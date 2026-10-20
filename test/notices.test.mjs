import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_BODY,
	MAX_TITLE,
	isExpired,
	noticeItemInput,
	validateNotice,
} from "../src/notices.mjs";

const NOW = Date.parse("2026-10-17T12:00:00Z"); // fixed clock: never wait on real time

function base(overrides = {}) {
	return { v: 1, producer: "keepwarm", dedupeKey: "daily", title: "워밍 필요", body: "캐시가 곧 식습니다", urgency: "now", ...overrides };
}

function expectErrors(body, expected) {
	const result = validateNotice(body);
	assert.equal(result.ok, false, `expected invalid: ${JSON.stringify(body)}`);
	assert.deepEqual(result.errors, expected);
}

describe("validateNotice", () => {
	test("accepts a minimal notice and drops nothing", () => {
		const result = validateNotice(base());
		assert.equal(result.ok, true);
		assert.deepEqual(result.notice, {
			v: 1,
			producer: "keepwarm",
			dedupeKey: "daily",
			title: "워밍 필요",
			body: "캐시가 곧 식습니다",
			urgency: "now",
		});
	});

	test("accepts every optional field and keeps only known keys", () => {
		const notice = {
			...base({ urgency: "fyi" }),
			session: "sess-1",
			cwd: "C:/dev/omo/omo-inbox",
			expiresAt: "2026-10-17T12:30:00Z",
			url: "https://example.test/health",
			actions: ["ack", "open-url"],
		};
		const result = validateNotice(notice);
		assert.equal(result.ok, true);
		assert.deepEqual(result.notice, notice);
		assert.deepEqual(Object.keys(result.notice), [
			"v",
			"producer",
			"dedupeKey",
			"title",
			"body",
			"urgency",
			"session",
			"cwd",
			"expiresAt",
			"url",
			"actions",
		]);
	});

	test("allows a relative url and an empty body", () => {
		assert.equal(validateNotice(base({ url: "/boards", body: "" })).ok, true);
		assert.equal(validateNotice(base({ url: "/s/sess-1#i-251017-abc123" })).ok, true);
	});

	test("rejects a non-object payload", () => {
		expectErrors(["nope"], ["notice: must be a JSON object"]);
		expectErrors(null, ["notice: must be a JSON object"]);
		expectErrors("producer=x", ["notice: must be a JSON object"]);
	});

	test("names an unknown top-level key", () => {
		expectErrors(base({ severity: "high" }), ["severity: unknown key"]);
		expectErrors({ ...base(), sound: true, color: "red" }, ["sound: unknown key", "color: unknown key"]);
	});

	test("rejects a wrong version", () => {
		expectErrors(base({ v: 2 }), ["v: must be 1"]);
		expectErrors(base({ v: "1" }), ["v: must be 1"]);
	});

	test("validates producer", () => {
		expectErrors(base({ producer: "" }), ["producer: must match /^[a-z0-9-]{1,40}$/"]);
		expectErrors(base({ producer: "KeepWarm" }), ["producer: must match /^[a-z0-9-]{1,40}$/"]);
		expectErrors(base({ producer: "keep_warm" }), ["producer: must match /^[a-z0-9-]{1,40}$/"]);
		expectErrors(base({ producer: "a".repeat(41) }), ["producer: must match /^[a-z0-9-]{1,40}$/"]);
		assert.equal(validateNotice(base({ producer: "a".repeat(40) })).ok, true);
	});

	test("validates dedupeKey", () => {
		expectErrors(base({ dedupeKey: "" }), ["dedupeKey: must match /^[A-Za-z0-9._:-]{1,80}$/"]);
		expectErrors(base({ dedupeKey: "a b" }), ["dedupeKey: must match /^[A-Za-z0-9._:-]{1,80}$/"]);
		expectErrors(base({ dedupeKey: "a/b" }), ["dedupeKey: must match /^[A-Za-z0-9._:-]{1,80}$/"]);
		expectErrors(base({ dedupeKey: "a".repeat(81) }), ["dedupeKey: must match /^[A-Za-z0-9._:-]{1,80}$/"]);
		assert.equal(validateNotice(base({ dedupeKey: "sess:12.v2_test" })).ok, true);
	});

	test("validates title", () => {
		expectErrors(base({ title: undefined }), ["title: must be a string"]);
		expectErrors(base({ title: "" }), ["title: must be at least 1 characters"]);
		expectErrors(base({ title: "   " }), ["title: must not be blank"]);
		expectErrors(base({ title: "가".repeat(MAX_TITLE + 1) }), [`title: must be at most ${MAX_TITLE} characters`]);
		assert.equal(validateNotice(base({ title: "가".repeat(MAX_TITLE) })).ok, true);
	});

	test("validates body", () => {
		expectErrors(base({ body: undefined }), ["body: must be a string"]);
		expectErrors(base({ body: 42 }), ["body: must be a string"]);
		expectErrors(base({ body: "x".repeat(MAX_BODY + 1) }), [`body: must be at most ${MAX_BODY} characters`]);
		assert.equal(validateNotice(base({ body: "x".repeat(MAX_BODY) })).ok, true);
	});

	test("validates urgency", () => {
		expectErrors(base({ urgency: "urgent" }), ["urgency: must be one of now, soon, fyi"]);
		expectErrors(base({ urgency: undefined }), ["urgency: must be one of now, soon, fyi"]);
		for (const urgency of ["now", "soon", "fyi"]) {
			assert.equal(validateNotice(base({ urgency })).ok, true);
		}
	});

	test("validates session and cwd", () => {
		expectErrors(base({ session: 7 }), ["session: must be a string"]);
		expectErrors(base({ session: "" }), ["session: must be at least 1 characters"]);
		expectErrors(base({ cwd: ["/tmp"] }), ["cwd: must be a string"]);
	});

	test("validates expiresAt", () => {
		expectErrors(base({ expiresAt: 1700000000000 }), ["expiresAt: must be a string"]);
		expectErrors(base({ expiresAt: "tomorrow" }), ["expiresAt: must be an ISO timestamp"]);
		expectErrors(base({ expiresAt: "2026-10-17" }), ["expiresAt: must be an ISO timestamp"]);
		assert.equal(validateNotice(base({ expiresAt: "2026-10-17T12:05:00.500Z" })).ok, true);
		assert.equal(validateNotice(base({ expiresAt: "2026-10-17T21:05:00+09:00" })).ok, true);
	});

	test("validates url", () => {
		expectErrors(base({ url: "javascript:alert(1)" }), ["url: must be a relative path or an https URL"]);
		expectErrors(base({ url: "//example.test/x" }), ["url: must be a relative path or an https URL"]);
		expectErrors(base({ url: "http://example.test/x" }), ["url: must be a relative path or an https URL"]);
		expectErrors(base({ url: 12 }), ["url: must be a string"]);
	});

	test("validates actions", () => {
		expectErrors(base({ actions: "ack" }), ["actions: must be an array"]);
		expectErrors(base({ actions: ["ack", "dismiss"] }), ["actions[1]: must be one of ack, open-url"]);
		assert.equal(validateNotice(base({ actions: [] })).ok, true);
	});

	test("collects every problem at once", () => {
		const result = validateNotice({ v: 1, producer: "BAD", dedupeKey: "", title: "", body: "ok", urgency: "nope", extra: 1 });
		assert.equal(result.ok, false);
		assert.deepEqual(result.errors, [
			"extra: unknown key",
			"producer: must match /^[a-z0-9-]{1,40}$/",
			"dedupeKey: must match /^[A-Za-z0-9._:-]{1,80}$/",
			"title: must be at least 1 characters",
			"urgency: must be one of now, soon, fyi",
		]);
	});
});

describe("noticeItemInput", () => {
	test("maps now/soon to a needs-you item and fyi to an fyi item", () => {
		for (const urgency of ["now", "soon"]) {
			const input = noticeItemInput(base({ urgency }), NOW);
			assert.equal(input.kind, "notice");
			assert.equal(input.policy, "needs-you");
		}
		const quiet = noticeItemInput(base({ urgency: "fyi" }), NOW);
		assert.equal(quiet.kind, "notice");
		assert.equal(quiet.policy, "fyi");
	});

	test("builds the producer-scoped dedupe key and keeps the raw notice", () => {
		const notice = validateNotice(base({ session: "sess-1" })).notice;
		const input = noticeItemInput(notice, NOW);
		assert.equal(input.dedupeKey, "keepwarm:daily");
		assert.deepEqual(input.raw, { notice });
		assert.notEqual(input.raw.notice, notice); // a copy, not the caller's object
		assert.equal(input.raw.notice.session, "sess-1");
	});

	test("stamps a fixed now and passes the expiry through meta", () => {
		const notice = validateNotice(base({ expiresAt: "2026-10-17T12:05:00Z" })).notice;
		assert.deepEqual(noticeItemInput(notice, NOW).meta, { createdAt: NOW, expiresAt: "2026-10-17T12:05:00Z" });
		assert.deepEqual(noticeItemInput(notice, new Date(NOW)).meta, { createdAt: NOW, expiresAt: "2026-10-17T12:05:00Z" });
		assert.deepEqual(noticeItemInput(validateNotice(base({ urgency: "fyi" })).notice, NOW).meta, { createdAt: NOW, expiresAt: null });
	});
});

describe("isExpired", () => {
	test("is false without an expiry", () => {
		assert.equal(isExpired(validateNotice(base()).notice, NOW), false);
		assert.equal(isExpired(null, NOW), false);
		assert.equal(isExpired(undefined, NOW), false);
	});

	test("expires exactly at the instant", () => {
		const notice = validateNotice(base({ expiresAt: "2026-10-17T12:00:00Z" })).notice;
		assert.equal(isExpired(notice, NOW - 1), false);
		assert.equal(isExpired(notice, NOW), true);
		assert.equal(isExpired(notice, NOW + 1), true);
	});

	test("accepts a Date clock and ignores an unparseable expiry", () => {
		const notice = validateNotice(base({ expiresAt: "2026-10-17T11:59:59Z" })).notice;
		assert.equal(isExpired(notice, new Date(NOW)), true);
		assert.equal(isExpired({ expiresAt: "whenever" }, NOW), false);
	});
});
