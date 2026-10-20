// Capture and turn-classifier tests (plan todo 14, contracts C3 and C4).
// Run: node --test test/capture.test.mjs
// Fake clock, fake timers, fake post: nothing here waits on wall-clock time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapture } from "../extension/inbox/capture.ts";

const SESSION = "s-1";
const START_AT = 1_000_000;
const USER_TEXT = "결제 화면을 만들어줘";
const ASSISTANT_TEXT = "결제 화면 골격을 만들었습니다. 승인할까요?";

function fakeCtx(over = {}) {
	const branch = over.branch ?? [
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: USER_TEXT }] },
		},
	];
	return {
		mode: "tui",
		cwd: "C:/work/proj",
		model: { provider: "anthropic", id: "claude-haiku-4-5" },
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => SESSION,
			getSessionFile: () => "C:/sessions/s-1.jsonl",
			getSessionName: () => "결제 화면",
			getBranch: () => branch,
		},
		...over.ctx,
	};
}

function assistantMessage(text = ASSISTANT_TEXT) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function makeCapture(options = {}) {
	const state = { t: START_AT, goal: options.goal ?? null, fail: false };
	const timers = new Set();
	const posts = [];
	const logs = [];
	const summaries = [];
	const post = options.post ?? (async (path, body) => {
		if (state.fail) throw new Error("server down");
		posts.push({ path, body });
		if (path.endsWith("/items")) {
			return { item: { id: `i-${posts.length}` }, created: true, summaryRequest: options.summaryRequest ?? null };
		}
		return { ok: true };
	});
	const capture = createCapture({
		mode: options.mode ?? "trial",
		env: options.env ?? {},
		now: () => state.t,
		setTimer: (fn, ms) => {
			const handle = { fn, due: state.t + ms, ms, cleared: false };
			timers.add(handle);
			return handle;
		},
		clearTimer: (handle) => {
			handle.cleared = true;
			timers.delete(handle);
		},
		readGoal: async () => state.goal,
		log: (line) => logs.push(line),
		onSummaryRequest: (item, request) => summaries.push({ item, request }),
		...(options.cacheTracker ? { cacheTracker: options.cacheTracker } : {}),
		...(options.bridgeState ? { bridgeState: options.bridgeState } : {}),
		...(options.deskBoards ? { deskBoards: options.deskBoards } : {}),
		...(options.settleDelayMs ? { settleDelayMs: options.settleDelayMs } : {}),
		post,
	});

	const only = (suffix) => posts.filter((entry) => entry.path.endsWith(suffix));
	const items = () => only("/items").map((entry) => entry.body);
	const activities = () => only("/activity").map((entry) => entry.body);

	async function flush() {
		for (let index = 0; index < 12; index += 1) {
			await capture.flush();
			await Promise.resolve();
		}
	}

	async function advance(ms) {
		state.t += ms;
		for (const handle of [...timers]) {
			if (handle.due > state.t) continue;
			timers.delete(handle);
			handle.fn();
		}
		await flush();
	}

	return { capture, state, posts, logs, summaries, timers, only, items, activities, flush, advance };
}

function runTurnAt(harness, ctx, { messages = [assistantMessage()], aborted = false, abortSource } = {}) {
	harness.capture.onAgentStart(ctx);
	harness.capture.onAgentEnd({ messages, aborted, abortSource }, ctx);
	harness.capture.onAgentSettled(ctx);
	return ctx;
}

function stamped(text, timestamp) {
	return { ...assistantMessage(text), timestamp };
}

/** One run with one stamped assistant message: start, message_end (a line), end, settled. */
function runLineTurn(harness, ctx, { text = ASSISTANT_TEXT, stamp = 5000, ...rest } = {}) {
	const message = stamped(text, stamp);
	harness.capture.onAgentStart(ctx);
	harness.capture.onMessageEnd({ message }, ctx);
	harness.capture.onAgentEnd({ messages: [message], ...rest }, ctx);
	harness.capture.onAgentSettled(ctx);
}

const kinds = (harness) => harness.items().map((item) => item.kind);
const stateBodies = (harness) => harness.only("/state").map((entry) => entry.body);
/** The fake post names an item `i-<number of posts so far>`: the first item post gets its index + 1. */
const lineItemId = (harness) => `i-${harness.posts.findIndex((entry) => entry.path.endsWith("/items")) + 1}`;
/** A terminal background job started inside the episode (a level signal: published once). */
const JOB = { source: "terminal-background-sessions", activeCount: 1, items: [{ id: "bg-1", startedAtMs: START_AT + 10 }] };

function runTurn(harness, options = {}) {
	const ctx = options.ctx ?? fakeCtx();
	harness.capture.onSessionStart(ctx);
	return runTurnAt(harness, ctx, options);
}

test("meta is posted before the first item and carries the thread facts", async () => {
	const harness = makeCapture();
	const ctx = runTurn(harness);
	await harness.advance(2500);
	await harness.flush();

	assert.equal(harness.posts[0].path, `/api/threads/${SESSION}/meta`);
	assert.deepEqual(harness.posts[0].body, {
		cwd: "C:/work/proj",
		sessionFile: "C:/sessions/s-1.jsonl",
		sessionName: "결제 화면",
		firstRequest: USER_TEXT,
		lastRequest: USER_TEXT,
		model: "anthropic/claude-haiku-4-5",
	});
	assert.equal(harness.posts.filter((entry) => entry.path.endsWith("/meta")).length, 1);
});

test("meta is re-sent once a request exists, keeping firstRequest and updating lastRequest", async () => {
	const harness = makeCapture();
	let branch = [];
	const ctx = fakeCtx({
		ctx: {
			sessionManager: {
				getSessionId: () => SESSION,
				getSessionFile: () => "C:/sessions/s-1.jsonl",
				getSessionName: () => "결제 화면",
				getBranch: () => branch,
			},
		},
	});
	harness.capture.onSessionStart(ctx);
	await harness.flush();
	assert.equal(harness.only("/meta")[0].body.firstRequest, "");
	assert.equal(harness.only("/meta")[0].body.lastRequest, "");

	branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "첫 요청" }] } }];
	runTurnAt(harness, ctx);
	await harness.advance(2500);
	let metas = harness.only("/meta");
	assert.equal(metas.length, 2);
	assert.equal(metas[1].body.firstRequest, "첫 요청");
	assert.equal(metas[1].body.lastRequest, "첫 요청");

	branch = [...branch, { type: "message", message: { role: "user", content: [{ type: "text", text: "두 번째 요청" }] } }];
	runTurnAt(harness, ctx);
	await harness.advance(2500);
	metas = harness.only("/meta");
	assert.equal(metas.length, 3);
	assert.equal(metas[2].body.firstRequest, "첫 요청");
	assert.equal(metas[2].body.lastRequest, "두 번째 요청");
});

test("interactive input re-sends meta after the request appears", async () => {
	const harness = makeCapture();
	let branch = [];
	const ctx = fakeCtx({
		ctx: {
			sessionManager: {
				getSessionId: () => SESSION,
				getSessionFile: () => "C:/sessions/s-1.jsonl",
				getSessionName: () => null,
				getBranch: () => branch,
			},
		},
	});
	harness.capture.onSessionStart(ctx);
	await harness.flush();
	branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "입력 뒤 요청" }] } }];
	harness.capture.onInput({ source: "interactive" }, ctx);
	await harness.flush();
	const metas = harness.only("/meta");
	assert.equal(metas.length, 2);
	assert.equal(metas[1].body.firstRequest, "입력 뒤 요청");
	assert.equal(metas[1].body.lastRequest, "입력 뒤 요청");
});

test("an empty session id posts nothing and logs once", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx({
		ctx: {
			sessionManager: {
				getSessionId: () => "",
				getSessionFile: () => null,
				getSessionName: () => null,
				getBranch: () => [],
			},
		},
	});
	harness.capture.onSessionStart(ctx);
	runTurnAt(harness, ctx);
	harness.capture.onAskUserAsked({ ctx, request: { requestId: "r-1", questions: [] } });
	harness.capture.onInput({ source: "interactive" }, ctx);
	await harness.advance(2500);
	assert.deepEqual(harness.posts, []);
	assert.equal(harness.logs.filter((line) => line.includes("session id is empty")).length, 1);
});

test("a throw from the settle timer is logged, not left unhandled", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx({ ctx: { isIdle: () => { throw new Error("boom"); } } });
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onAgentEnd({ messages: [assistantMessage()] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.equal(harness.logs.some((line) => line.includes("settle classification failed") && line.includes("boom")), true);
});

test("a question item carries the C3 payload and closes with the mapped reason", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	const request = {
		requestId: "r-1",
		questions: [
			{
				id: "q-1",
				header: "진행 승인",
				question: "이대로 진행할까요?",
				options: [{ label: "진행", description: "권장" }, { label: "멈춤", description: "" }],
				multiSelect: false,
			},
		],
		waitForAnswer: true,
		required: true,
		timeoutMs: 30 * 60_000,
	};
	harness.capture.onAskUserAsked({ ctx, request });
	await harness.flush();

	assert.deepEqual(harness.items()[0], {
		kind: "question",
		policy: "needs-you",
		dedupeKey: "q:r-1",
		raw: {
			request: {
				requestId: "r-1",
				questions: [
					{
						id: "q-1",
						header: "진행 승인",
						question: "이대로 진행할까요?",
						options: [
							{ label: "진행", description: "권장" },
							{ label: "멈춤", description: "" },
						],
						multiSelect: false,
					},
				],
				waitForAnswer: true,
				required: true,
				timeoutMs: 30 * 60_000,
				askedAt: START_AT,
			},
		},
	});

	harness.capture.onAskUserClosed({ requestId: "r-1", status: "answered", resolvedBy: "omo_inbox" });
	await harness.flush();
	const closes = harness.only("/close");
	assert.equal(closes.length, 1);
	assert.match(closes[0].path, /^\/api\/items\/i-\d+\/close$/);
	assert.deepEqual(closes[0].body, { reason: "answered-phone", resolvedBy: "omo_inbox" });
});

test("a question item reports the bridge state once its id arrives", async () => {
	const harness = makeCapture({ bridgeState: (requestId) => (requestId === "r-b" ? "none" : "live") });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAskUserAsked({ ctx, request: { requestId: "r-b", questions: [], waitForAnswer: true } });
	await harness.flush();

	const reports = harness.only("/bridge");
	assert.equal(reports.length, 1);
	assert.match(reports[0].path, /^\/api\/items\/i-\d+\/bridge$/);
	assert.deepEqual(reports[0].body, { state: "none" });
});

test("after a reload open questions without a live bridge wait are reported terminal-only", async () => {
	const states = { "r-live": "live", "r-detached": "detached", "r-none": "none" };
	const harness = makeCapture({ bridgeState: (requestId) => states[requestId] ?? "none" });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.reportOpenQuestionBridgeStates([
		{ id: "i-live", kind: "question", status: "open", raw: { request: { requestId: "r-live" } } },
		{ id: "i-detached", kind: "question", status: "open", raw: { request: { requestId: "r-detached" } } },
		{ id: "i-none", itemId: "i-none", kind: "question", status: "open", raw: { request: { requestId: "r-none" } } },
		{ id: "i-closed", kind: "question", status: "closed", raw: { request: { requestId: "r-closed" } } },
		{ id: "i-turn", kind: "turn", status: "open", raw: {} },
		{ raw: {} },
	]);
	await harness.flush();
	assert.deepEqual(harness.only("/bridge"), [
		{ path: "/api/items/i-detached/bridge", body: { state: "terminal-only" } },
		{ path: "/api/items/i-none/bridge", body: { state: "terminal-only" } },
	]);
});

test("a reattached question closes answered-terminal after the terminal answers", async () => {
	const harness = makeCapture({ bridgeState: () => "detached" });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.reportOpenQuestionBridgeStates([
		{ id: "i-reattached", kind: "question", status: "open", raw: { request: { requestId: "r-reattached" } } },
	]);
	await harness.flush();
	harness.capture.onAskUserClosed({ requestId: "r-reattached", status: "answered", resolvedBy: "local_ui" });
	await harness.flush();
	assert.deepEqual(harness.only("/close"), [
		{ path: "/api/items/i-reattached/close", body: { reason: "answered-terminal", resolvedBy: "local_ui" } },
	]);
});

test("a close for an unknown requestId does nothing", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAskUserClosed({ requestId: "r-unknown", status: "answered", resolvedBy: "local_ui" });
	await harness.flush();
	assert.deepEqual(harness.only("/close"), []);
});

test("close mapping follows status and answering surface", async () => {
	const cases = [
		{ status: "answered", resolvedBy: "local_ui", reason: "answered-terminal" },
		{ status: "comment-submitted", resolvedBy: "rpc_connection", reason: "answered-terminal" },
		{ status: "comment-submitted", resolvedBy: "omo_inbox", reason: "answered-phone" },
		{ status: "timed_out", reason: "timed-out" },
		{ status: "cancelled", reason: "cancelled" },
		{ status: "orphaned", reason: "cancelled" },
	];
	for (const entry of cases) {
		const harness = makeCapture();
		const ctx = fakeCtx();
		harness.capture.onSessionStart(ctx);
		harness.capture.onAskUserAsked({ ctx, request: { requestId: `r-${entry.status}`, questions: [], waitForAnswer: true } });
		harness.capture.onAskUserClosed({ requestId: `r-${entry.status}`, status: entry.status, resolvedBy: entry.resolvedBy });
		await harness.flush();
		const closes = harness.only("/close");
		assert.equal(closes.length, 1, `${entry.status} close`);
		assert.equal(closes[0].body.reason, entry.reason, `${entry.status} reason`);
		assert.equal(closes[0].body.resolvedBy ?? null, entry.resolvedBy ?? null, `${entry.status} resolvedBy`);
	}
});

test("a close that lands before the item response is applied once the id arrives", async () => {
	let release;
	const harness = makeCapture({
		post: async (path, body) => {
			harness.posts.push({ path, body });
			if (path.endsWith("/items")) {
				await new Promise((resolve) => { release = resolve; });
				return { item: { id: "i-slow" }, created: true, summaryRequest: null };
			}
			return { ok: true };
		},
	});
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAskUserAsked({ ctx, request: { requestId: "r-9", questions: [], waitForAnswer: true } });
	harness.capture.onAskUserClosed({ requestId: "r-9", status: "answered", resolvedBy: "local_ui" });
	assert.equal(harness.only("/close").length, 0);
	for (let index = 0; index < 10; index += 1) await Promise.resolve();
	assert.equal(typeof release, "function");
	release();
	await harness.flush();
	assert.deepEqual(harness.only("/close")[0].body, { reason: "answered-terminal", resolvedBy: "local_ui" });
});

test("a settled turn waits 2500 ms and then closes the episode with a needs-you final", async () => {
	const harness = makeCapture();
	runTurn(harness);
	assert.equal(harness.timers.size, 1);
	const [handle] = [...harness.timers];
	assert.equal(handle.ms, 2500);

	await harness.advance(2499);
	assert.deepEqual(harness.items(), []);
	await harness.advance(1);
	assert.deepEqual(harness.items(), [
		{
			kind: "turn",
			policy: "needs-you",
			dedupeKey: `episode:${SESSION}:${START_AT}:needs-you:m0`,
			raw: { final: ASSISTANT_TEXT, request: USER_TEXT, lastRequest: USER_TEXT },
			meta: {
				episode: {
					key: `e:${SESSION}:${START_AT}`,
					opener: START_AT,
					openedAt: START_AT,
					closedAt: START_AT + 2500,
					closeReason: "needs-you",
					lines: 0,
					turns: 1,
					interjections: 0,
					questions: 0,
				},
			},
		},
	]);
	assert.equal(harness.logs.includes("capture: close needs-you wait=-"), true);
});

test("a second settle in the same run does not post a second final", async () => {
	const harness = makeCapture({ goal: { status: "complete", objective: "배포 준비", updatedAt: Math.ceil(START_AT / 1000) } });
	const ctx = runTurn(harness);
	await harness.advance(2500);
	assert.deepEqual(kinds(harness), ["done"]);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.deepEqual(kinds(harness), ["done"], "still one final");
	assert.equal(harness.logs.includes("capture: turn end already reported in this run"), true);
});

test("agent_start inside the settle delay cancels the classification", async () => {
	const harness = makeCapture();
	const ctx = runTurn(harness);
	await harness.advance(1000);
	harness.capture.onAgentStart(ctx);
	await harness.advance(10_000);
	assert.deepEqual(harness.items(), []);
	assert.deepEqual(harness.activities(), [
		{ source: "agent-start", cause: "system", opened: true, episode: null },
		{ source: "agent-start", cause: "system", opened: false, episode: `e:${SESSION}:${START_AT}` },
	]);
});

test("no turn item is created while a question or permission dialog is open", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAskUserAsked({ ctx, request: { requestId: "r-open", questions: [], waitForAnswer: true } });
	runTurnAt(harness, ctx);
	await harness.advance(2500);
	assert.equal(harness.items().length, 1);
	assert.equal(harness.items()[0].kind, "question");

	harness.capture.onAskUserClosed({ requestId: "r-open", status: "answered", resolvedBy: "local_ui" });
	harness.capture.onPermissionDialog({ id: "d-1", title: "Permission required: bash", options: ["Allow once", "Deny"] }, ctx);
	runTurnAt(harness, ctx);
	await harness.advance(2500);
	assert.deepEqual(harness.items().map((item) => item.kind), ["question", "permission"]);
	assert.equal(harness.items()[1].dedupeKey, "perm:d-1");
	assert.deepEqual(harness.items()[1].raw.dialog.options, ["Allow once", "Deny"]);
});

test("a user abort posts a quiet turn", async () => {
	const harness = makeCapture();
	runTurn(harness, { aborted: true, abortSource: "user" });
	await harness.advance(2500);
	assert.equal(harness.items()[0].kind, "turn");
	assert.equal(harness.items()[0].policy, "quiet");
});

test("an active goal with a wake source posts the line and marks it waiting", async () => {
	const harness = makeCapture({ goal: { status: "active", objective: "배포 준비", updatedAt: 10 } });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	runLineTurn(harness, ctx);
	harness.capture.onSignal("wake_source_state", { source: "senpi-task", activeCount: 2 });
	await harness.advance(2500);
	assert.deepEqual(harness.items(), [
		{
			kind: "progress",
			policy: "progress",
			dedupeKey: `line:${SESSION}:m5000`,
			raw: { text: ASSISTANT_TEXT, request: USER_TEXT },
			meta: { episode: { key: `e:${SESSION}:${START_AT}`, opener: START_AT, openedAt: START_AT, seq: 1 } },
		},
	]);
	assert.deepEqual(harness.only("/state"), [
		{ path: `/api/items/${lineItemId(harness)}/state`, body: { state: "waiting", reasons: ["senpi-task"], boards: [] } },
	]);
});

test("holds, a scheduled continuation and a running monitor each keep the episode open", async () => {
	const cases = [
		{ channel: "continuation_hold_state", event: { source: "omo-desk", active: true }, reason: "hold:omo-desk" },
		{ channel: "goal_continuation_timer_state", event: { armed: true }, reason: "scheduled" },
		{ channel: "goal_continuation_scheduled", event: { delayMs: 1000, wakeSources: ["senpi-task"] }, reason: "scheduled" },
		{
			channel: "terminal_monitor_state",
			event: { activeCount: 1, monitors: [{ id: "mon-1", startedAtMs: START_AT, persistent: false, paused: false }] },
			reason: "terminal-monitors",
		},
	];
	for (const entry of cases) {
		const harness = makeCapture({ goal: { status: "active", objective: "배포 준비", updatedAt: 10 } });
		const ctx = fakeCtx();
		harness.capture.onSessionStart(ctx);
		runLineTurn(harness, ctx);
		// An agent start clears the scheduled flag, so these arrive after it.
		harness.capture.onSignal(entry.channel, entry.event);
		await harness.advance(2500);
		assert.deepEqual(kinds(harness), ["progress"], entry.channel);
		assert.deepEqual(stateBodies(harness), [{ state: "waiting", reasons: [entry.reason], boards: [] }], entry.channel);
	}
});

test("an active goal with no wake, hold or schedule closes stalled", async () => {
	const harness = makeCapture({ goal: { status: "active", objective: "배포 준비", updatedAt: 10 } });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onSignal("wake_source_state", { source: "omo-inbox", activeCount: 3 });
	runLineTurn(harness, ctx);
	await harness.advance(2500);
	assert.deepEqual(kinds(harness), ["progress", "turn"]);
	const final = harness.items()[1];
	assert.equal(final.policy, "needs-you");
	assert.equal(final.meta.stalled, true);
	assert.equal(final.meta.episode.closeReason, "stalled");
	assert.equal(final.meta.episode.lines, 1);
	assert.equal(final.dedupeKey, `episode:${SESSION}:${START_AT}:stalled:m5000`);
	assert.deepEqual(harness.only("/state"), []);
});

test("a stopped active goal is a plain needs-you turn", async () => {
	const harness = makeCapture({ goal: { status: "active", objective: "배포 준비", updatedAt: 10, continuationStoppedAt: 11 } });
	runTurn(harness);
	await harness.advance(2500);
	assert.equal(harness.items()[0].kind, "turn");
	assert.equal(harness.items()[0].policy, "needs-you");
	assert.equal(harness.items()[0].meta.stalled, undefined);
	assert.equal(harness.items()[0].meta.episode.closeReason, "needs-you");
});

test("a desk wake is a waiting line in either mode and carries the boards it waits on", async () => {
	const boards = [{ id: "b-1", title: "결제 보드", url: "https://box.tail.ts.net:4378/b/b-1" }];
	for (const mode of ["trial", "primary"]) {
		const harness = makeCapture({ mode, deskBoards: mode === "trial" ? () => boards : undefined });
		const ctx = fakeCtx();
		harness.capture.onSessionStart(ctx);
		harness.capture.onSignal("wake_source_state", { source: "omo-desk", activeCount: 1 });
		runLineTurn(harness, ctx);
		await harness.advance(2500);
		assert.deepEqual(kinds(harness), ["progress"], mode);
		assert.deepEqual(stateBodies(harness), [{ state: "waiting", reasons: ["omo-desk"], boards: mode === "trial" ? boards : [] }], mode);
	}
});

test("outside an episode update_goal still posts blocked and done items deduped by the goal key", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	const blocked = { status: "blocked", blockedReason: "배포 키가 필요합니다", objective: "배포 준비", updatedAt: 100 };
	harness.capture.onToolExecutionEnd({ toolName: "update_goal", result: { details: { goal: blocked } } }, ctx);
	harness.capture.onToolExecutionEnd({ toolName: "update_goal", result: { details: { goal: blocked } } }, ctx);
	harness.capture.onToolExecutionEnd({ toolName: "read", result: {} }, ctx);
	await harness.flush();
	assert.deepEqual(harness.items(), [
		{
			kind: "blocked",
			policy: "needs-you",
			dedupeKey: "goal:blocked:100",
			raw: {
				text: "",
				request: USER_TEXT,
				goal: { reason: "배포 키가 필요합니다", objective: "배포 준비" },
			},
		},
	]);

	harness.state.goal = { status: "complete", objective: "배포 준비", updatedAt: 200 };
	harness.capture.onGoalStoreChanged({ threadId: SESSION }, ctx);
	harness.capture.onGoalStoreChanged({ threadId: SESSION }, ctx);
	await harness.flush();
	assert.deepEqual(harness.items()[1], {
		kind: "done",
		policy: "needs-you",
		dedupeKey: "goal:complete:200",
		raw: { text: "", request: USER_TEXT, goal: { reason: null, objective: "배포 준비" } },
	});
	assert.equal(harness.items().length, 2);
});

test("a goal file change without a tool event still posts blocked once", async () => {
	const harness = makeCapture({ goal: { status: "blocked", blockedReason: "권한이 없습니다", objective: "배포", updatedAt: 42 } });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onGoalStoreChanged({ threadId: SESSION }, ctx);
	await harness.flush();
	assert.equal(harness.items()[0].kind, "blocked");
	assert.equal(harness.items()[0].dedupeKey, "goal:blocked:42");

	harness.capture.onGoalStoreChanged({ threadId: SESSION }, ctx);
	harness.capture.onGoalStoreChanged({ threadId: "another-session" }, ctx);
	await harness.flush();
	assert.equal(harness.items().length, 1);
});

test("a settled turn does not repeat a blocked goal the tool event already captured", async () => {
	const harness = makeCapture({ goal: { status: "blocked", blockedReason: "키 필요", objective: "배포", updatedAt: 7 } });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onToolExecutionEnd({ toolName: "update_goal", result: { details: { goal: harness.state.goal } } }, ctx);
	await harness.flush();
	harness.capture.onAgentEnd({ messages: [assistantMessage()] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.deepEqual(harness.items().map((item) => item.kind), ["blocked"]);
});

test("a complete goal updated in this run posts done once", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.state.goal = { status: "complete", objective: "배포", updatedAt: 1100 };
	harness.capture.onAgentEnd({ messages: [assistantMessage()] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.deepEqual(harness.items().map((item) => item.kind), ["done"]);
});

test("activity is posted for interactive input and agent start only", async () => {
	const harness = makeCapture();
	const ctx = runTurn(harness);
	harness.capture.onInput({ source: "interactive", text: "계속" }, ctx);
	harness.capture.onInput({ source: "extension", text: "계속" }, ctx);
	harness.capture.onInput({ source: "rpc", text: "계속" }, ctx);
	await harness.advance(2500);
	assert.deepEqual(harness.activities(), [
		{ source: "agent-start", cause: "system", opened: true, episode: null },
		{ source: "terminal-input", cause: "owner" },
	]);
});

test("the queue keeps a failed post in order and retries it on the next flush", async () => {
	const harness = makeCapture();
	harness.state.fail = true;
	runTurn(harness);
	await harness.advance(2500);
	assert.deepEqual(harness.items(), []);
	assert.equal(harness.logs.some((line) => line.includes("queued for retry")), true);

	harness.state.fail = false;
	await harness.flush();
	assert.deepEqual(harness.posts.map((entry) => entry.path), [
		`/api/threads/${SESSION}/meta`,
		`/api/threads/${SESSION}/activity`,
		`/api/threads/${SESSION}/items`,
	]);
	assert.equal(harness.items()[0].kind, "turn");
});

test("a summary request returned by the items post is handed to onSummaryRequest", async () => {
	const summaryRequest = { system: "s", user: "u", maxTokens: 700 };
	const harness = makeCapture({ summaryRequest });
	runTurn(harness);
	await harness.advance(2500);
	assert.equal(harness.summaries.length, 1);
	assert.deepEqual(harness.summaries[0].request, summaryRequest);
	assert.equal(harness.summaries[0].item.id.length > 0, true);
});

test("child sessions and non-tui modes stay inert", async () => {
	const child = makeCapture({ env: { OMO_SENPI_TASK_RPC_CHILD: "1" } });
	const childCtx = runTurn(child);
	child.capture.onAskUserAsked({ request: { requestId: "r", questions: [] } });
	child.capture.onInput({ source: "interactive" }, childCtx);
	child.capture.onNotice({ producer: "omo-inbox", dedupeKey: "k", title: "t", body: "b", urgency: "now" }, childCtx);
	await child.advance(3000);
	assert.deepEqual(child.posts, []);

	const rpc = makeCapture();
	const rpcCtx = fakeCtx({ ctx: { mode: "rpc" } });
	runTurn(rpc, { ctx: rpcCtx });
	rpc.capture.onAskUserAsked({ ctx: rpcCtx, request: { requestId: "r", questions: [] } });
	await rpc.advance(3000);
	assert.deepEqual(rpc.posts, []);
});

test("an assistant message without text parts produces no item", async () => {
	const harness = makeCapture();
	runTurn(harness, { messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read" }] }] });
	await harness.advance(2500);
	assert.deepEqual(harness.items(), []);

	const empty = makeCapture();
	runTurn(empty, { messages: [{ role: "assistant", content: [] }] });
	await empty.advance(2500);
	assert.deepEqual(empty.items(), []);
});

test("message_end alone can supply the turn text", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onMessageStart({ message: assistantMessage() }, ctx);
	harness.capture.onMessageEnd({ message: assistantMessage("배포 준비가 끝났습니다.") }, ctx);
	harness.capture.onAgentEnd({ messages: [] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.equal(harness.items()[0].raw.text, "배포 준비가 끝났습니다.");
});

test("the cache post only fires when warmUntil moves by more than 30 s", async () => {
	const tracker = { value: { warmUntil: START_AT + 300_000, ttlSec: 300 }, onAssistantStart: () => tracker.value };
	const harness = makeCapture({ cacheTracker: tracker });
	const ctx = runTurn(harness);
	harness.capture.onMessageStart({ message: assistantMessage() }, ctx);
	await harness.flush();
	assert.deepEqual(harness.only("/cache")[0].body, { warmUntil: START_AT + 300_000, ttlSec: 300 });

	tracker.value = { warmUntil: START_AT + 310_000, ttlSec: 300 };
	harness.capture.onMessageStart({ message: assistantMessage() }, ctx);
	await harness.flush();
	assert.equal(harness.only("/cache").length, 1);

	tracker.value = { warmUntil: START_AT + 400_000, ttlSec: 300 };
	harness.capture.onMessageStart({ message: assistantMessage() }, ctx);
	await harness.flush();
	assert.equal(harness.only("/cache").length, 2);
	assert.equal(harness.only("/cache")[1].body.warmUntil, START_AT + 400_000);
});

test("notices are forwarded with the session and cwd filled in", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onNotice({ producer: "qa", dedupeKey: "run-1", title: "QA", body: "끝났습니다", urgency: "soon" }, ctx);
	harness.capture.onNotice({ producer: "qa", dedupeKey: "run-2", title: "QA", body: "끝났습니다", urgency: "fyi", session: "other" }, ctx);
	await harness.flush();
	assert.deepEqual(harness.only("/notices")[0].body, {
		producer: "qa",
		dedupeKey: "run-1",
		title: "QA",
		body: "끝났습니다",
		urgency: "soon",
		session: SESSION,
		cwd: "C:/work/proj",
	});
	assert.equal(harness.only("/notices")[1].body.session, "other");
});

test("the answer frame is not the request text and the request is capped", async () => {
	const long = "가".repeat(3000);
	const harness = makeCapture();
	const ctx = fakeCtx({
		ctx: {
			sessionManager: {
				getSessionId: () => SESSION,
				getSessionFile: () => "C:/sessions/s-1.jsonl",
				getSessionName: () => null,
				getBranch: () => [
					{ type: "message", message: { role: "user", content: [{ type: "text", text: "[Answer to question q-1] 진행" }] } },
					{ type: "message", message: { role: "user", content: [{ type: "text", text: long }] } },
				],
			},
		},
	});
	runTurn(harness, { ctx });
	await harness.advance(2500);
	assert.equal(harness.items()[0].raw.request.length, 2048);
	assert.equal(harness.items()[0].raw.request, long.slice(0, 2048));
	assert.equal(harness.posts[0].body.lastRequest.length, 600);
});

test("goal active, background job started mid-turn is a waiting line, not a stalled turn", async () => {
	const harness = makeCapture({ goal: { status: "active", objective: "배포 준비", updatedAt: 10 } });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onSignal("wake_source_state", JOB);
	const message = stamped(ASSISTANT_TEXT, 5000);
	harness.capture.onMessageEnd({ message }, ctx);
	harness.capture.onAgentEnd({ messages: [message] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.deepEqual(kinds(harness), ["progress"]);
	assert.equal(harness.items().some((item) => item.meta?.stalled === true), false);
	assert.deepEqual(harness.only("/state"), [
		{
			path: `/api/items/${lineItemId(harness)}/state`,
			body: { state: "waiting", reasons: ["terminal-background-sessions"], boards: [] },
		},
	]);
	assert.equal(harness.logs.includes("capture: line-only - wait=terminal-background-sessions"), true);
});

test("no goal and a background job is a waiting line, not a needs-you turn", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onSignal("wake_source_state", JOB);
	runLineTurn(harness, ctx);
	await harness.advance(2500);
	assert.deepEqual(kinds(harness), ["progress"]);
	assert.equal(stateBodies(harness).length, 1);
	assert.deepEqual(stateBodies(harness)[0].reasons, ["terminal-background-sessions"]);
});

test("signals published before the session start and across turn ends still count", async () => {
	const harness = makeCapture();
	harness.capture.onSignal("wake_source_state", JOB);
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	runLineTurn(harness, ctx, { stamp: 5000 });
	await harness.advance(2500);
	runLineTurn(harness, ctx, { stamp: 6000 });
	await harness.advance(2500);
	assert.deepEqual(kinds(harness), ["progress", "progress"]);
	assert.equal(stateBodies(harness).length, 2);
});

test("flip: the last job ending while idle closes the episode after 10 s", async () => {
	for (const goal of [null, { status: "active", objective: "배포 준비", updatedAt: 10 }]) {
		const harness = makeCapture({ goal });
		const ctx = fakeCtx();
		harness.capture.onSessionStart(ctx);
		harness.capture.onSignal("wake_source_state", JOB);
		runLineTurn(harness, ctx);
		await harness.advance(2500);
		assert.deepEqual(kinds(harness), ["progress"]);

		harness.capture.onSignal("wake_source_state", { source: JOB.source, activeCount: 0 });
		assert.equal(harness.timers.size, 1);
		assert.equal([...harness.timers][0].ms, 10_000);
		await harness.advance(9999);
		assert.deepEqual(kinds(harness), ["progress"]);
		await harness.advance(1);
		assert.deepEqual(kinds(harness), ["progress", "turn"]);
		const final = harness.items()[1];
		assert.equal(final.raw.final, ASSISTANT_TEXT);
		assert.equal(final.policy, "needs-you");
		assert.equal(final.meta.episode.closeReason, goal === null ? "needs-you" : "stalled");
		assert.equal(final.meta.stalled ?? false, goal !== null);
	}
});

test("flip: a start within 10 s cancels the close", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onSignal("wake_source_state", JOB);
	runLineTurn(harness, ctx);
	await harness.advance(2500);
	harness.capture.onSignal("wake_source_state", { source: JOB.source, activeCount: 0 });
	assert.equal(harness.timers.size, 1);
	await harness.advance(5000);
	harness.capture.onAgentStart(ctx);
	assert.equal(harness.timers.size, 0);
	await harness.advance(30_000);
	assert.deepEqual(kinds(harness), ["progress"]);
});

test("flip: a wake that returns, a running session or no open episode arm nothing", async () => {
	const idle = { value: true };
	const harness = makeCapture();
	const ctx = fakeCtx({ ctx: { isIdle: () => idle.value } });
	harness.capture.onSessionStart(ctx);
	const jobEnds = { source: JOB.source, activeCount: 0 };
	harness.capture.onSignal("wake_source_state", JOB);
	harness.capture.onSignal("wake_source_state", jobEnds);
	assert.equal(harness.timers.size, 0, "no episode open yet");

	harness.capture.onSignal("wake_source_state", JOB);
	runLineTurn(harness, ctx);
	await harness.advance(2500);
	idle.value = false;
	harness.capture.onSignal("wake_source_state", jobEnds);
	assert.equal(harness.timers.size, 0, "running");

	idle.value = true;
	harness.capture.onSignal("wake_source_state", JOB);
	harness.capture.onSignal("wake_source_state", jobEnds);
	assert.equal(harness.timers.size, 1);
	harness.capture.onSignal("wake_source_state", JOB);
	assert.equal(harness.timers.size, 0);
	await harness.advance(10_000);
	assert.deepEqual(kinds(harness), ["progress"], "the wake came back before the timer fired");
});

test("update_goal during an episode posts no goal item: one final at settle with the closing text", async () => {
	const cases = [
		{ goal: { status: "complete", objective: "배포", updatedAt: 2000 }, kind: "done", reason: "done" },
		{ goal: { status: "blocked", blockedReason: "키 필요", objective: "배포", updatedAt: 2000 }, kind: "blocked", reason: "blocked" },
	];
	for (const entry of cases) {
		const idle = { value: true };
		const harness = makeCapture();
		const ctx = fakeCtx({ ctx: { isIdle: () => idle.value } });
		harness.capture.onSessionStart(ctx);
		harness.capture.onAgentStart(ctx);
		idle.value = false;
		harness.state.goal = entry.goal;
		harness.capture.onToolExecutionEnd({ toolName: "update_goal", result: { details: { goal: entry.goal } } }, ctx);
		harness.capture.onGoalStoreChanged({ threadId: SESSION }, ctx);
		await harness.flush();
		assert.deepEqual(harness.items(), [], `${entry.kind}: no goal item yet`);

		const message = stamped("모든 작업을 마쳤습니다.", 7000);
		harness.capture.onMessageEnd({ message }, ctx);
		harness.capture.onAgentEnd({ messages: [message] }, ctx);
		idle.value = true;
		harness.capture.onAgentSettled(ctx);
		await harness.advance(2500);
		assert.deepEqual(kinds(harness), ["progress", entry.kind]);
		const final = harness.items()[1];
		assert.equal(final.policy, "needs-you");
		assert.equal(final.raw.final, "모든 작업을 마쳤습니다.");
		assert.equal(final.raw.goal.objective, "배포");
		assert.equal(final.meta.episode.closeReason, entry.reason);
		assert.equal(final.dedupeKey, `episode:${SESSION}:${START_AT}:${entry.reason}:m7000`);
	}
});

test("update_goal complete survives a follow-up run that starts inside the settle delay", async () => {
	const goal = { status: "complete", objective: "배포", updatedAt: 2000 };
	const harness = makeCapture({ goal: { status: "active", objective: "배포", updatedAt: 10 } });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onToolExecutionEnd({ toolName: "update_goal", result: { details: { goal } } }, ctx);
	const first = stamped("목표를 끝냈습니다.", 7000);
	harness.capture.onMessageEnd({ message: first }, ctx);
	harness.capture.onAgentEnd({ messages: [first] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(1000);
	const second = stamped("확인했습니다.", 9000);
	harness.capture.onAgentStart(ctx);
	harness.capture.onMessageEnd({ message: second }, ctx);
	harness.capture.onAgentEnd({ messages: [second] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.deepEqual(kinds(harness).filter((kind) => kind !== "progress"), ["done"]);
});

test("update_goal complete closes the episode even while a job still runs", async () => {
	const goal = { status: "complete", objective: "배포", updatedAt: 2000 };
	const harness = makeCapture({ goal });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onSignal("wake_source_state", JOB);
	harness.capture.onAgentStart(ctx);
	harness.capture.onToolExecutionEnd({ toolName: "update_goal", result: { details: { goal } } }, ctx);
	const message = stamped("끝났습니다.", 7000);
	harness.capture.onMessageEnd({ message }, ctx);
	harness.capture.onAgentEnd({ messages: [message] }, ctx);
	harness.capture.onAgentSettled(ctx);
	await harness.advance(2500);
	assert.deepEqual(kinds(harness), ["progress", "done"]);
	assert.deepEqual(harness.only("/state"), []);
});

test("every assistant message with text posts one progress line", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onMessageEnd({ message: stamped("첫 메시지입니다.", 1000) }, ctx);
	harness.capture.onMessageEnd({ message: { role: "assistant", content: [{ type: "toolCall", name: "read" }], timestamp: 1500 } }, ctx);
	harness.capture.onMessageEnd({ message: { role: "user", content: [{ type: "text", text: "사용자" }], timestamp: 1600 } }, ctx);
	harness.capture.onMessageEnd({ message: stamped("가".repeat(9000), 2000) }, ctx);
	await harness.flush();
	const key = `e:${SESSION}:${START_AT}`;
	assert.deepEqual(harness.items(), [
		{
			kind: "progress",
			policy: "progress",
			dedupeKey: `line:${SESSION}:m1000`,
			raw: { text: "첫 메시지입니다.", request: USER_TEXT },
			meta: { episode: { key, opener: START_AT, openedAt: START_AT, seq: 1 } },
		},
		{
			kind: "progress",
			policy: "progress",
			dedupeKey: `line:${SESSION}:m2000`,
			raw: { text: "가".repeat(8192), request: USER_TEXT },
			meta: { episode: { key, opener: START_AT, openedAt: START_AT, seq: 2 } },
		},
	]);
});

test("a line is built when it is sent: the server's reopen answer changes its episode key", async () => {
	const harness = makeCapture({
		post: async (path, body) => {
			harness.posts.push({ path, body });
			if (path.endsWith("/activity")) return { source: "agent-start", superseded: 0, reopen: { key: "e:s-1:777", opener: 777, openedAt: 900, seq: 2 } };
			if (path.endsWith("/items")) return { item: { id: `i-${harness.posts.length}` }, created: true, summaryRequest: null };
			return { ok: true };
		},
	});
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onMessageEnd({ message: stamped("이어서 작업합니다.", 3000) }, ctx);
	await harness.flush();
	assert.deepEqual(harness.posts.map((entry) => entry.path), [
		`/api/threads/${SESSION}/meta`,
		`/api/threads/${SESSION}/activity`,
		`/api/threads/${SESSION}/items`,
	]);
	assert.deepEqual(harness.items()[0].meta, { episode: { key: "e:s-1:777", opener: 777, openedAt: 900, seq: 3 } });
	assert.equal(harness.items()[0].dedupeKey, `line:${SESSION}:m3000`);
});

test("a closed episode answered to an owner start gives the turn a new key", async () => {
	const harness = makeCapture({
		post: async (path, body) => {
			harness.posts.push({ path, body });
			if (path.endsWith("/activity") && body.source === "agent-start" && body.opened === false) {
				return { source: "agent-start", superseded: 0, episodeClosed: true, closeReason: "needs-you" };
			}
			if (path.endsWith("/items")) return { item: { id: `i-${harness.posts.length}` }, created: true, summaryRequest: null };
			return { ok: true };
		},
	});
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onAgentStart(ctx);
	await harness.flush();
	harness.state.t += 5000;
	harness.capture.onInput({ source: "interactive", text: "다음 일" }, ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onMessageEnd({ message: stamped("다음 일을 시작합니다.", 9000) }, ctx);
	await harness.flush();
	assert.deepEqual(harness.activities().map((body) => [body.source, body.cause, body.opened]), [
		["agent-start", "system", true],
		["terminal-input", "owner", undefined],
		["agent-start", "owner", false],
	]);
	assert.deepEqual(harness.items()[0].meta, {
		episode: { key: `e:${SESSION}:${START_AT + 5000}`, opener: START_AT + 5000, openedAt: START_AT + 5000, seq: 1 },
	});
});

test("owner causes mark the next agent start once", async () => {
	const harness = makeCapture();
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onInput({ source: "interactive", text: "계속" }, ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onAgentStart(ctx);
	harness.capture.onAskUserAsked({ ctx, request: { requestId: "r-1", questions: [], waitForAnswer: true } });
	harness.capture.onAskUserClosed({ requestId: "r-1", status: "answered", resolvedBy: "local_ui" });
	harness.capture.onAgentStart(ctx);
	harness.capture.markOwner("phone");
	harness.capture.onAgentStart(ctx);
	harness.capture.markOwner("robot");
	harness.capture.onAgentStart(ctx);
	harness.capture.onAskUserAsked({ ctx, request: { requestId: "r-2", questions: [], waitForAnswer: true } });
	harness.capture.onAskUserClosed({ requestId: "r-2", status: "cancelled" });
	harness.capture.onAgentStart(ctx);
	await harness.flush();
	const starts = harness.activities().filter((body) => body.source === "agent-start");
	assert.deepEqual(starts.map((body) => body.cause), ["owner", "system", "owner", "owner", "system", "system"]);
});

test("the verdict of every classification is logged", async () => {
	const harness = makeCapture({ goal: { status: "active", objective: "배포 준비", updatedAt: 10 } });
	const ctx = fakeCtx();
	harness.capture.onSessionStart(ctx);
	harness.capture.onSignal("wake_source_state", { source: "senpi-task", activeCount: 1 });
	harness.capture.onSignal("continuation_hold_state", { source: "omo-inbox", active: true });
	runLineTurn(harness, ctx);
	await harness.advance(2500);
	harness.capture.onSignal("wake_source_state", { source: "senpi-task", activeCount: 0 });
	harness.capture.onSignal("continuation_hold_state", { source: "omo-inbox", active: false });
	await harness.advance(10_000);
	assert.deepEqual(harness.logs.filter((line) => line.startsWith("capture: line-only") || line.startsWith("capture: close")), [
		"capture: line-only - wait=senpi-task,hold:omo-inbox",
		"capture: close stalled wait=-",
	]);
});

test("a restored episode counts as waking for 60 s, then closes through the flip", async () => {
	const harness = makeCapture();
	const branch = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: USER_TEXT }] } },
		{ type: "message", message: { role: "assistant", stopReason: "stop", timestamp: 900_000, content: [{ type: "text", text: "작업을 마쳤습니다." }] } },
	];
	const ctx = fakeCtx({ branch });
	harness.capture.onSessionStart(ctx);
	const items = [
		{ id: "i-9", kind: "progress", status: "closed", createdAt: new Date(500_000).toISOString(), meta: { episode: { key: "e:s-1:500", opener: 500, openedAt: 600, seq: 2 } } },
	];
	harness.capture.restoreEpisode(items);
	assert.deepEqual([...harness.timers].map((handle) => handle.ms), [60_000]);
	harness.capture.recoverTurnEnd(items);
	await harness.advance(2500);
	assert.deepEqual(harness.only("/state"), [
		{ path: "/api/items/i-9/state", body: { state: "waiting", reasons: ["reload-grace"], boards: [] } },
	]);
	assert.deepEqual(kinds(harness), []);

	await harness.advance(57_500);
	assert.deepEqual(kinds(harness), ["turn"]);
	const final = harness.items()[0];
	assert.equal(final.dedupeKey, "episode:s-1:500:needs-you:m900000");
	assert.equal(final.raw.final, "작업을 마쳤습니다.");
	assert.equal(final.meta.episode.key, "e:s-1:500");
	assert.equal(final.meta.episode.lines, 2);
});
