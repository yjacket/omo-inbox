import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createServer } from "../src/server.mjs";
import { safeSegment } from "../src/paths.mjs";

const START = Date.parse("2026-10-24T01:00:00Z");
const PLAN_SLUG = "comprehensive-tool-grouping";

const EXAMPLE_A = [
	"wanted: 남은 일이 없는지 확인",
	"For you: 작업은 모두 끝났습니다.",
	"Now: 남은 작업 없음. Next: 없음.",
].join("\n");

const EXAMPLE_B = [
	"wanted: 계획 실행",
	"For you: 계획 파일이 준비됐고 아직 남은 항목이 있습니다.",
	"Now: 미완료 항목 4개가 남았습니다.",
	"Next: `/ulw-execute comprehensive-tool-grouping` 로 새 세션에서 이어가세요.",
].join("\n");

function fakeTimers() {
	const timers = new Map();
	let next = 1;
	return {
		setTimer(fn, ms) {
			const id = next++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimer(id) {
			timers.delete(id);
		},
		runDue(elapsedMs) {
			for (const [id, timer] of [...timers.entries()]) {
				if (timer.ms > elapsedMs) continue;
				timers.delete(id);
				timer.fn();
			}
		},
	};
}

// Resolves when the n-th computation for an item finished, never by sleeping.
function nextLog() {
	const seen = [];
	const waiters = [];
	const check = () => {
		for (const waiter of [...waiters]) {
			if (!waiter.ready()) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	};
	const wait = (ready) => {
		if (ready()) return Promise.resolve();
		return new Promise((resolve) => {
			waiters.push({ ready, resolve });
		});
	};
	return {
		onNextComputed(itemId) {
			seen.push(itemId);
			check();
		},
		waitFor(itemId, count = 1) {
			return wait(() => seen.filter((id) => id === itemId).length >= count);
		},
		waitCount(count) {
			return wait(() => seen.length >= count);
		},
	};
}

async function withServer(t, options = {}) {
	const tmp = options.tmp ?? makeTmpHome("inbox-next-");
	const clock = options.clock ?? { at: START };
	const timers = fakeTimers();
	const nexts = nextLog();
	const server = createServer({
		home: tmp.home,
		webDir: options.webDir ?? path.join(tmp.home, "web"),
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: [], ...(options.config ?? {}) },
		now: () => new Date(clock.at),
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		reopener: options.reopener,
		onNextComputed: (itemId) => {
			nexts.onNextComputed(itemId);
			return options.onNextComputed ? options.onNextComputed(itemId) : undefined;
		},
	});
	const { port } = await server.listen();
	t.after(async () => {
		await server.close();
		if (!options.keepHome) tmp.cleanup();
	});
	return { tmp, home: tmp.home, server, clock, timers, nexts, base: `http://127.0.0.1:${port}` };
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

async function getJson(ctx, p) {
	const res = await fetch(ctx.base + p);
	return { status: res.status, body: await res.json() };
}

const turnInput = (text, key) => ({ kind: "turn", policy: "needs-you", dedupeKey: key, raw: { final: text }, meta: null });

function planRoot(home) {
	const root = path.join(home, "plan-work");
	fs.mkdirSync(path.join(root, ".omo", "plans"), { recursive: true });
	fs.writeFileSync(path.join(root, ".omo", "plans", `${PLAN_SLUG}.md`), "- [ ] first\n- [ ] second\n");
	return root;
}

function seedThread(home, sid, { cwd = null, events }) {
	const dir = path.join(home, "data", "threads", safeSegment(sid));
	fs.mkdirSync(path.join(dir, "events"), { recursive: true });
	fs.writeFileSync(path.join(dir, "thread.json"), JSON.stringify({ v: 1, session: sid, cwd, worktree: null, firstRequest: null, executes: null }));
	for (const [index, event] of events.entries()) {
		fs.writeFileSync(path.join(dir, "events", `${String(index + 1).padStart(6, "0")}-${event.type}.json`), JSON.stringify(event));
	}
}

function itemEvent(seq, itemId, text, at) {
	return { seq, at, type: "item", itemId, kind: "turn", policy: "needs-you", dedupeKey: null, createdAt: at, raw: { final: text }, meta: null };
}

test("a needs-you final gets a done verdict from example A and missing cwd keeps git null", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_A, "t1"));
	await ctx.nexts.waitFor(out.body.item.itemId);
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.next.state, "done");
	assert.equal(item.next.reason, "남은 일이 없습니다");
	assert.equal(item.next.facts.git, null);
	assert.deepEqual(item.next.actions, [{ id: "close", kind: "close", label: "세션 닫기", primary: true }]);
});

test("example B with an open plan in the thread cwd gets a plan offer", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	assert.equal((await postJson(ctx, "/api/threads/s1/meta", { cwd: root })).status, 200);
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_B, "t2"));
	await ctx.nexts.waitFor(out.body.item.itemId);
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.next.state, "plan");
	assert.equal(item.next.reason, `계획 ${PLAN_SLUG} 실행 대기`);
	assert.deepEqual(item.next.actions[0], {
		id: "new-session",
		kind: "new-session",
		label: "새 세션에서 실행",
		prompt: `/skill:ulw-execute ${PLAN_SLUG}`,
		primary: true,
	});
	assert.equal(item.next.facts.plan.slug, PLAN_SLUG);
});

test("a plan named in an earlier line of the work span, before a short closing final, still gets a plan offer", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	assert.equal((await postJson(ctx, "/api/threads/s1/meta", { cwd: root })).status, 200);
	const episode = { key: "e:s1:1", opener: 1, openedAt: 1 };
	const lineText = `별도 실행은 새 세션에서 /ulw-execute ${PLAN_SLUG} 으로 시작합니다.`;
	const line = await postJson(ctx, "/api/threads/s1/items", { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1", raw: { text: lineText }, meta: { episode: { ...episode, seq: 1 } } });
	assert.equal(line.status, 200);
	const out = await postJson(ctx, "/api/threads/s1/items", { kind: "turn", policy: "needs-you", dedupeKey: "episode:s1:1:needs-you:m2", raw: { final: "완료했습니다. 요청하신 문장을 정확히 출력했습니다." }, meta: { episode: { ...episode, closedAt: 2, closeReason: "needs-you" } } });
	await ctx.nexts.waitFor(out.body.item.itemId);
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.next.state, "plan");
	assert.equal(item.next.facts.plan.slug, PLAN_SLUG);
	assert.equal(item.next.actions[0].prompt, `/skill:ulw-execute ${PLAN_SLUG}`);
});

test("a plan named only in a line of another work span gets no plan offer", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	assert.equal((await postJson(ctx, "/api/threads/s1/meta", { cwd: root })).status, 200);
	const lineText = `/ulw-execute ${PLAN_SLUG} 로 시작합니다.`;
	await postJson(ctx, "/api/threads/s1/items", { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1", raw: { text: lineText }, meta: { episode: { key: "e:s1:old", opener: 1, openedAt: 1, seq: 1 } } });
	const out = await postJson(ctx, "/api/threads/s1/items", { kind: "turn", policy: "needs-you", dedupeKey: "episode:s1:2:needs-you:m3", raw: { final: "완료했습니다." }, meta: { episode: { key: "e:s1:new", opener: 2, openedAt: 2, closedAt: 3, closeReason: "needs-you" } } });
	await ctx.nexts.waitFor(out.body.item.itemId);
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.next.state, "done");
	assert.equal(item.next.facts.plan, null);
});

test("an untracked file in the thread's git repo gets a ship warning", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const repo = path.join(ctx.home, "repo");
	fs.mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
	fs.writeFileSync(path.join(repo, "new.txt"), "untracked");
	assert.equal((await postJson(ctx, "/api/threads/s1/meta", { cwd: repo })).status, 200);
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_A, "t3"));
	await ctx.nexts.waitFor(out.body.item.itemId);
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.next.state, "ship");
	assert.equal(item.next.facts.git.dirty, 1);
	assert.ok(item.next.warnings.includes("커밋 안 된 변경 1개"));
	assert.equal(item.next.actions[0].id, "commit-push");
});

test("a model summary with a ship hint stores m1 and recomputes the final", async (t) => {
	const ctx = await withServer(t);
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_A, "t4"));
	const itemId = out.body.item.itemId;
	await ctx.nexts.waitFor(itemId);
	const summary = {
		kind: "report",
		headline: "마무리",
		context: "c",
		body: "설치가 남았습니다.",
		ask: null,
		options: [],
		ifNoAnswer: null,
		terms: [],
		title: null,
		next: { state: "ship", actions: [{ label: "설치", prompt: "설치해" }] },
	};
	const stored = await postJson(ctx, `/api/items/${itemId}/summary`, { text: JSON.stringify(summary), model: "m" });
	assert.equal(stored.body.ok, true);
	await ctx.nexts.waitFor(itemId, 2);
	const item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.next.source, "model");
	assert.equal(item.next.state, "ship");
	assert.deepEqual(item.next.actions.filter((action) => action.id === "m1").map((action) => action.prompt), ["설치해"]);
});

test("progress items never get a next verdict", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const out = await postJson(ctx, "/api/threads/s1/items", { kind: "progress", policy: "progress", dedupeKey: "p1", raw: { text: "진행 중" } });
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.next, null);
});

test("a stall watchdog final gets a stalled verdict", async (t) => {
	const ctx = await withServer(t, {
		config: { summary: { enabled: false }, episode: { stallMinutes: 5 } },
	});
	const here = (idle = 1) => fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(ctx.home)}&session=s1&idle=${idle}`);
	await here();
	await postJson(ctx, "/api/threads/s1/items", {
		kind: "progress",
		policy: "progress",
		dedupeKey: "line:s1:m100",
		raw: { text: "진행 중", request: "첫 요청" },
		meta: { episode: { key: "e:s1:100", opener: 100, openedAt: START, seq: 100 } },
	});
	ctx.clock.at += 300_000;
	await here();
	ctx.timers.runDue(300_000);
	const items = (await getJson(ctx, "/api/threads/s1")).body.items;
	const final = items.find((item) => item.meta?.stalled === true);
	assert.ok(final, "the watchdog stored a final");
	await ctx.nexts.waitFor(final.itemId);
	const item = (await getJson(ctx, `/api/items/${final.itemId}`)).body;
	assert.equal(item.next.state, "stalled");
});

test("GET thread recomputes a next older than 30 seconds", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_A, "t7"));
	const itemId = out.body.item.itemId;
	await ctx.nexts.waitFor(itemId);
	ctx.clock.at += 31_000;
	assert.equal((await getJson(ctx, "/api/threads/s1")).status, 200);
	await ctx.nexts.waitFor(itemId, 2);
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.next.state, "done");
});

test("server start computes stored finals without a new post and list rows carry their labels", async (t) => {
	const tmp = makeTmpHome("inbox-next-start-");
	t.after(() => tmp.cleanup());
	const root = planRoot(tmp.home);
	const at = new Date(START).toISOString();
	seedThread(tmp.home, "seed-done", {
		events: [itemEvent(1, "i-260101-done01", EXAMPLE_A, at)],
	});
	seedThread(tmp.home, "seed-plan", {
		cwd: root,
		events: [
			itemEvent(1, "i-260101-plan01", EXAMPLE_B, at),
			{ seq: 2, at, type: "closed", itemId: "i-260101-plan01", reason: "session-closed", resolvedBy: null },
		],
	});
	fs.mkdirSync(path.join(tmp.home, "data"), { recursive: true });
	fs.writeFileSync(path.join(tmp.home, "data", "live.json"), JSON.stringify({ "seed-done": START }));

	const ctx = await withServer(t, { tmp, keepHome: true, clock: { at: START }, config: { summary: { enabled: false } } });
	await ctx.nexts.waitCount(2);
	const rows = (await getJson(ctx, "/api/threads")).body.items;
	const doneRow = rows.find((row) => row.session === "seed-done");
	const planRow = rows.find((row) => row.session === "seed-plan");
	assert.deepEqual(doneRow.next, { state: "done", label: "할 일 없음" });
	assert.deepEqual(planRow.next, { state: "plan", label: "실행 대기" });
	assert.equal((await getJson(ctx, "/api/items/i-260101-done01")).body.next.state, "done");
	assert.equal((await getJson(ctx, "/api/items/i-260101-plan01")).body.next.state, "plan");
});

test("a closed bye recomputes the actionable final with ended", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: root });
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_B, "t9"));
	const itemId = out.body.item.itemId;
	await ctx.nexts.waitFor(itemId);
	await postJson(ctx, "/api/bye", { session: "s1", closed: true });
	await ctx.nexts.waitFor(itemId, 2);
	const item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.closedReason, "session-closed");
	assert.equal(item.next.state, "plan");
	assert.equal(item.next.actions.some((action) => action.id === "close" || action.kind === "run"), false);
	assert.deepEqual(item.next.actions.map((action) => action.id), ["new-session"]);
});

test("a model summary posted after a closed bye keeps the ended plan verdict", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: root });
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_B, "t9b"));
	const itemId = out.body.item.itemId;
	await ctx.nexts.waitFor(itemId);
	await postJson(ctx, "/api/bye", { session: "s1", closed: true });
	await ctx.nexts.waitFor(itemId, 2);

	const summary = {
		kind: "report",
		headline: "계획 실행",
		context: "c",
		body: "계획이 남았습니다.",
		ask: null,
		options: [],
		ifNoAnswer: null,
		terms: [],
		title: null,
		next: null,
	};
	const stored = await postJson(ctx, `/api/items/${itemId}/summary`, { text: JSON.stringify(summary), model: "m" });
	assert.equal(stored.body.ok, true);
	await ctx.nexts.waitFor(itemId, 3);
	const item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.next.state, "plan");
	assert.equal(item.next.actions.some((action) => action.id === "close" || action.kind === "run"), false);
	assert.equal(item.next.actions[0].id, "new-session");
	assert.equal(item.next.actions[0].primary, true);
});

test("thread meta stores executes over HTTP and that thread gets no plan offer", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: root });
	const meta = await postJson(ctx, "/api/threads/s1/meta", { executes: PLAN_SLUG });
	assert.equal(meta.status, 200);
	assert.equal(meta.body.thread.executes, PLAN_SLUG);
	const file = path.join(ctx.home, "data", "threads", safeSegment("s1"), "thread.json");
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).executes, PLAN_SLUG);
	const out = await postJson(ctx, "/api/threads/s1/items", turnInput(EXAMPLE_B, "t10"));
	await ctx.nexts.waitFor(out.body.item.itemId);
	const item = (await getJson(ctx, `/api/items/${out.body.item.itemId}`)).body;
	assert.equal(item.next.state, "done");
	assert.equal(item.next.actions.some((action) => action.id === "new-session"), false);
});

const TAILNET = { "x-forwarded-for": "100.64.0.50", "tailscale-user-login": "owner@example.com" };
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeLauncher(calls = []) {
	return {
		async launch(input) {
			calls.push(input);
			return { ok: true, via: "wt" };
		},
		async reopen() {
			return { ok: true, via: "wt" };
		},
	};
}

function controlDir(home, sid) {
	return path.join(home, "control", safeSegment(sid));
}

function controlFiles(home, sid) {
	try {
		return fs.readdirSync(controlDir(home, sid)).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

function mailboxTexts(home, sid) {
	try {
		return fs
			.readdirSync(path.join(home, "mailbox", safeSegment(sid)))
			.filter((name) => name.endsWith(".json"))
			.map((name) => JSON.parse(fs.readFileSync(path.join(home, "mailbox", safeSegment(sid), name), "utf8")).text);
	} catch {
		return [];
	}
}

async function live(ctx, sid, watch = null) {
	const suffix = watch == null ? "" : `&watch=${watch}`;
	return fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(ctx.home)}&session=${sid}${suffix}`);
}

async function finalOf(ctx, sid, text, key) {
	const out = await postJson(ctx, `/api/threads/${sid}/items`, turnInput(text, key));
	await ctx.nexts.waitFor(out.body.item.itemId);
	return out.body.item.itemId;
}

function gitRepo(home, dirty = true) {
	const repo = path.join(home, "git-repo");
	fs.mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
	if (dirty) fs.writeFileSync(path.join(repo, "new.txt"), "untracked");
	return repo;
}

test("continue writes the action prompt into the mailbox and provider actions refresh the verdict", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_A, "a1");
	const actions = await postJson(ctx, "/api/threads/s1/actions", { producer: "pi", actions: [{ key: "go", label: "실행", prompt: "진행해" }] });
	assert.deepEqual(actions, { status: 200, body: { ok: true } });
	await ctx.nexts.waitFor(itemId, 2);
	const item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.next.actions.some((action) => action.id === "p:pi:go"), true);
	const tap = await postJson(ctx, `/api/items/${itemId}/action`, { action: "p:pi:go" });
	assert.equal(tap.status, 200);
	assert.equal(tap.body.via, "message");
	assert.equal(tap.body.off, true);
	assert.ok(tap.body.deliveryId);
	assert.deepEqual(mailboxTexts(ctx.home, "s1"), ["진행해"]);

	const bad = await postJson(ctx, "/api/threads/s1/actions", { producer: "BAD", actions: [{ key: "x y", label: "too long label", prompt: "" }] });
	assert.equal(bad.status, 400);
	assert.equal(bad.body.error, "bad_input");
	assert.ok(Array.isArray(bad.body.details) && bad.body.details.length > 0);
});

test("close on a live final writes a control file and the closed bye closes items closed-by-owner", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	await live(ctx, "s1");
	const itemId = await finalOf(ctx, "s1", EXAMPLE_A, "a2");
	const tap = await postJson(ctx, `/api/items/${itemId}/action`, { action: "close" });
	assert.equal(tap.status, 200);
	assert.equal(tap.body.via, "session");
	const files = controlFiles(ctx.home, "s1");
	assert.deepEqual(files, [`${tap.body.deliveryId}.json`]);
	const control = JSON.parse(fs.readFileSync(path.join(controlDir(ctx.home, "s1"), files[0]), "utf8"));
	assert.deepEqual({ ...control, issuedAt: "ignored" }, { v: 1, type: "session-control", action: "close", itemId, deliveryId: tap.body.deliveryId, issuedAt: "ignored" });
	await postJson(ctx, "/api/bye", { session: "s1", closed: true });
	const closed = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(closed.closedReason, "closed-by-owner");
	const ack = await postJson(ctx, `/api/items/${itemId}/delivered`, { deliveryId: tap.body.deliveryId, how: "control" });
	assert.deepEqual(ack, { status: 200, body: { ok: true, status: "closed" } });
});

test("close on an off thread closes its items at once; a dirty repo or live watch needs confirm", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const offId = await finalOf(ctx, "off", EXAMPLE_A, "a3");
	const off = await postJson(ctx, `/api/items/${offId}/action`, { action: "close" });
	assert.deepEqual(off, { status: 200, body: { ok: true, via: "offline" } });
	assert.equal((await getJson(ctx, `/api/items/${offId}`)).body.closedReason, "closed-by-owner");

	const repo = gitRepo(ctx.home);
	await live(ctx, "dirty");
	assert.equal((await postJson(ctx, "/api/threads/dirty/meta", { cwd: repo })).status, 200);
	const dirtyId = await finalOf(ctx, "dirty", EXAMPLE_A, "a4");
	const blocked = await postJson(ctx, `/api/items/${dirtyId}/action`, { action: "close" });
	assert.equal(blocked.status, 409);
	assert.equal(blocked.body.error, "confirm_required");
	assert.deepEqual(blocked.body.warnings, ["커밋 안 된 변경 1개"]);
	assert.deepEqual(controlFiles(ctx.home, "dirty"), []);
	const confirmed = await postJson(ctx, `/api/items/${dirtyId}/action`, { action: "close", confirm: true });
	assert.equal(confirmed.status, 200);
	assert.equal(confirmed.body.via, "session");

	await live(ctx, "watched", 1);
	const watchedId = await finalOf(ctx, "watched", EXAMPLE_A, "a5");
	const watchBlocked = await postJson(ctx, `/api/items/${watchedId}/action`, { action: "close" });
	assert.equal(watchBlocked.status, 409);
	assert.equal(watchBlocked.body.error, "confirm_required");
	assert.deepEqual(watchBlocked.body.warnings, ["상시 감시 1개가 함께 꺼집니다"]);
	assert.deepEqual(controlFiles(ctx.home, "watched"), []);
});

test("commit-push after the repo became clean answers stale with the fresh next", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const repo = gitRepo(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: repo });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_A, "a6");
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.next.actions[0].id, "commit-push");
	fs.rmSync(path.join(repo, "new.txt"));
	const stale = await postJson(ctx, `/api/items/${itemId}/action`, { action: "commit-push" });
	assert.equal(stale.status, 409);
	assert.equal(stale.body.error, "stale");
	assert.equal(stale.body.next.facts.git.dirty, 0);
	assert.equal(stale.body.next.actions.some((action) => action.id === "commit-push"), false);
	assert.deepEqual(mailboxTexts(ctx.home, "s1"), []);
});

test("new-session launches a uuidv7 sid in the plan root, excludes the executor, and connects on here", async (t) => {
	const calls = [];
	const ctx = await withServer(t, { reopener: fakeLauncher(calls), config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/old/meta", { cwd: root });
	await live(ctx, "old");
	const itemId = await finalOf(ctx, "old", EXAMPLE_B, "a7");
	const tap = await postJson(ctx, `/api/items/${itemId}/action`, { action: "new-session" });
	assert.equal(tap.status, 200);
	assert.equal(tap.body.via, "wt");
	assert.match(tap.body.session, UUID7);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].sid, tap.body.session);
	assert.equal(calls[0].folder, root);
	assert.equal(calls[0].message, `/skill:ulw-execute ${PLAN_SLUG}`);
	const launching = (await getJson(ctx, "/api/threads/old")).body.thread.handoff;
	assert.equal(launching.status, "launching");
	assert.equal(launching.to, tap.body.session);
	assert.equal(launching.slug, PLAN_SLUG);

	await postJson(ctx, `/api/threads/${tap.body.session}/meta`, { cwd: root });
	const ownId = await finalOf(ctx, tap.body.session, EXAMPLE_B, "a8");
	const own = (await getJson(ctx, `/api/items/${ownId}`)).body;
	assert.equal(own.next.state, "done");
	assert.equal(own.next.actions.some((action) => action.id === "new-session"), false);

	assert.equal((await live(ctx, tap.body.session)).status, 200);
	const connected = (await getJson(ctx, "/api/threads/old")).body.thread.handoff;
	assert.equal(connected.status, "connected");
	assert.equal(controlFiles(ctx.home, "old").length, 1);
	await postJson(ctx, "/api/bye", { session: "old", closed: true });
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.closedReason, "handed-off");
});

test("new-session in a linked worktree launches in the main checkout that holds the plan", async (t) => {
	const calls = [];
	const ctx = await withServer(t, { reopener: fakeLauncher(calls), config: { summary: { enabled: false } } });
	const main = path.join(ctx.home, "main-repo");
	fs.mkdirSync(main, { recursive: true });
	execFileSync("git", ["init"], { cwd: main, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: main, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "test"], { cwd: main, stdio: "ignore" });
	fs.writeFileSync(path.join(main, "seed.txt"), "seed");
	execFileSync("git", ["add", "."], { cwd: main, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "seed"], { cwd: main, stdio: "ignore" });
	fs.mkdirSync(path.join(main, ".omo", "plans"), { recursive: true });
	fs.writeFileSync(path.join(main, ".omo", "plans", `${PLAN_SLUG}.md`), "- [ ] first\n- [ ] second\n");
	const worktree = path.join(ctx.home, "linked-wt");
	execFileSync("git", ["worktree", "add", worktree, "-b", "linked"], { cwd: main, stdio: "ignore" });

	await postJson(ctx, "/api/threads/s1/meta", { cwd: worktree });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_B, "a18");
	const item = (await getJson(ctx, `/api/items/${itemId}`)).body;
	assert.equal(item.next.facts.plan.root, path.resolve(main));

	const tap = await postJson(ctx, `/api/items/${itemId}/action`, { action: "new-session" });
	assert.equal(tap.status, 200);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].folder, path.resolve(main));
	assert.equal(calls[0].message, `/skill:ulw-execute ${PLAN_SLUG}`);
});

test("new-session through the real sink writes one launch line and leaves the handoff launching", async (t) => {
	const tmp = makeTmpHome("inbox-next-sink-");
	t.after(() => tmp.cleanup());
	const binDir = path.join(tmp.home, "bin");
	const localAppData = path.join(tmp.home, "local");
	const sink = path.join(tmp.home, "sink.jsonl");
	fs.mkdirSync(binDir);
	fs.mkdirSync(localAppData);
	fs.writeFileSync(path.join(binDir, "wt.exe"), "");
	fs.writeFileSync(path.join(binDir, "omo.exe"), "");

	const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA, INBOX_REOPEN_SINK: process.env.INBOX_REOPEN_SINK };
	process.env.PATH = binDir + path.delimiter + (saved.PATH ?? "");
	process.env.LOCALAPPDATA = localAppData;
	process.env.INBOX_REOPEN_SINK = sink;
	// The server reads process.env when the action arrives, so the fake wt/omo must stay on PATH until the test ends.
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const ctx = await withServer(t, { tmp, keepHome: true, config: { summary: { enabled: false } } });

	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: root });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_B, "a19");
	const tap = await postJson(ctx, `/api/items/${itemId}/action`, { action: "new-session" });
	assert.equal(tap.status, 200);
	assert.equal(tap.body.via, "sink");

	const lines = fs.readFileSync(sink, "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	const entry = JSON.parse(lines[0]);
	assert.equal(entry.kind, "launch");
	const rootPosix = path.resolve(root).replace(/\\/g, "/");
	const attempt = entry.attempts.find((candidate) => candidate.args.includes(rootPosix) && candidate.args.includes(`/skill:ulw-execute ${PLAN_SLUG}`));
	assert.ok(attempt, "the sink line carries the plan root and the kickoff");
	assert.equal(attempt.args[attempt.args.indexOf("-d") + 1], rootPosix);
	assert.deepEqual((await getJson(ctx, "/api/threads/s1")).body.thread.handoff.status, "launching");
});

test("new-session on an off thread closes its open items handed-off at once", async (t) => {
	const calls = [];
	let release;
	let entered;
	const gate = new Promise((resolve) => { release = resolve; });
	const started = new Promise((resolve) => { entered = resolve; });
	const reopener = {
		async launch(input) {
			calls.push(input);
			entered();
			await gate;
			return { ok: true, via: "wt" };
		},
		async reopen() {
			return { ok: true, via: "wt" };
		},
	};
	const ctx = await withServer(t, { reopener, config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: root });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_B, "a9");
	await postJson(ctx, "/api/bye", { session: "s1", closed: true });
	await ctx.nexts.waitFor(itemId, 2);
	const pending = postJson(ctx, `/api/items/${itemId}/action`, { action: "new-session" });
	await started;
	const extra = await postJson(ctx, "/api/threads/s1/items", { kind: "progress", policy: "quiet", dedupeKey: "progress-late", raw: { text: "late" } });
	release();
	const tap = await pending;
	assert.equal(tap.status, 200);
	assert.equal(calls.length, 1);
	assert.equal((await getJson(ctx, `/api/items/${extra.body.item.itemId}`)).body.closedReason, "handed-off");
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.closedReason, "session-closed");
	assert.deepEqual(controlFiles(ctx.home, "s1"), []);
});

test("new-session answers plan_missing for a deleted plan and stale when every plan row is checked", async (t) => {
	const calls = [];
	const ctx = await withServer(t, { reopener: fakeLauncher(calls), config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: root });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_B, "a10");
	fs.rmSync(path.join(root, ".omo", "plans", `${PLAN_SLUG}.md`));
	const missing = await postJson(ctx, `/api/items/${itemId}/action`, { action: "new-session" });
	assert.deepEqual(missing, { status: 409, body: { error: "plan_missing" } });
	assert.equal(calls.length, 0);

	const root2 = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s2/meta", { cwd: root2 });
	const planId = await finalOf(ctx, "s2", EXAMPLE_B, "a11");
	fs.writeFileSync(path.join(root2, ".omo", "plans", `${PLAN_SLUG}.md`), "- [x] first\n- [x] second\n");
	const stale = await postJson(ctx, `/api/items/${planId}/action`, { action: "new-session" });
	assert.equal(stale.status, 409);
	assert.equal(stale.body.error, "stale");
	assert.equal(calls.length, 0);
});

test("a session-closed plan final still launches; a ship final commit-push becomes a free message", async (t) => {
	const calls = [];
	const ctx = await withServer(t, { reopener: fakeLauncher(calls), config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/plan/meta", { cwd: root });
	const planId = await finalOf(ctx, "plan", EXAMPLE_B, "a13");
	await postJson(ctx, "/api/bye", { session: "plan", closed: true });
	await ctx.nexts.waitFor(planId, 2);
	const launch = await postJson(ctx, `/api/items/${planId}/action`, { action: "new-session" });
	assert.equal(launch.status, 200);
	assert.equal(calls.length, 1);
	assert.equal((await getJson(ctx, "/api/threads/plan")).body.thread.handoff.status, "launching");
	const closedClose = await postJson(ctx, `/api/items/${planId}/action`, { action: "close" });
	assert.equal(closedClose.status, 409);
	assert.equal(closedClose.body.error, "closed");

	const repo = gitRepo(ctx.home);
	await postJson(ctx, "/api/threads/ship/meta", { cwd: repo });
	const shipId = await finalOf(ctx, "ship", EXAMPLE_A, "a14");
	await postJson(ctx, "/api/bye", { session: "ship", closed: true });
	await ctx.nexts.waitFor(shipId, 2);
	const push = await postJson(ctx, `/api/items/${shipId}/action`, { action: "commit-push" });
	assert.equal(push.status, 200);
	assert.equal(push.body.via, "message");
	assert.equal(push.body.off, true);
	assert.deepEqual(mailboxTexts(ctx.home, "ship"), ["변경을 커밋하고 푸시해"]);
	assert.equal(ctx.server.threads.actionableFinal("ship"), null);
	assert.deepEqual(await postJson(ctx, `/api/items/${shipId}/action`, { action: "commit-push" }), { status: 409, body: { error: "closed", reason: "session-closed" } });
	assert.deepEqual(mailboxTexts(ctx.home, "ship"), ["변경을 커밋하고 푸시해"]);
	assert.equal((await postJson(ctx, `/api/items/${shipId}/action`, { action: "close" })).status, 409);
});

test("unknown, closed, off-run, tailnet and funnel actions follow the route contract", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_A, "a15");
	assert.equal((await postJson(ctx, `/api/items/${itemId}/action`, { action: "nope" })).status, 400);
	assert.equal((await postJson(ctx, "/api/items/i-260101-missing/action", { action: "close" })).status, 404);

	await live(ctx, "run");
	const runId = await finalOf(ctx, "run", EXAMPLE_A, "a16");
	await postJson(ctx, "/api/threads/run/actions", { producer: "pi", actions: [{ key: "r1", label: "실행", run: true }] });
	await ctx.nexts.waitFor(runId, 2);
	assert.equal((await getJson(ctx, `/api/items/${runId}`)).body.next.actions.some((action) => action.id === "p:pi:r1"), true);
	ctx.clock.at += 91_000;
	assert.deepEqual(await postJson(ctx, `/api/items/${runId}/action`, { action: "p:pi:r1" }), { status: 409, body: { error: "off" } });

	await live(ctx, "phone");
	const phoneId = await finalOf(ctx, "phone", EXAMPLE_A, "a17");
	const phone = await postJson(ctx, `/api/items/${phoneId}/action`, { action: "close" }, TAILNET);
	assert.equal(phone.status, 200);
	const funnel = await postJson(ctx, `/api/items/${phoneId}/action`, { action: "close" }, { ...TAILNET, "tailscale-funnel-request": "1" });
	assert.equal(funnel.status, 403);

	await postJson(ctx, `/api/items/${phoneId}/close`, { reason: "superseded" });
	assert.equal((await postJson(ctx, `/api/items/${phoneId}/action`, { action: "close" })).status, 409);
});

test("a dropped control ack lets a later ordinary quit close items as session-closed", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	await live(ctx, "s1");
	const itemId = await finalOf(ctx, "s1", EXAMPLE_A, "a20");
	const tap = await postJson(ctx, `/api/items/${itemId}/action`, { action: "close" });
	assert.equal(tap.status, 200);
	assert.equal(tap.body.via, "session");
	const ack = await postJson(ctx, `/api/items/${itemId}/delivered`, { deliveryId: tap.body.deliveryId, how: "dropped", detail: "stale" });
	assert.deepEqual(ack, { status: 200, body: { ok: true, status: "delivered" } });
	await postJson(ctx, "/api/bye", { session: "s1", closed: true });
	assert.equal((await getJson(ctx, `/api/items/${itemId}`)).body.closedReason, "session-closed");
});

test("two concurrent new-session taps launch once and the second gets busy", async (t) => {
	const calls = [];
	let release;
	let entered;
	const gate = new Promise((resolve) => { release = resolve; });
	const started = new Promise((resolve) => { entered = resolve; });
	const reopener = {
		async launch(input) {
			calls.push(input);
			entered();
			await gate;
			return { ok: true, via: "wt" };
		},
		async reopen() {
			return { ok: true, via: "wt" };
		},
	};
	const ctx = await withServer(t, { reopener, config: { summary: { enabled: false } } });
	const root = planRoot(ctx.home);
	await postJson(ctx, "/api/threads/s1/meta", { cwd: root });
	const itemId = await finalOf(ctx, "s1", EXAMPLE_B, "a21");
	const first = postJson(ctx, `/api/items/${itemId}/action`, { action: "new-session" });
	await started;
	const second = await postJson(ctx, `/api/items/${itemId}/action`, { action: "new-session" });
	assert.equal(second.status, 409);
	assert.equal(second.body.error, "busy");
	release();
	const launched = await first;
	assert.equal(launched.status, 200);
	assert.equal(calls.length, 1);
});

test("close stops the startup next walk after the in-flight probe", async (t) => {
	const tmp = makeTmpHome("inbox-next-close-");
	t.after(() => tmp.cleanup());
	for (const sid of ["c1", "c2", "c3"]) seedThread(tmp.home, sid, { events: [itemEvent(1, `i-260101-${sid}`, EXAMPLE_A, new Date(START).toISOString())] });
	let computed = 0;
	const server = createServer({
		home: tmp.home,
		webDir: path.join(tmp.home, "web"),
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: [], summary: { enabled: false } },
		now: () => new Date(START),
		onNextComputed: () => { computed++; },
	});
	await server.listen();
	await server.close();
	assert.ok(computed < 3, `startup walk computed ${computed} of 3 threads`);
});

test("here watch reaches the verdict; a non-integer watch is ignored", async (t) => {
	const ctx = await withServer(t, { config: { summary: { enabled: false } } });
	const here = (sid, watch) => fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(ctx.home)}&session=${sid}&watch=${encodeURIComponent(watch)}`);
	assert.equal((await here("watched", "2")).status, 200);
	const first = await postJson(ctx, "/api/threads/watched/items", turnInput(EXAMPLE_A, "t11"));
	await ctx.nexts.waitFor(first.body.item.itemId);
	const watched = (await getJson(ctx, `/api/items/${first.body.item.itemId}`)).body;
	assert.ok(watched.next.warnings.includes("상시 감시 2개가 함께 꺼집니다"));
	assert.equal(watched.next.facts.watch, 2);

	assert.equal((await here("ignored", "abc")).status, 200);
	const second = await postJson(ctx, "/api/threads/ignored/items", turnInput(EXAMPLE_A, "t12"));
	await ctx.nexts.waitFor(second.body.item.itemId);
	const ignored = (await getJson(ctx, `/api/items/${second.body.item.itemId}`)).body;
	assert.equal(ignored.next.warnings.some((warning) => warning.startsWith("상시 감시")), false);
	assert.equal(ignored.next.facts.watch, 0);
});
