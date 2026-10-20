import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { layout, readConfig } from "./paths.mjs";
import { identityFor, normPath } from "./identity.mjs";
import { validateBoard } from "./board.mjs";
import { classify, ALLOW, postGuard } from "./access.mjs";
import { feedbackMessage, pendingNotice, footerText } from "./message.mjs";
import { createStore } from "./store.mjs";
import { createPusher } from "./push.mjs";
import { createThreads, writeJson } from "./threads.mjs";
import { buildLineRequest, buildRepairRequest, buildSummaryRequest, finalizeLine, finalizeSummary, heuristicSummary, lintSummary, validateSummary } from "./summary.mjs";
import { createStallWatch, stallMsFrom } from "./stall.mjs";
import { redact } from "./redact.mjs";
import { buildPushPayload, cacheReminderAt, createScheduler, pushPlan, summaryWaitDeadline, topicFor, CACHE_LEAD_MINUTES } from "./policy.mjs";
import { isExpired, noticeItemInput, validateNotice } from "./notices.mjs";
import { createReopener } from "./reopen.mjs";

const BODY_LIMIT = 30 * 1024 * 1024;
const URL_LIMIT = 30000;
const IDENTITY_TTL_MS = 60_000;
const LIVE_WINDOW_MS = 90_000;
const PROBE_TIMEOUT_MS = 3000;
const ASIDE_FALLBACK = "C:\\Program Files\\Aside\\Application\\Aside.exe";
const NAME = "omo-inbox";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mmd": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

const INVALID_SEGMENT = /^(?:|\.|\.\.)$/;
const ENDPOINT_LIMIT = 2048;
const REPLY_BODY_LIMIT = 120;
const WELCOME = { title: "알림이 켜졌습니다", body: "새 Review와 답이 오면 알려 드립니다", url: "/", tag: "inbox-welcome" };
const CSP =
	"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'";
const PAGE_HEADERS = { "content-security-policy": CSP };
const ITEM_KINDS = new Set(["question", "permission", "turn", "blocked", "done", "progress", "board", "notice"]);
const POLICIES = new Set(["needs-you", "progress", "quiet", "fyi"]);
const DELIVERED_HOWS = new Set(["bridge", "message", "late-message", "dropped", "refused"]);
const BRIDGE_STATES = new Set(["live", "detached", "terminal-only", "none"]);
const PERMISSION_CHOICES = ["Allow once", "Deny", "Deny with feedback"];
const UNCONFIRMED_MS = 60_000;
const OVERDUE_LIMIT_MS = 60 * 60_000;
const DEFAULT_SUMMARY = { enabled: true, models: ["anthropic-subscription/claude-sonnet-5", "chatgpt-subscription/gpt-6-luna-fast", "anthropic-subscription/claude-haiku-4-5"] };
const THREAD_EXTRA_KEYS = ["sessionName", "lastRequest", "model", "sessionFile"];
const THREAD_META_KEYS = ["cwd", "firstRequest", "ended", "title", "product", "feature", "worktree", "branch", "sessionFile"];

const nonBlank = (value) => typeof value === "string" && value.trim() !== "";
const HANGUL_RE = /[가-힣]/;

function deepRedact(value) {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map(deepRedact);
	if (value && typeof value === "object") {
		const out = {};
		for (const [key, inner] of Object.entries(value)) out[key] = deepRedact(inner);
		return out;
	}
	return value;
}

function optionLabel(option) {
	return typeof option === "string" ? option : option && typeof option === "object" ? option.label : undefined;
}

// C8 phone answer rule, validated against the item's own raw request or dialog.
function answerPayload(item, body) {
	if (item.kind === "question") {
		const questions = Array.isArray(item.raw?.request?.questions) ? item.raw.request.questions : [];
		const given = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? body.answers : {};
		const answers = {};
		const lines = [];
		for (const [qid, value] of Object.entries(given)) {
			const question = questions.find((entry) => String(entry?.id) === qid);
			if (!question || !value || typeof value !== "object") return { error: "invalid_answer", details: [`${qid}: unknown question`] };
			const selected = value.selected ?? [];
			if (!Array.isArray(selected) || selected.some((label) => typeof label !== "string")) {
				return { error: "invalid_answer", details: [`${qid}: selected must be a list of option labels`] };
			}
			const labels = (Array.isArray(question.options) ? question.options : []).map(optionLabel);
			const unknown = selected.filter((label) => !labels.includes(label));
			if (unknown.length) return { error: "invalid_answer", details: [`${qid}: unknown option ${unknown.join(", ")}`] };
			if (question.multiSelect !== true && selected.length > 1) return { error: "invalid_answer", details: [`${qid}: only one option allowed`] };
			const text = nonBlank(value.text) ? value.text : null;
			if (!selected.length && !text) continue;
			answers[qid] = text ? { selected, text } : { selected };
			lines.push(`${question.header || question.question || qid}: ${[selected.join(", "), text].filter(Boolean).join(" / ")}`);
		}
		const comment = nonBlank(body.comment) ? body.comment : null;
		if (!comment && !Object.keys(answers).length) return { error: "question_incomplete" };
		return { payload: comment ? { answers, comment } : { answers }, text: [...lines, comment].filter(Boolean).join("\n") };
	}
	if (item.kind === "permission") {
		const offered = Array.isArray(item.raw?.dialog?.options) ? item.raw.dialog.options.map(optionLabel).filter(Boolean) : [];
		const options = offered.length ? offered : PERMISSION_CHOICES;
		if (typeof body.choice !== "string" || !options.includes(body.choice)) return { error: "invalid_answer", details: ["choice: unknown option"] };
		const feedbackText = nonBlank(body.feedbackText) ? body.feedbackText : null;
		return {
			payload: feedbackText ? { choice: body.choice, feedbackText } : { choice: body.choice },
			text: feedbackText ? `${body.choice}: ${feedbackText}` : body.choice,
		};
	}
	const text = nonBlank(body.text) ? body.text : nonBlank(body.comment) ? body.comment : null;
	if (!text) return { error: "bad_input" };
	return { payload: { text }, text };
}

function lastActivityAt(events) {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type === "activity" && (event.cause == null || event.cause === "owner")) return event.at;
	}
	return null;
}

function episodeFinalOf(item) {
	const episode = item?.meta?.episode;
	return episode && typeof episode === "object" && typeof episode.closeReason === "string" && episode.closeReason ? episode : null;
}

// The thread payload stays small: progress lines and episode finals keep their request but lose
// the raw message text, which only the episode route serves.
function liteRaw(item, raw) {
	if (!raw || typeof raw !== "object") return raw;
	if (item?.kind !== "progress" && episodeFinalOf(item) === null) return raw;
	const out = { ...raw };
	delete out.text;
	delete out.final;
	return out;
}

// The thread route needs only the line headline for progress items; the full heuristic body stays
// in storage and is still served by the episode route.
function liteSummary(item) {
	return { headline: item?.summary?.summary?.headline ?? null };
}

// The thread payload carries a progress line's request only where its episode starts or the request
// changes from the previous line of that episode: the page draws the owner's request bubble there, and
// the 3 s poll stops repeating the same text on every line. Lines without an episode and every other
// kind pass through untouched.
function liteRequests(views) {
	const last = new Map();
	for (const view of views) {
		const key = view.kind === "progress" ? view.meta?.episode?.key : null;
		const request = view.raw?.request;
		if (typeof key !== "string" || !key || typeof request !== "string") continue;
		if (last.get(key) === request) {
			view.raw = { ...view.raw };
			delete view.raw.request;
		} else {
			last.set(key, request);
		}
	}
	return views;
}

function itemStamp(item) {
	const match = /:m(\d+)$/.exec(String(item?.dedupeKey ?? ""));
	if (match) return Number(match[1]);
	const seq = Number(item?.meta?.episode?.seq);
	if (Number.isFinite(seq)) return seq;
	const value = Number(item?.raw?.lastStamp ?? item?.meta?.episode?.lastStamp);
	return Number.isFinite(value) ? value : null;
}

function isHttpUrl(value) {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function hasText(raw) {
	return nonBlank(raw?.text) || nonBlank(raw?.notice?.body);
}

function validSubscription(value) {
	if (!value || typeof value !== "object" || !value.keys || typeof value.keys !== "object") return false;
	const { endpoint } = value;
	if (typeof endpoint !== "string" || endpoint.length > ENDPOINT_LIMIT) return false;
	try {
		if (new URL(endpoint).protocol !== "https:") return false;
	} catch {
		return false;
	}
	const { p256dh, auth } = value.keys;
	if (typeof p256dh !== "string" || typeof auth !== "string") return false;
	const point = Buffer.from(p256dh, "base64url");
	return point.length === 65 && point[0] === 0x04 && Buffer.from(auth, "base64url").length === 16;
}

function toSlash(value) {
	return String(value).replace(/\\/g, "/");
}

function contentType(file) {
	return TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function readVersion() {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
		if (parsed && typeof parsed.version === "string") return parsed.version;
	} catch {
		// a missing or broken package.json is not fatal for the health route
	}
	return "0.0.0";
}

function readTargets(webDir) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(webDir, "targets.json"), "utf8"));
		if (Array.isArray(parsed)) return parsed;
	} catch {
		// no targets file means an empty chooser
	}
	return [];
}

function asideExe() {
	if (process.platform !== "win32") return ASIDE_FALLBACK;
	try {
		const out = execFileSync("reg", ["query", "HKCR\\aside\\shell\\open\\command"], { encoding: "utf8", windowsHide: true });
		const quoted = out.match(/"([^"]+)"/);
		if (quoted) return quoted[1];
		const first = out.trim().split(/\s+/)[0];
		if (first) return first;
	} catch {
		// Aside is optional; fall back to the default install path
	}
	return ASIDE_FALLBACK;
}

function appendLog(logsDir, line) {
	try {
		fs.mkdirSync(logsDir, { recursive: true });
		fs.appendFileSync(path.join(logsDir, "server.log"), `${new Date().toISOString()} ${line}\n`);
	} catch {
		// logging must never take the server down
	}
}

function fail(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function proposalCounts(all) {
	const counts = { mine: 0, theirs: 0, closed: 0, reports: 0 };
	for (const summary of all) {
		counts[summary.status]++;
		if (summary.status !== "closed" && summary.kind === "report") counts.reports++;
	}
	return counts;
}

export function createServer({
	home,
	webDir,
	port = 4387,
	host = "127.0.0.1",
	config = {},
	now = () => new Date(),
	asidePath = null,
	pusher = null,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	onIdle = () => {},
	reopener = null,
} = {}) {
	if (!home) throw fail("bad_input", "home is required");
	const cfg = { v: 1, port, publicBase: null, pcTailnetIps: [], owner: null, ...config };
	const dir = {
		data: path.join(home, "data"),
		mailbox: path.join(home, "mailbox"),
		proposals: path.join(home, "data", "proposals"),
		logs: path.join(home, "logs"),
		push: path.join(home, "push"),
	};
	const cli = `node "${toSlash(path.join(home, "app", "bin", "inbox.mjs"))}"`;
	const store = createStore({ dataDir: dir.data, inboxDir: dir.mailbox, now });
	const push = pusher ?? createPusher({ dir: dir.push, log: (line) => appendLog(dir.logs, line) });
	const targets = readTargets(webDir);
	const version = readVersion();
	const aside = asidePath ?? asideExe();
	const lastSeen = new Map();
	const byeAt = new Map();
	const idleSessions = new Map();
	const identityCache = new Map();
	const reopenSessions = reopener ?? createReopener({ env: process.env, log: (line) => appendLog(dir.logs, "reopen: " + line) });
	let actualPort = port;

	const url = (id) => `${cfg.publicBase || `http://127.0.0.1:${actualPort}`}/p/${id}`;
	const nowMs = () => now().getTime();
	try {
		const saved = JSON.parse(fs.readFileSync(path.join(dir.data, "live.json"), "utf8").replace(/^\uFEFF/, ""));
		if (saved && typeof saved === "object" && !Array.isArray(saved)) {
			for (const [sid, ms] of Object.entries(saved)) {
				if (typeof ms === "number" && Number.isFinite(ms) && nowMs() - ms <= LIVE_WINDOW_MS) lastSeen.set(sid, ms);
			}
		}
	} catch {
		// A missing or corrupt liveness cache is equivalent to no restored sessions.
	}
	const persistLastSeen = () => {
		// Sessions that died without a bye would otherwise stay in the file forever.
		for (const [sid, ms] of lastSeen) if (nowMs() - ms > LIVE_WINDOW_MS) lastSeen.delete(sid);
		writeJson(path.join(dir.data, "live.json"), Object.fromEntries(lastSeen));
	};
	const mode = cfg.mode === "trial" ? "trial" : "primary";
	const summaryConfig = { ...DEFAULT_SUMMARY, ...(cfg.summary && typeof cfg.summary === "object" ? cfg.summary : {}) };
	const cacheLeadMinutes = Number.isFinite(cfg.cacheLeadMinutes) && cfg.cacheLeadMinutes >= 0 ? cfg.cacheLeadMinutes : CACHE_LEAD_MINUTES;
	const threads = createThreads({ home, now, isLive: (sid) => isLive(sid), isRecent: (sid) => isRecent(sid) });
	const scheduler = createScheduler({ now: nowMs, setTimer, clearTimer, log: (line) => appendLog(dir.logs, line) });
	const stall = createStallWatch({ setTimer, clearTimer, now: nowMs, stallMs: stallMsFrom(cfg, process.env), onFire: (sid, key) => stallFire(sid, key) });
	// itemId -> when the model summary was asked for; itemIds whose push is parked until it arrives.
	const summaryAsked = new Map();
	const pushDeferred = new Set();
	const firedCache = new Set();
	const threadExtra = new Map();

	const sendJson = (res, status, body) => {
		const text = JSON.stringify(body);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		});
		res.end(text);
	};

	const sendFile = (res, file, headers = {}) => {
		let bytes;
		try {
			bytes = fs.readFileSync(file);
		} catch {
			sendJson(res, 404, { error: "not_found" });
			return;
		}
		res.writeHead(200, { "content-type": contentType(file), ...headers });
		res.end(bytes);
	};

	const sendError = (res, error) => {
		const code = error && error.code;
		if (code === "not_found") return sendJson(res, 404, { error: "not_found" });
		if (code === "closed") return sendJson(res, 409, error.reason === undefined ? { error: "closed" } : { error: "closed", reason: error.reason });
		if (code === "duplicate") return sendJson(res, 409, { error: "duplicate", id: error.id, url: url(error.id) });
		if (code === "bad_rev") return sendJson(res, 400, { error: "bad_rev" });
		if (code === "bad_input") return sendJson(res, 400, { error: "bad_input" });
		if (code === "too_long") return sendJson(res, 413, { error: "too_long" });
		appendLog(dir.logs, `error: ${error && error.stack ? error.stack : error}`);
		return sendJson(res, 500, { error: "internal" });
	};

	const hasAccess = (access, level) => ALLOW[level].includes(access);

	function guard(res, access, level) {
		if (hasAccess(access, level)) return true;
		sendJson(res, 403, { error: "forbidden" });
		return false;
	}

	function decodeOnce(value) {
		try {
			return decodeURIComponent(value);
		} catch {
			throw fail("bad_input", `bad path encoding: ${value}`);
		}
	}

	function readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let size = 0;
			let tooLong = false;
			req.on("data", (chunk) => {
				size += chunk.length;
				if (size > BODY_LIMIT) tooLong = true;
				else chunks.push(chunk);
			});
			req.on("end", () => (tooLong ? reject(fail("too_long", "body too large")) : resolve(Buffer.concat(chunks))));
			req.on("error", reject);
		});
	}

	async function readJsonBody(req) {
		const raw = await readBody(req);
		try {
			const parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		} catch {
			throw fail("bad_input", "body must be json");
		}
	}

	function proposalDir(id) {
		return path.join(dir.proposals, id);
	}

	function clientOf(headers) {
		const forwarded = headers["x-forwarded-for"];
		const first = forwarded === undefined ? null : String(forwarded).split(",")[0].trim();
		return first || "127.0.0.1";
	}

	function feedbackBody(access, req) {
		return {
			via: access,
			client: clientOf(req.headers),
			ua: String(req.headers["user-agent"] || "").slice(0, 200),
		};
	}

	function serveStatic(res, file, headers = {}) {
		sendFile(res, file, headers);
	}

	// Fire and forget: called after the response is written, never awaited by a handler.
	function notifyLater(message, options = {}) {
		Promise.resolve()
			.then(() => push.notify(message, options))
			.catch((error) => appendLog(dir.logs, `push notify failed: ${error && error.stack ? error.stack : error}`));
	}

	function proposalMessage(title, body, id) {
		return { title, body, url: `/p/${id}`, tag: `inbox-${id}` };
	}

	const where = (summary) => `${summary.product.name || summary.product.key} \u00b7 ${summary.feature.branch}`;

	// --- threads and items (C5, C9, C10, C12) ---------------------------------

	function itemView(item, liteProgress = false) {
		const at = nowMs();
		const answers = item.answers.map((answer) => ({
			...answer,
			payload: deepRedact(answer.payload),
			deliveryUnconfirmed: !item.deliveredIds.includes(answer.deliveryId) && at - Date.parse(answer.at) >= UNCONFIRMED_MS,
		}));
		return {
			...item,
			id: item.itemId,
			raw: deepRedact(liteRaw(item, item.raw)),
			summary: item.summary
				? liteProgress && item.kind === "progress"
					? { source: item.summary.source, summary: liteSummary(item) }
					: { ...item.summary, summary: deepRedact(item.summary.summary) }
				: null,
			answers,
			deliveryUnconfirmed: answers.some((answer) => answer.deliveryUnconfirmed),
		};
	}

	function eventView(event) {
		const out = { ...event };
		if (out.type === "item" && "raw" in out) out.raw = liteRaw(out, out.raw);
		if (out.type === "summary" && out.summary?.kind === "progress") {
			out.summary = { headline: out.summary.headline ?? null };
		}
		for (const key of ["raw", "summary", "payload", "detail"]) {
			if (key in out) out[key] = deepRedact(out[key]);
		}
		return out;
	}

	const threadView = (thread) => ({ ...thread, title: redact(thread.title), firstRequest: redact(thread.firstRequest) });

	const rowView = (row) => ({
		...row,
		title: redact(row.title),
		newest: row.newest ? { ...row.newest, headline: redact(row.newest.headline) } : null,
	});

	// The thread as the summarizer sees it: the stored title only (not the `요청:` fallback) plus the session meta kept in memory.
	function summaryThread(sid) {
		const { thread } = threads.getThread(sid);
		const extra = threadExtra.get(sid) ?? {};
		const title = thread.titleSource || thread.session === "_notices" ? thread.title : null;
		return { ...thread, title, sessionName: extra.sessionName ?? null, lastRequest: extra.lastRequest ?? null };
	}

	function cancelPushes(itemId) {
		scheduler.cancel(`item:${itemId}`);
		scheduler.cancel(`wait:${itemId}`);
		scheduler.cancelPrefix(`cache:${itemId}:`);
		pushDeferred.delete(itemId);
		summaryAsked.delete(itemId);
	}

	function fireItem(itemId, { force = false } = {}) {
		let item;
		let view;
		try {
			item = threads.getItem(itemId);
			view = threads.getThread(item.session);
		} catch {
			return;
		}
		// One durable push per item: a restart or a repeated timer must not send it again.
		if (item.pushedAt) return;
		if (view.thread.hidden) {
			threads.markPushed(itemId, undefined, { suppressed: true });
			return;
		}
		const options = { mode, now: nowMs(), activityAt: lastActivityAt(view.events) };
		const plan = pushPlan(item, view.thread, mode, options);
		if (!plan.push) return;
		if (!force) {
			const deadline = summaryWaitDeadline(item, summaryAsked.get(itemId), nowMs(), plan.holdMs);
			if (deadline != null) {
				pushDeferred.add(itemId);
				scheduler.schedule(`wait:${itemId}`, deadline, () => fireItem(itemId, { force: true }));
				return;
			}
		}
		pushDeferred.delete(itemId);
		scheduler.cancel(`wait:${itemId}`);
		Promise.resolve()
			.then(() => push.notify(buildPushPayload(item, view.thread, item.summary?.summary ?? null, options), { topic: topicFor(item.session) }))
			.then(() => {
				try {
					threads.markPushed(itemId);
				} catch (error) {
					appendLog(dir.logs, `push record failed: ${error && error.stack ? error.stack : error}`);
				}
			})
			.catch((error) => appendLog(dir.logs, `push notify failed: ${error && error.stack ? error.stack : error}`));
	}

	// Board items push through the desk create/revise/reply notifications, never through the scheduler.
	function scheduleItem(item, view) {
		if (item.kind === "board" || item.pushedAt) return;
		const plan = pushPlan(item, view.thread, mode, { now: nowMs(), activityAt: lastActivityAt(view.events) });
		if (!plan.push) return;
		if (view.thread.hidden) {
			threads.markPushed(item.itemId, undefined, { suppressed: true });
			return;
		}
		scheduler.schedule(`item:${item.itemId}`, Date.parse(item.createdAt) + plan.holdMs, () => fireItem(item.itemId));
	}

	// A system start that opened a provisional episode may continue the session's newest final:
	// a stalled one, or one the phone was never told about. A newer episode item means new work.
	function reopenOf(sid) {
		const items = threads.getThread(sid).items.filter((item) => item.meta?.episode && typeof item.meta.episode.key === "string");
		const newest = items[items.length - 1];
		if (!newest) return null;
		const episode = episodeFinalOf(newest);
		if (!episode) return null;
		const stalled = episode.closeReason === "stalled";
		const unpushedOpen = newest.status === "open" && !newest.pushedAt;
		if (!stalled && !unpushedOpen) return null;
		return {
			key: episode.key,
			opener: Number.isFinite(episode.opener) ? episode.opener : null,
			openedAt: episode.openedAt ?? null,
			seq: Number.isFinite(episode.lines) ? Math.max(0, Math.floor(episode.lines)) : 0,
		};
	}

	function fireCache(itemId, key, warmUntil) {
		firedCache.add(key);
		let item;
		let view;
		try {
			item = threads.getItem(itemId);
			view = threads.getThread(item.session);
		} catch {
			return;
		}
		if (item.status !== "open" || view.thread.hidden || item.pushSuppressed) return;
		const minutesLeft = Math.max(0, Math.round((Number(warmUntil) - nowMs()) / 60_000));
		const payload = buildPushPayload(item, view.thread, item.summary?.summary ?? null, { kind: "cache", minutesLeft, mode });
		notifyLater(payload, { topic: topicFor(item.session) });
	}

	// One reminder per (newest open needs-you item, warmUntil), C9.
	function scheduleCache(sid) {
		const view = threads.getThread(sid);
		const warmUntil = view.thread.cacheUntil;
		if (warmUntil == null) return;
		const open = view.items.filter((item) => item.status === "open" && item.policy === "needs-you");
		const item = open[open.length - 1];
		if (!item || view.thread.hidden || item.pushSuppressed) return;
		const key = `cache:${item.itemId}:${warmUntil}`;
		if (firedCache.has(key) || scheduler.pending().some((entry) => entry.key === key)) return;
		const at = cacheReminderAt(item, view.thread, cacheLeadMinutes, { now: nowMs() });
		if (at == null) return;
		scheduler.cancelPrefix(`cache:${item.itemId}:`);
		scheduler.schedule(key, at, () => fireCache(item.itemId, key, warmUntil));
	}

	function rebuildSchedules() {
		const at = nowMs();
		for (const row of threads.list()) {
			const view = threads.getThread(row.session);
			for (const item of view.items) {
				if (item.status !== "open" || at - Date.parse(item.createdAt) >= OVERDUE_LIMIT_MS) continue;
				scheduleItem(item, view);
			}
			scheduleCache(row.session);
		}
	}

	// Restore one watchdog per open episode (progress lines with no final) after a restart.
	function rebuildStalls() {
		const rows = [];
		for (const row of threads.list()) {
			const { items } = threads.getThread(row.session);
			const finals = new Set(items.filter((item) => episodeFinalOf(item) !== null).map((item) => item.meta.episode.key));
			const newest = new Map();
			for (const item of items) {
				const key = item.meta?.episode?.key;
				if (item.kind !== "progress" || typeof key !== "string" || !key || finals.has(key)) continue;
				const previous = newest.get(key);
				if (!previous || Date.parse(item.createdAt) >= Date.parse(previous.createdAt)) newest.set(key, item);
			}
			for (const [key, item] of newest) rows.push({ sid: row.session, key, lastLineAt: item.createdAt });
		}
		stall.rebuild(rows);
	}

	function expireNotices(sid) {
		let view;
		try {
			view = threads.getThread(sid);
		} catch {
			return;
		}
		for (const item of view.items) {
			if (item.kind !== "notice" || item.status === "closed" || !isExpired(item.raw?.notice, nowMs())) continue;
			threads.close(item.itemId, "expired");
			cancelPushes(item.itemId);
		}
	}

	function expireAll() {
		for (const row of threads.list()) expireNotices(row.session);
	}

	function wantsSummary(item) {
		if (summaryConfig.enabled === false) return false;
		if (item.kind === "progress") return cfg.progress?.modelLines !== false;
		if (item.policy === "needs-you") return true;
		return item.policy === "fyi" && hasText(item.raw);
	}

	// The finished episode's line one-liners, newest last, for the final's summary and repair requests.
	function episodeOptions(sid, item) {
		const key = item?.meta?.episode?.key;
		if (typeof key !== "string" || !key) return {};
		const episodeLines = threads
			.episodeItems(sid, key)
			.filter((line) => line.kind === "progress")
			.map((line) => ({ at: line.createdAt, text: line.raw?.text ?? null, headline: line.summary?.summary?.headline ?? null }));
		return episodeLines.length ? { episodeLines } : {};
	}

	// One stalled final per open episode, from its own lines, once the session is idle too long.
	// A session that is gone gets nothing; a final that already exists wins over the watchdog.
	function stallFire(sid, key) {
		if (!isLive(sid)) return;
		let items;
		try {
			items = threads.episodeItems(sid, key);
		} catch {
			return;
		}
		if (items.some((item) => episodeFinalOf(item) !== null)) return;
		const lines = items.filter((item) => item.kind === "progress");
		if (!lines.length) return;
		const newest = lines[lines.length - 1];
		const first = lines[0];
		const fromKey = /^e:.*:(\d+)$/.exec(key);
		const openerValue = Number(first.meta?.episode?.opener ?? fromKey?.[1]);
		const opener = Number.isFinite(openerValue) ? openerValue : 0;
		const stamp = itemStamp(newest) ?? Date.parse(newest.createdAt);
		const request = first.raw?.request ?? newest.raw?.request ?? null;
		const created = addItem(sid, {
			kind: "turn",
			policy: "needs-you",
			dedupeKey: `episode:${sid}:${opener}:stalled:m${stamp}`,
			raw: { final: newest.raw?.text ?? "", request },
			meta: {
				stalled: true,
				episode: {
					key,
					opener,
					openedAt: first.meta?.episode?.openedAt ?? Date.parse(first.createdAt),
					closedAt: now().getTime(),
					closeReason: "stalled",
					lines: lines.length,
					turns: 1,
					interjections: 0,
					questions: 0,
				},
			},
		});
		// No extension sees this timer-created item, so it has no summary to wait for: push on the 30 s hold.
		if (created?.item?.itemId) summaryAsked.delete(created.item.itemId);
	}

	// Dedupe, store the heuristic summary at once, arm the hold-off push and say whether the model should summarize.
	function addItem(sid, input) {
		const { item, created } = threads.createItem(sid, input);
		if (!created) return { item, created, summaryRequest: null };
		const info = summaryThread(sid);
		const stored = threads.addSummary(item.itemId, finalizeSummary(heuristicSummary(item, info), item, info), "heuristic");
		const view = threads.getThread(sid);
		scheduleItem(stored, view);
		scheduleCache(sid);
		const episode = stored.meta?.episode;
		const episodeKey = typeof episode?.key === "string" && episode.key ? episode.key : null;
		if (episodeKey && stored.kind === "progress") stall.arm(sid, episodeKey, stored.createdAt);
		if (episodeKey && episodeFinalOf(stored) !== null) stall.cancel(sid, episodeKey);
		let summaryRequest = null;
		if (wantsSummary(stored)) {
			summaryRequest = stored.kind === "progress" ? buildLineRequest(stored, info) : buildSummaryRequest(stored, info, episodeOptions(sid, stored));
		}
		if (summaryRequest) summaryAsked.set(stored.itemId, nowMs());
		return { item: stored, created, summaryRequest };
	}

	const itemResponse = (out) => ({ item: { ...out.item, id: out.item.itemId }, created: out.created, summaryRequest: out.summaryRequest, summaryConfig });

	function closeBoardItem(summary, reason) {
		if (summary?.owner == null) return;
		let view;
		try {
			view = threads.getThread(summary.owner);
		} catch {
			return;
		}
		for (const item of view.items) {
			if (item.dedupeKey !== `board:${summary.id}` || item.status === "closed") continue;
			threads.close(item.itemId, reason);
			cancelPushes(item.itemId);
		}
	}

	// Board events of an owned proposal become the newest board item of the owner's thread; never breaks the board route.
	function boardItem(summary, label, note = "") {
		if (summary?.owner == null) return;
		try {
			closeBoardItem(summary, "superseded");
			addItem(summary.owner, {
				kind: "board",
				policy: mode === "primary" ? "needs-you" : "quiet",
				dedupeKey: `board:${summary.id}`,
				raw: { text: [`${label} · ${summary.title}`, note].filter(Boolean).join("\n"), proposalId: summary.id, rev: summary.rev, url: `/p/${summary.id}`, event: label },
				meta: { proposalId: summary.id },
			});
			const { thread } = threads.getThread(summary.owner);
			if (thread.product == null) {
				threads.setMeta(summary.owner, {
					product: summary.product.name || summary.product.key,
					feature: summary.feature.key,
					branch: summary.feature.branch,
					worktree: summary.feature.worktree,
				});
			}
		} catch (error) {
			appendLog(dir.logs, `board item failed: ${error && error.stack ? error.stack : error}`);
		}
	}

	function boardClosed(summary, reason) {
		try {
			closeBoardItem(summary, reason);
		} catch (error) {
			appendLog(dir.logs, `board item close failed: ${error && error.stack ? error.stack : error}`);
		}
	}

	async function handleThreadPost(res, req, sid, action, body, access) {
		if (action === "message" || action === "read") {
			if (!guard(res, access, "feedback")) return;
			const view = threads.getThread(sid);
			if (action === "read") return sendJson(res, 200, { ok: true, ...threads.markRead(sid, body.seq) });
			if (!nonBlank(body.text)) return sendJson(res, 400, { error: "bad_input" });
			let target = [...view.items].reverse().find((item) => item.kind === "turn" && item.status === "open");
			target ??= threads.createItem(sid, { kind: "turn", policy: "quiet", raw: { text: null, synthetic: true }, meta: { synthetic: true } }).item;
			const result = threads.answer(target.itemId, { text: body.text }, { ...feedbackBody(access, req), text: body.text });
			cancelPushes(target.itemId);
			return sendJson(res, 200, { ok: true, deliveryId: result.deliveryId, itemId: target.itemId });
		}
		if (action === "hide") {
			if (!guard(res, access, "feedback")) return;
			if (typeof body.hidden !== "boolean") return sendJson(res, 400, { error: "bad_input" });
			try {
				threads.getThread(sid);
			} catch (error) {
				if (error.code === "not_found") return sendJson(res, 404, { error: "not_found" });
				throw error;
			}
			threads.setMeta(sid, { hidden: body.hidden });
			if (body.hidden) {
				for (const item of threads.getThread(sid).items) {
					if (item.status !== "open" || item.pushedAt) continue;
					threads.markPushed(item.itemId, undefined, { suppressed: true });
					cancelPushes(item.itemId);
				}
			}
			return sendJson(res, 200, { ok: true, hidden: body.hidden });
		}
		if (action === "reopen") {
			if (!guard(res, access, "reopen")) return;
			if (sid === "_notices") return sendJson(res, 400, { error: "bad_input" });
			let view;
			try {
				view = threads.getThread(sid);
			} catch (error) {
				if (error.code === "not_found") return sendJson(res, 404, { error: "not_found" });
				throw error;
			}
			if (isLive(sid) || isRecent(sid)) return sendJson(res, 409, { error: "live" });
			const result = await reopenSessions.reopen(sid, view.thread);
			appendLog(dir.logs, `relaunch ${sid} -> ${result.ok ? result.via : result.error}`);
			if (result.ok) return sendJson(res, 200, { ok: true, via: result.via, ...(result.already ? { already: true } : {}) });
			const status = result.error === "no_launcher" ? 503 : result.error === "launch_failed" ? 502 : 409;
			return sendJson(res, status, { error: result.error });
		}
		if (!guard(res, access, "session")) return;
		if (action === "items") {
			if (!ITEM_KINDS.has(body.kind) || !POLICIES.has(body.policy)) return sendJson(res, 400, { error: "bad_input" });
			const out = addItem(sid, {
				kind: body.kind,
				policy: body.policy,
				dedupeKey: typeof body.dedupeKey === "string" && body.dedupeKey ? body.dedupeKey : null,
				raw: body.raw ?? null,
				meta: body.meta ?? null,
			});
			return sendJson(res, 200, itemResponse(out));
		}
		if (action === "activity") {
			if (!nonBlank(body.source)) return sendJson(res, 400, { error: "bad_input" });
			const cause = body.cause === undefined ? "owner" : body.cause;
			if (cause !== "owner" && cause !== "system") return sendJson(res, 400, { error: "bad_input" });
			// Decide reopen from the state before this start: the start then supersedes the open final.
			const reopen = body.source === "agent-start" && cause === "system" && body.opened === true ? reopenOf(sid) : undefined;
			const result = threads.activity(sid, body.source, cause);
			const response = { ok: true, ...result };
			if (body.source === "agent-start") {
				const key = typeof body.episode === "string" ? body.episode : body.episode && typeof body.episode === "object" && typeof body.episode.key === "string" ? body.episode.key : null;
				if (key) {
					const closed = threads.episodeItems(sid, key).find((item) => episodeFinalOf(item) !== null);
					if (closed) {
						response.episodeClosed = true;
						response.closeReason = episodeFinalOf(closed).closeReason;
					}
				}
				if (reopen !== undefined) response.reopen = reopen;
			}
			// A system-caused start keeps pending question pushes; only the owner moving on cancels them.
			if (cause === "owner") {
				for (const item of threads.getThread(sid).items) cancelPushes(item.itemId);
			}
			return sendJson(res, 200, response);
		}
		if (action === "cache") {
			const warmUntil = Number(body.warmUntil);
			if (!Number.isFinite(warmUntil)) return sendJson(res, 400, { error: "bad_input" });
			threads.cache(sid, warmUntil, Number.isFinite(Number(body.ttlSec)) ? Number(body.ttlSec) : null);
			scheduleCache(sid);
			return sendJson(res, 200, { ok: true });
		}
		if (action === "meta") return handleMeta(res, sid, body);
		return sendJson(res, 404, { error: "not_found" });
	}

	async function handleMeta(res, sid, body) {
		const extra = { ...(threadExtra.get(sid) ?? {}) };
		for (const key of THREAD_EXTRA_KEYS) {
			if (typeof body[key] === "string") extra[key] = body[key];
		}
		threadExtra.set(sid, extra);
		const meta = {};
		for (const key of THREAD_META_KEYS) {
			if (body[key] !== undefined) meta[key] = body[key];
		}
		// omo names sessions in English; only a Korean name becomes the title, else a Korean summary title is asked for.
	if (meta.title === undefined && nonBlank(body.sessionName) && HANGUL_RE.test(body.sessionName)) meta.title = body.sessionName.trim();
		if (nonBlank(body.cwd)) {
			try {
				const identity = await cachedIdentity(body.cwd);
				meta.product ??= identity.product.name || identity.product.key;
				meta.feature ??= identity.feature.key;
				meta.branch ??= identity.feature.branch;
				meta.worktree ??= identity.feature.worktree;
			} catch (error) {
				appendLog(dir.logs, `thread identity failed: ${error && error.message ? error.message : error}`);
			}
		}
		return sendJson(res, 200, { ok: true, thread: threads.setMeta(sid, meta) });
	}

	function handleItemPost(res, req, itemId, action, body, access) {
		if (action === "answer" || action === "explain") {
			if (!guard(res, access, "feedback")) return;
			const item = threads.getItem(itemId);
			if (action === "explain") {
				if (!isLive(item.session)) return sendJson(res, 409, { error: "not_live" });
				threads.writeAnswerMailbox(itemId, null, { type: "explain" });
				return sendJson(res, 200, { ok: true });
			}
			if (item.status === "closed") return sendJson(res, 409, { error: "closed", reason: item.closedReason });
			const checked = answerPayload(item, body);
			if (checked.error) return sendJson(res, 400, checked.details ? { error: checked.error, details: checked.details } : { error: checked.error });
			const result = threads.answer(itemId, checked.payload, { ...feedbackBody(access, req), text: checked.text });
			cancelPushes(itemId);
			return sendJson(res, 200, { ok: true, deliveryId: result.deliveryId });
		}
		if (!guard(res, access, "session")) return;
		if (action === "summary") {
			const item = threads.getItem(itemId);
			// A progress line answer is one headline only: no schema, lint or repair.
			if (item.kind === "progress") {
				const headline = finalizeLine(body.text);
				if (headline === null) return sendJson(res, 200, { ok: false });
				const heuristic = heuristicSummary(item, summaryThread(item.session));
				const summary = { ...heuristic, headline, title: null };
				threads.addSummary(itemId, summary, "model", typeof body.model === "string" ? body.model : null);
				summaryAsked.delete(itemId);
				return sendJson(res, 200, { ok: true, summary });
			}
			const validated = validateSummary(body.text, item);
			if (!validated) return sendJson(res, 200, { ok: false });
			const summary = finalizeSummary(validated, item, summaryThread(item.session));
			threads.addSummary(itemId, summary, "model", typeof body.model === "string" ? body.model : null, body.simpler === true);
			summaryAsked.delete(itemId);
			if (pushDeferred.delete(itemId)) {
				scheduler.cancel(`wait:${itemId}`);
				fireItem(itemId, { force: true });
			}
			// One repair per item and request: a repair post is never linted again.
			if (body.repair === true) return sendJson(res, 200, { ok: true, summary });
			const issues = lintSummary(body.text, item, summaryThread(item.session));
			if (!issues.length) return sendJson(res, 200, { ok: true, summary });
			const repairRequest = buildRepairRequest(item, summaryThread(item.session), String(body.text ?? ""), issues, episodeOptions(item.session, item));
			return sendJson(res, 200, { ok: true, summary, repairRequest });
		}
		if (action === "close") {
			if (!nonBlank(body.reason)) return sendJson(res, 400, { error: "bad_input" });
			const item = threads.close(itemId, body.reason, typeof body.resolvedBy === "string" ? body.resolvedBy : null);
			cancelPushes(itemId);
			return sendJson(res, 200, { ok: true, item: { ...item, id: item.itemId } });
		}
		if (action === "bridge") {
			if (!BRIDGE_STATES.has(body.state)) return sendJson(res, 400, { error: "bad_input" });
			threads.bridge(itemId, body.state);
			return sendJson(res, 200, { ok: true });
		}
		if (action === "delivered") {
			if (!nonBlank(body.deliveryId) || !DELIVERED_HOWS.has(body.how)) return sendJson(res, 400, { error: "bad_input" });
			const item = threads.delivered(itemId, body.deliveryId, body.how, body.detail ?? null);
			return sendJson(res, 200, { ok: true, status: item.status });
		}
		if (action === "state") {
			if (body.state !== "waiting" && body.state !== "resumed") return sendJson(res, 400, { error: "bad_input" });
			const reasons = body.reasons === undefined ? [] : body.reasons;
			if (!Array.isArray(reasons) || reasons.length > 10 || reasons.some((reason) => typeof reason !== "string" || reason.length > 40)) {
				return sendJson(res, 400, { error: "bad_input" });
			}
			const boards = body.boards === undefined ? [] : body.boards;
			if (!Array.isArray(boards) || boards.length > 5) return sendJson(res, 400, { error: "bad_input" });
			for (const board of boards) {
				if (!board || typeof board !== "object" || Array.isArray(board)) return sendJson(res, 400, { error: "bad_input" });
				if (typeof board.id !== "string" || typeof board.title !== "string" || board.title.length > 80 || !isHttpUrl(board.url)) {
					return sendJson(res, 400, { error: "bad_input" });
				}
			}
			threads.setItemState(itemId, { state: body.state, reasons, boards });
			return sendJson(res, 200, { ok: true });
		}
		return sendJson(res, 404, { error: "not_found" });
	}

	function handleNotice(res, body) {
		const checked = validateNotice(body);
		if (!checked.ok) return sendJson(res, 400, { error: "invalid_notice", details: checked.errors });
		const out = addItem(checked.notice.session ?? "_notices", noticeItemInput(checked.notice, nowMs()));
		return sendJson(res, 200, itemResponse(out));
	}

	async function handleGet(res, rawPath, query, access) {
		const parts = rawPath.split("/");

		if (rawPath === "/" || rawPath === "") {
			if (!guard(res, access, "read")) return;
			return serveStatic(res, path.join(webDir, "inbox.html"), PAGE_HEADERS);
		}
		if (parts[1] === "s" && parts.length === 3) {
			if (!guard(res, access, "read")) return;
			return serveStatic(res, path.join(webDir, "thread.html"), PAGE_HEADERS);
		}
		if (rawPath === "/boards") {
			if (!guard(res, access, "read")) return;
			return serveStatic(res, path.join(webDir, "boards.html"), PAGE_HEADERS);
		}
		if (parts[1] === "p" && parts.length === 3) {
			if (!guard(res, access, "read")) return;
			return serveStatic(res, path.join(webDir, "proposal.html"));
		}
		if (parts[1] === "web" && parts.length === 3) {
			if (!guard(res, access, "read")) return;
			const name = decodeOnce(parts[2]);
			if (name.includes("/") || name.includes("\\") || name.includes(":") || INVALID_SEGMENT.test(name)) {
				return sendJson(res, 403, { error: "forbidden" });
			}
			return sendFile(res, path.join(webDir, name));
		}
		if (rawPath === "/sw.js") {
			if (!guard(res, access, "read")) return;
			return sendFile(res, path.join(webDir, "sw.js"), { "service-worker-allowed": "/", "cache-control": "no-cache" });
		}
		if (parts[1] === "files" && parts.length >= 5) {
			if (!guard(res, access, "read")) return;
			return handleFileGet(res, parts);
		}
		if (parts[1] === "api") {
			if (parts[2] === "push" && parts[3] === "key" && parts.length === 4) {
				if (!guard(res, access, "read")) return;
				return sendJson(res, 200, { publicKey: push.publicKey });
			}
			if (parts[2] === "health" && parts.length === 3) {
				if (!guard(res, access, "read")) return;
				return sendJson(res, 200, { ok: true, name: NAME, version, pid: process.pid, port: actualPort });
			}
			if (parts[2] === "caps" && parts.length === 3) {
				if (!guard(res, access, "read")) return;
				const open = ALLOW.open.includes(access);
				const visible = targets.filter((target) => target.where === "any" || (target.where === "pc" && open));
				return sendJson(res, 200, { access, open, targets: visible });
			}
			if (parts[2] === "proposals" && parts.length === 3) {
				if (!guard(res, access, "read")) return;
				const status = query.get("status") || "open";
				const items = store
					.list({ product: query.get("product"), feature: query.get("feature"), status })
					.map((summary) => ({ ...summary, url: url(summary.id) }));
				const counts = proposalCounts(store.list({ status: "all" }));
				return sendJson(res, 200, { items, facets: store.facets(), counts });
			}
			if (parts[2] === "threads" && parts.length === 3) {
				if (!guard(res, access, "read")) return;
				expireAll();
				const items = threads.list({ status: query.get("status") || null }).map(rowView);
				const reviews = { mine: proposalCounts(store.list({ status: "all" })).mine };
				return sendJson(res, 200, { items, counts: threads.counts(), reviews });
			}
			if (parts[2] === "threads" && parts.length === 4) {
				if (!guard(res, access, "read")) return;
				const sid = decodeOnce(parts[3]);
				expireNotices(sid);
				const since = Number.parseInt(query.get("since") || "0", 10) || 0;
				const data = threads.getThread(sid, since);
				return sendJson(res, 200, { thread: threadView(data.thread), items: liteRequests(data.items.map((item) => itemView(item, true))), events: data.events.map(eventView) });
			}
			if (parts[2] === "threads" && parts.length === 6 && parts[4] === "episodes") {
				if (!guard(res, access, "read")) return;
				const sid = decodeOnce(parts[3]);
				const key = decodeOnce(parts[5]);
				const items = threads.episodeItems(sid, key);
				const finalItem = items.find((item) => episodeFinalOf(item) !== null) ?? null;
				const lastStamp = finalItem ? itemStamp(finalItem) : null;
				const lines = items
					.filter((item) => episodeFinalOf(item) === null)
					.filter((item) => lastStamp === null || itemStamp(item) !== lastStamp)
					.map((item) => ({
						id: item.itemId,
						at: item.createdAt,
						text: deepRedact(item.raw?.text ?? null),
						headline: deepRedact(item.summary?.summary?.headline ?? null),
					}));
				const opened = items.find((item) => item.raw && typeof item.raw === "object" && "request" in item.raw);
				const final = finalItem
					? { id: finalItem.itemId, at: finalItem.createdAt, text: deepRedact(finalItem.raw?.final ?? null) }
					: null;
				const request = deepRedact(finalItem?.raw?.request ?? opened?.raw?.request ?? null);
				return sendJson(res, 200, { request, lines, final });
			}
			if (parts[2] === "items" && parts.length === 4) {
				if (!guard(res, access, "read")) return;
				const itemId = decodeOnce(parts[3]);
				expireNotices(threads.getItem(itemId).session);
				return sendJson(res, 200, itemView(threads.getItem(itemId)));
			}
			if (parts[2] === "here" && parts.length === 3) {
				if (!guard(res, access, "session")) return;
				return handleHere(res, query);
			}
			if (parts[2] === "p" && parts.length === 4) {
				if (!guard(res, access, "read")) return;
				const id = decodeOnce(parts[3]);
				const since = Number.parseInt(query.get("since") || "0", 10) || 0;
				const data = store.get(id, { since });
				return sendJson(res, 200, { ...data, url: url(id) });
			}
		}
		return sendJson(res, 404, { error: "not_found" });
	}

	function handleFileGet(res, parts) {
		const id = decodeOnce(parts[2]);
		const kind = parts[3];
		if (kind !== "revs" && kind !== "crops") return sendJson(res, 404, { error: "not_found" });
		if (kind === "revs" && parts.length < 6) return sendJson(res, 404, { error: "not_found" });
		try {
			store.get(id);
		} catch (error) {
			return sendError(res, error);
		}
		const raw = parts.slice(4).join("/");
		let decoded;
		try {
			decoded = decodeURIComponent(raw);
		} catch {
			return sendJson(res, 400, { error: "bad_input" });
		}
		const segments = decoded.split("/");
		if (segments.some((segment) => INVALID_SEGMENT.test(segment) || segment.includes("\\") || segment.includes(":"))) {
			return sendJson(res, 403, { error: "forbidden" });
		}
		const base = path.join(proposalDir(id), kind);
		const abs = path.resolve(base, decoded);
		if (abs !== base && !abs.startsWith(base + path.sep)) {
			return sendJson(res, 403, { error: "forbidden" });
		}
		const headers = kind === "revs" ? { "cache-control": "public, max-age=31536000, immutable" } : {};
		return sendFile(res, abs, headers);
	}

	async function handleHere(res, query) {
		const cwd = query.get("cwd");
		if (!cwd) return sendJson(res, 400, { error: "bad_input" });
		const session = query.get("session");
		const start = query.get("start") === "1";
		if (session) {
			lastSeen.set(session, nowMs());
			persistLastSeen();
			const idle = query.get("idle");
			if (idle === "0" || idle === "1") {
				const isIdle = idle === "1";
				idleSessions.set(session, isIdle);
				try {
					onIdle(session, isIdle);
				} catch (error) {
					appendLog(dir.logs, `idle hook failed: ${error && error.stack ? error.stack : error}`);
				}
				stall.idle(session, isIdle);
			}
		}
		const identity = await cachedIdentity(cwd);
		const work = store.forWorktree({ worktree: identity.feature.worktree, featureKey: identity.feature.key });
		const pending = work.pending.map((summary) => {
			const events = store.get(summary.id).events;
			const feedback = [...events].reverse().find((event) => event.type === "feedback") || null;
			return {
				...summary,
				url: url(summary.id),
				latest: feedback ? { seq: feedback.seq, delivery: feedback.delivery } : null,
			};
		});
		const waiting = session ? store.waitingFor(session) : [];
		expireAll();
		const noticed = pending.filter((item) => {
			if (start && item.owner === session) return true;
			return item.owner !== session && !isLive(item.owner);
		});
		return sendJson(res, 200, {
			product: identity.product,
			feature: identity.feature,
			mine: work.mine,
			theirs: work.theirs,
			pending,
			waiting: waiting.map((item) => ({ ...item, url: url(item.id) })),
			notice: pendingNotice(noticed, cli),
			noticeKeys: noticed.map((item) => `${item.id}:${item.latest ? item.latest.seq : 0}`),
			footer: footerText({ waiting: threads.counts().needsYou, boards: waiting.filter((item) => item.status === "theirs").length }),
		});
	}

	function cachedIdentity(cwd) {
		const key = normPath(cwd);
		const at = nowMs();
		const hit = identityCache.get(key);
		if (hit && at - hit.at < IDENTITY_TTL_MS) return hit.promise;
		const promise = identityFor(cwd);
		identityCache.set(key, { at, promise });
		return promise;
	}

	function isLive(owner) {
		if (owner == null) return false;
		const seen = lastSeen.get(owner);
		return seen !== undefined && nowMs() - seen <= LIVE_WINDOW_MS;
	}

	function isRecent(sid) {
		const bye = byeAt.get(sid);
		return bye !== undefined && nowMs() - bye <= LIVE_WINDOW_MS;
	}

	async function handlePost(res, req, rawPath, access) {
		if (!postGuard(req.headers)) {
			sendJson(res, 403, { error: "forbidden" });
			return;
		}
		const parts = rawPath.split("/");
		const body = await readJsonBody(req);

		if (parts[1] === "api" && parts[2] === "threads" && parts.length === 5) {
			return handleThreadPost(res, req, decodeOnce(parts[3]), parts[4], body, access);
		}
		if (parts[1] === "api" && parts[2] === "items" && parts.length === 5) {
			return handleItemPost(res, req, decodeOnce(parts[3]), parts[4], body, access);
		}
		if (parts[1] === "api" && parts[2] === "notices" && parts.length === 3) {
			if (!guard(res, access, "session")) return;
			return handleNotice(res, body);
		}
		if (parts[1] === "api" && parts[2] === "open" && parts.length === 3) {
			if (!guard(res, access, "open")) return;
			return handleOpen(res, body, access);
		}
		if (parts[1] === "api" && parts[2] === "proposals" && parts.length === 3) {
			if (!guard(res, access, "session")) return;
			return handleCreate(res, body);
		}
		if (parts[1] === "api" && parts[2] === "push" && parts.length === 4 && (parts[3] === "subscribe" || parts[3] === "unsubscribe")) {
			if (!guard(res, access, "feedback")) return;
			return parts[3] === "subscribe" ? handleSubscribe(res, req, body, access) : handleUnsubscribe(res, body);
		}
		if (parts[1] === "api" && parts[2] === "bye" && parts.length === 3) {
			if (!guard(res, access, "session")) return;
			if (typeof body.session === "string") {
				lastSeen.delete(body.session);
				persistLastSeen();
				if (body.closed === true) byeAt.delete(body.session);
				else byeAt.set(body.session, nowMs());
			}
			// A quit or a switch to another session (never a reload) ends the thread: its open items close (끝남)
			// and its episode watchdogs stop.
			if (typeof body.session === "string" && body.closed === true) {
				try {
					for (const item of threads.getThread(body.session).items) {
						const key = item.meta?.episode?.key;
						if (typeof key === "string" && key) stall.cancel(body.session, key);
					}
				} catch (error) {
					// an unknown session has no timers to cancel; anything else is a bug worth a log line
					if (!error || error.code !== "not_found") appendLog(dir.logs, `bye cleanup failed: ${error && error.stack ? error.stack : error}`);
				}
				if (threads.closeSession(body.session) > 0) {
					for (const item of threads.getThread(body.session).items) cancelPushes(item.itemId);
				}
			}
			return sendJson(res, 200, { ok: true });
		}
		if (parts[1] === "api" && parts[2] === "shutdown" && parts.length === 3) {
			if (!guard(res, access, "session")) return;
			sendJson(res, 200, { ok: true });
			close().then(() => process.exit(0));
			return;
		}
		if (parts[1] === "api" && parts[2] === "p" && parts.length === 5) {
			const id = decodeOnce(parts[3]);
			const action = parts[4];
			if (action === "feedback") {
				if (!guard(res, access, "feedback")) return;
				return handleFeedback(res, req, id, body, access);
			}
			if (action === "revise") {
				if (!guard(res, access, "session")) return;
				return handleRevise(res, id, body);
			}
			if (action === "reply") {
				if (!guard(res, access, "session")) return;
				const summary = store.reply(id, { text: body.text, session: body.session ?? null });
				sendJson(res, 200, { summary });
				notifyLater(proposalMessage(`답이 왔습니다 · ${summary.title}`, String(body.text ?? "").slice(0, REPLY_BODY_LIMIT), summary.id));
				boardItem(summary, "답이 왔습니다", String(body.text ?? ""));
				return;
			}
			if (action === "close") {
				if (!guard(res, access, "session")) return;
				const summary = store.close(id, { summary: body.summary ?? null, by: "session", session: body.session ?? null });
				sendJson(res, 200, { summary });
				boardClosed(summary, "board-closed");
				return;
			}
			return sendJson(res, 404, { error: "not_found" });
		}
		return sendJson(res, 404, { error: "not_found" });
	}

	function handleCreate(res, body) {
		let identity = body.identity && typeof body.identity === "object" ? body.identity : null;
		if (!identity) {
			if (!body.cwd) return sendJson(res, 400, { error: "bad_input" });
			return identityFor(body.cwd).then((computed) => createWith(res, body, computed));
		}
		return createWith(res, body, identity);
	}

	function handleSubscribe(res, req, body, access) {
		if (!validSubscription(body.subscription)) return sendJson(res, 400, { error: "bad_input" });
		const { endpoint, keys } = body.subscription;
		const subscription = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
		push.subscribe(subscription, { ua: String(req.headers["user-agent"] || "").slice(0, 200), via: access });
		sendJson(res, 200, { ok: true });
		Promise.resolve()
			.then(() => push.notifyOne(subscription, WELCOME))
			.catch((error) => appendLog(dir.logs, `push welcome failed: ${error && error.stack ? error.stack : error}`));
	}

	function handleUnsubscribe(res, body) {
		if (typeof body.endpoint !== "string" || !body.endpoint) return sendJson(res, 400, { error: "bad_input" });
		push.unsubscribe(body.endpoint);
		return sendJson(res, 200, { ok: true });
	}

	function createWith(res, body, identity) {
		const validated = validateBoard(body.srcDir);
		if (!validated.ok) return sendJson(res, 400, { error: "invalid_board", details: validated.errors });
		const title = (typeof body.title === "string" ? body.title.trim() : "") || validated.board.title;
		const { summary, existing } = store.create({
			identity,
			title,
			srcDir: body.srcDir,
			files: validated.files,
			note: body.note ?? null,
			force: body.force === true,
			kind: validated.board.kind ?? "decision",
		});
		sendJson(res, 200, { summary, url: url(summary.id), existing: existing === true });
		if (existing !== true) {
			notifyLater(proposalMessage(`새 Review · ${summary.title}`, where(summary), summary.id));
			boardItem(summary, "새 Review");
		}
	}

	function handleRevise(res, id, body) {
		const validated = validateBoard(body.srcDir);
		if (!validated.ok) return sendJson(res, 400, { error: "invalid_board", details: validated.errors });
		const summary = store.revise(id, {
			srcDir: body.srcDir,
			files: validated.files,
			note: body.note ?? null,
			session: body.session ?? null,
			kind: validated.board.kind ?? "decision",
		});
		sendJson(res, 200, { summary, url: url(summary.id) });
		const note = typeof body.note === "string" ? body.note.trim().slice(0, REPLY_BODY_LIMIT) : "";
		notifyLater(proposalMessage(`수정본 ${summary.rev} · ${summary.title}`, note || where(summary), summary.id));
		boardItem(summary, `수정본 ${summary.rev}`, note);
	}

	function handleFeedback(res, req, id, body, access) {
		const result = store.feedback(id, {
			rev: body.rev,
			verdict: body.verdict,
			answers: body.answers,
			comment: body.comment ?? null,
			marks: body.marks ?? [],
			...feedbackBody(access, req),
		});
		const { summary, event, owner } = result;
		boardClosed(summary, "answered");
		const deliverable = owner != null && event.delivery !== "none";
		if (deliverable) {
			const board = store.board(id, event.rev);
			const text = feedbackMessage({ summary, board, event, url: url(id), cropDir: proposalDir(id), cli });
			const payload = {
				v: 1,
				proposalId: id,
				seq: event.seq,
				title: summary.title,
				url: url(id),
				approved: event.verdict === "approve",
				text,
			};
			try {
				store.writeInbox(owner, payload);
			} catch (error) {
				try {
					store.writeInbox(owner, payload);
				} catch (again) {
					appendLog(dir.logs, `inbox write failed: ${again && again.stack ? again.stack : again}`);
					return sendJson(res, 200, { ok: true, seq: event.seq, status: summary.status, routed: owner, delivery: "none" });
				}
			}
		}
		return sendJson(res, 200, {
			ok: true,
			seq: event.seq,
			status: summary.status,
			routed: owner,
			delivery: deliverable ? "pending" : "none",
		});
	}

	function handleOpen(res, body, access) {
		const target = targets.find((entry) => entry.id === body.target);
		if (!target) return sendJson(res, 400, { error: "bad_input" });
		const open = ALLOW.open.includes(access);
		if (target.where === "pc" && !open) return sendJson(res, 403, { error: "forbidden" });
		let boardUrl = null;
		let urlValue = null;
		if (target.copy) {
			urlValue = null;
		} else if (body.useHome && target.home) {
			urlValue = target.home;
			boardUrl = body.proposalId != null ? url(body.proposalId) : null;
		} else {
			boardUrl = body.proposalId != null ? url(body.proposalId) : null;
			urlValue = String(target.url || "")
				.replace(/\{q\}/g, encodeURIComponent(body.q == null ? "" : String(body.q)))
				.replace(/\{board\}/g, boardUrl == null ? "" : boardUrl);
		}
		if (urlValue != null && urlValue.length > URL_LIMIT) return sendJson(res, 413, { error: "too_long" });

		let cmd;
		if (target.id === "aside") {
			cmd = [aside, "--single-argument", urlValue ?? (boardUrl ?? "")];
		} else if (urlValue == null) {
			cmd = [];
		} else {
			cmd = ["rundll32", "url.dll,FileProtocolHandler", urlValue];
		}
		if (body.dry === true) return sendJson(res, 200, { ok: true, dry: true, cmd });
		if (target.id === "aside" && !fs.existsSync(cmd[0])) {
			appendLog(dir.logs, `open failed: aside not installed at ${cmd[0]}`);
			return sendJson(res, 404, { error: "not_installed" });
		}
		if (cmd.length) {
			try {
				const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore", windowsHide: true });
				child.on("error", (error) => appendLog(dir.logs, `open failed: ${error.message}`));
				child.unref?.();
			} catch (error) {
				appendLog(dir.logs, `open failed: ${error.message}`);
			}
		}
		return sendJson(res, 200, { ok: true, cmd });
	}

	async function handle(req, res) {
		const raw = req.url || "/";
		const qIndex = raw.indexOf("?");
		const rawPath = qIndex === -1 ? raw : raw.slice(0, qIndex);
		const query = new URLSearchParams(qIndex === -1 ? "" : raw.slice(qIndex + 1));
		const access = classify({
			remoteAddress: req.socket.remoteAddress,
			headers: req.headers,
			pcIps: cfg.pcTailnetIps,
			owner: cfg.owner,
		});
		if (req.method === "GET" || req.method === "HEAD") return handleGet(res, rawPath, query, access);
		if (req.method === "POST") return handlePost(res, req, rawPath, access);
		return sendJson(res, 405, { error: "method" });
	}

	const httpServer = http.createServer((req, res) => {
		handle(req, res).catch((error) => sendError(res, error));
	});

	function listen() {
		return new Promise((resolve, reject) => {
			const onError = (error) => {
				httpServer.removeListener("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				httpServer.removeListener("error", onError);
				actualPort = httpServer.address().port;
				writeServerJson(path.join(home, "server.json"), dir.logs, actualPort, version);
				try {
					rebuildSchedules();
				} catch (error) {
					appendLog(dir.logs, `push schedule rebuild failed: ${error && error.stack ? error.stack : error}`);
				}
				try {
					rebuildStalls();
				} catch (error) {
					appendLog(dir.logs, `stall rebuild failed: ${error && error.stack ? error.stack : error}`);
				}
				resolve({ port: actualPort });
			};
			httpServer.once("error", onError);
			httpServer.once("listening", onListening);
			httpServer.listen(port, host);
		});
	}

	function close() {
		scheduler.cancelPrefix("");
		return new Promise((resolve) => {
			if (!httpServer.listening) {
				resolve();
				return;
			}
			httpServer.close(() => resolve());
		});
	}

	return { listen, close, store, threads, scheduler };
}

async function probeHealth(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
		if (!response.ok) return false;
		const body = await response.json();
		return body && body.name === NAME;
	} catch {
		return false;
	}
}

function writeServerJson(file, logsDir, port, version) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({ v: 1, name: NAME, port, pid: process.pid, started: new Date().toISOString(), version }),
		);
	} catch (error) {
		appendLog(logsDir, `could not write server.json: ${error.message}`);
	}
}

function readSourceJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return null;
	}
}

// Package installs whose source folder is gone are orphans; uninstall once after the grace period.
export function createOrphanWatch({
	home,
	now = () => Date.now(),
	exists = (file) => fs.existsSync(file),
	spawn: run = spawn,
	graceMs = 20 * 60_000,
	execPath = process.execPath,
	readJson = readSourceJson,
} = {}) {
	const sourceFile = path.join(home, "app", "source.json");
	const cli = path.join(home, "app", "bin", "inbox.mjs");
	let firstMissing = null;
	let done = false;
	return {
		tick() {
			if (done) return;
			const meta = readJson(sourceFile);
			if (!meta || meta.channel !== "package" || !meta.source || exists(meta.source)) {
				firstMissing = null;
				return;
			}
			const at = now();
			firstMissing ??= at;
			if (at - firstMissing < graceMs) return;
			done = true;
			run(execPath, [cli, "uninstall"], { detached: true, stdio: "ignore", windowsHide: true, cwd: home }).unref();
		},
	};
}

async function main() {
	const l = layout();
	// A bug outside a request or timer must still leave a log line. Keep serving.
	process.on("uncaughtException", (error) => appendLog(l.logs, `uncaught exception: ${error && error.stack ? error.stack : error}`));
	process.on("unhandledRejection", (error) => appendLog(l.logs, `unhandled rejection: ${error && error.stack ? error.stack : error}`));
	const config = readConfig();
	const wanted = config.port ?? 4387;
	const server = createServer({
		home: l.home,
		webDir: path.join(REPO_ROOT, "web"),
		port: wanted,
		config,
	});
	try {
		await server.listen();
		const orphan = createOrphanWatch({ home: l.home, graceMs: Number(process.env.INBOX_ORPHAN_GRACE_MS) || 20 * 60_000 });
		setInterval(() => orphan.tick(), 60_000).unref();
	} catch (error) {
		if (error && error.code === "EADDRINUSE") {
			if (await probeHealth(wanted)) process.exit(0);
			appendLog(l.logs, `port ${wanted} is held by another process`);
			process.exit(3);
		}
		appendLog(l.logs, `listen failed: ${error && error.message}`);
		process.exit(1);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
