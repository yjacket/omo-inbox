import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { GitHubError, classify, createGitHubApi } from "../src/github-api.mjs";

function makeResponse({ status = 200, json, headers = {}, text } = {}) {
	const body = text !== undefined ? text : json === undefined ? "" : JSON.stringify(json);
	return { status, headers: new Headers(headers), text: async () => body };
}

function fakeFetch(handler) {
	const calls = [];
	const impl = async (url, options) => {
		calls.push({ url, options });
		return handler(url, options, calls.length);
	};
	return { calls, impl };
}

function fakeSpawn(handler) {
	const calls = [];
	const impl = (cmd, args, options) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => { child.killed = true; };
		calls.push({ cmd, args, options, child });
		handler?.(child, calls.length);
		return child;
	};
	return { calls, impl };
}

function ghSpawn(stdout, code = 0) {
	return fakeSpawn((child) => {
		process.nextTick(() => {
			if (stdout) child.stdout.emit("data", stdout);
			child.emit("close", code);
		});
	});
}

function noSpawn() {
	return () => { throw new Error("spawn must not be called"); };
}

function makeApi({ env = {}, spawnImpl = noSpawn(), fetchImpl, ghPath = "C:/fake/gh.exe", timeoutMs } = {}) {
	return createGitHubApi({ repo: "owner/repo", apiBase: "https://api.test", env, spawnImpl, fetchImpl, ghPath, timeoutMs });
}

test("GH_TOKEN takes precedence over GITHUB_TOKEN and gh", async () => {
	const spawn = ghSpawn("from-gh\n");
	const fetch = fakeFetch(() => makeResponse({ json: { ok: true } }));
	const api = makeApi({ env: { GH_TOKEN: "primary", GITHUB_TOKEN: "secondary" }, spawnImpl: spawn.impl, fetchImpl: fetch.impl });
	await api.request("GET", "/thing");
	assert.equal(fetch.calls[0].options.headers.Authorization, "Bearer primary");
	assert.equal(spawn.calls.length, 0);
});

test("GITHUB_TOKEN is used when GH_TOKEN is empty", async () => {
	const fetch = fakeFetch(() => makeResponse({ json: {} }));
	const api = makeApi({ env: { GH_TOKEN: "", GITHUB_TOKEN: "secondary" }, fetchImpl: fetch.impl });
	assert.equal(await api.resolveToken(), "secondary");
	assert.equal(fetch.calls.length, 0);
});

test("gh auth token fallback trims stdout and passes the locked-down spawn options", async () => {
	const spawn = ghSpawn("  ghost-token  \n");
	const fetch = fakeFetch(() => makeResponse({ json: {} }));
	const api = makeApi({ env: { Path: "C:/bin", GH_PROMPT_DISABLED: "0" }, spawnImpl: spawn.impl, fetchImpl: fetch.impl });
	await api.request("GET", "/thing");
	assert.equal(fetch.calls[0].options.headers.Authorization, "Bearer ghost-token");
	assert.equal(spawn.calls.length, 1);
	assert.deepEqual(spawn.calls[0].args, ["auth", "token"]);
	assert.equal(spawn.calls[0].options.shell, false);
	assert.equal(spawn.calls[0].options.windowsHide, true);
	assert.equal(spawn.calls[0].options.env.GH_PROMPT_DISABLED, "1");
	assert.equal(spawn.calls[0].options.env.Path, "C:/bin");
});

test("empty or failed gh output raises no_token", async () => {
	const empty = ghSpawn("");
	const apiEmpty = makeApi({ env: {}, spawnImpl: empty.impl, fetchImpl: fakeFetch(() => makeResponse()).impl });
	await assert.rejects(apiEmpty.resolveToken(), (error) => error instanceof GitHubError && error.kind === "no_token");
	const failed = ghSpawn("token\n", 1);
	const apiFailed = makeApi({ env: {}, spawnImpl: failed.impl, fetchImpl: fakeFetch(() => makeResponse()).impl });
	await assert.rejects(apiFailed.resolveToken(), (error) => error.kind === "no_token");
});

test("no gh executable configured raises no_token without spawning", async () => {
	const api = makeApi({ env: {}, ghPath: null, fetchImpl: fakeFetch(() => makeResponse()).impl });
	await assert.rejects(api.resolveToken(), (error) => error.kind === "no_token");
});

test("the resolved token is cached across requests", async () => {
	const spawn = ghSpawn("cached-token\n");
	const fetch = fakeFetch(() => makeResponse({ json: {} }));
	const api = makeApi({ env: {}, spawnImpl: spawn.impl, fetchImpl: fetch.impl });
	await api.request("GET", "/one");
	await api.request("GET", "/two");
	assert.equal(spawn.calls.length, 1);
	assert.equal(fetch.calls.length, 2);
	assert.equal(fetch.calls[1].options.headers.Authorization, "Bearer cached-token");
});

test("a 401 clears the token, re-resolves once and repeats the request once", async () => {
	const spawn = ghSpawn("first\n");
	let spawned = 0;
	const spawnImpl = (cmd, args, options) => {
		spawned += 1;
		const child = ghostChild(spawned === 1 ? "first\n" : "second\n");
		spawn.calls.push({ cmd, args, options });
		return child;
	};
	const fetch = fakeFetch((url, options, count) => count === 1
		? makeResponse({ status: 401, json: { message: "Bad credentials" } })
		: makeResponse({ json: { ok: true } }));
	const api = makeApi({ env: {}, spawnImpl, fetchImpl: fetch.impl });
	const result = await api.request("GET", "/thing");
	assert.equal(result.status, 200);
	assert.equal(fetch.calls.length, 2);
	assert.equal(fetch.calls[0].options.headers.Authorization, "Bearer first");
	assert.equal(fetch.calls[1].options.headers.Authorization, "Bearer second");
});

function ghostChild(stdout) {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => {};
	process.nextTick(() => {
		child.stdout.emit("data", stdout);
		child.emit("close", 0);
	});
	return child;
}

test("a repeated 401 raises auth after exactly one retry", async () => {
	const fetch = fakeFetch(() => makeResponse({ status: 401, json: { message: "Bad credentials" } }));
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl });
	await assert.rejects(api.request("GET", "/thing"), (error) => error instanceof GitHubError && error.kind === "auth" && error.status === 401);
	assert.equal(fetch.calls.length, 2);
});

test("classify maps auth, not_found, issues_disabled and transient", () => {
	assert.equal(classify(200, {}, null), null);
	assert.equal(classify(304, {}, null), null);
	assert.equal(classify(401, {}, null).kind, "auth");
	assert.equal(classify(404, {}, null).kind, "not_found");
	assert.equal(classify(410, {}, null).kind, "issues_disabled");
	const serverError = classify(502, {}, null);
	assert.equal(serverError.kind, "transient");
	assert.equal(serverError.status, 502);
});

test("classify marks 403 rate limits from x-ratelimit headers", () => {
	const reset = Math.floor(Date.now() / 1000) + 120;
	const error = classify(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, { message: "forbidden" });
	assert.equal(error.kind, "rate_limit");
	assert.equal(error.retryAt.getTime(), reset * 1000);
});

test("classify uses retry-after seconds for rate limits", () => {
	const before = Date.now();
	const error = classify(403, { "retry-after": "7" }, {});
	assert.equal(error.kind, "rate_limit");
	assert.ok(error.retryAt.getTime() >= before + 7000);
	assert.ok(error.retryAt.getTime() <= Date.now() + 7000);
});

test("classify recognizes a 403 rate-limit message and defaults to a 60 s retry", () => {
	const before = Date.now();
	const error = classify(403, {}, { message: "You have exceeded a secondary rate limit" });
	assert.equal(error.kind, "rate_limit");
	assert.ok(error.retryAt.getTime() >= before + 60000);
	assert.ok(error.retryAt.getTime() <= Date.now() + 60000);
});

test("classify treats other 403 responses as permission", () => {
	const error = classify(403, { "x-ratelimit-remaining": "42" }, { message: "Resource not accessible by integration" });
	assert.equal(error.kind, "permission");
	assert.equal(error.status, 403);
});

test("classify collects 422 error codes and maps 429 to rate_limit", () => {
	const validation = classify(422, {}, { errors: [{ code: "missing_field" }, { code: "invalid" }, { message: "no code" }] });
	assert.equal(validation.kind, "validation");
	assert.deepEqual(validation.codes, ["missing_field", "invalid"]);
	const limited = classify(429, { "retry-after": "1" }, {});
	assert.equal(limited.kind, "rate_limit");
	assert.ok(limited.retryAt instanceof Date);
});

test("request returns a 200 JSON body with the required GitHub headers", async () => {
	const fetch = fakeFetch(() => makeResponse({ status: 200, json: { hello: "world" } }));
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl, timeoutMs: 9000 });
	const result = await api.request("GET", "/user", { query: { a: 1, skip: undefined } });
	assert.equal(result.status, 200);
	assert.deepEqual(result.json, { hello: "world" });
	assert.equal(fetch.calls[0].url, "https://api.test/user?a=1");
	assert.equal(fetch.calls[0].options.method, "GET");
	assert.equal(fetch.calls[0].options.headers.Authorization, "Bearer t");
	assert.equal(fetch.calls[0].options.headers.Accept, "application/vnd.github+json");
	assert.equal(fetch.calls[0].options.headers["X-GitHub-Api-Version"], "2022-11-28");
	assert.equal(fetch.calls[0].options.headers["User-Agent"], "omo-inbox");
	assert.equal(fetch.calls[0].options.headers["Content-Type"], undefined);
	assert.equal(fetch.calls[0].options.body, undefined);
	assert.ok(fetch.calls[0].options.signal instanceof AbortSignal);
});

test("request sends JSON bodies and merges caller headers", async () => {
	const fetch = fakeFetch(() => makeResponse({ status: 201, json: { created: true } }));
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl });
	await api.request("POST", "/issues", { body: { title: "t" }, headers: { "X-Extra": "yes" } });
	assert.equal(fetch.calls[0].options.headers["Content-Type"], "application/json");
	assert.equal(fetch.calls[0].options.headers["X-Extra"], "yes");
	assert.deepEqual(JSON.parse(fetch.calls[0].options.body), { title: "t" });
});

test("network and timeout failures become transient errors", async () => {
	const timeout = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
	const api = makeApi({ env: { GH_TOKEN: "token_abc" }, fetchImpl: async () => { throw timeout; } });
	await assert.rejects(api.request("GET", "/thing"), (error) => error instanceof GitHubError && error.kind === "transient" && error.message === "The operation was aborted");
});

test("thrown error messages never carry the token", async () => {
	const api = makeApi({ env: { GH_TOKEN: "tok_secret" }, fetchImpl: async () => { throw new Error("connection failed for tok_secret"); } });
	await assert.rejects(api.request("GET", "/thing"), (error) => {
		assert.equal(error.kind, "transient");
		assert.equal(error.message.includes("tok_secret"), false);
		assert.equal(error.message.includes("[redacted]"), true);
		return true;
	});
});

test("304 is returned rather than classified as an error", async () => {
	const fetch = fakeFetch(() => makeResponse({ status: 304, text: "" }));
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl });
	const result = await api.request("GET", "/thing");
	assert.equal(result.status, 304);
	assert.equal(result.json, null);
});

test("allow returns 404 and 422 responses while other errors still throw", async () => {
	const notFound = fakeFetch(() => makeResponse({ status: 404, json: { message: "Not Found" } }));
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: notFound.impl });
	const result = await api.request("GET", "/missing", { allow: [404, 422] });
	assert.equal(result.status, 404);
	await assert.rejects(api.request("GET", "/other"), (error) => error.kind === "not_found");
});

test("paginate follows Link rel=next across three pages", async () => {
	const fetch = fakeFetch((url) => {
		const page = Number(new URL(url).searchParams.get("page") ?? "1");
		const headers = page < 3 ? { link: '<https://api.test/items?page=' + (page + 1) + '>; rel="next"' } : {};
		return makeResponse({ json: [{ page }], headers });
	});
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl });
	const result = await api.paginate("/items", { page: 1 });
	assert.deepEqual(result.items, [{ page: 1 }, { page: 2 }, { page: 3 }]);
	assert.equal(result.complete, true);
	assert.equal(fetch.calls.length, 3);
	assert.equal(fetch.calls[2].url, "https://api.test/items?page=3");
});

test("paginate stops at maxPages and reports incomplete", async () => {
	const fetch = fakeFetch((url) => {
		const page = Number(new URL(url).searchParams.get("page") ?? "1");
		return makeResponse({ json: [page], headers: { link: '<https://api.test/items?page=' + (page + 1) + '>; rel="next"' } });
	});
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl });
	const result = await api.paginate("/items", {}, { maxPages: 2 });
	assert.deepEqual(result.items, [1, 2]);
	assert.equal(result.complete, false);
	assert.equal(fetch.calls.length, 2);
});

test("login is cached", async () => {
	const fetch = fakeFetch(() => makeResponse({ json: { login: "octocat" } }));
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl });
	assert.equal(await api.login(), "octocat");
	assert.equal(await api.login(), "octocat");
	assert.equal(fetch.calls.length, 1);
	assert.equal(fetch.calls[0].url, "https://api.test/user");
});

test("repoInfo maps fields and is cached", async () => {
	const fetch = fakeFetch(() => makeResponse({ json: { private: true, has_issues: false, default_branch: "trunk" } }));
	const api = makeApi({ env: { GH_TOKEN: "t" }, fetchImpl: fetch.impl });
	assert.deepEqual(await api.repoInfo(), { private: true, hasIssues: false, defaultBranch: "trunk" });
	assert.deepEqual(await api.repoInfo(), { private: true, hasIssues: false, defaultBranch: "trunk" });
	assert.equal(fetch.calls.length, 1);
	assert.equal(fetch.calls[0].url, "https://api.test/repos/owner/repo");
});
