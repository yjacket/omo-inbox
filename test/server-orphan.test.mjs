import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createOrphanWatch } from "../src/server.mjs";

const GRACE = 20 * 60_000;

function setup({ meta = { channel: "package", source: "C:/src/omo-inbox" }, exists = { value: false } } = {}) {
	const { home, cleanup } = makeTmpHome();
	const clock = { t: 1_000_000 };
	const calls = [];
	const spawn = (...args) => {
		calls.push(args);
		return { unref() {} };
	};
	const watch = createOrphanWatch({
		home,
		now: () => clock.t,
		exists: () => exists.value,
		spawn,
		graceMs: GRACE,
		execPath: "NODE",
		readJson: () => meta,
	});
	return { home, cleanup, clock, calls, watch, exists };
}

test("source present -> never spawns", () => {
	const exists = { value: true };
	const s = setup({ exists });
	try {
		for (let i = 0; i < 3; i++) {
			s.watch.tick();
			s.clock.t += GRACE * 2;
		}
		assert.equal(s.calls.length, 0);
	} finally {
		s.cleanup();
	}
});

test("missing for less than grace -> no spawn", () => {
	const s = setup();
	try {
		s.watch.tick();
		s.clock.t += GRACE - 1;
		s.watch.tick();
		assert.equal(s.calls.length, 0);
	} finally {
		s.cleanup();
	}
});

test("missing for grace -> one detached uninstall spawn, not repeated", () => {
	const s = setup();
	try {
		s.watch.tick();
		s.clock.t += GRACE;
		s.watch.tick();
		assert.equal(s.calls.length, 1);
		const [cmd, args, opts] = s.calls[0];
		assert.equal(cmd, "NODE");
		assert.deepEqual(args, [path.join(s.home, "app", "bin", "inbox.mjs"), "uninstall"]);
		assert.equal(opts.detached, true);
		s.clock.t += GRACE;
		s.watch.tick();
		s.watch.tick();
		assert.equal(s.calls.length, 1);
	} finally {
		s.cleanup();
	}
});

test("source reappearing resets the grace timer", () => {
	const s = setup();
	try {
		s.watch.tick();
		s.clock.t += GRACE - 1;
		s.exists.value = true;
		s.watch.tick();
		s.exists.value = false;
		s.clock.t += 2;
		s.watch.tick();
		s.clock.t += GRACE - 1;
		s.watch.tick();
		assert.equal(s.calls.length, 0);
		s.clock.t += 1;
		s.watch.tick();
		assert.equal(s.calls.length, 1);
	} finally {
		s.cleanup();
	}
});

test("checkout channel or missing source.json -> never spawns", () => {
	for (const meta of [{ channel: "checkout", source: "C:/src/omo-inbox" }, null]) {
		const s = setup({ meta });
		try {
			s.watch.tick();
			s.clock.t += GRACE * 2;
			s.watch.tick();
			assert.equal(s.calls.length, 0);
		} finally {
			s.cleanup();
		}
	}
});
