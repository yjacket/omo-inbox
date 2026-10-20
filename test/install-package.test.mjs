import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { doctor, install, runValueName, uninstall } from "../src/install.mjs";
import { agentDir } from "../src/paths.mjs";

function fixture() {
	const tmp = makeTmpHome("inbox-package-");
	const home = path.join(tmp.home, "inbox");
	const userHome = path.join(tmp.home, "user");
	const agent = path.join(tmp.home, "agent");
	const repo = path.join(tmp.home, "repo");
	for (const dir of ["bin", "src", "web", "extension", "skill", "rules"]) fs.mkdirSync(path.join(repo, dir), { recursive: true });
	fs.writeFileSync(path.join(repo, "bin", "inbox.mjs"), "");
	fs.writeFileSync(path.join(repo, "src", "server.mjs"), "");
	fs.writeFileSync(path.join(repo, "extension", "omo-inbox.ts"), "package extension\n");
	fs.writeFileSync(path.join(repo, "skill", "SKILL.md"), "skill\n");
	fs.writeFileSync(path.join(repo, "rules", "visual-board.md"), "rule\n");
	fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "1.2.3" }));
	fs.mkdirSync(path.join(agent, "extensions"), { recursive: true });
	fs.writeFileSync(path.join(agent, "extensions", "omo-inbox.ts"), "legacy\n");
	fs.mkdirSync(home, { recursive: true });
	const env = { OMO_INBOX_HOME: home, INBOX_AGENT_DIR: agent, INBOX_USER_HOME: userHome, INBOX_NO_TAILSCALE: "1" };
	const calls = { reg: [], tailscale: [], spawn: [] };
	let serverUp = false;
	const runners = {
		git: () => ({ status: 0, stdout: `${"a".repeat(40)}\n` }),
		reg: (args) => {
			calls.reg.push(args);
			return { status: args[0] === "query" ? 1 : 0, stdout: "", stderr: "" };
		},
		tailscale: (args) => {
			calls.tailscale.push(args);
			throw new Error("tailscale must not run");
		},
		spawn: (cmd, args, options) => {
			calls.spawn.push({ cmd, args, options });
			serverUp = true;
			return { pid: 1234, unref() {} };
		},
	};
	// The fake server answers health only after install spawned it.
	const fetch = async (url) => ({ ok: url.endsWith("/api/health") ? serverUp : true });
	const opts = { env, repoRoot: repo, userHome, fetch, runners, now: () => 123456, sleep: async () => {} };
	return { tmp, home, userHome, agent, repo, env, calls, opts };
}

test("package install writes package source, removes legacy and disabled marker", async () => {
	const s = fixture();
	try {
		fs.writeFileSync(path.join(s.home, "disabled"), "disabled");
		const result = await install({ ...s.opts, fromPackage: true });
		assert.equal(result.ok, true, result.lines.join("\n"));
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, "app", "source.json"))), {
			channel: "package", source: s.repo, sha: "a".repeat(40), version: "1.2.3", installedMs: 123456,
		});
		assert.equal(fs.existsSync(path.join(s.agent, "extensions", "omo-inbox.ts")), false);
		assert.equal(fs.existsSync(path.join(s.home, "disabled")), false);
		assert.equal(fs.existsSync(path.join(s.home, "setup.lock")), false);
	} finally { s.tmp.cleanup(); }
});

test("package setup removes the developer extension dir as well as the legacy file", async () => {
	const s = fixture();
	try {
		const devDir = path.join(s.agent, "extensions", "omo-inbox");
		fs.mkdirSync(path.join(devDir, "inbox"), { recursive: true });
		fs.writeFileSync(path.join(devDir, "index.ts"), "dev entry\n");
		fs.writeFileSync(path.join(devDir, "inbox", "core.ts"), "dev core\n");
		const result = await install({ ...s.opts, fromPackage: true });
		assert.equal(result.ok, true, result.lines.join("\n"));
		assert.ok(result.lines.includes("extension: legacy removed"), result.lines.join("\n"));
		assert.equal(fs.existsSync(devDir), false);
		assert.equal(fs.existsSync(path.join(s.agent, "extensions", "omo-inbox.ts")), false);
	} finally { s.tmp.cleanup(); }
});

test("same package sha skips stop and app replacement", async () => {
	const s = fixture();
	try {
		fs.mkdirSync(path.join(s.home, "app", "src"), { recursive: true });
		fs.writeFileSync(path.join(s.home, "app", "src", "server.mjs"), "");
		fs.writeFileSync(path.join(s.home, "app", "source.json"), JSON.stringify({ channel: "package", source: s.repo, sha: "a".repeat(40) }));
		const result = await install({ ...s.opts, fromPackage: true });
		assert.deepEqual(result.lines, ["app: current"]);
		assert.equal(s.calls.spawn.length, 0);
	} finally { s.tmp.cleanup(); }
});

test("live setup lock returns locked and stale lock is taken over", async () => {
	const s = fixture();
	try {
		const lock = path.join(s.home, "setup.lock");
		fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedMs: 123456 }));
		assert.deepEqual((await install({ ...s.opts, fromPackage: true, now: () => 123457 })).lines, ["setup: locked"]);
		fs.writeFileSync(lock, JSON.stringify({ pid: -1, startedMs: 0 }));
		const result = await install({ ...s.opts, fromPackage: true });
		assert.equal(result.ok, true, result.lines.join("\n"));
		assert.equal(fs.existsSync(lock), false);
	} finally { s.tmp.cleanup(); }
});

test("package install keeps a checkout source", async () => {
	const s = fixture();
	try {
		fs.mkdirSync(path.join(s.home, "app"), { recursive: true });
		fs.writeFileSync(path.join(s.home, "app", "source.json"), JSON.stringify({ channel: "checkout" }));
		assert.deepEqual((await install({ ...s.opts, fromPackage: true })).lines, ["setup: checkout install kept"]);
		assert.equal(s.calls.spawn.length, 0);
	} finally { s.tmp.cleanup(); }
});

test("failed package setup records failedMs", async () => {
	const s = fixture();
	try {
		const result = await install({
			...s.opts,
			fromPackage: true,
			now: (() => { let n = 0; return () => { n += 1000; return n; }; })(),
			fetch: async (url) => ({ ok: !url.endsWith("/api/health") }),
		});
		assert.equal(result.ok, false);
		const state = JSON.parse(fs.readFileSync(path.join(s.home, "setup-state.json")));
		assert.equal(state.sha, "a".repeat(40));
		assert.equal(typeof state.failedMs, "number");
		assert.match(state.error, /health timeout/);
	} finally { s.tmp.cleanup(); }
});

test("checkout install writes checkout source metadata", async () => {
	const s = fixture();
	try {
		const result = await install({ ...s.opts, noTailscale: true });
		assert.equal(result.ok, true, result.lines.join("\n"));
		assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "app", "source.json"))).channel, "checkout");
	} finally { s.tmp.cleanup(); }
});

test("uninstall disables package channel but not checkout channel and leaves app cwd", async () => {
	const s = fixture();
	const original = process.cwd();
	try {
		fs.mkdirSync(path.join(s.home, "app"), { recursive: true });
		fs.writeFileSync(path.join(s.home, "app", "source.json"), JSON.stringify({ channel: "package" }));
		process.chdir(path.join(s.home, "app"));
		await uninstall({ ...s.opts, noTailscale: true });
		assert.ok(fs.existsSync(path.join(s.home, "disabled")));
		assert.notEqual(process.cwd(), path.join(s.home, "app"));
		fs.rmSync(path.join(s.home, "disabled"));
		fs.mkdirSync(path.join(s.home, "app"), { recursive: true });
		fs.writeFileSync(path.join(s.home, "app", "source.json"), JSON.stringify({ channel: "checkout" }));
		await uninstall({ ...s.opts, noTailscale: true });
		assert.equal(fs.existsSync(path.join(s.home, "disabled")), false);
	} finally { process.chdir(original); s.tmp.cleanup(); }
});

test("environment seams choose user home, Run value, agent dir and skip all tailscale calls", async () => {
	const s = fixture();
	try {
		assert.equal(runValueName({ INBOX_RUN_VALUE: "custom" }), "custom");
		assert.equal(agentDir({ INBOX_AGENT_DIR: "first", OMO_CODING_AGENT_DIR: "second" }), "first");
		const result = await install({ ...s.opts, fromPackage: true });
		assert.equal(result.ok, true, result.lines.join("\n"));
		assert.ok(fs.existsSync(path.join(s.userHome, ".agents", "skills", "visual-board", "SKILL.md")));
		assert.ok(s.calls.reg.some((args) => args.includes("omo-inbox")));
		assert.deepEqual(s.calls.tailscale, []);
	} finally { s.tmp.cleanup(); }
});

test("doctor package extension row compares source and requires legacy absence", async () => {
	const s = fixture();
	try {
		const app = path.join(s.home, "app");
		fs.mkdirSync(path.join(app, "extension"), { recursive: true });
		fs.copyFileSync(path.join(s.repo, "extension", "omo-inbox.ts"), path.join(app, "extension", "omo-inbox.ts"));
		fs.writeFileSync(path.join(app, "source.json"), JSON.stringify({ channel: "package", source: s.repo }));
		const result = await doctor({ ...s.opts, noTailscale: true });
		assert.ok(result.lines.includes("extension: fail differs from the app copy"));
		fs.rmSync(path.join(s.agent, "extensions", "omo-inbox.ts"));
		const next = await doctor({ ...s.opts, noTailscale: true });
		assert.ok(next.lines.includes("extension: ok"));
		assert.deepEqual(s.calls.tailscale, []);
	} finally { s.tmp.cleanup(); }
});

test("CLI forwards --from-package to install", () => {
	// A live lock held by this test process makes the package install stop before any side effect.
	const tmp = makeTmpHome("inbox-package-cli-");
	try {
		fs.writeFileSync(path.join(tmp.home, "setup.lock"), JSON.stringify({ pid: process.pid, startedMs: Date.now() }));
		const cli = fileURLToPath(new URL("../bin/inbox.mjs", import.meta.url));
		const env = { ...process.env, OMO_INBOX_HOME: tmp.home, INBOX_USER_HOME: tmp.home, INBOX_AGENT_DIR: tmp.home, INBOX_RUN_VALUE: "omo-inbox-test", INBOX_NO_TAILSCALE: "1" };
		const result = spawnSync(process.execPath, [cli, "install", "--from-package"], { env, encoding: "utf8", windowsHide: true });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), "setup: locked");
	} finally { tmp.cleanup(); }
});
