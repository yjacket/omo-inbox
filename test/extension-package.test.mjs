import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInbox } from "../extension/inbox/core.ts";

const sha1 = "1111111111111111111111111111111111111111";
const sha2 = "2222222222222222222222222222222222222222";

async function setup({ packageMode = true, sha = sha1, state, setupOnly = false, loadedSha = sha, disabled = false, env = {}, fetch, execPath } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-extension-package-"));
	const source = path.join(root, "clone");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(path.join(source, ".git", "refs", "heads"), { recursive: true });
	await fs.mkdir(path.join(source, "bin"), { recursive: true });
	await fs.writeFile(path.join(source, "bin", "inbox.mjs"), "");
	await fs.writeFile(path.join(source, ".git", "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(path.join(source, ".git", "refs", "heads", "main"), `${sha}\n`);
	await fs.mkdir(path.join(home, "app", "bin"), { recursive: true });
	await fs.writeFile(path.join(home, "app", "bin", "inbox.mjs"), "");
	await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
	if (setupOnly) {
		await fs.mkdir(path.join(agentDir, "extensions", "omo-inbox"), { recursive: true });
		await fs.writeFile(path.join(agentDir, "extensions", "omo-inbox", "index.ts"), "");
	}
	if (disabled) await fs.writeFile(path.join(home, "disabled"), "");
	if (state) await fs.writeFile(path.join(home, "app", "source.json"), JSON.stringify(state));
	const timers = [];
	const spawned = [];
	const commands = new Map();
	const handlers = new Map();
	const pi = {
		on(event, fn) { handlers.set(event, fn); },
		registerCommand(name, config) { commands.set(name, config); },
	};
	let now = 1_800_000_000_000;
	const handle = createInbox(pi, {
		packageMode, source, home, agentDir, loadedSha, env, fetch, execPath, platform: "win32",
		now: () => now,
		timer: {
			setInterval(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
			clearInterval(timer) { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
		},
		spawn(cmd, args, opts) { spawned.push({ cmd, args, opts }); return { unref() {} }; },
	});
	return {
		root, source, home, agentDir, handle, timers, spawned, commands, handlers,
		setNow(value) { now = value; },
		async tick() { await handle.packageTick(); },
		async close() { handle?.stop?.(); await fs.rm(root, { recursive: true, force: true }); },
	};
}

test("non-package mode registers no package timer", async () => {
	// A reachable server keeps the /api/here refresh from starting the CLI, so the assertion below
	// holds without depending on a live server on the default port.
	const s = await setup({ packageMode: false, fetch: async () => ({ ok: true, status: 200, json: async () => ({ footer: "", waiting: [] }) }) });
	await s.handlers.get("session_start")({}, { sessionManager: { getSessionId: () => "s" } });
	assert.equal(s.timers.some((timer) => timer.ms === 60_000), false);
	assert.equal(s.spawned.length, 0);
	await s.close();
});

test("steady package source does not spawn setup", async () => {
	const s = await setup({ state: { channel: "package", source: "", sha: sha1 } });
	await fs.writeFile(path.join(s.home, "app", "source.json"), JSON.stringify({ channel: "package", source: s.source, sha: sha1 }));
	await s.tick();
	assert.equal(s.spawned.length, 0);
	await s.close();
});

test("changed sha claims setup and spawns package install", async () => {
	const s = await setup({ sha: sha2 });
	await s.tick();
	assert.deepEqual(s.spawned[0].args, [path.join(s.source, "bin", "inbox.mjs"), "install", "--from-package"]);
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(s.home, "setup-state.json"), "utf8")), { sha: sha2, claimMs: 1_800_000_000_000, pid: process.pid });
	await s.close();
});

test("failed setup state backs off for the same sha", async () => {
	const s = await setup();
	await fs.writeFile(path.join(s.home, "setup-state.json"), JSON.stringify({ sha: sha1, failedMs: 1_800_000_000_000 - 1000, error: "failed" }));
	await s.tick();
	assert.equal(s.spawned.length, 0);
	await s.close();
});

test("disabled marker and checkout channel prevent setup", async () => {
	const disabled = await setup({ disabled: true });
	await disabled.tick();
	await disabled.handlers.get("session_start")({}, {});
	assert.equal(disabled.spawned.length, 0);
	await disabled.close();
	const checkout = await setup({ state: { channel: "checkout", source: "", sha: sha1 } });
	await checkout.tick();
	assert.equal(checkout.spawned.length, 0);
	await checkout.close();
});

test("setup and /inbox run the CLI on node even when omo runs on bun", async () => {
	const bin = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-node-bin-"));
	await fs.writeFile(path.join(bin, "node.exe"), "");
	const s = await setup({ sha: sha2, execPath: "C:\\tools\\bun.exe", env: { PATH: bin } });
	await s.tick();
	await s.commands.get("inbox").handler("uninstall", {});
	assert.deepEqual(s.spawned.map((entry) => entry.cmd), [path.join(bin, "node.exe"), path.join(bin, "node.exe")]);
	await s.close();
	await fs.rm(bin, { recursive: true, force: true });
});

test("a disabled package shows no footer and never asks the server", async () => {
	const fetches = [];
	const s = await setup({ disabled: true, fetch: async (url) => { fetches.push(url); throw new Error("down"); } });
	const statuses = [];
	await s.handlers.get("session_start")({}, { hasUI: true, cwd: s.root, ui: { setStatus: (_key, value) => statuses.push(value) }, sessionManager: { getSessionId: () => "s" } });
	assert.deepEqual(fetches, []);
	assert.equal(statuses.includes("Inbox 서버 꺼짐"), false);
	assert.equal(s.spawned.length, 0);
	await s.close();
});

test("setup-only migration instance has no inbox, footer, or command", async () => {
	const s = await setup({ setupOnly: true });
	assert.deepEqual([...s.handlers.keys()], ["session_start", "session_shutdown"]);
	assert.equal(s.commands.size, 0);
	await s.handlers.get("session_start")({}, {});
	assert.equal(s.timers.length, 1);
	await s.close();
});

test("setup-only instance reloads once legacy extension disappears", async () => {
	const s = await setup({ setupOnly: true, state: { channel: "package", source: "", sha: sha1 } });
	await fs.writeFile(path.join(s.home, "app", "source.json"), JSON.stringify({ channel: "package", source: s.source, sha: sha1 }));
	let reloads = 0;
	await s.handlers.get("session_start")({}, { isIdle: () => true, requestReload: () => reloads++ });
	assert.equal(reloads, 0);
	await fs.rm(path.join(s.agentDir, "extensions", "omo-inbox", "index.ts"));
	await s.tick();
	assert.equal(reloads, 1);
	await s.tick();
	assert.equal(reloads, 1);
	await s.close();
});

test("loaded sha mismatch reloads only when idle and prefers requestReload", async () => {
	const s = await setup({ state: { channel: "package", source: "", sha: sha1 }, loadedSha: sha2 });
	await fs.writeFile(path.join(s.home, "app", "source.json"), JSON.stringify({ channel: "package", source: s.source, sha: sha1 }));
	let requested = 0;
	let fallback = 0;
	await s.handlers.get("session_start")({}, { isIdle: () => false, requestReload: () => requested++, reload: () => fallback++ });
	await s.tick();
	assert.equal(requested, 0);
	await s.handlers.get("session_start")({}, { isIdle: () => true, requestReload: () => requested++, reload: () => fallback++ });
	assert.equal(requested, 1);
	assert.equal(fallback, 0);
	await s.close();
});

test("generation guard rejects a second owner and shutdown frees it", async () => {
	const s = await setup();
	const second = createInbox({ on() {} }, { packageMode: true, source: s.source, home: s.home, agentDir: s.agentDir, loadedSha: sha1 });
	assert.equal(second, null);
	await s.handlers.get("session_shutdown")();
	const third = createInbox({ on() {} }, { packageMode: true, source: s.source, home: s.home, agentDir: s.agentDir, loadedSha: sha1 });
	assert.notEqual(third, null);
	await third.stop();
	await s.close();
});

test("/inbox takeover, handback, status and bogus use the CLI or notify", async () => {
	const s = await setup({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
	const notices = [];
	const ctx = { ui: { notify: (text) => notices.push(text) } };
	await s.commands.get("inbox").handler("takeover", ctx);
	await s.commands.get("inbox").handler("handback", ctx);
	const spawnedAfterHandback = s.spawned.length;
	await s.commands.get("inbox").handler("status", ctx);
	await s.commands.get("inbox").handler("bogus", ctx);
	assert.deepEqual(s.spawned.map((entry) => entry.cmd), [process.execPath, process.execPath]);
	assert.deepEqual(s.spawned.map((entry) => entry.args), [
		[path.join(s.source, "bin", "inbox.mjs"), "takeover"],
		[path.join(s.source, "bin", "inbox.mjs"), "handback"],
	]);
	assert.equal(s.spawned.length, spawnedAfterHandback, "status and bogus spawn nothing");
	assert.deepEqual(notices, [
		"omo-inbox takeover을(를) 시작했습니다.",
		"omo-inbox handback을(를) 시작했습니다.",
		"omo-inbox 모드: trial, 서버: 꺼짐, 내 차례: 0건",
		"사용법: /inbox install | uninstall | takeover | handback | status",
	]);
	await s.close();
});

test("/inbox install and uninstall spawn the expected CLI commands", async () => {
	const s = await setup();
	const notices = [];
	await s.commands.get("inbox").handler("install", { ui: { notify: (text) => notices.push(text) } });
	await s.commands.get("inbox").handler("uninstall", { ui: { notify: (text) => notices.push(text) } });
	assert.deepEqual(s.spawned.map((entry) => entry.args.slice(1)), [["install", "--from-package"], ["uninstall"]]);
	assert.equal(s.spawned[1].args[0], path.join(s.source, "bin", "inbox.mjs"));
	assert.equal(notices.length, 2);
	await s.close();
});
