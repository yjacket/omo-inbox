import assert from "node:assert/strict";
import test from "node:test";
import { validateCreate } from "../src/issues-contract.mjs";
import { describeUnavailable, freezeCapture } from "../web/issue-context.js";
import {
	REDACTED_VIEW,
	baselineFromEvidence,
	buildEnvelope,
	classifyFailure,
	createReportState,
	deriveCapture,
	describeContext,
	describeReport,
	draftRecordFor,
	isLocked,
	ownsHistoryEntry,
	parseCreateResponse,
	parseDetailReceipt,
	pruneBaseline,
	reduceReport,
	validateDescription,
	withReporterToken,
} from "../web/issue-report.js";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const CAPTURE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_CAPTURE_ID = "77777777-7777-4777-8777-777777777777";
const THIRD_CAPTURE_ID = "88888888-8888-4888-8888-888888888888";
const DRAFT_ID = "99999999-9999-4999-8999-999999999999";
const TAB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW_MS = 1761177600000;
const ACCEPTED_AT = "2026-10-23T00:00:01.000Z";

function capture(overrides = {}) {
	return freezeCapture({
		page: "inbox",
		source: { kind: "thread", threadId: "qa-issue-a", itemId: null, observedSeq: 0 },
		target: null,
		view: { width: 390, height: 844, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "ko-KR", embedded: false, viewerOpen: false },
		excerpt: "표시된 항목 A",
		excerptEnabled: true,
		visibleIds: ["item-a1"],
		diagnostics: [{ type: "action", atMs: -10, name: "open_report" }],
		uuid: () => CAPTURE_ID,
		now: () => NOW_MS,
		...overrides,
	});
}

function envelope(requestId = REQUEST_ID, storeId = STORE_ID) {
	return buildEnvelope({ storeId, requestId, description: "  보내기 버튼이 눌리지 않습니다\n두 번째 줄  ", evidence: capture(), visual: null });
}

function editing() {
	return reduceReport(reduceReport(createReportState(), { type: "open", context: capture(), target: null, excerptEnabled: true }), { type: "edit", text: "보내기 버튼이 눌리지 않습니다", cursor: 5 });
}

function frozen() {
	return reduceReport(editing(), { type: "freeze", requestId: REQUEST_ID, envelope: envelope() });
}

function sending() {
	return reduceReport(reduceReport(frozen(), { type: "outbox", result: "written" }), { type: "send" });
}

function receipt(requestId = REQUEST_ID) {
	return { requestId, seq: 1, acceptedAt: ACCEPTED_AT };
}

function createBody(status, overrides = {}) {
	return { ok: true, id: REQUEST_ID, storeId: STORE_ID, receipt: receipt(), currentSeq: 1, state: "open", evidenceManifest: null, ...overrides };
}

test("validateDescription trims outer whitespace, keeps inner newlines and rejects empty or oversized text", () => {
	assert.deepEqual(validateDescription("  한 줄\n둘째 줄  "), { ok: true, text: "한 줄\n둘째 줄" });
	assert.deepEqual(validateDescription("   \n\t"), { ok: false, code: "empty" });
	assert.deepEqual(validateDescription(undefined), { ok: false, code: "empty" });
	assert.deepEqual(validateDescription("가".repeat(2731)), { ok: false, code: "too_long" });
	assert.equal(validateDescription("가".repeat(2730)).ok, true);
});

test("the composer envelope passes the server create validator", () => {
	const body = envelope();
	const checked = validateCreate(body);
	assert.equal(checked.ok, true, JSON.stringify(checked.fields));
	assert.equal(body.description, "보내기 버튼이 눌리지 않습니다\n두 번째 줄");
	assert.deepEqual(body.evidence.visual, { kind: "none", reason: "not_requested" });
	assert.equal(body.evidence.captureId, CAPTURE_ID);
	const withVisual = buildEnvelope({
		storeId: STORE_ID,
		requestId: REQUEST_ID,
		description: "사진 포함",
		evidence: capture(),
		visual: { kind: "raster", provenance: "user_upload", acquiredAt: null, sourceMatchesContext: "unverified", width: 1, height: 1, encoding: "rgba8-base64", pixels: "/wAA/w==", masks: [], marks: [] },
	});
	assert.equal(validateCreate(withVisual).ok, true);
	assert.throws(() => buildEnvelope({ storeId: STORE_ID, requestId: REQUEST_ID, description: "   ", evidence: capture(), visual: null }), TypeError);
});

test("table-driven transitions reach the documented status", () => {
	const cases = [
		{ name: "open", state: createReportState(), event: { type: "open", context: capture(), target: null }, status: "editing" },
		{ name: "edit", state: editing(), event: { type: "edit", text: "x", cursor: 1 }, status: "editing" },
		{ name: "freeze", state: editing(), event: { type: "freeze", requestId: REQUEST_ID, envelope: envelope() }, status: "frozen" },
		{ name: "outbox written keeps frozen", state: frozen(), event: { type: "outbox", result: "written" }, status: "frozen" },
		{ name: "send", state: reduceReport(frozen(), { type: "outbox", result: "written" }), event: { type: "send" }, status: "sending" },
		{ name: "accepted", state: sending(), event: { type: "accepted", id: REQUEST_ID, receipt: receipt(), replayed: false }, status: "sent" },
		{ name: "malformed", state: sending(), event: { type: "malformed", status: 200 }, status: "failed" },
		{ name: "rejected", state: sending(), event: { type: "rejected", status: 400, body: { error: "bad_input", fields: ["description"] } }, status: "failed" },
		{ name: "network", state: sending(), event: { type: "network", online: true }, status: "failed" },
		{ name: "discard", state: editing(), event: { type: "discard" }, status: "editing" },
		{ name: "reset", state: reduceReport(sending(), { type: "accepted", id: REQUEST_ID, receipt: receipt(), replayed: false }), event: { type: "reset" }, status: "editing" },
	];
	for (const item of cases) {
		const next = reduceReport(item.state, item.event);
		assert.equal(next.status, item.status, item.name);
		assert.notEqual(next, item.state, `${item.name} returns a new state`);
	}
});

test("an unsaved freeze cannot send until 저장 없이 보내기 is chosen", () => {
	const skipped = reduceReport(frozen(), { type: "outbox", result: "failed", reason: "quota" });
	assert.equal(skipped.storage, "failed");
	assert.equal(reduceReport(skipped, { type: "send" }).status, "frozen");
	assert.equal(describeReport(skipped).action, "send-without-save");
	const allowed = reduceReport(skipped, { type: "send-without-save" });
	assert.equal(reduceReport(allowed, { type: "send" }).status, "sending");
});

test("a lost response locks text, target and requestId until it is resolved", () => {
	const lost = reduceReport(sending(), { type: "network", online: true });
	assert.equal(isLocked(lost), true);
	assert.deepEqual(lost.failure, { kind: "retryable", code: "network", status: 0, fields: [], uncertain: true, queued: false });
	const edited = reduceReport(lost, { type: "edit", text: "다른 내용", cursor: 2 });
	assert.equal(edited.text, "보내기 버튼이 눌리지 않습니다");
	assert.equal(edited.requestId, REQUEST_ID);
	assert.equal(edited.status, "failed");
	assert.equal(reduceReport(lost, { type: "target", target: { kind: "page", key: "p", label: "화면", rect: { x: 0, y: 0, w: 1, h: 1 }, framePath: [] } }).target, null);
	assert.equal(reduceReport(lost, { type: "discard" }).status, "failed");
	const retried = reduceReport(lost, { type: "send", auto: true });
	assert.equal(retried.status, "sending");
	assert.equal(retried.requestId, REQUEST_ID);
	assert.equal(retried.envelope, lost.envelope);
	assert.equal(retried.attempts, 2);
	assert.equal(retried.autoRetried, true);
});

test("offline is queued, not uncertain, and still retries with the same request", () => {
	const offline = reduceReport(sending(), { type: "network", online: false });
	assert.equal(offline.failure.code, "offline");
	assert.equal(offline.failure.queued, true);
	assert.equal(offline.failure.uncertain, false);
	assert.equal(describeReport(offline).action, "retry");
	assert.equal(reduceReport(offline, { type: "send", auto: true }).requestId, REQUEST_ID);
});

test("accepted requires the receipt of this very request", () => {
	const foreign = reduceReport(sending(), { type: "accepted", id: OTHER_REQUEST_ID, receipt: receipt(OTHER_REQUEST_ID), replayed: false });
	assert.equal(foreign.status, "sending");
	const sent = reduceReport(sending(), { type: "accepted", id: REQUEST_ID, receipt: receipt(), replayed: true });
	assert.deepEqual(sent.receipt, receipt());
	assert.equal(sent.issueId, REQUEST_ID);
	assert.equal(sent.replayed, true);
	assert.equal(sent.outbox, "none");
	assert.equal(reduceReport(sent, { type: "edit", text: "x" }).text, sent.text);
	assert.equal(describeReport(sent).tone, "ok");
});

test("freeze pins requestId and envelope and rejects a mismatched pair", () => {
	const first = frozen();
	assert.equal(Object.isFrozen(first.envelope), true);
	assert.equal(reduceReport(first, { type: "freeze", requestId: OTHER_REQUEST_ID, envelope: envelope(OTHER_REQUEST_ID) }).requestId, REQUEST_ID);
	assert.throws(() => reduceReport(editing(), { type: "freeze", requestId: "not-a-uuid", envelope: envelope() }), TypeError);
	assert.throws(() => reduceReport(editing(), { type: "freeze", requestId: REQUEST_ID, envelope: envelope(OTHER_REQUEST_ID) }), TypeError);
});

test("409 key_reused keeps the text and needs a new requestId; store_changed also needs the new store", () => {
	const reused = reduceReport(sending(), { type: "rejected", status: 409, body: { error: "key_reused" } });
	assert.equal(reused.failure.kind, "conflict");
	assert.equal(reused.failure.needsNewRequest, true);
	assert.equal(reused.text, "보내기 버튼이 눌리지 않습니다");
	assert.equal(isLocked(reused), false);
	assert.equal(describeReport(reused).action, "renew");
	const renewed = reduceReport(reused, { type: "renew", requestId: OTHER_REQUEST_ID });
	assert.equal(renewed.status, "frozen");
	assert.equal(renewed.requestId, OTHER_REQUEST_ID);
	assert.equal(renewed.envelope.requestId, OTHER_REQUEST_ID);
	assert.equal(renewed.envelope.description, reused.envelope.description);
	assert.deepEqual(renewed.envelope.evidence, reused.envelope.evidence);
	assert.equal(renewed.outbox, "none");

	const moved = reduceReport(sending(), { type: "rejected", status: 409, body: { error: "store_changed" } });
	assert.equal(moved.failure.needsNewStore, true);
	assert.equal(describeReport(moved).action, "renew-store");
	assert.equal(reduceReport(moved, { type: "renew", requestId: OTHER_REQUEST_ID }).status, "failed");
	const under = reduceReport(moved, { type: "renew", requestId: OTHER_REQUEST_ID, storeId: "55555555-5555-4555-8555-555555555555" });
	assert.equal(under.envelope.storeId, "55555555-5555-4555-8555-555555555555");
	assert.equal(under.envelope.requestId, OTHER_REQUEST_ID);

	const edited = reduceReport(reused, { type: "edit", text: "고친 내용", cursor: 1 });
	assert.equal(edited.status, "editing");
	assert.equal(edited.requestId, null);
	assert.equal(edited.failure, null);
});

test("classifyFailure maps every status to its kind and next step", () => {
	assert.deepEqual(classifyFailure(400, { error: "bad_input", fields: ["description"] }), { kind: "rejected", code: "bad_input", status: 400, fields: ["description"] });
	assert.equal(classifyFailure(403, { error: "forbidden" }).code, "forbidden");
	assert.equal(classifyFailure(410, { error: "gone" }).code, "gone");
	assert.equal(classifyFailure(413, { error: "too_long" }).code, "too_long");
	assert.deepEqual(classifyFailure(409, { error: "version_conflict", currentSeq: 4, state: "investigating" }), { kind: "conflict", code: "version_conflict", status: 409, fields: [], needsNewRequest: false, needsNewStore: false, currentSeq: 4, state: "investigating" });
	assert.deepEqual(classifyFailure(503, "upstream"), { kind: "retryable", code: "server", status: 503, fields: [], uncertain: true, queued: false });
	for (const failure of [classifyFailure(400, null), classifyFailure(409, {}), classifyFailure(500, {})]) {
		assert.equal(["retryable", "conflict", "rejected"].includes(failure.kind), true);
	}
});

test("parseCreateResponse accepts only a receipt that names this request and store", () => {
	const expected = { requestId: REQUEST_ID, storeId: STORE_ID };
	assert.deepEqual(parseCreateResponse(201, createBody(201), expected), { ok: true, id: REQUEST_ID, receipt: receipt(), replayed: false, state: "open", currentSeq: 1 });
	assert.equal(parseCreateResponse(200, createBody(200), expected).replayed, true);
	const malformed = [
		[201, {}],
		[201, { ok: true }],
		[201, createBody(201, { id: OTHER_REQUEST_ID })],
		[201, createBody(201, { receipt: receipt(OTHER_REQUEST_ID) })],
		[201, createBody(201, { storeId: "66666666-6666-4666-8666-666666666666" })],
		[201, createBody(201, { receipt: { requestId: REQUEST_ID, seq: 0, acceptedAt: ACCEPTED_AT } })],
		[201, createBody(201, { receipt: { requestId: REQUEST_ID, seq: 1, acceptedAt: "yesterday" } })],
		[204, createBody(201)],
		[201, undefined],
		[201, "ok"],
	];
	for (const [status, body] of malformed) assert.deepEqual(parseCreateResponse(status, body, expected), { ok: false, code: "malformed" }, JSON.stringify(body));
	const malformedState = reduceReport(sending(), { type: "malformed", status: 200 });
	assert.equal(malformedState.failure.uncertain, true);
	assert.equal(isLocked(malformedState), true);
	assert.equal(describeReport(malformedState).action, "retry");
});

test("parseDetailReceipt reads the create event of the deterministic issue id", () => {
	const expected = { requestId: REQUEST_ID, storeId: STORE_ID };
	const detail = {
		issue: { id: REQUEST_ID, storeId: STORE_ID, title: "제목", description: "설명", createdAt: ACCEPTED_AT, source: null },
		state: "open",
		currentSeq: 2,
		events: [
			{ seq: 1, type: "created", requestId: REQUEST_ID, acceptedAt: ACCEPTED_AT },
			{ seq: 2, type: "comment", requestId: OTHER_REQUEST_ID, acceptedAt: "2026-10-23T00:00:02.000Z" },
		],
	};
	assert.deepEqual(parseDetailReceipt(detail, expected), { ok: true, id: REQUEST_ID, receipt: receipt(), replayed: true, state: "open", currentSeq: 2 });
	assert.equal(parseDetailReceipt({ ...detail, issue: { ...detail.issue, id: OTHER_REQUEST_ID } }, expected).ok, false);
	assert.equal(parseDetailReceipt({ ...detail, events: [] }, expected).ok, false);
	assert.equal(parseDetailReceipt(null, expected).ok, false);
});

test("context edits start a new generation and clear any earlier freeze; invalid text never freezes", () => {
	const state = editing();
	const retargeted = reduceReport(state, { type: "target", target: { kind: "record", key: "item:a1", label: "항목 A", rect: { x: 1.5, y: 2, w: 3, h: 4 }, framePath: [] } });
	assert.equal(retargeted.generation, state.generation + 1);
	assert.equal(retargeted.target.key, "item:a1");
	const trimmed = reduceReport(retargeted, { type: "context", context: capture({ excerptEnabled: false }), removed: ["excerpt", "bogus"] });
	assert.deepEqual(trimmed.removed, ["excerpt"]);
	assert.equal(trimmed.context.excerpt, null);
	const invalid = reduceReport(reduceReport(state, { type: "edit", text: "   ", cursor: 0 }), { type: "invalid", code: "empty" });
	assert.equal(invalid.status, "editing");
	assert.deepEqual(invalid.failure, { kind: "rejected", code: "empty", status: 0, fields: ["description"] });
	assert.equal(describeReport(invalid).tone, "error");
	assert.equal(reduceReport(invalid, { type: "edit", text: "내용", cursor: 2 }).failure, null);
	const discarded = reduceReport(state, { type: "discard" });
	assert.equal(discarded.text, "");
	assert.equal(discarded.context, state.context);
	assert.equal(discarded.generation, state.generation + 1);
});

test("a restored draft keeps its own observation as the editing baseline; the live page never re-freezes it", () => {
	const a = capture();
	const b = capture({ source: { kind: "thread", threadId: "qa-issue-b", itemId: null, observedSeq: 3 }, excerpt: "표시된 항목 B", visibleIds: ["item-b1"], uuid: () => OTHER_CAPTURE_ID, now: () => NOW_MS + 60_000 });
	// The reporter opened on a page that now shows B, then found the draft saved while A was shown.
	const opened = reduceReport(createReportState(), { type: "open", context: b, target: null, excerptEnabled: true });
	const restored = reduceReport(opened, { type: "restore", text: "복원된 설명", cursor: 3, context: a, target: null, removed: [], excerptEnabled: true });
	assert.equal(restored.context, a);
	assert.equal(restored.text, "복원된 설명");
	assert.equal(restored.cursor, 3);
	assert.equal(restored.storage, "saved");
	assert.equal(restored.generation, opened.generation + 1);
	// Removing the visible IDs of the restored draft re-freezes A's observation, not the page.
	const trimmed = deriveCapture(baselineFromEvidence(restored.context), { target: null, removed: ["visibleIds"], excerptEnabled: true, uuid: () => THIRD_CAPTURE_ID, now: () => NOW_MS + 120_000 });
	assert.deepEqual(trimmed.source, a.source);
	assert.equal(trimmed.excerpt, a.excerpt);
	assert.equal(trimmed.observedAt, a.observedAt);
	assert.deepEqual(trimmed.visibleIds, []);
	assert.deepEqual(trimmed.diagnostics, a.diagnostics);
	assert.notEqual(trimmed.source.threadId, b.source.threadId);
	// Text typed in this session is never overwritten by a stored draft.
	const typed = editing();
	const kept = reduceReport(typed, { type: "restore", text: "다른 초안", context: a });
	assert.equal(kept.text, typed.text);
	assert.equal(kept.context, typed.context);
	// Without an adapter the context stays unavailable and has no baseline to edit.
	const unavailable = deriveCapture(null, { target: null, removed: [], excerptEnabled: false, uuid: () => THIRD_CAPTURE_ID, now: () => NOW_MS });
	assert.equal(unavailable.contextStatus, "unavailable");
	assert.equal(baselineFromEvidence(unavailable), null);
});

test("a stored draft holds only the approved context: a removed id and a deselected excerpt leave every field, the identity stays", () => {
	const digest = "ef".repeat(32);
	// The adapter observation the reporter froze at open(): two visible rows and the first one's text.
	const observation = {
		page: "inbox",
		source: { kind: "thread", threadId: "qa-issue-a", itemId: null, observedSeq: 0 },
		target: null,
		view: { width: 390, height: 844, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "ko-KR", embedded: false, viewerOpen: false },
		excerpt: "결제 화면 문제 제보",
		excerptEnabled: true,
		visibleIds: ["qa-issue-a", "qa-issue-b"],
		diagnostics: [{ type: "action", atMs: -10, name: "open_report" }],
		clientBuild: { kind: "page_response_manifest", version: null, digest },
	};
	const frozen = deriveCapture(observation, { target: null, removed: [], excerptEnabled: true, uuid: () => CAPTURE_ID, now: () => NOW_MS });
	// The reporter fixes the observation time at the first freeze; every later derivation keeps it.
	observation.observedAt = frozen.observedAt;
	let state = reduceReport(createReportState(), { type: "open", context: frozen, target: null, excerptEnabled: true });
	state = reduceReport(state, { type: "edit", text: "저장되는 초안", cursor: 3 });
	// 지우기 on the visible ids, then 선택한 내용 포함 off: the baseline forgets the ids at once and the
	// excerpt text stays only for the visible toggle of this session.
	const removed = ["visibleIds"];
	const baseline = pruneBaseline(observation, removed);
	assert.deepEqual(baseline.visibleIds, []);
	assert.equal(baseline.excerpt, observation.excerpt);
	assert.equal(pruneBaseline(observation, ["excerpt"]).excerpt, null);
	assert.equal(pruneBaseline(null, removed), null);
	state = reduceReport(state, { type: "context", context: deriveCapture(baseline, { target: null, removed, excerptEnabled: false, uuid: () => OTHER_CAPTURE_ID, now: () => NOW_MS + 1000 }), removed, excerptEnabled: false });
	// What IndexedDB keeps is the record's plain data.
	const stored = JSON.parse(JSON.stringify(draftRecordFor(state, { draftId: DRAFT_ID, tabId: TAB_ID, revision: 2 })));
	const storedBytes = JSON.stringify(stored);
	assert.equal(storedBytes.includes("qa-issue-b"), false, storedBytes);
	assert.equal(storedBytes.includes(observation.excerpt), false, storedBytes);
	assert.equal(storedBytes.split("qa-issue-a").length - 1, 1, "the source id appears once, as the source");
	assert.deepEqual(stored.evidence.visibleIds, []);
	assert.equal(stored.evidence.excerpt, null);
	assert.equal(stored.excerptEnabled, false);
	assert.deepEqual(stored.removed, ["visibleIds"]);
	assert.deepEqual(stored.evidence.source, observation.source);
	assert.equal(stored.evidence.observedAt, frozen.observedAt);
	assert.equal(stored.evidence.clientBuild.digest, digest);
	assert.deepEqual(stored.evidence.view, observation.view);
	assert.equal(stored.text, "저장되는 초안");
	assert.deepEqual({ draftId: stored.draftId, tabId: stored.tabId, revision: stored.revision }, { draftId: DRAFT_ID, tabId: TAB_ID, revision: 2 });
	// Restored on a page that now shows B: the approved capture is the baseline, so an unrelated edit
	// (removing the view) still posts no removed id, no excerpt, and A's source and observation time.
	const b = capture({ source: { kind: "thread", threadId: "qa-issue-b", itemId: null, observedSeq: 3 }, excerpt: "제보함 목록 점검", visibleIds: ["qa-issue-b"], uuid: () => THIRD_CAPTURE_ID, now: () => NOW_MS + 60_000 });
	let restored = reduceReport(reduceReport(createReportState(), { type: "open", context: b, target: null, excerptEnabled: true }), { type: "restore", text: stored.text, cursor: stored.cursor, context: stored.evidence, target: stored.target, removed: stored.removed, excerptEnabled: stored.excerptEnabled });
	const restoredBaseline = baselineFromEvidence(stored.evidence);
	assert.equal(restoredBaseline.excerpt, null, "nothing is left to re-enable");
	assert.deepEqual(restoredBaseline.visibleIds, []);
	const removedAgain = [...stored.removed, "view"];
	restored = reduceReport(restored, { type: "context", context: deriveCapture(pruneBaseline(restoredBaseline, removedAgain), { target: null, removed: removedAgain, excerptEnabled: false, uuid: () => THIRD_CAPTURE_ID, now: () => NOW_MS + 120_000 }), removed: removedAgain });
	const posted = buildEnvelope({ storeId: STORE_ID, requestId: REQUEST_ID, description: restored.text, evidence: restored.context, visual: null });
	const postedBytes = JSON.stringify(posted);
	assert.equal(postedBytes.includes("qa-issue-b"), false, postedBytes);
	assert.equal(postedBytes.includes(observation.excerpt), false, postedBytes);
	assert.deepEqual(posted.evidence.visibleIds, []);
	assert.equal(posted.evidence.excerpt, null);
	assert.deepEqual(posted.evidence.source, observation.source);
	assert.equal(posted.evidence.observedAt, frozen.observedAt);
	assert.equal(posted.evidence.clientBuild.digest, digest);
	assert.deepEqual(posted.evidence.view, REDACTED_VIEW);
	assert.equal(validateCreate(posted).ok, true);
});

test("removing the view or build posts the unavailable view / null and still passes the server validator", () => {
	const digest = "ab".repeat(32);
	const baseline = baselineFromEvidence(capture({ clientBuild: { kind: "page_response_manifest", version: null, digest } }));
	assert.equal(baseline.clientBuild.digest, digest);
	const redacted = deriveCapture(baseline, { target: null, removed: ["view", "clientBuild"], excerptEnabled: true, uuid: () => THIRD_CAPTURE_ID, now: () => NOW_MS });
	assert.deepEqual(redacted.view, REDACTED_VIEW);
	assert.equal(redacted.clientBuild, null);
	assert.equal(redacted.excerpt, "표시된 항목 A");
	assert.equal(validateCreate(buildEnvelope({ storeId: STORE_ID, requestId: REQUEST_ID, description: "화면 정보 없이", evidence: redacted, visual: null })).ok, true);
});

test("the context review lists the retained values, one removable row per item, never counts", () => {
	const digest = "cd".repeat(32);
	const context = capture({ target: { kind: "record", key: "thread:qa-issue-a", label: "항목 A", rect: { x: 1.5, y: 2, w: 3, h: 4 }, framePath: [] }, clientBuild: { kind: "page_response_manifest", version: null, digest } });
	const items = describeContext(context, []);
	assert.deepEqual(items.map((item) => item.key), ["source", "target", "excerpt", "visibleIds", "diagnostics", "view", "clientBuild"]);
	const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
	assert.equal(byKey.source.value, "대화 qa-issue-a");
	assert.equal(byKey.target.value.endsWith("항목 A"), true);
	assert.equal(byKey.target.detail.startsWith("thread:qa-issue-a"), true);
	assert.equal(byKey.excerpt.value, "표시된 항목 A");
	assert.equal(byKey.visibleIds.value, "item-a1");
	assert.equal(byKey.diagnostics.value.includes("open_report"), true);
	assert.equal(byKey.view.value.includes("390×844") && byKey.view.value.includes("ko-KR"), true);
	assert.equal(byKey.clientBuild.value, digest);
	assert.equal(describeContext(context, ["view"]).some((item) => item.key === "view"), false);
	assert.deepEqual(describeContext(null), []);
	assert.deepEqual(describeContext(describeUnavailable("no_adapter", { uuid: () => CAPTURE_ID, now: () => NOW_MS })), []);
});

test("a definitive rejection retires the request from the outbox; the resend is a new request that supersedes it", () => {
	const rejected = reduceReport(sending(), { type: "rejected", status: 403, body: { error: "forbidden" } });
	assert.equal(rejected.outbox, "rejected");
	assert.deepEqual(rejected.retired, [{ requestId: REQUEST_ID, outcome: "rejected", code: "forbidden", status: 403, supersededBy: null }]);
	assert.equal(isLocked(rejected), false);
	const edited = reduceReport(rejected, { type: "edit", text: "고친 내용", cursor: 1 });
	assert.equal(edited.requestId, null);
	assert.equal(edited.outbox, "none");
	assert.equal(edited.retired[0].outcome, "rejected");
	const replaced = reduceReport(edited, { type: "freeze", requestId: OTHER_REQUEST_ID, envelope: envelope(OTHER_REQUEST_ID) });
	assert.equal(replaced.requestId, OTHER_REQUEST_ID);
	assert.deepEqual(replaced.retired, [{ requestId: REQUEST_ID, outcome: "superseded", code: "forbidden", status: 403, supersededBy: OTHER_REQUEST_ID }]);
	// An uncertain outcome keeps its entry: the request may already be on the server.
	const lost = reduceReport(sending(), { type: "network", online: true });
	assert.equal(lost.outbox, "written");
	assert.deepEqual(lost.retired, []);
	assert.equal(reduceReport(sending(), { type: "rejected", status: 503, body: {} }).outbox, "written");
	// key_reused is definitive as well; renewing supersedes it with the fresh requestId.
	const reused = reduceReport(sending(), { type: "rejected", status: 409, body: { error: "key_reused" } });
	assert.equal(reused.outbox, "rejected");
	const renewed = reduceReport(reused, { type: "renew", requestId: OTHER_REQUEST_ID });
	assert.deepEqual(renewed.retired, [{ requestId: REQUEST_ID, outcome: "superseded", code: "key_reused", status: 409, supersededBy: OTHER_REQUEST_ID }]);
	assert.equal(renewed.outbox, "none");
});

test("the reporter's history entry merges its token into the page state and Back restores that state untouched", () => {
	const pageState = Object.freeze({ viewer: "preserve-viewer", custom: 42 });
	const entries = [pageState];
	const history = {
		get state() {
			return entries[entries.length - 1];
		},
		pushState(value) {
			entries.push(value);
		},
		back() {
			entries.pop();
		},
	};
	history.pushState(withReporterToken(history.state, "mount:1"), "", "/s/a");
	assert.deepEqual(history.state, { viewer: "preserve-viewer", custom: 42, issueReport: "mount:1" });
	assert.equal(ownsHistoryEntry(history.state, "mount:1"), true);
	assert.equal(ownsHistoryEntry(history.state, "mount:2"), false);
	history.back();
	assert.equal(history.state, pageState);
	assert.equal(ownsHistoryEntry(history.state, "mount:1"), false);
	assert.deepEqual(withReporterToken(null, "mount:2"), { issueReport: "mount:2" });
	assert.deepEqual(withReporterToken("not-an-object", "mount:3"), { issueReport: "mount:3" });
});

test("storage status is text-reported and never implies a save before the transaction completes", () => {
	const fresh = editing();
	assert.equal(describeReport(fresh).text, "");
	assert.equal(describeReport(reduceReport(fresh, { type: "storage", status: "saving" })).tone, "muted");
	const saved = reduceReport(fresh, { type: "storage", status: "saved" });
	assert.equal(saved.storage, "saved");
	const failed = reduceReport(fresh, { type: "storage", status: "failed", reason: "quota" });
	assert.equal(failed.storageReason, "quota");
	assert.equal(describeReport(failed).tone, "error");
	assert.equal(describeReport(reduceReport(fresh, { type: "storage", status: "conflict" })).action, "fork");
	assert.equal(reduceReport(fresh, { type: "storage", status: "bogus" }).storage, "unknown");
});
