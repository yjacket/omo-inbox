import { test } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../extension/inbox/bridge.ts";

const QUESTION_SYMBOL = Symbol.for("omo-inbox.question-bridge");

/** A signal-like object that counts live "abort" listeners so leaks are observable. */
class CountingSignal {
	aborted = false;
	reason = undefined;
	listeners = new Set();
	addEventListener(type, fn, options) {
		if (type === "abort") this.listeners.add({ fn, once: Boolean(options?.once) });
	}
	removeEventListener(type, fn) {
		if (type !== "abort") return;
		for (const l of [...this.listeners]) if (l.fn === fn) this.listeners.delete(l);
	}
	abort(reason) {
		this.aborted = true;
		this.reason = reason;
		for (const l of [...this.listeners]) {
			if (l.once) this.listeners.delete(l);
			l.fn();
		}
	}
}

function cancelled(request) {
	return { status: "cancelled", answers: {}, unanswered: request.questions.map((q) => q.id) };
}

/** Fake ctx.ui: question/select stay pending until the test resolves the recorded call or the signal aborts. */
function makeUi() {
	const questionCalls = [];
	const selectCalls = [];
	const inputCalls = [];
	const ui = {
		questionCalls,
		selectCalls,
		inputCalls,
		question(request, opts) {
			return new Promise((resolve) => {
				const call = { request, opts, resolve, self: this };
				questionCalls.push(call);
				opts.signal.addEventListener("abort", () => resolve(cancelled(request)), { once: true });
			});
		},
		select(title, options, opts) {
			return new Promise((resolve) => {
				const call = { title, options, opts, resolve };
				selectCalls.push(call);
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		},
		input(title, placeholder, opts) {
			inputCalls.push({ title, placeholder, opts });
			return Promise.resolve("from-terminal");
		},
	};
	return ui;
}

function makeRequest(id, questions) {
	return {
		requestId: id,
		waitForAnswer: true,
		required: false,
		timeoutMs: 1800000,
		questions: questions ?? [
			{ id: "q1", header: "고르기", question: "어느 쪽?", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] },
		],
	};
}

const tui = (ui) => ({ mode: "tui", ui });

test("remote wins: local signal aborted with omo-inbox, response shape exact", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	assert.equal(bridge.install(tui(ui)), "installed");
	const outer = new AbortController();
	const request = makeRequest("r1");
	const answer = ui.question(request, { signal: outer.signal });
	const call = ui.questionCalls[0];
	assert.equal(bridge.hasQuestion("r1"), true);
	assert.equal(bridge.bridgeState("r1"), "live");

	assert.equal(bridge.resolveQuestion("r1", { answers: { q1: { selected: ["B"] } } }), "resolved");
	const response = await answer;
	assert.deepEqual(response, {
		status: "answered",
		resolvedBy: "omo_inbox",
		answers: { q1: { selected: ["B"] } },
		unanswered: [],
	});
	assert.equal(bridge.resolvedByMarker, "omo_inbox");
	assert.equal(call.opts.signal.aborted, true);
	assert.equal(call.opts.signal.reason, "omo-inbox");
	assert.equal(outer.signal.aborted, false);
	assert.equal(call.self, ui);
	// A second phone answer loses.
	assert.equal(bridge.resolveQuestion("r1", { answers: { q1: { selected: ["A"] } } }), "already-settled");
});

test("local wins: terminal response returned verbatim and later phone answers are already-settled", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const request = makeRequest("r2");
	const answer = ui.question(request, { signal: new AbortController().signal });
	const terminal = { status: "answered", answers: { q1: { selected: ["A"] } }, unanswered: [] };
	ui.questionCalls[0].resolve(terminal);
	assert.equal(await answer, terminal);
	assert.equal(bridge.resolveQuestion("r2", { answers: { q1: { selected: ["B"] } } }), "already-settled");
	assert.equal(bridge.bridgeState("r2"), "none");
});

test("after a timeout resolveQuestion returns no-wait", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const answer = ui.question(makeRequest("r3"), { signal: new AbortController().signal });
	ui.questionCalls[0].resolve({ status: "timed_out", answers: {}, unanswered: ["q1"], autoResolvedAfterMs: 1800000 });
	assert.equal((await answer).status, "timed_out");
	assert.equal(bridge.resolveQuestion("r3", { answers: { q1: { selected: ["A"] } } }), "no-wait");
});

test("unknown id: nothing resolved and nothing recorded", () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	assert.equal(bridge.resolveQuestion("nope", { answers: { q1: { selected: ["A"] } } }), "no-wait");
	assert.equal(bridge.hasQuestion("nope"), false);
	assert.equal(ui.questionCalls.length, 0);
});

test("double install is already; uninstall restores the original", () => {
	const bridge = createBridge();
	const ui = makeUi();
	const original = ui.question;
	const originalSelect = ui.select;
	assert.equal(bridge.install(tui(ui)), "installed");
	assert.notEqual(ui.question, original);
	const wrapper = ui.question;
	assert.equal(bridge.install(tui(ui)), "already");
	assert.equal(ui.question, wrapper);
	bridge.uninstall(tui(ui));
	assert.equal(ui.question, original);
	assert.equal(ui.select, originalSelect);
});

test("uninstall leaves a foreign replacement alone", () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const foreign = () => Promise.resolve();
	ui.question = foreign;
	bridge.uninstall(tui(ui));
	assert.equal(ui.question, foreign);
});

test("unavailable without a question function or outside tui mode", () => {
	const bridge = createBridge();
	assert.equal(bridge.install({ mode: "tui", ui: { notify() {} } }), "unavailable");
	assert.equal(bridge.bridgeState("x"), "none");
	for (const mode of ["print", "json", "rpc", undefined]) {
		const ui = makeUi();
		const original = ui.question;
		assert.equal(bridge.install({ mode, ui }), "unavailable");
		assert.equal(ui.question, original);
	}
	assert.equal(bridge.install({ mode: "tui" }), "unavailable");
});

test("INBOX_BRIDGE=off wraps nothing and reports no bridge", () => {
	const ui = makeUi();
	const original = ui.question;
	const bridge = createBridge({ env: { INBOX_BRIDGE: "off" } });
	assert.equal(bridge.install(tui(ui)), "unavailable");
	assert.equal(ui.question, original);
	assert.equal(bridge.bridgeState("r1"), "none");
});

test("frozen ui is unavailable", () => {
	const ui = Object.freeze(makeUi());
	assert.equal(createBridge().install(tui(ui)), "unavailable");
});

test("multiSelect labels and free text are kept; unanswered ids listed", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const request = makeRequest("r4", [
		{ id: "q1", header: "여러 개", question: "?", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
		{ id: "q2", header: "직접", question: "?", multiSelect: false, options: [{ label: "X" }] },
		{ id: "q3", header: "비움", question: "?", multiSelect: false, options: [{ label: "Y" }] },
	]);
	const answer = ui.question(request, { signal: new AbortController().signal });
	bridge.resolveQuestion("r4", { answers: { q1: { selected: ["A", "C"] }, q2: { selected: [], text: "직접 쓴 답" }, q3: { selected: [] } } });
	assert.deepEqual(await answer, {
		status: "answered",
		resolvedBy: "omo_inbox",
		answers: { q1: { selected: ["A", "C"] }, q2: { selected: [], text: "직접 쓴 답" } },
		unanswered: ["q3"],
	});
});

test("a non-blank comment gives comment-submitted; an empty payload is question_incomplete", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const answer = ui.question(makeRequest("r5"), { signal: new AbortController().signal });
	assert.throws(() => bridge.resolveQuestion("r5", { answers: {}, comment: "   " }), /question_incomplete/);
	assert.equal(bridge.bridgeState("r5"), "live");
	assert.equal(bridge.resolveQuestion("r5", { answers: {}, comment: "그냥 진행해" }), "resolved");
	assert.deepEqual(await answer, {
		status: "comment-submitted",
		resolvedBy: "omo_inbox",
		answers: {},
		comment: "그냥 진행해",
		unanswered: ["q1"],
	});
});

test("permission allow once resolves the dialog and aborts the terminal select", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	const originalSelect = ui.select;
	bridge.install(tui(ui));
	bridge.setRunInFlight(true);
	const opened = [];
	const closed = [];
	bridge.onDialog((d) => opened.push(d));
	bridge.onDialogClosed((d) => closed.push(d));
	const options = ["Allow once", "Allow always", "Deny", "Deny with feedback"];
	const picked = ui.select("Permission required: bash\n\nCommand: $ ls", options, { toolCallId: "t1" });
	assert.equal(opened.length, 1);
	assert.deepEqual(opened[0].options, options);
	assert.equal(bridge.resolvePermission("missing", "Allow once"), false);
	assert.equal(bridge.resolvePermission(opened[0].id, "Allow forever"), false);
	assert.equal(bridge.resolvePermission(opened[0].id, "once"), true);
	assert.equal(await picked, "Allow once");
	assert.equal(ui.selectCalls[0].opts.signal.aborted, true);
	assert.equal(ui.selectCalls[0].opts.toolCallId, "t1");
	assert.equal(bridge.resolvePermission(opened[0].id, "Allow once"), false);
	assert.equal(closed[0].by, "phone");
	bridge.uninstall(tui(ui));
	assert.equal(ui.select, originalSelect);
});

test("permission deny with feedback answers the next ui.input from staged text, then unwraps it", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	const originalInput = ui.input;
	bridge.install(tui(ui));
	bridge.setRunInFlight(true);
	const opened = [];
	bridge.onDialog((d) => opened.push(d));
	const picked = ui.select("Permission required: edit", ["Allow once", "Allow always", "Deny", "Deny with feedback"], {});
	assert.equal(bridge.resolvePermission(opened[0].id, "Deny with feedback", "범위가 너무 넓어요"), true);
	assert.equal(await picked, "Deny with feedback");
	// What the permission prompt does right after.
	assert.equal(await ui.input("Feedback", "Why are you denying this permission? (optional)", {}), "범위가 너무 넓어요");
	assert.equal(ui.inputCalls.length, 0);
	assert.equal(ui.input, originalInput);
	assert.equal(await ui.input("Feedback", "again", {}), "from-terminal");
});

test("terminal winning a permission dialog leaves nothing staged", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	bridge.setRunInFlight(true);
	const closed = [];
	bridge.onDialogClosed((d) => closed.push(d));
	const picked = ui.select("Permission required: bash", ["Allow once", "Deny"], {});
	ui.selectCalls[0].resolve("Deny");
	assert.equal(await picked, "Deny");
	assert.equal(closed[0].by, "terminal");
});

test("no permission wrapping when no run is in flight or the title differs", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const opened = [];
	bridge.onDialog((d) => opened.push(d));
	const idleOpts = {};
	const idle = ui.select("Permission required: bash", ["Allow once", "Deny"], idleOpts);
	ui.selectCalls[0].resolve("Allow once");
	assert.equal(await idle, "Allow once");
	bridge.setRunInFlight(true);
	const other = ui.select("Pick a model", ["a", "b"], {});
	ui.selectCalls[1].resolve("b");
	assert.equal(await other, "b");
	assert.equal(opened.length, 0);
	// Passthrough keeps the caller's own options untouched.
	assert.equal(ui.selectCalls[0].opts, idleOpts);
});

test("no listener leak on the outer signal after 1000 races", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const outer = new CountingSignal();
	for (let i = 0; i < 1000; i += 1) {
		const id = `leak-${i}`;
		const answer = ui.question(makeRequest(id), { signal: outer });
		const call = ui.questionCalls.at(-1);
		if (i % 2 === 0) {
			assert.equal(bridge.resolveQuestion(id, { answers: { q1: { selected: ["A"] } } }), "resolved");
		} else {
			call.resolve({ status: "answered", answers: { q1: { selected: ["B"] } }, unanswered: [] });
		}
		await answer;
		assert.equal(outer.listeners.size, 0, `listeners after race ${i}`);
	}
	assert.equal(outer.listeners.size, 0);
});

test("install inside a synchronous ask-user:asked listener is in place when attach reads ui.question", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	const original = ui.question;
	const ctx = tui(ui);
	const listeners = [];
	const events = { on: (name, fn) => listeners.push([name, fn]), emit: (name, e) => listeners.filter(([n]) => n === name).forEach(([, fn]) => fn(e)) };
	events.on("ask-user:asked", ({ request }) => {
		assert.equal(bridge.install(ctx), "installed");
		assert.equal(bridge.hasQuestion(request.requestId), false);
	});
	// ask-user's startQuestion: emit first, then attach re-reads ctx.ui.question.
	const request = makeRequest("r6");
	events.emit("ask-user:asked", { request });
	const currentQuestion = ctx.ui.question;
	assert.notEqual(currentQuestion, original);
	const answer = currentQuestion.call(ctx.ui, request, { signal: new AbortController().signal });
	assert.equal(bridge.hasQuestion("r6"), true);
	assert.equal(bridge.resolveQuestion("r6", { answers: { q1: { selected: ["A"] } } }), "resolved");
	assert.equal((await answer).resolvedBy, "omo_inbox");
});

test("outer reload abort detaches the wait; reattach makes it live again", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const request = makeRequest("r7");
	const first = new AbortController();
	const answer = ui.question(request, { signal: first.signal });
	first.abort("reload");
	assert.equal(bridge.bridgeState("r7"), "detached");
	assert.equal((await answer).status, "cancelled");
	// Settling the cancelled terminal must not erase the detached state.
	assert.equal(bridge.bridgeState("r7"), "detached");
	assert.equal(bridge.resolveQuestion("r7", { answers: { q1: { selected: ["A"] } } }), "no-wait");

	const second = ui.question(request, { signal: new AbortController().signal });
	assert.equal(bridge.bridgeState("r7"), "live");
	assert.equal(bridge.resolveQuestion("r7", { answers: { q1: { selected: ["A"] } } }), "resolved");
	assert.equal((await second).resolvedBy, "omo_inbox");
});

test("any other outer abort ends the wait", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const outer = new AbortController();
	const answer = ui.question(makeRequest("r8"), { signal: outer.signal });
	outer.abort("user-cancel");
	assert.equal((await answer).status, "cancelled");
	assert.equal(bridge.resolveQuestion("r8", { answers: { q1: { selected: ["A"] } } }), "no-wait");
	bridge.noteClosed("r8", "cancelled", undefined);
	assert.equal(bridge.bridgeState("r8"), "none");
});

test("noteClosed keeps the first outcome and drops detached waits", async () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const outer = new AbortController();
	void ui.question(makeRequest("r9"), { signal: outer.signal });
	outer.abort("reload");
	assert.equal(bridge.bridgeState("r9"), "detached");
	bridge.noteClosed("r9", "answered", { status: "answered" });
	assert.equal(bridge.bridgeState("r9"), "none");
	assert.equal(bridge.resolveQuestion("r9", { answers: { q1: { selected: ["A"] } } }), "already-settled");
	bridge.noteClosed("r9", "timed_out");
	assert.equal(bridge.resolveQuestion("r9", { answers: { q1: { selected: ["A"] } } }), "already-settled");
});

test("a question with no wait after install is terminal-only", () => {
	const bridge = createBridge();
	bridge.install(tui(makeUi()));
	assert.equal(bridge.bridgeState("asked-before-reload"), "terminal-only");
});

test("an older-generation wrapper is unwrapped, never chained", async () => {
	const ui = makeUi();
	const original = ui.question;
	const older = createBridge();
	const newer = createBridge();
	assert.equal(older.install(tui(ui)), "installed");
	const olderWrapper = ui.question;
	assert.equal(newer.install(tui(ui)), "installed");
	assert.notEqual(ui.question, olderWrapper);
	assert.equal(ui.question[QUESTION_SYMBOL].original, original);
	// The older bridge must not claim or undo the newer wrapper.
	assert.equal(older.install(tui(ui)), "already");
	older.uninstall(tui(ui));
	assert.notEqual(ui.question, original);

	const answer = ui.question(makeRequest("r10"), { signal: new AbortController().signal });
	assert.equal(ui.questionCalls.length, 1);
	assert.equal(older.hasQuestion("r10"), false);
	assert.equal(newer.hasQuestion("r10"), true);
	newer.resolveQuestion("r10", { answers: { q1: { selected: ["A"] } } });
	await answer;
	newer.uninstall(tui(ui));
	assert.equal(ui.question, original);
});

test("progress callbacks reach the original question function", () => {
	const bridge = createBridge();
	const ui = makeUi();
	bridge.install(tui(ui));
	const onProgress = () => {};
	void ui.question(makeRequest("r11"), { signal: new AbortController().signal, onProgress, deliver: "tool-result", timeout: 5 });
	assert.equal(ui.questionCalls[0].opts.onProgress, onProgress);
	assert.equal(ui.questionCalls[0].opts.deliver, "tool-result");
	assert.equal(ui.questionCalls[0].opts.timeout, 5);
});
