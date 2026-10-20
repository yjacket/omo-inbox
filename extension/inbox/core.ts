/**
 * omo-inbox senpi extension core (plan todo 3).
 *
 * Loaded into every interactive session from <agentDir>/extensions. It is inert
 * in omo-task child sessions, registers no tools and never does blocking I/O:
 *   - every 3 s it drains <home>/mailbox/<session>/*.json and delivers each
 *     feedback payload the server dropped there (followUp, wakes the turn);
 *   - every 30 s it refreshes the footer from /api/here, starts the server when
 *     it is down, and announces unanswered reviews once per session;
 *   - it reports waiting decision boards to senpi as a wake source and goal hold,
 *     emitting wake_source_state and continuation_hold_state; refreshes also happen
 *     after every tool execution; and it tells a session once when its board passes
 *     the answer window.
 *
 * senpi evaluates extensions through jiti/vm, where dynamic import() of repo
 * modules fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, so safeSegment and
 * the home/port resolution live in ./util.ts as copies of src/paths.mjs;
 * test/extension.test.mjs keeps util.ts's safeSegment equal to src/paths.mjs.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "./bridge.ts";
import { createCacheTracker } from "./cache.ts";
import { createCapture } from "./capture.ts";
import { createDelivery } from "./delivery.ts";
import { createSummaryQueue, createSummarizer, DEFAULT_MODELS } from "./summarize.ts";
import { CHILD_ENV, DEFAULT_PORT, resolveAgentDir, resolveHome, resolvePort, safeSegment } from "./util.ts";

const INBOX_MS = 3000;
const STATUS_MS = 30000;
const SPAWN_COOLDOWN_MS = 120_000;
const FETCH_TIMEOUT_MS = 5000;
const HOOK_TIMEOUT_MS = 1500;
const DESK_FETCH_TIMEOUT_MS = 2000;
const DESK_DEFAULT_PORT = 4377;
const TOOL_REFRESH_TIMEOUT_MS = 1500;
const SERVER_DOWN = "Inbox 서버 꺼짐";
const WAKE_SOURCE = "omo-inbox";
const WAKE_EVENT = "wake_source_state";
const HOLD_EVENT = "continuation_hold_state";
const ANSWER_WINDOW_DEFAULT_MIN = 30;

export function createInbox(pi, deps = {}) {
	const env = deps.env ?? process.env;
	if (CHILD_ENV.some((key) => String(env[key] ?? "").length > 0)) return null;
	const home = resolveHome(env, deps.home);
	const deskHome = deps.deskHome ?? env.INBOX_DESK_HOME ?? path.join(env.INBOX_USER_HOME || os.homedir(), ".omo-desk");
	const agentDir = resolveAgentDir(env, deps.agentDir);
	const source = path.resolve(deps.source ?? path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
	const ownFile = path.resolve(deps.extensionFile ?? fileURLToPath(import.meta.url));
	const now = deps.now ?? (() => Date.now());
	const timer = deps.timer ?? { setInterval, clearInterval };
	const doFetch = deps.fetch ?? ((...args) => globalThis.fetch(...args));
	const abortAfter = deps.abortAfter ?? ((ms) => AbortSignal.timeout(ms));
	const fsImpl = deps.fs ?? fs;
	const spawnImpl = deps.spawn ?? spawn;
	const execPath = deps.execPath ?? process.execPath;
	const platform = deps.platform ?? process.platform;
	const legacyExtension = path.join(agentDir, "extensions", "omo-inbox", "index.ts");
	const packageMode = deps.packageMode ?? (!deps.home && existsSync(path.join(source, ".git")) && existsSync(path.join(source, "bin", "inbox.mjs")) && path.resolve(path.dirname(ownFile)) !== path.resolve(path.join(agentDir, "extensions")));
	const setupOnly = packageMode && existsSync(legacyExtension);
	const loadedSha = deps.loadedSha ?? (packageMode ? readCloneSha(source) : null);
	const activeKey = Symbol.for("omo-inbox.extension.active");
	const owner = packageMode && !setupOnly;
	if (owner && globalThis[activeKey]) return null;
	if (owner) globalThis[activeKey] = source;
	let reloadTries = 0;
	let lastReloadAt = -Infinity;

	const delivered = new Set();
	const noticed = new Set();
	const timedOut = new Set();
	let ctx;
	let sessionId;
	let timers = [];
	let running = false;
	let staleGeneration = false;
	let lastFooter;
	let lastSpawnAt = -Infinity;
	let baseUrlCache;
	let waitingSnapshot = [];
	let initializedSession = false;
	let refreshPromise;
	let refreshRerun = false;
	let rerunStart = false;
	let refreshTimeoutMs = FETCH_TIMEOUT_MS;
	let rerunTimeoutMs = FETCH_TIMEOUT_MS;
	let inboxMode = "trial";
	try {
		const config = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8").replace(/^\uFEFF/, ""));
		if (config?.mode === "primary") inboxMode = "primary";
	} catch {
		// no config yet: trial is the default
	}
	const log = async (text) => {
		try {
			await fsImpl.mkdir(path.join(home, "logs"), { recursive: true });
			await fsImpl.appendFile(path.join(home, "logs", "extension.log"), `${new Date(now()).toISOString()} ${String(text).slice(0, 1500)}\n`);
		} catch {
			// logging must never disturb the session
		}
	};

	/** Every handler and timer body runs through this: a failure is logged, never thrown into senpi. */
	const safe = (name, fn) => async (...args) => {
		if (staleGeneration) return undefined;
		try {
			return await fn(...args);
		} catch (error) {
			if (String(error?.message ?? error).includes("stale extension generation")) {
				staleGeneration = true;
				stop();
				await log("stopped: extension generation replaced by reload");
				return undefined;
			}
			await log(`${name}: ${String((error && error.stack) || error)}`);
			return undefined;
		}
	};

	async function baseUrl() {
		if (baseUrlCache) return baseUrlCache;
		if (env.INBOX_URL) return (baseUrlCache = String(env.INBOX_URL).replace(/\/+$/, ""));
		let port = DEFAULT_PORT;
		try {
			const raw = await fsImpl.readFile(path.join(home, "config.json"), "utf8");
			const config = JSON.parse(String(raw).replace(/^\uFEFF/, ""));
			port = resolvePort(config);
			baseUrlCache = `http://127.0.0.1:${port}`;
		} catch {
			// no config yet (before install) - the default port is what install writes
		}
		return `http://127.0.0.1:${port}`;
	}

	async function exists(file) {
		try {
			await fsImpl.access(file);
			return true;
		} catch {
			return false;
		}
	}

	// --- server access (queued promises only; handlers never await these) ---
	let summaryEnabled = true;
	let summaryModels = DEFAULT_MODELS;
	const makeSummarizer = () => createSummarizer({ models: summaryModels, getRegistry: () => ctx?.modelRegistry, log: (text) => void log(text) });
	let summarizer = makeSummarizer();
	const summaryQueue = createSummaryQueue((request, signal) => summarizer.run(request, signal));

	/** The server returns its summary config with every items POST; the extension never reads config.json for it. */
	function applySummaryConfig(body) {
		const config = body?.summaryConfig;
		if (!config || typeof config !== "object") return;
		summaryEnabled = config.enabled !== false;
		if (Array.isArray(config.models) && config.models.join("\n") !== summaryModels.join("\n")) {
			summaryModels = config.models.filter((model) => typeof model === "string");
			summarizer = makeSummarizer();
		}
	}

	async function postJson(route, body) {
		const response = await doFetch(`${await baseUrl()}${route}`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-inbox": "1" },
			body: JSON.stringify(body ?? {}),
			signal: abortAfter(FETCH_TIMEOUT_MS),
		});
		let json = null;
		try {
			json = await response.json();
		} catch {
			// an empty body is fine
		}
		const object = json && typeof json === "object" ? json : {};
		if (!response.ok) {
			if (response.status >= 500) throw new Error(`post ${route}: ${response.status}`);
			return { ...object, ok: false, status: response.status };
		}
		applySummaryConfig(object);
		return json ?? { ok: true };
	}

	async function getItem(itemId) {
		const response = await doFetch(`${await baseUrl()}/api/items/${encodeURIComponent(itemId)}`, { headers: { accept: "application/json" }, signal: abortAfter(FETCH_TIMEOUT_MS) });
		if (!response?.ok) return null;
		const body = await response.json();
		return body?.item ?? body;
	}

	/**
	 * Runs the model off the handler path and posts the result; a failure only logs.
	 * Todo 32 / C6: when the server lints the draft and answers with `repairRequest`, run the
	 * summarizer once more with it and post that text with `repair: true`. At most one repair per
	 * request: a repairRequest in the repair response is ignored.
	 */
	function runSummary(itemId, request, simpler) {
		if (!summaryEnabled || !request) return;
		void (async () => {
			const out = await summaryQueue.run(request);
			if (!out) return;
			const first = await postJson(`/api/items/${encodeURIComponent(itemId)}/summary`, { text: out.text, model: out.model, simpler });
			const repair = first?.repairRequest;
			if (!repair || typeof repair !== "object") return;
			const repaired = await summaryQueue.run(repair);
			if (!repaired) return;
			await postJson(`/api/items/${encodeURIComponent(itemId)}/summary`, { text: repaired.text, model: repaired.model, simpler, repair: true });
		})().catch((error) => log(`summary: ${String((error && error.message) || error)}`));
	}

	/**
	 * C8 reload rule (todo 32): after a reload, an open question the builtin reattached to the
	 * terminal has no live wait in this bridge generation, so the phone must say terminal-only.
	 */
	async function reportReloadBridgeStates(sid, reload = false) {
		// Only an interactive session can own a question bridge; other modes must not touch the server here.
		if (!sid || ctx?.mode !== "tui") return;
		let body;
		try {
			const response = await doFetch(`${await baseUrl()}/api/threads/${encodeURIComponent(sid)}`, { headers: { accept: "application/json" }, signal: abortAfter(HOOK_TIMEOUT_MS) });
			if (!response?.ok) return;
			body = await response.json();
		} catch (error) {
			await log(`reload bridge: ${String((error && error.message) || error)}`);
			return;
		}
		capture.restoreEpisode(body?.items);
		capture.reportOpenQuestionBridgeStates(body?.items);
		if (reload) capture.recoverTurnEnd(body?.items);
	}

	/** The desk install the trial mode coexists with; its config is what takeover reads. */
	let deskBaseCache;
	async function deskBaseUrl() {
		if (deskBaseCache) return deskBaseCache;
		let port = DESK_DEFAULT_PORT;
		try {
			const config = JSON.parse(String(await fsImpl.readFile(path.join(deskHome, "config.json"), "utf8")).replace(/^\uFEFF/, ""));
			if (Number(config?.port) > 0) port = Number(config.port);
		} catch {
			// no desk config: the default desk port is the fallback
		}
		return (deskBaseCache = `http://127.0.0.1:${port}`);
	}

	/** Trial mode: the desk boards this session waits on, read-only. Any failure is no boards. */
	async function deskBoards() {
		if (inboxMode !== "trial" || !sessionId) return [];
		const cwd = ctx?.cwd ?? pi?.cwd ?? process.cwd();
		try {
			const url = `${await deskBaseUrl()}/api/here?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sessionId)}`;
			const response = await doFetch(url, { headers: { accept: "application/json" }, signal: abortAfter(DESK_FETCH_TIMEOUT_MS) });
			if (!response?.ok) return [];
			const body = await response.json();
			return (Array.isArray(body?.waiting) ? body.waiting : [])
				.filter((board) => board?.status === "mine")
				.map((board) => ({ id: board.id, title: board.title, url: board.url }));
		} catch (error) {
			await log(`desk boards: ${String((error && error.message) || error)}`);
			return [];
		}
	}

	/** "더 쉽게": rewrite the server-validated summary (already redacted); raw session text is never resent. */
	function simplerRequest(item) {
		const summary = item?.summary?.summary ?? item?.summary ?? null;
		if (!summary || typeof summary !== "object") return null;
		return {
			system: "주어진 요약 JSON을 더 쉽게 다시 쓰세요. 짧은 문장, 일상 단어, 예시 하나. 같은 JSON 필드(kind, headline, context, body, ask, options, ifNoAnswer, terms)만 쓰고, 없는 사실이나 권장안을 만들지 말고, JSON만 출력하세요.",
			user: JSON.stringify(summary),
			maxTokens: 700,
		};
	}

	const explain = async (itemId) => {
		const item = await getItem(itemId);
		if (!item) return;
		runSummary(itemId, item.summaryRequestSimpler ?? simplerRequest(item), true);
	};

	async function readGoal(target) {
		const id = target?.sessionManager?.getSessionId?.();
		const file = target?.goalStoreFile ?? (id ? path.join(target?.sessionManager?.getSessionDir?.() ?? "", "extensions", "goal", `${encodeURIComponent(id)}.json`) : null);
		if (!file) return null;
		try {
			const parsed = JSON.parse(String(await fsImpl.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
			return parsed?.goal ?? parsed;
		} catch {
			return null;
		}
	}

	/** A failed capture post means the server is unreachable: show it now, then ask once more. */
	const capturePost = async (route, body) => {
		try {
			return await postJson(route, body);
		} catch (error) {
			void setFooter(SERVER_DOWN);
			void status(false, TOOL_REFRESH_TIMEOUT_MS);
			throw error;
		}
	};

	const cacheTracker = createCacheTracker({ ttlSeconds: deps.ttlSeconds, now });
	const capture = createCapture({
		post: capturePost,
		now,
		mode: inboxMode,
		setTimer: deps.setTimer,
		clearTimer: deps.clearTimer,
		settleDelayMs: deps.settleDelayMs,
		env,
		readGoal,
		cacheTracker,
		deskBoards,
		log: (text) => void log(text),
		onSummaryRequest: (item, request) => runSummary(item.id, request, false),
		bridgeState: (requestId) => bridge.bridgeState(requestId),
	});
	const bridge = createBridge({ log: (text) => void log(text), now, env });
	bridge.onDialog((dialog) => capture.onPermissionDialog(dialog, ctx));
	bridge.onDialogClosed((closed) => capture.onPermissionDialog({ id: closed.id, active: false }, ctx));
	let boardDelivered = false;

	/** Board feedback keeps desk's behavior: deliver when the proposal is still waiting on the agent. */
	async function deliverBoardFeedback(payload) {
		if (!payload || typeof payload !== "object" || !payload.proposalId || payload.seq == null) {
			await log("inbox: unparsable board feedback: missing proposalId/seq");
			return;
		}
		const key = `${payload.proposalId}-${payload.seq}`;
		if (delivered.has(key)) return;
		let theirs = false;
		try {
			const response = await doFetch(`${await baseUrl()}/api/p/${encodeURIComponent(payload.proposalId)}?since=${encodeURIComponent(payload.seq)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			const body = response?.ok ? await response.json() : undefined;
			theirs = !response?.ok || body?.summary?.status === "theirs";
		} catch {
			// the server is unreachable: deliver rather than lose the feedback
			theirs = true;
		}
		if (!theirs) return;
		capture.markOwner("board-feedback");
		pi?.sendMessage?.(
			{ customType: "omo-inbox", content: payload.text, display: true, details: { proposalId: payload.proposalId, seq: payload.seq } },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		delivered.add(key);
		waitingSnapshot = waitingSnapshot.filter((item) => item.id !== payload.proposalId);
		boardDelivered = true;
	}

	/** /inbox status: mode, server state and the open needs-you count. */
	async function statusText() {
		let mode = "trial";
		try {
			const config = JSON.parse(String(await fsImpl.readFile(path.join(home, "config.json"), "utf8")).replace(/^\uFEFF/, ""));
			if (config?.mode === "primary") mode = "primary";
		} catch {
			// no config yet
		}
		let server = "꺼짐";
		let open = 0;
		try {
			const response = await doFetch(`${await baseUrl()}/api/threads`, { headers: { accept: "application/json" }, signal: abortAfter(FETCH_TIMEOUT_MS) });
			if (response?.ok) {
				server = "켜짐";
				open = Number((await response.json())?.counts?.needsYou) || 0;
			}
		} catch {
			// the server is down
		}
		return `omo-inbox 모드: ${mode}, 서버: ${server}, 내 차례: ${open}건`;
	}

	const makeDelivery = () => createDelivery({
		home,
		fs: fsImpl,
		getItem,
		post: postJson,
		bridge,
		pi,
		getCtx: () => ctx,
		explain,
		boardDeliver: deliverBoardFeedback,
		log,
		sessionId: sessionId ?? null,
	});
	let delivery = makeDelivery();

	const packageTick = safe("package", async () => {
		if (!packageMode || await exists(path.join(home, "disabled"))) return;
		let state;
		try {
			state = JSON.parse(await fsImpl.readFile(path.join(home, "app", "source.json"), "utf8"));
		} catch {
			state = undefined;
		}
		if (state?.channel === "checkout") return;
		const sha = await readCloneShaAsync(source, fsImpl);
		if (!sha) return;
		const sameSource = state?.source && path.resolve(state.source) === source;
		if (state?.channel === "package" && state.sha === sha && sameSource) {
			const legacyGone = !(await exists(legacyExtension));
			if ((setupOnly && legacyGone) || loadedSha !== sha) {
				if (reloadTries >= 3 || now() - lastReloadAt < 60_000) return;
				if (ctx?.isIdle?.() === false || (ctx?.hasPendingMessages?.() ?? ctx?.pendingMessages?.length > 0)) return;
				reloadTries += 1;
				lastReloadAt = now();
				(ctx?.requestReload ?? ctx?.reload)?.call(ctx);
			}
			return;
		}
		let claim;
		try {
			claim = JSON.parse(await fsImpl.readFile(path.join(home, "setup-state.json"), "utf8"));
		} catch {
			claim = undefined;
		}
		if ((claim?.sha === sha && claim.failedMs && now() - claim.failedMs < 10 * 60_000) || (claim?.sha === sha && claim.claimMs && now() - claim.claimMs < 60_000)) return;
		await fsImpl.mkdir(home, { recursive: true });
		const claimFile = path.join(home, "setup-state.json");
		await fsImpl.writeFile(claimFile, JSON.stringify({ sha, claimMs: now(), pid: process.pid }));
		let confirmed;
		try { confirmed = JSON.parse(await fsImpl.readFile(claimFile, "utf8")); } catch { return; }
		if (confirmed.sha !== sha || confirmed.pid !== process.pid) return;
		// omo may run on bun; install records its own runtime in the launcher, so it must run on node.
		const child = spawnImpl(await resolveNode(), [path.join(source, "bin", "inbox.mjs"), "install", "--from-package"], { detached: true, stdio: "ignore", windowsHide: true, cwd: home, env });
		child?.unref?.();
	});

	async function resolveNode() {
		if (/^node(\.exe)?$/i.test(path.basename(execPath))) return execPath;
		const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? "";
		for (const dir of String(pathValue).split(platform === "win32" ? ";" : ":")) {
			const candidate = path.join(dir, platform === "win32" ? "node.exe" : "node");
			if (dir && (await exists(candidate))) return candidate;
		}
		return "node";
	}

	/** The CLI launches the server outside this session's job (WMI on Windows); at most one attempt per 120 s. */
	const ensureServer = safe("ensure", async () => {
		// A package install that has not finished setup has no app yet; setup starts the server itself.
		if (await exists(path.join(home, "disabled")) || (packageMode && !(await exists(path.join(home, "app", "bin", "inbox.mjs"))))) return;
		if (now() - lastSpawnAt < SPAWN_COOLDOWN_MS) return;
		lastSpawnAt = now();
		const node = await resolveNode();
		const child = spawnImpl(node, [path.join(home, "app", "bin", "inbox.mjs"), "server", "start"], { detached: true, stdio: "ignore", windowsHide: true });
		child?.on?.("error", (e) => void log("ensure: " + e.message));
		child?.unref?.();
	});

	async function setFooter(text) {
		if (!ctx?.hasUI) return;
		const value = text || undefined;
		if (value === lastFooter) return;
		lastFooter = value;
		try {
			ctx.ui?.setStatus?.("omo-inbox", value);
		} catch {
			// the UI may already be gone during shutdown
		}
	}

	/** The server decides when a pending review is worth announcing; each key is announced once per session. */
	const notice = safe("notice", async (body) => {
		const keys = Array.isArray(body?.noticeKeys) ? body.noticeKeys.filter((key) => typeof key === "string") : [];
		if (keys.length === 0) return;
		if (!keys.some((key) => !noticed.has(key))) return;
		const text = typeof body?.notice === "string" ? body.notice : "";
		if (text) {
			pi?.sendMessage?.({ customType: "omo-inbox", content: text, display: true, details: { pending: keys } }, { deliverAs: "nextTurn", triggerTurn: false });
		}
		for (const key of keys) noticed.add(key);
	});

	const answerWindowMs = () => {
		const rawMinutes = ctx?.getAskUserSettings?.()?.timeoutMinutes;
		const timeoutMinutes = typeof rawMinutes === "number" && rawMinutes > 0 ? Math.min(120, Math.max(1, rawMinutes)) : ANSWER_WINDOW_DEFAULT_MIN;
		return timeoutMinutes * 60_000;
	};

	const publishWaiting = safe("publishWaiting", () => {
		try {
			void ctx?.hasUI;
		} catch (error) {
			if (String(error?.message ?? error).includes("stale extension generation")) {
				staleGeneration = true;
				stop();
				void log("stopped: extension generation replaced by reload");
			} else {
				void log(`publishWaiting: ${String((error && error.message) || error)}`);
			}
			return;
		}
		const windowMs = answerWindowMs();
		const currentTime = now();
		for (const item of waitingSnapshot) {
			if (item.status !== "mine") continue;
			const since = Date.parse(item.since);
			if (isNaN(since) || currentTime - since < windowMs) continue;
			const key = `${item.id}@${item.since}`;
			if (timedOut.has(key)) continue;
			timedOut.add(key);
			const minutes = Math.floor((currentTime - since) / 60_000);
			const content = `[omo-inbox] 답이 없습니다: ${item.title} (${item.id}), ${minutes}분\n처리: 되돌릴 수 있으면 권장안으로 진행하고 node "${home.replace(/\\/g, "/")}/app/bin/inbox.mjs" reply ${item.id} 로 알리세요. 되돌릴 수 없으면 멈추세요. 나중에 온 답도 전달됩니다.`;
			pi?.sendMessage?.(
				{ customType: "omo-inbox", content, display: true, details: { proposalId: item.id, timedOut: true } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		const live = waitingSnapshot.filter((item) => {
			if (item.status === "theirs") return !delivered.has(`${item.id}-${item.seq}`);
			if (item.status === "mine") {
				const since = Date.parse(item.since);
				if (isNaN(since)) return false;
				return currentTime - since < windowMs;
			}
			return false;
		});
		if (live.length > 0) {
			pi?.events?.emit?.(WAKE_EVENT, { source: WAKE_SOURCE, activeCount: live.length });
			pi?.events?.emit?.(HOLD_EVENT, { source: WAKE_SOURCE, active: true });
		} else {
			pi?.events?.emit?.(HOLD_EVENT, { source: WAKE_SOURCE, active: false });
			pi?.events?.emit?.(WAKE_EVENT, { source: WAKE_SOURCE, activeCount: 0 });
		}
	});

	const refreshStatus = safe("status", async (start) => {
		// After /inbox uninstall there is no server to report on.
		if (await exists(path.join(home, "disabled"))) {
			await setFooter(undefined);
			return;
		}
		const cwd = ctx?.cwd ?? pi?.cwd ?? process.cwd();
		if (!sessionId || !cwd) return;
		bridge.install(ctx);
		let idle = 0;
		try {
			idle = ctx?.isIdle?.() === true ? 1 : 0;
		} catch {
			// a broken idle probe reports busy
		}
		const url = `${await baseUrl()}/api/here?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sessionId)}${start ? "&start=1" : ""}&idle=${idle}`;
		let response;
		try {
			response = await doFetch(url, { headers: { accept: "application/json" }, signal: abortAfter(refreshTimeoutMs) });
		} catch (error) {
			await log(`status: ${String((error && error.message) || error)}`);
			await setFooter(SERVER_DOWN);
			await ensureServer();
			publishWaiting();
			return;
		}
		if (!response || !response.ok) {
			await setFooter(SERVER_DOWN);
			await ensureServer();
			publishWaiting();
			return;
		}
		const body = await response.json();
		waitingSnapshot = Array.isArray(body?.waiting) ? body.waiting : [];
		if (!initializedSession) {
			for (const item of waitingSnapshot) {
				const since = Date.parse(item.since);
				if (item.status === "mine" && !isNaN(since) && now() - since >= answerWindowMs()) timedOut.add(`${item.id}@${item.since}`);
			}
			initializedSession = true;
		}
		await setFooter(typeof body?.footer === "string" ? body.footer : "");
		await notice(body);
		publishWaiting();
	});

	const status = (start, timeoutMs = FETCH_TIMEOUT_MS) => {
		if (refreshPromise) {
			refreshRerun = true;
			rerunStart ||= Boolean(start);
			rerunTimeoutMs = Math.min(rerunTimeoutMs, timeoutMs);
			return refreshPromise;
		}
		refreshTimeoutMs = timeoutMs;
		refreshPromise = (async () => {
			try {
				await refreshStatus(start);
				while (refreshRerun) {
					refreshRerun = false;
					const startRerun = rerunStart;
					rerunStart = false;
					refreshTimeoutMs = rerunTimeoutMs;
					rerunTimeoutMs = FETCH_TIMEOUT_MS;
					await refreshStatus(startRerun);
				}
			} finally {
				refreshPromise = undefined;
				refreshRerun = false;
				rerunStart = false;
				rerunTimeoutMs = FETCH_TIMEOUT_MS;
			}
		})();
		return refreshPromise;
	};

	const onToolExecutionEnd = safe("tool_execution_end", () => status(false, TOOL_REFRESH_TIMEOUT_MS));

	/** Drains the mailbox through delivery (single-flight) and retries queued posts; board feedback refreshes the footer. */
	let inboxPromise;
	let inboxAgain = false;
	const drainOnce = safe("inbox", async () => {
		void capture.flush();
		boardDelivered = false;
		await delivery.drain();
		if (boardDelivered) {
			boardDelivered = false;
			publishWaiting();
			await status(false);
		}
	});
	/** A request that arrives during a drain runs one more pass (the mailbox may have changed) and awaits it. */
	const inbox = () => {
		if (inboxPromise) {
			inboxAgain = true;
			return inboxPromise;
		}
		inboxPromise = (async () => {
			try {
				do {
					inboxAgain = false;
					await drainOnce();
				} while (inboxAgain);
			} finally {
				inboxPromise = undefined;
			}
		})();
		return inboxPromise;
	};

	function start() {
		if (setupOnly) {
			const id = timer.setInterval(() => packageTick(), STATUS_MS);
			id?.unref?.();
			timers.push(id);
			return;
		}
		if (running) return;
		running = true;
		const every = (ms, fn) => {
			const id = timer.setInterval(fn, ms);
			id?.unref?.();
			timers.push(id);
		};
		every(INBOX_MS, () => inbox());
		every(STATUS_MS, () => status(false));
		if (packageMode) every(STATUS_MS, () => packageTick());
	}

	function stop() {
		for (const id of timers) {
			try {
				timer.clearInterval(id);
			} catch {
				// the timer may already be gone
			}
		}
		timers = [];
		running = false;
		try {
			bridge.uninstall(ctx);
		} catch {
			// the UI may already be gone
		}
		if (owner && globalThis[activeKey] === source) delete globalThis[activeKey];
	}

	const onSessionStart = safe("session_start", async (event, nextCtx) => {
		ctx = nextCtx;
		await packageTick();
		start();
		if (setupOnly) return;
		initializedSession = false;
		try {
			sessionId = nextCtx?.sessionManager?.getSessionId?.() ?? sessionId;
		} catch {
			// keep the previous id
		}
		bridge.install(nextCtx);
		capture.onSessionStart(nextCtx);
		delivery = makeDelivery();
		await delivery.reload(sessionId);
		// A hook may wait on the network for at most 1.5 s (IS-12): both reads get that
		// abort and run together, so a hung server cannot stack two 5 s waits here.
		await Promise.all([status(true, HOOK_TIMEOUT_MS), reportReloadBridgeStates(sessionId, event?.reason === "reload")]);
	});

	const onSessionShutdown = safe("session_shutdown", async (event) => {
		stop();
		if (owner && globalThis[activeKey] === source) delete globalThis[activeKey];
		if (setupOnly) return;
		pi?.events?.emit?.(HOLD_EVENT, { source: WAKE_SOURCE, active: false });
		pi?.events?.emit?.(WAKE_EVENT, { source: WAKE_SOURCE, activeCount: 0 });
		if (!sessionId) return;
		try {
			await doFetch(`${await baseUrl()}/api/bye`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-inbox": "1" },
				// quit / new / resume / fork leave this session; only a reload keeps it.
				body: JSON.stringify({ session: sessionId, ...(typeof event?.reason === "string" && event.reason !== "reload" ? { closed: true } : {}) }),
				signal: abortAfter(HOOK_TIMEOUT_MS),
			});
		} catch {
			// the server is already gone
		}
	});

	try {
		pi?.on?.("session_start", onSessionStart);
		pi?.on?.("session_shutdown", onSessionShutdown);
		if (setupOnly) return { stop, packageTick };
		if (owner) pi?.registerCommand?.("inbox", {
			handler: async (args, commandCtx) => {
				const action = String(args ?? "").trim().split(/\s+/)[0];
				let executable;
				let cliArgs;
				if (action === "install") {
					if (!packageMode) {
						commandCtx?.ui?.notify?.("패키지 설치에서만 사용할 수 있습니다.", "warning");
						return;
					}
					executable = path.join(source, "bin", "inbox.mjs");
					cliArgs = ["install", "--from-package"];
				} else if (action === "uninstall" || action === "takeover" || action === "handback") {
					executable = path.join(packageMode ? source : path.join(home, "app"), "bin", "inbox.mjs");
					cliArgs = [action];
				} else if (action === "status") {
					commandCtx?.ui?.notify?.(await statusText(), "info");
					return;
				} else {
					commandCtx?.ui?.notify?.("사용법: /inbox install | uninstall | takeover | handback | status", "info");
					return;
				}
				const child = spawnImpl(await resolveNode(), [executable, ...cliArgs], { detached: true, stdio: "ignore", windowsHide: true, cwd: home, env });
				child?.unref?.();
				commandCtx?.ui?.notify?.(`omo-inbox ${action}을(를) 시작했습니다.`, "info");
			},
		});
		pi?.on?.("tool_execution_end", onToolExecutionEnd);
		const capturing = (name, call) => safe(name, async (event, eventCtx) => {
			call(event, eventCtx ?? ctx);
		});
		pi?.on?.("tool_execution_end", capturing("capture:tool_execution_end", (event, c) => capture.onToolExecutionEnd(event, c)));
		pi?.on?.("message_start", capturing("message_start", (event, c) => capture.onMessageStart(event, c)));
		pi?.on?.("message_end", capturing("message_end", (event, c) => capture.onMessageEnd(event, c)));
		pi?.on?.("agent_start", capturing("agent_start", (_event, c) => {
			bridge.setRunInFlight(true);
			capture.onAgentStart(c);
		}));
		pi?.on?.("agent_end", capturing("agent_end", (event, c) => {
			bridge.setRunInFlight(false);
			capture.onAgentEnd(event, c);
		}));
		pi?.on?.("agent_settled", capturing("agent_settled", (_event, c) => {
			capture.onAgentSettled(c);
			void status(false, TOOL_REFRESH_TIMEOUT_MS);
		}));
		pi?.on?.("input", capturing("input", (event, c) => capture.onInput(event, c)));
		// pi.events listeners are synchronous: ask-user:asked installs the bridge before ask-user re-reads ctx.ui.question (C8).
		const listen = (channel, call) => pi?.events?.on?.(channel, (data) => {
			if (staleGeneration) return;
			try {
				call(data);
			} catch (error) {
				void log(`${channel}: ${String((error && error.message) || error)}`);
			}
		});
		listen("ask-user:asked", (data) => {
			bridge.install(ctx);
			capture.onAskUserAsked(data);
		});
		listen("ask-user:closed", (data) => {
			if (typeof data?.requestId === "string") bridge.noteClosed(data.requestId, String(data.status ?? ""), data.response);
			capture.onAskUserClosed(data);
		});
		for (const channel of ["wake_source_state", "continuation_hold_state", "terminal_monitor_state", "goal_continuation_scheduled", "goal_continuation_timer_state"]) listen(channel, (data) => capture.onSignal(channel, data));
		listen("goal_store_changed", (data) => capture.onGoalStoreChanged(data, ctx));
		listen("inbox:notice", (data) => capture.onNotice(data, ctx));
		listen("permission_asked", (data) => {
			const id = data?.id ?? data?.dialogId;
			if (id) capture.onPermissionDialog({ id: String(id), active: true }, ctx);
		});
		listen("herdr:blocked", (data) => {
			const id = data?.id ?? data?.dialogId;
			if (id && typeof data?.active === "boolean") capture.onPermissionDialog({ id: String(id), active: data.active }, ctx);
		});
	} catch (error) {
		void log(`register: ${String((error && error.message) || error)}`);
	}

	return { inbox, status, notice, packageTick, stop };
}

function readCloneSha(source) {
	try {
		const gitDir = path.join(source, ".git");
		let head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
		if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/i.test(head) ? head : null;
		const ref = head.slice(5);
		try {
			const sha = readFileSync(path.join(gitDir, ...ref.split("/")), "utf8").trim();
			if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
		} catch {}
		for (const line of readFileSync(path.join(gitDir, "packed-refs"), "utf8").split(/\r?\n/)) {
			const match = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
			if (match?.[2] === ref) return match[1];
		}
	} catch {}
	return null;
}

async function readCloneShaAsync(source, fsImpl) {
	try {
		const gitDir = path.join(source, ".git");
		const head = String(await fsImpl.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
		if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/i.test(head) ? head : null;
		const ref = head.slice(5);
		try {
			const sha = String(await fsImpl.readFile(path.join(gitDir, ...ref.split("/")), "utf8")).trim();
			if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
		} catch {}
		for (const line of String(await fsImpl.readFile(path.join(gitDir, "packed-refs"), "utf8")).split(/\r?\n/)) {
			const match = line.match(/^([0-9a-f]{40})\s+(.+)$/i);
			if (match?.[2] === ref) return match[1];
		}
	} catch {}
	return null;
}
