import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { handback, takeover } from "../src/takeover.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

function write(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function hashTree(root) {
	const hash = createHash("sha256");
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else hash.update(path.relative(root, full)).update(fs.readFileSync(full));
		}
	};
	walk(root);
	return hash.digest("hex");
}

function setup({ mode = "trial", source = { channel: "package", source: "/pkg/omo-desk" }, desk = true } = {}) {
	const tmp = makeTmpHome("inbox-takeover-");
	const root = tmp.home;
	const deskHome = path.join(root, "desk");
	const inboxHome = path.join(root, "inbox");
	const userHome = path.join(root, "user");
	const appDir = path.join(inboxHome, "app");
	write(path.join(inboxHome, "config.json"), `${JSON.stringify({ v: 1, port: 4387, mode })}\n`);
	write(path.join(appDir, "skill", "SKILL.md"), "skill v1\n");
	write(path.join(appDir, "skill", "sub", "a.txt"), "a\n");
	write(path.join(appDir, "rules", "visual-board.md"), "rule v1\n");
	write(path.join(appDir, "src", "cli.mjs"), "export async function main(argv) { console.log(JSON.stringify(argv)); return 7; }\n");
	if (desk) {
		write(path.join(deskHome, "app", "bin", "desk.mjs"), "// real desk\n");
		if (source) write(path.join(deskHome, "app", "source.json"), JSON.stringify(source));
		write(path.join(deskHome, "data", "proposals", "p1", "proposal.json"), "{\"id\":\"p1\"}");
		write(path.join(deskHome, "data", "proposals", "p2", "events", "000001.json"), "{}");
		write(path.join(deskHome, "inbox", "sess-a", "x-1.json"), "{\"a\":1}");
		write(path.join(deskHome, "inbox", "sess-a", "x-2.json"), "{\"a\":2}");
	}
	const calls = [];
	const result = { code: 0, stdout: "", stderr: "" };
	const deps = {
		deskHome, inboxHome, userHome, appDir,
		run: async (cmd, args) => {
			calls.push({ cmd, args });
			return result;
		},
		now: () => 1_700_000_000_000,
	};
	return { ...tmp, root, deskHome, inboxHome, userHome, appDir, deps, calls, result };
}

const mode = (s) => JSON.parse(fs.readFileSync(path.join(s.inboxHome, "config.json"), "utf8")).mode;

test("takeover skips when already primary", async () => {
	const s = setup({ mode: "primary" });
	try {
		const lines = await takeover(s.deps);
		assert.deepEqual(lines, [{ step: "takeover", result: "skipped (already primary)" }]);
		assert.equal(s.calls.length, 0);
		assert.equal(fs.existsSync(path.join(s.inboxHome, "takeover.json")), false);
	} finally {
		s.cleanup();
	}
});

test("takeover skips without an active desk, when disabled, or when inbox is not installed", async () => {
	const none = setup({ desk: false });
	const disabled = setup();
	const bare = setup();
	try {
		assert.equal((await takeover(none.deps))[0].result, "skipped (no active desk)");
		write(path.join(disabled.deskHome, "disabled"), "disabled\n");
		assert.equal((await takeover(disabled.deps))[0].result, "skipped (no active desk)");
		fs.rmSync(path.join(bare.inboxHome, "config.json"));
		assert.equal((await takeover(bare.deps))[0].result, "skipped (not installed)");
		assert.equal(none.calls.length + disabled.calls.length + bare.calls.length, 0);
	} finally {
		none.cleanup();
		disabled.cleanup();
		bare.cleanup();
	}
});

test("takeover imports additively, uninstalls desk, shims, and goes primary", async () => {
	const s = setup();
	try {
		write(path.join(s.inboxHome, "data", "proposals", "p1", "proposal.json"), "{\"id\":\"inbox-own\"}");
		const before = hashTree(path.join(s.deskHome, "data"));
		const mailboxBefore = hashTree(path.join(s.deskHome, "inbox"));
		const logged = [];
		const lines = await takeover({ ...s.deps, log: (line) => logged.push(line) });
		assert.deepEqual(lines.find((l) => l.step === "import"), { step: "import", result: "1 proposals, 2 mailbox files" });
		assert.equal(logged.length, lines.length);
		// desk data untouched, inbox own proposal not overwritten
		assert.equal(hashTree(path.join(s.deskHome, "data")), before);
		assert.equal(hashTree(path.join(s.deskHome, "inbox")), mailboxBefore);
		assert.equal(fs.readFileSync(path.join(s.inboxHome, "data", "proposals", "p1", "proposal.json"), "utf8"), "{\"id\":\"inbox-own\"}");
		assert.ok(fs.existsSync(path.join(s.inboxHome, "data", "proposals", "p2", "events", "000001.json")));
		assert.equal(fs.readFileSync(path.join(s.inboxHome, "mailbox", "sess-a", "x-2.json"), "utf8"), "{\"a\":2}");
		// uninstall ran against desk's bin, then disabled + shim
		assert.equal(s.calls.length, 1);
		assert.deepEqual(s.calls[0].args, [path.join(s.deskHome, "app", "bin", "desk.mjs"), "uninstall"]);
		assert.ok(fs.existsSync(path.join(s.deskHome, "disabled")));
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.deskHome, "app", "SHIM.json"), "utf8")), { by: "omo-inbox" });
		const record = JSON.parse(fs.readFileSync(path.join(s.inboxHome, "takeover.json"), "utf8"));
		assert.deepEqual(record, { v: 1, at: 1_700_000_000_000, desk: { home: s.deskHome, source: { channel: "package", source: "/pkg/omo-desk" } } });
		assert.equal(mode(s), "primary");
		for (const dir of [".agents", ".claude"]) {
			assert.equal(fs.readFileSync(path.join(s.userHome, dir, "skills", "visual-board", "sub", "a.txt"), "utf8"), "a\n");
		}
		assert.equal(fs.readFileSync(path.join(s.userHome, ".claude", "rules", "visual-board.md"), "utf8"), "rule v1\n");
	} finally {
		s.cleanup();
	}
});

test("a desk uninstall failure stops before disabled, shim and primary mode", async () => {
	const s = setup();
	try {
		s.result.code = 1;
		const lines = await takeover(s.deps);
		assert.deepEqual(lines.at(-1), { step: "takeover", result: "failed (desk uninstall)" });
		assert.equal(fs.existsSync(path.join(s.deskHome, "disabled")), false);
		assert.equal(fs.readFileSync(path.join(s.deskHome, "app", "bin", "desk.mjs"), "utf8"), "// real desk\n");
		assert.equal(fs.existsSync(path.join(s.deskHome, "app", "SHIM.json")), false);
		assert.equal(mode(s), "trial");
		assert.equal(fs.existsSync(path.join(s.userHome, ".claude", "rules", "visual-board.md")), false);
	} finally {
		s.cleanup();
	}
});

test("the shim forwards argv and the exit code to the inbox cli", async () => {
	const s = setup();
	try {
		await takeover(s.deps);
		const shim = path.join(s.deskHome, "app", "bin", "desk.mjs");
		const child = spawnSync(process.execPath, [shim, "list", "--x"], { encoding: "utf8", cwd: s.root });
		assert.equal(child.status, 7);
		assert.equal(child.stdout.trim(), JSON.stringify(["list", "--x"]));
	} finally {
		s.cleanup();
	}
});

test("handback skips without a takeover record or outside primary mode", async () => {
	const s = setup();
	try {
		assert.equal((await handback(s.deps))[0].result, "skipped (no takeover)");
		await takeover(s.deps);
		write(path.join(s.inboxHome, "config.json"), JSON.stringify({ mode: "trial" }));
		assert.equal((await handback(s.deps))[0].result, "skipped (not primary)");
	} finally {
		s.cleanup();
	}
});

for (const [channel, expectedArgs] of [
	["package", ["--from-package"]],
	["checkout", []],
]) {
	test(`handback reverts and reinstalls desk for the ${channel} channel`, async () => {
		const s = setup({ source: { channel, source: "/src/omo-desk" } });
		try {
			await takeover(s.deps);
			s.calls.length = 0;
			const lines = await handback({ ...s.deps, now: () => 1234 });
			assert.equal(fs.existsSync(path.join(s.deskHome, "app")), false);
			assert.equal(fs.existsSync(path.join(s.deskHome, "disabled")), false);
			assert.equal(fs.existsSync(path.join(s.userHome, ".claude", "rules", "visual-board.md")), false);
			assert.equal(fs.existsSync(path.join(s.userHome, ".agents", "skills", "visual-board")), false);
			assert.equal(fs.existsSync(path.join(s.userHome, ".claude", "skills", "visual-board")), false);
			assert.deepEqual(s.calls, [{ cmd: process.execPath, args: [path.join("/src/omo-desk", "bin", "desk.mjs"), "install", ...expectedArgs] }]);
			assert.equal(mode(s), "trial");
			assert.equal(fs.existsSync(path.join(s.inboxHome, "takeover.json")), false);
			assert.ok(fs.existsSync(path.join(s.inboxHome, "takeover-1234.json")));
			assert.equal(lines.find((l) => l.step === "desk").result, "reinstalled");
		} finally {
			s.cleanup();
		}
	});
}

test("handback without a known desk source prints manual", async () => {
	const s = setup({ source: null });
	try {
		await takeover(s.deps);
		s.calls.length = 0;
		const lines = await handback(s.deps);
		assert.equal(lines.find((l) => l.step === "desk").result, "manual (/desk install)");
		assert.equal(s.calls.length, 0);
		assert.equal(mode(s), "trial");
	} finally {
		s.cleanup();
	}
});

test("handback keeps modified skill/rule and a desk app that is not our shim", async () => {
	const s = setup();
	try {
		await takeover(s.deps);
		write(path.join(s.userHome, ".claude", "rules", "visual-board.md"), "edited\n");
		write(path.join(s.userHome, ".claude", "skills", "visual-board", "SKILL.md"), "edited\n");
		write(path.join(s.deskHome, "app", "SHIM.json"), JSON.stringify({ by: "someone-else" }));
		const lines = await handback(s.deps);
		const by = (step) => lines.find((l) => l.step === step).result;
		assert.equal(by("rule"), "kept (modified)");
		assert.equal(by("skill"), "kept (modified)");
		assert.equal(by("shim"), "kept (not ours)");
		assert.equal(fs.readFileSync(path.join(s.userHome, ".claude", "rules", "visual-board.md"), "utf8"), "edited\n");
		assert.ok(fs.existsSync(path.join(s.deskHome, "app", "bin", "desk.mjs")));
		// the unmodified agents copy is still removed
		assert.equal(fs.existsSync(path.join(s.userHome, ".agents", "skills", "visual-board")), false);
	} finally {
		s.cleanup();
	}
});
