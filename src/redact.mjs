// Redaction for session text that leaves the session (push bodies, summary
// prompts). Every credential-shaped match collapses to a single ellipsis, so
// the result is idempotent: redact(redact(text)) === redact(text).

const PLACEHOLDER = "…";

// A path-ish prefix chain ("~", "/home/u", "C:\Users\me") that may precede a
// credential file name.
const PATH_PREFIX = "[\\\\/]?(?:[A-Za-z0-9_.~$:-]+[\\\\/])*";

const RULES = [
	/\bsk-[A-Za-z0-9_-]{16,}/g,
	/\bghp_[A-Za-z0-9]{16,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{16,}/g,
	/\bxox[abp]-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)+/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
	/\b(?:password|passwd|pwd)\s*[=:]\s*\S+/gi,
	new RegExp(`${PATH_PREFIX}\\.(?:ssh|ssh-mcp)(?![A-Za-z0-9_.-])(?:[\\\\/][A-Za-z0-9_.~$-]+)*`, "g"),
	new RegExp(`${PATH_PREFIX}\\.mcp-secrets\\.env\\b`, "g"),
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
	/[A-Za-z0-9+/=_-]{32,}/g,
];

export function redact(text) {
	if (typeof text !== "string" || text === "") return text;
	let out = text;
	for (const rule of RULES) out = out.replace(rule, PLACEHOLDER);
	return out;
}
