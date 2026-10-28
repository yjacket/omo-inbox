import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createPublisher } from "../src/reports-publisher.mjs";
import { createReportsStore } from "../src/reports-store.mjs";
import { GitHubError } from "../src/github-api.mjs";
import { makeTmpHome } from "./helpers/tmp-home.mjs";

function harness(t, onSent = () => {}) {
	const tmp = makeTmpHome("inbox-publisher-");
	t.after(tmp.cleanup);
	let time = Date.parse("2026-10-28T00:00:00Z");
	let serial = 0;
	const timers = new Map();
	const calls = [];
	const notifications = [];
	const logs = [];
	const now = () => new Date(time);
	const store = createReportsStore({ dataDir: path.join(tmp.home, "data"), now });
	const api = {
		async repoInfo() { calls.push("repo"); return { private: true, hasIssues: true }; },
		async login() { calls.push("login"); return "owner"; },
	};
	const assets = {
		assetPath(record) { return `reports/2026/10/${record.id}.png`; },
		async ensureAssetsBranch() { calls.push("branch"); },
		async putAsset(_api, args) {
			calls.push("asset");
			assert.equal(store.get("one").delivery.state, "uploading");
			assert.deepEqual(args.bytes, Buffer.from("png"));
			return { path: args.path, blobSha: "blob" };
		},
	};
	const issues = {
		async ensureLabel() { calls.push("label"); },
		async createIssue(_api, request) {
			calls.push("create");
			return { number: 1, url: "https://example.invalid/1", nodeId: "node", createdAt: now().toISOString() };
		},
		async findIssueByMarker() { calls.push("find"); return { matches: [], complete: true }; },
	};
	const body = {
		marker: (id) => `<!-- inbox-report:${id} -->`,
		buildIssue({ record, title, label }) {
			calls.push("body");
			assert.deepEqual(record.asset, store.get(record.id).asset);
			return { title, body: `report ${record.id}`, labels: [label] };
		},
	};
	const options = {
		store, api, assets, issues, body, onSent,
		config: { repo: "owner/private", label: "inbox-report", assetsBranch: "assets" },
		notify: (value) => notifications.push(value), log: (value) => logs.push(value), now,
		random: () => 1, retryMs: 1000, reconcileMs: 5000,
		setTimer(fn, delay) { const id = ++serial; timers.set(id, { fn, at: time + delay }); return id; },
		clearTimer(id) { timers.delete(id); },
	};
	const publisher = createPublisher(options);
	t.after(() => publisher.stop());
	function add(id = "one", image = false) {
		return store.create({
			id, fingerprint: id, report: { description: `Title ${id}` },
			png: image ? Buffer.from("png") : null,
			imageMeta: image ? { width: 1, height: 1, provenance: "snapshot" } : null,
		}).record;
	}
	async function advance(ms) {
		time += ms;
		for (const [id, timer] of [...timers]) {
			if (timer.at <= time) {
				timers.delete(id);
				await timer.fn();
			}
		}
	}
	return {
		...options, publisher, options, calls, notifications, logs, timers, add, advance,
		record: (id = "one") => store.get(id),
		delay: () => [...timers.values()][0]?.at - time,
	};
}

test("happy image: assets and frozen request persist before create", async (t) => {
	const h = harness(t);
	h.add("one", true);
	const create = h.issues.createIssue;
	h.issues.createIssue = async (api, request) => {
		const record = h.record();
		assert.equal(record.delivery.state, "creating");
		assert.equal(record.delivery.creates, 1);
		assert.equal(record.delivery.uncertainSince, h.now().toISOString());
		assert.deepEqual(record.issueRequest, request);
		assert.equal(record.asset.blobSha, "blob");
		return create(api, request);
	};
	await h.publisher.kick("one");
	assert.deepEqual(h.calls, ["repo", "label", "branch", "asset", "body", "create"]);
	assert.equal(h.record().delivery.state, "sent");
});

test("happy without image never calls assets", async (t) => {
	const h = harness(t);
	h.add();
	await h.publisher.kick("one");
	assert.deepEqual(h.calls, ["repo", "label", "body", "create"]);
	assert.equal(h.record().delivery.lastError, null);
});

for (const reconciled of [false, true]) {
	for (const failure of ["none", "throw", "reject"]) {
		test(`onSent runs once after persistence (${reconciled ? "reconciliation" : "create"}, callback ${failure})`, async (t) => {
			const received = [];
			const persisted = [];
			const h = harness(t, (record) => {
				received.push(record);
				persisted.push(h.record());
				if (failure === "throw") throw new Error("callback failed");
				if (failure === "reject") return Promise.reject(new Error("callback failed"));
			});
			h.add();
			if (reconciled) {
				h.issues.createIssue = async () => { throw new GitHubError("transient"); };
				h.issues.findIssueByMarker = async () => ({
					matches: [{ number: 7, url: "/7" }], complete: true,
				});
			}
			await h.publisher.kick("one");
			if (reconciled) {
				assert.deepEqual(received, []);
				await h.advance(5000);
			}
			const sent = h.record();
			assert.equal(sent.delivery.state, "sent");
			assert.deepEqual(received, [sent]);
			assert.deepEqual(persisted, [sent]);
			await h.publisher.kick("one");
			await h.publisher.start();
			assert.equal(received.length, 1);
			assert.equal(h.record().delivery.state, "sent");
			assert.equal(h.timers.size, 0);
		});
	}
}

test("public repository fails before label or issue creation", async (t) => {
	const h = harness(t);
	h.add();
	h.api.repoInfo = async () => ({ private: false });
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.lastError.kind, "public_repo");
	assert.deepEqual(h.calls, []);
});

test("401 fails auth with fixed detail and exactly one notification", async (t) => {
	const h = harness(t);
	h.add();
	h.issues.createIssue = async () => { throw new GitHubError("auth", { status: 401, message: "secret-token" }); };
	await h.publisher.kick("one");
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "failed");
	assert.deepEqual(h.record().delivery.lastError, { kind: "auth", detail: "GitHub 인증을 확인해야 합니다" });
	assert.deepEqual(h.notifications, [{
		title: "제보를 GitHub에 올리지 못했습니다", body: "Title one", url: "/issues", tag: "report:one",
	}]);
	assert.ok(h.logs.every((line) => !line.includes("secret-token")));
});

test("rate limit retries only at retryAt and does not reconcile a rejected POST", async (t) => {
	const h = harness(t);
	h.add();
	const create = h.issues.createIssue;
	let count = 0;
	h.issues.createIssue = async (...args) => {
		if (++count === 1) throw new GitHubError("rate_limit", { retryAt: new Date(+h.now() + 7000) });
		return create(...args);
	};
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "retry_wait");
	assert.equal(h.delay(), 7000);
	await h.advance(6999);
	assert.equal(count, 1);
	await h.advance(1);
	assert.equal(h.record().delivery.state, "sent");
	assert.equal(count, 2);
	assert.ok(!h.calls.includes("find"));
});

test("transient setup backoff doubles and exhausts after eight attempts", async (t) => {
	const h = harness(t);
	h.add();
	h.api.repoInfo = async () => { throw new GitHubError("transient"); };
	await h.publisher.kick("one");
	for (let attempt = 1; attempt < 8; attempt++) {
		assert.equal(h.record().delivery.attempts, attempt);
		assert.equal(h.delay(), 1000 * 2 ** (attempt - 1));
		await h.advance(h.delay());
	}
	assert.equal(h.record().delivery.attempts, 8);
	assert.equal(h.record().delivery.state, "failed");
	assert.equal(h.notifications.length, 1);
});

test("ambiguous create then marker found sends with exactly one POST", async (t) => {
	const h = harness(t);
	h.add();
	let creates = 0;
	h.issues.createIssue = async () => { creates++; throw new GitHubError("transient", { codes: ["malformed"] }); };
	h.issues.findIssueByMarker = async (_api, args) => {
		assert.equal(args.marker, h.body.marker("one"));
		assert.equal(args.creator, "owner");
		assert.equal(args.label, "inbox-report");
		assert.equal(args.since.toISOString(), "2026-10-27T23:50:00.000Z");
		return { matches: [{ number: 4, url: "/4" }, { number: 2, url: "/2" }], complete: false };
	};
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "reconciling");
	assert.equal(h.delay(), 5000);
	await h.advance(5000);
	assert.equal(creates, 1);
	assert.equal(h.record().delivery.state, "sent");
	assert.equal(h.record().github.number, 2);
	assert.ok(h.logs.includes("report one reconciling duplicate"));
});

test("complete absent marker permits second create with the frozen request", async (t) => {
	const h = harness(t);
	h.add();
	const requests = [];
	h.issues.createIssue = async (_api, request) => {
		requests.push(request);
		if (requests.length === 1) throw new GitHubError("transient");
		return { number: 2, url: "/2" };
	};
	await h.publisher.kick("one");
	await h.advance(5000);
	assert.equal(h.record().delivery.state, "sent");
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[0], requests[1]);
	assert.equal(h.calls.filter((call) => call === "body").length, 1);
});

test("three ambiguous creates fail only after third complete reconciliation", async (t) => {
	const h = harness(t);
	h.add();
	let creates = 0;
	h.issues.createIssue = async () => { creates++; throw new GitHubError("transient"); };
	await h.publisher.kick("one");
	await h.advance(5000);
	await h.advance(5000);
	assert.equal(h.record().delivery.state, "reconciling");
	await h.advance(5000);
	assert.equal(creates, 3);
	assert.equal(h.record().delivery.lastError.kind, "transient");
	assert.equal(h.notifications.length, 1);
});

test("restart from persisted creating reconciles before any POST", async (t) => {
	const h = harness(t);
	const record = h.add();
	h.store.update("one", {
		issueRequest: { title: "frozen", body: "frozen", labels: ["inbox-report"] },
		delivery: { ...record.delivery, state: "creating", creates: 1, uncertainSince: h.now().toISOString() },
	});
	h.publisher.stop();
	const restarted = createPublisher(h.options);
	t.after(() => restarted.stop());
	h.issues.findIssueByMarker = async () => {
		h.calls.push("find");
		return { matches: [{ number: 9, url: "/9" }], complete: true };
	};
	await restarted.start();
	assert.deepEqual(h.calls, ["repo", "label", "login", "find"]);
	assert.equal(h.record().github.number, 9);
});

test("retry resets failure and publishes successfully", async (t) => {
	const h = harness(t);
	h.add();
	const create = h.issues.createIssue;
	h.issues.createIssue = async () => { throw new GitHubError("auth"); };
	await h.publisher.kick("one");
	h.issues.createIssue = create;
	assert.equal(h.publisher.retry("one"), true);
	assert.equal(h.record().delivery.state, "queued");
	assert.equal(h.record().delivery.attempts, 0);
	assert.equal(h.record().delivery.lastError, null);
	await h.publisher.kick("one");
	assert.equal(h.record().delivery.state, "sent");
	assert.equal(h.publisher.retry("one"), false);
	assert.equal(h.publisher.retry("missing"), false);
});

test("two records are strictly serial FIFO and duplicate kicks coalesce", async (t) => {
	const h = harness(t);
	h.add("one");
	h.add("two");
	const entered = Promise.withResolvers();
	const release = Promise.withResolvers();
	let active = 0;
	const titles = [];
	h.issues.createIssue = async (_api, request) => {
		assert.equal(active++, 0);
		titles.push(request.title);
		if (titles.length === 1) {
			entered.resolve();
			await release.promise;
		}
		active--;
		return { number: titles.length, url: "/issue" };
	};
	const first = h.publisher.kick("one");
	await entered.promise;
	const duplicate = h.publisher.kick("one");
	const second = h.publisher.kick("two");
	assert.deepEqual(titles, ["Title one"]);
	release.resolve();
	await Promise.all([first, duplicate, second]);
	assert.deepEqual(titles, ["Title one", "Title two"]);
	assert.equal(h.calls.filter((call) => call === "repo").length, 1);
	assert.equal(h.calls.filter((call) => call === "label").length, 1);
});

test("incomplete lookup backs off without another POST", async (t) => {
	const h = harness(t);
	h.add();
	let creates = 0;
	h.issues.createIssue = async () => { creates++; throw new GitHubError("transient"); };
	h.issues.findIssueByMarker = async () => ({ matches: [], complete: false });
	await h.publisher.kick("one");
	await h.advance(5000);
	assert.equal(creates, 1);
	assert.equal(h.record().delivery.state, "reconciling");
	assert.equal(h.delay(), 1000);
	await h.advance(1000);
	assert.equal(creates, 1);
	assert.equal(h.delay(), 2000);
});

test("start respects persisted retry deadlines and stop clears timers", async (t) => {
	const h = harness(t);
	const record = h.add();
	h.store.update("one", {
		delivery: { ...record.delivery, state: "retry_wait", nextAttemptAt: new Date(+h.now() + 1234).toISOString() },
	});
	await h.publisher.start();
	assert.deepEqual(h.calls, []);
	assert.equal(h.delay(), 1234);
	h.publisher.stop();
	assert.equal(h.timers.size, 0);
	await h.advance(2000);
	assert.deepEqual(h.calls, []);
});

test("disabled issues and attachment conflicts map to fixed failure kinds", async (t) => {
	for (const kind of ["issues_disabled", "attachment_conflict"]) {
		const h = harness(t);
		h.add("one", kind === "attachment_conflict");
		if (kind === "issues_disabled") h.api.repoInfo = async () => ({ private: true, hasIssues: false });
		else h.assets.putAsset = async () => { throw new GitHubError("validation", { codes: ["attachment_conflict"] }); };
		await h.publisher.kick("one");
		assert.equal(h.record().delivery.lastError.kind, kind);
		assert.ok(!h.calls.includes("create"));
	}
});

test("reconciliation rate limit retains uncertainty across retry_wait and restart", async (t) => {
	const h = harness(t);
	h.add();
	let creates = 0;
	let finds = 0;
	h.issues.createIssue = async () => { creates++; throw new GitHubError("transient"); };
	h.issues.findIssueByMarker = async () => {
		if (++finds === 1) throw new GitHubError("rate_limit", { retryAt: new Date(+h.now() + 2000) });
		return { matches: [{ number: 3, url: "/3" }], complete: true };
	};
	await h.publisher.kick("one");
	await h.advance(5000);
	assert.equal(h.record().delivery.state, "retry_wait");
	assert.ok(h.record().delivery.uncertainSince);
	h.publisher.stop();
	const restarted = createPublisher(h.options);
	t.after(() => restarted.stop());
	await restarted.start();
	await h.advance(2000);
	assert.equal(creates, 1);
	assert.equal(finds, 2);
	assert.equal(h.record().delivery.state, "sent");
});
