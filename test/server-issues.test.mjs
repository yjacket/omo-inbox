import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createServer, sourceManifestId } from "../src/server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The full suite runs beside other lanes that edit this worktree. A server must
// report its startup digest only while those source bytes are still identical,
// and null otherwise; asserting a hard startup value made the test flaky.
function expectedBuildStamp(server) {
	return sourceManifestId(REPO) === server.buildInfo.buildId ? server.buildInfo.buildId : null;
}
import { identityFor } from "../src/identity.mjs";

const START = Date.parse("2026-10-23T00:00:00Z");
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const CAPTURE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CAPTURE = "44444444-4444-4444-8444-444444444444";
const PIXELS = Buffer.from([255, 0, 0, 255]).toString("base64");

async function withServer(t, options = {}) {
	const tmp = options.tmp ?? makeTmpHome("inbox-issues-http-");
	const pushes = [];
	let pushFails = false;
	const pusher = options.pusher ?? {
		publicKey: "test-key",
		async notify(message) {
			pushes.push(message);
			if (pushFails) throw new Error("push down");
		},
	};
	const server = createServer({
		home: tmp.home,
		webDir: options.webDir ?? path.join(tmp.home, "web"),
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: ["100.64.0.9"], ...(options.config ?? {}) },
		now: () => new Date(START),
		pusher,
	});
	const { port } = await server.listen();
	t.after(async () => {
		await server.close();
		if (!options.keepHome) tmp.cleanup();
	});
	return {
		tmp,
		home: tmp.home,
		server,
		base: `http://127.0.0.1:${port}`,
		port,
		pushes,
		failPush(value) {
			pushFails = value;
		},
	};
}

function post(ctx, route, body, headers = {}) {
	return fetch(ctx.base + route, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
}

async function getJson(ctx, route, headers = {}) {
	const res = await fetch(ctx.base + route, { headers, signal: AbortSignal.timeout(10_000) });
	return { status: res.status, headers: res.headers, body: await res.json() };
}

function capture(captureId = CAPTURE_ID, visual = { kind: "none", reason: "not_requested" }) {
	return {
		captureId,
		observedAt: "2026-10-22T23:59:00.000Z",
		page: "proposal",
		source: null,
		target: null,
		clientBuild: null,
		view: {
			width: 390, height: 844, dpr: 2, scale: 1,
			scrollX: 0, scrollY: 0, theme: "light", locale: "ko-KR",
			embedded: false, viewerOpen: false,
		},
		excerpt: null,
		excerptTruncated: false,
		visibleIds: [],
		diagnostics: [],
		contextStatus: "captured",
		visual,
	};
}

function raster(captureId = CAPTURE_ID) {
	return capture(captureId, {
		kind: "raster",
		provenance: "display_capture",
		acquiredAt: null,
		sourceMatchesContext: "unverified",
		width: 1,
		height: 1,
		encoding: "rgba8-base64",
		pixels: PIXELS,
		masks: [],
		marks: [],
	});
}

function envelope(storeId, overrides = {}) {
	return {
		v: 1,
		storeId,
		requestId: ISSUE_ID,
		description: "결제 화면에서 제보 버튼이 보이지 않습니다",
		evidence: capture(),
		...overrides,
	};
}

function command(storeId, expectedSeq, requestId, value) {
	return { v: 1, storeId, requestId, expectedSeq, command: value };
}

async function storeIdOf(ctx) {
	return (await getJson(ctx, "/api/issues/capabilities")).body.storeId;
}

function snapshot(root) {
	const out = {};
	const walk = (dir, prefix) => {
		let names;
		try {
			names = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of names) {
			const file = path.join(dir, dirent.name);
			const rel = `${prefix}/${dirent.name}`;
			if (dirent.isDirectory()) walk(file, rel);
			else out[rel] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		}
	};
	for (const sub of ["data/proposals", "data/threads", "mailbox"]) walk(path.join(root, sub), sub);
	return out;
}

function makeBoard(home, name = "board") {
	const dir = path.join(home, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify({
		title: "제보 확인",
		sections: [{ title: "화면", cards: [{ title: "제보", frames: [["제보 버튼", "screen.svg"]] }] }],
	}));
	fs.writeFileSync(path.join(dir, "screen.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
	return dir;
}

async function submitBoard(ctx) {
	const srcDir = makeBoard(ctx.home);
	const identity = await identityFor(srcDir, {});
	const res = await post(ctx, "/api/proposals", {
		cwd: srcDir,
		identity: { ...identity, session: { id: "s1", file: null } },
		title: "제보 확인",
		srcDir,
	});
	assert.equal(res.status, 200);
	return (await res.json()).summary.id;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("capabilities, create, exact detail, replay and list use the issue store", async (t) => {
	const ctx = await withServer(t);
	const caps = await getJson(ctx, "/api/issues/capabilities");
	assert.equal(caps.status, 200);
	assert.equal(caps.body.v, 1);
	assert.equal(caps.body.schemas[0], "v1");
	assert.equal(caps.body.build.buildId, expectedBuildStamp(ctx.server));
	assert.equal(caps.body.build.version, ctx.server.buildInfo.version);
	assert.equal(caps.headers.get("cache-control"), "no-store");
	const storeId = caps.body.storeId;
	assert.equal(ctx.server.issues.storeId, storeId);

	const body = envelope(storeId);
	const created = await post(ctx, "/api/issues", body);
	assert.equal(created.status, 201);
	const receipt = await created.json();
	assert.equal(receipt.ok, true);
	assert.equal(receipt.id, ISSUE_ID);
	assert.equal(receipt.receipt.seq, 1);
	assert.equal(receipt.currentSeq, 1);
	assert.equal(receipt.state, "open");
	assert.equal(receipt.evidenceManifest.captureId, CAPTURE_ID);
	assert.equal(receipt.evidenceManifest.referenceCheck.status, "unversioned");

	const detail = await getJson(ctx, `/api/issues/${ISSUE_ID}`);
	assert.equal(detail.status, 200);
	assert.equal(detail.body.issue.id, ISSUE_ID);
	assert.equal(detail.body.issue.storeId, storeId);
	assert.equal(detail.body.issue.title, body.description);
	assert.deepEqual(detail.body.evidence, [receipt.evidenceManifest]);
	assert.equal(detail.body.events.length, 1);
	assert.equal(detail.body.events[0].requestId, ISSUE_ID);
	assert.equal(detail.body.capabilities.storeId, storeId);
	assert.equal(detail.body.capabilities.build.buildId, expectedBuildStamp(ctx.server));

	const replay = await post(ctx, "/api/issues", body);
	assert.equal(replay.status, 200);
	const replayed = await replay.json();
	assert.deepEqual(replayed.receipt, receipt.receipt);
	assert.equal(replayed.currentSeq, receipt.currentSeq);

	const list = await getJson(ctx, "/api/issues?state=open");
	assert.deepEqual(list.body.counts, { open: 1, investigating: 0, "needs-check": 0, resolved: 0 });
	assert.equal(list.body.items[0].id, ISSUE_ID);
});

test("issue HTTP guards reject oversized, unguarded, foreign and unowned requests without writes", async (t) => {
	const ctx = await withServer(t);
	const storeId = await storeIdOf(ctx);
	const before = snapshot(ctx.home);

	const missing = await fetch(ctx.base + "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(envelope(storeId)),
	});
	assert.equal(missing.status, 403);

	for (const origin of ["null", "https://example.invalid"]) {
		const denied = await post(ctx, "/api/issues", envelope(storeId), { origin });
		assert.equal(denied.status, 403, origin);
	}
	const literalNull = await post(ctx, "/api/issues", envelope(storeId), { origin: "null" });
	assert.equal(literalNull.status, 403);

	const noOwner = await getJson(ctx, "/api/issues/capabilities", {
		"x-forwarded-for": "100.64.0.50",
		"tailscale-user-login": "owner@example.com",
	});
	assert.equal(noOwner.status, 403);

	const funnel = await getJson(ctx, "/api/issues/capabilities", { "tailscale-funnel-request": "?1" });
	assert.equal(funnel.status, 403);

	const invalid = await getJson(ctx, "/api/issues/not-a-uuid");
	assert.equal(invalid.status, 400);
	assert.equal(invalid.body.error, "bad_input");

	const oversized = await fetch(ctx.base + "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: Buffer.alloc(12 * 1024 * 1024 + 1, 0x78),
		signal: AbortSignal.timeout(20_000),
	});
	assert.equal(oversized.status, 413);

	assert.deepEqual(snapshot(ctx.home), before, "rejected requests must not write source data");

	const accepted = await post(ctx, "/api/issues", envelope(storeId), { origin: ctx.base });
	assert.equal(accepted.status, 201);

	const reused = await post(ctx, "/api/issues", envelope(storeId, { description: "같은 요청 번호의 다른 내용" }));
	assert.equal(reused.status, 409);
	assert.deepEqual(await reused.json(), { error: "key_reused" });

	const stale = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 0, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", {
		type: "triage", category: "other", severity: "normal", note: null,
	}));
	assert.equal(stale.status, 409);
	assert.deepEqual(await stale.json(), { error: "version_conflict", currentSeq: 1, state: "open" });

	const ownerTriage = await post(ctx, `/api/issues/${ISSUE_ID}/feedback`, command(storeId, 1, "ffffffff-ffff-4fff-8fff-ffffffffffff", {
		type: "triage", category: "other", severity: "normal", note: null,
	}));
	assert.equal(ownerTriage.status, 403);
	assert.deepEqual(await ownerTriage.json(), { error: "forbidden" });

	const owned = await withServer(t, { config: { owner: "owner@example.com" } });
	const allowed = await getJson(owned, "/api/issues/capabilities", {
		"x-forwarded-for": "100.64.0.50",
		"tailscale-user-login": "owner@example.com",
	});
	assert.equal(allowed.status, 200);
});

test("a genuinely larger body still fits the old endpoints' unchanged 30 MiB limit", async (t) => {
	const ctx = await withServer(t);
	const accepted = await fetch(ctx.base + "/api/proposals", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify({ srcDir: "missing", pad: "x".repeat(13 * 1024 * 1024) }),
		signal: AbortSignal.timeout(20_000),
	});
	assert.notEqual(accepted.status, 413, "the old endpoint keeps its 30 MiB limit");
});

test("evidence images are manifest-selected and cannot cross issue boundaries", async (t) => {
	const ctx = await withServer(t);
	const storeId = await storeIdOf(ctx);
	const first = await post(ctx, "/api/issues", envelope(storeId, { requestId: ISSUE_ID, evidence: raster(CAPTURE_ID) }));
	assert.equal(first.status, 201);
	const second = await post(ctx, "/api/issues", envelope(storeId, { requestId: OTHER_ID, description: "다른 문제", evidence: raster(OTHER_CAPTURE) }));
	assert.equal(second.status, 201);

	const image = await fetch(`${ctx.base}/api/issues/${ISSUE_ID}/evidence/${CAPTURE_ID}/image`);
	assert.equal(image.status, 200);
	assert.equal(image.headers.get("content-type"), "image/png");
	assert.equal(image.headers.get("x-content-type-options"), "nosniff");
	assert.equal(image.headers.get("content-security-policy"), "default-src 'none'");
	assert.equal(image.headers.get("cache-control"), "private, no-store");
	const bytes = Buffer.from(await image.arrayBuffer());
	assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

	const crossed = await fetch(`${ctx.base}/api/issues/${ISSUE_ID}/evidence/${OTHER_CAPTURE}/image`);
	assert.equal(crossed.status, 404);
	assert.deepEqual(await crossed.json(), { error: "not_found" });
});

test("request_check pushes once, replay pushes nothing, and push failure never changes the response", async (t) => {
	const ctx = await withServer(t);
	const storeId = await storeIdOf(ctx);
	assert.equal((await post(ctx, "/api/issues", envelope(storeId))).status, 201);
	const checkId = "55555555-5555-4555-8555-555555555555";
	const check = command(storeId, 1, checkId, {
		type: "request_check",
		note: "수정했습니다",
		correction: { kind: "inbox-build", buildId: "a".repeat(64), summary: "새 빌드" },
		evidence: null,
	});
	const first = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, check);
	assert.equal(first.status, 200);
	const firstBody = await first.json();
	assert.equal(firstBody.state, "needs-check");
	assert.equal(firstBody.currentSeq, 2);
	await flush();
	assert.equal(ctx.pushes.length, 1);
	assert.deepEqual(ctx.pushes[0], {
		title: "제보한 문제의 수정안이 왔습니다",
		body: "제보함에서 확인해 주세요.",
		url: `/issues/${ISSUE_ID}`,
		tag: `issue:${ISSUE_ID}`,
	});

	const replay = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, check);
	assert.equal(replay.status, 200);
	assert.deepEqual((await replay.json()).receipt, firstBody.receipt);
	await flush();
	assert.equal(ctx.pushes.length, 1, "exact replay emits no second push");

	ctx.failPush(true);
	const secondCheck = command(storeId, 2, "66666666-6666-4666-8666-666666666666", {
		type: "request_check",
		note: "다시 확인해 주세요",
		correction: { kind: "inbox-build", buildId: "b".repeat(64), summary: "두 번째 빌드" },
		evidence: null,
	});
	const failed = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, secondCheck);
	assert.equal(failed.status, 200);
	const failedBody = await failed.json();
	assert.equal(failedBody.state, "needs-check");
	assert.equal(failedBody.currentSeq, 3);
	assert.equal(Object.hasOwn(failedBody, "delivery"), false);
	const detail = await getJson(ctx, `/api/issues/${ISSUE_ID}`);
	assert.equal(detail.body.currentSeq, 3);
	assert.equal(detail.body.state, "needs-check");
	await flush();
	assert.equal(ctx.pushes.length, 2, "the failed push was attempted but not rolled back");
});

test("request_check rejects unknown Review identity before committing", async (t) => {
	const ctx = await withServer(t);
	const proposalId = await submitBoard(ctx);
	const storeId = await storeIdOf(ctx);
	assert.equal((await post(ctx, "/api/issues", envelope(storeId))).status, 201);

	const absentProposal = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 1, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
		type: "request_check", note: "확인 부탁드립니다",
		correction: { kind: "review-artifact", proposalId: OTHER_ID, revision: 1, summary: "없는 Review" }, evidence: null,
	}));
	assert.equal(absentProposal.status, 400);
	assert.deepEqual(await absentProposal.json(), { error: "bad_input", fields: ["command.correction.proposalId"] });

	const absentRevision = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 1, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
		type: "request_check", note: "확인 부탁드립니다",
		correction: { kind: "review-artifact", proposalId, revision: 999, summary: "없는 개정" }, evidence: null,
	}));
	assert.equal(absentRevision.status, 400);
	assert.deepEqual(await absentRevision.json(), { error: "bad_input", fields: ["command.correction.revision"] });

	const beforeCommit = await getJson(ctx, `/api/issues/${ISSUE_ID}`);
	assert.equal(beforeCommit.body.currentSeq, 1);
	assert.equal(beforeCommit.body.state, "open");

	const matched = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 1, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
		type: "request_check", note: "수정본을 올렸습니다",
		correction: { kind: "review-artifact", proposalId, revision: 1, summary: "수정본" }, evidence: null,
	}));
	assert.equal(matched.status, 200);
	const matchedBody = await matched.json();
	assert.equal(matchedBody.state, "needs-check");
	assert.equal(matchedBody.currentSeq, 2);
	assert.equal(matchedBody.correctionCheck.status, "matched");
	assert.match(matchedBody.correctionCheck.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
	const matchedDetail = await getJson(ctx, `/api/issues/${ISSUE_ID}`);
	const matchedEvent = matchedDetail.body.events.find((event) => event.seq === 2);
	assert.deepEqual(matchedEvent.correctionCheck, matchedBody.correctionCheck, "GET detail projects the persisted correction check");
	assert.deepEqual(
		JSON.parse(fs.readFileSync(path.join(ctx.home, "data", "issues", "records", ISSUE_ID, "events", "000002.json"), "utf8")).correctionCheck,
		matchedBody.correctionCheck,
		"the committed event persists the correction check",
	);

	const unknownBuild = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 2, "edededdd-eded-4ded-8ded-edededededed", {
		type: "request_check", note: "다른 빌드",
		correction: { kind: "inbox-build", buildId: "f".repeat(64), summary: "배포되지 않은 빌드" }, evidence: null,
	}));
	assert.equal(unknownBuild.status, 200);
	const unknownBody = await unknownBuild.json();
	assert.equal(unknownBody.correctionCheck.status, "unversioned");
	const unknownDetail = await getJson(ctx, `/api/issues/${ISSUE_ID}`);
	assert.equal(unknownDetail.body.events.find((event) => event.seq === 3).correctionCheck.status, "unversioned");

	const nullBuild = await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 3, "fafafafa-fafa-4afa-8afa-fafafafafafa", {
		type: "request_check", note: "빌드를 모릅니다",
		correction: { kind: "inbox-build", buildId: null, summary: "알 수 없는 빌드" }, evidence: null,
	}));
	assert.equal(nullBuild.status, 200);
	const nullBody = await nullBuild.json();
	assert.equal(nullBody.correctionCheck.status, "unversioned");
	assert.equal(
		(await getJson(ctx, `/api/issues/${ISSUE_ID}`)).body.events.find((event) => event.seq === 4).correctionCheck.status,
		"unversioned",
	);
});

test("a full issue lifecycle leaves proposals, threads and mailbox bytes untouched", async (t) => {
	const ctx = await withServer(t);
	const proposalId = await submitBoard(ctx);
	await post(ctx, "/api/threads/s1/items", { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1", raw: { text: "확인" } });
	await ctx.server.drain();
	const storeId = await storeIdOf(ctx);
	const before = snapshot(ctx.home);
	const proposalBytes = fs.readFileSync(path.join(ctx.home, "data", "proposals", proposalId, "proposal.json"));

	const source = { kind: "proposal", proposalId, revision: 1, observedSeq: 0, recordedContentHash: null, frame: null };
	const created = await post(ctx, "/api/issues", envelope(storeId, { evidence: capture(CAPTURE_ID, { kind: "none", reason: "not_requested" }) }));
	assert.equal(created.status, 201);
	const withSource = await post(ctx, "/api/issues", envelope(storeId, {
		requestId: OTHER_ID,
		description: "원본 Review의 제보 버튼",
		evidence: { ...capture(OTHER_CAPTURE), source },
	}));
	assert.equal(withSource.status, 201);
	assert.equal((await withSource.json()).referenceCheck.status, "matched");

	assert.equal((await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 1, "77777777-7777-4777-8777-777777777777", {
		type: "triage", category: "inbox-ui", severity: "high", note: null,
	}))).status, 200);
	assert.equal((await post(ctx, `/api/issues/${ISSUE_ID}/commands`, command(storeId, 2, "88888888-8888-4888-8888-888888888888", {
		type: "request_check", note: "확인 부탁드립니다",
		correction: { kind: "review-artifact", proposalId, revision: 1, summary: "수정본" }, evidence: null,
	}))).status, 200);
	assert.equal((await post(ctx, `/api/issues/${ISSUE_ID}/feedback`, command(storeId, 3, "99999999-9999-4999-8999-999999999999", {
		type: "confirm",
	}))).status, 200);
	assert.equal((await post(ctx, `/api/issues/${ISSUE_ID}/feedback`, command(storeId, 4, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
		type: "comment", text: "확인했습니다",
	}))).status, 200);

	assert.deepEqual(snapshot(ctx.home), before, "issues never write proposal, thread or mailbox data");
	assert.deepEqual(fs.readFileSync(path.join(ctx.home, "data", "proposals", proposalId, "proposal.json")), proposalBytes);
	const detail = await getJson(ctx, `/api/issues/${ISSUE_ID}`);
	assert.equal(detail.body.state, "resolved");
	assert.equal(detail.body.currentSeq, 5);
});

test("pages carry the startup build stamp, css is typed, and issue pages stay isolated", async (t) => {
	const tmp = makeTmpHome("inbox-issues-web-");
	t.after(() => tmp.cleanup());
	const web = path.join(tmp.home, "web");
	fs.mkdirSync(web, { recursive: true });
	fs.writeFileSync(path.join(web, "inbox.html"), "<!doctype html><html><head><title>inbox</title></head><body>inbox</body></html>");
	fs.writeFileSync(path.join(web, "issues.html"), "<!doctype html><html><head><title>issues</title></head><body>issues</body></html>");
	fs.writeFileSync(path.join(web, "issues.css"), "body {}\n");
	fs.writeFileSync(path.join(web, "targets.json"), "[]");
	const ctx = await withServer(t, { tmp, webDir: web, keepHome: true });

	const page = await fetch(`${ctx.base}/`);
	assert.equal(page.status, 200);
	const html = await page.text();
	assert.match(html, new RegExp(`<head><meta name="inbox-build" content="${expectedBuildStamp(ctx.server)}">`));

	const issues = await fetch(`${ctx.base}/issues/new`);
	assert.equal(issues.status, 200);
	assert.match(await issues.text(), /inbox-build/);
	fs.rmSync(path.join(web, "issues.html"));
	const missing = await fetch(`${ctx.base}/issues/${ISSUE_ID}`);
	assert.equal(missing.status, 404);
	assert.deepEqual(await missing.json(), { error: "not_found" });
	assert.equal(missing.headers.get("content-security-policy"), "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'");
	assert.equal((await fetch(`${ctx.base}/issues/not-a-uuid`)).status, 404);
	const css = await fetch(`${ctx.base}/web/issues.css`);
	assert.equal(css.status, 200);
	assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
});
