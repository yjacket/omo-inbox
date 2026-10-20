import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { homeDir } from "../src/paths.mjs";
import { SERVER_NODE_ARGS, launchServer } from "../src/launch.mjs";

function fakeSpawn(plan) {
	const calls = [];
	const impl = (cmd, args, options) => {
		const call = { cmd, args, options };
		calls.push(call);
		const step = plan(call, calls.length) ?? {};
		const child = new EventEmitter();
		child.pid = step.pid;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {
			call.killed = true;
		};
		child.unref = () => {
			call.unrefed = true;
		};
		if (step.error !== undefined) {
			process.nextTick(() => child.emit("error", step.error));
		}
		if (step.close !== undefined) {
			process.nextTick(() => {
				if (step.out !== undefined) child.stdout.emit("data", step.out);
				child.emit("close", step.close);
			});
		}
		return child;
	};
	return { impl, calls };
}

test("an OMO_INBOX_ env key keeps the plain detached spawn with the server node args", async () => {
	const tmp = makeTmpHome();
	try {
		const env = { OMO_INBOX_HOME: tmp.home };
		const fake = fakeSpawn(() => ({ pid: 4321 }));
		const result = await launchServer({ env, platform: "win32", spawnImpl: fake.impl });
		assert.equal(result.via, "spawn");
		assert.equal(result.pid, 4321);
		assert.equal(fake.calls.length, 1);
		const [call] = fake.calls;
		assert.equal(call.cmd, process.execPath);
		assert.deepEqual(call.args, [...SERVER_NODE_ARGS, path.join(tmp.home, "app", "src", "server.mjs")]);
		assert.equal(call.options.detached, true);
		assert.equal(call.options.stdio, "ignore");
		assert.equal(call.options.windowsHide, true);
		assert.equal(call.options.cwd, homeDir(env));
		assert.equal(call.options.env, env);
		assert.equal(call.unrefed, true);
	} finally {
		tmp.cleanup();
	}
});

test("win32 without INBOX_/OMO_INBOX_ env creates the process through WMI", async () => {
	const tmp = makeTmpHome();
	try {
		const fake = fakeSpawn(() => ({ out: "0 1234\n", close: 0 }));
		const env = {};
		const result = await launchServer({ env, platform: "win32", home: tmp.home, spawnImpl: fake.impl });
		assert.deepEqual(result, { via: "wmi", pid: 1234 });
		assert.equal(fake.calls.length, 1);
		const [call] = fake.calls;
		assert.equal(call.cmd, "powershell.exe");
		assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
		assert.match(call.args[3], /INBOX_LAUNCH_CMD/);
		assert.match(call.args[3], /Win32_Process/);
		assert.match(call.options.env.INBOX_LAUNCH_CMD, /--max-semi-space-size=1/);
		assert.match(call.options.env.INBOX_LAUNCH_CMD, /--max-old-space-size=128/);
		assert.match(call.options.env.INBOX_LAUNCH_CMD, /server\.mjs/);
		assert.equal(call.options.env.INBOX_LAUNCH_CWD, tmp.home);
	} finally {
		tmp.cleanup();
	}
});

test("a WMI failure falls back to the plain spawn and reports wmiError", async () => {
	const tmp = makeTmpHome();
	try {
		const fake = fakeSpawn((call) => (call.cmd === "powershell.exe" ? { out: "9 0\n", close: 0 } : { pid: 777 }));
		const env = {};
		const result = await launchServer({ env, platform: "win32", home: tmp.home, spawnImpl: fake.impl });
		assert.equal(result.via, "spawn");
		assert.equal(result.pid, 777);
		assert.equal(typeof result.wmiError, "string");
		assert.equal(fake.calls.length, 2);
		assert.equal(fake.calls[1].cmd, process.execPath);
		assert.deepEqual(fake.calls[1].args.slice(0, SERVER_NODE_ARGS.length), SERVER_NODE_ARGS);
		assert.equal(fake.calls[1].options.detached, true);
		assert.equal(fake.calls[1].options.cwd, tmp.home);
	} finally {
		tmp.cleanup();
	}
});

test("a child 'error' event stays caught and the spawn result still resolves", async () => {
	const tmp = makeTmpHome();
	try {
		const fake = fakeSpawn(() => ({ pid: 55, error: new Error("spawn boom") }));
		const result = await launchServer({ env: {}, home: tmp.home, platform: "linux", spawnImpl: fake.impl });
		assert.equal(result.via, "spawn");
		assert.equal(result.pid, 55);
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		tmp.cleanup();
	}
});

test("a child 'error' event is appended to <home>/logs/launch.log", async () => {
	const tmp = makeTmpHome();
	try {
		const env = { OMO_INBOX_HOME: tmp.home };
		const fake = fakeSpawn(() => ({ pid: 55, error: new Error("spawn boom") }));
		const result = await launchServer({ env, platform: "linux", spawnImpl: fake.impl });
		assert.equal(result.via, "spawn");
		await new Promise((resolve) => setImmediate(resolve));
		const log = fs.readFileSync(path.join(tmp.home, "logs", "launch.log"), "utf8");
		assert.match(log, /spawn boom/);
	} finally {
		tmp.cleanup();
	}
});

test("a non-win32 platform uses the plain spawn without powershell", async () => {
	const tmp = makeTmpHome();
	try {
		const fake = fakeSpawn(() => ({ pid: 99 }));
		const script = "/srv/inbox/src/server.mjs";
		const result = await launchServer({ env: {}, home: tmp.home, platform: "linux", script, spawnImpl: fake.impl });
		assert.equal(result.via, "spawn");
		assert.equal(fake.calls.length, 1);
		assert.equal(fake.calls[0].cmd, process.execPath);
		assert.deepEqual(fake.calls[0].args, [...SERVER_NODE_ARGS, script]);
	} finally {
		tmp.cleanup();
	}
});
