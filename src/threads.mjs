import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { safeSegment } from "./paths.mjs";
import { detectQuestion, detectTodo } from "./summary.mjs";

const SEQ_WIDTH = 6;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const NOTICES_SID = "_notices";
const SUPERSEDE_KINDS = new Set(["turn", "blocked", "done", "progress", "board"]);
const LIST_STATUSES = new Set(["needs-you", "working", "ended"]);
const STATUS_RANK = { "needs-you": 0, working: 1, ended: 2 };
const ASKING_KINDS = new Set(["question", "permission", "blocked", "notice", "board"]);
const THREAD_KEYS = ["cwd", "product", "feature", "worktree", "branch", "title", "titleSource", "firstRequest", "ended", "sessionFile", "hidden", "executes"];
const ROW_NEXT_LABELS = { done: "할 일 없음", plan: "실행 대기", ship: "마무리 남음" };
const FINAL_KINDS = new Set(["turn", "done", "blocked"]);

function fail(code, message, extra) {
	const error = new Error(message);
	error.code = code;
	if (extra) Object.assign(error, extra);
	return error;
}

function renameWithRetry(from, to) {
	let last;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (error) {
			last = error;
			if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
		}
	}
	throw last;
}

export function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
	fs.writeFileSync(tmp, JSON.stringify(value));
	renameWithRetry(tmp, file);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function clip(text, n) {
	const value = String(text ?? "");
	return value.length <= n ? value : `${value.slice(0, Math.max(0, n - 1))}…`;
}

/** Stable JSON for comparing two JSON payloads regardless of key order. */
function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function defaultRandomId(n) {
	const bytes = crypto.randomBytes(n);
	let out = "";
	for (let i = 0; i < n; i++) out += ID_CHARS[bytes[i] % ID_CHARS.length];
	return out;
}

function lastOfType(events, type) {
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].type === type) return events[i];
	}
	return undefined;
}

/**
 * Item status from its own events, newest-last.
 * `closed` when a closed event exists, or when a question/permission item is older than 24 h;
 * `answered` when an answer has no delivered event with the same deliveryId;
 * `delivered` when any delivered event exists; `open` otherwise.
 */
export function statusOfItem(events, at = new Date()) {
	const item = events.find((event) => event.type === "item");
	if (events.some((event) => event.type === "closed")) return "closed";
	if (item && (item.kind === "question" || item.kind === "permission")) {
		const created = Date.parse(item.createdAt);
		if (Number.isFinite(created) && at.getTime() - created >= EXPIRY_MS) return "closed";
	}
	const answers = events.filter((event) => event.type === "answer");
	const delivered = events.filter((event) => event.type === "delivered");
	if (answers.some((answer) => !delivered.some((event) => event.deliveryId === answer.deliveryId))) return "answered";
	if (delivered.length) return "delivered";
	return "open";
}

export function createThreads({ home, now = () => new Date(), randomId = defaultRandomId, isLive = () => false, isRecent = () => false } = {}) {
	if (!home) throw fail("bad_input", "home is required");
	const threadsDir = path.join(home, "data", "threads");
	const mailboxRoot = path.join(home, "mailbox");
	const threads = new Map();
	const itemIndex = new Map();
	const handoffIndex = new Map();

	function readEvents(dir) {
		let names;
		try {
			names = fs.readdirSync(path.join(dir, "events"));
		} catch {
			return [];
		}
		const events = [];
		for (const name of names) {
			if (name.includes(".tmp-") || !name.endsWith(".json")) continue;
			const event = readJson(path.join(dir, "events", name));
			if (event && typeof event.seq === "number") events.push(event);
		}
		return events.sort((a, b) => a.seq - b.seq);
	}

	function rebuild() {
		threads.clear();
		itemIndex.clear();
		handoffIndex.clear();
		let dirents;
		try {
			dirents = fs.readdirSync(threadsDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of dirents) {
			if (!dirent.isDirectory() || dirent.name.includes(".tmp-")) continue;
			const dir = path.join(threadsDir, dirent.name);
			const thread = readJson(path.join(dir, "thread.json"));
			if (!thread || typeof thread !== "object" || typeof thread.session !== "string") continue;
			thread.sessionFile ??= null;
			thread.hidden ??= false;
			thread.executes ??= null;
			const events = readEvents(dir);
			const nextSeq = events.length ? events[events.length - 1].seq + 1 : 1;
			threads.set(thread.session, { sid: thread.session, dir, thread, events, nextSeq });
			for (const event of events) {
				if (event.type === "item" && typeof event.itemId === "string") itemIndex.set(event.itemId, thread.session);
				if (event.type === "handoff" && typeof event.to === "string") {
					handoffIndex.set(event.to, { sid: thread.session, itemId: event.itemId, via: event.via, status: event.status, slug: event.slug });
				}
			}
		}
	}

	function writeEvent(entry, event) {
		const seq = entry.nextSeq;
		const full = { seq, at: now().toISOString(), ...event };
		writeJson(path.join(entry.dir, "events", `${String(seq).padStart(SEQ_WIDTH, "0")}-${event.type}.json`), full);
		entry.events.push(full);
		entry.nextSeq = seq + 1;
		return full;
	}

	function ensureThread(sid) {
		const existing = threads.get(sid);
		if (existing) return existing;
		const dir = path.join(threadsDir, safeSegment(sid));
		const thread = {
			v: 1,
			session: sid,
			cwd: null,
			product: null,
			feature: null,
			worktree: null,
			branch: null,
			title: sid === NOTICES_SID ? "알림" : null,
			titleSource: null,
			firstRequest: null,
			created: now().toISOString(),
			ended: null,
			sessionFile: null,
			hidden: false,
			executes: null,
		};
		fs.mkdirSync(path.join(dir, "events"), { recursive: true });
		const entry = { sid, dir, thread, events: [], nextSeq: 1 };
		writeJson(path.join(dir, "thread.json"), thread);
		threads.set(sid, entry);
		return entry;
	}

	function pick(n) {
		let raw = "";
		try {
			raw = String(randomId(n) ?? "");
		} catch {
			raw = "";
		}
		const clean = [...raw.toLowerCase()].filter((c) => ID_CHARS.includes(c)).join("");
		return clean.length >= n ? clean.slice(0, n) : clean + defaultRandomId(n - clean.length);
	}

	function makeItemId() {
		for (let attempt = 0; attempt < 1000; attempt++) {
			const at = now();
			const yy = String(at.getFullYear() % 100).padStart(2, "0");
			const mm = String(at.getMonth() + 1).padStart(2, "0");
			const dd = String(at.getDate()).padStart(2, "0");
			const id = `i-${yy}${mm}${dd}-${pick(6)}`;
			if (!itemIndex.has(id)) return id;
		}
		throw fail("bad_input", "could not allocate an item id");
	}

	function itemIdsOf(entry) {
		const seen = new Set();
		const ids = [];
		for (const event of entry.events) {
			if (event.type !== "item" || typeof event.itemId !== "string" || seen.has(event.itemId)) continue;
			seen.add(event.itemId);
			ids.push(event.itemId);
		}
		return ids;
	}

	function itemEventsOf(entry, itemId) {
		return entry.events.filter((event) => event.itemId === itemId);
	}

	function closureOf(entry, itemId) {
		const events = itemEventsOf(entry, itemId);
		const closed = lastOfType(events, "closed");
		if (closed) return { reason: closed.reason ?? null, resolvedBy: closed.resolvedBy ?? null };
		if (statusOfItem(events, now()) === "closed") return { reason: "expired", resolvedBy: null };
		return null;
	}

	function buildItem(sid, itemId) {
		const entry = threads.get(sid);
		if (!entry) throw fail("not_found", `thread not found: ${sid}`);
		const events = itemEventsOf(entry, itemId);
		const item = events.find((event) => event.type === "item");
		if (!item) throw fail("not_found", `item not found: ${itemId}`);
		const summaryEvent = lastOfType(events, "summary");
		const bridgeEvent = lastOfType(events, "bridge");
		const stateEvent = lastOfType(events, "state");
		const pushedEvent = lastOfType(events, "pushed");
		const nextEvent = lastOfType(events, "next");
		const closure = closureOf(entry, itemId);
		return {
			itemId,
			session: sid,
			kind: item.kind,
			policy: item.policy,
			dedupeKey: item.dedupeKey ?? null,
			createdAt: item.createdAt,
			raw: item.raw ?? null,
			meta: item.meta ?? null,
			status: statusOfItem(events, now()),
			closedReason: closure ? closure.reason : null,
			resolvedBy: closure ? closure.resolvedBy : null,
			bridge: bridgeEvent ? bridgeEvent.state : null,
			state: stateEvent ? { state: stateEvent.state, reasons: stateEvent.reasons ?? [], boards: stateEvent.boards ?? [] } : null,
			pushedAt: pushedEvent ? (pushedEvent.pushedAt ?? pushedEvent.at ?? null) : null,
			next: nextEvent ? nextEvent.next : null,
			summary: summaryEvent
				? { summary: summaryEvent.summary, source: summaryEvent.source, model: summaryEvent.model ?? null, simpler: summaryEvent.simpler ?? false }
				: null,
			answers: events.filter((event) => event.type === "answer").map((event) => ({
				answerId: event.answerId,
				deliveryId: event.deliveryId,
				payload: event.payload ?? {},
				via: event.via ?? null,
				client: event.client ?? null,
				ua: event.ua ?? null,
				at: event.at,
			})),
			deliveredIds: events.filter((event) => event.type === "delivered").map((event) => event.deliveryId),
			...(events.some((event) => event.type === "pushed" && event.suppressed === true) ? { pushSuppressed: true } : {}),
		};
	}

	function requireItem(itemId) {
		const sid = itemIndex.get(itemId);
		if (!sid) throw fail("not_found", `item not found: ${itemId}`);
		return { sid, itemId };
	}

	// Line, turn and episode keys identify one episode record for good: a re-post after the
	// close (reload backfill, repeated settle) must return that record, not duplicate it.
	const ANY_STATUS_DEDUPE_PREFIXES = ["line:", "turn:", "episode:"];

	function findOpenByDedupe(dedupeKey) {
		const anyStatus = ANY_STATUS_DEDUPE_PREFIXES.some((prefix) => dedupeKey.startsWith(prefix));
		for (const entry of threads.values()) {
			for (const itemId of itemIdsOf(entry)) {
				const events = itemEventsOf(entry, itemId);
				const item = events.find((event) => event.type === "item");
				if (!item || (item.dedupeKey ?? null) !== dedupeKey) continue;
				if (!anyStatus && statusOfItem(events, now()) === "closed") continue;
				return { sid: entry.sid, itemId };
			}
		}
		return null;
	}

	function closeRef(ref, reason, resolvedBy) {
		writeEvent(threads.get(ref.sid), { type: "closed", itemId: ref.itemId, reason, resolvedBy: resolvedBy ?? null });
	}

	function supersedeTurns(entry) {
		let closed = 0;
		for (const itemId of itemIdsOf(entry)) {
			const events = itemEventsOf(entry, itemId);
			const item = events.find((event) => event.type === "item");
			if (!item || !SUPERSEDE_KINDS.has(item.kind)) continue;
			if (statusOfItem(events, now()) === "closed") continue;
			writeEvent(entry, { type: "closed", itemId, reason: "superseded", resolvedBy: null });
			closed++;
		}
		return closed;
	}

	function displayTitle(entry) {
		if (entry.thread.title) return entry.thread.title;
		if (entry.thread.firstRequest) return `요청: ${clip(entry.thread.firstRequest, 24)}`;
		return null;
	}

	function lastCache(entry) {
		const event = lastOfType(entry.events, "cache");
		return event ? (event.warmUntil ?? null) : null;
	}

	function readSeq(entry) {
		const event = lastOfType(entry.events, "read");
		return event && typeof event.readSeq === "number" ? event.readSeq : 0;
	}

	// Messenger unread: only new items the user has not seen. Machine events (activity,
	// summary, cache, bridge, delivered) and progress items never make a row unread.
	function unreadCount(entry) {
		const seq = readSeq(entry);
		return entry.events.filter((event) => event.seq > seq && event.type === "item" && event.kind !== "progress").length;
	}

	function newestOf(entry) {
		const ids = itemIdsOf(entry);
		if (!ids.length) return null;
		const item = buildItem(entry.sid, ids[ids.length - 1]);
		return {
			itemId: item.itemId,
			kind: item.kind,
			headline: item.summary ? clip(item.summary.summary?.headline ?? null, 40) || null : null,
			at: item.createdAt,
		};
	}

	function waitingItems(entry) {
		return itemIdsOf(entry)
			.map((itemId) => buildItem(entry.sid, itemId))
			.filter((item) => item.status === "open" && item.policy === "needs-you");
	}

	function stillAsks(item) {
		if (ASKING_KINDS.has(item.kind)) return true;
		if (item.kind !== "turn" && item.kind !== "done") return false;
		if (typeof item.summary?.summary?.ask === "string" && item.summary.summary.ask.trim()) return true;
		// A model summary is the judgment of record: older ones (before ask carried to-dos) still name the to-do in
		// their headline or body. Without one, fall back to the end of the item's own final text.
		const text = item.summary?.source === "model"
			? [item.summary.summary?.headline, item.summary.summary?.body].filter((value) => typeof value === "string").join(" ")
			: ([item.raw?.final, item.raw?.text].find((value) => typeof value === "string" && value.trim()) ?? "").slice(-400);
		if (detectQuestion(text) || detectTodo(text)) return true;
		return item.meta?.stalled === true || item.meta?.episode?.closeReason === "stalled";
	}

	function threadStatus(entry, waiting = waitingItems(entry)) {
		const live = isLive(entry.sid) || isRecent(entry.sid);
		if (waiting.length && (live || waiting.some(stillAsks))) return { status: "needs-you", live };
		return { status: live ? "working" : "ended", live };
	}

	function threadView(entry) {
		const waiting = waitingItems(entry);
		const { status, live } = threadStatus(entry, waiting);
		const handoffEvent = lastOfType(entry.events, "handoff");
		return {
			...entry.thread,
			title: displayTitle(entry),
			sessionFile: entry.thread.sessionFile ?? null,
			status,
			live,
			off: status === "needs-you" && !live && entry.sid !== NOTICES_SID,
			hidden: entry.thread.hidden === true,
			unread: unreadCount(entry),
			cacheUntil: lastCache(entry),
			waitingSince: waiting.length ? waiting[0].createdAt : null,
			handoff: handoffEvent
				? { to: handoffEvent.to, via: handoffEvent.via, status: handoffEvent.status, slug: handoffEvent.slug, at: handoffEvent.at }
				: null,
			actions: providerActions(entry.sid),
		};
	}

	function rowNext(entry, status, waiting) {
		if (status === "needs-you") {
			const state = waiting.at(-1)?.next?.state;
			return typeof state === "string" && Object.hasOwn(ROW_NEXT_LABELS, state) ? { state, label: ROW_NEXT_LABELS[state] } : null;
		}
		if (status === "ended") {
			const state = actionableFinal(entry.sid)?.next?.state;
			return state === "plan" || state === "ship" ? { state, label: ROW_NEXT_LABELS[state] } : null;
		}
		return null;
	}

	function rowOf(entry) {
		const waiting = waitingItems(entry);
		const { status, live } = threadStatus(entry, waiting);
		return {
			session: entry.thread.session,
			title: displayTitle(entry),
			product: entry.thread.product ?? null,
			branch: entry.thread.branch ?? null,
			status,
			live,
			off: status === "needs-you" && !live && entry.sid !== NOTICES_SID,
			hidden: entry.thread.hidden === true,
			newest: newestOf(entry),
			unread: unreadCount(entry),
			cacheUntil: lastCache(entry),
			waitingSince: waiting[0]?.createdAt ?? null,
			next: rowNext(entry, status, waiting),
		};
	}

	function compareRows(a, b) {
		const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
		if (rank) return rank;
		if (a.status === "needs-you") return a.waitingSince < b.waitingSince ? -1 : a.waitingSince > b.waitingSince ? 1 : 0;
		const at = a.newest?.at ?? "";
		const bt = b.newest?.at ?? "";
		return at < bt ? 1 : at > bt ? -1 : 0;
	}

	function createItem(sid, { kind, policy, dedupeKey = null, raw = null, meta = null } = {}) {
		if (typeof sid !== "string" || !sid) throw fail("bad_input", "session id is required");
		if (!kind) throw fail("bad_input", "kind is required");
		if (!policy) throw fail("bad_input", "policy is required");
		const existing = dedupeKey == null ? null : findOpenByDedupe(dedupeKey);
		if (existing) {
			if (kind === "notice") closeRef(existing, "superseded", null);
			else return { item: buildItem(existing.sid, existing.itemId), created: false };
		}
		const entry = ensureThread(sid);
		const itemId = makeItemId();
		writeEvent(entry, { type: "item", itemId, kind, policy, dedupeKey, createdAt: now().toISOString(), raw, meta });
		itemIndex.set(itemId, sid);
		return { item: buildItem(sid, itemId), created: true };
	}

	function addSummary(itemId, summary, source = "model", model = null, simpler = false) {
		const ref = requireItem(itemId);
		const entry = threads.get(ref.sid);
		writeEvent(entry, { type: "summary", itemId, summary, source, model, simpler });
		if (summary?.title && (!entry.thread.title || (entry.thread.titleSource === "session-name" && !/[가-힣]/.test(entry.thread.title)))) setMeta(ref.sid, { title: summary.title, titleSource: "summary" });
		return buildItem(ref.sid, itemId);
	}

	function mailboxFile(sid, itemId, seq) {
		return path.join(mailboxRoot, safeSegment(sid), `${itemId}-${String(seq).padStart(SEQ_WIDTH, "0")}.json`);
	}

	function writeAnswerMailbox(itemId, payload = null, meta = {}) {
		const ref = requireItem(itemId);
		const entry = threads.get(ref.sid);
		const item = buildItem(ref.sid, itemId);
		const type = meta.type ?? "item-answer";
		const seq = meta.seq ?? entry.nextSeq;
		if (type === "explain") {
			// An explain writes no event, so nextSeq alone would let two quick taps overwrite
			// the same file. Keep the C5 path shape and add a unique suffix.
			const file = path.join(mailboxRoot, safeSegment(ref.sid), `${itemId}-${String(seq).padStart(SEQ_WIDTH, "0")}-${pick(6)}.json`);
			writeJson(file, { v: 1, type: "explain", itemId });
			return file;
		}
		const file = mailboxFile(ref.sid, itemId, seq);
		const raw = item.raw ?? {};
		const requestId = meta.requestId ?? raw.request?.requestId ?? null;
		const dialogId = meta.dialogId ?? raw.dialog?.id ?? null;
		writeJson(file, {
			v: 1,
			type,
			itemId,
			kind: item.kind,
			deliveryId: meta.deliveryId ?? null,
			...(requestId == null ? {} : { requestId }),
			...(dialogId == null ? {} : { dialogId }),
			payload,
			text: meta.text ?? payload?.text ?? payload?.comment ?? null,
		});
		return file;
	}

	function answer(itemId, payload = {}, meta = {}) {
		const ref = requireItem(itemId);
		const entry = threads.get(ref.sid);
		const closure = closureOf(entry, itemId);
		if (closure) throw fail("closed", `item is closed: ${itemId}`, { reason: closure.reason, resolvedBy: closure.resolvedBy });
		// The phone's 다시 보내기 retries the same answer while it is undelivered. Reuse that
		// answer's deliveryId and rewrite its mailbox file so the session applies it once.
		if (meta.deliveryId == null) {
			const events = itemEventsOf(entry, itemId);
			const delivered = new Set(events.filter((event) => event.type === "delivered").map((event) => event.deliveryId));
			const wanted = canonicalJson(payload);
			const previous = events
				.filter((event) => event.type === "answer" && !delivered.has(event.deliveryId))
				.reverse()
				.find((event) => canonicalJson(event.payload ?? {}) === wanted);
			if (previous) {
				const file = writeAnswerMailbox(itemId, payload, { ...meta, deliveryId: previous.deliveryId, seq: previous.seq });
				return { ok: true, itemId, deliveryId: previous.deliveryId, seq: previous.seq, mailbox: file, reused: true };
			}
		}
		const deliveryId = meta.deliveryId ?? pick(12);
		const event = writeEvent(entry, {
			type: "answer",
			itemId,
			answerId: `a-${pick(8)}`,
			deliveryId,
			payload,
			via: meta.via ?? null,
			client: meta.client ?? null,
			ua: meta.ua ?? null,
		});
		const file = writeAnswerMailbox(itemId, payload, { ...meta, deliveryId, seq: event.seq });
		return { ok: true, itemId, deliveryId, seq: event.seq, mailbox: file };
	}

	function nextComparable(next) {
		if (!next || typeof next !== "object") return canonicalJson(next);
		const { at, ...rest } = next;
		return canonicalJson(rest);
	}

	function setNext(itemId, next) {
		const ref = requireItem(itemId);
		const entry = threads.get(ref.sid);
		const previous = lastOfType(itemEventsOf(entry, itemId), "next");
		if (previous && nextComparable(previous.next) === nextComparable(next)) return false;
		const value = next && typeof next === "object" && next.at != null ? next : { ...next, at: now().toISOString() };
		writeEvent(entry, { type: "next", itemId, next: value });
		return true;
	}

	function setActions(sid, producer, actions) {
		const entry = ensureThread(sid);
		writeEvent(entry, { type: "actions", producer, actions: Array.isArray(actions) ? actions : [] });
		return actions;
	}

	function providerActions(sid) {
		const entry = threads.get(sid);
		if (!entry) return [];
		const latest = new Map();
		for (const event of entry.events) {
			if (event.type !== "actions" || typeof event.producer !== "string") continue;
			latest.set(event.producer, Array.isArray(event.actions) ? event.actions : []);
		}
		const actions = [];
		for (const [producer, list] of latest) {
			if (!list.length) continue;
			for (const action of list) actions.push({ ...action, producer });
		}
		return actions;
	}

	function addHandoff(sid, { itemId, to, via, status, slug } = {}) {
		const entry = ensureThread(sid);
		const event = writeEvent(entry, { type: "handoff", itemId, to, via, status, slug });
		if (typeof to === "string") handoffIndex.set(to, { sid, itemId, via, status, slug });
		return { to, via, status, slug, at: event.at };
	}

	function handoffFrom(to) {
		const found = handoffIndex.get(to);
		return found ? { ...found } : null;
	}

	function writeControlFile(sid, { itemId, action, producer, key, deliveryId }) {
		writeJson(path.join(home, "control", safeSegment(sid), `${deliveryId}.json`), {
			v: 1,
			type: "session-control",
			action,
			itemId,
			deliveryId,
			issuedAt: now().toISOString(),
			...(producer == null ? {} : { producer }),
			...(key == null ? {} : { key }),
		});
	}

	function writeControl(sid, { itemId, action, producer, key } = {}) {
		const deliveryId = pick(12);
		writeControlFile(sid, { itemId, action, producer, key, deliveryId });
		return { deliveryId };
	}

	function answerControl(itemId, { action, label, producer, key } = {}) {
		const ref = requireItem(itemId);
		const entry = threads.get(ref.sid);
		const deliveryId = pick(12);
		writeEvent(entry, {
			type: "answer",
			itemId,
			answerId: `a-${pick(8)}`,
			deliveryId,
			payload: { action, text: label },
			via: null,
			client: null,
			ua: null,
		});
		writeControlFile(ref.sid, { itemId, action, producer, key, deliveryId });
		return { deliveryId };
	}

	function delivered(itemId, deliveryId, how, detail = null) {
		const ref = requireItem(itemId);
		writeEvent(threads.get(ref.sid), { type: "delivered", itemId, deliveryId, how, detail });
		return buildItem(ref.sid, itemId);
	}

	function close(itemId, reason, resolvedBy = null) {
		const ref = requireItem(itemId);
		closeRef(ref, reason, resolvedBy);
		return buildItem(ref.sid, itemId);
	}

	function bridge(itemId, state) {
		const ref = requireItem(itemId);
		writeEvent(threads.get(ref.sid), { type: "bridge", itemId, state });
		return buildItem(ref.sid, itemId);
	}

	function setItemState(itemId, { state, reasons, boards } = {}) {
		const ref = requireItem(itemId);
		writeEvent(threads.get(ref.sid), {
			type: "state",
			itemId,
			state: state ?? null,
			reasons: reasons ?? [],
			boards: boards ?? [],
		});
		return buildItem(ref.sid, itemId);
	}

	function markPushed(itemId, at = now().toISOString(), { suppressed = false } = {}) {
		const ref = requireItem(itemId);
		const pushedAt = at instanceof Date ? at.toISOString() : typeof at === "number" ? new Date(at).toISOString() : String(at);
		writeEvent(threads.get(ref.sid), { type: "pushed", itemId, pushedAt, ...(suppressed ? { suppressed: true } : {}) });
		return buildItem(ref.sid, itemId);
	}

	function activity(sid, source, cause = "owner") {
		const entry = ensureThread(sid);
		writeEvent(entry, { type: "activity", source, cause });
		const superseded = source === "agent-start" || source === "terminal-input" ? supersedeTurns(entry) : 0;
		return { source, superseded };
	}

	/** The session quit or switched away (not a reload): every open item closes as session-closed, so the thread reads 끝남. */
	function closeSession(sid, reason = "session-closed") {
		return closeOffline(sid, reason);
	}

	function closeOffline(sid, reason = "closed-by-owner") {
		const entry = threads.get(sid);
		if (!entry) return 0;
		let closed = 0;
		for (const itemId of itemIdsOf(entry)) {
			if (statusOfItem(itemEventsOf(entry, itemId), now()) === "closed") continue;
			writeEvent(entry, { type: "closed", itemId, reason, resolvedBy: null });
			closed++;
		}
		return closed;
	}

	function actionableFinal(sid) {
		const entry = threads.get(sid);
		if (!entry || entry.events.some((event) => event.type === "handoff")) return null;
		const ids = itemIdsOf(entry);
		let finalIndex = -1;
		for (let i = ids.length - 1; i >= 0; i--) {
			const item = buildItem(sid, ids[i]);
			if (item.policy === "needs-you" && FINAL_KINDS.has(item.kind)) {
				finalIndex = i;
				break;
			}
		}
		if (finalIndex < 0) return null;
		const final = buildItem(sid, ids[finalIndex]);
		if (final.closedReason !== "session-closed") return null;
		for (let i = finalIndex + 1; i < ids.length; i++) {
			if (buildItem(sid, ids[i]).policy === "needs-you") return null;
		}
		return final;
	}

	function cache(sid, warmUntil, ttlSec) {
		const entry = ensureThread(sid);
		writeEvent(entry, { type: "cache", warmUntil, ttlSec });
		return { warmUntil, ttlSec };
	}

	function setMeta(sid, meta = {}) {
		const entry = ensureThread(sid);
		let changed = false;
		for (const key of THREAD_KEYS) {
			if (!(key in meta)) continue;
			const value = meta[key];
			if (value === undefined) continue;
			if (entry.thread[key] !== value) changed = true;
			entry.thread[key] = value;
		}
		if (meta.title != null && meta.titleSource == null) entry.thread.titleSource = "session-name";
		if (changed || meta.title != null) writeJson(path.join(entry.dir, "thread.json"), entry.thread);
		return entry.thread;
	}

	function markRead(sid, seq) {
		const entry = ensureThread(sid);
		writeEvent(entry, { type: "read", readSeq: Number(seq) || 0 });
		return { seq: Number(seq) || 0 };
	}

	function getThread(sid, since = 0) {
		const entry = threads.get(sid);
		if (!entry) throw fail("not_found", `thread not found: ${sid}`);
		return {
			thread: threadView(entry),
			items: itemIdsOf(entry).map((itemId) => buildItem(sid, itemId)),
			events: entry.events.filter((event) => event.seq > since),
		};
	}

	function getItem(itemId) {
		const ref = requireItem(itemId);
		return buildItem(ref.sid, itemId);
	}

	function episodeItems(sid, key) {
		const entry = threads.get(sid);
		if (!entry) throw fail("not_found", `thread not found: ${sid}`);
		return itemIdsOf(entry)
			.map((itemId) => buildItem(sid, itemId))
			.filter((item) => item.meta?.episode?.key === key)
			.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
	}

	function list({ status } = {}) {
		if (status != null && !LIST_STATUSES.has(status)) throw fail("bad_input", `unknown status: ${status}`);
		return [...threads.values()]
			.map(rowOf)
			.filter((row) => status == null || row.status === status)
			.sort(compareRows);
	}

	function counts() {
		const rows = list();
		return {
			needsYou: rows.filter((row) => row.status === "needs-you" && !row.hidden).length,
			working: rows.filter((row) => row.status === "working").length,
			ended: rows.filter((row) => row.status === "ended").length,
			hidden: rows.filter((row) => row.hidden).length,
		};
	}

	rebuild();

	return {
		createItem,
		addSummary,
		answer,
		delivered,
		close,
		bridge,
		setItemState,
		markPushed,
		activity,
		closeSession,
		closeOffline,
		setNext,
		setActions,
		providerActions,
		addHandoff,
		handoffFrom,
		answerControl,
		writeControl,
		actionableFinal,
		cache,
		setMeta,
		markRead,
		getThread,
		getItem,
		episodeItems,
		list,
		counts,
		writeAnswerMailbox,
		statusOfItem,
	};
}
