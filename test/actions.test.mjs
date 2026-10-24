import { test } from "node:test";
import assert from "node:assert/strict";
import { createActions, validateActions } from "../extension/inbox/actions.ts";

function recorder() {
	const posts = [];
	const logs = [];
	let sid = "sid-1";
	const actions = createActions({
		post(path, body) {
			posts.push({ path, body });
		},
		sessionId: () => sid,
		log: (text) => logs.push(text),
	});
	return {
		actions,
		posts,
		logs,
		setSession: (next) => {
			sid = next;
		},
	};
}

test("valid prompt action is posted", async () => {
	const { actions, posts, logs } = recorder();
	await actions.onActions({ v: 1, producer: "keepwarm", actions: [{ key: "warm", label: " 깨우기 ", prompt: "  캐시를 깨워  " }] });
	assert.deepEqual(posts, [{
		path: "/api/threads/sid-1/actions",
		body: { producer: "keepwarm", actions: [{ key: "warm", label: "깨우기", prompt: "캐시를 깨워" }] },
	}]);
	assert.deepEqual(logs, []);
});

test("valid run action is posted", async () => {
	const { actions, posts } = recorder();
	await actions.onActions({ v: 1, producer: "omo-preview", actions: [{ key: "serve", label: "서버", run: true }] });
	assert.equal(posts.length, 1);
	assert.deepEqual(posts[0].body.actions, [{ key: "serve", label: "서버", run: true }]);
});

test("an empty actions array is posted to clear the producer", async () => {
	const { actions, posts } = recorder();
	await actions.onActions({ v: 1, producer: "keepwarm", actions: [] });
	assert.deepEqual(posts, [{ path: "/api/threads/sid-1/actions", body: { producer: "keepwarm", actions: [] } }]);
});

test("invalid payloads are logged and not posted", async () => {
	const cases = [
		{ v: 1, producer: "Bad Producer", actions: [] },
		{ v: 1, producer: "p", actions: [{ key: "a", label: "1234567890123", run: true }] },
		{ v: 1, producer: "p", actions: [{ key: "a", label: "ok", prompt: "x", run: true }] },
		{ v: 1, producer: "p", actions: Array.from({ length: 5 }, (_, index) => ({ key: `k${index}`, label: "ok", run: true })) },
	];
	for (const payload of cases) {
		const { actions, posts, logs } = recorder();
		await actions.onActions(payload);
		assert.equal(posts.length, 0);
		assert.equal(logs.length, 1);
		assert.match(logs[0], /^actions: invalid /);
	}
	const { actions, posts, logs } = recorder();
	await actions.onActions(null);
	assert.equal(posts.length, 0);
	assert.equal(logs[0], "actions: invalid ?: data must be an object");
});

test("resend posts every stored producer", async () => {
	const { actions, posts } = recorder();
	await actions.onActions({ v: 1, producer: "alpha", actions: [{ key: "a", label: "A", run: true }] });
	await actions.onActions({ v: 1, producer: "beta", actions: [{ key: "b", label: "B", prompt: "해" }] });
	posts.length = 0;
	await actions.resend();
	assert.deepEqual(posts.map((entry) => entry.body.producer), ["alpha", "beta"]);
	assert.deepEqual(posts.map((entry) => entry.path), ["/api/threads/sid-1/actions", "/api/threads/sid-1/actions"]);
});

test("no session id means no post, and a later resend delivers it", async () => {
	const { actions, posts, setSession } = recorder();
	setSession(null);
	await actions.onActions({ v: 1, producer: "keepwarm", actions: [{ key: "warm", label: "깨우기", run: true }] });
	assert.equal(posts.length, 0);
	setSession("sid-2");
	await actions.resend();
	assert.deepEqual(posts, [{
		path: "/api/threads/sid-2/actions",
		body: { producer: "keepwarm", actions: [{ key: "warm", label: "깨우기", run: true }] },
	}]);
});

test("validateActions matches the todo 1 provider rules", () => {
	assert.deepEqual(validateActions({
		v: 1,
		producer: "omo-preview",
		actions: [
			{ key: "serve", label: "테스트 서버", run: true },
			{ key: "ping", label: "확인", prompt: "  상태를 확인해  " },
		],
	}), {
		ok: true,
		value: {
			producer: "omo-preview",
			actions: [
				{ key: "serve", label: "테스트 서버", run: true },
				{ key: "ping", label: "확인", prompt: "상태를 확인해" },
			],
		},
	});
	assert.equal(validateActions({ v: 1, producer: "Bad Producer", actions: [] }).ok, false);
	assert.equal(validateActions({ v: 1, producer: "p", actions: [{ key: "a", label: "1234567890123", run: true }] }).ok, false);
	assert.equal(validateActions({ v: 1, producer: "p", actions: [{ key: "a", label: "ok", prompt: "x", run: true }] }).ok, false);
	assert.equal(validateActions({ v: 1, producer: "p", actions: Array.from({ length: 5 }, (_, index) => ({ key: `k${index}`, label: "ok", run: true })) }).ok, false);
});
