/* Private image evidence editor for the issue composer.
 *
 * Pure geometry, exported and DOM-free: file classification, JPEG EXIF orientation parsing,
 * orientation-normalised sizes and transforms, proportional downscale to the raster limits,
 * preview layout under a device pixel ratio, CSS<->bitmap rectangles with outward integer
 * rounding, mask union/normalisation, irreversible mask application, canonical base64 and the
 * visual envelope. test/issues-image-model.test.mjs covers these without a DOM.
 *
 * createIssueImage() is the thin DOM part: acquisition from a File, a paste DataTransfer or a
 * display-capture MediaStream; a preview canvas; pointer, touch and keyboard masks and marks in
 * final-bitmap integers; export of final opaque RGBA bytes with the masks already burned in.
 * The original File/Blob is never stored (no IndexedDB, no localStorage, no side copy); every
 * object URL is revoked and every media track stopped on success, failure, removal and release.
 * A late result from a removed or superseded acquisition is dropped and its resources released.
 *
 * Server contract (src/issues-contract.mjs, src/issues-raster.mjs): one raster with sides
 * <= 4096 and <= 2,097,152 pixels, encoding "rgba8-base64" with alpha 255; masks [{x,y,w,h}]
 * and marks [{rect:{x,y,w,h},text}] are integers inside the bitmap, at most 50 each, mark text
 * at most 256 UTF-8 bytes. The browser never produces a PNG: the server re-validates, re-applies
 * the masks and encodes the retained image itself.
 */

export const IMAGE_LIMITS = Object.freeze({
	maxSide: 4096,
	maxPixels: 2097152,
	maxRects: 50,
	markTextBytes: 256,
	fileBytes: 10485760,
});

export const ACCEPTED_TYPES = Object.freeze(["image/png", "image/jpeg", "image/webp"]);
export const NONE_REASONS = Object.freeze(["not_requested", "unsupported", "denied", "failed", "removed"]);

const HEAD_BYTES = 131072;
const MIN_DRAW_CSS = 6;
const KEY_STEP_CSS = 8;
const DEFAULT_BOX_FRACTION = 0.25;
const EPSILON = 1e-6;

export class IssueImageError extends Error {
	constructor(code, message) {
		super(message ?? code);
		this.name = "IssueImageError";
		this.code = code;
	}
}

class IssueImageCancelled extends Error {
	constructor(code) {
		super(code);
		this.name = "IssueImageCancelled";
		this.code = code;
	}
}

function limitsOf(limits) {
	return { ...IMAGE_LIMITS, ...(limits && typeof limits === "object" ? limits : {}) };
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

/** Accept browser-decodable PNG/JPEG/WebP up to the file limit; everything else is unsupported. */
export function classifyFile(file, limits = IMAGE_LIMITS) {
	const caps = limitsOf(limits);
	const type = file && typeof file.type === "string" ? file.type.toLowerCase() : "";
	const size = file ? Number(file.size) : NaN;
	if (!ACCEPTED_TYPES.includes(type)) return { ok: false, reason: "unsupported", code: "mime", type };
	if (!Number.isFinite(size) || size <= 0) return { ok: false, reason: "unsupported", code: "empty", type };
	if (size > caps.fileBytes) return { ok: false, reason: "unsupported", code: "size", type };
	return { ok: true, type, size };
}

function isSof(marker) {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function exifOrientation(bytes, start, end) {
	if (end - start < 14) return 0;
	const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
	for (let i = 0; i < exif.length; i++) if (bytes[start + i] !== exif[i]) return 0;
	const tiff = start + 6;
	const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
	const big = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d;
	if (!little && !big) return 0;
	const u16 = (at) => (at + 2 <= end ? (little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1]) : -1);
	const u32 = (at) => {
		if (at + 4 > end) return -1;
		return little
			? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0
			: ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
	};
	if (u16(tiff + 2) !== 0x2a) return 0;
	const offset = u32(tiff + 4);
	if (offset < 8) return 0;
	const ifd = tiff + offset;
	const count = u16(ifd);
	if (count < 0) return 0;
	for (let i = 0; i < count; i++) {
		const entry = ifd + 2 + i * 12;
		if (entry + 12 > end) return 0;
		if (u16(entry) !== 0x0112) continue;
		const value = u16(entry + 8);
		return value >= 1 && value <= 8 ? value : 0;
	}
	return 0;
}

/**
 * Read the EXIF orientation (1..8, 1 when absent or unreadable) and the SOF frame size from the
 * head of a JPEG. Linear scan of marker segments; truncated input yields what was readable.
 */
export function readJpegInfo(input) {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	const out = { jpeg: false, orientation: 1, width: null, height: null };
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return out;
	out.jpeg = true;
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if (marker === 0xd9 || marker === 0xda) break;
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		if (length < 2) break;
		const start = offset + 4;
		const end = offset + 2 + length;
		if (end > bytes.length) break;
		if (marker === 0xe1 && out.orientation === 1) {
			const orientation = exifOrientation(bytes, start, end);
			if (orientation !== 0) out.orientation = orientation;
		} else if (isSof(marker) && out.width === null && end - start >= 5) {
			out.height = (bytes[start + 1] << 8) | bytes[start + 2];
			out.width = (bytes[start + 3] << 8) | bytes[start + 4];
		}
		offset = end;
	}
	return out;
}

/** Size of the displayed (orientation-normalised) image for a raw width/height. */
export function orientedSize(width, height, orientation = 1) {
	const rotated = orientation >= 5 && orientation <= 8;
	return rotated ? { width: height, height: width, rotated: true } : { width, height, rotated: false };
}

/**
 * Canvas transform [a,b,c,d,e,f] that draws a raw width x height image into its oriented frame
 * (orientedSize). Raw point (x,y) lands at (a*x + c*y + e, b*x + d*y + f).
 */
export function orientationTransform(orientation, width, height) {
	switch (orientation) {
		case 2:
			return [-1, 0, 0, 1, width, 0];
		case 3:
			return [-1, 0, 0, -1, width, height];
		case 4:
			return [1, 0, 0, -1, 0, height];
		case 5:
			return [0, 1, 1, 0, 0, 0];
		case 6:
			return [0, 1, -1, 0, height, 0];
		case 7:
			return [0, -1, -1, 0, height, width];
		case 8:
			return [0, -1, 1, 0, 0, width];
		default:
			return [1, 0, 0, 1, 0, 0];
	}
}

/** Proportional downscale only when the raster limits require it; never upscale, never crop. */
export function fitToLimits(width, height, limits = IMAGE_LIMITS) {
	const caps = limitsOf(limits);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new IssueImageError("bad_size", "image size must be positive");
	const scale = Math.min(1, caps.maxSide / width, caps.maxSide / height, Math.sqrt(caps.maxPixels / (width * height)));
	if (scale >= 1) return { width: Math.round(width), height: Math.round(height), scale: 1 };
	let fitWidth = Math.max(1, Math.floor(width * scale + EPSILON));
	let fitHeight = Math.max(1, Math.floor(height * scale + EPSILON));
	while (fitWidth * fitHeight > caps.maxPixels) {
		if (fitWidth >= fitHeight) fitWidth -= 1;
		else fitHeight -= 1;
	}
	return { width: fitWidth, height: fitHeight, scale };
}

/** Preview box for a bitmap: fits the CSS box without upscaling; the backing store follows dpr. */
export function previewLayout({ bitmapWidth, bitmapHeight, maxCssWidth, maxCssHeight = Infinity, dpr = 1 }) {
	if (!(bitmapWidth > 0) || !(bitmapHeight > 0) || !(maxCssWidth > 0) || !(maxCssHeight > 0)) throw new IssueImageError("bad_layout", "layout needs positive sizes");
	const fit = Math.min(1, maxCssWidth / bitmapWidth, maxCssHeight / bitmapHeight);
	const cssWidth = Math.max(1, Math.floor(bitmapWidth * fit + EPSILON));
	const cssHeight = Math.max(1, Math.round(bitmapHeight * (cssWidth / bitmapWidth)));
	const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
	return {
		cssWidth,
		cssHeight,
		scale: bitmapWidth / cssWidth,
		dpr: ratio,
		backingWidth: Math.max(1, Math.round(cssWidth * ratio)),
		backingHeight: Math.max(1, Math.round(cssHeight * ratio)),
	};
}

/**
 * CSS-pixel rectangle relative to the preview -> final-bitmap integer rectangle. Rounds outward so
 * every touched pixel is covered, clamps to the bitmap, and yields null for an empty result.
 * The mapping depends on the preview scale only; the device pixel ratio never enters it.
 */
export function cssRectToBitmapRect(rect, { scale, bitmapWidth, bitmapHeight }) {
	if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || !(scale > 0)) return null;
	if (!(bitmapWidth > 0) || !(bitmapHeight > 0)) return null;
	const left = Math.min(rect.x, rect.x + rect.w);
	const right = Math.max(rect.x, rect.x + rect.w);
	const top = Math.min(rect.y, rect.y + rect.h);
	const bottom = Math.max(rect.y, rect.y + rect.h);
	const x0 = clamp(Math.floor(left * scale + EPSILON), 0, bitmapWidth);
	const x1 = clamp(Math.ceil(right * scale - EPSILON), 0, bitmapWidth);
	const y0 = clamp(Math.floor(top * scale + EPSILON), 0, bitmapHeight);
	const y1 = clamp(Math.ceil(bottom * scale - EPSILON), 0, bitmapHeight);
	if (x1 - x0 < 1 || y1 - y0 < 1) return null;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Final-bitmap rectangle -> CSS pixels at the given preview scale. */
export function bitmapRectToCss(rect, { scale }) {
	if (!rect || !(scale > 0)) return null;
	return { x: rect.x / scale, y: rect.y / scale, w: rect.w / scale, h: rect.h / scale };
}

function contains(outer, inner) {
	return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/**
 * Clip integer rectangles to the bitmap, drop empty ones, and reduce the set to its union
 * representatives (a rectangle fully inside another adds no coverage). Enforces the count limit.
 */
export function normalizeRects(rects, width, height, limit = IMAGE_LIMITS.maxRects) {
	if (!Array.isArray(rects)) return { ok: false, code: "shape" };
	const clipped = [];
	for (const rect of rects) {
		if (!rect || typeof rect !== "object" || ![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger)) return { ok: false, code: "integer" };
		const x0 = Math.max(0, rect.x);
		const y0 = Math.max(0, rect.y);
		const x1 = Math.min(width, rect.x + rect.w);
		const y1 = Math.min(height, rect.y + rect.h);
		if (x1 - x0 < 1 || y1 - y0 < 1) continue;
		clipped.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
	}
	const kept = clipped.filter((rect, index) => !clipped.some((other, otherIndex) => otherIndex !== index && contains(other, rect) && !(contains(rect, other) && otherIndex > index)));
	if (kept.length > limit) return { ok: false, code: "too_many", count: kept.length };
	return { ok: true, rects: kept };
}

/** Burn opaque black into every masked pixel; identical to the server's reapplication. */
export function applyMasks(rgba, width, height, masks) {
	for (const { x, y, w, h } of masks) {
		for (let row = y; row < y + h; row++) {
			const start = (row * width + x) * 4;
			const end = start + w * 4;
			for (let i = start; i < end; i += 4) {
				rgba[i] = 0;
				rgba[i + 1] = 0;
				rgba[i + 2] = 0;
				rgba[i + 3] = 255;
			}
		}
	}
	return rgba;
}

/** Force alpha 255 on every pixel (the canvas is flattened onto white; this guarantees it). */
export function opaque(rgba) {
	for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
	return rgba;
}

/** Canonical base64 of raw bytes, chunked so multi-megabyte rasters never overflow the stack. */
export function encodeBase64(bytes) {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const chunk = 0x8000;
	let binary = "";
	for (let i = 0; i < view.length; i += chunk) binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
	return btoa(binary);
}

export function utf8ByteLength(text) {
	return new TextEncoder().encode(text).length;
}

export function markTextOk(text, limits = IMAGE_LIMITS) {
	if (text === null || text === undefined) return true;
	return typeof text === "string" && utf8ByteLength(text) <= limitsOf(limits).markTextBytes;
}

/** The `visual` member of the issue evidence envelope for an exported raster. */
export function buildVisual({ width, height, pixels, masks = [], marks = [], provenance, acquiredAt = null }) {
	return {
		kind: "raster",
		provenance,
		acquiredAt,
		sourceMatchesContext: "unverified",
		width,
		height,
		encoding: "rgba8-base64",
		pixels,
		masks: masks.map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })),
		marks: marks.map((mark) => ({ rect: { x: mark.rect.x, y: mark.rect.y, w: mark.rect.w, h: mark.rect.h }, text: mark.text ?? null })),
	};
}

/** Map an acquisition failure to the envelope's `visual: none` reason plus a stable detail code. */
export function noneReasonFor(error) {
	const name = error && typeof error.name === "string" ? error.name : "";
	if (name === "IssueImageCancelled") return { reason: "removed", code: typeof error.code === "string" ? error.code : "cancelled" };
	if (name === "NotAllowedError" || name === "PermissionDeniedError") return { reason: "denied", code: "permission" };
	if (name === "NotSupportedError" || name === "NotFoundError" || name === "OverconstrainedError") return { reason: "unsupported", code: "capture" };
	if (name === "SecurityError") return { reason: "failed", code: "tainted" };
	if (name === "EncodingError") return { reason: "failed", code: "decode" };
	if (name === "NotReadableError" || name === "AbortError" || name === "InvalidStateError") return { reason: "failed", code: "source" };
	return { reason: "failed", code: "other" };
}

const REASON_TEXT = {
	mime: "지원하지 않는 파일",
	empty: "빈 파일",
	decode: "사진을 읽지 못했습니다",
	tainted: "사진을 읽지 못했습니다",
	permission: "화면 캡처를 허용하지 않았습니다",
	capture: "이 브라우저는 화면 캡처를 지원하지 않습니다",
	source: "화면을 가져오지 못했습니다",
	other: "사진을 가져오지 못했습니다",
};

function detectOrientationApplied(info, naturalWidth, naturalHeight) {
	if (info.orientation === 1) return true;
	if (info.orientation < 5 || info.width === null || info.height === null || info.width === info.height) return null;
	return naturalWidth === info.height && naturalHeight === info.width;
}

function toIso(value) {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The DOM editor. `document` and `now` are required; `limits` overrides IMAGE_LIMITS (from
 * capabilities); `createObjectURL`/`revokeObjectURL`, `mediaDevices`, `isSecureContext` and
 * `devicePixelRatio` default to the document's window and exist for injection in QA.
 */
export function createIssueImage({ document, now, limits, createObjectURL, revokeObjectURL, mediaDevices, isSecureContext, devicePixelRatio } = {}) {
	if (!document || typeof document.createElement !== "function") throw new TypeError("createIssueImage needs a document");
	if (typeof now !== "function") throw new TypeError("createIssueImage needs now()");
	const caps = limitsOf(limits);
	const view = document.defaultView ?? null;
	const urlApi = view && view.URL ? view.URL : globalThis.URL;
	const makeUrl = typeof createObjectURL === "function" ? createObjectURL : (blob) => urlApi.createObjectURL(blob);
	const dropUrl = typeof revokeObjectURL === "function" ? revokeObjectURL : (url) => urlApi.revokeObjectURL(url);
	const mediaOf = () => (mediaDevices !== undefined ? mediaDevices : (view && view.navigator ? view.navigator.mediaDevices : null) ?? null);
	const secure = () => (isSecureContext !== undefined ? isSecureContext === true : Boolean(view && view.isSecureContext));
	const dprOf = () => (devicePixelRatio !== undefined ? devicePixelRatio : view && view.devicePixelRatio) || 1;

	const state = {
		status: "empty",
		reason: "not_requested",
		code: null,
		notice: null,
		tool: null,
		width: 0,
		height: 0,
		masks: [],
		marks: [],
		history: [],
		selectedMark: -1,
		pending: null,
		drag: null,
		provenance: null,
		source: null,
		acquiredAt: null,
	};
	const stats = {
		objectUrls: { created: 0, revoked: 0 },
		tracks: { seen: 0, stopped: 0 },
		videos: { attached: 0, detached: 0 },
		attempts: { started: 0, applied: 0, failed: 0, dropped: 0 },
	};
	const listeners = new Set();
	let bitmap = null;
	let layout = null;
	let generation = 0;
	let attempt = null;
	let released = false;
	let resizeObserver = null;

	function el(tag, className) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		return node;
	}
	function button(label, data) {
		const node = el("button");
		node.type = "button";
		node.textContent = label;
		for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
		return node;
	}

	const root = el("div", "issue-image");
	const stage = el("div", "issue-image__stage");
	stage.tabIndex = 0;
	stage.setAttribute("role", "group");
	stage.setAttribute("aria-label", "사진 편집");
	const canvas = el("canvas", "issue-image__canvas");
	const layer = el("div", "issue-image__layer");
	stage.append(canvas, layer);
	const tools = el("div", "issue-image__tools");
	tools.setAttribute("role", "toolbar");
	tools.setAttribute("aria-label", "사진 도구");
	const maskButton = button("가리기", { tool: "mask" });
	const markButton = button("표시하기", { tool: "mark" });
	const undoButton = button("되돌리기", { action: "undo" });
	const removeButton = button("사진 지우기", { action: "remove" });
	tools.append(maskButton, markButton, undoButton, removeButton);
	const note = el("label", "issue-image__note");
	const noteLabel = el("span");
	const noteInput = el("input");
	noteInput.type = "text";
	noteInput.autocomplete = "off";
	noteInput.setAttribute("aria-label", "표시 메모");
	note.append(noteLabel, noteInput);
	const status = el("p", "issue-image__status");
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	root.append(stage, tools, note, status);

	function snapshot() {
		return {
			status: state.status,
			reason: state.status === "ready" ? null : state.reason,
			code: state.code,
			tool: state.tool,
			width: state.width,
			height: state.height,
			masks: state.masks.map((rect) => ({ ...rect })),
			marks: state.marks.map((mark) => ({ rect: { ...mark.rect }, text: mark.text })),
			selectedMark: state.selectedMark,
			pending: state.pending ? { ...state.pending } : null,
			provenance: state.provenance,
			source: state.source ? { ...state.source } : null,
			acquiredAt: state.acquiredAt,
			stats: JSON.parse(JSON.stringify(stats)),
		};
	}
	function emit() {
		const current = snapshot();
		for (const listener of listeners) {
			try {
				listener(current);
			} catch {
				// a listener failure never breaks the editor
			}
		}
		const EventCtor = view && view.CustomEvent ? view.CustomEvent : globalThis.CustomEvent;
		if (typeof EventCtor === "function") root.dispatchEvent(new EventCtor("issue-image-change", { bubbles: true }));
	}

	function createUrl(blob) {
		const url = makeUrl(blob);
		stats.objectUrls.created += 1;
		return url;
	}
	function revokeUrl(url) {
		stats.objectUrls.revoked += 1;
		try {
			dropUrl(url);
		} catch {
			// an already-revoked URL is not a failure
		}
	}
	function stopStream(stream) {
		if (!stream || typeof stream.getTracks !== "function") return;
		for (const track of stream.getTracks()) {
			stats.tracks.stopped += 1;
			try {
				track.stop();
			} catch {
				// a stopped track is the goal either way
			}
		}
	}
	function disposeBitmap(target) {
		if (!target) return;
		target.canvas.width = 0;
		target.canvas.height = 0;
	}

	function beginAttempt(kind) {
		if (released) throw new IssueImageError("released", "the editor was released");
		if (attempt) attempt.cancel("superseded");
		const token = {
			gen: ++generation,
			kind,
			cancelled: null,
			waiters: new Set(),
			cancel(code) {
				if (token.cancelled !== null) return;
				token.cancelled = code;
				for (const reject of token.waiters) reject(new IssueImageCancelled(code));
				token.waiters.clear();
			},
		};
		attempt = token;
		stats.attempts.started += 1;
		disposeBitmap(bitmap);
		bitmap = null;
		state.status = "loading";
		state.notice = null;
		state.pending = null;
		state.drag = null;
		render();
		emit();
		return token;
	}
	function isLive(token) {
		return attempt === token && token.cancelled === null && !released;
	}
	function waitWith(token, executor) {
		return new Promise((resolve, reject) => {
			if (token.cancelled !== null) {
				reject(new IssueImageCancelled(token.cancelled));
				return;
			}
			const fail = (error) => {
				token.waiters.delete(fail);
				reject(error);
			};
			token.waiters.add(fail);
			executor((value) => {
				token.waiters.delete(fail);
				resolve(value);
			}, fail);
		});
	}
	function dropped(token) {
		stats.attempts.dropped += 1;
		return { ok: false, handled: true, reason: "removed", code: token.cancelled ?? "superseded", dropped: true };
	}
	function settleFailure(token, reason, code) {
		if (!isLive(token)) return dropped(token);
		attempt = null;
		stats.attempts.failed += 1;
		state.status = "error";
		state.reason = reason;
		state.code = code;
		resetMarks();
		render();
		emit();
		return { ok: false, handled: true, reason, code };
	}
	// A fresh or missing image starts with no tool active, so pointer scrolling works by default.
	function resetMarks() {
		state.masks = [];
		state.marks = [];
		state.history = [];
		state.selectedMark = -1;
		state.pending = null;
		state.drag = null;
		state.tool = null;
		state.width = 0;
		state.height = 0;
		state.provenance = null;
		state.source = null;
		state.acquiredAt = null;
	}
	function paint(width, height, draw) {
		const target = el("canvas");
		target.width = width;
		target.height = height;
		const ctx = target.getContext("2d");
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, width, height);
		draw(ctx);
		// A tainted canvas throws SecurityError here, before any pixel could be exported.
		ctx.getImageData(0, 0, 1, 1);
		return { canvas: target, ctx, width, height };
	}
	function commit(token, painted, meta) {
		if (!isLive(token)) {
			disposeBitmap(painted);
			return dropped(token);
		}
		attempt = null;
		stats.attempts.applied += 1;
		resetMarks();
		bitmap = painted;
		state.status = "ready";
		state.reason = "not_requested";
		state.code = null;
		state.width = painted.width;
		state.height = painted.height;
		state.provenance = meta.provenance;
		state.source = {
			kind: meta.kind,
			originalWidth: meta.rawWidth,
			originalHeight: meta.rawHeight,
			orientation: meta.orientation,
			rotated: meta.rotated,
			orientationApplied: meta.orientationApplied,
			scale: meta.fit.scale,
		};
		state.acquiredAt = toIso(now());
		layout = null;
		render();
		emit();
		return { ok: true, width: state.width, height: state.height, provenance: state.provenance, source: { ...state.source }, acquiredAt: state.acquiredAt };
	}

	async function acquireBlob(blob, kind, provenance) {
		const token = beginAttempt(kind);
		const classified = classifyFile(blob, caps);
		if (!classified.ok) return settleFailure(token, classified.reason, classified.code);
		const img = el("img");
		img.decoding = "async";
		let url = null;
		try {
			let info = { jpeg: false, orientation: 1, width: null, height: null };
			if (classified.type === "image/jpeg") {
				const head = await waitWith(token, (resolve, reject) => blob.slice(0, HEAD_BYTES).arrayBuffer().then(resolve, reject));
				info = readJpegInfo(new Uint8Array(head));
			}
			url = createUrl(blob);
			img.src = url;
			await waitWith(token, (resolve, reject) => img.decode().then(resolve, reject));
			const naturalWidth = img.naturalWidth;
			const naturalHeight = img.naturalHeight;
			if (!(naturalWidth > 0 && naturalHeight > 0)) throw new DOMException("empty image", "EncodingError");
			const rawWidth = info.width ?? naturalWidth;
			const rawHeight = info.height ?? naturalHeight;
			const oriented = orientedSize(rawWidth, rawHeight, info.orientation);
			const applied = detectOrientationApplied(info, naturalWidth, naturalHeight);
			const orientedWidth = applied === false ? oriented.width : naturalWidth;
			const orientedHeight = applied === false ? oriented.height : naturalHeight;
			const fit = fitToLimits(orientedWidth, orientedHeight, caps);
			const painted = paint(fit.width, fit.height, (ctx) => {
				if (applied === false) {
					ctx.scale(fit.width / orientedWidth, fit.height / orientedHeight);
					ctx.transform(...orientationTransform(info.orientation, naturalWidth, naturalHeight));
					ctx.drawImage(img, 0, 0, naturalWidth, naturalHeight);
				} else {
					ctx.drawImage(img, 0, 0, fit.width, fit.height);
				}
			});
			return commit(token, painted, {
				kind,
				provenance,
				rawWidth,
				rawHeight,
				orientation: info.orientation,
				rotated: oriented.rotated,
				orientationApplied: applied,
				fit,
			});
		} catch (error) {
			const mapped = noneReasonFor(error);
			return settleFailure(token, mapped.reason, mapped.code);
		} finally {
			if (url !== null) revokeUrl(url);
			img.removeAttribute("src");
		}
	}

	function waitForVideoFrame(video, stream, resolve, reject) {
		const [track] = stream.getVideoTracks();
		if (!track) {
			reject(new DOMException("no video track", "NotReadableError"));
			return;
		}
		if (track.readyState === "ended") {
			reject(new DOMException("track ended", "NotReadableError"));
			return;
		}
		track.addEventListener("ended", () => reject(new DOMException("track ended", "NotReadableError")), { once: true });
		video.addEventListener("error", () => reject(new DOMException("video failed", "NotReadableError")), { once: true });
		const ready = () => {
			if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback(() => resolve());
			else video.addEventListener("playing", () => resolve(), { once: true });
			const playing = video.play();
			if (playing && typeof playing.catch === "function") playing.catch(reject);
		};
		if (video.readyState >= 1) ready();
		else video.addEventListener("loadedmetadata", ready, { once: true });
	}

	async function captureFrame(token, streamPromise) {
		let stream = null;
		const video = el("video");
		video.muted = true;
		video.playsInline = true;
		video.setAttribute("playsinline", "");
		const source = Promise.resolve(streamPromise);
		let consumed = false;
		const waiting = waitWith(token, (resolve, reject) => source.then((value) => {
			if (token.cancelled === null) consumed = true;
			resolve(value);
		}, reject));
		// Registered after the consuming handler: a stream that arrives once this attempt was
		// cancelled is stopped as soon as it exists instead of leaking.
		source.then((late) => {
			if (!consumed) stopStream(late);
		}, () => {});
		try {
			stream = await waiting;
			if (!stream || typeof stream.getTracks !== "function") throw new DOMException("no stream", "NotReadableError");
			stats.tracks.seen += stream.getTracks().length;
			stats.videos.attached += 1;
			video.srcObject = stream;
			await waitWith(token, (resolve, reject) => waitForVideoFrame(video, stream, resolve, reject));
			const frameWidth = video.videoWidth;
			const frameHeight = video.videoHeight;
			if (!(frameWidth > 0 && frameHeight > 0)) throw new DOMException("no frame", "NotReadableError");
			const fit = fitToLimits(frameWidth, frameHeight, caps);
			const painted = paint(fit.width, fit.height, (ctx) => ctx.drawImage(video, 0, 0, fit.width, fit.height));
			return commit(token, painted, {
				kind: "capture",
				provenance: "display_capture",
				rawWidth: frameWidth,
				rawHeight: frameHeight,
				orientation: 1,
				rotated: false,
				orientationApplied: true,
				fit,
			});
		} catch (error) {
			const mapped = noneReasonFor(error);
			return settleFailure(token, mapped.reason, mapped.code);
		} finally {
			stopStream(stream);
			if (video.srcObject) {
				video.srcObject = null;
				stats.videos.detached += 1;
			}
			video.removeAttribute("src");
		}
	}

	function supportsCapture() {
		const media = mediaOf();
		return secure() && Boolean(media) && typeof media.getDisplayMedia === "function";
	}

	/**
	 * Display capture. With no argument the call to getDisplayMedia happens synchronously inside
	 * this function so it still carries the click's user activation. A MediaStream or a factory
	 * returning one is accepted for callers that already own a stream.
	 */
	function acquireCapture(input) {
		const token = beginAttempt("capture");
		let streamPromise;
		try {
			if (input && typeof input.getTracks === "function") streamPromise = Promise.resolve(input);
			else if (typeof input === "function") streamPromise = Promise.resolve(input());
			else if (!supportsCapture()) return Promise.resolve(settleFailure(token, "unsupported", "capture"));
			else streamPromise = mediaOf().getDisplayMedia({ video: true, audio: false });
		} catch (error) {
			const mapped = noneReasonFor(error);
			return Promise.resolve(settleFailure(token, mapped.reason, mapped.code));
		}
		return captureFrame(token, streamPromise);
	}

	function acquireFile(file) {
		return acquireBlob(file, "file", "user_upload");
	}

	function acquirePaste(clipboardData) {
		const items = clipboardData && clipboardData.items ? Array.from(clipboardData.items) : [];
		const fileItem = items.find((item) => item.kind === "file" && typeof item.type === "string" && item.type.startsWith("image/"));
		let file = fileItem && typeof fileItem.getAsFile === "function" ? fileItem.getAsFile() : null;
		if (!file && clipboardData && clipboardData.files) {
			file = Array.from(clipboardData.files).find((entry) => typeof entry.type === "string" && entry.type.startsWith("image/")) ?? null;
		}
		if (!file) return Promise.resolve({ ok: false, handled: false, reason: "not_requested", code: "no_image" });
		return acquireBlob(file, "paste", "user_upload");
	}

	/** Any CanvasImageSource (img, canvas, bitmap, video) already decoded by the caller. */
	async function acquireSource(source, { kind = "file", provenance = "user_upload" } = {}) {
		const token = beginAttempt(kind);
		try {
			const width = source ? source.naturalWidth || source.videoWidth || source.width || 0 : 0;
			const height = source ? source.naturalHeight || source.videoHeight || source.height || 0 : 0;
			if (!(width > 0 && height > 0)) throw new DOMException("empty source", "EncodingError");
			const fit = fitToLimits(width, height, caps);
			const painted = paint(fit.width, fit.height, (ctx) => ctx.drawImage(source, 0, 0, fit.width, fit.height));
			return commit(token, painted, { kind, provenance, rawWidth: width, rawHeight: height, orientation: 1, rotated: false, orientationApplied: true, fit });
		} catch (error) {
			const mapped = noneReasonFor(error);
			return settleFailure(token, mapped.reason, mapped.code);
		}
	}

	function statusText() {
		if (state.notice === "too_many") return `가림과 표시는 각각 ${caps.maxRects}개까지`;
		if (state.notice === "mark_text") return `메모는 ${caps.markTextBytes}바이트까지`;
		if (state.status === "loading") return "불러오는 중";
		if (state.status === "error") {
			if (state.code === "size") return `${Math.round(caps.fileBytes / 1048576)} MiB까지 올릴 수 있습니다`;
			return REASON_TEXT[state.code] ?? REASON_TEXT.other;
		}
		if (state.status === "ready") {
			const parts = [`${state.width}×${state.height}`];
			if (state.source && state.source.scale < 1) parts[0] += ` (원본 ${state.source.originalWidth}×${state.source.originalHeight})`;
			if (state.masks.length > 0) parts.push(`가림 ${state.masks.length}`);
			if (state.marks.length > 0) parts.push(`표시 ${state.marks.length}`);
			return parts.join(" · ");
		}
		return state.reason === "removed" ? "사진을 지웠습니다" : "사진 없음";
	}

	function boxNode(rect, kind, label) {
		const node = el("div", `issue-image__box issue-image__box--${kind}`);
		node.style.left = `${(rect.x / state.width) * 100}%`;
		node.style.top = `${(rect.y / state.height) * 100}%`;
		node.style.width = `${(rect.w / state.width) * 100}%`;
		node.style.height = `${(rect.h / state.height) * 100}%`;
		if (label !== undefined) {
			const badge = el("span", "issue-image__badge");
			badge.textContent = String(label);
			node.append(badge);
		}
		return node;
	}
	function drawBoxes() {
		const nodes = [];
		for (const rect of state.masks) nodes.push(boxNode(rect, "mask"));
		state.marks.forEach((mark, index) => {
			nodes.push(boxNode(mark.rect, "mark", index + 1));
		});
		if (state.drag) {
			const rect = dragRect();
			if (rect) nodes.push(boxNode(rect, `pending issue-image__box--${state.tool}-pending`));
		} else if (state.pending) {
			nodes.push(boxNode(state.pending, `pending issue-image__box--${state.tool}-pending`));
		}
		layer.replaceChildren(...nodes);
	}
	function drawPreview() {
		const maxCssWidth = root.clientWidth - 2;
		if (!(maxCssWidth > 0) || !bitmap) return;
		const maxCssHeight = view && view.innerHeight > 0 ? Math.max(120, Math.floor(view.innerHeight * 0.6)) : Infinity;
		const next = previewLayout({ bitmapWidth: state.width, bitmapHeight: state.height, maxCssWidth, maxCssHeight, dpr: dprOf() });
		const changed = !layout || layout.cssWidth !== next.cssWidth || layout.cssHeight !== next.cssHeight || layout.backingWidth !== next.backingWidth || layout.backingHeight !== next.backingHeight;
		layout = next;
		if (changed) {
			canvas.width = next.backingWidth;
			canvas.height = next.backingHeight;
			canvas.style.width = `${next.cssWidth}px`;
			canvas.style.height = `${next.cssHeight}px`;
			stage.style.width = `${next.cssWidth}px`;
			const ctx = canvas.getContext("2d");
			ctx.imageSmoothingEnabled = true;
			ctx.drawImage(bitmap.canvas, 0, 0, next.backingWidth, next.backingHeight);
		}
	}
	function render() {
		root.dataset.state = state.status;
		root.dataset.notes = state.marks.length > 0 ? "true" : "false";
		maskButton.setAttribute("aria-pressed", state.tool === "mask" ? "true" : "false");
		markButton.setAttribute("aria-pressed", state.tool === "mark" ? "true" : "false");
		undoButton.disabled = state.history.length === 0;
		if (state.tool) stage.dataset.tool = state.tool;
		else delete stage.dataset.tool;
		status.textContent = statusText();
		if (state.status === "ready" && bitmap) {
			drawPreview();
			drawBoxes();
		} else {
			layout = null;
			canvas.width = 0;
			canvas.height = 0;
			canvas.removeAttribute("style");
			stage.removeAttribute("style");
			layer.replaceChildren();
		}
		const mark = state.marks[state.selectedMark];
		if (mark) {
			noteLabel.textContent = `표시 ${state.selectedMark + 1} 메모`;
			if (noteInput.value !== (mark.text ?? "")) noteInput.value = mark.text ?? "";
			noteInput.setAttribute("aria-invalid", markTextOk(mark.text, caps) ? "false" : "true");
		} else {
			noteLabel.textContent = "메모";
			noteInput.value = "";
			noteInput.setAttribute("aria-invalid", "false");
		}
	}

	function currentScale() {
		const rect = canvas.getBoundingClientRect();
		if (!(rect.width > 0)) return null;
		return { rect, scale: state.width / rect.width };
	}
	function dragRect() {
		const drag = state.drag;
		if (!drag) return null;
		const css = {
			x: Math.min(drag.start.x, drag.current.x),
			y: Math.min(drag.start.y, drag.current.y),
			w: Math.abs(drag.current.x - drag.start.x),
			h: Math.abs(drag.current.y - drag.start.y),
		};
		if (css.w < MIN_DRAW_CSS || css.h < MIN_DRAW_CSS) return null;
		return cssRectToBitmapRect(css, { scale: drag.scale, bitmapWidth: state.width, bitmapHeight: state.height });
	}
	function addRect(tool, rect) {
		if (!rect || state.status !== "ready") return false;
		const list = tool === "mask" ? state.masks : state.marks;
		if (list.length >= caps.maxRects) {
			state.notice = "too_many";
			render();
			return false;
		}
		const normalized = normalizeRects([rect], state.width, state.height, caps.maxRects);
		if (!normalized.ok || normalized.rects.length === 0) return false;
		const clean = normalized.rects[0];
		if (tool === "mask") state.masks.push(clean);
		else {
			state.marks.push({ rect: clean, text: null });
			state.selectedMark = state.marks.length - 1;
		}
		state.history.push(tool);
		state.notice = null;
		render();
		emit();
		return true;
	}
	function defaultBox() {
		const w = Math.max(1, Math.round(state.width * DEFAULT_BOX_FRACTION));
		const h = Math.max(1, Math.round(state.height * DEFAULT_BOX_FRACTION));
		return { x: Math.round((state.width - w) / 2), y: Math.round((state.height - h) / 2), w, h };
	}
	function keyStep() {
		return Math.max(1, Math.round((layout ? layout.scale : 1) * KEY_STEP_CSS));
	}
	function nudge(pending, dx, dy, resize) {
		const step = keyStep();
		const next = { ...pending };
		if (resize) {
			next.w = clamp(next.w + dx * step, 1, state.width - next.x);
			next.h = clamp(next.h + dy * step, 1, state.height - next.y);
		} else {
			next.x = clamp(next.x + dx * step, 0, state.width - next.w);
			next.y = clamp(next.y + dy * step, 0, state.height - next.h);
		}
		return next;
	}

	stage.addEventListener("pointerdown", (event) => {
		if (state.status !== "ready" || !state.tool) return;
		if (event.pointerType === "mouse" && event.button !== 0) return;
		const measured = currentScale();
		if (!measured) return;
		const point = { x: event.clientX - measured.rect.left, y: event.clientY - measured.rect.top };
		state.drag = { pointerId: event.pointerId, start: point, current: point, scale: measured.scale, left: measured.rect.left, top: measured.rect.top };
		state.pending = null;
		try {
			stage.setPointerCapture(event.pointerId);
		} catch {
			// capture is an optimisation; move/up still arrive while the pointer stays inside
		}
		event.preventDefault();
		if (typeof stage.focus === "function") stage.focus({ preventScroll: true });
		drawBoxes();
	});
	stage.addEventListener("pointermove", (event) => {
		const drag = state.drag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		drag.current = { x: event.clientX - drag.left, y: event.clientY - drag.top };
		event.preventDefault();
		drawBoxes();
	});
	const finishDrag = (event) => {
		const drag = state.drag;
		if (!drag || drag.pointerId !== event.pointerId) return;
		if (event.type === "pointerup") drag.current = { x: event.clientX - drag.left, y: event.clientY - drag.top };
		const rect = event.type === "pointerup" ? dragRect() : null;
		state.drag = null;
		try {
			stage.releasePointerCapture(event.pointerId);
		} catch {
			// already released
		}
		event.preventDefault();
		if (!addRect(state.tool, rect)) {
			render();
		}
	};
	stage.addEventListener("pointerup", finishDrag);
	stage.addEventListener("pointercancel", finishDrag);

	stage.addEventListener("keydown", (event) => {
		if (state.status !== "ready") return;
		const key = event.key;
		if (key === "Backspace" || key === "Delete") {
			if (state.pending) state.pending = null;
			else undo();
			event.preventDefault();
			render();
			return;
		}
		if (!state.tool) return;
		if (key === "Enter" || key === " ") {
			if (state.pending) {
				const pending = state.pending;
				state.pending = null;
				addRect(state.tool, pending);
			} else {
				state.pending = defaultBox();
			}
			event.preventDefault();
			render();
			return;
		}
		if (key === "Escape") {
			if (!state.pending) return;
			state.pending = null;
			event.preventDefault();
			event.stopPropagation();
			render();
			return;
		}
		const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
		if (arrows[key] && state.pending) {
			const [dx, dy] = arrows[key];
			state.pending = nudge(state.pending, dx, dy, event.shiftKey);
			event.preventDefault();
			render();
		}
	});

	tools.addEventListener("click", (event) => {
		const target = event.target && typeof event.target.closest === "function" ? event.target.closest("button") : null;
		if (!target || !tools.contains(target)) return;
		if (target.dataset.tool) setTool(state.tool === target.dataset.tool ? null : target.dataset.tool);
		else if (target.dataset.action === "undo") undo();
		else if (target.dataset.action === "remove") remove();
	});
	noteInput.addEventListener("input", () => {
		const mark = state.marks[state.selectedMark];
		if (!mark) return;
		mark.text = noteInput.value === "" ? null : noteInput.value;
		state.notice = markTextOk(mark.text, caps) ? null : "mark_text";
		render();
		emit();
	});
	if (view && typeof view.ResizeObserver === "function") {
		resizeObserver = new view.ResizeObserver(() => {
			if (state.status === "ready" && bitmap) {
				drawPreview();
				drawBoxes();
			}
		});
		resizeObserver.observe(root);
	}

	function setTool(tool) {
		state.tool = tool === "mask" || tool === "mark" ? tool : null;
		state.pending = null;
		state.notice = null;
		render();
		emit();
		return state.tool;
	}
	function undo() {
		const last = state.history.pop();
		if (!last) return false;
		if (last === "mask") state.masks.pop();
		else {
			state.marks.pop();
			state.selectedMark = state.marks.length - 1;
		}
		state.notice = null;
		render();
		emit();
		return true;
	}
	function addRectFrom(tool, rect, space, text) {
		if (state.status !== "ready") throw new IssueImageError("no_image", "no image to annotate");
		let target = rect;
		if (space === "css") {
			if (!layout) drawPreview();
			if (!layout) throw new IssueImageError("not_displayed", "the preview has no layout yet");
			target = cssRectToBitmapRect(rect, { scale: layout.scale, bitmapWidth: state.width, bitmapHeight: state.height });
		}
		const added = addRect(tool, target);
		if (added && tool === "mark" && text !== undefined) {
			state.marks[state.selectedMark].text = text === null || text === "" ? null : String(text);
			state.notice = markTextOk(state.marks[state.selectedMark].text, caps) ? null : "mark_text";
			render();
			emit();
		}
		return added;
	}
	function remove() {
		if (attempt) {
			attempt.cancel("cancelled");
			attempt = null;
		}
		const hadImage = bitmap !== null || state.status === "loading";
		disposeBitmap(bitmap);
		bitmap = null;
		resetMarks();
		state.status = "empty";
		if (hadImage) {
			state.reason = "removed";
			state.code = null;
		}
		state.notice = null;
		render();
		emit();
	}
	function release() {
		if (released) return;
		remove();
		released = true;
		if (resizeObserver) resizeObserver.disconnect();
		listeners.clear();
		canvas.width = 0;
		canvas.height = 0;
		root.replaceChildren();
	}
	function exportEvidence() {
		if (released) throw new IssueImageError("released", "the editor was released");
		if (state.status !== "ready" || !bitmap) throw new IssueImageError("no_image", "no image to export");
		for (const mark of state.marks) if (!markTextOk(mark.text, caps)) throw new IssueImageError("mark_text", "mark text exceeds the limit");
		const masks = normalizeRects(state.masks, state.width, state.height, caps.maxRects);
		if (!masks.ok) throw new IssueImageError(masks.code, "masks are invalid");
		if (state.marks.length > caps.maxRects) throw new IssueImageError("too_many", "too many marks");
		const image = bitmap.ctx.getImageData(0, 0, state.width, state.height);
		const rgba = new Uint8Array(image.data.buffer.slice(0));
		applyMasks(rgba, state.width, state.height, masks.rects);
		opaque(rgba);
		const pixels = encodeBase64(rgba);
		const visual = buildVisual({
			width: state.width,
			height: state.height,
			pixels,
			masks: masks.rects,
			marks: state.marks,
			provenance: state.provenance,
			acquiredAt: state.acquiredAt,
		});
		return {
			width: state.width,
			height: state.height,
			rgba,
			pixels,
			masks: visual.masks,
			marks: visual.marks,
			scale: state.source.scale,
			source: { ...state.source },
			provenance: state.provenance,
			acquiredAt: state.acquiredAt,
			visual,
		};
	}

	render();
	return {
		element: root,
		stage,
		acquireFile,
		acquirePaste,
		acquireCapture,
		acquireSource,
		supportsCapture,
		setTool,
		addMask: (rect, { space = "css" } = {}) => addRectFrom("mask", rect, space),
		addMark: (rect, text = null, { space = "css" } = {}) => addRectFrom("mark", rect, space, text),
		undo,
		remove,
		release,
		exportEvidence,
		state: snapshot,
		layout: () => (layout ? { ...layout } : null),
		hasImage: () => state.status === "ready" && bitmap !== null,
		noneReason: () => (state.status === "ready" ? null : state.reason),
		onChange(listener) {
			if (typeof listener !== "function") throw new TypeError("onChange needs a function");
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
