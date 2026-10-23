import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import zlib from "node:zlib";
import { validateCreate } from "../src/issues-contract.mjs";
import { applyMasks, encodePng, sha256Hex, validateRaster } from "../src/issues-raster.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function rgba(width, height, fill = (x, y) => [x * 17 + y, y * 13, 200, 255]) {
	const buffer = Buffer.alloc(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = fill(x, y);
			const i = (y * width + x) * 4;
			buffer[i] = r;
			buffer[i + 1] = g;
			buffer[i + 2] = b;
			buffer[i + 3] = a;
		}
	}
	return buffer;
}

function visual({ width = 3, height = 2, pixels = rgba(3, 2).toString("base64"), masks = [], marks = [] } = {}) {
	return {
		kind: "raster",
		provenance: "user_upload",
		acquiredAt: "2026-10-23T00:00:00.000Z",
		sourceMatchesContext: "unverified",
		width,
		height,
		encoding: "rgba8-base64",
		pixels,
		masks,
		marks,
	};
}

function parsePng(buffer) {
	assert.ok(buffer.subarray(0, 8).equals(SIGNATURE), "png signature");
	const chunks = [];
	let offset = 8;
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		const crc = buffer.readUInt32BE(offset + 8 + length);
		assert.equal(zlib.crc32(buffer.subarray(offset + 4, offset + 8 + length)), crc, `${type} crc`);
		chunks.push({ type, data });
		offset += 12 + length;
	}
	assert.equal(offset, buffer.length);
	return chunks;
}

function reject(result, fields) {
	assert.equal(result.ok, false);
	assert.equal(result.error, "bad_input");
	assert.deepEqual(result.fields, fields);
}

test("valid raster round-trips pixels, masks and marks", () => {
	const input = visual({
		masks: [{ x: 1, y: 0, w: 2, h: 2 }],
		marks: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, text: "note" }, { rect: { x: 2, y: 1, w: 1, h: 1 }, text: null }],
	});
	const result = validateRaster(input);
	assert.equal(result.ok, true);
	assert.equal(result.value.width, 3);
	assert.equal(result.value.height, 2);
	assert.ok(Buffer.isBuffer(result.value.rgba));
	assert.deepEqual(result.value.masks, input.masks);
	assert.deepEqual(result.value.marks, input.marks);

	const expected = Buffer.from(result.value.rgba);
	for (let y = 0; y < 2; y++) {
		for (let x = 1; x < 3; x++) {
			const i = (y * 3 + x) * 4;
			expected[i] = 0;
			expected[i + 1] = 0;
			expected[i + 2] = 0;
			expected[i + 3] = 255;
		}
	}
	assert.equal(applyMasks(result.value.rgba, 3, 2, input.masks), result.value.rgba);
	assert.ok(result.value.rgba.equals(expected));
	const png = encodePng({ width: 3, height: 2, rgba: result.value.rgba });
	assert.ok(Buffer.isBuffer(png));
	assert.equal(sha256Hex(png), createHash("sha256").update(png).digest("hex"));

	const chunks = parsePng(png);
	assert.deepEqual(chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
	assert.deepEqual([...chunks[0].data.subarray(0, 10)], [0, 0, 0, 3, 0, 0, 0, 2, 8, 6]);
	const inflated = zlib.inflateSync(chunks[1].data);
	assert.equal(inflated.length, 2 * (3 * 4 + 1));
	for (let y = 0; y < 2; y++) {
		const row = y * (3 * 4 + 1);
		assert.equal(inflated[row], 0, "filter byte");
		assert.ok(inflated.subarray(row + 1, row + 13).equals(expected.subarray(y * 12, (y + 1) * 12)), `row ${y}`);
	}
	assert.deepEqual([...inflated.subarray(1, 13)], [0, 0, 200, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
});

test("width 4097 rejects without touching pixels", () => {
	const input = visual({ width: 4097, height: 1 });
	Object.defineProperty(input, "pixels", {
		get() {
			throw new Error("pixels must not be read");
		},
	});
	reject(validateRaster(input), ["width"]);
});

test("pixel budget +1 rejects before decode", () => {
	const input = visual({ width: 2049, height: 1025 });
	Object.defineProperty(input, "pixels", {
		get() {
			throw new Error("pixels must not be read");
		},
	});
	const result = validateRaster(input);
	assert.equal(result.ok, false);
	assert.equal(result.error, "bad_input");
	assert.ok(result.fields.includes("width"));
	assert.ok(result.fields.includes("height"));
});

test("decoded length mismatch rejects", () => {
	reject(validateRaster(visual({ width: 2, height: 2, pixels: rgba(1, 1).toString("base64") })), ["pixels"]);
});

test("nonopaque alpha rejects with its pixel offset", () => {
	const pixels = rgba(1, 1).toString("base64");
	const bytes = Buffer.from(pixels, "base64");
	bytes[3] = 254;
	reject(validateRaster(visual({ width: 1, height: 1, pixels: bytes.toString("base64") })), ["pixels[3]"]);
});

test("mask outside the raster rejects", () => {
	reject(validateRaster(visual({ masks: [{ x: 2, y: 0, w: 2, h: 1 }] })), ["masks[0].x + masks[0].w"]);
	reject(validateRaster(visual({ masks: [{ x: 0, y: 0, w: 3, h: 3 }] })), ["masks[0].y + masks[0].h"]);
});

test("rectangles require integers and positive sizes", () => {
	reject(validateRaster(visual({ masks: [{ x: 0.5, y: 0, w: 1, h: 1 }] })), ["masks[0].x"]);
	reject(validateRaster(visual({ masks: [{ x: 0, y: 0, w: 0, h: 1 }] })), ["masks[0].w"]);
});

test("string and NaN dimensions reject", () => {
	reject(validateRaster(visual({ width: "3", height: 2 })), ["width"]);
	reject(validateRaster(visual({ width: NaN, height: 2 })), ["width"]);
});

test("noncanonical base64 rejects", () => {
	reject(validateRaster(visual({ width: 1, height: 1, pixels: "/////x==" })), ["pixels"]);
	reject(validateRaster(visual({ width: 1, height: 1, pixels: "/////w=" })), ["pixels"]);
	reject(validateRaster(visual({ width: 1, height: 1, pixels: "/////w==\n" })), ["pixels"]);
});

test("permitted large rasters validate without stack overflow", () => {
	for (const [width, height] of [[1024, 1024], [4096, 512]]) {
		const pixels = Buffer.alloc(width * height * 4, 255).toString("base64");
		const result = validateRaster(visual({ width, height, pixels }));
		assert.equal(result.ok, true, JSON.stringify(result.fields));
		assert.equal(result.value.rgba.length, width * height * 4);
	}
});

test("a marked visual passes both the shared contract and raster validators", () => {
	const marked = visual({ marks: [{ rect: { x: 0, y: 0, w: 1, h: 1 }, text: "Synthetic note" }] });
	const body = {
		v: 1,
		storeId: "11111111-1111-4111-8111-111111111111",
		requestId: "22222222-2222-4222-8222-222222222222",
		description: "Synthetic marked image",
		evidence: {
			captureId: "33333333-3333-4333-8333-333333333333",
			observedAt: "2026-10-23T00:00:00.000Z",
			page: "inbox",
			source: null,
			target: null,
			clientBuild: null,
			view: { width: 390, height: 844, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "ko-KR", embedded: false, viewerOpen: false },
			excerpt: null,
			excerptTruncated: false,
			visibleIds: [],
			diagnostics: [],
			contextStatus: "captured",
			visual: marked,
		},
	};
	const contract = validateCreate(body);
	assert.equal(contract.ok, true, JSON.stringify(contract.fields));
	const raster = validateRaster(marked);
	assert.equal(raster.ok, true, JSON.stringify(raster.fields));
	assert.deepEqual(raster.value.marks, marked.marks);
});

test("marks and masks stay within their caps and mark text limit", () => {
	const rect = { x: 0, y: 0, w: 1, h: 1 };
	const masks = Array.from({ length: 51 }, () => rect);
	reject(validateRaster(visual({ masks })), ["masks"]);
	const marks = Array.from({ length: 51 }, () => ({ rect, text: null }));
	reject(validateRaster(visual({ marks })), ["marks"]);
	reject(validateRaster(visual({ marks: [{ rect, text: "가".repeat(86) }] })), ["marks[0].text"]);
	reject(validateRaster(visual({ marks: [{ rect }] })), ["marks[0].text"]);
});
