import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createServer } from "../src/server.mjs";
import { createReopener } from "../src/reopen.mjs";

const START = Date.parse("2026-10-17T00:00:00Z");
const TAILNET = { "x-forwarded-for": "100.64.0.50", "tailscale-user-login": "owner@example.com" };
const SID = "reopen-sid-0001";
const toSlash = (value) => String(value).replace(/\\/g, "/");

async function withServer(t, options = {}) {
	const tmp = makeTmpHome("inbox-reopen-");
	const server = createServer({
		home: tmp.home,
		webDir: path.join(tmp.home, "web"),
		port: 0,
		config: { v: 1, port: 0, publicBase: null, pcTailnetIps: ["100.64.0.9"] },
		now: () => new Date(START),
		reopener: options.reopener,
	});
	const { port } = await server.listen();
	t.after(async () => {
		await server.close();
		tmp.cleanup();
	});
	return { home: tmp.home, base: `http://127.0.0.1:${port}` };
}

function post(ctx, p, body = {}, headers = {}) {
	return fetch(ctx.base + p, {
		method: "POST",
		headers: { "content-type": "application/json", "x-inbox": "1", ...headers },
		body: JSON.stringify(body),
	});
}

async function postJson(ctx, p, body, headers = {}) {
	const res = await post(ctx, p, body, headers);
	return { status: res.status, body: await res.json() };
}

async function getJson(ctx, p, headers = {}) {
	const res = await fetch(ctx.base + p, { headers });
	return { status: res.status, body: await res.json() };
}

async function seed(ctx, meta = { title: "reopen test" }) {
	const res = await postJson(ctx, `/api/threads/${SID}/meta`, meta);
	assert.equal(res.status, 200);
}

const okReopener = (calls = []) => ({
	reopen: async (sid, thread) => {
		calls.push({ sid, thread });
		return { ok: true, via: "wt" };
	},
});

test("a known session is reopened through the injected reopener; the body is ignored", async (t) => {
	const calls = [];
	const ctx = await withServer(t, { reopener: okReopener(calls) });
	await seed(ctx, { title: "reopen test", cwd: "C:/seeded-cwd" });
	const res = await postJson(ctx, `/api/threads/${SID}/reopen`, { cwd: "C:/ignored", command: "ignored" });
	assert.deepEqual(res, { status: 200, body: { ok: true, via: "wt" } });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].sid, SID);
	assert.equal(calls[0].thread.cwd, "C:/seeded-cwd");
	assert.equal(calls[0].thread.command, undefined);
});

test("tailnet callers may reopen; the funnel header is rejected with the same status as a read route", async (t) => {
	const ctx = await withServer(t, { reopener: okReopener() });
	await seed(ctx);
	const tailnet = await postJson(ctx, `/api/threads/${SID}/reopen`, {}, TAILNET);
	assert.deepEqual(tailnet, { status: 200, body: { ok: true, via: "wt" } });
	const funnelHeaders = { ...TAILNET, "tailscale-funnel-request": "1" };
	const funnel = await postJson(ctx, `/api/threads/${SID}/reopen`, {}, funnelHeaders);
	const read = await getJson(ctx, "/api/threads", funnelHeaders);
	assert.equal(funnel.status, read.status);
	assert.equal(funnel.status, 403);
});

test("a live or just-closed-by-reload session is never reopened", async (t) => {
	let calls = 0;
	const ctx = await withServer(t, {
		reopener: {
			reopen: async () => {
				calls += 1;
				return { ok: true, via: "wt" };
			},
		},
	});
	await seed(ctx);
	await getJson(ctx, `/api/here?session=${SID}&cwd=${encodeURIComponent(process.cwd())}`);
	assert.deepEqual(await postJson(ctx, `/api/threads/${SID}/reopen`, {}), { status: 409, body: { error: "live" } });

	const bye = await postJson(ctx, "/api/bye", { session: SID });
	assert.equal(bye.status, 200);
	assert.deepEqual(await postJson(ctx, `/api/threads/${SID}/reopen`, {}), { status: 409, body: { error: "live" } });
	assert.equal(calls, 0);
});

test("an unknown session is 404 and the notices sid is 400, neither reaches the reopener", async (t) => {
	let calls = 0;
	const ctx = await withServer(t, {
		reopener: {
			reopen: async () => {
				calls += 1;
				return { ok: true, via: "wt" };
			},
		},
	});
	assert.deepEqual(await postJson(ctx, "/api/threads/no-such-session-01/reopen", {}), { status: 404, body: { error: "not_found" } });
	assert.deepEqual(await postJson(ctx, "/api/threads/_notices/reopen", {}), { status: 400, body: { error: "bad_input" } });
	assert.equal(calls, 0);
});

test("reopener errors map to 409, 409, 503 and 502 with the error string", async (t) => {
	const expected = { cwd_missing: 409, no_session: 409, no_launcher: 503, launch_failed: 502 };
	let next;
	const ctx = await withServer(t, { reopener: { reopen: async () => next } });
	await seed(ctx);
	for (const [error, status] of Object.entries(expected)) {
		next = { ok: false, error };
		assert.deepEqual(await postJson(ctx, `/api/threads/${SID}/reopen`, {}), { status, body: { error } });
	}
});

test("the real reopener writes one sink line through wt; a second press is already and adds no line", async (t) => {
	const tmp = makeTmpHome("inbox-reopen-bin-");
	t.after(() => tmp.cleanup());
	const binDir = path.join(tmp.home, "bin");
	const cwd = path.join(tmp.home, "project");
	const localAppData = path.join(tmp.home, "local");
	const sessionFile = path.join(tmp.home, "x.jsonl");
	const sink = path.join(tmp.home, "reopen-sink.jsonl");
	fs.mkdirSync(binDir);
	fs.mkdirSync(cwd);
	fs.mkdirSync(localAppData);
	fs.writeFileSync(path.join(binDir, "wt.exe"), "");
	fs.writeFileSync(path.join(binDir, "omo.exe"), "");
	fs.writeFileSync(sessionFile, "");

	const reopener = createReopener({
		env: { PATH: binDir, LOCALAPPDATA: localAppData, INBOX_REOPEN_SINK: sink },
		log: () => {},
	});
	const ctx = await withServer(t, { reopener });
	await seed(ctx, { title: "reopen-it", cwd, sessionFile: toSlash(sessionFile) });

	const first = await postJson(ctx, `/api/threads/${SID}/reopen`, {});
	assert.deepEqual(first, { status: 200, body: { ok: true, via: "sink" } });
	const lines = fs.readFileSync(sink, "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	const entry = JSON.parse(lines[0]);
	assert.equal(entry.sid, SID);
	assert.equal(entry.attempts[0].via, "wt");
	assert.deepEqual(entry.attempts[0].args, [
		"-w",
		"-1",
		"new-tab",
		"-d",
		toSlash(cwd),
		"--title",
		"reopen-it",
		path.join(binDir, "omo.exe"),
		"--session",
		toSlash(sessionFile),
	]);

	const second = await postJson(ctx, `/api/threads/${SID}/reopen`, {});
	assert.deepEqual(second, { status: 200, body: { ok: true, via: "sink", already: true } });
	assert.equal(fs.readFileSync(sink, "utf8").trim().split("\n").length, 1);
});
