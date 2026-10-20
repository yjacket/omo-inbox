import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createServer } from "../src/server.mjs";
import { createPusher } from "../src/push.mjs";
import { identityFor } from "../src/identity.mjs";
import { safeSegment } from "../src/paths.mjs";
import { topicFor } from "../src/policy.mjs";

const START = Date.parse("2026-10-17T00:00:00Z");
const TAILNET = { "x-forwarded-for": "100.64.0.50", "tailscale-user-login": "owner@example.com" };
const CSP =
	"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'";

function fakeTimers() {
	const timers = new Map();
	let next = 1;
	return {
		timers,
		setTimer(fn, ms) {
			const id = next++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimer(id) {
			timers.delete(id);
		},
		// Fire every armed timer whose delay has elapsed on the fake clock.
		runDue(elapsedMs) {
			for (const [id, timer] of [...timers.entries()]) {
				if (timer.ms > elapsedMs) continue;
				timers.delete(id);
				timer.fn();
			}
		},
	};
}

function subscription() {
	const ecdh = crypto.createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		endpoint: "https://push.example.invalid/send/abc",
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function withServer(t, options = {}) {
	const tmp = options.tmp ?? makeTmpHome("inbox-items-");
	const clock = options.clock ?? { at: START };
	const timers = fakeTimers();
	const sink = path.join(tmp.home, "push-sink.jsonl");
	const pusher = createPusher({ dir: path.join(tmp.home, "push"), sink, now: () => clock.at });
	pusher.subscribe(subscription());
	const server = createServer({
		home: tmp.home,
		webDir: options.webDir ?? path.join(tmp.home, "web"),
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: ["100.64.0.9"], ...(options.config ?? {}) },
		now: options.now ?? (() => new Date(clock.at)),
		pusher,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		onIdle: options.onIdle ?? (() => {}),
	});
	const { port } = await server.listen();
	t.after(async () => {
		await server.close();
		if (!options.keepHome) tmp.cleanup();
	});
	const pushes = () =>
		fs.existsSync(sink)
			? fs.readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
			: [];
	return { tmp, home: tmp.home, server, clock, timers, pushes, base: `http://127.0.0.1:${port}` };
}

function post(ctx, p, body, headers = {}) {
	return fetch(ctx.base + p, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1", ...headers },
		body: JSON.stringify(body),
	});
}

async function postJson(ctx, p, body, headers = {}) {
	const res = await post(ctx, p, body, headers);
	return { status: res.status, body: await res.json() };
}

async function getJson(ctx, p, headers = {}) {
	const res = await fetch(ctx.base + p, { headers });
	return { status: res.status, body: await res.json() };
}

function questionInput(requestId = "r1", overrides = {}) {
	return {
		kind: "question",
		policy: "needs-you",
		dedupeKey: `q:${requestId}`,
		raw: {
			request: {
				requestId,
				questions: [
					{
						id: "q1",
						header: "방식",
						question: "어느 쪽으로 할까요?",
						options: [
							{ label: "A안 (권장)", description: "빠름" },
							{ label: "B안", description: "느림" },
						],
						multiSelect: false,
					},
				],
				waitForAnswer: true,
				required: false,
				timeoutMs: 600000,
				askedAt: START,
			},
		},
		meta: null,
		...overrides,
	};
}

const turnInput = (text = "작업을 끝냈습니다. 다음으로 무엇을 할까요?", key = "turn:s1:1:1") => ({
	kind: "turn",
	policy: "needs-you",
	dedupeKey: key,
	raw: { text },
	meta: null,
});

function makeBoard(home, name) {
	const dir = path.join(home, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "board.json"),
		JSON.stringify({
			title: "테스트 보드",
			sections: [{ title: "화면", cards: [{ title: "로그인", frames: [["로그인 화면", "screen.svg"]] }] }],
			questions: [{ id: "q1", text: "어떻게?", options: [{ value: "a", label: "A안" }, { value: "b", label: "B안" }] }],
		}),
	);
	fs.writeFileSync(path.join(dir, "screen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	return dir;
}

async function submitBoard(ctx, session) {
	const srcDir = makeBoard(ctx.home, `board-${session}`);
	const identity = await identityFor(srcDir, {});
	return postJson(ctx, "/api/proposals", {
		cwd: srcDir,
		identity: { ...identity, session: { id: session, file: null } },
		title: "보드",
		srcDir,
	});
}

test("items POST dedupes, stores a heuristic summary and returns a summary request by policy", async (t) => {
	const ctx = await withServer(t);
	const first = await postJson(ctx, "/api/threads/s1/items", questionInput());
	assert.equal(first.status, 200);
	assert.equal(first.body.created, true);
	assert.match(first.body.item.itemId, /^i-\d{6}-[a-z0-9]{6}$/);
	assert.equal(first.body.item.id, first.body.item.itemId, "the extension reads item.id");
	assert.equal(first.body.item.summary.source, "heuristic");
	assert.equal(typeof first.body.summaryRequest.system, "string");
	assert.equal(first.body.summaryRequest.maxTokens, 700);
	assert.deepEqual(first.body.summaryConfig, {
		enabled: true,
		models: ["anthropic-subscription/claude-sonnet-5", "chatgpt-subscription/gpt-6-luna-fast", "anthropic-subscription/claude-haiku-4-5"],
	});

	const again = await postJson(ctx, "/api/threads/s1/items", questionInput());
	assert.equal(again.body.created, false);
	assert.equal(again.body.item.itemId, first.body.item.itemId);
	assert.equal(again.body.summaryRequest, null);

	const progress = await postJson(ctx, "/api/threads/s1/items", { kind: "progress", policy: "progress", dedupeKey: "turn:s1:1:2", raw: { text: "진행 중" } });
	assert.equal(progress.body.created, true);
	assert.equal(progress.body.summaryRequest.purpose, "line");
	assert.equal(progress.body.item.summary.source, "heuristic");

	const bad = await postJson(ctx, "/api/threads/s1/items", { kind: "weird", policy: "needs-you" });
	assert.equal(bad.status, 400);
});

test("summary config disabled means no summary request", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput());
	assert.equal(out.body.summaryRequest, null);
	assert.equal(out.body.summaryConfig.enabled, false);
});

test("session routes reject tailnet and pc callers; read and feedback routes accept them", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const itemId = body.item.itemId;
	const sessionRoutes = [
		["/api/threads/s1/items", turnInput("x", "k2")],
		[`/api/items/${itemId}/summary`, { text: "{}" }],
		[`/api/items/${itemId}/close`, { reason: "x" }],
		["/api/threads/s1/activity", { source: "agent-start" }],
		["/api/threads/s1/cache", { warmUntil: START + 600000, ttlSec: 600 }],
		["/api/threads/s1/meta", { title: "x" }],
		[`/api/items/${itemId}/delivered`, { deliveryId: "d", how: "message" }],
		[`/api/items/${itemId}/bridge`, { state: "none" }],
		["/api/notices", { v: 1, producer: "p", dedupeKey: "k", title: "t", body: "", urgency: "now" }],
	];
	for (const [route, payload] of sessionRoutes) {
		for (const headers of [TAILNET, { "x-forwarded-for": "100.64.0.9" }]) {
			const res = await post(ctx, route, payload, headers);
			assert.equal(res.status, 403, `${route} must be session-only`);
		}
	}
	const noGuard = await fetch(`${ctx.base}/api/threads/s1/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(turnInput()) });
	assert.equal(noGuard.status, 403, "POST without x-inbox is refused");

	assert.equal((await getJson(ctx, "/api/threads", TAILNET)).status, 200);
	assert.equal((await getJson(ctx, "/api/threads/s1", TAILNET)).status, 200);
	assert.equal((await getJson(ctx, `/api/items/${itemId}`, TAILNET)).status, 200);
	const read = await postJson(ctx, "/api/threads/s1/read", { seq: 3 }, TAILNET);
	assert.equal(read.status, 200);
	const answer = await postJson(ctx, `/api/items/${itemId}/answer`, { text: "계속해" }, TAILNET);
	assert.equal(answer.status, 200);
	assert.equal(answer.body.ok, true);
	assert.equal((await post(ctx, `/api/items/${itemId}/answer`, { text: "x" }, { "x-forwarded-for": "100.64.0.77" })).status, 403, "an unknown forwarder is rejected");
});

test("bridge state is stored on the item and validated", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", questionInput());
	const itemId = body.item.itemId;
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.bridge, null);
	assert.equal((await postJson(ctx, `/api/items/${itemId}/bridge`, { state: "none" })).status, 200);
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.bridge, "none");
	assert.equal((await postJson(ctx, `/api/items/${itemId}/bridge`, { state: "weird" })).status, 400);
});

test("summary POST stores a valid model summary and keeps the heuristic on invalid input", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const itemId = body.item.itemId;
	const invalid = await postJson(ctx, `/api/items/${itemId}/summary`, { text: "not json", model: "m" });
	assert.deepEqual(invalid.body, { ok: false });
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.summary.source, "heuristic");

	const text = JSON.stringify({ kind: "report", headline: "끝났습니다", context: "c", body: "b", ask: null, options: [], ifNoAnswer: null, terms: [], title: "로그인 개선" });
	const ok = await postJson(ctx, `/api/items/${itemId}/summary`, { text, model: "anthropic-subscription/claude-haiku-4-5", simpler: false });
	assert.equal(ok.body.ok, true);
	assert.equal(ok.body.summary.headline, "끝났습니다");
	const item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.summary.source, "model");
	assert.equal(item.summary.model, "anthropic-subscription/claude-haiku-4-5");
	assert.equal((await getJson(ctx, "/api/threads/s1")).body.thread.title, "로그인 개선");
});

test("answer writes the mailbox file, validates against the request and refuses closed items", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", questionInput());
	const itemId = body.item.itemId;

	const incomplete = await postJson(ctx, `/api/items/${itemId}/answer`, { answers: {} });
	assert.equal(incomplete.status, 400);
	assert.equal(incomplete.body.error, "question_incomplete");
	const unknown = await postJson(ctx, `/api/items/${itemId}/answer`, { answers: { q1: { selected: ["C안"] } } });
	assert.equal(unknown.body.error, "invalid_answer");
	const many = await postJson(ctx, `/api/items/${itemId}/answer`, { answers: { q1: { selected: ["A안 (권장)", "B안"] } } });
	assert.equal(many.status, 400);
	assert.equal(many.body.error, "invalid_answer");

	const ok = await postJson(ctx, `/api/items/${itemId}/answer`, { answers: { q1: { selected: ["B안"] } } });
	assert.equal(ok.status, 200);
	const mailboxDir = path.join(ctx.home, "mailbox", safeSegment("s1"));
	const files = fs.readdirSync(mailboxDir);
	assert.equal(files.length, 1);
	assert.match(files[0], new RegExp(`^${itemId}-\\d{6}\\.json$`));
	const mail = JSON.parse(fs.readFileSync(path.join(mailboxDir, files[0]), "utf8"));
	assert.equal(mail.type, "item-answer");
	assert.equal(mail.kind, "question");
	assert.equal(mail.deliveryId, ok.body.deliveryId);
	assert.equal(mail.requestId, "r1");
	assert.deepEqual(mail.payload, { answers: { q1: { selected: ["B안"] } } });
	assert.equal(mail.text, "방식: B안");

	await postJson(ctx, `/api/items/${itemId}/close`, { reason: "answered-terminal", resolvedBy: "terminal" });
	const closed = await postJson(ctx, `/api/items/${itemId}/answer`, { comment: "늦었다" });
	assert.equal(closed.status, 409);
	assert.deepEqual(closed.body, { error: "closed", reason: "answered-terminal" });
});

test("an HTML-looking item body comes back verbatim as JSON", async (t) => {
	const ctx = await withServer(t);
	const html = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput(html));
	const res = await fetch(`${ctx.base}/api/items/${body.item.itemId}`);
	assert.match(res.headers.get("content-type"), /^application\/json/);
	const item = await res.json();
	assert.equal(item.raw.text, html);
	const thread = await getJson(ctx, "/api/threads/s1");
	assert.equal(thread.body.items[0].raw.text, html);
});

test("GET responses redact secrets in raw text and summaries", async (t) => {
	const ctx = await withServer(t);
	const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput(`키는 ${secret} 입니다`));
	const item = (await getJson(ctx, `/api/items/${body.item.itemId}`)).body;
	assert.ok(!JSON.stringify(item).includes(secret));
	const thread = (await getJson(ctx, "/api/threads/s1")).body;
	assert.ok(!JSON.stringify(thread).includes(secret));
});

test("delivered acks settle the answer; an unacked answer is reported unconfirmed after 60 s", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const itemId = body.item.itemId;
	const first = await postJson(ctx, `/api/items/${itemId}/answer`, { text: "계속해" });
	ctx.clock.at += 61_000;
	let item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.status, "answered");
	assert.equal(item.deliveryUnconfirmed, true);
	const bad = await postJson(ctx, `/api/items/${itemId}/delivered`, { deliveryId: first.body.deliveryId, how: "teleport" });
	assert.equal(bad.status, 400);
	const acked = await postJson(ctx, `/api/items/${itemId}/delivered`, { deliveryId: first.body.deliveryId, how: "message", detail: null });
	assert.equal(acked.body.status, "delivered");
	item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.deliveryUnconfirmed, false);
	assert.deepEqual(item.deliveredIds, [first.body.deliveryId]);
});

test("the hold-off push fires through the fake clock into the push sink with the session topic", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const { body } = await postJson(ctx, "/api/threads/s1/items", questionInput());
	const itemId = body.item.itemId;
	assert.deepEqual(ctx.server.scheduler.pending(), [{ key: `item:${itemId}`, atMs: START + 15_000 }]);
	ctx.timers.runDue(14_999);
	await flush();
	assert.equal(ctx.pushes().length, 0, "nothing goes out inside the hold");
	ctx.clock.at += 15_000;
	ctx.timers.runDue(15_000);
	await flush();
	const pushes = ctx.pushes();
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].topic, topicFor("s1"));
	assert.equal(pushes[0].payload.itemId, itemId);
	assert.equal(pushes[0].payload.url, `/s/s1#${itemId}`);
	assert.equal(pushes[0].payload.tag, "s-s1");
	assert.deepEqual(pushes[0].payload.actions.map((action) => action.action), ["rec", "open"]);
	assert.deepEqual(pushes[0].payload.rec, { questionId: "q1", label: "A안 (권장)" });
});

test("activity supersedes turn items and cancels their pending push", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	assert.equal(ctx.server.scheduler.pending().length, 1);
	const activity = await postJson(ctx, "/api/threads/s1/activity", { source: "terminal-input" });
	assert.equal(activity.body.superseded, 1);
	assert.deepEqual(ctx.server.scheduler.pending(), []);
	ctx.clock.at += 30_000;
	ctx.timers.runDue(Infinity);
	await flush();
	assert.equal(ctx.pushes().length, 0);
	const item = (await getJson(ctx, `/api/items/${body.item.itemId}`)).body;
	assert.equal(item.status, "closed");
	assert.equal(item.closedReason, "superseded");
});

test("an answer cancels the item's pending push", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	await postJson(ctx, `/api/items/${body.item.itemId}/answer`, { text: "멈춰" });
	assert.deepEqual(ctx.server.scheduler.pending(), []);
});

test("the cache reminder fires once per item and warmUntil", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const itemId = body.item.itemId;
	await postJson(ctx, `/api/items/${itemId}/answer`, { text: "x" });
	// An answered item never reminds; a fresh open turn does.
	const fresh = await postJson(ctx, "/api/threads/s1/items", turnInput("다 했습니다", "turn:s1:1:9"));
	const freshId = fresh.body.item.itemId;
	const warmUntil = START + 10 * 60_000;
	await postJson(ctx, "/api/threads/s1/cache", { warmUntil, ttlSec: 600 });
	await postJson(ctx, "/api/threads/s1/cache", { warmUntil, ttlSec: 600 });
	const cacheKeys = ctx.server.scheduler.pending().filter((entry) => entry.key.startsWith("cache:"));
	assert.deepEqual(cacheKeys, [{ key: `cache:${freshId}:${warmUntil}`, atMs: warmUntil - 5 * 60_000 }]);

	ctx.clock.at = warmUntil - 5 * 60_000;
	for (const [id, timer] of [...ctx.timers.timers.entries()]) {
		if (timer.ms !== 5 * 60_000) continue;
		ctx.timers.timers.delete(id);
		timer.fn();
	}
	await flush();
	const reminders = ctx.pushes().filter((line) => line.payload.title.startsWith("🔥"));
	assert.equal(reminders.length, 1);
	assert.equal(reminders[0].payload.title, "🔥 캐시가 5분 뒤 식습니다");
	assert.equal(reminders[0].payload.itemId, freshId);

	await postJson(ctx, "/api/threads/s1/cache", { warmUntil, ttlSec: 600 });
	assert.equal(ctx.server.scheduler.pending().filter((entry) => entry.key.startsWith("cache:")).length, 0, "the same warmUntil never reminds twice");
});

test("config.cacheLeadMinutes sets how early the cache reminder fires", async (t) => {
	const ctx = await withServer(t, { config: { cacheLeadMinutes: 2 } });
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const warmUntil = START + 10 * 60_000;
	await postJson(ctx, "/api/threads/s1/cache", { warmUntil, ttlSec: 600 });
	const cacheKeys = ctx.server.scheduler.pending().filter((entry) => entry.key.startsWith("cache:"));
	assert.deepEqual(cacheKeys, [{ key: `cache:${body.item.itemId}:${warmUntil}`, atMs: warmUntil - 2 * 60_000 }]);
});

test("a closed bye ends the thread: open items close as session-closed and their pushes are cancelled; a plain bye keeps them", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const itemId = body.item.itemId;
	await postJson(ctx, "/api/threads/s2/items", turnInput("끝", "turn:s2:1:1"));
	assert.deepEqual((await postJson(ctx, "/api/bye", { session: "s2" })).body, { ok: true });
	assert.deepEqual((await postJson(ctx, "/api/bye", { session: "s1", closed: true })).body, { ok: true });
	const rows = (await getJson(ctx, "/api/threads")).body.items;
	assert.equal(rows.find((row) => row.session === "s1").status, "ended");
	assert.equal(rows.find((row) => row.session === "s2").status, "needs-you", "a reload's bye keeps the turn open");
	const item = (await getJson(ctx, "/api/threads/s1")).body.items.find((entry) => (entry.id ?? entry.itemId) === itemId);
	assert.equal(item.status, "closed");
	assert.equal(item.closedReason, "session-closed");
	assert.equal(ctx.server.scheduler.pending().filter((entry) => entry.key.includes(itemId)).length, 0);
	assert.deepEqual((await postJson(ctx, "/api/bye", { session: "missing", closed: true })).body, { ok: true }, "an unknown session is fine");
});

test("last /api/here liveness survives a server restart for one window", async (t) => {
	const tmp = makeTmpHome("inbox-live-restart-");
	const clock = { at: START };
	let first;
	let second;
	let third;
	try {
		first = await withServer(t, { tmp, clock, keepHome: true, config: { summary: { enabled: false } } });
		await getJson(first, `/api/here?session=live-restart&cwd=${encodeURIComponent(process.cwd())}`);
		await postJson(first, "/api/threads/live-restart/items", turnInput("모두 끝났습니다.", "turn:live-restart:1:1"));
		await first.server.close();

		clock.at = START + 60_000;
		second = await withServer(t, { tmp, clock, keepHome: true, config: { summary: { enabled: false } } });
		let row = (await getJson(second, "/api/threads")).body.items.find((item) => item.session === "live-restart");
		assert.equal(row.status, "needs-you");
		assert.equal(row.live, true);

		clock.at = START + 120_000;
		await second.server.close();
		third = await withServer(t, { tmp, clock, keepHome: true, config: { summary: { enabled: false } } });
		row = (await getJson(third, "/api/threads")).body.items.find((item) => item.session === "live-restart");
		assert.equal(row.status, "ended");
		assert.equal(row.live, false);
	} finally {
		await first?.server.close();
		await second?.server.close();
		await third?.server.close();
		tmp.cleanup();
	}
});

test("a plain bye keeps an idle thread working during reload grace only", async (t) => {
	const ctx = await withServer(t);
	await postJson(ctx, "/api/threads/reload-idle/meta", { cwd: ctx.home });
	await postJson(ctx, "/api/bye", { session: "reload-idle" });
	let row = (await getJson(ctx, "/api/threads")).body.items.find((item) => item.session === "reload-idle");
	assert.equal(row.status, "working");
	assert.equal(row.live, true);
	ctx.clock.at += 90_001;
	row = (await getJson(ctx, "/api/threads")).body.items.find((item) => item.session === "reload-idle");
	assert.equal(row.status, "ended");
	assert.equal(row.live, false);
});

test("an English session name is not the title; the model's Korean title replaces the request fallback", async (t) => {
	const ctx = await withServer(t);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: ctx.home, sessionName: "Verify omo package", firstRequest: "패키지 확인해 줘" });
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	assert.equal((await getJson(ctx, "/api/threads")).body.items[0].title, "요청: 패키지 확인해 줘");
	const summary = { kind: "report", headline: "패키지 확인을 끝냈습니다", context: "요청: 패키지 확인", body: "확인을 마쳤습니다.", ask: null, options: [], ifNoAnswer: null, terms: [], title: "패키지 확인" };
	await postJson(ctx, `/api/items/${body.item.itemId}/summary`, { text: JSON.stringify(summary), model: "qa/stub" });
	assert.equal((await getJson(ctx, "/api/threads")).body.items[0].title, "패키지 확인");
	await postJson(ctx, "/api/threads/s2/meta", { cwd: ctx.home, sessionName: "결제 작업" });
	await postJson(ctx, "/api/threads/s2/items", turnInput("끝", "turn:s2:1:1"));
	assert.equal((await getJson(ctx, "/api/threads")).body.items.find((row) => row.session === "s2").title, "결제 작업", "a Korean session name stays the title");
});

test("a notice with the same dedupeKey supersedes the open one; an fyi notice never pushes", async (t) => {
	const ctx = await withServer(t);
	const notice = { v: 1, producer: "ci-watch", dedupeKey: "build:42", title: "빌드 실패", body: "main", urgency: "now" };
	const first = await postJson(ctx, "/api/notices", notice);
	assert.equal(first.status, 200);
	assert.equal(first.body.item.kind, "notice");
	assert.equal(first.body.item.policy, "needs-you");
	const second = await postJson(ctx, "/api/notices", { ...notice, title: "빌드 다시 실패" });
	assert.equal(second.body.created, true);
	const old = (await getJson(ctx, `/api/items/${first.body.item.itemId}`)).body;
	assert.equal(old.status, "closed");
	assert.equal(old.closedReason, "superseded");
	const thread = (await getJson(ctx, "/api/threads/_notices")).body;
	assert.equal(thread.thread.title, "알림");

	ctx.timers.runDue(0);
	await flush();
	assert.deepEqual(ctx.pushes().map((line) => line.payload.itemId), [second.body.item.itemId], "the superseded notice never pushes");

	const fyi = await postJson(ctx, "/api/notices", { ...notice, dedupeKey: "info:1", urgency: "fyi" });
	assert.equal(fyi.body.item.policy, "fyi");
	assert.equal(ctx.server.scheduler.pending().some((entry) => entry.key === `item:${fyi.body.item.itemId}`), false);
	ctx.timers.runDue(Infinity);
	await flush();
	assert.equal(ctx.pushes().some((line) => line.payload.itemId === fyi.body.item.itemId), false);

	const invalid = await postJson(ctx, "/api/notices", { v: 1, producer: "BAD", title: "", urgency: "loud" });
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error, "invalid_notice");
	assert.ok(invalid.body.details.length >= 3);
});

test("an expired notice closes with reason expired on read", async (t) => {
	const ctx = await withServer(t);
	const out = await postJson(ctx, "/api/notices", {
		v: 1, producer: "p", dedupeKey: "k", title: "t", body: "", urgency: "soon", expiresAt: new Date(START + 60_000).toISOString(),
	});
	ctx.clock.at = START + 60_000;
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.status, "closed");
	assert.equal(item.closedReason, "expired");
});

test("free message answers the open turn or creates a synthetic one; explain needs a live session", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const msg = await postJson(ctx, "/api/threads/s1/message", { text: "계속해" }, TAILNET);
	assert.equal(msg.status, 200);
	assert.equal(msg.body.itemId, body.item.itemId);
	const free = await postJson(ctx, "/api/threads/s1/message", { text: "하나 더" });
	assert.notEqual(free.body.itemId, body.item.itemId);
	const synthetic = (await getJson(ctx, `/api/items/${free.body.itemId}`)).body;
	assert.equal(synthetic.kind, "turn");
	assert.equal(synthetic.policy, "quiet");
	assert.equal(synthetic.status, "answered");
	assert.equal((await post(ctx, "/api/threads/nope/message", { text: "x" })).status, 404);

	const notLive = await postJson(ctx, `/api/items/${body.item.itemId}/explain`, {}, TAILNET);
	assert.equal(notLive.status, 409);
	await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(ctx.home)}&session=s1`);
	const live = await postJson(ctx, `/api/items/${body.item.itemId}/explain`, {}, TAILNET);
	assert.deepEqual(live.body, { ok: true });
	const again = await postJson(ctx, `/api/items/${body.item.itemId}/explain`, {}, TAILNET);
	assert.deepEqual(again.body, { ok: true });
	const names = fs.readdirSync(path.join(ctx.home, "mailbox", "s1"));
	const files = names.map((name) => JSON.parse(fs.readFileSync(path.join(ctx.home, "mailbox", "s1", name), "utf8")));
	assert.equal(files.filter((file) => file.type === "explain" && file.itemId === body.item.itemId).length, 2, "two explains keep two files");
	assert.equal(new Set(names).size, names.length);
});

test("an identical answer resend keeps the deliveryId; a different payload gets a new one", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const itemId = body.item.itemId;
	const first = await postJson(ctx, `/api/items/${itemId}/answer`, { text: "계속해" });
	assert.equal(first.status, 200);
	const second = await postJson(ctx, `/api/items/${itemId}/answer`, { text: "계속해" });
	assert.equal(second.status, 200);
	assert.equal(second.body.deliveryId, first.body.deliveryId, "a resend is the same delivery");
	const item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.answers.length, 1, "the resend adds no answer event");
	assert.equal(item.status, "answered");

	const different = await postJson(ctx, `/api/items/${itemId}/answer`, { text: "멈춰" });
	assert.equal(different.status, 200);
	assert.notEqual(different.body.deliveryId, first.body.deliveryId, "a different payload is a new delivery");
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.answers.length, 2);
});

test("activity, summary and cache events do not raise unread; a new item does", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	assert.equal((await getJson(ctx, "/api/threads")).body.items[0].unread, 1);
	const thread = (await getJson(ctx, "/api/threads/s1?since=0")).body;
	await postJson(ctx, "/api/threads/s1/read", { seq: thread.events.at(-1).seq });
	await postJson(ctx, "/api/threads/s1/activity", { source: "agent-start" });
	await postJson(ctx, "/api/threads/s1/cache", { warmUntil: START + 600_000, ttlSec: 300 });
	const summary = JSON.stringify({ kind: "report", headline: "끝났습니다", context: "c", body: "b", ask: null, options: [], ifNoAnswer: null, terms: [], title: null });
	await postJson(ctx, `/api/items/${body.item.itemId}/summary`, { text: summary, model: "m" });
	assert.equal((await getJson(ctx, "/api/threads")).body.items[0].unread, 0);
	await postJson(ctx, "/api/threads/s1/items", { ...turnInput("다음 일", "turn:s1:2:1"), kind: "blocked", raw: { goal: { reason: "막힘", objective: "일" } } });
	assert.equal((await getJson(ctx, "/api/threads")).body.items[0].unread, 1);
});

test("a throwing timer callback logs and the server keeps serving", async (t) => {
	const ctx = await withServer(t);
	ctx.server.scheduler.schedule("boom", ctx.clock.at, () => {
		throw new Error("scheduler boom");
	});
	assert.doesNotThrow(() => ctx.timers.runDue(0));
	const log = fs.readFileSync(path.join(ctx.home, "logs", "server.log"), "utf8");
	assert.match(log, /timer boom failed: .*scheduler boom/);
	const health = await getJson(ctx, "/api/health");
	assert.equal(health.status, 200);
	assert.equal(health.body.name, "omo-inbox");
});

test("threads list rows, counts and meta", async (t) => {
	const ctx = await withServer(t);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: ctx.home, sessionName: "로그인 작업", firstRequest: "로그인 고쳐 줘", lastRequest: "더" });
	await postJson(ctx, "/api/threads/s1/items", turnInput());
	await postJson(ctx, "/api/threads/s2/items", { kind: "progress", policy: "progress", dedupeKey: "p", raw: { text: "진행" } });
	const list = (await getJson(ctx, "/api/threads")).body;
	assert.deepEqual(list.counts, { needsYou: 1, working: 0, ended: 1, hidden: 0 });
	assert.equal(list.items[0].session, "s1");
	assert.equal(list.items[0].title, "로그인 작업");
	assert.equal(list.items[0].status, "needs-you");
	assert.equal((await getJson(ctx, "/api/threads?status=ended")).body.items.length, 1);
	assert.equal((await getJson(ctx, "/api/threads?status=bogus")).status, 400);
	assert.equal((await getJson(ctx, "/api/threads/missing")).status, 404);
});

test("pages send the CSP header and /boards serves the proposal list", async (t) => {
	const tmp = makeTmpHome("inbox-items-web-");
	const webDir = path.join(tmp.home, "web");
	fs.mkdirSync(webDir, { recursive: true });
	fs.writeFileSync(path.join(webDir, "inbox.html"), "<!doctype html><title>threads</title>");
	fs.writeFileSync(path.join(webDir, "thread.html"), "<!doctype html><title>thread</title>");
	fs.writeFileSync(path.join(webDir, "boards.html"), "<!doctype html><title>boards</title>");
	fs.writeFileSync(path.join(webDir, "proposal.html"), "<!doctype html><title>proposal</title>");
	const ctx = await withServer(t, { tmp, webDir });
	for (const [p, title] of [["/s/x", "thread"], ["/", "threads"], ["/boards", "boards"]]) {
		const res = await fetch(ctx.base + p);
		assert.equal(res.status, 200, p);
		assert.equal(res.headers.get("content-security-policy"), CSP, p);
		assert.match(await res.text(), new RegExp(title));
	}
	const proposal = await fetch(`${ctx.base}/p/whatever`);
	assert.equal(proposal.status, 200);
	assert.match(await proposal.text(), /proposal/);
	const tailnet = await fetch(`${ctx.base}/s/x`, { headers: TAILNET });
	assert.equal(tailnet.status, 200);
});

test("board events become board items in the owner's thread and the footer counts both sides", async (t) => {
	const ctx = await withServer(t);
	await postJson(ctx, "/api/threads/s1/items", turnInput());
	const created = await submitBoard(ctx, "sB");
	assert.equal(created.status, 200);
	const id = created.body.summary.id;
	let thread = (await getJson(ctx, "/api/threads/sB")).body;
	assert.equal(thread.items.length, 1);
	assert.equal(thread.items[0].kind, "board");
	assert.equal(thread.items[0].policy, "needs-you");
	assert.equal(thread.items[0].raw.proposalId, id);
	assert.equal(thread.thread.status, "needs-you");
	assert.deepEqual(ctx.server.scheduler.pending().filter((entry) => entry.key === `item:${thread.items[0].itemId}`), [], "boards push through desk notifications");

	const revised = await postJson(ctx, `/api/p/${id}/revise`, { srcDir: path.join(ctx.home, "board-sB"), note: "고쳤어요", session: "sB" });
	assert.equal(revised.status, 200);
	thread = (await getJson(ctx, "/api/threads/sB")).body;
	assert.deepEqual(thread.items.map((item) => item.status), ["closed", "open"]);
	assert.match(thread.items[1].raw.text, /^수정본 2/);

	const here = await getJson(ctx, `/api/here?cwd=${encodeURIComponent(path.join(ctx.home, "board-sB"))}&session=sB`);
	assert.equal(here.body.footer, "🙋 2");
	const fb = await postJson(ctx, `/api/p/${id}/feedback`, { rev: 2, verdict: "change", comment: "더" }, { "x-forwarded-for": "100.64.0.9" });
	assert.equal(fb.status, 200);
	const after = await getJson(ctx, `/api/here?cwd=${encodeURIComponent(path.join(ctx.home, "board-sB"))}&session=sB`);
	assert.equal(after.body.footer, "🙋 1 🤖 1");

	await postJson(ctx, `/api/p/${id}/close`, { summary: "끝", session: "sB" });
	thread = (await getJson(ctx, "/api/threads/sB")).body;
	assert.ok(thread.items.every((item) => item.status === "closed"));
});

test("trial mode files board items as quiet", async (t) => {
	const ctx = await withServer(t, { config: { mode: "trial" } });
	await submitBoard(ctx, "sT");
	const thread = (await getJson(ctx, "/api/threads/sT")).body;
	assert.equal(thread.items[0].policy, "quiet");
	assert.equal(thread.thread.status, "ended");
});

test("schedules are rebuilt from open items at start; overdue holds fire at once", async (t) => {
	const tmp = makeTmpHome("inbox-items-rebuild-");
	t.after(() => tmp.cleanup());
	const clock = { at: START };
	const first = await withServer(t, { tmp, clock, keepHome: true });
	const { body } = await postJson(first, "/api/threads/s1/items", turnInput());
	await first.server.close();

	clock.at = START + 5 * 60_000;
	const second = await withServer(t, { tmp, clock, keepHome: true });
	assert.deepEqual(second.server.scheduler.pending(), [{ key: `item:${body.item.itemId}`, atMs: START + 30_000 }]);
	second.timers.runDue(0);
	await flush();
	assert.deepEqual(second.pushes().map((line) => line.payload.itemId), [body.item.itemId]);
});

test("a progress line asks for a model one-liner and stores it without lint or repair", async (t) => {
	const ctx = await withServer(t);
	const line = await postEpisodeLine(ctx, 110, "서버 연결을 확인하고 있습니다. 곧 마칩니다.");
	assert.equal(line.body.created, true);
	assert.equal(line.body.summaryRequest.purpose, "line");
	assert.equal(line.body.summaryRequest.maxTokens, 80);
	assert.match(line.body.summaryRequest.user, /서버 연결을 확인하고 있습니다/);

	const out = await postJson(ctx, `/api/items/${line.body.item.itemId}/summary`, { text: "  서버 연결을 확인했습니다.  ", model: "qa/line" });
	assert.equal(out.body.ok, true);
	assert.equal(out.body.summary.headline, "서버 연결을 확인했습니다.");
	assert.equal(out.body.summary.title, null);
	assert.equal("repairRequest" in out.body, false, "a line answer is never linted or repaired");
	const item = (await getJson(ctx, `/api/items/${line.body.item.itemId}`)).body;
	assert.equal(item.summary.source, "model");
	assert.equal(item.summary.model, "qa/line");
	assert.equal(item.summary.summary.kind, "progress");
	assert.equal(item.summary.summary.headline, "서버 연결을 확인했습니다.");
});

test("an English model line is rejected and the heuristic headline stays", async (t) => {
	const ctx = await withServer(t);
	const line = await postEpisodeLine(ctx, 120, "결과를 정리하고 있습니다.");
	const before = line.body.item.summary.summary.headline;
	const out = await postJson(ctx, `/api/items/${line.body.item.itemId}/summary`, { text: "Waiting for bash_10 completion", model: "qa/line" });
	assert.deepEqual(out.body, { ok: false });
	const item = (await getJson(ctx, `/api/items/${line.body.item.itemId}`)).body;
	assert.equal(item.summary.source, "heuristic");
	assert.equal(item.summary.summary.headline, before);
});

test("progress.modelLines false asks for no line summary", async (t) => {
	const ctx = await withServer(t, { config: { progress: { modelLines: false } } });
	const line = await postEpisodeLine(ctx, 130, "조용히 진행 중");
	assert.equal(line.body.summaryRequest, null);
});

test("an episode final request and its repair carry the line digest", async (t) => {
	const ctx = await withServer(t);
	await postEpisodeLine(ctx, 100, "첫 줄을 확인했습니다.");
	ctx.clock.at += 1_000;
	await postEpisodeLine(ctx, 200, "둘째 줄을 고쳤습니다.");
	ctx.clock.at += 1_000;
	const final = await postEpisodeFinal(ctx, { stamp: 300, final: "배포를 마쳤습니다. 이제 쉬어도 됩니다." });
	assert.equal(final.body.summaryRequest.purpose, "summary");
	const request = final.body.summaryRequest.user;
	assert.match(request, /이번 작업 구간: 2개 메시지/);
	assert.match(request, /첫 줄을 확인했습니다/);
	assert.match(request, /둘째 줄을 고쳤습니다/);
	assert.match(request, /마지막 메시지 원문:/);
	assert.match(request, /배포를 마쳤습니다\. 이제 쉬어도 됩니다\./);

	const bad = JSON.stringify({ kind: "report", headline: "배포를 마쳤습니다", context: "요청: 배포", body: "task_send 로 배포했습니다", ask: null, options: [], ifNoAnswer: null, terms: [], title: null });
	const repair = await postJson(ctx, `/api/items/${final.body.item.itemId}/summary`, { text: bad, model: "m" });
	assert.equal(repair.body.ok, true);
	assert.ok(repair.body.repairRequest);
	assert.match(repair.body.repairRequest.user, /이번 작업 구간: 2개 메시지/);
	assert.match(repair.body.repairRequest.user, /마지막 메시지 원문:/);
});

const liveIdle = (ctx, idle = 1, sid = "s1") =>
	fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(ctx.home)}&session=${sid}&idle=${idle}`);

const stallConfig = { summary: { enabled: false }, episode: { stallMinutes: 5 } };

async function stalledItems(ctx) {
	return (await getJson(ctx, "/api/threads/s1")).body.items.filter((item) => item.meta?.stalled);
}

test("the stall watchdog makes one stalled final and one push", async (t) => {
	const ctx = await withServer(t, { config: stallConfig });
	await liveIdle(ctx);
	await postEpisodeLine(ctx, 100, "첫 줄");
	ctx.clock.at += 1_000;
	await postEpisodeLine(ctx, 200, "마지막 진행 줄");
	ctx.clock.at += 300_000;
	await liveIdle(ctx);
	ctx.timers.runDue(300_000);

	const items = await stalledItems(ctx);
	assert.equal(items.length, 1);
	const final = items[0];
	assert.equal(final.kind, "turn");
	assert.equal(final.policy, "needs-you");
	const episode = await getJson(ctx, `/api/threads/s1/episodes/${encodeURIComponent(episodeKey)}`);
	assert.equal(episode.body.final.text, "마지막 진행 줄");
	assert.equal(final.meta.episode.closeReason, "stalled");
	assert.equal(final.meta.episode.lines, 2);
	assert.equal(final.dedupeKey, "episode:s1:100:stalled:m200");
	assert.ok(ctx.server.scheduler.pending().some((entry) => entry.key === `item:${final.itemId}` && entry.atMs === ctx.clock.at + 30_000));

	ctx.clock.at += 30_000;
	ctx.timers.runDue(30_000);
	await flush();
	assert.equal(ctx.pushes().length, 1);
	assert.equal(ctx.pushes()[0].payload.itemId, final.itemId);

	ctx.clock.at += 600_000;
	ctx.timers.runDue(Infinity);
	await flush();
	assert.equal((await stalledItems(ctx)).length, 1, "the watchdog fires once");
	assert.equal(ctx.pushes().length, 1);
});

test("a busy report suspends the stall (idle=0 never fires) and the next idle report re-arms it", async (t) => {
	const ctx = await withServer(t, { config: stallConfig });
	await liveIdle(ctx, 1);
	await postEpisodeLine(ctx, 100, "첫 줄");
	await liveIdle(ctx, 0);
	ctx.clock.at += 400_000;
	ctx.timers.runDue(Infinity);
	assert.equal((await stalledItems(ctx)).length, 0, "idle=0 never fires");

	await liveIdle(ctx, 1);
	ctx.clock.at += 300_000;
	await liveIdle(ctx, 1);
	ctx.timers.runDue(300_000);
	assert.equal((await stalledItems(ctx)).length, 1);
});

test("a final cancels its episode's stall watchdog", async (t) => {
	const ctx = await withServer(t, { config: stallConfig });
	await liveIdle(ctx);
	await postEpisodeLine(ctx, 100, "첫 줄");
	await postEpisodeFinal(ctx, { stamp: 300, final: "끝났습니다" });
	ctx.clock.at += 400_000;
	ctx.timers.runDue(Infinity);
	await flush();
	assert.equal((await stalledItems(ctx)).length, 0);
	assert.equal((await getJson(ctx, "/api/threads/s1")).body.items.length, 2, "the line and the real final only");
});

test("a closed bye cancels the session's stall watchdog", async (t) => {
	const ctx = await withServer(t, { config: stallConfig });
	await liveIdle(ctx);
	await postEpisodeLine(ctx, 100, "첫 줄");
	assert.deepEqual((await postJson(ctx, "/api/bye", { session: "s1", closed: true })).body, { ok: true });

	ctx.clock.at += 300_000;
	ctx.timers.runDue(Infinity);
	await flush();
	assert.equal((await stalledItems(ctx)).length, 0);
});

test("the stall watchdog writes nothing when the session is gone", async (t) => {
	const ctx = await withServer(t, { config: stallConfig });
	await liveIdle(ctx);
	await postEpisodeLine(ctx, 100, "첫 줄");
	ctx.clock.at += 300_000;
	ctx.timers.runDue(300_000);
	assert.equal((await stalledItems(ctx)).length, 0);
	assert.equal((await getJson(ctx, "/api/threads/s1")).body.items.length, 1);
});

test("a restart rebuilds the open episode's stall watchdog", async (t) => {
	const tmp = makeTmpHome("inbox-items-stall-");
	t.after(() => tmp.cleanup());
	const clock = { at: START };
	const first = await withServer(t, { tmp, clock, keepHome: true, config: stallConfig });
	await liveIdle(first);
	await postEpisodeLine(first, 100, "첫 줄");
	await first.server.close();

	clock.at += 60_000;
	const second = await withServer(t, { tmp, clock, keepHome: true, config: stallConfig });
	clock.at += 240_000;
	await liveIdle(second);
	second.timers.runDue(240_000);
	assert.equal((await stalledItems(second)).length, 1);
});

const modelText = (over = {}) =>
	JSON.stringify({ kind: "report", headline: "로그인 화면을 고쳤습니다", context: "요청: 로그인", body: "화면을 손봤습니다", ask: null, options: [], ifNoAnswer: null, terms: [], title: null, ...over });

test("summary POST with lint issues stores the provisional summary and returns one repairRequest", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput("화면을 고쳤습니다."));
	const itemId = body.item.itemId;
	const bad = modelText({ body: "task_send 로 보냈습니다" });
	const first = await postJson(ctx, `/api/items/${itemId}/summary`, { text: bad, model: "m" });
	assert.equal(first.body.ok, true);
	assert.equal(typeof first.body.repairRequest.system, "string");
	assert.ok(first.body.repairRequest.user.includes("task_send"));
	assert.equal(first.body.repairRequest.maxTokens, 700);
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.summary.source, "model");

	const repaired = await postJson(ctx, `/api/items/${itemId}/summary`, { text: modelText({ body: "작업 도구로 보냈습니다" }), model: "m", repair: true });
	assert.equal(repaired.body.ok, true);
	assert.equal("repairRequest" in repaired.body, false);
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.summary.summary.body, "작업 도구로 보냈습니다");

	const stillBad = await postJson(ctx, `/api/items/${itemId}/summary`, { text: bad, model: "m", repair: true });
	assert.equal("repairRequest" in stillBad.body, false, "a repair post is never repaired again");

	const clean = await postJson(ctx, `/api/items/${itemId}/summary`, { text: modelText(), model: "m" });
	assert.equal("repairRequest" in clean.body, false);
});

test("a turn push waits for the model summary and goes out with it", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput("화면을 고쳤습니다. 다음은요?"));
	assert.ok(body.summaryRequest);
	ctx.clock.at = START + 30_000;
	ctx.timers.runDue(30_000);
	await flush();
	assert.equal(ctx.pushes().length, 0, "the hold fired but the push is parked");
	await postJson(ctx, `/api/items/${body.item.itemId}/summary`, { text: modelText({ headline: "모델이 쓴 제목입니다" }), model: "m" });
	await flush();
	const pushes = ctx.pushes();
	assert.equal(pushes.length, 1);
	assert.ok(JSON.stringify(pushes[0]).includes("모델이 쓴 제목입니다"));
});

test("a parked push goes out with the heuristic summary after 30 s without a model summary", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput("화면을 고쳤습니다."));
	ctx.clock.at = START + 30_000;
	ctx.timers.runDue(30_000);
	await flush();
	assert.equal(ctx.pushes().length, 0);
	ctx.clock.at = START + 60_000;
	ctx.timers.runDue(30_000);
	await flush();
	const pushes = ctx.pushes();
	assert.equal(pushes.length, 1);
	assert.ok(JSON.stringify(pushes[0]).includes("화면을 고쳤습니다"));
	assert.equal((await getJson(ctx, `/api/items/${body.item.itemId}`)).body.summary.source, "heuristic");
});

test("a push is not parked when no model summary was asked for", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	await postJson(ctx, "/api/threads/s1/items", turnInput("화면을 고쳤습니다."));
	ctx.clock.at = START + 30_000;
	ctx.timers.runDue(30_000);
	await flush();
	assert.equal(ctx.pushes().length, 1);
});

test("here reports idle now and busy later through the onIdle hook", async (t) => {
	const calls = [];
	const ctx = await withServer(t, { onIdle: (sid, idle) => calls.push([sid, idle]) });
	const at = `${ctx.base}/api/here?cwd=${encodeURIComponent(ctx.home)}&session=s1`;
	await fetch(`${at}&idle=1`);
	await fetch(`${at}&idle=0`);
	await fetch(`${at}&idle=bogus`);
	assert.deepEqual(calls, [["s1", true], ["s1", false]]);
});

test("item state route validates its payload and stores the latest state", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", turnInput());
	const itemId = body.item.itemId;
	const boards = [{ id: "b1", title: "보드", url: "https://example.test/b" }];
	const ok = await postJson(ctx, `/api/items/${itemId}/state`, { state: "waiting", reasons: ["terminal-monitors"], boards });
	assert.equal(ok.status, 200);
	assert.deepEqual(ok.body, { ok: true });
	assert.deepEqual((await getJson(ctx, `/api/items/${itemId}`)).body.state, { state: "waiting", reasons: ["terminal-monitors"], boards });
	assert.equal((await postJson(ctx, `/api/items/${itemId}/state`, { state: "resumed" })).status, 200);
	assert.deepEqual((await getJson(ctx, `/api/items/${itemId}`)).body.state, { state: "resumed", reasons: [], boards: [] });

	for (const payload of [
		{ state: "waking" },
		{ state: "waiting", reasons: Array.from({ length: 11 }, (_, i) => `r${i}`) },
		{ state: "waiting", reasons: ["x".repeat(41)] },
		{ state: "waiting", boards: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, title: "t", url: "https://example.test/b" })) },
		{ state: "waiting", boards: [{ id: "b", title: "x".repeat(81), url: "https://example.test/b" }] },
		{ state: "waiting", boards: [{ id: "b", title: "t", url: "javascript:alert(1)" }] },
	]) {
		assert.equal((await postJson(ctx, `/api/items/${itemId}/state`, payload)).status, 400, JSON.stringify(payload).slice(0, 120));
	}
	assert.equal((await post(ctx, `/api/items/${itemId}/state`, { state: "waiting" }, TAILNET)).status, 403);
});

const episodeKey = "e:s1:100";
const episodeMeta = (over = {}) => ({ key: episodeKey, opener: 100, openedAt: START, ...over });

async function postEpisodeLine(ctx, stamp, text, key = episodeKey, request = "첫 요청") {
	return postJson(ctx, "/api/threads/s1/items", {
		kind: "progress",
		policy: "progress",
		dedupeKey: `line:s1:m${stamp}`,
		raw: { text, request },
		meta: { episode: { key, opener: 100, openedAt: START, seq: stamp } },
	});
}

async function postEpisodeFinal(ctx, { key = episodeKey, reason = "done", stamp = 300, final = "마지막 메시지", request = "첫 요청", openedAt = START, lines = 3, kind = "turn" } = {}) {
	return postJson(ctx, "/api/threads/s1/items", {
		kind,
		policy: "needs-you",
		dedupeKey: `episode:s1:100:${reason}:m${stamp}`,
		raw: { final, request, lastRequest: request },
		meta: { episode: { key, opener: 100, openedAt, closeReason: reason, closedAt: START, lines, turns: 1, interjections: 0, questions: 0 } },
	});
}

test("episode GET returns the opener request, ordered lines and the final, without repeating the final message", async (t) => {
	const ctx = await withServer(t);
	const first = await postEpisodeLine(ctx, 100, "첫 줄");
	ctx.clock.at += 1_000;
	const second = await postEpisodeLine(ctx, 200, "둘째 줄");
	ctx.clock.at += 1_000;
	const duplicate = await postEpisodeLine(ctx, 300, "마지막 메시지");
	ctx.clock.at += 1_000;
	const final = await postEpisodeFinal(ctx);

	const out = await getJson(ctx, `/api/threads/s1/episodes/${encodeURIComponent(episodeKey)}`);
	assert.equal(out.status, 200);
	assert.equal(out.body.request, "첫 요청");
	assert.deepEqual(out.body.lines.map((line) => line.id), [first.body.item.itemId, second.body.item.itemId], "the line equal to the final is omitted");
	assert.deepEqual(out.body.lines.map((line) => line.text), ["첫 줄", "둘째 줄"]);
	assert.deepEqual(out.body.lines.map((line) => Object.keys(line).sort()), [
		["at", "headline", "id", "text"],
		["at", "headline", "id", "text"],
	]);
	assert.deepEqual(out.body.final, { id: final.body.item.itemId, at: final.body.item.createdAt, text: "마지막 메시지" });
	assert.notEqual(duplicate.body.item.itemId, final.body.item.itemId);

	assert.deepEqual((await getJson(ctx, `/api/threads/s1/episodes/${encodeURIComponent("e:s1:missing")}`)).body, { request: null, lines: [], final: null });
	assert.equal((await getJson(ctx, `/api/threads/s1/episodes/${encodeURIComponent(episodeKey)}`, TAILNET)).status, 200);
});

test("thread GET keeps request fields but never the raw text of progress lines or episode finals", async (t) => {
	const ctx = await withServer(t);
	const lineText = `L${"a".repeat(4_999)}`;
	const finalText = `F${"b".repeat(4_999)}`;
	const line = await postEpisodeLine(ctx, 100, lineText, episodeKey, "요청 본문");
	ctx.clock.at += 1_000;
	const final = await postEpisodeFinal(ctx, { final: finalText, request: "요청 본문" });

	const thread = (await getJson(ctx, "/api/threads/s1")).body;
	const lineView = thread.items.find((item) => (item.id ?? item.itemId) === line.body.item.itemId);
	const finalView = thread.items.find((item) => (item.id ?? item.itemId) === final.body.item.itemId);
	assert.equal("text" in lineView.raw, false);
	assert.equal(lineView.raw.request, "요청 본문");
	assert.equal("text" in finalView.raw, false);
	assert.equal("final" in finalView.raw, false);
	assert.equal(finalView.raw.request, "요청 본문");
	const itemEvents = thread.events.filter((event) => event.type === "item");
	for (const event of itemEvents) {
		if (event.kind === "progress" || event.meta?.episode?.closeReason) {
			assert.equal("text" in event.raw, false);
			assert.equal("final" in event.raw, false);
			assert.equal(event.raw.request, "요청 본문");
		}
	}
	const json = JSON.stringify(thread);
	for (let at = 0; at <= 4_000; at += 1_000) {
		assert.equal(json.includes(lineText.slice(at, at + 1_000)), false, `line text at ${at}`);
		assert.equal(json.includes(finalText.slice(at, at + 1_000)), false, `final text at ${at}`);
	}
	assert.equal((await getJson(ctx, `/api/items/${line.body.item.itemId}`)).body.raw.text, undefined);
});

test("a seeded 7-line episode thread GET stays within the final's JSON plus 2 KB per line", async (t) => {
	const ctx = await withServer(t);
	for (let i = 1; i <= 7; i++) {
		await postEpisodeLine(ctx, i * 100, `진행 ${i}: ${"가".repeat(600)}`);
		ctx.clock.at += 1_000;
	}
	await postEpisodeFinal(ctx, { stamp: 800, final: `마지막: ${"나".repeat(3_000)}`, lines: 8 });

	const res = await fetch(`${ctx.base}/api/threads/s1`, { headers: { accept: "application/json" } });
	const body = await res.text();
	const parsed = JSON.parse(body);
	const finalItem = parsed.items.find((item) => item.meta?.episode?.closeReason);
	const payloadBytes = Buffer.byteLength(body, "utf8");
	const budget = Buffer.byteLength(JSON.stringify(finalItem), "utf8") + 2048 * 8;
	assert.equal(parsed.items.length, 8);
	assert.ok(payloadBytes <= budget, `${payloadBytes} > ${budget}`);
});

test("a thread GET keeps a line's request only where its episode starts or the request changes", async (t) => {
	const ctx = await withServer(t);
	const requests = ["첫 요청", "첫 요청", "첫 요청", "둘째 요청", "둘째 요청", "첫 요청"];
	const ids = [];
	for (const [i, request] of requests.entries()) {
		ids.push((await postEpisodeLine(ctx, (i + 1) * 100, `줄 ${i + 1}`, episodeKey, request)).body.item.itemId);
		ctx.clock.at += 1_000;
	}
	const plain = await postJson(ctx, "/api/threads/s1/items", { kind: "progress", policy: "progress", dedupeKey: "turn:s1:plain", raw: { text: "에피소드 없는 줄", request: "첫 요청" } });
	await postEpisodeFinal(ctx, { stamp: 700, request: "첫 요청" });

	const thread = (await getJson(ctx, "/api/threads/s1")).body;
	const byId = (id) => thread.items.find((item) => item.id === id);
	assert.deepEqual(ids.map((id) => byId(id).raw.request), ["첫 요청", undefined, undefined, "둘째 요청", undefined, "첫 요청"], "the first line and every change keep the request; repeats drop it");
	assert.equal(byId(plain.body.item.itemId).raw.request, "첫 요청", "a progress item without an episode is untouched");
	assert.equal(thread.items.find((item) => item.meta?.episode?.closeReason).raw.request, "첫 요청", "the final keeps its request");
	for (const event of thread.events.filter((event) => event.type === "item" && ids.includes(event.itemId))) {
		assert.equal(event.raw.request, requests[ids.indexOf(event.itemId)], "the incremental events keep every request");
	}
	assert.equal((await getJson(ctx, `/api/items/${ids[1]}`)).body.raw.request, "첫 요청", "the single item GET keeps a repeated request");
});

test("a closed bye ignores an unknown session, but logs any other cleanup failure and still closes the thread", async (t) => {
	const clock = { at: START, broken: false };
	const now = () => {
		if (clock.broken) {
			clock.broken = false;
			throw new Error("clock exploded");
		}
		return new Date(clock.at);
	};
	const ctx = await withServer(t, { clock, now });
	const logFile = path.join(ctx.home, "logs", "server.log");
	const logText = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");

	assert.deepEqual((await postJson(ctx, "/api/bye", { session: "nobody", closed: true })).body, { ok: true });
	assert.equal(logText().includes("bye cleanup failed"), false, "an unknown session has nothing to cancel and is no error");

	const line = await postEpisodeLine(ctx, 100, "첫 줄");
	clock.broken = true;
	assert.deepEqual((await postJson(ctx, "/api/bye", { session: "s1", closed: true })).body, { ok: true });
	assert.match(logText(), /bye cleanup failed: Error: clock exploded/);
	assert.equal((await getJson(ctx, `/api/items/${line.body.item.itemId}`)).body.closedReason, "session-closed", "the thread still closes after the logged failure");
});

test("a progress item's thread summary carries only the headline and source", async (t) => {
	const ctx = await withServer(t);
	const line = await postEpisodeLine(ctx, 100, "서버 연결을 확인하고 있습니다.");
	const headline = line.body.item.summary.summary.headline;
	await postEpisodeFinal(ctx);

	const thread = (await getJson(ctx, "/api/threads/s1")).body;
	const view = thread.items.find((item) => item.id === line.body.item.itemId);
	assert.equal(view.summary.source, "heuristic");
	assert.deepEqual(view.summary.summary, { headline });
	assert.deepEqual(Object.keys(view.summary.summary), ["headline"], "the heuristic body, ask and terms stay out");

	const summaryEvent = thread.events.find((event) => event.type === "summary" && event.itemId === line.body.item.itemId);
	assert.deepEqual(summaryEvent.summary, { headline });
	assert.equal(summaryEvent.source, "heuristic");

	const episode = (await getJson(ctx, `/api/threads/s1/episodes/${encodeURIComponent(episodeKey)}`)).body;
	assert.equal(episode.lines[0].headline, headline);
});

test("a system agent-start 20 s after an unpushed final reopens it and its push never fires", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const final = await postEpisodeFinal(ctx);
	ctx.clock.at += 20_000;
	const start = await postJson(ctx, "/api/threads/s1/activity", { source: "agent-start", cause: "system", opened: true });
	assert.deepEqual(start.body.reopen, { key: episodeKey, opener: 100, openedAt: START, seq: 3 });

	assert.equal((await getJson(ctx, `/api/items/${final.body.item.itemId}`)).body.closedReason, "superseded", "the reopened final is superseded so its push dies");
	ctx.timers.runDue(20_000);
	await flush();
	assert.equal(ctx.pushes().length, 0);
	ctx.clock.at += 10_000;
	ctx.timers.runDue(30_000);
	await flush();
	assert.equal(ctx.pushes().length, 0);
});

test("a system agent-start 45 s after a final pushed at 30 s does not reopen it", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	await postEpisodeFinal(ctx);
	ctx.clock.at += 30_000;
	ctx.timers.runDue(30_000);
	await flush();
	assert.equal(ctx.pushes().length, 1);
	assert.ok((await getJson(ctx, "/api/threads/s1")).body.items[0].pushedAt);

	ctx.clock.at += 15_000;
	const start = await postJson(ctx, "/api/threads/s1/activity", { source: "agent-start", cause: "system", opened: true });
	assert.equal(start.body.reopen, null);
});

test("a restart rebuilds no push for an item already pushed", async (t) => {
	const tmp = makeTmpHome("inbox-items-pushed-");
	t.after(() => tmp.cleanup());
	const clock = { at: START };
	const first = await withServer(t, { tmp, clock, keepHome: true, config: { summary: { enabled: false } } });
	await postEpisodeFinal(first);
	clock.at += 30_000;
	first.timers.runDue(30_000);
	await flush();
	assert.equal(first.pushes().length, 1);
	await first.server.close();

	const second = await withServer(t, { tmp, clock, keepHome: true, config: { summary: { enabled: false } } });
	assert.deepEqual(second.server.scheduler.pending(), []);
	second.timers.runDue(Infinity);
	await flush();
	assert.equal(second.pushes().length, 1, "the pushed final is not sent again after a restart");
});

test("a newer episode line after a stalled final blocks reopen", async (t) => {
	const ctx = await withServer(t);
	await postEpisodeFinal(ctx, { reason: "stalled" });
	ctx.clock.at += 1_000;
	const lineB = await postEpisodeLine(ctx, 400, "B의 줄", "e:s1:200");
	ctx.clock.at += 1_000;
	const start = await postJson(ctx, "/api/threads/s1/activity", { source: "agent-start", cause: "system", opened: true, episode: "e:s1:200" });
	assert.equal(start.body.reopen, null);
	assert.equal(start.body.episodeClosed, undefined, "episode B has no final");
	assert.equal((await getJson(ctx, `/api/items/${lineB.body.item.itemId}`)).body.meta.episode.key, "e:s1:200");
});

test("an agent-start naming a watchdog-closed episode is told it is closed", async (t) => {
	const ctx = await withServer(t);
	await postEpisodeFinal(ctx, { reason: "stalled" });
	const start = await postJson(ctx, "/api/threads/s1/activity", { source: "agent-start", cause: "system", opened: false, episode: episodeKey });
	assert.equal(start.body.episodeClosed, true);
	assert.equal(start.body.closeReason, "stalled");
});

test("a system agent-start keeps a pending question push; owner activity cancels it and closes the open final", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const question = await postJson(ctx, "/api/threads/s1/items", questionInput());
	await postJson(ctx, "/api/threads/s1/activity", { source: "agent-start", cause: "system", opened: true });
	assert.equal(ctx.server.scheduler.pending().some((entry) => entry.key === `item:${question.body.item.itemId}`), true);
	ctx.timers.runDue(14_999);
	await flush();
	assert.equal(ctx.pushes().length, 0);
	ctx.clock.at += 15_000;
	ctx.timers.runDue(15_000);
	await flush();
	assert.deepEqual(ctx.pushes().map((line) => line.payload.itemId), [question.body.item.itemId]);

	const owner = await withServer(t, { config: { summary: { enabled: false } } });
	const pendingQuestion = await postJson(owner, "/api/threads/s2/items", questionInput("r2"));
	const openFinal = await postJson(owner, "/api/threads/s2/items", {
		kind: "turn",
		policy: "needs-you",
		dedupeKey: "episode:s2:100:done:m300",
		raw: { final: "끝", request: "요청" },
		meta: { episode: { key: "e:s2:100", opener: 100, openedAt: START, closeReason: "done", lines: 1 } },
	});
	assert.equal(owner.server.scheduler.pending().filter((entry) => entry.key === `item:${pendingQuestion.body.item.itemId}`).length, 1);
	await postJson(owner, "/api/threads/s2/activity", { source: "terminal-input" });
	assert.deepEqual(owner.server.scheduler.pending(), []);
	assert.equal((await getJson(owner, `/api/items/${openFinal.body.item.itemId}`)).body.closedReason, "superseded");
	owner.timers.runDue(Infinity);
	await flush();
	assert.equal(owner.pushes().length, 0);
});

test("summary POST overwrites a model-invented ifNoAnswer with the runtime fact", async (t) => {
	const ctx = await withServer(t);
	const { body } = await postJson(ctx, "/api/threads/s1/items", questionInput());
	const itemId = body.item.itemId;
	assert.match(body.item.summary.summary.ifNoAnswer, /^(답이 없으면 그 작업은 하지 않고 기다립니다|\d+분 안에 답이 없으면 에이전트가 스스로 판단해 진행합니다)$/);
	const text = JSON.stringify({ kind: "question", headline: "정해 주세요", context: "c", body: "b", ask: "무엇으로 할까요", options: [], ifNoAnswer: "자동으로 취소됩니다", terms: [] });
	const ok = await postJson(ctx, `/api/items/${itemId}/summary`, { text, model: "m" });
	assert.equal(ok.body.ok, true);
	assert.notEqual(ok.body.summary.ifNoAnswer, "자동으로 취소됩니다");
	const stored = (await getJson(ctx, `/api/items/${itemId}`)).body.summary.summary;
	assert.equal(stored.ifNoAnswer, ok.body.summary.ifNoAnswer);
	assert.match(stored.ifNoAnswer, /^(답이 없으면 그 작업은|\d+분 안에 답이)/);
});

test("threads list reports the owner's Review count and the hidden count", async (t) => {
	const ctx = await withServer(t);
	const sub = await submitBoard(ctx, "s1");
	assert.equal(sub.status, 200);
	const list = (await getJson(ctx, "/api/threads")).body;
	assert.equal(list.reviews.mine, 1);
	assert.equal(typeof list.counts.hidden, "number");
});

test("hiding a thread leaves the needs-you count and stays hidden after a restart", async (t) => {
	const tmp = makeTmpHome("inbox-items-hide-restart-");
	const clock = { at: START };
	const config = { summary: { enabled: false } };
	let first;
	let second;
	try {
		first = await withServer(t, { tmp, clock, keepHome: true, config });
		await postJson(first, "/api/threads/s1/items", questionInput());
		assert.equal((await getJson(first, "/api/threads")).body.counts.needsYou, 1);
		const hide = await postJson(first, "/api/threads/s1/hide", { hidden: true });
		assert.equal(hide.status, 200);
		assert.deepEqual(hide.body, { ok: true, hidden: true });
		let list = (await getJson(first, "/api/threads")).body;
		assert.equal(list.items.find((row) => row.session === "s1").hidden, true);
		assert.equal(list.counts.needsYou, 0);
		await first.server.close();
		clock.at = START + 60_000;
		second = await withServer(t, { tmp, clock, keepHome: true, config });
		list = (await getJson(second, "/api/threads")).body;
		assert.equal(list.items.find((row) => row.session === "s1").hidden, true);
	} finally {
		await first?.server.close();
		await second?.server.close();
		tmp.cleanup();
	}
});

test("hide rejects a non-boolean, answers 404 for an unknown session, and accepts the tailnet", async (t) => {
	const ctx = await withServer(t);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: ctx.home });
	assert.equal((await postJson(ctx, "/api/threads/s1/hide", { hidden: "yes" })).status, 400);
	const missing = await postJson(ctx, "/api/threads/nope/hide", { hidden: true });
	assert.equal(missing.status, 404);
	assert.deepEqual(missing.body, { error: "not_found" });
	const tailnet = await postJson(ctx, "/api/threads/s1/hide", { hidden: true }, TAILNET);
	assert.equal(tailnet.status, 200);
});

test("an item created in a hidden thread never pushes, even after unhide", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	await postJson(ctx, "/api/threads/s1/meta", { cwd: ctx.home });
	assert.equal((await postJson(ctx, "/api/threads/s1/hide", { hidden: true })).status, 200);
	await postJson(ctx, "/api/threads/s1/items", questionInput());
	assert.equal(ctx.server.scheduler.pending().length, 0, "a hidden thread schedules nothing");
	await postJson(ctx, "/api/threads/s1/hide", { hidden: false });
	ctx.clock.at += 60_000;
	ctx.timers.runDue(Infinity);
	await flush();
	assert.equal(ctx.pushes().length, 0);
});

test("a hidden-thread item stays silent across unhide and a restart", async (t) => {
	const tmp = makeTmpHome("inbox-items-hidden-restart-");
	const clock = { at: START };
	const config = { summary: { enabled: false } };
	let first;
	let second;
	try {
		first = await withServer(t, { tmp, clock, keepHome: true, config });
		await postJson(first, "/api/threads/s1/meta", { cwd: first.home });
		await postJson(first, "/api/threads/s1/hide", { hidden: true });
		await postJson(first, "/api/threads/s1/items", questionInput());
		await postJson(first, "/api/threads/s1/hide", { hidden: false });
		await first.server.close();
		clock.at = START + 1_000;
		second = await withServer(t, { tmp, clock, keepHome: true, config });
		clock.at = START + 60_000;
		second.timers.runDue(Infinity);
		await flush();
		assert.equal(second.pushes().length, 0);
	} finally {
		await first?.server.close();
		await second?.server.close();
		tmp.cleanup();
	}
});

test("a visible thread's item pushes after the hold", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const { body } = await postJson(ctx, "/api/threads/s1/items", questionInput());
	ctx.clock.at += 15_000;
	ctx.timers.runDue(15_000);
	await flush();
	const pushes = ctx.pushes();
	assert.equal(pushes.length, 1);
	assert.equal(pushes[0].payload.itemId, body.item.itemId);
});

test("an item scheduled while visible stays silent when its thread is hidden before the hold ends", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	await postJson(ctx, "/api/threads/s1/items", questionInput());
	assert.equal(ctx.server.scheduler.pending().length, 1);
	assert.equal((await postJson(ctx, "/api/threads/s1/hide", { hidden: true })).status, 200);
	assert.deepEqual(ctx.server.scheduler.pending(), []);
	ctx.clock.at += 15_000;
	ctx.timers.runDue(Infinity);
	await flush();
	assert.equal(ctx.pushes().length, 0);
});

test("a hidden thread's item gets no cache reminder after unhide and a restart; a visible control still does", async (t) => {
	const tmp = makeTmpHome("inbox-items-hidden-cache-");
	const clock = { at: START };
	const config = { summary: { enabled: false } };
	const warmUntil = START + 10 * 60_000;
	let first;
	let second;
	try {
		first = await withServer(t, { tmp, clock, keepHome: true, config });
		await postJson(first, "/api/threads/hidden/meta", { cwd: first.home });
		await postJson(first, "/api/threads/hidden/hide", { hidden: true });
		await postJson(first, "/api/threads/hidden/items", turnInput("숨긴 턴", "turn:hidden:1:1"));
		await postJson(first, "/api/threads/hidden/cache", { warmUntil, ttlSec: 600 });
		await postJson(first, "/api/threads/hidden/hide", { hidden: false });
		const control = await postJson(first, "/api/threads/s1/items", turnInput());
		await postJson(first, "/api/threads/s1/cache", { warmUntil, ttlSec: 600 });
		await first.server.close();
		clock.at = START + 60_000;
		second = await withServer(t, { tmp, clock, keepHome: true, config });
		clock.at = warmUntil - 5 * 60_000;
		second.timers.runDue(Infinity);
		await flush();
		const reminders = second.pushes().filter((line) => line.payload.title.startsWith("🔥"));
		assert.equal(reminders.length, 1);
		assert.equal(reminders[0].payload.itemId, control.body.item.itemId);
	} finally {
		await first?.server.close();
		await second?.server.close();
		tmp.cleanup();
	}
});

test("thread meta keeps the session file path", async (t) => {
	const ctx = await withServer(t);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: ctx.home, sessionFile: "C:/sessions/s1.jsonl" });
	assert.equal((await getJson(ctx, "/api/threads/s1")).body.thread.sessionFile, "C:/sessions/s1.jsonl");
});
