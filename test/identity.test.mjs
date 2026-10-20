import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeRemote, normPath, identityFor } from "../src/identity.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

function runGit(cwd, args, home) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			XDG_CONFIG_HOME: path.join(home, ".config"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function initRepo(home, name, remote) {
	const dir = path.join(home, name);
	fs.mkdirSync(dir);
	runGit(dir, ["init", "-b", "main"], home);
	runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], home);
	if (remote) runGit(dir, ["remote", "add", "origin", remote], home);
	return dir;
}

describe("normalizeRemote", () => {
	test("normalizes remote urls to a lowercase key with original-case name", () => {
		const table = [
			["https://github.com/acme/widget.git", "github.com/acme/widget", "widget"],
			["git@GitHub.com:acme/Widget.git", "github.com/acme/widget", "Widget"],
			["ssh://git@github.com:22/acme/x", "github.com/acme/x", "x"],
			["https://u:p@gitlab.com/a/b/", "gitlab.com/a/b", "b"],
			["https://github.com/acme/widget", "github.com/acme/widget", "widget"],
			["  https://github.com/acme/widget.git  ", "github.com/acme/widget", "widget"],
		];
		for (const [url, key, name] of table) {
			assert.deepEqual(normalizeRemote(url), { key, name }, url);
		}
	});

	test("returns null for empty, whitespace, file:, host-only and windows-drive remotes", () => {
		for (const url of [
			"",
			"   ",
			"file:///C:/tmp/repo",
			"https://github.com",
			"https://github.com/",
			"git@github.com:",
			"C:/dev/repo",
			"C:\\dev\\repo",
			"c:/x",
		]) {
			assert.equal(normalizeRemote(url), null, JSON.stringify(url));
		}
	});
});

describe("normPath", () => {
	test("strips trailing separators and keeps the root", () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const dir = path.join(home, "np");
			fs.mkdirSync(dir);
			assert.equal(normPath(dir + path.sep), normPath(dir));
			assert.ok(!normPath(dir).endsWith("/"));
			if (process.platform === "win32") {
				assert.equal(normPath("C:\\"), "C:/");
				assert.equal(normPath(dir).charAt(0), path.resolve(dir).charAt(0).toUpperCase());
			}
		} finally {
			cleanup();
		}
	});
});

describe("identityFor", () => {
	test("derives product, feature, cwd and session for a repo with origin", async () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const dir = initRepo(home, "myrepo", "https://github.com/Owner/Repo.git");
			const id = await identityFor(dir, {});
			assert.equal(id.product.key, "github.com/owner/repo");
			assert.equal(id.product.name, "Repo");
			assert.equal(id.product.remote, "https://github.com/Owner/Repo.git");
			assert.equal(id.feature.key, "github.com/owner/repo#main");
			assert.equal(id.feature.branch, "main");
			assert.equal(id.feature.worktree, normPath(dir));
			assert.equal(id.cwd, normPath(dir));
			assert.deepEqual(id.session, { id: null, file: null });
		} finally {
			cleanup();
		}
	});

	test("falls back to the first remote when origin is absent", async () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const dir = initRepo(home, "upsrepo", null);
			runGit(dir, ["remote", "add", "upstream", "https://gitlab.com/Org/Proj.git"], home);
			const id = await identityFor(dir, {});
			assert.equal(id.product.key, "gitlab.com/org/proj");
			assert.equal(id.product.name, "Proj");
			assert.equal(id.product.remote, "https://gitlab.com/Org/Proj.git");
			assert.equal(id.feature.key, "gitlab.com/org/proj#main");
		} finally {
			cleanup();
		}
	});

	test("shares one product key across worktrees and reports the worktree branch", async () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const main = initRepo(home, "mainrepo", "https://github.com/owner/mainrepo.git");
			const wtPath = path.join(home, "wt");
			runGit(main, ["worktree", "add", "-b", "feature-x", wtPath, "main"], home);
			const mainId = await identityFor(main, {});
			const wtId = await identityFor(wtPath, {});
			assert.equal(wtId.product.key, mainId.product.key);
			assert.equal(wtId.feature.key, "github.com/owner/mainrepo#feature-x");
			assert.equal(wtId.feature.branch, "feature-x");
			assert.equal(wtId.feature.worktree, normPath(wtPath));
			assert.notEqual(wtId.feature.worktree, mainId.feature.worktree);
		} finally {
			cleanup();
		}
	});

	test("uses local/<dir> when the repo has no remote", async () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const dir = initRepo(home, "myrepo", null);
			const id = await identityFor(dir, {});
			assert.equal(id.product.key, "local/myrepo");
			assert.equal(id.product.name, "myrepo");
			assert.equal(id.product.remote, null);
			assert.equal(id.feature.key, "local/myrepo#main");
		} finally {
			cleanup();
		}
	});

	test("uses wt:<worktree basename> for a detached HEAD", async () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const dir = initRepo(home, "detached", "https://github.com/o/detached.git");
			runGit(dir, ["checkout", "--detach", "HEAD"], home);
			const id = await identityFor(dir, {});
			assert.equal(id.feature.branch, "wt:" + path.basename(normPath(dir)));
			assert.equal(id.feature.key, "github.com/o/detached#wt:" + path.basename(normPath(dir)));
			assert.equal(id.feature.worktree, normPath(dir));
		} finally {
			cleanup();
		}
	});

	test("treats a non-git directory as dir/<name>", async () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const dir = path.join(home, "plain");
			fs.mkdirSync(dir);
			const id = await identityFor(dir, {});
			assert.deepEqual(id.product, { key: "dir/plain", name: "plain", remote: null });
			assert.deepEqual(id.feature, { key: "dir/plain#-", branch: "-", worktree: normPath(dir) });
			assert.equal(id.cwd, normPath(dir));
			assert.ok(id.product.key.startsWith("dir/"));
		} finally {
			cleanup();
		}
	});

	test("prefers INBOX_SESSION over PI_SESSION_ID and reads PI_SESSION_FILE", async () => {
		const { home, cleanup } = makeTmpHome();
		try {
			const dir = path.join(home, "plain");
			fs.mkdirSync(dir);
			const both = await identityFor(dir, { INBOX_SESSION: "inbox-1", PI_SESSION_ID: "pi-1", PI_SESSION_FILE: "C:/x.json" });
			assert.equal(both.session.id, "inbox-1");
			assert.equal(both.session.file, "C:/x.json");
			const fallback = await identityFor(dir, { PI_SESSION_ID: "pi-1" });
			assert.equal(fallback.session.id, "pi-1");
			assert.equal(fallback.session.file, null);
			const none = await identityFor(dir, {});
			assert.equal(none.session.id, null);
			assert.equal(none.session.file, null);
		} finally {
			cleanup();
		}
	});

	if (process.platform === "win32") {
		test("normalizes a lowercase drive and backslashes to the same worktree", async () => {
			const { home, cleanup } = makeTmpHome();
			try {
				const dir = initRepo(home, "caseRepo", "https://github.com/o/caseRepo.git");
				const weird = dir.replace(/^([A-Za-z]):/, (m, d) => d.toLowerCase() + ":").replace(/\//g, "\\");
				const a = await identityFor(dir, {});
				const b = await identityFor(weird, {});
				assert.equal(b.cwd, a.cwd);
				assert.equal(b.feature.worktree, a.feature.worktree);
				assert.equal(b.product.key, a.product.key);
				assert.equal(b.feature.key, a.feature.key);
			} finally {
				cleanup();
			}
		});
	}
});
