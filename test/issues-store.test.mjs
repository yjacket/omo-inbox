import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { createIssuesStore, IssueStoreError } from "../src/issues-store.mjs";
import { LIMITS } from "../src/issues-contract.mjs";
import { sha256Hex } from "../src/issues-raster.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { AT, idFor, owner, maintainer, capture, createBody, commandBody, terminateAtBarrier } from "./fixtures/issues-crash-worker.mjs";

function setup(t, options = {}) {
	const { home, cleanup } = makeTmpHome("issues-store-");
	const dataDir = path.join(home, "data");
	let store = createIssuesStore({ dataDir, now: () => new Date(AT), ...options });
	t.after(() => { store.close(); cleanup(); });
	return {
		home, dataDir,
		get store() { return store; },
		restart() {
			store.close();
			store = createIssuesStore({ dataDir, now: () => new Date(AT), ...options });
			return store;
		},
	};
}

function code(expected, fields) {
	return (error) => {
		assert.ok(error instanceof IssueStoreError);
		assert.equal(error.code, expected);
		if (fields) assert.deepEqual(error.fields, fields);
		return true;
	};
}

function filesUnder(root) {
	const out = {};
	if (!fs.existsSync(root)) return out;
	for (const file of fs.readdirSync(root, { recursive: true })) {
		const full = path.join(root, file);
		if (fs.statSync(full).isFile()) out[file.replaceAll("\\", "/")] = sha256Hex(fs.readFileSync(full));
	}
	return out;
}

test("identity persists, live ownership is exclusive, and close cannot keep writing", async (t) => {
	const f = setup(t);
	const first = f.store;
	const identity = first.storeId;
	assert.deepEqual(first.capabilities(), {
		v: 1, storeId: identity, schemas: ["v1"], limits: LIMITS,
		states: ["open", "investigating", "needs-check", "resolved"],
		ownerCommands: ["comment", "append_evidence", "confirm", "reopen", "purge"],
		maintainerCommands: ["triage", "comment", "request_check"],
	});
	assert.throws(() => createIssuesStore({ dataDir: f.dataDir }), code("locked"));
	assert.equal(f.restart().storeId, identity);
	assert.throws(() => first.list(), code("locked"));
	await assert.rejects(first.create(createBody(identity), owner), code("locked"));
	const original = createBody(identity);
	await assert.rejects(f.store.create({ ...original, storeId: idFor(90) }, owner), code("store_changed"));
	await assert.rejects(f.store.create({ ...original, requestId: "../outside" }, owner), code("bad_input", ["requestId"]));
	assert.equal(fs.readdirSync(path.join(f.dataDir, "issues", "records")).length, 0);
});

test("two stale-lock reclaimers cannot remove the new live owner", async (t) => {
	const f = setup(t);
	f.store.close();
	await terminateAtBarrier({ dataDir: f.dataDir, point: "lock_acquired" });
	const real = fs.unlinkSync;
	const lockFile = path.join(f.dataDir, "issues", ".lock");
	let contested = false;
	const mocked = t.mock.method(fs, "unlinkSync", function(file) {
		if (String(file) === lockFile && !contested) {
			contested = true;
			assert.throws(() => createIssuesStore({ dataDir: f.dataDir }), code("locked"));
		}
		return real.call(this, file);
	});
	f.restart();
	mocked.mock.restore();
	assert.equal(contested, true);
	await f.store.create(createBody(f.store.storeId), owner);
	assert.equal(f.store.get(idFor(1)).currentSeq, 1);
});

test("create receipts reference complete sanitized immutable evidence and replay current state", async (t) => {
	const f = setup(t, { redactText: (text) => text.replaceAll("PRIVATE", "[redacted]") });
	const input = createBody(f.store.storeId);
	input.description = "  PRIVATE first line\nsecond line  ";
	input.evidence.excerpt = "PRIVATE";
	input.evidence.visual.marks[0].text = "PRIVATE";
	const original = structuredClone(input);
	const created = await f.store.create(input, owner);
	assert.deepEqual(input, original);
	assert.equal(created.status, 201);
	assert.deepEqual(created.body.receipt, { requestId: idFor(1), seq: 1, acceptedAt: AT });
	assert.equal(created.body.referenceCheck.status, "missing");
	assert.equal(created.body.evidenceManifest.serverBuild, owner.buildId);
	assert.equal(created.body.evidenceManifest.clientBuild.digest, "b".repeat(64));
	assert.equal(created.body.evidenceManifest.context.excerpt, "[redacted]");
	assert.equal(created.body.evidenceManifest.context.view.width, 390);
	const detail = f.store.get(idFor(1));
	assert.equal(detail.issue.title, "[redacted] first line");
	assert.equal(detail.events.length, 1);
	const image = f.store.evidenceImage(idFor(1), idFor(2));
	assert.equal(image.sha256, sha256Hex(image.bytes));
	assert.equal(image.byteLength, image.bytes.length);
	let offset = 8;
	const compressed = [];
	while (offset < image.bytes.length) {
		const size = image.bytes.readUInt32BE(offset);
		if (image.bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") compressed.push(image.bytes.subarray(offset + 8, offset + 8 + size));
		offset += 12 + size;
	}
	assert.deepEqual([...zlib.inflateSync(Buffer.concat(compressed))], [0, 0, 0, 0, 255, 10, 20, 30, 255]);
	const dir = path.join(f.dataDir, "issues", "records", idFor(1));
	const evidenceBefore = filesUnder(path.join(dir, "evidence"));
	for (const filename of fs.readdirSync(dir, { recursive: true }).filter((file) => file.endsWith(".json"))) {
		const text = fs.readFileSync(path.join(dir, filename), "utf8");
		assert.ok(!text.includes("PRIVATE"));
		assert.ok(!text.includes('"pixels"'));
		assert.ok(!text.includes(input.evidence.visual.pixels));
	}
	const triage = commandBody(f.store.storeId, idFor(3), 1, { type: "triage", category: "inbox-ui", severity: "high", note: null });
	await f.store.command(idFor(1), triage, maintainer);
	f.restart();
	const replayed = await f.store.create(input, owner);
	assert.equal(replayed.status, 200);
	assert.equal(replayed.replayed, true);
	assert.deepEqual(replayed.body.receipt, created.body.receipt);
	assert.equal(replayed.body.currentSeq, 2);
	assert.equal(replayed.body.state, "investigating");
	await assert.rejects(f.store.create({ ...input, description: "different" }, owner), code("key_reused"));
	assert.deepEqual(filesUnder(path.join(dir, "evidence")), evidenceBefore);
});

test("same-key concurrency and expectedSeq CAS each produce exactly one event", async (t) => {
	const f = setup(t);
	const input = createBody(f.store.storeId);
	const creates = await Promise.all([f.store.create(input, owner), f.store.create(input, owner)]);
	assert.deepEqual(creates.map((r) => r.status).sort(), [200, 201]);
	const a = commandBody(f.store.storeId, idFor(3), 1, { type: "comment", text: "a" });
	const b = commandBody(f.store.storeId, idFor(4), 1, { type: "comment", text: "b" });
	const race = await Promise.allSettled([f.store.command(idFor(1), a, owner), f.store.command(idFor(1), b, owner)]);
	assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
	const conflict = race.find((r) => r.status === "rejected").reason;
	assert.equal(conflict.code, "version_conflict");
	assert.equal(conflict.currentSeq, 2);
	assert.equal(conflict.state, "open");
	const replayed = await f.store.command(idFor(1), a, owner);
	assert.equal(replayed.replayed, true);
	assert.equal(replayed.event, null);
	assert.equal(replayed.body.receipt.seq, 2);
	await assert.rejects(f.store.command(idFor(1), { ...a, expectedSeq: 2 }, owner), code("key_reused"));
	const same = commandBody(f.store.storeId, idFor(5), 2, { type: "comment", text: "once" });
	const results = await Promise.all([f.store.command(idFor(1), same, owner), f.store.command(idFor(1), same, owner)]);
	assert.equal(results.filter((r) => r.replayed).length, 1);
	assert.deepEqual(f.store.get(idFor(1)).events.map((e) => e.seq), [1, 2, 3]);
});

test("async reference resolution rechecks CAS, tombstones, and store close", async (t) => {
	const f = setup(t);
	await f.store.create(createBody(f.store.storeId), owner);
	let release;
	const held = { ...owner, resolveReference: () => new Promise((resolve) => { release = resolve; }) };
	const pending = f.store.command(idFor(1), commandBody(f.store.storeId, idFor(3), 1, { type: "append_evidence", evidence: capture(idFor(4)), note: null }), held);
	await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(5), 1, { type: "purge" }), owner);
	release({ status: "missing", checkedAt: AT });
	await assert.rejects(pending, code("gone"));
	const next = createBody(f.store.storeId, idFor(7));
	const creating = f.store.create(next, held);
	f.store.close();
	release({ status: "missing", checkedAt: AT });
	await assert.rejects(creating, code("locked"));
});

test("lifecycle keeps correction, evidence, confirmation and route actors distinct", async (t) => {
	const f = setup(t);
	const s = f.store;
	await s.create(createBody(s.storeId), owner);
	const requests = [];
	let seq = 1;
	let n = 10;
	async function send(command, actor, state) {
		const body = commandBody(s.storeId, idFor(n++), seq, command);
		requests.push([body, actor]);
		const result = await s.command(idFor(1), body, actor);
		assert.equal(result.body.currentSeq, ++seq);
		assert.equal(result.body.state, state);
		return result;
	}
	await assert.rejects(s.command(idFor(1), commandBody(s.storeId, idFor(9), 1, { type: "confirm" }), owner), code("invalid_transition"));
	await assert.rejects(s.command(idFor(1), commandBody(s.storeId, idFor(9), 1, { type: "triage", category: "other", severity: "low", note: null }), owner), code("forbidden"));
	await assert.rejects(s.create(createBody(s.storeId, idFor(8)), maintainer), code("forbidden"));
	await send({ type: "triage", category: "report-content", severity: "high", note: "investigating" }, maintainer, "investigating");
	const check = { type: "request_check", note: "Please check", correction: { kind: "review-artifact", proposalId: "opaque/source", revision: 2, summary: "New artifact, not deployed code" }, evidence: capture(idFor(60)) };
	check.evidence.visual.provenance = "reproduction";
	await send(check, maintainer, "needs-check");
	await send({ ...check, evidence: null }, maintainer, "needs-check");
	const confirmation = await send({ type: "confirm" }, owner, "resolved");
	await send({ type: "comment", text: "Owner comment" }, owner, "resolved");
	await send({ type: "comment", text: "Maintainer comment" }, maintainer, "resolved");
	const before = s.get(idFor(1)).evidence;
	await send({ type: "append_evidence", evidence: capture(idFor(61)), note: null }, owner, "resolved");
	assert.deepEqual(s.get(idFor(1)).evidence.slice(0, 2), before);
	await assert.rejects(s.command(idFor(1), commandBody(s.storeId, idFor(90), seq, check), maintainer), code("invalid_transition"));
	await send({ type: "reopen", comment: "Still present" }, owner, "open");
	const replayed = await s.command(idFor(1), requests[3][0], owner);
	assert.deepEqual(replayed.body.receipt, confirmation.body.receipt);
	assert.equal(replayed.body.state, "open");
	assert.equal(s.list().items[0].category, "report-content");
	assert.equal(s.list().items[0].severity, "high");
	await assert.rejects(s.command(idFor(1), commandBody(s.storeId, idFor(90), seq, { type: "append_evidence", evidence: capture(idFor(2)), note: null }), owner), code("bad_input", ["command.evidence.captureId"]));
	await assert.rejects(s.command(idFor(1), commandBody(s.storeId, idFor(90), seq, { type: "confirm" }), maintainer), code("forbidden"));
	await assert.rejects(s.command(idFor(1), commandBody(s.storeId, idFor(90), seq, { type: "comment", text: "x" }), { ...owner, actor: "toString" }), code("forbidden"));
});

test("request_check correction is resolved before commit, persisted, and never re-resolved on replay", async (t) => {
	const f = setup(t);
	await f.store.create(createBody(f.store.storeId), owner);
	const correction = { kind: "review-artifact", proposalId: "opaque/source", revision: 2, summary: "New artifact" };
	const body = commandBody(f.store.storeId, idFor(3), 1, { type: "request_check", note: "Check this", correction, evidence: null });
	let calls = 0;
	const resolving = {
		...maintainer,
		async resolveCorrection(value) {
			calls++;
			assert.deepEqual(value, correction);
			return { ok: true, check: { status: "matched", checkedAt: AT } };
		},
	};
	const result = await f.store.command(idFor(1), body, resolving);
	assert.equal(calls, 1);
	assert.deepEqual(result.body.correctionCheck, { status: "matched", checkedAt: AT });
	const eventFile = JSON.parse(fs.readFileSync(path.join(f.dataDir, "issues", "records", idFor(1), "events", "000002.json"), "utf8"));
	assert.deepEqual(eventFile.correctionCheck, { status: "matched", checkedAt: AT });
	assert.deepEqual(f.store.get(idFor(1)).events.at(-1).correctionCheck, { status: "matched", checkedAt: AT });
	f.restart();
	const replaying = {
		...maintainer,
		async resolveCorrection() { throw new Error("resolver must not run on replay"); },
	};
	const replay = await f.store.command(idFor(1), body, replaying);
	assert.equal(replay.replayed, true);
	assert.equal(replay.event, null);
	assert.deepEqual(replay.body.receipt, result.body.receipt);
	assert.deepEqual(replay.body.correctionCheck, result.body.correctionCheck);
	assert.equal(f.store.get(idFor(1)).currentSeq, 2);
	assert.equal(calls, 1);
});

test("rejected correction check commits nothing and a missing resolver is unversioned", async (t) => {
	const f = setup(t);
	await f.store.create(createBody(f.store.storeId), owner);
	const correction = { kind: "review-artifact", proposalId: "missing/source", revision: 2, summary: "New artifact" };
	const body = commandBody(f.store.storeId, idFor(3), 1, { type: "request_check", note: "Check this", correction, evidence: null });
	const rejecting = { ...maintainer, resolveCorrection: async () => ({ ok: false, fields: ["command.correction.proposalId"] }) };
	await assert.rejects(f.store.command(idFor(1), body, rejecting), code("bad_input", ["command.correction.proposalId"]));
	assert.equal(f.store.get(idFor(1)).currentSeq, 1);
	assert.deepEqual(fs.readdirSync(path.join(f.dataDir, "issues", "records", idFor(1), "events")).sort(), [".committed.json", "000001.json"]);
	const unversioned = await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(4), 1, { type: "request_check", note: "Check this", correction, evidence: null }), maintainer);
	assert.deepEqual(unversioned.body.correctionCheck, { status: "unversioned", checkedAt: AT });
	assert.deepEqual(f.store.get(idFor(1)).events.at(-1).correctionCheck, { status: "unversioned", checkedAt: AT });
	assert.equal(f.store.get(idFor(1)).currentSeq, 2);
});

test("list sorting, literal search, opaque cursors and event pagination survive restart", async (t) => {
	const f = setup(t);
	for (const n of [1, 3, 5]) {
		const body = createBody(f.store.storeId, idFor(n), capture(idFor(n + 1), false));
		body.description = n === 3 ? "Case [.*] literal" : `Other ${n}`;
		await f.store.create(body, owner);
	}
	await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(9), 1, { type: "triage", category: "other", severity: "normal", note: null }), maintainer);
	f.restart();
	const page = f.store.list({ limit: 2 });
	assert.deepEqual(page.items.map((item) => item.id), [idFor(5), idFor(3)]);
	assert.deepEqual(f.store.list({ cursor: page.nextCursor, limit: 2 }).items.map((item) => item.id), [idFor(1)]);
	assert.deepEqual(page.counts, { open: 2, investigating: 1, "needs-check": 0, resolved: 0 });
	assert.equal(f.store.list({ q: "CASE [.*]" }).items[0].id, idFor(3));
	assert.equal(f.store.list({ q: "^Other" }).items.length, 0);
	assert.equal(f.store.list({ state: "investigating" }).items.length, 1);
	const first = f.store.get(idFor(1), { limit: 1 });
	assert.equal(first.nextAfter, 1);
	assert.equal(f.store.get(idFor(1), { after: first.nextAfter }).events[0].seq, 2);
	assert.equal(f.store.get(idFor(1), { after: 20 }).nextAfter, null);
	for (const options of [{ limit: 101 }, { limit: 0 }, { limit: "1" }, { state: "closed" }, { q: "x".repeat(201) }, { cursor: "../" }, { cursor: Buffer.from('{"id":"../","createdAt":"yesterday"}').toString("base64url") }]) {
		assert.throws(() => f.store.list(options), code("bad_input"));
	}
	assert.throws(() => f.store.get(idFor(1), { after: -1 }), code("bad_input"));
	assert.throws(() => f.store.get(idFor(99)), code("not_found"));
	assert.throws(() => f.store.evidenceImage(idFor(1), idFor(2)), code("not_found"));
	assert.throws(() => f.store.evidenceImage(idFor(1), "../"), code("bad_input"));
});

test("101 evidence sets paginate with their creating events after restart", async (t) => {
	const f = setup(t);
	await f.store.create(createBody(f.store.storeId, idFor(1), capture(idFor(2), false)), owner);
	for (let seq = 2; seq <= 101; seq++) {
		const body = commandBody(f.store.storeId, idFor(seq * 2 - 1), seq - 1, {
			type: "append_evidence", evidence: capture(idFor(seq * 2), false), note: null,
		});
		await f.store.command(idFor(1), body, owner);
	}
	f.restart();
	const first = f.store.get(idFor(1));
	assert.equal(first.events.length, 50);
	assert.equal(first.evidence.length, 50);
	assert.equal(first.nextAfter, 50);
	const maximum = f.store.get(idFor(1), { limit: 100 });
	assert.equal(maximum.events.length, 100);
	assert.equal(maximum.evidence.length, 100);
	assert.equal(maximum.nextAfter, 100);
	const last = f.store.get(idFor(1), { after: 100 });
	assert.deepEqual(last.events.map((event) => event.seq), [101]);
	assert.deepEqual(last.evidence.map((manifest) => manifest.seq), [101]);
	assert.equal(last.nextAfter, null);
	const walked = [];
	let after = 0;
	do {
		const page = f.store.get(idFor(1), { after });
		assert.ok(page.events.length <= 50);
		assert.deepEqual(page.evidence, page.events.map((event) => event.evidenceManifest));
		for (const manifest of page.evidence) {
			assert.equal(manifest.seq, walked.length + 1);
			const file = path.join(f.dataDir, "issues", "records", idFor(1), "evidence", manifest.captureId, "manifest.json");
			assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), manifest);
			walked.push(manifest.captureId);
		}
		after = page.nextAfter;
	} while (after !== null);
	assert.deepEqual(walked, Array.from({ length: 101 }, (_, i) => idFor((i + 1) * 2)));
	for (const after of [101, 200]) {
		const empty = f.store.get(idFor(1), { after });
		assert.deepEqual(empty.events, []);
		assert.deepEqual(empty.evidence, []);
		assert.equal(empty.nextAfter, null);
	}
	assert.throws(() => f.store.get(idFor(1), { limit: 101 }), code("bad_input", ["limit"]));
});

test("evidence pages follow event sequence across comments and correction evidence", async (t) => {
	const f = setup(t);
	await f.store.create(createBody(f.store.storeId), owner);
	await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(3), 1, { type: "comment", text: "No evidence" }), owner);
	const correction = capture(idFor(5));
	correction.visual.provenance = "reproduction";
	await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(4), 2, {
		type: "request_check", note: "Check this", correction: { kind: "inbox-build", buildId: owner.buildId, summary: "Correction" }, evidence: correction,
	}), maintainer);
	await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(6), 3, {
		type: "append_evidence", evidence: capture(idFor(7)), note: null,
	}), owner);
	f.restart();
	const first = f.store.get(idFor(1), { limit: 2 });
	assert.deepEqual(first.evidence.map((manifest) => manifest.seq), [1]);
	assert.equal(first.nextAfter, 2);
	const comment = f.store.get(idFor(1), { after: 1, limit: 1 });
	assert.deepEqual(comment.events.map((event) => event.seq), [2]);
	assert.deepEqual(comment.evidence, []);
	assert.equal(comment.nextAfter, 2);
	const rest = f.store.get(idFor(1), { after: first.nextAfter, limit: 2 });
	assert.deepEqual(rest.evidence.map((manifest) => manifest.seq), [3, 4]);
	assert.deepEqual(rest.evidence, rest.events.map((event) => event.evidenceManifest));
	assert.equal(rest.nextAfter, null);
});

test("raster rejection and capture collision never publish partial accepted state", async (t) => {
	const f = setup(t);
	const input = createBody(f.store.storeId);
	input.evidence.visual.pixels = Buffer.from([1, 2, 3, 0, 1, 2, 3, 255]).toString("base64");
	await assert.rejects(f.store.create(input, owner), code("bad_input"));
	assert.throws(() => f.store.get(idFor(1)), code("not_found"));
	assert.equal(f.store.list().items.length, 0);
	input.evidence = capture();
	await f.store.create(input, owner);
	const invalid = capture(idFor(4));
	invalid.visual.width = 3;
	await assert.rejects(f.store.command(idFor(1), commandBody(f.store.storeId, idFor(3), 1, { type: "append_evidence", evidence: invalid, note: null }), owner), code("bad_input"));
	assert.equal(f.store.get(idFor(1)).currentSeq, 1);
});

test("committed corruption is explicit and isolated; staging and orphan evidence stay invisible", async (t) => {
	for (const damage of ["created", "event", "missing-event", "missing-tail", "watermark", "image", "context", "manifest"]) {
		await t.test(damage, async (t) => {
			const f = setup(t);
			await f.store.create(createBody(f.store.storeId), owner);
			await f.store.create(createBody(f.store.storeId, idFor(9), capture(idFor(8))), owner);
			await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(3), 1, { type: "comment", text: "second" }), owner);
			await f.store.command(idFor(1), commandBody(f.store.storeId, idFor(4), 2, { type: "comment", text: "third" }), owner);
			const dir = path.join(f.dataDir, "issues", "records", idFor(1));
			const target = {
				created: "created.json", event: "events/000002.json", "missing-event": "events/000002.json",
				"missing-tail": "events/000003.json", watermark: "events/.committed.json",
				image: `evidence/${idFor(2)}/image.png`, context: `evidence/${idFor(2)}/context.json`, manifest: `evidence/${idFor(2)}/manifest.json`,
			}[damage];
			if (damage.startsWith("missing-")) fs.unlinkSync(path.join(dir, target));
			else fs.writeFileSync(path.join(dir, target), "corrupt");
			f.restart();
			assert.throws(() => f.store.get(idFor(1)), code("corrupt_record"));
			assert.throws(() => f.store.evidenceImage(idFor(1), idFor(2)), code("corrupt_record"));
			await assert.rejects(f.store.create(createBody(f.store.storeId), owner), code("corrupt_record"));
			assert.equal(f.store.get(idFor(9)).currentSeq, 1);
		});
	}
	const f = setup(t);
	await f.store.create(createBody(f.store.storeId), owner);
	fs.mkdirSync(path.join(f.dataDir, "issues", "records", `.tmp-${idFor(9)}-abandoned`));
	fs.mkdirSync(path.join(f.dataDir, "issues", "records", idFor(1), "evidence", idFor(50)));
	f.restart();
	assert.equal(f.store.list().items.length, 1);
	assert.equal(f.store.get(idFor(1)).evidence.length, 1);
	assert.throws(() => f.store.evidenceImage(idFor(1), idFor(50)), code("not_found"));
});

test("disk-full and rename failures leave no receipt and retry once without changing original evidence", async (t) => {
	for (const operation of ["create", "append"]) {
		for (const injection of ["write", "evidence-rename", "commit-rename"]) {
			await t.test(`${operation} ${injection}`, async (t) => {
				const f = setup(t);
				const first = createBody(f.store.storeId);
				if (operation === "append") await f.store.create(first, owner);
				const next = commandBody(f.store.storeId, idFor(3), 1, { type: "append_evidence", evidence: capture(idFor(4)), note: null });
				const run = () => operation === "create" ? f.store.create(first, owner) : f.store.command(idFor(1), next, owner);
				const original = filesUnder(path.join(f.dataDir, "issues", "records", idFor(1), "evidence"));
				const method = injection === "write" ? "writeFileSync" : "renameSync";
				const real = fs[method];
				let injected = false;
				const mocked = t.mock.method(fs, method, function(...args) {
					const file = String(args[injection === "write" ? 0 : 1]).replaceAll("\\", "/");
					const selected = injection === "write" ? file.endsWith("image.png")
						: injection === "evidence-rename" && operation === "append" ? /\/evidence\/[0-9a-f-]+$/.test(file)
							: operation === "create" ? /\/records\/[0-9a-f-]+$/.test(file) : /\/events\/\d+\.json$/.test(file);
					if (selected && !injected) {
						injected = true;
						throw Object.assign(new Error("injected storage failure"), { code: injection === "write" ? "ENOSPC" : "EIO" });
					}
					return real.apply(this, args);
				});
				await assert.rejects(run(), { code: injection === "write" ? "ENOSPC" : "EIO" });
				mocked.mock.restore();
				assert.equal(injected, true);
				f.restart();
				if (operation === "create") assert.throws(() => f.store.get(idFor(1)), code("not_found"));
				else {
					assert.equal(f.store.get(idFor(1)).currentSeq, 1);
					assert.equal(f.store.get(idFor(1)).evidence.length, 1);
					for (const [file, hash] of Object.entries(original)) assert.equal(filesUnder(path.join(f.dataDir, "issues", "records", idFor(1), "evidence"))[file], hash);
				}
				assert.equal((await run()).replayed, false);
				assert.equal((await run()).replayed, true);
				assert.equal(f.store.get(idFor(1)).currentSeq, operation === "create" ? 1 : 2);
			});
		}
	}
});

test("purge is terminal for every prior key and retries pending physical deletion on startup", async (t) => {
	const f = setup(t);
	const input = createBody(f.store.storeId);
	await f.store.create(input, owner);
	const comment = commandBody(f.store.storeId, idFor(3), 1, { type: "comment", text: "private comment" });
	await f.store.command(idFor(1), comment, owner);
	const purge = commandBody(f.store.storeId, idFor(4), 2, { type: "purge" });
	const recordDir = path.join(f.dataDir, "issues", "records", idFor(1));
	const abandoned = path.join(f.dataDir, "issues", "records", `.tmp-${idFor(1)}-terminated-create`);
	fs.mkdirSync(abandoned);
	fs.writeFileSync(path.join(abandoned, "context.json"), "private unpublished context");
	const real = fs.rmSync;
	const mocked = t.mock.method(fs, "rmSync", function(file, ...args) {
		if (String(file) === recordDir) throw Object.assign(new Error("locked file"), { code: "EPERM" });
		return real.call(this, file, ...args);
	});
	await assert.rejects(f.store.command(idFor(1), purge, owner), { code: "EPERM" });
	mocked.mock.restore();
	const tombstone = path.join(f.dataDir, "issues", "tombstones", `${idFor(1)}.json`);
	const marker = JSON.parse(fs.readFileSync(tombstone, "utf8"));
	assert.equal(marker.deletion_pending, true);
	assert.equal(marker.event.seq, 3);
	assert.ok(!JSON.stringify(marker).includes("private comment"));
	assert.ok(!JSON.stringify(marker).includes(input.description));
	assert.ok(!JSON.stringify(marker).includes("context"));
	assert.throws(() => f.store.get(idFor(1)), code("gone"));
	assert.throws(() => f.store.evidenceImage(idFor(1), idFor(2)), code("gone"));
	assert.equal(f.store.list().items.length, 0);
	await assert.rejects(f.store.create(input, owner), code("gone"));
	for (const body of [comment, purge]) await assert.rejects(f.store.command(idFor(1), body, owner), code("gone"));
	f.restart();
	assert.equal(fs.existsSync(recordDir), false);
	assert.equal(fs.existsSync(abandoned), false);
	assert.equal(JSON.parse(fs.readFileSync(tombstone, "utf8")).deletion_pending, false);
	await assert.rejects(f.store.create(input, owner), code("gone"));
	await assert.rejects(f.store.command(idFor(1), comment, owner), code("gone"));
});

test("real child termination at staging, publish, event and response barriers recovers exactly once", async (t) => {
	for (const operation of ["create", "append"]) {
		const points = operation === "create" ? ["after_evidence_staging", "after_record_rename", "before_response"]
			: ["after_evidence_staging", "after_evidence_publish", "after_event_rename", "before_response"];
		for (const point of points) {
			await t.test(`${operation} ${point}`, async (t) => {
				const f = setup(t);
				const first = createBody(f.store.storeId);
				if (operation === "append") await f.store.create(first, owner);
				const body = operation === "create" ? first
					: commandBody(f.store.storeId, idFor(3), 1, { type: "append_evidence", evidence: capture(idFor(4)), note: null });
				f.store.close();
				const transcript = await terminateAtBarrier({
					dataDir: f.dataDir, body, id: operation === "append" ? idFor(1) : undefined, point,
					onBarrier: () => assert.throws(() => createIssuesStore({ dataDir: f.dataDir }), code("locked")),
				});
				assert.equal(transcript.point, point);
				assert.ok(transcript.signal || transcript.code !== 0);
				t.diagnostic(JSON.stringify(transcript));
				f.restart();
				const committed = ["after_record_rename", "after_event_rename", "before_response"].includes(point);
				if (operation === "create" && !committed) assert.throws(() => f.store.get(idFor(1)), code("not_found"));
				else assert.equal(f.store.get(idFor(1)).currentSeq, operation === "create" ? 1 : committed ? 2 : 1);
				const replay = operation === "create" ? await f.store.create(body, owner) : await f.store.command(idFor(1), body, owner);
				assert.equal(replay.replayed, committed);
				assert.equal(replay.body.receipt.seq, operation === "create" ? 1 : 2);
				const all = f.store.get(idFor(1));
				assert.equal(all.events.length, all.currentSeq);
				assert.equal(all.evidence.length, operation === "create" ? 1 : 2);
				for (const manifest of all.evidence) assert.equal(f.store.evidenceImage(idFor(1), manifest.captureId).sha256, manifest.visual.sha256);
			});
		}
	}
});
