import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { closeTabAfterExit } from "../src/tabclose.mjs";

function fakeSpawn({ code = 0, error = null } = {}) {
	const calls = [];
	const impl = (cmd, args, options) => {
		const child = new EventEmitter();
		calls.push({ cmd, args, options, child });
		process.nextTick(() => {
			if (error) child.emit("error", error);
			else child.emit("close", code);
		});
		return child;
	};
	return { calls, impl };
}

function aliveSequence(values) {
	const queue = [...values];
	return () => (queue.length > 1 ? queue.shift() : queue[0]);
}

const immediate = async () => {};

test("closes the Orca tab once the process exits with the exact argv", async () => {
	const fake = fakeSpawn({ code: 0 });
	const waits = [];
	const result = await closeTabAfterExit({
		pid: 1234,
		terminal: "term_abc-1.2:3",
		orcaPath: "C:/bin/orca.exe",
		isAlive: aliveSequence([true, true, false]),
		wait: async (ms) => { waits.push(ms); },
		spawnImpl: fake.impl,
	});
	assert.equal(result, "closed");
	assert.deepEqual(waits, [200, 200]);
	assert.equal(fake.calls.length, 1);
	assert.equal(fake.calls[0].cmd, "C:/bin/orca.exe");
	assert.deepEqual(fake.calls[0].args, ["terminal", "close", "--terminal", "term_abc-1.2:3", "--tab", "--json"]);
	assert.deepEqual(fake.calls[0].options, { windowsHide: true, stdio: "ignore" });
});

test("still alive past the deadline returns timeout without spawning", async () => {
	const fake = fakeSpawn();
	let waits = 0;
	const result = await closeTabAfterExit({
		pid: 1234,
		terminal: "term_abc",
		orcaPath: "C:/bin/orca.exe",
		isAlive: () => true,
		wait: async () => { waits += 1; },
		spawnImpl: fake.impl,
		intervalMs: 200,
		maxWaitMs: 400,
	});
	assert.equal(result, "timeout");
	assert.equal(waits, 2);
	assert.equal(fake.calls.length, 0);
});

test("rejects a handle with terminal syntax", async () => {
	const fake = fakeSpawn();
	const result = await closeTabAfterExit({
		pid: 1234,
		terminal: "a b",
		orcaPath: "C:/bin/orca.exe",
		isAlive: () => false,
		wait: immediate,
		spawnImpl: fake.impl,
	});
	assert.equal(result, "bad_terminal");
	assert.equal(fake.calls.length, 0);
	for (const bad of ["", "a".repeat(121), "a;b", 'a"b']) {
		assert.equal(await closeTabAfterExit({ pid: 1, terminal: bad, orcaPath: "orca", isAlive: () => false, wait: immediate, spawnImpl: fake.impl }), "bad_terminal");
	}
});

test("non-zero exit or spawn error returns failed", async () => {
	const nonzero = fakeSpawn({ code: 1 });
	assert.equal(await closeTabAfterExit({
		pid: 1234, terminal: "term_abc", orcaPath: "orca",
		isAlive: () => false, wait: immediate, spawnImpl: nonzero.impl,
	}), "failed");
	const erroring = fakeSpawn({ error: new Error("spawn ENOENT") });
	assert.equal(await closeTabAfterExit({
		pid: 1234, terminal: "term_abc", orcaPath: "orca",
		isAlive: () => false, wait: immediate, spawnImpl: erroring.impl,
	}), "failed");
	const throwing = () => { throw new Error("spawn ENOENT"); };
	assert.equal(await closeTabAfterExit({
		pid: 1234, terminal: "term_abc", orcaPath: "orca",
		isAlive: () => false, wait: immediate, spawnImpl: throwing,
	}), "failed");
});
