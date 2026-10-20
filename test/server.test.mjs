import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createServer } from "../src/server.mjs";
import { identityFor } from "../src/identity.mjs";
import { safeSegment } from "../src/paths.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(REPO, "web");
const toSlash = (value) => String(value).replace(/\\/g, "/");

function board() {
	return {
		title: "테스트 보드",
		sections: [
			{
				title: "화면",
				cards: [{ title: "로그인", frames: [["로그인 화면", "screen.svg"]] }],
			},
		],
		questions: [
			{
				id: "q1",
				text: "어떻게 할까요?",
				options: [
					{ value: "a", label: "A안" },
					{ value: "b", label: "B안" },
				],
			},
		],
	};
}

function makeBoard(home, name = "proto") {
	const dir = path.join(home, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(board()));
	fs.writeFileSync(path.join(dir, "screen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	fs.writeFileSync(path.join(dir, "screen.mmd"), "flowchart TD\n\tA-->B\n");
	return dir;
}

function reportBoard(home, name = "report") {
	const dir = path.join(home, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "board.json"),
		JSON.stringify({
			title: "완료 보고",
			kind: "report",
			sections: [{ title: "결과", cards: [{ title: "화면", frames: [["완료 화면", "screen.svg"]] }] }],
		}),
	);
	fs.writeFileSync(path.join(dir, "screen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	return dir;
}

async function withServer(t, options = {}) {
	const tmp = makeTmpHome("inbox-srv-");
	const server = createServer({
		home: tmp.home,
		webDir: options.webDir || WEB,
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: ["100.64.0.9"], ...(options.config || {}) },
		...(options.now ? { now: options.now } : {}),
		...(options.asidePath ? { asidePath: options.asidePath } : {}),
		...(options.pusher ? { pusher: options.pusher } : {}),
	});
	const { port } = await server.listen();
	t.after(async () => {
		await server.close();
		tmp.cleanup();
	});
	return { home: tmp.home, server, port, base: `http://127.0.0.1:${port}` };
}

function postJson(base, p, body, headers = {}) {
	return fetch(base + p, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1", ...headers },
		body: JSON.stringify(body),
	});
}

function rawGet(port, rawPath, headers = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", headers }, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => (data += chunk));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		req.end();
	});
}

async function submit(ctx, { srcDir, session = "s1", title = "기획안", extra = {} } = {}) {
	const identity = await identityFor(srcDir, {});
	const body = {
		cwd: srcDir,
		identity: { ...identity, session: { id: session, file: null } },
		title,
		srcDir,
		...extra,
	};
	const res = await postJson(ctx.base, "/api/proposals", body);
	return { res, body: await res.json() };
}

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function waitForText(file, pattern, ms = 3000) {
	const read = () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
	if (pattern.test(read())) return Promise.resolve(read());
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const signal = AbortSignal.timeout(ms);
	return new Promise((resolve, reject) => {
		let watcher;
		const onAbort = () => {
			watcher?.close();
			reject(new Error(`log never matched ${pattern}`));
		};
		const done = (text) => {
			watcher?.close();
			signal.removeEventListener("abort", onAbort);
			resolve(text);
		};
		signal.addEventListener("abort", onAbort);
		watcher = fs.watch(path.dirname(file), () => {
			const text = read();
			if (pattern.test(text)) done(text);
		});
	});
}

test("health reports the service with no-store", async (t) => {
	const ctx = await withServer(t);
	const res = await fetch(`${ctx.base}/api/health`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	const body = await res.json();
	assert.equal(body.ok, true);
	assert.equal(body.name, "omo-inbox");
	assert.equal(body.port, ctx.port);
	assert.equal(typeof body.version, "string");
	assert.ok(body.pid > 0);
});

test("submit returns summary and url", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { res, body } = await submit(ctx, { srcDir: dir, title: "로그인 개편" });
	assert.equal(res.status, 200);
	assert.equal(body.existing, false);
	assert.equal(body.summary.title, "로그인 개편");
	assert.equal(body.summary.status, "mine");
	assert.equal(body.summary.rev, 1);
	assert.equal(body.url, `${ctx.base}/p/${body.summary.id}`);
});

test("invalid board is rejected with details", async (t) => {
	const ctx = await withServer(t);
	const dir = path.join(ctx.home, "broken");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), "{ not json");
	const res = await postJson(ctx.base, "/api/proposals", { cwd: dir, srcDir: dir, title: "깨짐" });
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.equal(body.error, "invalid_board");
	assert.ok(Array.isArray(body.details) && body.details.length > 0);
});

test("feedback routes to the owner, writes the inbox, stores client and ua", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-1", title: "의견" });
	const id = sub.summary.id;

	const res = await postJson(
		ctx.base,
		`/api/p/${id}/feedback`,
		{ rev: 1, verdict: "change", comment: "고쳐 주세요" },
		{ "user-agent": "inbox-test/1.0" },
	);
	assert.equal(res.status, 200);
	const fb = await res.json();
	assert.equal(fb.ok, true);
	assert.equal(fb.routed, "owner-1");
	assert.equal(fb.delivery, "pending");
	assert.equal(fb.status, "theirs");
	assert.equal(typeof fb.seq, "number");

	const inbox = path.join(ctx.home, "mailbox", safeSegment("owner-1"), `${id}-${String(fb.seq).padStart(6, "0")}.json`);
	assert.ok(fs.existsSync(inbox), "inbox file exists");
	const payload = JSON.parse(fs.readFileSync(inbox, "utf8"));
	assert.equal(payload.proposalId, id);
	assert.match(payload.text, /\[omo-inbox\] 의견이 왔습니다/);
	assert.ok(payload.text.includes(`node "` + toSlash(path.join(ctx.home, "app", "bin", "inbox.mjs")) + `" show ${id}`));

	const detail = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	const event = detail.events.find((item) => item.type === "feedback");
	assert.equal(event.client, "127.0.0.1");
	assert.equal(event.ua, "inbox-test/1.0");
	assert.equal(event.delivery, "pending");
});

test("feedback with an unknown frame label is bad_input", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-2" });
	const res = await postJson(ctx.base, `/api/p/${sub.summary.id}/feedback`, {
		rev: 1,
		verdict: "change",
		marks: [{ frame: "없는 라벨", x: 0, y: 0, w: 0.2, h: 0.2 }],
	});
	assert.equal(res.status, 400);
	assert.equal((await res.json()).error, "bad_input");
});

test("a .mmd revision file is served as plain text", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const res = await fetch(`${ctx.base}/files/${sub.summary.id}/revs/1/screen.mmd`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
	assert.match(await res.text(), /flowchart/);
});

test("bad percent-encoding in a file path is bad_input", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const res = await rawGet(ctx.port, `/files/${sub.summary.id}/revs/1/%E0%A4%A`);
	assert.equal(res.status, 400);
});

test("path traversal in a file route is forbidden", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const id = sub.summary.id;
	const plain = await rawGet(ctx.port, `/files/${id}/revs/1/../../proposal.json`);
	assert.equal(plain.status, 403);
	const encoded = await rawGet(ctx.port, `/files/${id}/revs/1/%2e%2e/%2e%2e/proposal.json`);
	assert.equal(encoded.status, 403);
});

test("revision files are immutable and svg is typed", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const res = await fetch(`${ctx.base}/files/${sub.summary.id}/revs/1/screen.svg`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "image/svg+xml");
	assert.match(res.headers.get("cache-control"), /immutable/);
});

test("list and facets describe submitted proposals", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, title: "목록" });
	const res = await fetch(`${ctx.base}/api/proposals`);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.items.length, 1);
	assert.equal(body.items[0].id, sub.summary.id);
	assert.equal(body.items[0].url, `${ctx.base}/p/${sub.summary.id}`);
	assert.ok(Array.isArray(body.facets) && body.facets.length === 1);
	assert.equal(body.facets[0].count, 1);
});

test("proposal counts stay overall across filters", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	await submit(ctx, { srcDir: dir, title: "내 차례" });
	const theirs = await submit(ctx, { srcDir: dir, title: "상대 차례" });
	const closed = await submit(ctx, { srcDir: dir, title: "닫힘" });
	await postJson(ctx.base, `/api/p/${theirs.body.summary.id}/feedback`, { rev: 1, verdict: "change", comment: "수정" });
	await postJson(ctx.base, `/api/p/${closed.body.summary.id}/close`, { summary: "완료" });
	for (const status of ["open", "mine", "theirs", "closed", "all"]) {
		const res = await fetch(`${ctx.base}/api/proposals?status=${status}`);
		assert.equal(res.status, 200, status);
		const body = await res.json();
		assert.deepEqual(body.counts, { mine: 1, theirs: 1, closed: 1, reports: 0 }, status);
	}
});

test("a report submit keeps its kind and an ack with a comment routes to the owner", async (t) => {
	const ctx = await withServer(t);
	const dir = reportBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-report", title: "완료 보고" });
	assert.equal(sub.summary.kind, "report");
	assert.equal(sub.summary.status, "mine");
	const id = sub.summary.id;

	const listed = await (await fetch(`${ctx.base}/api/proposals`)).json();
	assert.equal(listed.items[0].kind, "report");
	assert.equal(listed.counts.reports, 1);

	const res = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "ack", comment: "확인했습니다" });
	assert.equal(res.status, 200);
	const fb = await res.json();
	assert.equal(fb.status, "theirs");
	assert.equal(fb.routed, "owner-report");
	assert.equal(fb.delivery, "pending");
	const inbox = path.join(ctx.home, "mailbox", safeSegment("owner-report"), `${id}-${String(fb.seq).padStart(6, "0")}.json`);
	assert.ok(fs.existsSync(inbox), "inbox file exists");

	const detail = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	assert.equal(detail.summary.kind, "report");
	assert.equal(detail.events.some((event) => event.type === "closed"), false);

	const closed = await postJson(ctx.base, `/api/p/${id}/close`, { summary: "확인", session: { id: "owner-report" } });
	assert.equal(closed.status, 200);
	assert.equal((await closed.json()).summary.status, "closed");
});

test("a comment-less ack closes by the user with no delivery", async (t) => {
	const ctx = await withServer(t);
	const dir = reportBoard(ctx.home, "report-2");
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-ack", title: "완료 보고 2" });
	const id = sub.summary.id;
	assert.equal((await (await fetch(`${ctx.base}/api/proposals`)).json()).counts.reports, 1);

	const res = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "ack" });
	assert.equal(res.status, 200);
	const fb = await res.json();
	assert.equal(fb.delivery, "none");
	assert.equal(fb.status, "closed");
	assert.equal(fb.routed, "owner-ack");

	const detail = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	const feedback = detail.events.find((event) => event.type === "feedback");
	assert.equal(feedback.verdict, "ack");
	assert.equal(feedback.delivery, "none");
	const closed = detail.events.find((event) => event.type === "closed");
	assert.equal(closed.by, "user");
	assert.equal(detail.summary.status, "closed");
	assert.equal(detail.summary.outcome, null);

	const inboxDir = path.join(ctx.home, "mailbox", safeSegment("owner-ack"));
	if (fs.existsSync(inboxDir)) assert.deepEqual(fs.readdirSync(inboxDir), []);
	assert.equal((await (await fetch(`${ctx.base}/api/proposals`)).json()).counts.reports, 0);

	const again = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "ack" });
	assert.equal(again.status, 409);
	assert.equal((await again.json()).error, "closed");
});

test("report and decision boards reject the other verdict and a question-ful report", async (t) => {
	const ctx = await withServer(t);
	const report = reportBoard(ctx.home, "report-3");
	const decision = makeBoard(ctx.home, "decision-3");

	const reportSub = await submit(ctx, { srcDir: report, session: "owner-v", title: "보고" });
	const approve = await postJson(ctx.base, `/api/p/${reportSub.body.summary.id}/feedback`, { rev: 1, verdict: "approve" });
	assert.equal(approve.status, 400);
	assert.equal((await approve.json()).error, "bad_input");

	const decisionSub = await submit(ctx, { srcDir: decision, session: "owner-v", title: "결정" });
	assert.equal(decisionSub.body.summary.kind, "decision");
	const ack = await postJson(ctx.base, `/api/p/${decisionSub.body.summary.id}/feedback`, { rev: 1, verdict: "ack" });
	assert.equal(ack.status, 400);
	assert.equal((await ack.json()).error, "bad_input");

	const bad = path.join(ctx.home, "report-q");
	fs.mkdirSync(bad, { recursive: true });
	const questionBoard = JSON.parse(fs.readFileSync(path.join(report, "board.json"), "utf8"));
	questionBoard.questions = [{ id: "q1", text: "왜?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }];
	fs.writeFileSync(path.join(bad, "board.json"), JSON.stringify(questionBoard));
	fs.copyFileSync(path.join(report, "screen.svg"), path.join(bad, "screen.svg"));
	const attempted = await submit(ctx, { srcDir: bad, title: "질문 있는 보고" });
	assert.equal(attempted.res.status, 400);
	assert.equal(attempted.body.error, "invalid_board");
	assert.ok(attempted.body.details.some((line) => line.includes("questions")), JSON.stringify(attempted.body.details));

	const revised = await postJson(ctx.base, `/api/p/${reportSub.body.summary.id}/revise`, { srcDir: decision, session: { id: "owner-v" } });
	assert.equal(revised.status, 400);
	assert.equal((await revised.json()).error, "bad_input");
});

test("submit without kind reads as a decision board", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home, "decision-4");
	const { body: sub } = await submit(ctx, { srcDir: dir, title: "기본 결정" });
	assert.equal(sub.summary.kind, "decision");
});

test("tailnet feedback is accepted but tailnet session writes are forbidden", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-3" });
	const headers = { "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "me@x" };
	const fb = await postJson(ctx.base, `/api/p/${sub.summary.id}/feedback`, { rev: 1, verdict: "approve" }, headers);
	assert.equal(fb.status, 200);
	const write = await postJson(ctx.base, "/api/proposals", { cwd: dir, srcDir: dir, title: "tailnet" }, headers);
	assert.equal(write.status, 403);
	assert.equal((await write.json()).error, "forbidden");
});

test("the tailscale funnel header is rejected everywhere", async (t) => {
	const ctx = await withServer(t);
	const res = await fetch(`${ctx.base}/api/health`, { headers: { "tailscale-funnel-request": "1" } });
	assert.equal(res.status, 403);
});

test("POST without the x-inbox guard is forbidden", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const res = await fetch(`${ctx.base}/api/proposals`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: dir, srcDir: dir, title: "no guard" }),
	});
	assert.equal(res.status, 403);
});

test("reply, revise and close move the status, then feedback is closed", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-4" });
	const id = sub.summary.id;

	const revised = await postJson(ctx.base, `/api/p/${id}/revise`, { srcDir: makeBoard(ctx.home, "proto-r2"), session: { id: "owner-4" } });
	assert.equal(revised.status, 200);
	const revisedBody = await revised.json();
	assert.equal(revisedBody.summary.rev, 2);
	assert.equal(revisedBody.summary.status, "mine");
	assert.equal(revisedBody.url, `${ctx.base}/p/${id}`);

	const replied = await postJson(ctx.base, `/api/p/${id}/reply`, { text: "확인했습니다", session: { id: "owner-4" } });
	assert.equal(replied.status, 200);
	assert.equal((await replied.json()).summary.status, "mine");

	const closed = await postJson(ctx.base, `/api/p/${id}/close`, { summary: "완료", session: { id: "owner-4" } });
	assert.equal(closed.status, 200);
	assert.equal((await closed.json()).summary.status, "closed");

	const after = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 2, verdict: "approve" });
	assert.equal(after.status, 409);
	assert.equal((await after.json()).error, "closed");
});

test("dismiss is not found and leaves the proposal unchanged", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-5" });
	const id = sub.summary.id;
	const before = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	const res = await postJson(ctx.base, `/api/p/${id}/dismiss`, {});
	assert.equal(res.status, 404);
	assert.deepEqual(await res.json(), { error: "not_found" });
	const after = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	assert.equal(after.status, before.status);
});

test("an identical resubmit is idempotent, changed content is a duplicate", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const first = await submit(ctx, { srcDir: dir, title: "중복" });
	assert.equal(first.body.existing, false);

	const again = await submit(ctx, { srcDir: dir, title: "중복" });
	assert.equal(again.res.status, 200);
	assert.equal(again.body.existing, true);
	assert.equal(again.body.summary.id, first.body.summary.id);

	const parsed = board();
	parsed.lead = "바뀐 내용";
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(parsed));
	const changed = await submit(ctx, { srcDir: dir, title: "중복" });
	assert.equal(changed.res.status, 409);
	const changedBody = await changed.body;
	assert.equal(changedBody.error, "duplicate");
	assert.equal(changedBody.id, first.body.summary.id);
	assert.equal(changedBody.url, `${ctx.base}/p/${first.body.summary.id}`);
});

test("peer access: pc classification follows x-forwarded-for", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-6" });
	const res = await postJson(
		ctx.base,
		`/api/p/${sub.summary.id}/feedback`,
		{ rev: 1, verdict: "change", comment: "pc" },
		{ "x-forwarded-for": "100.64.0.9" },
	);
	assert.equal(res.status, 200);
	const detail = await (await fetch(`${ctx.base}/api/p/${sub.summary.id}`)).json();
	const event = detail.events.find((item) => item.type === "feedback");
	assert.equal(event.via, "pc");
	assert.equal(event.client, "100.64.0.9");
});

test("configured owner rejects another tailscale login", async (t) => {
	const ctx = await withServer(t, { config: { owner: "me@x" } });
	const dir = makeBoard(ctx.home);
	const res = await postJson(
		ctx.base,
		"/api/proposals",
		{ cwd: dir, srcDir: dir, title: "남의 로그인" },
		{ "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "other@x" },
	);
	assert.equal(res.status, 403);
});

test("caps hides pc targets from the tailnet", async (t) => {
	const ctx = await withServer(t);
	const tailnet = await (
		await fetch(`${ctx.base}/api/caps`, { headers: { "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "me@x" } })
	).json();
	assert.equal(tailnet.access, "tailnet");
	assert.equal(tailnet.open, false);
	assert.ok(tailnet.targets.length > 0);
	assert.ok(tailnet.targets.every((target) => target.where !== "pc"));

	const local = await (await fetch(`${ctx.base}/api/caps`)).json();
	assert.equal(local.access, "local");
	assert.equal(local.open, true);
	assert.ok(local.targets.some((target) => target.where === "pc"));
});

test("open dry-runs every target and forbids the tailnet", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const targets = JSON.parse(fs.readFileSync(path.join(WEB, "targets.json"), "utf8"));
	for (const target of targets) {
		const res = await postJson(ctx.base, "/api/open", { target: target.id, q: "hello", proposalId: sub.summary.id, dry: true });
		assert.equal(res.status, 200, target.id);
		const body = await res.json();
		assert.equal(body.ok, true);
		assert.equal(body.dry, true);
		assert.ok(Array.isArray(body.cmd), target.id);
		if (target.id === "aside") assert.equal(body.cmd[1], "--single-argument");
		else if (target.copy) assert.equal(body.cmd.length, 0);
		else assert.equal(body.cmd[0], "rundll32");
	}
	const denied = await postJson(
		ctx.base,
		"/api/open",
		{ target: "chatgpt", q: "hello", dry: true },
		{ "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "me@x" },
	);
	assert.equal(denied.status, 403);
});

test("a body over 30 MiB is too long", async (t) => {
	const ctx = await withServer(t);
	const big = `"${"x".repeat(30 * 1024 * 1024 + 1)}"`;
	const res = await fetch(`${ctx.base}/api/proposals`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: big,
	});
	assert.equal(res.status, 413);
});

test("static pages come from webDir", async (t) => {
	const tmp = makeTmpHome("inbox-web-");
	t.after(() => tmp.cleanup());
	const dir = path.join(tmp.home, "web");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "inbox.html"), "<h1>inbox</h1>");
	fs.writeFileSync(path.join(dir, "proposal.html"), "<h1>proposal</h1>");
	fs.writeFileSync(path.join(dir, "app.js"), "console.log(1);");
	fs.copyFileSync(path.join(WEB, "targets.json"), path.join(dir, "targets.json"));

	const ctx = await withServer(t, { webDir: dir });
	const inbox = await fetch(`${ctx.base}/`);
	assert.equal(inbox.status, 200);
	assert.equal(inbox.headers.get("content-type"), "text/html; charset=utf-8");
	assert.match(await inbox.text(), /inbox/);

	const proposal = await fetch(`${ctx.base}/p/whatever`);
	assert.equal(proposal.status, 200);
	assert.match(await proposal.text(), /proposal/);

	const js = await fetch(`${ctx.base}/web/app.js`);
	assert.equal(js.status, 200);
	assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");

	const targets = await fetch(`${ctx.base}/web/targets.json`);
	assert.equal(targets.status, 200);
	assert.equal(targets.headers.get("content-type"), "application/json; charset=utf-8");
});

test("here counts only the current worktree, across clones and branches", async (t) => {
	const ctx = await withServer(t);
	const origin = path.join(ctx.home, "origin.git");
	git(ctx.home, "init", "--bare", origin);
	git(origin, "symbolic-ref", "HEAD", "refs/heads/main");

	const cloneA = path.join(ctx.home, "clone-a");
	git(ctx.home, "clone", toSlash(origin), "clone-a");
	fs.writeFileSync(path.join(cloneA, "seed.txt"), "seed\n");
	git(cloneA, "add", "-A");
	git(cloneA, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
	git(cloneA, "push", "origin", "main");
	const cloneB = path.join(ctx.home, "clone-b");
	git(ctx.home, "clone", toSlash(origin), "clone-b");

	const dirA = makeBoard(ctx.home, path.join("clone-a", "board"));
	const dirB = makeBoard(ctx.home, path.join("clone-b", "board"));
	const a = await submit(ctx, { srcDir: dirA, session: "sA", title: "A 안" });
	const b = await submit(ctx, { srcDir: dirB, session: "sB", title: "B 안" });
	assert.notEqual(a.body.summary.id, b.body.summary.id);

	const hereA = await (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(dirA)}&session=sA`)).json();
	assert.equal(hereA.mine, 1);
	assert.equal(hereA.theirs, 0);
	assert.deepEqual(hereA.pending, []);
	assert.equal(hereA.notice, null);
	// Both sessions' boards wait on the user (primary mode), so two threads need him; neither board waits on its session.
	assert.equal(hereA.footer, "🙋 2");

	const hereB = await (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(dirB)}&session=sB`)).json();
	assert.equal(hereB.mine, 1);
	assert.equal(hereB.theirs, 0);

	git(cloneA, "checkout", "-b", "b");
	const hereBranch = await (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(dirA)}&session=sA`)).json();
	assert.equal(hereBranch.mine, 1);
	assert.equal(hereBranch.pending.length, 0);
});

test("here notice follows owner liveness, not delivery", async (t) => {
	let clock = Date.parse("2026-01-01T00:00:00Z");
	const now = () => new Date(clock);
	const ctx = await withServer(t, { now });
	const dir = makeBoard(ctx.home, "live");
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-live", title: "라이브" });
	const id = sub.summary.id;
	const fb = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "봐 주세요" }, { "x-forwarded-for": "100.64.0.9" });
	const fbBody = await fb.json();
	assert.equal(fbBody.routed, "owner-live");
	const inbox = path.join(ctx.home, "mailbox", safeSegment("owner-live"), `${id}-${String(fbBody.seq).padStart(6, "0")}.json`);
	fs.rmSync(inbox);

	const detail = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	const event = detail.events.find((item) => item.type === "feedback");
	assert.equal(event.delivery, "delivered");

	const hereUrl = (session, extra = "") => `${ctx.base}/api/here?cwd=${encodeURIComponent(dir)}&session=${session}${extra}`;

	let mine = await (await fetch(hereUrl("owner-live"))).json();
	assert.equal(mine.mine, 0);
	assert.equal(mine.theirs, 1);
	assert.equal(mine.pending.length, 1);
	assert.equal(mine.pending[0].latest.seq, fbBody.seq);
	assert.equal(mine.pending[0].latest.delivery, "delivered");
	assert.equal(mine.notice, null);

	clock += 10_000;
	const recent = await (await fetch(hereUrl("other"))).json();
	assert.equal(recent.notice, null);
	assert.deepEqual(recent.noticeKeys, []);

	clock += 90_000;
	const stale = await (await fetch(hereUrl("other"))).json();
	assert.ok(stale.notice && stale.notice.includes(id));
	assert.deepEqual(stale.noticeKeys, [`${id}:${fbBody.seq}`]);

	const resumed = await (await fetch(hereUrl("owner-live", "&start=1"))).json();
	assert.ok(resumed.notice && resumed.notice.includes(id));

	const bye = await postJson(ctx.base, "/api/bye", { session: "owner-live" });
	assert.deepEqual(await bye.json(), { ok: true });
	const afterBye = await (await fetch(hereUrl("other"))).json();
	assert.ok(afterBye.notice && afterBye.notice.includes(id));
	assert.deepEqual(afterBye.noticeKeys, [`${id}:${fbBody.seq}`]);

	const seen = await (await fetch(hereUrl("fresh"))).json();
	assert.ok(seen.notice && seen.notice.includes(id));
});

test("here lists the session's decision boards waiting on the owner", async (t) => {
	const ctx = await withServer(t);
	const dirA = makeBoard(ctx.home, "waiting-a");
	const dirOther = makeBoard(ctx.home, "waiting-other");
	const a = await submit(ctx, { srcDir: dirA, session: "sA", title: "A" });
	await submit(ctx, { srcDir: reportBoard(ctx.home, "waiting-report"), session: "sA", title: "Report" });
	const other = await submit(ctx, { srcDir: dirOther, session: "sB", title: "Other" });
	const ownerlessDir = makeBoard(ctx.home, "waiting-ownerless");
	const ownerlessIdentity = await identityFor(ownerlessDir, {});
	await postJson(ctx.base, "/api/proposals", {
		cwd: ownerlessDir,
		identity: { ...ownerlessIdentity, session: null },
		title: "Ownerless",
		srcDir: ownerlessDir,
	});
	const closed = await submit(ctx, { srcDir: makeBoard(ctx.home, "waiting-closed"), session: "sA", title: "Closed" });
	await postJson(ctx.base, `/api/p/${closed.body.summary.id}/close`, { summary: "done" });

	const fetchHere = async (cwd, session) => {
		const suffix = session ? `&session=${session}` : "";
		return (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(cwd)}${suffix}`)).json();
	};
	const first = (await fetchHere(dirA, "sA")).waiting;
	const submittedAt = (await (await fetch(`${ctx.base}/api/p/${a.body.summary.id}`)).json()).events[0].at;
	assert.deepEqual(first, [{
		id: a.body.summary.id,
		title: "A",
		status: "mine",
		since: submittedAt,
		seq: null,
		url: `${ctx.base}/p/${a.body.summary.id}`,
	}]);

	await postJson(ctx.base, `/api/p/${a.body.summary.id}/reply`, { text: "ack", session: { id: "sA" } });
	assert.equal((await fetchHere(dirA, "sA")).waiting[0].since, submittedAt);

	const later = await submit(ctx, { srcDir: makeBoard(ctx.home, "waiting-later"), session: "sA", title: "Later" });
	const sorted = (await fetchHere(dirA, "sA")).waiting;
	assert.deepEqual(sorted.map((item) => item.id), [a.body.summary.id, later.body.summary.id]);
	assert.deepEqual((await fetchHere(dirOther, "sB")).waiting.map((item) => item.id), [other.body.summary.id]);
	assert.deepEqual((await fetchHere(dirA, null)).waiting, []);
});

test("a board stays waiting until its feedback is delivered", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home, "waiting-feedback");
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "sA", title: "Feedback" });
	const fb = await (await postJson(ctx.base, `/api/p/${sub.summary.id}/feedback`, { rev: 1, verdict: "change", comment: "revise" })).json();
	const here = async () => (await fetch(`${ctx.base}/api/here?cwd=${encodeURIComponent(dir)}&session=sA`)).json();
	let waiting = (await here()).waiting;
	assert.equal(waiting.length, 1);
	assert.equal(waiting[0].status, "theirs");
	assert.equal(waiting[0].seq, fb.seq);

	const inboxDir = path.join(ctx.home, "mailbox", safeSegment("sA"));
	const inbox = path.join(inboxDir, `${sub.summary.id}-${String(fb.seq).padStart(6, "0")}.json`);
	fs.rmSync(inbox);
	waiting = (await here()).waiting;
	assert.deepEqual(waiting, []);
});

test("open with a missing aside exe is 404 not_installed and the server stays up", async (t) => {
	const missing = path.join(REPO, "test", "no-such-aside.exe");
	assert.ok(!fs.existsSync(missing), "the test needs a path that does not exist");
	const ctx = await withServer(t, { asidePath: missing });
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const res = await postJson(ctx.base, "/api/open", { target: "aside", proposalId: sub.summary.id, dry: false });
	assert.equal(res.status, 404);
	assert.equal((await res.json()).error, "not_installed");
	assert.match(fs.readFileSync(path.join(ctx.home, "logs", "server.log"), "utf8"), /aside not installed/);

	const health = await fetch(`${ctx.base}/api/health`);
	assert.equal(health.status, 200);
	assert.equal((await health.json()).ok, true);
});

test("a spawn error is logged and does not take the server down", async (t) => {
	const ctx = await withServer(t, { asidePath: path.join(REPO, "test") });
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir });
	const logged = waitForText(path.join(ctx.home, "logs", "server.log"), /open failed:/);
	const res = await postJson(ctx.base, "/api/open", { target: "aside", proposalId: sub.summary.id, dry: false });
	assert.equal(res.status, 200);
	await logged;

	const health = await fetch(`${ctx.base}/api/health`);
	assert.equal(health.status, 200);
});

test("a failed inbox write still answers 200 with delivery none", async (t) => {
	const ctx = await withServer(t);
	const dir = makeBoard(ctx.home);
	const { body: sub } = await submit(ctx, { srcDir: dir, session: "owner-inbox" });
	const id = sub.summary.id;
	fs.writeFileSync(path.join(ctx.home, "mailbox"), "not a directory");

	const res = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "인박스 실패" });
	assert.equal(res.status, 200);
	const fb = await res.json();
	assert.equal(fb.ok, true);
	assert.equal(fb.routed, "owner-inbox");
	assert.equal(fb.delivery, "none");

	const detail = await (await fetch(`${ctx.base}/api/p/${id}`)).json();
	const event = detail.events.find((item) => item.type === "feedback");
	assert.ok(event, "the feedback event is stored");
	assert.equal(event.seq, fb.seq);
	assert.match(fs.readFileSync(path.join(ctx.home, "logs", "server.log"), "utf8"), /inbox write failed/);
});

test("server.json is written on listen with the package version", async (t) => {
	const ctx = await withServer(t);
	const parsed = JSON.parse(fs.readFileSync(path.join(ctx.home, "server.json"), "utf8"));
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
	assert.equal(parsed.version, pkg.version);
	assert.equal(parsed.port, ctx.port);
	assert.equal(parsed.pid, process.pid);
	assert.equal(typeof parsed.started, "string");
});

function fakePusher() {
	const waiting = [];
	const welcomeWaiting = [];
	const pusher = {
		publicKey: "fake-public-key",
		calls: [],
		welcomes: [],
		subscribed: [],
		unsubscribed: [],
		subscribe(subscription, meta) {
			pusher.subscribed.push({ subscription, meta });
		},
		unsubscribe(endpoint) {
			pusher.unsubscribed.push(endpoint);
		},
		list: () => [],
		notify(message) {
			pusher.calls.push(message);
			waiting.shift()?.(message);
			return Promise.resolve([]);
		},
		notifyOne(subscription, message) {
			pusher.welcomes.push({ subscription, message });
			welcomeWaiting.shift()?.(message);
			return Promise.resolve({ delivered: true });
		},
		nextNotify: () => new Promise((resolve) => waiting.push(resolve)),
		nextWelcome: () => new Promise((resolve) => welcomeWaiting.push(resolve)),
	};
	return pusher;
}

function validSubscription(endpoint = "https://fcm.example.test/fcm/send/abc") {
	const ua = crypto.createECDH("prime256v1");
	ua.generateKeys();
	return {
		endpoint,
		keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
	};
}

const TAILNET = { "x-forwarded-for": "100.64.0.20", "tailscale-user-login": "me@x" };

test("/sw.js is served as javascript with scope and no-cache headers", async (t) => {
	const ctx = await withServer(t);
	const res = await fetch(`${ctx.base}/sw.js`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
	assert.equal(res.headers.get("service-worker-allowed"), "/");
	assert.equal(res.headers.get("cache-control"), "no-cache");
	assert.match(await res.text(), /notificationclick/);
	const funnel = await fetch(`${ctx.base}/sw.js`, { headers: { "tailscale-funnel-request": "1" } });
	assert.equal(funnel.status, 403);
});

test("/api/push/key returns the pusher's public key", async (t) => {
	const ctx = await withServer(t, { pusher: fakePusher() });
	const res = await fetch(`${ctx.base}/api/push/key`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.deepEqual(await res.json(), { publicKey: "fake-public-key" });
});

test("the default pusher creates vapid.json under the home and serves its key", async (t) => {
	const ctx = await withServer(t);
	const { publicKey } = await (await fetch(`${ctx.base}/api/push/key`)).json();
	assert.equal(Buffer.from(publicKey, "base64url").length, 65);
	assert.ok(fs.existsSync(path.join(ctx.home, "push", "vapid.json")));
});

test("subscribe rejects a bad endpoint or bad keys with bad_input", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const good = validSubscription();
	const cases = [
		{ ...good, endpoint: "http://fcm.example.test/x" },
		{ ...good, endpoint: "not a url" },
		{ ...good, endpoint: `https://fcm.example.test/${"a".repeat(2048)}` },
		{ endpoint: good.endpoint },
		{ ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65, 1).toString("base64url") } },
		{ ...good, keys: { ...good.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(32)]).toString("base64url") } },
		{ ...good, keys: { ...good.keys, auth: crypto.randomBytes(15).toString("base64url") } },
		{ ...good, keys: { ...good.keys, auth: 42 } },
	];
	for (const subscription of cases) {
		const res = await postJson(ctx.base, "/api/push/subscribe", { subscription });
		assert.equal(res.status, 400, JSON.stringify(subscription).slice(0, 80));
		assert.deepEqual(await res.json(), { error: "bad_input" });
	}
	const missing = await postJson(ctx.base, "/api/push/subscribe", {});
	assert.equal(missing.status, 400);
	assert.equal(pusher.subscribed.length, 0);
});

test("subscribe stores the subscription and sends the welcome push to it only", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const subscription = validSubscription();
	const welcome = pusher.nextWelcome();
	const res = await postJson(ctx.base, "/api/push/subscribe", { subscription }, { "user-agent": "Samsung/1".padEnd(300, "x") });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true });
	assert.deepEqual(await welcome, {
		title: "알림이 켜졌습니다",
		body: "새 Review와 답이 오면 알려 드립니다",
		url: "/",
		tag: "inbox-welcome",
	});
	assert.equal(pusher.subscribed.length, 1);
	assert.deepEqual(pusher.subscribed[0].subscription, subscription);
	assert.equal(pusher.subscribed[0].meta.via, "local");
	assert.equal(pusher.subscribed[0].meta.ua.length, 200);
	assert.equal(pusher.calls.length, 0);
});

test("subscribe is refused for the funnel header and allowed over the tailnet", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const subscription = validSubscription();
	const funnel = await postJson(ctx.base, "/api/push/subscribe", { subscription }, { "tailscale-funnel-request": "1" });
	assert.equal(funnel.status, 403);
	assert.equal(pusher.subscribed.length, 0);

	const welcome = pusher.nextWelcome();
	const tailnet = await postJson(ctx.base, "/api/push/subscribe", { subscription }, TAILNET);
	assert.equal(tailnet.status, 200);
	await welcome;
	assert.equal(pusher.subscribed[0].meta.via, "tailnet");

	const stranger = await postJson(ctx.base, "/api/push/subscribe", { subscription }, { "x-forwarded-for": "100.64.0.21" });
	assert.equal(stranger.status, 403);
});

test("unsubscribe removes the endpoint and needs the same guard", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const endpoint = "https://fcm.example.test/fcm/send/abc";
	const res = await postJson(ctx.base, "/api/push/unsubscribe", { endpoint }, TAILNET);
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { ok: true });
	assert.deepEqual(pusher.unsubscribed, [endpoint]);
	const funnel = await postJson(ctx.base, "/api/push/unsubscribe", { endpoint }, { "tailscale-funnel-request": "1" });
	assert.equal(funnel.status, 403);
	const bare = await fetch(`${ctx.base}/api/push/unsubscribe`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ endpoint }),
	});
	assert.equal(bare.status, 403);
	assert.deepEqual(pusher.unsubscribed, [endpoint]);
});

test("a new proposal notifies once; an identical resubmit does not", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const dir = makeBoard(ctx.home);
	const next = pusher.nextNotify();
	const { body: sub } = await submit(ctx, { srcDir: dir, title: "로그인 개편" });
	const message = await next;
	const id = sub.summary.id;
	assert.equal(message.title, "새 Review · 로그인 개편");
	assert.equal(message.body, `${sub.summary.product.name || sub.summary.product.key} · ${sub.summary.feature.branch}`);
	assert.equal(message.url, `/p/${id}`);
	assert.equal(message.tag, `inbox-${id}`);
	assert.equal(pusher.calls.length, 1);

	const again = await submit(ctx, { srcDir: dir, title: "로그인 개편" });
	assert.equal(again.body.existing, true);
	// the next real event comes after the resubmit, so a stray notify from it would show up first
	const reply = pusher.nextNotify();
	await postJson(ctx.base, `/api/p/${id}/reply`, { text: "확인", session: { id: "s1" } });
	assert.match((await reply).title, /^답이 왔습니다/);
	assert.equal(pusher.calls.length, 2);
});

test("revise notifies with the note, or product and branch without one", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const { body: sub } = await submit(ctx, { srcDir: makeBoard(ctx.home), title: "개편" });
	const id = sub.summary.id;
	const where = `${sub.summary.product.name || sub.summary.product.key} · ${sub.summary.feature.branch}`;

	const withNote = pusher.nextNotify();
	const first = await postJson(ctx.base, `/api/p/${id}/revise`, { srcDir: makeBoard(ctx.home, "proto-r2"), note: "색을 바꿨습니다", session: { id: "s1" } });
	assert.equal(first.status, 200);
	const noteMessage = await withNote;
	assert.equal(noteMessage.title, "수정본 2 · 개편");
	assert.equal(noteMessage.body, "색을 바꿨습니다");
	assert.equal(noteMessage.url, `/p/${id}`);
	assert.equal(noteMessage.tag, `inbox-${id}`);

	const plain = pusher.nextNotify();
	const parsed = board();
	parsed.lead = "세 번째";
	const third = makeBoard(ctx.home, "proto-r3");
	fs.writeFileSync(path.join(third, "board.json"), JSON.stringify(parsed));
	await postJson(ctx.base, `/api/p/${id}/revise`, { srcDir: third, session: { id: "s1" } });
	const plainMessage = await plain;
	assert.equal(plainMessage.title, "수정본 3 · 개편");
	assert.equal(plainMessage.body, where);
});

test("a session reply notifies with the text cut to 120 chars", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const { body: sub } = await submit(ctx, { srcDir: makeBoard(ctx.home), title: "답장" });
	const id = sub.summary.id;
	const next = pusher.nextNotify();
	const res = await postJson(ctx.base, `/api/p/${id}/reply`, { text: "가".repeat(200), session: { id: "s1" } });
	assert.equal(res.status, 200);
	const message = await next;
	assert.equal(message.title, "답이 왔습니다 · 답장");
	assert.equal(message.body, "가".repeat(120));
	assert.equal(message.url, `/p/${id}`);
	assert.equal(message.tag, `inbox-${id}`);
});

test("owner feedback and closes do not notify", async (t) => {
	const pusher = fakePusher();
	const ctx = await withServer(t, { pusher });
	const first = pusher.nextNotify();
	const { body: sub } = await submit(ctx, { srcDir: makeBoard(ctx.home), session: "owner-9", title: "조용히" });
	await first;
	const id = sub.summary.id;
	assert.equal(pusher.calls.length, 1);

	const feedback = await postJson(ctx.base, `/api/p/${id}/feedback`, { rev: 1, verdict: "change", comment: "수정" }, TAILNET);
	assert.equal(feedback.status, 200);
	const closed = await postJson(ctx.base, `/api/p/${id}/close`, { summary: "받은함에서 닫음", session: { id: "owner-9" } });
	assert.equal(closed.status, 200);
	const second = await submit(ctx, { srcDir: makeBoard(ctx.home, "other"), session: "owner-9", title: "닫기" });
	const closing = await postJson(ctx.base, `/api/p/${second.body.summary.id}/close`, { summary: "끝", session: { id: "owner-9" } });
	assert.equal(closing.status, 200);
	// two proposals were created, so exactly the two "new proposal" pushes exist and nothing else
	assert.deepEqual(pusher.calls.map((message) => message.title), ["새 Review · 조용히", "새 Review · 닫기"]);
});

test("a failing pusher is logged and never changes the HTTP response", async (t) => {
	const pusher = fakePusher();
	const failed = new Promise((resolve) => {
		pusher.notify = () => {
			resolve();
			return Promise.reject(new Error("push exploded"));
		};
	});
	const ctx = await withServer(t, { pusher });
	const { res } = await submit(ctx, { srcDir: makeBoard(ctx.home), title: "실패" });
	assert.equal(res.status, 200);
	await failed;
	const text = await waitForText(path.join(ctx.home, "logs", "server.log"), /push notify failed: Error: push exploded/);
	assert.match(text, /push exploded/);
});
