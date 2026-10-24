/**
 * omo-inbox capture (plan todos 14 and 8): maps senpi session events into inbox items, one gray line per assistant
 * message, and closes an episode ("one owner request, one report") with a final only when the work really stops.
 * The decisions live in episode.ts; this module wires the runtime events into them.
 *
 * core.ts registers the handlers and owns the child-session guard; this module
 * never registers anything itself and never imports from src/. Posts are
 * fire-and-forget: a failed post stays in an in-memory queue (max 200, the
 * oldest is dropped) and is retried on the next flush().
 */
import {
	adoptReopen,
	applyServerState,
	closeEpisode,
	createEpisodeState,
	currentEpisode,
	lineKey,
	markOwner as markEpisodeOwner,
	noteLine,
	observeSignal,
	onAgentStart as startEpisode,
	restore as restoreState,
	standingCount,
	verdict,
	willWake,
} from "./episode.ts";
import type { EpisodeState, Verdict } from "./episode.ts";
import { CHILD_ENV } from "./util.ts";

const SETTLE_DELAY_MS = 2500;
/** A signal that turns waking off while idle closes the episode after this long, unless a start or a wake comes first. */
const FLIP_DELAY_MS = 10_000;
const CACHE_MOVE_MS = 30_000;
const TEXT_LIMIT = 8 * 1024;
const REQUEST_LIMIT = 2 * 1024;
const REQUEST_META_LIMIT = 600;
const QUEUE_LIMIT = 200;
const STATE_REASONS_MAX = 10;
const STATE_REASON_LIMIT = 40;
const STATE_BOARDS_MAX = 5;
/** C8: resolvedBy of an answer that came through the phone bridge. */
const BRIDGE_RESOLVED_BY = "omo_inbox";
const ANSWER_PREFIX = "[Answer to question";

export type CaptureDeps = {
	post: (path: string, body: unknown) => Promise<any>,
	now?: () => number,
	setTimer?: (fn: () => void, ms: number) => unknown,
	clearTimer?: (handle: unknown) => void,
	readGoal?: (ctx: any) => any,
	mode?: string,
	log?: (text: string) => void,
	settleDelayMs?: number,
	env?: Record<string, string | undefined>,
	cacheTracker?: { onAssistantStart?: (ctx: any) => { warmUntil?: number, ttlSec?: number, moved?: boolean } | null | undefined },
	onSummaryRequest?: (item: any, request: any) => void,
	/** C5/C8: the bridge state of a question, reported once its item exists. */
	bridgeState?: (requestId: string) => string,
	/** Desk boards the session waits on, shown on the newest line while it waits (trial mode); default none. */
	deskBoards?: () => any[] | Promise<any[]>,
};

type QuestionRecord = { itemId: string | null, pendingClose: { reason: string, resolvedBy: string | null } | null };
/** `prepare` builds the body when the entry reaches the front of the queue, so it sees what the posts before it left behind. Null drops the entry. */
type QueueEntry = { path: string, body: unknown, onResponse?: (response: any) => void, prepare?: () => unknown };
/** The newest line of the open episode: the item a "waiting" state is attached to. */
type LineRecord = { itemId: string | null, waiting: Record<string, unknown> | null };

export function createCapture(deps: CaptureDeps) {
	const now = deps.now ?? (() => Date.now());
	const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const log = deps.log ?? (() => {});
	const settleDelayMs = deps.settleDelayMs ?? SETTLE_DELAY_MS;
	const env = deps.env ?? process.env;
	const readGoal = deps.readGoal ?? (async () => null);
	const deskBoards = deps.deskBoards ?? (() => []);

	let ctx: any = null;
	let sessionStartMs = 0;
	let metaSent = false;
	let metaFirstRequest = "";
	let metaLastRequest = "";
	/** The plan slug this session executes was already posted as thread meta (at most once per session). */
	let executesSent = false;
	let emptySessionLogged = false;
	let runId = 0;
	let runStartedAtMs = 0;
	let runText = "";
	/** Send time of the run's last assistant reply, the stamp of the final's dedupe key. */
	let runEndStamp = 0;
	let lastMessageStamp = 0;
	let runAborted = false;
	let runAbortSource = "";
	let settleSeq = 0;
	let settleHandle: unknown = null;
	let flipHandle: unknown = null;
	let armedRunId = -1;
	let armedSeq = 0;
	let startSeq = 0;
	let lastCacheWarmUntil = 0;
	let goalCapturedStatus: string | null = null;
	let goalCapturedRunId = -1;
	/** update_goal blocked/complete seen inside an open episode: the turn end closes it (no goal item). */
	let pendingClose: "done" | "blocked" | null = null;
	/** The run whose turn end already closed an episode: a second settle in the same run must not report it again. */
	let closedRunId = -1;
	let pendingGoal: any = null;
	/** The episode reducer. Its signal state (wake counts, holds, scheduled) is level state and outlives every session reset. */
	let ep: EpisodeState = createEpisodeState("");
	let lastLine: LineRecord | null = null;
	let lastLineText = "";
	let openerKey = "";
	let openerRequest = "";
	const openQuestions = new Set<string>();
	const openDialogs = new Set<string>();
	const questionItems = new Map<string, QuestionRecord>();
	const dialogItems = new Map<string, { itemId: string | null }>();
	const postedGoalKeys = new Set<string>();
	const queue: QueueEntry[] = [];
	let draining = false;
	let drainPromise: Promise<void> | null = null;

	// --- text helpers -------------------------------------------------------

	function messageText(message: any): string {
		const content = message?.content;
		if (typeof content === "string") return content.trim();
		if (!Array.isArray(content)) return "";
		let text = "";
		for (const part of content) {
			if (part && part.type === "text" && typeof part.text === "string") text += part.text;
		}
		return text.trim();
	}

	function lastAssistantText(messages: any): string {
		if (!Array.isArray(messages)) return "";
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant") continue;
			const text = messageText(message);
			if (text.length > 0) return clip(text, TEXT_LIMIT);
		}
		return "";
	}

	function lastAssistantStamp(messages: any): number {
		if (!Array.isArray(messages)) return 0;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message?.role !== "assistant" || messageText(message).length === 0) continue;
			const stamp = Number(message.timestamp);
			return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
		}
		return 0;
	}

	function userTexts(target: any): string[] {
		let branch: any[] = [];
		try {
			branch = target?.sessionManager?.getBranch?.() ?? [];
		} catch (error) {
			log(`capture: branch unavailable: ${text(error)}`);
			return [];
		}
		const texts = [];
		for (const entry of branch) {
			if (entry?.type !== "message" || entry.message?.role !== "user") continue;
			const text = messageText(entry.message);
			if (text.length === 0 || text.startsWith(ANSWER_PREFIX)) continue;
			texts.push(text);
		}
		return texts;
	}

	function firstRequest(target: any): string {
		const texts = userTexts(target);
		return clip(texts[0] ?? "", REQUEST_META_LIMIT);
	}

	function latestRequest(target: any): string {
		const texts = userTexts(target);
		return clip(texts[texts.length - 1] ?? "", REQUEST_LIMIT);
	}

	function lastMetaRequest(target: any): string {
		const texts = userTexts(target);
		return clip(texts[texts.length - 1] ?? "", REQUEST_META_LIMIT);
	}

	function sessionMeta(target: any, first = firstRequest(target), last = lastMetaRequest(target)): Record<string, unknown> {
		const model = target?.model;
		const modelId = typeof model?.id === "string" && model.id.length > 0
			? [model.provider, model.id].filter((part: unknown) => typeof part === "string" && part.length > 0).join("/")
			: null;
		let sessionFile: string | null = null;
		let sessionName: string | null = null;
		try {
			sessionFile = target?.sessionManager?.getSessionFile?.() ?? null;
			sessionName = target?.sessionManager?.getSessionName?.() ?? null;
		} catch (error) {
			log(`capture: session meta unavailable: ${text(error)}`);
		}
		return {
			cwd: target?.cwd ?? null,
			sessionFile,
			sessionName,
			firstRequest: first,
			lastRequest: last,
			model: modelId,
		};
	}

	function clip(value: string, limit: number): string {
		return value.length <= limit ? value : value.slice(0, limit);
	}

	function text(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function sessionId(target: any): string {
		try {
			return String(target?.sessionManager?.getSessionId?.() ?? "");
		} catch (error) {
			log(`capture: session id unavailable: ${text(error)}`);
			return "";
		}
	}

	/** m6: a session without an id would post to `/api/threads//...`; skip and say so once. */
	function sessionIdOrNull(target: any): string | null {
		const id = sessionId(target);
		if (id.length > 0) return id;
		if (!emptySessionLogged) {
			emptySessionLogged = true;
			log("capture: session id is empty, skipping posts");
		}
		return null;
	}

	/**
	 * The stamp an episode key is derived from: the last transcript entry when the run starts (agent_start fires
	 * before the new user message is persisted). A message entry gives its message timestamp, any other entry its
	 * own timestamp, an empty branch 0.
	 */
	function branchStamp(target: any): number {
		let branch: any[] = [];
		try {
			branch = target?.sessionManager?.getBranch?.() ?? [];
		} catch (error) {
			log(`capture: branch unavailable: ${text(error)}`);
			return 0;
		}
		const last = branch[branch.length - 1];
		if (last === undefined || last === null) return 0;
		const fromMessage = last.type === "message" ? Number(last.message?.timestamp) : Number.NaN;
		const stamp = Number.isFinite(fromMessage) && fromMessage > 0 ? fromMessage : Date.parse(String(last.timestamp ?? ""));
		return Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
	}

	// --- episode state ------------------------------------------------------

	/** A new reducer for a new session that keeps the runtime's level signals: they are published once and never again. */
	function freshEpisodeState(sid: string): void {
		const next = createEpisodeState(sid);
		next.sources = ep.sources;
		next.holds = ep.holds;
		next.scheduled = ep.scheduled;
		ep = next;
	}

	function syncEpisodeSession(target: any): void {
		const sid = sessionId(target);
		if (sid.length > 0 && sid !== ep.sid) freshEpisodeState(sid);
	}

	function wakeNow(): { wake: boolean, reasons: string[] } {
		return willWake(ep, { openQuestions, openDialogs, now: now() });
	}

	/** The request that opened the open episode, read once when its first line or final needs it. */
	function openerRequestFor(target: any): string {
		const key = ep.episode?.key ?? "";
		if (key !== openerKey) {
			openerKey = key;
			openerRequest = latestRequest(target);
		}
		return openerRequest;
	}

	// --- posting ------------------------------------------------------------

	function live(target: any): boolean {
		if (target === null || target === undefined) return false;
		if (target.mode !== "tui") return false;
		return !CHILD_ENV.some((key) => String(env[key] ?? "").length > 0);
	}

	function drain(): Promise<void> {
		if (draining) return drainPromise ?? Promise.resolve();
		draining = true;
		drainPromise = (async () => {
			try {
				while (queue.length > 0) {
					const entry = queue[0];
					if (entry.prepare !== undefined) {
						// Built once: a retry after a failed post resends the same body (and the same line sequence number).
						const prepare = entry.prepare;
						entry.prepare = undefined;
						let built: unknown = null;
						try {
							built = prepare();
						} catch (error) {
							log(`capture: preparing ${entry.path} failed, dropped: ${text(error)}`);
						}
						if (built === null || built === undefined) {
							queue.shift();
							continue;
						}
						entry.body = built;
					}
					let response: any;
					try {
						response = await deps.post(entry.path, entry.body);
					} catch (error) {
						log(`capture: post ${entry.path} failed, queued for retry: ${text(error)}`);
						return;
					}
					queue.shift();
					try {
						entry.onResponse?.(response);
					} catch (error) {
						log(`capture: post response handler failed: ${text(error)}`);
					}
				}
			} finally {
				draining = false;
				drainPromise = null;
			}
		})();
		return drainPromise;
	}

	function send(path: string, body: unknown, onResponse?: (response: any) => void, prepare?: () => unknown): void {
		queue.push({ path, body, onResponse, prepare });
		while (queue.length > QUEUE_LIMIT) {
			const dropped = queue.shift();
			log(`capture: queue full, dropped post ${String(dropped?.path)}`);
		}
		void drain();
	}

	function ensureMeta(target: any, sid?: string | null, extra?: Record<string, unknown>, force = false): void {
		const id = sid === undefined ? sessionIdOrNull(target) : sid;
		if (id === null) return;
		const first = metaFirstRequest.length > 0 ? metaFirstRequest : firstRequest(target);
		const last = lastMetaRequest(target) || metaLastRequest;
		if (!force && metaSent && first === metaFirstRequest && last === metaLastRequest) return;
		metaSent = true;
		metaFirstRequest = first;
		metaLastRequest = last;
		const body = sessionMeta(target, first, last);
		if (extra !== undefined) Object.assign(body, extra);
		send(`/api/threads/${id}/meta`, body);
	}

	/** `input` may be a builder: it runs when the post reaches the front of the queue (null drops the post). */
	function postItem(target: any, input: Record<string, unknown> | (() => Record<string, unknown> | null), onResponse?: (response: any) => void): void {
		const sid = sessionIdOrNull(target);
		if (sid === null) return;
		ensureMeta(target, sid);
		const handle = (response: any): void => {
			const item = response?.item;
			if (item?.id !== undefined && response?.summaryRequest !== null && response?.summaryRequest !== undefined && typeof deps.onSummaryRequest === "function") {
				try {
					deps.onSummaryRequest(item, response.summaryRequest);
				} catch (error) {
					log(`capture: summary request failed: ${text(error)}`);
				}
			}
			onResponse?.(response);
		};
		if (typeof input === "function") send(`/api/threads/${sid}/items`, null, handle, input);
		else send(`/api/threads/${sid}/items`, input, handle);
	}

	function itemInput(kind: string, policy: string, dedupeKey: string, raw: unknown, meta?: unknown): Record<string, unknown> {
		const input: Record<string, unknown> = { kind, policy, dedupeKey, raw };
		if (meta !== undefined && meta !== null) input.meta = meta;
		return input;
	}

	function closeItem(itemId: string, reason: string, resolvedBy: string | null): void {
		send(`/api/items/${itemId}/close`, resolvedBy === null ? { reason } : { reason, resolvedBy });
	}

	function postActivity(target: any, body: Record<string, unknown>, onResponse?: (response: any) => void): void {
		const sid = sessionIdOrNull(target);
		if (sid === null) return;
		send(`/api/threads/${sid}/activity`, body, onResponse);
	}

	// --- lines --------------------------------------------------------------

	/**
	 * One gray line per assistant message with text. The episode key and sequence are read when the post is sent
	 * (after the agent-start activity before it has answered), not now.
	 */
	function postLine(target: any, lineText: string, stamp: number): void {
		const sid = sessionIdOrNull(target);
		if (sid === null) return;
		const record: LineRecord = { itemId: null, waiting: null };
		lastLine = record;
		lastLineText = lineText;
		postItem(target, () => {
			const request = latestRequest(target);
			const open = currentEpisode(ep);
			if (open === null) {
				const key = stamp > 0 ? lineKey(sid, stamp, "", 0) : `line:${sid}:r${runId}:${Math.floor(now())}`;
				return itemInput("progress", "progress", key, { text: lineText, request });
			}
			openerRequestFor(target);
			const seq = noteLine(ep);
			return itemInput("progress", "progress", lineKey(sid, stamp, open.key, seq), { text: lineText, request }, {
				episode: { key: open.key, opener: open.opener, openedAt: open.openedAt, seq },
			});
		}, (response) => {
			if (response?.item?.id === undefined) return;
			record.itemId = String(response.item.id);
			if (record.waiting === null) return;
			const waiting = record.waiting;
			record.waiting = null;
			send(`/api/items/${record.itemId}/state`, waiting);
		});
	}

	/** A turn end that will wake again: the newest line says what it waits for. */
	async function reportWaiting(reasons: string[]): Promise<void> {
		const record = lastLine;
		if (record === null) return;
		let boards: any[] = [];
		try {
			const found = await deskBoards();
			if (Array.isArray(found)) boards = found.slice(0, STATE_BOARDS_MAX);
		} catch (error) {
			log(`capture: desk boards unavailable: ${text(error)}`);
		}
		const body = {
			state: "waiting",
			reasons: reasons.slice(0, STATE_REASONS_MAX).map((reason) => clip(reason, STATE_REASON_LIMIT)),
			boards,
		};
		if (record.itemId === null) {
			record.waiting = body;
			return;
		}
		send(`/api/items/${record.itemId}/state`, body);
	}

	// --- goals --------------------------------------------------------------

	async function readGoalSafe(target: any): Promise<any> {
		try {
			const goal = await readGoal(target);
			return goal !== null && typeof goal === "object" ? goal : null;
		} catch (error) {
			log(`capture: goal read failed: ${text(error)}`);
			return null;
		}
	}

	function goalKey(goal: any): string {
		return `goal:${String(goal.status)}:${String(goal.updatedAt ?? "")}`;
	}

	function goalUpdatedInRun(goal: any): boolean {
		if (typeof goal?.updatedAt !== "number") return false;
		return goal.updatedAt * 1000 >= runStartedAtMs;
	}

	function capturedThisRun(status: string): boolean {
		return goalCapturedStatus === status && goalCapturedRunId === runId;
	}

	function postGoalItem(target: any, goal: any): void {
		const key = goalKey(goal);
		if (postedGoalKeys.has(key)) return;
		postedGoalKeys.add(key);
		goalCapturedStatus = String(goal.status);
		goalCapturedRunId = runId;
		const kind = goal.status === "blocked" ? "blocked" : "done";
		const raw = {
			text: runText,
			request: latestRequest(target),
			goal: { reason: goal.blockedReason ?? null, objective: goal.objective ?? null },
		};
		postItem(target, itemInput(kind, "needs-you", key, raw));
	}

	/** Inside an open episode a blocked or completed goal does not post its own item: the turn end closes the episode with it. */
	function setPendingClose(goal: any): void {
		pendingClose = goal.status === "blocked" ? "blocked" : "done";
		pendingGoal = goal;
		goalCapturedStatus = String(goal.status);
		goalCapturedRunId = runId;
	}

	// --- settle timer -------------------------------------------------------

	function armSettle(target: any): void {
		ctx = target;
		settleSeq += 1;
		armedRunId = runId;
		armedSeq = settleSeq;
		const seq = settleSeq;
		settleHandle = setTimer(() => {
			settleHandle = null;
			void classify(target, seq).catch((error) => {
				log(`capture: settle classification failed: ${text(error)}`);
			});
		}, settleDelayMs);
	}

	function cancelSettle(): void {
		if (settleHandle === null) return;
		clearTimer(settleHandle);
		settleHandle = null;
	}

	function cancelFlip(): void {
		if (flipHandle === null) return;
		clearTimer(flipHandle);
		flipHandle = null;
	}

	async function classify(target: any, seq: number): Promise<void> {
		if (!live(target) || ctx !== target) return;
		if (armedSeq !== seq || armedRunId !== runId) return;
		if (typeof target.isIdle === "function" && target.isIdle() === false) return;
		const turnText = runText.trim();
		if (turnText.length === 0 && pendingClose === null) return;
		await resolveTurn(target, turnText.length > 0 ? turnText : lastLineText, () => ctx === target && armedSeq === seq && armedRunId === runId);
	}

	/**
	 * A turn end (or a flip): ask the reducer. A session that will wake again only gets its newest line marked
	 * waiting; anything else closes the episode with a final. `current` says the run was not replaced meanwhile.
	 */
	async function resolveTurn(target: any, turnText: string, current: () => boolean): Promise<void> {
		const goal = await readGoalSafe(target);
		if (!current()) return;
		const goalDone = goal?.status === "complete" && goalUpdatedInRun(goal);
		// A goal blocked before this run stays blocked until the owner revives it; it must not close later work.
		const goalBlocked = goal?.status === "blocked" && goalUpdatedInRun(goal);
		if (ep.episode === null) {
			if (closedRunId === runId) {
				log("capture: turn end already reported in this run");
				return;
			}
			// No agent start was seen for this work (a reload dropped it): the old goal item already said it.
			if (goal?.status === "blocked" && capturedThisRun("blocked")) return;
			if (goalDone && capturedThisRun("complete")) return;
			startEpisode(ep, { stamp: runEndStamp > 0 ? runEndStamp : lastMessageStamp, now: now() });
		}
		const decision = verdict(ep, {
			aborted: runAborted,
			abortSource: runAbortSource,
			goal,
			goalCompletedInRun: goalDone,
			goalBlockedInRun: goalBlocked,
			pendingClose,
			openQuestions,
			openDialogs,
			now: now(),
		});
		log(`capture: ${decision.action} ${decision.closeReason ?? "-"} wait=${decision.reasons.length > 0 ? decision.reasons.join(",") : "-"}`);
		if (decision.action === "line-only") {
			await reportWaiting(decision.reasons);
			return;
		}
		closeNow(target, decision, turnText, goal);
	}

	function closeNow(target: any, decision: Verdict, turnText: string, goal: any): void {
		if (decision.closeReason === null) return;
		const request = openerRequestFor(target);
		const lastRequest = latestRequest(target);
		const closed = closeEpisode(ep, decision.closeReason, runEndStamp > 0 ? runEndStamp : lastMessageStamp, now());
		if (closed === null) return;
		closedRunId = runId;
		cancelFlip();
		const raw: Record<string, unknown> = { final: turnText, request, lastRequest };
		if (decision.kind === "blocked") {
			const source = goal?.status === "blocked" ? goal : pendingGoal;
			if (source !== null && source !== undefined) raw.goal = { reason: source.blockedReason ?? null, objective: source.objective ?? null };
		} else if (decision.kind === "done") {
			const source = goal?.status === "complete" ? goal : pendingGoal;
			if (source !== null && source !== undefined) raw.goal = { reason: null, objective: source.objective ?? null };
		}
		const meta: Record<string, unknown> = { episode: closed.meta };
		if (decision.stalled) meta.stalled = true;
		const watch = standingCount(ep);
		if (watch > 0) meta.watch = watch;
		lastLine = null;
		lastLineText = "";
		openerKey = "";
		openerRequest = "";
		pendingClose = null;
		pendingGoal = null;
		postItem(target, itemInput(decision.kind, decision.policy, closed.dedupeKey, raw, meta));
	}

	/** A signal turned waking off (or a restore's grace is running out): while idle with an open episode, close it unless something wakes first. */
	function armFlip(delayMs: number): void {
		const target = ctx;
		if (flipHandle !== null || settleHandle !== null || ep.episode === null || !live(target)) return;
		const flipRun = runId;
		flipHandle = setTimer(() => {
			flipHandle = null;
			void flipClose(target, flipRun).catch((error) => {
				log(`capture: flip close failed: ${text(error)}`);
			});
		}, delayMs);
	}

	function idleNow(target: any): boolean {
		return !(typeof target?.isIdle === "function" && target.isIdle() === false);
	}

	function maybeArmFlip(): void {
		const target = ctx;
		if (flipHandle !== null || settleHandle !== null || ep.episode === null || !live(target)) return;
		try {
			if (!idleNow(target)) return;
		} catch (error) {
			log(`capture: idle state unavailable, flip not armed: ${text(error)}`);
			return;
		}
		if (wakeNow().wake) return;
		armFlip(FLIP_DELAY_MS);
	}

	async function flipClose(target: any, flipRun: number): Promise<void> {
		if (!live(target) || ctx !== target || runId !== flipRun || settleHandle !== null || ep.episode === null) return;
		if (!idleNow(target) || wakeNow().wake) return;
		const turnText = runText.trim().length > 0 ? runText.trim() : lastLineText;
		if (turnText.length === 0 && pendingClose === null) {
			log("capture: flip close skipped, the episode has no text");
			return;
		}
		await resolveTurn(target, turnText, () => ctx === target && runId === flipRun && settleHandle === null);
	}

	function resetSession(): void {
		cancelSettle();
		cancelFlip();
		ctx = null;
		sessionStartMs = 0;
		metaSent = false;
		metaFirstRequest = "";
		metaLastRequest = "";
		executesSent = false;
		emptySessionLogged = false;
		runId = 0;
		runStartedAtMs = 0;
		runText = "";
		runEndStamp = 0;
		lastMessageStamp = 0;
		runAborted = false;
		runAbortSource = "";
		settleSeq = 0;
		armedRunId = -1;
		armedSeq = 0;
		lastCacheWarmUntil = 0;
		goalCapturedStatus = null;
		goalCapturedRunId = -1;
		pendingClose = null;
		pendingGoal = null;
		closedRunId = -1;
		lastLine = null;
		lastLineText = "";
		openerKey = "";
		openerRequest = "";
		// Wake counts and holds are the runtime's level state, published once (possibly before this ctx exists): keep them.
		freshEpisodeState("");
		openQuestions.clear();
		openDialogs.clear();
		questionItems.clear();
		dialogItems.clear();
		postedGoalKeys.clear();
	}

	return {
		onSessionStart(nextCtx: any): void {
			resetSession();
			if (!live(nextCtx)) return;
			ctx = nextCtx;
			sessionStartMs = now();
			syncEpisodeSession(nextCtx);
			ensureMeta(nextCtx);
		},

		onAskUserAsked(event: any): void {
			const target = event?.ctx ?? ctx;
			if (!live(target)) return;
			const request = event?.request ?? {};
			const requestId = String(request.requestId ?? request.id ?? "");
			if (requestId.length === 0) return;
			openQuestions.add(requestId);
			const questions = Array.isArray(request.questions) ? request.questions.map(questionSnapshot) : [];
			const raw = {
				request: {
					requestId,
					questions,
					waitForAnswer: request.waitForAnswer !== false,
					required: request.required === true,
					timeoutMs: typeof request.timeoutMs === "number" ? request.timeoutMs : null,
					askedAt: now(),
				},
			};
			questionItems.set(requestId, { itemId: null, pendingClose: null });
			postItem(target, itemInput("question", "needs-you", `q:${requestId}`, raw), (response) => {
				const record = questionItems.get(requestId);
				if (record === undefined || response?.item?.id === undefined) return;
				record.itemId = String(response.item.id);
				if (record.pendingClose === null && deps.bridgeState !== undefined) {
					send(`/api/items/${record.itemId}/bridge`, { state: deps.bridgeState(requestId) });
				}
				if (record.pendingClose === null) return;
				const pending = record.pendingClose;
				record.pendingClose = null;
				closeItem(record.itemId, pending.reason, pending.resolvedBy);
			});
		},

		onAskUserClosed(event: any): void {
			const target = event?.ctx ?? ctx;
			if (!live(target)) return;
			const requestId = String(event?.requestId ?? "");
			if (requestId.length === 0) return;
			openQuestions.delete(requestId);
			const status = String(event?.status ?? "");
			const resolvedBy = typeof event?.resolvedBy === "string" ? event.resolvedBy : null;
			const reason = closeReason(status, resolvedBy);
			// The agent start that follows an answer is the owner's, whichever surface answered.
			if (reason.startsWith("answered-")) {
				syncEpisodeSession(target);
				markEpisodeOwner(ep, "question-answer", now());
			}
			const record = questionItems.get(requestId);
			if (record === undefined) return;
			if (record.itemId === null) {
				record.pendingClose = { reason, resolvedBy };
				return;
			}
			closeItem(record.itemId, reason, resolvedBy);
		},

		onPermissionDialog(dialog: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target) || dialog === null || dialog === undefined) return;
			const id = String(dialog.id ?? "");
			if (id.length === 0) return;
			if (typeof dialog.active === "boolean") {
				// herdr:blocked open/close pair; the bridge and delivery own the item.
				if (dialog.active) openDialogs.add(id);
				else openDialogs.delete(id);
				return;
			}
			openDialogs.add(id);
			if (dialogItems.has(id)) return;
			dialogItems.set(id, { itemId: null });
			const raw = {
				dialog: {
					id,
					title: typeof dialog.title === "string" ? dialog.title : "",
					options: Array.isArray(dialog.options) ? dialog.options.slice() : [],
				},
			};
			postItem(target, itemInput("permission", "needs-you", `perm:${id}`, raw), (response) => {
				const record = dialogItems.get(id);
				if (record !== undefined && response?.item?.id !== undefined) record.itemId = String(response.item.id);
			});
		},

		onMessageStart(event: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target)) return;
			if (event?.message?.role !== "assistant") return;
			trackCache(target);
		},

		onMessageEnd(event: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target)) return;
			if (event?.message?.role !== "assistant") return;
			const assistantText = messageText(event.message);
			if (assistantText.length === 0) return;
			runText = clip(assistantText, TEXT_LIMIT);
			const stamp = Number(event.message.timestamp);
			const validStamp = Number.isFinite(stamp) && stamp > 0;
			if (validStamp) lastMessageStamp = stamp;
			postLine(target, runText, validStamp ? stamp : 0);
		},

		onAgentStart(nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target)) return;
			ctx = target;
			runId += 1;
			runStartedAtMs = now();
			cancelSettle();
			cancelFlip();
			runText = "";
			runEndStamp = 0;
			lastMessageStamp = 0;
			runAborted = false;
			runAbortSource = "";
			goalCapturedStatus = null;
			goalCapturedRunId = -1;
			// A pending blocked/done close outlives a run that starts inside the settle delay (seen live: the runtime
			// continued right after update_goal complete and the episode then closed as a plain turn). closeNow clears it.
			syncEpisodeSession(target);
			const before = currentEpisode(ep);
			const started = startEpisode(ep, { stamp: branchStamp(target), now: now() });
			if (started.opened) {
				lastLine = null;
				lastLineText = "";
				openerKey = "";
				openerRequest = "";
			}
			startSeq += 1;
			const mine = startSeq;
			// First through the FIFO queue and answered before any line of this turn is sent: the lines read the episode key then.
			postActivity(target, {
				source: "agent-start",
				cause: started.cause,
				opened: started.opened,
				episode: before === null ? null : before.key,
			}, (response) => {
				if (mine !== startSeq) return;
				if (response?.episodeClosed === true) {
					applyServerState(ep, { episodeClosed: true, closeReason: typeof response.closeReason === "string" ? response.closeReason : null });
				}
				const reopen = response?.reopen;
				if (reopen !== null && typeof reopen === "object") {
					const adopted = adoptReopen(ep, reopen);
					if (adopted.adopted) {
						lastLine = null;
						log(`capture: reopened ${String(adopted.key)}`);
					}
				}
			});
		},

		onAgentEnd(event: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target)) return;
			const assistantText = lastAssistantText(event?.messages);
			if (assistantText.length > 0) runText = assistantText;
			const stamp = lastAssistantStamp(event?.messages);
			if (stamp > 0) runEndStamp = stamp;
			runAborted = event?.aborted === true;
			runAbortSource = typeof event?.abortSource === "string" ? event.abortSource : "";
		},

		onAgentSettled(nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target) || settleHandle !== null) return;
			armSettle(target);
		},

		/**
		 * A reload inside the settle window drops the armed classification with the old generation (seen live: the
		 * turn ended, a reload came 2 s later, and the phone kept 진행 중). On a reload start, re-arm it once from the
		 * transcript when the session ended on an assistant reply and the thread got no item after that reply. The
		 * classification goes through the episode verdict like any turn end.
		 */
		recoverTurnEnd(items: any): void {
			const target = ctx;
			if (!live(target) || settleHandle !== null || runId !== 0) return;
			if (typeof target.isIdle === "function" && target.isIdle() === false) return;
			let branch: any[] = [];
			try {
				branch = target?.sessionManager?.getBranch?.() ?? [];
			} catch (error) {
				log(`capture: branch unavailable, turn end not recovered: ${text(error)}`);
				return;
			}
			const last = [...branch].reverse().find((entry) => entry?.type === "message" || entry?.type === "custom_message");
			const message = last?.type === "message" ? last.message : null;
			if (message?.role !== "assistant" || (message.stopReason !== "stop" && message.stopReason !== "length")) return;
			const replyText = messageText(message);
			if (replyText.length === 0) return;
			const stamp = Number(message.timestamp) || Date.parse(String(last.timestamp ?? ""));
			if (!Number.isFinite(stamp) || stamp <= 0) return;
			// The reply's own progress line is posted at message_end, before the settle; only a final or a question means
			// the old generation already classified this turn end.
			if (Array.isArray(items) && items.some((item) => item?.kind !== "progress" && Date.parse(String(item?.createdAt ?? "")) >= stamp)) return;
			runText = clip(replyText, TEXT_LIMIT);
			runEndStamp = stamp;
			log("capture: re-armed the turn end a reload dropped");
			armSettle(target);
		},

		onInput(event: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target)) return;
			if (event?.source !== "interactive") return;
			const text = typeof event.text === "string" ? event.text : "";
			const kickoff = /^(?:\/skill:ulw-execute|\/ulw-execute|\$ulw-execute)\s+([a-z0-9][a-z0-9-]{0,79})(?![a-z0-9-])/.exec(text);
			if (kickoff !== null && !executesSent) {
				executesSent = true;
				ensureMeta(target, undefined, { executes: kickoff[1].toLowerCase() }, true);
			} else {
				ensureMeta(target);
			}
			syncEpisodeSession(target);
			markEpisodeOwner(ep, "terminal", now());
			postActivity(target, { source: "terminal-input", cause: "owner" });
		},

		onToolExecutionEnd(event: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target)) return;
			if (event?.toolName !== "update_goal") return;
			void applyGoalToolEvent(target, event);
		},

		onGoalStoreChanged(event: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target)) return;
			if (typeof event?.threadId === "string" && event.threadId.length > 0 && event.threadId !== sessionId(target)) return;
			void applyGoalStoreChange(target);
		},

		/**
		 * One runtime signal (wake_source_state, continuation_hold_state, terminal_monitor_state,
		 * goal_continuation_timer_state, goal_continuation_scheduled). Observed with no ctx gate and never reset:
		 * the terminal publishes its counts at its own session start, possibly before this extension has a ctx.
		 */
		onSignal(channel: string, event: any): void {
			observeSignal(ep, channel, event);
			if (flipHandle !== null && wakeNow().wake) cancelFlip();
			maybeArmFlip();
		},

		/** An owner message was sent (phone, board feedback): the next agent start is the owner's. */
		markOwner(cause: string): void {
			if (ctx !== null) syncEpisodeSession(ctx);
			markEpisodeOwner(ep, cause, now());
		},

		/**
		 * After a session start (startup, resume, reload): continue the episode the thread's newest item says is
		 * still open. It counts as waking for a grace period, then the flip check closes it if nothing woke.
		 */
		restoreEpisode(items: any): void {
			const target = ctx;
			if (!live(target)) return;
			syncEpisodeSession(target);
			const restored = restoreState(ep, Array.isArray(items) ? items : [], now());
			log(`capture: restore ${restored.restored ? String(restored.key) : "-"}`);
			if (!restored.restored) return;
			lastLine = null;
			let newestAt = -1;
			for (const item of Array.isArray(items) ? items : []) {
				if (item?.kind !== "progress" || item?.meta?.episode?.key !== restored.key) continue;
				const at = Date.parse(String(item.createdAt ?? ""));
				const id = item.id ?? item.itemId;
				if (id === undefined || !(at >= newestAt)) continue;
				newestAt = at;
				lastLine = { itemId: String(id), waiting: null };
			}
			cancelFlip();
			armFlip(Math.max(0, ep.graceUntil - now()));
		},

		onNotice(payload: any, nextCtx: any): void {
			const target = nextCtx ?? ctx;
			if (!live(target) || payload === null || typeof payload !== "object") return;
			send("/api/notices", {
				...payload,
				session: payload.session ?? sessionId(target),
				cwd: payload.cwd ?? target?.cwd ?? null,
			});
		},

		sessionMeta(nextCtx: any): Record<string, unknown> {
			return sessionMeta(nextCtx ?? ctx);
		},

		/**
		 * C8 reload rule (todo 32): after a reload the builtin reattaches a surviving question to
		 * the terminal, so its requestId has no live wait in this generation (a detached wait is no
		 * longer live either). Every open question in that state is reported terminal-only.
		 */
		reportOpenQuestionBridgeStates(items: any[]): void {
			if (!live(ctx) || !Array.isArray(items)) return;
			for (const item of items) {
				if (item?.kind !== "question" || item?.status !== "open") continue;
				const requestId = item?.raw?.request?.requestId;
				if (typeof requestId !== "string" || requestId.length === 0) continue;
				const itemId = String(item.id ?? item.itemId ?? "");
				if (itemId.length === 0) continue;
				if (!questionItems.has(requestId)) {
					questionItems.set(requestId, { itemId, pendingClose: null });
					openQuestions.add(requestId);
				}
				if (typeof deps.bridgeState === "function" && deps.bridgeState(requestId) === "live") continue;
				send(`/api/items/${itemId}/bridge`, { state: "terminal-only" });
			}
		},

		/** Standing (persistent, unpaused) monitors right now; the server attaches it to /api/here (todo 13). */
		watchCount(): number {
			return standingCount(ep);
		},

		flush(): Promise<void> {
			return drain();
		},
	};

	function questionSnapshot(question: any): Record<string, unknown> {
		const options = Array.isArray(question?.options)
			? question.options.map((option: any) => ({
				label: typeof option?.label === "string" ? option.label : String(option?.label ?? ""),
				description: typeof option?.description === "string" ? option.description : null,
			}))
			: [];
		return {
			id: String(question?.id ?? ""),
			header: typeof question?.header === "string" ? question.header : "",
			question: typeof question?.question === "string" ? question.question : "",
			options,
			multiSelect: question?.multiSelect === true,
		};
	}

	function closeReason(status: string, resolvedBy: string | null): string {
		if (status === "answered" || status === "comment-submitted") {
			return resolvedBy === BRIDGE_RESOLVED_BY ? "answered-phone" : "answered-terminal";
		}
		if (status === "timed_out") return "timed-out";
		return "cancelled";
	}

	async function applyGoalToolEvent(target: any, event: any): Promise<void> {
		const fromTool = event?.result?.details?.goal;
		const goal = fromTool !== null && typeof fromTool === "object" ? fromTool : await readGoalSafe(target);
		if (goal === null || (goal.status !== "blocked" && goal.status !== "complete")) return;
		if (ep.episode !== null) {
			setPendingClose(goal);
			return;
		}
		postGoalItem(target, goal);
	}

	async function applyGoalStoreChange(target: any): Promise<void> {
		const goal = await readGoalSafe(target);
		if (goal === null || (goal.status !== "blocked" && goal.status !== "complete")) return;
		if (capturedThisRun(String(goal.status))) return;
		// During a run this is update_goal's own write: the episode's turn end reports it. While idle it is an outside change.
		if (ep.episode !== null && !idleNow(target)) {
			setPendingClose(goal);
			return;
		}
		postGoalItem(target, goal);
	}

	function trackCache(target: any): void {
		const tracker = deps.cacheTracker;
		if (tracker === undefined || typeof tracker.onAssistantStart !== "function") return;
		let result: { warmUntil?: number, ttlSec?: number, moved?: boolean } | null | undefined;
		try {
			result = tracker.onAssistantStart(target);
		} catch (error) {
			log(`capture: cache tracker failed: ${text(error)}`);
			return;
		}
		if (result === null || result === undefined || typeof result.warmUntil !== "number") return;
		if (result.moved === false) return;
		if (result.moved === undefined && lastCacheWarmUntil !== 0 && Math.abs(result.warmUntil - lastCacheWarmUntil) <= CACHE_MOVE_MS) return;
		lastCacheWarmUntil = result.warmUntil;
		const sid = sessionIdOrNull(target);
		if (sid === null) return;
		send(`/api/threads/${sid}/cache`, {
			warmUntil: result.warmUntil,
			ttlSec: typeof result.ttlSec === "number" ? result.ttlSec : null,
		});
	}
}
