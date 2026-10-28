import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATCH_KEYS = ["asset", "issueRequest", "delivery", "github", "handoff"];
const DELIVERY_DEFAULT = {
	state: "queued",
	attempts: 0,
	creates: 0,
	nextAttemptAt: null,
	uncertainSince: null,
	lastError: null,
};

function fail(code, message) {
	const error = new Error(message ?? code);
	error.code = code;
	return error;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.tmp-${crypto.randomUUID()}`;
	try {
		fs.writeFileSync(temporary, JSON.stringify(value));
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function validIso(value) {
	if (typeof value !== "string" || value === "") return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : value;
}

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function imageRecord(png, imageMeta) {
	if (png == null) return imageMeta == null ? null : structuredClone(imageMeta);
	const meta = imageMeta && typeof imageMeta === "object" ? imageMeta : {};
	return {
		sha256: meta.sha256 ?? sha256(png),
		bytes: meta.bytes ?? png.length,
		width: meta.width ?? 0,
		height: meta.height ?? 0,
		provenance: meta.provenance ?? "snapshot",
	};
}

function byNewest(a, b) {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
	if (a.id === b.id) return 0;
	return a.id < b.id ? 1 : -1;
}

export function createReportsStore({ dataDir, now = () => new Date(), renameSync = fs.renameSync } = {}) {
	if (typeof dataDir !== "string" || dataDir === "") throw fail("bad_input", "dataDir is required");
	const root = path.join(dataDir, "reports");
	fs.mkdirSync(root, { recursive: true });

	function dirOf(id) {
		if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
		return path.join(root, id);
	}

	function readRecord(id) {
		const dir = dirOf(id);
		if (!dir) return null;
		const record = readJson(path.join(dir, "report.json"));
		if (!record || typeof record !== "object" || Array.isArray(record)) return null;
		if (record.id !== id || record.v !== 1) return null;
		return record;
	}

	function allRecords() {
		let dirents;
		try {
			dirents = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			return [];
		}
		const records = [];
		for (const dirent of dirents) {
			if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
			const record = readRecord(dirent.name);
			if (record) records.push(record);
		}
		return records.sort(byNewest);
	}

	function create({ id, fingerprint, report, png, imageMeta, legacy = null, createdAt } = {}) {
		if (!dirOf(id)) throw fail("bad_input", "id");
		const at = validIso(createdAt) ?? now().toISOString();
		const finalDir = dirOf(id);
		const existing = readRecord(id);
		if (existing) {
			if (existing.fingerprint === fingerprint) return { created: false, record: structuredClone(existing) };
			throw fail("key_reused", `report id already used: ${id}`);
		}
		const record = {
			v: 1,
			id,
			createdAt: at,
			fingerprint,
			report,
			image: imageRecord(png, imageMeta),
			asset: null,
			issueRequest: null,
			delivery: structuredClone(DELIVERY_DEFAULT),
			github: null,
			handoff: null,
			legacy: legacy ?? null,
		};
		const staging = path.join(root, `.staging-${id}-${crypto.randomBytes(6).toString("hex")}`);
		try {
			fs.mkdirSync(staging, { recursive: true });
			if (png != null) fs.writeFileSync(path.join(staging, "image.png"), png);
			writeJson(path.join(staging, "report.json"), record);
			fs.mkdirSync(root, { recursive: true });
			// A directory without a readable report.json is ignored on read, so it
			// cannot be a live record and must not block this create.
			fs.rmSync(finalDir, { recursive: true, force: true });
			try {
				renameSync(staging, finalDir);
			} catch (error) {
				// Two processes may create the same report at once. The loser's
				// rename fails against the winner's directory; an identical record
				// already there means this create is an exact concurrent replay.
				if (error?.code !== "EPERM" && error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
				const concurrent = readRecord(id);
				if (!concurrent || concurrent.fingerprint !== fingerprint) throw error;
				return { created: false, record: structuredClone(concurrent) };
			}
		} finally {
			fs.rmSync(staging, { recursive: true, force: true });
		}
		return { created: true, record: structuredClone(record) };
	}

	function get(id) {
		const record = readRecord(id);
		return record ? structuredClone(record) : null;
	}

	function update(id, patch = {}) {
		const record = readRecord(id);
		if (!record) throw fail("not_found", `report not found: ${id}`);
		for (const key of PATCH_KEYS) {
			if (Object.hasOwn(patch, key)) record[key] = patch[key];
		}
		writeJson(path.join(dirOf(id), "report.json"), record);
		return structuredClone(record);
	}

	function list({ limit = 50, cursor = null } = {}) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw fail("bad_input", "limit");
		const records = allRecords();
		let start = 0;
		if (cursor != null) {
			const index = records.findIndex((record) => record.id === cursor);
			if (index === -1) return { items: [], nextCursor: null };
			start = index + 1;
		}
		const page = records.slice(start, start + limit);
		const more = start + page.length < records.length;
		return {
			items: page.map((record) => structuredClone(record)),
			nextCursor: more && page.length ? page[page.length - 1].id : null,
		};
	}

	function image(id) {
		const dir = dirOf(id);
		if (!dir) return null;
		try {
			return fs.readFileSync(path.join(dir, "image.png"));
		} catch {
			return null;
		}
	}

	function unfinished() {
		return allRecords()
			.filter((record) => {
				const state = record.delivery?.state;
				return state !== "sent" && state !== "failed";
			})
			.map((record) => structuredClone(record));
	}

	function counts() {
		const result = { pending: 0, failed: 0, sent: 0 };
		for (const record of allRecords()) {
			const state = record.delivery?.state;
			if (state === "failed") result.failed++;
			else if (state === "sent") result.sent++;
			else result.pending++;
		}
		return result;
	}

	return { create, get, list, update, image, unfinished, counts };
}
