import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	createReopener,
	listOrcaWorktrees,
	pathExists,
	planReopen,
	runAttempts,
	safePath,
	safeTitle,
	sessionTarget,
} from "../src/reopen.mjs";

function fakeSpawn(plan) {
	const calls = [];
	const impl = (cmd, args, options) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => { child.killed = true; };
		calls.push({ cmd, args, options, child });
		plan(child, calls.length);
		return child;
	};
	return { calls, impl };
}

function timers() {
	const callbacks = [];
	return { callbacks, setTimer(callback) { callbacks.push(callback); return callbacks.length; }, clearTimer() {} };
}

test("safe title and paths reject terminal syntax and normalize", () => {
	assert.equal(safeTitle('한글 ;"&'), "한글");
	assert.equal(safeTitle(""), "omo");
	assert.equal(safeTitle("a".repeat(45)), "a".repeat(40));
	for (const bad of ['C:/a"b', "C:/a;b", "C:/a%b", "relative", "//server/share"]) assert.equal(safePath(bad, "win32"), null);
	assert.equal(safePath("C:\\Users\\x\\", "win32"), "C:/Users/x");
	assert.equal(safePath("C:/", "win32"), "C:/");
});

test("session target prefers existing JSONL then validates sid", () => {
	assert.equal(sessionTarget({ sid: "valid-sid1", sessionFile: "C:/x/session.JSONL", exists: () => true }), "C:/x/session.JSONL");
	assert.equal(sessionTarget({ sid: "valid-sid1", sessionFile: "C:/x/session.jsonl", exists: () => false }), "valid-sid1");
	assert.equal(sessionTarget({ sid: "bad", sessionFile: null, exists: () => false }), null);
});

test("plan chooses matching Orca worktree first and preserves listed spelling", () => {
	const exists = (p) => ["C:/bin/orca.exe", "C:/bin/wt.exe", "C:/bin/omo.exe"].includes(p);
	const plan = planReopen({
		sid: "valid-sid1", thread: { cwd: "C:/Work/Repo", title: "작업" },
		env: { PATH: "C:/bin" }, exists, isDir: () => true,
		worktrees: ["c:\\work\\repo"],
	});
	assert.equal(plan.attempts[0].via, "orca");
	assert.equal(plan.attempts[0].args[3], "path:c:\\work\\repo");
	assert.equal(plan.attempts[1].via, "wt");
	assert.deepEqual(planReopen({ sid: "valid-sid1", thread: { cwd: "C:/a;b" }, env: {}, exists, isDir: () => true, worktrees: [] }), { error: "cwd_missing" });
	assert.deepEqual(planReopen({ sid: "bad", thread: { cwd: "C:/x" }, env: {}, exists, isDir: () => true, worktrees: [] }), { error: "no_session" });
	assert.deepEqual(planReopen({ sid: "valid-sid1", thread: { cwd: "C:/x" }, env: {}, exists: () => false, isDir: () => true, worktrees: [] }), { error: "no_launcher" });
});

test("Orca worktree listing parses envelope and fails closed", async () => {
	for (const [out, expected] of [['{"result":{"worktrees":[{"path":"C:/x"},{"path":""}]}}', ["C:/x"]], ["garbage", []]]) {
		const fake = fakeSpawn((child) => process.nextTick(() => { child.stdout.emit("data", out); child.emit("close", 0); }));
		assert.deepEqual(await listOrcaWorktrees({ orcaPath: "orca.exe", spawnImpl: fake.impl }), expected);
	}
});

test("attempt runner falls through a failed exit but stops on an unreadable Orca reply or a timeout", async () => {
	const attempts = [{ via: "orca", cmd: "orca", args: [] }, { via: "wt", cmd: "wt", args: [] }];
	let fake = fakeSpawn((child, n) => process.nextTick(() => { if (n === 1) child.emit("close", 1); else child.emit("close", 0); }));
	assert.deepEqual(await runAttempts(attempts, { spawnImpl: fake.impl }), { ok: true, via: "wt", output: "" });
	fake = fakeSpawn((child, n) => process.nextTick(() => { child.stdout.emit("data", n === 1 ? "{}" : '{"result":{}}'); child.emit("close", 0); }));
	const unreadable = await runAttempts(attempts, { spawnImpl: fake.impl });
	assert.equal(unreadable.ok, false);
	assert.equal(unreadable.error, "launch_failed");
	assert.equal(fake.calls.length, 1);
	const clock = timers();
	fake = fakeSpawn(() => {});
	const running = runAttempts(attempts, { spawnImpl: fake.impl, ...clock });
	clock.callbacks[0]();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fake.calls[0].child.killed, true);
	const timedOut = await running;
	assert.equal(timedOut.ok, false);
	assert.equal(timedOut.tried.length, 1);
	assert.equal(fake.calls.length, 1);
});

test("reopener sink records once, dedupes, and expires after sixty seconds", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reopen-"));
	try {
		const sink = path.join(dir, "sink.jsonl");
		const nowBox = { value: 1000 };
		const env = { PATH: "C:/bin", INBOX_REOPEN_SINK: sink };
		const exists = (p) => ["C:/bin/wt.exe", "C:/bin/omo.exe"].includes(p) || p === "C:/work";
		const reopener = createReopener({ env, exists, isDir: () => true, now: () => nowBox.value });
		assert.deepEqual(await reopener.reopen("valid-sid1", { cwd: "C:/work" }), { ok: true, via: "sink" });
		assert.deepEqual(await reopener.reopen("valid-sid1", { cwd: "C:/work" }), { ok: true, already: true, via: "sink" });
		assert.equal(fs.readFileSync(sink, "utf8").trim().split("\n").length, 1);
		nowBox.value += 60000;
		await reopener.reopen("valid-sid1", { cwd: "C:/work" });
		assert.equal(fs.readFileSync(sink, "utf8").trim().split("\n").length, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("overlapping reopen calls reserve one launch", async () => {
	let child;
	const fake = fakeSpawn((made) => { child = made; });
	const env = { PATH: "C:/bin" };
	const exists = (p) => ["C:/bin/wt.exe", "C:/bin/omo.exe"].includes(p);
	const reopener = createReopener({ env, exists, isDir: () => true, spawnImpl: fake.impl });
	const first = reopener.reopen("valid-sid1", { cwd: "C:/work" });
	const second = reopener.reopen("valid-sid1", { cwd: "C:/work" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fake.calls.length, 1);
	child.emit("close", 0);
	assert.deepEqual(await first, { ok: true, via: "wt" });
	assert.deepEqual(await second, { ok: true, via: "wt", already: true });
});

test("pathExists sees a link whose target is not statable, where fs.existsSync does not (app execution aliases)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reopen-exists-"));
	try {
		const link = path.join(dir, "alias");
		fs.symlinkSync(path.join(dir, "missing-target"), link, "junction");
		assert.equal(fs.existsSync(link), false);
		assert.equal(pathExists(link), true);
		assert.equal(pathExists(path.join(dir, "nothing-here")), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("plan opens Windows Terminal alone when no Orca worktree matches, and Orca alone when wt or omo is missing", () => {
	const thread = { cwd: "C:/work", title: "t" };
	const base = { sid: "valid-sid1", thread, isDir: () => true };
	const wtOnly = planReopen({ ...base, env: { PATH: "C:/bin" }, exists: (p) => ["C:/bin/orca.exe", "C:/bin/wt.exe", "C:/bin/omo.exe"].includes(p), worktrees: ["C:/elsewhere"] });
	assert.deepEqual(wtOnly.attempts.map((attempt) => attempt.via), ["wt"]);
	const orcaOnly = planReopen({ ...base, env: { PATH: "C:/bin" }, exists: (p) => p === "C:/bin/orca.exe", worktrees: ["C:/work"] });
	assert.deepEqual(orcaOnly.attempts.map((attempt) => attempt.via), ["orca"]);
});

test("attempt runner reports launch_failed with every attempt tried when each one exits with an error", async () => {
	const attempts = [{ via: "orca", cmd: "orca", args: [] }, { via: "wt", cmd: "wt", args: [] }];
	const fake = fakeSpawn((child) => process.nextTick(() => child.emit("close", 1)));
	const result = await runAttempts(attempts, { spawnImpl: fake.impl });
	assert.equal(result.ok, false);
	assert.equal(result.error, "launch_failed");
	assert.deepEqual(result.tried.map((entry) => entry.via), ["orca", "wt"]);
});
