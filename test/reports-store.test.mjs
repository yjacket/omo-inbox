import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createReportsStore } from "../src/reports-store.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function fingerprint(n) {
	return String(n).repeat(64).slice(0, 64);
}

function report(id, description = `${id} description`) {
	return { v: 2, reportId: id, description, page: { kind: "inbox" }, image: null };
}

function setup(t, iso = "2026-01-02T03:04:05.000Z") {
	const { home, cleanup } = makeTmpHome("reports-store-");
	t.after(cleanup);
	let clock = new Date(iso);
	const dataDir = path.join(home, "data");
	const store = createReportsStore({ dataDir, now: () => clock });
	return {
		home,
		dataDir,
		store,
		setNow(value) {
			clock = new Date(value);
		},
	};
}

function create(store, id, extra = {}) {
	return store.create({ id, fingerprint: fingerprint(1), report: report(id), ...extra });
}

test("create writes report.json and image.png in the id directory", (t) => {
	const f = setup(t);
	const result = create(f.store, "id-a", { png: PNG, imageMeta: { width: 1, height: 1, provenance: "snapshot" } });
	assert.equal(result.created, true);
	const dir = path.join(f.dataDir, "reports", "id-a");
	assert.ok(fs.existsSync(path.join(dir, "report.json")));
	assert.ok(fs.existsSync(path.join(dir, "image.png")));
	assert.deepEqual([...fs.readdirSync(f.dataDir)].length, 1);
	const staging = fs.readdirSync(path.join(f.dataDir, "reports")).filter((name) => name.startsWith(".staging-"));
	assert.deepEqual(staging, []);
});

test("create returns the documented record defaults", (t) => {
	const f = setup(t);
	const result = create(f.store, "id-a", { legacy: { issueId: "old-1", createdAt: "2025-01-01T00:00:00.000Z", target: "repo" } });
	assert.deepEqual(result.record, {
		v: 1,
		id: "id-a",
		createdAt: "2026-01-02T03:04:05.000Z",
		fingerprint: fingerprint(1),
		report: report("id-a"),
		image: null,
		asset: null,
		issueRequest: null,
		delivery: {
			state: "queued",
			attempts: 0,
			creates: 0,
			nextAttemptAt: null,
			uncertainSince: null,
			lastError: null,
		},
		github: null,
		handoff: null,
		legacy: { issueId: "old-1", createdAt: "2025-01-01T00:00:00.000Z", target: "repo" },
	});
});

test("get returns the created record and null for unknown ids", (t) => {
	const f = setup(t);
	const result = create(f.store, "id-a");
	assert.deepEqual(f.store.get("id-a"), result.record);
	assert.equal(f.store.get("missing"), null);
	assert.equal(f.store.get(".."), null);
});

test("create without createdAt uses the injected now", (t) => {
	const f = setup(t, "2027-02-03T04:05:06.789Z");
	assert.equal(create(f.store, "id-a").record.createdAt, "2027-02-03T04:05:06.789Z");
	f.setNow("2028-01-01T00:00:00.000Z");
	assert.equal(create(f.store, "id-b").record.createdAt, "2028-01-01T00:00:00.000Z");
});

test("explicit createdAt is kept even after the clock moves", (t) => {
	const f = setup(t);
	const createdAt = "2020-05-06T07:08:09.000Z";
	const result = create(f.store, "id-a", { createdAt });
	assert.equal(result.record.createdAt, createdAt);
	f.setNow("2030-01-01T00:00:00.000Z");
	assert.equal(create(f.store, "id-b").record.createdAt, "2030-01-01T00:00:00.000Z");
});

test("an exact create replay returns created:false with the stored record", (t) => {
	const f = setup(t);
	const first = create(f.store, "id-a");
	f.setNow("2029-09-09T00:00:00.000Z");
	const again = create(f.store, "id-a");
	assert.equal(again.created, false);
	assert.deepEqual(again.record, first.record);
	assert.equal(again.record.createdAt, "2026-01-02T03:04:05.000Z");
});

test("a different fingerprint for the same id throws key_reused", (t) => {
	const f = setup(t);
	create(f.store, "id-a");
	assert.throws(
		() => f.store.create({ id: "id-a", fingerprint: fingerprint(2), report: report("id-a") }),
		(error) => error.code === "key_reused",
	);
});

test("a fresh store instance reads the same record", (t) => {
	const f = setup(t);
	const result = create(f.store, "id-a", { png: PNG, imageMeta: { width: 1, height: 1, provenance: "upload" } });
	const again = createReportsStore({ dataDir: f.dataDir, now: () => new Date("2031-01-01T00:00:00.000Z") });
	assert.deepEqual(again.get("id-a"), result.record);
	assert.deepEqual(again.image("id-a"), PNG);
});

test("update shallow-merges only the documented top-level keys and persists", (t) => {
	const f = setup(t);
	const original = create(f.store, "id-a").record;
	const updated = f.store.update("id-a", {
		asset: { path: "reports/2026/01/id-a.png", blobSha: "abc" },
		issueRequest: { title: "t", body: "b", labels: ["inbox-report"] },
		delivery: { state: "retry_wait", attempts: 2, nextAttemptAt: "2026-01-02T03:05:00.000Z" },
		github: { number: 3, url: "https://example.test/3", nodeId: "n", createdAt: "2026-01-02T03:04:06.000Z" },
		handoff: { at: "2026-01-02T03:04:07.000Z", session: "s", via: "local" },
		report: { replaced: true },
		bogus: "ignored",
	});
	assert.equal(updated.delivery.state, "retry_wait");
	assert.equal(updated.delivery.attempts, 2);
	assert.equal(updated.asset.blobSha, "abc");
	assert.equal(updated.github.number, 3);
	assert.equal(updated.handoff.via, "local");
	assert.deepEqual(updated.report, original.report);
	assert.equal(Object.hasOwn(updated, "bogus"), false);
	const again = createReportsStore({ dataDir: f.dataDir, now: () => new Date() });
	assert.deepEqual(again.get("id-a"), updated);
});

test("update throws not_found for an unknown id", (t) => {
	const f = setup(t);
	assert.throws(() => f.store.update("missing", { handoff: {} }), (error) => error.code === "not_found");
});

test("explicit createdAt decides ordering and equal times sort by id descending", (t) => {
	const f = setup(t);
	create(f.store, "id-old", { createdAt: "2020-01-01T00:00:00.000Z" });
	create(f.store, "id-a", { createdAt: "2021-01-01T00:00:00.000Z" });
	create(f.store, "id-b", { createdAt: "2021-01-01T00:00:00.000Z" });
	create(f.store, "id-new", { createdAt: "2022-01-01T00:00:00.000Z" });
	assert.deepEqual(f.store.list({}).items.map((item) => item.id), ["id-new", "id-b", "id-a", "id-old"]);
});

test("list paginates newest first with the last id as the cursor", (t) => {
	const f = setup(t);
	for (let i = 1; i <= 5; i++) {
		create(f.store, `id-${i}`, { createdAt: `2026-01-0${i}T00:00:00.000Z` });
	}
	const first = f.store.list({ limit: 2 });
	assert.deepEqual(first.items.map((item) => item.id), ["id-5", "id-4"]);
	assert.equal(first.nextCursor, "id-4");
	const second = f.store.list({ limit: 2, cursor: first.nextCursor });
	assert.deepEqual(second.items.map((item) => item.id), ["id-3", "id-2"]);
	assert.equal(second.nextCursor, "id-2");
	const third = f.store.list({ limit: 2, cursor: second.nextCursor });
	assert.deepEqual(third.items.map((item) => item.id), ["id-1"]);
	assert.equal(third.nextCursor, null);
});

test("list ignores staging dirs and directories without a usable report.json", (t) => {
	const f = setup(t);
	create(f.store, "id-real");
	const root = path.join(f.dataDir, "reports");
	fs.mkdirSync(path.join(root, ".staging-x-1"), { recursive: true });
	fs.writeFileSync(path.join(root, ".staging-x-1", "report.json"), "{\"partial\":");
	fs.writeFileSync(path.join(root, ".staging-x-1", "image.png"), PNG);
	fs.mkdirSync(path.join(root, "no-report"), { recursive: true });
	fs.writeFileSync(path.join(root, "no-report", "image.png"), PNG);
	fs.mkdirSync(path.join(root, "bad-json"), { recursive: true });
	fs.writeFileSync(path.join(root, "bad-json", "report.json"), "not json");
	fs.mkdirSync(path.join(root, "wrong-id"), { recursive: true });
	fs.writeFileSync(path.join(root, "wrong-id", "report.json"), JSON.stringify({ v: 1, id: "someone-else" }));
	assert.deepEqual(f.store.list({}).items.map((item) => item.id), ["id-real"]);
	assert.deepEqual(f.store.counts(), { pending: 1, failed: 0, sent: 0 });
	assert.equal(f.store.get("no-report"), null);
});

test("images round trip through a fresh store and a null image stays null", (t) => {
	const f = setup(t);
	const withImage = create(f.store, "id-image", {
		png: PNG,
		imageMeta: { width: 1, height: 1, provenance: "upload" },
	}).record;
	assert.equal(withImage.image.bytes, PNG.length);
	assert.equal(withImage.image.width, 1);
	assert.equal(withImage.image.provenance, "upload");
	assert.match(withImage.image.sha256, /^[0-9a-f]{64}$/);
	const again = createReportsStore({ dataDir: f.dataDir, now: () => new Date() });
	assert.deepEqual(again.image("id-image"), PNG);
	assert.equal(again.image("id-none"), null);
	assert.equal(create(f.store, "id-none").record.image, null);
	assert.equal(again.image("id-none"), null);
});

test("counts groups every delivery state as pending, failed or sent", (t) => {
	const f = setup(t);
	create(f.store, "id-queued");
	create(f.store, "id-uploading");
	create(f.store, "id-reconciling");
	create(f.store, "id-retry");
	create(f.store, "id-failed");
	create(f.store, "id-sent");
	f.store.update("id-uploading", { delivery: { state: "uploading" } });
	f.store.update("id-reconciling", { delivery: { state: "reconciling" } });
	f.store.update("id-retry", { delivery: { state: "retry_wait" } });
	f.store.update("id-failed", { delivery: { state: "failed" } });
	f.store.update("id-sent", { delivery: { state: "sent" } });
	assert.deepEqual(f.store.counts(), { pending: 4, failed: 1, sent: 1 });
});

test("unfinished excludes sent and failed and survives a restart", (t) => {
	const f = setup(t);
	create(f.store, "id-queued");
	create(f.store, "id-retry");
	create(f.store, "id-failed");
	create(f.store, "id-sent");
	f.store.update("id-retry", { delivery: { state: "retry_wait" } });
	f.store.update("id-failed", { delivery: { state: "failed" } });
	f.store.update("id-sent", { delivery: { state: "sent" } });
	const restarted = createReportsStore({ dataDir: f.dataDir, now: () => new Date() });
	assert.deepEqual(restarted.unfinished().map((record) => record.id), ["id-retry", "id-queued"]);
});
