import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RECORD_SIZE = 4096;
const VAPID_TTL_S = 12 * 60 * 60;
const VAPID_SUBJECT = "mailto:omo-inbox@example.invalid";
const SEND_TIMEOUT_MS = 15000;
const TTL_S = 86400;
const TOPIC_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PAYLOAD_FIELDS = ["title", "body", "url", "tag", "renotify", "actions", "itemId", "rec"];

/** RFC 8030 section 5.4: a Topic is at most 32 base64url characters; anything else is dropped. */
function normalizeTopic(topic) {
	return typeof topic === "string" && TOPIC_RE.test(topic) ? topic : null;
}

/** The JSON payload the phone receives: only the fields the service worker reads. */
function pushPayload(message) {
	const out = {};
	for (const field of PAYLOAD_FIELDS) {
		if (message[field] !== undefined) out[field] = message[field];
	}
	return out;
}

const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
const unb64u = (text) => Buffer.from(String(text), "base64url");

function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${crypto.randomBytes(4).toString("hex")}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, "\t"));
	fs.renameSync(tmp, file);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return null;
	}
}

function privateKeyObject(keys) {
	const point = unb64u(keys.publicKey);
	return crypto.createPrivateKey({
		key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) },
		format: "jwk",
	});
}

/** A new P-256 pair: { publicKey: base64url of the 65-byte point, privateKey: base64url of the 32-byte scalar }. */
export function generateVapidKeys() {
	const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = privateKey.export({ format: "jwk" });
	const point = Buffer.concat([Buffer.from([0x04]), unb64u(jwk.x), unb64u(jwk.y)]);
	return { publicKey: b64u(point), privateKey: jwk.d };
}

/** Load `<dir>/vapid.json`, creating it once when it is missing or unusable. */
export function loadVapidKeys(dir) {
	const file = path.join(dir, "vapid.json");
	const stored = readJson(file);
	if (stored && typeof stored.publicKey === "string" && typeof stored.privateKey === "string" && unb64u(stored.publicKey).length === 65) {
		return { publicKey: stored.publicKey, privateKey: stored.privateKey };
	}
	const keys = generateVapidKeys();
	writeJsonAtomic(file, { v: 1, ...keys });
	return keys;
}

/**
 * RFC 8291 aes128gcm body (RFC 8188 header + one record).
 * `localKeys` is the sender's { publicKey, privateKey } as raw Buffers (65 and 32 bytes).
 */
export function encryptPayload({ payload, p256dh, auth, salt = crypto.randomBytes(16), localKeys = null }) {
	const uaPublic = Buffer.isBuffer(p256dh) ? p256dh : unb64u(p256dh);
	const authSecret = Buffer.isBuffer(auth) ? auth : unb64u(auth);
	const ecdh = crypto.createECDH("prime256v1");
	if (localKeys) ecdh.setPrivateKey(localKeys.privateKey);
	else ecdh.generateKeys();
	const asPublic = localKeys ? Buffer.from(localKeys.publicKey) : ecdh.getPublicKey();

	const secret = ecdh.computeSecret(uaPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
	const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, authSecret, keyInfo, 32));
	const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

	const plaintext = Buffer.concat([Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8"), Buffer.from([0x02])]);
	const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
	const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

	const header = Buffer.alloc(16 + 4 + 1);
	Buffer.from(salt).copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, body]);
}

/** `vapid t=<ES256 JWT>, k=<public key>` for one push service endpoint. `now` is epoch milliseconds. */
export function vapidHeader({ endpoint, keys, now = Date.now() }) {
	const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
	const claims = b64u(
		JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_TTL_S, sub: VAPID_SUBJECT }),
	);
	const input = `${head}.${claims}`;
	const signature = crypto.sign("sha256", Buffer.from(input), { key: privateKeyObject(keys), dsaEncoding: "ieee-p1363" });
	return `vapid t=${input}.${b64u(signature)}, k=${keys.publicKey}`;
}

function describe(error) {
	return error && error.message ? error.message : String(error);
}

export function createPusher({ dir, fetch = globalThis.fetch, now = Date.now, log = () => {}, sink = process.env.INBOX_PUSH_SINK ?? null } = {}) {
	if (!dir) throw new Error("dir is required");
	const keys = loadVapidKeys(dir);
	const file = path.join(dir, "subscriptions.json");

	const read = () => {
		const parsed = readJson(file);
		return Array.isArray(parsed) ? parsed : [];
	};

	const remove = (endpoint) => {
		const all = read();
		const kept = all.filter((entry) => entry.endpoint !== endpoint);
		if (kept.length !== all.length) writeJsonAtomic(file, kept);
	};

	function subscribe(subscription, meta = {}) {
		const entry = {
			endpoint: subscription.endpoint,
			keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
			created: new Date(now()).toISOString(),
			ua: meta.ua ?? "",
			via: meta.via ?? null,
		};
		const others = read().filter((existing) => existing.endpoint !== entry.endpoint);
		writeJsonAtomic(file, [...others, entry]);
		return entry;
	}

	function unsubscribe(endpoint) {
		remove(endpoint);
	}

	async function send(subscription, message, options = {}) {
		const endpoint = subscription.endpoint;
		const result = { endpoint, status: null, delivered: false, removed: false };
		const topic = normalizeTopic(options.topic);
		if (sink) {
			const line = JSON.stringify({ at: new Date(now()).toISOString(), endpoint, topic, payload: message });
			fs.mkdirSync(path.dirname(sink), { recursive: true });
			fs.appendFileSync(sink, `${line}\n`);
			log(`push: sink ${sink}`);
			return { endpoint, status: null, delivered: true, removed: false, sunk: true };
		}
		try {
			const body = encryptPayload({
				payload: JSON.stringify(message),
				p256dh: subscription.keys.p256dh,
				auth: subscription.keys.auth,
			});
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					TTL: String(TTL_S),
					Urgency: "high",
					"Content-Encoding": "aes128gcm",
					"Content-Type": "application/octet-stream",
					Authorization: vapidHeader({ endpoint, keys, now: now() }),
					...(topic ? { Topic: topic } : {}),
				},
				body,
				signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
			});
			result.status = response.status;
			if (response.status === 201 || response.status === 202) {
				result.delivered = true;
			} else if (response.status === 404 || response.status === 410) {
				remove(endpoint);
				result.removed = true;
				log(`push: ${new URL(endpoint).origin} answered ${response.status}, subscription removed`);
			} else {
				log(`push: ${new URL(endpoint).origin} answered ${response.status}, subscription kept`);
			}
		} catch (error) {
			result.error = describe(error);
			log(`push: send failed, subscription kept: ${result.error}`);
		}
		return result;
	}

	async function notify(message, options = {}) {
		const payload = pushPayload(message);
		return Promise.all(read().map((subscription) => send(subscription, payload, options)));
	}

	function notifyOne(subscription, message, options = {}) {
		return send(subscription, pushPayload(message), options);
	}

	return { publicKey: keys.publicKey, subscribe, unsubscribe, list: read, notify, notifyOne };
}
