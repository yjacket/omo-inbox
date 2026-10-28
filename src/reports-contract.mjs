// Versioned report create-body contract: strict validation, redacted text,
// titles, PNG inspection and canonical request identity. Pure module.
//
// Validators never coerce or truncate. A rejection carries only JSON paths.

import { createHash } from "node:crypto";
import { redact as defaultRedact } from "./redact.mjs";

export const LIMITS = Object.freeze({
	DESCRIPTION_BYTES: 8192,
	PAGE_URL_BYTES: 2048,
	PAGE_TITLE_BYTES: 160,
	SELECTOR_BYTES: 2048,
	DOM_PATH_BYTES: 2048,
	TAG_BYTES: 40,
	ROLE_BYTES: 40,
	LABEL_BYTES: 160,
	EXCERPT_BYTES: 512,
	SOURCE_ID_BYTES: 200,
	FRAME_TEXT_BYTES: 160,
	TITLE_CODE_POINTS: 80,
	COORD_ABS_MAX: 100000,
	DPR_MIN: 0.5,
	DPR_MAX: 8,
	SCALE_MIN: 0.1,
	SCALE_MAX: 10,
	FRAMES: 1,
	PNG_MAX_SIDE: 4096,
	PNG_MAX_PIXELS: 2097152,
	PNG_MAX_BYTES: 8388608,
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PAGE_KINDS = ["inbox", "thread", "boards", "proposal", "issues"];
const PAGE_ROUTES = ["/", "/s/:sid", "/boards", "/p/:id", "/issues", "/issues/new"];
const STABILITIES = ["id", "data", "class", "structural", "unavailable"];
const COLOR_SCHEMES = ["light", "dark"];
const POINTERS = ["fine", "coarse"];
const PROVENANCES = ["snapshot", "upload"];

const TOP_KEYS = ["v", "reportId", "description", "page", "element", "view", "source", "image"];
const PAGE_KEYS = ["kind", "route", "url", "title", "frames"];
const FRAME_KEYS = ["selector", "url"];
const ELEMENT_KEYS = [
	"selector", "selectorStability", "domPath", "domPathTruncated", "tag", "role",
	"label", "textExcerpt", "excerptTruncated", "rect",
];
const RECT_KEYS = ["x", "y", "w", "h"];
const VIEW_KEYS = ["layout", "visual", "scroll", "dpr", "colorScheme", "pointer"];
const LAYOUT_KEYS = ["w", "h"];
const VISUAL_KEYS = ["x", "y", "w", "h", "scale"];
const SCROLL_KEYS = ["x", "y"];
const THREAD_KEYS = ["kind", "threadId", "itemId"];
const PROPOSAL_KEYS = ["kind", "proposalId", "revision", "frame"];
const IMAGE_KEYS = ["provenance", "png", "width", "height"];

export const FAILURE_TEXT = Object.freeze({
	auth: "GitHub 인증을 확인해야 합니다",
	no_token: "GitHub 토큰이 없습니다",
	permission: "저장소에 쓸 권한이 없습니다",
	not_found: "저장소를 찾을 수 없습니다",
	issues_disabled: "저장소의 Issues가 꺼져 있습니다",
	public_repo: "공개 저장소에는 올리지 않습니다",
	validation: "GitHub가 내용을 받지 않았습니다",
	attachment_conflict: "그림 파일이 이미 다르게 올라가 있습니다",
	transient: "GitHub에 연결하지 못했습니다",
});

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path, key) {
	return path === "" ? key : `${path}.${key}`;
}

function byteLength(text) {
	return Buffer.byteLength(text, "utf8");
}

function checkKeys(value, path, allowed, required, errors) {
	if (!isPlainObject(value)) {
		errors.push(path === "" ? "body" : path);
		return false;
	}
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) errors.push(join(path, key));
	}
	for (const key of required) {
		if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(join(path, key));
	}
	return true;
}

function checkString(value, path, maxBytes, errors) {
	if (typeof value !== "string" || byteLength(value) > maxBytes) errors.push(path);
}

function checkNullableString(value, path, maxBytes, errors) {
	if (value !== null) checkString(value, path, maxBytes, errors);
}

function checkBoolean(value, path, errors) {
	if (typeof value !== "boolean") errors.push(path);
}

function checkFiniteRange(value, path, min, max, errors) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) errors.push(path);
}

function checkEnum(value, path, values, errors) {
	if (!values.includes(value)) errors.push(path);
}

function checkPathname(value, path, maxBytes, errors, allowSidQuery) {
	if (typeof value !== "string" || byteLength(value) > maxBytes) {
		errors.push(path);
		return;
	}
	if (!value.startsWith("/") || value.includes("#") || /[\s\u0000-\u001f]/.test(value)) {
		errors.push(path);
		return;
	}
	if (!value.includes("?")) return;
	const at = value.indexOf("?");
	const pathname = value.slice(0, at);
	const query = value.slice(at + 1);
	if (!allowSidQuery || pathname !== "/" || !/^s=[^&#]+$/.test(query)) errors.push(path);
}

function validatePage(page, errors) {
	if (!checkKeys(page, "page", PAGE_KEYS, PAGE_KEYS, errors)) return;
	checkEnum(page.kind, "page.kind", PAGE_KINDS, errors);
	checkEnum(page.route, "page.route", PAGE_ROUTES, errors);
	checkPathname(page.url, "page.url", LIMITS.PAGE_URL_BYTES, errors, true);
	checkString(page.title, "page.title", LIMITS.PAGE_TITLE_BYTES, errors);
	if (!Array.isArray(page.frames) || page.frames.length > LIMITS.FRAMES) {
		errors.push("page.frames");
		return;
	}
	page.frames.forEach((frame, index) => {
		const path = `page.frames[${index}]`;
		if (!checkKeys(frame, path, FRAME_KEYS, FRAME_KEYS, errors)) return;
		checkString(frame.selector, `${path}.selector`, LIMITS.SELECTOR_BYTES, errors);
		checkPathname(frame.url, `${path}.url`, LIMITS.PAGE_URL_BYTES, errors, false);
	});
}

function validateElement(element, errors) {
	if (!checkKeys(element, "element", ELEMENT_KEYS, ELEMENT_KEYS, errors)) return;
	checkNullableString(element.selector, "element.selector", LIMITS.SELECTOR_BYTES, errors);
	checkEnum(element.selectorStability, "element.selectorStability", STABILITIES, errors);
	checkString(element.domPath, "element.domPath", LIMITS.DOM_PATH_BYTES, errors);
	checkBoolean(element.domPathTruncated, "element.domPathTruncated", errors);
	if (typeof element.tag !== "string" || element.tag.length > LIMITS.TAG_BYTES || !/^[a-z][a-z0-9-]*$/.test(element.tag)) {
		errors.push("element.tag");
	}
	checkNullableString(element.role, "element.role", LIMITS.ROLE_BYTES, errors);
	checkString(element.label, "element.label", LIMITS.LABEL_BYTES, errors);
	checkString(element.textExcerpt, "element.textExcerpt", LIMITS.EXCERPT_BYTES, errors);
	checkBoolean(element.excerptTruncated, "element.excerptTruncated", errors);
	if (checkKeys(element.rect, "element.rect", RECT_KEYS, RECT_KEYS, errors)) {
		for (const key of RECT_KEYS) {
			checkFiniteRange(element.rect[key], `element.rect.${key}`, -LIMITS.COORD_ABS_MAX, LIMITS.COORD_ABS_MAX, errors);
		}
	}
}

function validateView(view, errors) {
	if (!checkKeys(view, "view", VIEW_KEYS, VIEW_KEYS, errors)) return;
	if (checkKeys(view.layout, "view.layout", LAYOUT_KEYS, LAYOUT_KEYS, errors)) {
		for (const key of LAYOUT_KEYS) {
			checkFiniteRange(view.layout[key], `view.layout.${key}`, -LIMITS.COORD_ABS_MAX, LIMITS.COORD_ABS_MAX, errors);
		}
	}
	if (checkKeys(view.visual, "view.visual", VISUAL_KEYS, VISUAL_KEYS, errors)) {
		for (const key of ["x", "y", "w", "h"]) {
			checkFiniteRange(view.visual[key], `view.visual.${key}`, -LIMITS.COORD_ABS_MAX, LIMITS.COORD_ABS_MAX, errors);
		}
		checkFiniteRange(view.visual.scale, "view.visual.scale", LIMITS.SCALE_MIN, LIMITS.SCALE_MAX, errors);
	}
	if (checkKeys(view.scroll, "view.scroll", SCROLL_KEYS, SCROLL_KEYS, errors)) {
		for (const key of SCROLL_KEYS) {
			checkFiniteRange(view.scroll[key], `view.scroll.${key}`, -LIMITS.COORD_ABS_MAX, LIMITS.COORD_ABS_MAX, errors);
		}
	}
	checkFiniteRange(view.dpr, "view.dpr", LIMITS.DPR_MIN, LIMITS.DPR_MAX, errors);
	checkEnum(view.colorScheme, "view.colorScheme", COLOR_SCHEMES, errors);
	checkEnum(view.pointer, "view.pointer", POINTERS, errors);
}

function validateSource(source, errors) {
	if (!isPlainObject(source)) {
		errors.push("source");
		return;
	}
	if (source.kind === "thread") {
		if (checkKeys(source, "source", THREAD_KEYS, THREAD_KEYS, errors)) {
			checkString(source.threadId, "source.threadId", LIMITS.SOURCE_ID_BYTES, errors);
			if (typeof source.threadId === "string" && byteLength(source.threadId) === 0) errors.push("source.threadId");
			checkNullableString(source.itemId, "source.itemId", Number.MAX_SAFE_INTEGER, errors);
		}
		return;
	}
	if (source.kind === "proposal") {
		if (checkKeys(source, "source", PROPOSAL_KEYS, PROPOSAL_KEYS, errors)) {
			checkString(source.proposalId, "source.proposalId", LIMITS.SOURCE_ID_BYTES, errors);
			if (typeof source.proposalId === "string" && byteLength(source.proposalId) === 0) errors.push("source.proposalId");
			if (source.revision !== null && (!Number.isInteger(source.revision) || source.revision <= 0)) {
				errors.push("source.revision");
			}
			checkNullableString(source.frame, "source.frame", LIMITS.FRAME_TEXT_BYTES, errors);
		}
		return;
	}
	// Unknown kind: reject the discriminator, and unknown keys still count.
	const allowed = [...new Set([...THREAD_KEYS, ...PROPOSAL_KEYS])];
	for (const key of Object.keys(source)) {
		if (!allowed.includes(key)) errors.push(join("source", key));
	}
	errors.push("source.kind");
}

function validateImage(image, errors) {
	if (image === null) return null;
	if (!checkKeys(image, "image", IMAGE_KEYS, IMAGE_KEYS, errors)) return null;
	checkEnum(image.provenance, "image.provenance", PROVENANCES, errors);
	let geoOk = true;
	for (const key of ["width", "height"]) {
		const value = image[key];
		if (!Number.isInteger(value) || value < 1 || value > LIMITS.PNG_MAX_SIDE) {
			errors.push(`image.${key}`);
			geoOk = false;
		}
	}
	if (geoOk && image.width * image.height > LIMITS.PNG_MAX_PIXELS) {
		errors.push("image.png");
		geoOk = false;
	}
	if (typeof image.png !== "string" || image.png === "" || image.png.startsWith("data:")) {
		errors.push("image.png");
		return null;
	}
	const bytes = Buffer.from(image.png, "base64");
	if (bytes.toString("base64") !== image.png) {
		errors.push("image.png");
		return null;
	}
	if (bytes.length > LIMITS.PNG_MAX_BYTES) {
		errors.push("image.png");
		return null;
	}
	const info = pngInfo(bytes);
	if (info === null) {
		errors.push("image.png");
		return null;
	}
	if (geoOk && (info.width !== image.width || info.height !== image.height)) {
		errors.push("image.png");
		return null;
	}
	if (info.width > LIMITS.PNG_MAX_SIDE || info.height > LIMITS.PNG_MAX_SIDE || info.width * info.height > LIMITS.PNG_MAX_PIXELS) {
		errors.push("image.png");
		return null;
	}
	return bytes;
}

export function validateCreate(body) {
	if (!isPlainObject(body)) return { ok: false, fields: ["body"] };
	const errors = [];
	if (!checkKeys(body, "", TOP_KEYS, TOP_KEYS, errors)) return { ok: false, fields: errors };

	if ("v" in body && body.v !== 2) errors.push("v");
	if ("reportId" in body && (typeof body.reportId !== "string" || !UUID_V4.test(body.reportId))) errors.push("reportId");
	if ("description" in body) {
		if (typeof body.description !== "string") {
			errors.push("description");
		} else {
			const bytes = byteLength(body.description);
			if (bytes < 1 || bytes > LIMITS.DESCRIPTION_BYTES) errors.push("description");
		}
	}
	if ("page" in body) validatePage(body.page, errors);
	if ("element" in body && body.element !== null) validateElement(body.element, errors);
	if ("view" in body) validateView(body.view, errors);
	if ("source" in body && body.source !== null) validateSource(body.source, errors);
	let png = null;
	if ("image" in body) png = validateImage(body.image, errors);
	if (errors.length > 0) return { ok: false, fields: errors };

	const value = {
		v: body.v,
		reportId: body.reportId,
		description: body.description,
		page: {
			kind: body.page.kind,
			route: body.page.route,
			url: body.page.url,
			title: body.page.title,
			frames: body.page.frames.map((frame) => ({ selector: frame.selector, url: frame.url })),
		},
		element: body.element === null ? null : {
			selector: body.element.selector,
			selectorStability: body.element.selectorStability,
			domPath: body.element.domPath,
			domPathTruncated: body.element.domPathTruncated,
			tag: body.element.tag,
			role: body.element.role,
			label: body.element.label,
			textExcerpt: body.element.textExcerpt,
			excerptTruncated: body.element.excerptTruncated,
			rect: {
				x: body.element.rect.x,
				y: body.element.rect.y,
				w: body.element.rect.w,
				h: body.element.rect.h,
			},
		},
		view: {
			layout: { w: body.view.layout.w, h: body.view.layout.h },
			visual: {
				x: body.view.visual.x,
				y: body.view.visual.y,
				w: body.view.visual.w,
				h: body.view.visual.h,
				scale: body.view.visual.scale,
			},
			scroll: { x: body.view.scroll.x, y: body.view.scroll.y },
			dpr: body.view.dpr,
			colorScheme: body.view.colorScheme,
			pointer: body.view.pointer,
		},
		source: body.source === null ? null : body.source.kind === "thread" ? {
			kind: "thread",
			threadId: body.source.threadId,
			itemId: body.source.itemId,
		} : {
			kind: "proposal",
			proposalId: body.source.proposalId,
			revision: body.source.revision,
			frame: body.source.frame,
		},
		image: body.image === null ? null : {
			provenance: body.image.provenance,
			width: body.image.width,
			height: body.image.height,
		},
	};
	return { ok: true, value, png };
}

export function deriveTitle(description) {
	if (typeof description !== "string") return "";
	for (const line of description.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const points = Array.from(trimmed);
		if (points.length <= LIMITS.TITLE_CODE_POINTS) return trimmed;
		return `${points.slice(0, LIMITS.TITLE_CODE_POINTS - 1).join("")}…`;
	}
	return "";
}

function canonicalValue(value) {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("canonicalize: non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => (entry === undefined ? "null" : canonicalValue(entry))).join(",")}]`;
	}
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

function withoutImagePng(value) {
	if (!isPlainObject(value) || !isPlainObject(value.image) || !("png" in value.image)) return value;
	const image = {};
	for (const key of Object.keys(value.image)) {
		if (key !== "png") image[key] = value.image[key];
	}
	return { ...value, image };
}

export function fingerprint(value, pngSha256 = null) {
	const digest = createHash("sha256").update(canonicalValue(withoutImagePng(value)), "utf8").digest("hex");
	if (pngSha256 === null) return digest;
	return createHash("sha256").update(`${digest}:\n${pngSha256}`, "utf8").digest("hex");
}

export function redactReport(value, redact = defaultRedact) {
	if (!isPlainObject(value)) return value;
	const out = { ...value };
	if (typeof out.description === "string") out.description = redact(out.description);
	if (isPlainObject(out.page) && typeof out.page.title === "string") {
		out.page = { ...out.page, title: redact(out.page.title) };
	}
	if (isPlainObject(out.element)) {
		const element = { ...out.element };
		if (typeof element.label === "string") element.label = redact(element.label);
		if (typeof element.textExcerpt === "string") element.textExcerpt = redact(element.textExcerpt);
		out.element = element;
	}
	return out;
}

export function pngInfo(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 33) return null;
	if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
	if (buf.readUInt32BE(8) !== 13) return null;
	if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
	const width = buf.readUInt32BE(16);
	const height = buf.readUInt32BE(20);
	if (width === 0 || height === 0) return null;
	return { width, height };
}

export function rowState(deliveryState) {
	if (deliveryState === "failed") return "failed";
	if (deliveryState === "sent") return "sent";
	return "pending";
}
