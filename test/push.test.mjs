import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createPusher, encryptPayload, generateVapidKeys, loadVapidKeys, vapidHeader } from "../src/push.mjs";

const unb64u = (text) => Buffer.from(text, "base64url");
const NOW = Date.parse("2026-01-01T00:00:00Z");

// RFC 8291 section 5 and appendix A.
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function subscriptionFor(endpoint) {
	const ua = crypto.createECDH("prime256v1");
	ua.generateKeys();
	return {
		endpoint,
		keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
	};
}

function withPusher(t, { fetch, log = () => {} } = {}) {
	const tmp = makeTmpHome("inbox-push-");
	t.after(() => tmp.cleanup());
	const dir = path.join(tmp.home, "push");
	return { dir, pusher: createPusher({ dir, fetch, now: () => NOW, log }) };
}

test("encryptPayload reproduces the RFC 8291 appendix A message byte for byte", () => {
	const body = encryptPayload({
		payload: RFC.plaintext,
		p256dh: RFC.uaPublic,
		auth: RFC.auth,
		salt: unb64u(RFC.salt),
		localKeys: { privateKey: unb64u(RFC.asPrivate), publicKey: unb64u(RFC.asPublic) },
	});
	assert.equal(body.length, 86 + RFC.plaintext.length + 1 + 16);
	assert.equal(body.toString("base64url"), RFC.body);
	assert.equal(body.readUInt32BE(16), 4096);
	assert.equal(body[20], 65);
});

test("encryptPayload with random salt and keys differs every time but keeps the header shape", () => {
	const subscription = subscriptionFor("https://push.example/a");
	const one = encryptPayload({ payload: "x", ...{ p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } });
	const two = encryptPayload({ payload: "x", ...{ p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } });
	assert.notDeepEqual(one, two);
	assert.equal(one.length, 21 + 65 + 1 + 1 + 16);
	assert.equal(one[21], 0x04);
});

test("vapidHeader carries a verifiable ES256 JWT with the endpoint origin", () => {
	const keys = generateVapidKeys();
	const header = vapidHeader({ endpoint: "https://fcm.example.test/fcm/send/abc?x=1", keys, now: NOW });
	const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
	assert.ok(match, header);
	const [, head, claims, signature, k] = match;
	assert.equal(k, keys.publicKey);
	assert.deepEqual(JSON.parse(unb64u(head).toString()), { typ: "JWT", alg: "ES256" });
	assert.deepEqual(JSON.parse(unb64u(claims).toString()), {
		aud: "https://fcm.example.test",
		exp: Math.floor(NOW / 1000) + 12 * 60 * 60,
		sub: "mailto:omo-inbox@example.invalid",
	});
	const point = unb64u(k);
	assert.equal(point.length, 65);
	assert.equal(point[0], 0x04);
	const publicKey = crypto.createPublicKey({
		key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
		format: "jwk",
	});
	assert.equal(unb64u(signature).length, 64);
	assert.ok(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, unb64u(signature)));
});

test("vapid.json is created once and reused", (t) => {
	const tmp = makeTmpHome("inbox-vapid-");
	t.after(() => tmp.cleanup());
	const dir = path.join(tmp.home, "push");
	const file = path.join(dir, "vapid.json");
	assert.equal(fs.existsSync(file), false);
	const first = createPusher({ dir, fetch: async () => ({ status: 201 }) });
	const written = fs.readFileSync(file, "utf8");
	assert.equal(unb64u(first.publicKey).length, 65);
	assert.deepEqual(fs.readdirSync(dir), ["vapid.json"]);

	const second = createPusher({ dir, fetch: async () => ({ status: 201 }) });
	assert.equal(second.publicKey, first.publicKey);
	assert.equal(fs.readFileSync(file, "utf8"), written);
	assert.deepEqual(loadVapidKeys(dir).publicKey, first.publicKey);
});

test("subscribe dedupes by endpoint and stores created, ua and via", (t) => {
	const { dir, pusher } = withPusher(t, { fetch: async () => ({ status: 201 }) });
	const sub = subscriptionFor("https://push.example/one");
	pusher.subscribe(sub, { ua: "old", via: "local" });
	pusher.subscribe(sub, { ua: "Samsung", via: "tailnet" });
	pusher.subscribe(subscriptionFor("https://push.example/two"), { ua: "pc", via: "pc" });
	const list = pusher.list();
	assert.deepEqual(list.map((entry) => entry.endpoint).sort(), ["https://push.example/one", "https://push.example/two"]);
	const one = list.find((entry) => entry.endpoint.endsWith("/one"));
	assert.equal(one.ua, "Samsung");
	assert.equal(one.via, "tailnet");
	assert.equal(one.created, new Date(NOW).toISOString());
	assert.deepEqual(one.keys, sub.keys);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "subscriptions.json"), "utf8")), list);

	pusher.unsubscribe("https://push.example/one");
	assert.deepEqual(pusher.list().map((entry) => entry.endpoint), ["https://push.example/two"]);
});

test("notify keeps 201 and 202, removes 404 and 410, keeps and logs 500 and rejected fetches", async (t) => {
	const statuses = new Map([
		["https://push.example/created", 201],
		["https://push.example/accepted", 202],
		["https://push.example/gone", 404],
		["https://push.example/expired", 410],
		["https://push.example/broken", 500],
		["https://push.example/offline", "reject"],
		["https://push.example/throws", "throw"],
	]);
	const requests = [];
	const logs = [];
	const fetch = async (endpoint, init) => {
		requests.push({ endpoint, init });
		const behavior = statuses.get(endpoint);
		if (behavior === "reject") throw new Error("network down");
		if (behavior === "throw") return Promise.reject(new TypeError("boom"));
		return { status: behavior };
	};
	const { pusher } = withPusher(t, { fetch, log: (line) => logs.push(line) });
	for (const endpoint of statuses.keys()) pusher.subscribe(subscriptionFor(endpoint), {});

	const results = await pusher.notify({ title: "t", body: "b", url: "/p/260101-abcd", tag: "inbox-260101-abcd" });
	assert.equal(results.length, statuses.size);
	const byEndpoint = new Map(results.map((result) => [result.endpoint, result]));
	assert.equal(byEndpoint.get("https://push.example/created").delivered, true);
	assert.equal(byEndpoint.get("https://push.example/accepted").delivered, true);
	assert.equal(byEndpoint.get("https://push.example/gone").removed, true);
	assert.equal(byEndpoint.get("https://push.example/expired").removed, true);
	assert.equal(byEndpoint.get("https://push.example/broken").delivered, false);
	assert.match(byEndpoint.get("https://push.example/offline").error, /network down/);

	assert.deepEqual(
		pusher.list().map((entry) => entry.endpoint).sort(),
		["https://push.example/accepted", "https://push.example/broken", "https://push.example/created", "https://push.example/offline", "https://push.example/throws"],
	);
	assert.ok(logs.some((line) => line.includes("500")));
	assert.ok(logs.some((line) => line.includes("network down")));
	assert.ok(logs.some((line) => line.includes("410")));

	const sent = requests.find((request) => request.endpoint.endsWith("/created")).init;
	assert.equal(sent.method, "POST");
	assert.equal(sent.headers.TTL, "86400");
	assert.equal(sent.headers.Urgency, "high");
	assert.equal(sent.headers["Content-Encoding"], "aes128gcm");
	assert.equal(sent.headers["Content-Type"], "application/octet-stream");
	assert.match(sent.headers.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${pusher.publicKey}$`));
	assert.ok(Buffer.isBuffer(sent.body));
	assert.ok(sent.body.length > 86);
});

test("notify never throws, even when fetch throws synchronously or a stored key is garbage", async (t) => {
	const { dir, pusher } = withPusher(t, {
		fetch: () => {
			throw new Error("sync failure");
		},
	});
	pusher.subscribe(subscriptionFor("https://push.example/sync"), {});
	const damaged = JSON.parse(fs.readFileSync(path.join(dir, "subscriptions.json"), "utf8"));
	damaged.push({ endpoint: "https://push.example/garbage", keys: { p256dh: "AAAA", auth: "AAAA" } });
	fs.writeFileSync(path.join(dir, "subscriptions.json"), JSON.stringify(damaged));
	const results = await pusher.notify({ title: "t", body: "b", url: "/", tag: "x" });
	assert.equal(results.length, 2);
	assert.ok(results.every((result) => result.delivered === false && typeof result.error === "string"));
	assert.equal(pusher.list().length, 2);
});

test("notify sets the Topic header only for a valid base64url topic", async (t) => {
	const requests = [];
	const { pusher } = withPusher(t, {
		fetch: async (endpoint, init) => {
			requests.push({ endpoint, init });
			return { status: 201 };
		},
	});
	pusher.subscribe(subscriptionFor("https://push.example/topic"), {});
	const message = { title: "🙋 thread", body: "b", url: "/s/abc#i-1", tag: "s-abc" };

	const topic = "a".repeat(32);
	await pusher.notify(message, { topic });
	assert.equal(requests[0].init.headers.Topic, topic);

	for (const bad of ["a".repeat(33), "bad topic!", "🙋".repeat(2), "", null]) {
		await pusher.notify(message, { topic: bad });
		assert.equal("Topic" in requests.at(-1).init.headers, false, `Topic must be dropped for ${JSON.stringify(bad)}`);
	}
	await pusher.notify(message);
	assert.equal("Topic" in requests.at(-1).init.headers, false);
	await pusher.notifyOne(pusher.list()[0], message, { topic });
	assert.equal(requests.at(-1).init.headers.Topic, topic);
});

test("INBOX_PUSH_SINK appends JSON lines with the pass-through payload and sends nothing", async (t) => {
	const tmp = makeTmpHome("inbox-push-sink-");
	t.after(() => tmp.cleanup());
	const sink = path.join(tmp.home, "push-sink.jsonl");
	const previous = process.env.INBOX_PUSH_SINK;
	process.env.INBOX_PUSH_SINK = sink;
	t.after(() => {
		if (previous === undefined) delete process.env.INBOX_PUSH_SINK;
		else process.env.INBOX_PUSH_SINK = previous;
	});

	const fetches = [];
	const pusher = createPusher({
		dir: path.join(tmp.home, "push"),
		now: () => NOW,
		fetch: async (endpoint) => {
			fetches.push(endpoint);
			return { status: 201 };
		},
	});
	pusher.subscribe(subscriptionFor("https://push.example/one"), {});
	pusher.subscribe(subscriptionFor("https://push.example/two"), {});

	const topic = "b".repeat(32);
	const payload = {
		title: "🙋 thread",
		body: "headline — ask",
		url: "/s/abc#i-1",
		tag: "s-abc",
		renotify: true,
		actions: [{ action: "open", title: "열기" }],
		itemId: "i-1",
		rec: { questionId: "q1", label: "진행" },
		secret: "never written",
	};
	const results = await pusher.notify({ ...payload, secret: undefined }, { topic });
	assert.deepEqual(fetches, []);
	assert.equal(results.length, 2);
	assert.ok(results.every((result) => result.sunk === true && result.delivered === true && result.status === null));

	const lines = fs.readFileSync(sink, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(lines.length, 2);
	assert.deepEqual(lines.map((line) => line.endpoint).sort(), ["https://push.example/one", "https://push.example/two"]);
	for (const line of lines) {
		assert.equal(line.at, new Date(NOW).toISOString());
		assert.equal(line.topic, topic);
		assert.deepEqual(line.payload, {
			title: payload.title,
			body: payload.body,
			url: payload.url,
			tag: payload.tag,
			renotify: true,
			actions: payload.actions,
			itemId: payload.itemId,
			rec: payload.rec,
		});
	}

	await pusher.notifyOne(pusher.list()[1], { title: "t" }, { topic: "c".repeat(32) });
	const appended = fs.readFileSync(sink, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(appended.length, 3);
	assert.deepEqual(appended.at(-1).payload, { title: "t" });
	assert.deepEqual(fetches, []);
});

test("notifyOne sends to that subscription only", async (t) => {
	const hits = [];
	const { pusher } = withPusher(t, {
		fetch: async (endpoint) => {
			hits.push(endpoint);
			return { status: 201 };
		},
	});
	const target = subscriptionFor("https://push.example/target");
	pusher.subscribe(target, {});
	pusher.subscribe(subscriptionFor("https://push.example/other"), {});
	const result = await pusher.notifyOne(target, { title: "t", body: "b", url: "/", tag: "x" });
	assert.equal(result.delivered, true);
	assert.deepEqual(hits, ["https://push.example/target"]);
});
