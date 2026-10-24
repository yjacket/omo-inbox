/* Contextual issue composer: native <dialog>, optional target picker, context/image preview with
 * per-item removal, draft and outbox bookkeeping, and the receipt-safe send flow.
 *
 * The top half is a pure state machine (createReportState / reduceReport plus the envelope and
 * response parsers). It touches no DOM, storage or network, so test/issues-report-state.test.mjs
 * runs it under Node. mountIssueReport() below is the DOM owner and receives everything it needs
 * injected: document/window, the adapter registry (web/issue-adapters.js), the drafts storage API
 * (web/issue-drafts.js), diagnostics (web/issue-diagnostics.js), an optional image editor
 * (web/issue-image.js), fetchImpl, now(), uuid() and the page build stamp.
 *
 * Exactly-once rule: the requestId and envelope are frozen into the outbox BEFORE the network
 * call. A lost or malformed response is "접수 확인 중", never success or failure; it is resolved by
 * GET of the deterministic issue id (create id == requestId) and only then by an exact replay
 * with the SAME requestId, which the server answers with the original receipt (200) or a 201.
 * The composer never touches the host page's own inputs, never clears storage and adds exactly
 * one history token (merged into the page's own history state) while it is open.
 *
 * Baseline rule: every re-freeze (target pick, per-item removal, excerpt toggle) derives from the
 * observation the draft is about - the adapter capture taken when the reporter opened, or the
 * approved capture a restored draft stored - never from whatever the page shows now. Only an
 * explicit recapture (first open, 초안 버리기, 새 제보) replaces the whole frozen context at once.
 *
 * Approved-context rule: the baseline keeps only what the user has not removed (plus the excerpt
 * the visible 선택한 내용 포함 toggle offers while that toggle is shown), and the stored draft holds
 * the frozen capture itself - text, identity (source, observedAt, build) and approved context -
 * never a copy of the observation behind it. Nothing removed or deselected can come back from
 * storage; re-adding is an explicit recapture or an explicit target pick.
 *
 * Outbox rule: an envelope the server definitively rejected leaves the persistent outbox at once
 * and is recorded as retired; a resend after editing is a NEW request that supersedes it, so a
 * later load replays only entries that are queued or whose send outcome is unknown.
 */
import { createGenerationOwner, describeUnavailable, freezeCapture } from "./issue-context.js";

export const REPORT_STATUSES = Object.freeze(["idle", "editing", "frozen", "sending", "sent", "failed"]);
export const FAILURE_KINDS = Object.freeze(["retryable", "conflict", "rejected"]);

// Copied from src/issues-contract.mjs LIMITS (a browser module imports no server code).
export const REPORT_LIMITS = Object.freeze({ descriptionBytes: 8192 });

export const TEXT = Object.freeze({
	title: "문제 제보",
	send: "보내기",
	retry: "다시 보내기",
	sendWithoutSave: "저장 없이 보내기",
	copy: "설명 복사",
	newRequest: "새 요청으로 보내기",
	newStore: "새 제보로 보내기",
	discard: "초안 버리기",
	discardConfirm: "이 초안을 버릴까요?",
	discardYes: "버리기",
	cancel: "취소",
	close: "닫기",
	pick: "위치 선택",
	change: "바꾸기",
	remove: "지우기",
	pageTarget: "현재 화면",
	attachments: "첨부 확인",
	addPhoto: "사진 추가",
	capture: "화면 캡처",
	includeExcerpt: "선택한 내용 포함",
	attachNone: "첨부 없음",
	noContext: "화면 정보 없음",
	truncated: "잘림",
	items: Object.freeze({ source: "출처", target: "위치", excerpt: "선택한 내용", visibleIds: "표시된 항목", diagnostics: "동작 기록", view: "화면", clientBuild: "빌드" }),
	issueLink: "제보 보기",
	newReport: "새 제보",
	status: Object.freeze({
		empty: "설명을 입력해 주세요",
		tooLong: "설명은 8192바이트까지",
		saved: "초안 저장됨",
		saving: "저장 중",
		saveFailed: "이 기기에 초안을 저장하지 못했습니다 · 새로 고치면 복구되지 않습니다",
		draftConflict: "다른 탭에서 바꾼 초안이 있습니다",
		sending: "보내는 중",
		pending: "접수 확인 중",
		offline: "오프라인 · 연결되면 다시 보냅니다",
		accepted: "접수했습니다",
		keyReused: "같은 요청 번호가 다른 내용으로 쓰였습니다",
		storeChanged: "서버 저장소가 바뀌었습니다",
		conflict: "서버 상태가 달라졌습니다",
		badInput: "서버가 내용을 받지 않았습니다",
		forbidden: "이 기기에서는 보낼 수 없습니다",
		tooLongBody: "첨부가 너무 큽니다",
		gone: "삭제된 제보입니다",
		server: "서버 오류 · 접수 확인 중",
		network: "연결이 끊겼습니다 · 접수 확인 중",
		noCapabilities: "서버에 연결하지 못했습니다",
	}),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTEXT_ITEMS = Object.freeze(["source", "target", "excerpt", "visibleIds", "diagnostics", "view", "clientBuild"]);
const KIND_LABEL = Object.freeze({ page: "화면", record: "항목", control: "버튼", frame: "창" });
const SOURCE_LABEL = Object.freeze({ thread: "대화", proposal: "Review", issue: "제보" });
/** The envelope requires a view; a removed one is sent as the "no view information" shape describeUnavailable() uses. */
export const REDACTED_VIEW = Object.freeze({ width: 1, height: 1, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "unknown", locale: "unknown", embedded: false, viewerOpen: false });

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function utf8Length(value) {
	let bytes = 0;
	for (const char of value) {
		const code = char.codePointAt(0);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (code <= 0xffff) bytes += 3;
		else bytes += 4;
	}
	return bytes;
}

/** Trim outer whitespace only; reject empty or oversized text instead of truncating it. */
export function validateDescription(text, limits = REPORT_LIMITS) {
	const value = typeof text === "string" ? text.trim() : "";
	if (value === "") return { ok: false, code: "empty" };
	if (utf8Length(value) > limits.descriptionBytes) return { ok: false, code: "too_long" };
	return { ok: true, text: value };
}

/** Fresh composer state. `context` is a frozen capture (or null); `text` seeds a restored draft. */
export function createReportState(initial = {}) {
	const source = isPlainObject(initial) ? initial : {};
	return {
		status: "idle",
		text: typeof source.text === "string" ? source.text : "",
		cursor: Number.isInteger(source.cursor) && source.cursor >= 0 ? source.cursor : 0,
		generation: 0,
		context: source.context === undefined ? null : source.context,
		target: source.target === undefined ? null : source.target,
		removed: Array.isArray(source.removed) ? source.removed.filter((item) => CONTEXT_ITEMS.includes(item)) : [],
		excerptEnabled: source.excerptEnabled === true,
		storage: "unknown",
		storageReason: null,
		sendWithoutSave: false,
		outbox: "none",
		requestId: null,
		envelope: null,
		attempts: 0,
		autoRetried: false,
		receipt: null,
		issueId: null,
		replayed: false,
		failure: null,
		// Requests this draft gave up on: definitively rejected, then superseded by the next request.
		retired: [],
	};
}

/** True while a request may already have reached the server: text and target are locked. */
export function isLocked(state) {
	if (state.status === "frozen" || state.status === "sending") return true;
	if (state.status === "failed") return state.failure !== null && state.failure.kind === "retryable";
	return false;
}

/** Map an HTTP failure to its kind and the explicit next step it requires. */
export function classifyFailure(status, body) {
	const code = isPlainObject(body) && typeof body.error === "string" ? body.error : null;
	const fields = isPlainObject(body) && Array.isArray(body.fields) ? body.fields.filter((field) => typeof field === "string") : [];
	if (status === 409) {
		if (code === "key_reused") return { kind: "conflict", code, status, fields, needsNewRequest: true, needsNewStore: false, currentSeq: null, state: null };
		if (code === "store_changed") return { kind: "conflict", code, status, fields, needsNewRequest: true, needsNewStore: true, currentSeq: null, state: null };
		return {
			kind: "conflict",
			code: code ?? "other",
			status,
			fields,
			needsNewRequest: false,
			needsNewStore: false,
			currentSeq: isPlainObject(body) && Number.isSafeInteger(body.currentSeq) ? body.currentSeq : null,
			state: isPlainObject(body) && typeof body.state === "string" ? body.state : null,
		};
	}
	if (status === 400) return { kind: "rejected", code: code ?? "bad_input", status, fields };
	if (status === 403) return { kind: "rejected", code: "forbidden", status, fields };
	if (status === 404) return { kind: "rejected", code: "not_found", status, fields };
	if (status === 410) return { kind: "rejected", code: "gone", status, fields };
	if (status === 413) return { kind: "rejected", code: "too_long", status, fields };
	if (status >= 500) return { kind: "retryable", code: "server", status, fields, uncertain: true, queued: false };
	return { kind: "retryable", code: "other", status, fields, uncertain: true, queued: false };
}

/**
 * Accept a 2xx create body only when it names this very request. Anything else is uncertain:
 * the server may have committed, so the caller resolves by GET, never by a fresh request.
 */
export function parseCreateResponse(status, body, expected) {
	if (status !== 200 && status !== 201) return { ok: false, code: "malformed" };
	if (!isPlainObject(body) || body.ok !== true) return { ok: false, code: "malformed" };
	const receipt = body.receipt;
	if (!isPlainObject(receipt)) return { ok: false, code: "malformed" };
	if (body.id !== expected.requestId || receipt.requestId !== expected.requestId) return { ok: false, code: "malformed" };
	if (body.storeId !== expected.storeId) return { ok: false, code: "malformed" };
	if (!Number.isSafeInteger(receipt.seq) || receipt.seq < 1) return { ok: false, code: "malformed" };
	if (typeof receipt.acceptedAt !== "string" || !ISO_RE.test(receipt.acceptedAt)) return { ok: false, code: "malformed" };
	return {
		ok: true,
		id: body.id,
		receipt: { requestId: receipt.requestId, seq: receipt.seq, acceptedAt: receipt.acceptedAt },
		replayed: status === 200,
		state: typeof body.state === "string" ? body.state : null,
		currentSeq: Number.isSafeInteger(body.currentSeq) ? body.currentSeq : null,
	};
}

/** Receipt of the create event from a GET /api/issues/<id> body; create id equals requestId. */
export function parseDetailReceipt(body, expected) {
	if (!isPlainObject(body) || !isPlainObject(body.issue)) return { ok: false, code: "malformed" };
	if (body.issue.id !== expected.requestId || body.issue.storeId !== expected.storeId) return { ok: false, code: "malformed" };
	const events = Array.isArray(body.events) ? body.events : [];
	const created = events.find((event) => isPlainObject(event) && event.seq === 1 && event.requestId === expected.requestId);
	if (!created || typeof created.acceptedAt !== "string" || !ISO_RE.test(created.acceptedAt)) return { ok: false, code: "malformed" };
	return {
		ok: true,
		id: body.issue.id,
		receipt: { requestId: expected.requestId, seq: 1, acceptedAt: created.acceptedAt },
		replayed: true,
		state: typeof body.state === "string" ? body.state : null,
		currentSeq: Number.isSafeInteger(body.currentSeq) ? body.currentSeq : null,
	};
}

/** The v1 create envelope. `evidence` is a frozen capture; `visual` replaces its placeholder. */
export function buildEnvelope({ storeId, requestId, description, evidence, visual }) {
	const checked = validateDescription(description);
	if (!checked.ok) throw new TypeError(`description is ${checked.code}`);
	if (!isPlainObject(evidence)) throw new TypeError("buildEnvelope needs a frozen capture");
	const copy = JSON.parse(JSON.stringify(evidence));
	copy.visual = visual === undefined || visual === null ? { kind: "none", reason: "not_requested" } : JSON.parse(JSON.stringify(visual));
	return { v: 1, storeId, requestId, description: checked.text, evidence: copy };
}

function sourceLabel(source) {
	if (!source) return null;
	if (source.kind === "thread") return `${SOURCE_LABEL.thread} ${source.threadId}${source.itemId ? ` · ${source.itemId}` : ""}`;
	if (source.kind === "proposal") return `${SOURCE_LABEL.proposal} ${source.proposalId} r${source.revision}`;
	if (source.kind === "issue") return `${SOURCE_LABEL.issue} ${source.issueId}`;
	return null;
}

/**
 * The adapter capture a frozen context was derived from. A restored draft that stored no baseline
 * edits its frozen evidence itself; an unavailable context has nothing to derive from.
 */
export function baselineFromEvidence(evidence) {
	if (!isPlainObject(evidence) || evidence.contextStatus === "unavailable") return null;
	return {
		page: evidence.page,
		observedAt: evidence.observedAt,
		source: evidence.source ?? null,
		target: evidence.target ?? null,
		clientBuild: evidence.clientBuild ?? null,
		view: isPlainObject(evidence.view) ? { ...evidence.view } : null,
		excerpt: typeof evidence.excerpt === "string" ? evidence.excerpt : null,
		excerptEnabled: typeof evidence.excerpt === "string",
		visibleIds: Array.isArray(evidence.visibleIds) ? [...evidence.visibleIds] : [],
		diagnostics: Array.isArray(evidence.diagnostics) ? JSON.parse(JSON.stringify(evidence.diagnostics)) : [],
	};
}

/**
 * The observation with the user's removals applied: the baseline keeps only approved items, so a
 * removed one has no copy to come back from. The excerpt text stays until its row is removed,
 * because the visible 선택한 내용 포함 toggle offers it; a null baseline has nothing to prune.
 */
export function pruneBaseline(baseline, removed = []) {
	if (!isPlainObject(baseline)) return null;
	const drop = new Set(removed);
	return {
		page: baseline.page,
		observedAt: baseline.observedAt,
		source: drop.has("source") ? null : baseline.source ?? null,
		target: drop.has("target") ? null : baseline.target ?? null,
		clientBuild: drop.has("clientBuild") ? null : baseline.clientBuild ?? null,
		view: drop.has("view") ? { ...REDACTED_VIEW } : isPlainObject(baseline.view) ? { ...baseline.view } : null,
		excerpt: drop.has("excerpt") ? null : typeof baseline.excerpt === "string" ? baseline.excerpt : null,
		excerptEnabled: !drop.has("excerpt") && baseline.excerptEnabled === true,
		visibleIds: drop.has("visibleIds") ? [] : Array.isArray(baseline.visibleIds) ? [...baseline.visibleIds] : [],
		diagnostics: drop.has("diagnostics") ? [] : Array.isArray(baseline.diagnostics) ? JSON.parse(JSON.stringify(baseline.diagnostics)) : [],
	};
}

/**
 * What a draft stores: its identity, the text and the approved frozen context - the capture after
 * the user's removals and excerpt choice - never the observation it was derived from. Restoring
 * the record edits that capture, so nothing removed or deselected can reappear or be sent.
 */
export function draftRecordFor(state, { draftId, tabId, revision }) {
	return {
		draftId,
		tabId,
		revision,
		text: state.text,
		cursor: state.cursor,
		evidence: state.context,
		target: state.target,
		removed: [...state.removed],
		excerptEnabled: state.excerptEnabled,
		requestId: state.requestId,
		status: state.status,
	};
}

/**
 * Freeze one observation again with the user's target and removals applied. Only the baseline is
 * read, so a restored draft keeps its source, excerpt and observedAt whatever the page shows now;
 * a null baseline is the standalone "unavailable" context.
 */
export function deriveCapture(baseline, { target, removed = [], excerptEnabled = false, uuid, now }) {
	if (baseline === null || baseline === undefined) return describeUnavailable("no_adapter", { uuid, now });
	const drop = new Set(removed);
	return freezeCapture({
		page: baseline.page,
		observedAt: typeof baseline.observedAt === "string" ? baseline.observedAt : undefined,
		source: drop.has("source") ? null : baseline.source ?? null,
		target: drop.has("target") ? null : target === undefined ? baseline.target ?? null : target,
		clientBuild: drop.has("clientBuild") ? null : baseline.clientBuild ?? null,
		view: drop.has("view") ? REDACTED_VIEW : baseline.view ?? REDACTED_VIEW,
		excerpt: baseline.excerpt ?? null,
		excerptEnabled: !drop.has("excerpt") && excerptEnabled === true,
		visibleIds: drop.has("visibleIds") ? [] : baseline.visibleIds ?? [],
		diagnostics: drop.has("diagnostics") ? [] : baseline.diagnostics ?? [],
		uuid,
		now,
	});
}

// Display rounding only: the envelope keeps the exact offsets and rectangles.
function describeDiagnostic(entry) {
	const at = `${Math.round(entry.atMs)}ms`;
	if (entry.type === "action") return `${entry.name} · ${at}`;
	if (entry.type === "request") return `${entry.route} ${entry.status}${entry.errorCode ? ` ${entry.errorCode}` : ""} · ${entry.durationMs}ms · ${at}`;
	if (entry.type === "script") return `${entry.file}:${entry.line}:${entry.column} ${entry.errorClass} · ${at}`;
	return at;
}

function describeView(view) {
	const flags = `${view.embedded ? " · 삽입" : ""}${view.viewerOpen ? " · 뷰어" : ""}`;
	return `${view.width}×${view.height} · dpr ${view.dpr} · 배율 ${view.scale} · 스크롤 ${view.scrollX},${view.scrollY} · ${view.theme} · ${view.locale}${flags}`;
}

/**
 * The retained contents of a frozen context, one entry per removable item, exactly as they will
 * be posted: values, not counts. `removed` hides the view entry, whose removal is a substitution.
 */
export function describeContext(context, removed = []) {
	const items = [];
	if (!isPlainObject(context)) return items;
	const names = TEXT.items;
	if (context.source) items.push({ key: "source", name: names.source, value: sourceLabel(context.source), detail: `seq ${context.source.observedSeq}` });
	if (context.target) {
		const t = context.target;
		items.push({ key: "target", name: names.target, value: `${KIND_LABEL[t.kind] ?? t.kind} ${t.label}`, detail: `${t.key} · ${Math.round(t.rect.w)}×${Math.round(t.rect.h)} @ ${Math.round(t.rect.x)},${Math.round(t.rect.y)}` });
	}
	if (typeof context.excerpt === "string") items.push({ key: "excerpt", name: context.excerptTruncated ? `${names.excerpt} · ${TEXT.truncated}` : names.excerpt, value: context.excerpt, detail: null });
	if (Array.isArray(context.visibleIds) && context.visibleIds.length) items.push({ key: "visibleIds", name: `${names.visibleIds} ${context.visibleIds.length}`, value: context.visibleIds.join(", "), detail: null });
	if (Array.isArray(context.diagnostics) && context.diagnostics.length) items.push({ key: "diagnostics", name: `${names.diagnostics} ${context.diagnostics.length}`, value: context.diagnostics.map(describeDiagnostic).join("\n"), detail: null });
	if (isPlainObject(context.view) && !removed.includes("view") && context.contextStatus !== "unavailable") items.push({ key: "view", name: names.view, value: describeView(context.view), detail: null });
	if (isPlainObject(context.clientBuild) && typeof context.clientBuild.digest === "string") items.push({ key: "clientBuild", name: names.clientBuild, value: context.clientBuild.digest, detail: context.clientBuild.version });
	return items;
}

/** The reporter's history entry keeps every field the page stored there and adds only its token. */
export function withReporterToken(current, token) {
	return { ...(isPlainObject(current) ? current : {}), issueReport: token };
}

/** True when a history entry is the one this reporter pushed. */
export function ownsHistoryEntry(current, token) {
	return isPlainObject(current) && typeof token === "string" && current.issueReport === token;
}

function supersedeRetired(next, requestId) {
	next.retired = next.retired.map((entry) => (entry.supersededBy === null ? { ...entry, outcome: "superseded", supersededBy: requestId } : entry));
}

/**
 * Pure transition. Returns a new state and never mutates the input. Locked states ignore edits
 * and target changes so a retry can never carry different content under the same requestId.
 */
export function reduceReport(state, event) {
	if (!isPlainObject(state)) throw new TypeError("reduceReport needs a state");
	if (!isPlainObject(event) || typeof event.type !== "string") throw new TypeError("reduceReport needs an event with a type");
	const next = { ...state, removed: [...state.removed], retired: state.retired.map((entry) => ({ ...entry })) };
	switch (event.type) {
		case "open": {
			if (isLocked(next) || next.status === "sent") return next;
			if (event.context !== undefined) {
				next.context = event.context;
				next.removed = [];
			}
			if (event.target !== undefined) next.target = event.target;
			if (event.excerptEnabled !== undefined) next.excerptEnabled = event.excerptEnabled === true;
			next.generation += 1;
			next.status = "editing";
			return next;
		}
		case "restore": {
			// A stored draft replaces only an untouched editor; its evidence is the baseline from here.
			if (next.status !== "editing" || next.text !== "" || next.requestId !== null) return next;
			next.text = typeof event.text === "string" ? event.text : "";
			next.cursor = Number.isInteger(event.cursor) && event.cursor >= 0 ? event.cursor : 0;
			if (event.context !== undefined) next.context = event.context;
			next.target = event.target === undefined ? null : event.target;
			next.removed = Array.isArray(event.removed) ? event.removed.filter((item) => CONTEXT_ITEMS.includes(item)) : [];
			next.excerptEnabled = event.excerptEnabled === true;
			next.storage = "saved";
			next.generation += 1;
			return next;
		}
		case "edit": {
			if (isLocked(next) || next.status === "sent") return next;
			if (typeof event.text === "string") next.text = event.text;
			if (Number.isInteger(event.cursor) && event.cursor >= 0) next.cursor = event.cursor;
			// A rejected or conflicting request never committed with this content; the next send
			// freezes a fresh requestId.
			next.requestId = null;
			next.envelope = null;
			next.outbox = "none";
			next.attempts = 0;
			next.autoRetried = false;
			next.failure = null;
			next.status = "editing";
			return next;
		}
		case "target": {
			if (isLocked(next) || next.status === "sent") return next;
			next.target = event.target === undefined ? null : event.target;
			next.generation += 1;
			next.requestId = null;
			next.envelope = null;
			next.outbox = "none";
			next.failure = null;
			next.status = "editing";
			return next;
		}
		case "context": {
			if (isLocked(next) || next.status === "sent") return next;
			next.context = event.context === undefined ? null : event.context;
			if (Array.isArray(event.removed)) next.removed = event.removed.filter((item) => CONTEXT_ITEMS.includes(item));
			if (event.excerptEnabled !== undefined) next.excerptEnabled = event.excerptEnabled === true;
			next.generation += 1;
			next.requestId = null;
			next.envelope = null;
			next.outbox = "none";
			if (next.status === "idle") next.status = "editing";
			return next;
		}
		case "invalid": {
			if (isLocked(next) || next.status === "sent") return next;
			next.failure = { kind: "rejected", code: event.code === "too_long" ? "too_long" : "empty", status: 0, fields: ["description"] };
			next.status = "editing";
			return next;
		}
		case "freeze": {
			if (next.requestId !== null || isLocked(next) || next.status === "sent") return next;
			if (typeof event.requestId !== "string" || !UUID_RE.test(event.requestId)) throw new TypeError("freeze needs a UUIDv4 requestId");
			if (!isPlainObject(event.envelope) || event.envelope.requestId !== event.requestId) throw new TypeError("freeze needs the envelope for that requestId");
			next.requestId = event.requestId;
			next.envelope = Object.freeze(JSON.parse(JSON.stringify(event.envelope)));
			supersedeRetired(next, event.requestId);
			next.outbox = "none";
			next.attempts = 0;
			next.autoRetried = false;
			next.failure = null;
			next.status = "frozen";
			return next;
		}
		case "outbox": {
			if (next.status !== "frozen") return next;
			if (event.result === "written") {
				next.outbox = "written";
			} else {
				next.outbox = "skipped";
				next.storage = "failed";
				next.storageReason = typeof event.reason === "string" ? event.reason : "storage_unavailable";
			}
			return next;
		}
		case "send-without-save": {
			next.sendWithoutSave = true;
			return next;
		}
		case "send": {
			const retry = next.status === "failed" && next.failure !== null && next.failure.kind === "retryable";
			if (next.status !== "frozen" && !retry) return next;
			if (next.status === "frozen" && next.outbox !== "written" && !next.sendWithoutSave) return next;
			next.attempts += 1;
			if (event.auto === true) next.autoRetried = true;
			next.failure = null;
			next.status = "sending";
			return next;
		}
		case "accepted": {
			if (next.status !== "sending" && next.status !== "failed") return next;
			if (next.requestId === null) return next;
			const receipt = event.receipt;
			if (!isPlainObject(receipt) || receipt.requestId !== next.requestId || event.id !== next.requestId) return next;
			next.receipt = { requestId: receipt.requestId, seq: receipt.seq, acceptedAt: receipt.acceptedAt };
			next.issueId = event.id;
			next.replayed = event.replayed === true;
			next.failure = null;
			next.outbox = "none";
			next.status = "sent";
			return next;
		}
		case "malformed": {
			if (next.status !== "sending") return next;
			next.failure = { kind: "retryable", code: "malformed", status: Number.isInteger(event.status) ? event.status : 0, fields: [], uncertain: true, queued: false };
			next.status = "failed";
			return next;
		}
		case "rejected": {
			if (next.status !== "sending") return next;
			next.failure = classifyFailure(event.status, event.body);
			if (next.failure.kind !== "retryable") {
				// Definitive: this envelope can never be accepted as it is. It leaves the outbox for
				// good; only a new request (after an edit, or a renew) may carry the text again.
				next.outbox = "rejected";
				next.retired.push({ requestId: next.requestId, outcome: "rejected", code: next.failure.code, status: next.failure.status, supersededBy: null });
			}
			next.status = "failed";
			return next;
		}
		case "network": {
			if (next.status !== "sending") return next;
			const online = event.online !== false;
			next.failure = { kind: "retryable", code: online ? "network" : "offline", status: 0, fields: [], uncertain: online, queued: !online };
			next.status = "failed";
			return next;
		}
		case "renew": {
			if (next.status !== "failed" || next.failure === null || next.failure.kind !== "conflict" || !next.failure.needsNewRequest) return next;
			if (typeof event.requestId !== "string" || !UUID_RE.test(event.requestId)) throw new TypeError("renew needs a UUIDv4 requestId");
			if (next.failure.needsNewStore && typeof event.storeId !== "string") return next;
			const envelope = JSON.parse(JSON.stringify(next.envelope));
			envelope.requestId = event.requestId;
			if (typeof event.storeId === "string") envelope.storeId = event.storeId;
			next.requestId = event.requestId;
			supersedeRetired(next, event.requestId);
			next.envelope = Object.freeze(envelope);
			next.outbox = "none";
			next.attempts = 0;
			next.autoRetried = false;
			next.failure = null;
			next.status = "frozen";
			return next;
		}
		case "storage": {
			next.storage = ["saved", "saving", "failed", "unavailable", "conflict", "unknown"].includes(event.status) ? event.status : "unknown";
			next.storageReason = typeof event.reason === "string" ? event.reason : null;
			return next;
		}
		case "discard": {
			if (isLocked(next)) return next;
			return {
				...createReportState({ context: next.context, excerptEnabled: next.excerptEnabled }),
				storage: next.storage === "unavailable" ? "unavailable" : "unknown",
				generation: next.generation + 1,
				status: "editing",
			};
		}
		case "reset": {
			if (next.status !== "sent") return next;
			return {
				...createReportState({ context: next.context, excerptEnabled: next.excerptEnabled }),
				storage: next.storage === "unavailable" ? "unavailable" : "unknown",
				generation: next.generation + 1,
				status: "editing",
			};
		}
		default:
			return next;
	}
}

/** The status line and the one explicit next-step control the current state requires. */
export function describeReport(state) {
	const s = TEXT.status;
	if (state.status === "sent") return { text: s.accepted, tone: "ok", action: null };
	if (state.status === "sending") return { text: state.attempts > 1 ? s.pending : s.sending, tone: "busy", action: null };
	if (state.status === "frozen") {
		if (state.outbox === "skipped" && !state.sendWithoutSave) return { text: s.saveFailed, tone: "error", action: "send-without-save" };
		return { text: s.sending, tone: "busy", action: null };
	}
	if (state.status === "failed" && state.failure) {
		const f = state.failure;
		if (f.kind === "retryable") {
			if (f.code === "offline") return { text: s.offline, tone: "error", action: "retry" };
			if (f.code === "server") return { text: s.server, tone: "error", action: "retry" };
			if (f.code === "network") return { text: s.network, tone: "error", action: "retry" };
			return { text: s.pending, tone: "error", action: "retry" };
		}
		if (f.kind === "conflict") {
			if (f.code === "key_reused") return { text: s.keyReused, tone: "error", action: "renew" };
			if (f.code === "store_changed") return { text: s.storeChanged, tone: "error", action: "renew-store" };
			const detail = f.currentSeq !== null ? ` · ${f.state ?? ""} seq ${f.currentSeq}`.replace("  ", " ") : "";
			return { text: s.conflict + detail, tone: "error", action: null };
		}
		if (f.code === "forbidden") return { text: s.forbidden, tone: "error", action: null };
		if (f.code === "too_long") return { text: s.tooLongBody, tone: "error", action: null };
		if (f.code === "gone") return { text: s.gone, tone: "error", action: null };
		return { text: s.badInput + (f.fields.length ? ` · ${f.fields.join(", ")}` : ""), tone: "error", action: null };
	}
	if (state.failure && state.failure.kind === "rejected" && state.failure.status === 0) {
		return { text: state.failure.code === "too_long" ? s.tooLong : s.empty, tone: "error", action: null };
	}
	if (state.storage === "failed" || state.storage === "unavailable") return { text: s.saveFailed, tone: "error", action: null };
	if (state.storage === "conflict") return { text: s.draftConflict, tone: "error", action: "fork" };
	if (state.storage === "saving") return { text: s.saving, tone: "muted", action: null };
	if (state.storage === "saved") return { text: s.saved, tone: "muted", action: null };
	return { text: "", tone: "muted", action: null };
}

// ---------------------------------------------------------------------------------------------
// DOM owner
// ---------------------------------------------------------------------------------------------

const POST_HEADERS = Object.freeze({ "content-type": "application/json", "x-inbox": "1" });

function el(document, tag, attrs = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "text") node.textContent = value;
		else if (value === true) node.setAttribute(key, "");
		else node.setAttribute(key, String(value));
	}
	for (const child of children) if (child !== null && child !== undefined) node.append(child);
	return node;
}

function buildStampFrom(document, buildId) {
	let digest = typeof buildId === "string" ? buildId : null;
	if (digest === null && document && typeof document.querySelector === "function") {
		const meta = document.querySelector('meta[name="inbox-build"]');
		const content = meta ? meta.getAttribute("content") : null;
		if (typeof content === "string") digest = content;
	}
	return digest !== null && SHA256_RE.test(digest) ? { kind: "page_response_manifest", version: null, digest } : null;
}

export function mountIssueReport(options = {}) {
	const {
		document,
		window: win,
		adapters = null,
		drafts = null,
		diagnostics = null,
		image = null,
		fetchImpl,
		now,
		uuid,
		buildId = null,
		capabilities = null,
		indexedDB: idbOption,
		stylesheet = "/web/issue-report.css",
		imageStylesheet = "/web/issue-image.css",
		pageKey,
	} = options;
	if (!document || typeof document.createElement !== "function") throw new TypeError("mountIssueReport needs a document");
	if (!win || typeof win.addEventListener !== "function") throw new TypeError("mountIssueReport needs a window");
	if (typeof fetchImpl !== "function") throw new TypeError("mountIssueReport needs fetchImpl");
	if (typeof now !== "function") throw new TypeError("mountIssueReport needs now()");
	if (typeof uuid !== "function") throw new TypeError("mountIssueReport needs uuid()");

	const clientBuild = buildStampFrom(document, buildId);
	const idb = idbOption !== undefined ? idbOption : win.indexedDB ?? null;
	// One identity per browser tab, kept across reloads (sessionStorage is per tab), so the draft
	// revision check tells a reloaded tab from a genuinely different one.
	const tabId = (() => {
		const key = "inbox-issues-v1:tab";
		try {
			const stored = win.sessionStorage ? win.sessionStorage.getItem(key) : null;
			if (typeof stored === "string" && UUID_RE.test(stored)) return stored;
			const fresh = uuid();
			if (win.sessionStorage) win.sessionStorage.setItem(key, fresh);
			return fresh;
		} catch {
			return uuid();
		}
	})();
	const draftKey = `inbox-issues-v1:draft:${typeof pageKey === "string" ? pageKey : win.location ? win.location.pathname : "/"}`;
	const owner = createGenerationOwner();

	let state = createReportState();
	let caps = isPlainObject(capabilities) && typeof capabilities.storeId === "string" ? { storeId: capabilities.storeId, limits: capabilities.limits ?? null } : null;
	let db = null;
	let dbError = null;
	// The observation every re-freeze derives from: the adapter capture taken at open(), pruned to
	// the approved items as the user removes them, or the approved capture a restored draft stored.
	// Only an explicit recapture (first open, 초안 버리기, 새 제보) replaces it.
	let baseline = null;
	let draftId = null;
	let draftRevision = 0;
	let saveChain = Promise.resolve();
	let saveDirty = false;
	let saving = false;
	let opener = null;
	let scroll = null;
	// history.state survives a reload, so the token names this mount (a fresh id per mount, not the
	// per-tab identity) as well as the count: a stale entry left by the previous document can never
	// look like the current reporter.
	const mountId = uuid();
	let historyCount = 0;
	let historyToken = null;
	let closing = null;
	let onlineArmed = false;
	let destroyed = false;
	const receipts = new Map();
	const log = [];

	// ---- stylesheet (idempotent) -----------------------------------------------------------
	function ensureStylesheet(href, marker) {
		if (typeof href !== "string" || href === "" || !document.head) return;
		if (document.head.querySelector(`link[${marker}]`)) return;
		const link = el(document, "link", { rel: "stylesheet", href });
		link.setAttribute(marker, "");
		document.head.append(link);
	}
	ensureStylesheet(stylesheet, "data-issue-report-style");
	if (image) ensureStylesheet(imageStylesheet, "data-issue-image-style");

	// ---- dialog ----------------------------------------------------------------------------
	const dialog = el(document, "dialog", { class: "issue-report", id: "issue-report", "aria-labelledby": "issue-report-title" });
	const title = el(document, "h2", { class: "issue-report__title", id: "issue-report-title", text: TEXT.title });
	const closeButton = el(document, "button", { type: "button", class: "issue-report__close", id: "issue-close", text: TEXT.close });
	const head = el(document, "header", { class: "issue-report__head" }, title, closeButton);

	const chip = el(document, "span", { class: "issue-report__chip", id: "issue-target-label", text: TEXT.pageTarget });
	const pickButton = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-target-pick", text: TEXT.pick, "aria-expanded": "false", "aria-controls": "issue-picker" });
	const clearTargetButton = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-target-clear", text: TEXT.remove, hidden: true });
	const targetRow = el(document, "div", { class: "issue-report__target", id: "issue-target" }, chip, pickButton, clearTargetButton);
	const picker = el(document, "ul", { class: "issue-report__picker", id: "issue-picker", role: "listbox", "aria-label": TEXT.pick, hidden: true });

	const label = el(document, "label", { class: "issue-report__label", for: "issue-description", text: "설명" });
	const textarea = el(document, "textarea", { class: "issue-report__textarea", id: "issue-description", rows: "4", required: true, autocomplete: "off" });

	const attachSummary = el(document, "span", { class: "issue-report__attach-summary", id: "issue-attach-summary" });
	const attachToggle = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-attach-toggle", text: TEXT.attachments, "aria-expanded": "false", "aria-controls": "issue-attach-list" });
	const attachRow = el(document, "div", { class: "issue-report__attach-row" }, attachSummary, attachToggle);
	const attachList = el(document, "ul", { class: "issue-report__attach-list", id: "issue-attach-list", hidden: true });
	const fileInput = el(document, "input", { type: "file", id: "issue-file", class: "issue-report__file-input", accept: "image/png,image/jpeg,image/webp" });
	const fileLabel = el(document, "label", { class: "issue-report__ctl issue-report__file", for: "issue-file", text: TEXT.addPhoto });
	const captureButton = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-capture", text: TEXT.capture, hidden: true });
	const photoRow = el(document, "div", { class: "issue-report__photo", hidden: !image }, fileLabel, fileInput, captureButton);
	const attachments = el(document, "section", { class: "issue-report__attach", id: "issue-attachments", "aria-label": "첨부" }, attachRow, attachList, photoRow);
	if (image && image.element) attachments.append(image.element);

	const status = el(document, "p", { class: "issue-report__status", id: "issue-status", role: "status", "aria-live": "polite" });
	const link = el(document, "a", { class: "issue-report__link", id: "issue-link", href: "#", text: TEXT.issueLink });
	const newReportButton = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-new", text: TEXT.newReport });
	const receipt = el(document, "div", { class: "issue-report__receipt", id: "issue-receipt", hidden: true }, link, newReportButton);

	const body = el(document, "div", { class: "issue-report__body" }, targetRow, picker, label, textarea, attachments, status, receipt);

	const discardButton = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-discard", text: TEXT.discard });
	const copyButton = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-copy", text: TEXT.copy, hidden: true });
	const actionButton = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-retry", hidden: true });
	const sendButton = el(document, "button", { type: "button", class: "issue-report__send", id: "issue-send", text: TEXT.send });
	const actions = el(document, "footer", { class: "issue-report__actions" }, discardButton, copyButton, actionButton, sendButton);

	const confirmText = el(document, "p", { id: "issue-discard-text", text: TEXT.discardConfirm });
	const confirmYes = el(document, "button", { type: "button", class: "issue-report__ctl issue-report__danger", id: "issue-discard-yes", text: TEXT.discardYes });
	const confirmNo = el(document, "button", { type: "button", class: "issue-report__ctl", id: "issue-discard-no", text: TEXT.cancel });
	const confirm = el(document, "div", { class: "issue-report__confirm", id: "issue-discard-confirm", role: "alertdialog", "aria-labelledby": "issue-discard-text", hidden: true }, confirmText, el(document, "div", { class: "issue-report__confirm-row" }, confirmYes, confirmNo));

	dialog.append(head, body, actions, confirm);
	document.body.append(dialog);

	// ---- helpers ---------------------------------------------------------------------------
	function record(step, detail) {
		log.push({ step, detail: detail === undefined ? null : detail, at: now() });
		if (log.length > 200) log.splice(0, log.length - 200);
	}

	function dispatch(event) {
		state = reduceReport(state, event);
		return state;
	}

	function defaultView() {
		let theme = "unknown";
		try {
			if (typeof win.matchMedia === "function") theme = win.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		} catch {
			theme = "unknown";
		}
		const visual = win.visualViewport ?? null;
		return {
			width: Number(win.innerWidth) || 1,
			height: Number(win.innerHeight) || 1,
			dpr: Number(win.devicePixelRatio) || 1,
			scale: visual && Number(visual.scale) > 0 ? Number(visual.scale) : 1,
			scrollX: Number(win.scrollX) || 0,
			scrollY: Number(win.scrollY) || 0,
			theme,
			locale: win.navigator && typeof win.navigator.language === "string" ? win.navigator.language : "unknown",
			embedded: Boolean(win.top && win.top !== win),
			viewerOpen: false,
		};
	}

	function freezeNow({ target, removed, excerptEnabled }) {
		const frozen = deriveCapture(baseline, { target, removed, excerptEnabled, uuid, now });
		// The first freeze of a baseline fixes its observation time; every later derivation keeps it.
		if (baseline !== null && typeof baseline.observedAt !== "string") baseline.observedAt = frozen.observedAt;
		return frozen;
	}

	function captureBaseline() {
		let value = null;
		try {
			value = adapters && typeof adapters.freeze === "function" ? adapters.freeze({ fresh: true }) : null;
		} catch {
			value = null;
		}
		if (value === null || value === undefined) return null;
		const snapshot = JSON.parse(JSON.stringify(value));
		if (diagnostics && typeof diagnostics.snapshot === "function") snapshot.diagnostics = diagnostics.snapshot();
		if (!snapshot.view) snapshot.view = defaultView();
		if (!snapshot.clientBuild) snapshot.clientBuild = clientBuild;
		return snapshot;
	}

	/** Explicit recapture of the live page: the whole frozen context is replaced at once. */
	function recapture() {
		baseline = captureBaseline();
		owner.begin();
		const excerptEnabled = baseline !== null && baseline.excerptEnabled === true;
		return { context: freezeNow({ target: null, removed: [], excerptEnabled }), excerptEnabled };
	}

	async function ensureCapabilities() {
		if (caps) return caps;
		const res = await fetchImpl("/api/issues/capabilities", { headers: { accept: "application/json" } });
		if (!res || !res.ok) throw new Error("capabilities unavailable");
		const json = await res.json();
		if (!isPlainObject(json) || typeof json.storeId !== "string") throw new Error("capabilities malformed");
		caps = { storeId: json.storeId, limits: isPlainObject(json.limits) ? json.limits : null };
		return caps;
	}

	async function ensureDb() {
		if (db || dbError || !drafts || typeof drafts.openDraftDb !== "function") return db;
		let current;
		try {
			current = await ensureCapabilities();
		} catch {
			// A transient capabilities failure is not a storage failure; the next call tries again.
			return null;
		}
		try {
			db = await drafts.openDraftDb({ indexedDB: idb, origin: win.location.origin, storeId: current.storeId });
		} catch (error) {
			dbError = error;
			dispatch({ type: "storage", status: "unavailable", reason: error && error.code ? error.code : "storage_unavailable" });
		}
		return db;
	}

	function readPointer() {
		try {
			return win.localStorage ? win.localStorage.getItem(draftKey) : null;
		} catch {
			return null;
		}
	}
	function writePointer(value) {
		try {
			if (!win.localStorage) return;
			if (value === null) win.localStorage.removeItem(draftKey);
			else win.localStorage.setItem(draftKey, value);
		} catch {
			// no pointer: the draft stays in memory for this tab
		}
	}

	function draftRecord() {
		return draftRecordFor(state, { draftId, tabId, revision: draftRevision });
	}

	function scheduleSave() {
		if (!drafts || dbError || !draftId) return saveChain;
		saveDirty = true;
		if (saving) return saveChain;
		saving = true;
		saveChain = saveChain.then(async () => {
			while (saveDirty) {
				saveDirty = false;
				const database = await ensureDb();
				if (!database) break;
				dispatch({ type: "storage", status: "saving" });
				render();
				try {
					const result = await drafts.saveDraft(database, draftRecord());
					if (result && result.ok) {
						draftRevision = result.revision;
						writePointer(draftId);
						dispatch({ type: "storage", status: "saved" });
					} else {
						dispatch({ type: "storage", status: "conflict" });
					}
				} catch (error) {
					dispatch({ type: "storage", status: "failed", reason: error && error.code ? error.code : "storage_unavailable" });
				}
				render();
			}
			saving = false;
		});
		return saveChain;
	}

	async function restoreDraft() {
		const pointer = readPointer();
		if (!pointer) return null;
		const database = await ensureDb();
		if (!database) return null;
		try {
			const found = await drafts.readDraft(database, pointer);
			if (!found || typeof found.text !== "string") return null;
			return found;
		} catch {
			return null;
		}
	}

	/**
	 * A stored draft that was frozen into a request becomes editable again only once the server
	 * says that request never committed; otherwise a fresh send could duplicate an accepted report.
	 */
	async function draftVerdict(found) {
		if (found.status === "sent") return "consumed";
		if (typeof found.requestId !== "string" || found.requestId === "") return "restore";
		if (receipts.has(found.requestId)) return "consumed";
		try {
			const pending = db ? await drafts.listPending(db) : [];
			if (pending.some((entry) => entry.requestId === found.requestId)) return "consumed";
		} catch {
			return "unknown";
		}
		try {
			const res = await fetchImpl(`/api/issues/${encodeURIComponent(found.requestId)}`, { headers: { accept: "application/json" } });
			if (res.status === 200) return "consumed";
			if (res.status === 404) return "restore";
		} catch {
			// offline: the stored draft waits for a later open
		}
		return "unknown";
	}

	// ---- network ---------------------------------------------------------------------------
	function recordRequest(route, startedAt, status, errorCode) {
		if (!diagnostics || typeof diagnostics.recordRequest !== "function") return;
		diagnostics.recordRequest({ route, status, durationMs: Math.max(0, now() - startedAt), errorCode: errorCode ?? null });
	}

	async function persistReceipt() {
		receipts.set(state.requestId, state.receipt);
		const database = await ensureDb();
		if (!database) return;
		try {
			await drafts.recordReceipt(database, state.requestId, state.receipt);
		} catch {
			// the server holds the receipt; the outbox entry is replayed harmlessly next time
		}
		if (draftId) {
			try {
				const result = await drafts.saveDraft(database, { ...draftRecord(), status: "sent" });
				if (result && result.ok) draftRevision = result.revision;
			} catch {
				// the pointer still names a sent draft; open() treats it as consumed
			}
		}
	}

	/** A definitive rejection ends the request: its outbox entry must never be replayed by a later load. */
	async function retireOutbox(requestId) {
		const database = await ensureDb();
		if (!database) return;
		try {
			await drafts.clearOutbox(database, requestId);
			record("outbox-retired", requestId);
		} catch (error) {
			record("outbox-retire-failed", { requestId, code: error && error.code ? error.code : "storage_unavailable" });
		}
	}

	function armOnline() {
		if (onlineArmed) return;
		onlineArmed = true;
		const onOnline = () => {
			onlineArmed = false;
			win.removeEventListener("online", onOnline);
			if (destroyed || state.status !== "failed" || !state.failure || state.failure.kind !== "retryable" || state.autoRetried) return;
			record("online-retry", state.requestId);
			void retry({ auto: true });
		};
		win.addEventListener("online", onOnline);
	}

	async function transmit() {
		const { requestId, envelope } = state;
		const expected = { requestId, storeId: envelope.storeId };
		if (win.navigator && win.navigator.onLine === false) {
			dispatch({ type: "network", online: false });
			armOnline();
			render();
			return;
		}
		const startedAt = now();
		let res;
		try {
			res = await fetchImpl("/api/issues", { method: "POST", headers: { ...POST_HEADERS }, body: JSON.stringify(envelope) });
		} catch {
			recordRequest("issue_create", startedAt, 0, "network");
			if (state.requestId !== requestId || state.status !== "sending") return;
			const online = !(win.navigator && win.navigator.onLine === false);
			dispatch({ type: "network", online });
			if (!online) armOnline();
			render();
			return;
		}
		const httpStatus = Number(res.status) || 0;
		let json;
		try {
			json = await res.json();
		} catch {
			json = undefined;
		}
		if (state.requestId !== requestId || state.status !== "sending") return;
		if (httpStatus >= 200 && httpStatus < 300) {
			const parsed = parseCreateResponse(httpStatus, json, expected);
			recordRequest("issue_create", startedAt, httpStatus, parsed.ok ? null : "other");
			if (parsed.ok) {
				dispatch({ type: "accepted", id: parsed.id, receipt: parsed.receipt, replayed: parsed.replayed });
				record("accepted", { requestId, replayed: parsed.replayed });
				render();
				await persistReceipt();
			} else {
				dispatch({ type: "malformed", status: httpStatus });
				record("malformed", { requestId, status: httpStatus });
				render();
			}
			return;
		}
		recordRequest("issue_create", startedAt, httpStatus, isPlainObject(json) && typeof json.error === "string" ? json.error : "other");
		dispatch({ type: "rejected", status: httpStatus, body: json });
		record("rejected", { requestId, status: httpStatus, error: isPlainObject(json) ? json.error : null });
		render();
		if (state.outbox === "rejected") await retireOutbox(requestId);
	}

	/** Lost/ambiguous response: GET the deterministic id first, replay only when it is absent. */
	async function resolvePending() {
		const { requestId, envelope } = state;
		const expected = { requestId, storeId: envelope.storeId };
		if (win.navigator && win.navigator.onLine === false) {
			dispatch({ type: "network", online: false });
			armOnline();
			render();
			return;
		}
		const startedAt = now();
		let res;
		try {
			res = await fetchImpl(`/api/issues/${encodeURIComponent(requestId)}`, { headers: { accept: "application/json" } });
		} catch {
			recordRequest("issue_detail", startedAt, 0, "network");
			if (state.requestId !== requestId || state.status !== "sending") return;
			const online = !(win.navigator && win.navigator.onLine === false);
			dispatch({ type: "network", online });
			if (!online) armOnline();
			render();
			return;
		}
		const httpStatus = Number(res.status) || 0;
		let json;
		try {
			json = await res.json();
		} catch {
			json = undefined;
		}
		recordRequest("issue_detail", startedAt, httpStatus, httpStatus === 200 ? null : isPlainObject(json) && typeof json.error === "string" ? json.error : "other");
		if (state.requestId !== requestId || state.status !== "sending") return;
		if (httpStatus === 200) {
			const parsed = parseDetailReceipt(json, expected);
			if (parsed.ok) {
				dispatch({ type: "accepted", id: parsed.id, receipt: parsed.receipt, replayed: true });
				record("resolved", { requestId, via: "detail" });
				render();
				await persistReceipt();
				return;
			}
			dispatch({ type: "malformed", status: httpStatus });
			render();
			return;
		}
		if (httpStatus === 404) {
			record("replay", { requestId });
			await transmit();
			return;
		}
		dispatch({ type: "rejected", status: httpStatus, body: json });
		render();
		if (state.outbox === "rejected") await retireOutbox(requestId);
	}

	// Every retry resolves by GET first: whether the earlier attempt was lost, malformed, 5xx or
	// never left the device, the deterministic id tells the truth before any replay is sent.
	async function retry({ auto = false } = {}) {
		if (state.status !== "failed" || !state.failure || state.failure.kind !== "retryable") return;
		dispatch({ type: "send", auto });
		render();
		await resolvePending();
	}

	async function send({ withoutSave = false } = {}) {
		if (state.status === "sending" || state.status === "sent") return;
		if (state.status === "failed" && state.failure && state.failure.kind === "retryable") {
			await retry();
			return;
		}
		if (state.status !== "frozen") {
			const checked = validateDescription(textarea.value);
			if (!checked.ok) {
				dispatch({ type: "edit", text: textarea.value, cursor: textarea.selectionStart ?? 0 });
				dispatch({ type: "invalid", code: checked.code });
				record("invalid", checked.code);
				render();
				textarea.focus({ preventScroll: true });
				return;
			}
			let current;
			try {
				current = await ensureCapabilities();
			} catch {
				status.textContent = TEXT.status.noCapabilities;
				status.dataset.tone = "error";
				record("capabilities-failed");
				return;
			}
			dispatch({ type: "edit", text: textarea.value, cursor: textarea.selectionStart ?? 0 });
			let visual = null;
			if (image) {
				if (image.hasImage()) {
					try {
						visual = image.exportEvidence().visual;
					} catch {
						visual = { kind: "none", reason: "failed" };
					}
				} else {
					visual = { kind: "none", reason: image.noneReason() ?? "not_requested" };
				}
			}
			const context = state.context ?? freezeNow({ target: state.target, removed: state.removed, excerptEnabled: state.excerptEnabled });
			const requestId = uuid();
			const envelope = buildEnvelope({ storeId: current.storeId, requestId, description: checked.text, evidence: context, visual });
			dispatch({ type: "freeze", requestId, envelope });
			if (diagnostics && typeof diagnostics.recordAction === "function") diagnostics.recordAction("issue_submit");
			record("freeze", requestId);
			render();
			// The stored draft now names its request, so a reload can tell a consumed draft apart.
			await scheduleSave();
		}
		if (withoutSave) dispatch({ type: "send-without-save" });
		if (state.outbox === "none") {
			const database = await ensureDb();
			if (database) {
				try {
					const frozen = await drafts.freezeToOutbox(database, state.requestId, state.envelope);
					if (frozen && frozen.ok) dispatch({ type: "outbox", result: "written" });
					else dispatch({ type: "outbox", result: "failed", reason: "conflict" });
				} catch (error) {
					dispatch({ type: "outbox", result: "failed", reason: error && error.code ? error.code : "storage_unavailable" });
				}
			} else {
				dispatch({ type: "outbox", result: "failed", reason: dbError && dbError.code ? dbError.code : "storage_unavailable" });
			}
			record("outbox", state.outbox);
			if (state.outbox !== "written" && !state.sendWithoutSave) {
				render();
				return;
			}
		}
		dispatch({ type: "send" });
		render();
		await transmit();
	}

	async function renew() {
		if (state.status !== "failed" || !state.failure || state.failure.kind !== "conflict" || !state.failure.needsNewRequest) return;
		let storeId;
		if (state.failure.needsNewStore) {
			caps = null;
			try {
				storeId = (await ensureCapabilities()).storeId;
			} catch {
				status.textContent = TEXT.status.noCapabilities;
				status.dataset.tone = "error";
				return;
			}
			// Drafts, outbox and receipts are scoped by storeId: reopen under the new store.
			if (db && typeof db.close === "function") db.close();
			db = null;
			dbError = null;
			draftRevision = 0;
		}
		dispatch({ type: "renew", requestId: uuid(), storeId });
		record("renew", { requestId: state.requestId, storeId: storeId ?? null });
		render();
		await send();
	}

	/**
	 * Outbox entries left by an earlier page: resolve each once, with its own frozen envelope. Only
	 * queued or send-outcome-unknown entries are ever there: acceptance and definitive rejection both
	 * remove the entry at once, so a replaced request is never posted again.
	 */
	async function resume() {
		const database = await ensureDb();
		if (!database) return [];
		let pending;
		try {
			pending = await drafts.listPending(database);
		} catch {
			return [];
		}
		const outcomes = [];
		for (const entry of pending) {
			const envelope = entry.envelope;
			if (!isPlainObject(envelope) || envelope.requestId !== entry.requestId) continue;
			const expected = { requestId: entry.requestId, storeId: envelope.storeId };
			const outcome = { requestId: entry.requestId, outcome: "pending", receipt: null };
			try {
				const res = await fetchImpl(`/api/issues/${encodeURIComponent(entry.requestId)}`, { headers: { accept: "application/json" } });
				let json;
				try {
					json = await res.json();
				} catch {
					json = undefined;
				}
				let parsed = null;
				if (res.status === 200) parsed = parseDetailReceipt(json, expected);
				else if (res.status === 404) {
					const replay = await fetchImpl("/api/issues", { method: "POST", headers: { ...POST_HEADERS }, body: JSON.stringify(envelope) });
					let replayJson;
					try {
						replayJson = await replay.json();
					} catch {
						replayJson = undefined;
					}
					parsed = replay.status === 200 || replay.status === 201 ? parseCreateResponse(replay.status, replayJson, expected) : { ok: false, code: isPlainObject(replayJson) && typeof replayJson.error === "string" ? replayJson.error : "other", status: replay.status };
					outcome.via = "replay";
				} else parsed = { ok: false, code: isPlainObject(json) && typeof json.error === "string" ? json.error : "other", status: res.status };
				if (parsed.ok) {
					outcome.outcome = "accepted";
					outcome.receipt = parsed.receipt;
					receipts.set(entry.requestId, parsed.receipt);
					await drafts.recordReceipt(database, entry.requestId, parsed.receipt);
				} else if (["key_reused", "store_changed", "bad_input", "forbidden", "gone"].includes(parsed.code)) {
					// The frozen envelope can never be accepted as it is; keep nothing that would
					// resend it silently, the user restarts from the retained draft text.
					outcome.outcome = "rejected";
					outcome.code = parsed.code;
					await drafts.clearOutbox(database, entry.requestId);
				} else {
					outcome.code = parsed.code;
				}
			} catch (error) {
				outcome.code = error && error.code ? error.code : "network";
			}
			outcomes.push(outcome);
		}
		record("resume", outcomes.map((entry) => `${entry.requestId}:${entry.outcome}`));
		return outcomes;
	}

	// ---- render ----------------------------------------------------------------------------
	function targetLabel() {
		if (state.target) return `${KIND_LABEL[state.target.kind] ?? state.target.kind} · ${state.target.label}`;
		const source = state.context ? sourceLabel(state.context.source) : null;
		return source ?? TEXT.pageTarget;
	}

	function renderAttachments() {
		const locked = isLocked(state) || state.status === "sent";
		const items = describeContext(state.context, state.removed);
		const parts = [];
		if (state.context && state.context.contextStatus === "unavailable") parts.push(TEXT.noContext);
		for (const item of items) parts.push(item.name);
		if (image && image.hasImage()) {
			const snapshot = image.state();
			parts.push(`사진 ${snapshot.width}×${snapshot.height}`);
		}
		attachSummary.textContent = parts.length ? `첨부 · ${parts.join(", ")}` : TEXT.attachNone;
		attachList.replaceChildren();
		// Each row shows the value that will be posted (text, ids, fields), with its own 지우기.
		for (const item of items) {
			const text = el(document, "div", { class: "issue-report__attach-text" }, el(document, "span", { class: "issue-report__attach-name", text: item.name }), el(document, "span", { class: "issue-report__attach-value", text: item.value, "data-item": item.key }));
			if (item.detail) text.append(el(document, "span", { class: "issue-report__attach-detail", text: item.detail }));
			const removeButton = el(document, "button", { type: "button", class: "issue-report__ctl issue-report__ctl--small", text: TEXT.remove, "data-remove": item.key, "aria-label": `${item.name} ${TEXT.remove}` });
			removeButton.disabled = locked;
			attachList.append(el(document, "li", { class: "issue-report__attach-item" }, text, removeButton));
		}
		if (baseline && typeof baseline.excerpt === "string" && baseline.excerpt !== "" && !state.removed.includes("excerpt")) {
			const checkbox = el(document, "input", { type: "checkbox", id: "issue-excerpt" });
			checkbox.checked = state.excerptEnabled;
			checkbox.disabled = locked;
			attachList.append(el(document, "li", { class: "issue-report__attach-item" }, el(document, "label", { class: "issue-report__check", for: "issue-excerpt" }, checkbox, el(document, "span", { text: TEXT.includeExcerpt }))));
		}
		if (image) {
			captureButton.hidden = !image.supportsCapture();
			fileLabel.classList.toggle("is-disabled", locked);
			fileInput.disabled = locked;
			captureButton.disabled = locked;
		}
	}

	function render() {
		const described = describeReport(state);
		const locked = isLocked(state);
		const sent = state.status === "sent";
		dialog.dataset.status = state.status;
		if (textarea.value !== state.text) textarea.value = state.text;
		textarea.readOnly = locked || sent;
		chip.textContent = targetLabel();
		pickButton.textContent = state.target ? TEXT.change : TEXT.pick;
		pickButton.disabled = locked || sent;
		clearTargetButton.hidden = state.target === null;
		clearTargetButton.disabled = locked || sent;
		renderAttachments();
		status.textContent = described.text;
		status.dataset.tone = described.tone;
		receipt.hidden = !sent;
		if (sent && state.issueId) link.setAttribute("href", `/issues/${state.issueId}`);
		sendButton.hidden = sent;
		// Sending, waiting for an explicit 저장 없이 보내기, a pending retry and a conflict each have
		// their own single control; only idle/editing/rejected states send through this button.
		const awaitingWithoutSave = state.status === "frozen" && state.outbox !== "written" && !state.sendWithoutSave;
		const failedElsewhere = state.status === "failed" && state.failure !== null && state.failure.kind !== "rejected";
		sendButton.disabled = state.status === "sending" || awaitingWithoutSave || failedElsewhere;
		discardButton.disabled = locked || sent;
		// Storage failed: the text can still leave this device by copy, not only by an online send.
		copyButton.hidden = sent || !((state.storage === "failed" || state.storage === "unavailable") && state.text.trim() !== "");
		if (described.action === null) {
			actionButton.hidden = true;
			actionButton.dataset.action = "";
		} else {
			actionButton.hidden = false;
			actionButton.dataset.action = described.action;
			actionButton.textContent = described.action === "send-without-save" ? TEXT.sendWithoutSave : described.action === "renew" ? TEXT.newRequest : described.action === "renew-store" ? TEXT.newStore : described.action === "fork" ? "별도 초안으로 저장" : TEXT.retry;
			actionButton.disabled = state.status === "sending";
		}
	}

	// ---- picker ----------------------------------------------------------------------------
	function closePicker() {
		picker.hidden = true;
		picker.replaceChildren();
		pickButton.setAttribute("aria-expanded", "false");
	}

	function openPicker() {
		let targets = [];
		try {
			targets = adapters && typeof adapters.listTargets === "function" ? adapters.listTargets() : [];
		} catch {
			targets = [];
		}
		picker.replaceChildren();
		if (!targets.length) {
			picker.append(el(document, "li", { class: "issue-report__picker-empty", text: "선택할 위치가 없습니다" }));
		}
		targets.forEach((target, index) => {
			const option = el(document, "li", { class: "issue-report__option", role: "option", tabindex: index === 0 ? "0" : "-1", "data-index": String(index), "aria-selected": state.target && state.target.key === target.key ? "true" : "false" });
			option.append(el(document, "span", { class: "issue-report__option-kind", text: KIND_LABEL[target.kind] ?? target.kind }), el(document, "span", { text: target.label }));
			option.__target = target;
			picker.append(option);
		});
		picker.hidden = false;
		pickButton.setAttribute("aria-expanded", "true");
		const first = picker.querySelector('[role="option"]');
		if (first) first.focus({ preventScroll: true });
	}

	function chooseTarget(target) {
		const plain = target ? { kind: target.kind, key: target.key, label: target.label, rect: { ...target.rect }, framePath: [...(target.framePath ?? [])] } : null;
		const gen = owner.begin();
		// Picking a target is the explicit act that puts the 위치 item back after its removal.
		const removed = plain === null ? state.removed : state.removed.filter((item) => item !== "target");
		dispatch({ type: "target", target: plain });
		dispatch({ type: "context", context: freezeNow({ target: plain, removed, excerptEnabled: state.excerptEnabled }), removed });
		if (diagnostics && typeof diagnostics.recordAction === "function") diagnostics.recordAction("pick_target");
		record("target", plain ? plain.key : null);
		closePicker();
		render();
		void scheduleSave();
		return gen;
	}

	picker.addEventListener("click", (event) => {
		const option = event.target.closest ? event.target.closest('[role="option"]') : null;
		if (!option || !picker.contains(option)) return;
		event.preventDefault();
		chooseTarget(option.__target);
		pickButton.focus({ preventScroll: true });
	});
	picker.addEventListener("keydown", (event) => {
		const options = Array.from(picker.querySelectorAll('[role="option"]'));
		const index = options.indexOf(document.activeElement);
		if (event.key === "Enter" || event.key === " ") {
			if (index < 0) return;
			event.preventDefault();
			chooseTarget(options[index].__target);
			pickButton.focus({ preventScroll: true });
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			if (!options.length) return;
			event.preventDefault();
			const nextIndex = index < 0 ? 0 : (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
			options.forEach((option, i) => option.setAttribute("tabindex", i === nextIndex ? "0" : "-1"));
			options[nextIndex].focus({ preventScroll: true });
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closePicker();
			pickButton.focus({ preventScroll: true });
		}
	});
	pickButton.addEventListener("click", () => {
		if (!picker.hidden) {
			closePicker();
			return;
		}
		openPicker();
	});
	clearTargetButton.addEventListener("click", () => {
		chooseTarget(null);
		pickButton.focus({ preventScroll: true });
	});

	// ---- attachments -----------------------------------------------------------------------
	attachToggle.addEventListener("click", () => {
		const open = attachList.hidden;
		attachList.hidden = !open;
		attachToggle.setAttribute("aria-expanded", String(open));
	});
	attachList.addEventListener("click", (event) => {
		const button = event.target.closest ? event.target.closest("[data-remove]") : null;
		if (!button || !attachList.contains(button)) return;
		const key = button.dataset.remove;
		if (isLocked(state) || state.status === "sent") return;
		const removed = state.removed.includes(key) ? state.removed : [...state.removed, key];
		const excerptEnabled = removed.includes("excerpt") ? false : state.excerptEnabled;
		// The baseline forgets the item too: nothing removed survives in memory or in the stored draft.
		baseline = pruneBaseline(baseline, removed);
		owner.begin();
		dispatch({ type: "context", context: freezeNow({ target: removed.includes("target") ? null : state.target, removed, excerptEnabled }), removed, excerptEnabled });
		if (key === "target") dispatch({ type: "target", target: null });
		record("remove-context", key);
		render();
		attachToggle.focus({ preventScroll: true });
		void scheduleSave();
	});
	attachList.addEventListener("change", (event) => {
		if (!event.target || event.target.id !== "issue-excerpt") return;
		if (isLocked(state) || state.status === "sent") return;
		const enabled = event.target.checked === true;
		owner.begin();
		dispatch({ type: "context", context: freezeNow({ target: state.target, removed: state.removed, excerptEnabled: enabled }), excerptEnabled: enabled });
		record("excerpt", enabled);
		render();
		void scheduleSave();
	});
	fileInput.addEventListener("change", () => {
		if (!image || isLocked(state) || state.status === "sent") return;
		const file = fileInput.files && fileInput.files[0];
		if (!file) return;
		record("image-file", { type: file.type, size: file.size });
		void image.acquireFile(file).finally(() => {
			fileInput.value = "";
		});
	});
	captureButton.addEventListener("click", () => {
		if (!image || isLocked(state) || state.status === "sent") return;
		record("image-capture");
		void image.acquireCapture();
	});
	dialog.addEventListener("paste", (event) => {
		if (!image || isLocked(state) || state.status === "sent") return;
		const data = event.clipboardData;
		if (!data) return;
		const hasImage = Array.from(data.items ?? []).some((item) => item.kind === "file" && typeof item.type === "string" && item.type.startsWith("image/"));
		if (!hasImage) return;
		event.preventDefault();
		record("image-paste");
		void image.acquirePaste(data);
	});
	if (image && typeof image.onChange === "function") {
		image.onChange(() => {
			renderAttachments();
		});
	}

	// ---- text ------------------------------------------------------------------------------
	textarea.addEventListener("input", () => {
		if (isLocked(state) || state.status === "sent") {
			textarea.value = state.text;
			return;
		}
		dispatch({ type: "edit", text: textarea.value, cursor: textarea.selectionStart ?? textarea.value.length });
		render();
		void scheduleSave();
	});
	textarea.addEventListener("selectionchange", () => {
		if (isLocked(state) || state.status === "sent") return;
		if (Number.isInteger(textarea.selectionStart)) state = { ...state, cursor: textarea.selectionStart };
	});

	// ---- actions ---------------------------------------------------------------------------
	sendButton.addEventListener("click", () => {
		record("send-click", state.status);
		void send();
	});
	actionButton.addEventListener("click", () => {
		const action = actionButton.dataset.action;
		record("action-click", action);
		if (action === "send-without-save") void send({ withoutSave: true });
		else if (action === "retry") void retry();
		else if (action === "renew" || action === "renew-store") void renew();
		else if (action === "fork") {
			draftId = uuid();
			draftRevision = 0;
			dispatch({ type: "storage", status: "unknown" });
			render();
			void scheduleSave();
		}
	});
	copyButton.addEventListener("click", () => {
		const clipboard = win.navigator && win.navigator.clipboard;
		if (!clipboard || typeof clipboard.writeText !== "function") {
			record("copy", "unavailable");
			return;
		}
		clipboard.writeText(state.text).then(() => record("copy", "ok"), () => record("copy", "denied"));
	});
	newReportButton.addEventListener("click", () => {
		if (state.status !== "sent") return;
		dispatch({ type: "reset" });
		draftId = uuid();
		draftRevision = 0;
		writePointer(null);
		if (image) image.remove();
		const fresh = recapture();
		dispatch({ type: "context", context: fresh.context, removed: [], excerptEnabled: fresh.excerptEnabled });
		record("new-report");
		render();
		textarea.focus({ preventScroll: true });
	});
	link.addEventListener("click", () => record("open-link", link.getAttribute("href")));

	function showConfirm(show) {
		confirm.hidden = !show;
		body.inert = show;
		actions.inert = show;
		head.inert = show;
		if (show) confirmYes.focus({ preventScroll: true });
		else discardButton.focus({ preventScroll: true });
	}
	discardButton.addEventListener("click", () => {
		if (isLocked(state) || state.status === "sent") return;
		showConfirm(true);
	});
	confirmNo.addEventListener("click", () => showConfirm(false));
	confirmYes.addEventListener("click", () => {
		showConfirm(false);
		if (isLocked(state)) return;
		dispatch({ type: "discard" });
		draftId = uuid();
		draftRevision = 0;
		writePointer(null);
		if (image) image.remove();
		const fresh = recapture();
		dispatch({ type: "context", context: fresh.context, removed: [], excerptEnabled: fresh.excerptEnabled });
		record("discard");
		render();
		textarea.focus({ preventScroll: true });
	});

	// ---- focus trap, Escape, history -------------------------------------------------------
	function focusables() {
		return Array.from(dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((node) => {
			if (node.hidden) return false;
			let parent = node.parentElement;
			while (parent && parent !== dialog) {
				if (parent.hidden || parent.inert) return false;
				parent = parent.parentElement;
			}
			return true;
		});
	}
	dialog.addEventListener("keydown", (event) => {
		if (event.key !== "Tab") return;
		const nodes = focusables();
		if (!nodes.length) return;
		const first = nodes[0];
		const last = nodes[nodes.length - 1];
		if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
			event.preventDefault();
			last.focus({ preventScroll: true });
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus({ preventScroll: true });
		}
	});

	const onKeydownCapture = (event) => {
		if (!dialog.open || event.key !== "Escape") return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (!confirm.hidden) {
			showConfirm(false);
			return;
		}
		if (!picker.hidden) {
			closePicker();
			pickButton.focus({ preventScroll: true });
			return;
		}
		close();
	};
	const onPopstateCapture = (event) => {
		if (!dialog.open && closing === null) return;
		const current = win.history && win.history.state;
		if (ownsHistoryEntry(current, historyToken)) return;
		// Our own token was popped (user Back or our history.back()): only the reporter closes.
		event.stopImmediatePropagation();
		finishClose();
	};
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		if (!confirm.hidden) {
			showConfirm(false);
			return;
		}
		close();
	});
	dialog.addEventListener("close", () => {
		if (closing === null && dialogOpenState) finishClose({ external: true });
	});
	closeButton.addEventListener("click", () => close());

	let dialogOpenState = false;

	function finishClose({ external = false } = {}) {
		if (!dialogOpenState) return;
		dialogOpenState = false;
		closing = null;
		win.removeEventListener("keydown", onKeydownCapture, true);
		win.removeEventListener("popstate", onPopstateCapture, true);
		closePicker();
		if (!confirm.hidden) showConfirm(false);
		if (dialog.open) dialog.close();
		try {
			if (adapters && typeof adapters.resumeAll === "function") adapters.resumeAll();
		} catch {
			// a page render failure is the page's own problem
		}
		const pageControl = document.querySelector("[data-issue-report]");
		const focusTarget = opener && opener.isConnected && opener !== document.body ? opener : pageControl;
		if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus({ preventScroll: true });
		if (scroll && typeof win.scrollTo === "function") win.scrollTo(scroll.x, scroll.y);
		opener = null;
		scroll = null;
		record("close", external ? "external" : "token");
	}

	function close() {
		if (!dialogOpenState || closing !== null) return;
		const current = win.history && win.history.state;
		if (win.history && typeof win.history.back === "function" && ownsHistoryEntry(current, historyToken)) {
			// The popstate from this back() reaches the capture listener, which finishes the close
			// and stops the event before any page-level popstate handler (e.g. a viewer) sees it.
			closing = historyToken;
			win.history.back();
			return;
		}
		finishClose();
	}

	async function open({ opener: explicitOpener } = {}) {
		if (destroyed) throw new Error("issue report was destroyed");
		if (dialogOpenState) {
			textarea.focus({ preventScroll: true });
			return state;
		}
		opener = explicitOpener ?? document.activeElement ?? null;
		scroll = { x: Number(win.scrollX) || 0, y: Number(win.scrollY) || 0 };
		if (diagnostics && typeof diagnostics.recordAction === "function") diagnostics.recordAction("open_report");
		try {
			if (adapters && typeof adapters.deferAll === "function") adapters.deferAll();
		} catch {
			// a page deferral failure is the page's own problem
		}
		// Freeze the source synchronously before anything else renders or polls.
		if (state.status === "idle" || state.status === "editing") {
			if (state.context === null || state.status === "idle") {
				const fresh = recapture();
				dispatch({ type: "open", context: fresh.context, target: null, excerptEnabled: fresh.excerptEnabled });
			} else {
				dispatch({ type: "open" });
			}
		}
		dialogOpenState = true;
		historyCount += 1;
		historyToken = `${mountId}:${historyCount}`;
		try {
			// The page's own state (viewer, selection ...) stays in the entry; Back restores it untouched.
			if (win.history && typeof win.history.pushState === "function") win.history.pushState(withReporterToken(win.history.state, historyToken), "", win.location.href);
		} catch {
			// no history entry: Escape and the close button still close the reporter
		}
		win.addEventListener("keydown", onKeydownCapture, true);
		win.addEventListener("popstate", onPopstateCapture, true);
		render();
		if (typeof dialog.showModal === "function") dialog.showModal();
		else dialog.setAttribute("open", "");
		textarea.focus({ preventScroll: true });
		if (textarea.setSelectionRange) {
			const at = Math.min(state.cursor, textarea.value.length);
			try {
				textarea.setSelectionRange(at, at);
			} catch {
				// a hidden textarea rejects selection; focus is enough
			}
		}
		record("open", { generation: state.generation, contextStatus: state.context ? state.context.contextStatus : null });
		draftId ??= uuid();
		// Draft restore and storage status arrive asynchronously; the frozen capture above stays.
		if (drafts && state.text === "" && state.status === "editing") {
			await ready;
			const found = await restoreDraft();
			if (found && dialogOpenState && state.text === "" && state.status === "editing") {
				const verdict = await draftVerdict(found);
				record("draft-verdict", { draftId: found.draftId, requestId: found.requestId ?? null, verdict });
				if (verdict === "consumed") {
					writePointer(null);
				} else if (verdict === "restore" && found.text !== "" && dialogOpenState && state.text === "") {
					draftId = found.draftId;
					draftRevision = Number.isInteger(found.revision) ? found.revision : 0;
					// The stored observation is the baseline from here on; the capture made above for
					// the current page is dropped whole, never merged into the restored evidence.
					if (isPlainObject(found.evidence)) {
						// The approved capture is the only observation a stored draft carries; a removed
						// or deselected item has no copy to come back from.
						baseline = baselineFromEvidence(found.evidence);
						owner.begin();
					}
					dispatch({
						type: "restore",
						text: found.text,
						cursor: found.cursor,
						context: isPlainObject(found.evidence) ? found.evidence : undefined,
						target: found.target ?? null,
						removed: found.removed,
						excerptEnabled: found.excerptEnabled === true,
					});
					record("restore", { draftId, revision: draftRevision });
					render();
					textarea.focus({ preventScroll: true });
				}
			}
		}
		return state;
	}

	// ---- entry anchors ---------------------------------------------------------------------
	const triggerHandler = (event) => {
		if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		void open({ opener: event.currentTarget });
	};
	const boundTriggers = new Set();
	function bindTriggers(root = document) {
		for (const node of root.querySelectorAll("[data-issue-report]")) {
			if (boundTriggers.has(node)) continue;
			boundTriggers.add(node);
			node.addEventListener("click", triggerHandler);
		}
		return boundTriggers.size;
	}
	bindTriggers();

	const ready = (async () => {
		await ensureDb();
		return resume();
	})();

	function destroy() {
		if (destroyed) return;
		destroyed = true;
		if (dialogOpenState) finishClose({ external: true });
		for (const node of boundTriggers) node.removeEventListener("click", triggerHandler);
		boundTriggers.clear();
		if (db && typeof db.close === "function") db.close();
		dialog.remove();
	}

	render();
	return {
		element: dialog,
		open,
		close,
		destroy,
		bindTriggers,
		resume,
		ready,
		flush: () => saveChain,
		send: () => send(),
		retry: () => retry(),
		state: () => ({ ...state, removed: [...state.removed], retired: state.retired.map((entry) => ({ ...entry })), open: dialogOpenState, draftId, draftRevision, storeId: caps ? caps.storeId : null }),
		receipts: () => Array.from(receipts.entries()).map(([requestId, value]) => ({ requestId, receipt: value })),
		log: () => log.slice(),
	};
}
