/**
 * omo-inbox extension prompt-cache TTL lookup (plan todo 16).
 *
 * The only pi-ai import in the extension: senpi's pi-ai knows how long each
 * model's prompt cache lives, so `ttlSeconds(model)` asks it and answers
 * `undefined` for anything it does not know (no model, no helper, a thrown
 * error, a non-positive number).
 *
 * cache.ts and summarize.ts never import this file (plan todo 16); the caller
 * passes `ttlSeconds` into `createCacheTracker` (todo 20). Tests never import it.
 */
import * as piAi from "@earendil-works/pi-ai";

/** Prompt cache lifetime senpi knows for `model`, in seconds, or undefined. */
export function ttlSeconds(model: unknown): number | undefined {
	const resolve = (piAi as any).resolvePromptCacheTtlSeconds;
	if (!model || typeof resolve !== "function") return undefined;
	try {
		const seconds = resolve(model);
		return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
	} catch {
		return undefined;
	}
}
