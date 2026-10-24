import test from "node:test";
import assert from "node:assert/strict";
import { handleClick } from "../web/sw.js";

const ITEM_ID = "i-260101-abc123";
const URL = "https://inbox.example.ts.net/s/01a14658-5241-79c1-a5c6-fc15b8380a83#i-260101-abc123";
const DATA = { url: URL, itemId: ITEM_ID };

function clientsStub() {
	const opened = [];
	return {
		opened,
		client: {
			matchAll: async () => [],
			openWindow: async (url) => {
				opened.push(url);
				return null;
			},
		},
	};
}

test("a close action POSTs the control once and opens nothing on 2xx", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return { ok: true, status: 200 };
	};
	const clients = clientsStub();
	const result = await handleClick(DATA, "close", fetchImpl, clients.client);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `/api/items/${ITEM_ID}/action`);
	assert.equal(calls[0].init.method, "POST");
	assert.deepEqual(calls[0].init.headers, { "content-type": "application/json", "x-inbox": "1" });
	assert.deepEqual(JSON.parse(calls[0].init.body), { action: "close" });
	assert.equal(clients.opened.length, 0);
	assert.equal(result.opened, false);
});

test("a close action that fails (409) opens the thread like a plain click", async () => {
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		return { ok: false, status: 409 };
	};
	const clients = clientsStub();
	const result = await handleClick(DATA, "close", fetchImpl, clients.client);

	assert.equal(calls.length, 1);
	assert.deepEqual(clients.opened, [URL]);
	assert.equal(result.opened, true);
});

test("a close action that throws opens the thread", async () => {
	const clients = clientsStub();
	const result = await handleClick(DATA, "close", async () => {
		throw new Error("offline");
	}, clients.client);

	assert.deepEqual(clients.opened, [URL]);
	assert.equal(result.opened, true);
});
