import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd, args) {
	try {
		const { stdout } = await run("git", args, { cwd, windowsHide: true, encoding: "utf8" });
		return stdout.trim();
	} catch {
		return null;
	}
}

function splitRemote(url) {
	if (typeof url !== "string") return null;
	const raw = url.trim();
	if (!raw || /^file:/i.test(raw)) return null;
	let host;
	let rest;
	if (raw.includes("://")) {
		rest = raw.slice(raw.indexOf("://") + 3);
		const at = rest.lastIndexOf("@");
		if (at !== -1) rest = rest.slice(at + 1);
		const slash = rest.indexOf("/");
		const authority = slash === -1 ? rest : rest.slice(0, slash);
		rest = slash === -1 ? "" : rest.slice(slash + 1);
		if (authority.startsWith("[")) {
			const close = authority.indexOf("]");
			host = close === -1 ? authority : authority.slice(0, close + 1);
		} else {
			const colon = authority.lastIndexOf(":");
			host = colon === -1 ? authority : authority.slice(0, colon);
		}
	} else {
		if (/^[a-z]:[\\/]/i.test(raw)) return null;
		const colon = raw.indexOf(":");
		if (colon === -1) return null;
		const left = raw.slice(0, colon);
		rest = raw.slice(colon + 1);
		const at = left.lastIndexOf("@");
		host = at === -1 ? left : left.slice(at + 1);
	}
	if (!host) return null;
	rest = rest.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
	return { host, path: rest };
}

export function normalizeRemote(url) {
	const parts = splitRemote(url);
	if (!parts || !parts.path) return null;
	const key = (parts.path ? parts.host + "/" + parts.path : parts.host).toLowerCase();
	if (!key) return null;
	const segments = parts.path.split("/").filter(Boolean);
	return { key, name: segments.length ? segments[segments.length - 1] : null };
}

export function normPath(p) {
	let resolved;
	try {
		resolved = fs.realpathSync.native(p);
	} catch {
		resolved = path.resolve(p);
	}
	if (resolved.startsWith("\\\\?\\")) resolved = resolved.slice(4);
	resolved = resolved.replace(/\\/g, "/");
	if (/^[a-z]:\//.test(resolved)) resolved = resolved[0].toUpperCase() + resolved.slice(1);
	while (resolved.length > 3 && resolved.endsWith("/")) resolved = resolved.slice(0, -1);
	return resolved;
}

export async function identityFor(cwd, env = process.env) {
	const session = {
		id: env.INBOX_SESSION || env.PI_SESSION_ID || null,
		file: env.PI_SESSION_FILE || null,
	};
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top) {
		const name = path.basename(normPath(cwd));
		const key = "dir/" + name.toLowerCase();
		return {
			product: { key, name, remote: null },
			feature: { key: key + "#-", branch: "-", worktree: normPath(cwd) },
			session,
			cwd: normPath(cwd),
		};
	}
	const worktree = normPath(top);
	let url = await git(cwd, ["remote", "get-url", "origin"]);
	if (url === null) {
		const remotes = (await git(cwd, ["remote"]) || "").split("\n").map((s) => s.trim()).filter(Boolean);
		if (remotes.length) url = await git(cwd, ["remote", "get-url", remotes[0]]);
	}
	const normalized = url === null ? null : normalizeRemote(url);
	let product;
	if (normalized) {
		product = { key: normalized.key, name: normalized.name, remote: url };
	} else {
		const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const name = commonDir ? path.basename(path.dirname(normPath(commonDir))) : path.basename(worktree);
		product = { key: "local/" + name.toLowerCase(), name, remote: url };
	}
	let branch = await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
	if (!branch) branch = "wt:" + path.basename(worktree);
	return {
		product,
		feature: { key: product.key + "#" + branch, branch, worktree },
		session,
		cwd: normPath(cwd),
	};
}
