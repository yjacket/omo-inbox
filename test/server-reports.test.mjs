import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { classify, ALLOW } from "../src/access.mjs";
import { createReportsStore } from "../src/reports-store.mjs";
import { createReportsHttp, REPORT_PAGE } from "../src/reports-http.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const OWNER = "owner@example.com";
const PUBLIC_BASE = "https://machine.tailnet.ts.net:4388";
const REPO = "yjacket/omo-inbox";
const NOW = new Date("2026-10-28T12:00:00.000Z");
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function uuidFor(n) {
	return `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
}

function pngBuffer(width, height) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(13, 0);
	head.write("IHDR", 4, "ascii");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([SIGNATURE, head, ihdr, Buffer.alloc(4), Buffer.from([1, 2, 3, 4])]);
}

const PNG = pngBuffer(2, 2);

function baseBody(overrides = {}) {
	return {
		v: 2,
		reportId: UUID,
		description: "버튼이 눌리지 않습니다",
		page: {
			kind: "thread",
			route: "/s/:sid",
			url: "/s/demo-sid",
			title: "대화",
			frames: [],
		},
		element: null,
		view: {
			layout: { w: 1280, h: 720 },
			visual: { x: 0, y: 0, w: 1280, h: 720, scale: 1 },
			scroll: { x: 0, y: 0 },
			dpr: 1,
			colorScheme: "light",
			pointer: "fine",
		},
		source: null,
		image: null,
		...overrides,
	};
}

function reportStub(id, description = `${id} 설명`) {
	return { ...baseBody({ reportId: id, description }) };
}

function delivery(state, extra = {}) {
	return {
		state,
		attempts: 0,
		creates: 0,
		nextAttemptAt: null,
		uncertainSince: null,
		lastError: null,
		...extra,
	};
}

function fail(code, message = code) {
	const error = new Error(message);
	error.code = code;
	return error;
}

async function setup(t, options = {}) {
	const { home, cleanup } = makeTmpHome("reports-http-");
	const dataDir = path.join(home, "data");
	const reportsDir = path.join(dataDir, "reports");
	const clock = options.now ?? NOW;
	const store = createReportsStore({ dataDir, now: () => clock });
	const state = { map: null, at: null };
	const stateCache = { get: () => state.map, at: () => state.at };
	const kicked = [];
	const retried = [];
	const logs = [];
	let handoffResult = { ok: true, via: "orca", session: "sess-1" };
	let handoffCalls = 0;
	let owner = Object.hasOwn(options, "owner") ? options.owner : OWNER;
	let actualPort = 0;

	const publisher = {
		kick(id) {
			kicked.push(id);
		},
		retry(id) {
			const record = store.get(id);
			if (record == null || record.delivery.state !== "failed") return false;
			retried.push(id);
			store.update(id, { delivery: { ...record.delivery, state: "queued", nextAttemptAt: null } });
			return true;
		},
	};

	const handoff = async () => {
		handoffCalls += 1;
		return handoffResult;
	};

	const productOf = options.productOf ?? ((source) => {
		if (source.kind === "thread") return "thread-product";
		if (source.kind === "proposal") return "proposal-product";
		return null;
	});

	function sendJson(res, status, body) {
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(JSON.stringify(body));
	}

	function readBody(req, limit) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			let tooLong = false;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > limit) tooLong = true;
				else chunks.push(chunk);
			});
			req.on("end", () => {
				if (tooLong) reject(fail("too_long", "body too large"));
				else resolve(Buffer.concat(chunks));
			});
			req.on("error", reject);
		});
	}

	async function readJsonBody(req, limit) {
		const raw = await readBody(req, limit);
		try {
			const parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch {
			throw fail("bad_input", "body must be json");
		}
	}

	// Copied from src/server.mjs:514-532, with the owner/publicBase injectable.
	function reportAllowed(access, _headers, level = "read") {
		if (!ALLOW[level].includes(access)) return false;
		return !(access === "tailnet" && owner == null);
	}

	function reportOriginAllowed(headers, access) {
		const origin = headers ? headers.origin : undefined;
		if (origin === undefined) return access === "local";
		if (typeof origin !== "string" || origin === "null") return false;
		const allowed = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
		if (options.publicBase) {
			try {
				allowed.add(new URL(options.publicBase).origin);
			} catch {
				// an invalid public base contributes no allowed origin
			}
		}
		return allowed.has(origin);
	}

	const reportsHttp = createReportsHttp({
		store,
		publisher,
		stateCache,
		sendJson,
		readJsonBody,
		bodyLimit: options.bodyLimit ?? 12 * 1024 * 1024,
		allowAccess: reportAllowed,
		allowOrigin: reportOriginAllowed,
		handoff,
		productOf,
		repo: REPO,
		log: (line) => logs.push(line),
		now: () => clock,
	});

	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, `http://127.0.0.1:${actualPort}`);
			const parts = url.pathname.split("/");
			const access = classify({
				remoteAddress: req.socket.remoteAddress,
				headers: req.headers,
				pcIps: [],
				owner,
			});
			if (parts[1] === "api" && parts[2] === "reports") {
				if (req.method === "GET") {
					const handled = await reportsHttp.handleGet(res, parts, url.searchParams, access);
					if (!handled) sendJson(res, 404, { error: "not_found" });
					return;
				}
				if (req.method === "POST") {
					const handled = await reportsHttp.handlePost(res, req, parts, access);
					if (!handled) sendJson(res, 404, { error: "not_found" });
					return;
				}
			}
			sendJson(res, 404, { error: "not_found" });
		} catch (error) {
			if (!res.headersSent) sendJson(res, 500, { error: "internal" });
			else res.destroy();
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	actualPort = server.address().port;
	const base = `http://127.0.0.1:${actualPort}`;

	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		cleanup();
	});

	function phoneHeaders(extra = {}) {
		return {
			"x-forwarded-for": "100.64.0.9",
			"tailscale-user-login": OWNER,
			origin: options.publicBase,
			...extra,
		};
	}

	async function request(method, route, { body, headers = {}, raw } = {}) {
		const requestHeaders = { ...headers };
		if (body !== undefined || raw !== undefined) {
			requestHeaders["content-type"] = "application/json";
			requestHeaders["x-inbox"] = "1";
		}
		const response = await fetch(base + route, {
			method,
			headers: requestHeaders,
			body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers),
			json,
			text,
		};
	}

	async function requestBytes(route, headers = {}) {
		const response = await fetch(base + route, { headers });
		return {
			status: response.status,
			headers: Object.fromEntries(response.headers),
			bytes: Buffer.from(await response.arrayBuffer()),
		};
	}

	function seed(id, { createdAt, state = "queued", extraDelivery = {}, github = null, handoff = null, image = null, description } = {}) {
		store.create({
			id,
			createdAt,
			fingerprint: crypto.createHash("sha256").update(id).digest("hex"),
			report: reportStub(id, description),
			png: image,
			imageMeta: image == null ? null : { width: 2, height: 2, provenance: "snapshot" },
		});
		store.update(id, { delivery: delivery(state, extraDelivery), github, handoff });
	}

	return {
		home,
		dataDir,
		reportsDir,
		store,
		stateCache,
		state,
		kicked,
		retried,
		logs,
		base,
		port: actualPort,
		request,
		requestBytes,
		phoneHeaders,
		seed,
		setOwner(value) {
			owner = value;
		},
		setHandoffResult(value) {
			handoffResult = value;
		},
		get handoffCalls() {
			return handoffCalls;
		},
	};
}

function reportDirs(reportsDir) {
	try {
		return fs.readdirSync(reportsDir);
	} catch {
		return [];
	}
}

test("REPORT_PAGE is the absolute web/reports.html path", () => {
	assert.equal(path.isAbsolute(REPORT_PAGE), true);
	assert.equal(path.basename(REPORT_PAGE), "reports.html");
	assert.equal(path.basename(path.dirname(REPORT_PAGE)), "web");
});

test("create returns 201 and the list shows the row pending", async (t) => {
	const f = await setup(t);
	const created = await f.request("POST", "/api/reports", { body: baseBody() });
	assert.equal(created.status, 201);
	assert.deepEqual(created.json, { ok: true, id: UUID, state: "pending", github: null });
	assert.deepEqual(f.kicked, [UUID]);
	assert.equal(f.store.get(UUID).delivery.state, "queued");

	const list = await f.request("GET", "/api/reports");
	assert.equal(list.status, 200);
	assert.equal(list.json.items.length, 1);
	assert.deepEqual(list.json.items[0], {
		id: UUID,
		title: "버튼이 눌리지 않습니다",
		createdAt: NOW.toISOString(),
		state: "pending",
		detail: null,
		github: null,
		image: false,
		handoff: null,
	});
	assert.deepEqual(list.json.counts, { pending: 1, failed: 0, sent: 0 });
	assert.equal(list.json.nextCursor, null);
	assert.equal(list.json.repo, REPO);
	assert.equal(list.json.statesAt, null);
});

test("an exact create replay returns 200 with replay true and does not kick again", async (t) => {
	const f = await setup(t);
	const first = await f.request("POST", "/api/reports", { body: baseBody() });
	assert.equal(first.status, 201);
	const again = await f.request("POST", "/api/reports", { body: baseBody() });
	assert.equal(again.status, 200);
	assert.deepEqual(again.json, { ok: true, id: UUID, state: "pending", github: null, replay: true });
	assert.deepEqual(f.kicked, [UUID]);
	assert.equal(reportDirs(f.reportsDir).length, 1);
});

test("a reused id with a different fingerprint is 409 key_reused", async (t) => {
	const f = await setup(t);
	assert.equal((await f.request("POST", "/api/reports", { body: baseBody() })).status, 201);
	const changed = baseBody({ description: "다른 내용입니다" });
	const reused = await f.request("POST", "/api/reports", { body: changed });
	assert.equal(reused.status, 409);
	assert.deepEqual(reused.json, { error: "key_reused" });
});

test("bad input returns 400 with the offending fields", async (t) => {
	const f = await setup(t);
	const body = baseBody();
	delete body.description;
	const response = await f.request("POST", "/api/reports", { body });
	assert.equal(response.status, 400);
	assert.equal(response.json.error, "bad_input");
	assert.ok(Array.isArray(response.json.fields));
	assert.ok(response.json.fields.includes("description"));
	assert.equal(reportDirs(f.reportsDir).length, 0);
});

test("source.product is filled by productOf and a client product is rejected", async (t) => {
	const f = await setup(t);
	const source = { kind: "thread", threadId: "sid-1", itemId: "item-1" };
	const created = await f.request("POST", "/api/reports", { body: baseBody({ source }) });
	assert.equal(created.status, 201);
	assert.equal(f.store.get(UUID).report.source.product, "thread-product");

	const withProduct = baseBody({
		reportId: uuidFor(2),
		source: { ...source, product: "thread-product" },
	});
	const rejected = await f.request("POST", "/api/reports", { body: withProduct });
	assert.equal(rejected.status, 400);
	assert.equal(rejected.json.error, "bad_input");
	assert.ok(rejected.json.fields.includes("source.product"));
});

test("a body over the numeric bodyLimit is 413 too_long", async (t) => {
	const f = await setup(t, { bodyLimit: 1024 });
	const body = baseBody({ description: "가".repeat(2000) });
	const response = await f.request("POST", "/api/reports", { body });
	assert.equal(response.status, 413);
	assert.deepEqual(response.json, { error: "too_long" });
	assert.equal(reportDirs(f.reportsDir).length, 0);
});

test("list is newest first with counts and merged GitHub state", async (t) => {
	const f = await setup(t);
	f.seed("id-a", { createdAt: "2026-01-01T00:00:00.000Z", state: "queued" });
	f.seed("id-b", {
		createdAt: "2026-01-02T00:00:00.000Z",
		state: "failed",
		extraDelivery: { attempts: 3, lastError: { kind: "auth", detail: "GitHub 인증을 확인해야 합니다" } },
	});
	f.seed("id-c", {
		createdAt: "2026-01-03T00:00:00.000Z",
		state: "sent",
		github: { number: 7, url: "https://github.com/yjacket/omo-inbox/issues/7", nodeId: "n7", createdAt: "2026-01-03T00:01:00.000Z" },
	});
	f.state.map = new Map([[7, { state: "closed", comments: 4 }]]);
	f.state.at = "2026-10-28T00:00:05.000Z";

	const response = await f.request("GET", "/api/reports?limit=2");
	assert.equal(response.status, 200);
	assert.deepEqual(response.json.items.map((item) => item.id), ["id-c", "id-b"]);
	assert.equal(response.json.items[0].state, "sent");
	assert.equal(response.json.items[0].github.state, "closed");
	assert.equal(response.json.items[0].github.comments, 4);
	assert.equal(response.json.items[1].detail, "GitHub 인증을 확인해야 합니다");
	assert.deepEqual(response.json.counts, { pending: 1, failed: 1, sent: 1 });
	assert.equal(response.json.nextCursor, "id-b");
	assert.equal(response.json.statesAt, "2026-10-28T00:00:05.000Z");

	const rest = await f.request("GET", "/api/reports?cursor=id-b");
	assert.deepEqual(rest.json.items.map((item) => item.id), ["id-a"]);
	assert.equal(rest.json.nextCursor, null);
});

test("a null cache map leaves GitHub state and comments null", async (t) => {
	const f = await setup(t);
	const id = uuidFor(30);
	f.seed(id, {
		createdAt: "2026-01-03T00:00:00.000Z",
		state: "sent",
		github: { number: 7, url: "https://github.com/yjacket/omo-inbox/issues/7", nodeId: "n7", createdAt: "2026-01-03T00:01:00.000Z" },
	});
	f.state.map = null;
	f.state.at = null;
	const detail = await f.request("GET", `/api/reports/${id}`);
	assert.equal(detail.status, 200);
	assert.deepEqual(detail.json.github, {
		number: 7,
		url: "https://github.com/yjacket/omo-inbox/issues/7",
		state: null,
		comments: null,
	});
});

test("an issue missing from a fresh cache map shows as open with zero comments", async (t) => {
	const f = await setup(t);
	const id = uuidFor(33);
	f.seed(id, {
		createdAt: "2026-01-03T00:00:00.000Z",
		state: "sent",
		github: { number: 5, url: "https://github.com/yjacket/omo-inbox/issues/5", nodeId: "x", createdAt: "2026-10-29T00:00:00.000Z" },
	});
	f.state.map = new Map();
	const response = await f.request("GET", "/api/reports");
	assert.equal(response.status, 200);
	const row = response.json.items.find((item) => item.id === id);
	assert.equal(row.github.state, "open");
	assert.equal(row.github.comments, 0);
});

test("detail carries the row plus delivery and the failed detail", async (t) => {
	const f = await setup(t);
	const nextAttemptAt = "2026-10-28T13:00:00.000Z";
	const id = uuidFor(31);
	f.seed(id, {
		createdAt: "2026-01-02T00:00:00.000Z",
		state: "failed",
		extraDelivery: {
			attempts: 2,
			nextAttemptAt,
			lastError: { kind: "permission", detail: "저장소에 쓸 권한이 없습니다" },
		},
	});
	const response = await f.request("GET", `/api/reports/${id}`);
	assert.equal(response.status, 200);
	assert.equal(response.json.state, "failed");
	assert.equal(response.json.detail, "저장소에 쓸 권한이 없습니다");
	assert.deepEqual(response.json.delivery, { state: "failed", attempts: 2, nextAttemptAt });
});

test("the image route returns the stored PNG with the exact headers", async (t) => {
	const f = await setup(t);
	const id = uuidFor(32);
	f.seed(id, { createdAt: "2026-01-04T00:00:00.000Z", state: "queued", image: PNG });
	const response = await f.requestBytes(`/api/reports/${id}/image`);
	assert.equal(response.status, 200);
	assert.equal(response.headers["content-type"], "image/png");
	assert.equal(response.headers["x-content-type-options"], "nosniff");
	assert.equal(response.headers["content-security-policy"], "default-src 'none'");
	assert.equal(response.headers["cache-control"], "private, no-store");
	assert.deepEqual(response.bytes, PNG);

	const list = await f.request("GET", "/api/reports");
	assert.equal(list.json.items[0].image, true);

	const none = await f.requestBytes(`/api/reports/${uuidFor(33)}/image`);
	assert.equal(none.status, 404);
});

test("retry moves a failed report to pending and then answers 409 not_failed", async (t) => {
	const f = await setup(t);
	const id = uuidFor(34);
	f.seed(id, {
		createdAt: "2026-01-02T00:00:00.000Z",
		state: "failed",
		extraDelivery: { attempts: 1, lastError: { kind: "auth", detail: "GitHub 인증을 확인해야 합니다" } },
	});
	const first = await f.request("POST", `/api/reports/${id}/retry`);
	assert.equal(first.status, 200);
	assert.deepEqual(first.json, { ok: true, state: "pending" });
	assert.deepEqual(f.retried, [id]);
	assert.equal(f.store.get(id).delivery.state, "queued");

	const second = await f.request("POST", `/api/reports/${id}/retry`);
	assert.equal(second.status, 409);
	assert.deepEqual(second.json, { error: "not_failed" });
});

test("handoff persists the session and returns ok", async (t) => {
	const f = await setup(t);
	const id = uuidFor(35);
	f.seed(id, {
		createdAt: "2026-01-03T00:00:00.000Z",
		state: "sent",
		github: { number: 7, url: "https://github.com/yjacket/omo-inbox/issues/7", nodeId: "n7", createdAt: "2026-01-03T00:01:00.000Z" },
	});
	const response = await f.request("POST", `/api/reports/${id}/handoff`);
	assert.equal(response.status, 200);
	assert.deepEqual(response.json, { ok: true, via: "orca", session: "sess-1" });
	assert.equal(f.handoffCalls, 1);
	assert.deepEqual(f.store.get(id).handoff, {
		at: NOW.toISOString(),
		session: "sess-1",
		via: "orca",
	});
});

test("handoff refuses an unsent report with 409 not_sent", async (t) => {
	const f = await setup(t);
	const id = uuidFor(36);
	f.seed(id, { createdAt: "2026-01-01T00:00:00.000Z", state: "queued" });
	const response = await f.request("POST", `/api/reports/${id}/handoff`);
	assert.equal(response.status, 409);
	assert.deepEqual(response.json, { error: "not_sent" });
	assert.equal(f.handoffCalls, 0);
});

test("handoff errors map to cwd_missing 409, no_launcher 503 and launch_failed 502", async (t) => {
	const f = await setup(t);
	const id = uuidFor(37);
	f.seed(id, {
		createdAt: "2026-01-03T00:00:00.000Z",
		state: "sent",
		github: { number: 7, url: "https://github.com/yjacket/omo-inbox/issues/7", nodeId: "n7", createdAt: "2026-01-03T00:01:00.000Z" },
	});
	const cases = [
		[{ ok: false, error: "cwd_missing" }, 409, "cwd_missing"],
		[{ ok: false, error: "no_launcher" }, 503, "no_launcher"],
		[{ ok: false, error: "launch_failed" }, 502, "launch_failed"],
	];
	for (const [result, status, error] of cases) {
		f.setHandoffResult(result);
		const response = await f.request("POST", `/api/reports/${id}/handoff`);
		assert.equal(response.status, status);
		assert.deepEqual(response.json, { error });
	}
	assert.equal(f.store.get(id).handoff, null);
});

test("unknown and malformed report ids are 404", async (t) => {
	const f = await setup(t);
	const unknown = uuidFor(999);
	for (const [method, route] of [
		["GET", `/api/reports/${unknown}`],
		["GET", `/api/reports/${unknown}/image`],
		["POST", `/api/reports/${unknown}/retry`],
		["POST", `/api/reports/${unknown}/handoff`],
		["GET", "/api/reports/not-a-uuid"],
		["POST", "/api/reports/not-a-uuid/retry"],
		["POST", "/api/reports/not-a-uuid/handoff"],
	]) {
		const response = await f.request(method, route);
		assert.equal(response.status, 404, `${method} ${route}`);
		assert.deepEqual(response.json, { error: "not_found" });
	}
});

test("tailnet is forbidden when no owner is configured, and nothing is written", async (t) => {
	const f = await setup(t, { owner: null, publicBase: PUBLIC_BASE });
	const read = await f.request("GET", "/api/reports", { headers: f.phoneHeaders() });
	assert.equal(read.status, 403);
	assert.deepEqual(read.json, { error: "forbidden" });

	const created = await f.request("POST", "/api/reports", {
		body: baseBody(),
		headers: f.phoneHeaders(),
	});
	assert.equal(created.status, 403);
	assert.deepEqual(created.json, { error: "forbidden" });
	assert.deepEqual(reportDirs(f.reportsDir), []);
});

test("a tailnet POST without Origin is 403 and writes nothing", async (t) => {
	const f = await setup(t, { publicBase: PUBLIC_BASE });
	const headers = f.phoneHeaders();
	delete headers.origin;
	const response = await f.request("POST", "/api/reports", { body: baseBody(), headers });
	assert.equal(response.status, 403);
	assert.deepEqual(response.json, { error: "forbidden" });
	assert.deepEqual(reportDirs(f.reportsDir), []);
});

test("a foreign Origin is rejected and writes nothing", async (t) => {
	const f = await setup(t, { publicBase: PUBLIC_BASE });
	const response = await f.request("POST", "/api/reports", {
		body: baseBody(),
		headers: { origin: "https://evil.example" },
	});
	assert.equal(response.status, 403);
	assert.deepEqual(response.json, { error: "forbidden" });
	assert.deepEqual(reportDirs(f.reportsDir), []);
});

test("the positive phone case creates 201", async (t) => {
	const f = await setup(t, { publicBase: PUBLIC_BASE });
	const response = await f.request("POST", "/api/reports", {
		body: baseBody(),
		headers: f.phoneHeaders(),
	});
	assert.equal(response.status, 201);
	assert.deepEqual(response.json, { ok: true, id: UUID, state: "pending", github: null });
	assert.deepEqual(f.kicked, [UUID]);
});

test("the positive phone case retries 200", async (t) => {
	const f = await setup(t, { publicBase: PUBLIC_BASE });
	const id = uuidFor(38);
	f.seed(id, {
		createdAt: "2026-01-02T00:00:00.000Z",
		state: "failed",
		extraDelivery: { attempts: 1, lastError: { kind: "auth", detail: "GitHub 인증을 확인해야 합니다" } },
	});
	const response = await f.request("POST", `/api/reports/${id}/retry`, {
		headers: f.phoneHeaders(),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(response.json, { ok: true, state: "pending" });
});

test("the positive phone case hands off 200", async (t) => {
	const f = await setup(t, { publicBase: PUBLIC_BASE });
	const id = uuidFor(39);
	f.seed(id, {
		createdAt: "2026-01-03T00:00:00.000Z",
		state: "sent",
		github: { number: 7, url: "https://github.com/yjacket/omo-inbox/issues/7", nodeId: "n7", createdAt: "2026-01-03T00:01:00.000Z" },
	});
	const response = await f.request("POST", `/api/reports/${id}/handoff`, {
		headers: f.phoneHeaders(),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(response.json, { ok: true, via: "orca", session: "sess-1" });
	assert.equal(f.store.get(id).handoff.session, "sess-1");
});

test("an invalid list limit is 400 bad_input", async (t) => {
	const f = await setup(t);
	for (const limit of ["0", "101", "abc"]) {
		const response = await f.request("GET", `/api/reports?limit=${limit}`);
		assert.equal(response.status, 400);
		assert.deepEqual(response.json, { error: "bad_input", fields: ["limit"] });
	}
});
