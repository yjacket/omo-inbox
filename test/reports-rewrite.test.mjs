// Public-repo reports: leak check, rewrite parse and request, the public issue body, the publisher's
// public path and the extension-facing HTTP routes. Fake GitHub API, injected clock, no wall time.
// Run: node --test test/reports-rewrite.test.mjs
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { ALLOW } from "../src/access.mjs";
import * as realBody from "../src/reports-body.mjs";
import { createReportsHttp } from "../src/reports-http.mjs";
import { createPublisher } from "../src/reports-publisher.mjs";
import { buildRewriteRequest, findLeaks, leakSources, parseRewrite } from "../src/reports-rewrite.mjs";
import { createReportsStore } from "../src/reports-store.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

const SID = "01a21547-1ac3-7e05-8727-bd0a2ade8f26";
const ITEM = "i-261124-ab12cd";
const MESSAGE = "결제 모듈 커밋을 두 개로 나눌지 정해 주세요";
const TITLE = "vlay 결제 화면 정리";
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CLEAN = "말풍선의 선택지 버튼이 잘립니다\n\n### 문제\n선택지 버튼 글자가 말풍선 밖으로 넘칩니다.\n\n### 위치\n대화 화면의 질문 말풍선\n\n### 재현 순서\n1. 질문이 온 대화를 엽니다.\n2. 폰 너비로 봅니다.";

function png(width, height, fill = 0) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(13, 0);
	head.write("IHDR", 4, "ascii");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([SIGNATURE, head, ihdr, Buffer.alloc(4), Buffer.from([fill, 2, 3, 4])]);
}

const ORIGINAL = png(2, 2, 1);
const MASKED = png(2, 2, 9);

function report(id, overrides = {}) {
	return {
		v: 2,
		reportId: id,
		description: `세션 "${TITLE}"에서 "${MESSAGE}" 줄의 버튼이 잘려요`,
		page: { kind: "thread", route: "/s/:sid", url: `/s/${SID}`, title: `${TITLE} · Inbox`, frames: [] },
		element: {
			selector: `[data-msg="${ITEM}"] .opts`,
			selectorStability: "data",
			domPath: "article.msg > div.bubble > div.opts",
			domPathTruncated: false,
			tag: "div",
			role: null,
			label: MESSAGE,
			textExcerpt: MESSAGE,
			excerptTruncated: false,
			rect: { x: 10, y: 20, w: 300, h: 80 },
		},
		view: {
			layout: { w: 390, h: 844 },
			visual: { x: 0, y: 0, w: 390, h: 844, scale: 1 },
			scroll: { x: 0, y: 0 },
			dpr: 2,
			colorScheme: "light",
			pointer: "coarse",
		},
		source: { kind: "thread", threadId: SID, itemId: ITEM, product: "github.com/yjacket/vlay" },
		image: { provenance: "snapshot", width: 2, height: 2 },
		mask: { width: 2, height: 2, texts: [TITLE, MESSAGE] },
		...overrides,
	};
}

// ---------- pure: leak check, parse, request, public body ----------

test("findLeaks: a whole short user text, a 12-character run of a long one, page ids and private shapes", () => {
	const sources = leakSources(report("r"));
	assert.deepEqual(sources.texts, [TITLE, MESSAGE]);
	assert.ok(sources.ids.includes(SID) && sources.ids.includes(ITEM));
	assert.deepEqual(findLeaks(`제목이 ${TITLE}인 세션`, sources), ["text"]);
	assert.deepEqual(findLeaks("커밋을 두 개로 나눌지 묻는 말풍선", sources), ["text"], "a 12-character run of the message");
	assert.deepEqual(findLeaks("두 개로 나눌지 묻는 말풍선", sources), [], "an 11-character run is not a copy");
	assert.deepEqual(findLeaks(`항목 ${ITEM}`, sources), ["id"]);
	assert.deepEqual(findLeaks("C:\\Users\\someone\\proj 에서", sources), ["path"]);
	assert.deepEqual(findLeaks("owner@example.com 에게", sources), ["email"]);
	assert.deepEqual(findLeaks("machine.tailnet.ts.net:4388", sources), ["host"]);
	assert.deepEqual(findLeaks(CLEAN, sources), []);
	assert.deepEqual(findLeaks("QA", { texts: ["QA"] }), [], "texts under 5 characters never count");
	assert.deepEqual(findLeaks("○○○ ○○○", { texts: ["○○○ ○○○ ○○○"] }), [], "a run without letters or digits never counts");
});

test("findLeaks normalizes width, case and whitespace before comparing", () => {
	assert.deepEqual(findLeaks("VLAY   결제\n화면 정리", { texts: [TITLE] }), ["text"]);
});

test("parseRewrite: first line is the title, the rest the body; a bare line or empty answer is refused", () => {
	assert.deepEqual(parseRewrite(`# 제목: 버튼이 잘립니다\n\n본문`), { title: "버튼이 잘립니다", body: "본문" });
	assert.deepEqual(parseRewrite("```markdown\n제목\n\n본문\n```"), { title: "제목", body: "본문" });
	assert.equal(parseRewrite("제목만"), null);
	assert.equal(parseRewrite("  \n "), null);
});

test("buildRewriteRequest sends the original picture, the description and the element, never the visible text", () => {
	const request = buildRewriteRequest({ report: report("r") }, ORIGINAL.toString("base64"));
	assert.deepEqual(request.image, { data: ORIGINAL.toString("base64"), mimeType: "image/png" });
	assert.ok(request.user.includes(report("r").description));
	assert.ok(request.user.includes("/s/:sid"));
	assert.ok(!request.user.includes(SID), "the page url is not sent");
	assert.equal(buildRewriteRequest({ report: report("r", { element: null }) }, null).image, null);
});

test("buildPublicIssue holds the rewrite and no description, url, id, label, visible text or other product", () => {
	const record = {
		id: "r", createdAt: "2026-11-26T00:00:00.000Z", report: report("r"),
		asset: { path: "reports/2026/11/r.png", blobSha: "b" },
		rewrite: parseRewrite(CLEAN),
	};
	const issue = realBody.buildPublicIssue({ record, repo: "yjacket/omo-inbox", assetsBranch: "assets", label: "inbox-report", serverBuild: "b1", version: "0.1.0" });
	assert.equal(issue.title, "말풍선의 선택지 버튼이 잘립니다");
	assert.deepEqual(issue.labels, ["inbox-report"]);
	for (const secret of [MESSAGE, TITLE, SID, ITEM, "vlay"]) assert.ok(!issue.title.includes(secret) && !issue.body.includes(secret), secret);
	assert.ok(issue.body.includes("- 고른 곳: `div`"), "a selector with an item id falls back to the tag");
	assert.ok(issue.body.includes("- 출처: 대화\n"));
	assert.ok(issue.body.includes("- 제품: 다른 프로젝트"));
	assert.ok(issue.body.includes("![가린 그림](../blob/assets/reports/2026/11/r.png?raw=true)"));
	assert.ok(issue.body.includes("원본 그림과 설명은 제보한 PC에만 보관합니다"));
	assert.ok(issue.body.endsWith("<!-- inbox-report:r -->"));
	const own = realBody.buildPublicIssue({
		record: { ...record, report: report("r", { source: { kind: "proposal", proposalId: "261124-abcd", revision: 1, frame: null, product: "github.com/yjacket/omo-inbox" }, element: { ...report("r").element, selector: "#reportLink" } }) },
		repo: "yjacket/omo-inbox", assetsBranch: "assets", label: "inbox-report", serverBuild: "b1", version: "0.1.0",
	});
	assert.ok(own.body.includes("- 제품: yjacket/omo-inbox") && own.body.includes("- 고른 곳: `#reportLink`") && own.body.includes("- 출처: Review\n"));
	assert.ok(!own.body.includes("261124-abcd"));
});

// ---------- publisher: the public path ----------

function harness(t, { privateRepo = false } = {}) {
	const tmp = makeTmpHome("inbox-rewrite-");
	t.after(tmp.cleanup);
	const time = Date.parse("2026-11-26T00:00:00Z");
	const calls = [];
	const notifications = [];
	const store = createReportsStore({ dataDir: path.join(tmp.home, "data"), now: () => new Date(time) });
	const created = [];
	const uploaded = [];
	const api = {
		async repoInfo() { calls.push("repo"); return { private: privateRepo, hasIssues: true }; },
		async login() { return "owner"; },
	};
	const assets = {
		assetPath(record) { return `reports/2026/11/${record.id}.png`; },
		async ensureAssetsBranch() { calls.push("branch"); },
		async putAsset(_api, args) { calls.push("asset"); uploaded.push(args.bytes); return { path: args.path, blobSha: "blob" }; },
	};
	const issues = {
		async ensureLabel() { calls.push("label"); },
		async createIssue(_api, request) { calls.push("create"); created.push(request); return { number: 7, url: "https://example.invalid/7", nodeId: "n", createdAt: new Date(time).toISOString() }; },
		async findIssueByMarker() { return { matches: [], complete: true }; },
	};
	const publisher = createPublisher({
		store, api, assets, issues, body: realBody,
		config: { repo: "yjacket/omo-inbox", label: "inbox-report", assetsBranch: "assets" },
		serverBuild: "b1", version: "0.1.0", notify: (value) => notifications.push(value), now: () => new Date(time),
		setTimer: () => 0, clearTimer() {}, random: () => 1,
	});
	t.after(() => publisher.stop());
	function add(id = "one", overrides = {}) {
		const value = report(id, overrides);
		return store.create({ id, fingerprint: id, report: value, png: ORIGINAL, maskPng: value.mask?.width ? MASKED : null, imageMeta: { width: 2, height: 2, provenance: "snapshot" } }).record;
	}
	return { store, publisher, calls, created, uploaded, notifications, add, record: (id = "one") => store.get(id) };
}

test("public: a rewrite that copies a captured user text is held and nothing reaches GitHub", async (t) => {
	const h = harness(t);
	h.add();
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "rewriting");
	assert.deepEqual(h.publisher.rewriteRequest("one").image.data, ORIGINAL.toString("base64"), "the model sees the original");
	const result = await h.publisher.rewritten("one", { text: `버튼이 잘립니다\n\n"${MESSAGE}" 말풍선의 버튼`, model: "fake/vision" });
	assert.deepEqual(result, { ok: true, state: "held" });
	assert.equal(h.record().delivery.state, "held");
	assert.deepEqual(h.record().delivery.lastError, { kind: "leak", detail: "공개 글에 화면 속 글자가 그대로 있어 올리지 않았습니다" });
	assert.equal(h.record().rewrite, null, "a refused answer is not kept");
	await h.publisher.kick("one");
	assert.deepEqual(h.calls, ["repo"], "no label, asset or issue call");
	assert.equal(h.notifications.length, 1);
	assert.deepEqual(h.publisher.rewriteWanted(), []);
});

test("public: a clean rewrite posts the masked picture and the rewritten text", async (t) => {
	const h = harness(t);
	h.add();
	await h.publisher.kick("one");
	assert.deepEqual(await h.publisher.rewritten("one", { text: CLEAN, model: "fake/vision" }), { ok: true, state: "pending" });
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "sent");
	assert.deepEqual(h.calls, ["repo", "label", "branch", "asset", "create"]);
	assert.deepEqual(h.uploaded, [MASKED], "the masked picture, never the original");
	assert.equal(h.created[0].title, "말풍선의 선택지 버튼이 잘립니다");
	assert.ok(!h.created[0].body.includes(MESSAGE) && !h.created[0].body.includes(SID));
	assert.equal(h.record().rewrite.model, "fake/vision");
});

test("public: without a masked picture the issue has no picture", async (t) => {
	const h = harness(t);
	h.add("one", { mask: { width: 0, height: 0, texts: [MESSAGE] } });
	await h.publisher.kick("one");
	await h.publisher.rewritten("one", { text: CLEAN });
	await h.publisher.kick("one");
	assert.deepEqual(h.calls, ["repo", "label", "create"]);
	assert.ok(!h.created[0].body.includes("![가린 그림]"));
});

test("public: no image-capable model holds the report with its reason, and a retry asks the model again", async (t) => {
	const h = harness(t);
	h.add();
	await h.publisher.kick("one");
	assert.deepEqual(await h.publisher.rewriteUnavailable("one", "no_model"), { ok: true, state: "held" });
	assert.deepEqual(h.record().delivery.lastError, { kind: "no_model", detail: "그림을 읽을 수 있는 모델이 없습니다" });
	assert.deepEqual(await h.publisher.rewriteUnavailable("one", "failed"), { ok: false, error: "not_waiting" });
	assert.equal(h.publisher.retry("one"), true);
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "rewriting");
	assert.deepEqual(h.publisher.rewriteWanted(), ["one"]);
	assert.deepEqual(await h.publisher.rewriteUnavailable("one", "failed"), { ok: true, state: "held" });
	assert.equal(h.record().delivery.lastError.kind, "rewrite_failed");
	assert.deepEqual(await h.publisher.rewritten("one", { text: CLEAN }), { ok: false, error: "not_waiting" });
});

test("private: the mask is ignored, the original picture and the full body go out as before", async (t) => {
	const h = harness(t, { privateRepo: true });
	h.add();
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "sent");
	assert.deepEqual(h.uploaded, [ORIGINAL]);
	assert.equal(h.record().rewrite, null);
	assert.ok(h.created[0].body.includes(MESSAGE), "the private body keeps the description");
	assert.deepEqual(h.publisher.rewriteWanted(), []);
});

// ---------- HTTP: create with a mask, rewrite job, rewrite routes ----------

async function server(t) {
	const h = harness(t);
	let clock = Date.parse("2026-11-26T00:00:00Z");
	const reportsHttp = createReportsHttp({
		store: h.store,
		publisher: h.publisher,
		stateCache: { get: () => null, at: () => null },
		sendJson(res, status, body) {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		},
		async readJsonBody(req) {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
		},
		bodyLimit: 12 * 1024 * 1024,
		allowAccess: (access, _headers, level) => ALLOW[level].includes(access),
		allowOrigin: () => true,
		handoff: async () => ({ ok: false }),
		productOf: () => "github.com/yjacket/vlay",
		now: () => new Date(clock),
	});
	const srv = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const parts = url.pathname.split("/");
		const access = req.headers["x-test-access"] ?? "local";
		const handled = req.method === "GET"
			? await reportsHttp.handleGet(res, parts, url.searchParams, access)
			: await reportsHttp.handlePost(res, req, parts, access);
		if (!handled) {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => srv.close(resolve)));
	const base = `http://127.0.0.1:${srv.address().port}`;
	const call = async (method, route, body, access = "local") => {
		const response = await fetch(base + route, {
			method,
			headers: { "content-type": "application/json", "x-inbox": "1", "x-test-access": access },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, json: await response.json().catch(() => null) };
	};
	return { ...h, reportsHttp, call, advance: (ms) => { clock += ms; } };
}

function createBody(id) {
	const value = report(id);
	return {
		...value,
		source: { kind: "thread", threadId: SID, itemId: ITEM },
		image: { provenance: "snapshot", png: ORIGINAL.toString("base64"), width: 2, height: 2 },
		mask: { png: MASKED.toString("base64"), width: 2, height: 2, texts: [TITLE, MESSAGE] },
	};
}

const ID = "123e4567-e89b-42d3-a456-426614174000";

test("http: a create stores the masked picture beside the original and the texts on the record", async (t) => {
	const s = await server(t);
	const created = await s.call("POST", "/api/reports", createBody(ID));
	assert.equal(created.status, 201);
	assert.deepEqual(s.store.maskedImage(ID), MASKED);
	assert.deepEqual(s.store.image(ID), ORIGINAL);
	assert.deepEqual(s.store.get(ID).report.mask, { width: 2, height: 2, texts: [TITLE, MESSAGE] });
	assert.equal((await s.call("POST", "/api/reports", { ...createBody(ID), mask: { ...createBody(ID).mask, width: 3 } })).status, 400, "a masked picture of another size");
	const upload = { ...createBody(ID), image: { ...createBody(ID).image, provenance: "upload" } };
	assert.deepEqual((await s.call("POST", "/api/reports", upload)).json.fields, ["mask.png"], "only a snapshot has a masked twin");
});

test("http: the rewrite job is leased to one extension, its request is local-only, and the answer is checked", async (t) => {
	const s = await server(t);
	await s.call("POST", "/api/reports", createBody(ID));
	await s.publisher.kick(ID);
	assert.equal(s.reportsHttp.rewriteJob(), ID);
	assert.equal(s.reportsHttp.rewriteJob(), null, "leased");
	s.advance(120001);
	assert.equal(s.reportsHttp.rewriteJob(), ID, "offered again after the lease");
	assert.equal((await s.call("GET", `/api/reports/${ID}/rewrite`, undefined, "tailnet")).status, 403);
	const request = await s.call("GET", `/api/reports/${ID}/rewrite`);
	assert.equal(request.status, 200);
	assert.equal(request.json.image.data, ORIGINAL.toString("base64"));
	assert.equal((await s.call("POST", `/api/reports/${ID}/rewrite`, { text: CLEAN }, "tailnet")).status, 403);
	assert.equal((await s.call("POST", `/api/reports/${ID}/rewrite`, { unavailable: "maybe" })).status, 400);
	const leaked = await s.call("POST", `/api/reports/${ID}/rewrite`, { text: `제목\n\n${TITLE} 세션`, model: "fake/vision" });
	assert.deepEqual(leaked.json, { ok: true, state: "held" });
	const row = await s.call("GET", `/api/reports/${ID}`);
	assert.equal(row.json.state, "held");
	assert.equal(row.json.detail, "공개 글에 화면 속 글자가 그대로 있어 올리지 않았습니다");
	assert.equal((await s.call("POST", `/api/reports/${ID}/retry`, {})).status, 200);
	await s.publisher.kick(ID);
	assert.equal(s.reportsHttp.rewriteJob(), ID, "a retry clears the lease and asks again");
	assert.deepEqual((await s.call("POST", `/api/reports/${ID}/rewrite`, { text: CLEAN, model: "fake/vision" })).json, { ok: true, state: "pending" });
	await s.publisher.kick(ID);
	assert.equal((await s.call("GET", `/api/reports/${ID}`)).json.state, "sent");
	assert.equal((await s.call("GET", `/api/reports/${ID}/rewrite`)).status, 409);
});
