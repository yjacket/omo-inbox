import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { assetPath, ensureAssetsBranch, gitBlobSha, putAsset } from "../src/reports-assets.mjs";

const REPO = "yjacket/omo-inbox";
const BRANCH = "inbox-report-assets";
const ID = "11111111-1111-4111-8111-111111111111";
const PATH = `reports/2026/10/${ID}.png`;
const REF = `/repos/${REPO}/git/ref/heads/${BRANCH}`;
const CONTENTS = `/repos/${REPO}/contents/${PATH}`;

function fakeApi(handler) {
	const calls = [];
	const api = {
		repo: REPO,
		calls,
		async repoInfo() {
			calls.push({ method: "repoInfo", path: null, opts: null });
			return { private: true, hasIssues: true, defaultBranch: "main" };
		},
		async request(method, path, opts = {}) {
			const call = { method, path, opts };
			calls.push(call);
			return handler(call, calls);
		},
	};
	return api;
}

function bootstrapHandler() {
	return (call) => {
		if (call.method === "GET" && call.path === REF) return { status: 404, headers: {}, json: null, text: "" };
		if (call.method === "POST" && call.path === `/repos/${REPO}/git/trees`) {
			return { status: 201, headers: {}, json: { sha: "tree-sha", url: "https://api.github.com/repos/o/r/git/trees/tree-sha", tree: [{ path: ".gitkeep", mode: "100644", type: "blob", sha: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" }], truncated: false }, text: "" };
		}
		if (call.method === "POST" && call.path === `/repos/${REPO}/git/commits`) {
			return { status: 201, headers: {}, json: { sha: "commit-sha" }, text: "" };
		}
		if (call.method === "POST" && call.path === `/repos/${REPO}/git/refs`) {
			return { status: 201, headers: {}, json: { ref: `refs/heads/${BRANCH}` }, text: "" };
		}
		throw new Error(`unexpected call ${call.method} ${call.path}`);
	};
}

function existing(sha) {
	return { status: 200, headers: {}, json: { path: PATH, sha }, text: "" };
}

const missing = { status: 404, headers: {}, json: null, text: "" };

describe("gitBlobSha", () => {
	test("hashes the git blob header and bytes", () => {
		assert.equal(gitBlobSha(Buffer.from("hello")), "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0");
	});
});

describe("assetPath", () => {
	test("uses the UTC createdAt year and month", () => {
		assert.equal(assetPath({ id: ID, createdAt: "2026-10-28T23:59:59.000Z" }), PATH);
		assert.equal(assetPath({ id: ID, createdAt: "2027-01-01T00:00:00.000Z" }), `reports/2027/01/${ID}.png`);
	});
});

describe("ensureAssetsBranch", () => {
	test("returns at once when the branch ref exists", async () => {
		const api = fakeApi(() => ({ status: 200, headers: {}, json: { ref: `refs/heads/${BRANCH}` }, text: "" }));
		await ensureAssetsBranch(api, { branch: BRANCH });
		assert.deepEqual(api.calls.map((call) => `${call.method} ${call.path}`), [`GET ${REF}`]);
	});

	test("bootstraps missing branch with trees, commits, refs posts in order", async () => {
		const api = fakeApi(bootstrapHandler());
		await ensureAssetsBranch(api, { branch: BRANCH });
		assert.deepEqual(
			api.calls.map((call) => (call.method === "repoInfo" ? "repoInfo" : `${call.method} ${call.path}`)),
			[
				`GET ${REF}`,
				"repoInfo",
				`POST /repos/${REPO}/git/trees`,
				`POST /repos/${REPO}/git/commits`,
				`POST /repos/${REPO}/git/refs`,
			],
		);
		assert.deepEqual(api.calls[2].opts.body, {
			tree: [{ path: ".gitkeep", mode: "100644", type: "blob", content: "" }],
		});
		assert.deepEqual(api.calls[3].opts.body, {
			message: "Initialize inbox report assets",
			tree: "tree-sha",
			parents: [],
		});
		assert.deepEqual(api.calls[4].opts.body, {
			ref: `refs/heads/${BRANCH}`,
			sha: "commit-sha",
		});
	});

	test("rechecks the ref after a 422 race and memoizes success", async () => {
		let refGets = 0;
		const api = fakeApi((call) => {
			if (call.method === "GET" && call.path === REF) {
				refGets += 1;
				return refGets === 1 ? missing : existingRef();
			}
			if (call.method === "POST" && call.path === `/repos/${REPO}/git/refs`) {
				return { status: 422, headers: {}, json: null, text: "" };
			}
			return bootstrapHandler()(call);
		});
		await ensureAssetsBranch(api, { branch: BRANCH });
		const posts = api.calls.filter((call) => call.method === "POST");
		assert.equal(posts.length, 3);
		assert.equal(refGets, 2);
		await ensureAssetsBranch(api, { branch: BRANCH });
		assert.equal(api.calls.length, 6);
	});

	test("throws validation when a 422 race still leaves no ref", async () => {
		const api = fakeApi((call) => {
			if (call.method === "GET" && call.path === REF) return missing;
			if (call.method === "POST" && call.path === `/repos/${REPO}/git/refs`) {
				return { status: 422, headers: {}, json: null, text: "" };
			}
			return bootstrapHandler()(call);
		});
		await assert.rejects(ensureAssetsBranch(api, { branch: BRANCH }), (err) => err.kind === "validation");
	});
});

function existingRef() {
	return { status: 200, headers: {}, json: { ref: `refs/heads/${BRANCH}` }, text: "" };
}

describe("putAsset", () => {
	test("uploads a new picture to the branch and returns the content sha", async () => {
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		const api = fakeApi((call) => {
			if (call.method === "GET") return missing;
			return { status: 201, headers: {}, json: { content: { sha: "new-sha" } }, text: "" };
		});
		const result = await putAsset(api, { branch: BRANCH, path: PATH, bytes, message: "report picture" });
		assert.deepEqual(result, { path: PATH, blobSha: "new-sha" });
		assert.deepEqual(api.calls.map((call) => call.method), ["GET", "PUT"]);
		assert.deepEqual(api.calls[0].opts.query, { ref: BRANCH });
		assert.deepEqual(api.calls[0].opts.allow, [404]);
		assert.deepEqual(api.calls[1].opts.allow, [422]);
		assert.deepEqual(api.calls[1].opts.body, {
			message: "report picture",
			content: bytes.toString("base64"),
			branch: BRANCH,
		});
	});

	test("runs bootstrap before the first upload in endpoint order", async () => {
		const api = fakeApi((call) => {
			if (call.path === CONTENTS) {
				return call.method === "GET"
					? missing
					: { status: 201, headers: {}, json: { content: { sha: "pic-sha" } }, text: "" };
			}
			return bootstrapHandler()(call);
		});
		await ensureAssetsBranch(api, { branch: BRANCH });
		await putAsset(api, { branch: BRANCH, path: PATH, bytes: Buffer.from("png"), message: "m" });
		assert.deepEqual(
			api.calls.map((call) => (call.method === "repoInfo" ? "repoInfo" : `${call.method} ${call.path}`)),
			[
				`GET ${REF}`,
				"repoInfo",
				`POST /repos/${REPO}/git/trees`,
				`POST /repos/${REPO}/git/commits`,
				`POST /repos/${REPO}/git/refs`,
				`GET ${CONTENTS}`,
				`PUT ${CONTENTS}`,
			],
		);
	});

	test("returns without a PUT when the existing blob has the same sha", async () => {
		const bytes = Buffer.from("hello");
		const api = fakeApi(() => existing(gitBlobSha(bytes)));
		const result = await putAsset(api, { branch: BRANCH, path: PATH, bytes, message: "m" });
		assert.deepEqual(result, { path: PATH, blobSha: gitBlobSha(bytes) });
		assert.deepEqual(api.calls.map((call) => call.method), ["GET"]);
	});

	test("rejects an existing different blob with attachment_conflict and no PUT", async () => {
		const api = fakeApi(() => existing("another-sha"));
		await assert.rejects(
			putAsset(api, { branch: BRANCH, path: PATH, bytes: Buffer.from("hello"), message: "m" }),
			(err) => err.kind === "validation" && err.codes.includes("attachment_conflict"),
		);
		assert.deepEqual(api.calls.map((call) => call.method), ["GET"]);
	});

	test("repeats the GET after a PUT 422 and accepts the same sha", async () => {
		const bytes = Buffer.from("hello");
		let gets = 0;
		const api = fakeApi((call) => {
			if (call.method === "GET") {
				gets += 1;
				return gets === 1 ? missing : existing(gitBlobSha(bytes));
			}
			return { status: 422, headers: {}, json: null, text: "" };
		});
		const result = await putAsset(api, { branch: BRANCH, path: PATH, bytes, message: "m" });
		assert.deepEqual(result, { path: PATH, blobSha: gitBlobSha(bytes) });
		assert.deepEqual(api.calls.map((call) => call.method), ["GET", "PUT", "GET"]);
	});

	test("rejects with attachment_conflict when the PUT race produced other bytes", async () => {
		const bytes = Buffer.from("hello");
		let gets = 0;
		const api = fakeApi((call) => {
			if (call.method === "GET") {
				gets += 1;
				return gets === 1 ? missing : existing("other-sha");
			}
			return { status: 422, headers: {}, json: null, text: "" };
		});
		await assert.rejects(
			putAsset(api, { branch: BRANCH, path: PATH, bytes, message: "m" }),
			(err) => err.codes.includes("attachment_conflict"),
		);
		assert.equal(api.calls.filter((call) => call.method === "PUT").length, 1);
	});

	test("encodes each path segment", async () => {
		const api = fakeApi((call) =>
			call.method === "GET"
				? missing
				: { status: 201, headers: {}, json: { content: { sha: "s" } }, text: "" },
		);
		await putAsset(api, { branch: BRANCH, path: "reports/a b/#1.png", bytes: Buffer.from("x"), message: "m" });
		assert.equal(api.calls[0].path, `/repos/${REPO}/contents/reports/a%20b/%231.png`);
	});
});
