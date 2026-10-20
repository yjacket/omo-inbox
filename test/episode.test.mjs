// Episode reducer tests (plan todo 2): pure state machine, no timers, no I/O.
// Run: node --test test/episode.test.mjs
// Time is a plain number the test passes in; nothing here waits on the clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	adoptReopen,
	applyServerState,
	closeEpisode,
	createEpisodeState,
	currentEpisode,
	lineKey,
	markOwner,
	noteLine,
	noteQuestion,
	observeSignal,
	onAgentStart,
	restore,
	verdict,
	willWake,
} from "../extension/inbox/episode.ts";

const SID = "s-1";
const T0 = 10_000_000;
const MIN = 60_000;
const NONE = { openQuestions: 0, openDialogs: 0 };

function started(stamp = 500, now = T0) {
	const state = createEpisodeState(SID);
	const result = onAgentStart(state, { stamp, now });
	return { state, result };
}

function turnEnd(state, over = {}) {
	return verdict(state, { aborted: false, abortSource: "", goal: null, goalCompletedInRun: false, pendingClose: null, ...NONE, now: T0 + 1000, ...over });
}

const ACTIVE_GOAL = { status: "active" };

// --- signals ---------------------------------------------------------------

test("wake and hold signals survive agent end and clear only when the source reports 0 or false", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 2 });
	observeSignal(state, "continuation_hold_state", { source: "omo-dag", active: true });
	// Agent end changes nothing here; the settle verdict reads the same state any number of times.
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 5000 }).reasons, ["senpi-task", "hold:omo-dag"]);
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 6000 }).reasons, ["senpi-task", "hold:omo-dag"]);
	// A following agent start does not reset them either.
	onAgentStart(state, { stamp: 600, now: T0 + 7000 });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 7500 }).reasons, ["senpi-task", "hold:omo-dag"]);
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 0 });
	observeSignal(state, "continuation_hold_state", { source: "omo-dag", active: false });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 8000 }), { wake: false, reasons: [] });
});

test("a self hold counts, a self count does not, an omo-desk count does", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "omo-inbox", activeCount: 1 });
	assert.equal(willWake(state, { ...NONE, now: T0 }).wake, false);
	observeSignal(state, "continuation_hold_state", { source: "omo-inbox", active: true });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 }), { wake: true, reasons: ["hold:omo-inbox"] });
	observeSignal(state, "continuation_hold_state", { source: "omo-inbox", active: false });
	assert.equal(willWake(state, { ...NONE, now: T0 }).wake, false);
	observeSignal(state, "wake_source_state", { source: "omo-desk", activeCount: 1 });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 }), { wake: true, reasons: ["omo-desk"] });
});

test("sources without items count by activeCount; malformed events are ignored", () => {
	const { state } = started();
	for (const source of ["senpi-task", "omo-dag", "senpi-codemode"]) {
		observeSignal(state, "wake_source_state", { source, activeCount: 1 });
	}
	observeSignal(state, "wake_source_state", { activeCount: 5 });
	observeSignal(state, "wake_source_state", null);
	observeSignal(state, "no_such_channel", { source: "x", activeCount: 1 });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 }).reasons, ["omo-dag", "senpi-codemode", "senpi-task"]);
});

test("timer_state armed sets scheduled and unarmed clears it; the secondary setter only sets", () => {
	const { state } = started();
	observeSignal(state, "goal_continuation_timer_state", { armed: true });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 }), { wake: true, reasons: ["scheduled"] });
	observeSignal(state, "goal_continuation_timer_state", { armed: false });
	assert.equal(willWake(state, { ...NONE, now: T0 }).wake, false);
	observeSignal(state, "goal_continuation_scheduled", { delayMs: 5000 });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 }).reasons, ["scheduled"]);
	observeSignal(state, "goal_continuation_timer_state", { armed: false });
	observeSignal(state, "goal_continuation_scheduled", { wakeSources: ["senpi-task"] });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 }).reasons, ["scheduled"]);
	// The next agent start consumes the scheduled continuation.
	onAgentStart(state, { stamp: 700, now: T0 + 1 });
	assert.equal(willWake(state, { ...NONE, now: T0 + 2 }).wake, false);
});

test("terminal entries count only when started in the episode, not persistent, not paused", () => {
	const { state } = started(500, T0);
	observeSignal(state, "wake_source_state", {
		source: "terminal-background-sessions",
		activeCount: 2,
		items: [
			{ id: "bg-old", startedAtMs: T0 - 5 * MIN },
			{ id: "bg-new", startedAtMs: T0 + 1000 },
		],
	});
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 2000 }).reasons, ["terminal-background-sessions"]);

	const monitors = [
		{ id: "m-standing", startedAtMs: T0 + 10, persistent: true, paused: false },
		{ id: "m-paused", startedAtMs: T0 + 20, persistent: false, paused: true },
		{ id: "m-before", startedAtMs: T0 - 1, persistent: false, paused: false },
	];
	observeSignal(state, "terminal_monitor_state", { activeCount: 3, monitors });
	assert.equal(willWake(state, { ...NONE, now: T0 + 2000 }).reasons.includes("terminal-monitors"), false);
	observeSignal(state, "terminal_monitor_state", { activeCount: 4, monitors: [...monitors, { id: "m-live", startedAtMs: T0 + 30, persistent: false, paused: false }] });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 2000 }).reasons, ["terminal-background-sessions", "terminal-monitors"]);
});

test("a persistent monitor and a background session started before the episode do not keep it open", () => {
	const state = createEpisodeState(SID);
	observeSignal(state, "terminal_monitor_state", { activeCount: 1, monitors: [{ id: "m1", startedAtMs: T0 - MIN, persistent: true, paused: false }] });
	observeSignal(state, "wake_source_state", { source: "terminal-background-sessions", activeCount: 1, items: [{ id: "dev-server", startedAtMs: T0 - 10 * MIN }] });
	onAgentStart(state, { stamp: 500, now: T0 });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 1 }), { wake: false, reasons: [] });
	assert.equal(turnEnd(state, { goal: ACTIVE_GOAL }).stalled, true);
	assert.equal(turnEnd(state).closeReason, "needs-you");
});

test("terminal_monitor_state and the wake terminal-monitors event are one source; flags merge by id in either order", () => {
	const { state } = started(500, T0);
	const full = [{ id: "m1", startedAtMs: T0 + 5, persistent: true, paused: false }];
	// Real order: the monitor-state event (full flags) first, then the wake event without persistent/paused.
	observeSignal(state, "terminal_monitor_state", { activeCount: 1, monitors: full });
	observeSignal(state, "wake_source_state", { source: "terminal-monitors", activeCount: 1, monitors: [{ id: "m1", description: "watch", startedAtMs: T0 + 5 }] });
	assert.equal(willWake(state, { ...NONE, now: T0 + 10 }).wake, false);
	// One report of 0 through either channel clears the source.
	observeSignal(state, "terminal_monitor_state", { activeCount: 1, monitors: [{ id: "m2", startedAtMs: T0 + 6, persistent: false, paused: false }] });
	assert.deepEqual(willWake(state, { ...NONE, now: T0 + 10 }).reasons, ["terminal-monitors"]);
	observeSignal(state, "wake_source_state", { source: "terminal-monitors", activeCount: 0 });
	assert.equal(willWake(state, { ...NONE, now: T0 + 10 }).wake, false);
	observeSignal(state, "wake_source_state", { source: "terminal-monitors", activeCount: 1, monitors: [{ id: "m3", startedAtMs: T0 + 7 }] });
	observeSignal(state, "terminal_monitor_state", { activeCount: 0, monitors: [] });
	assert.equal(willWake(state, { ...NONE, now: T0 + 10 }).wake, false);
});

test("willWake reasons are deduplicated and in the fixed order", () => {
	const state = createEpisodeState(SID);
	const restoredAt = T0 + 1;
	observeSignal(state, "wake_source_state", { source: "ask-user", activeCount: 1 });
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 1 });
	observeSignal(state, "wake_source_state", { source: "omo-dag", activeCount: 3 });
	observeSignal(state, "wake_source_state", { source: "omo-inbox", activeCount: 4 });
	observeSignal(state, "terminal_monitor_state", { activeCount: 1, monitors: [{ id: "m", startedAtMs: T0 + 1, persistent: false, paused: false }] });
	observeSignal(state, "continuation_hold_state", { source: "senpi-task", active: true });
	observeSignal(state, "continuation_hold_state", { source: "omo-inbox", active: true });
	observeSignal(state, "goal_continuation_timer_state", { armed: true });
	observeSignal(state, "goal_continuation_scheduled", { delayMs: 1000 });
	// A restored episode adds the reload grace; the terminal monitor above started inside it (openedAt = T0 - 5000).
	restore(state, [lineItem()], restoredAt);
	const result = willWake(state, { openQuestions: new Set(["q1", "q2"]), openDialogs: ["d1"], goalActive: true, now: restoredAt + 1 });
	assert.deepEqual(result.reasons, ["ask-user", "dialog", "omo-dag", "senpi-task", "terminal-monitors", "hold:omo-inbox", "hold:senpi-task", "scheduled", "reload-grace"]);
	assert.equal(new Set(result.reasons).size, result.reasons.length);
});

// --- owner marks and episode lifecycle ------------------------------------

test("no mark: a system start opens `e:<sid>:<stamp>` and a mark attributes the next start to the owner once", () => {
	const state = createEpisodeState(SID);
	markOwner(state, "terminal", T0);
	const first = onAgentStart(state, { stamp: 500, now: T0 + 1000 });
	assert.deepEqual(first, { key: `e:${SID}:500`, opened: true, reopened: false, cause: "owner" });
	// One-shot: the next start has no mark.
	const second = onAgentStart(state, { stamp: 600, now: T0 + 2000 });
	assert.equal(second.cause, "system");
	assert.equal(second.opened, false);
	assert.equal(second.key, first.key);
	// A start with no mark at all is system.
	assert.equal(started().result.cause, "system");
});

test("an owner mark expires after 30 minutes; an owner mark set 10 minutes earlier is still consumed once", () => {
	const old = createEpisodeState(SID);
	markOwner(old, "phone", T0);
	assert.equal(onAgentStart(old, { stamp: 500, now: T0 + 30 * MIN + 1 }).cause, "system");

	const state = createEpisodeState(SID);
	markOwner(state, "question-answer", T0);
	assert.equal(onAgentStart(state, { stamp: 500, now: T0 + 10 * MIN }).cause, "owner");
	assert.equal(onAgentStart(state, { stamp: 501, now: T0 + 11 * MIN }).cause, "system");

	// An expired mark is discarded, not kept for a later start.
	const stale = createEpisodeState(SID);
	markOwner(stale, "board-feedback", T0);
	assert.equal(onAgentStart(stale, { stamp: 500, now: T0 + 31 * MIN }).cause, "system");
	assert.equal(onAgentStart(stale, { stamp: 501, now: T0 + 31 * MIN + 1 }).cause, "system");

	// An unknown cause is not a mark.
	const bad = createEpisodeState(SID);
	markOwner(bad, "robot", T0);
	assert.equal(onAgentStart(bad, { stamp: 500, now: T0 + 1 }).cause, "system");
});

test("an owner interjection extends the open episode: same key, interjections 1", () => {
	const { state, result } = started(500, T0);
	markOwner(state, "terminal", T0 + 1000);
	const next = onAgentStart(state, { stamp: 900, now: T0 + 2000 });
	assert.equal(next.key, result.key);
	assert.equal(next.opened, false);
	assert.equal(next.cause, "owner");
	noteLine(state);
	const closed = closeEpisode(state, "needs-you", 950, T0 + 3000);
	assert.equal(closed.meta.interjections, 1);
	assert.equal(closed.meta.turns, 2);
	assert.equal(closed.meta.lines, 1);
	// A system start extends without counting an interjection.
	const again = started();
	onAgentStart(again.state, { stamp: 600, now: T0 + 1 });
	assert.equal(closeEpisode(again.state, "needs-you", 0, T0 + 2).meta.interjections, 0);
});

test("lineKey uses the message stamp, or episode and seq when the stamp is 0 or NaN", () => {
	assert.equal(lineKey(SID, 1234, `e:${SID}:500`, 3), `line:${SID}:m1234`);
	assert.equal(lineKey(SID, 0, `e:${SID}:500`, 3), `line:${SID}:e:${SID}:500:3`);
	assert.equal(lineKey(SID, Number.NaN, `e:${SID}:500`, 4), `line:${SID}:e:${SID}:500:4`);
});

test("noteLine counts sequence numbers and noteQuestion counts questions into the close meta", () => {
	const { state } = started(500, T0);
	assert.equal(noteLine(state), 1);
	assert.equal(noteLine(state), 2);
	noteQuestion(state);
	assert.deepEqual(currentEpisode(state), { key: `e:${SID}:500`, opener: 500, openedAt: T0, seq: 2 });
	const closed = closeEpisode(state, "done", 777, T0 + 5000);
	assert.deepEqual(closed, {
		dedupeKey: `episode:${SID}:500:done:m777`,
		meta: { key: `e:${SID}:500`, opener: 500, openedAt: T0, closedAt: T0 + 5000, closeReason: "done", lines: 2, turns: 1, interjections: 0, questions: 1 },
	});
	assert.equal(state.episode, null);
	assert.equal(closeEpisode(state, "done", 1), null);
});

test("two states fed the same stamps give identical keys and dedupe keys", () => {
	const run = () => {
		const state = createEpisodeState(SID);
		const first = onAgentStart(state, { stamp: 4242, now: T0 });
		noteLine(state);
		const closed = closeEpisode(state, "needs-you", 5000, T0 + 10);
		return { first, closed, line: lineKey(SID, 5000, first.key, 1) };
	};
	assert.deepEqual(run(), run());
});

// --- verdict ---------------------------------------------------------------

test("close table: user abort -> turn/quiet/aborted, even with a source still active", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 1 });
	const result = turnEnd(state, { aborted: true, abortSource: "user", goal: { status: "blocked" } });
	assert.deepEqual([result.action, result.kind, result.policy, result.closeReason, result.stalled], ["close", "turn", "quiet", "aborted", false]);
	// An abort that is not the user's is judged normally.
	const other = turnEnd(state, { aborted: true, abortSource: "system" });
	assert.equal(other.action, "line-only");
});

test("close table: goal blocked in this run -> blocked/needs-you, regardless of wake state", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 1 });
	const result = turnEnd(state, { goal: { status: "blocked" }, goalBlockedInRun: true });
	assert.deepEqual([result.action, result.kind, result.policy, result.closeReason, result.stalled], ["close", "blocked", "needs-you", "blocked", false]);
	// A pending blocked close from update_goal does the same.
	const pending = turnEnd(started().state, { pendingClose: "blocked" });
	assert.equal(pending.kind, "blocked");
});

test("a goal blocked before this run does not close later work: it waits on its sources, then ends as a plain turn", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 1 });
	const waiting = turnEnd(state, { goal: { status: "blocked" }, goalBlockedInRun: false });
	assert.equal(waiting.action, "line-only");
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 0 });
	const done = turnEnd(state, { goal: { status: "blocked" }, goalBlockedInRun: false });
	assert.deepEqual([done.action, done.kind, done.closeReason, done.stalled], ["close", "turn", "needs-you", false]);
});

test("close table: goal complete in this run -> done/needs-you despite a lingering source", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "terminal-background-sessions", activeCount: 1, items: [{ id: "b", startedAtMs: T0 + 1 }] });
	observeSignal(state, "continuation_hold_state", { source: "omo-inbox", active: true });
	assert.equal(willWake(state, { ...NONE, now: T0 + 2 }).wake, true);
	const result = turnEnd(state, { goal: { status: "complete" }, goalCompletedInRun: true });
	assert.deepEqual([result.action, result.kind, result.policy, result.closeReason, result.stalled], ["close", "done", "needs-you", "done", false]);
});

test("close table: goal complete from an earlier run does not close by itself", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 1 });
	assert.equal(turnEnd(state, { goal: { status: "complete" }, goalCompletedInRun: false }).action, "line-only");
});

test("close table: pendingClose done closes as done", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "senpi-task", activeCount: 1 });
	for (const pendingClose of ["done", "complete", { status: "complete" }, { kind: "done" }]) {
		const result = turnEnd(state, { pendingClose });
		assert.deepEqual([result.action, result.kind, result.closeReason], ["close", "done", "done"]);
	}
	assert.equal(turnEnd(state, { pendingClose: { status: "other" } }).action, "line-only");
});

test("close table: willWake -> line-only with the reasons, with or without a goal", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "senpi-codemode", activeCount: 1 });
	for (const goal of [null, ACTIVE_GOAL]) {
		const result = turnEnd(state, { goal });
		assert.deepEqual([result.action, result.kind, result.policy, result.closeReason, result.stalled, result.reasons], ["line-only", "progress", "progress", null, false, ["senpi-codemode"]]);
	}
});

test("close table: goal active and nothing pending -> turn/needs-you/stalled with stalled true", () => {
	const { state } = started();
	const result = turnEnd(state, { goal: ACTIVE_GOAL });
	assert.deepEqual([result.action, result.kind, result.policy, result.closeReason, result.stalled], ["close", "turn", "needs-you", "stalled", true]);
	// A goal whose continuation was stopped is not active.
	assert.equal(turnEnd(state, { goal: { status: "active", continuationStoppedAt: 5 } }).closeReason, "needs-you");
});

test("close table: no goal and nothing pending -> turn/needs-you/needs-you", () => {
	const { state } = started();
	const result = turnEnd(state);
	assert.deepEqual([result.action, result.kind, result.policy, result.closeReason, result.stalled], ["close", "turn", "needs-you", "needs-you", false]);
});

test("a source that reports 0 turns line-only into a close", () => {
	const { state } = started();
	observeSignal(state, "wake_source_state", { source: "omo-desk", activeCount: 1 });
	assert.equal(turnEnd(state, { goal: ACTIVE_GOAL }).action, "line-only");
	observeSignal(state, "wake_source_state", { source: "omo-desk", activeCount: 0 });
	assert.equal(willWake(state, { ...NONE, now: T0 + 1 }).wake, false);
	assert.equal(turnEnd(state, { goal: ACTIVE_GOAL }).closeReason, "stalled");
});

test("an open question or dialog -> line-only", () => {
	const { state } = started();
	const question = turnEnd(state, { openQuestions: new Set(["q1"]) });
	assert.deepEqual([question.action, question.reasons], ["line-only", ["ask-user"]]);
	const dialog = turnEnd(state, { openDialogs: new Set(["d1"]) });
	assert.deepEqual([dialog.action, dialog.reasons], ["line-only", ["dialog"]]);
	// The wake source `ask-user` is the same reason, listed once.
	observeSignal(state, "wake_source_state", { source: "ask-user", activeCount: 1 });
	assert.deepEqual(turnEnd(state, { openQuestions: 1 }).reasons, ["ask-user"]);
});

// --- reload restore --------------------------------------------------------

function lineItem(over = {}) {
	return {
		itemId: "i-1",
		kind: "progress",
		status: "open",
		closedReason: null,
		createdAt: new Date(T0 + 1000).toISOString(),
		meta: { episode: { key: `e:${SID}:500`, opener: 500, openedAt: T0 - 5000, seq: 3 } },
		...over,
	};
}

function finalItem(closeReason, over = {}) {
	return {
		itemId: "i-2",
		kind: "turn",
		status: "closed",
		closedReason: null,
		createdAt: new Date(T0 + 2000).toISOString(),
		meta: { episode: { key: `e:${SID}:500`, opener: 500, openedAt: T0 - 5000, closedAt: T0 + 2000, closeReason, lines: 3, turns: 2, interjections: 0, questions: 0 } },
		...over,
	};
}

test("restore: a line with no final after it reopens the same key, seq, opener and openedAt with a 60 s grace", () => {
	const state = createEpisodeState(SID);
	const now = T0 + 5000;
	const result = restore(state, [lineItem()], now);
	assert.deepEqual(result, { restored: true, key: `e:${SID}:500` });
	assert.deepEqual(currentEpisode(state), { key: `e:${SID}:500`, opener: 500, openedAt: T0 - 5000, seq: 3 });
	// Grace holds the episode open with or without a goal, then lapses at 60 s.
	for (const goal of [null, ACTIVE_GOAL]) {
		const held = turnEnd(state, { goal, now: now + 59_999 });
		assert.deepEqual([held.action, held.reasons], ["line-only", ["reload-grace"]]);
	}
	assert.equal(turnEnd(state, { now: now + 60_000 }).action, "close");
	// The next line continues the sequence.
	assert.equal(noteLine(state), 4);
});

test("restore: a session-closed line ends the span; a superseded line (normal agent start) does not", () => {
	const gone = createEpisodeState(SID);
	assert.equal(restore(gone, [lineItem({ status: "closed", closedReason: "session-closed" })], T0).restored, false);
	assert.equal(gone.episode, null);
	const superseded = createEpisodeState(SID);
	assert.equal(restore(superseded, [lineItem({ status: "closed", closedReason: "superseded" })], T0).restored, true);
});

test("restore: any other final -> idle; no episode items -> idle", () => {
	for (const closeReason of ["needs-you", "done", "blocked", "aborted"]) {
		const state = createEpisodeState(SID);
		assert.equal(restore(state, [lineItem(), finalItem(closeReason)], T0 + 9000).restored, false);
		assert.equal(state.episode, null);
		assert.equal(willWake(state, { ...NONE, now: T0 + 9000 }).wake, false);
	}
	// A stalled final that nothing superseded is a plain final.
	const stalled = createEpisodeState(SID);
	assert.equal(restore(stalled, [lineItem(), finalItem("stalled", { status: "open" })], T0 + 9000).restored, false);
	const none = createEpisodeState(SID);
	assert.equal(restore(none, [{ kind: "question", createdAt: new Date(T0).toISOString(), meta: null }], T0).restored, false);
	assert.equal(restore(none, null, T0).restored, false);
});

test("restore: a stalled final closed superseded reopens the same key (reopen after stalled)", () => {
	const state = createEpisodeState(SID);
	const items = [lineItem(), finalItem("stalled", { closedReason: "superseded" })];
	const result = restore(state, items, T0 + 9000);
	assert.deepEqual(result, { restored: true, key: `e:${SID}:500` });
	assert.deepEqual(currentEpisode(state), { key: `e:${SID}:500`, opener: 500, openedAt: T0 - 5000, seq: 3 });
	// Item order does not matter; the newest item with meta.episode decides.
	const reversed = createEpisodeState(SID);
	assert.equal(restore(reversed, [...items].reverse(), T0 + 9000).restored, true);
});

test("restore: the newest episode item wins over an older episode's final", () => {
	const state = createEpisodeState(SID);
	const olderFinal = finalItem("done", {
		createdAt: new Date(T0 - 100_000).toISOString(),
		meta: { episode: { key: `e:${SID}:100`, opener: 100, openedAt: T0 - 200_000, closeReason: "done", lines: 1 } },
	});
	assert.equal(restore(state, [olderFinal, lineItem()], T0 + 9000).restored, true);
	assert.equal(currentEpisode(state).key, `e:${SID}:500`);
});

// --- reopen and server state ----------------------------------------------

test("adoptReopen continues the old key and seq when a system start opened a provisional episode with no line", () => {
	const { state, result } = started(900, T0);
	assert.equal(result.opened, true);
	const adopted = adoptReopen(state, { key: `e:${SID}:500`, opener: 500, openedAt: T0 - 90_000, seq: 4 });
	assert.deepEqual(adopted, { adopted: true, key: `e:${SID}:500`, reopened: true });
	assert.deepEqual(currentEpisode(state), { key: `e:${SID}:500`, opener: 500, openedAt: T0 - 90_000, seq: 4 });
	assert.equal(noteLine(state), 5);
	const closed = closeEpisode(state, "needs-you", 1000, T0 + 1);
	assert.equal(closed.dedupeKey, `episode:${SID}:500:needs-you:m1000`);
	assert.equal(closed.meta.lines, 5);
});

test("adoptReopen is ignored when the episode was already open or already has a line", () => {
	const reopen = { key: `e:${SID}:500`, opener: 500, openedAt: T0 - 90_000, seq: 4 };

	// The episode was already open: this start extended it, so a reopen answer is ignored.
	const open = createEpisodeState(SID);
	onAgentStart(open, { stamp: 800, now: T0 });
	onAgentStart(open, { stamp: 850, now: T0 + 1000 });
	assert.equal(adoptReopen(open, reopen).adopted, false);
	assert.equal(currentEpisode(open).key, `e:${SID}:800`);

	// The provisional episode already has a line.
	const withLine = createEpisodeState(SID);
	onAgentStart(withLine, { stamp: 800, now: T0 });
	noteLine(withLine);
	assert.equal(adoptReopen(withLine, reopen).adopted, false);
	assert.equal(currentEpisode(withLine).key, `e:${SID}:800`);

	// No episode at all.
	assert.equal(adoptReopen(createEpisodeState(SID), reopen).adopted, false);

	// Adopting twice: the second answer finds a non-provisional episode.
	const once = createEpisodeState(SID);
	onAgentStart(once, { stamp: 800, now: T0 });
	assert.equal(adoptReopen(once, reopen).adopted, true);
	assert.equal(adoptReopen(once, { ...reopen, key: `e:${SID}:300` }).adopted, false);
	assert.equal(currentEpisode(once).key, `e:${SID}:500`);
});

test("applyServerState: an owner-caused start after a server-closed episode switches to a new key", () => {
	const { state } = started(500, T0);
	noteLine(state);
	markOwner(state, "phone", T0 + MIN);
	const next = onAgentStart(state, { stamp: 900, now: T0 + 2 * MIN });
	assert.equal(next.key, `e:${SID}:500`);
	assert.equal(next.cause, "owner");
	const applied = applyServerState(state, { episodeClosed: true, closeReason: "stalled" });
	assert.deepEqual(applied, { switched: true, key: `e:${SID}:900` });
	assert.deepEqual(currentEpisode(state), { key: `e:${SID}:900`, opener: 900, openedAt: T0 + 2 * MIN, seq: 0 });
	// Request B never inherits A's counters.
	const closed = closeEpisode(state, "needs-you", 950, T0 + 3 * MIN);
	assert.deepEqual([closed.meta.lines, closed.meta.turns, closed.meta.interjections], [0, 1, 0]);
});

test("applyServerState: a system-caused start keeps the key when the server closed it `stalled` (resumed A)", () => {
	const { state } = started(500, T0);
	noteLine(state);
	onAgentStart(state, { stamp: 900, now: T0 + 2 * MIN });
	const applied = applyServerState(state, { episodeClosed: true, closeReason: "stalled" });
	assert.deepEqual(applied, { switched: false, key: `e:${SID}:500` });
	assert.equal(currentEpisode(state).key, `e:${SID}:500`);
	assert.equal(noteLine(state), 2);
});

test("applyServerState: a system start after any other server close is new work with a new key", () => {
	const { state } = started(500, T0);
	noteLine(state);
	onAgentStart(state, { stamp: 900, now: T0 + 2 * MIN });
	assert.deepEqual(applyServerState(state, { episodeClosed: true, closeReason: "needs-you" }), { switched: true, key: `e:${SID}:900` });
});

test("applyServerState does nothing when the server did not close it, or the start opened the episode", () => {
	const { state } = started(500, T0);
	onAgentStart(state, { stamp: 900, now: T0 + 1 });
	assert.equal(applyServerState(state, { episodeClosed: false }).switched, false);
	assert.equal(applyServerState(state, {}).switched, false);
	const opened = started(500, T0).state;
	assert.equal(applyServerState(opened, { episodeClosed: true, closeReason: "stalled" }).switched, false);
	assert.equal(applyServerState(createEpisodeState(SID), { episodeClosed: true }).switched, false);
});

test("a stamp of 0 (empty branch) still gives distinct, deterministic keys", () => {
	const a = createEpisodeState(SID);
	const b = createEpisodeState(SID);
	assert.equal(onAgentStart(a, { stamp: 0, now: T0 }).key, onAgentStart(b, { stamp: 0, now: T0 }).key);
	const c = createEpisodeState(SID);
	assert.notEqual(onAgentStart(c, { stamp: 0, now: T0 + 5000 }).key, a.episode.key);
});
