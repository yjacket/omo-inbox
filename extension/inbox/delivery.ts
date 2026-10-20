/**
 * omo-inbox extension delivery (plan todo 15).
 *
 * The server drops one JSON file per phone answer into
 * `<home>/mailbox/<safeSegment(session)>/`; on every tick (3 s, owned by
 * core.ts) `drain()` reads those files sorted and, single-flight, hands each
 * answer to the question bridge, the session-control admit path, the board
 * delegate or the explain callback, acks it through
 * `POST /api/items/<itemId>/delivered` and deletes the file.
 *
 * Rules that matter (C8):
 *   - the deliveryId is written to `<home>/ledger/<sid>.json` BEFORE the bridge
 *     or admit call runs, so a crash between the two cannot deliver twice; a
 *     `held_draft` (or any other retryable admit verdict) rolls that entry back;
 *   - the in-memory delivered set is rebuilt from the ledger, the process
 *     lifetime `pi.session.listAdmittedDeliveries()` and the
 *     `session_control_delivery` entries of the session;
 *   - mailbox messages go to an idle session as follow-ups (`deliverAs:
 *     "followUp"`); a busy session gets free messages and turn replies as a
 *     steer with `expected_turn_id` = `pi.session.admissionGate().turn_epoch`,
 *     and a `turn_conflict` keeps the file for the next tick;
 *   - a delivery id already in the ledger is re-acked with the recorded how
 *     before its file is deleted, so an ack that failed earlier is repaired;
 *   - a late answer is one labeled user message, never the `[Answer to
 *     question` frame.
 */

import fsDefault from "node:fs/promises";
import path from "node:path";
import { safeSegment } from "./util.ts";

/** The sender recorded on every externally admitted delivery. */
export const SENDER = { kind: "external", platform: "omo-inbox" };
/** Every answer that missed its live question starts with this marker. */
export const LATE_MARKER = "[omo-inbox] 폰에서 늦게 온 답";
/** admitExternalMessage verdicts that mean the delivery is applied or queued. */
const ADMITTED = new Set(["started", "queued", "steered", "already_admitted"]);
/** Verdicts that leave nothing enqueued: the file is retried on the next tick. */
const RETRY_KINDS = new Set(["held_draft", "turn_conflict"]);

/** The human-read text of a phone answer: chosen labels first, then the typed text. */
export function answerText(payload) {
	const parts = [];
	for (const answer of Object.values(payload?.answers ?? {})) {
		for (const label of Array.isArray(answer?.selected) ? answer.selected : []) {
			const value = String(label ?? "").trim();
			if (value) parts.push(value);
		}
		const typed = typeof answer?.text === "string" ? answer.text.trim() : "";
		if (typed) parts.push(typed);
	}
	for (const key of ["comment", "text", "choice", "feedbackText"]) {
		const value = typeof payload?.[key] === "string" ? payload[key].trim() : "";
		if (value) parts.push(value);
	}
	return [...new Set(parts)].join(", ");
}

/**
 * The C8 late-answer text. `closed` picks the variant C8 uses for a question
 * that already closed; without it (the wait is merely gone: detached,
 * terminal-only or bridged nowhere) the plain form is used.
 */
export function lateAnswerText(header, answer, closed = false) {
	const label = String(header ?? "").trim() || "질문";
	const text = String(answer ?? "").trim();
	return `${LATE_MARKER} (질문 "${label}"${closed ? "은 이미 닫힘" : ""}): ${text}`;
}

function messageOf(error) {
	return String((error && (error.message || error.stack)) || error);
}

/** `entry` -> delivery id, for the shapes `listAdmittedDeliveries` may use. */
function admittedIdOf(entry) {
	if (typeof entry === "string") return entry || null;
	const id = entry?.delivery_id ?? entry?.deliveryId ?? null;
	return typeof id === "string" && id ? id : null;
}

/** Delivery ids recorded as `session_control_delivery` custom entries. */
function idsFromEntries(entries) {
	const ids = new Set();
	for (const entry of entries ?? []) {
		if (!entry || typeof entry !== "object") continue;
		const customType = entry.customType ?? entry.custom_type ?? null;
		if (customType && customType !== "session_control_delivery") continue;
		const details = entry.details ?? entry.data ?? null;
		const id = details?.delivery_id ?? details?.deliveryId ?? null;
		if (typeof id === "string" && id) ids.add(id);
	}
	return ids;
}

export function createDelivery(deps = {}) {
	const { home, getItem, post, bridge, pi, getCtx, explain, boardDeliver, capture, log, sessionId } = deps;
	const fsImpl = deps.fs ?? fsDefault;
	const note = async (text) => {
		try {
			if (typeof log === "function") await log(text);
		} catch {
			// logging must never break a drain
		}
	};

	/** Answered delivery ids (from the ledger, the runtime and this generation). */
	const delivered = new Set();
	/** Ids this extension itself wrote to the ledger. */
	const ledger = new Set();
	/** How each ledger id was delivered, for re-acking an already-applied file. */
	const ledgerHow = new Map();
	const ledgerRoot = path.join(String(home ?? ""), "ledger");
	let sid = sessionId ?? null;
	let loadedSid = null;
	let running = null;

	function resolveSid() {
		if (sid) return sid;
		try {
			const ctx = getCtx?.();
			sid = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId ?? null;
		} catch {
			sid = null;
		}
		return sid;
	}

	function mailboxDir(value = resolveSid()) {
		return value ? path.join(String(home ?? ""), "mailbox", safeSegment(value)) : null;
	}

	function ledgerPath(value = resolveSid()) {
		return value ? path.join(ledgerRoot, `${safeSegment(value)}.json`) : null;
	}

	async function writeLedger(value = resolveSid()) {
		const file = ledgerPath(value);
		if (!file) return;
		await fsImpl.mkdir(ledgerRoot, { recursive: true });
		const tmp = `${file}.tmp-${Math.random().toString(36).slice(2, 10)}`;
		await fsImpl.writeFile(
			tmp,
			JSON.stringify({ v: 1, ids: [...ledger].sort(), how: Object.fromEntries([...ledgerHow].sort()) }, null, "\t"),
		);
		await fsImpl.rename(tmp, file);
	}

	/** Remember (and record) a delivery id right before it is applied. */
	async function ledgerAdd(id) {
		if (!id) return;
		ledger.add(id);
		delivered.add(id);
		await writeLedger();
	}

	/** Undo ledgerAdd for a delivery that was not applied after all. */
	async function ledgerDrop(id) {
		if (!id) return;
		ledger.delete(id);
		ledgerHow.delete(id);
		delivered.delete(id);
		await writeLedger();
	}

	/** Record how an applied delivery was acked, so a retried ack matches it. */
	async function ledgerRemember(id, how) {
		if (!id || !how) return;
		ledgerHow.set(id, how);
		await writeLedger();
	}

	/** Rebuild the delivered set from disk and the runtime ledger. */
	async function reload(value) {
		const target = value ?? resolveSid();
		if (!target) return delivered;
		loadedSid = target;
		const ids = new Set();
		try {
			const raw = await fsImpl.readFile(ledgerPath(target), "utf8");
			const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
			for (const id of parsed?.ids ?? []) {
				if (typeof id === "string" && id) {
					ids.add(id);
					ledger.add(id);
				}
			}
			for (const [id, how] of Object.entries(parsed?.how ?? {})) {
				if (ids.has(id) && typeof how === "string" && how) ledgerHow.set(id, how);
			}
		} catch {
			// no ledger yet: a first session
		}
		try {
			const admitted = pi?.session?.listAdmittedDeliveries?.();
			for (const group of [admitted?.pending, admitted?.emitted, admitted?.failed]) {
				for (const entry of group ?? []) {
					const id = admittedIdOf(entry);
					if (id) ids.add(id);
				}
			}
		} catch (error) {
			await note(`delivery: admitted ledger unavailable: ${messageOf(error)}`);
		}
		try {
			for (const id of idsFromEntries(getCtx?.()?.sessionManager?.getEntries?.())) ids.add(id);
		} catch {
			// a missing entry list must not stop the delivery
		}
		for (const id of ids) delivered.add(id);
		return delivered;
	}

	async function removeQuietly(file) {
		try {
			await fsImpl.rm(file, { force: true });
		} catch (error) {
			await note(`delivery: cannot delete ${file}: ${messageOf(error)}`);
		}
	}

	async function itemOf(itemId) {
		if (!itemId || typeof getItem !== "function") return null;
		try {
			return (await getItem(itemId)) ?? null;
		} catch (error) {
			await note(`delivery: item ${itemId} unavailable: ${messageOf(error)}`);
			return null;
		}
	}

	/** Whether the session is idle, for the C8 follow-up/steer choice. */
	function idleNow() {
		try {
			const ctx = getCtx?.();
			return typeof ctx?.isIdle === "function" ? ctx.isIdle() !== false : true;
		} catch {
			return true;
		}
	}

	/** The current turn epoch, or null when the runtime has no admission gate. */
	function gateEpoch() {
		try {
			const gate = pi?.session?.admissionGate?.();
			return gate && gate.turn_epoch != null ? gate.turn_epoch : null;
		} catch {
			return null;
		}
	}

	/**
	 * Send one user message. Returns `{ keep, kind }`; keep means retry next tick.
	 * A busy session gets a steer with the current turn epoch; an idle one a
	 * follow-up. Question late answers pass `steer: false` (C8: never steer).
	 */
	async function sendMessage(text, deliveryId, { steer = true } = {}) {
		const busy = steer && !idleNow();
		const deliverAs = busy ? "steer" : "followUp";
		const epoch = busy ? gateEpoch() : null;
		const admit = pi?.session?.admitExternalMessage;
		// Without an admission gate a steer has no epoch and is always a
		// turn_conflict, so the runtime fallback carries it instead.
		if (typeof admit === "function" && (!busy || epoch != null)) {
			let result;
			try {
				result = admit.call(pi.session, {
					...(deliveryId ? { delivery_id: deliveryId } : {}),
					text,
					deliverAs,
					...(epoch != null ? { expected_turn_id: epoch } : {}),
					sender: SENDER,
				});
			} catch (error) {
				await note(`delivery: admit failed, falling back: ${messageOf(error)}`);
			}
			if (result) {
				const kind = String(result.kind ?? "");
				if (RETRY_KINDS.has(kind)) return { keep: true, kind };
				if (ADMITTED.has(kind)) return { keep: false, kind };
				return { keep: true, kind: kind || "unknown" };
			}
		}
		const send = pi?.sendUserMessage;
		if (typeof send === "function") {
			await send.call(pi, text, { deliverAs });
			return { keep: false, kind: "fallback" };
		}
		await note("delivery: no way to send a user message");
		return { keep: true, kind: "unavailable" };
	}

	/** The next agent start this delivery causes is the owner's. */
	async function markOwner(cause) {
		if (typeof capture?.markOwner !== "function") return;
		try {
			capture.markOwner(cause);
		} catch (error) {
			await note(`delivery: owner mark failed: ${messageOf(error)}`);
		}
	}

	async function ack(itemId, how, detail = null, deliveryId = null) {
		if (!itemId || typeof post !== "function") return;
		const response = await post(`/api/items/${encodeURIComponent(itemId)}/delivered`, { deliveryId, how, detail });
		if (response && response.ok === false) throw new Error(`delivered ack failed: ${response.status ?? "unknown"}`);
	}

	/** What to do with one answer, before anything is sent. */
	async function plan(payload) {
		const item = await itemOf(payload.itemId);
		const kind = payload.kind ?? item?.kind ?? null;
		const answer = payload.payload ?? {};
		if (kind === "question") {
			const requestId = payload.requestId ?? item?.raw?.request?.requestId ?? null;
			const header = item?.raw?.request?.questions?.[0]?.header ?? null;
			const verdict = typeof bridge?.resolveQuestion === "function" ? await bridge.resolveQuestion(requestId, answer) : "no-wait";
			if (verdict === "resolved") return { ack: { how: "bridge" } };
			if (verdict === "already-settled") return { ack: { how: "dropped", detail: "answered on another surface" } };
			const closed = item?.status === "closed";
			return {
				message: lateAnswerText(header, answerText(answer), closed),
				ack: { how: "late-message", detail: closed ? (item?.closedReason ?? "closed") : "no-wait" },
				steer: false,
			};
		}
		if (kind === "permission") {
			const dialogId = payload.dialogId ?? item?.raw?.dialog?.id ?? null;
			const choice = answer.choice ?? answer.comment ?? answer.text ?? null;
			const resolved = typeof bridge?.resolvePermission === "function" ? await bridge.resolvePermission(dialogId, choice, answer.feedbackText ?? null) : false;
			return resolved ? { ack: { how: "bridge" } } : { ack: { how: "refused", detail: "dialog closed" } };
		}
		return { message: answerText(answer) || String(payload.text ?? "").trim(), ack: { how: "message" }, steer: true };
	}

	/** Handle one parsed mailbox file. Returns "handled" | "skipped" | "kept" | "removed". */
	async function handle(file, payload) {
		if (!payload || typeof payload !== "object") {
			await note(`delivery: unparsable ${file}: not a JSON object`);
			await removeQuietly(file);
			return "removed";
		}
		const type = payload.type ?? "board-feedback";
		if (type === "board-feedback") {
			const key = `board:${payload.proposalId ?? "?"}-${payload.seq ?? "?"}`;
			if (delivered.has(key)) {
				await removeQuietly(file);
				return "skipped";
			}
			delivered.add(key);
			try {
				await boardDeliver?.(payload);
			} catch (error) {
				delivered.delete(key);
				await note(`delivery: board feedback failed: ${messageOf(error)}`);
				return "kept";
			}
			await removeQuietly(file);
			return "handled";
		}
		if (type === "explain") {
			if (!payload.itemId) {
				await note(`delivery: unparsable ${file}: missing itemId`);
				await removeQuietly(file);
				return "removed";
			}
			if (typeof explain !== "function") {
				await note(`delivery: no explain callback for ${payload.itemId}`);
				return "kept";
			}
			await explain(payload.itemId);
			await removeQuietly(file);
			return "handled";
		}
		if (type !== "item-answer") {
			await note(`delivery: unparsable ${file}: unknown type ${String(type)}`);
			await removeQuietly(file);
			return "removed";
		}
		if (!payload.itemId) {
			await note(`delivery: unparsable ${file}: missing itemId`);
			await removeQuietly(file);
			return "removed";
		}
		const deliveryId = typeof payload.deliveryId === "string" && payload.deliveryId ? payload.deliveryId : null;
		const fallbackKey = `file:${path.basename(file)}`;
		if (deliveryId && delivered.has(deliveryId)) {
			// Already applied (an ack failed or the process died after the ledger
			// write): re-send the recorded ack before deleting the file.
			const how = ledgerHow.get(deliveryId) ?? (payload.kind === "question" ? "late-message" : "message");
			try {
				await ack(payload.itemId, how, null, deliveryId);
			} catch (error) {
				await note(`delivery: ${payload.itemId} re-ack failed: ${messageOf(error)}`);
				return "kept";
			}
			await removeQuietly(file);
			return "skipped";
		}
		if (delivered.has(fallbackKey)) {
			await removeQuietly(file);
			return "skipped";
		}
		// The ledger entry goes in first: a crash after it cannot deliver twice.
		if (deliveryId) await ledgerAdd(deliveryId);
		else delivered.add(fallbackKey);
		let verdict;
		try {
			verdict = await plan(payload);
		} catch (error) {
			await (deliveryId ? ledgerDrop(deliveryId) : Promise.resolve(delivered.delete(fallbackKey)));
			await note(`delivery: ${payload.itemId} planning failed: ${messageOf(error)}`);
			return "kept";
		}
		if (verdict.message) {
			await markOwner("phone");
			let sent;
			try {
				sent = await sendMessage(verdict.message, deliveryId, { steer: verdict.steer !== false });
			} catch (error) {
				sent = { keep: true, kind: "throw" };
				await note(`delivery: ${payload.itemId} send failed: ${messageOf(error)}`);
			}
			if (sent.keep) {
				// nothing was enqueued: retry the same file on the next tick
				await (deliveryId ? ledgerDrop(deliveryId) : Promise.resolve(delivered.delete(fallbackKey)));
				return "kept";
			}
		}
		if (deliveryId) await ledgerRemember(deliveryId, verdict.ack.how);
		try {
			await ack(payload.itemId, verdict.ack.how, verdict.ack.detail ?? null, deliveryId);
		} catch (error) {
			// the answer is applied but unacked: keep the file and let the delivered
			// set stop a second apply on the next drain
			await note(`delivery: ${payload.itemId} ack failed: ${messageOf(error)}`);
			return "kept";
		}
		await removeQuietly(file);
		return "handled";
	}

	async function run() {
		const target = resolveSid();
		if (!target) return { handled: 0, skipped: "no-session" };
		if (loadedSid !== target) await reload(target);
		const dir = mailboxDir(target);
		let names;
		try {
			names = await fsImpl.readdir(dir);
		} catch (error) {
			if (error?.code === "ENOENT") return { handled: 0, skipped: "no-mailbox" };
			throw error;
		}
		let handled = 0;
		for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
			const file = path.join(dir, name);
			let payload;
			try {
				payload = JSON.parse(String(await fsImpl.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
			} catch (error) {
				await note(`delivery: unparsable ${file}: ${messageOf(error)}`);
				await removeQuietly(file);
				continue;
			}
			try {
				if ((await handle(file, payload)) === "handled") handled++;
			} catch (error) {
				await note(`delivery: ${file} failed: ${messageOf(error)}`);
			}
		}
		return { handled };
	}

	/** One drain at a time: an overlapping tick would deliver the same file twice. */
	function drain() {
		if (running) return running;
		running = (async () => {
			try {
				return await run();
			} finally {
				running = null;
			}
		})();
		return running;
	}

	return {
		drain,
		reload,
		mailboxDir,
		ledgerPath,
		deliveredIds: () => [...delivered],
	};
}
