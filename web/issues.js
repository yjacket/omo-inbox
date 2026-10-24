/* 제보함: the issue list (/issues), detail (/issues/<uuid>) and the standalone fallback composer
 * (/issues/new). One page, one script; the route is chosen from location.pathname.
 *
 * Everything above mountIssues() is a pure, exported view model with no DOM, tested in
 * test/issues-view-model.test.mjs. It maps store responses to render state and keeps two truths:
 * a source crop or a reproduction is never labelled as the owner's original screenshot, and a
 * correction commit or build is never labelled as installed. A correction check is shown as
 * 확인됨 (the build or Review revision matched what the server knew at acceptance) or 미확인.
 *
 * The DOM part renders every reported string through textContent; no markup is built from data.
 * Every owner mutation sends expectedSeq from the latest detail read with a fresh requestId, then
 * re-reads the detail. A mutation counts as accepted only by a verified receipt (mutationReceipt):
 * a conflict or an uncertain result keeps the typed text and the selected image, and an uncertain
 * one is resolved by the detail read or by replaying the same envelope. The owner's controls are
 * mounted once per issue and survive every refresh. A purged issue renders the 410 state without
 * any content bytes. /issues/new mounts the shared reporter (web/issue-report.js) with no source.
 *
 * issueBadgeFromCounts() is the badge data the existing pages (wave D) consume: needs-check only.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHORT_HASH = 12;
const UNKNOWN = "미확인";

export const LIST_LIMIT = 50;
export const EVENT_PAGE_LIMIT = 100;
export const DETAIL_PAGE_CAP = 50;
export const DEFAULT_LIMITS = Object.freeze({ DESCRIPTION_BYTES: 8192, COMMENT_BYTES: 4096, NOTE_BYTES: 4096, QUERY_BYTES: 200 });

export const STATE_FILTERS = Object.freeze(["open", "investigating", "needs-check", "resolved"]);
export const STATE_LABELS = Object.freeze({
	open: "접수",
	investigating: "조사 중",
	"needs-check": "확인 요청",
	resolved: "해결",
	tombstone: "삭제됨",
});
export const CATEGORY_LABELS = Object.freeze({ "inbox-ui": "Inbox 화면", "report-content": "보고 내용", other: "기타" });
export const SEVERITY_LABELS = Object.freeze({ normal: "보통", high: "높음", low: "낮음" });
export const PAGE_LABELS = Object.freeze({ inbox: "Inbox", thread: "대화", boards: "Review 목록", proposal: "Review", issues: "제보함", other: "기타" });
export const THEME_LABELS = Object.freeze({ light: "밝은 화면", dark: "어두운 화면", unknown: "화면 모드 미확인" });
export const CONTEXT_LABELS = Object.freeze({ captured: "맥락 담김", partial: "맥락 일부", unavailable: "맥락 없음" });
/* Owner-supplied evidence keeps its own name; a crop of stored source assets and a maintainer's
 * reproduction are reconstructions and say so. None of them is called the original screenshot. */
export const PROVENANCE_LABELS = Object.freeze({
	display_capture: "화면 캡처",
	user_upload: "올린 사진",
	source_asset_crop: "출처 자료 일부",
	reproduction: "재현 화면",
});
export const RECONSTRUCTED_PROVENANCES = Object.freeze(["source_asset_crop", "reproduction"]);
export const RECONSTRUCTED_NOTE = "원본 화면 아님";
export const MATCH_LABELS = Object.freeze({ unverified: "출처 일치 미확인", user_confirmed: "출처 일치 사용자 확인" });
export const NONE_REASON_LABELS = Object.freeze({
	not_requested: "사진 없음",
	unsupported: "캡처 미지원",
	denied: "캡처 거부",
	failed: "캡처 실패",
	removed: "사진 지움",
});
export const REFERENCE_LABELS = Object.freeze({ matched: "일치", missing: "없음", mismatch: "불일치", unversioned: "버전 없음" });
/* The check label is binary on purpose: it reports a comparison the server made, never a deploy. */
export const CHECK_LABELS = Object.freeze({ matched: "확인됨", missing: UNKNOWN, mismatch: UNKNOWN, unversioned: UNKNOWN });
export const EVENT_LABELS = Object.freeze({
	created: "접수",
	triage: "분류",
	comment: "의견",
	append_evidence: "사진 추가",
	request_check: "수정안 확인 요청",
	confirm: "해결 확인",
	reopen: "다시 열기",
	purge: "삭제",
});
export const ACTOR_LABELS = Object.freeze({ owner: "제보자", maintainer: "담당" });

const encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

export function utf8Length(text) {
	if (typeof text !== "string") return 0;
	if (encoder) return encoder.encode(text).length;
	let bytes = 0;
	for (const char of text) {
		const code = char.codePointAt(0);
		bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}

export function isUuid(value) {
	return typeof value === "string" && UUID_RE.test(value);
}

export function shortHash(value) {
	return typeof value === "string" && SHA256_RE.test(value) ? value.slice(0, SHORT_HASH) : UNKNOWN;
}

/** `M월 D일 HH:MM` in local time, the same shape the other pages print; "" for a bad timestamp. */
export function formatStamp(iso) {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const date = new Date(at);
	const two = (n) => String(n).padStart(2, "0");
	return `${date.getMonth() + 1}월 ${date.getDate()}일 ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Relative time as the Inbox list prints it; nowMs is injected so tests never read the clock. */
export function formatAgo(iso, nowMs) {
	const at = Date.parse(iso);
	if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return "";
	const minutes = Math.floor(Math.max(0, nowMs - at) / 60000);
	if (minutes < 1) return "방금";
	if (minutes < 60) return `${minutes}분 전`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}시간 전`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}일 전`;
	const date = new Date(at);
	return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

/* ---------- routes and list queries ---------- */

export function routeFromPath(pathname) {
	const clean = typeof pathname === "string" ? pathname.replace(/\/+$/, "") || "/" : "/";
	if (clean === "/issues") return { kind: "list", id: null };
	if (clean === "/issues/new") return { kind: "new", id: null };
	const match = /^\/issues\/([^/]+)$/.exec(clean);
	if (match && isUuid(match[1])) return { kind: "detail", id: match[1] };
	return { kind: "unknown", id: null };
}

export function listQueryFromSearch(search) {
	const params = new URLSearchParams(typeof search === "string" ? search : "");
	const q = (params.get("q") ?? "").trim();
	const state = params.get("state");
	return { q, state: STATE_FILTERS.includes(state) ? state : null };
}

export function listLocationSearch(query) {
	const params = new URLSearchParams();
	if (query && typeof query.q === "string" && query.q.trim() !== "") params.set("q", query.q.trim());
	if (query && STATE_FILTERS.includes(query.state)) params.set("state", query.state);
	const text = params.toString();
	return text === "" ? "" : `?${text}`;
}

export function listRequestPath({ q = "", state = null, cursor = null, limit = LIST_LIMIT } = {}) {
	const params = new URLSearchParams();
	if (STATE_FILTERS.includes(state)) params.set("state", state);
	if (typeof q === "string" && q.trim() !== "") params.set("q", q.trim());
	if (typeof cursor === "string" && cursor !== "") params.set("cursor", cursor);
	params.set("limit", String(limit));
	return `/api/issues?${params.toString()}`;
}

export function detailRequestPath(id, { after = 0, limit = EVENT_PAGE_LIMIT } = {}) {
	if (!isUuid(id)) throw new TypeError("detailRequestPath needs an issue id");
	return `/api/issues/${id}?after=${after}&limit=${limit}`;
}

export function evidenceImagePath(id, captureId) {
	if (!isUuid(id) || !isUuid(captureId)) return null;
	return `/api/issues/${id}/evidence/${captureId}/image`;
}

export function feedbackPath(id) {
	if (!isUuid(id)) throw new TypeError("feedbackPath needs an issue id");
	return `/api/issues/${id}/feedback`;
}

/* ---------- list ---------- */

function listRow(item, nowMs) {
	const id = isUuid(item?.id) ? item.id : null;
	const state = typeof item?.state === "string" && STATE_LABELS[item.state] ? item.state : "open";
	return {
		id,
		href: id ? `/issues/${id}` : null,
		title: typeof item?.title === "string" && item.title.trim() !== "" ? item.title : "(제목 없음)",
		state,
		stateLabel: STATE_LABELS[state],
		category: item?.category ?? "other",
		categoryLabel: CATEGORY_LABELS[item?.category] ?? CATEGORY_LABELS.other,
		severity: item?.severity ?? "normal",
		severityLabel: SEVERITY_LABELS[item?.severity] ?? SEVERITY_LABELS.normal,
		createdAt: typeof item?.createdAt === "string" ? item.createdAt : null,
		updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : null,
		updatedLabel: typeof item?.updatedAt === "string" ? formatAgo(item.updatedAt, nowMs) : "",
	};
}

export function listViewModel(response, { query = { q: "", state: null }, nowMs = 0 } = {}) {
	const items = Array.isArray(response?.items) ? response.items : [];
	const counts = {};
	let total = 0;
	for (const state of STATE_FILTERS) {
		const value = response?.counts && Number.isSafeInteger(response.counts[state]) && response.counts[state] >= 0 ? response.counts[state] : 0;
		counts[state] = value;
		total += value;
	}
	const rows = items.map((item) => listRow(item, nowMs)).filter((row) => row.id !== null);
	const q = typeof query?.q === "string" ? query.q.trim() : "";
	const state = STATE_FILTERS.includes(query?.state) ? query.state : null;
	let emptyText = null;
	if (rows.length === 0) {
		if (q !== "") emptyText = "검색 결과가 없습니다";
		else if (state !== null) emptyText = `${STATE_LABELS[state]} 상태의 제보가 없습니다`;
		else emptyText = "제보가 없습니다";
	}
	return {
		rows,
		counts,
		total,
		filters: [
			{ value: null, label: "전체", count: total, selected: state === null },
			...STATE_FILTERS.map((value) => ({ value, label: STATE_LABELS[value], count: counts[value], selected: state === value })),
		],
		query: { q, state },
		nextCursor: typeof response?.nextCursor === "string" && response.nextCursor !== "" ? response.nextCursor : null,
		emptyText,
		badge: issueBadgeFromCounts(counts),
	};
}

/** Badge data for the header 제보함 link: needs-check only, nothing from Review or 내 차례. */
export function issueBadgeFromCounts(counts) {
	const raw = counts && typeof counts === "object" ? counts["needs-check"] : 0;
	const count = Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
	return {
		count,
		hidden: count === 0,
		text: count === 0 ? "" : count > 99 ? "99+" : String(count),
		label: count === 0 ? "" : `확인 요청 ${count}건`,
	};
}

/* ---------- detail ---------- */

export function mergeDetailPages(pages) {
	if (!Array.isArray(pages) || pages.length === 0) throw new TypeError("mergeDetailPages needs at least one page");
	const last = pages[pages.length - 1];
	const events = [];
	const evidence = [];
	const seenEvents = new Set();
	const seenCaptures = new Set();
	for (const page of pages) {
		for (const event of Array.isArray(page?.events) ? page.events : []) {
			if (seenEvents.has(event.seq)) continue;
			seenEvents.add(event.seq);
			events.push(event);
		}
		for (const manifest of Array.isArray(page?.evidence) ? page.evidence : []) {
			if (seenCaptures.has(manifest.captureId)) continue;
			seenCaptures.add(manifest.captureId);
			evidence.push(manifest);
		}
	}
	events.sort((a, b) => a.seq - b.seq);
	evidence.sort((a, b) => a.seq - b.seq);
	return { ...last, events, evidence, nextAfter: null };
}

export function sourceLink(source) {
	if (!source || typeof source !== "object") return { kind: null, label: "없음", href: null };
	if (source.kind === "proposal") {
		const id = String(source.proposalId ?? "");
		return { kind: "proposal", label: `Review ${id} r${source.revision}`, href: `/p/${encodeURIComponent(id)}` };
	}
	if (source.kind === "thread") {
		const id = String(source.threadId ?? "");
		return { kind: "thread", label: `대화 ${id}${source.itemId ? ` · ${source.itemId}` : ""}`, href: `/s/${encodeURIComponent(id)}` };
	}
	if (source.kind === "issue") {
		const id = String(source.issueId ?? "");
		return { kind: "issue", label: `제보 ${shortHash(id) === UNKNOWN ? id.slice(0, 8) : id}`, href: isUuid(id) ? `/issues/${id}` : null };
	}
	return { kind: null, label: "없음", href: null };
}

export function correctionView(correction) {
	if (!correction || typeof correction !== "object") return null;
	const summary = typeof correction.summary === "string" ? correction.summary : "";
	if (correction.kind === "inbox-build") {
		return {
			kind: "inbox-build",
			label: `Inbox 빌드 ${shortHash(correction.buildId)}`,
			buildId: typeof correction.buildId === "string" ? correction.buildId : null,
			summary,
			href: null,
		};
	}
	if (correction.kind === "review-artifact") {
		const id = String(correction.proposalId ?? "");
		return {
			kind: "review-artifact",
			label: `Review ${id} r${correction.revision}`,
			buildId: null,
			summary,
			href: `/p/${encodeURIComponent(id)}`,
		};
	}
	return { kind: "unknown", label: UNKNOWN, buildId: null, summary, href: null };
}

/* What the server compared, in words that never claim a deploy or an install. */
export function checkView(check, correction) {
	if (!check || typeof check !== "object") return { status: null, label: UNKNOWN, detail: "서버 확인 기록 없음" };
	const status = typeof check.status === "string" && CHECK_LABELS[check.status] ? check.status : "unversioned";
	const review = correction && correction.kind === "review-artifact";
	let detail;
	if (status === "matched") detail = review ? "저장된 Review 수정본과 일치" : "접수 당시 서버 빌드와 일치";
	else if (status === "mismatch") detail = review ? "저장된 Review 수정본과 다름" : "서버 빌드와 다름";
	else if (status === "missing") detail = review ? "저장된 Review 수정본 없음" : "서버 빌드 없음";
	else detail = review ? "Review 수정본을 비교하지 못함" : "일치하는 서버 빌드 없음";
	return { status, label: CHECK_LABELS[status], detail, checkedAt: typeof check.checkedAt === "string" ? check.checkedAt : null };
}

function viewLabel(view) {
	if (!view || typeof view !== "object") return "";
	const parts = [];
	if (Number.isFinite(view.width) && Number.isFinite(view.height)) parts.push(`${view.width}×${view.height}`);
	if (Number.isFinite(view.dpr)) parts.push(`${view.dpr}x`);
	parts.push(THEME_LABELS[view.theme] ?? THEME_LABELS.unknown);
	if (view.embedded === true) parts.push("내장 화면");
	if (view.viewerOpen === true) parts.push("전체 화면 열림");
	return parts.join(" · ");
}

export function evidenceView(manifest, issueId) {
	const context = manifest?.context && typeof manifest.context === "object" ? manifest.context : {};
	const visual = manifest?.visual && typeof manifest.visual === "object" ? manifest.visual : { kind: "none", reason: "not_requested" };
	const captureId = isUuid(manifest?.captureId) ? manifest.captureId : null;
	const raster = visual.kind === "raster";
	const provenance = raster && PROVENANCE_LABELS[visual.provenance] ? visual.provenance : null;
	const reconstructed = provenance !== null && RECONSTRUCTED_PROVENANCES.includes(provenance);
	const target = context.target && typeof context.target === "object" ? context.target : null;
	return {
		captureId,
		seq: Number.isSafeInteger(manifest?.seq) ? manifest.seq : null,
		kind: raster ? "raster" : "none",
		provenance,
		provenanceLabel: raster ? (PROVENANCE_LABELS[visual.provenance] ?? UNKNOWN) : (NONE_REASON_LABELS[visual.reason] ?? NONE_REASON_LABELS.not_requested),
		reconstructed,
		note: reconstructed ? RECONSTRUCTED_NOTE : null,
		matchLabel: raster ? (MATCH_LABELS[visual.sourceMatchesContext] ?? MATCH_LABELS.unverified) : null,
		imageHref: raster && captureId ? evidenceImagePath(issueId, captureId) : null,
		width: raster && Number.isSafeInteger(visual.width) ? visual.width : null,
		height: raster && Number.isSafeInteger(visual.height) ? visual.height : null,
		masks: raster && Array.isArray(visual.masks) ? visual.masks.length : 0,
		marks: raster && Array.isArray(visual.marks) ? visual.marks.length : 0,
		acquiredAt: raster && typeof visual.acquiredAt === "string" ? visual.acquiredAt : null,
		observedAt: typeof manifest?.observedAt === "string" ? manifest.observedAt : null,
		acceptedAt: typeof manifest?.acceptedAt === "string" ? manifest.acceptedAt : null,
		pageLabel: PAGE_LABELS[context.page] ?? PAGE_LABELS.other,
		contextStatus: CONTEXT_LABELS[context.contextStatus] ? context.contextStatus : "unavailable",
		contextLabel: CONTEXT_LABELS[context.contextStatus] ?? CONTEXT_LABELS.unavailable,
		viewLabel: viewLabel(context.view),
		targetLabel: target && typeof target.label === "string" ? target.label : null,
		excerpt: typeof context.excerpt === "string" ? context.excerpt : null,
		excerptTruncated: context.excerptTruncated === true,
		visibleIds: Array.isArray(context.visibleIds) ? context.visibleIds.length : 0,
		diagnostics: Array.isArray(context.diagnostics) ? context.diagnostics.length : 0,
		referenceLabel: REFERENCE_LABELS[manifest?.referenceCheck?.status] ?? null,
		clientBuild: manifest?.clientBuild && typeof manifest.clientBuild === "object" ? manifest.clientBuild : null,
		serverBuild: typeof manifest?.serverBuild === "string" ? manifest.serverBuild : null,
	};
}

function historyText(event) {
	const command = event?.command && typeof event.command === "object" ? event.command : null;
	if (!command) return null;
	if (command.type === "comment") return typeof command.text === "string" ? command.text : null;
	if (command.type === "reopen") return typeof command.comment === "string" ? command.comment : null;
	if (command.type === "triage" || command.type === "append_evidence" || command.type === "request_check") {
		return typeof command.note === "string" ? command.note : null;
	}
	return null;
}

export function historyEntry(event) {
	const type = typeof event?.type === "string" && EVENT_LABELS[event.type] ? event.type : "comment";
	const actor = ACTOR_LABELS[event?.actor] ? event.actor : "owner";
	const command = event?.command && typeof event.command === "object" ? event.command : null;
	const correction = type === "request_check" ? correctionView(command?.correction) : null;
	const triage = type === "triage" && command
		? `${CATEGORY_LABELS[command.category] ?? CATEGORY_LABELS.other} · ${SEVERITY_LABELS[command.severity] ?? SEVERITY_LABELS.normal}`
		: null;
	let label = EVENT_LABELS[type];
	if (type === "comment" && actor === "maintainer") label = "담당 의견";
	return {
		seq: Number.isSafeInteger(event?.seq) ? event.seq : null,
		type,
		label,
		actor,
		actorLabel: ACTOR_LABELS[actor],
		readOnly: actor === "maintainer",
		acceptedAt: typeof event?.acceptedAt === "string" ? event.acceptedAt : null,
		state: typeof event?.state === "string" ? event.state : null,
		stateLabel: STATE_LABELS[event?.state] ?? null,
		text: historyText(event),
		triage,
		correction,
		check: type === "request_check" ? checkView(event?.correctionCheck, correction) : null,
		captureId: isUuid(event?.evidenceManifest?.captureId) ? event.evidenceManifest.captureId : null,
		serverBuild: typeof event?.serverBuild === "string" ? event.serverBuild : null,
	};
}

export function ownerActions(state) {
	return {
		comment: true,
		append: true,
		confirm: state === "needs-check",
		reopen: state === "needs-check" || state === "resolved",
		purge: true,
	};
}

export function purgeConfirmText(title) {
	const name = typeof title === "string" && title.trim() !== "" ? title.trim() : "(제목 없음)";
	return `"${name}" 제보를 삭제합니다. 설명, 맥락, 사진이 모두 사라지고 되돌릴 수 없습니다.`;
}

export function detailViewModel(detail, { loadedBuild = null, nowMs = 0 } = {}) {
	if (!detail || typeof detail !== "object" || !detail.issue || typeof detail.issue !== "object") {
		throw new TypeError("detailViewModel needs a detail response");
	}
	const issue = detail.issue;
	const id = isUuid(issue.id) ? issue.id : null;
	const state = STATE_LABELS[detail.state] ? detail.state : "open";
	const events = (Array.isArray(detail.events) ? [...detail.events] : []).sort((a, b) => a.seq - b.seq);
	const manifests = (Array.isArray(detail.evidence) ? [...detail.evidence] : []).sort((a, b) => a.seq - b.seq);
	const history = events.map(historyEntry);
	const evidence = manifests.map((manifest) => evidenceView(manifest, id));
	const original = evidence.find((entry) => entry.seq === 1) ?? evidence[0] ?? null;
	const createdEvent = events.find((event) => event.type === "created") ?? null;
	const lastCheck = [...history].reverse().find((entry) => entry.type === "request_check") ?? null;
	const lastConfirm = [...history].reverse().find((entry) => entry.type === "confirm") ?? null;
	const reopenedAfterConfirm = lastConfirm ? history.some((entry) => entry.type === "reopen" && entry.seq > lastConfirm.seq) : false;
	const serverBuild = typeof detail.capabilities?.build?.buildId === "string" && SHA256_RE.test(detail.capabilities.build.buildId)
		? detail.capabilities.build.buildId
		: null;
	const loaded = typeof loadedBuild === "string" && SHA256_RE.test(loadedBuild) ? loadedBuild : null;
	const source = sourceLink(issue.source);
	const referenceStatus = original?.referenceLabel ?? null;
	const limits = detail.capabilities?.limits && typeof detail.capabilities.limits === "object" ? { ...DEFAULT_LIMITS, ...detail.capabilities.limits } : { ...DEFAULT_LIMITS };

	const rows = [
		{ key: "observed", label: "관찰 시각", value: original?.observedAt ? formatStamp(original.observedAt) : UNKNOWN, note: null, href: null },
		{
			key: "observedBuild",
			label: "관찰 빌드",
			value: original?.clientBuild ? `${original.clientBuild.version ? `${original.clientBuild.version} · ` : ""}${shortHash(original.clientBuild.digest)}` : UNKNOWN,
			note: original?.clientBuild ? "페이지 응답 시점의 서버 매니페스트" : null,
			href: null,
		},
		{ key: "accepted", label: "접수 시각", value: createdEvent?.acceptedAt ? formatStamp(createdEvent.acceptedAt) : (issue.createdAt ? formatStamp(issue.createdAt) : UNKNOWN), note: null, href: null },
		{ key: "acceptedBuild", label: "접수 빌드", value: shortHash(original?.serverBuild ?? createdEvent?.serverBuild ?? null), note: null, href: null },
		{ key: "source", label: "출처", value: source.label, note: referenceStatus ? `기록 비교 ${referenceStatus}` : null, href: source.href },
		{
			key: "correction",
			label: "수정안",
			value: lastCheck?.correction ? `${lastCheck.correction.label}${lastCheck.correction.summary ? ` · ${lastCheck.correction.summary}` : ""}` : "없음",
			note: lastCheck?.acceptedAt ? formatStamp(lastCheck.acceptedAt) : null,
			href: lastCheck?.correction?.href ?? null,
		},
		{
			key: "appliedBuild",
			label: "수정안 확인",
			value: lastCheck ? lastCheck.check.label : "없음",
			note: lastCheck ? lastCheck.check.detail : null,
			href: null,
		},
		{
			key: "confirmed",
			label: "사용자 확인",
			value: lastConfirm?.acceptedAt ? formatStamp(lastConfirm.acceptedAt) : "없음",
			note: reopenedAfterConfirm ? "이후 다시 열림" : null,
			href: null,
		},
		{
			key: "pageBuild",
			label: "이 화면 빌드",
			value: shortHash(loaded),
			note: loaded && serverBuild ? (loaded === serverBuild ? "서버 빌드와 같음" : `서버 빌드 ${shortHash(serverBuild)}와 다름`) : null,
			href: null,
		},
	];

	return {
		id,
		storeId: typeof issue.storeId === "string" ? issue.storeId : null,
		title: typeof issue.title === "string" && issue.title.trim() !== "" ? issue.title : "(제목 없음)",
		description: typeof issue.description === "string" ? issue.description : "",
		state,
		stateLabel: STATE_LABELS[state],
		currentSeq: Number.isSafeInteger(detail.currentSeq) ? detail.currentSeq : events.length,
		createdAt: typeof issue.createdAt === "string" ? issue.createdAt : null,
		createdLabel: typeof issue.createdAt === "string" ? formatAgo(issue.createdAt, nowMs) : "",
		source: { ...source, referenceLabel: referenceStatus },
		rows,
		evidence,
		history,
		actions: ownerActions(state),
		build: { loaded, server: serverBuild, differs: Boolean(loaded && serverBuild && loaded !== serverBuild) },
		limits,
		purgeText: purgeConfirmText(issue.title),
	};
}

/* ---------- errors and envelopes ---------- */

export function errorViewModel(status, body) {
	const code = body && typeof body === "object" && typeof body.error === "string" ? body.error : null;
	const fields = body && typeof body === "object" && Array.isArray(body.fields) ? body.fields.filter((field) => typeof field === "string") : [];
	const currentSeq = body && typeof body === "object" && Number.isSafeInteger(body.currentSeq) ? body.currentSeq : null;
	const state = body && typeof body === "object" && STATE_LABELS[body.state] ? body.state : null;
	let text;
	if (!Number.isFinite(status) || status === 0) text = "연결하지 못했습니다";
	else if (code === "version_conflict") text = `다른 변경이 먼저 반영되었습니다 (현재 순번 ${currentSeq ?? "?"}${state ? `, ${STATE_LABELS[state]}` : ""})`;
	else if (code === "key_reused") text = "같은 요청 번호가 다른 내용으로 쓰였습니다";
	else if (code === "store_changed") text = "저장소가 바뀌었습니다. 새로 고침 뒤 다시 시도해 주세요";
	else if (code === "invalid_transition") text = `지금 상태${state ? `(${STATE_LABELS[state]})` : ""}에서는 할 수 없습니다`;
	else if (status === 400) text = `입력이 올바르지 않습니다${fields.length ? ` (${fields.join(", ")})` : ""}`;
	else if (status === 403) text = "권한이 없습니다";
	else if (status === 404) text = "없는 제보입니다";
	else if (status === 410) text = "삭제된 제보입니다";
	else if (status === 413) text = "첨부가 너무 큽니다";
	else if (code === "corrupt_record") text = "기록이 손상되었습니다";
	else if (status === 503) text = "저장소가 잠겨 있습니다";
	else if (status >= 500) text = `서버 오류 (${status})`;
	else text = `요청 실패 (${status})`;
	return { status: Number.isFinite(status) ? status : 0, code, fields, currentSeq, state, text };
}

export function commandEnvelope({ storeId, requestId, expectedSeq, command }) {
	if (!isUuid(storeId)) throw new TypeError("commandEnvelope needs the store id");
	if (!isUuid(requestId)) throw new TypeError("commandEnvelope needs a fresh request id");
	if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 1) throw new TypeError("commandEnvelope needs the current sequence");
	if (!command || typeof command !== "object" || typeof command.type !== "string") throw new TypeError("commandEnvelope needs a command");
	return { v: 1, storeId, requestId, expectedSeq, command };
}

export function ownerCommand(type, payload = {}) {
	if (type === "comment") return { type, text: String(payload.text ?? "").trim() };
	if (type === "reopen") {
		const comment = typeof payload.comment === "string" ? payload.comment.trim() : "";
		return { type, comment: comment === "" ? null : comment };
	}
	if (type === "append_evidence") {
		const note = typeof payload.note === "string" ? payload.note.trim() : "";
		return { type, evidence: payload.evidence, note: note === "" ? null : note };
	}
	if (type === "confirm" || type === "purge") return { type };
	throw new TypeError(`unknown owner command ${type}`);
}

export function textCheck(text, limitBytes) {
	const trimmed = typeof text === "string" ? text.trim() : "";
	const bytes = utf8Length(trimmed);
	if (bytes < 1) return { ok: false, reason: "empty", bytes };
	if (bytes > limitBytes) return { ok: false, reason: "too_long", bytes };
	return { ok: true, reason: null, bytes };
}

export function clientBuildFromStamp(stamp) {
	return typeof stamp === "string" && SHA256_RE.test(stamp) ? { kind: "page_response_manifest", version: null, digest: stamp } : null;
}

/** Evidence set for an owner's appended image: the issue itself is the source, observed now. */
export function appendEvidenceFor({ issueId, currentSeq, visual, view, clientBuild = null, uuid, now }) {
	if (typeof uuid !== "function" || typeof now !== "function") throw new TypeError("appendEvidenceFor needs uuid() and now()");
	if (!isUuid(issueId) || !Number.isSafeInteger(currentSeq) || currentSeq < 0) throw new TypeError("appendEvidenceFor needs the issue id and sequence");
	if (!visual || visual.kind !== "raster") throw new TypeError("appendEvidenceFor needs a raster visual");
	const at = now();
	const observedAt = new Date(typeof at === "number" ? at : Date.parse(String(at))).toISOString();
	const safe = view && typeof view === "object" ? view : {};
	return {
		captureId: uuid(),
		observedAt,
		page: "issues",
		source: { kind: "issue", issueId, observedSeq: currentSeq },
		target: null,
		clientBuild,
		view: {
			width: Number.isFinite(safe.width) && safe.width > 0 ? safe.width : 1,
			height: Number.isFinite(safe.height) && safe.height > 0 ? safe.height : 1,
			dpr: Number.isFinite(safe.dpr) && safe.dpr > 0 ? safe.dpr : 1,
			scale: 1,
			scrollX: Number.isFinite(safe.scrollX) ? safe.scrollX : 0,
			scrollY: Number.isFinite(safe.scrollY) ? safe.scrollY : 0,
			theme: THEME_LABELS[safe.theme] ? safe.theme : "unknown",
			locale: typeof safe.locale === "string" && /^[A-Za-z0-9-]{1,35}$/.test(safe.locale) ? safe.locale : "ko-KR",
			embedded: false,
			viewerOpen: false,
		},
		excerpt: null,
		excerptTruncated: false,
		visibleIds: [],
		diagnostics: [],
		contextStatus: "captured",
		visual,
	};
}

/* ---------- receipts: what counts as accepted ---------- */

/**
 * A mutation is accepted only by a verified receipt: a 2xx whose body says ok:true for the same
 * issue (and store, when known), whose receipt names the requestId we sent with an integer seq
 * and a parseable acceptedAt, with an integer currentSeq and a known state. Anything else is not
 * an acceptance: no response is "network", a non-2xx is "rejected", and a 2xx with any other body
 * is "malformed". Network and malformed are uncertain for the caller: the server may have committed.
 */
export function mutationReceipt(status, body, expected) {
	if (!expected || !isUuid(expected.requestId) || !isUuid(expected.id)) throw new TypeError("mutationReceipt needs the expected requestId and id");
	const code = Number.isFinite(status) ? status : 0;
	if (code === 0) return { ok: false, code: "network", status: 0 };
	if (code < 200 || code >= 300) return { ok: false, code: "rejected", status: code };
	const malformed = { ok: false, code: "malformed", status: code };
	if (!body || typeof body !== "object" || Array.isArray(body)) return malformed;
	if (body.ok !== true || body.id !== expected.id) return malformed;
	if (isUuid(expected.storeId) && body.storeId !== expected.storeId) return malformed;
	const receipt = body.receipt;
	if (!receipt || typeof receipt !== "object" || receipt.requestId !== expected.requestId) return malformed;
	if (!Number.isSafeInteger(receipt.seq) || receipt.seq < 1) return malformed;
	if (typeof receipt.acceptedAt !== "string" || !Number.isFinite(Date.parse(receipt.acceptedAt))) return malformed;
	if (!Number.isSafeInteger(body.currentSeq) || body.currentSeq < receipt.seq) return malformed;
	if (!STATE_LABELS[body.state]) return malformed;
	return {
		ok: true,
		id: body.id,
		receipt: { requestId: receipt.requestId, seq: receipt.seq, acceptedAt: receipt.acceptedAt },
		currentSeq: body.currentSeq,
		state: body.state,
	};
}

const UNCERTAIN_TEXT = Object.freeze({
	network: "연결하지 못했습니다 · 접수 확인 중",
	malformed: "응답을 확인하지 못했습니다 · 접수 확인 중",
});

/**
 * How the page treats one attempt: "accepted" (verified receipt), "conflict" (409 version_conflict
 * with the current sequence and state to show), "rejected" (any other error) or "uncertain" (no
 * response or a malformed success). Only "accepted" may clear what the owner typed or selected.
 */
export function mutationOutcome(status, body, expected) {
	const receipt = mutationReceipt(status, body, expected);
	if (receipt.ok) return { kind: "accepted", reason: null, receipt: receipt.receipt, currentSeq: receipt.currentSeq, state: receipt.state, error: null, text: null };
	if (receipt.code === "rejected") {
		const error = errorViewModel(receipt.status, body);
		if (receipt.status === 409 && error.code === "version_conflict") return { kind: "conflict", reason: error.code, receipt: null, currentSeq: error.currentSeq, state: error.state, error, text: error.text };
		return { kind: "rejected", reason: error.code, receipt: null, currentSeq: null, state: null, error, text: error.text };
	}
	return { kind: "uncertain", reason: receipt.code, receipt: null, currentSeq: null, state: null, error: errorViewModel(receipt.status, body), text: UNCERTAIN_TEXT[receipt.code] };
}

/** The committed event for a request in a detail read, or null: resolves an uncertain send without a replay. */
export function committedEvent(detail, requestId) {
	if (!isUuid(requestId)) return null;
	const events = Array.isArray(detail?.events) ? detail.events : [];
	const event = events.find((entry) => entry && typeof entry === "object" && entry.requestId === requestId);
	if (!event || !Number.isSafeInteger(event.seq)) return null;
	return {
		seq: event.seq,
		type: typeof event.type === "string" ? event.type : null,
		acceptedAt: typeof event.acceptedAt === "string" ? event.acceptedAt : null,
		state: STATE_LABELS[event.state] ? event.state : null,
	};
}

/* ====================================================================================
 * DOM controller. Nothing below is imported by tests; it only runs inside web/issues.html.
 * ==================================================================================== */

const POST_HEADERS = Object.freeze({ "content-type": "application/json", "x-inbox": "1" });

export async function mountIssues({ document, window, fetchImpl, now, uuid, importModule } = {}) {
	if (!document || !window) throw new TypeError("mountIssues needs document and window");
	const app = document.getElementById("issues-app");
	if (!app) throw new TypeError("mountIssues needs #issues-app");
	const doFetch = typeof fetchImpl === "function" ? fetchImpl : (input, init) => window.fetch(input, init);
	const nowMs = typeof now === "function" ? now : () => Date.now();
	const freshId = typeof uuid === "function" ? uuid : () => window.crypto.randomUUID();
	const load = typeof importModule === "function" ? importModule : (specifier) => import(specifier);
	const heading = document.getElementById("issues-title");
	const back = document.getElementById("issues-back");
	const badge = document.getElementById("issues-badge");
	const newLink = document.getElementById("issues-new");
	const stampMeta = document.querySelector('meta[name="inbox-build"]');
	const loadedBuild = stampMeta && SHA256_RE.test(stampMeta.content ?? "") ? stampMeta.content : null;
	let renders = 0;

	function h(tag, attrs = null, children = []) {
		const el = document.createElement(tag);
		if (attrs) {
			for (const [key, value] of Object.entries(attrs)) {
				if (value === null || value === undefined || value === false) continue;
				if (key === "class") el.className = value;
				else if (key === "text") el.textContent = value;
				else el.setAttribute(key, value === true ? "" : String(value));
			}
		}
		for (const child of Array.isArray(children) ? children : [children]) {
			if (child === null || child === undefined || child === false) continue;
			el.append(typeof child === "string" ? document.createTextNode(child) : child);
		}
		return el;
	}

	function rendered(route, extra = {}) {
		renders += 1;
		app.dataset.route = route;
		app.dataset.render = String(renders);
		for (const [key, value] of Object.entries(extra)) {
			if (value === null || value === undefined) delete app.dataset[key];
			else app.dataset[key] = String(value);
		}
	}

	function setBadge(counts) {
		if (!badge) return;
		const data = issueBadgeFromCounts(counts);
		badge.textContent = data.text;
		badge.hidden = data.hidden;
		badge.setAttribute("aria-label", data.label);
	}

	function setHeader({ title, backHref, backText, showNew }) {
		if (heading) heading.textContent = title;
		if (back) {
			back.href = backHref;
			back.textContent = backText;
		}
		if (newLink) newLink.hidden = !showNew;
		document.title = title === "제보함" ? "제보함" : `${title} · 제보함`;
	}

	function chip(state) {
		return h("span", { class: `chip chip-${state}`, "data-state": state, text: STATE_LABELS[state] ?? state });
	}

	async function readJson(response) {
		try {
			return await response.json();
		} catch {
			return null;
		}
	}

	async function request(path, init = null) {
		let response;
		try {
			response = await doFetch(path, { cache: "no-store", ...(init ?? {}) });
		} catch {
			return { ok: false, status: 0, body: null, error: errorViewModel(0, null) };
		}
		const body = await readJson(response);
		if (!response.ok) return { ok: false, status: response.status, body, error: errorViewModel(response.status, body) };
		return { ok: true, status: response.status, body, error: null };
	}

	/* ---------- list ---------- */

	async function showList() {
		setHeader({ title: "제보함", backHref: "/", backText: "‹ Inbox", showNew: true });
		const query = listQueryFromSearch(window.location.search);
		const model = { query, rows: [], nextCursor: null };
		const search = h("input", { type: "search", id: "issue-search", name: "q", placeholder: "제목이나 설명 검색", autocomplete: "off", "aria-label": "검색", maxlength: "200" });
		search.value = query.q;
		const searchButton = h("button", { type: "submit", class: "ctl", text: "검색" });
		const form = h("form", { class: "search", role: "search" }, [search, searchButton]);
		const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "상태" });
		const filters = h("div", { class: "filters" }, [form, seg]);
		const notice = h("div", { class: "notice", role: "alert", hidden: true });
		const rows = h("div", { class: "rows", id: "issue-rows" });
		const empty = h("p", { class: "empty", hidden: true });
		const more = h("button", { type: "button", class: "ctl more", id: "issue-more", hidden: true, text: "더 보기" });
		app.replaceChildren(filters, notice, rows, empty, more);

		function renderFilters(view) {
			seg.replaceChildren();
			for (const filter of view.filters) {
				const input = h("input", { type: "radio", name: "state", value: filter.value ?? "" });
				input.checked = filter.selected;
				const label = h("label", null, [input, h("span", { text: filter.label }), h("span", { class: "count", text: String(filter.count) })]);
				input.addEventListener("change", () => {
					model.query = { ...model.query, state: filter.value };
					syncLocation();
					fetchPage(null);
				});
				seg.append(label);
			}
		}

		function rowElement(row) {
			const link = h("a", { class: "row", href: row.href, "data-id": row.id, "data-state": row.state }, [
				h("div", { class: "row-head" }, [h("span", { class: "title", text: row.title }), chip(row.state)]),
				h("time", { class: "when", datetime: row.updatedAt ?? "", text: row.updatedLabel }),
				h("div", { class: "meta" }, [
					h("span", { class: "where", text: row.categoryLabel }),
					h("span", { class: "where", text: `중요도 ${row.severityLabel}` }),
				]),
			]);
			return link;
		}

		function syncLocation() {
			const next = `${window.location.pathname}${listLocationSearch(model.query)}`;
			if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(null, "", next);
		}

		async function fetchPage(cursor) {
			const append = cursor !== null;
			app.dataset.loading = "list";
			more.disabled = true;
			const result = await request(listRequestPath({ q: model.query.q, state: model.query.state, cursor, limit: LIST_LIMIT }));
			delete app.dataset.loading;
			more.disabled = false;
			if (!result.ok) {
				notice.replaceChildren(h("span", { text: `목록을 불러오지 못했습니다 · ${result.error.text}` }), h("button", { type: "button", text: "다시 시도" }));
				notice.lastChild.addEventListener("click", () => fetchPage(null));
				notice.hidden = false;
				if (!append) {
					rows.replaceChildren();
					empty.hidden = true;
					more.hidden = true;
					model.rows = [];
					model.nextCursor = null;
				}
				rendered("list", { error: String(result.status), count: model.rows.length });
				return;
			}
			notice.hidden = true;
			const view = listViewModel(result.body, { query: model.query, nowMs: nowMs() });
			renderFilters(view);
			setBadge(view.counts);
			if (!append) {
				rows.replaceChildren();
				model.rows = [];
			}
			for (const row of view.rows) {
				rows.append(rowElement(row));
				model.rows.push(row);
			}
			model.nextCursor = view.nextCursor;
			more.hidden = model.nextCursor === null;
			const nothing = model.rows.length === 0;
			empty.textContent = nothing ? view.emptyText : "";
			empty.hidden = !nothing;
			rows.hidden = nothing;
			rendered("list", { error: null, count: model.rows.length, query: model.query.q, state: model.query.state ?? "" });
		}

		form.addEventListener("submit", (event) => {
			event.preventDefault();
			model.query = { ...model.query, q: search.value.trim() };
			syncLocation();
			fetchPage(null);
		});
		more.addEventListener("click", () => {
			if (model.nextCursor) fetchPage(model.nextCursor);
		});
		renderFilters(listViewModel({ items: [], counts: {}, nextCursor: null }, { query, nowMs: nowMs() }));
		await fetchPage(null);
	}

	/* ---------- detail ---------- */

	async function loadDetail(id) {
		const pages = [];
		let after = 0;
		for (let page = 0; page < DETAIL_PAGE_CAP; page++) {
			const result = await request(detailRequestPath(id, { after, limit: EVENT_PAGE_LIMIT }));
			if (!result.ok) return result;
			pages.push(result.body);
			if (!Number.isSafeInteger(result.body?.nextAfter)) break;
			after = result.body.nextAfter;
		}
		return { ok: true, status: 200, body: mergeDetailPages(pages), error: null };
	}

	async function showDetail(id) {
		setHeader({ title: "제보", backHref: "/issues", backText: "‹ 제보함", showNew: false });
		const model = { id, detail: null, view: null, panel: null, imageModule: null, editor: null, pending: null, busy: false };
		const notice = h("div", { class: "notice", role: "alert", hidden: true });
		const pendingBox = h("div", { class: "notice pending", id: "issue-pending", role: "status", hidden: true });
		const status = h("p", { class: "status", id: "issue-status", role: "status", "aria-live": "polite" });
		const article = h("article", { class: "detail", id: "issue-detail" });
		app.replaceChildren(notice, article, pendingBox, status);

		function setStatus(text, { error = false } = {}) {
			status.textContent = text;
			status.classList.toggle("error", error);
		}

		function locked() {
			return model.busy || model.pending !== null;
		}

		function releaseEditor() {
			if (model.editor) model.editor.release();
			model.editor = null;
			if (model.panel) {
				model.panel.editorHost.replaceChildren();
				model.panel.appendSend.disabled = true;
			}
		}

		function clearPending() {
			model.pending = null;
			pendingBox.hidden = true;
			pendingBox.replaceChildren();
			delete app.dataset.pending;
		}

		function renderGone(errorView) {
			releaseEditor();
			clearPending();
			article.replaceChildren(
				h("header", { class: "head" }, [h("h2", { class: "title", text: "삭제된 제보" }), chip("tombstone")]),
				h("p", { class: "gone", text: `${errorView.text}. 설명, 맥락, 사진은 남아 있지 않습니다.` }),
				h("a", { class: "ctl", href: "/issues", text: "제보함으로" }),
			);
			app.dataset.state = "tombstone";
			delete app.dataset.seq;
			rendered("detail", { error: String(errorView.status) });
		}

		function factRows(view) {
			const dl = h("dl", { class: "facts" });
			for (const row of view.rows) {
				const value = row.href
					? h("a", { href: row.href, text: row.value })
					: h("span", { text: row.value });
				dl.append(
					h("dt", { text: row.label }),
					h("dd", { "data-key": row.key }, [value, row.note ? h("small", { class: "note", text: row.note }) : null]),
				);
			}
			return dl;
		}

		function evidenceCards(view) {
			const list = h("div", { class: "evidence" });
			for (const entry of view.evidence) {
				const card = h("section", { class: "card ev", "data-capture": entry.captureId ?? "", "data-provenance": entry.provenance ?? "none" });
				const head = h("div", { class: "ev-head" }, [
					h("span", { class: "ev-label", text: entry.provenanceLabel }),
					entry.note ? h("span", { class: "chip chip-note", text: entry.note }) : null,
					entry.seq !== null ? h("span", { class: "seq", text: `#${entry.seq}` }) : null,
				]);
				card.append(head);
				if (entry.imageHref) {
					const img = h("img", { class: "ev-image", src: entry.imageHref, alt: `${entry.provenanceLabel} ${entry.width}×${entry.height}`, loading: "lazy", width: entry.width, height: entry.height });
					card.append(img);
					card.append(h("p", { class: "ev-meta", text: `${entry.width}×${entry.height} · 가림 ${entry.masks} · 표시 ${entry.marks} · ${entry.matchLabel}` }));
				}
				const facts = [
					`${entry.pageLabel} · ${entry.contextLabel}`,
					entry.viewLabel,
					entry.observedAt ? `관찰 ${formatStamp(entry.observedAt)}` : null,
					entry.acquiredAt ? `사진 ${formatStamp(entry.acquiredAt)}` : null,
					entry.targetLabel ? `위치 ${entry.targetLabel}` : null,
					entry.referenceLabel ? `출처 비교 ${entry.referenceLabel}` : null,
				].filter(Boolean);
				card.append(h("p", { class: "ev-meta", text: facts.join(" · ") }));
				if (entry.excerpt) {
					card.append(h("blockquote", { class: "excerpt", text: entry.excerpt }));
					if (entry.excerptTruncated) card.append(h("p", { class: "ev-meta", text: "발췌는 일부만 담겼습니다" }));
				}
				list.append(card);
			}
			if (view.evidence.length === 0) list.append(h("p", { class: "ev-meta", text: "증거 없음" }));
			return list;
		}

		function historyList(view) {
			const ol = h("ol", { class: "history", id: "issue-history" });
			for (const entry of view.history) {
				const li = h("li", { class: `event event-${entry.actor}`, "data-seq": entry.seq ?? "", "data-type": entry.type, "data-readonly": entry.readOnly ? "true" : null });
				li.append(h("div", { class: "ev-head" }, [
					h("span", { class: "ev-label", text: entry.label }),
					h("span", { class: "actor", text: entry.actorLabel }),
					entry.stateLabel ? chip(entry.state) : null,
					h("time", { class: "when", datetime: entry.acceptedAt ?? "", text: entry.acceptedAt ? formatStamp(entry.acceptedAt) : "" }),
				]));
				if (entry.triage) li.append(h("p", { class: "ev-meta", text: entry.triage }));
				if (entry.text) li.append(h("p", { class: "text", text: entry.text }));
				if (entry.correction) {
					li.append(h("p", { class: "ev-meta" }, [
						entry.correction.href ? h("a", { href: entry.correction.href, text: entry.correction.label }) : h("span", { text: entry.correction.label }),
						entry.correction.summary ? h("span", { text: ` · ${entry.correction.summary}` }) : null,
					]));
				}
				if (entry.check) {
					li.append(h("p", { class: "ev-meta check", "data-check": entry.check.status ?? "" }, [
						h("strong", { text: entry.check.label }),
						h("span", { text: ` · ${entry.check.detail}` }),
					]));
				}
				if (entry.captureId) li.append(h("p", { class: "ev-meta", text: `증거 #${entry.seq}` }));
				ol.append(li);
			}
			return ol;
		}

		/* The owner's controls are built once per issue and moved, not rebuilt, on every detail
		 * refresh: unsent text, the selected image and the editor's listeners stay on the live
		 * elements, and a refresh can never detach a handler from a button that is still visible. */
		function buildPanel() {
			const root = h("section", { class: "card actions-card", "aria-label": "내 작업" });
			const comment = h("textarea", { id: "issue-comment", rows: "3", placeholder: "의견 적기", "aria-label": "의견" });
			const commentSend = h("button", { type: "button", class: "btn", id: "issue-comment-send", text: "의견 보내기" });
			const file = h("input", { type: "file", id: "issue-append-file", accept: "image/png,image/jpeg,image/webp", "aria-label": "사진 추가" });
			const fileLabel = h("label", { class: "btn ghost file" }, [h("span", { text: "사진 추가" }), file]);
			const editorHost = h("div", { class: "editor", id: "issue-append-editor" });
			const appendSend = h("button", { type: "button", class: "btn", id: "issue-append-send", text: "사진 보내기", disabled: true });
			const hint = h("p", { class: "ev-meta" });
			const confirm = h("button", { type: "button", class: "btn", id: "issue-confirm", text: "해결 확인", disabled: true });
			const reopen = h("button", { type: "button", class: "btn ghost", id: "issue-reopen", text: "다시 열기", disabled: true });
			const purge = h("button", { type: "button", class: "btn danger", id: "issue-purge", text: "삭제" });
			const purgeText = h("p");
			const purgeConfirm = h("button", { type: "button", class: "btn danger", id: "issue-purge-confirm", text: "삭제" });
			const purgeCancel = h("button", { type: "button", class: "btn ghost", id: "issue-purge-cancel", text: "취소" });
			const confirmBox = h("div", { class: "confirm", id: "issue-purge-box", hidden: true, role: "group", "aria-label": "삭제 확인" }, [
				purgeText,
				h("div", { class: "row-actions" }, [purgeConfirm, purgeCancel]),
			]);
			commentSend.addEventListener("click", () => sendComment());
			file.addEventListener("change", () => pickImage());
			appendSend.addEventListener("click", () => sendImage());
			confirm.addEventListener("click", () => mutate(ownerCommand("confirm"), "해결로 표시했습니다"));
			reopen.addEventListener("click", () => mutate(ownerCommand("reopen", { comment: comment.value }), "다시 열었습니다"));
			purge.addEventListener("click", () => {
				confirmBox.hidden = false;
				purgeConfirm.focus();
			});
			purgeCancel.addEventListener("click", () => {
				confirmBox.hidden = true;
				purge.focus();
			});
			purgeConfirm.addEventListener("click", () => mutate(ownerCommand("purge"), "삭제했습니다"));
			root.append(
				h("div", { class: "compose" }, [comment, commentSend]),
				h("div", { class: "row-actions" }, [fileLabel, appendSend]),
				editorHost,
				hint,
				h("div", { class: "row-actions" }, [confirm, reopen, purge]),
				confirmBox,
			);
			return { root, comment, commentSend, file, editorHost, appendSend, hint, confirm, reopen, purge, purgeText, purgeConfirm, confirmBox };
		}

		function updatePanel(view) {
			const panel = model.panel;
			const held = locked();
			panel.comment.setAttribute("maxlength", String(view.limits.COMMENT_BYTES));
			panel.commentSend.disabled = held;
			panel.file.disabled = held;
			panel.appendSend.disabled = held || !(model.editor && model.editor.hasImage());
			panel.confirm.disabled = held || !view.actions.confirm;
			panel.reopen.disabled = held || !view.actions.reopen;
			panel.purge.disabled = held;
			panel.purgeConfirm.disabled = held;
			panel.purgeText.textContent = view.purgeText;
			panel.hint.textContent = view.actions.confirm
				? "수정안을 확인하고 해결로 표시하거나 다시 열 수 있습니다"
				: view.actions.reopen
					? "문제가 남아 있으면 다시 열 수 있습니다"
					: "담당의 수정안 확인 요청이 오면 해결 확인이 열립니다";
		}

		function render() {
			const view = model.view;
			if (!model.panel) model.panel = buildPanel();
			updatePanel(view);
			const parts = [
				h("header", { class: "head" }, [
					h("h2", { class: "title", text: view.title }),
					chip(view.state),
					h("span", { class: "seq", text: `기록 ${view.history.length}건` }),
					view.createdLabel ? h("time", { class: "when", datetime: view.createdAt ?? "", text: view.createdLabel }) : null,
				]),
				h("section", { class: "card" }, [h("h3", { text: "설명" }), h("p", { class: "desc", id: "issue-description-text", text: view.description })]),
				h("section", { class: "card" }, [h("h3", { text: "기록" }), factRows(view)]),
			];
			if (view.build.differs) {
				const reload = h("button", { type: "button", class: "ctl", id: "issue-reload", text: "새로 고침" });
				reload.addEventListener("click", () => window.location.reload());
				parts.push(h("div", { class: "notice build", role: "status" }, [h("span", { text: `이 화면 빌드 ${shortHash(view.build.loaded)} · 서버 빌드 ${shortHash(view.build.server)}` }), reload]));
			}
			parts.push(
				h("section", { class: "card" }, [h("h3", { text: "증거" }), evidenceCards(view)]),
				h("section", { class: "card" }, [h("h3", { text: "이력" }), historyList(view)]),
				model.panel.root,
			);
			const focused = document.activeElement;
			article.replaceChildren(...parts);
			if (focused && model.panel.root.contains(focused) && typeof focused.focus === "function") focused.focus({ preventScroll: true });
			app.dataset.state = view.state;
			app.dataset.seq = String(view.currentSeq);
			rendered("detail", { error: null });
		}

		async function reload() {
			const result = await loadDetail(id);
			if (!result.ok) {
				if (result.status === 410) {
					renderGone(result.error);
					return false;
				}
				notice.replaceChildren(h("span", { text: `제보를 불러오지 못했습니다 · ${result.error.text}` }), h("button", { type: "button", text: "다시 시도" }));
				notice.lastChild.addEventListener("click", () => reload());
				notice.hidden = false;
				rendered("detail", { error: String(result.status) });
				return false;
			}
			notice.hidden = true;
			model.detail = result.body;
			model.view = detailViewModel(result.body, { loadedBuild, nowMs: nowMs() });
			render();
			return true;
		}

		/* After a verified acceptance only: the committed text leaves the box (unless the owner
		 * changed it meanwhile) and a sent image leaves the editor. */
		function afterAccepted(envelope, seq, doneText, alive) {
			const command = envelope.command;
			if (model.panel) {
				const typed = model.panel.comment.value.trim();
				if (command.type === "comment" && command.text === typed) model.panel.comment.value = "";
				if (command.type === "reopen" && command.comment !== null && command.comment === typed) model.panel.comment.value = "";
			}
			if (command.type === "append_evidence") releaseEditor();
			if (alive && model.panel) updatePanel(model.view);
			setStatus(alive ? `${doneText} (순번 ${seq})` : doneText);
		}

		function showPending() {
			const pending = model.pending;
			if (!pending) return;
			const retry = h("button", { type: "button", class: "ctl", id: "issue-retry", text: "다시 보내기" });
			retry.addEventListener("click", () => resend());
			pendingBox.replaceChildren(h("span", { text: `${EVENT_LABELS[pending.envelope.command.type] ?? pending.envelope.command.type} · 접수 여부를 알 수 없습니다` }), retry);
			pendingBox.hidden = false;
			setStatus("접수 확인 중 · 응답을 받지 못했습니다", { error: true });
		}

		/* One attempt of one envelope. Its outcome is read from the receipt, never from the HTTP
		 * status alone: accepted clears the committed input, a conflict shows the current sequence
		 * and refreshes with the input kept, a rejection shows the error, and an uncertain result
		 * keeps the input, re-reads the detail for the requestId and otherwise offers a replay of
		 * the SAME envelope (same requestId and expectedSeq), which the server answers exactly once. */
		async function send(envelope, doneText, { retry = false } = {}) {
			model.busy = true;
			app.dataset.busy = envelope.command.type;
			if (retry) pendingBox.hidden = true;
			updatePanel(model.view);
			setStatus(retry ? "다시 보내는 중" : "보내는 중");
			const result = await request(feedbackPath(id), { method: "POST", headers: POST_HEADERS, body: JSON.stringify(envelope) });
			const outcome = mutationOutcome(result.status, result.body, { requestId: envelope.requestId, id, storeId: envelope.storeId });
			model.busy = false;
			delete app.dataset.busy;
			if (outcome.kind === "accepted") {
				clearPending();
				const alive = await reload();
				afterAccepted(envelope, outcome.receipt.seq, doneText, alive);
				return outcome;
			}
			if (outcome.kind === "conflict" || outcome.kind === "rejected") {
				clearPending();
				setStatus(outcome.text, { error: true });
				if (result.status === 410) renderGone(outcome.error);
				else await reload();
				return outcome;
			}
			model.pending = { envelope, doneText };
			app.dataset.pending = envelope.requestId;
			setStatus(outcome.text, { error: true });
			const alive = await reload();
			if (!alive && app.dataset.state === "tombstone") return outcome;
			const committed = alive ? committedEvent(model.detail, envelope.requestId) : null;
			if (committed) {
				clearPending();
				afterAccepted(envelope, committed.seq, doneText, true);
				return { ...outcome, kind: "accepted", reason: "detail" };
			}
			if (model.panel) updatePanel(model.view);
			showPending();
			return outcome;
		}

		async function mutate(command, doneText) {
			if (locked() || !model.detail) return null;
			const envelope = commandEnvelope({ storeId: model.view.storeId, requestId: freshId(), expectedSeq: model.view.currentSeq, command });
			return send(envelope, doneText);
		}

		async function resend() {
			const pending = model.pending;
			if (!pending || model.busy) return null;
			return send(pending.envelope, pending.doneText, { retry: true });
		}

		async function sendComment() {
			const panel = model.panel;
			const check = textCheck(panel.comment.value, model.view.limits.COMMENT_BYTES);
			if (!check.ok) {
				setStatus(check.reason === "empty" ? "의견을 적어 주세요" : `의견은 ${model.view.limits.COMMENT_BYTES}바이트까지`, { error: true });
				panel.comment.focus();
				return;
			}
			await mutate(ownerCommand("comment", { text: panel.comment.value }), "의견을 보냈습니다");
		}

		async function pickImage() {
			const panel = model.panel;
			const file = panel.file.files && panel.file.files[0];
			if (!file) return;
			try {
				if (!model.imageModule) model.imageModule = await load("/web/issue-image.js");
				if (!model.editor) {
					model.editor = model.imageModule.createIssueImage({ document, now: () => nowMs() });
					// The panel is never rebuilt, so this listener always reaches the visible button.
					model.editor.onChange(() => {
						panel.appendSend.disabled = locked() || !(model.editor && model.editor.hasImage());
					});
					panel.editorHost.replaceChildren(model.editor.element);
				}
				const result = await model.editor.acquireFile(file);
				if (!result.ok) setStatus(`사진을 쓸 수 없습니다 (${NONE_REASON_LABELS[result.reason] ?? result.reason})`, { error: true });
				else setStatus(`사진 ${result.width}×${result.height} 준비됨 · 가리기와 표시 뒤 보내기`);
			} catch {
				setStatus("사진 편집기를 불러오지 못했습니다", { error: true });
			} finally {
				panel.file.value = "";
			}
		}

		async function sendImage() {
			if (!model.editor || !model.editor.hasImage()) return;
			let exported;
			try {
				exported = model.editor.exportEvidence();
			} catch (error) {
				setStatus(`사진을 내보내지 못했습니다 (${error && error.code ? error.code : "failed"})`, { error: true });
				return;
			}
			const evidence = appendEvidenceFor({
				issueId: id,
				currentSeq: model.view.currentSeq,
				visual: exported.visual,
				view: {
					width: window.innerWidth,
					height: window.innerHeight,
					dpr: window.devicePixelRatio,
					scrollX: window.scrollX,
					scrollY: window.scrollY,
					theme: window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
					locale: window.navigator?.language ?? "ko-KR",
				},
				clientBuild: clientBuildFromStamp(loadedBuild),
				uuid: freshId,
				now: nowMs,
			});
			await mutate(ownerCommand("append_evidence", { evidence, note: null }), "사진을 보냈습니다");
		}

		await reload();
	}

	/* ---------- standalone composer: the shared reporter (web/issue-report.js) without a source ---------- */

	async function showNew() {
		setHeader({ title: "문제 제보", backHref: "/issues", backText: "‹ 제보함", showNew: false });
		const status = h("p", { class: "status", id: "issue-new-status", role: "status", "aria-live": "polite" });
		const open = h("button", { type: "button", class: "btn", id: "issue-open", text: "제보 쓰기", disabled: true });
		const hint = h("p", { class: "ev-meta", id: "issue-source-hint", text: "출처 없음 · 설명만 보냅니다" });
		app.replaceChildren(h("section", { class: "card compose-card" }, [hint, h("div", { class: "row-actions" }, [open]), status]));
		let report;
		try {
			const [reportModule, draftsModule] = await Promise.all([load("/web/issue-report.js"), load("/web/issue-drafts.js").catch(() => null)]);
			// No source adapter: the context is describeUnavailable() and a text-only report is allowed.
			report = reportModule.mountIssueReport({ document, window, drafts: draftsModule, fetchImpl: doFetch, now: nowMs, uuid: freshId, pageKey: "/issues/new" });
		} catch {
			status.textContent = "제보 화면을 불러오지 못했습니다";
			status.classList.add("error");
			rendered("new", { error: "module" });
			return;
		}
		const sync = () => {
			const state = report.state();
			app.dataset.report = state.status;
			if (state.status === "sent" && isUuid(state.issueId)) app.dataset.accepted = state.issueId;
			else delete app.dataset.accepted;
		};
		new window.MutationObserver(sync).observe(report.element, { attributes: true, childList: true, subtree: true, characterData: true });
		report.element.addEventListener("close", sync);
		open.addEventListener("click", () => {
			report.open({ opener: open }).catch(() => {
				status.textContent = "제보 화면을 열지 못했습니다";
				status.classList.add("error");
			});
		});
		open.disabled = false;
		rendered("new", { error: null });
		await report.open({ opener: open });
		sync();
	}

	const route = routeFromPath(window.location.pathname);
	if (route.kind === "list") await showList();
	else if (route.kind === "detail") await showDetail(route.id);
	else if (route.kind === "new") await showNew();
	else {
		setHeader({ title: "제보함", backHref: "/issues", backText: "‹ 제보함", showNew: true });
		app.replaceChildren(h("p", { class: "empty", text: "없는 주소입니다" }));
		rendered("unknown", { error: "404" });
	}
	return { route, renders: () => renders };
}

if (typeof document !== "undefined" && typeof window !== "undefined" && document.getElementById("issues-app")) {
	mountIssues({ document, window }).catch((error) => {
		const app = document.getElementById("issues-app");
		if (app) {
			const p = document.createElement("p");
			p.className = "notice";
			p.textContent = "화면을 그리지 못했습니다";
			app.replaceChildren(p);
		}
		throw error;
	});
}
