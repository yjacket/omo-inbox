// Report reminder git check tests (README "Report reminder", Visual).
// Run: node --test test/visual.test.mjs
// Real git in temp folders; file times and commit dates are set explicitly, never read from the wall clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { isVisualPath, lastVisualChange } from "../extension/inbox/visual.ts";

const SINCE = Date.parse("2026-01-01T12:00:00Z");
const BEFORE = "2026-01-01T11:00:00Z";
const AFTER = "2026-01-01T13:00:00Z";

function git(cwd, args, date = BEFORE) {
	return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
	});
}

function repo(t) {
	const tmp = makeTmpHome("inbox-visual-");
	t.after(() => tmp.cleanup());
	const dir = path.join(tmp.home, "app");
	fs.mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q", "-b", "main"]);
	fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", "seed"]);
	return { home: tmp.home, dir };
}

function writeAt(file, text, iso) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	const at = new Date(iso);
	fs.utimesSync(file, at, at);
}

test("visual files are UI extensions or files under templates, static, public or web", () => {
	for (const file of ["src/Page.tsx", "a/b.css", "index.html", "web/app.js", "src/ui/static/app.js", "public/logo.png", "templates/mail.txt"]) {
		assert.equal(isVisualPath(file), true, file);
	}
	for (const file of ["src/logic.ts", "README.md", "test/web.test.mjs", ".omo/evidence/shot.png"]) {
		assert.equal(isVisualPath(file), false, file);
	}
});

test("an uncommitted visual file counts with its modification time when it was modified at or after the window start", async (t) => {
	const { dir } = repo(t);
	writeAt(path.join(dir, "web", "app.js"), "old\n", BEFORE);
	writeAt(path.join(dir, "src", "logic.mjs"), "new\n", AFTER);
	assert.equal(await lastVisualChange([dir], SINCE), null, "an older visual edit and a new plain edit");

	writeAt(path.join(dir, "web", "app.js"), "new\n", AFTER);
	assert.equal(await lastVisualChange([dir], SINCE), Date.parse(AFTER));
});

test("a commit dated at or after the window start counts with its date in any worktree of the repository", async (t) => {
	const { home, dir } = repo(t);
	const tree = path.join(home, "app-wt");
	git(dir, ["worktree", "add", "-q", "-b", "feat", tree]);

	writeAt(path.join(tree, "src", "old.css"), "a{}\n", BEFORE);
	git(tree, ["add", "-A"]);
	git(tree, ["commit", "-q", "-m", "old"], BEFORE);
	assert.equal(await lastVisualChange([dir], SINCE), null, "the commit predates the window");

	writeAt(path.join(tree, "src", "new.css"), "b{}\n", BEFORE);
	git(tree, ["add", "-A"]);
	git(tree, ["commit", "-q", "-m", "new"], AFTER);
	assert.equal(await lastVisualChange([dir], SINCE), Date.parse(AFTER), "asked from the main worktree, found in the linked one");
});

test("a folder outside git never counts", async (t) => {
	const tmp = makeTmpHome("inbox-visual-");
	t.after(() => tmp.cleanup());
	writeAt(path.join(tmp.home, "page", "index.html"), "<p>x</p>\n", AFTER);
	assert.equal(await lastVisualChange([path.join(tmp.home, "page"), path.join(tmp.home, "missing")], SINCE), null);
});
