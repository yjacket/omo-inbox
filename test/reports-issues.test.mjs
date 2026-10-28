import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { GitHubError } from "../src/github-api.mjs";
import {
	createIssue,
	createStateCache,
	ensureLabel,
	findIssueByMarker,
} from "../src/reports-issues.mjs";

const REPO = "yjacket/omo-inbox";
const LABEL = "inbox-report";
const MARKER = "<!-- inbox-report:11111111-1111-4111-8111-111111111111 -->";

function makeApi({ request, paginate } = {}) {
	return {
		repo: REPO,
		request: request ?? (async () => ({ status: 200, headers: {}, json: {}, text: "" })),
		paginate: paginate ?? (async () => ({ items: [], complete: true })),
	};
}

function issue(overrides = {}) {
	return {
		number: 7,
		html_url: "https://github.com/yjacket/omo-inbox/issues/7",
		body: `report\n${MARKER}`,
		state: "open",
		comments: 2,
		...overrides,
	};
}

describe("ensureLabel", () => {
	test("returns an existing label without creating it", async () => {
		const calls = [];
		const api = makeApi({
			request: async (method, path, options) => {
				calls.push({ method, path, options });
				return { status: 200, headers: {}, json: { name: LABEL }, text: "" };
			},
		});
		const label = await ensureLabel(api, { name: LABEL, color: "ededed", description: "reports" });
		assert.deepEqual(label, { name: LABEL });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "GET");
		assert.equal(calls[0].path, `/repos/${REPO}/labels/${LABEL}`);
		assert.deepEqual(calls[0].options.allow, [404]);
	});

	test("creates a missing label once and memoizes it", async () => {
		const calls = [];
		const api = makeApi({
			request: async (method, path, options) => {
				calls.push({ method, path, options });
				if (method === "GET") return { status: 404, headers: {}, json: null, text: "" };
				return { status: 201, headers: {}, json: { name: "space label" }, text: "" };
			},
		});
		const first = await ensureLabel(api, { name: "space label", color: "ededed", description: "reports" });
		const second = await ensureLabel(api, { name: "space label", color: "ededed", description: "reports" });
		assert.deepEqual(first, { name: "space label" });
		assert.deepEqual(second, first);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].path, `/repos/${REPO}/labels/space%20label`);
		assert.equal(calls[1].method, "POST");
		assert.equal(calls[1].path, `/repos/${REPO}/labels`);
		assert.deepEqual(calls[1].options.body, { name: "space label", color: "ededed", description: "reports" });
		assert.deepEqual(calls[1].options.allow, [422]);
	});

	test("treats a 422 already_exists as success", async () => {
		const calls = [];
		const api = makeApi({
			request: async (method) => {
				calls.push(method);
				if (method === "GET") return { status: 404, headers: {}, json: null, text: "" };
				return {
					status: 422,
					headers: {},
					json: { errors: [{ code: "already_exists" }] },
					text: "",
				};
			},
		});
		await ensureLabel(api, { name: LABEL, color: "ededed", description: "reports" });
		await ensureLabel(api, { name: LABEL, color: "ededed", description: "reports" });
		assert.deepEqual(calls, ["GET", "POST"]);
	});

	test("throws a validation error for another 422 code", async () => {
		const api = makeApi({
			request: async (method) => {
				if (method === "GET") return { status: 404, headers: {}, json: null, text: "" };
				return {
					status: 422,
					headers: {},
					json: { errors: [{ code: "invalid" }] },
					text: "",
				};
			},
		});
		await assert.rejects(
			ensureLabel(api, { name: LABEL, color: "ededed", description: "reports" }),
			(error) => error instanceof GitHubError && error.kind === "validation" && error.codes.includes("invalid"),
		);
	});
});

describe("createIssue", () => {
	test("posts the issue and maps the GitHub fields", async () => {
		let seen;
		const api = makeApi({
			request: async (method, path, options) => {
				seen = { method, path, options };
				return {
					status: 201,
					headers: {},
					json: {
						number: 42,
						html_url: "https://github.com/yjacket/omo-inbox/issues/42",
						node_id: "I_42",
						created_at: "2026-10-28T01:02:03Z",
					},
					text: "",
				};
			},
		});
		const created = await createIssue(api, { title: "t", body: "b", labels: [LABEL] });
		assert.deepEqual(created, {
			number: 42,
			url: "https://github.com/yjacket/omo-inbox/issues/42",
			nodeId: "I_42",
			createdAt: "2026-10-28T01:02:03Z",
		});
		assert.equal(seen.method, "POST");
		assert.equal(seen.path, `/repos/${REPO}/issues`);
		assert.deepEqual(seen.options.body, { title: "t", body: "b", labels: [LABEL] });
	});

	test("throws a transient malformed error for a 201 without a number", async () => {
		const api = makeApi({
			request: async () => ({ status: 201, headers: {}, json: { id: 1 }, text: "" }),
		});
		await assert.rejects(
			createIssue(api, { title: "t", body: "b", labels: [LABEL] }),
			(error) =>
				error instanceof GitHubError &&
				error.kind === "transient" &&
				error.status === 201 &&
				error.codes.includes("malformed"),
		);
	});
});

describe("findIssueByMarker", () => {
	test("finds the marker in the first pass and keeps the issue url", async () => {
		const calls = [];
		const api = makeApi({
			paginate: async (path, query, options) => {
				calls.push({ path, query, options });
				return {
					items: [issue({ number: 1, body: "other" }), issue({ number: 9 })],
					complete: true,
				};
			},
		});
		const found = await findIssueByMarker(api, {
			marker: MARKER,
			label: LABEL,
			creator: "yjacket",
			since: "2026-01-01T00:00:00Z",
		});
		assert.deepEqual(found, {
			matches: [{ number: 9, url: "https://github.com/yjacket/omo-inbox/issues/7" }],
			complete: true,
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].path, `/repos/${REPO}/issues`);
		assert.deepEqual(calls[0].query, {
			state: "all",
			labels: LABEL,
			creator: "yjacket",
			since: "2026-01-01T00:00:00Z",
			sort: "created",
			direction: "desc",
			per_page: 100,
		});
	});

	test("retries without labels only when the first pass found nothing", async () => {
		const calls = [];
		const api = makeApi({
			paginate: async (path, query) => {
				calls.push(query);
				if (calls.length === 1) return { items: [issue({ body: "no marker" })], complete: true };
				return { items: [issue({ number: 11 })], complete: true };
			},
		});
		const found = await findIssueByMarker(api, { marker: MARKER, label: LABEL });
		assert.equal(calls.length, 2);
		assert.equal(calls[0].labels, LABEL);
		assert.equal(Object.hasOwn(calls[1], "labels"), false);
		assert.deepEqual(found.matches, [{ number: 11, url: "https://github.com/yjacket/omo-inbox/issues/7" }]);
		assert.equal(found.complete, true);
	});

	test("ignores pull request entries even when they carry the marker", async () => {
		const api = makeApi({
			paginate: async (path) => ({
				items: [issue({ pull_request: { url: "https://api.github.test/pulls/7" } })],
				complete: true,
			}),
		});
		const found = await findIssueByMarker(api, { marker: MARKER, label: LABEL });
		assert.deepEqual(found.matches, []);
		assert.equal(found.complete, true);
	});

	test("reports complete false when a pass stops early", async () => {
		let page = 0;
		const api = makeApi({
			paginate: async () => {
				page += 1;
				return { items: [], complete: false };
			},
		});
		const found = await findIssueByMarker(api, { marker: MARKER, label: LABEL, maxPages: 1 });
		assert.deepEqual(found.matches, []);
		assert.equal(found.complete, false);
		assert.equal(page, 2);
	});

	test("reports complete false when the first pass is capped after finding a match", async () => {
		const api = makeApi({
			paginate: async () => ({ items: [issue()], complete: false }),
		});
		const found = await findIssueByMarker(api, { marker: MARKER, label: LABEL });
		assert.equal(found.matches.length, 1);
		assert.equal(found.complete, false);
	});
});

function reply(status, json, headers = {}) {
	return { status, headers: new Headers(headers), json, text: "" };
}

describe("createStateCache", () => {
	test("get is null before the first success and returns the map and at after refresh", async () => {
		const calls = [];
		const api = makeApi({
			request: async (method, path, options) => {
				calls.push({ method, path, options });
				return reply(200, [issue({ number: 3, state: "open", comments: 5 })], { etag: '"v1"' });
			},
		});
		const cache = createStateCache(api, { label: LABEL, now: () => new Date("2026-10-28T00:00:00Z") });
		assert.equal(cache.get(), null);
		assert.equal(cache.at(), null);
		await cache.refresh();
		assert.deepEqual(cache.get(), new Map([[3, { state: "open", comments: 5 }]]));
		assert.equal(cache.at(), "2026-10-28T00:00:00.000Z");
		assert.equal(calls[0].method, "GET");
		assert.equal(calls[0].path, `/repos/${REPO}/issues`);
		assert.deepEqual(calls[0].options.query, { state: "all", labels: LABEL, per_page: 100 });
		assert.deepEqual(calls[0].options.headers, {});
	});

	test("get never awaits an in-flight refresh and starts only one", async () => {
		let resolvePage;
		let calls = 0;
		const api = makeApi({
			request: () => {
				calls += 1;
				return new Promise((resolve) => {
					resolvePage = resolve;
				});
			},
		});
		const cache = createStateCache(api, { label: LABEL, now: () => new Date("2026-10-28T00:00:00Z") });
		assert.equal(cache.get(), null);
		assert.equal(cache.get(), null);
		assert.equal(calls, 1);
		resolvePage(reply(200, [issue({ number: 1 })], { etag: '"v1"' }));
		await cache.refresh();
		assert.deepEqual(cache.get(), new Map([[1, { state: "open", comments: 2 }]]));
		assert.equal(calls, 1);
	});

	test("gates refreshes on the injected clock and stale-while-revalidate", async () => {
		let clock = new Date("2026-10-28T00:00:00Z");
		let calls = 0;
		const api = makeApi({
			request: async () => {
				calls += 1;
				return reply(200, [issue({ number: calls })], { etag: `"v${calls}"` });
			},
		});
		const cache = createStateCache(api, { label: LABEL, ttlMs: 60000, now: () => clock });
		await cache.refresh();
		assert.equal(calls, 1);
		assert.equal(cache.at(), "2026-10-28T00:00:00.000Z");
		clock = new Date("2026-10-28T00:00:59Z");
		assert.equal(cache.get().get(1).state, "open");
		assert.equal(calls, 1);
		clock = new Date("2026-10-28T00:01:01Z");
		assert.equal(cache.get().get(1).state, "open");
		assert.equal(calls, 2);
		await cache.refresh();
		assert.equal(cache.get().get(2).state, "open");
		assert.equal(cache.at(), "2026-10-28T00:01:01.000Z");
	});

	test("sends If-None-Match on a later refresh and keeps the map on 304", async () => {
		const calls = [];
		const api = makeApi({
			request: async (method, path, options) => {
				calls.push({ method, path, options });
				if (calls.length === 1) return reply(200, [issue({ number: 8, comments: 0 })], { etag: '"v1"' });
				return reply(304, null, { etag: '"v2"' });
			},
		});
		let clock = new Date("2026-10-28T00:00:00Z");
		const cache = createStateCache(api, { label: LABEL, ttlMs: 1000, now: () => clock });
		await cache.refresh();
		const first = cache.get();
		assert.equal(first, cache.get());
		clock = new Date("2026-10-28T00:00:02Z");
		cache.get();
		await cache.refresh();
		assert.equal(cache.get(), first, "the same map object is kept on 304");
		assert.equal(calls[1].options.headers["If-None-Match"], '"v1"');
		assert.equal(cache.at(), "2026-10-28T00:00:02.000Z");
	});

	test("follows Link rel next over two pages without repeating the ETag", async () => {
		const calls = [];
		const next = "https://api.github.test/repositories/1/issues?page=2";
		const api = makeApi({
			request: async (method, path, options) => {
				calls.push({ method, path, options });
				if (calls.length === 1) {
					return reply(200, [issue({ number: 1 })], {
						etag: '"v1"',
						link: `<${next}>; rel="next"`,
					});
				}
				return reply(200, [issue({ number: 2, comments: 9 })], {});
			},
		});
		const cache = createStateCache(api, { label: LABEL, now: () => new Date("2026-10-28T00:00:00Z") });
		await cache.refresh();
		assert.equal(calls.length, 2);
		assert.equal(calls[1].path, next);
		assert.equal(calls[1].options.query, undefined);
		assert.equal(Object.hasOwn(calls[1].options.headers, "If-None-Match"), false);
		assert.deepEqual(
			cache.get(),
			new Map([
				[1, { state: "open", comments: 2 }],
				[2, { state: "open", comments: 9 }],
			]),
		);
	});

	test("swallows a refresh error and keeps the last map and at", async () => {
		let fail = false;
		const api = makeApi({
			request: async () => {
				if (fail) throw new GitHubError("transient", { message: "boom" });
				return reply(200, [issue({ number: 4 })], { etag: '"v1"' });
			},
		});
		let clock = new Date("2026-10-28T00:00:00Z");
		const cache = createStateCache(api, { label: LABEL, ttlMs: 1000, now: () => clock });
		await cache.refresh();
		const before = cache.get();
		fail = true;
		clock = new Date("2026-10-28T00:00:02Z");
		cache.get();
		await cache.refresh();
		assert.equal(cache.get(), before);
		assert.equal(cache.at(), "2026-10-28T00:00:00.000Z");
	});
});
