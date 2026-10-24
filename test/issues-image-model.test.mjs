import assert from "node:assert/strict";
import test from "node:test";
import { validateCreate } from "../src/issues-contract.mjs";
import { applyMasks as serverApplyMasks, validateRaster } from "../src/issues-raster.mjs";
import {
	ACCEPTED_TYPES,
	IMAGE_LIMITS,
	IssueImageError,
	applyMasks,
	bitmapRectToCss,
	buildVisual,
	classifyFile,
	createIssueImage,
	cssRectToBitmapRect,
	encodeBase64,
	fitToLimits,
	markTextOk,
	noneReasonFor,
	normalizeRects,
	opaque,
	orientationTransform,
	orientedSize,
	previewLayout,
	readJpegInfo,
} from "../web/issue-image.js";

const STORE_ID = "00000000-0000-4000-8000-00000000000a";
const REQUEST_ID = "00000000-0000-4000-8000-00000000000b";
const CAPTURE_ID = "00000000-0000-4000-8000-00000000000c";

function u16(value, little) {
	return little ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff];
}
function u32(value, little) {
	const bytes = [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	return little ? bytes.reverse() : bytes;
}
function segment(marker, payload) {
	const length = payload.length + 2;
	return [0xff, marker, length >> 8, length & 0xff, ...payload];
}
function app0() {
	return segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
}
function exifSegment(orientation, { little = false, tag = 0x0112 } = {}) {
	const tiff = [
		...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
		...u16(0x2a, little),
		...u32(8, little),
		...u16(1, little),
		...u16(tag, little),
		...u16(3, little),
		...u32(1, little),
		...u16(orientation, little),
		0,
		0,
		...u32(0, little),
	];
	return segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
}
function sof0(width, height) {
	return segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}
function jpeg({ orientation = null, little = false, width = 960, height = 720, exifFirst = true } = {}) {
	const exif = orientation === null ? [] : exifSegment(orientation, { little });
	const head = exifFirst ? [...exif, ...app0()] : [...app0(), ...exif];
	return new Uint8Array([0xff, 0xd8, ...head, ...sof0(width, height), 0xff, 0xda, 0, 2]);
}

function rect(x, y, w, h) {
	return { x, y, w, h };
}

function raster(width, height) {
	const rgba = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		rgba[i * 4] = (i * 7) % 256;
		rgba[i * 4 + 1] = (i * 13) % 256;
		rgba[i * 4 + 2] = (i * 29) % 256;
		rgba[i * 4 + 3] = 255;
	}
	return rgba;
}

function envelope(visual) {
	return {
		v: 1,
		storeId: STORE_ID,
		requestId: REQUEST_ID,
		description: "사진에 표시한 버튼이 눌리지 않습니다",
		evidence: {
			captureId: CAPTURE_ID,
			observedAt: "2026-10-23T00:00:00.000Z",
			page: "inbox",
			source: null,
			target: null,
			clientBuild: null,
			view: { width: 390, height: 844, dpr: 2, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "ko-KR", embedded: false, viewerOpen: false },
			excerpt: null,
			excerptTruncated: false,
			visibleIds: [],
			diagnostics: [],
			contextStatus: "captured",
			visual,
		},
	};
}

test("classifyFile accepts PNG/JPEG/WebP up to the file limit and rejects the rest without decoding", () => {
	assert.deepEqual(ACCEPTED_TYPES, ["image/png", "image/jpeg", "image/webp"]);
	for (const type of ACCEPTED_TYPES) assert.deepEqual(classifyFile({ type, size: IMAGE_LIMITS.fileBytes }), { ok: true, type, size: IMAGE_LIMITS.fileBytes });
	assert.deepEqual(classifyFile({ type: "image/JPEG", size: 10 }), { ok: true, type: "image/jpeg", size: 10 });
	for (const type of ["image/svg+xml", "image/gif", "image/heic", "application/octet-stream", ""]) {
		assert.deepEqual(classifyFile({ type, size: 10 }), { ok: false, reason: "unsupported", code: "mime", type });
	}
	assert.deepEqual(classifyFile({ type: "image/png", size: IMAGE_LIMITS.fileBytes + 1 }), { ok: false, reason: "unsupported", code: "size", type: "image/png" });
	assert.deepEqual(classifyFile({ type: "image/png", size: 0 }), { ok: false, reason: "unsupported", code: "empty", type: "image/png" });
	assert.deepEqual(classifyFile(null), { ok: false, reason: "unsupported", code: "mime", type: "" });
	assert.equal(classifyFile({ type: "image/png", size: 2048 }, { fileBytes: 1024 }).code, "size");
});

test("readJpegInfo reads the EXIF orientation in both byte orders and the SOF frame size", () => {
	assert.deepEqual(readJpegInfo(jpeg({ orientation: 6 })), { jpeg: true, orientation: 6, width: 960, height: 720 });
	assert.deepEqual(readJpegInfo(jpeg({ orientation: 8, little: true })), { jpeg: true, orientation: 8, width: 960, height: 720 });
	assert.deepEqual(readJpegInfo(jpeg({ orientation: 3, exifFirst: false, width: 4000, height: 3000 })), { jpeg: true, orientation: 3, width: 4000, height: 3000 });
	assert.deepEqual(readJpegInfo(jpeg()), { jpeg: true, orientation: 1, width: 960, height: 720 });
});

test("readJpegInfo treats unreadable or absent orientation as 1 and never throws", () => {
	assert.deepEqual(readJpegInfo(jpeg({ orientation: 9 })), { jpeg: true, orientation: 1, width: 960, height: 720 });
	assert.deepEqual(readJpegInfo(jpeg({ orientation: 0 })), { jpeg: true, orientation: 1, width: 960, height: 720 });
	const noOrientationTag = new Uint8Array([0xff, 0xd8, ...exifSegment(6, { tag: 0x0110 }), ...sof0(10, 20)]);
	assert.deepEqual(readJpegInfo(noOrientationTag), { jpeg: true, orientation: 1, width: 10, height: 20 });
	const truncated = jpeg({ orientation: 6 }).subarray(0, 20);
	assert.deepEqual(readJpegInfo(truncated), { jpeg: true, orientation: 1, width: null, height: null });
	assert.deepEqual(readJpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { jpeg: false, orientation: 1, width: null, height: null });
	assert.deepEqual(readJpegInfo(new Uint8Array(0)), { jpeg: false, orientation: 1, width: null, height: null });
	assert.deepEqual(readJpegInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45]).buffer), { jpeg: true, orientation: 1, width: null, height: null });
});

test("orientedSize swaps the sides for orientations 5-8 only", () => {
	for (const orientation of [1, 2, 3, 4]) assert.deepEqual(orientedSize(960, 720, orientation), { width: 960, height: 720, rotated: false });
	for (const orientation of [5, 6, 7, 8]) assert.deepEqual(orientedSize(960, 720, orientation), { width: 720, height: 960, rotated: true });
	assert.deepEqual(orientedSize(10, 20), { width: 10, height: 20, rotated: false });
});

test("orientationTransform maps the raw corners onto the normalised frame", () => {
	const w = 40;
	const h = 30;
	const apply = (orientation, x, y) => {
		const [a, b, c, d, e, f] = orientationTransform(orientation, w, h);
		return [a * x + c * y + e, b * x + d * y + f];
	};
	// raw top-left, top-right, bottom-left, bottom-right
	const expected = {
		1: [[0, 0], [w, 0], [0, h], [w, h]],
		2: [[w, 0], [0, 0], [w, h], [0, h]],
		3: [[w, h], [0, h], [w, 0], [0, 0]],
		4: [[0, h], [w, h], [0, 0], [w, 0]],
		5: [[0, 0], [0, w], [h, 0], [h, w]],
		6: [[h, 0], [h, w], [0, 0], [0, w]],
		7: [[h, w], [h, 0], [0, w], [0, 0]],
		8: [[0, w], [0, 0], [h, w], [h, 0]],
	};
	for (const [orientation, corners] of Object.entries(expected)) {
		const actual = [apply(Number(orientation), 0, 0), apply(Number(orientation), w, 0), apply(Number(orientation), 0, h), apply(Number(orientation), w, h)];
		assert.deepEqual(actual, corners, `orientation ${orientation}`);
	}
	assert.deepEqual(orientationTransform(99, w, h), [1, 0, 0, 1, 0, 0]);
});

test("fitToLimits downscales proportionally only when a limit requires it", () => {
	assert.deepEqual(fitToLimits(960, 720), { width: 960, height: 720, scale: 1 });
	assert.deepEqual(fitToLimits(4096, 512), { width: 4096, height: 512, scale: 1 });
	const long = fitToLimits(5000, 100);
	assert.equal(long.width, 4096);
	assert.equal(long.height, 81);
	assert.ok(long.scale < 1 && long.scale > 0.819 && long.scale < 0.82);
	const big = fitToLimits(2400, 1800);
	assert.ok(big.width * big.height <= IMAGE_LIMITS.maxPixels, "pixel budget");
	assert.ok(big.width <= 4096 && big.height <= 4096);
	assert.ok(Math.abs(big.width / big.height - 2400 / 1800) < 0.002, "aspect ratio kept");
	assert.ok(big.width >= 1670 && big.height >= 1250, `scaled size ${big.width}x${big.height}`);
	const sliver = fitToLimits(1, 5000000);
	assert.deepEqual([sliver.width, sliver.height], [1, 4096]);
	const custom = fitToLimits(100, 100, { maxSide: 10, maxPixels: 50 });
	assert.deepEqual([custom.width, custom.height], [7, 7]);
	assert.throws(() => fitToLimits(0, 10), (error) => error instanceof IssueImageError && error.code === "bad_size");
});

test("previewLayout fits the CSS box without upscaling and sizes the backing store by dpr", () => {
	assert.deepEqual(previewLayout({ bitmapWidth: 960, bitmapHeight: 720, maxCssWidth: 320, maxCssHeight: 1000, dpr: 2 }), {
		cssWidth: 320, cssHeight: 240, scale: 3, dpr: 2, backingWidth: 640, backingHeight: 480,
	});
	assert.deepEqual(previewLayout({ bitmapWidth: 100, bitmapHeight: 80, maxCssWidth: 320, dpr: 1 }), {
		cssWidth: 100, cssHeight: 80, scale: 1, dpr: 1, backingWidth: 100, backingHeight: 80,
	});
	assert.deepEqual(previewLayout({ bitmapWidth: 720, bitmapHeight: 960, maxCssWidth: 320, maxCssHeight: 300, dpr: 1.5 }), {
		cssWidth: 225, cssHeight: 300, scale: 3.2, dpr: 1.5, backingWidth: 338, backingHeight: 450,
	});
	assert.equal(previewLayout({ bitmapWidth: 960, bitmapHeight: 720, maxCssWidth: 320, dpr: 0 }).dpr, 1);
	assert.throws(() => previewLayout({ bitmapWidth: 0, bitmapHeight: 10, maxCssWidth: 10 }), (error) => error.code === "bad_layout");
});

test("cssRectToBitmapRect rounds outward to integers, clamps to the bitmap and ignores dpr", () => {
	const layout = { scale: 3, bitmapWidth: 960, bitmapHeight: 720 };
	assert.deepEqual(cssRectToBitmapRect(rect(80, 40, 40, 40), layout), rect(240, 120, 120, 120));
	assert.deepEqual(cssRectToBitmapRect(rect(80.3, 40.2, 39.5, 39.6), layout), rect(240, 120, 120, 120));
	assert.deepEqual(cssRectToBitmapRect(rect(80.5, 40.5, 1, 1), layout), rect(241, 121, 4, 4));
	assert.deepEqual(cssRectToBitmapRect(rect(120, 80, -40, -40), layout), rect(240, 120, 120, 120), "negative drag direction");
	assert.deepEqual(cssRectToBitmapRect(rect(-10, -10, 20, 20), layout), rect(0, 0, 30, 30), "clamped at the origin");
	assert.deepEqual(cssRectToBitmapRect(rect(310, 230, 100, 100), layout), rect(930, 690, 30, 30), "clamped at the far edge");
	assert.equal(cssRectToBitmapRect(rect(400, 10, 10, 10), layout), null, "entirely outside");
	assert.equal(cssRectToBitmapRect(rect(10, 10, 0, 0), layout), null, "empty drag");
	assert.equal(cssRectToBitmapRect(rect(10, 10, Number.NaN, 5), layout), null);
	assert.equal(cssRectToBitmapRect(rect(10, 10, 5, 5), { scale: 0, bitmapWidth: 10, bitmapHeight: 10 }), null);
	const atDpr1 = previewLayout({ bitmapWidth: 960, bitmapHeight: 720, maxCssWidth: 320, dpr: 1 });
	const atDpr2 = previewLayout({ bitmapWidth: 960, bitmapHeight: 720, maxCssWidth: 320, dpr: 2 });
	assert.equal(atDpr1.scale, atDpr2.scale);
	assert.deepEqual(
		cssRectToBitmapRect(rect(33.3, 21.7, 50.1, 42.9), { ...atDpr1, bitmapWidth: 960, bitmapHeight: 720 }),
		cssRectToBitmapRect(rect(33.3, 21.7, 50.1, 42.9), { ...atDpr2, bitmapWidth: 960, bitmapHeight: 720 }),
	);
	assert.deepEqual(bitmapRectToCss(rect(240, 120, 120, 120), { scale: 3 }), rect(80, 40, 40, 40));
	assert.equal(bitmapRectToCss(null, { scale: 3 }), null);
});

test("normalizeRects clips, drops empty and contained rectangles, and enforces the count limit", () => {
	const result = normalizeRects([rect(-5, -5, 10, 10), rect(100, 100, 0, 10), rect(90, 90, 20, 20), rect(95, 95, 5, 5), rect(20, 20, 3, 3), rect(20, 20, 3, 3), rect(50, 50, 20, 5), rect(55, 45, 5, 20)], 100, 100);
	assert.deepEqual(result, { ok: true, rects: [rect(0, 0, 5, 5), rect(90, 90, 10, 10), rect(20, 20, 3, 3), rect(50, 50, 20, 5), rect(55, 45, 5, 20)] });
	assert.deepEqual(normalizeRects([rect(0, 0, 1.5, 2)], 10, 10), { ok: false, code: "integer" });
	assert.deepEqual(normalizeRects([null], 10, 10), { ok: false, code: "integer" });
	assert.deepEqual(normalizeRects("x", 10, 10), { ok: false, code: "shape" });
	const many = Array.from({ length: 51 }, (_, index) => rect(index, 0, 1, 1));
	assert.deepEqual(normalizeRects(many, 100, 100), { ok: false, code: "too_many", count: 51 });
	assert.equal(normalizeRects(many.slice(0, 50), 100, 100).ok, true);
	assert.deepEqual(normalizeRects([rect(0, 0, 10, 10), rect(20, 0, 10, 10)], 100, 100, 1), { ok: false, code: "too_many", count: 2 });
});

test("applyMasks burns opaque black into exactly the masked pixels", () => {
	const width = 4;
	const height = 4;
	const rgba = raster(width, height);
	rgba[(1 * width + 1) * 4 + 3] = 7;
	const before = Uint8Array.from(rgba);
	applyMasks(rgba, width, height, [rect(1, 1, 2, 2)]);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const at = (y * width + x) * 4;
			const inside = x >= 1 && x <= 2 && y >= 1 && y <= 2;
			const pixel = Array.from(rgba.subarray(at, at + 4));
			if (inside) assert.deepEqual(pixel, [0, 0, 0, 255], `${x},${y} masked`);
			else assert.deepEqual(pixel, Array.from(before.subarray(at, at + 4)), `${x},${y} untouched`);
		}
	}
	const translucent = new Uint8Array([1, 2, 3, 0, 4, 5, 6, 128]);
	assert.deepEqual(Array.from(opaque(translucent)), [1, 2, 3, 255, 4, 5, 6, 255]);
});

test("encodeBase64 is canonical for every padding length and large inputs", () => {
	for (let length = 0; length <= 6; length++) {
		const bytes = Uint8Array.from({ length }, (_, index) => 250 + index);
		assert.equal(encodeBase64(bytes), Buffer.from(bytes).toString("base64"));
	}
	const big = raster(600, 300);
	assert.equal(encodeBase64(big), Buffer.from(big).toString("base64"));
	assert.equal(encodeBase64(big.buffer), Buffer.from(big).toString("base64"));
});

test("markTextOk measures UTF-8 bytes against the 256-byte limit", () => {
	assert.equal(markTextOk(null), true);
	assert.equal(markTextOk(undefined), true);
	assert.equal(markTextOk("a".repeat(256)), true);
	assert.equal(markTextOk("a".repeat(257)), false);
	assert.equal(markTextOk("가".repeat(85)), true);
	assert.equal(markTextOk("가".repeat(86)), false);
	assert.equal(markTextOk(12), false);
	assert.equal(markTextOk("abc", { markTextBytes: 2 }), false);
});

test("buildVisual produces an envelope the server contract accepts and masks identically to the server", () => {
	const width = 8;
	const height = 6;
	const original = raster(width, height);
	const masked = Uint8Array.from(original);
	const masks = [rect(2, 1, 3, 2), rect(0, 5, 8, 1)];
	applyMasks(masked, width, height, masks);
	const marks = [{ rect: rect(0, 0, 2, 2), text: "버튼" }, { rect: rect(6, 4, 2, 2), text: null }];
	const visual = buildVisual({ width, height, pixels: encodeBase64(masked), masks, marks, provenance: "user_upload", acquiredAt: "2026-10-23T00:00:01.000Z" });
	assert.deepEqual(Object.keys(visual), ["kind", "provenance", "acquiredAt", "sourceMatchesContext", "width", "height", "encoding", "pixels", "masks", "marks"]);
	assert.equal(visual.encoding, "rgba8-base64");
	assert.equal(visual.sourceMatchesContext, "unverified");
	assert.deepEqual(visual.marks, [{ rect: rect(0, 0, 2, 2), text: "버튼" }, { rect: rect(6, 4, 2, 2), text: null }]);
	const create = validateCreate(envelope(visual));
	assert.equal(create.ok, true, JSON.stringify(create));
	const checked = validateRaster(visual);
	assert.equal(checked.ok, true, JSON.stringify(checked));
	const reapplied = serverApplyMasks(Buffer.from(checked.value.rgba), width, height, checked.value.masks);
	assert.deepEqual(Array.from(reapplied), Array.from(masked), "server reapplication changes nothing the client did not already burn in");
	for (const { x, y, w, h } of masks) {
		for (let row = y; row < y + h; row++) {
			for (let column = x; column < x + w; column++) {
				const at = (row * width + column) * 4;
				assert.deepEqual(Array.from(masked.subarray(at, at + 4)), [0, 0, 0, 255]);
				assert.notDeepEqual(Array.from(original.subarray(at, at + 3)), [0, 0, 0], "the fixture is not black there");
			}
		}
	}
	const bad = buildVisual({ width, height, pixels: encodeBase64(masked), masks: [rect(7, 0, 2, 1)], marks: [], provenance: "user_upload" });
	assert.equal(validateCreate(envelope(bad)).ok, false, "a mask leaving the bitmap is rejected by the contract");
	const reproduction = buildVisual({ width, height, pixels: encodeBase64(masked), masks: [], marks: [], provenance: "reproduction" });
	assert.equal(validateCreate(envelope(reproduction)).ok, false, "reproduction provenance is not a create provenance");
});

test("noneReasonFor maps acquisition failures to the contract's none reasons", () => {
	assert.deepEqual(noneReasonFor(new DOMException("denied", "NotAllowedError")), { reason: "denied", code: "permission" });
	assert.deepEqual(noneReasonFor(new DOMException("no", "NotSupportedError")), { reason: "unsupported", code: "capture" });
	assert.deepEqual(noneReasonFor(new DOMException("none", "NotFoundError")), { reason: "unsupported", code: "capture" });
	assert.deepEqual(noneReasonFor(new DOMException("tainted", "SecurityError")), { reason: "failed", code: "tainted" });
	assert.deepEqual(noneReasonFor(new DOMException("bad", "EncodingError")), { reason: "failed", code: "decode" });
	assert.deepEqual(noneReasonFor(new DOMException("ended", "NotReadableError")), { reason: "failed", code: "source" });
	assert.deepEqual(noneReasonFor(new DOMException("aborted", "AbortError")), { reason: "failed", code: "source" });
	assert.deepEqual(noneReasonFor(new TypeError("boom")), { reason: "failed", code: "other" });
	assert.deepEqual(noneReasonFor(null), { reason: "failed", code: "other" });
	const cancelled = new Error("cancelled");
	cancelled.name = "IssueImageCancelled";
	cancelled.code = "superseded";
	assert.deepEqual(noneReasonFor(cancelled), { reason: "removed", code: "superseded" });
});

test("createIssueImage requires an injected document and clock", () => {
	assert.throws(() => createIssueImage({}), TypeError);
	assert.throws(() => createIssueImage({ document: { createElement() {} } }), TypeError);
});
