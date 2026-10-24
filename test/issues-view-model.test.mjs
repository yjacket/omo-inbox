import assert from "node:assert/strict";
import test from "node:test";
import { validateCommand } from "../src/issues-contract.mjs";
import {
	appendEvidenceFor,
	checkView,
	clientBuildFromStamp,
	commandEnvelope,
	committedEvent,
	detailViewModel,
	errorViewModel,
	evidenceView,
	formatAgo,
	formatStamp,
	issueBadgeFromCounts,
	listLocationSearch,
	listQueryFromSearch,
	listRequestPath,
	listViewModel,
	mergeDetailPages,
	mutationOutcome,
	mutationReceipt,
	ownerActions,
	ownerCommand,
	purgeConfirmText,
	routeFromPath,
	textCheck,
} from "../web/issues.js";

const ISSUE = "10101010-1010-4010-8010-101010101010";
const STORE = "20202020-2020-4020-8020-202020202020";
const CAPTURE = "30303030-3030-4030-8030-303030303030";
const CAPTURE_2 = "40404040-4040-4040-8040-404040404040";
const REQUEST = "50505050-5050-4050-8050-505050505050";
const BUILD_A = "a".repeat(64);
const BUILD_B = "b".repeat(64);
const HASH = "c".repeat(64);
const T0 = "2026-10-23T00:00:00.000Z";
const T1 = "2026-10-23T00:10:00.000Z";
const T2 = "2026-10-23T00:20:00.000Z";
const T3 = "2026-10-23T00:30:00.000Z";
const NOW_MS = Date.parse("2026-10-23T01:00:00.000Z");
const PIXELS = Buffer.from([255, 0, 0, 255]).toString("base64");

function manifest(seq, captureId, visual, { acceptedAt = T0, source = null, referenceCheck = { status: "matched", checkedAt: T0 }, clientBuild = null, serverBuild = BUILD_A, context = {} } = {}) {
	return {
		v: 1,
		seq,
		captureId,
		observedAt: T0,
		acceptedAt,
		source,
		clientBuild,
		serverBuild,
		referenceCheck,
		context: {
			captureId,
			observedAt: T0,
			page: "proposal",
			source,
			target: { kind: "control", key: "btn:report", label: "제보 버튼", rect: { x: 1, y: 2, w: 3, h: 4 }, framePath: [] },
			clientBuild,
			view: { width: 390, height: 844, dpr: 2, scale: 1, scrollX: 0, scrollY: 0, theme: "dark", locale: "ko-KR", embedded: false, viewerOpen: false },
			excerpt: "선택한 내용",
			excerptTruncated: false,
			visibleIds: [],
			diagnostics: [],
			contextStatus: "captured",
			visual,
			sha256: HASH,
			byteLength: 10,
			...context,
		},
		visual,
	};
}

function raster(provenance) {
	return { kind: "raster", provenance, acquiredAt: T0, sourceMatchesContext: "unverified", width: 1, height: 1, masks: [{ x: 0, y: 0, w: 1, h: 1 }], marks: [], sha256: HASH, byteLength: 70 };
}

function event(seq, type, { actor = "owner", command = null, state = "open", acceptedAt = T0, evidenceManifest = null, correctionCheck } = {}) {
	const out = {
		v: 1, type, seq, requestId: REQUEST.replace(/^5/, String(seq)), fingerprint: HASH, acceptedAt, actor, via: "local",
		serverBuild: BUILD_A, state, command, evidenceManifest, previousHash: HASH, hash: HASH,
	};
	if (correctionCheck) out.correctionCheck = correctionCheck;
	return out;
}

const SOURCE = { kind: "proposal", proposalId: "decision-1", revision: 1, observedSeq: 0, recordedContentHash: null, frame: null };

function detailFixture({ state = "needs-check", check = { status: "unversioned", checkedAt: T1 }, correction = { kind: "inbox-build", buildId: BUILD_B, summary: "제보 화면 수정" }, extraEvents = [], serverBuild = BUILD_A } = {}) {
	const created = manifest(1, CAPTURE, raster("display_capture"), { source: SOURCE, clientBuild: { kind: "page_response_manifest", version: null, digest: BUILD_A } });
	const reproduction = manifest(2, CAPTURE_2, raster("reproduction"), { acceptedAt: T1, referenceCheck: { status: "unversioned", checkedAt: T1 } });
	const events = [
		event(1, "created", { evidenceManifest: created }),
		event(2, "request_check", {
			actor: "maintainer", state: "needs-check", acceptedAt: T1,
			command: { type: "request_check", note: "수정본을 올렸습니다", correction, evidence: { captureId: CAPTURE_2 } },
			evidenceManifest: reproduction, correctionCheck: check,
		}),
		...extraEvents,
	];
	return {
		issue: { id: ISSUE, storeId: STORE, title: "제보 버튼이 보이지 않습니다", description: "제보 버튼이 보이지 않습니다\n두 번째 줄", createdAt: T0, source: SOURCE },
		state,
		currentSeq: events.length,
		events,
		evidence: [created, reproduction],
		nextAfter: null,
		capabilities: { v: 1, storeId: STORE, limits: { COMMENT_BYTES: 4096 }, build: { buildId: serverBuild } },
	};
}

test("routeFromPath picks list, new, detail and rejects everything else", () => {
	assert.deepEqual(routeFromPath("/issues"), { kind: "list", id: null });
	assert.deepEqual(routeFromPath("/issues/"), { kind: "list", id: null });
	assert.deepEqual(routeFromPath("/issues/new"), { kind: "new", id: null });
	assert.deepEqual(routeFromPath(`/issues/${ISSUE}`), { kind: "detail", id: ISSUE });
	assert.equal(routeFromPath("/issues/a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0").kind, "detail");
	assert.equal(routeFromPath("/issues/A0A0A0A0-A0A0-40A0-80A0-A0A0A0A0A0A0").kind, "unknown");
	assert.equal(routeFromPath("/issues/not-a-uuid").kind, "unknown");
	assert.equal(routeFromPath("/boards").kind, "unknown");
});

test("list query, location and request path agree and validate the state filter", () => {
	assert.deepEqual(listQueryFromSearch("?q=%20결제%20&state=needs-check"), { q: "결제", state: "needs-check" });
	assert.deepEqual(listQueryFromSearch("?state=bogus"), { q: "", state: null });
	assert.equal(listLocationSearch({ q: "결제", state: "open" }), "?q=%EA%B2%B0%EC%A0%9C&state=open");
	assert.equal(listLocationSearch({ q: "  ", state: null }), "");
	assert.equal(listRequestPath({ q: " 결제 ", state: "open", cursor: "abc" }), "/api/issues?state=open&q=%EA%B2%B0%EC%A0%9C&cursor=abc&limit=50");
	assert.equal(listRequestPath({ state: "bogus" }), "/api/issues?limit=50");
});

test("listViewModel maps rows, counts, filters and the empty text for each query", () => {
	const response = {
		items: [
			{ id: ISSUE, title: "결제 화면", state: "needs-check", category: "inbox-ui", severity: "high", createdAt: T0, updatedAt: T1 },
			{ id: "not-a-uuid", title: "dropped", state: "open", category: "other", severity: "normal", createdAt: T0, updatedAt: T0 },
		],
		counts: { open: 2, investigating: 1, "needs-check": 1, resolved: 0 },
		nextCursor: "",
	};
	const view = listViewModel(response, { query: { q: "", state: "needs-check" }, nowMs: NOW_MS });
	assert.equal(view.rows.length, 1);
	assert.deepEqual(view.rows[0], {
		id: ISSUE, href: `/issues/${ISSUE}`, title: "결제 화면", state: "needs-check", stateLabel: "확인 요청",
		category: "inbox-ui", categoryLabel: "Inbox 화면", severity: "high", severityLabel: "높음",
		createdAt: T0, updatedAt: T1, updatedLabel: "50분 전",
	});
	assert.equal(view.total, 4);
	assert.equal(view.nextCursor, null);
	assert.equal(view.emptyText, null);
	assert.deepEqual(view.filters.map((entry) => [entry.label, entry.count, entry.selected]), [["전체", 4, false], ["접수", 2, false], ["조사 중", 1, false], ["확인 요청", 1, true], ["해결", 0, false]]);
	assert.equal(listViewModel({ items: [], counts: {}, nextCursor: null }, { query: { q: "zzz", state: null } }).emptyText, "검색 결과가 없습니다");
	assert.equal(listViewModel({ items: [], counts: {}, nextCursor: null }, { query: { q: "", state: "resolved" } }).emptyText, "해결 상태의 제보가 없습니다");
	assert.equal(listViewModel({ items: [], counts: {}, nextCursor: null }).emptyText, "제보가 없습니다");
});

test("issueBadgeFromCounts counts needs-check only", () => {
	assert.deepEqual(issueBadgeFromCounts({ open: 9, investigating: 4, "needs-check": 2, resolved: 7 }), { count: 2, hidden: false, text: "2", label: "확인 요청 2건" });
	assert.deepEqual(issueBadgeFromCounts({ open: 9 }), { count: 0, hidden: true, text: "", label: "" });
	assert.equal(issueBadgeFromCounts({ "needs-check": 120 }).text, "99+");
	assert.equal(issueBadgeFromCounts(null).hidden, true);
	assert.equal(issueBadgeFromCounts({ "needs-check": -1 }).hidden, true);
});

test("mergeDetailPages concatenates pages in sequence order without duplicates", () => {
	const first = { issue: { id: ISSUE }, state: "open", currentSeq: 3, events: [event(1, "created"), event(2, "comment")], evidence: [manifest(1, CAPTURE, { kind: "none", reason: "not_requested" })], nextAfter: 2 };
	const second = { issue: { id: ISSUE }, state: "open", currentSeq: 3, events: [event(2, "comment"), event(3, "comment")], evidence: [], nextAfter: null, capabilities: { build: { buildId: BUILD_A } } };
	const merged = mergeDetailPages([first, second]);
	assert.deepEqual(merged.events.map((entry) => entry.seq), [1, 2, 3]);
	assert.equal(merged.evidence.length, 1);
	assert.equal(merged.nextAfter, null);
	assert.equal(merged.capabilities.build.buildId, BUILD_A);
	assert.throws(() => mergeDetailPages([]), TypeError);
});

test("evidence labels never call a crop or a reproduction the original screenshot", () => {
	const ownerLabels = ["화면 캡처", "올린 사진"];
	for (const provenance of ["source_asset_crop", "reproduction"]) {
		const view = evidenceView(manifest(2, CAPTURE_2, raster(provenance)), ISSUE);
		assert.equal(view.reconstructed, true, provenance);
		assert.equal(view.note, "원본 화면 아님", provenance);
		assert.ok(!ownerLabels.includes(view.provenanceLabel), `${provenance} -> ${view.provenanceLabel}`);
		assert.ok(!view.provenanceLabel.includes("원본"), `${provenance} label must not read as the original`);
	}
	const capture = evidenceView(manifest(1, CAPTURE, raster("display_capture")), ISSUE);
	assert.equal(capture.provenanceLabel, "화면 캡처");
	assert.equal(capture.reconstructed, false);
	assert.equal(capture.note, null);
	assert.equal(capture.imageHref, `/api/issues/${ISSUE}/evidence/${CAPTURE}/image`);
	assert.equal(capture.masks, 1);
	assert.equal(capture.matchLabel, "출처 일치 미확인");
	const none = evidenceView(manifest(3, CAPTURE, { kind: "none", reason: "denied" }), ISSUE);
	assert.equal(none.kind, "none");
	assert.equal(none.provenanceLabel, "캡처 거부");
	assert.equal(none.imageHref, null);
});

test("a correction check is 확인됨 or 미확인 and never an install claim", () => {
	const build = { kind: "inbox-build", buildId: BUILD_B, summary: "수정" };
	const review = { kind: "review-artifact", proposalId: "decision-1", revision: 2, summary: "수정본" };
	assert.equal(checkView({ status: "matched", checkedAt: T1 }, build).label, "확인됨");
	for (const status of ["unversioned", "missing", "mismatch"]) {
		assert.equal(checkView({ status, checkedAt: T1 }, build).label, "미확인", status);
		assert.equal(checkView({ status, checkedAt: T1 }, review).label, "미확인", status);
	}
	assert.equal(checkView(null, build).label, "미확인");
	for (const correction of [build, review]) {
		for (const status of ["matched", "unversioned", "missing", "mismatch"]) {
			const text = `${checkView({ status, checkedAt: T1 }, correction).label} ${checkView({ status, checkedAt: T1 }, correction).detail}`;
			assert.ok(!/설치|배포/.test(text), `${correction.kind}/${status}: ${text}`);
		}
	}
});

test("detailViewModel keeps the provenance rows separate and truthful for an unknown build", () => {
	const view = detailViewModel(detailFixture(), { loadedBuild: BUILD_A, nowMs: NOW_MS });
	assert.deepEqual(view.rows.map((row) => row.key), ["observed", "observedBuild", "accepted", "acceptedBuild", "source", "correction", "appliedBuild", "confirmed", "pageBuild"]);
	const byKey = Object.fromEntries(view.rows.map((row) => [row.key, row]));
	assert.equal(byKey.observed.value, formatStamp(T0));
	assert.equal(byKey.observedBuild.value, BUILD_A.slice(0, 12));
	assert.equal(byKey.observedBuild.note, "페이지 응답 시점의 서버 매니페스트");
	assert.equal(byKey.acceptedBuild.value, BUILD_A.slice(0, 12));
	assert.equal(byKey.source.value, "Review decision-1 r1");
	assert.equal(byKey.source.href, "/p/decision-1");
	assert.equal(byKey.source.note, "기록 비교 일치");
	assert.equal(byKey.correction.value, `Inbox 빌드 ${BUILD_B.slice(0, 12)} · 제보 화면 수정`);
	assert.equal(byKey.appliedBuild.value, "미확인");
	assert.ok(!/설치|배포/.test(`${byKey.appliedBuild.value} ${byKey.appliedBuild.note}`));
	assert.equal(byKey.confirmed.value, "없음");
	assert.equal(byKey.pageBuild.note, "서버 빌드와 같음");
	assert.equal(view.build.differs, false);
	assert.equal(view.evidence[0].provenanceLabel, "화면 캡처");
	assert.equal(view.evidence[1].provenanceLabel, "재현 화면");
	assert.equal(view.evidence[1].note, "원본 화면 아님");
	assert.deepEqual(view.history.map((entry) => [entry.seq, entry.type, entry.readOnly]), [[1, "created", false], [2, "request_check", true]]);
	assert.equal(view.history[1].check.label, "미확인");
	assert.equal(view.history[1].text, "수정본을 올렸습니다");
	assert.deepEqual(view.actions, { comment: true, append: true, confirm: true, reopen: true, purge: true });
	assert.equal(view.purgeText, purgeConfirmText("제보 버튼이 보이지 않습니다"));
	assert.ok(view.purgeText.includes("제보 버튼이 보이지 않습니다"));
	assert.equal(view.description, "제보 버튼이 보이지 않습니다\n두 번째 줄");
});

test("detailViewModel reports a matched check, a confirmation, a reopen and a build difference", () => {
	const detail = detailFixture({
		state: "open",
		check: { status: "matched", checkedAt: T1 },
		extraEvents: [
			event(3, "comment", { command: { type: "comment", text: "아직 그대로입니다" }, state: "needs-check", acceptedAt: T2 }),
			event(4, "confirm", { command: { type: "confirm" }, state: "resolved", acceptedAt: T2 }),
			event(5, "reopen", { command: { type: "reopen", comment: null }, state: "open", acceptedAt: T3 }),
		],
		serverBuild: BUILD_B,
	});
	const view = detailViewModel(detail, { loadedBuild: BUILD_A, nowMs: NOW_MS });
	const byKey = Object.fromEntries(view.rows.map((row) => [row.key, row]));
	assert.equal(byKey.appliedBuild.value, "확인됨");
	assert.equal(byKey.appliedBuild.note, "접수 당시 서버 빌드와 일치");
	assert.equal(byKey.confirmed.value, formatStamp(T2));
	assert.equal(byKey.confirmed.note, "이후 다시 열림");
	assert.equal(byKey.pageBuild.note, `서버 빌드 ${BUILD_B.slice(0, 12)}와 다름`);
	assert.equal(view.build.differs, true);
	assert.deepEqual(view.history.map((entry) => entry.seq), [1, 2, 3, 4, 5]);
	assert.equal(view.history[2].text, "아직 그대로입니다");
	assert.equal(view.history[4].stateLabel, "접수");
	assert.deepEqual(view.actions, { comment: true, append: true, confirm: false, reopen: false, purge: true });
	assert.equal(view.currentSeq, 5);
});

test("ownerActions follows the lifecycle", () => {
	assert.deepEqual(ownerActions("open"), { comment: true, append: true, confirm: false, reopen: false, purge: true });
	assert.deepEqual(ownerActions("investigating"), { comment: true, append: true, confirm: false, reopen: false, purge: true });
	assert.deepEqual(ownerActions("needs-check"), { comment: true, append: true, confirm: true, reopen: true, purge: true });
	assert.deepEqual(ownerActions("resolved"), { comment: true, append: true, confirm: false, reopen: true, purge: true });
});

test("errorViewModel names the conflict state and never echoes submitted text", () => {
	const conflict = errorViewModel(409, { error: "version_conflict", currentSeq: 4, state: "needs-check" });
	assert.equal(conflict.code, "version_conflict");
	assert.equal(conflict.currentSeq, 4);
	assert.equal(conflict.text, "다른 변경이 먼저 반영되었습니다 (현재 순번 4, 확인 요청)");
	assert.equal(errorViewModel(409, { error: "invalid_transition", state: "open" }).text, "지금 상태(접수)에서는 할 수 없습니다");
	assert.equal(errorViewModel(410, { error: "gone" }).text, "삭제된 제보입니다");
	assert.equal(errorViewModel(400, { error: "bad_input", fields: ["command.text"] }).text, "입력이 올바르지 않습니다 (command.text)");
	assert.equal(errorViewModel(0, null).text, "연결하지 못했습니다");
	assert.equal(errorViewModel(500, { error: "corrupt_record" }).text, "기록이 손상되었습니다");
	assert.equal(errorViewModel(502, "<html>").text, "서버 오류 (502)");
});

test("mutationReceipt accepts only a verified receipt for the request that was sent", () => {
	const expected = { requestId: REQUEST, id: ISSUE, storeId: STORE };
	const body = { ok: true, id: ISSUE, storeId: STORE, receipt: { requestId: REQUEST, seq: 3, acceptedAt: T2 }, currentSeq: 3, state: "needs-check", evidenceManifest: null };
	assert.deepEqual(mutationReceipt(200, body, expected), { ok: true, id: ISSUE, receipt: { requestId: REQUEST, seq: 3, acceptedAt: T2 }, currentSeq: 3, state: "needs-check" });
	assert.equal(mutationReceipt(201, body, expected).ok, true);
	assert.equal(mutationReceipt(200, { ...body, currentSeq: 5 }, { requestId: REQUEST, id: ISSUE }).ok, true);
	// a 200 that carries only ok:true and an id is not an acceptance
	assert.deepEqual(mutationReceipt(200, { ok: true, id: ISSUE }, expected), { ok: false, code: "malformed", status: 200 });
	assert.deepEqual(mutationReceipt(200, {}, expected), { ok: false, code: "malformed", status: 200 });
	assert.equal(mutationReceipt(200, null, expected).code, "malformed");
	assert.equal(mutationReceipt(200, { ...body, id: CAPTURE }, expected).code, "malformed");
	assert.equal(mutationReceipt(200, { ...body, storeId: CAPTURE }, expected).code, "malformed");
	assert.equal(mutationReceipt(200, { ...body, receipt: { ...body.receipt, requestId: CAPTURE } }, expected).code, "malformed");
	assert.equal(mutationReceipt(200, { ...body, receipt: { ...body.receipt, seq: "3" } }, expected).code, "malformed");
	assert.equal(mutationReceipt(200, { ...body, receipt: { ...body.receipt, acceptedAt: "soon" } }, expected).code, "malformed");
	assert.equal(mutationReceipt(200, { ...body, currentSeq: "3" }, expected).code, "malformed");
	assert.equal(mutationReceipt(200, { ...body, state: "deployed" }, expected).code, "malformed");
	assert.deepEqual(mutationReceipt(409, { error: "version_conflict", currentSeq: 4 }, expected), { ok: false, code: "rejected", status: 409 });
	assert.deepEqual(mutationReceipt(0, null, expected), { ok: false, code: "network", status: 0 });
	assert.throws(() => mutationReceipt(200, body, { requestId: "nope", id: ISSUE }), TypeError);
});

test("mutationOutcome keeps conflict, rejection and uncertainty apart from acceptance", () => {
	const expected = { requestId: REQUEST, id: ISSUE, storeId: STORE };
	const accepted = mutationOutcome(200, { ok: true, id: ISSUE, storeId: STORE, receipt: { requestId: REQUEST, seq: 3, acceptedAt: T2 }, currentSeq: 3, state: "open" }, expected);
	assert.equal(accepted.kind, "accepted");
	assert.equal(accepted.receipt.seq, 3);
	const conflict = mutationOutcome(409, { error: "version_conflict", currentSeq: 4, state: "needs-check" }, expected);
	assert.equal(conflict.kind, "conflict");
	assert.equal(conflict.currentSeq, 4);
	assert.equal(conflict.state, "needs-check");
	assert.equal(conflict.text, "다른 변경이 먼저 반영되었습니다 (현재 순번 4, 확인 요청)");
	assert.equal(mutationOutcome(409, { error: "invalid_transition", state: "open" }, expected).kind, "rejected");
	assert.equal(mutationOutcome(410, { error: "gone" }, expected).kind, "rejected");
	const malformed = mutationOutcome(200, {}, expected);
	assert.equal(malformed.kind, "uncertain");
	assert.equal(malformed.reason, "malformed");
	assert.ok(malformed.text.includes("접수 확인 중"), malformed.text);
	const network = mutationOutcome(0, null, expected);
	assert.equal(network.kind, "uncertain");
	assert.equal(network.reason, "network");
	assert.ok(network.text.includes("접수 확인 중"), network.text);
	for (const outcome of [conflict, malformed, network]) {
		assert.equal(outcome.receipt, null);
		assert.ok(!outcome.text.includes("보냈습니다"), outcome.text);
	}
});

test("committedEvent resolves an uncertain send from the detail read by requestId", () => {
	const detail = detailFixture({ extraEvents: [event(3, "comment", { command: { type: "comment", text: "늦게 도착한 의견" }, state: "needs-check", acceptedAt: T2 })] });
	assert.deepEqual(committedEvent(detail, detail.events[2].requestId), { seq: 3, type: "comment", acceptedAt: T2, state: "needs-check" });
	assert.equal(committedEvent(detail, REQUEST.replace(/^5/, "9")), null);
	assert.equal(committedEvent(detail, "nope"), null);
	assert.equal(committedEvent(null, REQUEST), null);
});

test("owner commands and the append evidence set pass the server contract", () => {
	const uuids = [CAPTURE_2, REQUEST];
	const visual = { kind: "raster", provenance: "user_upload", acquiredAt: T0, sourceMatchesContext: "unverified", width: 1, height: 1, encoding: "rgba8-base64", pixels: PIXELS, masks: [], marks: [] };
	const evidence = appendEvidenceFor({
		issueId: ISSUE, currentSeq: 2, visual,
		view: { width: 1280, height: 800, dpr: 1, scrollX: 0, scrollY: 12, theme: "dark", locale: "ko-KR" },
		clientBuild: clientBuildFromStamp(BUILD_A),
		uuid: () => uuids.shift(),
		now: () => NOW_MS,
	});
	assert.equal(evidence.captureId, CAPTURE_2);
	assert.equal(evidence.page, "issues");
	assert.deepEqual(evidence.source, { kind: "issue", issueId: ISSUE, observedSeq: 2 });
	assert.equal(evidence.contextStatus, "captured");
	assert.equal(evidence.observedAt, new Date(NOW_MS).toISOString());
	const commands = [
		ownerCommand("comment", { text: "  아직 그대로입니다  " }),
		ownerCommand("confirm"),
		ownerCommand("reopen", { comment: "" }),
		ownerCommand("purge"),
		ownerCommand("append_evidence", { evidence, note: " " }),
	];
	assert.equal(commands[0].text, "아직 그대로입니다");
	assert.equal(commands[2].comment, null);
	assert.equal(commands[4].note, null);
	for (const command of commands) {
		const envelope = commandEnvelope({ storeId: STORE, requestId: REQUEST, expectedSeq: 2, command });
		const result = validateCommand(envelope);
		assert.equal(result.ok, true, `${command.type}: ${JSON.stringify(result.fields)}`);
	}
	assert.throws(() => commandEnvelope({ storeId: STORE, requestId: "nope", expectedSeq: 2, command: { type: "confirm" } }), TypeError);
	assert.throws(() => commandEnvelope({ storeId: STORE, requestId: REQUEST, expectedSeq: 0, command: { type: "confirm" } }), TypeError);
	assert.throws(() => ownerCommand("triage"), TypeError);
	assert.throws(() => appendEvidenceFor({ issueId: ISSUE, currentSeq: 1, visual: { kind: "none" }, uuid: () => REQUEST, now: () => NOW_MS }), TypeError);
	assert.equal(clientBuildFromStamp("null"), null);
});

test("textCheck measures UTF-8 bytes after trimming", () => {
	assert.deepEqual(textCheck("   ", 10), { ok: false, reason: "empty", bytes: 0 });
	assert.deepEqual(textCheck(" 가나 ", 6), { ok: true, reason: null, bytes: 6 });
	assert.deepEqual(textCheck("가나다", 6), { ok: false, reason: "too_long", bytes: 9 });
});

test("time labels use the injected clock", () => {
	assert.equal(formatAgo(T0, Date.parse(T0) + 30_000), "방금");
	assert.equal(formatAgo(T0, Date.parse(T0) + 5 * 60_000), "5분 전");
	assert.equal(formatAgo(T0, Date.parse(T0) + 3 * 3_600_000), "3시간 전");
	assert.equal(formatAgo(T0, Date.parse(T0) + 2 * 86_400_000), "2일 전");
	assert.equal(formatAgo("bad", NOW_MS), "");
	assert.match(formatStamp(T0), /^\d{1,2}월 \d{1,2}일 \d{2}:\d{2}$/);
	assert.equal(formatStamp("bad"), "");
});
