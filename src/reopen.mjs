import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

export function safeTitle(text) {
	const value = String(text ?? "").replace(/[^\uac00-\ud7a3\u3131-\u314eA-Za-z0-9 ._()-]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
	return value || "omo";
}

export function safePath(value, platform = process.platform) {
	if (typeof value !== "string" || /["';&|<>^%$`\r\n]/.test(value)) return null;
	let result = value.replace(/\\/g, "/");
	if (result.endsWith("/") && !/^[A-Za-z]:\/$/.test(result)) result = result.slice(0, -1);
	if (platform === "win32") {
		if (/^[A-Za-z]:\//.test(result)) return result;
		return process.platform !== "win32" && result.startsWith("/") && !result.startsWith("//") ? result : null;
	}
	return result.startsWith("/") && !result.startsWith("//") ? result : null;
}

export function samePath(a, b) {
	const left = safePath(a, "win32") ?? safePath(a, "posix") ?? (typeof a === "string" ? a.replace(/\\/g, "/").replace(/\/$/, "") : null);
	const right = safePath(b, "win32") ?? safePath(b, "posix") ?? (typeof b === "string" ? b.replace(/\\/g, "/").replace(/\/$/, "") : null);
	return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

// Windows app execution aliases (e.g. %LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe) are reparse points that
// fs.existsSync reports as missing under Node (stat fails with EACCES); lstat sees them.
export function pathExists(p) {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
}

export function findExecutable(names, env, exists) {
	const separator = process.platform === "win32" || (env.PATH ?? env.Path ?? "").includes(";") ? ";" : ":";
	for (const dir of (env.PATH ?? env.Path ?? "").split(separator)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = dir.includes("/") || dir.includes("\\") ? dir.replace(/[\\/]+$/, "") + (dir.includes("\\") ? "\\" : "/") + name : path.join(dir, name);
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

function fallback(env, exists, suffix) {
	const candidate = path.join(env.LOCALAPPDATA ?? "", ...suffix);
	return env.LOCALAPPDATA && exists(candidate) ? candidate : null;
}

export function orcaPathFor(env, exists) {
	return findExecutable(["orca.exe"], env, exists) ?? fallback(env, exists, ["Programs", "orca", "resources", "bin", "orca.exe"]);
}

export function wtPathFor(env, exists) {
	return findExecutable(["wt.exe"], env, exists) ?? fallback(env, exists, ["Microsoft", "WindowsApps", "wt.exe"]);
}

export function omoPathFor(env, exists) {
	return findExecutable(["omo.exe", "omo.cmd", "omo"], env, exists);
}

export function sessionTarget({ sid, sessionFile, exists }) {
	const safe = safePath(sessionFile);
	if (safe && /\.jsonl$/i.test(safe) && exists(safe)) return safe;
	return SID_RE.test(sid) ? sid : null;
}

export function orcaAttempt({ orcaPath, worktreePath, title, command }) {
	return { via: "orca", cmd: orcaPath, args: ["terminal", "create", "--worktree", "path:" + worktreePath, "--title", title, "--command", command, "--focus", "--json"] };
}

export function wtAttempt({ wtPath, cwd, title, argv }) {
	return { via: "wt", cmd: wtPath, args: ["-w", "-1", "new-tab", "-d", cwd, "--title", title, ...argv] };
}

export function uuidv7(now = Date.now(), randomBytes = crypto.randomBytes) {
	const bytes = Buffer.from(randomBytes(16));
	let time = Number(now);
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = time % 256;
		time = Math.floor(time / 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function matchingWorktree(worktrees, cwd) {
	return worktrees.find((w) => {
		const listed = safePath(w, "win32") ?? safePath(w, "posix") ?? (typeof w === "string" ? w.replace(/\\/g, "/").replace(/\/$/, "") : null);
		return listed !== null && samePath(w, cwd);
	});
}

export function planNewSession({ sid, folder, message, env, exists, isDir, worktrees }) {
	if (typeof message !== "string" || !/^\/skill:ulw-execute [a-z0-9][a-z0-9-]{0,79}$/.test(message)) return { error: "bad_message" };
	if (!SID_RE.test(sid)) return { error: "bad_sid" };
	const cwd = safePath(folder);
	if (!cwd || !isDir(cwd)) return { error: "cwd_missing" };
	const slug = message.slice("/skill:ulw-execute ".length);
	const title = safeTitle("ulw-execute " + slug);
	const attempts = [];
	const orcaPath = orcaPathFor(env, exists);
	if (orcaPath) {
		const match = matchingWorktree(worktrees, cwd);
		if (match) attempts.push(orcaAttempt({ orcaPath, worktreePath: match, title, command: "omo --session-id " + sid + ' "' + message + '"' }));
	}
	const wtPath = wtPathFor(env, exists);
	const omoPath = omoPathFor(env, exists);
	if (wtPath && omoPath) attempts.push(wtAttempt({ wtPath, cwd, title, argv: [omoPath, "--session-id", sid, message] }));
	return attempts.length ? { attempts, cwd, title } : { error: "no_launcher" };
}

export function planReopen({ sid, thread, env, exists, isDir, worktrees }) {
	const cwd = safePath(thread.cwd);
	if (!cwd || !isDir(cwd)) return { error: "cwd_missing" };
	const target = sessionTarget({ sid, sessionFile: thread.sessionFile, exists });
	if (!target) return { error: "no_session" };
	const title = safeTitle(thread.title || thread.product || "omo");
	const attempts = [];
	const orcaPath = orcaPathFor(env, exists);
	if (orcaPath) {
		const match = worktrees.find((w) => {
			const listed = safePath(w, "win32") ?? safePath(w, "posix") ?? (typeof w === "string" ? w.replace(/\\/g, "/").replace(/\/$/, "") : null);
			return listed !== null && samePath(w, cwd);
		});
		if (match) attempts.push(orcaAttempt({ orcaPath, worktreePath: match, title, command: 'omo --session "' + target + '"' }));
	}
	const wtPath = wtPathFor(env, exists);
	const omoPath = omoPathFor(env, exists);
	if (wtPath && omoPath) attempts.push(wtAttempt({ wtPath, cwd, title, argv: [omoPath, "--session", target] }));
	return attempts.length ? { attempts, cwd, target, title } : { error: "no_launcher" };
}

export function listOrcaWorktrees({ orcaPath, spawnImpl, timeoutMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout }) {
	return new Promise((resolve) => {
		let child;
		let output = "";
		let settled = false;
		let timer;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimer(timer);
			resolve(value);
		};
		try {
			child = spawnImpl(orcaPath, ["worktree", "list", "--json"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout?.on("data", (chunk) => { output += chunk; });
			child.on("error", () => finish([]));
			child.on("close", (code) => {
				if (code !== 0) return finish([]);
				try {
					finish(JSON.parse(output).result.worktrees.map((w) => w.path).filter(Boolean));
				} catch {
					finish([]);
				}
			});
			timer = setTimer(() => { child.kill?.(); finish([]); }, timeoutMs);
		} catch {
			finish([]);
		}
	});
}

export function runAttempts(attempts, { spawnImpl, timeoutMs = 15000, setTimer = setTimeout, clearTimer = clearTimeout }) {
	return (async () => {
		const tried = [];
		for (const attempt of attempts) {
			const result = await new Promise((resolve) => {
				let child;
				let output = "";
				let settled = false;
				let timer;
				const finish = (value) => {
					if (settled) return;
					settled = true;
					clearTimer(timer);
					resolve(value);
				};
				try {
					child = spawnImpl(attempt.cmd, attempt.args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
					child.stdout?.on("data", (chunk) => { output += chunk; });
					child.on("error", (error) => finish({ error: error.message }));
					child.on("close", (code) => {
						let valid = code === 0;
						if (valid && attempt.via === "orca") {
							try { valid = JSON.parse(output).result != null; } catch { valid = false; }
						}
						// Exit 0 with an unreadable reply may still have opened a tab: stop rather than open a second terminal.
						finish(valid ? { ok: true, output } : code === 0 ? { code, error: "invalid_output", stop: true } : { code });
					});
					timer = setTimer(() => { child.kill?.(); finish({ error: "timeout", stop: true }); }, timeoutMs);
				} catch (error) {
					finish({ error: error.message });
				}
			});
			if (result.ok) return { ok: true, via: attempt.via, output: result.output };
			tried.push({ via: attempt.via, ...(result.code !== undefined ? { code: result.code } : {}), ...(result.error ? { error: result.error } : {}) });
			// Only a clear failure (spawn error or non-zero exit) falls through; a timeout or an unreadable reply stops.
			if (result.stop) break;
		}
		return { ok: false, error: "launch_failed", tried };
	})();
}

export function createReopener({ env = process.env, exists = pathExists, isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }, spawnImpl = spawn, sink = env.INBOX_REOPEN_SINK || null, now = Date.now, log = () => {} } = {}) {
	const last = new Map();
	const lastVia = new Map();
	const inflight = new Map();
	const launchInflight = new Map();
	return {
		async reopen(sid, thread) {
			if (inflight.has(sid)) return inflight.get(sid).then((r) => r.ok ? { ...r, already: true } : r);
			const launch = (async () => {
				if (now() - (last.get(sid) ?? -Infinity) < 60000) return { ok: true, already: true, via: lastVia.get(sid) };
				const orcaPath = orcaPathFor(env, exists);
				const worktrees = orcaPath ? await listOrcaWorktrees({ orcaPath, spawnImpl }) : [];
				const plan = planReopen({ sid, thread, env, exists, isDir, worktrees });
				if (plan.error) return { ok: false, error: plan.error };
				if (sink) {
					fs.appendFileSync(sink, JSON.stringify({ at: new Date(now()).toISOString(), sid, attempts: plan.attempts }) + "\n");
					last.set(sid, now());
					lastVia.set(sid, "sink");
					return { ok: true, via: "sink" };
				}
				const result = await runAttempts(plan.attempts, { spawnImpl });
				if (result.ok) {
					last.set(sid, now());
					lastVia.set(sid, result.via);
					return { ok: true, via: result.via };
				}
				log("relaunch " + sid + " failed " + JSON.stringify(result.tried));
				return { ok: false, error: "launch_failed" };
			})();
			inflight.set(sid, launch);
			try { return await launch; } finally { inflight.delete(sid); }
		},
		async launch({ sid, folder, message }) {
			if (launchInflight.has(sid)) return launchInflight.get(sid).then((r) => r.ok ? { ...r, already: true } : r);
			const start = (async () => {
				const orcaPath = orcaPathFor(env, exists);
				const worktrees = orcaPath ? await listOrcaWorktrees({ orcaPath, spawnImpl }) : [];
				const plan = planNewSession({ sid, folder, message, env, exists, isDir, worktrees });
				if (plan.error) return { ok: false, error: plan.error };
				if (sink) {
					fs.appendFileSync(sink, JSON.stringify({ at: new Date(now()).toISOString(), sid, kind: "launch", attempts: plan.attempts }) + "\n");
					return { ok: true, via: "sink" };
				}
				const result = await runAttempts(plan.attempts, { spawnImpl });
				if (result.ok) return { ok: true, via: result.via };
				log("launch " + sid + " failed " + JSON.stringify(result.tried));
				return { ok: false, error: "launch_failed" };
			})();
			launchInflight.set(sid, start);
			try { return await start; } finally { launchInflight.delete(sid); }
		},
	};
}
