import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { safeSegment } from "./paths.mjs";
import { normPath } from "./identity.mjs";

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const SEQ_WIDTH = 6;
const MAX_MARKS = 50;
const MAX_CROP_BYTES = 5 * 1024 * 1024;
const PNG_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fail(code, message, extra) {
	const error = new Error(message);
	error.code = code;
	if (extra) Object.assign(error, extra);
	return error;
}

function toBytes(value, n) {
	if (value == null) return crypto.randomBytes(n);
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	if (Array.isArray(value)) return Buffer.from(value);
	if (typeof value === "string") return Buffer.from(value, "utf8");
	throw fail("bad_input", "rand must return bytes");
}

function charsFromBytes(bytes, n) {
	if (!bytes.length) throw fail("bad_input", "rand returned no bytes");
	let out = "";
	for (let i = 0; i < n; i++) out += ID_CHARS[bytes[i % bytes.length] % ID_CHARS.length];
	return out;
}

function sha256(text) {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function renameWithRetry(from, to) {
	let last;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (error) {
			last = error;
			if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
		}
	}
	throw last;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value));
	renameWithRetry(tmp, file);
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function normalizeRel(rel) {
	const value = String(rel).replace(/\\/g, "/");
	if (!value || value.startsWith("/") || value.includes(":") || /(^|\/)\.\.?(\/|$)/.test(value)) {
		throw fail("bad_input", `bad file path: ${rel}`);
	}
	return value;
}

function boardFacts(board) {
	const frames = new Set();
	for (const section of board.sections || []) {
		for (const card of section.cards || []) {
			for (const frame of card.frames || []) {
				if (Array.isArray(frame) && typeof frame[0] === "string") frames.add(frame[0]);
			}
		}
	}
	const questions = new Map();
	for (const question of board.questions || []) {
		if (question && typeof question.id === "string") {
			questions.set(question.id, new Set((question.options || []).map((option) => option && option.value)));
		}
	}
	return { frames, questions };
}

export function createStore({ dataDir, inboxDir, now = () => new Date(), rand } = {}) {
	const proposalsDir = path.join(dataDir, "proposals");
	const entries = new Map();

	function exists(id) {
		return entries.has(id) || fs.existsSync(path.join(proposalsDir, id));
	}

	function pickChars(n) {
		const value = rand ? rand(n) : null;
		return charsFromBytes(toBytes(value, n), n);
	}

	function makeId() {
		for (let attempt = 0; attempt < 1000; attempt++) {
			const at = now();
			const yy = String(at.getFullYear() % 100).padStart(2, "0");
			const mm = String(at.getMonth() + 1).padStart(2, "0");
			const dd = String(at.getDate()).padStart(2, "0");
			const id = `${yy}${mm}${dd}-${pickChars(4)}`;
			if (!exists(id)) return id;
		}
		throw fail("bad_input", "could not allocate a proposal id");
	}

	function readEvents(dir) {
		let names;
		try {
			names = fs.readdirSync(path.join(dir, "events"));
		} catch {
			return [];
		}
		const events = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const event = readJson(path.join(dir, "events", name));
			if (event && typeof event.seq === "number") events.push(event);
		}
		return events.sort((a, b) => a.seq - b.seq);
	}

	function loadEntry(id, dir) {
		const proposal = readJson(path.join(dir, "proposal.json"));
		if (!proposal || typeof proposal !== "object") return null;
		const events = readEvents(dir);
		const nextSeq = events.length ? events[events.length - 1].seq + 1 : 1;
		return { id, dir, proposal, events, nextSeq };
	}

	function rebuild() {
		entries.clear();
		let dirents;
		try {
			dirents = fs.readdirSync(proposalsDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of dirents) {
			if (!dirent.isDirectory() || dirent.name.includes(".tmp-")) continue;
			const entry = loadEntry(dirent.name, path.join(proposalsDir, dirent.name));
			if (entry) entries.set(dirent.name, entry);
		}
	}

	rebuild();

	function getEntry(id) {
		const entry = entries.get(id);
		if (!entry) throw fail("not_found", `proposal not found: ${id}`);
		return entry;
	}

	function openEntry(id) {
		const entry = getEntry(id);
		if (statusOf(entry) === "closed") throw fail("closed", `proposal is closed: ${id}`);
		return entry;
	}

	function statusOf(entry) {
		if (entry.events.some((event) => event.type === "closed")) return "closed";
		const last = lastNonReplyEvent(entry);
		if (last && last.type === "feedback") return "theirs";
		return "mine";
	}

	function lastNonReplyEvent(entry) {
		for (let i = entry.events.length - 1; i >= 0; i--) {
			if (entry.events[i].type !== "reply") return entry.events[i];
		}
		return undefined;
	}

	function ownerOf(entry) {
		let owner = null;
		for (const event of entry.events) {
			const id = event.session && event.session.id;
			if (id) owner = id;
		}
		return owner;
	}

	function revOf(entry) {
		let rev = 0;
		for (const event of entry.events) {
			if ((event.type === "submitted" || event.type === "revised") && typeof event.rev === "number") rev = event.rev;
		}
		return rev;
	}

	function summaryOf(entry) {
		const { proposal, events } = entry;
		const last = events[events.length - 1];
		const statusEvent = lastNonReplyEvent(entry);
		const approved = statusEvent !== undefined && statusEvent.type === "feedback" && statusEvent.verdict === "approve";
		const closed = events.find((event) => event.type === "closed");
		return {
			id: proposal.id,
			title: proposal.title,
			kind: proposal.kind ?? "decision",
			product: { key: proposal.product.key, name: proposal.product.name },
			feature: { key: proposal.feature.key, branch: proposal.feature.branch, worktree: proposal.feature.worktree },
			status: statusOf(entry),
			approved,
			rev: revOf(entry),
			created: proposal.created,
			updated: last ? last.at : proposal.created,
			lastType: last ? last.type : null,
			owner: ownerOf(entry),
			outcome: closed ? (closed.summary ?? null) : null,
		};
	}

	function writeEvent(entry, event) {
		const seq6 = String(event.seq).padStart(SEQ_WIDTH, "0");
		writeJson(path.join(entry.dir, "events", `${seq6}-${event.type}.json`), event);
		entry.events.push(event);
		entry.nextSeq = event.seq + 1;
	}

	function existingRevs(entry) {
		let dirents;
		try {
			dirents = fs.readdirSync(path.join(entry.dir, "revs"), { withFileTypes: true });
		} catch {
			return [];
		}
		return dirents
			.filter((dirent) => dirent.isDirectory() && /^\d+$/.test(dirent.name))
			.map((dirent) => Number(dirent.name))
			.sort((a, b) => a - b);
	}

	function hashFiles(srcDir, files) {
		const lines = files.map((raw) => {
			const rel = normalizeRel(raw);
			const bytes = fs.readFileSync(path.join(srcDir, rel));
			return `${rel}\n${sha256(bytes)}\n`;
		});
		lines.sort();
		return sha256(Buffer.from(lines.join("")));
	}

	function copyRevision(dir, srcDir, files, rev) {
		const revsDir = path.join(dir, "revs");
		const tmp = path.join(revsDir, `${rev}.tmp-${crypto.randomBytes(4).toString("hex")}`);
		fs.mkdirSync(tmp, { recursive: true });
		const root = path.resolve(srcDir);
		for (const raw of files) {
			const rel = normalizeRel(raw);
			const src = path.resolve(srcDir, rel);
			if (src !== root && !src.startsWith(root + path.sep)) throw fail("bad_input", `file escapes srcDir: ${raw}`);
			const dest = path.join(tmp, rel);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
		}
		const finalDir = path.join(revsDir, String(rev));
		fs.rmSync(finalDir, { recursive: true, force: true });
		fs.renameSync(tmp, finalDir);
	}

	function latestHash(entry) {
		let hash = null;
		for (const event of entry.events) {
			if (event.type === "submitted" || event.type === "revised") hash = event.hash;
		}
		return hash;
	}

	function findOpenSame(identity, title) {
		for (const entry of entries.values()) {
			if (statusOf(entry) === "closed") continue;
			if (entry.proposal.feature.key === identity.feature.key && entry.proposal.title === title) return entry;
		}
		return null;
	}

	function create({ identity, title, srcDir, files = [], note = null, force = false, kind = "decision" } = {}) {
		if (!identity || !title) throw fail("bad_input", "identity and title are required");
		const hash = hashFiles(srcDir, files);
		if (!force) {
			const existing = findOpenSame(identity, title);
			if (existing) {
				if (latestHash(existing) === hash) return { summary: summaryOf(existing), existing: true };
				throw fail("duplicate", `open proposal exists with different content: ${existing.id}`, { id: existing.id });
			}
		}
		const id = makeId();
		const dir = path.join(proposalsDir, id);
		fs.mkdirSync(path.join(dir, "events"), { recursive: true });
		fs.mkdirSync(path.join(dir, "crops"), { recursive: true });
		const created = now();
		copyRevision(dir, srcDir, files, 1);
		const entry = { id, dir, proposal: null, events: [], nextSeq: 1 };
		writeEvent(entry, {
			seq: 1,
			type: "submitted",
			at: created.toISOString(),
			rev: 1,
			note: note ?? null,
			session: identity.session ?? null,
			hash,
		});
		entry.proposal = {
			v: 1,
			id,
			title,
			created: created.toISOString(),
			product: identity.product,
			feature: identity.feature,
			session: identity.session ?? null,
			kind: kind ?? "decision",
		};
		writeJson(path.join(dir, "proposal.json"), entry.proposal);
		entries.set(id, entry);
		return { summary: summaryOf(entry), existing: false };
	}

	function revise(id, { srcDir, files = [], note = null, session = null, kind = "decision" } = {}) {
		const entry = openEntry(id);
		if ((kind ?? "decision") !== (entry.proposal.kind ?? "decision")) throw fail("bad_input", "kind");
		const rev = revOf(entry) + 1;
		const hash = hashFiles(srcDir, files);
		copyRevision(entry.dir, srcDir, files, rev);
		writeEvent(entry, { seq: entry.nextSeq, type: "revised", at: now().toISOString(), rev, note: note ?? null, session, hash });
		return summaryOf(entry);
	}

	function reply(id, { text, session = null } = {}) {
		const entry = openEntry(id);
		writeEvent(entry, { seq: entry.nextSeq, type: "reply", at: now().toISOString(), text, session });
		return summaryOf(entry);
	}

	function close(id, { summary = null, by = "session", session = null } = {}) {
		const entry = openEntry(id);
		writeEvent(entry, { seq: entry.nextSeq, type: "closed", at: now().toISOString(), by, summary, session });
		return summaryOf(entry);
	}

	function prepareMark(mark, index, frames) {
		if (!mark || typeof mark !== "object") throw fail("bad_input", `marks[${index}]`);
		if (!frames.has(mark.frame)) throw fail("bad_input", `marks[${index}].frame: unknown frame label ${mark.frame}`);
		const { x, y, w, h } = mark;
		if (!(x >= 0 && x <= 1)) throw fail("bad_input", `marks[${index}].x`);
		if (!(y >= 0 && y <= 1)) throw fail("bad_input", `marks[${index}].y`);
		if (!(w > 0 && w <= 1)) throw fail("bad_input", `marks[${index}].w`);
		if (!(h > 0 && h <= 1)) throw fail("bad_input", `marks[${index}].h`);
		if (!(x + w <= 1.001)) throw fail("bad_input", `marks[${index}].x + w`);
		if (!(y + h <= 1.001)) throw fail("bad_input", `marks[${index}].y + h`);
		let crop = null;
		if (mark.crop != null) {
			if (typeof mark.crop !== "string" || !mark.crop.startsWith(PNG_PREFIX)) {
				throw fail("bad_input", `marks[${index}].crop: must be a png data url`);
			}
			crop = Buffer.from(mark.crop.slice(PNG_PREFIX.length), "base64");
			if (crop.length > MAX_CROP_BYTES) throw fail("bad_input", `marks[${index}].crop: larger than 5 MiB`);
			if (!crop.subarray(0, 8).equals(PNG_SIGNATURE)) throw fail("bad_input", `marks[${index}].crop: not a png`);
		}
		return { n: index + 1, frame: mark.frame, x, y, w, h, comment: mark.comment ?? null, crop };
	}

	function feedback(id, { rev, verdict, answers = {}, comment = null, marks = [], via = "local", client = "127.0.0.1", ua = "" } = {}) {
		const entry = openEntry(id);
		if (!existingRevs(entry).includes(rev)) throw fail("bad_rev", `no such revision: ${rev}`);
		const board = readJson(path.join(entry.dir, "revs", String(rev), "board.json")) || {};
		const { frames, questions } = boardFacts(board);
		const kind = entry.proposal.kind ?? "decision";
		if (kind === "report") {
			if (verdict !== "ack") throw fail("bad_input", "verdict");
		} else if (verdict !== "change" && verdict !== "approve") {
			throw fail("bad_input", "verdict");
		}
		if (verdict === "ack" && Object.keys(answers || {}).length > 0) throw fail("bad_input", "answers");
		for (const [qid, value] of Object.entries(answers || {})) {
			if (!questions.has(qid)) throw fail("bad_input", `answers: unknown question ${qid}`);
			if (!questions.get(qid).has(value)) throw fail("bad_input", `answers.${qid}: unknown option value`);
		}
		if (!Array.isArray(marks)) throw fail("bad_input", "marks must be an array");
		if (marks.length > MAX_MARKS) throw fail("bad_input", `marks: at most ${MAX_MARKS}`);
		const prepared = marks.map((mark, index) => prepareMark(mark, index, frames));
		if (verdict === "change" && Object.keys(answers || {}).length === 0 && !comment && marks.length === 0) {
			throw fail("bad_input", "empty");
		}
		const seq = entry.nextSeq;
		const seq6 = String(seq).padStart(SEQ_WIDTH, "0");
		const routed = ownerOf(entry);
		const storedMarks = prepared.map((mark) => {
			if (!mark.crop) return { ...mark, crop: null };
			const rel = `crops/${seq6}-${mark.n}.png`;
			const file = path.join(entry.dir, rel);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, mark.crop);
			return { ...mark, crop: rel };
		});
		const nothingToDeliver = verdict === "ack" && !comment && storedMarks.length === 0;
		const event = {
			seq,
			type: "feedback",
			at: now().toISOString(),
			rev,
			verdict,
			answers: answers || {},
			comment: comment ?? null,
			marks: storedMarks,
			via,
			client,
			ua: String(ua).slice(0, 200),
			routed,
			...(nothingToDeliver ? { delivery: "none" } : {}),
		};
		writeEvent(entry, event);
		if (nothingToDeliver) {
			writeEvent(entry, { seq: entry.nextSeq, type: "closed", at: now().toISOString(), by: "user", summary: null, session: null });
		}
		return { summary: summaryOf(entry), event, owner: routed };
	}

	function inboxPath(sessionId, proposalId, seq) {
		const seq6 = String(seq).padStart(SEQ_WIDTH, "0");
		return path.join(inboxDir, safeSegment(sessionId), `${proposalId}-${seq6}.json`);
	}

	function writeInbox(sessionId, payload) {
		if (sessionId == null) throw fail("bad_input", "sessionId is required");
		const file = inboxPath(sessionId, payload.proposalId, payload.seq);
		writeJson(file, payload);
		return file;
	}

	function withDelivery(entry, event) {
		if (event.type !== "feedback") return event;
		const nothingToDeliver = event.verdict === "ack" && !event.comment && (!event.marks || event.marks.length === 0);
		const file = event.routed == null ? null : inboxPath(event.routed, entry.proposal.id, event.seq);
		return { ...event, delivery: event.routed == null || nothingToDeliver ? "none" : fs.existsSync(file) ? "pending" : "delivered" };
	}

	function revsOf(entry) {
		const revs = [];
		for (const event of entry.events) {
			if (event.type === "submitted" || event.type === "revised") revs.push({ n: event.rev, at: event.at, note: event.note ?? null });
		}
		return revs.sort((a, b) => a.n - b.n);
	}

	function get(id, { since = 0 } = {}) {
		const entry = getEntry(id);
		return {
			proposal: entry.proposal,
			summary: summaryOf(entry),
			revs: revsOf(entry),
			events: entry.events.filter((event) => event.seq > since).map((event) => withDelivery(entry, event)),
		};
	}

	function board(id, rev) {
		const entry = getEntry(id);
		const file = path.join(entry.dir, "revs", String(rev), "board.json");
		if (!fs.existsSync(file)) throw fail("bad_rev", `no such revision: ${rev}`);
		const parsed = readJson(file);
		if (parsed === undefined) throw fail("bad_rev", `no such revision: ${rev}`);
		return parsed;
	}

	function updatedDesc(a, b) {
		return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0;
	}

	function list({ product, feature, status = "open" } = {}) {
		let items = [...entries.values()].map(summaryOf);
		if (status === "open") items = items.filter((item) => item.status !== "closed");
		else if (status === "mine") items = items.filter((item) => item.status === "mine");
		else if (status === "theirs") items = items.filter((item) => item.status === "theirs");
		else if (status === "closed") items = items.filter((item) => item.status === "closed");
		else if (status !== "all") throw fail("bad_input", `unknown status: ${status}`);
		if (product != null) {
			const wanted = String(product).toLowerCase();
			items = items.filter((item) => item.product.key.toLowerCase() === wanted || item.product.name.toLowerCase() === wanted);
		}
		if (feature != null) {
			items = items.filter((item) => item.feature.branch === feature || item.feature.key === feature);
		}
		if (status === "closed" || status === "all") items.sort(updatedDesc);
		else items.sort((a, b) => (a.status === "mine" ? 0 : 1) - (b.status === "mine" ? 0 : 1) || updatedDesc(a, b));
		return items;
	}

	function facets() {
		const products = new Map();
		for (const entry of entries.values()) {
			const summary = summaryOf(entry);
			let product = products.get(summary.product.key);
			if (!product) {
				product = { key: summary.product.key, name: summary.product.name, count: 0, open: 0, features: new Map() };
				products.set(summary.product.key, product);
			}
			product.count++;
			if (summary.status !== "closed") product.open++;
			let feature = product.features.get(summary.feature.key);
			if (!feature) {
				feature = {
					key: summary.feature.key,
					branch: summary.feature.branch,
					worktree: summary.feature.worktree,
					count: 0,
					open: 0,
					updated: summary.updated,
				};
				product.features.set(summary.feature.key, feature);
			}
			feature.count++;
			if (summary.status !== "closed") feature.open++;
			if (summary.updated >= feature.updated) {
				feature.updated = summary.updated;
				feature.branch = summary.feature.branch;
				feature.worktree = summary.feature.worktree;
			}
		}
		return [...products.values()]
			.map((product) => ({ ...product, features: [...product.features.values()] }))
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	}

	function forWorktree({ worktree, featureKey } = {}) {
		const target = worktree == null ? null : normPath(worktree).toLowerCase();
		let mine = 0;
		let theirs = 0;
		const pending = [];
		for (const entry of entries.values()) {
			const summary = summaryOf(entry);
			if (summary.status !== "mine" && summary.status !== "theirs") continue;
			const recorded = summary.feature.worktree;
			const matches = target != null && recorded != null && normPath(recorded).toLowerCase() === target;
			const orphaned = featureKey != null && summary.feature.key === featureKey && recorded != null && !fs.existsSync(recorded);
			if (!matches && !orphaned) continue;
			if (summary.status === "mine") mine++;
			else {
				theirs++;
				pending.push(summary);
			}
		}
		return { mine, theirs, pending };
	}

	function waitingFor(session) {
		if (typeof session !== "string" || !session) return [];
		const items = [];
		for (const entry of entries.values()) {
			const summary = summaryOf(entry);
			if (summary.kind !== "decision" || summary.owner !== session) continue;
			if (summary.status !== "mine" && summary.status !== "theirs") continue;
			const feedback = [...entry.events].reverse().find((event) => event.type === "feedback") || null;
			if (summary.status === "theirs" && (!feedback || withDelivery(entry, feedback).delivery !== "pending")) continue;
			const lastEvent = [...entry.events].reverse().find((event) => ["submitted", "revised", "feedback"].includes(event.type));
			if (!lastEvent) continue;
			items.push({
				id: summary.id,
				title: summary.title,
				status: summary.status,
				since: lastEvent.at,
				seq: summary.status === "theirs" ? feedback.seq : null,
			});
		}
		return items.sort((a, b) => a.since < b.since ? -1 : a.since > b.since ? 1 : 0);
	}

	/**
	 * The newest board activity of `session` at or after `sinceMs`: `board` is a submit or revise, `reply` a reply
	 * (ISO times, null when none). An event without a session counts for the board's owner.
	 */
	function activitySince(session, sinceMs) {
		const newest = { board: null, reply: null };
		if (typeof session !== "string" || !session || !Number.isFinite(sinceMs)) return newest;
		for (const entry of entries.values()) {
			const owner = ownerOf(entry);
			for (const event of entry.events) {
				const kind = event.type === "submitted" || event.type === "revised" ? "board" : event.type === "reply" ? "reply" : null;
				if (kind === null || ((event.session && event.session.id) || owner) !== session) continue;
				const at = Date.parse(event.at);
				if (!(at >= sinceMs)) continue;
				if (newest[kind] === null || at > Date.parse(newest[kind])) newest[kind] = event.at;
			}
		}
		return newest;
	}

	return {
		create,
		revise,
		reply,
		feedback,
		close,
		writeInbox,
		get,
		board,
		list,
		facets,
		forWorktree,
		waitingFor,
		activitySince,
	};
}
