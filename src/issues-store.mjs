import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
	LIMITS, validateCreate, validateCommand, redactDesignated,
	fingerprint, deriveTitle, isUuidV4, isCanonicalUtcIso,
} from "./issues-contract.mjs";
import { validateRaster, applyMasks, encodePng, sha256Hex } from "./issues-raster.mjs";

const STATUS = {
	bad_input: 400, not_found: 404, gone: 410, key_reused: 409,
	version_conflict: 409, invalid_transition: 409, store_changed: 409,
	forbidden: 403, corrupt_record: 500, locked: 503,
};
const STATES = ["open", "investigating", "needs-check", "resolved"];
const COMMANDS = {
	owner: ["comment", "append_evidence", "confirm", "reopen", "purge"],
	maintainer: ["triage", "comment", "request_check"],
};

export class IssueStoreError extends Error {
	constructor(code, extra = {}) {
		super(code);
		this.name = "IssueStoreError";
		this.code = code;
		this.status = STATUS[code];
		Object.assign(this, extra);
	}
}

function fail(code, extra) {
	throw new IssueStoreError(code, extra);
}

function json(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
	fs.writeFileSync(file, JSON.stringify(value), { flag: "wx" });
}

function atomicJson(file, value) {
	const temporary = `${file}.tmp-${crypto.randomUUID()}`;
	try {
		writeJson(temporary, value);
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function nextState(state, type) {
	if (type === "comment" || type === "append_evidence") return state;
	if (type === "purge") return "tombstone";
	if (type === "triage" && ["open", "investigating"].includes(state)) return "investigating";
	if (type === "request_check" && ["open", "investigating", "needs-check"].includes(state)) return "needs-check";
	if (type === "confirm" && state === "needs-check") return "resolved";
	if (type === "reopen" && ["needs-check", "resolved"].includes(state)) return "open";
	fail("invalid_transition");
}

function validId(id, field = "id") {
	if (!isUuidV4(id)) fail("bad_input", { fields: [field] });
}

function pageLimit(limit) {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("bad_input", { fields: ["limit"] });
}

function absent(owner) {
	if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) fail("locked");
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (error.code === "ESRCH") return;
	}
	fail("locked");
}

// A single server owns this namespace. No source store is opened or mutated.
// Committed events are both the mutation and receipt; no second receipt write
// can be lost independently of the effect. Filesystem operations after the
// reference resolver returns are synchronous, including the CAS and publication.
export function createIssuesStore({
	dataDir, now = () => new Date(), uuid = () => crypto.randomUUID(),
	lockOwner = { pid: process.pid }, redactText,
}) {
	const root = path.join(dataDir, "issues");
	const records = path.join(root, "records");
	const tombstones = path.join(root, "tombstones");
	const lockFile = path.join(root, ".lock");
	fs.mkdirSync(records, { recursive: true });
	fs.mkdirSync(tombstones, { recursive: true });
	if (!Number.isSafeInteger(lockOwner.pid) || lockOwner.pid <= 0) fail("bad_input", { fields: ["lockOwner.pid"] });
	const lock = { pid: lockOwner.pid, startedAt: now().toISOString() };
	// Publish complete lock JSON with a hard link, so process termination cannot
	// leave a partially written owner identity that is impossible to reclaim.
	const candidate = `${lockFile}.tmp-${crypto.randomUUID()}`;
	writeJson(candidate, lock);
	try {
		try {
			fs.linkSync(candidate, lockFile);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			let prior;
			try { prior = json(lockFile); } catch { fail("locked"); }
			absent(prior);
			// Reclaiming must itself be exclusive: two readers of a dead PID
			// must not both unlink the lock (the second could delete the first
			// reader's new live lock). Each dead identity has one atomic claim.
			// If that claimant also died, follow its identity to a new claim.
			// These tiny owner-only receipts survive termination at any step.
			let predecessor = prior;
			for (;;) {
				const claimFile = path.join(root, `.lock-reclaim-${fingerprint(predecessor)}.json`);
				try {
					fs.linkSync(candidate, claimFile);
					break;
				} catch (claim) {
					if (claim.code !== "EEXIST") throw claim;
					try { predecessor = json(claimFile); } catch { fail("locked"); }
					absent(predecessor);
				}
			}
			// A different claimant may have completed before we acquired the
			// dead generation's claim. Never unlink a different owner.
			if (fingerprint(json(lockFile)) !== fingerprint(prior)) fail("locked");
			fs.unlinkSync(lockFile);
			try { fs.linkSync(candidate, lockFile); } catch (claim) {
				if (claim.code === "EEXIST") fail("locked");
				throw claim;
			}
		}
	} finally {
		fs.rmSync(candidate, { force: true });
	}
	let closed = false;
	function close() {
		if (closed) return;
		closed = true;
		if (fs.existsSync(lockFile) && fingerprint(json(lockFile)) === fingerprint(lock)) fs.unlinkSync(lockFile);
	}
	function active() {
		if (closed) fail("locked");
	}
	function removeContent(id) {
		fs.rmSync(path.join(records, id), { recursive: true, force: true });
		// A killed create may have left a complete but unpublished staging
		// tree. Purging that ID must erase those copies as well.
		for (const name of fs.readdirSync(records)) {
			if (name.startsWith(`.tmp-${id}-`)) fs.rmSync(path.join(records, name), { recursive: true, force: true });
		}
	}
	let storeId;
	try {
		const identityFile = path.join(root, "store.json");
		if (!fs.existsSync(identityFile)) {
			const id = uuid();
			validId(id, "storeId");
			atomicJson(identityFile, { v: 1, storeId: id, createdAt: now().toISOString() });
		}
		const identity = json(identityFile);
		if (identity.v !== 1 || !isUuidV4(identity.storeId) || !isCanonicalUtcIso(identity.createdAt)) fail("corrupt_record");
		storeId = identity.storeId;
		// A tombstone wins over all remaining record content, even if cleanup
		// was interrupted. A failed cleanup remains pending and never resurrects.
		for (const name of fs.readdirSync(tombstones)) {
			if (!/^[0-9a-f-]+\.json$/.test(name) || !isUuidV4(name.slice(0, -5))) continue;
			try {
				const marker = json(path.join(tombstones, name));
				removeContent(name.slice(0, -5));
				if (marker.deletion_pending) atomicJson(path.join(tombstones, name), { ...marker, deletion_pending: false });
			} catch {
				// Reads check tombstone existence, not successful physical deletion.
			}
		}
	} catch (error) {
		close();
		if (error instanceof SyntaxError) fail("corrupt_record");
		throw error;
	}

	function location(id) {
		active();
		validId(id);
		if (fs.existsSync(path.join(tombstones, `${id}.json`))) fail("gone");
		return path.join(records, id);
	}

	function readRecord(id) {
		const dir = location(id);
		if (!fs.existsSync(dir)) fail("not_found");
		try {
			const created = json(path.join(dir, "created.json"));
			if (created.v !== 1 || created.id !== id || created.storeId !== storeId ||
				typeof created.description !== "string" || created.title !== deriveTitle(created.description) ||
				!isCanonicalUtcIso(created.createdAt)) fail("corrupt_record");
			const files = fs.readdirSync(path.join(dir, "events")).filter((name) => name !== ".committed.json" && !name.includes(".tmp-"));
			if (!files.length || files.some((name) => !/^\d{6,}\.json$/.test(name))) fail("corrupt_record");
			files.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
			const events = [];
			const receipts = new Map();
			const evidence = [];
			const captures = new Set();
			let state = "open";
			let category = "other";
			let severity = "normal";
			let previousHash = fingerprint(created);
			for (const name of files) {
				const event = json(path.join(dir, "events", name));
				const { hash, ...payload } = event;
				const seq = events.length + 1;
				if (event.v !== 1 || event.seq !== seq || name !== `${String(seq).padStart(6, "0")}.json` ||
					event.previousHash !== previousHash || hash !== fingerprint(payload) ||
					!isUuidV4(event.requestId) || receipts.has(event.requestId) ||
					!/^[0-9a-f]{64}$/.test(event.fingerprint) || !isCanonicalUtcIso(event.acceptedAt) ||
					!["owner", "maintainer"].includes(event.actor) || !["local", "pc", "tailnet"].includes(event.via)) fail("corrupt_record");
				if (seq === 1) {
					if (event.type !== "created" || event.requestId !== id || event.acceptedAt !== created.createdAt || !event.evidenceManifest) fail("corrupt_record");
				} else {
					if (!COMMANDS[event.actor].includes(event.type) || event.command?.type !== event.type) fail("corrupt_record");
					state = nextState(state, event.type);
					if (event.type === "triage") {
						category = event.command.category;
						severity = event.command.severity;
					}
				}
				if (event.state !== state) fail("corrupt_record");
				if (event.correctionCheck !== undefined &&
					(!event.correctionCheck || !["matched", "missing", "mismatch", "unversioned"].includes(event.correctionCheck.status) ||
					!isCanonicalUtcIso(event.correctionCheck.checkedAt))) fail("corrupt_record");
				if (event.evidenceManifest) {
					const manifest = event.evidenceManifest;
					if (manifest.seq !== seq || !isUuidV4(manifest.captureId) || captures.has(manifest.captureId)) fail("corrupt_record");
					const base = path.join(dir, "evidence", manifest.captureId);
					const stored = json(path.join(base, "manifest.json"));
					const context = fs.readFileSync(path.join(base, "context.json"));
					if (fingerprint(stored) !== fingerprint(manifest) ||
						sha256Hex(context) !== manifest.context.sha256 || context.length !== manifest.context.byteLength) fail("corrupt_record");
					const parsed = JSON.parse(context);
					if (parsed.captureId !== manifest.captureId || parsed.visual?.pixels !== undefined) fail("corrupt_record");
					if (manifest.visual.kind === "raster") {
						const image = fs.readFileSync(path.join(base, "image.png"));
						if (sha256Hex(image) !== manifest.visual.sha256 || image.length !== manifest.visual.byteLength) fail("corrupt_record");
					} else if (manifest.visual.kind !== "none") fail("corrupt_record");
					evidence.push(manifest);
					captures.add(manifest.captureId);
				}
				previousHash = hash;
				events.push(event);
				receipts.set(event.requestId, event);
			}
			// This acknowledgement watermark is not a projection or receipt
			// authority. It may lag an event after a lost response, but may never
			// lead it: deleting an acknowledged tail must not silently roll back.
			const acknowledged = json(path.join(dir, "events", ".committed.json"));
			if (!Number.isSafeInteger(acknowledged.seq) || acknowledged.seq < 1 ||
				events[acknowledged.seq - 1]?.hash !== acknowledged.hash) fail("corrupt_record");
			return { dir, created, events, receipts, evidence, state, category, severity, currentSeq: events.length, previousHash, acknowledged };
		} catch (error) {
			if (error.code === "gone" || error.code === "not_found") throw error;
			fail("corrupt_record");
		}
	}

	function validate(body, validator) {
		active();
		const result = validator(body);
		if (!result.ok) fail("bad_input", { fields: result.fields });
		if (result.value.storeId !== storeId) fail("store_changed");
		return result.value;
	}

	function actor(meta, type) {
		if (!meta || !Object.hasOwn(COMMANDS, meta.actor) ||
			!["local", "pc", "tailnet"].includes(meta.via) ||
			(type === "created" ? meta.actor !== "owner" : !COMMANDS[meta.actor].includes(type))) fail("forbidden");
	}

	function redacted(value) {
		const clean = redactDesignated(value).value;
		if (!redactText) return clean;
		function walk(node, evidence = false) {
			if (Array.isArray(node)) return node.map((entry) => walk(entry, evidence));
			if (!node || typeof node !== "object") return node;
			return Object.fromEntries(Object.entries(node).map(([key, entry]) => [
				key, typeof entry === "string" && (["description", "comment", "note", "text"].includes(key) || (key === "excerpt" && evidence))
					? redactText(entry) : walk(entry, evidence || key === "evidence"),
			]));
		}
		return walk(clean);
	}

	async function reference(evidence, meta) {
		if (!evidence) return null;
		const result = meta.resolveReference ? await meta.resolveReference(evidence.source) : { status: "unversioned", checkedAt: now().toISOString() };
		if (!result || !["matched", "missing", "mismatch", "unversioned"].includes(result.status) || !isCanonicalUtcIso(result.checkedAt)) fail("bad_input", { fields: ["referenceCheck"] });
		return { status: result.status, checkedAt: result.checkedAt };
	}

	function stageEvidence(dir, evidence, seq, acceptedAt, referenceCheck, meta) {
		const { visual, ...context } = evidence;
		let image = null;
		let retained = visual;
		if (visual.kind === "raster") {
			const result = validateRaster(visual);
			if (!result.ok) fail("bad_input", { fields: result.fields.map((field) => `evidence.visual.${field}`) });
			const raster = result.value;
			applyMasks(raster.rgba, raster.width, raster.height, raster.masks);
			image = encodePng(raster);
			const { pixels, encoding, ...metadata } = visual;
			retained = { ...metadata, sha256: sha256Hex(image), byteLength: image.length };
		}
		context.visual = retained;
		const bytes = Buffer.from(JSON.stringify(context));
		const manifest = {
			v: 1, seq, captureId: evidence.captureId, observedAt: evidence.observedAt, acceptedAt,
			source: evidence.source, clientBuild: evidence.clientBuild, serverBuild: meta.buildId ?? null,
			referenceCheck, context: { ...context, sha256: sha256Hex(bytes), byteLength: bytes.length }, visual: retained,
		};
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "context.json"), bytes, { flag: "wx" });
		if (image) fs.writeFileSync(path.join(dir, "image.png"), image, { flag: "wx" });
		writeJson(path.join(dir, "manifest.json"), manifest);
		return manifest;
	}

	function replay(record, requestId, digest) {
		const event = record.receipts.get(requestId);
		if (!event) return null;
		if (event.fingerprint !== digest) fail("key_reused");
		if (record.acknowledged.seq < record.currentSeq) {
			atomicJson(path.join(record.dir, "events", ".committed.json"), { seq: record.currentSeq, hash: record.previousHash });
		}
		return response(record, event, true);
	}

	function response(record, event, replayed) {
		const result = {
			replayed, status: event.type === "created" && !replayed ? 201 : 200,
			body: {
				ok: true, id: record.created.id, storeId,
				receipt: { requestId: event.requestId, seq: event.seq, acceptedAt: event.acceptedAt },
				currentSeq: record.currentSeq, state: record.state, evidenceManifest: event.evidenceManifest,
				...(event.correctionCheck ? { correctionCheck: event.correctionCheck } : {}),
			},
		};
		if (event.type === "created") result.body.referenceCheck = event.evidenceManifest.referenceCheck;
		else result.event = replayed ? null : { type: event.type, seq: event.seq };
		return result;
	}

	function eventFor(value, meta, seq, state, acceptedAt, previousHash, evidenceManifest, command = null, correctionCheck = null) {
		const event = {
			v: 1, type: command?.type ?? "created", seq, requestId: value.requestId,
			fingerprint: fingerprint(value), acceptedAt, actor: meta.actor, via: meta.via,
			serverBuild: meta.buildId ?? null, state, command, evidenceManifest, previousHash,
		};
		if (correctionCheck) event.correctionCheck = correctionCheck;
		return { ...event, hash: fingerprint(event) };
	}

	// D8: the resolver owns proposal/thread reads and reports a non-mutating
	// correction identity check before the event is published. A resolver result
	// can only reject or label the command; it cannot alter the payload.
	async function resolveCorrectionCheck(correction, meta) {
		if (!meta.resolveCorrection) return { status: "unversioned", checkedAt: now().toISOString() };
		const result = await meta.resolveCorrection(correction);
		if (!result || result.ok !== true) {
			const fields = Array.isArray(result?.fields) && result.fields.length && result.fields.every((field) => typeof field === "string")
				? result.fields : ["command.correction"];
			fail("bad_input", { fields });
		}
		const check = result.check;
		if (!check || !["matched", "missing", "mismatch", "unversioned"].includes(check.status) || !isCanonicalUtcIso(check.checkedAt)) {
			fail("bad_input", { fields: ["correctionCheck"] });
		}
		return { status: check.status, checkedAt: check.checkedAt };
	}

	async function create(body, meta) {
		const value = validate(body, validateCreate);
		actor(meta, "created");
		const id = value.requestId;
		const digest = fingerprint(value);
		let dir = location(id);
		if (fs.existsSync(dir)) return replay(readRecord(id), id, digest);
		const clean = redacted(value);
		const referenceCheck = await reference(clean.evidence, meta);
		// Recheck after the only asynchronous boundary, before staging or CAS.
		dir = location(id);
		if (fs.existsSync(dir)) return replay(readRecord(id), id, digest);
		const acceptedAt = now().toISOString();
		const temporary = path.join(records, `.tmp-${id}-${crypto.randomUUID()}`);
		try {
			fs.mkdirSync(path.join(temporary, "events"), { recursive: true });
			const manifest = stageEvidence(path.join(temporary, "evidence", clean.evidence.captureId), clean.evidence, 1, acceptedAt, referenceCheck, meta);
			const created = {
				v: 1, id, storeId, title: deriveTitle(clean.description), description: clean.description,
				createdAt: acceptedAt, source: clean.evidence.source,
			};
			writeJson(path.join(temporary, "created.json"), created);
			const event = eventFor(value, meta, 1, "open", acceptedAt, fingerprint(created), manifest);
			writeJson(path.join(temporary, "events", "000001.json"), event);
			writeJson(path.join(temporary, "events", ".committed.json"), { seq: 1, hash: event.hash });
			fs.renameSync(temporary, dir);
			return response({ created, currentSeq: 1, state: "open" }, event, false);
		} finally {
			fs.rmSync(temporary, { recursive: true, force: true });
		}
	}

	async function command(id, body, meta) {
		const value = validate(body, validateCommand);
		actor(meta, value.command.type);
		let record = readRecord(id);
		const digest = fingerprint(value);
		let previous = replay(record, value.requestId, digest);
		if (previous) return previous;
		const clean = redacted(value).command;
		const correctionCheck = clean.type === "request_check" ? await resolveCorrectionCheck(clean.correction, meta) : null;
		const referenceCheck = await reference(clean.evidence, meta);
		record = readRecord(id);
		previous = replay(record, value.requestId, digest);
		if (previous) return previous;
		if (value.expectedSeq !== record.currentSeq) fail("version_conflict", { currentSeq: record.currentSeq, state: record.state });
		const state = nextState(record.state, clean.type);
		const acceptedAt = now().toISOString();
		const seq = record.currentSeq + 1;
		let manifest = null;
		if (clean.evidence) {
			const captureId = clean.evidence.captureId;
			if (record.evidence.some((entry) => entry.captureId === captureId)) fail("bad_input", { fields: ["command.evidence.captureId"] });
			const base = path.join(record.dir, "evidence");
			const temporary = path.join(base, `.tmp-${captureId}-${crypto.randomUUID()}`);
			try {
				manifest = stageEvidence(temporary, clean.evidence, seq, acceptedAt, referenceCheck, meta);
				// Only an unreferenced orphan can occupy this capture ID.
				const destination = path.join(base, captureId);
				fs.rmSync(destination, { recursive: true, force: true });
				fs.renameSync(temporary, destination);
			} finally {
				fs.rmSync(temporary, { recursive: true, force: true });
			}
		}
		const retainedCommand = { ...clean };
		if (Object.hasOwn(retainedCommand, "evidence")) retainedCommand.evidence = manifest ? { captureId: manifest.captureId } : null;
		const event = eventFor(value, meta, seq, state, acceptedAt, record.previousHash, manifest, retainedCommand, correctionCheck);
		if (clean.type === "purge") {
			const file = path.join(tombstones, `${id}.json`);
			const marker = { v: 1, id, storeId, deletion_pending: true, event };
			atomicJson(file, marker);
			removeContent(id);
			atomicJson(file, { ...marker, deletion_pending: false });
		} else {
			atomicJson(path.join(record.dir, "events", `${String(seq).padStart(6, "0")}.json`), event);
			atomicJson(path.join(record.dir, "events", ".committed.json"), { seq, hash: event.hash });
		}
		return response({ ...record, currentSeq: seq, state }, event, false);
	}

	function get(id, { after = 0, limit = 50 } = {}) {
		pageLimit(limit);
		if (!Number.isSafeInteger(after) || after < 0) fail("bad_input", { fields: ["after"] });
		const record = readRecord(id);
		const { v, ...issue } = record.created;
		const events = record.events.filter((event) => event.seq > after).slice(0, limit);
		const last = events.at(-1)?.seq;
		const evidence = record.evidence.filter((manifest) => manifest.seq > after && manifest.seq <= last);
		return { issue, state: record.state, currentSeq: record.currentSeq, events, evidence, nextAfter: last < record.currentSeq ? last : null };
	}

	function list({ state = null, q = null, cursor = null, limit = 50 } = {}) {
		active();
		pageLimit(limit);
		if (state !== null && !STATES.includes(state)) fail("bad_input", { fields: ["state"] });
		if (q !== null && (typeof q !== "string" || Buffer.byteLength(q) > LIMITS.QUERY_BYTES)) fail("bad_input", { fields: ["q"] });
		let anchor = null;
		if (cursor !== null) {
			try {
				if (typeof cursor !== "string" || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
				const bytes = Buffer.from(cursor, "base64url");
				if (bytes.toString("base64url") !== cursor) throw new Error();
				anchor = JSON.parse(bytes.toString("utf8"));
				if (!anchor || Object.keys(anchor).sort().join(",") !== "createdAt,id" ||
					!isUuidV4(anchor.id) || !isCanonicalUtcIso(anchor.createdAt)) throw new Error();
			} catch { fail("bad_input", { fields: ["cursor"] }); }
		}
		const counts = Object.fromEntries(STATES.map((entry) => [entry, 0]));
		const items = [];
		for (const id of fs.readdirSync(records)) {
			if (!isUuidV4(id) || fs.existsSync(path.join(tombstones, `${id}.json`))) continue;
			const record = readRecord(id);
			counts[record.state]++;
			if (state !== null && state !== record.state) continue;
			if (q !== null && !`${record.created.title}\n${record.created.description}`.toLowerCase().includes(q.toLowerCase())) continue;
			const { title, createdAt } = record.created;
			if (anchor && (createdAt > anchor.createdAt || (createdAt === anchor.createdAt && id >= anchor.id))) continue;
			items.push({ id, title, state: record.state, category: record.category, severity: record.severity, createdAt, updatedAt: record.events.at(-1).acceptedAt });
		}
		items.sort((a, b) => a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : (a.createdAt < b.createdAt ? 1 : -1));
		const page = items.slice(0, limit);
		const last = page.at(-1);
		const nextCursor = items.length > limit ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null;
		return { items: page, counts, nextCursor };
	}

	function evidenceImage(id, captureId) {
		validId(captureId, "captureId");
		const record = readRecord(id);
		const manifest = record.evidence.find((entry) => entry.captureId === captureId);
		if (!manifest || manifest.visual.kind !== "raster") fail("not_found");
		return { bytes: fs.readFileSync(path.join(record.dir, "evidence", captureId, "image.png")), sha256: manifest.visual.sha256, byteLength: manifest.visual.byteLength };
	}

	function capabilities() {
		active();
		return { v: 1, storeId, schemas: ["v1"], limits: LIMITS, states: [...STATES], ownerCommands: [...COMMANDS.owner], maintainerCommands: [...COMMANDS.maintainer] };
	}
	return { storeId, capabilities, create, command, get, list, evidenceImage, close };
}
