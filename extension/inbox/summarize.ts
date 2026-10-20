/**
 * omo-inbox extension summarizer (plan todo 16).
 *
 * The server owns the summary prompt and validation (src/summary.mjs); the
 * extension only runs the model. `createSummarizer` returns a `run(request,
 * signal)` that picks the first configured model of a preference list, calls it
 * through the session's model registry and returns `{text, model}` - or null
 * whenever nothing usable came back (no registry, no authenticated model, an
 * error, an empty answer or the timeout).
 *
 * Never fall back to the session model: a phone summary is background work and
 * must not compete with the user's own turn for the same provider slot.
 *
 * Hedging (todo 34): a subscription provider's one-shot lane can stall for tens of seconds while
 * another model answers in about two. When the first model has not answered within `hedgeMs`, or it
 * failed, the next usable model of the list starts; the first usable answer wins and the rest abort.
 * `timeoutMs` still bounds the whole request.
 *
 * Queue (todo 11): `createSummaryQueue` lets a needs-you summary start at once, while progress
 * line requests run one at a time and only when no summary is in flight. At most the newest 3
 * line requests wait; a line dropped by that bound resolves null, so its heuristic headline stays.
 *
 * senpi evaluates extensions through jiti/vm, so this module stays dependency
 * free: it imports nothing but its own types and takes the registry as a getter.
 */

export const DEFAULT_MODELS = ["anthropic-subscription/claude-sonnet-5", "chatgpt-subscription/gpt-6-luna-fast", "anthropic-subscription/claude-haiku-4-5"];

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_HEDGE_MS = 30000;
const MAX_PENDING_LINES = 3;

/** Just enough of the pi-ai shapes this module touches (the host supplies the real ones). */
interface SummaryModel {
	provider?: unknown;
	id?: unknown;
	modelId?: unknown;
}

interface SummaryPart {
	type?: string;
	text?: string;
}

interface SummaryMessage {
	stopReason?: string;
	errorMessage?: string;
	content?: SummaryPart[];
}

interface SummaryContext {
	systemPrompt: string;
	messages: { role: string; content: SummaryPart[]; timestamp: number }[];
}

interface SummaryOptions {
	maxTokens?: number;
	signal: AbortSignal;
}

interface SummaryRegistry {
	find(provider: string, modelId: string): SummaryModel | undefined;
	hasConfiguredAuth?(model: SummaryModel): boolean;
	complete?(model: SummaryModel, context: SummaryContext, options: SummaryOptions): Promise<SummaryMessage> | SummaryMessage;
	streamSimple?(model: SummaryModel, context: SummaryContext, options: SummaryOptions): { result(): Promise<SummaryMessage> };
}

interface SummarizerDeps {
	getRegistry?: () => unknown;
	models?: string[];
	timeoutMs?: number;
	hedgeMs?: number;
	log?: (text: string) => void;
	timer?: { setTimeout(handler: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
	now?: () => number;
}

export interface SummaryQueueRequest {
	purpose?: string;
	system?: string;
	user?: string;
	maxTokens?: number;
}

/**
 * Serializes progress-line summary calls behind needs-you summaries.
 *
 * Summary requests (`purpose` "summary" or missing) start immediately, as before. Line requests
 * (`purpose` "line") wait: only one line runs at a time, and none starts while a summary is in
 * flight. Only the newest three line requests stay pending; older ones resolve null.
 */
export function createSummaryQueue<T>(run: (request: SummaryQueueRequest, signal?: AbortSignal) => Promise<T> | T) {
	const pending: { request: SummaryQueueRequest; signal?: AbortSignal; resolve: (value: T | null) => void; reject: (error: unknown) => void }[] = [];
	let runningLine = false;
	let runningSummaries = 0;

	const pump = () => {
		if (runningLine || runningSummaries > 0) return;
		const entry = pending.shift();
		if (!entry) return;
		runningLine = true;
		let result: Promise<T> | T;
		try {
			result = run(entry.request, entry.signal);
		} catch (error) {
			runningLine = false;
			entry.reject(error);
			pump();
			return;
		}
		Promise.resolve(result).then(
			(value) => {
				runningLine = false;
				entry.resolve(value);
				pump();
			},
			(error) => {
				runningLine = false;
				entry.reject(error);
				pump();
			},
		);
	};

	function enqueue(request: SummaryQueueRequest = {}, signal?: AbortSignal): Promise<T | null> {
		if (request.purpose !== "line") {
			runningSummaries += 1;
			let result: Promise<T> | T;
			try {
				result = run(request, signal);
			} catch (error) {
				runningSummaries -= 1;
				pump();
				return Promise.reject(error);
			}
			return Promise.resolve(result).then(
				(value) => {
					runningSummaries -= 1;
					pump();
					return value;
				},
				(error) => {
					runningSummaries -= 1;
					pump();
					throw error;
				},
			);
		}
		return new Promise<T | null>((resolve, reject) => {
			pending.push({ request, signal, resolve, reject });
			while (pending.length > MAX_PENDING_LINES) pending.shift()?.resolve(null);
			pump();
		});
	}

	return { run: enqueue };
}

function messageText(message: SummaryMessage) {
	const content = Array.isArray(message?.content) ? message.content : [];
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function modelRef(model: SummaryModel, fallback: string) {
	const provider = model?.provider;
	const id = model?.id ?? model?.modelId;
	return typeof provider === "string" && typeof id === "string" ? `${provider}/${id}` : fallback;
}

/** Every preference whose model the registry resolves and has auth for, in preference order. */
function pickModels(registry: SummaryRegistry, models: string[]) {
	const picked: { model: SummaryModel; ref: string }[] = [];
	for (const ref of models) {
		const text = String(ref ?? "");
		const slash = text.indexOf("/");
		if (slash <= 0 || slash === text.length - 1) continue;
		const model = registry.find(text.slice(0, slash), text.slice(slash + 1));
		if (!model) continue;
		if (typeof registry.hasConfiguredAuth === "function" && !registry.hasConfiguredAuth(model)) continue;
		picked.push({ model, ref: text });
	}
	return picked;
}

export function createSummarizer(deps: SummarizerDeps = {}) {
	const getRegistry = deps.getRegistry ?? (() => undefined);
	const models = deps.models ?? DEFAULT_MODELS;
	const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
	const hedgeMs = Number.isFinite(deps.hedgeMs) ? deps.hedgeMs : DEFAULT_HEDGE_MS;
	const log = typeof deps.log === "function" ? deps.log : () => {};
	const timer = deps.timer ?? { setTimeout, clearTimeout };
	const now = deps.now ?? (() => Date.now());

	async function run(request: { system?: string; user?: string; maxTokens?: number } = {}, signal?: AbortSignal) {
		const user = String(request.user ?? "");
		const context: SummaryContext = {
			systemPrompt: String(request.system ?? ""),
			messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: now() }],
		};
		let registry: SummaryRegistry | undefined;
		try {
			registry = (await getRegistry()) as SummaryRegistry | undefined;
		} catch (error) {
			log(`summarize: registry unavailable: ${String(error?.message ?? error)}`);
			return null;
		}
		if (!registry) {
			log("summarize: no model registry");
			return null;
		}
		let candidates: { model: SummaryModel; ref: string }[];
		try {
			candidates = pickModels(registry, models);
		} catch (error) {
			log(`summarize: model lookup failed: ${String(error?.message ?? error)}`);
			return null;
		}
		if (candidates.length === 0) {
			log(`summarize: no usable model (${models.join(", ")})`);
			return null;
		}
		const controller = new AbortController();
		const outer = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const options = { maxTokens: request.maxTokens, signal: outer };
		const startedAt = now();
		let settled = false;

		/** One model call: the answer, or null after logging why. Never rejects; stays silent once the request settled. */
		const attempt = async (picked: { model: SummaryModel; ref: string }): Promise<{ text: string; model: string } | null> => {
			const say = (line: string) => {
				if (!settled) log(line);
			};
			let message: SummaryMessage;
			try {
				// `complete` is the registry's one-shot lane; `streamSimple(...).result()` is the fallback.
				const call = typeof registry.complete === "function"
					? Promise.resolve(registry.complete(picked.model, context, options))
					: typeof registry.streamSimple === "function"
						? Promise.resolve(registry.streamSimple(picked.model, context, options).result())
						: undefined;
				if (!call) {
					say(`summarize: ${picked.ref}: no completion lane on the registry`);
					return null;
				}
				message = await call;
			} catch (error) {
				say(`summarize: ${picked.ref}: ${String(error?.message ?? error)}`);
				return null;
			}
			if (settled) return null;
			if (message?.stopReason === "error") {
				say(`summarize: ${picked.ref}: ${String(message.errorMessage ?? "model error")}`);
				return null;
			}
			const text = messageText(message);
			if (!text.trim()) {
				say(`summarize: ${picked.ref}: empty response`);
				return null;
			}
			log(`summarize: ${picked.ref}: answered in ${now() - startedAt} ms`);
			return { text, model: modelRef(picked.model, picked.ref) };
		};

		return new Promise<{ text: string; model: string } | null>((resolve) => {
			let next = 0;
			let pending = 0;
			let hedgeTimer: unknown;
			let timeoutTimer: unknown;
			const unref = (id: unknown) => (id as { unref?(): void } | undefined)?.unref?.();
			const finish = (value: { text: string; model: string } | null) => {
				if (settled) return;
				settled = true;
				if (hedgeTimer !== undefined) timer.clearTimeout(hedgeTimer);
				if (timeoutTimer !== undefined) timer.clearTimeout(timeoutTimer);
				controller.abort("omo-inbox summary settled");
				resolve(value);
			};
			/** Starts the next candidate; false when none is left. A hedge timer re-arms while candidates remain. */
			const launch = (): boolean => {
				if (settled || next >= candidates.length) return false;
				if (hedgeTimer !== undefined) timer.clearTimeout(hedgeTimer);
				hedgeTimer = undefined;
				const picked = candidates[next++];
				pending += 1;
				void attempt(picked).then((result) => {
					pending -= 1;
					if (settled) return;
					if (result) finish(result);
					else if (!launch() && pending === 0) finish(null);
				});
				if (!settled && next < candidates.length) {
					hedgeTimer = timer.setTimeout(() => {
						hedgeTimer = undefined;
						launch();
					}, hedgeMs);
					unref(hedgeTimer);
				}
				return true;
			};
			launch();
			// The provider may reject after the timeout abandoned the call; attempt() absorbs that.
			timeoutTimer = timer.setTimeout(() => {
				log(`summarize: ${candidates.slice(0, next).map((entry) => entry.ref).join(", ")}: timed out after ${timeoutMs} ms`);
				finish(null);
			}, timeoutMs);
			unref(timeoutTimer);
		});
	}

	return { run };
}
