/**
 * omo-inbox episode reducer (plan todo 2): the pure state machine behind "one owner request, one report".
 *
 * No I/O, no timers, no imports: every function takes `now` (ms) from the caller, and signals arrive as the
 * plain event payloads the runtime emits. capture.ts owns the wiring; this module only decides.
 *
 * Wake and hold signals are LEVEL state: the runtime emits them on change, so nothing here is reset at agent
 * end. A source clears only when it reports 0 / false, or when its terminal entries stop qualifying.
 */

/** C4 step 6 and the runtime's own self-source: a self count never keeps an episode open, a self hold does. */
const SELF_SOURCE = "omo-inbox";
const TERMINAL_SESSIONS_SOURCE = "terminal-background-sessions";
const TERMINAL_MONITORS_SOURCE = "terminal-monitors";
const OWNER_MARK_TTL_MS = 30 * 60 * 1000;
const RELOAD_GRACE_MS = 60 * 1000;
const OWNER_CAUSES = new Set(["terminal", "phone", "question-answer", "board-feedback"]);

export type OwnerCause = "terminal" | "phone" | "question-answer" | "board-feedback";

type Entry = { id: string, startedAtMs: number | null, persistent: boolean | null, paused: boolean | null };
type Source = { count: number, entries: Entry[] | null };
type Episode = {
	key: string,
	opener: number,
	openedAt: number,
	seq: number,
	lines: number,
	turns: number,
	interjections: number,
	questions: number,
	/** Opened by the latest agent start and no line posted yet: the only state adoptReopen may replace. */
	provisional: boolean,
};
type LastStart = { stamp: number, now: number, cause: "owner" | "system", opened: boolean };

export type EpisodeState = {
	sid: string,
	episode: Episode | null,
	sources: Map<string, Source>,
	holds: Map<string, boolean>,
	scheduled: boolean,
	ownerMark: { cause: OwnerCause, at: number } | null,
	graceUntil: number,
	lastStart: LastStart | null,
	lastNow: number,
};

export type EpisodeMeta = {
	key: string,
	opener: number,
	openedAt: number,
	closedAt: number,
	closeReason: string,
	lines: number,
	turns: number,
	interjections: number,
	questions: number,
};

export type Verdict = {
	action: "line-only" | "close",
	kind: "progress" | "turn" | "blocked" | "done",
	policy: "progress" | "quiet" | "needs-you",
	closeReason: "aborted" | "blocked" | "done" | "stalled" | "needs-you" | null,
	stalled: boolean,
	reasons: string[],
};

export function createEpisodeState(sid: string): EpisodeState {
	return {
		sid,
		episode: null,
		sources: new Map(),
		holds: new Map(),
		scheduled: false,
		ownerMark: null,
		graceUntil: 0,
		lastStart: null,
		lastNow: 0,
	};
}

// --- signals ---------------------------------------------------------------

/**
 * Observe one runtime signal. `channel` is the event name: wake_source_state, continuation_hold_state,
 * terminal_monitor_state, goal_continuation_timer_state or goal_continuation_scheduled. Unknown channels and
 * malformed payloads are ignored.
 */
export function observeSignal(state: EpisodeState, channel: string, event: any): void {
	if (event === null || typeof event !== "object") return;
	if (channel === "wake_source_state") {
		if (typeof event.source !== "string" || event.source.length === 0) return;
		observeCount(state, event.source, event);
		return;
	}
	if (channel === "terminal_monitor_state") {
		observeCount(state, TERMINAL_MONITORS_SOURCE, event);
		return;
	}
	if (channel === "continuation_hold_state") {
		if (typeof event.source !== "string" || event.source.length === 0 || typeof event.active !== "boolean") return;
		if (event.active) state.holds.set(event.source, true);
		else state.holds.delete(event.source);
		return;
	}
	if (channel === "goal_continuation_timer_state") {
		if (typeof event.armed === "boolean") state.scheduled = event.armed;
		return;
	}
	if (channel === "goal_continuation_scheduled") {
		if (typeof event.delayMs === "number" || Array.isArray(event.wakeSources)) state.scheduled = true;
	}
}

function observeCount(state: EpisodeState, source: string, event: any): void {
	const list = Array.isArray(event.items) ? event.items : Array.isArray(event.monitors) ? event.monitors : null;
	const count = typeof event.activeCount === "number" ? event.activeCount : list !== null ? list.length : null;
	if (count === null) return;
	if (count <= 0) {
		state.sources.delete(source);
		return;
	}
	const terminal = source === TERMINAL_SESSIONS_SOURCE || source === TERMINAL_MONITORS_SOURCE;
	if (!terminal || list === null) {
		state.sources.set(source, { count, entries: null });
		return;
	}
	// The wake event of terminal-monitors omits persistent/paused; the monitor-state event carries them. Keep the
	// flags a previous event gave the same id, so the order of the two events does not matter.
	const previous = new Map<string, Entry>();
	for (const entry of state.sources.get(source)?.entries ?? []) previous.set(entry.id, entry);
	const entries = list.map((raw: any): Entry => {
		const id = String(raw?.id ?? "");
		const known = previous.get(id);
		return {
			id,
			startedAtMs: typeof raw?.startedAtMs === "number" ? raw.startedAtMs : null,
			persistent: typeof raw?.persistent === "boolean" ? raw.persistent : known?.persistent ?? null,
			paused: typeof raw?.paused === "boolean" ? raw.paused : known?.paused ?? null,
		};
	});
	state.sources.set(source, { count, entries });
}

/** Standing monitors across every source: persistent entries that are not paused. They outlive the episode. */
export function standingCount(state: EpisodeState): number {
	let total = 0;
	for (const source of state.sources.values()) {
		for (const entry of source.entries ?? []) {
			if (entry.persistent === true && entry.paused !== true) total += 1;
		}
	}
	return total;
}

/** Terminal entries count only when started inside this episode and neither standing (persistent) nor paused. */
function countOf(source: Source, openedAt: number): number {
	if (source.entries === null) return source.count;
	let total = 0;
	for (const entry of source.entries) {
		if (entry.persistent === true || entry.paused === true) continue;
		if (entry.startedAtMs === null || entry.startedAtMs < openedAt) continue;
		total += 1;
	}
	return total;
}

// --- owner marks -----------------------------------------------------------

/** An owner message was sent; the next agent start is attributed to the owner (one-shot, expires after 30 min). */
export function markOwner(state: EpisodeState, cause: string, now: number): void {
	touch(state, now);
	if (!OWNER_CAUSES.has(cause)) return;
	state.ownerMark = { cause: cause as OwnerCause, at: now };
}

// --- episode lifecycle -----------------------------------------------------

function touch(state: EpisodeState, now: number): void {
	if (typeof now === "number" && Number.isFinite(now) && now > state.lastNow) state.lastNow = now;
}

function validStamp(stamp: unknown): stamp is number {
	return typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0;
}

function openEpisode(state: EpisodeState, stamp: number, now: number): Episode {
	// An empty branch gives stamp 0 (the user message is not persisted yet): fall back to the clock so two
	// episodes of one session never share a key. Same inputs still give the same key.
	const opener = validStamp(stamp) ? stamp : Math.floor(now);
	return {
		key: `e:${state.sid}:${opener}`,
		opener,
		openedAt: now,
		seq: 0,
		lines: 0,
		turns: 1,
		interjections: 0,
		questions: 0,
		provisional: true,
	};
}

/**
 * An agent run starts. Opens `e:<sid>:<stamp>` when no episode is open, otherwise extends the open one (owner
 * causes count as interjections). A system start that opens a new episode is provisional: the server may answer
 * that it continues an older stalled or unpushed final (adoptReopen).
 */
export function onAgentStart(state: EpisodeState, input: { stamp: number, now: number }): { key: string, opened: boolean, reopened: boolean, cause: "owner" | "system" } {
	const now = input.now;
	touch(state, now);
	let cause: "owner" | "system" = "system";
	if (state.ownerMark !== null) {
		if (now - state.ownerMark.at <= OWNER_MARK_TTL_MS) cause = "owner";
		state.ownerMark = null;
	}
	state.scheduled = false;
	let opened = false;
	if (state.episode === null) {
		state.episode = openEpisode(state, input.stamp, now);
		opened = true;
	} else {
		state.episode.turns += 1;
		if (cause === "owner") state.episode.interjections += 1;
		state.episode.provisional = false;
	}
	state.lastStart = { stamp: input.stamp, now, cause, opened };
	return { key: state.episode.key, opened, reopened: false, cause };
}

/**
 * The server answered the agent-start post with `reopen`: continue that older episode (same key, opener,
 * openedAt and seq) instead of the provisional one. Applies only when this agent start opened the provisional
 * episode and no line was posted yet; otherwise ignored.
 */
export function adoptReopen(state: EpisodeState, input: { key: string, opener: number, openedAt: number, seq: number }): { adopted: boolean, key: string | null, reopened: boolean } {
	const episode = state.episode;
	if (episode === null || !episode.provisional || episode.lines > 0 || input === null || typeof input !== "object") {
		return { adopted: false, key: episode?.key ?? null, reopened: false };
	}
	if (typeof input.key !== "string" || input.key.length === 0) return { adopted: false, key: episode.key, reopened: false };
	const seq = Number.isFinite(input.seq) && input.seq > 0 ? Math.floor(input.seq) : 0;
	state.episode = {
		key: input.key,
		opener: Number.isFinite(input.opener) ? input.opener : episode.opener,
		openedAt: Number.isFinite(input.openedAt) ? input.openedAt : episode.openedAt,
		seq,
		lines: seq,
		turns: episode.turns,
		interjections: episode.interjections,
		questions: episode.questions,
		provisional: false,
	};
	return { adopted: true, key: input.key, reopened: true };
}

/**
 * The agent-start response told us the episode we extended was already closed on the server (the stall
 * watchdog's final). A new owner request B never inherits A: switch to a new key. A system start keeps the key
 * only when A was closed `stalled` (A resumed); after any other close it is new work, so it gets a new key too.
 */
export function applyServerState(state: EpisodeState, input: { episodeClosed?: boolean, closeReason?: string | null }): { switched: boolean, key: string | null } {
	const episode = state.episode;
	const start = state.lastStart;
	if (episode === null || start === null || input === null || typeof input !== "object") return { switched: false, key: episode?.key ?? null };
	if (input.episodeClosed !== true || start.opened) return { switched: false, key: episode.key };
	if (start.cause === "system" && input.closeReason === "stalled") return { switched: false, key: episode.key };
	state.episode = openEpisode(state, start.stamp, start.now);
	state.episode.provisional = false;
	return { switched: true, key: state.episode.key };
}

/** The identity a line or the hold state carries: {key, opener, openedAt, seq}. Null when no episode is open. */
export function currentEpisode(state: EpisodeState): { key: string, opener: number, openedAt: number, seq: number } | null {
	const episode = state.episode;
	if (episode === null) return null;
	return { key: episode.key, opener: episode.opener, openedAt: episode.openedAt, seq: episode.seq };
}

/** A line was posted for the open episode; returns its sequence number (1-based). */
export function noteLine(state: EpisodeState): number {
	const episode = state.episode;
	if (episode === null) return 0;
	episode.seq += 1;
	episode.lines += 1;
	episode.provisional = false;
	return episode.seq;
}

export function noteQuestion(state: EpisodeState): void {
	if (state.episode !== null) state.episode.questions += 1;
}

/** Dedupe key of a progress line: the assistant message stamp, or episode and sequence when there is no stamp. */
export function lineKey(sid: string, stamp: number, episodeKey: string, seq: number): string {
	if (validStamp(stamp)) return `line:${sid}:m${stamp}`;
	return `line:${sid}:${episodeKey}:${seq}`;
}

/** Close the open episode. `now` defaults to the newest clock value any call has seen. Null when none is open. */
export function closeEpisode(state: EpisodeState, closeReason: string, lastStamp: number, now?: number): { dedupeKey: string, meta: EpisodeMeta } | null {
	const episode = state.episode;
	if (episode === null) return null;
	if (now !== undefined) touch(state, now);
	const stamp = typeof lastStamp === "number" && Number.isFinite(lastStamp) ? lastStamp : 0;
	const meta: EpisodeMeta = {
		key: episode.key,
		opener: episode.opener,
		openedAt: episode.openedAt,
		closedAt: now ?? state.lastNow,
		closeReason,
		lines: episode.lines,
		turns: episode.turns,
		interjections: episode.interjections,
		questions: episode.questions,
	};
	state.episode = null;
	state.graceUntil = 0;
	return { dedupeKey: `episode:${state.sid}:${episode.opener}:${closeReason}:m${stamp}`, meta };
}

// --- restore ---------------------------------------------------------------

function timeOf(value: unknown): number {
	if (typeof value === "number") return value;
	const parsed = Date.parse(String(value ?? ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * After a reload or restart, rebuild the episode from the thread's items (any order). The newest item with
 * meta.episode decides: a line with no final after it opens the episode again (a quit, closed `session-closed`,
 * ends the span) with a 60 s grace for the runtime to re-publish its signals; a `stalled` final closed
 * `superseded` means the work resumed, so the same key opens again; any other final leaves the state idle.
 */
export function restore(state: EpisodeState, items: any[], now: number): { restored: boolean, key: string | null } {
	touch(state, now);
	state.episode = null;
	state.graceUntil = 0;
	if (!Array.isArray(items)) return { restored: false, key: null };
	let newest: any = null;
	let newestAt = -1;
	for (const item of items) {
		const episode = item?.meta?.episode;
		if (episode === null || typeof episode !== "object" || typeof episode.key !== "string") continue;
		const at = timeOf(item.createdAt);
		if (at >= newestAt) {
			newest = item;
			newestAt = at;
		}
	}
	if (newest === null) return { restored: false, key: null };
	const meta = newest.meta.episode;
	const closedReason = newest.closedReason ?? newest.closeReason ?? null;
	const isFinal = typeof meta.closeReason === "string" && meta.closeReason.length > 0;
	let seq: number;
	if (isFinal) {
		if (meta.closeReason !== "stalled" || closedReason !== "superseded") return { restored: false, key: null };
		seq = Number.isFinite(meta.lines) ? Math.floor(meta.lines) : 0;
	} else {
		if (newest.status === "closed" && closedReason === "session-closed") return { restored: false, key: null };
		seq = Number.isFinite(meta.seq) ? Math.floor(meta.seq) : 0;
	}
	const openedAt = Number.isFinite(meta.openedAt) ? meta.openedAt : newestAt;
	let questions = 0;
	for (const item of items) {
		if (item?.kind === "question" && timeOf(item.createdAt) >= openedAt) questions += 1;
	}
	state.episode = {
		key: meta.key,
		opener: Number.isFinite(meta.opener) ? meta.opener : openedAt,
		openedAt,
		seq,
		lines: seq,
		turns: Number.isFinite(meta.turns) ? Math.floor(meta.turns) : 1,
		interjections: Number.isFinite(meta.interjections) ? Math.floor(meta.interjections) : 0,
		questions,
		provisional: false,
	};
	state.graceUntil = now + RELOAD_GRACE_MS;
	return { restored: true, key: meta.key };
}

// --- verdicts --------------------------------------------------------------

function sizeOf(value: unknown): number {
	if (typeof value === "number") return value;
	if (value === null || value === undefined) return 0;
	const set = value as { size?: unknown, length?: unknown };
	if (typeof set.size === "number") return set.size;
	if (typeof set.length === "number") return set.length;
	return 0;
}

/**
 * Whether the session will wake itself or wait on the owner. `reasons` are deduplicated in a fixed order:
 * ask-user, dialog, other wake sources sorted, terminal-monitors, hold:<source> sorted (self included), scheduled,
 * reload-grace. A self (`omo-inbox`) count never counts; a self hold does. `goalActive` is accepted for the
 * caller's symmetry: the reload grace applies with or without a goal.
 */
export function willWake(state: EpisodeState, input: { openQuestions?: unknown, openDialogs?: unknown, goalActive?: boolean, now: number }): { wake: boolean, reasons: string[] } {
	touch(state, input.now);
	const reasons = new Set<string>();
	const openedAt = state.episode?.openedAt ?? Number.NEGATIVE_INFINITY;
	const counted = new Map<string, number>();
	for (const [source, entry] of state.sources) counted.set(source, countOf(entry, openedAt));
	if (sizeOf(input.openQuestions) > 0 || (counted.get("ask-user") ?? 0) > 0) reasons.add("ask-user");
	if (sizeOf(input.openDialogs) > 0) reasons.add("dialog");
	const others = [...counted.keys()]
		.filter((source) => source !== "ask-user" && source !== SELF_SOURCE && source !== TERMINAL_MONITORS_SOURCE)
		.sort();
	for (const source of others) {
		if ((counted.get(source) ?? 0) > 0) reasons.add(source);
	}
	if ((counted.get(TERMINAL_MONITORS_SOURCE) ?? 0) > 0) reasons.add(TERMINAL_MONITORS_SOURCE);
	for (const source of [...state.holds.keys()].sort()) {
		if (state.holds.get(source) === true) reasons.add(`hold:${source}`);
	}
	if (state.scheduled) reasons.add("scheduled");
	if (state.graceUntil > input.now) reasons.add("reload-grace");
	return { wake: reasons.size > 0, reasons: [...reasons] };
}

function pendingKind(pending: unknown): "done" | "blocked" | null {
	if (pending === null || pending === undefined) return null;
	const value = typeof pending === "string"
		? pending
		: String((pending as any).kind ?? (pending as any).status ?? (pending as any).reason ?? "");
	if (value === "done" || value === "complete") return "done";
	if (value === "blocked") return "blocked";
	return null;
}

/**
 * The turn-end decision, in this order: user abort -> quiet close; goal blocked -> blocked; goal complete in this
 * run or a pending done -> done (explicit goal end states close whatever is still waiting); willWake -> a line
 * only; goal active -> stalled turn; else a plain needs-you turn.
 */
export function verdict(state: EpisodeState, input: {
	aborted?: boolean,
	abortSource?: string,
	goal?: any,
	goalCompletedInRun?: boolean,
	goalBlockedInRun?: boolean,
	pendingClose?: unknown,
	openQuestions?: unknown,
	openDialogs?: unknown,
	now: number,
}): Verdict {
	const pending = pendingKind(input.pendingClose);
	const goalActive = input.goal?.status === "active" && input.goal.continuationStoppedAt === undefined;
	const wake = willWake(state, { openQuestions: input.openQuestions, openDialogs: input.openDialogs, goalActive, now: input.now });
	const close = (kind: Verdict["kind"], policy: Verdict["policy"], closeReason: NonNullable<Verdict["closeReason"]>, stalled = false): Verdict => ({
		action: "close",
		kind,
		policy,
		closeReason,
		stalled,
		reasons: wake.reasons,
	});
	if (input.aborted === true && input.abortSource === "user") return close("turn", "quiet", "aborted");
	if (input.goalBlockedInRun === true || pending === "blocked") return close("blocked", "needs-you", "blocked");
	if (input.goalCompletedInRun === true || pending === "done") return close("done", "needs-you", "done");
	if (wake.wake) {
		return { action: "line-only", kind: "progress", policy: "progress", closeReason: null, stalled: false, reasons: wake.reasons };
	}
	if (goalActive) return close("turn", "needs-you", "stalled", true);
	return close("turn", "needs-you", "needs-you");
}
