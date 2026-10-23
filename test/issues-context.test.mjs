import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateCreate } from "../src/issues-contract.mjs";
import {
	attachLate,
	createGenerationOwner,
	describeUnavailable,
	freezeCapture,
	onDiscard,
} from "../web/issue-context.js";

const UUID = "00000000-0000-4000-8000-000000000001";
const OBSERVED = "2026-10-23T12:34:56.789Z";
const NOW_MS = 1729692896789;

function input(overrides = {}) {
	return {
		page: "proposal",
		source: {
			kind: "proposal",
			proposalId: "decision-1",
			revision: 1,
			observedSeq: 7,
			recordedContentHash: null,
			frame: { label: "frame", path: "frame.png" },
		},
		target: {
			kind: "record",
			key: "card:q1",
			label: "결정 카드",
			rect: { x: 10, y: 20, w: 300, h: 120 },
			framePath: ["thread-frame-1"],
		},
		view: {
			width: 390,
			height: 844,
			dpr: 2,
			scale: 1,
			scrollX: 0,
			scrollY: 40,
			theme: "light",
			locale: "ko-KR",
			embedded: false,
			viewerOpen: false,
		},
		excerpt: "rev1 text",
		excerptEnabled: true,
		visibleIds: ["item-1", "item-2"],
		diagnostics: [{ type: "action", atMs: -1200, name: "open_report" }],
		clientBuild: { kind: "page_response_manifest", version: "1.0.0", digest: "a".repeat(64) },
		observedAt: OBSERVED,
		uuid: () => UUID,
		now: () => NOW_MS,
		...overrides,
	};
}

function utf8Length(value) {
	return new TextEncoder().encode(value).length;
}

test("freezeCapture deep-copies, freezes and ignores later input mutation", () => {
	const source = input();
	const frozen = freezeCapture(source);
	const before = JSON.stringify(frozen);
	assert.equal(frozen.source.revision, 1);
	assert.equal(frozen.excerpt, "rev1 text");
	assert.ok(Object.isFrozen(frozen));
	assert.ok(Object.isFrozen(frozen.source));
	assert.ok(Object.isFrozen(frozen.source.frame));
	assert.ok(Object.isFrozen(frozen.target.rect));
	assert.ok(Object.isFrozen(frozen.view));
	assert.ok(Object.isFrozen(frozen.diagnostics[0]));
	assert.ok(Object.isFrozen(frozen.visibleIds));

	source.source.revision = 2;
	source.source.frame.label = "changed";
	source.target.rect.w = 999;
	source.view.width = 1;
	source.excerpt = "rev2 text";
	source.visibleIds.push("item-3");
	source.diagnostics[0].name = "issue_submit";
	delete source.source.frame;

	assert.equal(JSON.stringify(frozen), before);
	assert.equal(frozen.source.revision, 1);
	assert.equal(frozen.excerpt, "rev1 text");
	assert.equal(frozen.target.rect.w, 300);
	assert.throws(() => {
		frozen.source.revision = 3;
	}, TypeError);
});

test("excerpt clips at the 8192-byte boundary without splitting a code point", () => {
	const text = "가".repeat(2731); // 8193 UTF-8 bytes
	const frozen = freezeCapture(input({ excerpt: text }));
	assert.equal(frozen.excerptTruncated, true);
	assert.equal(utf8Length(frozen.excerpt), 8190);
	assert.equal(Array.from(frozen.excerpt).length, 2730);
	assert.ok(!frozen.excerpt.includes("\uFFFD"));
	assert.ok(frozen.excerpt.endsWith("가"));

	const exact = `${"나".repeat(2730)}a`; // 8191 bytes: still over after one code point
	const clipped = freezeCapture(input({ excerpt: `${exact.slice(0, 2730)}😀` })); // 8190 + 4 bytes
	assert.equal(clipped.excerptTruncated, true);
	assert.equal(clipped.excerpt, "나".repeat(2730));
	assert.equal(utf8Length(clipped.excerpt), 8190);

	const disabled = freezeCapture(input({ excerptEnabled: false }));
	assert.equal(disabled.excerpt, null);
	assert.equal(disabled.excerptTruncated, false);
});

test("unknown keys are dropped and malformed targets/views stay finite", () => {
	const frozen = freezeCapture(
		input({
			evil: "top-level",
			source: { ...input().source, evil: "source" },
			target: {
				kind: "record",
				key: "k",
				label: "l",
				rect: { x: Number.NaN, y: Infinity, w: -1, h: 10 },
				framePath: ["frame-1", "frame-2"],
				evil: "target",
			},
			view: { ...input().view, evil: "view" },
		}),
	);
	const serialized = JSON.stringify(frozen);
	assert.ok(!serialized.includes("evil"));
	assert.ok(!("evil" in frozen));
	assert.ok(!("evil" in frozen.source));
	assert.ok(!("evil" in frozen.target));
	assert.ok(!("evil" in frozen.view));
	assert.equal(frozen.target.rect.x, 0);
	assert.equal(frozen.target.rect.y, 0);
	assert.equal(frozen.target.rect.w, 0);
	assert.equal(frozen.target.rect.h, 10);
	for (const value of Object.values(frozen.target.rect)) assert.ok(Number.isFinite(value));
	assert.deepEqual(frozen.target.framePath, ["frame-1"]);
	assert.equal(frozen.contextStatus, "partial");
});

test("describeUnavailable never upgrades to latest data", () => {
	const frozen = describeUnavailable("no_adapter", { uuid: () => UUID, now: () => NOW_MS });
	assert.equal(frozen.contextStatus, "unavailable");
	assert.equal(frozen.source, null);
	assert.equal(frozen.excerpt, null);
	assert.equal(frozen.excerptTruncated, false);
	assert.deepEqual(frozen.visibleIds, []);
	assert.deepEqual(frozen.diagnostics, []);
	assert.deepEqual(frozen.visual, { kind: "none", reason: "not_requested" });
	assert.ok(Object.isFrozen(frozen));
});

test("uuid and now are required injections and the module reads no platform globals", () => {
	assert.throws(() => freezeCapture(input({ uuid: undefined })), TypeError);
	assert.throws(() => freezeCapture(input({ now: undefined })), TypeError);
	assert.throws(() => describeUnavailable("no_adapter", { uuid: () => UUID }), TypeError);
	assert.throws(() => describeUnavailable("no_adapter", { now: () => NOW_MS }), TypeError);
	assert.throws(() => freezeCapture(input({ uuid: () => "not-a-uuid" })), TypeError);
	const source = readFileSync(new URL("../web/issue-context.js", import.meta.url), "utf8");
	assert.ok(!/\bglobalThis\b|\bnew\s+Date\b|\bcrypto\s*\.|\bdocument\s*\.|\bwindow\s*\.|\blocalStorage\b|\bsessionStorage\b|\bfetch\s*\(/.test(source));
	assert.ok(!/^\s*import\s/m.test(source), "web module has no imports");
	const at = freezeCapture(input({ observedAt: undefined }));
	assert.equal(at.observedAt, "2024-10-23T14:14:56.789Z");
});

test("script diagnostics use the contract error-class and basename allowlists", () => {
	const diagnostics = [
		{ type: "script", atMs: -10, file: "issue-context.js", line: 3, column: 9, errorClass: "ResourceError" },
		{ type: "script", atMs: -9, file: "inbox-inline", line: 1, column: 1, errorClass: "UnhandledRejection" },
		{ type: "script", atMs: -8, file: "board.js", line: 2, column: 2, errorClass: "Other" },
		{ type: "script", atMs: -7, file: "https://h.example/x.js?token=abc", line: 4, column: 5, errorClass: "Error" },
	];
	const frozen = freezeCapture(input({ diagnostics }));
	assert.equal(frozen.diagnostics.length, 4);
	assert.deepEqual(frozen.diagnostics.map((entry) => entry.errorClass), ["ResourceError", "UnhandledRejection", "other", "Error"]);
	assert.deepEqual(frozen.diagnostics.map((entry) => entry.file), ["issue-context.js", "inbox-inline", "board.js", "other"]);
	assert.ok(!JSON.stringify(frozen).includes("h.example"));
	assert.equal(frozen.contextStatus, "captured");
});

test("visible ids are bound to 1..200 bytes and oversized context is normalized", () => {
	const frozen = freezeCapture(input({ visibleIds: ["", "x".repeat(300), "ok-id"] }));
	assert.deepEqual(frozen.visibleIds, ["ok-id"]);
	assert.equal(frozen.contextStatus, "partial");
	const many = freezeCapture(input({ visibleIds: Array.from({ length: 60 }, (_, index) => `id-${index}`) }));
	assert.equal(many.visibleIds.length, 50);
	const escaped = freezeCapture(input({ excerpt: "\u0001".repeat(8192) }));
	assert.ok(Buffer.byteLength(JSON.stringify(escaped), "utf8") <= 32768);
	assert.equal(escaped.excerptTruncated, true);
	assert.equal(escaped.contextStatus, "partial");
	const body = {
		v: 1,
		storeId: UUID,
		requestId: "00000000-0000-4000-8000-000000000002",
		description: "report",
		evidence: frozen,
	};
	const valid = validateCreate(body);
	assert.equal(valid.ok, true, JSON.stringify(valid.fields));
	const escapedBody = { ...body, evidence: escaped };
	assert.equal(validateCreate(escapedBody).ok, true, JSON.stringify(validateCreate(escapedBody).fields));
});

test("malformed source and target normalize to partial instead of invalid envelopes", () => {
	const body = (evidence) => ({
		v: 1,
		storeId: UUID,
		requestId: "00000000-0000-4000-8000-000000000002",
		description: "report",
		evidence,
	});
	const badIssue = freezeCapture(input({ source: { kind: "issue", issueId: "not-a-uuid", observedSeq: 1 } }));
	assert.equal(badIssue.source, null);
	assert.equal(badIssue.contextStatus, "partial");
	assert.equal(validateCreate(body(badIssue)).ok, true);
	const badTarget = freezeCapture(input({ target: { kind: "record", label: "label", rect: { x: 0, y: 0, w: 1, h: 1 }, framePath: [] } }));
	assert.equal(badTarget.target, null);
	assert.equal(badTarget.contextStatus, "partial");
	assert.equal(validateCreate(body(badTarget)).ok, true);
});

test("clipping replaces a lone surrogate instead of emitting invalid UTF-16", () => {
	const frozen = freezeCapture(input({ excerpt: "a\ud83d" }));
	assert.equal(frozen.excerpt, "a\uFFFD");
	assert.equal(Buffer.byteLength(frozen.excerpt, "utf8"), 4);
});

test("fractional now() is truncated to canonical millisecond UTC in both capture paths", () => {
	const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
	for (const value of [NOW_MS + 0.5, NOW_MS + 0.999, -NOW_MS - 0.5]) {
		const expected = new Date(Math.trunc(value)).toISOString();
		const frozen = freezeCapture(input({ observedAt: undefined, now: () => value }));
		const fallback = describeUnavailable("no_adapter", { uuid: () => UUID, now: () => value });
		assert.equal(frozen.observedAt, expected);
		assert.equal(fallback.observedAt, expected);
		assert.match(frozen.observedAt, canonical);
		assert.match(fallback.observedAt, canonical);
	}
	assert.throws(() => freezeCapture(input({ observedAt: undefined, now: () => Number.NaN })), TypeError);
	assert.throws(() => freezeCapture(input({ observedAt: undefined, now: () => Infinity })), TypeError);
	assert.throws(() => describeUnavailable("no_adapter", { uuid: () => UUID, now: () => Number.NEGATIVE_INFINITY }), TypeError);
});

test("begin supersedes the prior generation and runs its cleanup exactly once", () => {
	const owner = createGenerationOwner();
	const first = owner.begin();
	let cleanups = 0;
	assert.equal(onDiscard(first, () => cleanups++), true);
	const second = owner.begin();
	assert.equal(cleanups, 1);
	assert.equal(owner.current(), second);
	assert.equal(owner.isCurrent(first), false);
	assert.equal(owner.isCurrent(second), true);
	onDiscard(second, () => cleanups++);
	owner.begin();
	assert.equal(cleanups, 2, "the superseded cleanup is not run twice");
	owner.cancel(second);
	owner.cancel(first);
	assert.equal(cleanups, 2, "cancelling an already-discarded generation is a no-op");
});

test("attachLate applies only for the current generation", () => {
	const owner = createGenerationOwner();
	const gen = owner.begin();
	let applied = 0;
	let dropped = 0;
	assert.equal(attachLate(gen, owner, "value", () => applied++, () => dropped++), "applied");
	assert.deepEqual({ applied, dropped }, { applied: 1, dropped: 0 });
});

test("attachLate drops a superseded generation exactly once and never applies", () => {
	const owner = createGenerationOwner();
	const first = owner.begin();
	let cleanups = 0;
	let applied = 0;
	const dropped = [];
	onDiscard(first, () => cleanups++);
	const second = owner.begin();
	const outcome = attachLate(first, owner, "late", () => applied++, (result) => dropped.push(result));
	assert.equal(outcome, "dropped");
	assert.equal(applied, 0);
	assert.deepEqual(dropped, ["late"]);
	assert.equal(cleanups, 1);
	assert.equal(attachLate(first, owner, "late-2", () => applied++, (result) => dropped.push(result)), "dropped");
	assert.equal(applied, 0);
	assert.deepEqual(dropped, ["late", "late-2"]);
	assert.equal(cleanups, 1);
	assert.equal(owner.isCurrent(second), true);
});

test("cancel then attachLate drops and releases the generation", () => {
	const owner = createGenerationOwner();
	const gen = owner.begin();
	let cleanups = 0;
	onDiscard(gen, () => cleanups++);
	let applied = 0;
	let dropped = 0;
	owner.cancel(gen);
	assert.equal(cleanups, 1);
	assert.equal(owner.current(), null);
	assert.equal(attachLate(gen, owner, "late", () => applied++, () => dropped++), "dropped");
	assert.deepEqual({ applied, dropped }, { applied: 0, dropped: 1 });
	owner.cancel(gen);
	assert.equal(cleanups, 1);
});
