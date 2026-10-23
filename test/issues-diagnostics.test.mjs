import assert from "node:assert/strict";
import test from "node:test";
import { ENUMS, validateCreate } from "../src/issues-contract.mjs";
import { ACTIONS, ERROR_CLASSES, ERROR_CODES, ROUTES, SCRIPT_NAMES, createDiagnostics } from "../web/issue-diagnostics.js";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const CAPTURE_ID = "33333333-3333-4333-8333-333333333333";

function envelope(diagnostics) {
	return {
		v: 1,
		storeId: STORE_ID,
		requestId: REQUEST_ID,
		description: "제보 내용",
		evidence: Object.freeze({
			captureId: CAPTURE_ID,
			observedAt: "2026-10-23T00:00:00.000Z",
			page: "inbox",
			source: null,
			target: null,
			clientBuild: null,
			view: {
				width: 390,
				height: 844,
				dpr: 1,
				scale: 1,
				scrollX: 0,
				scrollY: 0,
				theme: "light",
				locale: "ko-KR",
				embedded: false,
				viewerOpen: false,
			},
			excerpt: null,
			excerptTruncated: false,
			visibleIds: [],
			diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze({ ...entry }))),
			contextStatus: "captured",
			visual: { kind: "none", reason: "not_requested" },
		}),
	};
}

function fakeTarget() {
	const listeners = new Map();
	return {
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(listener);
		},
		removeEventListener(type, listener) {
			listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== listener));
		},
		emit(type, event) {
			for (const listener of listeners.get(type) || []) listener(event);
			return event;
		},
		count(type) {
			return (listeners.get(type) || []).length;
		},
	};
}

test("the injected clock trims entries at the window boundary", () => {
	let clock = 1000;
	const diagnostics = createDiagnostics({ now: () => clock });
	clock = 1000;
	diagnostics.recordAction("open_report");
	clock = 15000;
	diagnostics.recordAction("answer");
	clock = 31001;
	diagnostics.recordAction("approve");

	assert.deepEqual(diagnostics.snapshot(31001), [
		{ type: "action", name: "answer", atMs: -16001 },
		{ type: "action", name: "approve", atMs: 0 },
	]);
	assert.deepEqual(diagnostics.snapshot(31000), [
		{ type: "action", name: "open_report", atMs: -30000 },
		{ type: "action", name: "answer", atMs: -16000 },
	]);
});

test("the buffer keeps only the newest 30 entries", () => {
	let clock = 0;
	const diagnostics = createDiagnostics({ now: () => clock });
	const names = ["open_report", "pick_target", "open_review", "answer", "approve"];
	for (let index = 0; index < 35; index++) {
		clock = index;
		diagnostics.recordAction(names[index % names.length]);
	}
	const snapshot = diagnostics.snapshot(35);
	assert.equal(snapshot.length, 30);
	assert.equal(snapshot[0].atMs, -30);
	assert.equal(snapshot[29].atMs, -1);
	assert.deepEqual(
		snapshot.map((entry) => entry.name),
		Array.from({ length: 30 }, (_value, index) => names[(index + 5) % names.length]),
	);
});

test("requests and scripts keep only allowlisted tokens, codes and locations", () => {
	let clock = 0;
	const diagnostics = createDiagnostics({ now: () => clock++ });
	diagnostics.recordRequest({
		route: "threads_list?token=abc",
		status: 999,
		durationMs: -5,
		errorCode: "sk-SECRETTOKEN",
		url: "https://example.invalid/api?token=abc",
	});
	diagnostics.recordRequest({ route: "issue_detail", status: 404, durationMs: 12.5, errorCode: "not_found" });
	diagnostics.recordScript({ file: "https://example.invalid/web/board.js?token=abc#fragment", line: 12.9, column: -2, errorClass: "TypeError" });
	diagnostics.recordScript({ file: "https://example.invalid/secret.js?token=abc", line: "x", column: Number.NaN, errorClass: "NotAClass" });

	const snapshot = diagnostics.snapshot(4);
	assert.deepEqual(snapshot, [
		{ type: "request", route: "other", status: 599, durationMs: 0, errorCode: "other", atMs: -4 },
		{ type: "request", route: "issue_detail", status: 404, durationMs: 12.5, errorCode: "not_found", atMs: -3 },
		{ type: "script", file: "board.js", line: 12, column: 0, errorClass: "TypeError", atMs: -2 },
		{ type: "script", file: "other", line: 0, column: 0, errorClass: "other", atMs: -1 },
	]);
	const serialized = JSON.stringify(snapshot);
	for (const forbidden of ["sk-SECRETTOKEN", "token=abc", "example.invalid", "https://"]) {
		assert.equal(serialized.includes(forbidden), false, `snapshot retained ${forbidden}`);
	}
});

test("window listeners observe errors without suppressing them or reading their text", () => {
	let clock = 0;
	const diagnostics = createDiagnostics({ now: () => clock++ });
	const target = fakeTarget();
	const detach = diagnostics.attachWindowListeners(target);
	assert.equal(target.count("error"), 1);
	assert.equal(target.count("unhandledrejection"), 1);

	const errorEvent = {
		filename: "https://example.invalid/web/thread.js?token=abc",
		lineno: 7.8,
		colno: 9,
		error: new TypeError("sk-SECRETTOKEN"),
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		get message() {
			throw new Error("diagnostics read the error message");
		},
	};
	target.emit("error", errorEvent);
	assert.equal(errorEvent.defaultPrevented, false);

	const rejectionEvent = {
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		get reason() {
			throw new Error("diagnostics read the rejection reason");
		},
	};
	target.emit("unhandledrejection", rejectionEvent);
	assert.equal(rejectionEvent.defaultPrevented, false);

	detach();
	assert.equal(target.count("error"), 0);
	assert.equal(target.count("unhandledrejection"), 0);

	const snapshot = diagnostics.snapshot(2);
	assert.deepEqual(snapshot, [
		{ type: "script", file: "thread.js", line: 7, column: 9, errorClass: "TypeError", atMs: -2 },
		{ type: "script", file: "other", line: 0, column: 0, errorClass: "UnhandledRejection", atMs: -1 },
	]);
	const serialized = JSON.stringify(snapshot);
	for (const forbidden of ["sk-SECRETTOKEN", "token=abc", "example.invalid"]) {
		assert.equal(serialized.includes(forbidden), false, `snapshot retained ${forbidden}`);
	}
});

test("the vocabulary is copied verbatim from the contract and cannot be widened", () => {
	assert.deepEqual(ACTIONS, ENUMS.ACTIONS);
	assert.deepEqual(ROUTES, ENUMS.ROUTES);
	assert.deepEqual(ERROR_CODES, ENUMS.ERROR_CODES);
	assert.deepEqual(ERROR_CLASSES, ENUMS.ERROR_CLASSES);
	assert.deepEqual(SCRIPT_NAMES, ENUMS.SCRIPT_NAMES);
});

test("unknown action tokens and caller allowlists never reach the snapshot", () => {
	let clock = 0;
	const diagnostics = createDiagnostics({ now: () => clock++, actionNames: ["login sk-SECRET"] });
	diagnostics.recordAction("login sk-SECRET");
	diagnostics.recordAction("not_a_contract_action");
	diagnostics.recordAction("open_report");
	const snapshot = diagnostics.snapshot(2);
	assert.deepEqual(snapshot, [{ type: "action", name: "open_report", atMs: -2 }]);
	assert.equal(JSON.stringify(snapshot).includes("sk-SECRET"), false);
});

test("a frozen capture embedding the snapshot passes validateCreate", () => {
	let clock = 5000;
	const diagnostics = createDiagnostics({ now: () => clock });
	diagnostics.recordAction("open_report");
	clock = 5100;
	diagnostics.recordRequest({ route: "issue_create", status: 500, durationMs: 250, errorCode: "network" });
	clock = 5200;
	diagnostics.recordScript({ file: "/web/issues.js?token=abc", line: 3, column: 14, errorClass: "Error" });
	const snapshot = diagnostics.snapshot(5300);
	const capture = envelope(snapshot);
	const result = validateCreate({ ...envelope(snapshot), description: "제보 내용", evidence: capture.evidence });
	assert.equal(result.ok, true, JSON.stringify(result.fields ?? result));
	assert.deepEqual(result.value.evidence.diagnostics, snapshot);
});
