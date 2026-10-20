import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { RUN_KEY, RUN_VALUE, doctor, install, uninstall } from "../src/install.mjs";
import { guard, serveOff, serveOn, status } from "../src/tailscale.mjs";

const DNS = "host.tailnet.ts.net";
const PROXY = "http://127.0.0.1:4387";

/** A fixture repo root with every entry install copies. */
function makeRepo(root) {
	const repo = path.join(root, "repo");
	for (const dir of ["bin", "src", "web", "extension", path.join("extension", "inbox"), path.join("skill", "example"), "rules"]) {
		fs.mkdirSync(path.join(repo, dir), { recursive: true });
	}
	fs.writeFileSync(path.join(repo, "bin", "inbox.mjs"), "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(repo, "src", "server.mjs"), "export {};\n");
	fs.writeFileSync(path.join(repo, "web", "targets.json"), "[]\n");
	fs.writeFileSync(path.join(repo, "extension", "omo-inbox.ts"), "export const x = 1;\n");
	fs.writeFileSync(path.join(repo, "extension", "inbox", "core.ts"), "export const core = 1;\n");
	fs.writeFileSync(path.join(repo, "skill", "SKILL.md"), "# visual-board\n");
	fs.writeFileSync(path.join(repo, "skill", "example", "board.json"), "{}\n");
	fs.writeFileSync(path.join(repo, "rules", "visual-board.md"), "# rules\n");
	fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "omo-inbox", version: "0.1.0" }));
	return repo;
}

/** In-memory HKCU Run store behind a reg.exe-shaped runner. */
function fakeReg() {
	const values = new Map();
	const calls = [];
	const runner = (args) => {
		calls.push(args);
		const valueName = args.includes("/v") ? args[args.indexOf("/v") + 1] : undefined;
		if (args[0] === "query") {
			if (!values.has(valueName)) return { status: 1, stdout: "", stderr: "" };
			return { status: 0, stdout: `\r\n${RUN_KEY}\r\n    ${valueName}    REG_SZ    ${values.get(valueName)}\r\n\r\n`, stderr: "" };
		}
		if (args[0] === "add") {
			values.set(valueName, args[args.indexOf("/d") + 1]);
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "delete") {
			values.delete(valueName);
			return { status: 0, stdout: "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: `unexpected reg ${args.join(" ")}` };
	};
	return { runner, calls, values };
}

/** A tailscale stub whose serve state mutates exactly as `breakAfter` says. */
function fakeTailscale({ running = true, breakAfter = null } = {}) {
	const state = {
		web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "https://127.0.0.1:443" } } } },
		allowFunnel: {},
		tcp: { "443": { TCPForward: "127.0.0.1:443" } },
		off: 0,
	};
	const calls = [];
	const runner = (args) => {
		calls.push(args);
		if (args[0] === "status" && args[1] === "--json") {
			return {
				status: 0,
				stdout: JSON.stringify({
					BackendState: running ? "Running" : "Stopped",
					Self: { DNSName: `${DNS}.`, TailscaleIPs: ["100.1.2.3", "fd7a::1"], UserID: 42 },
					User: { "42": { LoginName: "me@example.com" } },
				}),
				stderr: "",
			};
		}
		if (args[0] === "serve" && args[1] === "status") {
			return { status: 0, stdout: JSON.stringify({ Web: state.web, AllowFunnel: state.allowFunnel, TCP: state.tcp }), stderr: "" };
		}
		if (args[0] === "serve" && args.includes("--bg")) {
			state.web[`${DNS}:4388`] = { Handlers: { "/": { Proxy: PROXY } } };
			if (breakAfter === "web443") state.web[`${DNS}:443`] = { Handlers: {} };
			if (breakAfter === "funnel") state.allowFunnel[`${DNS}:4388`] = true;
			if (breakAfter === "proxy") state.web[`${DNS}:4388`] = { Handlers: { "/": { Proxy: "http://127.0.0.1:9" } } };
			return { status: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "serve" && args.includes("off")) {
			state.off += 1;
			delete state.web[`${DNS}:4388`];
			return { status: 0, stdout: "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: `unexpected tailscale ${args.join(" ")}` };
	};
	return { runner, calls, state };
}

/** A child_process.spawn fake for launchServer's detached path. */
function fakeSpawn(onSpawn) {
	const calls = [];
	const impl = (cmd, args, options) => {
		calls.push({ cmd, args, options });
		onSpawn?.();
		return { pid: 4321, unref() {} };
	};
	return { impl, calls };
}

/** The server answers 403 unless a shutdown carries postGuard's two headers, and keeps running. */
function fakeFetch({ stubborn = false } = {}) {
	const state = { healthy: false };
	const calls = [];
	const impl = async (url, init) => {
		calls.push({ url, init });
		if (url.endsWith("/api/health")) {
			if (!state.healthy) throw new Error("ECONNREFUSED");
			return { ok: true, json: async () => ({ ok: true }) };
		}
		if (url.endsWith("/api/shutdown")) {
			const headers = init?.headers ?? {};
			const guarded = init?.method === "POST" && String(headers["content-type"]).startsWith("application/json") && headers["x-inbox"] === "1";
			if (!guarded) return { ok: false, status: 403, json: async () => ({ ok: false }) };
			if (!stubborn) state.healthy = false;
			return { ok: true, json: async () => ({ ok: true }) };
		}
		throw new Error(`unexpected fetch ${url}`);
	};
	return { impl, calls, state };
}

function setup({ stubborn = false } = {}) {
	const tmp = makeTmpHome();
	const home = path.join(tmp.home, "home");
	const userHome = path.join(tmp.home, "user");
	const agent = path.join(tmp.home, "agent");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(userHome, { recursive: true });
	const repo = makeRepo(tmp.home);
	const env = { OMO_INBOX_HOME: home, OMO_CODING_AGENT_DIR: agent };
	const reg = fakeReg();
	const ts = fakeTailscale();
	const fetch = fakeFetch({ stubborn });
	const spawn = fakeSpawn(() => {
		fetch.state.healthy = true;
	});
	const opts = {
		env,
		repoRoot: repo,
		userHome,
		runners: { reg: reg.runner, tailscale: ts.runner, spawn: spawn.impl },
		fetch: fetch.impl,
	};
	return { tmp, home, userHome, agent, repo, env, reg, ts, fetch, spawn, opts };
}

function lineFor(lines, step) {
	return lines.find((line) => line.startsWith(`${step}:`));
}

test("fresh install writes every step and copies the app", async () => {
	const s = setup();
	try {
		const { ok, lines } = await install(s.opts);
		assert.equal(ok, true, lines.join("\n"));
		assert.equal(lineFor(lines, "stop"), "stop: skipped");
		assert.equal(lineFor(lines, "app"), "app: written");
		assert.equal(lineFor(lines, "mode"), "mode: primary");
		assert.equal(lineFor(lines, "launcher"), "launcher: written");
		assert.equal(lineFor(lines, "autostart"), "autostart: written");
		assert.equal(lineFor(lines, "extension"), "extension: written");
		assert.equal(lineFor(lines, "skill"), "skill: written");
		assert.equal(lineFor(lines, "rule"), "rule: written");
		assert.equal(lineFor(lines, "config"), "config: written");
		assert.equal(lineFor(lines, "tailscale"), "tailscale: written");
		assert.equal(lineFor(lines, "server"), "server: started:4321");
		assert.equal(lines.at(-1), "열린 omo 세션에서 /reload 하면 확장이 반영됩니다.");

		assert.ok(fs.existsSync(path.join(s.home, "app", "src", "server.mjs")));
		assert.ok(fs.existsSync(path.join(s.home, "app", "package.json")));
		assert.ok(fs.existsSync(path.join(s.agent, "extensions", "omo-inbox", "index.ts")));
		assert.ok(fs.existsSync(path.join(s.agent, "extensions", "omo-inbox", "inbox", "core.ts")));
		assert.equal(fs.existsSync(path.join(s.agent, "extensions", "omo-inbox.ts")), false);
		assert.ok(fs.existsSync(path.join(s.userHome, ".agents", "skills", "visual-board", "SKILL.md")));
		assert.ok(fs.existsSync(path.join(s.userHome, ".agents", "skills", "visual-board", "example", "board.json")));
		assert.ok(fs.existsSync(path.join(s.userHome, ".claude", "skills", "visual-board", "SKILL.md")));
		assert.ok(fs.existsSync(path.join(s.userHome, ".claude", "rules", "visual-board.md")));

		const launcher = fs.readFileSync(path.join(s.home, "launch-hidden.vbs"), "utf8");
		assert.ok(launcher.startsWith('Set sh = CreateObject("WScript.Shell")\r\n'));
		assert.ok(launcher.includes("--max-semi-space-size=1 --max-old-space-size=128"));
		assert.ok(launcher.endsWith('", 0, False\r\n'));
		assert.equal(s.reg.values.get(RUN_VALUE), `wscript.exe "${path.join(s.home, "launch-hidden.vbs")}"`);

		const config = JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8"));
		assert.equal(config.publicBase, `https://${DNS}:4388`);
		assert.deepEqual(config.pcTailnetIps, ["100.1.2.3", "fd7a::1"]);
		assert.equal(config.owner, "me@example.com");
		assert.deepEqual(config.baseline443, {
			web: { Handlers: { "/": { Proxy: "https://127.0.0.1:443" } } },
			allowFunnel: {},
		});
		// server.json belongs to the running server, so install must not write one.
		assert.equal(fs.existsSync(path.join(s.home, "server.json")), false);
	} finally {
		s.tmp.cleanup();
	}
});

test("a second install reports unchanged except app and server", async () => {
	const s = setup();
	try {
		await install(s.opts);
		const { ok, lines } = await install(s.opts);
		assert.equal(ok, true, lines.join("\n"));
		assert.equal(lineFor(lines, "stop"), "stop: stopped");
		assert.equal(lineFor(lines, "app"), "app: written");
		assert.equal(lineFor(lines, "launcher"), "launcher: unchanged");
		assert.equal(lineFor(lines, "autostart"), "autostart: unchanged");
		assert.equal(lineFor(lines, "extension"), "extension: unchanged");
		assert.equal(lineFor(lines, "skill"), "skill: unchanged");
		assert.equal(lineFor(lines, "rule"), "rule: unchanged");
		assert.equal(lineFor(lines, "config"), "config: unchanged");
		assert.equal(lineFor(lines, "tailscale"), "tailscale: unchanged");
		assert.equal(lineFor(lines, "server"), "server: started:4321");
		assert.equal(s.ts.state.off, 0);

		const shutdown = s.fetch.calls.find((call) => call.url.endsWith("/api/shutdown"));
		assert.equal(shutdown.init.method, "POST");
		assert.equal(shutdown.init.headers["content-type"], "application/json");
		assert.equal(shutdown.init.headers["x-inbox"], "1");
		assert.equal(shutdown.init.body, "{}");
	} finally {
		s.tmp.cleanup();
	}
});

test("a server that ignores shutdown aborts before the app dir is touched", async () => {
	const s = setup({ stubborn: true });
	try {
		s.fetch.state.healthy = true;
		let clock = 0;
		const opts = { ...s.opts, now: () => (clock += 1000), sleep: async () => {} };
		const { ok, lines } = await install(opts);
		assert.equal(ok, false);
		assert.equal(lineFor(lines, "stop"), "stop: failed:server did not stop");
		assert.equal(lines.some((line) => line.startsWith("app:")), false);
		assert.equal(fs.existsSync(path.join(s.home, "app")), false);
		assert.equal(s.spawn.calls.length, 0);
	} finally {
		s.tmp.cleanup();
	}
});

test("--no-autostart and --no-tailscale are reported skipped", async () => {
	const s = setup();
	try {
		const { ok, lines } = await install({ ...s.opts, noAutostart: true, noTailscale: true });
		assert.equal(ok, true, lines.join("\n"));
		assert.equal(lineFor(lines, "autostart"), "autostart: skipped");
		assert.equal(lineFor(lines, "tailscale"), "tailscale: skipped");
		assert.equal(s.reg.values.size, 0);
		const config = JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8"));
		assert.equal(config.publicBase, `https://${DNS}:4388`);
		assert.equal(config.baseline443, undefined);
	} finally {
		s.tmp.cleanup();
	}
});

test("a tailscale that is not Running yields null config and skips serve", async () => {
	const s = setup();
	try {
		s.ts = fakeTailscale({ running: false });
		const opts = { ...s.opts, runners: { ...s.opts.runners, tailscale: s.ts.runner } };
		const { ok, lines } = await install(opts);
		assert.equal(ok, true, lines.join("\n"));
		const config = JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8"));
		assert.equal(config.publicBase, null);
		assert.deepEqual(config.pcTailnetIps, []);
		assert.equal(config.owner, null);
		assert.equal(lineFor(lines, "tailscale"), "tailscale: skipped");
		assert.equal(s.ts.state.off, 0);
	} finally {
		s.tmp.cleanup();
	}
});

for (const [name, breakAfter] of [["the 443 Web entry", "web443"], ["an AllowFunnel 4388 key", "funnel"]]) {
	test(`guarding against a change to ${name} rolls 4388 back and reports failed:443-guard`, async () => {
		const s = setup();
		try {
			s.ts = fakeTailscale({ breakAfter });
			const opts = { ...s.opts, runners: { ...s.opts.runners, tailscale: s.ts.runner } };
			const { ok, lines } = await install(opts);
			assert.equal(ok, false);
			assert.equal(lineFor(lines, "tailscale"), "tailscale: failed:443-guard");
			assert.equal(s.ts.state.off, 1);
			const config = JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8"));
			assert.equal(config.baseline443, undefined);
		} finally {
			s.tmp.cleanup();
		}
	});
}

test("install without repoRoot copies the repo the module lives in, not the cwd", async () => {
	const s = setup();
	const cwd = process.cwd();
	try {
		const { repoRoot, ...opts } = s.opts;
		const decoy = path.join(s.tmp.home, "cwd-decoy");
		fs.mkdirSync(decoy, { recursive: true });
		process.chdir(decoy);
		const { ok, lines } = await install(opts);
		assert.equal(ok, true, lines.join("\n"));
		assert.equal(lineFor(lines, "app"), "app: written");
		assert.ok(fs.existsSync(path.join(s.home, "app", "src", "server.mjs")), lines.join("\n"));
		assert.ok(fs.existsSync(path.join(s.home, "app", "package.json")));
	} finally {
		process.chdir(cwd);
		s.tmp.cleanup();
	}
});

test("a repoRoot that is not a repo checkout is refused without touching the app dir", async () => {
	const s = setup();
	try {
		const app = path.join(s.home, "app");
		fs.mkdirSync(app, { recursive: true });
		fs.writeFileSync(path.join(app, "keep.txt"), "keep\n");
		const empty = path.join(s.tmp.home, "empty");
		fs.mkdirSync(empty, { recursive: true });
		const { ok, lines } = await install({ ...s.opts, repoRoot: empty });
		assert.equal(ok, false);
		assert.ok(lines.includes(`app: failed:not a repo checkout ${empty}`), lines.join("\n"));
		assert.equal(fs.readFileSync(path.join(app, "keep.txt"), "utf8"), "keep\n");
	} finally {
		s.tmp.cleanup();
	}
});

test("a repoRoot equal to <home>/app is refused so install cannot delete its own source", async () => {
	const s = setup();
	try {
		const app = path.join(s.home, "app");
		fs.mkdirSync(app, { recursive: true });
		fs.writeFileSync(path.join(app, "keep.txt"), "keep\n");
		const { ok, lines } = await install({ ...s.opts, repoRoot: app });
		assert.equal(ok, false);
		assert.ok(lines.includes(`app: failed:not a repo checkout ${app}`), lines.join("\n"));
		assert.equal(fs.readFileSync(path.join(app, "keep.txt"), "utf8"), "keep\n");
	} finally {
		s.tmp.cleanup();
	}
});

test("a refused repoRoot never stops or writes over a running server", async () => {
	const s = setup();
	try {
		s.fetch.state.healthy = true;
		const app = path.join(s.home, "app");
		fs.mkdirSync(app, { recursive: true });
		fs.writeFileSync(path.join(app, "keep.txt"), "keep\n");
		const { ok, lines } = await install({ ...s.opts, repoRoot: app });
		assert.equal(ok, false);
		assert.ok(lines.includes(`app: failed:not a repo checkout ${app}`), lines.join("\n"));
		// the refused install must not have reached step 0 at all.
		assert.equal(s.fetch.calls.some((call) => call.url.endsWith("/api/shutdown")), false);
		assert.equal(s.fetch.calls.some((call) => call.url.endsWith("/api/health")), false);
		assert.equal(fs.readFileSync(path.join(app, "keep.txt"), "utf8"), "keep\n");
		assert.equal(s.spawn.calls.length, 0);
	} finally {
		s.tmp.cleanup();
	}
});

/** Flip the case of the first ASCII letter so a win32 path names the same directory. */
function swapCase(target) {
	const at = target.search(/[a-zA-Z]/);
	if (at === -1) return target;
	const ch = target[at];
	const flipped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
	return target.slice(0, at) + flipped + target.slice(at + 1);
}

/** Make <home>/app look like a real checkout, so a refusal can only come from the path guard. */
function seedAppCheckout(app) {
	fs.mkdirSync(path.join(app, "src"), { recursive: true });
	fs.writeFileSync(path.join(app, "src", "server.mjs"), "export {};\n");
	fs.writeFileSync(path.join(app, "keep.txt"), "keep\n");
}

test("a repoRoot naming <home>/app in a different letter case is refused before any shutdown", async (t) => {
	if (process.platform !== "win32") {
		t.skip("case-insensitive path identity is a win32 property");
		return;
	}
	const s = setup();
	try {
		const app = path.join(s.home, "app");
		seedAppCheckout(app);
		s.fetch.state.healthy = true;
		const repoRoot = swapCase(app);
		assert.notEqual(repoRoot, app);
		const { ok, lines } = await install({ ...s.opts, repoRoot });
		assert.equal(ok, false);
		assert.ok(lines.includes(`app: failed:not a repo checkout ${repoRoot}`), lines.join("\n"));
		assert.equal(s.fetch.calls.some((call) => call.url.endsWith("/api/shutdown")), false);
		assert.equal(s.fetch.calls.some((call) => call.url.endsWith("/api/health")), false);
		assert.equal(fs.readFileSync(path.join(app, "keep.txt"), "utf8"), "keep\n");
		assert.equal(s.spawn.calls.length, 0);
	} finally {
		s.tmp.cleanup();
	}
});

test("a repoRoot reached through a junction into <home>/app is refused before any shutdown", async (t) => {
	const s = setup();
	const link = path.join(s.tmp.home, "app-link");
	try {
		const app = path.join(s.home, "app");
		seedAppCheckout(app);
		try {
			fs.symlinkSync(app, link, "junction");
		} catch (error) {
			// e.g. a locked-down Windows box where reparse points are unavailable.
			t.skip(`junction unavailable: ${error.message}`);
			return;
		}
		s.fetch.state.healthy = true;
		const { ok, lines } = await install({ ...s.opts, repoRoot: link });
		assert.equal(ok, false);
		assert.ok(lines.includes(`app: failed:not a repo checkout ${link}`), lines.join("\n"));
		assert.equal(s.fetch.calls.some((call) => call.url.endsWith("/api/shutdown")), false);
		assert.equal(fs.readFileSync(path.join(app, "keep.txt"), "utf8"), "keep\n");
		assert.equal(s.spawn.calls.length, 0);
	} finally {
		fs.rmSync(link, { recursive: true, force: true });
		s.tmp.cleanup();
	}
});

test("uninstall removes extension, skill, rule and Run value, and keeps data", async () => {
	const s = setup();
	try {
		await install(s.opts);
		fs.mkdirSync(path.join(s.home, "data", "proposals"), { recursive: true });
		fs.writeFileSync(path.join(s.home, "data", "keep.json"), "{}\n");
		const { ok, lines } = await uninstall(s.opts);
		assert.equal(ok, true, lines.join("\n"));
		assert.equal(lineFor(lines, "server"), "server: stopped");
		assert.equal(lineFor(lines, "autostart"), "autostart: removed");
		assert.equal(lineFor(lines, "extension"), "extension: removed");
		assert.equal(lineFor(lines, "skill"), "skill: removed");
		assert.equal(lineFor(lines, "rule"), "rule: removed");
		assert.equal(lineFor(lines, "tailscale"), "tailscale: off");
		assert.equal(lineFor(lines, "app"), "app: removed");
		assert.ok(lines.some((line) => line === `data kept: ${path.join(s.home, "data")}`));

		assert.equal(s.reg.values.has(RUN_VALUE), false);
		assert.equal(fs.existsSync(path.join(s.agent, "extensions", "omo-inbox")), false);
		assert.equal(fs.existsSync(path.join(s.agent, "extensions", "omo-inbox.ts")), false);
		assert.equal(fs.existsSync(path.join(s.userHome, ".agents", "skills", "visual-board")), false);
		assert.equal(fs.existsSync(path.join(s.userHome, ".claude", "skills", "visual-board")), false);
		assert.equal(fs.existsSync(path.join(s.userHome, ".claude", "rules", "visual-board.md")), false);
		assert.equal(fs.existsSync(path.join(s.home, "app")), false);
		assert.equal(fs.existsSync(path.join(s.home, "launch-hidden.vbs")), false);
		assert.equal(fs.existsSync(path.join(s.home, "config.json")), false);
		assert.equal(fs.existsSync(path.join(s.home, "server.json")), false);
		assert.deepEqual(fs.readFileSync(path.join(s.home, "data", "keep.json"), "utf8"), "{}\n");
	} finally {
		s.tmp.cleanup();
	}
});

test("doctor passes after install and fails a missing extension copy", async () => {
	const s = setup();
	try {
		await install(s.opts);
		const good = await doctor(s.opts);
		assert.equal(good.ok, true, good.lines.join("\n"));
		assert.ok(good.lines.every((line) => line.includes(": ok")), good.lines.join("\n"));

		fs.rmSync(path.join(s.agent, "extensions", "omo-inbox"), { recursive: true });
		const bad = await doctor(s.opts);
		assert.equal(bad.ok, false);
		assert.ok(bad.lines.some((line) => line.startsWith("extension: fail")), bad.lines.join("\n"));
	} finally {
		s.tmp.cleanup();
	}
});

// ---- task 19: modes (C2), the trial skill/rule skip and the takeover record ----------------------

/** A desk install that install can detect: its bin exists until a test writes `disabled`. */
function deskSeam(root) {
	const home = path.join(root, "desk");
	fs.mkdirSync(path.join(home, "app", "bin"), { recursive: true });
	fs.writeFileSync(path.join(home, "app", "bin", "desk.mjs"), "export {};\n");
	return home;
}

test("an active desk selects trial, which writes no skill or rule", async () => {
	const s = setup();
	const deskHome = deskSeam(s.tmp.home);
	const env = { ...s.env, INBOX_DESK_HOME: deskHome };
	try {
		const { ok, lines } = await install({ ...s.opts, env });
		assert.equal(ok, true, lines.join("\n"));
		assert.equal(lineFor(lines, "mode"), "mode: trial");
		assert.equal(lineFor(lines, "skill"), "skill: skipped (trial)");
		assert.equal(lineFor(lines, "rule"), "rule: skipped (trial)");
		assert.equal(JSON.parse(fs.readFileSync(path.join(s.home, "config.json"), "utf8")).mode, "trial");
		assert.equal(fs.existsSync(path.join(s.userHome, ".agents", "skills", "visual-board")), false);
		assert.equal(fs.existsSync(path.join(s.userHome, ".claude", "rules", "visual-board.md")), false);

		// a disabled desk leaves the field to inbox
		fs.writeFileSync(path.join(deskHome, "disabled"), "disabled\n");
		const primary = await install({ ...s.opts, env });
		assert.equal(primary.ok, true, primary.lines.join("\n"));
		assert.equal(lineFor(primary.lines, "mode"), "mode: primary");
		assert.equal(lineFor(primary.lines, "skill"), "skill: written");
		assert.equal(lineFor(primary.lines, "rule"), "rule: written");
	} finally {
		s.tmp.cleanup();
	}
});

test("uninstall in trial mode leaves desk's skill and rule alone", async () => {
	const s = setup();
	const deskHome = deskSeam(s.tmp.home);
	const env = { ...s.env, INBOX_DESK_HOME: deskHome };
	try {
		await install({ ...s.opts, env });
		fs.mkdirSync(path.join(s.userHome, ".agents", "skills", "visual-board"), { recursive: true });
		fs.writeFileSync(path.join(s.userHome, ".agents", "skills", "visual-board", "SKILL.md"), "desk\n");
		fs.mkdirSync(path.join(s.userHome, ".claude", "rules"), { recursive: true });
		fs.writeFileSync(path.join(s.userHome, ".claude", "rules", "visual-board.md"), "desk rule\n");
		const { ok, lines } = await uninstall({ ...s.opts, env });
		assert.equal(ok, true, lines.join("\n"));
		assert.equal(lineFor(lines, "skill"), "skill: skipped (trial)");
		assert.equal(lineFor(lines, "rule"), "rule: skipped (trial)");
		assert.equal(fs.readFileSync(path.join(s.userHome, ".agents", "skills", "visual-board", "SKILL.md"), "utf8"), "desk\n");
		assert.equal(fs.readFileSync(path.join(s.userHome, ".claude", "rules", "visual-board.md"), "utf8"), "desk rule\n");
	} finally {
		s.tmp.cleanup();
	}
});

test("doctor checks skill and rule only in primary mode", async () => {
	const s = setup();
	const deskHome = deskSeam(s.tmp.home);
	const env = { ...s.env, INBOX_DESK_HOME: deskHome };
	const configFile = path.join(s.home, "config.json");
	try {
		await install({ ...s.opts, env });
		const trial = await doctor({ ...s.opts, env });
		assert.equal(trial.ok, true, trial.lines.join("\n"));
		assert.equal(trial.lines.some((line) => line.startsWith("skill:")), false, trial.lines.join("\n"));
		assert.equal(trial.lines.some((line) => line.startsWith("rule:")), false, trial.lines.join("\n"));
		assert.equal(trial.lines.some((line) => line.startsWith("takeover:")), false, trial.lines.join("\n"));

		// primary with an active desk and no takeover record is a fail; the record settles it
		const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
		fs.writeFileSync(configFile, JSON.stringify({ ...config, mode: "primary" }));
		const bad = await doctor({ ...s.opts, env });
		assert.equal(bad.ok, false);
		assert.equal(lineFor(bad.lines, "takeover"), "takeover: fail no takeover record and an active desk");
		fs.writeFileSync(path.join(s.home, "takeover.json"), "{}\n");
		const recorded = await doctor({ ...s.opts, env });
		assert.equal(lineFor(recorded.lines, "takeover"), "takeover: ok");
	} finally {
		s.tmp.cleanup();
	}
});

test("tailscale.status parses a Running tailnet and nulls a stopped one", () => {
	const running = fakeTailscale();
	assert.deepEqual(status(running.runner), {
		publicBase: `https://${DNS}:4388`,
		pcTailnetIps: ["100.1.2.3", "fd7a::1"],
		owner: "me@example.com",
		dns: DNS,
	});
	const stopped = fakeTailscale({ running: false });
	assert.deepEqual(status(stopped.runner), { publicBase: null, pcTailnetIps: [], owner: null, dns: null });
	assert.deepEqual(status(() => ({ status: 1, stdout: "", stderr: "not found" })), { publicBase: null, pcTailnetIps: [], owner: null, dns: null });
});

test("tailscale.serveOn and serveOff issue the contracted commands", () => {
	const ts = fakeTailscale();
	serveOn(ts.runner);
	serveOff(ts.runner);
	assert.deepEqual(ts.calls[0], ["serve", "--bg", "--https=4388", PROXY]);
	assert.deepEqual(ts.calls[1], ["serve", "--https=4388", "off"]);
});

test("tailscale.guard accepts a preserved 443 and rejects drift", () => {
	const baseline = { Web: { [`${DNS}:443`]: { Handlers: {} } }, AllowFunnel: {}, TCP: { "443": { TCPForward: "x" } } };
	const after = {
		Web: { [`${DNS}:443`]: { Handlers: {} }, [`${DNS}:4388`]: { Handlers: { "/": { Proxy: PROXY } } } },
		AllowFunnel: {},
		TCP: { "443": { TCPForward: "x" } },
	};
	assert.equal(guard(baseline, after, DNS), true);
	assert.equal(guard(baseline, after, DNS, { proxy: null }), true);
	const webDrift = { ...after, Web: { ...after.Web, [`${DNS}:443`]: { Handlers: { "/": { Proxy: "x" } } } } };
	assert.equal(guard(baseline, webDrift, DNS), false);
	const funnelDrift = { ...after, AllowFunnel: { [`${DNS}:4388`]: true } };
	assert.equal(guard(baseline, funnelDrift, DNS), false);
	const tcpDrift = { ...after, TCP: {} };
	assert.equal(guard(baseline, tcpDrift, DNS), false);
	const proxyDrift = { ...after, Web: { ...after.Web, [`${DNS}:4388`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9" } } } } };
	assert.equal(guard(baseline, proxyDrift, DNS), false);
});
