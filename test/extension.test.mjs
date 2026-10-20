// Fake-pi harness for the omo-inbox extension: no senpi, no server, no wall clock.
// Run: node --test test/extension.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInbox } from "../extension/inbox/core.ts";
import { safeSegment } from "../extension/inbox/util.ts";
import { safeSegment as pathsSafeSegment } from "../src/paths.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

const SESSION = "s-1";
const INBOX_FILE = "261004-abcd-000003.json";
const PAYLOAD = {
	v: 1,
	proposalId: "261004-abcd",
	seq: 3,
	title: "결제 화면",
	url: "http://127.0.0.1:4387/p/261004-abcd",
	approved: false,
	text: "[omo-inbox] 의견이 왔습니다: 결제 화면 (261004-abcd, 1안, #3)",
};

function fakePi() {
	const handlers = new Map();
	const sent = [];
	const emitted = [];
	return {
		pi: {
			on(event, handler) {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event).push(handler);
			},
			sendMessage(message, opts) {
				sent.push({ message, opts });
			},
			events: {
				emit(channel, data) {
					emitted.push({ channel, data });
				},
			},
		},
		handlers,
		sent,
		emitted,
		async emit(event, ctx) {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		},
	};
}

function fakeCtx({ sessionId = SESSION, cwd = "C:/work/proj", hasUI = true, askUser } = {}) {
	const statuses = [];
	const ctx = {
		cwd,
		hasUI,
		ui: { setStatus: (key, text) => statuses.push([key, text]) },
		sessionManager: { getSessionId: () => sessionId },
	};
	if (askUser) {
		ctx.getAskUserSettings = () => askUser;
	}
	return { ctx, statuses };
}

function setup({ env = {}, sessionId = SESSION, hasUI = true, cwd, piCwd, here, proposal, proposalStatus = 200, fetchThrows = false, fsOverrides = {}, spawn: spawnOverride, askUser, abortAfter } = {}) {
	const tmp = makeTmpHome();
	const fp = fakePi();
	if (piCwd !== undefined) fp.pi.cwd = piCwd;
	const { ctx, statuses } = fakeCtx({ sessionId, hasUI, cwd, askUser });
	const timers = [];
	const spawned = [];
	const fetchCalls = [];
	const state = {
		here: here ?? { footer: "", notice: null, noticeKeys: [] },
		proposal: proposal ?? { summary: { status: "theirs" } },
	};
	let clock = 1_750_000_000_000;
	const fsImpl = { ...fsp, ...fsOverrides };
	const fetchImpl = async (url, opts = {}) => {
		fetchCalls.push({ url: String(url), opts });
		if (fetchThrows) throw new Error("connect ECONNREFUSED 127.0.0.1:4387");
		const parsed = new URL(String(url));
		if (parsed.pathname === "/api/here") {
			const body = typeof state.here === "function" ? state.here(parsed, opts) : state.here;
			return { ok: true, status: 200, json: async () => await body };
		}
		if (parsed.pathname.startsWith("/api/p/")) {
			const body = typeof state.proposal === "function" ? state.proposal(parsed) : state.proposal;
			return { ok: proposalStatus >= 200 && proposalStatus < 300, status: proposalStatus, json: async () => body };
		}
		return { ok: true, status: 200, json: async () => ({ ok: true }) };
	};
	const handle = createInbox(fp.pi, {
		env: { OMO_INBOX_HOME: tmp.home, ...env },
		home: tmp.home,
		now: () => clock,
		timer: {
			setInterval: (fn, ms) => {
				const id = { fn, ms };
				timers.push(id);
				return id;
			},
			clearInterval: (id) => {
				const at = timers.indexOf(id);
				if (at >= 0) timers.splice(at, 1);
			},
		},
		fetch: fetchImpl,
		abortAfter,
		fs: fsImpl,
		spawn:
			spawnOverride ??
			((cmd, args, opts) => {
				spawned.push({ cmd, args, opts });
				return { unref() {} };
			}),
	});
	return {
		home: tmp.home,
		handle,
		pi: fp,
		ctx,
		statuses,
		timers,
		spawned,
		fetchCalls,
		state,
		inboxDir: path.join(tmp.home, "mailbox", sessionId),
		writeInbox(name = INBOX_FILE, payload = PAYLOAD) {
			mkdirSync(path.join(tmp.home, "mailbox", sessionId), { recursive: true });
			writeFileSync(path.join(tmp.home, "mailbox", sessionId, name), JSON.stringify(payload));
		},
		async tick(ms) {
			for (const timer of timers.filter((entry) => entry.ms === ms)) await timer.fn();
		},
		advance(ms) {
			clock += ms;
			return clock;
		},
		cleanup() {
			try {
				handle?.stop?.();
			} catch {
				// already stopped
			}
			tmp.cleanup();
		},
	};
}

test("omo-task child sessions are inert: null, no handlers", () => {
	for (const key of ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"]) {
		const tmp = makeTmpHome();
		const fp = fakePi();
		const handle = createInbox(fp.pi, { env: { [key]: "1" }, home: tmp.home });
		assert.equal(handle, null, key);
		assert.equal(fp.handlers.size, 0, key);
		tmp.cleanup();
	}
	const tmp = makeTmpHome();
	const empty = createInbox(fakePi().pi, { env: { OMO_SENPI_TASK_RPC_CHILD: "" }, home: tmp.home });
	assert.notEqual(empty, null, "an empty value is not a child session");
	empty.stop();
	tmp.cleanup();
});

test("createInbox returns null and registers nothing in a task-RPC child session", () => {
	const tmp = makeTmpHome();
	const fp = fakePi();
	const handle = createInbox(fp.pi, { env: { OMO_SENPI_TASK_RPC_CHILD: "1" }, home: tmp.home });
	assert.equal(handle, null, "a child session is inert");
	assert.equal(fp.handlers.size, 0, "no handler is registered");
	tmp.cleanup();
});

test("session_start registers the 3 s/30 s timers and asks /api/here with start=1", async () => {
	const s = setup({ here: { footer: "🙋 1", notice: null, noticeKeys: [] } });
	assert.equal(s.timers.length, 0);
	await s.pi.emit("session_start", s.ctx);
	assert.deepEqual(
		s.timers.map((timer) => timer.ms).sort((a, b) => a - b),
		[3000, 30000],
	);
	const hereReads = () => s.fetchCalls.filter((call) => call.url.includes("/api/here"));
	assert.equal(hereReads().length, 1);
	assert.match(hereReads()[0].url, /\/api\/here\?cwd=C%3A%2Fwork%2Fproj&session=s-1&start=1&idle=0$/);
	assert.deepEqual(s.statuses.at(-1), ["omo-inbox", "🙋 1"]);
	await s.tick(30000);
	assert.equal(hereReads().length, 2);
	assert.doesNotMatch(hereReads()[1].url, /start=1/, "later ticks are not a session start");
	s.cleanup();
});

test("tool_execution_end refreshes /api/here once after session_start", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	await s.pi.emit("tool_execution_end", s.ctx);
	const hereReads = s.fetchCalls.filter((call) => call.url.includes("/api/here"));
	assert.equal(hereReads.length, 2);
	assert.match(hereReads[0].url, /start=1&idle=0$/);
	assert.doesNotMatch(hereReads[1].url, /start=1/);
	assert.equal(hereReads[1].opts.signal instanceof AbortSignal, true);
	s.cleanup();
});

test("overlapping tool refreshes coalesce into one rerun awaited by every handler", async () => {
	let release;
	let releaseSecond;
	let startedFirst;
	let startedSecond;
	const firstStarted = new Promise((resolve) => { startedFirst = resolve; });
	const secondStarted = new Promise((resolve) => { startedSecond = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
	let hereCalls = 0;
	const s = setup({
		here: (_parsed) => {
			hereCalls += 1;
			if (hereCalls === 2) {
				startedFirst();
				return gate.then(() => ({ footer: "", waiting: [] }));
			}
			if (hereCalls === 3) {
				startedSecond();
				return secondGate.then(() => ({ footer: "", waiting: [{ id: "fresh", title: "Fresh", status: "theirs", seq: 2 }] }));
			}
			return { footer: "", waiting: [] };
		},
	});
	await s.pi.emit("session_start", s.ctx);
	let settled = 0;
	const handlers = [s.pi.emit("tool_execution_end", s.ctx), s.pi.emit("tool_execution_end", s.ctx), s.pi.emit("tool_execution_end", s.ctx)]
		.map((promise) => promise.then(() => { settled += 1; }));
	await firstStarted;
	assert.equal(hereCalls, 2, "only the first refresh is running");
	assert.equal(settled, 0, "all tool handlers remain pending while refresh is held");
	release();
	await secondStarted;
	assert.equal(hereCalls, 3, "one coalesced rerun follows the held refresh");
	assert.equal(settled, 0, "tool handlers remain pending until the rerun completes");
	releaseSecond();
	await Promise.all(handlers);
	assert.equal(settled, 3);
	assert.ok(s.pi.emitted.some((event) => event.channel === "wake_source_state" && event.data.activeCount === 1), "the rerun includes the board added between fetches");
	assert.equal(hereCalls, 3, "the burst produced exactly two additional fetches");
	s.cleanup();
});

test("session_start during a held refresh carries start=1 into the rerun", async () => {
	let release;
	let started;
	const startedFirst = new Promise((resolve) => { started = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	let hereCalls = 0;
	const s = setup({
		here: (_parsed, opts) => {
			hereCalls += 1;
			if (hereCalls === 2) {
				started();
				return gate.then(() => ({ footer: "", waiting: [] }));
			}
			return { footer: "", waiting: [] };
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const firstRefresh = s.handle.status(false);
	await startedFirst;
	const startingSession = s.pi.emit("session_start", s.ctx);
	release();
	await Promise.all([firstRefresh, startingSession]);
	assert.equal(hereCalls, 3);
	// The C8 reload listing (todo 32) is a separate GET; only the /api/here reads are ordered here.
	const hereReads = s.fetchCalls.filter((call) => call.url.includes("/api/here"));
	assert.match(hereReads[1].url, /\/api\/here\?.*session=s-1&idle=0$/);
	assert.match(hereReads[2].url, /\/api\/here\?.*session=s-1&start=1&idle=0$/);
	s.cleanup();
});

test("a tool refresh that joins a held timer refresh reruns with the short tool timeout", async () => {
	let release;
	let started;
	const startedFirst = new Promise((resolve) => { started = resolve; });
	const gate = new Promise((resolve) => { release = resolve; });
	const timeouts = [];
	let hereCalls = 0;
	const s = setup({
		abortAfter: (ms) => {
			timeouts.push(ms);
			return new AbortController().signal;
		},
		here: () => {
			hereCalls += 1;
			if (hereCalls === 2) {
				started();
				return gate.then(() => ({ footer: "", waiting: [] }));
			}
			return { footer: "", waiting: [] };
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const timerRefresh = s.handle.status(false);
	await startedFirst;
	const toolRefresh = s.pi.emit("tool_execution_end", s.ctx);
	release();
	await Promise.all([timerRefresh, toolRefresh]);
	assert.equal(hereCalls, 3);
	assert.deepEqual(timeouts, [1500, 5000, 1500], "session_start uses the hook bound; the timer and tool refresh keep theirs");
	s.cleanup();
});

test("tool_execution_end resolves when its injected abort signal fires", async () => {
	let signalReady;
	const ready = new Promise((resolve) => { signalReady = resolve; });
	const controller = new AbortController();
	let hereCalls = 0;
	const s = setup({
		abortAfter: (ms) => {
			return ms === 1500 ? controller.signal : AbortSignal.timeout(ms);
		},
		here: (_parsed, opts) => {
			hereCalls += 1;
			if (hereCalls === 1) return { footer: "", waiting: [] };
			return new Promise((_resolve, reject) => {
			signalReady();
			if (opts.signal.aborted) {
				reject(new DOMException("aborted", "AbortError"));
				return;
			}
			opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
			});
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const pending = s.pi.emit("tool_execution_end", s.ctx);
	await ready;
	controller.abort();
	await assert.doesNotReject(() => pending);
	s.cleanup();
});

test("a payload whose proposal is theirs is delivered once as a followUp and the file is removed", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.customType, "omo-inbox");
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.deepEqual(s.pi.sent[0].message.details, { proposalId: PAYLOAD.proposalId, seq: PAYLOAD.seq });
	assert.deepEqual(s.pi.sent[0].opts, { deliverAs: "followUp", triggerTurn: true });
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	assert.ok(
		s.fetchCalls.some((call) => call.url.endsWith(`/api/p/${PAYLOAD.proposalId}?since=${PAYLOAD.seq}`)),
		"the payload is confirmed against the proposal before delivery",
	);
	assert.ok(s.fetchCalls.some((call) => call.url.includes("/api/here")), "a delivery refreshes the status");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "the empty inbox delivers nothing more");
	s.cleanup();
});

test("a payload the server calls mine is dropped without a message", async () => {
	const s = setup({ proposal: { summary: { status: "mine" } } });
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 0);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	s.cleanup();
});

const flush = () => new Promise(setImmediate);

test("two overlapping inbox ticks deliver the payload once", async () => {
	let started = 0;
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const s = setup({
		fsOverrides: {
			readdir: async () => [INBOX_FILE],
			readFile: async () => JSON.stringify(PAYLOAD),
		},
	});
	s.state.proposal = () => {
		started += 1;
		return gate.then(() => ({ summary: { status: "theirs" } }));
	};
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	const first = s.handle.inbox();
	await flush();
	const second = s.handle.inbox();
	await flush();
	assert.equal(started, 1, "the second tick is skipped while the first one runs");
	release();
	await Promise.all([first, second]);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	s.cleanup();
});

test("a 500 from the proposal check delivers the feedback once and removes the file", async () => {
	const s = setup({ proposalStatus: 500 });
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false, "the file is not kept: the delivery was made");
	const check = s.fetchCalls.find((call) => call.url.includes("/api/p/"));
	assert.ok(check.opts.signal instanceof AbortSignal, "every proposal fetch is bounded by a timeout");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "the delivered set prevents a second delivery");
	s.cleanup();
});

test("a spawn 'error' is logged, never thrown into senpi", async () => {
	let onError;
	let seen;
	const logged = new Promise((resolve) => {
		seen = resolve;
	});
	const s = setup({
		fetchThrows: true,
		spawn: () => ({
			unref() {},
			on(event, handler) {
				if (event === "error") onError = handler;
			},
		}),
		fsOverrides: {
			appendFile: async (file, text) => {
				await fsp.appendFile(file, text);
				if (String(text).includes("ensure:")) seen();
			},
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(typeof onError, "function", "the spawn gets an error listener");
	assert.doesNotThrow(() => onError(new Error("spawn node ENOENT")));
	await logged;
	assert.match(readFileSync(path.join(s.home, "logs", "extension.log"), "utf8"), /ensure: spawn node ENOENT/);
	s.cleanup();
});

test("a failed proposal fetch still delivers rather than lose the feedback", async () => {
	const s = setup({ fetchThrows: true });
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.content, PAYLOAD.text);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	s.cleanup();
});

test("a failed delete is retried next tick without a second delivery", async () => {
	let rmCalls = 0;
	const s = setup({
		fsOverrides: {
			rm: async (file, opts) => {
				rmCalls += 1;
				if (rmCalls === 1) throw new Error("EBUSY: locked");
				return fsp.rm(file, opts);
			},
		},
	});
	await s.pi.emit("session_start", s.ctx);
	s.writeInbox();
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), true, "the delete failed, the file stays");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "the delivered set prevents a second delivery");
	assert.equal(existsSync(path.join(s.inboxDir, INBOX_FILE)), false);
	assert.match(readFileSync(path.join(s.home, "logs", "extension.log"), "utf8"), /cannot delete/);
	s.cleanup();
});

test("an unparsable inbox file is deleted and logged", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	mkdirSync(s.inboxDir, { recursive: true });
	writeFileSync(path.join(s.inboxDir, "broken.json"), "{ this is not json");
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 0);
	assert.equal(existsSync(path.join(s.inboxDir, "broken.json")), false);
	assert.match(readFileSync(path.join(s.home, "logs", "extension.log"), "utf8"), /unparsable/);
	s.cleanup();
});

test("an unreachable server shows Inbox 서버 꺼짐 and starts the CLI at most once per 120 s", async () => {
	const s = setup({ fetchThrows: true });
	await s.pi.emit("session_start", s.ctx);
	assert.deepEqual(s.statuses.at(-1), ["omo-inbox", "Inbox 서버 꺼짐"]);
	assert.equal(s.spawned.length, 1);
	const [spawned] = s.spawned;
	assert.match(path.basename(spawned.cmd), /^node(\.exe)?$/i);
	assert.match(spawned.args[0], /app[\\/]bin[\\/]inbox\.mjs$/);
	assert.deepEqual(spawned.args.slice(1), ["server", "start"]);
	assert.deepEqual(spawned.opts, { detached: true, stdio: "ignore", windowsHide: true });
	await s.tick(30000);
	assert.equal(s.spawned.length, 1, "still inside the 120 s window");
	s.advance(120000);
	await s.tick(30000);
	assert.equal(s.spawned.length, 2);
	s.cleanup();
});

test("session_shutdown stops the timers and POSTs /api/bye with the session id", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	await s.pi.emit("session_shutdown", s.ctx);
	assert.equal(s.timers.length, 0);
	const bye = s.fetchCalls.find((call) => call.url.endsWith("/api/bye"));
	assert.ok(bye, "the server is told the session is gone");
	assert.equal(bye.opts.method, "POST");
	assert.equal(bye.opts.headers["x-inbox"], "1");
	assert.match(bye.opts.headers["content-type"], /application\/json/);
	assert.deepEqual(JSON.parse(bye.opts.body), { session: SESSION });
	const failing = setup({ fetchThrows: true });
	await failing.pi.emit("session_start", failing.ctx);
	await assert.doesNotReject(() => failing.pi.emit("session_shutdown", failing.ctx), "bye errors are ignored");
	failing.cleanup();
	s.cleanup();
});

test("a stale extension generation stops timers and logs once without a stack trace", async () => {
	const s = setup();
	let stale = false;
	const staleCtx = Object.defineProperties({ ...s.ctx }, {
		cwd: { get() {
			if (stale) throw new Error("stale extension generation after reload");
			return "C:/work/proj";
		} },
	});
	await s.pi.emit("session_start", staleCtx);
	const timers = [...s.timers];
	const callbacks = timers.map((entry) => entry.fn);
	assert.equal(callbacks.length, 2);
	stale = true;
	await timers.find((entry) => entry.ms === 30000).fn();
	assert.equal(s.timers.length, 0);
	const logFile = path.join(s.home, "logs", "extension.log");
	const stoppedLog = readFileSync(logFile, "utf8");
	assert.equal(stoppedLog.split("\n").filter(Boolean).length, 1);
	assert.match(stoppedLog, /stopped/);
	assert.doesNotMatch(stoppedLog, /Error:|at /);
	await Promise.all(callbacks.map((callback) => callback()));
	assert.equal(readFileSync(logFile, "utf8"), stoppedLog);
	s.cleanup();
});

test("status announces new notice keys once, sets the footer, and clears it when empty", async () => {
	const s = setup({
		here: { footer: "🤖 1", notice: "notice-1", noticeKeys: ["261004-abcd:3"] },
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].message.customType, "omo-inbox");
	assert.equal(s.pi.sent[0].message.content, "notice-1");
	assert.deepEqual(s.pi.sent[0].message.details, { pending: ["261004-abcd:3"] });
	assert.deepEqual(s.pi.sent[0].opts, { deliverAs: "nextTurn", triggerTurn: false });
	await s.tick(30000);
	assert.equal(s.pi.sent.length, 1, "the same key is not announced twice");
	s.state.here = { footer: "", notice: "notice-1", noticeKeys: ["261004-abcd:3"] };
	await s.tick(30000);
	assert.deepEqual(s.statuses.at(-1), ["omo-inbox", undefined], "an empty footer clears the status");
	const sets = s.statuses.length;
	await s.tick(30000);
	assert.equal(s.statuses.length, sets, "an unchanged footer is not re-set");
	s.state.here = { footer: "", notice: "notice-2", noticeKeys: ["261004-abcd:3", "261004-efgh:7"] };
	await s.tick(30000);
	assert.equal(s.pi.sent.length, 2);
	assert.equal(s.pi.sent[1].message.content, "notice-2");
	assert.deepEqual(s.pi.sent[1].message.details, { pending: ["261004-abcd:3", "261004-efgh:7"] });
	s.cleanup();
});

test("session_start without ctx.cwd falls back to pi.cwd for /api/here", async () => {
	const s = setup({ cwd: null, piCwd: "C:/work/from-pi", here: { footer: "🙋 1", notice: null, noticeKeys: [] } });
	await s.pi.emit("session_start", s.ctx);
	const hereReads = s.fetchCalls.filter((call) => call.url.includes("/api/here"));
	assert.equal(hereReads.length, 1);
	assert.match(hereReads[0].url, /\/api\/here\?cwd=C%3A%2Fwork%2Ffrom-pi&session=s-1&start=1&idle=0$/);
	assert.deepEqual(s.statuses.at(-1), ["omo-inbox", "🙋 1"]);
	s.cleanup();
});

test("here reports the ctx idle state as idle=1 or idle=0", async () => {
	const idle = setup();
	idle.ctx.isIdle = () => true;
	await idle.pi.emit("session_start", idle.ctx);
	assert.match(idle.fetchCalls.find((call) => call.url.includes("/api/here")).url, /&idle=1$/);
	idle.cleanup();

	const busy = setup();
	busy.ctx.isIdle = () => false;
	await busy.pi.emit("session_start", busy.ctx);
	assert.match(busy.fetchCalls.find((call) => call.url.includes("/api/here")).url, /&idle=0$/);
	busy.cleanup();
});

test("without a UI the footer is not touched", async () => {
	const s = setup({ hasUI: false, here: { footer: "🙋 1", notice: null, noticeKeys: [] } });
	await s.pi.emit("session_start", s.ctx);
	await s.tick(30000);
	assert.equal(s.statuses.length, 0);
	s.cleanup();
});

test("a throwing hook is logged, never thrown into senpi", async () => {
	const s = setup({
		fsOverrides: {
			readdir: async () => {
				throw new Error("EACCES: denied");
			},
		},
	});
	await s.pi.emit("session_start", s.ctx);
	await assert.doesNotReject(() => s.tick(3000));
	const logFile = path.join(s.home, "logs", "extension.log");
	assert.equal(existsSync(logFile), true);
	assert.match(readFileSync(logFile, "utf8"), /inbox:/);
	s.cleanup();
});

test("a mine board inside the window -> recorded order is [wake activeCount 1, hold true]", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.emitted.length, 2);
	assert.deepEqual(s.pi.emitted[0], { channel: "wake_source_state", data: { source: "omo-inbox", activeCount: 1 } });
	assert.deepEqual(s.pi.emitted[1], { channel: "continuation_hold_state", data: { source: "omo-inbox", active: true } });
	s.cleanup();
});

test("waiting goes from 1 to [] -> recorded order [hold false, wake 0]", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.emitted.length, 2);
	s.pi.emitted.length = 0;
	s.state.here.waiting = [];
	await s.tick(30000);
	assert.equal(s.pi.emitted.length, 2);
	assert.deepEqual(s.pi.emitted[0], { channel: "continuation_hold_state", data: { source: "omo-inbox", active: false } });
	assert.deepEqual(s.pi.emitted[1], { channel: "wake_source_state", data: { source: "omo-inbox", activeCount: 0 } });
	s.cleanup();
});

test("a mine board older than the window is not counted while a theirs board of the same age is", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 40 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [
				{ id: "261004-mine", title: "Mine", status: "mine", since, seq: null },
				{ id: "261004-theirs", title: "Theirs", status: "theirs", since, seq: 3 },
			],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.emitted.length, 2);
	assert.equal(s.pi.emitted[0].data.activeCount, 1);
	assert.equal(s.pi.emitted[1].data.active, true);
	s.cleanup();
});

test("getAskUserSettings timeoutMinutes 5 shrinks the window", async () => {
	const now = 1_750_000_000_000;
	const mine4min = new Date(now - 4 * 60_000).toISOString();
	const mine6min = new Date(now - 6 * 60_000).toISOString();
	const s = setup({
		hasUI: true,
		askUser: { timeoutMinutes: 5 },
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [
				{ id: "261004-4", title: "4min", status: "mine", since: mine4min, seq: null },
				{ id: "261004-6", title: "6min", status: "mine", since: mine6min, seq: null },
			],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
	assert.deepEqual(counts, [1], "only the 4-min board is inside the 5-minute window");
	s.cleanup();
});

test("unreachable server: the cached snapshot is re-published; expired board releases hold", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	let refreshCallCount = 0;
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	s.state.here = () => {
		refreshCallCount++;
		if (refreshCallCount > 1) throw new Error("server down");
		return { waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] };
	};
	await s.pi.emit("session_start", s.ctx);
	s.pi.emitted.length = 0;
	await s.tick(30000);
	assert.ok(s.pi.emitted.some((e) => e.data.activeCount === 1), "first refresh still shows the board");
	s.pi.emitted.length = 0;
	await s.tick(30000);
	assert.ok(s.pi.emitted.some((e) => e.data.activeCount === 1), "server down: cached snapshot re-published with board still inside window");
	s.pi.emitted.length = 0;
	s.advance(35 * 60_000);
	await s.tick(30000);
	const emissions = s.pi.emitted.filter((e) => e.channel === "wake_source_state");
	assert.ok(emissions.some((e) => e.data.activeCount === 0), "after advancing past the window, server down refresh shows count 0");
	s.cleanup();
});

test("shutdown emits hold false then wake 0", async () => {
	const s = setup();
	await s.pi.emit("session_start", s.ctx);
	s.pi.emitted.length = 0;
	await s.pi.emit("session_shutdown", s.ctx);
	const shutdownEvents = s.pi.emitted.filter((e) => e.channel === "continuation_hold_state" || e.channel === "wake_source_state");
	assert.equal(shutdownEvents.length, 2);
	assert.deepEqual(shutdownEvents[0], { channel: "continuation_hold_state", data: { source: "omo-inbox", active: false } });
	assert.deepEqual(shutdownEvents[1], { channel: "wake_source_state", data: { source: "omo-inbox", activeCount: 0 } });
	s.cleanup();
});

test("a pi without events never throws", async () => {
	const fp = fakePi();
	delete fp.pi.events;
	const tmp = makeTmpHome();
	const { ctx } = fakeCtx();
	const handle = createInbox(fp.pi, {
		env: { OMO_INBOX_HOME: tmp.home },
		home: tmp.home,
		now: () => 1_750_000_000_000,
		timer: { setInterval: () => ({}), clearInterval: () => {} },
		fetch: async () => ({
			ok: true,
			status: 200,
			json: async () => ({ footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since: new Date(1_750_000_000_000 - 10 * 60_000).toISOString(), seq: null }] }),
		}),
	});
	await assert.doesNotReject(async () => {
		await handle.status(true);
	});
	handle.stop();
	tmp.cleanup();
});

test("every emitted pair satisfies hold.active === (activeCount > 0)", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	for (let i = 0; i < s.pi.emitted.length; i += 2) {
		const wake = s.pi.emitted[i];
		const hold = s.pi.emitted[i + 1];
		if (wake && hold) {
			const holdActive = hold.data.active;
			const wakeCount = wake.data.activeCount;
			assert.equal(holdActive, wakeCount > 0, `pair at ${i}: hold.active=${holdActive} but activeCount=${wakeCount}`);
		}
	}
	s.cleanup();
});

test("board cached as theirs with inbox payload, post-delivery refresh fails", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	let refreshCallCount = 0;
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }],
		},
	});
	s.state.here = () => {
		refreshCallCount++;
		if (refreshCallCount > 1) throw new Error("server down after delivery");
		return { waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }], footer: "" };
	};
	await s.pi.emit("session_start", s.ctx);
	s.pi.sent.length = 0;
	s.pi.emitted.length = 0;
	s.writeInbox();
	await s.tick(3000);
	const delivered = s.pi.sent.length > 0;
	assert.equal(delivered, true, "board delivered as followUp");
	const eventAfterDelivery = s.pi.emitted.filter((e) => e.channel === "wake_source_state");
	const hasCountZero = eventAfterDelivery.some((e) => e.data.activeCount === 0);
	assert.equal(hasCountZero, true, "post-delivery refresh emits count 0 even when server fails");
	s.cleanup();
});

test("a since of 'garbage' never counts as live", async () => {
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since: "garbage", seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
	assert.ok(counts.every((c) => c === 0), "board with invalid since never counts");
	s.cleanup();
});

test("a second session_start (reload) re-emits the current state on its first refresh", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	const firstStart = s.pi.emitted.length;
	s.pi.emitted.length = 0;
	await s.pi.emit("session_start", s.ctx);
	assert.ok(s.pi.emitted.length > 0, "second session_start causes a refresh with events");
	s.cleanup();
});

test("a theirs item whose id-seq was already delivered by this copy is not counted", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 10 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	s.pi.emitted.length = 0;
	s.writeInbox("261004-abcd-000003.json", PAYLOAD);
	await s.tick(3000);
	assert.equal(s.pi.sent.length, 1, "payload delivered");
	s.pi.emitted.length = 0;
	await s.tick(30000);
	const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
	assert.ok(counts.some((c) => c === 0), "after delivery, the same theirs item no longer counts");
	s.cleanup();
});

test("timeoutMinutes 0, -1 and 500 clamp to defaults/bounds", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 35 * 60_000).toISOString();
	for (const minutes of [0, -1, 500]) {
		const s = setup({
			askUser: { timeoutMinutes: minutes },
			here: {
				footer: "",
				notice: null,
				noticeKeys: [],
				waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
			},
		});
		await s.pi.emit("session_start", s.ctx);
		const counts = s.pi.emitted.filter((e) => e.channel === "wake_source_state").map((e) => e.data.activeCount);
		if (minutes === 0 || minutes === -1) {
			assert.ok(counts.some((c) => c === 0), `timeoutMinutes ${minutes} should clamp to default 30, board older than window`);
		} else if (minutes === 500) {
			assert.ok(counts.some((c) => c === 1), `timeoutMinutes 500 should clamp to 120, board inside 120-minute window`);
		}
		s.cleanup();
	}
});

test("expired mine board sends one timeout followUp before event emissions", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 1 * 60_000).toISOString();
	const s = setup({
		here: {
			footer: "",
			notice: null,
			noticeKeys: [],
			waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }],
		},
	});
	await s.pi.emit("session_start", s.ctx);
	s.advance(30 * 60_000);
	await s.handle.status(false);
	assert.equal(s.pi.sent.length, 1);
	assert.equal(s.pi.sent[0].opts.deliverAs, "followUp");
	assert.equal(s.pi.sent[0].opts.triggerTurn, true);
	assert.deepEqual(s.pi.sent[0].message.details, { proposalId: "261004-abcd", timedOut: true });
	assert.match(s.pi.sent[0].message.content, /^\[omo-inbox\] 답이 없습니다: Test \(261004-abcd\), 31분\n처리:/);
	assert.match(s.pi.sent[0].message.content, /node ".*\/app\/bin\/inbox\.mjs" reply 261004-abcd 로 알리세요/);
	assert.ok(s.pi.sent[0].message.content.includes("/"), "home path uses forward slashes");
	assert.equal(s.pi.emitted.length, 4);
	await s.pi.emit("tool_execution_end", s.ctx);
	assert.equal(s.pi.sent.length, 1, "second refresh does not re-send");
	s.cleanup();
});

test("revised since gets a new timeout notice", async () => {
	const now = 1_750_000_000_000;
	let since = new Date(now - 1 * 60_000).toISOString();
	const s = setup({ here: () => ({ footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] }) });
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 0);
	s.advance(31 * 60_000);
	since = new Date(now + 30 * 60_000).toISOString();
	s.advance(31 * 60_000);
	await s.pi.emit("tool_execution_end", s.ctx);
	assert.equal(s.pi.sent.length, 1);
	s.cleanup();
});

test("expired boards already present at session_start stay silent across reload", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 31 * 60_000).toISOString();
	const s = setup({ here: { footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] } });
	await s.pi.emit("session_start", s.ctx);
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 0);
	s.cleanup();
});

test("theirs boards and same-since session replies never trigger timeout notices", async () => {
	const now = 1_750_000_000_000;
	const since = new Date(now - 1 * 60_000).toISOString();
	const s = setup({ here: { footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "theirs", since, seq: 3 }] } });
	await s.pi.emit("session_start", s.ctx);
	assert.equal(s.pi.sent.length, 0);
	s.advance(28 * 60_000);
	s.state.here = { footer: "", waiting: [{ id: "261004-abcd", title: "Test", status: "mine", since, seq: null }] };
	await s.pi.emit("tool_execution_end", s.ctx);
	assert.equal(s.pi.sent.length, 0, "session reply does not move since or restart its notice");
	s.cleanup();
});

test("the embedded safeSegment matches src/paths.mjs", () => {
	const table = ["s-1", "a/b\\c", "한글 세션", "", "..", "x".repeat(200), "a b?c*d", null, undefined, 12345, "dup--__.."];
	for (const value of table) {
		assert.equal(safeSegment(value), pathsSafeSegment(value), JSON.stringify(value));
	}
});

// --- capture / bridge / delivery integration (plan todo 20) ---

function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

/** A tui session with a synchronous event bus, a recording server and injected timers. */
function tuiHarness({ serverDown = false, thread = {}, summaryRequest = null, summaryReply, abortAfter, fetch, deskWaiting = null, deskFails = false } = {}) {
	const tmp = makeTmpHome();
	const deskHome = path.join(tmp.home, "desk-home");
	const deskPort = 4499;
	mkdirSync(deskHome, { recursive: true });
	writeFileSync(path.join(deskHome, "config.json"), JSON.stringify({ v: 1, port: deskPort }));
	const deskCalls = [];
	const handlers = new Map();
	const listeners = new Map();
	const intervals = [];
	const oneShots = [];
	const posts = [];
	const waiters = [];
	const summaries = [];
	const pi = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
		},
		sendMessage() {},
		events: {
			on(channel, handler) {
				if (!listeners.has(channel)) listeners.set(channel, []);
				listeners.get(channel).push(handler);
			},
			emit(channel, data) {
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
		},
	};
	const note = (route, body) => {
		posts.push({ route, body });
		for (const waiter of [...waiters]) {
			if (waiter.match(route, body)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.done.resolve({ route, body });
			}
		}
	};
	const fetchImpl = async (url, opts = {}) => {
		if (fetch) return fetch(url, opts);
		const parsed = new URL(String(url));
		if (parsed.port === String(deskPort)) {
			deskCalls.push({ url: String(url), opts });
			if (deskFails) throw new Error(opts.signal?.aborted ? "desk request aborted" : "desk timed out");
			return { ok: true, status: 200, json: async () => ({ waiting: deskWaiting ?? [] }) };
		}
		if (opts.method === "POST") {
			if (serverDown) throw new Error("connect ECONNREFUSED");
			const body = JSON.parse(opts.body);
			note(parsed.pathname, body);
			if (parsed.pathname.endsWith("/items")) return { ok: true, status: 200, json: async () => ({ item: { id: "i-1" }, created: true, summaryRequest }) };
			if (parsed.pathname.endsWith("/summary")) {
				summaries.push(body);
				const reply = typeof summaryReply === "function" ? summaryReply(body, summaries.length) : { ok: true };
				return { ok: true, status: 200, json: async () => reply };
			}
			return { ok: true, status: 200, json: async () => ({ ok: true }) };
		}
		if (serverDown) throw new Error("connect ECONNREFUSED");
		if (parsed.pathname === "/api/here") return { ok: true, status: 200, json: async () => ({ footer: "", waiting: [] }) };
		if (parsed.pathname.startsWith("/api/p/")) return { ok: true, status: 200, json: async () => ({ summary: { status: "theirs" } }) };
		if (parsed.pathname.startsWith("/api/threads/")) {
			const body = typeof thread === "function" ? thread(parsed) : thread;
			return { ok: true, status: 200, json: async () => body };
		}
		return { ok: true, status: 200, json: async () => ({}) };
	};
	const fsImpl = { ...fsp, readFile: async (file, ...rest) => {
		if (String(file).includes("goal")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return fsp.readFile(file, ...rest);
	}, appendFile: async () => {} };
	const handle = createInbox(pi, {
		env: { OMO_INBOX_HOME: tmp.home },
		home: tmp.home,
		deskHome,
		fs: fsImpl,
		fetch: fetchImpl,
		abortAfter,
		timer: { setInterval: (fn, ms) => { const id = { fn, ms }; intervals.push(id); return id; }, clearInterval: (id) => { const at = intervals.indexOf(id); if (at >= 0) intervals.splice(at, 1); } },
		setTimer: (fn, ms) => { const id = { fn, ms }; oneShots.push(id); return id; },
		clearTimer: (id) => { const at = oneShots.indexOf(id); if (at >= 0) oneShots.splice(at, 1); },
		spawn: () => ({ unref() {} }),
	});
	const original = async () => new Promise(() => {});
	const statuses = [];
	const ctx = {
		mode: "tui",
		cwd: "C:/work/proj",
		hasUI: true,
		isIdle: () => true,
		ui: { setStatus: (key, text) => statuses.push([key, text]), question: original },
		sessionManager: { getSessionId: () => SESSION, getBranch: () => [], getSessionFile: () => null, getSessionName: () => null },
	};
	return {
		home: tmp.home,
		handle,
		pi,
		ctx,
		posts,
		summaries,
		statuses,
		original,
		intervals,
		oneShots,
		deskCalls,
		emit(channel, data) { pi.events.emit(channel, data); },
		async fire(event, data) { for (const handler of handlers.get(event) ?? []) await handler(data ?? {}, ctx); },
		waitFor(match) {
			const found = posts.find((post) => match(post.route, post.body));
			if (found) return Promise.resolve(found);
			const done = deferred();
			waiters.push({ match, done });
			return done.promise;
		},
		cleanup() { handle?.stop?.(); tmp.cleanup(); },
	};
}

const REQUEST = { requestId: "r1", questions: [{ id: "q1", header: "H", question: "which?", options: [{ label: "A" }, { label: "B" }] }], required: false };

/**
 * Event-driven wait: the test calls changed() at the exact state change it observes (a fetch, a footer
 * write), and until(condition) resolves on the first change that makes condition true. The 5 s bound only
 * turns a regression into a failure; passing never depends on how many event-loop turns the chain takes.
 */
function changeWatch() {
	const waiters = [];
	return {
		changed() {
			for (const waiter of [...waiters]) {
				if (!waiter.condition()) continue;
				waiters.splice(waiters.indexOf(waiter), 1);
				clearTimeout(waiter.timer);
				waiter.resolve();
			}
		},
		until(condition, label) {
			if (condition()) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const waiter = { condition, resolve };
				waiter.timer = setTimeout(() => {
					waiters.splice(waiters.indexOf(waiter), 1);
					reject(new Error(`timed out waiting for ${label}`));
				}, 5000);
				waiters.push(waiter);
			});
		},
	};
}

test("ask-user:asked posts a question item and installs the bridge before any await", async () => {
	const h = tuiHarness();
	await h.fire("session_start");
	const posted = h.waitFor((route, body) => route.endsWith("/items") && body.kind === "question");
	h.emit("ask-user:asked", { request: REQUEST });
	const { body } = await posted;
	assert.equal(body.dedupeKey, "q:r1");
	assert.equal(body.raw.request.requestId, "r1");
	assert.notEqual(h.ctx.ui.question, h.original, "the wrapper is installed synchronously");
	h.cleanup();
});

test("a mailbox answer resolves the pending question through the bridge and acks it", async () => {
	const h = tuiHarness();
	await h.fire("session_start");
	h.emit("ask-user:asked", { request: REQUEST });
	const pending = h.ctx.ui.question(REQUEST, {});
	mkdirSync(path.join(h.home, "mailbox", SESSION), { recursive: true });
	writeFileSync(path.join(h.home, "mailbox", SESSION, "i-1-000001.json"), JSON.stringify({ v: 1, type: "item-answer", itemId: "i-1", kind: "question", deliveryId: "d-1", requestId: "r1", payload: { answers: { q1: { selected: ["A"] } } }, text: "A" }));
	const acked = h.waitFor((route) => route === "/api/items/i-1/delivered");
	for (const timer of h.intervals.filter((entry) => entry.ms === 3000)) await timer.fn();
	const response = await pending;
	assert.equal(response.status, "answered");
	assert.deepEqual(response.answers.q1.selected, ["A"]);
	assert.equal(response.resolvedBy, "omo_inbox");
	const { body } = await acked;
	assert.equal(body.how, "bridge");
	assert.equal(body.deliveryId, "d-1");
	assert.equal(existsSync(path.join(h.home, "mailbox", SESSION, "i-1-000001.json")), false);
	h.cleanup();
});

test("agent_settled posts a turn item after the injected settle delay", async () => {
	const h = tuiHarness();
	await h.fire("session_start");
	await h.fire("agent_start");
	await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "작업을 끝냈습니다. 계속할까요?" }] } });
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "작업을 끝냈습니다. 계속할까요?" }] }] });
	await h.fire("agent_settled");
	assert.equal(h.oneShots.length, 1, "one settle timer is armed");
	assert.equal(h.posts.some((post) => post.body?.kind === "turn"), false, "nothing is classified before the timer fires");
	const posted = h.waitFor((route, body) => route.endsWith("/items") && body.kind === "turn");
	h.oneShots[0].fn();
	const { body } = await posted;
	assert.equal(body.policy, "needs-you");
	assert.match(body.raw.final, /작업을 끝냈습니다/);
	h.cleanup();
});

test("the turn item's dedupe key is the send time of the last assistant reply", async () => {
	const h = tuiHarness();
	await h.fire("session_start");
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "끝났습니다." }], timestamp: 1_792_000_000_000 }] });
	await h.fire("agent_settled");
	const posted = h.waitFor((route, body) => route.endsWith("/items") && body.kind === "turn");
	h.oneShots[0].fn();
	const { body } = await posted;
	assert.match(body.dedupeKey, new RegExp(`^episode:${SESSION}:\\d+:needs-you:m1792000000000$`));
	h.cleanup();
});

const ENDED_AT = Date.UTC(2026, 9, 18, 18, 52, 58);
const endedBranch = () => [
	{ type: "message", timestamp: new Date(ENDED_AT - 120_000).toISOString(), message: { role: "user", content: "커밋해 줘", timestamp: ENDED_AT - 120_000 } },
	{ type: "message", timestamp: new Date(ENDED_AT).toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "커밋 두 개를 만들었습니다." }], timestamp: ENDED_AT } },
	{ type: "custom", customType: "senpi.hooks.stop-state" },
];

test("a reload inside the settle wait re-arms the lost turn end from the transcript, with the same key", async () => {
	const h = tuiHarness({ thread: { items: [{ id: "q-old", kind: "question", status: "closed", createdAt: new Date(ENDED_AT - 60_000).toISOString() }] } });
	h.ctx.sessionManager.getBranch = endedBranch;
	await h.fire("session_start", { reason: "reload" });
	assert.equal(h.oneShots.length, 1, "the dropped settle is armed again");
	const posted = h.waitFor((route, body) => route.endsWith("/items") && body.kind === "turn");
	h.oneShots[0].fn();
	const { body } = await posted;
	assert.equal(body.policy, "needs-you");
	assert.equal(body.dedupeKey, `episode:${SESSION}:${ENDED_AT}:needs-you:m${ENDED_AT}`);
	assert.match(body.raw.final, /커밋 두 개/);
	h.cleanup();
});

test("every session_start restores the open episode from the thread; only a reload re-arms the turn end", async () => {
	const openedAt = ENDED_AT - 30_000;
	const key = `e:${SESSION}:${openedAt}`;
	const thread = { items: [{ id: "i-old", kind: "progress", status: "open", createdAt: new Date(openedAt).toISOString(), meta: { episode: { key, opener: openedAt, seq: 2, openedAt } } }] };
	for (const reason of ["startup", "resume", "reload"]) {
		const h = tuiHarness({ thread });
		await h.fire("session_start", { reason });
		await h.fire("agent_start");
		const { body } = await h.waitFor((route, body) => route === `/api/threads/${SESSION}/activity` && body?.source === "agent-start");
		assert.equal(body.opened, false, `${reason} continued the restored episode`);
		assert.equal(body.episode, key, `${reason} kept the restored key`);
		h.cleanup();
	}
});

test("board feedback marks the next agent start as the owner's", async () => {
	const h = tuiHarness();
	await h.fire("session_start");
	mkdirSync(path.join(h.home, "mailbox", SESSION), { recursive: true });
	writeFileSync(path.join(h.home, "mailbox", SESSION, INBOX_FILE), JSON.stringify(PAYLOAD));
	for (const timer of h.intervals.filter((entry) => entry.ms === 3000)) await timer.fn();
	await h.fire("agent_start");
	const { body } = await h.waitFor((route, body) => route === `/api/threads/${SESSION}/activity` && body?.source === "agent-start");
	assert.equal(body.cause, "owner", "board feedback makes the start the owner's");
	h.cleanup();
});

test("trial mode reads desk boards without start=1 and puts mine boards on the waiting line", async () => {
	const deskWaiting = [
		{ id: "p-1", title: "결제 화면", status: "mine", url: "http://127.0.0.1:4499/p/p-1" },
		{ id: "p-2", title: "남의 화면", status: "theirs", url: "http://127.0.0.1:4499/p/p-2" },
	];
	const h = tuiHarness({ deskWaiting });
	await h.fire("session_start");
	await h.fire("agent_start");
	const line = h.waitFor((route, body) => route.endsWith("/items") && body.kind === "progress");
	await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "작업 중입니다." }] } });
	await line;
	h.emit("continuation_hold_state", { source: "terminal-background-sessions", active: true });
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "작업 중입니다." }] }] });
	await h.fire("agent_settled");
	const settle = h.oneShots.find((timer) => timer.ms === 2500);
	assert.ok(settle, "the settle timer is armed");
	const state = h.waitFor((route) => route.endsWith("/state"));
	settle.fn();
	const { body } = await state;
	assert.equal(body.state, "waiting");
	assert.deepEqual(body.boards, [{ id: "p-1", title: "결제 화면", url: "http://127.0.0.1:4499/p/p-1" }]);
	assert.equal(h.deskCalls.length, 1);
	assert.equal(h.deskCalls[0].url, `http://127.0.0.1:4499/api/here?cwd=C%3A%2Fwork%2Fproj&session=${SESSION}`);
	h.cleanup();
});

test("a desk read that times out gives no boards and never throws", async () => {
	const abortMs = [];
	const h = tuiHarness({ deskFails: true, abortAfter: (ms) => { abortMs.push(ms); return AbortSignal.abort(); } });
	await h.fire("session_start");
	await h.fire("agent_start");
	const line = h.waitFor((route, body) => route.endsWith("/items") && body.kind === "progress");
	await h.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: "작업 중입니다." }] } });
	await line;
	h.emit("continuation_hold_state", { source: "terminal-background-sessions", active: true });
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "작업 중입니다." }] }] });
	await h.fire("agent_settled");
	const settle = h.oneShots.find((timer) => timer.ms === 2500);
	assert.ok(settle, "the settle timer is armed");
	const state = h.waitFor((route) => route.endsWith("/state"));
	assert.doesNotThrow(() => settle.fn());
	const { body } = await state;
	assert.deepEqual(body.boards, []);
	assert.ok(abortMs.includes(2000), "the desk read used its 2 s timeout");
	h.cleanup();
});

test("the reply's own progress line does not stop a reload from re-arming the dropped turn end", async () => {
	const h = tuiHarness({ thread: { items: [{ id: "l-1", kind: "progress", status: "open", createdAt: new Date(ENDED_AT + 40).toISOString() }] } });
	h.ctx.sessionManager.getBranch = endedBranch;
	await h.fire("session_start", { reason: "reload" });
	assert.equal(h.oneShots.length, 1, "the dropped settle is armed again despite the line");
	const posted = h.waitFor((route, body) => route.endsWith("/items") && body.kind === "turn");
	h.oneShots[0].fn();
	const { body } = await posted;
	assert.equal(body.policy, "needs-you");
	h.cleanup();
});

test("no re-arm when the thread got an item after the reply, the start is not a reload, or the user already replied", async () => {
	const later = tuiHarness({ thread: { items: [{ id: "t-1", kind: "turn", status: "open", createdAt: new Date(ENDED_AT + 1500).toISOString() }] } });
	later.ctx.sessionManager.getBranch = endedBranch;
	await later.fire("session_start", { reason: "reload" });
	assert.equal(later.oneShots.length, 0, "the old copy already posted it");
	later.cleanup();
	const startup = tuiHarness();
	startup.ctx.sessionManager.getBranch = endedBranch;
	await startup.fire("session_start", { reason: "startup" });
	assert.equal(startup.oneShots.length, 0, "only a reload recovers");
	startup.cleanup();
	const replied = tuiHarness();
	replied.ctx.sessionManager.getBranch = () => [...endedBranch(), { type: "custom_message", customType: "session_control_delivery", content: "계속해" }];
	await replied.fire("session_start", { reason: "reload" });
	assert.equal(replied.oneShots.length, 0, "a reply after the turn starts the next turn instead");
	replied.cleanup();
});

test("a quit or a switch to another session says closed in the bye; a reload does not", async () => {
	for (const [reason, closed] of [["quit", true], ["new", true], ["resume", true], ["reload", false]]) {
		const h = tuiHarness();
		await h.fire("session_start");
		const bye = h.waitFor((route) => route === "/api/bye");
		await h.fire("session_shutdown", { reason });
		const { body } = await bye;
		assert.equal(body.session, SESSION);
		assert.equal(body.closed === true, closed, reason);
		h.cleanup();
	}
});

test("a turn end triggers a status refresh without waiting for the 30 s timer", async () => {
	let hereReads = 0;
	const watch = changeWatch();
	const h = tuiHarness({
		fetch: async (url, opts = {}) => {
			const parsed = new URL(String(url));
			if (parsed.pathname === "/api/here") {
				hereReads += 1;
				watch.changed();
				return { ok: true, status: 200, json: async () => ({ footer: "🙋 1", waiting: [] }) };
			}
			if (opts.method === "POST") return { ok: true, status: 200, json: async () => ({ item: { id: "i-1" } }) };
			if (parsed.pathname.startsWith("/api/threads/")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
			return { ok: true, status: 200, json: async () => ({}) };
		},
	});
	await h.fire("session_start");
	assert.equal(hereReads, 1);
	const settled = watch.until(() => hereReads === 2, "the settle refresh");
	await h.fire("agent_settled");
	await settled;
	assert.deepEqual(h.statuses.at(-1), ["omo-inbox", "🙋 1"]);
	h.cleanup();
});

test("a failed capture post shows the down footer at once and refreshes", async () => {
	let down = false;
	let hereReads = 0;
	const watch = changeWatch();
	const h = tuiHarness({
		fetch: async (url, opts = {}) => {
			if (String(url).includes("/api/here")) {
				hereReads += 1;
				watch.changed();
			}
			if (down) throw new Error("connect ECONNREFUSED");
			const parsed = new URL(String(url));
			if (parsed.pathname === "/api/here") {
				return { ok: true, status: 200, json: async () => ({ footer: "", waiting: [] }) };
			}
			if (opts.method === "POST") return { ok: true, status: 200, json: async () => ({ item: { id: "i-1" }, summaryConfig: { enabled: false } }) };
			if (parsed.pathname.startsWith("/api/threads/")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
			return { ok: true, status: 200, json: async () => ({}) };
		},
	});
	await h.fire("session_start");
	const setStatus = h.ctx.ui.setStatus;
	h.ctx.ui.setStatus = (key, text) => {
		setStatus(key, text);
		watch.changed();
	};
	const shown = watch.until(() => h.statuses.some((entry) => entry[1] === "Inbox 서버 꺼짐"), "the down footer");
	const refreshed = watch.until(() => hereReads === 2, "the post-failure refresh");
	down = true;
	h.emit("ask-user:asked", { request: REQUEST });
	await shown;
	assert.deepEqual(h.statuses.at(-1), ["omo-inbox", "Inbox 서버 꺼짐"]);
	await refreshed;
	h.cleanup();
});

test("stop uninstalls the bridge and restores the original question function", async () => {
	const h = tuiHarness();
	await h.fire("session_start");
	assert.notEqual(h.ctx.ui.question, h.original);
	h.handle.stop();
	assert.equal(h.ctx.ui.question, h.original);
	h.cleanup();
});

test("the extension never registers before_agent_start", async () => {
	const h = tuiHarness();
	await h.fire("session_start");
	assert.equal(h.pi.events.on !== undefined, true);
	const registered = new Set();
	const spy = { ...h.pi, on: (event, handler) => { registered.add(event); h.pi.on(event, handler); } };
	const tmp = makeTmpHome();
	const second = createInbox(spy, { env: { OMO_INBOX_HOME: tmp.home }, home: tmp.home, fetch: async () => ({ ok: true, json: async () => ({}) }), timer: { setInterval: () => ({}), clearInterval() {} } });
	assert.equal(registered.has("before_agent_start"), false);
	for (const event of ["message_start", "message_end", "agent_start", "agent_end", "agent_settled", "input", "tool_execution_end", "session_start", "session_shutdown"]) assert.equal(registered.has(event), true, event);
	second.stop();
	tmp.cleanup();
	h.cleanup();
});

test("a summary repairRequest is run once with the repair prompt and posted with repair true", async () => {
	const calls = [];
	const registry = {
		find(provider, model) {
			return provider === "anthropic-subscription" && model === "claude-haiku-4-5" ? { provider, id: model } : undefined;
		},
		hasConfiguredAuth: () => true,
		complete: async (_model, context) => {
			calls.push({ system: context.systemPrompt, user: context.messages[0].content[0].text });
			return { content: [{ type: "text", text: "{\"headline\":\"고침\"}" }] };
		},
	};
	const repair = { system: "repair system", user: "repair user", maxTokens: 400 };
	const h = tuiHarness({
		summaryRequest: { system: "first system", user: "first user", maxTokens: 500 },
		summaryReply: (_body, count) => (count === 1 ? { ok: true, repairRequest: repair } : { ok: true, repairRequest: { system: "again", user: "again" } }),
	});
	h.ctx.modelRegistry = registry;
	await h.fire("session_start");
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "작업을 끝냈습니다." }] }] });
	await h.fire("agent_settled");
	h.oneShots[0].fn();
	const repaired = await h.waitFor((route, body) => route.endsWith("/summary") && body?.repair === true);
	for (let index = 0; index < 10; index += 1) await Promise.resolve();

	assert.equal(h.summaries.length, 2, "one repair at most; the repair response's repairRequest is ignored");
	assert.deepEqual(calls, [
		{ system: "first system", user: "first user" },
		{ system: "repair system", user: "repair user" },
	]);
	assert.equal(repaired.body.model, "anthropic-subscription/claude-haiku-4-5");
	assert.equal(h.summaries[1].repair, true);
	assert.equal(h.summaries[1].text, "{\"headline\":\"고침\"}");
	h.cleanup();
});

test("session_start marks an open question without a live wait terminal-only", async () => {
	let reads = 0;
	const h = tuiHarness({
		thread: () => {
			reads += 1;
			if (reads === 1) return { items: [] };
			return {
				items: [
					{ id: "i-live", kind: "question", status: "open", raw: { request: { requestId: "live" } } },
					{ id: "i-orphan", kind: "question", status: "open", raw: { request: { requestId: "orphan" } } },
					{ id: "i-detached", kind: "question", status: "open", raw: { request: { requestId: "detached" } } },
					{ id: "i-closed", kind: "question", status: "closed", raw: { request: { requestId: "closed" } } },
				],
			};
		},
	});
	await h.fire("session_start");

	// A wait that is alive in this process is not reported; a detached one still is (C8 reload rule).
	h.ctx.ui.question({ requestId: "live", questions: [] }, {});
	const controller = new AbortController();
	h.ctx.ui.question({ requestId: "detached", questions: [] }, { signal: controller.signal });
	controller.abort("reload");
	await h.fire("session_start");

	await h.waitFor((route) => route === "/api/items/i-detached/bridge");
	assert.deepEqual(h.posts.filter((post) => post.route.endsWith("/bridge")), [
		{ route: "/api/items/i-orphan/bridge", body: { state: "terminal-only" } },
		{ route: "/api/items/i-detached/bridge", body: { state: "terminal-only" } },
	]);
	h.cleanup();
});

test("session_start and session_shutdown abort hung network reads at 1.5 s and queued items post later", async () => {
	const controllers = new Map();
	const timeouts = [];
	const abortAfter = (ms) => {
		const controller = new AbortController();
		controllers.set(controller.signal, controller);
		timeouts.push(ms);
		return controller.signal;
	};
	let hung = true;
	let hangItems = false;
	const hungCalls = [];
	const worked = [];
	// Waits resolve on the hung request itself arriving, never on a count of event-loop turns (that raced real fs work).
	const waiters = [];
	const recordHung = (call) => {
		hungCalls.push(call);
		for (const waiter of [...waiters]) {
			if (!waiter.condition()) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			clearTimeout(waiter.guard);
			waiter.resolve();
		}
	};
	const hungFetch = (url, opts = {}) => {
		const parsed = new URL(String(url));
		const hold = hung || (hangItems && parsed.pathname.endsWith("/items"));
		if (!hold) {
			worked.push({ path: parsed.pathname, method: opts.method ?? "GET", body: opts.body });
			if (parsed.pathname === "/api/here") return Promise.resolve({ ok: true, status: 200, json: async () => ({ footer: "", waiting: [] }) });
			if (parsed.pathname.startsWith("/api/threads/")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) });
			return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, item: { id: "i-1" } }) });
		}
		// A hung server: the request only settles when the injected abort fires.
		const call = { path: parsed.pathname, method: opts.method ?? "GET", signal: opts.signal, timeout: timeouts.at(-1) };
		recordHung(call);
		return new Promise((_resolve, reject) => {
			const fail = () => reject(new DOMException("aborted", "AbortError"));
			if (opts.signal?.aborted) fail();
			else opts.signal?.addEventListener("abort", fail, { once: true });
		});
	};
	const until = (condition, label) => {
		if (condition()) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const waiter = { condition, resolve, guard: null };
			// A failure bound only; the test proceeds the moment the awaited request is recorded.
			waiter.guard = setTimeout(() => {
				waiters.splice(waiters.indexOf(waiter), 1);
				reject(new Error(`timed out waiting for ${label}`));
			}, 5000);
			waiters.push(waiter);
		});
	};
	const h = tuiHarness({ abortAfter, fetch: hungFetch });

	let started = false;
	const starting = h.fire("session_start").then(() => { started = true; });
	await until(() => hungCalls.some((call) => call.path === `/api/threads/${SESSION}`) && hungCalls.some((call) => call.path === "/api/here"), "the session_start reads");
	assert.equal(started, false, "a hung server keeps the handler pending until its abort");
	const hookReads = hungCalls.filter((call) => call.method === "GET");
	assert.deepEqual(hookReads.map((call) => call.timeout), [1500, 1500], "both session_start reads use the 1.5 s hook bound");
	for (const call of hookReads) controllers.get(call.signal)?.abort();
	await starting;
	assert.equal(started, true, "session_start settles when the 1.5 s abort fires");
	for (const call of hungCalls) controllers.get(call.signal)?.abort();
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));

	// A capture post queued while the server hangs still goes out on a later flush.
	hung = false;
	hangItems = true;
	h.emit("ask-user:asked", { request: REQUEST });
	await h.handle.inbox();
	await until(() => hungCalls.some((call) => call.method === "POST" && call.path === `/api/threads/${SESSION}/items`), "the queued question item");
	const itemCall = hungCalls.findLast((call) => call.method === "POST" && call.path === `/api/threads/${SESSION}/items`);
	controllers.get(itemCall.signal)?.abort();
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	hangItems = false;
	await h.handle.inbox();
	await until(() => worked.some((call) => call.method === "POST" && call.path === `/api/threads/${SESSION}/items`), "the retried item post");

	hung = true;
	let shutDown = false;
	const shutting = h.fire("session_shutdown").then(() => { shutDown = true; });
	await until(() => hungCalls.some((call) => call.path === "/api/bye"), "the shutdown bye");
	const bye = hungCalls.findLast((call) => call.path === "/api/bye");
	assert.equal(bye.timeout, 1500, "the shutdown bye uses the 1.5 s hook bound");
	assert.equal(shutDown, false);
	controllers.get(bye.signal)?.abort();
	await shutting;
	assert.equal(shutDown, true, "session_shutdown settles when the 1.5 s abort fires");
	h.cleanup();
});

test("with the server unreachable handlers return without awaiting the network and items queue", async () => {
	const h = tuiHarness({ serverDown: true });
	await h.fire("session_start");
	let returned = false;
	h.emit("ask-user:asked", { request: REQUEST });
	await h.fire("input", { source: "interactive" }).then(() => { returned = true; });
	assert.equal(returned, true);
	assert.equal(h.posts.length, 0, "no post ever reached the server");
	h.cleanup();
});
