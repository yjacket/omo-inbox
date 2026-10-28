import { spawn } from "node:child_process";
import fs from "node:fs";
import { findExecutable } from "./reopen.mjs";

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_PAGES = 10;
const GH_TIMEOUT_MS = 10000;

export class GitHubError extends Error {
	constructor(kind, { status = null, retryAt = null, codes = [], message } = {}) {
		super(message ?? "GitHub request failed (" + kind + ")");
		this.name = "GitHubError";
		this.kind = kind;
		this.status = status;
		this.retryAt = retryAt;
		this.codes = codes;
	}
}

function headerValue(headers, name) {
	if (!headers) return null;
	if (typeof headers.get === "function") return headers.get(name);
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	if (key === undefined) return null;
	const value = headers[key];
	return value === undefined || value === null ? null : String(value);
}

function rateRetryAt(headers) {
	const retryAfter = headerValue(headers, "retry-after");
	const seconds = Number(retryAfter);
	if (retryAfter !== null && retryAfter !== "" && Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
	const reset = Number(headerValue(headers, "x-ratelimit-reset"));
	if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000);
	return new Date(Date.now() + 60000);
}

export function classify(status, headers, json) {
	if (status < 400) return null;
	if (status === 401) return new GitHubError("auth", { status });
	if (status === 403) {
		const message = typeof json?.message === "string" ? json.message : "";
		const remaining = headerValue(headers, "x-ratelimit-remaining");
		const retryAfter = headerValue(headers, "retry-after");
		if ((remaining !== null && Number(remaining) === 0) || retryAfter !== null || /rate limit/i.test(message)) {
			return new GitHubError("rate_limit", { status, retryAt: rateRetryAt(headers) });
		}
		return new GitHubError("permission", { status });
	}
	if (status === 404) return new GitHubError("not_found", { status });
	if (status === 410) return new GitHubError("issues_disabled", { status });
	if (status === 422) {
		const codes = Array.isArray(json?.errors) ? json.errors.map((error) => error?.code).filter((code) => typeof code === "string") : [];
		return new GitHubError("validation", { status, codes });
	}
	if (status === 429) return new GitHubError("rate_limit", { status, retryAt: rateRetryAt(headers) });
	if (status >= 500) return new GitHubError("transient", { status });
	return null;
}

function nextLink(link) {
	if (typeof link !== "string") return null;
	for (const part of link.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
		if (match) return match[1];
	}
	return null;
}

export function createGitHubApi({
	repo,
	apiBase,
	fetchImpl = globalThis.fetch,
	env = process.env,
	spawnImpl = spawn,
	ghPath,
	timeoutMs,
} = {}) {
	const base = String(apiBase ?? env.INBOX_GITHUB_API ?? DEFAULT_API_BASE).replace(/\/+$/, "");
	const envTimeout = Number(env.INBOX_GITHUB_TIMEOUT_MS);
	const timeout = timeoutMs === undefined ? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS) : timeoutMs;
	const ghExecutable = ghPath === undefined ? findExecutable(["gh.exe", "gh"], env, fs.existsSync) : ghPath;

	let tokenCache = null;
	let loginCache = null;
	let repoCache = null;

	function ghToken() {
		return new Promise((resolve) => {
			if (!ghExecutable) return resolve(null);
			const stdout = [];
			let settled = false;
			let child;
			let timer;
			const finish = (value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			};
			try {
				child = spawnImpl(ghExecutable, ["auth", "token"], {
					shell: false,
					windowsHide: true,
					env: { ...env, GH_PROMPT_DISABLED: "1" },
				});
				child.stdout?.on("data", (chunk) => { stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); });
				child.on("error", () => finish(null));
				child.on("close", (code) => {
					const value = Buffer.concat(stdout).toString("utf8").trim();
					finish(code === 0 && value ? value : null);
				});
				timer = setTimeout(() => {
					child.kill?.();
					finish(null);
				}, GH_TIMEOUT_MS);
			} catch {
				finish(null);
			}
		});
	}

	async function resolveToken() {
		if (tokenCache) return tokenCache;
		const envToken = env.GH_TOKEN || env.GITHUB_TOKEN;
		if (typeof envToken === "string" && envToken.trim()) {
			tokenCache = envToken.trim();
			return tokenCache;
		}
		const token = await ghToken();
		if (!token) throw new GitHubError("no_token");
		tokenCache = token;
		return tokenCache;
	}

	function urlFor(path, query) {
		const url = /^https?:\/\//i.test(path) ? path : base + path;
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== null) params.append(key, String(value));
		}
		const encoded = params.toString();
		if (!encoded) return url;
		return url + (url.includes("?") ? "&" : "?") + encoded;
	}

	function sanitize(message, token) {
		const text = String(message ?? "network error");
		return token ? text.split(token).join("[redacted]") : text;
	}

	async function fetchOnce(method, path, options, token) {
		const init = {
			method,
			headers: {
				Authorization: "Bearer " + token,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "omo-inbox",
				...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
				...options.headers,
			},
			signal: AbortSignal.timeout(timeout),
		};
		if (options.body !== undefined) init.body = JSON.stringify(options.body);
		let response;
		let text;
		try {
			response = await fetchImpl(urlFor(path, options.query), init);
			text = await response.text();
		} catch (error) {
			if (error instanceof GitHubError) throw error;
			throw new GitHubError("transient", { message: sanitize(error?.message, token) });
		}
		let json = null;
		if (text) {
			try {
				json = JSON.parse(text);
			} catch {
				json = null;
			}
		}
		return { status: response.status, headers: response.headers ?? {}, json, text };
	}

	async function request(method, path, options = {}) {
		const allow = new Set(options.allow ?? []);
		let token = await resolveToken();
		let result = await fetchOnce(method, path, options, token);
		if (result.status === 401) {
			tokenCache = null;
			token = await resolveToken();
			result = await fetchOnce(method, path, options, token);
		}
		const error = classify(result.status, result.headers, result.json);
		if (error && !allow.has(result.status)) throw error;
		return result;
	}

	async function paginate(path, query, { maxPages = DEFAULT_MAX_PAGES } = {}) {
		const items = [];
		let next = path;
		let nextQuery = query;
		let pages = 0;
		while (next && pages < maxPages) {
			const response = await request("GET", next, { query: nextQuery });
			if (Array.isArray(response.json)) items.push(...response.json);
			pages += 1;
			next = nextLink(headerValue(response.headers, "link"));
			nextQuery = undefined;
		}
		return { items, complete: !next };
	}

	async function login() {
		if (loginCache !== null) return loginCache;
		const response = await request("GET", "/user");
		loginCache = String(response.json?.login ?? "");
		return loginCache;
	}

	async function repoInfo() {
		if (repoCache !== null) return repoCache;
		const response = await request("GET", "/repos/" + repo);
		const json = response.json ?? {};
		repoCache = { private: json.private === true, hasIssues: json.has_issues === true, defaultBranch: json.default_branch ?? null };
		return repoCache;
	}

	return { repo, request, paginate, resolveToken, login, repoInfo };
}
