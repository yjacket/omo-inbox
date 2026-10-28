import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { migrateLegacy } from "../src/reports-legacy.mjs";
import { createReportsStore } from "../src/reports-store.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

const LIVE_ID = "423bab59-043a-4d30-b1ba-06db92798daf";
const LIVE_CREATED_AT = "2026-10-27T15:32:14.822Z";
const PRODUCT_OF = (source) => (source?.kind === "proposal" ? "omo-inbox" : null);
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

function setup(t) {
	const { home, cleanup } = makeTmpHome("reports-legacy-");
	t.after(cleanup);
	const dataDir = path.join(home, "data");
	const store = createReportsStore({ dataDir, now: () => new Date("2030-01-01T00:00:00.000Z") });
	return { home, dataDir, store };
}

function addRecord(dataDir, {
	id = LIVE_ID,
	description = "와이어프레임으로 구성하는게 더 적절",
	state = "open",
	tombstone = false,
	image = false,
	targetKind = "frame",
	page = "proposal",
} = {}) {
	const dir = path.join(dataDir, "issues", "records", id);
	const source = {
		kind: "proposal",
		proposalId: "261028-m28s",
		revision: 1,
		observedSeq: 1,
		recordedContentHash: "57c64b491567c18f3cdf29591d67da16228044a752642f51ae9c4091f0e19a21",
		frame: null,
	};
	writeJson(path.join(dir, "created.json"), {
		v: 1,
		id,
		storeId: "6b52ef1f-69e9-4b59-915c-d6476b8b549c",
		title: description,
		description,
		createdAt: LIVE_CREATED_AT,
		source,
	});
	writeJson(path.join(dir, "events", ".committed.json"), {
		seq: 1,
		hash: "a9eb5b059607b49672ff233065e122a34d7708b96d61051d786dfb8266ef046e",
	});
	writeJson(path.join(dir, "events", "000001.json"), {
		v: 1,
		type: "created",
		seq: 1,
		requestId: id,
		acceptedAt: LIVE_CREATED_AT,
		actor: "owner",
		via: "pc",
		state,
		command: null,
	});
	const captureId = "b20e2cce-b461-423b-ade5-a00826b0dc55";
	writeJson(path.join(dir, "evidence", captureId, "context.json"), {
		captureId,
		observedAt: "2026-10-27T15:31:31.520Z",
		page,
		source,
		target: {
			kind: targetKind,
			key: targetKind === "frame" ? "frame:보고서 순서" : "element:#board",
			label: "보고서 순서",
			rect: { x: 45, y: 358.390625, w: 690, h: 745.9375 },
			framePath: [],
		},
		view: {
			width: 795,
			height: 1270,
			dpr: 1,
			scale: 1,
			scrollX: 0,
			scrollY: 0,
			theme: "light",
			locale: "ko",
			embedded: false,
			viewerOpen: false,
		},
		excerpt: null,
		excerptTruncated: false,
	});
	if (image) fs.writeFileSync(path.join(dir, "evidence", captureId, "image.png"), PNG);
	if (tombstone) writeJson(path.join(dataDir, "issues", "tombstones", `${id}.json`), { id, at: LIVE_CREATED_AT });
	return dir;
}

function treeHashes(dir) {
	const result = {};
	function walk(current, prefix) {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.join(current, entry.name);
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(file, rel);
			else result[rel] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		}
	}
	walk(dir, "");
	return result;
}

function migrate(dataDir, store, extra = {}) {
	return migrateLegacy({ dataDir, store, productOf: PRODUCT_OF, now: () => new Date("2026-10-28T00:00:00.000Z"), ...extra });
}

test("an open live-shaped record migrates with its mapped v2 report", (t) => {
	const f = setup(t);
	addRecord(f.dataDir);
	const result = migrate(f.dataDir, f.store);
	assert.deepEqual(result, { migrated: 1, skipped: 0 });

	const record = f.store.get(LIVE_ID);
	assert.ok(record);
	assert.equal(record.createdAt, LIVE_CREATED_AT);
	assert.equal(record.fingerprint, `legacy:${LIVE_ID}`);
	assert.deepEqual(record.legacy, { issueId: LIVE_ID, createdAt: LIVE_CREATED_AT, target: "보고서 순서" });
	assert.deepEqual(record.report, {
		v: 2,
		reportId: LIVE_ID,
		description: "와이어프레임으로 구성하는게 더 적절",
		page: { kind: "proposal", route: "/", url: "/", title: "", frames: [] },
		element: null,
		view: {
			layout: { w: 795, h: 1270 },
			visual: { x: 0, y: 0, w: 795, h: 1270, scale: 1 },
			scroll: { x: 0, y: 0 },
			dpr: 1,
			colorScheme: "light",
			pointer: "fine",
		},
		source: {
			kind: "proposal",
			proposalId: "261028-m28s",
			revision: 1,
			frame: "보고서 순서",
			product: "omo-inbox",
		},
		image: null,
	});
	assert.equal(record.report.source.frame, "보고서 순서");
	assert.equal(record.delivery.state, "queued");
});

test("a resolved record is skipped and counted", (t) => {
	const f = setup(t);
	addRecord(f.dataDir, { id: "11111111-1111-4111-8111-111111111111", state: "resolved" });
	const result = migrate(f.dataDir, f.store);
	assert.deepEqual(result, { migrated: 0, skipped: 1 });
	assert.equal(f.store.get("11111111-1111-4111-8111-111111111111"), null);
	const marker = JSON.parse(fs.readFileSync(path.join(f.dataDir, "reports", ".legacy-migrated.json"), "utf8"));
	assert.deepEqual(marker, { at: "2026-10-28T00:00:00.000Z", ids: [] });
});

test("a tombstoned record is skipped and counted", (t) => {
	const f = setup(t);
	addRecord(f.dataDir, { tombstone: true });
	const result = migrate(f.dataDir, f.store);
	assert.deepEqual(result, { migrated: 0, skipped: 1 });
	assert.equal(f.store.get(LIVE_ID), null);
});

test("a second run is a no-op and keeps the marker", (t) => {
	const f = setup(t);
	addRecord(f.dataDir);
	assert.deepEqual(migrate(f.dataDir, f.store), { migrated: 1, skipped: 0 });
	const markerPath = path.join(f.dataDir, "reports", ".legacy-migrated.json");
	const markerBefore = fs.readFileSync(markerPath, "utf8");
	const dirBefore = fs.readdirSync(path.join(f.dataDir, "reports")).sort();
	let productCalls = 0;
	const second = migrate(f.dataDir, f.store, {
		productOf: () => {
			productCalls++;
			return "omo-inbox";
		},
	});
	assert.deepEqual(second, { migrated: 0, skipped: 0 });
	assert.equal(productCalls, 0);
	assert.equal(fs.readFileSync(markerPath, "utf8"), markerBefore);
	assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "reports")).sort(), dirBefore);
});

test("the legacy data/issues tree is byte-for-byte unchanged", (t) => {
	const f = setup(t);
	addRecord(f.dataDir);
	const before = treeHashes(path.join(f.dataDir, "issues"));
	migrate(f.dataDir, f.store);
	assert.deepEqual(treeHashes(path.join(f.dataDir, "issues")), before);
});

test("no legacy records directory is a no-op without a marker", (t) => {
	const f = setup(t);
	assert.deepEqual(migrate(f.dataDir, f.store), { migrated: 0, skipped: 0 });
	assert.equal(fs.existsSync(path.join(f.dataDir, "reports", ".legacy-migrated.json")), false);
});

test("a legacy picture becomes a legacy-provenance image", (t) => {
	const f = setup(t);
	addRecord(f.dataDir, { image: true });
	assert.deepEqual(migrate(f.dataDir, f.store), { migrated: 1, skipped: 0 });
	const record = f.store.get(LIVE_ID);
	assert.deepEqual(record.report.image, { provenance: "legacy", width: 1, height: 1 });
	assert.deepEqual(record.image, {
		sha256: crypto.createHash("sha256").update(PNG).digest("hex"),
		bytes: PNG.length,
		width: 1,
		height: 1,
		provenance: "legacy",
	});
	assert.deepEqual(f.store.image(LIVE_ID), PNG);
});
