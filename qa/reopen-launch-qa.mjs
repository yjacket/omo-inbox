import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOrcaWorktrees, orcaAttempt, orcaPathFor, planReopen, runAttempts, samePath, wtAttempt, wtPathFor } from "../src/reopen.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replaceAll("\\", "/");
const SID = "01a15860-5e09-7e12-b966-bcb4501f052e";
const TITLE = "inbox-reopen-qa";
const env = process.env;
const exists = fs.existsSync;
const isDir = (p) => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};
const orcaPath = orcaPathFor(env, exists);
const wtPath = wtPathFor(env, exists);

const results = [];
let listedWorktree = null;
let handle = null;
const dir = path.join(os.tmpdir(), `inbox-reopen-qa-${process.pid}`);

function run(file, args, cwd = REPO) {
	return new Promise((resolve) => {
		execFile(file, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function findKey(value, key) {
	if (value && typeof value === "object") {
		if (typeof value[key] === "string") return value[key];
		for (const v of Object.values(value)) {
			const found = findKey(v, key);
			if (found) return found;
		}
	}
	return null;
}

function waitExit(child, timeoutMs) {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill();
			resolve({ code: null, error: new Error(`close-tab did not exit within ${timeoutMs} ms`) });
		}, timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, error: null });
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, error });
		});
	});
}

async function waitGone(terminal, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const list = await run(orcaPath, ["terminal", "list", "--json"]);
		if (list.code === 0 && !list.stdout.includes(terminal)) return;
		if (Date.now() >= deadline) throw new Error(`terminal ${terminal} is still listed after ${timeoutMs} ms`);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

function waitForFile(file, timeoutMs) {
	return new Promise((resolve, reject) => {
		const name = path.basename(file);
		let watcher;
		let timer;
		const done = (error) => {
			clearTimeout(timer);
			watcher?.close();
			if (error) reject(error);
			else resolve();
		};
		timer = setTimeout(() => done(new Error(`${name} not created within ${timeoutMs} ms`)), timeoutMs);
		watcher = fs.watch(path.dirname(file), (_, changed) => {
			if (changed === name && exists(file)) done();
		});
		if (exists(file)) done();
	});
}

async function check(name, fn) {
	try {
		await fn();
		results.push(true);
		console.log(`PASS ${name}`);
	} catch (error) {
		results.push(false);
		console.log(`FAIL ${name}: ${error.message}`);
	}
}

try {
	await check("orca lists the current worktree", async () => {
		assert(orcaPath, "orca.exe not found");
		const current = await run(orcaPath, ["worktree", "current", "--json"]);
		assert(current.code === 0, `orca worktree current exited ${current.code}: ${current.stderr || current.stdout}`);
		const currentPath = JSON.parse(current.stdout).result?.worktree?.path;
		assert(typeof currentPath === "string", "orca worktree current returned no path; repo is not Orca-managed");
		const worktrees = await listOrcaWorktrees({ orcaPath, spawnImpl: spawn });
		listedWorktree = worktrees.find((w) => samePath(w, currentPath)) ?? null;
		assert(listedWorktree, `orca worktree list lacks ${currentPath}`);
	});

	await check("plan puts orca before wt, with no shell and cwd_missing for bad paths", async () => {
		const worktrees = listedWorktree ? [listedWorktree] : [];
		const plan = planReopen({ sid: SID, thread: { cwd: REPO, title: TITLE }, env, exists, isDir, worktrees });
		assert(plan.attempts, `plan returned error ${plan.error}`);
		assert(plan.attempts[0]?.via === "orca", "attempt 0 is not orca");
		const flag = plan.attempts[0].args.indexOf("--worktree");
		assert(plan.attempts[0].args[flag + 1] === "path:" + listedWorktree, "orca --worktree arg does not use the listed spelling");
		assert(plan.attempts[1]?.via === "wt", "attempt 1 is not wt");
		assert(plan.attempts.every((attempt) => !("shell" in attempt)), "an attempt carries a shell key");
		const bad = planReopen({ sid: SID, thread: { cwd: "C:/a;b", title: TITLE }, env, exists, isDir, worktrees });
		assert(bad.error === "cwd_missing", `cwd C:/a;b gave ${bad.error}, expected cwd_missing`);
	});

	await check("orca terminal opens in the worktree, shows the repo path, and closes", async () => {
		assert(listedWorktree, "no listed Orca worktree from check 1");
		const created = await runAttempts([orcaAttempt({ orcaPath, worktreePath: listedWorktree, title: TITLE, command: "cd" })], { spawnImpl: spawn });
		assert(created.ok, `orca create failed: ${JSON.stringify(created.tried)}`);
		handle = findKey(JSON.parse(created.output).result, "handle");
		assert(handle, "orca create output has no handle");
		let text = "";
		for (let attempt = 0; attempt < 3 && !text.includes(REPO.toLowerCase()); attempt++) {
			await run(orcaPath, ["terminal", "wait", "--terminal", handle, "--for", "tui-idle", "--timeout-ms", "10000"]);
			const read = await run(orcaPath, ["terminal", "read", "--terminal", handle, "--json"]);
			text = read.stdout.toLowerCase().replace(/\\+/g, "/");
		}
		assert(text.includes(REPO.toLowerCase()), "terminal output does not contain the repo path");
		const closed = await run(orcaPath, ["terminal", "close", "--terminal", handle]);
		assert(closed.code === 0, `orca terminal close exited ${closed.code}: ${closed.stderr}`);
		const list = await run(orcaPath, ["terminal", "list", "--json"]);
		assert(list.code === 0 && !list.stdout.includes(handle), "terminal is still listed after close");
		handle = null;
	});

	await check("close-tab closes the Orca tab after the process exits", async () => {
		assert(listedWorktree, "no listed Orca worktree from check 1");
		const created = await runAttempts([orcaAttempt({ orcaPath, worktreePath: listedWorktree, title: `${TITLE}-close`, command: "cd" })], { spawnImpl: spawn });
		assert(created.ok, `orca create failed: ${JSON.stringify(created.tried)}`);
		const tabHandle = findKey(JSON.parse(created.output).result, "handle");
		assert(tabHandle, "orca create output has no handle");
		let dummy = null;
		try {
			dummy = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
			const pid = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("dummy process did not spawn within 5000 ms")), 5000);
				dummy.once("spawn", () => {
					clearTimeout(timer);
					resolve(dummy.pid);
				});
				dummy.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
			});
			const closer = spawn(process.execPath, [path.join(REPO, "bin", "close-tab.mjs"), "--pid", String(pid), "--terminal", tabHandle], { cwd: REPO, windowsHide: true, stdio: "ignore" });
			dummy.kill();
			const exited = await waitExit(closer, 15000);
			assert(!exited.error, exited.error?.message);
			assert(exited.code === 0, `close-tab exited ${exited.code}`);
			dummy = null;
			await waitGone(tabHandle, 10000);
		} finally {
			dummy?.kill();
		}
	});

	await check("wt opens a tab in a temp folder that runs a command", async () => {
		assert(wtPath, "wt.exe not found");
		fs.mkdirSync(dir, { recursive: true });
		const launched = await runAttempts([wtAttempt({ wtPath, cwd: dir, title: TITLE, argv: ["cmd.exe", "/c", "echo ok>reopen-marker.txt"] })], { spawnImpl: spawn });
		assert(launched.ok, `wt launch failed: ${JSON.stringify(launched.tried)}`);
		await waitForFile(path.join(dir, "reopen-marker.txt"), 15000);
	});
} finally {
	if (handle) await run(orcaPath, ["terminal", "close", "--terminal", handle]);
	try {
		await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 1000 });
	} catch (error) {
		console.log(`WARN cleanup left ${dir} (${error.code}); the wt tab still holds it`);
	}
}

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed`);
process.exitCode = passed === results.length && results.length === 5 ? 0 : 1;
