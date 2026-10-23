/* Q03: bounded RGBA raster validation, server-side masks and PNG encoding.
 *
 * No browser: this scenario exercises the pure raster module only. The encoded
 * grid is parsed back chunk by chunk, inflated and compared pixel by pixel.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const WIDTH = 64;
const HEIGHT = 48;
const MASK = { x: 10, y: 5, w: 10, h: 10 };
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BANDS = [
	[196, 48, 64, 255],
	[232, 146, 40, 255],
	[214, 206, 64, 255],
	[64, 168, 112, 255],
	[56, 120, 208, 255],
	[144, 88, 192, 255],
];

function bandColor(x) {
	return BANDS[Math.min(BANDS.length - 1, Math.floor((x / WIDTH) * BANDS.length))];
}

function makeGrid() {
	const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const [r, g, b, a] = bandColor(x);
			const i = (y * WIDTH + x) * 4;
			rgba[i] = r;
			rgba[i + 1] = g;
			rgba[i + 2] = b;
			rgba[i + 3] = a;
		}
	}
	return rgba;
}

function parsePng(buffer) {
	if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("png signature");
	const chunks = [];
	let offset = 8;
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		const crc = buffer.readUInt32BE(offset + 8 + length);
		const actual = zlib.crc32(buffer.subarray(offset + 4, offset + 8 + length));
		if (actual !== crc) throw new Error(`${type} crc mismatch`);
		chunks.push({ type, data, crc });
		offset += 12 + length;
	}
	if (offset !== buffer.length) throw new Error("trailing bytes");
	return chunks;
}

function pixel(rgba, width, x, y) {
	const i = (y * width + x) * 4;
	return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

function fields(result) {
	return result && Array.isArray(result.fields) ? result.fields : null;
}

function raster({ width = WIDTH, height = HEIGHT, pixels = makeGrid().toString("base64"), masks = [] } = {}) {
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
		marks: [],
	};
}

export default async function run({ ctx, check, evidence }) {
	const modulePath = path.join(ctx.appDir, "src", "issues-raster.mjs");
	const rasterModule = await import(pathToFileURL(modulePath).href);
	const { validateRaster, applyMasks, encodePng, sha256Hex } = rasterModule;
	const contractPath = path.join(ctx.appDir, "src", "issues-contract.mjs");
	const { validateCreate } = await import(pathToFileURL(contractPath).href);

	const visual = raster({ masks: [MASK] });
	const validated = validateRaster(visual);
	check("grid validates", validated.ok === true, validated.ok ? `${WIDTH}x${HEIGHT}` : JSON.stringify(validated));
	if (!validated.ok) return;

	const masked = applyMasks(validated.value.rgba, WIDTH, HEIGHT, validated.value.masks);
	check("applyMasks returns the same buffer", masked === validated.value.rgba);
	const png = encodePng({ width: WIDTH, height: HEIGHT, rgba: masked });
	const chunks = parsePng(png);
	const types = chunks.map((chunk) => chunk.type);
	check("chunk list is exactly IHDR, IDAT, IEND", JSON.stringify(types) === JSON.stringify(["IHDR", "IDAT", "IEND"]), types.join(","));

	const ihdr = chunks[0].data;
	check(
		"IHDR is 64x48, 8-bit RGBA, non-interlaced",
		ihdr.readUInt32BE(0) === WIDTH && ihdr.readUInt32BE(4) === HEIGHT && ihdr[8] === 8 && ihdr[9] === 6 && ihdr[10] === 0 && ihdr[11] === 0 && ihdr[12] === 0,
		[...ihdr].join(","),
	);

	const inflated = zlib.inflateSync(chunks[1].data);
	const decoded = Buffer.alloc(WIDTH * HEIGHT * 4);
	for (let y = 0; y < HEIGHT; y++) {
		const row = y * (WIDTH * 4 + 1);
		if (inflated[row] !== 0) throw new Error(`filter byte row ${y}`);
		inflated.copy(decoded, y * WIDTH * 4, row + 1, row + 1 + WIDTH * 4);
	}
	const expected = makeGrid();
	for (let y = MASK.y; y < MASK.y + MASK.h; y++) {
		for (let x = MASK.x; x < MASK.x + MASK.w; x++) {
			const i = (y * WIDTH + x) * 4;
			expected[i] = 0;
			expected[i + 1] = 0;
			expected[i + 2] = 0;
			expected[i + 3] = 255;
		}
	}

	const coordinates = [
		[0, 0],
		[9, 5],
		[10, 5],
		[19, 14],
		[20, 15],
		[20, 5],
		[9, 15],
		[63, 0],
		[0, 47],
		[63, 47],
	];
	const samples = [];
	let allMatch = true;
	for (const [x, y] of coordinates) {
		const got = pixel(decoded, WIDTH, x, y);
		const want = pixel(expected, WIDTH, x, y);
		const ok = got.every((value, index) => value === want[index]);
		allMatch = allMatch && ok;
		samples.push({ x, y, rgba: got, matches: ok });
	}
	check("inflated pixels equal the masked grid at sampled coordinates", allMatch, `${samples.filter((sample) => !sample.matches).length} mismatches`);
	const inside = [];
	for (let y = MASK.y; y < MASK.y + MASK.h; y++) {
		for (let x = MASK.x; x < MASK.x + MASK.w; x++) inside.push(pixel(decoded, WIDTH, x, y));
	}
	check("every masked pixel is opaque black", inside.every((rgba) => rgba.join(",") === "0,0,0,255"), `${inside.length} pixels`);
	check(
		"unmasked neighbors keep band colors",
		pixel(decoded, WIDTH, 9, 5).join(",") === bandColor(9).join(",") && pixel(decoded, WIDTH, 20, 5).join(",") === bandColor(20).join(","),
	);
	const independentDigest = createHash("sha256").update(png).digest("hex");
	check("retained png digest matches an independent sha256", sha256Hex(png) === independentDigest, independentDigest);

	const gridFile = evidence("Q03-grid.png", png);
	const report = {
		width: WIDTH,
		height: HEIGHT,
		mask: MASK,
		chunks: chunks.map((chunk) => ({ type: chunk.type, length: chunk.data.length, crc: chunk.crc })),
		sha256: sha256Hex(png),
		samples,
	};
	check("grid evidence written", Boolean(gridFile), gridFile);

	const probes = [];
	const probe = (name, input, expectedFields) => {
		const result = validateRaster(input);
		const ok = result.ok === false && result.error === "bad_input" && expectedFields.every((field) => fields(result)?.includes(field));
		probes.push({ name, ok, fields: fields(result) });
		check(`rejects ${name}`, ok, JSON.stringify(fields(result)));
	};
	probe("width 4097", raster({ width: 4097, height: 1 }), ["width"]);
	const budget = raster({ width: 2049, height: 1025 });
	Object.defineProperty(budget, "pixels", {
		get() {
			throw new Error("pixels must not be read");
		},
	});
	probe("pixel budget +1 before decode", budget, ["width", "height"]);
	probe("decoded length mismatch", raster({ width: 2, height: 2, pixels: makeGrid().subarray(0, 4).toString("base64") }), ["pixels"]);
	const alpha = makeGrid();
	alpha[3] = 254;
	probe("alpha 254", raster({ pixels: alpha.toString("base64") }), ["pixels[3]"]);
	probe("mask out of bounds", raster({ masks: [{ x: 60, y: 0, w: 8, h: 1 }] }), ["masks[0].x + masks[0].w"]);
	probe("string dimension", raster({ width: "3", height: 2 }), ["width"]);
	probe("NaN dimension", raster({ width: NaN, height: 2 }), ["width"]);
	probe("noncanonical base64", raster({ width: 1, height: 1, pixels: "/////x==" }), ["pixels"]);

	const acceptances = [];
	for (const [width, height] of [[1024, 1024], [4096, 512]]) {
		const large = { ...raster({ width, height }), pixels: Buffer.alloc(width * height * 4, 255).toString("base64") };
		const result = validateRaster(large);
		const ok = result.ok === true && result.value.rgba.length === width * height * 4;
		acceptances.push({ width, height, ok });
		check(`accepts valid ${width}x${height} raster`, ok, ok ? "accepted" : JSON.stringify(result));
	}

	const marked = raster({ marks: [] });
	marked.marks = [{ rect: { x: 0, y: 0, w: 1, h: 1 }, text: "Synthetic note" }];
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
	const contractResult = validateCreate(body);
	const rasterResult = validateRaster(marked);
	check(
		"a marked visual passes both the shared contract and raster validators",
		contractResult.ok === true && rasterResult.ok === true,
		JSON.stringify({ contract: contractResult.ok ? "accepted" : contractResult.fields, raster: rasterResult.ok ? "accepted" : rasterResult.fields }),
	);

	const pixelsFile = evidence("Q03-pixels.json", JSON.stringify({ ...report, acceptances, probes }, null, 2));
	check("pixel evidence written", Boolean(pixelsFile), pixelsFile);
}
