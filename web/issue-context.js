/* Pure capture-context normalization and capture-generation ownership.
 *
 * This module never reads the document, storage or the network. Callers pass already-displayed
 * adapter metadata; freezeCapture copies only the fields named by the versioned envelope, so a
 * later poll, revision or live-object mutation cannot change an observation that was captured.
 */

const PAGE_VALUES = new Set(["inbox", "thread", "boards", "proposal", "issues", "other"]);
const THEME_VALUES = new Set(["light", "dark", "unknown"]);
const TARGET_KINDS = new Set(["page", "record", "control", "frame"]);
const EXCERPT_LIMIT = 8192;
const CONTEXT_BYTES = 32768;
const TOKEN_LIMIT = 160;
const ID_LIMIT = 200;
const VISIBLE_LIMIT = 50;
const DIAGNOSTIC_LIMIT = 30;
const DOCUMENT_LIMIT = 1_000_000;
const LOCALE_RE = /^[A-Za-z0-9-]{1,35}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTION_NAMES = new Set([
	"open_report", "pick_target", "open_review", "open_viewer", "close_viewer",
	"change_revision", "select_thread", "toggle_original", "toggle_progress", "answer",
	"ack", "approve", "request_change", "hide_thread", "reopen_session", "send_reply",
	"issue_submit", "issue_comment", "issue_confirm", "issue_reopen",
]);
const ROUTE_NAMES = new Set([
	"threads_list", "thread_detail", "thread_episode", "item_answer", "thread_message",
	"thread_reopen", "proposals_list", "proposal_detail", "proposal_feedback",
	"issue_capabilities", "issue_create", "issue_detail", "issue_command", "issue_feedback",
	"other",
]);
const ERROR_CODES = new Set([
	"bad_input", "forbidden", "not_found", "closed", "too_long", "bad_rev", "duplicate",
	"key_reused", "version_conflict", "store_changed", "invalid_transition",
	"corrupt_record", "network", "aborted", "other",
]);
const ERROR_CLASSES = new Set([
	"Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError",
	"EvalError", "DOMException", "ResourceError", "UnhandledRejection",
]);
const SCRIPT_NAMES = new Set([
	"board.js", "thread.js", "sw.js", "issues.js", "issue-context.js",
	"issue-adapters.js", "issue-drafts.js", "issue-report.js",
	"inbox-inline", "boards-inline", "other",
]);
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function utf8Length(value) {
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

function clipUtf8(value, limit) {
	if (typeof value !== "string") return null;
	let bytes = 0;
	let text = "";
	let truncated = false;
	for (const char of value) {
		const code = char.codePointAt(0);
		// A lone surrogate is not valid UTF-8; normalize it before it reaches the envelope.
		const piece = code >= 0xd800 && code <= 0xdfff ? "\uFFFD" : char;
		const size = code >= 0xd800 && code <= 0xdfff ? 3 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		if (bytes + size > limit) {
			truncated = true;
			break;
		}
		text += piece;
		bytes += size;
	}
	return { text, truncated };
}

function token(value, limit = TOKEN_LIMIT) {
	const clipped = clipUtf8(value, limit);
	return clipped === null ? null : clipped.text;
}

function daysInMonth(year, month) {
	if (month === 2) {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		return leap ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function canonicalIso(value) {
	if (typeof value !== "string") return null;
	const match = ISO_RE.exec(value);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (month < 1 || month > 12) return null;
	if (day < 1 || day > daysInMonth(year, month)) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	return value;
}

function pad(value, width) {
	return String(value).padStart(width, "0");
}

function civilFromDays(days) {
	const z = days + 719468;
	const era = Math.floor(z / 146097);
	const doe = z - era * 146097;
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
	let year = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp + (mp < 10 ? 3 : -9);
	if (month <= 2) year += 1;
	return { year, month, day };
}

// Canonical UTC ISO from injected epoch milliseconds without reading the platform clock.
function isoFromEpochMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError("now() must return finite epoch milliseconds");
	}
	const ms = Math.trunc(value);
	const wholeSeconds = Math.floor(ms / 1000);
	const millis = ms - wholeSeconds * 1000;
	const days = Math.floor(wholeSeconds / 86400);
	const secondOfDay = wholeSeconds - days * 86400;
	const { year, month, day } = civilFromDays(days);
	const hour = Math.floor(secondOfDay / 3600);
	const minute = Math.floor((secondOfDay - hour * 3600) / 60);
	const second = secondOfDay - hour * 3600 - minute * 60;
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millis, 3)}Z`;
}

function finiteNumber(value, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
	if (typeof value !== "number" || !Number.isFinite(value)) return { value: fallback, ok: false };
	if (value < min || value > max) return { value: Math.min(max, Math.max(min, value)), ok: false };
	return { value, ok: true };
}

function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function deepCopy(value) {
	if (Array.isArray(value)) return value.map(deepCopy);
	if (isPlainObject(value)) {
		const out = {};
		for (const [key, child] of Object.entries(value)) out[key] = deepCopy(child);
		return out;
	}
	return value;
}

function normalizeSource(input, partial) {
	if (input === null || input === undefined) return null;
	if (!isPlainObject(input)) {
		partial.ok = false;
		return null;
	}
	if (input.kind === "proposal") {
		const proposalId = token(input.proposalId, ID_LIMIT);
		const revision = input.revision;
		const observedSeq = input.observedSeq;
		if (proposalId === null || proposalId === "" || !Number.isSafeInteger(revision) || revision <= 0 || !Number.isSafeInteger(observedSeq) || observedSeq < 0) {
			partial.ok = false;
			return null;
		}
		let frame = null;
		if (input.frame !== null && input.frame !== undefined) {
			const label = isPlainObject(input.frame) ? token(input.frame.label) : null;
			const path = isPlainObject(input.frame) ? token(input.frame.path, ID_LIMIT) : null;
			if (label === null || path === null || label === "" || path === "") partial.ok = false;
			else frame = { label, path };
		}
		const hash = typeof input.recordedContentHash === "string" && SHA256_RE.test(input.recordedContentHash) ? input.recordedContentHash : null;
		if (input.recordedContentHash !== null && input.recordedContentHash !== undefined && hash === null) partial.ok = false;
		return { kind: "proposal", proposalId, revision, observedSeq, recordedContentHash: hash, frame };
	}
	if (input.kind === "thread") {
		const threadId = token(input.threadId, ID_LIMIT);
		const observedSeq = input.observedSeq;
		if (threadId === null || threadId === "" || !Number.isSafeInteger(observedSeq) || observedSeq < 0) {
			partial.ok = false;
			return null;
		}
		let itemId = null;
		if (input.itemId !== null && input.itemId !== undefined) {
			itemId = token(input.itemId, ID_LIMIT);
			if (itemId === null || itemId === "") {
				partial.ok = false;
				itemId = null;
			}
		}
		return { kind: "thread", threadId, itemId, observedSeq };
	}
	if (input.kind === "issue") {
		const issueId = token(input.issueId, ID_LIMIT);
		const observedSeq = input.observedSeq;
		if (issueId === null || !UUID_RE.test(issueId) || !Number.isSafeInteger(observedSeq) || observedSeq < 0) {
			partial.ok = false;
			return null;
		}
		return { kind: "issue", issueId, observedSeq };
	}
	partial.ok = false;
	return null;
}

function normalizeRect(input, partial) {
	if (!isPlainObject(input)) {
		partial.ok = false;
		return { x: 0, y: 0, w: 0, h: 0 };
	}
	const x = finiteNumber(input.x, { min: -DOCUMENT_LIMIT, max: DOCUMENT_LIMIT });
	const y = finiteNumber(input.y, { min: -DOCUMENT_LIMIT, max: DOCUMENT_LIMIT });
	const w = finiteNumber(input.w, { min: 0, max: DOCUMENT_LIMIT });
	const h = finiteNumber(input.h, { min: 0, max: DOCUMENT_LIMIT });
	if (!x.ok || !y.ok || !w.ok || !h.ok) partial.ok = false;
	return { x: x.value, y: y.value, w: w.value, h: h.value };
}

function normalizeTarget(input, partial) {
	if (input === null || input === undefined) return null;
	if (!isPlainObject(input) || !TARGET_KINDS.has(input.kind)) {
		partial.ok = false;
		return null;
	}
	const key = token(input.key);
	const label = token(input.label);
	if (key === null || label === null || key === "" || label === "") {
		partial.ok = false;
		return null;
	}
	const framePath = [];
	if (input.framePath !== undefined) {
		if (!Array.isArray(input.framePath)) {
			partial.ok = false;
		} else {
			for (const entry of input.framePath.slice(0, 1)) {
				const id = token(entry, ID_LIMIT);
				if (id === null || id === "") partial.ok = false;
				else framePath.push(id);
			}
		}
	}
	return { kind: input.kind, key, label, rect: normalizeRect(input.rect, partial), framePath };
}

function normalizeClientBuild(input, partial) {
	if (input === null || input === undefined) return null;
	if (!isPlainObject(input) || input.kind !== "page_response_manifest") {
		partial.ok = false;
		return null;
	}
	let version = null;
	if (input.version !== null && input.version !== undefined) {
		version = token(input.version, 64);
		if (version === null) partial.ok = false;
	}
	let digest = null;
	if (input.digest !== null && input.digest !== undefined) {
		if (typeof input.digest === "string" && SHA256_RE.test(input.digest)) digest = input.digest;
		else partial.ok = false;
	}
	return { kind: "page_response_manifest", version, digest };
}

function normalizeView(input, partial) {
	const source = isPlainObject(input) ? input : {};
	if (!isPlainObject(input)) partial.ok = false;
	const width = finiteNumber(source.width, { min: 0, max: 32768, fallback: 1 });
	const height = finiteNumber(source.height, { min: 0, max: 32768, fallback: 1 });
	const dpr = finiteNumber(source.dpr, { min: 0, max: 16, fallback: 1 });
	const scale = finiteNumber(source.scale, { min: 0, max: 16, fallback: 1 });
	const scrollX = finiteNumber(source.scrollX, { min: -DOCUMENT_LIMIT, max: DOCUMENT_LIMIT, fallback: 0 });
	const scrollY = finiteNumber(source.scrollY, { min: -DOCUMENT_LIMIT, max: DOCUMENT_LIMIT, fallback: 0 });
	// Width/height and dpr/scale must be strictly positive; zero is treated as unavailable.
	const positiveWidth = width.ok && width.value > 0;
	const positiveHeight = height.ok && height.value > 0;
	const positiveDpr = dpr.ok && dpr.value > 0;
	const positiveScale = scale.ok && scale.value > 0;
	if (!positiveWidth || !positiveHeight || !positiveDpr || !positiveScale || !scrollX.ok || !scrollY.ok) partial.ok = false;
	const theme = THEME_VALUES.has(source.theme) ? source.theme : "unknown";
	if (!THEME_VALUES.has(source.theme)) partial.ok = false;
	const locale = typeof source.locale === "string" && LOCALE_RE.test(source.locale) ? source.locale : "unknown";
	if (locale === "unknown" && source.locale !== "unknown") partial.ok = false;
	return {
		width: positiveWidth ? width.value : 1,
		height: positiveHeight ? height.value : 1,
		dpr: positiveDpr ? dpr.value : 1,
		scale: positiveScale ? scale.value : 1,
		scrollX: scrollX.ok ? scrollX.value : 0,
		scrollY: scrollY.ok ? scrollY.value : 0,
		theme,
		locale,
		embedded: source.embedded === true,
		viewerOpen: source.viewerOpen === true,
	};
}

function normalizeDiagnostic(entry) {
	if (!isPlainObject(entry)) return null;
	const atMs = entry.atMs;
	if (typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < -30000 || atMs > 0) return null;
	if (entry.type === "action") {
		if (!ACTION_NAMES.has(entry.name)) return null;
		return { type: "action", atMs, name: entry.name };
	}
	if (entry.type === "request") {
		if (!ROUTE_NAMES.has(entry.route)) return null;
		if (!Number.isInteger(entry.status) || entry.status < 0 || entry.status > 599) return null;
		if (typeof entry.durationMs !== "number" || !Number.isFinite(entry.durationMs) || entry.durationMs < 0 || entry.durationMs > 600000) return null;
		let errorCode = null;
		if (entry.errorCode !== null && entry.errorCode !== undefined) {
			if (!ERROR_CODES.has(entry.errorCode)) return null;
			errorCode = entry.errorCode;
		}
		return { type: "request", atMs, route: entry.route, status: entry.status, durationMs: entry.durationMs, errorCode };
	}
	if (entry.type === "script") {
		// Served basenames only; unknown source strings (including URLs with query/hash)
		// collapse to the explicit catch-all instead of retaining any part of the URL.
		const file = SCRIPT_NAMES.has(entry.file) ? entry.file : "other";
		const errorClass = ERROR_CLASSES.has(entry.errorClass) ? entry.errorClass : "other";
		if (!Number.isInteger(entry.line) || entry.line < 0 || !Number.isInteger(entry.column) || entry.column < 0) return null;
		return { type: "script", atMs, file, line: entry.line, column: entry.column, errorClass };
	}
	return null;
}

function takeUuid(uuid) {
	if (typeof uuid !== "function") throw new TypeError("freezeCapture needs an injected uuid() provider");
	const value = uuid();
	if (typeof value !== "string" || !UUID_RE.test(value)) {
		throw new TypeError("uuid() must return a lowercase canonical UUIDv4");
	}
	return value;
}

function takeNow(now) {
	if (typeof now !== "function") throw new TypeError("freezeCapture needs an injected now() provider");
	return isoFromEpochMs(now());
}

function canonicalValue(value) {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalValue(entry)).join(",")}]`;
	const entries = [];
	for (const key of Object.keys(value).sort()) entries.push(`${JSON.stringify(key)}:${canonicalValue(value[key])}`);
	return `{${entries.join(",")}}`;
}

function contextBytes(value) {
	return utf8Length(canonicalValue(value));
}

// Keep the whole frozen context inside the 32 KiB canonical-UTF-8 contract. Excerpt bytes are
// reduced first (JSON escaping can expand them), then optional collections, so a valid envelope
// never turns into a server rejection.
function enforceContextLimit(evidence, partial) {
	if (contextBytes(evidence) <= CONTEXT_BYTES) return;
	partial.ok = false;
	if (evidence.excerpt !== null) {
		const original = evidence.excerpt;
		let low = 0;
		let high = utf8Length(original);
		let best = "";
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			evidence.excerpt = clipUtf8(original, mid).text;
			evidence.excerptTruncated = true;
			if (contextBytes(evidence) <= CONTEXT_BYTES) {
				best = evidence.excerpt;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		evidence.excerpt = best;
		evidence.excerptTruncated = true;
	}
	while (contextBytes(evidence) > CONTEXT_BYTES && evidence.visibleIds.length > 0) evidence.visibleIds.pop();
	while (contextBytes(evidence) > CONTEXT_BYTES && evidence.diagnostics.length > 0) evidence.diagnostics.pop();
	if (contextBytes(evidence) > CONTEXT_BYTES) {
		evidence.source = null;
		evidence.target = null;
		evidence.clientBuild = null;
		evidence.excerpt = null;
		evidence.excerptTruncated = false;
	}
}

/**
 * Normalize and deeply freeze one capture. Only the versioned envelope fields survive; the
 * evidence object shares no mutable state with the caller's inputs.
 */
export function freezeCapture(input = {}) {
	const sourceInput = isPlainObject(input) ? input : {};
	const captureId = takeUuid(sourceInput.uuid);
	if (typeof sourceInput.now !== "function") throw new TypeError("freezeCapture needs an injected now() provider");
	const partial = { ok: true };
	const page = PAGE_VALUES.has(sourceInput.page) ? sourceInput.page : "other";
	if (!PAGE_VALUES.has(sourceInput.page)) partial.ok = false;
	const view = normalizeView(sourceInput.view, partial);
	let observedAt = canonicalIso(sourceInput.observedAt);
	if (sourceInput.observedAt !== undefined && observedAt === null) partial.ok = false;
	if (observedAt === null) observedAt = takeNow(sourceInput.now);
	const excerptEnabled = sourceInput.excerptEnabled === true;
	let excerpt = null;
	let excerptTruncated = false;
	if (excerptEnabled) {
		const clipped = clipUtf8(sourceInput.excerpt, EXCERPT_LIMIT);
		if (clipped === null) {
			if (sourceInput.excerpt !== null && sourceInput.excerpt !== undefined) partial.ok = false;
		} else {
			excerpt = clipped.text;
			excerptTruncated = clipped.truncated;
		}
	}
	const visibleIds = [];
	if (Array.isArray(sourceInput.visibleIds)) {
		for (const entry of sourceInput.visibleIds) {
			if (typeof entry !== "string") {
				partial.ok = false;
				continue;
			}
			const bytes = utf8Length(entry);
			if (bytes < 1 || bytes > ID_LIMIT) {
				partial.ok = false;
				continue;
			}
			visibleIds.push(entry);
			if (visibleIds.length === VISIBLE_LIMIT) break;
		}
	} else if (sourceInput.visibleIds !== undefined && sourceInput.visibleIds !== null) {
		partial.ok = false;
	}
	const diagnostics = [];
	if (Array.isArray(sourceInput.diagnostics)) {
		for (const entry of sourceInput.diagnostics) {
			const normalized = normalizeDiagnostic(entry);
			if (normalized === null) continue;
			diagnostics.push(deepCopy(normalized));
			if (diagnostics.length === DIAGNOSTIC_LIMIT) break;
		}
	} else if (sourceInput.diagnostics !== undefined && sourceInput.diagnostics !== null) {
		partial.ok = false;
	}
	const evidence = {
		captureId,
		observedAt,
		page,
		source: normalizeSource(sourceInput.source, partial),
		target: normalizeTarget(sourceInput.target, partial),
		clientBuild: normalizeClientBuild(sourceInput.clientBuild, partial),
		view,
		excerpt,
		excerptTruncated,
		visibleIds,
		diagnostics,
		contextStatus: "captured",
		visual: { kind: "none", reason: "not_requested" },
	};
	enforceContextLimit(evidence, partial);
	evidence.contextStatus = partial.ok ? "captured" : "partial";
	return deepFreeze(evidence);
}

/**
 * Standalone fallback when no page adapter is available. It never upgrades a missing source to
 * the newest visible data: source and excerpt stay null and contextStatus says unavailable.
 */
export function describeUnavailable(reason, options = {}) {
	void reason;
	const evidence = {
		captureId: takeUuid(options.uuid),
		observedAt: takeNow(options.now),
		page: "other",
		source: null,
		target: null,
		clientBuild: null,
		view: {
			width: 1,
			height: 1,
			dpr: 1,
			scale: 1,
			scrollX: 0,
			scrollY: 0,
			theme: "unknown",
			locale: "unknown",
			embedded: false,
			viewerOpen: false,
		},
		excerpt: null,
		excerptTruncated: false,
		visibleIds: [],
		diagnostics: [],
		contextStatus: "unavailable",
		visual: { kind: "none", reason: "not_requested" },
	};
	return deepFreeze(evidence);
}

const generations = new WeakMap();

/**
 * Capture-generation owner. begin() supersedes the previous generation; every discarded
 * generation's registered cleanups run exactly once.
 */
export function createGenerationOwner() {
	let nextId = 0;
	let current = null;
	function discard(gen) {
		const record = generations.get(gen);
		if (!record || record.done) return;
		record.done = true;
		if (current === gen) current = null;
		let firstError = null;
		for (const cleanup of record.cleanups) {
			try {
				cleanup();
			} catch (error) {
				firstError ??= error;
			}
		}
		record.cleanups.length = 0;
		if (firstError !== null) throw firstError;
	}
	const owner = {
		begin() {
			if (current !== null) discard(current);
			const gen = Object.freeze({ id: ++nextId });
			generations.set(gen, { owner, cleanups: [], done: false });
			current = gen;
			return gen;
		},
		isCurrent(gen) {
			return current === gen;
		},
		cancel(gen) {
			discard(gen);
		},
		current() {
			return current;
		},
	};
	return owner;
}

/**
 * Register a cleanup for a generation. It runs once when the generation is cancelled or
 * superseded, whichever comes first.
 */
export function onDiscard(gen, cleanup) {
	const record = generations.get(gen);
	if (!record || record.done) return false;
	if (typeof cleanup !== "function") throw new TypeError("onDiscard needs a cleanup function");
	record.cleanups.push(cleanup);
	return true;
}

/**
 * Apply a late async result only when its generation still owns the capture; otherwise drop it.
 */
export function attachLate(gen, owner, result, apply, onDrop) {
	if (owner && typeof owner.isCurrent === "function" && owner.isCurrent(gen)) {
		apply(result);
		return "applied";
	}
	onDrop(result);
	return "dropped";
}
