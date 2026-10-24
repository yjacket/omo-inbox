import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseGitStatus, probeFacts } from "../src/facts.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function gitTimers() {
	let callback = null;
	return {
		setTimer(fn) { callback = fn; return 1; },
		clearTimer() {},
		fire() { callback?.(); },
	};
}

function fakeSpawn(onSpawn) {
	const calls = [];
	const impl = (cmd, args, options) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => { child.killed = true; };
		calls.push({ cmd, args, options, child });
		onSpawn?.(child, calls.length);
		return child;
	};
	return { calls, impl };
}

test("parseGitStatus reads branch, upstream, ahead and dirty lines", () => {
	assert.deepEqual(parseGitStatus("## main...origin/main [ahead 2]\n M a\n?? b\nA  c\n"), { branch: "main", dirty: 3, ahead: 2, upstream: true });
	assert.deepEqual(parseGitStatus("## main\n"), { branch: "main", dirty: 0, ahead: 0, upstream: false });
	assert.deepEqual(parseGitStatus("## main...origin/main\n"), { branch: "main", dirty: 0, ahead: 0, upstream: true });
	assert.deepEqual(parseGitStatus("## No commits yet on main\n"), { branch: "main", dirty: 0, ahead: 0, upstream: false });
	assert.deepEqual(parseGitStatus("## HEAD (no branch)\n"), { branch: null, dirty: 0, ahead: 0, upstream: false });
});

test("probeFacts reads a real repository and reports an untracked file", async () => {
	const tmp = makeTmpHome();
	try {
		git(tmp.home, ["init", "-q", "-b", "main"]);
		fs.writeFileSync(path.join(tmp.home, "tracked.txt"), "one\n");
		git(tmp.home, ["add", "tracked.txt"]);
		git(tmp.home, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "one"]);
		fs.writeFileSync(path.join(tmp.home, "untracked.txt"), "two\n");
		const facts = await probeFacts({ cwd: tmp.home });
		assert.equal(facts.git.branch, "main");
		assert.equal(facts.git.dirty, 1);
		assert.equal(facts.git.upstream, false);
	} finally {
		tmp.cleanup();
	}
});

test("probeFacts returns null git outside a repository", async () => {
	const tmp = makeTmpHome();
	try {
		assert.deepEqual(await probeFacts({ cwd: tmp.home }), { git: null, plan: null });
	} finally {
		tmp.cleanup();
	}
});

test("probeFacts reports unknown when git never exits until the timeout", async () => {
	const tmp = makeTmpHome();
	try {
		const timers = gitTimers();
		const fake = fakeSpawn();
		const pending = probeFacts({ cwd: tmp.home, spawnImpl: fake.impl, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
		timers.fire();
		assert.deepEqual(await pending, { git: { unknown: true }, plan: null });
		assert.equal(fake.calls[0].child.killed, true);
		assert.equal(fake.calls[0].options.windowsHide, true);
		assert.deepEqual(fake.calls[0].args.slice(0, 2), ["-C", tmp.home]);
	} finally {
		tmp.cleanup();
	}
});

test("probeFacts finds an open plan in the worktree", async () => {
	const tmp = makeTmpHome();
	try {
		const plans = path.join(tmp.home, ".omo", "plans");
		fs.mkdirSync(plans, { recursive: true });
		fs.writeFileSync(path.join(plans, "my-plan.md"), "# Plan\n- [ ] first\n- [x] done\n");
		const facts = await probeFacts({ cwd: tmp.home, worktree: tmp.home, slug: "my-plan", spawnImpl: fakeSpawn((child) => {
			process.nextTick(() => { child.stderr.emit("data", "fatal: not a git repository\n"); child.emit("close", 128); });
		}).impl });
		assert.equal(facts.plan.slug, "my-plan");
		assert.equal(facts.plan.path, path.join(tmp.home, ".omo", "plans", "my-plan.md"));
		assert.equal(facts.plan.root, path.resolve(tmp.home));
		assert.equal(facts.plan.open, true);
	} finally {
		tmp.cleanup();
	}
});

test("probeFacts closes a plan with only completed rows", async () => {
	const tmp = makeTmpHome();
	try {
		const plans = path.join(tmp.home, ".omo", "plans");
		fs.mkdirSync(plans, { recursive: true });
		fs.writeFileSync(path.join(plans, "done-plan.md"), "# Plan\n- [x] first\n");
		const facts = await probeFacts({ cwd: tmp.home, slug: "done-plan", spawnImpl: fakeSpawn((child) => {
			process.nextTick(() => { child.stderr.emit("data", "not a git repository"); child.emit("close", 128); });
		}).impl });
		assert.equal(facts.plan.open, false);
	} finally {
		tmp.cleanup();
	}
});

test("probeFacts finds a plan through a linked worktree common dir", async () => {
	const tmp = makeTmpHome();
	const work = path.join(tmp.home, "worktree");
	try {
		const main = path.join(tmp.home, "main");
		fs.mkdirSync(main);
		git(main, ["init", "-q", "-b", "main"]);
		fs.writeFileSync(path.join(main, "tracked.txt"), "one\n");
		git(main, ["add", "tracked.txt"]);
		git(main, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "one"]);
		const plans = path.join(main, ".omo", "plans");
		fs.mkdirSync(plans, { recursive: true });
		fs.writeFileSync(path.join(plans, "linked-plan.md"), "- [ ] work\n");
		git(main, ["worktree", "add", "-q", "-b", "linked", work]);
		const facts = await probeFacts({ cwd: work, worktree: work, slug: "linked-plan" });
		assert.equal(facts.plan.slug, "linked-plan");
		assert.equal(facts.plan.path, path.join(plans, "linked-plan.md"));
		assert.equal(facts.plan.root, path.resolve(main));
		assert.equal(facts.plan.open, true);
	} finally {
		tmp.cleanup();
	}
});

test("probeFacts returns no plan for a missing slug or a traversing slug", async () => {
	const tmp = makeTmpHome();
	try {
		const fake = () => fakeSpawn((child) => {
			process.nextTick(() => { child.stderr.emit("data", "not a git repository"); child.emit("close", 128); });
		}).impl;
		assert.equal((await probeFacts({ cwd: tmp.home, slug: "missing-plan", spawnImpl: fake() })).plan, null);
		assert.equal((await probeFacts({ cwd: tmp.home, slug: "../x", spawnImpl: fake() })).plan, null);
	} finally {
		tmp.cleanup();
	}
});
