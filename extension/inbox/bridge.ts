/**
 * Answer bridge for the omo-inbox senpi extension (plan todo 13, contract C8).
 *
 * Wraps `ctx.ui.question` (and `ctx.ui.select` for permission dialogs) so a phone answer can race the
 * terminal overlay. The only runtime surface used is `ctx.ui` and `ctx.mode`; nothing here imports
 * from src/ (extension files stay standalone).
 *
 * - question: terminal first -> its response is returned verbatim; phone first -> the inner signal
 *   aborts with reason "omo-inbox" (the overlay closes and resolves cancelled, which ask-user ignores)
 *   and the phone response is returned. The bridge owns no timers.
 * - permission: a `select` titled "Permission required: ..." while a run is in flight registers a
 *   dialog the phone can answer; "Deny with feedback" stages text for the immediately following
 *   `ui.input("Feedback", ...)`.
 */

const QUESTION_BRIDGE = Symbol.for("omo-inbox.question-bridge");
const SELECT_BRIDGE = Symbol.for("omo-inbox.select-bridge");
const INPUT_BRIDGE = Symbol.for("omo-inbox.input-bridge");
const GENERATION = Symbol.for("omo-inbox.bridge-generation");

const PERMISSION_PREFIX = "Permission required:";
const FEEDBACK_OPTION = "deny with feedback";
const ABORT_REASON = "omo-inbox";
export const RESOLVED_BY = "omo_inbox";
const SETTLED_CAP = 200;

const CHOICE_ALIASES: Record<string, string> = {
	once: "allow once",
	"allow-once": "allow once",
	allow: "allow once",
	always: "allow always",
	"allow-always": "allow always",
	deny: "deny",
	reject: "deny",
	feedback: FEEDBACK_OPTION,
	"deny-with-feedback": FEEDBACK_OPTION,
};

export type InstallResult = "installed" | "already" | "unavailable";
export type ResolveResult = "resolved" | "no-wait" | "already-settled";
export type BridgeState = "live" | "detached" | "terminal-only" | "none";

/** Bridge generations are process-global so a reloaded extension module still orders after the old one. */
function nextGeneration(): number {
	const g = globalThis as any;
	g[GENERATION] = (g[GENERATION] ?? 0) + 1;
	return g[GENERATION];
}

/**
 * AbortSignal.any equivalent that works with any signal-like object and gives its listeners back on
 * dispose(), so nothing accumulates on a long-lived outer signal.
 */
function linkSignals(outer: any, inner: any) {
	const controller = new AbortController();
	const release: Array<() => void> = [];
	for (const source of [outer, inner]) {
		if (!source) continue;
		if (source.aborted) {
			controller.abort(source.reason);
			continue;
		}
		const onAbort = () => controller.abort(source.reason);
		source.addEventListener("abort", onAbort, { once: true });
		release.push(() => source.removeEventListener("abort", onAbort));
	}
	return {
		signal: controller.signal,
		dispose() {
			for (const fn of release.splice(0)) fn();
		},
	};
}

/** Build the control-endpoint style response (runtime session-control-commands.js:121-147) for a phone answer. */
function buildPhoneResponse(request: any, payload: any) {
	const answers: Record<string, any> = {};
	const unanswered: string[] = [];
	for (const question of request?.questions ?? []) {
		const given = payload?.answers?.[question.id];
		const selected = Array.isArray(given?.selected) ? given.selected.filter((s: unknown) => typeof s === "string") : [];
		const text = typeof given?.text === "string" ? given.text : undefined;
		if (selected.length > 0 || (text !== undefined && text.trim() !== "")) {
			answers[question.id] = { selected, ...(text !== undefined ? { text } : {}) };
		} else {
			unanswered.push(question.id);
		}
	}
	const comment = typeof payload?.comment === "string" && payload.comment.trim() !== "" ? payload.comment : undefined;
	const answered = Object.keys(answers).length > 0;
	if (comment === undefined && !answered) throw new Error("question_incomplete");
	return {
		status: comment !== undefined ? "comment-submitted" : "answered",
		resolvedBy: RESOLVED_BY,
		answers,
		...(comment !== undefined ? { comment } : {}),
		unanswered,
	};
}

function matchOption(options: string[], choice: unknown): string | undefined {
	const want = String(choice ?? "").trim().toLowerCase();
	const target = CHOICE_ALIASES[want] ?? want;
	return options.find((option) => String(option).toLowerCase() === target);
}

export function createBridge(deps: { log?: (msg: string) => void; now?: () => number; env?: Record<string, string | undefined> } = {}) {
	const log = deps.log ?? (() => {});
	const now = deps.now ?? Date.now;
	const gen = nextGeneration();

	let installState: InstallResult | null = null;
	let installedUi: any = null;
	let runInFlight = false;
	let seq = 0;
	let staged: { text: string } | null = null;

	const waits = new Map<string, any>();
	const settled = new Map<string, { status: string; response: any }>();
	const dialogs = new Map<string, any>();
	const dialogListeners = new Set<(d: any) => void>();
	const dialogClosedListeners = new Set<(d: any) => void>();

	function emit(set: Set<(d: any) => void>, arg: any) {
		for (const cb of [...set]) {
			try {
				cb(arg);
			} catch (error) {
				log(`bridge listener failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	function remember(requestId: string, status: string, response: any) {
		settled.set(requestId, { status, response });
		if (settled.size > SETTLED_CAP) settled.delete(settled.keys().next().value as string);
	}

	/** Wrap ui[prop] once per generation; an older generation's wrapper is unwrapped, never chained. */
	function installWrapper(ui: any, prop: string, symbol: symbol, make: (original: any) => any): InstallResult {
		const current = ui?.[prop];
		if (typeof current !== "function") return "unavailable";
		let original = current;
		const meta = current[symbol];
		if (meta) {
			if (meta.gen >= gen) return "already";
			original = meta.original;
		}
		const wrapper = make(original);
		wrapper[symbol] = { original, gen };
		try {
			ui[prop] = wrapper;
		} catch {
			return "unavailable";
		}
		return ui[prop] === wrapper ? "installed" : "unavailable";
	}

	/** Restore the original only when the current value is this generation's wrapper. */
	function uninstallWrapper(ui: any, prop: string, symbol: symbol) {
		const meta = ui?.[prop]?.[symbol];
		if (!meta || meta.gen !== gen) return;
		try {
			ui[prop] = meta.original;
		} catch (error) {
			log(`bridge uninstall ${prop} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function clearStaged() {
		staged = null;
		if (installedUi) uninstallWrapper(installedUi, "input", INPUT_BRIDGE);
	}

	function stageFeedback(text: string) {
		staged = { text };
		if (!installedUi) return;
		installWrapper(installedUi, "input", INPUT_BRIDGE, (original) =>
			async function (this: any, title: unknown, placeholder: unknown, opts: unknown) {
				if (staged !== null && title === "Feedback") {
					const value = staged.text;
					clearStaged();
					return value;
				}
				return original.call(this, title, placeholder, opts);
			},
		);
	}

	const makeQuestion = (original: any) =>
		async function (this: any, request: any, opts: any) {
			const requestId = request?.requestId;
			if (typeof requestId !== "string") return original.call(this, request, opts);

			const inner = new AbortController();
			const outer = opts?.signal;
			const link = linkSignals(outer, inner.signal);
			const entry: any = { request, state: "live", resolve: null, phoneAnswered: false };
			const phone = new Promise<any>((resolve) => {
				entry.resolve = resolve;
			});
			waits.set(requestId, entry);

			// An outer abort with reason "reload" detaches the wait; the item stays open until reattach.
			link.signal.addEventListener(
				"abort",
				() => {
					if (outer?.aborted && outer.reason === "reload" && entry.state === "live") entry.state = "detached";
				},
				{ once: true },
			);

			const forget = () => {
				if (waits.get(requestId) === entry) waits.delete(requestId);
			};
			let pending: Promise<any>;
			try {
				pending = Promise.resolve(original.call(this, request, { ...opts, signal: link.signal, onProgress: opts?.onProgress }));
			} catch (error) {
				link.dispose();
				forget();
				throw error;
			}
			const terminal = pending.then(
				(response) => {
					// Record synchronously so a phone answer arriving in the same tick sees the terminal result.
					if (!entry.phoneAnswered && entry.state !== "detached") {
						forget();
						remember(requestId, response?.status, response);
					}
					return { phone: false, response };
				},
				(error) => {
					forget();
					return { phone: false, error, failed: true };
				},
			);
			const remote = phone.then((response) => ({ phone: true, response }));

			const winner: any = await Promise.race([terminal, remote]);
			if (winner.phone) {
				inner.abort(ABORT_REASON);
				link.dispose();
				return winner.response;
			}
			link.dispose();
			if (winner.failed) throw winner.error;
			return winner.response;
		};

	const makeSelect = (original: any) =>
		async function (this: any, title: unknown, options: unknown, opts: any) {
			if (!runInFlight || typeof title !== "string" || !title.startsWith(PERMISSION_PREFIX) || !Array.isArray(options)) {
				return original.call(this, title, options, opts);
			}
			const id = `perm-${now().toString(36)}-${++seq}`;
			const inner = new AbortController();
			const outer = opts?.signal;
			const link = linkSignals(outer, inner.signal);
			const dialog: any = { id, title, options: [...options], answered: false, resolve: null };
			const phone = new Promise<any>((resolve) => {
				dialog.resolve = resolve;
			});
			dialogs.set(id, dialog);
			emit(dialogListeners, { id, title, options: [...options] });

			let pending: Promise<any>;
			try {
				pending = Promise.resolve(original.call(this, title, options, { ...opts, signal: link.signal }));
			} catch (error) {
				link.dispose();
				dialogs.delete(id);
				throw error;
			}
			const terminal = pending.then(
				(value) => ({ phone: false, value }),
				(error) => ({ phone: false, error, failed: true }),
			);
			const remote = phone.then((value) => ({ phone: true, value }));

			const winner: any = await Promise.race([terminal, remote]);
			dialogs.delete(id);
			if (winner.phone) {
				inner.abort(ABORT_REASON);
				link.dispose();
				emit(dialogClosedListeners, { id, by: "phone", choice: winner.value });
				return winner.value;
			}
			link.dispose();
			clearStaged();
			emit(dialogClosedListeners, { id, by: outer?.aborted ? "aborted" : "terminal", choice: winner.value });
			if (winner.failed) throw winner.error;
			return winner.value;
		};

	return {
		resolvedByMarker: RESOLVED_BY,

		install(ctx: any): InstallResult {
			const ui = ctx?.ui;
			// INBOX_BRIDGE=off is a debug switch: nothing is wrapped, so phone answers take the late path.
			if (deps.env?.INBOX_BRIDGE === "off") {
				installState = "unavailable";
				return "unavailable";
			}
			if (ctx?.mode !== "tui" || !ui || typeof ui.question !== "function") {
				installState = "unavailable";
				return "unavailable";
			}
			const result = installWrapper(ui, "question", QUESTION_BRIDGE, makeQuestion);
			installState = result;
			if (result === "unavailable") return result;
			installedUi = ui;
			installWrapper(ui, "select", SELECT_BRIDGE, makeSelect);
			return result;
		},

		uninstall(ctx: any) {
			const ui = ctx?.ui ?? installedUi;
			if (ui) {
				uninstallWrapper(ui, "question", QUESTION_BRIDGE);
				uninstallWrapper(ui, "select", SELECT_BRIDGE);
			}
			clearStaged();
			for (const [requestId, entry] of waits) if (entry.state === "detached") waits.delete(requestId);
			installState = null;
			installedUi = null;
		},

		resolveQuestion(requestId: string, phonePayload: any): ResolveResult {
			const entry = waits.get(requestId);
			if (entry && entry.state === "live") {
				const response = buildPhoneResponse(entry.request, phonePayload);
				entry.phoneAnswered = true;
				waits.delete(requestId);
				remember(requestId, response.status, response);
				entry.resolve(response);
				return "resolved";
			}
			const known = settled.get(requestId);
			if (known && (known.status === "answered" || known.status === "comment-submitted")) return "already-settled";
			return "no-wait";
		},

		/** Called from the `ask-user:closed` listener; keeps the first recorded outcome. */
		noteClosed(requestId: string, status: string, response?: any) {
			waits.delete(requestId);
			if (!settled.has(requestId)) remember(requestId, status, response);
		},

		bridgeState(requestId: string): BridgeState {
			const entry = waits.get(requestId);
			if (entry) return entry.state;
			if (settled.has(requestId)) return "none";
			return installState === null || installState === "unavailable" ? "none" : "terminal-only";
		},

		hasQuestion(requestId: string): boolean {
			return waits.has(requestId) || settled.has(requestId);
		},

		resolvePermission(dialogId: string, choice: string, feedbackText?: string): boolean {
			const dialog = dialogs.get(dialogId);
			if (!dialog || dialog.answered) return false;
			const option = matchOption(dialog.options, choice);
			if (option === undefined) return false;
			dialog.answered = true;
			dialogs.delete(dialogId);
			if (option.toLowerCase() === FEEDBACK_OPTION) stageFeedback(typeof feedbackText === "string" ? feedbackText : "");
			dialog.resolve(option);
			return true;
		},

		/** Fires when a permission dialog opens: `{id, title, options}`. Returns an unsubscribe function. */
		onDialog(cb: (dialog: { id: string; title: string; options: string[] }) => void) {
			dialogListeners.add(cb);
			return () => dialogListeners.delete(cb);
		},

		/** Fires when a permission dialog closes: `{id, by: "phone"|"terminal"|"aborted", choice}`. */
		onDialogClosed(cb: (closed: { id: string; by: string; choice: unknown }) => void) {
			dialogClosedListeners.add(cb);
			return () => dialogClosedListeners.delete(cb);
		},

		setRunInFlight(value: boolean) {
			runInFlight = Boolean(value);
		},
	};
}
