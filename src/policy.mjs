// Push policy and scheduler (contract C9). Pure policy functions plus a timer wrapper with an
// injected clock: this module decides *whether* and *when* a push would go out, builds the JSON
// payload the phone receives, and never sends anything (no push.mjs, no server.mjs).

import crypto from "node:crypto";
import { redact } from "./redact.mjs";
import { clip, recommendedOption } from "./summary.mjs";

export const HOLD_QUESTION_MS = 15_000;
export const HOLD_TURN_MS = 30_000;
export const HOLD_BOARD_MS = 0;
export const CACHE_LEAD_MINUTES = 5;
export const SUMMARY_WAIT_MS = 30_000;
export const MAX_PAYLOAD_BYTES = 3000;
export const MAX_TITLE = 40;
export const MAX_BODY = 120;
export const MAX_ACTIONS = 2;
export const TITLE_PREFIX = "🙋 ";
export const CACHE_TITLE = "🔥";
export const OPEN_ACTION = { action: "open", title: "열기" };

const HOLD_BY_KIND = {
	question: HOLD_QUESTION_MS,
	permission: HOLD_QUESTION_MS,
	turn: HOLD_TURN_MS,
	blocked: HOLD_TURN_MS,
	done: HOLD_TURN_MS,
	board: HOLD_BOARD_MS,
	notice: HOLD_BOARD_MS,
};
const NO_PUSH_POLICIES = new Set(["progress", "quiet", "fyi"]);
const NO_PLAN = { push: false, holdMs: null, actions: [] };

/** Epoch milliseconds from a Date, an ISO string or a number; null when unusable. */
function timeOf(value) {
	if (value == null) return null;
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const parsed = Date.parse(String(value));
	return Number.isFinite(parsed) ? parsed : null;
}

/** A goal with status `active` and no continuation stop still runs; its session is not idle. */
function isGoalActive(thread) {
	const goal = thread?.goal;
	const status = typeof goal === "string" ? goal : (goal?.status ?? thread?.goalStatus ?? null);
	if (status !== "active") return false;
	const stopped = typeof goal === "object" && goal ? goal.continuationStoppedAt : thread?.goalContinuationStoppedAt;
	return stopped == null || stopped === false || stopped === "";
}

/** C3/C6: a question item is required when either raw.required or raw.request.required says so. */
function isRequired(item) {
	const raw = item?.raw ?? {};
	return raw.required === true || raw.request?.required === true;
}

/** The recommended option of the first question that carries one; null when none does. */
export function recommendedChoice(item) {
	const request = item?.raw?.request;
	const questions = Array.isArray(request?.questions) ? request.questions : [];
	for (const question of questions) {
		const index = recommendedOption({ questions: [question] });
		if (index == null) continue;
		const option = Array.isArray(question?.options) ? question.options[index] : null;
		const label = String(option?.label ?? "").trim();
		if (!label) continue;
		return { questionId: question?.id == null ? null : String(question.id), label: clip(label, 20) };
	}
	return null;
}

/** Closed, answered or delivered items, and items the session moved past, never push. */
function cancelled(item, options = {}) {
	if (item.status != null && item.status !== "open") return true;
	const createdAt = timeOf(item.createdAt);
	const activityAt = timeOf(options.activityAt ?? item.lastActivityAt);
	return createdAt != null && activityAt != null && activityAt > createdAt;
}

function pushable(item, mode) {
	if (NO_PUSH_POLICIES.has(item.policy)) return false;
	if (item.kind === "board" && mode === "trial") return false;
	return item.policy === "needs-you";
}

/**
 * C9 table: `{push, holdMs, actions}` for one item.
 * `options.kind` is `"item"` (default) or `"cache"`; a cache reminder needs `minutesLeft` and
 * carries the hold that is left until `warmUntil - leadMinutes`.
 */
export function pushPlan(item, thread, mode = "primary", options = {}) {
	if (!item || typeof item !== "object") return { ...NO_PLAN };
	const now = timeOf(options.now) ?? Date.now();
	if ((options.kind ?? "item") === "cache") {
		const at = cacheReminderAt(item, thread, options.leadMinutes ?? CACHE_LEAD_MINUTES, { now });
		if (at == null) return { ...NO_PLAN };
		return { push: true, holdMs: Math.max(0, at - now), actions: [{ ...OPEN_ACTION }] };
	}
	if (cancelled(item, options)) return { ...NO_PLAN };
	if (!pushable(item, mode)) return { ...NO_PLAN };
	const actions = [];
	if (item.kind === "question" && !isRequired(item)) {
		const rec = recommendedChoice(item);
		if (rec) actions.push({ action: "rec", title: `권장: ${rec.label}` });
	}
	actions.push({ ...OPEN_ACTION });
	return { push: true, holdMs: HOLD_BY_KIND[item.kind] ?? HOLD_TURN_MS, actions: actions.slice(0, MAX_ACTIONS) };
}

/**
 * The instant the cache reminder is due, or null when there is nothing to remind about:
 * the item must still be open and needs-you, the thread must have no active goal, and
 * `warmUntil - leadMinutes` must still be in the future. Callers key it `cache:<itemId>:<warmUntil>`
 * so one (item, warmUntil) pair reminds exactly once.
 */
export function cacheReminderAt(item, thread, leadMinutes = CACHE_LEAD_MINUTES, options = {}) {
	const now = timeOf(options.now) ?? Date.now();
	if (!item || typeof item !== "object") return null;
	if ((item.status ?? "open") !== "open") return null;
	if ((item.policy ?? "needs-you") !== "needs-you") return null;
	if (isGoalActive(thread)) return null;
	const warmUntil = timeOf(item.raw?.warmUntil ?? thread?.cacheUntil);
	if (warmUntil == null) return null;
	const lead = Number(leadMinutes);
	const minutes = Number.isFinite(lead) && lead >= 0 ? lead : CACHE_LEAD_MINUTES;
	const at = warmUntil - minutes * 60_000;
	return at > now ? at : null;
}

/**
 * Push wait for the model summary: when the hold fires while the summary is still the heuristic one
 * and a model summary was asked for, the push waits up to SUMMARY_WAIT_MS more. Returns the deadline
 * (epoch ms) or null when the push should go out now. `askedAt` is when the model summary was requested.
 */
export function summaryWaitDeadline(item, askedAt, now, holdMs = 0) {
	const asked = timeOf(askedAt);
	if (asked == null || item?.summary?.source !== "heuristic" || !(Number(holdMs) > 0)) return null;
	const at = timeOf(now) ?? Date.now();
	const hold = Number.isFinite(Number(holdMs)) ? Number(holdMs) : 0;
	return at - asked < hold + SUMMARY_WAIT_MS ? at + SUMMARY_WAIT_MS : null;
}

function jsonBytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Keep the payload under the push service limit: shrink text, then drop optional extras. */
function fitPayload(payload, limit = MAX_PAYLOAD_BYTES) {
	const out = { ...payload };
	if (jsonBytes(out) <= limit) return out;
	while (out.body && jsonBytes(out) > limit) out.body = out.body.slice(0, -1);
	while (out.title && jsonBytes(out) > limit) out.title = out.title.slice(0, -1);
	if (jsonBytes(out) > limit) delete out.rec;
	if (jsonBytes(out) > limit && Array.isArray(out.actions) && out.actions.length > 1) out.actions = out.actions.slice(0, 1);
	if (jsonBytes(out) > limit) delete out.actions;
	return out;
}

/**
 * The JSON the phone receives (C9): title, body, url, tag, renotify, itemId, actions and rec.
 * Session text in the title and the body is redacted and clipped; the result is at most
 * `options.maxBytes` (3000) bytes.
 */
export function buildPushPayload(item, thread, summary = null, options = {}) {
	const view = summary && typeof summary === "object" ? summary : {};
	const kind = options.kind ?? "item";
	const sid = String(item?.session ?? thread?.session ?? "");
	const itemId = item?.itemId ?? null;
	const headline = String(view.headline ?? "");
	const ask = String(view.ask ?? "");
	const threadTitle = String(thread?.title ?? thread?.session ?? "");
	const bodyText =
		kind === "cache"
			? [threadTitle, headline].filter(Boolean).join(" — ")
			: `${headline}${ask ? ` — ${ask}` : ""}`;
	const minutesLeft = Math.max(0, Math.round(Number(options.minutesLeft) || 0));
	const payload = {
		title: clip(kind === "cache" ? `${CACHE_TITLE} 캐시가 ${minutesLeft}분 뒤 식습니다` : `${TITLE_PREFIX}${redact(threadTitle)}`, MAX_TITLE),
		body: clip(redact(bodyText), MAX_BODY),
		url: `/s/${encodeURIComponent(sid)}#${itemId ?? ""}`,
		tag: `s-${sid}`,
		renotify: true,
		itemId,
	};
	if (kind !== "cache") {
		const plan = pushPlan(item, thread, options.mode ?? "primary", options);
		if (plan.actions.length) payload.actions = plan.actions;
		const rec = plan.actions.some((action) => action.action === "rec") ? recommendedChoice(item) : null;
		if (rec) payload.rec = rec;
	} else {
		payload.actions = [{ ...OPEN_ACTION }];
	}
	return fitPayload(payload, options.maxBytes ?? MAX_PAYLOAD_BYTES);
}

/** RFC 8030 section 5.4 Topic: the first 32 base64url characters of the session id hash. */
export function topicFor(sessionId) {
	return crypto.createHash("sha256").update(String(sessionId ?? ""), "utf8").digest("base64url").slice(0, 32);
}

/**
 * Timer wrapper with an injected clock. `schedule(key, atMs, fn)` arms one timer per key;
 * `cancel(key)` drops it, `cancelPrefix(prefix)` drops a family of keys (for example every
 * `cache:` reminder of one item) and `pending()` lists what is still armed. A callback is
 * removed from `pending()` before it runs, so a reschedule inside `fn` wins.
 */
export function createScheduler({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
	const entries = new Map();

	function cancel(key) {
		const entry = entries.get(key);
		if (!entry) return false;
		entries.delete(key);
		clearTimer(entry.handle);
		return true;
	}

	function schedule(key, atMs, fn) {
		if (typeof key !== "string" || !key) throw new Error("key is required");
		if (typeof fn !== "function") throw new Error("fn is required");
		cancel(key);
		const target = Number(atMs);
		if (!Number.isFinite(target)) throw new Error("atMs must be a number");
		let handle = null;
		handle = setTimer(() => {
			const current = entries.get(key);
			if (!current || current.handle !== handle) return;
			entries.delete(key);
			try {
				fn();
			} catch (error) {
				log(`timer ${key} failed: ${error && error.stack ? error.stack : error}`);
			}
		}, Math.max(0, target - now()));
		entries.set(key, { key, atMs: target, handle, fn });
		return key;
	}

	function cancelPrefix(prefix) {
		let cancelled = 0;
		for (const key of [...entries.keys()]) {
			if (key.startsWith(prefix)) cancelled += cancel(key) ? 1 : 0;
		}
		return cancelled;
	}

	function pending() {
		return [...entries.values()]
			.map((entry) => ({ key: entry.key, atMs: entry.atMs }))
			.sort((a, b) => a.atMs - b.atMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}

	return { schedule, cancel, cancelPrefix, pending };
}
