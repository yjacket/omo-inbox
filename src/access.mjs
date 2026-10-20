const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

const header = (headers, name) => (headers ? headers[name] : undefined);

export function classify({ remoteAddress, headers, pcIps, owner }) {
	if (!LOOPBACK.has(remoteAddress)) return "reject";
	if (header(headers, "tailscale-funnel-request") !== undefined) return "reject";

	const forwardedFor = header(headers, "x-forwarded-for");
	if (forwardedFor === undefined) {
		const host = header(headers, "host");
		return typeof host === "string" && LOCAL_HOST.test(host) ? "local" : "reject";
	}

	const first = String(forwardedFor).split(",")[0].trim();
	if (Array.isArray(pcIps) && pcIps.includes(first)) return "pc";

	const login = header(headers, "tailscale-user-login");
	if (login === undefined) return "reject";
	if (owner != null && login !== owner) return "reject";
	return "tailnet";
}

export const ALLOW = {
	read: ["local", "pc", "tailnet"],
	feedback: ["local", "pc", "tailnet"],
	session: ["local"],
	open: ["local", "pc"],
	reopen: ["local", "pc", "tailnet"],
};

export function postGuard(headers) {
	const contentType = header(headers, "content-type");
	return (
		typeof contentType === "string" &&
		contentType.startsWith("application/json") &&
		header(headers, "x-inbox") === "1"
	);
}
