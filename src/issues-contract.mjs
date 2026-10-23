// Versioned issue envelopes (schema v1): literal limits, strict validators and
// canonical request identity. Pure module: no I/O beyond node:crypto hashing.
//
// Validators never coerce and never truncate user text. Every rejection
// returns {ok:false, error:"bad_input", fields:[json.path, ...]} without the
// submitted text.

import { createHash } from "node:crypto";
import { redact } from "./redact.mjs";

export const LIMITS = Object.freeze({
	DESCRIPTION_BYTES: 8192,
	COMMENT_BYTES: 4096,
	NOTE_BYTES: 4096,
	TITLE_CODE_POINTS: 80,
	CONTEXT_BYTES: 32768,
	EXCERPT_BYTES: 8192,
	VISIBLE_IDS: 50,
	DIAGNOSTICS: 30,
	DIAGNOSTIC_WINDOW_MS: 30000,
	RASTER_MAX_SIDE: 4096,
	RASTER_MAX_PIXELS: 2097152,
	MARKS: 50,
	MASKS: 50,
	MARK_NOTE_BYTES: 256,
	BODY_BYTES: 12582912,
	LIST_LIMIT: 50,
	LIST_MAX: 100,
	EVENT_LIMIT: 50,
	EVENT_MAX: 100,
	SOURCE_ID_BYTES: 200,
	TARGET_TEXT_BYTES: 160,
	QUERY_BYTES: 200,
	VIEW_MAX_PX: 32768,
	SCROLL_ABS_MAX: 1000000,
	RECT_ABS_MAX: 1000000,
});

export const ENUMS = Object.freeze({
	PAGES: Object.freeze(["inbox", "thread", "boards", "proposal", "issues", "other"]),
	SOURCE_KINDS: Object.freeze(["proposal", "thread", "issue"]),
	TARGET_KINDS: Object.freeze(["page", "record", "control", "frame"]),
	VISUAL_NONE_REASONS: Object.freeze(["not_requested", "unsupported", "denied", "failed", "removed"]),
	PROVENANCES: Object.freeze(["display_capture", "user_upload", "source_asset_crop", "reproduction"]),
	MATCHES: Object.freeze(["unverified", "user_confirmed"]),
	THEMES: Object.freeze(["light", "dark", "unknown"]),
	STATES: Object.freeze(["open", "investigating", "needs-check", "resolved", "tombstone"]),
	CATEGORIES: Object.freeze(["inbox-ui", "report-content", "other"]),
	SEVERITIES: Object.freeze(["normal", "high", "low"]),
	COMMAND_TYPES: Object.freeze(["triage", "comment", "append_evidence", "request_check", "confirm", "reopen", "purge"]),
	ACTIONS: Object.freeze([
		"open_report", "pick_target", "open_review", "open_viewer", "close_viewer",
		"change_revision", "select_thread", "toggle_original", "toggle_progress",
		"answer", "ack", "approve", "request_change", "hide_thread", "reopen_session",
		"send_reply", "issue_submit", "issue_comment", "issue_confirm", "issue_reopen",
	]),
	ROUTES: Object.freeze([
		"threads_list", "thread_detail", "thread_episode", "item_answer", "thread_message",
		"thread_reopen", "proposals_list", "proposal_detail", "proposal_feedback",
		"issue_capabilities", "issue_create", "issue_detail", "issue_command",
		"issue_feedback", "other",
	]),
	ERROR_CODES: Object.freeze([
		"bad_input", "forbidden", "not_found", "closed", "too_long", "bad_rev",
		"duplicate", "key_reused", "version_conflict", "store_changed",
		"invalid_transition", "corrupt_record", "network", "aborted", "other",
	]),
	ERROR_CLASSES: Object.freeze([
		"Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
		"URIError", "EvalError", "DOMException", "ResourceError",
		"UnhandledRejection", "other",
	]),
	// Current served script basenames plus the two inline owners and the
	// explicit catch-all. Unknown source strings map to "other" upstream.
	SCRIPT_NAMES: Object.freeze([
		"board.js", "thread.js", "sw.js", "issues.js", "issue-context.js",
		"issue-adapters.js", "issue-drafts.js", "issue-report.js",
		"inbox-inline", "boards-inline", "other",
	]),
});

const CREATE_KEYS = new Set(["v", "storeId", "requestId", "description", "evidence"]);
const EVIDENCE_KEYS = new Set([
	"captureId", "observedAt", "page", "source", "target", "clientBuild", "view",
	"excerpt", "excerptTruncated", "visibleIds", "diagnostics", "contextStatus", "visual",
]);
const VIEW_KEYS = new Set(["width", "height", "dpr", "scale", "scrollX", "scrollY", "theme", "locale", "embedded", "viewerOpen"]);
const TARGET_KEYS = new Set(["kind", "key", "label", "rect", "framePath"]);
const CLIENT_BUILD_KEYS = new Set(["kind", "version", "digest"]);
const PROPOSAL_SOURCE_KEYS = new Set(["kind", "proposalId", "revision", "observedSeq", "recordedContentHash", "frame"]);
const THREAD_SOURCE_KEYS = new Set(["kind", "threadId", "itemId", "observedSeq"]);
const ISSUE_SOURCE_KEYS = new Set(["kind", "issueId", "observedSeq"]);
const VISUAL_NONE_KEYS = new Set(["kind", "reason"]);
const VISUAL_RASTER_KEYS = new Set([
	"kind", "provenance", "acquiredAt", "sourceMatchesContext", "width", "height",
	"encoding", "pixels", "masks", "marks",
]);
const RECT_KEYS = new Set(["x", "y", "w", "h"]);
const MARK_KEYS = new Set(["rect", "text"]);
const ACTION_DIAGNOSTIC_KEYS = new Set(["type", "atMs", "name"]);
const REQUEST_DIAGNOSTIC_KEYS = new Set(["type", "atMs", "route", "status", "durationMs", "errorCode"]);
const SCRIPT_DIAGNOSTIC_KEYS = new Set(["type", "atMs", "file", "line", "column", "errorClass"]);
const COMMAND_ENVELOPE_KEYS = new Set(["v", "storeId", "requestId", "expectedSeq", "command"]);
const COMMAND_KEYS = Object.freeze({
	triage: new Set(["type", "category", "severity", "note"]),
	comment: new Set(["type", "text"]),
	append_evidence: new Set(["type", "evidence", "note"]),
	request_check: new Set(["type", "note", "correction", "evidence"]),
	confirm: new Set(["type"]),
	reopen: new Set(["type", "comment"]),
	purge: new Set(["type"]),
});
const CONTEXT_STATUSES = ["captured", "partial", "unavailable"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const LOCALE = /^[A-Za-z0-9-]{1,35}$/;

export function utf8Bytes(str) {
	return Buffer.byteLength(str, "utf8");
}

export function isUuidV4(value) {
	return typeof value === "string" && UUID_V4.test(value);
}

export function isCanonicalBase64(value) {
	if (typeof value !== "string" || value.length % 4 !== 0) return false;
	// Scan linearly: a quantified regex over an 11 MiB base64 raster exhausts
	// the regular-expression stack. Only the final two positions may be "=".
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const bodyEnd = value.length - padding;
	for (let index = 0; index < bodyEnd; index++) {
		const code = value.charCodeAt(index);
		const alphabet =
			(code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
			(code >= 48 && code <= 57) || code === 43 || code === 47;
		if (!alphabet) return false;
	}
	const decoded = Buffer.from(value, "base64");
	return decoded.toString("base64") === value;
}

export function isCanonicalUtcIso(value) {
	if (typeof value !== "string") return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function bad(errors, path) {
	if (!errors.includes(path)) errors.push(path);
}

function pathOf(parent, key) {
	return parent ? `${parent}.${key}` : key;
}

function indexed(parent, index) {
	return `${parent}[${index}]`;
}

function checkKeys(obj, allowed, path, errors) {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) bad(errors, pathOf(path, key));
	}
}

function requireKeys(obj, keys, path, errors) {
	for (const key of keys) {
		if (!Object.prototype.hasOwnProperty.call(obj, key)) bad(errors, pathOf(path, key));
	}
}

function requireObject(value, path, errors) {
	if (!isPlainObject(value)) {
		bad(errors, path);
		return false;
	}
	return true;
}

function checkEnum(value, allowed, path, errors) {
	if (!allowed.includes(value)) bad(errors, path);
	return value;
}

function checkUuid(value, path, errors) {
	if (!isUuidV4(value)) bad(errors, path);
	return value;
}

function checkSha256(value, path, errors) {
	if (typeof value !== "string" || !SHA256_HEX.test(value)) bad(errors, path);
	return value;
}

function checkFinite(value, path, errors, { min = -Infinity, max = Infinity, integer = false, safe = false } = {}) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		bad(errors, path);
		return value;
	}
	if (integer && !Number.isInteger(value)) bad(errors, path);
	if (safe && !Number.isSafeInteger(value)) bad(errors, path);
	if (value < min || value > max) bad(errors, path);
	return value;
}

function checkStringBytes(value, path, errors, { min = 0, max = Infinity, trim = false } = {}) {
	if (typeof value !== "string") {
		bad(errors, path);
		return value;
	}
	const out = trim ? sanitizeText(value) : value;
	const bytes = utf8Bytes(out);
	if (bytes < min || bytes > max) bad(errors, path);
	return out;
}

function checkNullableText(value, path, errors, max, { trim = true } = {}) {
	if (value === null) return null;
	return checkStringBytes(value, path, errors, { min: 1, max, trim });
}

function checkNullableTimestamp(value, path, errors) {
	if (value === null) return null;
	if (!isCanonicalUtcIso(value)) bad(errors, path);
	return value;
}

function checkOpaqueId(value, path, errors, max = LIMITS.SOURCE_ID_BYTES) {
	return checkStringBytes(value, path, errors, { min: 1, max });
}

// Bitmap rects (masks/marks) are safe integers in final-bitmap pixels; target
// rects are CSS coordinates and keep finite fractions (D2).
function checkRect(value, path, errors, { integer = true, bounds = null } = {}) {
	if (!requireObject(value, path, errors)) return value;
	checkKeys(value, RECT_KEYS, path, errors);
	requireKeys(value, RECT_KEYS, path, errors);
	const out = {};
	for (const key of ["x", "y"]) {
		out[key] = checkFinite(value[key], pathOf(path, key), errors, {
			min: -LIMITS.RECT_ABS_MAX, max: LIMITS.RECT_ABS_MAX, integer, safe: integer,
		});
	}
	for (const key of ["w", "h"]) {
		out[key] = checkFinite(value[key], pathOf(path, key), errors, {
			min: 0, max: LIMITS.RECT_ABS_MAX, integer, safe: integer,
		});
	}
	if (bounds && integer && Number.isInteger(out.x) && Number.isInteger(out.y) && Number.isInteger(out.w) && Number.isInteger(out.h)) {
		if (out.x < 0 || out.y < 0 || out.x + out.w > bounds.width || out.y + out.h > bounds.height) {
			bad(errors, path);
		}
	}
	return out;
}

function checkSource(value, path, errors) {
	if (value === null) return null;
	if (!requireObject(value, path, errors)) return value;
	const kind = value.kind;
	if (!ENUMS.SOURCE_KINDS.includes(kind)) {
		bad(errors, pathOf(path, "kind"));
		return value;
	}
	if (kind === "proposal") {
		checkKeys(value, PROPOSAL_SOURCE_KEYS, path, errors);
		requireKeys(value, ["kind", "proposalId", "revision", "observedSeq", "recordedContentHash", "frame"], path, errors);
		const out = {
			kind: "proposal",
			proposalId: checkOpaqueId(value.proposalId, pathOf(path, "proposalId"), errors),
			revision: checkFinite(value.revision, pathOf(path, "revision"), errors, { min: 1, integer: true, safe: true }),
			observedSeq: checkFinite(value.observedSeq, pathOf(path, "observedSeq"), errors, { min: 0, integer: true, safe: true }),
			recordedContentHash: value.recordedContentHash === null
				? null
				: checkSha256(value.recordedContentHash, pathOf(path, "recordedContentHash"), errors),
			frame: null,
		};
		if (value.frame !== null) {
			const framePath = pathOf(path, "frame");
			if (!requireObject(value.frame, framePath, errors)) out.frame = value.frame;
			else {
				checkKeys(value.frame, new Set(["label", "path"]), framePath, errors);
				requireKeys(value.frame, ["label", "path"], framePath, errors);
				out.frame = {
					label: checkStringBytes(value.frame.label, pathOf(framePath, "label"), errors, { min: 1, max: LIMITS.TARGET_TEXT_BYTES }),
					path: checkOpaqueId(value.frame.path, pathOf(framePath, "path"), errors),
				};
			}
		}
		return out;
	}
	if (kind === "thread") {
		checkKeys(value, THREAD_SOURCE_KEYS, path, errors);
		requireKeys(value, ["kind", "threadId", "itemId", "observedSeq"], path, errors);
		return {
			kind: "thread",
			threadId: checkOpaqueId(value.threadId, pathOf(path, "threadId"), errors),
			itemId: value.itemId === null ? null : checkOpaqueId(value.itemId, pathOf(path, "itemId"), errors),
			observedSeq: checkFinite(value.observedSeq, pathOf(path, "observedSeq"), errors, { min: 0, integer: true, safe: true }),
		};
	}
	checkKeys(value, ISSUE_SOURCE_KEYS, path, errors);
	requireKeys(value, ["kind", "issueId", "observedSeq"], path, errors);
	return {
		kind: "issue",
		issueId: checkUuid(value.issueId, pathOf(path, "issueId"), errors),
		observedSeq: checkFinite(value.observedSeq, pathOf(path, "observedSeq"), errors, { min: 0, integer: true, safe: true }),
	};
}

function checkTarget(value, path, errors) {
	if (value === null) return null;
	if (!requireObject(value, path, errors)) return value;
	checkKeys(value, TARGET_KEYS, path, errors);
	requireKeys(value, ["kind", "key", "label", "rect", "framePath"], path, errors);
	const out = {
		kind: checkEnum(value.kind, ENUMS.TARGET_KINDS, pathOf(path, "kind"), errors),
		key: checkStringBytes(value.key, pathOf(path, "key"), errors, { min: 1, max: LIMITS.TARGET_TEXT_BYTES }),
		label: checkStringBytes(value.label, pathOf(path, "label"), errors, { min: 1, max: LIMITS.TARGET_TEXT_BYTES }),
		rect: checkRect(value.rect, pathOf(path, "rect"), errors, { integer: false }),
		framePath: [],
	};
	if (!Array.isArray(value.framePath)) {
		bad(errors, pathOf(path, "framePath"));
	} else {
		if (value.framePath.length > 1) bad(errors, pathOf(path, "framePath"));
		out.framePath = value.framePath.map((entry, index) => checkOpaqueId(entry, indexed(pathOf(path, "framePath"), index), errors));
	}
	return out;
}

function checkClientBuild(value, path, errors) {
	if (value === null) return null;
	if (!requireObject(value, path, errors)) return value;
	checkKeys(value, CLIENT_BUILD_KEYS, path, errors);
	requireKeys(value, ["kind", "version", "digest"], path, errors);
	if (value.kind !== "page_response_manifest") bad(errors, pathOf(path, "kind"));
	const versionPath = pathOf(path, "version");
	let version = value.version;
	if (version !== null) version = checkStringBytes(version, versionPath, errors, { max: 64 });
	return {
		kind: value.kind,
		version,
		digest: value.digest === null ? null : checkSha256(value.digest, pathOf(path, "digest"), errors),
	};
}

function checkView(value, path, errors) {
	if (!requireObject(value, path, errors)) return value;
	checkKeys(value, VIEW_KEYS, path, errors);
	requireKeys(value, VIEW_KEYS, path, errors);
	const out = {
		width: checkFinite(value.width, pathOf(path, "width"), errors, { min: Number.MIN_VALUE, max: LIMITS.VIEW_MAX_PX }),
		height: checkFinite(value.height, pathOf(path, "height"), errors, { min: Number.MIN_VALUE, max: LIMITS.VIEW_MAX_PX }),
		dpr: checkFinite(value.dpr, pathOf(path, "dpr"), errors, { min: Number.MIN_VALUE, max: 16 }),
		scale: checkFinite(value.scale, pathOf(path, "scale"), errors, { min: Number.MIN_VALUE, max: 16 }),
		scrollX: checkFinite(value.scrollX, pathOf(path, "scrollX"), errors, { min: -LIMITS.SCROLL_ABS_MAX, max: LIMITS.SCROLL_ABS_MAX }),
		scrollY: checkFinite(value.scrollY, pathOf(path, "scrollY"), errors, { min: -LIMITS.SCROLL_ABS_MAX, max: LIMITS.SCROLL_ABS_MAX }),
		theme: checkEnum(value.theme, ENUMS.THEMES, pathOf(path, "theme"), errors),
		locale: value.locale,
		embedded: value.embedded,
		viewerOpen: value.viewerOpen,
	};
	if (typeof value.locale !== "string" || !LOCALE.test(value.locale)) bad(errors, pathOf(path, "locale"));
	if (typeof value.embedded !== "boolean") bad(errors, pathOf(path, "embedded"));
	if (typeof value.viewerOpen !== "boolean") bad(errors, pathOf(path, "viewerOpen"));
	return out;
}

function checkAtMs(value, path, errors) {
	return checkFinite(value, path, errors, {
		min: -LIMITS.DIAGNOSTIC_WINDOW_MS,
		max: 0,
	});
}

function checkDiagnostics(value, path, errors) {
	if (!Array.isArray(value)) {
		bad(errors, path);
		return [];
	}
	if (value.length > LIMITS.DIAGNOSTICS) bad(errors, path);
	return value.map((entry, index) => {
		const entryPath = indexed(path, index);
		if (!isPlainObject(entry)) {
			bad(errors, entryPath);
			return entry;
		}
		const type = entry.type;
		const atMs = checkAtMs(entry.atMs, pathOf(entryPath, "atMs"), errors);
		if (type === "action") {
			checkKeys(entry, ACTION_DIAGNOSTIC_KEYS, entryPath, errors);
			requireKeys(entry, ["type", "atMs", "name"], entryPath, errors);
			return { type, atMs, name: checkEnum(entry.name, ENUMS.ACTIONS, pathOf(entryPath, "name"), errors) };
		}
		if (type === "request") {
			checkKeys(entry, REQUEST_DIAGNOSTIC_KEYS, entryPath, errors);
			requireKeys(entry, ["type", "atMs", "route", "status", "durationMs", "errorCode"], entryPath, errors);
			let errorCode = entry.errorCode;
			if (errorCode !== null) errorCode = checkEnum(errorCode, ENUMS.ERROR_CODES, pathOf(entryPath, "errorCode"), errors);
			return {
				type,
				atMs,
				route: checkEnum(entry.route, ENUMS.ROUTES, pathOf(entryPath, "route"), errors),
				status: checkFinite(entry.status, pathOf(entryPath, "status"), errors, { min: 0, max: 599, integer: true, safe: true }),
				durationMs: checkFinite(entry.durationMs, pathOf(entryPath, "durationMs"), errors, { min: 0, max: 600000 }),
				errorCode,
			};
		}
		if (type === "script") {
			checkKeys(entry, SCRIPT_DIAGNOSTIC_KEYS, entryPath, errors);
			requireKeys(entry, ["type", "atMs", "file", "line", "column", "errorClass"], entryPath, errors);
			return {
				type,
				atMs,
				file: checkEnum(entry.file, ENUMS.SCRIPT_NAMES, pathOf(entryPath, "file"), errors),
				line: checkFinite(entry.line, pathOf(entryPath, "line"), errors, { min: 0, integer: true, safe: true }),
				column: checkFinite(entry.column, pathOf(entryPath, "column"), errors, { min: 0, integer: true, safe: true }),
				errorClass: checkEnum(entry.errorClass, ENUMS.ERROR_CLASSES, pathOf(entryPath, "errorClass"), errors),
			};
		}
		bad(errors, pathOf(entryPath, "type"));
		return entry;
	});
}

function checkVisual(value, path, errors, { allowReproduction = false } = {}) {
	if (!requireObject(value, path, errors)) return value;
	const kind = value.kind;
	if (kind === "none") {
		checkKeys(value, VISUAL_NONE_KEYS, path, errors);
		requireKeys(value, ["kind", "reason"], path, errors);
		return { kind: "none", reason: checkEnum(value.reason, ENUMS.VISUAL_NONE_REASONS, pathOf(path, "reason"), errors) };
	}
	if (kind !== "raster") {
		bad(errors, pathOf(path, "kind"));
		return value;
	}
	checkKeys(value, VISUAL_RASTER_KEYS, path, errors);
	requireKeys(value, VISUAL_RASTER_KEYS, path, errors);
	const width = checkFinite(value.width, pathOf(path, "width"), errors, {
		min: 1, max: LIMITS.RASTER_MAX_SIDE, integer: true, safe: true,
	});
	const height = checkFinite(value.height, pathOf(path, "height"), errors, {
		min: 1, max: LIMITS.RASTER_MAX_SIDE, integer: true, safe: true,
	});
	if (Number.isSafeInteger(width) && Number.isSafeInteger(height) && width * height > LIMITS.RASTER_MAX_PIXELS) {
		bad(errors, pathOf(path, "width"));
	}
	const out = {
		kind: "raster",
		provenance: checkEnum(value.provenance, ENUMS.PROVENANCES, pathOf(path, "provenance"), errors),
		acquiredAt: checkNullableTimestamp(value.acquiredAt, pathOf(path, "acquiredAt"), errors),
		sourceMatchesContext: checkEnum(value.sourceMatchesContext, ENUMS.MATCHES, pathOf(path, "sourceMatchesContext"), errors),
		width,
		height,
		encoding: value.encoding,
		pixels: value.pixels,
		masks: [],
		marks: [],
	};
	if (value.encoding !== "rgba8-base64") bad(errors, pathOf(path, "encoding"));
	if (!isCanonicalBase64(value.pixels)) bad(errors, pathOf(path, "pixels"));
	const bounds = { width, height };
	// D5: reproduction provenance is reserved for a request_check correction image.
	if (value.provenance === "reproduction" && !allowReproduction) bad(errors, pathOf(path, "provenance"));
	if (!Array.isArray(value.masks)) {
		bad(errors, pathOf(path, "masks"));
	} else {
		if (value.masks.length > LIMITS.MASKS) bad(errors, pathOf(path, "masks"));
		out.masks = value.masks.map((mask, index) => checkRect(mask, indexed(pathOf(path, "masks"), index), errors, { bounds }));
	}
	if (!Array.isArray(value.marks)) {
		bad(errors, pathOf(path, "marks"));
	} else {
		if (value.marks.length > LIMITS.MARKS) bad(errors, pathOf(path, "marks"));
		out.marks = value.marks.map((mark, index) => {
			const markPath = indexed(pathOf(path, "marks"), index);
			if (!isPlainObject(mark)) {
				bad(errors, markPath);
				return mark;
			}
			checkKeys(mark, MARK_KEYS, markPath, errors);
			requireKeys(mark, MARK_KEYS, markPath, errors);
			const text = mark.text === null
				? null
				: checkStringBytes(mark.text, pathOf(markPath, "text"), errors, { max: LIMITS.MARK_NOTE_BYTES });
			return {
				rect: checkRect(mark.rect, pathOf(markPath, "rect"), errors, { bounds }),
				text,
			};
		});
	}
	return out;
}

function checkEvidence(value, path, errors, { allowReproduction = false } = {}) {
	if (!requireObject(value, path, errors)) return value;
	checkKeys(value, EVIDENCE_KEYS, path, errors);
	requireKeys(value, EVIDENCE_KEYS, path, errors);
	const out = {
		captureId: checkUuid(value.captureId, pathOf(path, "captureId"), errors),
		observedAt: value.observedAt,
		page: checkEnum(value.page, ENUMS.PAGES, pathOf(path, "page"), errors),
		source: checkSource(value.source, pathOf(path, "source"), errors),
		target: checkTarget(value.target, pathOf(path, "target"), errors),
		clientBuild: checkClientBuild(value.clientBuild, pathOf(path, "clientBuild"), errors),
		view: checkView(value.view, pathOf(path, "view"), errors),
		excerpt: null,
		excerptTruncated: value.excerptTruncated,
		visibleIds: [],
		diagnostics: checkDiagnostics(value.diagnostics, pathOf(path, "diagnostics"), errors),
		contextStatus: checkEnum(value.contextStatus, CONTEXT_STATUSES, pathOf(path, "contextStatus"), errors),
		visual: checkVisual(value.visual, pathOf(path, "visual"), errors, { allowReproduction }),
	};
	if (!isCanonicalUtcIso(value.observedAt)) bad(errors, pathOf(path, "observedAt"));
	if (value.excerpt !== null) out.excerpt = checkStringBytes(value.excerpt, pathOf(path, "excerpt"), errors, { max: LIMITS.EXCERPT_BYTES });
	if (typeof value.excerptTruncated !== "boolean") bad(errors, pathOf(path, "excerptTruncated"));
	if (!Array.isArray(value.visibleIds)) bad(errors, pathOf(path, "visibleIds"));
	else {
		if (value.visibleIds.length > LIMITS.VISIBLE_IDS) bad(errors, pathOf(path, "visibleIds"));
		out.visibleIds = value.visibleIds.map((id, index) => checkOpaqueId(id, indexed(pathOf(path, "visibleIds"), index), errors));
	}
	// At most 32 KiB of canonical UTF-8 JSON for the context metadata, after
	// normalization, including escaped excerpt bytes. The raster pixel payload
	// is bounded independently (validateRaster limits and the 12 MiB body cap),
	// so it is measured as its decoded byte length, not its base64 text.
	if (errors.length === 0 && contextBytes(out) > LIMITS.CONTEXT_BYTES) bad(errors, path);
	return out;
}

function contextBytes(value) {
	const visual = value.visual;
	if (isPlainObject(visual) && visual.kind === "raster" && typeof visual.pixels === "string") {
		return utf8Bytes(canonicalize({
			...value,
			visual: { ...visual, pixels: Buffer.from(visual.pixels, "base64").length },
		}));
	}
	return utf8Bytes(canonicalize(value));
}

export function validateCreate(body) {
	const errors = [];
	if (!isPlainObject(body)) {
		return { ok: false, error: "bad_input", fields: ["$"] };
	}
	checkKeys(body, CREATE_KEYS, "", errors);
	requireKeys(body, CREATE_KEYS, "", errors);
	if (body.v !== 1) bad(errors, "v");
	checkUuid(body.storeId, "storeId", errors);
	checkUuid(body.requestId, "requestId", errors);
	const description = typeof body.description === "string" ? sanitizeText(body.description) : body.description;
	if (typeof description !== "string") bad(errors, "description");
	else if (utf8Bytes(description) < 1 || utf8Bytes(description) > LIMITS.DESCRIPTION_BYTES) bad(errors, "description");
	const value = {
		v: body.v,
		storeId: body.storeId,
		requestId: body.requestId,
		description,
		evidence: checkEvidence(body.evidence, "evidence", errors),
	};
	if (errors.length > 0) return { ok: false, error: "bad_input", fields: errors };
	return { ok: true, value };
}

function checkCorrection(value, path, errors) {
	if (!requireObject(value, path, errors)) return value;
	const kind = value.kind;
	if (kind === "inbox-build") {
		checkKeys(value, new Set(["kind", "buildId", "summary"]), path, errors);
		requireKeys(value, ["kind", "buildId", "summary"], path, errors);
		return {
			kind,
			buildId: checkSha256(value.buildId, pathOf(path, "buildId"), errors),
			summary: checkStringBytes(value.summary, pathOf(path, "summary"), errors, { min: 1, max: LIMITS.NOTE_BYTES, trim: true }),
		};
	}
	if (kind === "review-artifact") {
		checkKeys(value, new Set(["kind", "proposalId", "revision", "summary"]), path, errors);
		requireKeys(value, ["kind", "proposalId", "revision", "summary"], path, errors);
		return {
			kind,
			proposalId: checkOpaqueId(value.proposalId, pathOf(path, "proposalId"), errors),
			revision: checkFinite(value.revision, pathOf(path, "revision"), errors, { min: 1, integer: true, safe: true }),
			summary: checkStringBytes(value.summary, pathOf(path, "summary"), errors, { min: 1, max: LIMITS.NOTE_BYTES, trim: true }),
		};
	}
	bad(errors, pathOf(path, "kind"));
	return value;
}

function checkCommandObject(value, path, errors) {
	if (!requireObject(value, path, errors)) return value;
	const type = value.type;
	if (!ENUMS.COMMAND_TYPES.includes(type)) {
		bad(errors, pathOf(path, "type"));
		return value;
	}
	checkKeys(value, COMMAND_KEYS[type], path, errors);
	requireKeys(value, COMMAND_KEYS[type], path, errors);
	switch (type) {
	case "triage":
		return {
			type,
			category: checkEnum(value.category, ENUMS.CATEGORIES, pathOf(path, "category"), errors),
			severity: checkEnum(value.severity, ENUMS.SEVERITIES, pathOf(path, "severity"), errors),
			note: checkNullableText(value.note, pathOf(path, "note"), errors, LIMITS.NOTE_BYTES),
		};
	case "comment":
		return {
			type,
			text: checkStringBytes(value.text, pathOf(path, "text"), errors, { min: 1, max: LIMITS.COMMENT_BYTES, trim: true }),
		};
	case "append_evidence":
		return {
			type,
			evidence: checkEvidence(value.evidence, pathOf(path, "evidence"), errors),
			note: checkNullableText(value.note, pathOf(path, "note"), errors, LIMITS.NOTE_BYTES),
		};
	case "request_check": {
		const evidence = value.evidence === null ? null : checkEvidence(value.evidence, pathOf(path, "evidence"), errors, { allowReproduction: true });
		if (evidence && evidence.visual && evidence.visual.kind === "raster" && evidence.visual.provenance !== "reproduction") {
			bad(errors, pathOf(pathOf(path, "evidence"), "visual.provenance"));
		}
		return {
			type,
			note: checkStringBytes(value.note, pathOf(path, "note"), errors, { min: 1, max: LIMITS.NOTE_BYTES, trim: true }),
			correction: checkCorrection(value.correction, pathOf(path, "correction"), errors),
			evidence,
		};
	}
	case "confirm":
		return { type };
	case "reopen":
		return {
			type,
			comment: checkNullableText(value.comment, pathOf(path, "comment"), errors, LIMITS.COMMENT_BYTES),
		};
	default:
		return { type };
	}
}

export function validateCommand(body) {
	const errors = [];
	if (!isPlainObject(body)) {
		return { ok: false, error: "bad_input", fields: ["$"] };
	}
	checkKeys(body, COMMAND_ENVELOPE_KEYS, "", errors);
	requireKeys(body, COMMAND_ENVELOPE_KEYS, "", errors);
	if (body.v !== 1) bad(errors, "v");
	checkUuid(body.storeId, "storeId", errors);
	checkUuid(body.requestId, "requestId", errors);
	checkFinite(body.expectedSeq, "expectedSeq", errors, { min: 0, integer: true, safe: true });
	const value = {
		v: body.v,
		storeId: body.storeId,
		requestId: body.requestId,
		expectedSeq: body.expectedSeq,
		command: checkCommandObject(body.command, "command", errors),
	};
	if (errors.length > 0) return { ok: false, error: "bad_input", fields: errors };
	return { ok: true, value };
}

export function sanitizeText(str) {
	return typeof str === "string" ? str.trim() : str;
}

export function deriveTitle(description) {
	if (typeof description !== "string") return "";
	for (const line of description.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		return Array.from(line.trim()).slice(0, LIMITS.TITLE_CODE_POINTS).join("");
	}
	return "";
}

// Redact only user-authored designated text. Identifiers, hashes, base64 and
// every other field pass through byte-for-byte.
export function redactDesignated(value) {
	let changed = false;
	const walk = (node, inEvidence) => {
		if (Array.isArray(node)) {
			return node.map((entry) => walk(entry, inEvidence));
		}
		if (!isPlainObject(node)) return node;
		const out = {};
		for (const key of Object.keys(node)) {
			const current = node[key];
			const designated =
				(key === "description" || key === "comment" || key === "note") ||
				(key === "excerpt" && inEvidence) ||
				key === "text";
			if (designated && typeof current === "string") {
				const masked = redact(current);
				if (masked !== current) changed = true;
				out[key] = masked;
			} else {
				out[key] = walk(current, inEvidence || key === "evidence");
			}
		}
		return out;
	};
	const out = walk(value, false);
	return { value: out, changed };
}

function canonicalValue(value) {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("canonicalize: non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((entry) => (entry === undefined ? "null" : canonicalValue(entry))).join(",")}]`;
	if (typeof value === "object") {
		const entries = [];
		for (const key of Object.keys(value).sort()) {
			if (value[key] === undefined) continue;
			entries.push(`${JSON.stringify(key)}:${canonicalValue(value[key])}`);
		}
		return `{${entries.join(",")}}`;
	}
	throw new TypeError(`canonicalize: unsupported ${typeof value}`);
}

export function canonicalize(value) {
	return canonicalValue(value);
}

export function fingerprint(value) {
	return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
