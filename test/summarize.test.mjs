// Extension summarizer and cache tracker (plan todo 16): fake registry, fake timers, no wall clock.
// Run: node --test test/summarize.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { CACHE_MOVE_MS, createCacheTracker } from "../extension/inbox/cache.ts";
import { DEFAULT_MODELS, createSummarizer, createSummaryQueue } from "../extension/inbox/summarize.ts";

const SONNET = "anthropic-subscription/claude-sonnet-5";
const HAIKU = "anthropic-subscription/claude-haiku-4-5";
const LUNA = "chatgpt-subscription/gpt-6-luna-fast";

const REQUEST = { system: "요약 규칙", user: "세션 원문", maxTokens: 700 };

/** A model-registry stand-in: `find(provider, modelId)` plus whichever call lanes the test needs. */
function fakeRegistry({ models = {}, auth = () => true, complete, streamSimple, findThrows = false } = {}) {
	const calls = { find: [], complete: [], streamSimple: [] };
	const registry = {
		find(provider, modelId) {
			const ref = `${provider}/${modelId}`;
			calls.find.push(ref);
			if (findThrows) throw new Error(`unknown model: ${ref}`);
			return models[ref];
		},
	};
	if (auth !== null) registry.hasConfiguredAuth = (model) => auth(model);
	if (complete) {
		registry.complete = (model, context, options) => {
			calls.complete.push({ model, context, options });
			return complete(model, context, options);
		};
	}
	if (streamSimple) {
		registry.streamSimple = (model, context, options) => {
			calls.streamSimple.push({ model, context, options });
			return streamSimple(model, context, options);
		};
	}
	return { registry, calls };
}

function message(...parts) {
	return { stopReason: "stop", content: parts };
}

function text(value) {
	return { type: "text", text: value };
}

test("summarize picks the preferred model, joins its text parts and passes the request through", async () => {
	const { registry, calls } = fakeRegistry({
		models: { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" }, [LUNA]: { provider: "chatgpt-subscription", id: "gpt-6-luna-fast" } },
		complete: async () => message({ type: "thinking", text: "무시" }, text("머리"), text("꼬리")),
		streamSimple: () => {
			throw new Error("streamSimple must not be used when complete exists");
		},
	});
	const summarizer = createSummarizer({ getRegistry: () => registry, models: [HAIKU, LUNA], now: () => 1_700_000_000_000 });

	const result = await summarizer.run(REQUEST);

	assert.deepEqual(result, { text: "머리꼬리", model: HAIKU });
	assert.equal(calls.complete.length, 1);
	assert.equal(calls.streamSimple.length, 0);
	const call = calls.complete[0];
	assert.equal(call.model.provider, "anthropic-subscription");
	assert.equal(call.context.systemPrompt, REQUEST.system);
	assert.equal(call.context.messages.length, 1);
	assert.equal(call.context.messages[0].role, "user");
	assert.deepEqual(call.context.messages[0].content, [{ type: "text", text: REQUEST.user }]);
	assert.equal(call.context.messages[0].timestamp, 1_700_000_000_000);
	assert.equal(call.options.maxTokens, 700);
	assert.ok(call.options.signal instanceof AbortSignal);
});

test("summarize logs how long an answered call took (todo 34 latency diagnosis)", async () => {
	const lines = [];
	let clock = 1_000;
	const { registry } = fakeRegistry({
		models: { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" } },
		complete: async () => {
			clock += 15_759;
			return message(text("대답"));
		},
	});
	const summarizer = createSummarizer({ getRegistry: () => registry, now: () => clock, log: (line) => lines.push(line) });

	assert.deepEqual(await summarizer.run(REQUEST), { text: "대답", model: HAIKU });
	assert.deepEqual(lines, [`summarize: ${HAIKU}: answered in 15759 ms`]);
});

test("summarize defaults to the plan's preference list and falls back to streamSimple(...).result()", async () => {
	const { registry, calls } = fakeRegistry({
		models: { [LUNA]: { provider: "chatgpt-subscription", id: "gpt-6-luna-fast" } },
		streamSimple: () => ({ result: async () => message(text("대답")) }),
	});
	const summarizer = createSummarizer({ getRegistry: async () => registry });

	const result = await summarizer.run(REQUEST);

	assert.deepEqual(DEFAULT_MODELS, [SONNET, LUNA, HAIKU]);
	assert.deepEqual(calls.find, [SONNET, LUNA, HAIKU]);
	assert.deepEqual(result, { text: "대답", model: LUNA });
	assert.equal(calls.streamSimple.length, 1);
});

test("summarize skips a model the registry has no auth for", async () => {
	const { registry, calls } = fakeRegistry({
		models: { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" }, [LUNA]: { provider: "chatgpt-subscription", id: "gpt-6-luna-fast" } },
		auth: (model) => model.id !== "claude-haiku-4-5",
		complete: async () => message(text("대답")),
	});
	const summarizer = createSummarizer({ getRegistry: () => registry, models: [HAIKU, LUNA] });

	const result = await summarizer.run(REQUEST);

	assert.deepEqual(calls.find, [HAIKU, LUNA]);
	assert.deepEqual(result, { text: "대답", model: LUNA });
});

test("summarize returns null without any model call when no preferred model is available", async () => {
	const lines = [];
	const { registry, calls } = fakeRegistry({
		models: {},
		complete: async () => message(text("대답")),
		streamSimple: () => ({ result: async () => message(text("대답")) }),
	});
	const summarizer = createSummarizer({ getRegistry: () => registry, log: (line) => lines.push(line) });

	assert.equal(await summarizer.run(REQUEST), null);
	assert.equal(calls.complete.length, 0);
	assert.equal(calls.streamSimple.length, 0);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /no usable model/);
});

test("summarize never calls a model outside the configured list, even when the registry offers only that model", async () => {
	const sessionModel = "anthropic-subscription/claude-opus-4-5";
	const { registry, calls } = fakeRegistry({
		models: { [sessionModel]: { provider: "anthropic-subscription", id: "claude-opus-4-5" } },
		complete: async () => message(text("세션 모델 답")),
		streamSimple: () => ({ result: async () => message(text("세션 모델 답")) }),
	});
	const summarizer = createSummarizer({ getRegistry: () => registry, models: [HAIKU, LUNA] });

	assert.equal(await summarizer.run(REQUEST), null);
	assert.deepEqual(calls.find, [HAIKU, LUNA]);
	assert.equal(calls.complete.length, 0, "the unlisted model must never be invoked");
	assert.equal(calls.streamSimple.length, 0, "the unlisted model must never be streamed");
});

test("summarize uses a listed model and never the session's own model", async () => {
	const sessionModel = "anthropic-subscription/claude-opus-4-5";
	const { registry, calls } = fakeRegistry({
		models: {
			[sessionModel]: { provider: "anthropic-subscription", id: "claude-opus-4-5" },
			[HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" },
		},
		complete: async (model) => (model.id === "claude-haiku-4-5" ? message(text("목록 모델 답")) : message(text("세션 모델 답"))),
	});
	const summarizer = createSummarizer({ getRegistry: () => registry, models: [HAIKU] });

	assert.deepEqual(await summarizer.run(REQUEST), { text: "목록 모델 답", model: HAIKU });
	assert.deepEqual(calls.find, [HAIKU]);
	assert.equal(calls.complete.length, 1);
	assert.equal(calls.complete[0].model.id, "claude-haiku-4-5");
	assert.equal(calls.complete.filter((call) => call.model.id === "claude-opus-4-5").length, 0, "the session's own model must record zero calls");
});

test("summarize returns null and logs one line when the registry throws on find", async () => {
	const lines = [];
	const { registry } = fakeRegistry({ findThrows: true });
	const summarizer = createSummarizer({ getRegistry: () => registry, log: (line) => lines.push(line) });

	assert.equal(await summarizer.run(REQUEST), null);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /model lookup failed: unknown model/);
});

test("summarize times out through the injected timer, aborts the call and returns null", async () => {
	const timed = [];
	const timer = {
		setTimeout(callback, ms) {
			timed.push(ms);
			callback();
			return 1;
		},
		clearTimeout() {},
	};
	let callSignal;
	const { registry, calls } = fakeRegistry({
		models: { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" } },
		complete: (_model, _context, options) => {
			callSignal = options.signal;
			// Never settles: the timeout, not the provider, decides.
			return new Promise(() => {});
		},
	});
	const lines = [];
	const summarizer = createSummarizer({ getRegistry: () => registry, timer, timeoutMs: 1234, log: (line) => lines.push(line) });

	assert.equal(await summarizer.run(REQUEST), null);
	assert.deepEqual(timed, [1234]);
	assert.equal(calls.complete.length, 1);
	assert.equal(callSignal.aborted, true);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /timed out after 1234 ms/);
});

test("summarize defaults to a 60 s timeout (todo 32)", async () => {
	const timed = [];
	const timer = {
		setTimeout(callback, ms) {
			timed.push(ms);
			callback();
			return 1;
		},
		clearTimeout() {},
	};
	const { registry } = fakeRegistry({
		models: { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" } },
		complete: () => new Promise(() => {}),
	});
	const summarizer = createSummarizer({ getRegistry: () => registry, timer });

	assert.equal(await summarizer.run(REQUEST), null);
	assert.deepEqual(timed, [60000]);
});

test("summarize defaults to a 30 s hedge between models", async () => {
	const timer = manualTimer();
	const { registry } = fakeRegistry({ models: { [HAIKU]: BOTH_MODELS[HAIKU], [LUNA]: BOTH_MODELS[LUNA] }, complete: () => new Promise(() => {}) });
	const summarizer = createSummarizer({ getRegistry: () => registry, timer, models: [HAIKU, LUNA] });

	const running = summarizer.run(REQUEST);
	await tick();
	assert.deepEqual(timer.scheduled.map((entry) => entry.ms), [30000, 60000]);
	timer.fire(60000);
	assert.equal(await running, null);
});

/** A timer the test drives by hand: nothing fires unless `fire(ms)` says so. */
function manualTimer() {
	const scheduled = [];
	return {
		scheduled,
		setTimeout(callback, ms) {
			const entry = { callback, ms, cleared: false };
			scheduled.push(entry);
			return entry;
		},
		clearTimeout(entry) {
			entry.cleared = true;
		},
		fire(ms) {
			const entry = scheduled.find((candidate) => candidate.ms === ms && !candidate.cleared);
			assert.ok(entry, `no live timer for ${ms} ms`);
			entry.cleared = true;
			entry.callback();
		},
	};
}

/** One turn of the event loop, enough for the summarizer's awaited steps to reach their timers. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const BOTH_MODELS = { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" }, [LUNA]: { provider: "chatgpt-subscription", id: "gpt-6-luna-fast" } };

test("summarize starts the next model when the first has not answered within hedgeMs, and the first answer wins", async () => {
	const timer = manualTimer();
	const signals = {};
	const { registry, calls } = fakeRegistry({
		models: BOTH_MODELS,
		complete: (model, _context, options) => {
			signals[model.id] = options.signal;
			return model.id === "claude-haiku-4-5" ? new Promise(() => {}) : Promise.resolve(message(text("빠른 답")));
		},
	});
	const lines = [];
	let clock = 0;
	const summarizer = createSummarizer({ getRegistry: () => registry, timer, models: [HAIKU, LUNA], hedgeMs: 7000, timeoutMs: 60000, now: () => clock, log: (line) => lines.push(line) });

	const running = summarizer.run(REQUEST);
	await tick();
	assert.equal(calls.complete.length, 1, "only the preferred model at first");
	assert.deepEqual(timer.scheduled.map((entry) => entry.ms), [7000, 60000]);

	clock = 7000;
	timer.fire(7000);
	assert.deepEqual(await running, { text: "빠른 답", model: LUNA });
	assert.equal(calls.complete.length, 2);
	assert.equal(signals["claude-haiku-4-5"].aborted, true, "the loser is aborted");
	assert.ok(timer.scheduled.every((entry) => entry.cleared), "every timer is cleared once settled");
	assert.deepEqual(lines, [`summarize: ${LUNA}: answered in 7000 ms`]);
});

test("summarize does not start the second model when the first answers in time", async () => {
	const timer = manualTimer();
	const { registry, calls } = fakeRegistry({ models: BOTH_MODELS, complete: async () => message(text("대답")) });
	const summarizer = createSummarizer({ getRegistry: () => registry, timer, models: [HAIKU, LUNA] });

	assert.deepEqual(await summarizer.run(REQUEST), { text: "대답", model: HAIKU });
	assert.equal(calls.complete.length, 1);
	assert.ok(timer.scheduled.length > 0 && timer.scheduled.every((entry) => entry.cleared));
});

test("summarize starts the next model at once when the first one fails", async () => {
	const timer = manualTimer();
	const { registry, calls } = fakeRegistry({
		models: BOTH_MODELS,
		complete: async (model) => (model.id === "claude-haiku-4-5" ? { stopReason: "error", errorMessage: "529", content: [] } : message(text("대안 답"))),
	});
	const lines = [];
	const summarizer = createSummarizer({ getRegistry: () => registry, timer, models: [HAIKU, LUNA], log: (line) => lines.push(line) });

	assert.deepEqual(await summarizer.run(REQUEST), { text: "대안 답", model: LUNA });
	assert.equal(calls.complete.length, 2);
	assert.match(lines[0], /claude-haiku-4-5: 529/);
	assert.match(lines[1], /gpt-6-luna-fast: answered in/);
});

test("summarize times out the whole request when every started model stays silent, and a late answer logs nothing", async () => {
	const timer = manualTimer();
	const finishers = [];
	const { registry } = fakeRegistry({
		models: BOTH_MODELS,
		complete: () => new Promise((resolve) => finishers.push(resolve)),
	});
	const lines = [];
	const summarizer = createSummarizer({ getRegistry: () => registry, timer, models: [HAIKU, LUNA], hedgeMs: 5, timeoutMs: 9, log: (line) => lines.push(line) });

	const running = summarizer.run(REQUEST);
	await tick();
	timer.fire(5);
	await tick();
	timer.fire(9);
	assert.equal(await running, null);
	assert.equal(lines.length, 1);
	assert.match(lines[0], new RegExp(`${HAIKU}, ${LUNA}: timed out after 9 ms`));

	for (const finish of finishers) finish(message(text("너무 늦음")));
	await tick();
	assert.equal(lines.length, 1, "a late answer after the timeout stays silent");
});

test("summarize returns null once, quietly, when the only started model failed and no other is left", async () => {
	const { registry } = fakeRegistry({ models: { [HAIKU]: BOTH_MODELS[HAIKU] }, complete: async () => ({ stopReason: "error", errorMessage: "429", content: [] }) });
	const lines = [];
	const summarizer = createSummarizer({ getRegistry: () => registry, timer: manualTimer(), log: (line) => lines.push(line) });

	assert.equal(await summarizer.run(REQUEST), null);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /429/);
});

test("summarize returns null on an empty answer and on a provider error", async () => {
	const lines = [];
	const empty = createSummarizer({
		getRegistry: () => fakeRegistry({ models: { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" } }, complete: async () => message({ type: "thinking", text: "생각만" }) }).registry,
		log: (line) => lines.push(line),
	});
	assert.equal(await empty.run(REQUEST), null);
	assert.match(lines[0], /empty response/);

	const failed = createSummarizer({
		getRegistry: () => fakeRegistry({ models: { [HAIKU]: { provider: "anthropic-subscription", id: "claude-haiku-4-5" } }, complete: async () => ({ stopReason: "error", errorMessage: "429", content: [] }) }).registry,
		log: (line) => lines.push(line),
	});
	assert.equal(await failed.run(REQUEST), null);
	assert.match(lines[1], /429/);
});

test("summary queue starts summaries at once and runs lines one at a time in order", async () => {
	const started = [];
	const gates = new Map();
	const queue = createSummaryQueue((request) => {
		started.push(request.tag);
		return new Promise((resolve) => gates.set(request.tag, resolve));
	});

	const a = queue.run({ purpose: "line", tag: "a" });
	const b = queue.run({ purpose: "line", tag: "b" });
	const c = queue.run({ purpose: "line", tag: "c" });
	assert.deepEqual(started, ["a"], "one line at a time");

	const summary = queue.run({ tag: "summary" });
	assert.deepEqual(started, ["a", "summary"], "a request without purpose is a summary and starts at once");

	gates.get("summary")({ text: "summary" });
	assert.deepEqual(await summary, { text: "summary" });
	await tick();
	assert.deepEqual(started, ["a", "summary"], "queued lines wait for the running line, not only the summary");

	gates.get("a")({ text: "a" });
	assert.deepEqual(await a, { text: "a" });
	await tick();
	assert.deepEqual(started, ["a", "summary", "b"]);

	gates.get("b")({ text: "b" });
	assert.deepEqual(await b, { text: "b" });
	await tick();
	assert.deepEqual(started, ["a", "summary", "b", "c"]);
	gates.get("c")({ text: "c" });
	assert.deepEqual(await c, { text: "c" });
});

test("summary queue keeps only the newest three pending lines and resolves the dropped ones null", async () => {
	const started = [];
	const gates = {};
	const queue = createSummaryQueue((request) => {
		started.push(request.tag);
		return new Promise((resolve) => {
			gates[request.tag] = resolve;
		});
	});

	const results = [queue.run({ purpose: "line", tag: "line0" })];
	for (let index = 1; index <= 5; index += 1) results.push(queue.run({ purpose: "line", tag: `line${index}` }));

	assert.deepEqual(await Promise.all(results.slice(1, 3)), [null, null], "the two oldest pending lines are dropped");
	assert.deepEqual(started, ["line0"]);

	gates.line0({ text: "line0" });
	await results[0];
	await tick();
	assert.deepEqual(started, ["line0", "line3"], "the kept lines start oldest first");

	gates.line3({ text: "line3" });
	await results[3];
	await tick();
	assert.deepEqual(started, ["line0", "line3", "line4"]);

	gates.line4({ text: "line4" });
	await results[4];
	await tick();
	assert.deepEqual(started, ["line0", "line3", "line4", "line5"]);

	gates.line5({ text: "line5" });
	assert.deepEqual(await results[5], { text: "line5" });
});

test("summary queue serves one summary before five queued lines (fake clock)", async () => {
	let clock = 0;
	const started = [];
	const gates = [];
	const queue = createSummaryQueue((request) => {
		if (request.purpose === "line") {
			started.push(request.tag);
			return new Promise((resolve) => {
				gates.push(() => {
					clock += 5000;
					resolve({ text: request.tag });
				});
			});
		}
		started.push("summary");
		return { text: "summary", at: clock };
	});

	const lines = [];
	for (let index = 0; index < 5; index += 1) lines.push(queue.run({ purpose: "line", tag: `line${index}` }));
	assert.deepEqual(started, ["line0"]);

	assert.deepEqual(await queue.run({ purpose: "summary" }), { text: "summary", at: 0 });
	assert.equal(clock, 0, "the summary did not wait for a line call");
	assert.deepEqual(started, ["line0", "summary"], "the summary was served before the five lines");
	assert.equal(await lines[1], null, "the oldest pending line still obeyed the three-line bound");

	gates.shift()();
	await lines[0];
	await tick();
	for (const index of [2, 3, 4]) {
		gates.shift()();
		assert.deepEqual(await lines[index], { text: `line${index}` });
		await tick();
	}
});

test("summary queue serves a summary immediately with ten queued lines (fake clock)", async () => {
	let clock = 0;
	const started = [];
	const lineGates = [];
	const queue = createSummaryQueue((request) => {
		if (request.purpose === "line") {
			started.push(request.tag);
			return new Promise((resolve) => {
				lineGates.push(() => {
					clock += 15_000;
					resolve({ text: request.tag });
				});
			});
		}
		started.push("summary");
		return { text: "summary", at: clock };
	});

	const lines = [];
	for (let index = 0; index < 10; index += 1) lines.push(queue.run({ purpose: "line", tag: `line${index}` }));
	assert.deepEqual(started, ["line0"], "only the first line started");

	assert.deepEqual(await queue.run({ purpose: "summary" }), { text: "summary", at: 0 });
	assert.equal(clock, 0, "the summary did not wait for 15 s model calls");
	assert.deepEqual(started, ["line0", "summary"], "the summary started before any queued line finished");

	lineGates.shift()();
	await lines[0];
	await tick();
	assert.deepEqual(started, ["line0", "summary", "line7"], "only the newest three lines remained queued");
	for (const index of [7, 8, 9]) {
		lineGates.shift()();
		assert.deepEqual(await lines[index], { text: `line${index}` });
		await tick();
	}
});

test("cache tracker computes warmUntil = now + ttl * 1000 and flags a move over 30 s", () => {
	let clock = 1_000_000;
	const tracker = createCacheTracker({ ttlSeconds: () => 300, now: () => clock });

	// The first reply of a generation always counts as a move.
	assert.deepEqual(tracker.onAssistantStart({ model: { id: "m" } }), { warmUntil: 1_300_000, ttlSec: 300, moved: true });
	assert.deepEqual(tracker.onAssistantStart({ model: { id: "m" } }), { warmUntil: 1_300_000, ttlSec: 300, moved: false });

	// Exactly 30 s is not "more than 30 s".
	clock += CACHE_MOVE_MS;
	assert.deepEqual(tracker.onAssistantStart({ model: { id: "m" } }), { warmUntil: 1_330_000, ttlSec: 300, moved: false });

	clock += CACHE_MOVE_MS + 2;
	assert.deepEqual(tracker.onAssistantStart({ model: { id: "m" } }), { warmUntil: 1_360_002, ttlSec: 300, moved: true });
});

test("cache tracker answers null when senpi knows no TTL", () => {
	const unknown = createCacheTracker({ ttlSeconds: () => undefined, now: () => 1 });
	assert.equal(unknown.onAssistantStart({ model: {} }), null);

	const absent = createCacheTracker({ now: () => 1 });
	assert.equal(absent.onAssistantStart({ model: {} }), null);

	const zero = createCacheTracker({ ttlSeconds: () => 0, now: () => 1 });
	assert.equal(zero.onAssistantStart({ model: {} }), null);

	const nan = createCacheTracker({ ttlSeconds: () => Number.NaN, now: () => 1 });
	assert.equal(nan.onAssistantStart({ model: {} }), null);

	const throwing = createCacheTracker({ ttlSeconds: () => {
		throw new Error("no such model");
	}, now: () => 1 });
	assert.equal(throwing.onAssistantStart({ model: {} }), null);

	assert.equal(unknown.onAssistantStart(undefined), null);
});
