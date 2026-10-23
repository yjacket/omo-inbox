// Bounded opaque RGBA raster validation, mask application and server-owned PNG
// encoding. Pure module: only node:zlib and node:crypto, no untrusted decoder.

import { createHash } from "node:crypto";
import zlib from "node:zlib";

export const LIMITS = Object.freeze({
	MAX_SIDE: 4096,
	MAX_PIXELS: 2097152,
	MAX_RECTS: 50,
	MARK_TEXT_BYTES: 256,
});

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PROVENANCES = new Set(["display_capture", "user_upload", "source_asset_crop", "reproduction"]);
const MATCHES = new Set(["unverified", "user_confirmed"]);

// Linear-time shape check: a nested-quantifier regex overflows the stack on
// multi-megabyte pixel strings, which are valid within the permitted budget.
function isBase64Shape(value) {
	if (typeof value !== "string" || value.length % 4 !== 0) return false;
	let padding = 0;
	if (value.endsWith("==")) padding = 2;
	else if (value.endsWith("=")) padding = 1;
	for (let i = 0; i < value.length - padding; i++) {
		const code = value.charCodeAt(i);
		const alnum = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
		if (!alnum && code !== 43 && code !== 47) return false;
	}
	return true;
}

function bad(fields) {
	return { ok: false, error: "bad_input", fields };
}

function isSafeDimension(value) {
	return Number.isSafeInteger(value) && value > 0 && value <= LIMITS.MAX_SIDE;
}

function checkRect(rect, field, width, height) {
	if (!rect || typeof rect !== "object" || Array.isArray(rect)) return [field];
	const fields = [];
	for (const key of ["x", "y", "w", "h"]) {
		if (!Number.isInteger(rect[key])) fields.push(`${field}.${key}`);
	}
	if (fields.length > 0) return fields;
	if (rect.x < 0) fields.push(`${field}.x`);
	if (rect.y < 0) fields.push(`${field}.y`);
	if (rect.w <= 0) fields.push(`${field}.w`);
	if (rect.h <= 0) fields.push(`${field}.h`);
	if (rect.x + rect.w > width) fields.push(`${field}.x + ${field}.w`);
	if (rect.y + rect.h > height) fields.push(`${field}.y + ${field}.h`);
	return fields;
}

export function validateRaster(visual) {
	if (!visual || typeof visual !== "object" || Array.isArray(visual)) return bad(["visual"]);
	const fields = [];
	if (visual.kind !== "raster") fields.push("kind");
	if (visual.encoding !== "rgba8-base64") fields.push("encoding");
	if (!PROVENANCES.has(visual.provenance)) fields.push("provenance");
	if (visual.acquiredAt !== null && (typeof visual.acquiredAt !== "string" || Number.isNaN(Date.parse(visual.acquiredAt)))) {
		fields.push("acquiredAt");
	}
	if (!MATCHES.has(visual.sourceMatchesContext)) fields.push("sourceMatchesContext");
	const width = visual.width;
	const height = visual.height;
	const widthOk = isSafeDimension(width);
	const heightOk = isSafeDimension(height);
	if (!widthOk) fields.push("width");
	if (!heightOk) fields.push("height");
	if (widthOk && heightOk && width * height > LIMITS.MAX_PIXELS) {
		fields.push("width");
		fields.push("height");
	}
	if (fields.length > 0) return bad(fields);

	const pixels = visual.pixels;
	if (typeof pixels !== "string" || pixels.length % 4 !== 0) return bad(["pixels"]);
	const padding = pixels.endsWith("==") ? 2 : pixels.endsWith("=") ? 1 : 0;
	const decodedLength = (pixels.length / 4) * 3 - padding;
	const expectedLength = width * height * 4;
	if (decodedLength !== expectedLength) return bad(["pixels"]);
	if (!isBase64Shape(pixels)) return bad(["pixels"]);

	const rgba = Buffer.from(pixels, "base64");
	if (rgba.length !== expectedLength || rgba.toString("base64") !== pixels) return bad(["pixels"]);
	for (let i = 3; i < rgba.length; i += 4) {
		if (rgba[i] !== 255) return bad([`pixels[${Math.floor(i / 4) * 4 + 3}]`]);
	}

	const masks = visual.masks;
	if (!Array.isArray(masks)) return bad(["masks"]);
	if (masks.length > LIMITS.MAX_RECTS) return bad(["masks"]);
	const maskFields = [];
	masks.forEach((rect, index) => maskFields.push(...checkRect(rect, `masks[${index}]`, width, height)));
	if (maskFields.length > 0) return bad(maskFields);

	const marks = visual.marks;
	if (!Array.isArray(marks)) return bad(["marks"]);
	if (marks.length > LIMITS.MAX_RECTS) return bad(["marks"]);
	const markFields = [];
	const cleanMarks = [];
	marks.forEach((mark, index) => {
		if (!mark || typeof mark !== "object" || Array.isArray(mark)) {
			markFields.push(`marks[${index}]`);
			return;
		}
		markFields.push(...checkRect(mark.rect, `marks[${index}].rect`, width, height));
		if (mark.text !== null && typeof mark.text !== "string") markFields.push(`marks[${index}].text`);
		else if (typeof mark.text === "string" && Buffer.byteLength(mark.text, "utf8") > LIMITS.MARK_TEXT_BYTES) {
			markFields.push(`marks[${index}].text`);
		}
		cleanMarks.push({ rect: { x: mark.rect?.x, y: mark.rect?.y, w: mark.rect?.w, h: mark.rect?.h }, text: mark.text });
	});
	if (markFields.length > 0) return bad(markFields);

	return {
		ok: true,
		value: {
			width,
			height,
			rgba,
			masks: masks.map((rect) => ({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })),
			marks: cleanMarks,
		},
	};
}

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

function chunk(type, data) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
	return Buffer.concat([head, data, crc]);
}

export function encodePng({ width, height, rgba }) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	const rowBytes = width * 4;
	const raw = Buffer.alloc((rowBytes + 1) * height);
	for (let y = 0; y < height; y++) {
		const start = y * (rowBytes + 1);
		raw[start] = 0;
		rgba.copy(raw, start + 1, y * rowBytes, (y + 1) * rowBytes);
	}
	return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export function sha256Hex(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}
