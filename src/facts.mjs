import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function parseGitStatus(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	const head = lines.find((line) => line.startsWith("## ")) ?? "";
	let branch = null;
	let upstream = false;
	let ahead = 0;
	const rest = head.slice(3);
	if (rest.startsWith("No commits yet on ")) {
		branch = rest.slice("No commits yet on ".length).trim() || null;
	} else if (!rest.startsWith("HEAD (no branch)")) {
		const dots = rest.indexOf("...");
		const space = rest.indexOf(" ");
		const end = dots === -1 ? (space === -1 ? rest.length : space) : dots;
		branch = rest.slice(0, end).trim() || null;
		if (dots !== -1) upstream = true;
	}
	const match = /\[ahead (\d+)/.exec(rest);
	if (match) ahead = Number(match[1]);
	const dirty = lines.filter((line) => line.length > 0 && !line.startsWith("## ")).length;
	return { branch, dirty, ahead, upstream };
}

function run(command, args, { spawnImpl, timeoutMs, setTimer, clearTimer }) {
	return new Promise((resolve) => {
		let child;
		const stdout = [];
		const stderr = [];
		let settled = false;
		let timer;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimer(timer);
			resolve(value);
		};
		try {
			child = spawnImpl(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout?.on("data", (chunk) => { stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); });
			child.stderr?.on("data", (chunk) => { stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); });
			child.on("error", () => finish({ unknown: true }));
			child.on("close", (code) => finish({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
			timer = setTimer(() => {
				child.kill?.();
				finish({ unknown: true });
			}, timeoutMs);
		} catch {
			finish({ unknown: true });
		}
	});
}

function defaultIsDir(value) {
	try {
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

export async function probeFacts({
	cwd,
	worktree,
	slug,
	spawnImpl = spawn,
	exists = fs.existsSync,
	isDir = defaultIsDir,
	readFile = fs.readFileSync,
	timeoutMs = 3000,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
}) {
	const dir = worktree || cwd;
	if (typeof dir !== "string" || !path.isAbsolute(dir) || !exists(dir) || !isDir(dir)) return { git: null, plan: null };

	const gitRun = await run("git", ["-C", dir, "status", "--porcelain=v1", "--branch"], { spawnImpl, timeoutMs, setTimer, clearTimer });
	let git;
	if (gitRun.unknown) {
		git = { unknown: true };
	} else if (gitRun.code === 0) {
		git = parseGitStatus(gitRun.stdout);
	} else if (gitRun.code === 128 && /not a git repository/i.test(gitRun.stderr)) {
		git = null;
	} else {
		git = { unknown: true };
	}

	let plan = null;
	if (SLUG_RE.test(String(slug ?? ""))) {
		const candidates = [];
		if (worktree) candidates.push(worktree);
		if (cwd) candidates.push(cwd);
		const common = await run("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { spawnImpl, timeoutMs, setTimer, clearTimer });
		if (!common.unknown && common.code === 0) {
			const value = common.stdout.trim();
			if (value) candidates.push(path.dirname(value));
		}
		const seen = new Set();
		for (const candidate of candidates) {
			const root = path.resolve(candidate);
			const key = process.platform === "win32" ? root.toLowerCase() : root;
			if (seen.has(key)) continue;
			seen.add(key);
			if (!exists(root) || !isDir(root)) continue;
			const file = path.join(root, ".omo", "plans", slug + ".md");
			if (!exists(file)) continue;
			let text = "";
			try {
				text = String(readFile(file));
			} catch {
				continue;
			}
			plan = { slug, path: file, root, open: /^- \[ \] /m.test(text) };
			break;
		}
	}

	return { git, plan };
}
