/**
 * omo-inbox extension cache tracker (plan todo 16, wire-up in todo 20).
 *
 * An assistant reply warms the provider's prompt cache for the model's TTL, so
 * `onAssistantStart(ctx)` turns "this reply just started" into `{warmUntil,
 * ttlSec, moved}` - the moment the cache goes cold and whether it moved enough
 * (> 30 s) to be worth posting to `/api/threads/<sid>/cache`. It returns null
 * when senpi knows no TTL for the model, which is also the "show nothing" case.
 *
 * The TTL lookup is injected: cache.ts never imports ttl.ts (plan todo 16), so
 * the pi-ai import stays in the one file that needs it.
 */

/** A warm-until move larger than this is worth a `/cache` post (plan C3). */
export const CACHE_MOVE_MS = 30_000;

interface CacheTrackerDeps {
	ttlSeconds?: (model: unknown) => number | undefined;
	now?: () => number;
	moveMs?: number;
}

export function createCacheTracker(deps: CacheTrackerDeps = {}) {
	const ttlSeconds = deps.ttlSeconds;
	const now = deps.now ?? (() => Date.now());
	const moveMs = Number.isFinite(deps.moveMs) ? (deps.moveMs as number) : CACHE_MOVE_MS;
	let last: number | undefined;

	return {
		onAssistantStart(ctx?: { model?: unknown }) {
			if (typeof ttlSeconds !== "function") return null;
			let ttl: number | undefined;
			try {
				ttl = ttlSeconds(ctx?.model);
			} catch {
				return null;
			}
			if (!Number.isFinite(ttl) || ttl <= 0) return null;
			const ttlSec = ttl;
			const warmUntil = now() + ttlSec * 1000;
			const moved = last === undefined || Math.abs(warmUntil - last) > moveMs;
			last = warmUntil;
			return { warmUntil, ttlSec, moved };
		},
	};
}
