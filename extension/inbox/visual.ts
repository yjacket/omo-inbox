/**
 * omo-inbox report reminder: when did the work last change a visual file since the window start? Answered from git
 * only, in every worktree of the repositories involved: an uncommitted visual file modified since then (its
 * modification time), or a commit dated since then that touches one (its committer date). What the session looked at
 * (images, computer use, words) never counts.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VISUAL_EXT = /\.(?:html?|css|scss|sass|less|vue|svelte|jsx|tsx)$/i;
const VISUAL_DIR = /(?:^|[\\/])(?:templates|static|public|web)[\\/]/i;
const GIT_TIMEOUT_MS = 10_000;

/** Runs git in a folder; any failure (not a repository, missing folder, timeout) is null. */
export type Git = (cwd: string, args: string[]) => Promise<string | null>;

export function isVisualPath(file: string): boolean {
	return VISUAL_EXT.test(file) || VISUAL_DIR.test(file);
}

// Optional locks off: a status run must not take the index lock while the agent is using git.
const runGit: Git = (cwd, args) => new Promise((resolve) => {
	execFile(
		"git",
		["-c", "core.quotepath=off", ...args],
		{ cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
		(error, stdout) => resolve(error ? null : String(stdout)),
	);
});

async function worktreesOf(dirs: string[], git: Git): Promise<string[]> {
	const found = new Set<string>();
	for (const dir of new Set(dirs)) {
		const listed = await git(dir, ["worktree", "list", "--porcelain"]);
		if (listed === null) continue;
		for (const line of listed.split(/\r?\n/)) {
			if (line.startsWith("worktree ")) found.add(path.resolve(line.slice("worktree ".length)));
		}
	}
	return [...found];
}

async function dirtyVisual(worktree: string, sinceMs: number, git: Git): Promise<number | null> {
	const status = await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (status === null) return null;
	let latest: number | null = null;
	const records = status.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length < 4) continue;
		// A rename or copy record is followed by its source path.
		if (record[0] === "R" || record[0] === "C") index += 1;
		const file = record.slice(3);
		if (!isVisualPath(file)) continue;
		const stat = fs.statSync(path.join(worktree, file), { throwIfNoEntry: false });
		if (stat !== undefined && stat.mtimeMs >= sinceMs && (latest === null || stat.mtimeMs > latest)) latest = stat.mtimeMs;
	}
	return latest;
}

async function committedVisual(worktree: string, sinceMs: number, git: Git): Promise<number | null> {
	const log = await git(worktree, ["log", `--since=${new Date(sinceMs).toISOString()}`, "--no-merges", "--name-only", "--format=%x00%ct", "HEAD"]);
	if (log === null) return null;
	let latest: number | null = null;
	let commitMs = 0;
	for (const line of log.split(/\r?\n/)) {
		if (line.startsWith("\0")) commitMs = Number(line.slice(1)) * 1000;
		else if (line.length > 0 && isVisualPath(line) && (latest === null || commitMs > latest)) latest = commitMs;
	}
	return latest;
}

/** The latest time (epoch ms) a worktree of a repository holding one of `dirs` changed a visual file at or after `sinceMs`, or null. */
export async function lastVisualChange(dirs: string[], sinceMs: number, git: Git = runGit): Promise<number | null> {
	let latest: number | null = null;
	for (const worktree of await worktreesOf(dirs, git)) {
		if (!fs.existsSync(worktree)) continue;
		for (const at of [await dirtyVisual(worktree, sinceMs, git), await committedVisual(worktree, sinceMs, git)]) {
			if (at !== null && (latest === null || at > latest)) latest = at;
		}
	}
	return latest;
}
