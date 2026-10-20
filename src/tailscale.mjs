import { isDeepStrictEqual } from "node:util";
import { TAILNET_PORT } from "./paths.mjs";

const NULLS = { publicBase: null, pcTailnetIps: [], owner: null, dns: null };

/** Parse `tailscale status --json` into the config fields; missing/not Running -> nulls. */
export function status(runner) {
	let result;
	try {
		result = runner(["status", "--json"]);
	} catch {
		return { ...NULLS };
	}
	if (!result || result.status !== 0) return { ...NULLS };
	let data;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return { ...NULLS };
	}
	if (!data || data.BackendState !== "Running") return { ...NULLS };
	const self = data.Self ?? {};
	const dns = String(self.DNSName ?? "").replace(/\.$/, "");
	const login = data.User?.[String(self.UserID)]?.LoginName;
	return {
		publicBase: dns ? `https://${dns}:${TAILNET_PORT}` : null,
		pcTailnetIps: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [],
		owner: typeof login === "string" ? login : null,
		dns: dns || null,
	};
}

/** `tailscale serve --bg --https=4388 http://127.0.0.1:4387`. */
export function serveOn(runner) {
	return runner(["serve", "--bg", `--https=${TAILNET_PORT}`, "http://127.0.0.1:4387"]);
}

/** `tailscale serve --https=4388 off`. */
export function serveOff(runner) {
	return runner(["serve", `--https=${TAILNET_PORT}`, "off"]);
}

export function parseServe(result) {
	if (!result || result.status !== 0) return {};
	try {
		const data = JSON.parse(result.stdout);
		return data && typeof data === "object" ? data : {};
	} catch {
		return {};
	}
}

export const SERVE_PROXY = "http://127.0.0.1:4387";

/**
 * The 443 guard: serving 4388 must not disturb the existing 443 entry, the AllowFunnel map, or TCP 443,
 * and (unless `proxy` is null, as in uninstall) the 4388 handler must point at the local server.
 */
export function guard(baseline, after, dns, { proxy = SERVE_PROXY } = {}) {
	const before = baseline ?? {};
	const now = after ?? {};
	if (!isDeepStrictEqual(now.Web?.[`${dns}:443`], before.Web?.[`${dns}:443`])) return false;
	if (!isDeepStrictEqual(now.AllowFunnel ?? {}, before.AllowFunnel ?? {})) return false;
	if (!isDeepStrictEqual(now.TCP?.["443"], before.TCP?.["443"])) return false;
	if (proxy !== null) {
		const actual = now.Web?.[`${dns}:${TAILNET_PORT}`]?.Handlers?.["/"]?.Proxy;
		if (actual !== proxy) return false;
	}
	return true;
}
