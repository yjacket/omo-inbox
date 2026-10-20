import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createStore } from "../src/store.mjs";
import { safeSegment } from "../src/paths.mjs";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([SIG, Buffer.from([0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1])]);
const DATA_URL = "data:image/png;base64," + PNG.toString("base64");
const PRODUCT = { key: "github.com/acme/app", name: "App", remote: null };
const FEATURE_KEY = "github.com/acme/app#main";
const QUESTIONS = [{ id: "q1", text: "Q1", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }];

function clock() {
	const base = new Date(2026, 9, 4, 12, 0, 0).getTime();
	let step = 0;
	return () => new Date(base + step++ * 60_000);
}

function ident(worktree, sessionId = "s1") {
	return { product: PRODUCT, feature: { key: FEATURE_KEY, branch: "main", worktree }, session: { id: sessionId, file: null }, cwd: worktree };
}

function makeBoardDir(root, { title = "Board", frames = ["f1"], questions } = {}) {
	const dir = fs.mkdtempSync(path.join(root, "board-"));
	const cards = [{ frames: frames.map((label) => [label, `frames/${label}.png`]) }];
	const board = { title, sections: [{ title: "S", cards }] };
	if (questions !== undefined) board.questions = questions;
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(board));
	fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
	for (const label of frames) fs.writeFileSync(path.join(dir, "frames", `${label}.png`), Buffer.from([1, 2, 3, 4]));
	return dir;
}

function filesFor(frames = ["f1"]) {
	return ["board.json", ...frames.map((label) => `frames/${label}.png`)];
}

function setup(options = {}) {
	const { home, cleanup } = makeTmpHome();
	const dataDir = path.join(home, "data");
	const inboxDir = path.join(home, "mailbox");
	const store = createStore({ dataDir, inboxDir, now: clock(), ...options });
	return { home, cleanup, dataDir, inboxDir, store };
}

function codeOf(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return null;
}

function sha256Text(text) {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function hashFile(file) {
	return sha256Text(fs.readFileSync(file));
}

test("feedback validation rejects bad input with the right codes and accepts an empty approve", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		const good = { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] };
		assert.equal(store.feedback(id, good).summary.status, "theirs");

		assert.equal(codeOf(() => store.feedback(id, { ...good, rev: 2 })).code, "bad_rev");
		assert.equal(codeOf(() => store.feedback(id, { ...good, marks: [{ frame: "nope", x: 0, y: 0, w: 0.1, h: 0.1 }] })).code, "bad_input");
		assert.equal(codeOf(() => store.feedback(id, { ...good, answers: { zz: "a" } })).code, "bad_input");
		assert.equal(codeOf(() => store.feedback(id, { ...good, answers: { q1: "c" } })).code, "bad_input");
		assert.equal(codeOf(() => store.feedback(id, { ...good, marks: [{ frame: "f1", x: -0.01, y: 0, w: 0.1, h: 0.1 }] })).code, "bad_input");
		assert.equal(codeOf(() => store.feedback(id, { ...good, marks: [{ frame: "f1", x: 0.95, y: 0, w: 0.1, h: 0.1 }] })).code, "bad_input");
		assert.equal(codeOf(() => store.feedback(id, { ...good, marks: [{ frame: "f1", x: 0, y: 0, w: 0, h: 0.1 }] })).code, "bad_input");
		const fiftyOne = Array.from({ length: 51 }, () => ({ frame: "f1", x: 0, y: 0, w: 0.1, h: 0.1 }));
		assert.equal(codeOf(() => store.feedback(id, { ...good, marks: fiftyOne })).code, "bad_input");
		assert.equal(codeOf(() => store.feedback(id, { ...good, marks: [{ frame: "f1", x: 0, y: 0, w: 0.1, h: 0.1, crop: "data:image/png;base64,aGVsbG8=" }] })).code, "bad_input");

		const empty = codeOf(() => store.feedback(id, { rev: 1, verdict: "change", answers: {}, comment: "", marks: [] }));
		assert.equal(empty.code, "bad_input");
		assert.equal(empty.message, "empty");

		const approved = store.feedback(id, { rev: 1, verdict: "approve", answers: {}, comment: "", marks: [] });
		assert.equal(approved.summary.status, "theirs");
		assert.equal(approved.summary.approved, true);
	} finally {
		cleanup();
	}
});

test("approved is true only when the last non-reply event is an approving feedback", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;

		store.feedback(id, { rev: 1, verdict: "approve", answers: {}, comment: "", marks: [] });
		assert.equal(store.get(id).summary.approved, true);

		store.reply(id, { text: "thanks", session: { id: "s2", file: null } });
		const afterReply = store.get(id).summary;
		assert.equal(afterReply.lastType, "reply");
		assert.equal(afterReply.approved, true);

		store.feedback(id, { rev: 1, verdict: "approve", answers: {}, comment: "", marks: [] });
		assert.equal(store.get(id).summary.approved, true);

		store.revise(id, { srcDir: src, files: filesFor(), note: "v2", session: { id: "s3", file: null } });
		const afterRevise = store.get(id).summary;
		assert.equal(afterRevise.lastType, "revised");
		assert.equal(afterRevise.rev, 2);
		assert.equal(afterRevise.approved, false);

		store.feedback(id, { rev: 2, verdict: "approve", answers: {}, comment: "", marks: [] });
		assert.equal(store.get(id).summary.approved, true);
	} finally {
		cleanup();
	}
});

test("feedback targets an older revision after a newer one exists", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		store.revise(id, { srcDir: src, files: filesFor(), session: { id: "s1", file: null } });
		const result = store.feedback(id, { rev: 1, verdict: "change", comment: "old rev", answers: {}, marks: [] });
		assert.equal(result.event.rev, 1);
		assert.equal(result.summary.rev, 2);
		assert.equal(store.get(id).events.find((event) => event.type === "feedback").rev, 1);
	} finally {
		cleanup();
	}
});

test("routed, delivery and writeInbox", () => {
	const { home, cleanup, inboxDir, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		const result = store.feedback(id, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [], via: "local", client: "100.0.0.1", ua: "UA" });
		assert.equal(result.event.routed, "s1");
		assert.equal(result.owner, "s1");
		assert.equal(result.event.client, "100.0.0.1");
		assert.equal(result.event.ua, "UA");
		assert.equal(store.get(id).events.find((event) => event.type === "feedback").delivery, "delivered");

		const payload = { v: 1, proposalId: id, seq: result.event.seq, title: "B", url: "http://x/p/" + id, approved: false, text: "hi" };
		const file = store.writeInbox("s1", payload);
		assert.equal(file, path.join(inboxDir, safeSegment("s1"), `${id}-000002.json`));
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), payload);
		assert.equal(store.get(id).events.find((event) => event.type === "feedback").delivery, "pending");
		fs.rmSync(file);
		assert.equal(store.get(id).events.find((event) => event.type === "feedback").delivery, "delivered");

		const id2 = store.create({ identity: ident(home, null), title: "NoSession", srcDir: src, files: filesFor() }).summary.id;
		const routedNull = store.feedback(id2, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] });
		assert.equal(routedNull.event.routed, null);
		assert.equal(store.get(id2).events.find((event) => event.type === "feedback").delivery, "none");
	} finally {
		cleanup();
	}
});

test("crops decode to files named by sequence and mark number", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		const result = store.feedback(id, {
			rev: 1,
			verdict: "change",
			answers: {},
			comment: "x",
			marks: [
				{ frame: "f1", x: 0, y: 0, w: 0.5, h: 0.5, comment: "m1", crop: DATA_URL },
				{ frame: "f1", x: 0.5, y: 0.5, w: 0.5, h: 0.5, comment: "m2" },
			],
		});
		assert.equal(result.event.marks[0].n, 1);
		assert.equal(result.event.marks[0].crop, "crops/000002-1.png");
		assert.equal(result.event.marks[1].crop, null);
		const file = path.join(home, "data", "proposals", id, "crops", "000002-1.png");
		assert.ok(fs.existsSync(file));
		assert.ok(fs.readFileSync(file).subarray(0, 8).equals(SIG));
	} finally {
		cleanup();
	}
});

test("lifecycle statuses, owner movement and the closed guard", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		let summary = store.get(id).summary;
		assert.equal(summary.status, "mine");
		assert.equal(summary.lastType, "submitted");
		assert.equal(summary.owner, "s1");
		assert.equal(summary.rev, 1);

		store.feedback(id, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] });
		summary = store.get(id).summary;
		assert.equal(summary.status, "theirs");
		assert.equal(summary.approved, false);
		assert.equal(summary.lastType, "feedback");

		store.reply(id, { text: "ok", session: { id: "s2", file: null } });
		summary = store.get(id).summary;
		assert.equal(summary.status, "theirs");
		assert.equal(summary.lastType, "reply");
		assert.equal(summary.owner, "s2");

		store.revise(id, { srcDir: src, files: filesFor(), note: "v2", session: { id: "s3", file: null } });
		summary = store.get(id).summary;
		assert.equal(summary.status, "mine");
		assert.equal(summary.rev, 2);
		assert.equal(summary.lastType, "revised");
		assert.equal(summary.owner, "s3");

		store.feedback(id, { rev: 2, verdict: "approve", answers: {}, comment: "", marks: [] });
		summary = store.get(id).summary;
		assert.equal(summary.status, "theirs");
		assert.equal(summary.approved, true);

		const closed = store.close(id, { summary: "done", by: "session", session: { id: "s3", file: null } });
		assert.equal(closed.status, "closed");
		assert.equal(closed.outcome, "done");
		assert.equal(closed.lastType, "closed");

		assert.equal(codeOf(() => store.feedback(id, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] })).code, "closed");
		assert.equal(codeOf(() => store.reply(id, { text: "x", session: null })).code, "closed");
		assert.equal(codeOf(() => store.revise(id, { srcDir: src, files: filesFor(), session: null })).code, "closed");
		assert.equal(codeOf(() => store.close(id, { summary: "again", by: "me", session: null })).code, "closed");
	} finally {
		cleanup();
	}
});

test("a reply never changes the status", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const create = (title) => store.create({ identity: ident(home), title, srcDir: makeBoardDir(home, { questions: QUESTIONS }), files: filesFor() }).summary.id;

		const changedId = create("changed");
		store.feedback(changedId, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] });
		store.reply(changedId, { text: "ok", session: { id: "s2", file: null } });
		assert.equal(store.get(changedId).summary.status, "theirs");
		assert.equal(store.get(changedId).summary.approved, false);

		const approvedId = create("approved");
		store.feedback(approvedId, { rev: 1, verdict: "approve", answers: {}, comment: "", marks: [] });
		store.reply(approvedId, { text: "ok", session: { id: "s2", file: null } });
		assert.equal(store.get(approvedId).summary.status, "theirs");
		assert.equal(store.get(approvedId).summary.approved, true);

		const submittedId = create("submitted");
		store.reply(submittedId, { text: "ok", session: { id: "s2", file: null } });
		assert.equal(store.get(submittedId).summary.status, "mine");

		const revisedId = create("revised");
		assert.equal(new Set([changedId, approvedId, submittedId, revisedId]).size, 4);
		store.feedback(revisedId, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] });
		store.reply(revisedId, { text: "ok", session: { id: "s2", file: null } });
		store.revise(revisedId, { srcDir: src, files: filesFor(), note: "v2", session: { id: "s3", file: null } });
		assert.equal(store.get(revisedId).summary.status, "mine");
	} finally {
		cleanup();
	}
});

test("submitted and revised events carry the content hash and revisions stay immutable", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { frames: ["f1", "f2"], questions: QUESTIONS });
		const files = filesFor(["f1", "f2"]);
		const expected = sha256Text(files.map((rel) => `${rel}\n${hashFile(path.join(src, rel))}\n`).sort().join(""));
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files }).summary.id;
		assert.equal(store.get(id).events[0].hash, expected);

		fs.writeFileSync(path.join(src, "frames", "f1.png"), Buffer.from([9, 9, 9]));
		fs.rmSync(path.join(src, "frames", "f2.png"));
		const revDir = path.join(home, "data", "proposals", id, "revs", "1");
		assert.deepEqual([...fs.readFileSync(path.join(revDir, "frames", "f1.png"))], [1, 2, 3, 4]);
		assert.ok(fs.existsSync(path.join(revDir, "frames", "f2.png")));
		assert.ok(store.board(id, 1).sections[0].cards[0].frames.some((frame) => frame[0] === "f2"));

		store.revise(id, { srcDir: src, files: ["board.json"], note: "n", session: { id: "s1", file: null } });
		const revised = store.get(id).events.find((event) => event.type === "revised");
		assert.equal(revised.hash, sha256Text(`board.json\n${hashFile(path.join(src, "board.json"))}\n`));
	} finally {
		cleanup();
	}
});

test("id collisions regenerate the suffix", () => {
	const bytes = [Buffer.from([0, 0, 0, 0]), Buffer.from([0, 0, 0, 0]), Buffer.from([1, 2, 3, 4])];
	let call = 0;
	const rand = () => bytes[Math.min(call++, bytes.length - 1)];
	const { home, cleanup, store } = setup({ rand });
	try {
		const src = makeBoardDir(home);
		const first = store.create({ identity: ident(home), title: "A", srcDir: src, files: filesFor() }).summary.id;
		const second = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor(), force: true }).summary.id;
		assert.notEqual(first, second);
		assert.match(first, /^\d{6}-[a-z0-9]{4}$/);
		assert.match(second, /^\d{6}-[a-z0-9]{4}$/);
	} finally {
		cleanup();
	}
});

test("idempotent submit, duplicate rejection and force", () => {
	const { home, cleanup, dataDir, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const first = store.create({ identity: ident(home), title: "T", srcDir: src, files: filesFor() });
		assert.equal(first.existing, false);
		const again = store.create({ identity: ident(home), title: "T", srcDir: src, files: filesFor() });
		assert.equal(again.existing, true);
		assert.equal(again.summary.id, first.summary.id);
		assert.equal(fs.readdirSync(path.join(dataDir, "proposals")).length, 1);

		fs.writeFileSync(path.join(src, "frames", "f1.png"), Buffer.from([7, 7, 7, 7]));
		const duplicate = codeOf(() => store.create({ identity: ident(home), title: "T", srcDir: src, files: filesFor() }));
		assert.equal(duplicate.code, "duplicate");
		assert.equal(duplicate.id, first.summary.id);

		const forced = store.create({ identity: ident(home), title: "T", srcDir: src, files: filesFor(), force: true });
		assert.equal(forced.existing, false);
		assert.notEqual(forced.summary.id, first.summary.id);
		assert.equal(fs.readdirSync(path.join(dataDir, "proposals")).length, 2);
	} finally {
		cleanup();
	}
});

test("list filters and sort order", () => {
	const { home, cleanup, store } = setup();
	try {
		const srcA = makeBoardDir(home);
		const srcB = makeBoardDir(home);
		const p1 = store.create({ identity: ident(home), title: "P1", srcDir: srcA, files: filesFor() }).summary;
		const p2 = store.create({ identity: ident(home), title: "P2", srcDir: srcA, files: filesFor() }).summary;
		store.feedback(p2.id, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] });
		const p3 = store.create({ identity: ident(home), title: "P3", srcDir: srcB, files: filesFor() }).summary;
		store.close(p3.id, { summary: "done", by: "me", session: { id: "s1", file: null } });

		assert.deepEqual(store.list().map((summary) => summary.id), [p1.id, p2.id]);
		assert.deepEqual(store.list({ status: "mine" }).map((summary) => summary.id), [p1.id]);
		assert.deepEqual(store.list({ status: "theirs" }).map((summary) => summary.id), [p2.id]);
		assert.deepEqual(store.list({ status: "closed" }).map((summary) => summary.id), [p3.id]);
		assert.deepEqual(store.list({ status: "all" }).map((summary) => summary.id).sort(), [p1.id, p2.id, p3.id].sort());
		assert.deepEqual(store.list({ product: PRODUCT.key }).map((summary) => summary.id).sort(), [p1.id, p2.id].sort());
		assert.deepEqual(store.list({ product: "app" }).map((summary) => summary.id).sort(), [p1.id, p2.id].sort());
		assert.deepEqual(store.list({ feature: "main" }).map((summary) => summary.id).sort(), [p1.id, p2.id].sort());
		assert.deepEqual(store.list({ feature: FEATURE_KEY }).map((summary) => summary.id).sort(), [p1.id, p2.id].sort());
		assert.deepEqual(store.list({ status: "all" }).map((summary) => summary.id), [p3.id, p2.id, p1.id]);
	} finally {
		cleanup();
	}
});

test("facets counts and a rebuilt store sees the same list", () => {
	const { home, cleanup, dataDir, inboxDir, store } = setup();
	try {
		const srcA = makeBoardDir(home);
		const srcB = makeBoardDir(home);
		store.create({ identity: ident(home), title: "P1", srcDir: srcA, files: filesFor() });
		const p2 = store.create({ identity: ident(home), title: "P2", srcDir: srcA, files: filesFor() }).summary;
		store.feedback(p2.id, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] });
		const other = { product: { key: "github.com/acme/other", name: "Other", remote: null }, feature: { key: "github.com/acme/other#dev", branch: "dev", worktree: home }, session: { id: "s1", file: null }, cwd: home };
		const p3 = store.create({ identity: other, title: "P3", srcDir: srcB, files: filesFor() }).summary;
		store.close(p3.id, { summary: "done", by: "me", session: { id: "s1", file: null } });

		const facets = store.facets();
		const app = facets.find((facet) => facet.key === PRODUCT.key);
		assert.equal(app.count, 2);
		assert.equal(app.open, 2);
		assert.equal(app.features.length, 1);
		assert.equal(app.features[0].key, FEATURE_KEY);
		assert.equal(app.features[0].count, 2);
		assert.equal(app.features[0].open, 2);
		const otherFacet = facets.find((facet) => facet.key === "github.com/acme/other");
		assert.equal(otherFacet.count, 1);
		assert.equal(otherFacet.open, 0);

		const rebuilt = createStore({ dataDir, inboxDir, now: clock() });
		assert.deepEqual(rebuilt.list({ status: "all" }).map((summary) => summary.id), store.list({ status: "all" }).map((summary) => summary.id));
		assert.equal(rebuilt.list({ status: "all" }).length, 3);
	} finally {
		cleanup();
	}
});

test("20 concurrent feedback calls get unique sequential seqs", async () => {
	const { home, cleanup, dataDir, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) => store.feedback(id, { rev: 1, verdict: "change", comment: `c${index}`, answers: {}, marks: [] })),
		);
		assert.deepEqual(results.map((result) => result.event.seq).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 2));
		const dir = path.join(dataDir, "proposals", id, "events");
		const names = fs.readdirSync(dir);
		assert.equal(names.length, 21);
		for (const name of names) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
		assert.equal(store.get(id).events.length, 21);
	} finally {
		cleanup();
	}
});

test("rebuild ignores proposal dirs without proposal.json and tmp revision dirs", () => {
	const { home, cleanup, dataDir, inboxDir, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		fs.mkdirSync(path.join(dataDir, "proposals", "no-proposal"), { recursive: true });
		fs.mkdirSync(path.join(dataDir, "proposals", id, "revs", "2.tmp-abc"), { recursive: true });
		const rebuilt = createStore({ dataDir, inboxDir, now: clock() });
		assert.deepEqual(rebuilt.list({ status: "all" }).map((summary) => summary.id), [id]);
		assert.equal(rebuilt.get(id).summary.rev, 1);
		assert.equal(codeOf(() => rebuilt.board(id, 2)).code, "bad_rev");
	} finally {
		cleanup();
	}
});

test("get returns only events after since", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const id = store.create({ identity: ident(home), title: "B", srcDir: src, files: filesFor() }).summary.id;
		store.feedback(id, { rev: 1, verdict: "change", comment: "one", answers: {}, marks: [] });
		store.reply(id, { text: "two", session: { id: "s1", file: null } });
		const all = store.get(id);
		assert.deepEqual(all.events.map((event) => event.seq), [1, 2, 3]);
		assert.deepEqual(all.revs.map((rev) => rev.n), [1]);
		assert.equal(all.proposal.v, 1);
		assert.deepEqual(store.get(id, { since: 2 }).events.map((event) => event.seq), [3]);
	} finally {
		cleanup();
	}
});

test("report kind: create persists kind and summaries default to decision", () => {
	const { home, cleanup, dataDir, store } = setup();
	try {
		const src = makeBoardDir(home);
		const report = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" });
		assert.equal(report.summary.kind, "report");
		assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "proposals", report.summary.id, "proposal.json"), "utf8")).kind, "report");

		const decision = store.create({ identity: ident(home), title: "D", srcDir: src, files: filesFor() });
		assert.equal(decision.summary.kind, "decision");
		const proposal = JSON.parse(fs.readFileSync(path.join(dataDir, "proposals", decision.summary.id, "proposal.json"), "utf8"));
		assert.equal(proposal.kind, "decision");
		assert.equal(proposal.v, 1);
		assert.equal(store.list({ status: "all" }).find((item) => item.id === report.summary.id).kind, "report");
	} finally {
		cleanup();
	}
});

test("report kind: a legacy proposal without kind reads as decision", () => {
	const { home, cleanup, dataDir, inboxDir } = setup();
	try {
		const id = "260101-aaaa";
		const dir = path.join(dataDir, "proposals", id);
		fs.mkdirSync(path.join(dir, "events"), { recursive: true });
		fs.writeFileSync(path.join(dir, "proposal.json"), JSON.stringify({
			v: 1,
			id,
			title: "Legacy",
			created: "2026-01-01T00:00:00.000Z",
			product: PRODUCT,
			feature: { key: FEATURE_KEY, branch: "main", worktree: home },
			session: null,
		}));
		const rebuilt = createStore({ dataDir, inboxDir, now: clock() });
		assert.equal(rebuilt.get(id).summary.kind, "decision");
		assert.equal(rebuilt.list({ status: "all" })[0].kind, "decision");
	} finally {
		cleanup();
	}
});

test("report kind: ack with a comment routes to the owner and writes one inbox file", () => {
	const { home, cleanup, inboxDir, store } = setup();
	try {
		const src = makeBoardDir(home);
		const id = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" }).summary.id;
		const result = store.feedback(id, { rev: 1, verdict: "ack", comment: "확인했습니다", answers: {}, marks: [] });
		assert.equal(result.summary.status, "theirs");
		assert.equal(result.summary.lastType, "feedback");
		assert.equal(result.event.routed, "s1");
		assert.equal(result.owner, "s1");
		assert.equal(store.get(id).events.some((event) => event.type === "closed"), false);

		const payload = { v: 1, proposalId: id, seq: result.event.seq, title: "R", url: "http://x/p/" + id, approved: false, text: "확인했습니다" };
		store.writeInbox(result.event.routed, payload);
		assert.equal(fs.readdirSync(path.join(inboxDir, safeSegment("s1"))).length, 1);
		assert.equal(store.get(id).events.find((event) => event.type === "feedback").delivery, "pending");
	} finally {
		cleanup();
	}
});

test("report kind: ack without comment or marks closes by user with delivery none", () => {
	const { home, cleanup, dataDir, inboxDir, store } = setup();
	try {
		const src = makeBoardDir(home);
		const id = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" }).summary.id;
		const result = store.feedback(id, { rev: 1, verdict: "ack", answers: {}, marks: [] });
		assert.equal(result.summary.status, "closed");
		assert.equal(result.summary.lastType, "closed");
		assert.equal(result.summary.outcome, null);
		assert.equal(result.event.routed, "s1");

		const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "proposals", id, "events", "000002-feedback.json"), "utf8"));
		assert.equal(stored.delivery, "none");
		assert.equal(store.get(id).events.find((event) => event.type === "feedback").delivery, "none");
		const closed = store.get(id).events.find((event) => event.type === "closed");
		assert.equal(closed.by, "user");
		assert.equal(closed.summary, null);
		assert.equal(fs.existsSync(path.join(inboxDir, safeSegment("s1"))), false);
	} finally {
		cleanup();
	}
});

test("report kind: ack with marks only routes like a comment", () => {
	const { home, cleanup, inboxDir, store } = setup();
	try {
		const src = makeBoardDir(home);
		const id = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" }).summary.id;
		const result = store.feedback(id, { rev: 1, verdict: "ack", answers: {}, marks: [{ frame: "f1", x: 0, y: 0, w: 0.5, h: 0.5 }] });
		assert.equal(result.summary.status, "theirs");
		assert.equal(store.get(id).events.some((event) => event.type === "closed"), false);
		store.writeInbox(result.event.routed, { v: 1, proposalId: id, seq: result.event.seq, title: "R", url: "u", approved: false, text: "" });
		assert.equal(fs.readdirSync(path.join(inboxDir, safeSegment("s1"))).length, 1);
	} finally {
		cleanup();
	}
});

test("report kind: wrong verdicts per board kind are bad_input verdict", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const report = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" }).summary.id;
		assert.equal(codeOf(() => store.feedback(report, { rev: 1, verdict: "approve", answers: {}, comment: "", marks: [] })).message, "verdict");
		assert.equal(codeOf(() => store.feedback(report, { rev: 1, verdict: "change", comment: "x", answers: {}, marks: [] })).code, "bad_input");

		const decision = store.create({ identity: ident(home), title: "D", srcDir: src, files: filesFor() }).summary.id;
		assert.equal(codeOf(() => store.feedback(decision, { rev: 1, verdict: "ack", answers: {}, marks: [] })).message, "verdict");
		assert.equal(codeOf(() => store.feedback(decision, { rev: 1, verdict: "ack", comment: "x", answers: {}, marks: [] })).code, "bad_input");
	} finally {
		cleanup();
	}
});

test("report kind: ack with answers is bad_input answers", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home);
		const id = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" }).summary.id;
		const error = codeOf(() => store.feedback(id, { rev: 1, verdict: "ack", comment: "x", answers: { q1: "a" }, marks: [] }));
		assert.equal(error.code, "bad_input");
		assert.equal(error.message, "answers");
	} finally {
		cleanup();
	}
});

test("report kind: revise keeps the kind and rejects a mismatched board", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home);
		const id = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" }).summary.id;
		const mismatched = codeOf(() => store.revise(id, { srcDir: src, files: filesFor(), note: "v2", session: { id: "s1", file: null } }));
		assert.equal(mismatched.code, "bad_input");
		assert.equal(mismatched.message, "kind");
		assert.equal(store.get(id).summary.rev, 1);
		assert.equal(fs.existsSync(path.join(home, "data", "proposals", id, "revs", "2")), false);

		const revised = store.revise(id, { srcDir: src, files: filesFor(), note: "v2", session: { id: "s1", file: null }, kind: "report" });
		assert.equal(revised.rev, 2);
		assert.equal(revised.kind, "report");

		const decision = store.create({ identity: ident(home), title: "D", srcDir: src, files: filesFor() }).summary.id;
		assert.equal(codeOf(() => store.revise(decision, { srcDir: src, files: filesFor(), note: "v2", session: null, kind: "report" })).message, "kind");
	} finally {
		cleanup();
	}
});

test("report kind: feedback after a comment-less ack is closed", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home);
		const id = store.create({ identity: ident(home), title: "R", srcDir: src, files: filesFor(), kind: "report" }).summary.id;
		store.feedback(id, { rev: 1, verdict: "ack", answers: {}, marks: [] });
		assert.equal(codeOf(() => store.feedback(id, { rev: 1, verdict: "ack", comment: "late", answers: {}, marks: [] })).code, "closed");
	} finally {
		cleanup();
	}
});

test("forWorktree scopes by worktree and adopts deleted worktrees", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const wtA = fs.mkdtempSync(path.join(home, "wtA-"));
		const wtB = fs.mkdtempSync(path.join(home, "wtB-"));
		const wtC = fs.mkdtempSync(path.join(home, "wtC-"));
		store.create({ identity: ident(wtA), title: "A", srcDir: src, files: filesFor() });
		store.create({ identity: ident(wtB), title: "B", srcDir: src, files: filesFor() });

		assert.deepEqual(store.forWorktree({ worktree: wtA, featureKey: FEATURE_KEY }), { mine: 1, theirs: 0, pending: [] });
		assert.equal(store.forWorktree({ worktree: wtB, featureKey: FEATURE_KEY }).mine, 1);

		fs.rmSync(wtB, { recursive: true, force: true });
		assert.equal(store.forWorktree({ worktree: wtA, featureKey: FEATURE_KEY }).mine, 2);

		const other = { product: PRODUCT, feature: { key: "github.com/acme/app#other", branch: "other", worktree: wtC }, session: { id: "s1", file: null }, cwd: wtC };
		const wc = store.create({ identity: other, title: "C", srcDir: src, files: filesFor() }).summary;
		// C matches by worktree and the orphaned B follows the same feature key here too.
		assert.equal(store.forWorktree({ worktree: wtC, featureKey: FEATURE_KEY }).mine, 2);
		store.close(wc.id, { summary: "done", by: "me", session: { id: "s1", file: null } });
		assert.equal(store.forWorktree({ worktree: wtC, featureKey: FEATURE_KEY }).mine, 1);
	} finally {
		cleanup();
	}
});

test("waitingFor returns owned decisions with pending feedback and event timestamps", () => {
	const { home, cleanup, store } = setup();
	try {
		const src = makeBoardDir(home, { questions: QUESTIONS });
		const mine = store.create({ identity: ident(home, "sA"), title: "Mine", srcDir: src, files: filesFor() }).summary;
		const theirs = store.create({ identity: ident(home, "sA"), title: "Theirs", srcDir: src, files: filesFor(), force: true }).summary;
		const report = store.create({ identity: ident(home, "sA"), title: "Report", srcDir: src, files: filesFor(), force: true, kind: "report" }).summary;
		store.reply(mine.id, { text: "reply", session: { id: "sA" } });
		const feedback = store.feedback(theirs.id, { rev: 1, verdict: "change", comment: "revise" });
		store.writeInbox("sA", { proposalId: theirs.id, seq: feedback.event.seq });
		const waiting = store.waitingFor("sA");
		assert.deepEqual(waiting.map((item) => item.id), [mine.id, theirs.id]);
		assert.equal(waiting[0].since, store.get(mine.id).events[0].at);
		assert.equal(waiting[0].seq, null);
		assert.equal(waiting[1].status, "theirs");
		assert.equal(waiting[1].seq, 2);
		assert.deepEqual(store.waitingFor(""), []);
		assert.deepEqual(store.waitingFor("sB"), []);

		fs.rmSync(path.join(home, "mailbox", safeSegment("sA"), `${theirs.id}-000002.json`));
		assert.deepEqual(store.waitingFor("sA").map((item) => item.id), [mine.id]);
		store.close(report.id, { summary: "done" });
	} finally {
		cleanup();
	}
});
