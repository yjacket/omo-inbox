import test from "node:test";
import assert from "node:assert/strict";
import { createStallWatch, stallMsFrom } from "../src/stall.mjs";

const SID = "01a14658-5241-79c1-a5c6-fc15b8380a83";
const MINUTE = 60_000;

/** A fake clock plus fake timers: nothing here ever waits on real time. */
function fakeTimers(start = 0) {
	let nowMs = start;
	let nextId = 0;
	const timers = new Map();
	return {
		now: () => nowMs,
		setTimer(fn, delay) {
			const handle = ++nextId;
			timers.set(handle, { fn, at: nowMs + delay });
			return handle;
		},
		clearTimer(handle) {
			timers.delete(handle);
		},
		armed() {
			return [...timers.values()].map((timer) => timer.at).sort((a, b) => a - b);
		},
		advance(ms) {
			const target = nowMs + ms;
			for (;;) {
				let next = null;
				for (const [handle, timer] of timers) {
					if (timer.at > target) continue;
					if (!next || timer.at < next.timer.at || (timer.at === next.timer.at && handle < next.handle)) next = { handle, timer };
				}
				if (!next) break;
				timers.delete(next.handle);
				nowMs = next.timer.at;
				next.timer.fn();
			}
			nowMs = target;
		},
	};
}

function watch(stallMs = 100) {
	const clock = fakeTimers();
	const fired = [];
	const stall = createStallWatch({ ...clock, stallMs, onFire: (sid, key) => fired.push([sid, key]) });
	return { clock, fired, ...stall };
}

test("fires onFire exactly once at lastLineAt + stallMs and then forgets the entry", () => {
	const { clock, fired, arm, idle, pending } = watch(100);
	arm(SID, "ep-1", 0);
	idle(SID, true);
	assert.deepEqual(pending(), [{ sid: SID, key: "ep-1", atMs: 100 }]);
	clock.advance(99);
	assert.deepEqual(fired, []);
	clock.advance(1);
	assert.deepEqual(fired, [[SID, "ep-1"]]);
	clock.advance(10_000);
	assert.deepEqual(fired, [[SID, "ep-1"]]);
	assert.deepEqual(pending(), []);
});

test("no fire while busy; the next idle report re-arms from that idle time", () => {
	const { clock, fired, arm, idle, pending } = watch(100);
	idle(SID, true);
	arm(SID, "ep-1", 0);
	clock.advance(50);
	idle(SID, false);
	assert.deepEqual(pending(), []);
	clock.advance(10_000);
	assert.deepEqual(fired, []);
	idle(SID, true);
	assert.deepEqual(pending(), [{ sid: SID, key: "ep-1", atMs: 10_150 }]);
	clock.advance(99);
	assert.deepEqual(fired, []);
	clock.advance(1);
	assert.deepEqual(fired, [[SID, "ep-1"]]);
});

test("a busy report keeps a later line from firing until idle returns", () => {
	const { clock, fired, arm, idle } = watch(100);
	idle(SID, false);
	arm(SID, "ep-1", 0);
	clock.advance(5_000);
	arm(SID, "ep-1", 5_000);
	clock.advance(10_000);
	assert.deepEqual(fired, []);
	idle(SID, true);
	clock.advance(99);
	assert.deepEqual(fired, []);
	clock.advance(1);
	assert.deepEqual(fired, [[SID, "ep-1"]]);
});

test("cancel removes the timer for one key and leaves the others", () => {
	const { clock, fired, arm, idle, cancel, pending } = watch(100);
	arm(SID, "ep-1", 0);
	arm(SID, "ep-2", 20);
	idle(SID, true);
	assert.equal(cancel(SID, "ep-1"), true);
	assert.equal(cancel(SID, "ep-1"), false);
	assert.deepEqual(pending(), [{ sid: SID, key: "ep-2", atMs: 120 }]);
	clock.advance(100);
	assert.deepEqual(fired, []);
	clock.advance(20);
	assert.deepEqual(fired, [[SID, "ep-2"]]);
});

test("re-arming moves the deadline and parses ISO line times", () => {
	const { clock, fired, arm, idle, pending } = watch(100);
	const base = Date.parse("2026-01-01T00:00:00Z");
	clock.advance(base);
	idle(SID, true);
	arm(SID, "ep-1", new Date(base).toISOString());
	clock.advance(50);
	arm(SID, "ep-1", new Date(base + 50).toISOString());
	assert.deepEqual(pending(), [{ sid: SID, key: "ep-1", atMs: base + 150 }]);
	clock.advance(50);
	assert.deepEqual(fired, []);
	clock.advance(50);
	assert.deepEqual(fired, [[SID, "ep-1"]]);
});

test("rebuild fires overdue entries under an hour and drops older ones", () => {
	const now = 10_000_000;
	const stall = 60_000;
	const status = fakeTimers(now);
	const fired = [];
	const { rebuild, pending } = createStallWatch({ ...status, stallMs: stall, onFire: (sid, key) => fired.push([sid, key]) });
	rebuild([
		{ sid: "s1", key: "oldish", lastLineAt: now - stall - 1_000 },
		{ sid: "s1", key: "too-old", lastLineAt: now - stall - 60 * MINUTE },
		{ sid: "s1", key: "future", lastLineAt: now - 30_000 },
	]);
	assert.deepEqual(fired, [["s1", "oldish"]]);
	assert.deepEqual(pending(), [{ sid: "s1", key: "future", atMs: now + 30_000 }]);
	status.advance(30_000);
	assert.deepEqual(fired, [["s1", "oldish"], ["s1", "future"]]);
});

test("stallMsFrom clamps minutes and lets the env override win unclamped", () => {
	assert.equal(stallMsFrom({}, {}), 60 * MINUTE);
	assert.equal(stallMsFrom({ episode: { stallMinutes: 1 } }, {}), 5 * MINUTE);
	assert.equal(stallMsFrom({ episode: { stallMinutes: 999 } }, {}), 240 * MINUTE);
	assert.equal(stallMsFrom({ episode: { stallMinutes: 10 } }, {}), 10 * MINUTE);
	assert.equal(stallMsFrom({ episode: { stallMinutes: 10 } }, { INBOX_EPISODE_STALL_MS: "1234" }), 1234);
	assert.equal(stallMsFrom({ episode: { stallMinutes: 10 } }, { INBOX_EPISODE_STALL_MS: "abc" }), 10 * MINUTE);
	assert.equal(stallMsFrom({ episode: { stallMinutes: "not-a-number" } }, { INBOX_EPISODE_STALL_MS: "" }), 60 * MINUTE);
});
