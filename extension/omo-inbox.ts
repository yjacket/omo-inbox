/**
 * omo-inbox senpi extension entry (plan todo 20).
 *
 * The implementation lives in ./inbox/core.ts (shared helpers: ./inbox/util.ts).
 * ttl.ts is the only file that imports pi-ai, so it is wired in here.
 */
import { createInbox } from "./inbox/core.ts";
import { ttlSeconds } from "./inbox/ttl.ts";

export default function omoInboxExtension(pi, deps = {}) {
	return createInbox(pi, { ttlSeconds, ...deps });
}
