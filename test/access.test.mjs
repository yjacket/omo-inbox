import test from "node:test";
import assert from "node:assert/strict";

import { ALLOW, classify, postGuard } from "../src/access.mjs";

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

test("non-loopback remoteAddress is rejected before anything else", () => {
	for (const remoteAddress of ["192.168.0.10", "100.64.0.55", "", undefined]) {
		assert.equal(classify({ remoteAddress, headers: { host: "localhost" } }), "reject");
	}
});

test("funnel request header is rejected even from loopback", () => {
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost", "tailscale-funnel-request": "?1" },
		}),
		"reject",
	);
});

test("no x-forwarded-for: only loopback hosts are local", () => {
	for (const remoteAddress of LOOPBACK) {
		for (const host of ["127.0.0.1", "localhost", "LOCALHOST:7777", "127.0.0.1:8080"]) {
			assert.equal(classify({ remoteAddress, headers: { host } }), "local", `${host}`);
		}
	}
	for (const host of ["example.com", "localhost.evil.com", "127.0.0.1.evil.com", "", undefined]) {
		assert.equal(classify({ remoteAddress: "127.0.0.1", headers: { host } }), "reject", `${host}`);
	}
});

test("x-forwarded-for equal to a pcIp classifies as pc without identity headers", () => {
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { "x-forwarded-for": "100.64.0.55" },
			pcIps: ["100.64.0.55"],
		}),
		"pc",
	);
});

test("x-forwarded-for with a non-pc ip rejects without identity headers", () => {
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { "x-forwarded-for": "100.64.0.56" },
			pcIps: ["100.64.0.55"],
		}),
		"reject",
	);
});

test("forwarded traffic without a tailscale identity rejects", () => {
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { "x-forwarded-for": "100.64.0.9" },
			pcIps: [],
			owner: "a@b",
		}),
		"reject",
	);
});

test("owner set rejects a mismatching tailscale login", () => {
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "x@y" },
			pcIps: [],
			owner: "a@b",
		}),
		"reject",
	);
});

test("owner set accepts the matching tailscale login", () => {
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "a@b" },
			pcIps: [],
			owner: "a@b",
		}),
		"tailnet",
	);
});

test("owner null accepts any tailscale login", () => {
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "anyone@example.com" },
			pcIps: [],
			owner: null,
		}),
		"tailnet",
	);
});

test("first forwarded entry wins and is trimmed", () => {
	assert.equal(
		classify({
			remoteAddress: "::1",
			headers: { "x-forwarded-for": " 100.64.0.55 , 10.0.0.1" },
			pcIps: ["100.64.0.55"],
			owner: "a@b",
		}),
		"pc",
	);
});

test("ALLOW maps roles to the contract's classes", () => {
	assert.deepEqual(ALLOW, {
		read: ["local", "pc", "tailnet"],
		feedback: ["local", "pc", "tailnet"],
		session: ["local"],
		open: ["local", "pc"],
		reopen: ["local", "pc", "tailnet"],
	});
});

test("reopen is tailnet-reachable and a funnel request is rejected, never reopen", () => {
	assert.ok(ALLOW.reopen.includes("tailnet"));
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost", "tailscale-funnel-request": "?1" },
		}),
		"reject",
	);
	assert.equal(ALLOW.reopen.includes("reject"), false);
});

test("postGuard requires json content-type and x-inbox", () => {
	assert.equal(postGuard({}), false);
	assert.equal(postGuard({ "content-type": "text/plain", "x-inbox": "1" }), false);
	assert.equal(postGuard({ "content-type": "application/json", "x-inbox": "0" }), false);
	assert.equal(
		postGuard({ "content-type": "application/json; charset=utf-8", "x-inbox": "1" }),
		true,
	);
});

test("qa scenario: pcIp traffic is pc, funnel header forces reject", () => {
	const headers = {
		"x-forwarded-for": "100.64.0.55",
		"tailscale-user-login": "a@b",
	};
	assert.equal(
		classify({ remoteAddress: "127.0.0.1", headers, pcIps: ["100.64.0.55"] }),
		"pc",
	);
	assert.equal(
		classify({
			remoteAddress: "127.0.0.1",
			headers: { ...headers, "tailscale-funnel-request": "?1" },
			pcIps: ["100.64.0.55"],
		}),
		"reject",
	);
});
