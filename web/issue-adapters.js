/* Explicit parent-owned adapter registry for issue reporting.
 *
 * Pages register a getter from their own closure, so a capture never rediscovers application
 * state by scraping the document or depends on QA globals. Same-origin child frames register
 * through a direct call on the parent's registry, and the parent verifies that the passed
 * contentWindow is the live iframe it owns and that both locations share the adapter origin.
 * There is no postMessage command surface.
 *
 * The registry owns the frozen capture: freeze() snapshots once, and a later render, frame
 * replacement or rejected registration cannot replace it. Only an explicit
 * freeze({ fresh: true }) begins a new capture generation.
 */

const PAGE_VALUES = new Set(["inbox", "thread", "boards", "proposal", "issues", "other"]);
const TARGET_KINDS = new Set(["page", "record", "control", "frame"]);
const TOKEN_BYTES = 160;
const EXCERPT_BYTES = 512;
const FRAME_ID_BYTES = 200;
const RECT_ABS_MAX = 1_000_000;

export class AdapterRegistrationError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "AdapterRegistrationError";
		this.code = code;
	}
}

function fail(code, message) {
	throw new AdapterRegistrationError(code, message);
}

// Same-origin iframes are a second realm: their object literals have that realm's Object.prototype,
// so prototype identity against this module's realm would reject every child-created descriptor.
// The boundary is structural and every accepted value is copied field by field into this realm.
function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.prototype.toString.call(value) === "[object Object]";
}

function clipBytes(value, limit) {
	if (typeof value !== "string") return null;
	let bytes = 0;
	let text = "";
	for (const char of value) {
		const code = char.codePointAt(0);
		const lone = code >= 0xd800 && code <= 0xdfff;
		const piece = lone ? "\uFFFD" : char;
		const size = lone ? 3 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
		if (bytes + size > limit) break;
		text += piece;
		bytes += size;
	}
	return text;
}

function token(value) {
	const text = clipBytes(value, TOKEN_BYTES);
	return text === null || text === "" ? null : text;
}

function frameToken(value) {
	const text = clipBytes(value, FRAME_ID_BYTES);
	return text === null || text === "" ? null : text;
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

function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function rectDescriptor(value) {
	if (!isPlainObject(value)) return null;
	const out = {};
	for (const key of ["x", "y"]) {
		const number = value[key];
		if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number) > RECT_ABS_MAX) return null;
		out[key] = number;
	}
	for (const key of ["w", "h"]) {
		const number = value[key];
		if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > RECT_ABS_MAX) return null;
		out[key] = number;
	}
	return out;
}

function descriptorOf(record) {
	return Object.freeze({
		id: record.id,
		page: record.page,
		origin: record.origin,
		frame: record.frame,
		framePath: Object.freeze([...record.framePath]),
	});
}

export function createAdapterRegistry({ ownerWindow } = {}) {
	if (ownerWindow === null || typeof ownerWindow !== "object" && typeof ownerWindow !== "function") {
		throw new TypeError("createAdapterRegistry needs the owning window");
	}

	let nextId = 0;
	const records = new Map();
	const frames = new Map();
	let parentRecord = null;
	let activeId = null;
	let capture = null;
	let deferred = false;

	function ownerOrigin() {
		try {
			const value = ownerWindow.location && ownerWindow.location.origin;
			return typeof value === "string" ? value : null;
		} catch {
			return null;
		}
	}

	function verifyFrame(frameWindow, origin) {
		if (frameWindow === null || typeof frameWindow !== "object" && typeof frameWindow !== "function") {
			fail("unloaded_frame", "frameWindow is not a live window");
		}
		if (typeof origin !== "string" || origin === "") fail("cross_origin", "frame registration needs its origin");
		let document;
		try {
			document = ownerWindow.document;
		} catch {
			fail("origin_denied", "the parent document is not readable");
		}
		if (!document || typeof document.querySelectorAll !== "function") fail("origin_denied", "the parent document is not readable");
		let element = null;
		let denied = false;
		for (const candidate of document.querySelectorAll("iframe")) {
			let contentWindow;
			try {
				contentWindow = candidate.contentWindow;
			} catch {
				denied = true;
				continue;
			}
			if (contentWindow === frameWindow) {
				element = candidate;
				break;
			}
		}
		if (element === null) {
			if (denied) fail("origin_denied", "the frame window is not readable");
			fail("stale_frame", "frameWindow no longer belongs to a current iframe");
		}
		let contentDocument;
		try {
			contentDocument = element.contentDocument;
		} catch {
			fail("origin_denied", "the frame document is not readable");
		}
		if (contentDocument === null) fail("unloaded_frame", "the frame document is not loaded");
		let frameOrigin;
		try {
			frameOrigin = frameWindow.location.origin;
		} catch {
			fail("origin_denied", "the frame location is not readable");
		}
		const parentOrigin = ownerOrigin();
		if (frameOrigin !== origin || parentOrigin !== origin) {
			fail("cross_origin", "frame and parent origins do not match the adapter origin");
		}
		return element;
	}

	function register(options) {
		if (!isPlainObject(options)) fail("bad_input", "register needs an adapter descriptor");
		const { page, getContext, getTargets, deferRender, resumeRender, origin, frameWindow } = options;
		if (!PAGE_VALUES.has(page)) fail("bad_input", "adapter page is unknown");
		for (const [name, value] of [
			["getContext", getContext],
			["getTargets", getTargets],
			["deferRender", deferRender],
			["resumeRender", resumeRender],
		]) {
			if (value !== undefined && value !== null && typeof value !== "function") fail("bad_input", `${name} is not a function`);
		}
		const isFrame = frameWindow !== undefined && frameWindow !== null;
		let framePath = [];
		let frameOrigin = typeof origin === "string" ? origin : null;
		if (isFrame) {
			const element = verifyFrame(frameWindow, origin);
			const id = frameToken(element.id) ?? frameToken(element.getAttribute && element.getAttribute("name"));
			framePath = id === null ? [] : [id];
		} else {
			frameOrigin = ownerOrigin();
		}
		const record = {
			id: ++nextId,
			page,
			origin: frameOrigin,
			frame: isFrame,
			framePath,
			frameWindow: isFrame ? frameWindow : null,
			getContext,
			getTargets,
			deferRender,
			resumeRender,
		};
		records.set(record.id, record);
		if (isFrame) {
			const previous = frames.get(frameWindow);
			if (previous) records.delete(previous.id);
			frames.set(frameWindow, record);
		} else {
			if (parentRecord) records.delete(parentRecord.id);
			parentRecord = record;
		}
		activeId = record.id;
		return Object.freeze({ id: record.id, page, origin: record.origin, frame: record.frame, framePath: Object.freeze([...record.framePath]) });
	}

	function unregister(handle) {
		if (!isPlainObject(handle) || !Number.isInteger(handle.id)) return false;
		const record = records.get(handle.id);
		if (!record) return false;
		records.delete(record.id);
		if (record.frame) {
			if (frames.get(record.frameWindow) === record) frames.delete(record.frameWindow);
		} else if (parentRecord === record) {
			parentRecord = null;
		}
		if (activeId === record.id) activeId = null;
		return true;
	}

	function current() {
		if (activeId === null) return null;
		const record = records.get(activeId);
		return record ? descriptorOf(record) : null;
	}

	function isLive(record) {
		if (!record.frame) return true;
		try {
			verifyFrame(record.frameWindow, record.origin);
			return true;
		} catch {
			return false;
		}
	}

	function freeze(options = {}) {
		if (capture !== null && options.fresh !== true) return capture.context;
		if (activeId === null) return null;
		const record = records.get(activeId);
		if (!record || !isLive(record) || typeof record.getContext !== "function") return null;
		const value = record.getContext();
		if (value === null || value === undefined) return null;
		if (typeof value.then === "function") throw new TypeError("getContext must return synchronously");
		if (!isPlainObject(value)) throw new TypeError("getContext must return a plain capture object");
		const snapshot = deepFreeze(deepCopy(value));
		capture = { adapterId: record.id, descriptor: descriptorOf(record), context: snapshot };
		return snapshot;
	}

	function listTargets() {
		if (activeId === null) return Object.freeze([]);
		const record = records.get(activeId);
		if (!record || !isLive(record) || typeof record.getTargets !== "function") return Object.freeze([]);
		const raw = record.getTargets();
		if (!Array.isArray(raw)) return Object.freeze([]);
		const out = [];
		for (const entry of raw) {
			if (!isPlainObject(entry) || !TARGET_KINDS.has(entry.kind)) continue;
			const key = token(entry.key);
			const label = token(entry.label);
			const rect = rectDescriptor(entry.rect);
			if (key === null || label === null || rect === null) continue;
			// Ownership comes only from the iframe element the parent verified at registration. An
			// adapter-supplied framePath is rejected as authority; it cannot rename its source.
			const framePath = record.frame ? [...record.framePath] : [];
			// The descriptor may carry the visible text it names; it is bounded here so the frozen
			// capture can take its excerpt from the picked descriptor without a second page read.
			const excerpt = clipBytes(entry.excerpt, EXCERPT_BYTES);
			const descriptor = { kind: entry.kind, key, label, rect: Object.freeze(rect), framePath: Object.freeze(framePath) };
			if (excerpt !== null && excerpt !== "") descriptor.excerpt = excerpt;
			out.push(Object.freeze(descriptor));
		}
		return Object.freeze(out);
	}

	function deferAll() {
		if (deferred) return false;
		deferred = true;
		const errors = [];
		for (const record of records.values()) {
			if (typeof record.deferRender !== "function") continue;
			try {
				record.deferRender();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "deferRender failed");
		return true;
	}

	function resumeAll() {
		if (!deferred) return false;
		deferred = false;
		const errors = [];
		for (const record of records.values()) {
			if (typeof record.resumeRender !== "function") continue;
			try {
				record.resumeRender();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "resumeRender failed");
		return true;
	}

	function standalone() {
		return Object.freeze({ href: "/issues/new", contextStatus: "unavailable" });
	}

	const registry = {
		register,
		unregister,
		current,
		freeze,
		listTargets,
		deferAll,
		resumeAll,
		standalone,
	};
	// The child reaches this object through window.parent; origin and contentWindow identity are
	// checked by register(), so exposing the registry is not a message channel.
	try {
		ownerWindow.__inboxIssueAdapters = registry;
	} catch {
		// A sealed owner window still gets the returned registry.
	}
	return registry;
}
