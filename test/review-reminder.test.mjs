// Report reminder tests (README "Report reminder").
// Run: node --test test/review-reminder.test.mjs
// Fake clock, fake timers, fake post: nothing here waits on wall-clock time.
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
	const state = { t: START_AT, stamp: 5000 };
	const timers = new Set();
	const posts = [];
	const logs = [];
	const reminders = [];
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
	const finals = () => posts.filter((entry) => entry.path.endsWith("/items") && entry.body.kind !== "progress").map((entry) => entry.body);
	const starts = () => posts.filter((entry) => entry.path.endsWith("/activity") && entry.body.source === "agent-start").map((entry) => entry.body);
	return { capture, reminders, logs, finals, starts, turn, input };
}

const SCREENSHOT_TOOL = { name: "eval", args: { code: "await page.screenshot()" }, result: { content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] } };
const SUBMIT_TOOL = { name: "bash", args: { command: "node bin/inbox.mjs submit board.json" }, result: { content: [{ type: "text", text: "submitted" }] } };

test("a screenshot with no board reminds once and holds the final until the next turn end", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	await h.turn({ tools: [SCREENSHOT_TOOL] });

	assert.deepEqual(h.reminders, [REVIEW_REMINDER_TEXT]);
	assert.ok(h.logs.includes("capture: review reminder"));
	assert.deepEqual(h.finals(), [], "no final on the reminded turn end");

	await h.turn();
	assert.equal(h.reminders.length, 1);
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
	assert.match(h.finals()[0].dedupeKey, /^episode:/);
	assert.deepEqual(h.starts().map((start) => [start.cause, start.opened]), [["owner", true], ["system", false]], "the reminded turn continues the episode");
});

test("an edit of a visual file counts, a plain source edit does not", async () => {
	const visual = makeHarness();
	visual.input("버튼 색을 바꿔줘");
	await visual.turn({ tools: [{ name: "edit", args: { path: "C:/app/src/templates/page.txt" } }] });
	assert.equal(visual.reminders.length, 1);

	const plain = makeHarness();
	plain.input("로직을 고쳐줘");
	await plain.turn({ tools: [{ name: "edit", args: { path: "C:/app/src/logic.ts" } }] });
	assert.deepEqual(plain.reminders, []);
	assert.deepEqual(plain.finals().map((item) => item.kind), ["turn"]);
});

test("a tool that only mentions screenshots in text does not remind", async () => {
	const h = makeHarness();
	h.input("디스크 정리안을 알려줘");
	await h.turn({
		tools: [
			{ name: "eval", args: { code: "send('이전 회차는 스크린샷·영상만 지우기')" }, result: { content: [{ type: "text", text: "sent" }] } },
			{ name: "bash", args: { command: "du -sh evidence" }, result: { content: [{ type: "text", text: "8.6G evidence/screenshots" }] } },
		],
	});
	assert.deepEqual(h.reminders, []);
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
});

test("a submit command in the window means no reminder", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	await h.turn({ tools: [SCREENSHOT_TOOL, SUBMIT_TOOL] });
	assert.deepEqual(h.reminders, []);
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
});

test("an input that says Review 생략 means no reminder", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘, Review 생략");
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	assert.deepEqual(h.reminders, []);
	assert.deepEqual(h.finals().map((item) => item.kind), ["turn"]);
});

test("a user abort closes quietly without a reminder", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	await h.turn({ tools: [SCREENSHOT_TOOL], aborted: true, abortSource: "user" });
	assert.deepEqual(h.reminders, []);
	assert.deepEqual(h.finals().map((item) => item.policy), ["quiet"]);
});

test("one window reminds at most once", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	assert.equal(h.reminders.length, 1);
	assert.equal(h.finals().length, 2, "the second and third turn ends close as usual");
});

test("a new input starts a new window", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	await h.turn();
	assert.equal(h.reminders.length, 1);

	h.input("이번에는 설명만 해줘");
	await h.turn();
	assert.equal(h.reminders.length, 1, "the new window has no visual work yet");

	h.input("다시 화면을 고쳐줘");
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	assert.equal(h.reminders.length, 2);
});

test("an extension input keeps the window, a phone request starts a new one", async () => {
	const h = makeHarness();
	h.input("결제 화면을 고쳐줘");
	await h.turn({ tools: [SCREENSHOT_TOOL, SUBMIT_TOOL] });
	h.capture.onInput({ source: "extension", text: "background task finished" }, null);
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	assert.deepEqual(h.reminders, [], "the board submitted before the job wake still counts");

	h.capture.markOwner("phone");
	h.capture.onInput({ source: "extension", text: "버튼만 바꿔줘" }, null);
	await h.turn({ tools: [SCREENSHOT_TOOL] });
	assert.equal(h.reminders.length, 1);
});
