/* Q10: guarded issue HTTP routes and truthful build provenance.
 *
 * HTTP only. The fixture server is a real child process (ledger D3); every call
 * carries a named 10 s AbortSignal deadline and every wait subscribes to the push
 * sink before triggering the request that writes it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ISSUE_ID = "10101010-1010-4010-8010-101010101010";
const OTHER_ID = "20202020-2020-4020-8020-202020202020";
const CAPTURE_ID = "30303030-3030-4030-8030-303030303030";
const OTHER_CAPTURE = "40404040-4040-4040-8040-404040404040";
const CHECK_ID = "50505050-5050-4050-8050-505050505050";
const ABSENT_REVIEW_ID = "60606060-6060-4060-8060-606060606060";
const ABSENT_REVISION_ID = "70707070-7070-4070-8070-707070707070";
const VALID_REVIEW_ID = "80808080-8080-4080-8080-808080808080";
const UNKNOWN_BUILD_ID = "90909090-9090-4090-8090-909090909090";
const PIXELS = Buffer.from([255, 0, 0, 255]).toString("base64");
const TIMEOUT = 10_000;

function capture(captureId, source) {
	return {
		captureId,
		observedAt: "2026-10-23T00:00:00.000Z",
		page: "proposal",
		source,
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
		visual: {
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
		},
	};
}

function envelope(storeId, requestId, description, evidence) {
	return { v: 1, storeId, requestId, description, evidence };
}

function command(storeId, expectedSeq, requestId, value) {
	return { v: 1, storeId, requestId, expectedSeq, command: value };
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

function diff(before, after) {
	const added = Object.keys(after).filter((key) => !(key in before));
	const removed = Object.keys(before).filter((key) => !(key in after));
	const changed = Object.keys(after).filter((key) => key in before && before[key] !== after[key]);
	return { equal: !added.length && !removed.length && !changed.length, added, removed, changed };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

export default async function run({ ctx, check, evidence }) {
	const log = [];
	const read = (file) => {
		if (!fs.existsSync(file)) return [];
		const text = fs.readFileSync(file, "utf8").trim();
		return text ? text.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
	};
	const request = async (label, route, init = {}) => {
		const res = await fetch(ctx.base + route, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		const headers = Object.fromEntries(res.headers.entries());
		log.push({ label, method: init.method ?? "GET", route, status: res.status, headers, body: text.length > 500 ? `${text.slice(0, 500)}… (${text.length} bytes)` : body });
		return { status: res.status, headers, body };
	};

	const caps = await request("capabilities", "/api/issues/capabilities");
	check("Q10 capabilities 200 with a store id", caps.status === 200 && typeof caps.body.storeId === "string", JSON.stringify(caps.body && caps.body.storeId));
	check("Q10 capabilities report a server build id", caps.body && caps.body.build && /^[0-9a-f]{64}$/.test(caps.body.build.buildId ?? ""), caps.body?.build?.buildId);
	const storeId = caps.body.storeId;

	const before = snapshot(ctx.home);
	const source = {
		kind: "proposal",
		proposalId: ctx.fixtures.decision.id,
		revision: 1,
		observedSeq: 0,
		recordedContentHash: null,
		frame: null,
	};
	const body = envelope(storeId, ISSUE_ID, "제보 버튼이 보이지 않습니다", capture(CAPTURE_ID, source));
	const created = await request("create", "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(body),
	});
	check("Q10 valid create returns 201", created.status === 201, String(created.status));
	check("Q10 create returns receipt seq 1", created.body?.receipt?.seq === 1, JSON.stringify(created.body?.receipt));
	check("Q10 create reference check is matched", created.body?.referenceCheck?.status === "matched", created.body?.referenceCheck?.status);
	check("Q10 create manifest is present", created.body?.evidenceManifest?.captureId === CAPTURE_ID, JSON.stringify(created.body?.evidenceManifest?.captureId));

	const detail = await request("detail", `/api/issues/${ISSUE_ID}`);
	check("Q10 detail manifest equals the create manifest", JSON.stringify(detail.body?.evidence?.[0]) === JSON.stringify(created.body?.evidenceManifest), JSON.stringify(detail.body?.evidence?.[0]));
	const createdEvent = detail.body?.events?.[0];
	check(
		"Q10 detail receipt matches the create receipt",
		createdEvent?.requestId === created.body?.receipt?.requestId && createdEvent?.acceptedAt === created.body?.receipt?.acceptedAt && createdEvent?.seq === created.body?.receipt?.seq,
		JSON.stringify(createdEvent && { requestId: createdEvent.requestId, seq: createdEvent.seq, acceptedAt: createdEvent.acceptedAt }),
	);
	check("Q10 detail carries the build capability", detail.body?.capabilities?.build?.buildId === caps.body.build.buildId, detail.body?.capabilities?.build?.buildId);

	const replay = await request("replay", "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(body),
	});
	check("Q10 exact replay returns 200", replay.status === 200, String(replay.status));
	check("Q10 exact replay returns the original receipt", JSON.stringify(replay.body?.receipt) === JSON.stringify(created.body?.receipt), JSON.stringify(replay.body?.receipt));

	const absentReview = await request("correction-absent-review", `/api/issues/${ISSUE_ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(command(storeId, 1, ABSENT_REVIEW_ID, {
			type: "request_check", note: "확인 부탁드립니다",
			correction: { kind: "review-artifact", proposalId: OTHER_ID, revision: 1, summary: "없는 Review" }, evidence: null,
		})),
	});
	check(
		"Q10 correction with an absent Review is 400 on correction.proposalId",
		absentReview.status === 400 && absentReview.body?.error === "bad_input" && JSON.stringify(absentReview.body?.fields) === JSON.stringify(["command.correction.proposalId"]),
		`${absentReview.status} ${JSON.stringify(absentReview.body)}`,
	);

	const absentRevision = await request("correction-absent-revision", `/api/issues/${ISSUE_ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(command(storeId, 1, ABSENT_REVISION_ID, {
			type: "request_check", note: "확인 부탁드립니다",
			correction: { kind: "review-artifact", proposalId: source.proposalId, revision: 999, summary: "없는 개정" }, evidence: null,
		})),
	});
	check(
		"Q10 correction with an absent revision is 400 on correction.revision",
		absentRevision.status === 400 && absentRevision.body?.error === "bad_input" && JSON.stringify(absentRevision.body?.fields) === JSON.stringify(["command.correction.revision"]),
		`${absentRevision.status} ${JSON.stringify(absentRevision.body)}`,
	);

	const untouched = await request("correction-rejected-state", `/api/issues/${ISSUE_ID}`);
	check("Q10 rejected corrections do not commit", untouched.body?.currentSeq === 1 && untouched.body?.state === "open", JSON.stringify({ currentSeq: untouched.body?.currentSeq, state: untouched.body?.state }));

	const validReview = await request("correction-valid-review", `/api/issues/${ISSUE_ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(command(storeId, 1, VALID_REVIEW_ID, {
			type: "request_check", note: "수정본을 올렸습니다",
			correction: { kind: "review-artifact", proposalId: source.proposalId, revision: 1, summary: "수정본" }, evidence: null,
		})),
	});
	check(
		"Q10 existing Review and revision is recorded as matched",
		validReview.status === 200 && validReview.body?.correctionCheck?.status === "matched" && validReview.body?.state === "needs-check",
		`${validReview.status} ${JSON.stringify(validReview.body && { correctionCheck: validReview.body.correctionCheck, state: validReview.body.state })}`,
	);
	const reviewDetail = await request("correction-matched-detail", `/api/issues/${ISSUE_ID}`);
	const reviewEvent = reviewDetail.body?.events?.find((event) => event.seq === 2);
	check(
		"Q10 GET detail projects the matched correctionCheck from the committed event",
		JSON.stringify(reviewEvent?.correctionCheck) === JSON.stringify(validReview.body?.correctionCheck),
		JSON.stringify(reviewEvent?.correctionCheck),
	);

	const unknownBuild = await request("correction-unknown-build", `/api/issues/${ISSUE_ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(command(storeId, 2, UNKNOWN_BUILD_ID, {
			type: "request_check", note: "다른 빌드",
			correction: { kind: "inbox-build", buildId: "f".repeat(64), summary: "배포되지 않은 빌드" }, evidence: null,
		})),
	});
	check(
		"Q10 unknown inbox-build correction stays unversioned",
		unknownBuild.status === 200 && unknownBuild.body?.correctionCheck?.status === "unversioned",
		`${unknownBuild.status} ${JSON.stringify(unknownBuild.body?.correctionCheck)}`,
	);

	const nullBuild = await request("correction-null-build", `/api/issues/${ISSUE_ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(command(storeId, 3, "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0", {
			type: "request_check", note: "빌드를 모릅니다",
			correction: { kind: "inbox-build", buildId: null, summary: "알 수 없는 빌드" }, evidence: null,
		})),
	});
	check(
		"Q10 inbox-build with null buildId is accepted as unversioned",
		nullBuild.status === 200 && nullBuild.body?.correctionCheck?.status === "unversioned" && nullBuild.body?.state === "needs-check",
		`${nullBuild.status} ${JSON.stringify(nullBuild.body && { correctionCheck: nullBuild.body.correctionCheck, state: nullBuild.body.state })}`,
	);
	const nullDetail = await request("correction-null-build-detail", `/api/issues/${ISSUE_ID}`);
	check(
		"Q10 GET detail projects the null-build correctionCheck",
		nullDetail.body?.events?.find((event) => event.seq === 4)?.correctionCheck?.status === "unversioned",
		JSON.stringify(nullDetail.body?.events?.find((event) => event.seq === 4)?.correctionCheck),
	);

	await request("create-other", "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(envelope(storeId, OTHER_ID, "다른 화면의 문제", capture(OTHER_CAPTURE, null))),
	});

	const oversized = await request("oversized", "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: Buffer.alloc(12 * 1024 * 1024 + 1, 0x78),
	});
	check("Q10 12 MiB + 1 is 413", oversized.status === 413, String(oversized.status));

	const missingGuard = await request("missing-x-inbox", "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	check("Q10 missing x-inbox is 403", missingGuard.status === 403, String(missingGuard.status));

	const nullOrigin = await request("origin-null", "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1", origin: "null" },
		body: JSON.stringify(body),
	});
	check("Q10 Origin null is 403", nullOrigin.status === 403, String(nullOrigin.status));

	const foreignOrigin = await request("origin-foreign", "/api/issues", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1", origin: "https://example.invalid" },
		body: JSON.stringify(body),
	});
	check("Q10 foreign Origin is 403", foreignOrigin.status === 403, String(foreignOrigin.status));

	const ownerless = await request("ownerless-tailnet", "/api/issues/capabilities", {
		headers: { "x-forwarded-for": "100.64.0.50", "tailscale-user-login": "owner@example.com" },
	});
	check("Q10 ownerless forwarded tailnet is 403", ownerless.status === 403, String(ownerless.status));

	const funnel = await request("funnel", "/api/issues/capabilities", { headers: { "tailscale-funnel-request": "?1" } });
	check("Q10 Funnel header is rejected", funnel.status === 403, String(funnel.status));

	const invalid = await request("invalid-id", "/api/issues/not-a-uuid");
	check("Q10 invalid id is 400", invalid.status === 400 && invalid.body?.error === "bad_input", `${invalid.status} ${JSON.stringify(invalid.body)}`);

	const crossed = await request("cross-issue-image", `/api/issues/${ISSUE_ID}/evidence/${OTHER_CAPTURE}/image`);
	check("Q10 cross-issue image is 404", crossed.status === 404, String(crossed.status));

	const image = await request("own-image", `/api/issues/${ISSUE_ID}/evidence/${CAPTURE_ID}/image`);
	check("Q10 own image is a no-store PNG", image.status === 200 && image.headers["content-type"] === "image/png" && image.headers["cache-control"] === "private, no-store", `${image.status} ${image.headers["content-type"]}`);

	// Push evidence. Subscribe first, then take the baseline after the welcome entry.
	const ecdh = crypto.createECDH("prime256v1");
	ecdh.generateKeys();
	const welcomeWait = ctx.barriers.pushEntry();
	const subscribed = await request("subscribe", "/api/push/subscribe", {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify({
			subscription: {
				endpoint: "https://push.example.invalid/send/q10",
				keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
			},
		}),
	});
	check("Q10 push subscription is accepted", subscribed.status === 200, String(subscribed.status));
	await welcomeWait;
	const pushFile = ctx.push.file;
	const baseline = read(pushFile).length;
	check("Q10 welcome push established the sink baseline", baseline === 1, String(baseline));
	const sinkWait = ctx.barriers.pushEntry();
	const checkBody = command(storeId, 4, CHECK_ID, {
		type: "request_check",
		note: "수정했습니다",
		correction: { kind: "inbox-build", buildId: caps.body.build.buildId, summary: "제보 화면 수정" },
		evidence: null,
	});
	const checkCreated = await request("request-check", `/api/issues/${ISSUE_ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(checkBody),
	});
	check("Q10 request_check commits", checkCreated.status === 200 && checkCreated.body?.state === "needs-check", `${checkCreated.status} ${JSON.stringify(checkCreated.body)}`);
	const pushed = await sinkWait;
	const entries = read(pushFile).slice(baseline);
	const payload = entries[0]?.payload;
	check("Q10 request_check emits one generic push", entries.length === 1, JSON.stringify(entries.length));
	check(
		"Q10 push copy is generic",
		payload?.title === "제보한 문제의 수정안이 왔습니다" && payload?.body === "제보함에서 확인해 주세요." && payload?.url === `/issues/${ISSUE_ID}` && payload?.tag === `issue:${ISSUE_ID}`,
		JSON.stringify(payload),
	);
	check("Q10 push barrier observed the sink line", Boolean(pushed), JSON.stringify(pushed));

	const replayCheck = await request("request-check-replay", `/api/issues/${ISSUE_ID}/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: JSON.stringify(checkBody),
	});
	await flush();
	const afterReplay = read(pushFile).length;
	check("Q10 request_check replay is 200", replayCheck.status === 200, String(replayCheck.status));
	check("Q10 request_check replay emits no second push", afterReplay === baseline + 1, JSON.stringify({ baseline, afterReplay }));

	const after = snapshot(ctx.home);
	const sourceDiff = diff(before, after);
	check("Q10 source directories are byte-identical", sourceDiff.equal, JSON.stringify(sourceDiff));

	evidence("Q10-http.txt", log.map((entry) => [
		`### ${entry.label} ${entry.method} ${entry.route}`,
		`status: ${entry.status}`,
		`headers: ${JSON.stringify(entry.headers)}`,
		`body: ${typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body)}`,
		"",
	].join("\n")).join("\n"));
	evidence("Q10-source-diff.json", JSON.stringify({ before, after, diff: sourceDiff }, null, "\t"));
	evidence("Q10-push.json", JSON.stringify({ baseline, entries, replayAdded: afterReplay - baseline, replayEntryCount: afterReplay, generic: payload }, null, "\t"));
}
