import test from "node:test";
import assert from "node:assert/strict";
import {
	CACHE_LEAD_MINUTES,
	HOLD_QUESTION_MS,
	HOLD_TURN_MS,
	MAX_PAYLOAD_BYTES,
	buildPushPayload,
	cacheReminderAt,
	createScheduler,
	SUMMARY_WAIT_MS,
	summaryWaitDeadline,
	pushPlan,
	topicFor,
} from "../src/policy.mjs";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const SID = "01a14658-5241-79c1-a5c6-fc15b8380a83";
const ITEM_ID = "i-260101-abc123";
const OPEN = { action: "open", title: "열기" };

function threadThread(extra = {}) {
	return { session: SID, title: "파일 정리", product: "omo-inbox", branch: "main", ...extra };
}

function makeItem(kind, extra = {}) {
	return {
		itemId: ITEM_ID,
		session: SID,
		kind,
		policy: "needs-you",
		createdAt: new Date(NOW).toISOString(),
		status: "open",
		raw: {},
		meta: null,
		...extra,
	};
}

function questionRequest({ required = false, rec = "권장: 위험 없음" } = {}) {
	const options = [{ label: "그대로 둔다", description: rec }, { label: "지운다", description: "" }];
	return {
		requestId: "q1",
		questions: [{ id: "q1", header: "정리", question: "어떻게 할까요?", options, multiSelect: false }],
		waitForAnswer: true,
		required,
		timeoutMs: 300_000,
		askedAt: new Date(NOW).toISOString(),
	};
}

function questionItem({ required = false, rec } = {}) {
	return makeItem("question", { raw: { request: questionRequest({ required, rec }) } });
}

/** A fake clock plus fake timers: nothing here ever waits on real time. */
function fakeTimers(start = NOW) {
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
			return [...timers.entries()].map(([handle, timer]) => ({ handle, at: timer.at }));
		},
		fire(handle) {
			const timer = timers.get(handle);
			assert.ok(timer, `timer ${handle} is armed`);
			timers.delete(handle);
			nowMs = Math.max(nowMs, timer.at);
			timer.fn();
		},
	};
}

test("C9 table: push, hold and actions for every item row", () => {
	const thread = threadThread();
	const rows = [
		{
			name: "question, required false, with a recommended option",
			item: questionItem(),
			mode: "primary",
			want: { push: true, holdMs: HOLD_QUESTION_MS, actions: [{ action: "rec", title: "권장: 그대로 둔다" }, OPEN] },
		},
		{
			name: "question, required false, without any recommendation marker",
			item: questionItem({ rec: "" }),
			mode: "primary",
			want: { push: true, holdMs: HOLD_QUESTION_MS, actions: [OPEN] },
		},
		{
			name: "question, required true, never gets a rec action",
			item: questionItem({ required: true }),
			mode: "primary",
			want: { push: true, holdMs: HOLD_QUESTION_MS, actions: [OPEN] },
		},
		{
			name: "question, required true at the raw level, never gets a rec action",
			item: makeItem("question", { raw: { required: true, request: questionRequest({ required: false }) } }),
			mode: "primary",
			want: { push: true, holdMs: HOLD_QUESTION_MS, actions: [OPEN] },
		},
		{ name: "permission", item: makeItem("permission", { raw: { dialog: { id: "d1" } } }), mode: "primary", want: { push: true, holdMs: HOLD_QUESTION_MS, actions: [OPEN] } },
		{ name: "turn", item: makeItem("turn"), mode: "primary", want: { push: true, holdMs: HOLD_TURN_MS, actions: [OPEN] } },
		{ name: "blocked", item: makeItem("blocked"), mode: "primary", want: { push: true, holdMs: HOLD_TURN_MS, actions: [OPEN] } },
		{ name: "done", item: makeItem("done"), mode: "primary", want: { push: true, holdMs: HOLD_TURN_MS, actions: [OPEN] } },
		{ name: "progress", item: makeItem("progress", { policy: "progress" }), mode: "primary", want: { push: false, holdMs: null, actions: [] } },
		{ name: "board in primary mode", item: makeItem("board"), mode: "primary", want: { push: true, holdMs: 0, actions: [OPEN] } },
		{ name: "board in trial mode", item: makeItem("board", { policy: "quiet" }), mode: "trial", want: { push: false, holdMs: null, actions: [] } },
		{ name: "board in trial mode keeps quiet even without the quiet policy", item: makeItem("board"), mode: "trial", want: { push: false, holdMs: null, actions: [] } },
		{ name: "notice, urgency now", item: makeItem("notice"), mode: "primary", want: { push: true, holdMs: 0, actions: [OPEN] } },
		{ name: "notice, urgency soon", item: makeItem("notice"), mode: "primary", want: { push: true, holdMs: 0, actions: [OPEN] } },
		{ name: "notice, urgency fyi", item: makeItem("notice", { policy: "fyi" }), mode: "primary", want: { push: false, holdMs: null, actions: [] } },
	];
	for (const row of rows) {
		assert.deepEqual(pushPlan(row.item, thread, row.mode, { now: NOW }), row.want, row.name);
	}
	assert.deepEqual(pushPlan(null, thread), { push: false, holdMs: null, actions: [] });
});

test("pushPlan cancels closed, answered and superseded items", () => {
	const thread = threadThread();
	const turn = makeItem("turn");
	assert.equal(pushPlan(turn, thread, "primary", { now: NOW }).push, true);

	for (const status of ["closed", "answered", "delivered"]) {
		assert.equal(pushPlan({ ...turn, status }, thread, "primary", { now: NOW }).push, false, status);
	}
	assert.equal(pushPlan(turn, thread, "primary", { now: NOW, activityAt: NOW - 1_000 }).push, true);
	assert.equal(pushPlan(turn, thread, "primary", { now: NOW, activityAt: NOW + 1_000 }).push, false);
	assert.equal(pushPlan({ ...turn, lastActivityAt: new Date(NOW + 1_000).toISOString() }, thread, "primary", { now: NOW }).push, false);
});

test("a question payload carries the rec action and the rec field, a required one does not", () => {
	const thread = threadThread();
	const payload = buildPushPayload(questionItem(), thread, { headline: "정리 방식을 골라 주세요", ask: "지울까요?" });
	assert.equal(payload.title, "🙋 파일 정리");
	assert.equal(payload.body, "정리 방식을 골라 주세요 — 지울까요?");
	assert.equal(payload.url, `/s/${SID}#${ITEM_ID}`);
	assert.equal(payload.tag, `s-${SID}`);
	assert.equal(payload.renotify, true);
	assert.equal(payload.itemId, ITEM_ID);
	assert.deepEqual(payload.actions, [{ action: "rec", title: "권장: 그대로 둔다" }, OPEN]);
	assert.deepEqual(payload.rec, { questionId: "q1", label: "그대로 둔다" });

	const required = buildPushPayload(questionItem({ required: true }), thread, { headline: "정리 방식을 골라 주세요" });
	assert.deepEqual(required.actions, [OPEN]);
	assert.equal("rec" in required, false);
});

test("a 10 KB headline still fits a payload under 3000 bytes, redacted and clipped", () => {
	const headline = `토큰 sk-abcdefghijklmnop1234567890 노출 ${"가".repeat(10_000)}`;
	const payload = buildPushPayload(makeItem("turn"), threadThread(), { headline, ask: "계속할까요?" });
	assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_PAYLOAD_BYTES);
	assert.ok(payload.body.length <= 120, String(payload.body.length));
	assert.ok(!payload.body.includes("sk-abcdefghijklmnop"));
	assert.ok(payload.body.includes("…"));
	assert.deepEqual(payload.actions, [OPEN]);

	const longTitle = buildPushPayload(makeItem("turn"), threadThread({ title: "제".repeat(500) }), { headline: "보고" });
	assert.ok(longTitle.title.length <= 40);
	assert.ok(Buffer.byteLength(JSON.stringify(longTitle), "utf8") <= MAX_PAYLOAD_BYTES);
});

test("a cache reminder names the remaining minutes and keeps the thread title in the body", () => {
	const payload = buildPushPayload(makeItem("turn"), threadThread(), { headline: "정리 도중" }, { kind: "cache", minutesLeft: 3 });
	assert.equal(payload.title, "🔥 캐시가 3분 뒤 식습니다");
	assert.equal(payload.body, "파일 정리 — 정리 도중");
	assert.equal(payload.body.includes("파일 정리"), true);
	assert.deepEqual(payload.actions, [OPEN]);
	assert.equal(payload.url, `/s/${SID}#${ITEM_ID}`);
});

test("cacheReminderAt fires lead minutes before the cache goes cold, and never while a goal is active", () => {
	const warmUntil = NOW + 10 * 60_000;
	const openTurn = makeItem("turn");
	const withCache = threadThread({ cacheUntil: warmUntil });
	assert.equal(cacheReminderAt(openTurn, withCache, CACHE_LEAD_MINUTES, { now: NOW }), warmUntil - CACHE_LEAD_MINUTES * 60_000);
	assert.equal(cacheReminderAt(openTurn, withCache, 1, { now: NOW }), warmUntil - 60_000);
	assert.equal(cacheReminderAt({ ...openTurn, raw: { warmUntil } }, threadThread(), CACHE_LEAD_MINUTES, { now: NOW }), warmUntil - CACHE_LEAD_MINUTES * 60_000);

	assert.equal(cacheReminderAt(openTurn, threadThread({ cacheUntil: warmUntil, goal: { status: "active" } }), CACHE_LEAD_MINUTES, { now: NOW }), null);
	assert.equal(cacheReminderAt(openTurn, threadThread({ cacheUntil: warmUntil, goal: { status: "active", continuationStoppedAt: new Date(NOW).toISOString() } }), CACHE_LEAD_MINUTES, { now: NOW }), warmUntil - CACHE_LEAD_MINUTES * 60_000);
	assert.equal(cacheReminderAt(openTurn, threadThread({ cacheUntil: warmUntil, goalStatus: "active" }), CACHE_LEAD_MINUTES, { now: NOW }), null);
	assert.equal(cacheReminderAt(openTurn, threadThread({ cacheUntil: warmUntil, goal: { status: "complete" } }), CACHE_LEAD_MINUTES, { now: NOW }), warmUntil - CACHE_LEAD_MINUTES * 60_000);

	assert.equal(cacheReminderAt({ ...openTurn, status: "closed" }, withCache, CACHE_LEAD_MINUTES, { now: NOW }), null);
	assert.equal(cacheReminderAt({ ...openTurn, status: "answered" }, withCache, CACHE_LEAD_MINUTES, { now: NOW }), null);
	assert.equal(cacheReminderAt({ ...openTurn, policy: "progress" }, withCache, CACHE_LEAD_MINUTES, { now: NOW }), null);
	assert.equal(cacheReminderAt(openTurn, threadThread(), CACHE_LEAD_MINUTES, { now: NOW }), null);
	assert.equal(cacheReminderAt(openTurn, withCache, CACHE_LEAD_MINUTES, { now: warmUntil - 60_000 }), null);
});

test("cache reminders take the table's cache row and cancel with the item", () => {
	const warmUntil = NOW + 10 * 60_000;
	const item = makeItem("turn");
	const thread = threadThread({ cacheUntil: warmUntil });
	const plan = pushPlan(item, thread, "primary", { kind: "cache", minutesLeft: 10, now: NOW });
	assert.deepEqual(plan, { push: true, holdMs: 5 * 60_000, actions: [OPEN] });
	assert.deepEqual(pushPlan({ ...item, status: "answered" }, thread, "primary", { kind: "cache", minutesLeft: 10, now: NOW }), { push: false, holdMs: null, actions: [] });
	assert.deepEqual(pushPlan(item, threadThread({ cacheUntil: warmUntil, goal: { status: "active" } }), "primary", { kind: "cache", minutesLeft: 10, now: NOW }), { push: false, holdMs: null, actions: [] });
});

test("topicFor is 32 url-safe characters, stable and per session", () => {
	const topic = topicFor(SID);
	assert.equal(topic.length, 32);
	assert.match(topic, /^[A-Za-z0-9_-]{32}$/);
	assert.equal(topicFor(SID), topic);
	assert.notEqual(topicFor("01a14658-5241-79c1-a5c6-fc15b8380a84"), topic);
});

test("the scheduler arms one timer per key on the injected clock", () => {
	const clock = fakeTimers();
	const scheduler = createScheduler(clock);
	const fired = [];
	scheduler.schedule("turn:a", NOW + 30_000, () => fired.push("a"));
	scheduler.schedule("cache:a:1", NOW + 300_000, () => fired.push("cache"));

	assert.deepEqual(scheduler.pending(), [
		{ key: "turn:a", atMs: NOW + 30_000 },
		{ key: "cache:a:1", atMs: NOW + 300_000 },
	]);
	assert.equal(clock.armed().length, 2);
	assert.deepEqual(clock.armed().map((timer) => timer.at), [NOW + 30_000, NOW + 300_000]);

	const [turnTimer] = clock.armed();
	clock.fire(turnTimer.handle);
	assert.deepEqual(fired, ["a"]);
	assert.deepEqual(scheduler.pending(), [{ key: "cache:a:1", atMs: NOW + 300_000 }]);
});

test("the scheduler cancels one key, a prefix, and replaces a key that is scheduled again", () => {
	const clock = fakeTimers();
	const scheduler = createScheduler(clock);
	const fired = [];
	scheduler.schedule("cache:a:1", NOW + 1_000, () => fired.push("one"));
	scheduler.schedule("cache:a:2", NOW + 2_000, () => fired.push("two"));
	scheduler.schedule("turn:b", NOW + 3_000, () => fired.push("turn"));

	assert.equal(scheduler.cancel("cache:a:1"), true);
	assert.equal(scheduler.cancel("cache:a:1"), false);
	assert.equal(clock.armed().length, 2);

	scheduler.schedule("turn:b", NOW + 4_000, () => fired.push("turn-again"));
	assert.equal(scheduler.pending().filter((entry) => entry.key === "turn:b").length, 1);
	assert.deepEqual(scheduler.pending().find((entry) => entry.key === "turn:b"), { key: "turn:b", atMs: NOW + 4_000 });

	assert.equal(scheduler.cancelPrefix("cache:"), 1);
	assert.deepEqual(scheduler.pending().map((entry) => entry.key), ["turn:b"]);

	const [turnTimer] = clock.armed();
	clock.fire(turnTimer.handle);
	assert.deepEqual(fired, ["turn-again"]);
	assert.deepEqual(scheduler.pending(), []);
	assert.throws(() => scheduler.schedule("", NOW, () => {}), /key is required/);
	assert.throws(() => scheduler.schedule("k", NOW, null), /fn is required/);
});

test("a rescheduled key drops the replaced timer and may reschedule itself from inside its callback", () => {
	const clock = fakeTimers();
	const scheduler = createScheduler(clock);
	const fired = [];
	scheduler.schedule("turn:c", NOW + 1_000, () => fired.push("old"));
	const replaced = clock.armed()[0].handle;
	scheduler.schedule("turn:c", NOW + 2_000, () => fired.push("new"));
	assert.equal(clock.armed().length, 1);
	assert.notEqual(clock.armed()[0].handle, replaced);
	assert.throws(() => clock.fire(replaced), /is armed/);

	const [timer] = clock.armed();
	clock.fire(timer.handle);
	assert.deepEqual(fired, ["new"]);
	assert.deepEqual(scheduler.pending(), []);
	assert.equal(scheduler.cancel("turn:c"), false);

	const ticks = [];
	const tick = (n) => {
		scheduler.schedule("cache:x", NOW + n * 1_000, () => {
			ticks.push(n);
			if (n < 2) tick(n + 1);
		});
	};
	tick(1);
	clock.fire(clock.armed()[0].handle);
	assert.deepEqual(ticks, [1]);
	assert.deepEqual(scheduler.pending().map((entry) => entry.key), ["cache:x"]);
	clock.fire(clock.armed()[0].handle);
	assert.deepEqual(ticks, [1, 2]);
	assert.deepEqual(scheduler.pending(), []);
});

test("pushPlan works on the wire shapes the server gets from the store", () => {
	const stored = {
		itemId: ITEM_ID,
		session: SID,
		kind: "turn",
		policy: "needs-you",
		createdAt: new Date(NOW).toISOString(),
		raw: { text: "보고" },
		meta: { stalled: true },
		status: "open",
	};
	assert.deepEqual(pushPlan(stored, threadThread(), "primary"), { push: true, holdMs: HOLD_TURN_MS, actions: [OPEN] });
});

test("summaryWaitDeadline parks a push only while a model summary is pending behind a heuristic one", () => {
	const heuristic = { summary: { source: "heuristic" } };
	const model = { summary: { source: "model" } };
	assert.equal(SUMMARY_WAIT_MS, 30_000);
	assert.equal(summaryWaitDeadline(heuristic, 1000, 31_000, 30_000), 61_000);
	assert.equal(summaryWaitDeadline(heuristic, null, 31_000, 30_000), null, "no model summary was asked for");
	assert.equal(summaryWaitDeadline(model, 1000, 31_000, 30_000), null, "the model summary is already there");
	assert.equal(summaryWaitDeadline(heuristic, 1000, 100_000, 30_000), null, "asked long ago");
	assert.equal(summaryWaitDeadline(heuristic, 1000, 1000, 0), null, "a zero-hold item (notice, board) never waits");
});
