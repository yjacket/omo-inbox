// Stall watchdog (GAP-8). A session that keeps claiming an active wait but produces no
// lines is caught after a long idle, without depending on real time in tests.

const MIN_STALL_MINUTES = 5;
const MAX_STALL_MINUTES = 240;
const DEFAULT_STALL_MINUTES = 60;
const OVERDUE_LIMIT_MS = 60 * 60_000;

/** Epoch milliseconds from a Date, an ISO string or a number; null when unusable. */
function timeOf(value) {
	if (value == null) return null;
	if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const parsed = Date.parse(String(value));
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Timer wrapper keyed by (session, episode). One deadline per entry:
 * `max(lastLineAt, idleSince) + stallMs`, so a line that arrives after the session went
 * idle starts a fresh stall, while an idle report after a busy spell covers lines that
 * came during the work. A busy report suspends every timer of the session; the next idle
 * report re-arms them. A fired or cancelled entry is gone, so `onFire` runs once.
 */
export function createStallWatch({ setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, stallMs, onFire } = {}) {
	const stall = Number(stallMs);
	if (!Number.isFinite(stall) || stall < 0) throw new Error("stallMs must be a non-negative number");
	if (typeof onFire !== "function") throw new Error("onFire is required");

	const sessions = new Map();
	const clock = () => {
		const value = now();
		return value instanceof Date ? value.getTime() : Number(value);
	};

	function ensure(sid) {
		let state = sessions.get(sid);
		if (!state) {
			state = { idle: false, idleSince: null, entries: new Map() };
			sessions.set(sid, state);
		}
		return state;
	}

	function disarm(entry) {
		if (entry.handle == null) return;
		clearTimer(entry.handle);
		entry.handle = null;
	}

	function armEntry(sid, state, entry) {
		disarm(entry);
		if (!state.idle) return;
		const last = timeOf(entry.lastLineAt);
		if (last == null) return;
		const idleSince = state.idleSince ?? last;
		const atMs = Math.max(last, idleSince) + stall;
		const handle = setTimer(() => {
			const current = sessions.get(sid);
			if (!current || current.entries.get(entry.key) !== entry) return;
			if (!current.idle) return;
			current.entries.delete(entry.key);
			entry.handle = null;
			onFire(sid, entry.key);
		}, Math.max(0, atMs - clock()));
		entry.handle = handle;
		entry.atMs = atMs;
	}

	/** Register or refresh one episode line. `lastLineAt` may be epoch ms, Date or ISO text. */
	function arm(sid, key, lastLineAt) {
		if (typeof key !== "string" || !key) throw new Error("key is required");
		const last = timeOf(lastLineAt);
		if (last == null) throw new Error("lastLineAt must be a time");
		const state = ensure(sid);
		const entry = { key, lastLineAt: last, handle: null, atMs: null };
		const previous = state.entries.get(key);
		if (previous) disarm(previous);
		state.entries.set(key, entry);
		armEntry(sid, state, entry);
		return entry.atMs;
	}

	/** Feed the session's idle status. Busy clears timers; idle starts a fresh deadline. */
	function idle(sid, isIdle) {
		const state = ensure(sid);
		const next = Boolean(isIdle);
		if (next === state.idle) {
			if (next) {
				for (const entry of state.entries.values()) if (entry.handle == null && entry.atMs == null) armEntry(sid, state, entry);
			}
			return;
		}
		state.idle = next;
		state.idleSince = next ? clock() : null;
		if (!next) {
			for (const entry of state.entries.values()) disarm(entry);
			return;
		}
		for (const entry of state.entries.values()) armEntry(sid, state, entry);
	}

	/** Drop one episode timer, for example when its final is posted. */
	function cancel(sid, key) {
		const state = sessions.get(sid);
		const entry = state?.entries.get(key);
		if (!entry) return false;
		disarm(entry);
		state.entries.delete(key);
		return true;
	}

	/**
	 * Restore entries after a restart. A deadline already passed by less than an hour fires
	 * at once; older ones are dropped, matching server.mjs's OVERDUE_LIMIT_MS rebuild rule.
	 */
	function rebuild(list) {
		const at = clock();
		for (const row of Array.isArray(list) ? list : []) {
			const last = timeOf(row?.lastLineAt);
			if (last == null || typeof row.key !== "string" || !row.key) continue;
			const state = ensure(row.sid);
			const previous = state.entries.get(row.key);
			if (previous) {
				disarm(previous);
				state.entries.delete(row.key);
			}
			state.idle = true;
			state.idleSince = last;
			const dueAt = last + stall;
			const overdue = at - dueAt;
			if (overdue >= OVERDUE_LIMIT_MS) continue;
			if (overdue >= 0) {
				onFire(row.sid, row.key);
				continue;
			}
			const entry = { key: row.key, lastLineAt: last, handle: null, atMs: null };
			state.entries.set(row.key, entry);
			armEntry(row.sid, state, entry);
		}
	}

	function pending() {
		const out = [];
		for (const [sid, state] of sessions) {
			for (const entry of state.entries.values()) {
				if (entry.handle != null) out.push({ sid, key: entry.key, atMs: entry.atMs });
			}
		}
		return out.sort((a, b) => a.atMs - b.atMs || (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}

	return { arm, idle, cancel, rebuild, pending };
}

/**
 * `INBOX_EPISODE_STALL_MS` (milliseconds, used as-is for QA) wins over
 * `episode.stallMinutes`, clamped to 5..240, default 60.
 */
export function stallMsFrom(config = {}, env = {}) {
	const fromEnv = Number(env?.INBOX_EPISODE_STALL_MS);
	if (env?.INBOX_EPISODE_STALL_MS != null && env.INBOX_EPISODE_STALL_MS !== "" && Number.isFinite(fromEnv) && fromEnv > 0) {
		return fromEnv;
	}
	const raw = Number(config?.episode?.stallMinutes);
	const minutes = Number.isFinite(raw) ? Math.min(MAX_STALL_MINUTES, Math.max(MIN_STALL_MINUTES, raw)) : DEFAULT_STALL_MINUTES;
	return minutes * 60_000;
}
