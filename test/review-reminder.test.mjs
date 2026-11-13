// Report reminder tests (README "Report reminder").
// Run: node --test test/review-reminder.test.mjs
// Fake clock, fake timers, fake post, fake git and server checks: nothing here waits on wall-clock time.
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapture } from "../extension/inbox/capture.ts";
import { REVIEW_REMINDER_TEXT } from "../extension/inbox/reminder.ts";

const SESSION = "s-r";
const START_AT = 1_000_000;

function fakeCtx() {
	const branch = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "화면을 고쳐줘" }] } }];
	return {
		mode: "tui",
		cwd: "C:/work/proj",
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => SESSION,
			getSessionFile: () => "C:/sessions/s-r.jsonl",
			getSessionName: () => "화면",
			getBranch: () => branch,
		},
	};
}

function makeHarness() {
	const state = { t: START_AT, stamp: 5000, serverDown: false };
	const timers = new Set();
	const posts = [];
	const logs = [];
	const reminders = [];
	/** Times a visual file changed in git, times this session posted a board or a reply, and what each git check was asked. */
	const changes = [];
	const boards = [];
	const replies = [];
	const probes = [];
	const newest = (list, sinceMs) => {
		const seen = list.filter((at) => at >= sinceMs);
		return seen.length > 0 ? Math.max(...seen) : null;
	};
	const capture = createCapture({
		env: {},
		now: () => state.t,
		setTimer: (fn, ms) => {
			const handle = { fn, due: state.t + ms };
			timers.add(handle);
			return handle;
		},
		clearTimer: (handle) => timers.delete(handle),
		readGoal: async () => null,
		log: (line) => logs.push(line),
		remind: (text) => reminders.push(text),
		reviewChecks: {
			lastVisualChange: async (dirs, sinceMs) => {
				probes.push({ dirs, since: sinceMs });
				return newest(changes, sinceMs);
			},
			boardActivity: async (session, sinceMs) => {
				if (state.serverDown) return null;
				return session === SESSION ? { board: newest(boards, sinceMs), reply: newest(replies, sinceMs) } : { board: null, reply: null };
			},
		},
		post: async (path, body) => {
			posts.push({ path, body });
			return path.endsWith("/items") ? { item: { id: `i-${posts.length}` }, created: true, summaryRequest: null } : { ok: true };
		},
	});
	const ctx = fakeCtx();
	capture.onSessionStart(ctx);

	async function advance(ms) {
		state.t += ms;
		for (const handle of [...timers]) {
			if (handle.due > state.t) continue;
			timers.delete(handle);
			handle.fn();
		}
		for (let index = 0; index < 12; index += 1) {
			await capture.flush();
			await Promise.resolve();
		}
	}

	/** One run: optional tool calls, one assistant reply, agent end, settle. */
	async function turn({ tools = [], aborted = false, abortSource } = {}) {
		state.stamp += 1000;
		const message = { role: "assistant", content: [{ type: "text", text: `완료 ${state.stamp}` }], timestamp: state.stamp };
		capture.onAgentStart(ctx);
		for (const tool of tools) {
			capture.onToolExecutionStart({ toolCallId: tool.id ?? "t", toolName: tool.name, args: tool.args ?? {} }, ctx);
			capture.onToolExecutionEnd({ toolCallId: tool.id ?? "t", toolName: tool.name, result: tool.result ?? { content: [] }, isError: false }, ctx);
		}
		capture.onMessageEnd({ message }, ctx);
		capture.onAgentEnd({ messages: [message], aborted, abortSource }, ctx);
		capture.onAgentSettled(ctx);
		await advance(2500);
	}

	const input = (text) => capture.onInput({ source: "interactive", text }, ctx);
	const changeScreen = () => changes.push(state.t);
	const postBoard = () => boards.push(state.t);
	const postReply = () => replies.push(state.t);
	const finals = () => posts.filter((entry) => entry.path.endsWith("/items") && entry.body.kind !== "progress").map((entry) => entry.body);
	const starts = () => posts.filter((entry) => entry.path.endsWith("/activity") && entry.body.source === "agent-start").map((entry) => entry.body);
	return { capture, state, reminders, logs, probes, finals, starts, turn, input, advance, changeScreen, postBoard, postReply };
}

const IMAGE = { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };

test("a visual change with no board reminds once, and the next final keeps the held report", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	h.changeScreen();
	await h.turn();

	assert.deepEqual(h.reminders, [REVIEW_REMINDER_TEXT]);
	assert.ok(h.logs.includes("capture: review check visual=yes board=no"));
	assert.ok(h.logs.includes("capture: review reminder"));
	assert.deepEqual(h.finals(), [], "no final on the reminded turn end");

	await h.turn();
	assert.equal(h.reminders.length, 1);
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
	assert.equal(h.finals()[0].raw.final, "완료 6000\n\n완료 7000", "the reply to the reminder follows the report instead of replacing it");
	assert.match(h.finals()[0].dedupeKey, /^episode:/);
	assert.deepEqual(h.starts().map((start) => [start.cause, start.opened]), [["owner", true], ["system", false]], "the reminded turn continues the episode");
});

test("what the session only looked at never reminds", async () => {
	const h = makeHarness();
	h.input("이 앱 화면을 보고 설명해줘");
	await h.turn({
		tools: [
			{ name: "computer", args: { action: "screenshot" }, result: IMAGE },
			{ name: "read", args: { path: "C:/work/ref.png" }, result: IMAGE },
			{ name: "eval", args: { code: "send('이전 회차는 스크린샷·영상만 지우기')" }, result: { content: [{ type: "text", text: "8.6G evidence/screenshots" }] } },
		],
	});
	assert.deepEqual(h.reminders, []);
	assert.ok(h.logs.includes("capture: review check visual=no board=-"));
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
});

test("a board the session posted in the window means no reminder, however the command was written", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	h.changeScreen();
	h.postBoard();
	await h.turn({ tools: [{ name: "eval", args: { code: "await Bun.$`node ${inbox} ${args}`" } }] });
	assert.deepEqual(h.reminders, []);
	assert.ok(h.logs.includes("capture: review check visual=yes board=yes"));
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
});

test("a reply counts only when it comes after the last visual change", async () => {
	const h = makeHarness();
	h.capture.markOwner("board-feedback");
	h.postReply();
	await h.advance(1000);
	h.changeScreen();
	await h.turn();
	assert.deepEqual(h.reminders, [REVIEW_REMINDER_TEXT], "acknowledging the feedback before the change is not a report");
	await h.turn();

	h.input("한 군데만 더 고쳐줘");
	h.changeScreen();
	await h.advance(1000);
	h.postReply();
	await h.turn();
	assert.equal(h.reminders.length, 1, "a reply after the change reports it");
});

test("when the server can't answer there is no reminder", async () => {
	const h = makeHarness();
	h.state.serverDown = true;
	h.input("결제 화면을 고쳐줘");
	h.changeScreen();
	await h.turn();
	assert.deepEqual(h.reminders, []);
	assert.ok(h.logs.includes("capture: review check visual=yes board=unknown"));
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
});

test("git is asked about the cwd and the folders of edited visual files only", async () => {
	const h = makeHarness();
	h.input("버튼 색을 바꿔줘");
	await h.turn({
		tools: [
			{ name: "edit", args: { path: "../shared/web/app.js" } },
			{ name: "write", args: { file_path: "C:/other/src/Page.tsx" } },
			{ name: "edit", args: { path: "src/logic.ts" } },
		],
	});
	const cwd = fakeCtx().cwd;
	assert.deepEqual(h.probes.map((probe) => probe.dirs), [[cwd, path.dirname(path.resolve(cwd, "../shared/web/app.js")), path.dirname(path.resolve(cwd, "C:/other/src/Page.tsx"))]]);
	assert.deepEqual(h.reminders, [], "the fake git saw no change");
});

test("an input that says Review 생략 means no reminder", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘, Review 생략");
	h.changeScreen();
	await h.turn();
	assert.deepEqual(h.reminders, []);
	assert.deepEqual(h.probes, [], "a skipped window asks nothing");
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
});

test("a user abort closes quietly without a reminder", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	h.changeScreen();
	await h.turn({ aborted: true, abortSource: "user" });
	assert.deepEqual(h.reminders, []);
	assert.deepEqual(h.finals().map((item) => item.policy), ["quiet"]);
});

test("one window reminds at most once", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	h.changeScreen();
	await h.turn();
	await h.turn();
	assert.equal(h.reminders.length, 1);
	assert.equal(h.finals().length, 1, "the reminded episode closes at the next turn end");
});

test("a posted final starts a new window, so a later request through an extension is checked on its own", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	h.changeScreen();
	h.postBoard();
	await h.turn();
	assert.deepEqual(h.reminders, []);
	assert.equal(h.finals().length, 1);

	// A Discord request arrives as an extension input: no owner input, but the final already started a new window.
	h.capture.onInput({ source: "extension", text: "버튼도 바꿔줘" }, null);
	await h.advance(1000);
	h.changeScreen();
	await h.turn();
	assert.deepEqual(h.reminders, [REVIEW_REMINDER_TEXT], "the board belongs to the earlier window");
});

test("a new owner input starts a new window", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	h.changeScreen();
	await h.turn();
	await h.turn();
	assert.equal(h.reminders.length, 1);

	h.input("이번에는 설명만 해줘");
	await h.turn();
	assert.equal(h.reminders.length, 1, "nothing changed since the new window started");

	h.input("다시 화면을 고쳐줘");
	h.changeScreen();
	await h.turn();
	assert.equal(h.reminders.length, 2);
});

test("an extension input keeps the window, a phone request starts a new one", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	h.postBoard();
	h.capture.onInput({ source: "extension", text: "background task finished" }, null);
	await h.advance(1000);
	h.changeScreen();
	await h.turn();
	assert.deepEqual(h.reminders, [], "the board posted before the job wake still counts");

	h.capture.markOwner("phone");
	h.capture.onInput({ source: "extension", text: "버튼만 바꿔줘" }, null);
	h.changeScreen();
	await h.turn();
	assert.equal(h.reminders.length, 1);
});
