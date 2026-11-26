// Public-repo reports: the model request that rewrites a report into general
// text, the parse of its answer, and the deterministic leak check that keeps
// any text visible in the original picture (and ids, paths, emails) out of a
// public issue. Pure module: no model call, no I/O.

const MAX_TOKENS = 1200;
const TITLE_CODE_POINTS = 80;
const BODY_CODE_POINTS = 4000;
// A source text this long (code points, after normalization) or longer counts
// as a leak when it appears whole; longer texts leak through any window of
// WINDOW code points.
const MIN_WHOLE = 5;
const WINDOW = 12;

const SYSTEM_PROMPT = [
	"너는 버그 제보를 공개 저장소용 이슈로 다시 쓰는 사람이다.",
	"그림은 제보자가 고른 화면 부분이다. 그 안의 대화 내용, 세션 이름, 제목, 경로, id, 이메일, 사람 이름은 비공개다.",
	"쓸 것: 무엇이 이상한지, 화면의 어디인지(버튼, 말풍선, 목록 같은 일반 이름으로), 다시 겪는 순서.",
	"쓰지 말 것: 그림이나 설명에 있는 글자를 그대로 옮기기, 세션 이름, 대화 문장, id, 경로, 주소, 이메일. 내용이 필요하면 '대화 내용', '세션 제목'처럼 일반 말로 쓴다.",
	"형식: 첫 줄은 제목 한 줄(60자 이내), 빈 줄, 그다음 본문. 본문은 '### 문제', '### 위치', '### 재현 순서' 세 절로 쓴다. 한국어로 쓴다.",
].join("\n");

function codePoints(text) {
	return Array.from(text);
}

function normalize(text) {
	return String(text ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

const MEANINGFUL = /[\p{L}\p{N}]/u;

// Shapes that never belong in a public issue, whatever the capture showed.
const PATTERNS = Object.freeze([
	["email", /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.[\p{L}\p{N}.-]+/u],
	["path", /\b[a-z]:[\\/]/i],
	["path", /(?:^|[\s(`'"])(?:~|\/users|\/home)\/[^\s/]+/i],
	["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
	["id", /\bi-\d{6}-[a-z0-9]{6}\b/i],
	["id", /\b\d{6}-[a-z0-9]{4}\b/i],
	["id", /\b[0-9a-f]{12,}\b/i],
	["host", /\.ts\.net\b/i],
	["host", /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
]);

function idsOf(report) {
	const ids = [];
	const source = report?.source;
	if (source?.kind === "thread") ids.push(source.threadId, source.itemId);
	if (source?.kind === "proposal") ids.push(source.proposalId);
	const url = String(report?.page?.url ?? "");
	for (const match of url.matchAll(/(?:\/s\/|\/p\/|[?&]s=)([^/?&#]+)/g)) {
		try {
			ids.push(decodeURIComponent(match[1]));
		} catch {
			ids.push(match[1]);
		}
	}
	return ids.filter((id) => typeof id === "string" && id !== "");
}

/** What the leak check compares against: the user texts the picture showed, and the ids of the page. */
export function leakSources(report) {
	const texts = Array.isArray(report?.mask?.texts) ? report.mask.texts.filter((text) => typeof text === "string") : [];
	return { texts, ids: idsOf(report) };
}

/**
 * Every reason the text may not be posted publicly, in a fixed order: `text` when a
 * user text of the picture appears verbatim (whole, or any WINDOW-long run of a longer
 * one), `id` when a page id appears, then the shape kinds of PATTERNS. Never returns
 * the matched text itself.
 */
export function findLeaks(text, { texts = [], ids = [] } = {}) {
	const kinds = new Set();
	const hay = normalize(text);
	for (const source of texts) {
		const points = codePoints(normalize(source));
		if (points.length < MIN_WHOLE) continue;
		if (points.length <= WINDOW) {
			const whole = points.join("");
			if (MEANINGFUL.test(whole) && hay.includes(whole)) kinds.add("text");
			continue;
		}
		for (let at = 0; at + WINDOW <= points.length; at++) {
			const run = points.slice(at, at + WINDOW).join("");
			if (MEANINGFUL.test(run) && hay.includes(run)) {
				kinds.add("text");
				break;
			}
		}
	}
	for (const id of ids) {
		const needle = normalize(id);
		if (needle.length >= 4 && hay.includes(needle)) kinds.add("id");
	}
	const raw = String(text ?? "");
	for (const [kind, pattern] of PATTERNS) {
		if (pattern.test(raw)) kinds.add(kind);
	}
	return [...kinds];
}

/** The model request for one stored report; `image` is the original picture as base64, or null. */
export function buildRewriteRequest(record, image) {
	const report = record.report;
	const element = report.element;
	const lines = [
		"제보자가 쓴 설명:",
		report.description,
		"",
		`화면 종류: ${report.page.route}`,
	];
	if (element == null) {
		lines.push("고른 곳: 화면 전체");
	} else {
		lines.push(`고른 곳: ${element.label}`, `태그: ${element.tag}${element.role ? ` (역할 ${element.role})` : ""}`, `선택자: ${element.selector ?? element.domPath}`);
	}
	lines.push(`보기: ${report.view.layout.w}×${report.view.layout.h} CSS px, ${report.view.pointer === "coarse" ? "터치" : "마우스"}, ${report.view.colorScheme}`);
	lines.push("", image ? "첨부한 그림은 고른 곳을 다시 그린 원본이다." : "그림은 없다.");
	return {
		system: SYSTEM_PROMPT,
		user: lines.join("\n"),
		image: image ? { data: image, mimeType: "image/png" } : null,
		maxTokens: MAX_TOKENS,
	};
}

/** Title and body of a model answer, or null when it has no title line or no body. */
export function parseRewrite(text) {
	const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/^```[^\n]*\n([\s\S]*?)\n```\s*$/, "$1").split("\n");
	const first = lines.findIndex((line) => line.trim() !== "");
	if (first === -1) return null;
	const title = lines[first].trim().replace(/^#+\s*/, "").replace(/^제목\s*[:：]\s*/, "").trim();
	const body = lines.slice(first + 1).join("\n").trim();
	if (title === "" || body === "") return null;
	const titlePoints = codePoints(title);
	const bodyPoints = codePoints(body);
	return {
		title: titlePoints.length <= TITLE_CODE_POINTS ? title : `${titlePoints.slice(0, TITLE_CODE_POINTS - 1).join("")}…`,
		body: bodyPoints.length <= BODY_CODE_POINTS ? body : `${bodyPoints.slice(0, BODY_CODE_POINTS - 1).join("")}…`,
	};
}
