import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { DEFAULT_PORT, TAILNET_PORT, agentDir, homeDir, layout, readConfig, safeSegment } from "../src/paths.mjs";

test("ports are the documented defaults", () => {
	assert.equal(DEFAULT_PORT, 4387);
	assert.equal(TAILNET_PORT, 4388);
});

test("homeDir prefers OMO_INBOX_HOME and otherwise uses ~/.omo-inbox", () => {
	assert.equal(homeDir({ OMO_INBOX_HOME: "C:/x" }), "C:/x");
	assert.equal(homeDir({}), path.join(os.homedir(), ".omo-inbox"));
});

test("layout puts every path under the resolved home", () => {
	const tmp = makeTmpHome();
	try {
		const l = layout({ OMO_INBOX_HOME: tmp.home });
		assert.deepEqual(Object.keys(l).sort(), ["app", "config", "data", "home", "launcher", "logs", "mailbox", "proposals", "push", "serverJson"].sort());
		assert.equal(l.home, tmp.home);
		assert.equal(l.app, path.join(tmp.home, "app"));
		assert.equal(l.data, path.join(tmp.home, "data"));
		assert.equal(l.proposals, path.join(tmp.home, "data", "proposals"));
		assert.equal(l.mailbox, path.join(tmp.home, "mailbox"));
		assert.equal(l.logs, path.join(tmp.home, "logs"));
		assert.equal(l.push, path.join(tmp.home, "push"));
		assert.equal(l.config, path.join(tmp.home, "config.json"));
		assert.equal(l.serverJson, path.join(tmp.home, "server.json"));
		assert.equal(l.launcher, path.join(tmp.home, "launch-hidden.vbs"));
	} finally {
		tmp.cleanup();
	}
});

test("readConfig returns the default when config.json is missing", () => {
	const tmp = makeTmpHome();
	try {
		assert.deepEqual(readConfig({ OMO_INBOX_HOME: tmp.home }), { v: 1, port: 4387, publicBase: null, pcTailnetIps: [], owner: null });
	} finally {
		tmp.cleanup();
	}
});

test("readConfig strips a BOM and parses the file", () => {
	const tmp = makeTmpHome();
	try {
		fs.writeFileSync(path.join(tmp.home, "config.json"), "\uFEFF" + JSON.stringify({ v: 1, port: 5000, publicBase: null, pcTailnetIps: [], owner: null }));
		assert.equal(readConfig({ OMO_INBOX_HOME: tmp.home }).port, 5000);
	} finally {
		tmp.cleanup();
	}
});

test("readConfig falls back to the default on broken JSON", () => {
	const tmp = makeTmpHome();
	try {
		fs.writeFileSync(path.join(tmp.home, "config.json"), "{broken");
		assert.deepEqual(readConfig({ OMO_INBOX_HOME: tmp.home }), { v: 1, port: 4387, publicBase: null, pcTailnetIps: [], owner: null });
	} finally {
		tmp.cleanup();
	}
});

test("agentDir prefers OMO, then SENPI, then PI, then ~/.omo/agent", () => {
	assert.equal(agentDir({ OMO_CODING_AGENT_DIR: "a", SENPI_CODING_AGENT_DIR: "b", PI_CODING_AGENT_DIR: "c" }), "a");
	assert.equal(agentDir({ SENPI_CODING_AGENT_DIR: "b", PI_CODING_AGENT_DIR: "c" }), "b");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "c" }), "c");
	assert.equal(agentDir({}), path.join(os.homedir(), ".omo", "agent"));
});

test("safeSegment replaces everything outside the allowed set and caps at 120 chars", () => {
	assert.equal(safeSegment("a/b c\\d:응"), "a_b_c_d__");
	assert.equal(safeSegment("keep.A-Z_09-"), "keep.A-Z_09-");
	assert.equal(safeSegment("x".repeat(200)).length, 120);
});

test("targets.json parses with the five contracted targets", () => {
	const file = fileURLToPath(new URL("../web/targets.json", import.meta.url));
	const targets = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.deepEqual(targets.map((t) => t.id), ["chatgpt", "claude", "claude-app", "aside", "copy"]);
	assert.equal(targets.length, 5);
});
