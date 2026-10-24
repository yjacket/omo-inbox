/**
 * omo-inbox provider action registry (plan todo 7, GAP-13).
 *
 * Other extensions offer buttons for the newest turn by emitting `inbox:actions`
 * on `pi.events`. This module validates that payload with the same rules as
 * src/next.mjs, keeps the latest actions per producer, and posts
 * `POST /api/threads/<sid>/actions` with `{ producer, actions }`. An empty
 * actions array clears the producer's offer. Nothing here imports from src/.
 */

const PRODUCER_RE = /^[a-z0-9-]{1,40}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,40}$/;
const MAX_ACTIONS = 4;
const LABEL_MAX = 12;
const PROMPT_MAX = 300;

export type ProviderAction = { key: string, label: string, prompt: string } | { key: string, label: string, run: true };

export type ValidatedActions = { producer: string, actions: ProviderAction[] };

export type ValidateResult =
	| { ok: true, value: ValidatedActions }
	| { ok: false, errors: string[] };

export type ActionsDeps = {
	post: (path: string, body: unknown) => Promise<any> | any,
	sessionId: () => string | null,
	log: (text: string) => void,
};

/**
 * The provider payload rules shared with todo 1: v 1, a lowercase producer,
 * at most four actions, and each action either a prompt (1..300 after trim)
 * or run, never both.
 */
export function validateActions(data: unknown): ValidateResult {
	const errors: string[] = [];
	if (data === null || typeof data !== "object") return { ok: false, errors: ["data must be an object"] };
	const payload = data as Record<string, unknown>;
	if (payload.v !== 1) errors.push("v must be 1");
	const producer = payload.producer;
	if (typeof producer !== "string" || !PRODUCER_RE.test(producer)) errors.push("producer must match ^[a-z0-9-]{1,40}$");
	if (!Array.isArray(payload.actions)) {
		errors.push("actions must be an array");
		return { ok: false, errors };
	}
	if (payload.actions.length > MAX_ACTIONS) errors.push(`actions must have at most ${MAX_ACTIONS} entries`);
	const actions: ProviderAction[] = [];
	for (let i = 0; i < payload.actions.length; i += 1) {
		const action = payload.actions[i] as Record<string, unknown> | null | undefined;
		if (action === null || typeof action !== "object") {
			errors.push(`action ${i + 1}: must be an object`);
			continue;
		}
		const key = action.key;
		const label = typeof action.label === "string" ? action.label.trim() : "";
		const prompt = typeof action.prompt === "string" ? action.prompt.trim() : "";
		const run = action.run === true;
		if (typeof key !== "string" || !KEY_RE.test(key)) errors.push(`action ${i + 1}: key must match ^[A-Za-z0-9._:-]{1,40}$`);
		if (!label || label.length > LABEL_MAX) errors.push(`action ${i + 1}: label must be 1..${LABEL_MAX} chars`);
		if (run && prompt) errors.push(`action ${i + 1}: use either prompt or run, not both`);
		else if (!run && (!prompt || prompt.length > PROMPT_MAX)) errors.push(`action ${i + 1}: prompt must be 1..${PROMPT_MAX} chars`);
		if (typeof key === "string" && KEY_RE.test(key) && label && label.length <= LABEL_MAX && (run !== Boolean(prompt)) && (run || prompt.length <= PROMPT_MAX)) {
			actions.push(run ? { key, label, run: true } : { key, label, prompt });
		}
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { producer: producer as string, actions } };
}

/**
 * `onActions` validates one event: a bad payload is logged once and ignored,
 * a good one replaces that producer's stored actions and is posted (when the
 * session has an id). `resend` posts every producer again, so a reloaded
 * server sees the offers the extension still stands behind.
 */
export function createActions(deps: ActionsDeps) {
	const stored = new Map<string, ProviderAction[]>();
	const log = deps.log ?? (() => {});
	const sessionId = deps.sessionId ?? (() => null);

	function pathFor(sid: string): string {
		return `/api/threads/${sid}/actions`;
	}

	async function postActions(producer: string, actions: ProviderAction[]): Promise<void> {
		const sid = sessionId();
		if (sid === null) return;
		try {
			await deps.post(pathFor(sid), { producer, actions });
		} catch (error) {
			log(`actions: post failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		onActions(data: unknown): Promise<void> {
			const result = validateActions(data);
			if (!result.ok) {
				const rawProducer = (data as Record<string, unknown> | null | undefined)?.producer;
				const producer = typeof rawProducer === "string" && rawProducer.length > 0 ? rawProducer : "?";
				log(`actions: invalid ${producer}: ${result.errors[0]}`);
				return Promise.resolve();
			}
			stored.set(result.value.producer, result.value.actions);
			return postActions(result.value.producer, result.value.actions);
		},

		async resend(): Promise<void> {
			for (const [producer, actions] of stored) {
				await postActions(producer, actions);
			}
		},
	};
}
