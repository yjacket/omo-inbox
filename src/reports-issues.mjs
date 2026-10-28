// GitHub labels, issue creation, marker lookup, and the stale-while-revalidate
// cache of issue states used by report rows. Nothing here closes or edits an
// issue, and marker lookup never uses the search API.

import { GitHubError } from "./github-api.mjs";

const DEFAULT_TTL_MS = 60000;
const DEFAULT_MAX_PAGES = 10;
const CACHE_MAX_PAGES = 3;

function unexpected(method, path, response) {
	return new GitHubError("transient", {
		status: response?.status ?? null,
		message: `${method} ${path} failed with ${response?.status}`,
	});
}

function responseCodes(response) {
	const errors = response?.json?.errors;
	return Array.isArray(errors) ? errors.map((error) => error?.code).filter((code) => typeof code === "string") : [];
}

function headerValue(headers, name) {
	if (!headers) return null;
	if (typeof headers.get === "function") return headers.get(name);
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
	const value = key === undefined ? null : headers[key];
	return value === undefined || value === null ? null : String(value);
}

function nextLink(link) {
	if (typeof link !== "string") return null;
	for (const part of link.split(",")) {
		const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part.trim());
		if (match) return match[1];
	}
	return null;
}

const labelCache = new WeakMap();

function labelsFor(api) {
	let labels = labelCache.get(api);
	if (labels == null) {
		labels = new Map();
		labelCache.set(api, labels);
	}
	return labels;
}

export function ensureLabel(api, { name, color, description }) {
	const labels = labelsFor(api);
	if (labels.has(name)) return labels.get(name);
	const path = `/repos/${api.repo}/labels/${encodeURIComponent(name)}`;
	const pending = (async () => {
		const existing = await api.request("GET", path, { allow: [404] });
		if (existing.status === 200) return existing.json;
		if (existing.status !== 404) throw unexpected("GET", path, existing);

		const createPath = `/repos/${api.repo}/labels`;
		const created = await api.request("POST", createPath, {
			body: { name, color, description },
			allow: [422],
		});
		if (created.status === 422) {
			if (responseCodes(created).includes("already_exists")) return created.json;
			throw new GitHubError("validation", {
				status: 422,
				codes: responseCodes(created),
			});
		}
		if (created.status !== 201 && created.status !== 200) throw unexpected("POST", createPath, created);
		return created.json;
	})().catch((error) => {
		labels.delete(name);
		throw error;
	});
	labels.set(name, pending);
	return pending;
}

export async function createIssue(api, { title, body, labels }) {
	const path = `/repos/${api.repo}/issues`;
	const response = await api.request("POST", path, { body: { title, body, labels } });
	if (response.status < 200 || response.status >= 300) throw unexpected("POST", path, response);
	const json = response.json ?? {};
	if (typeof json.number !== "number" || !Number.isFinite(json.number)) {
		throw new GitHubError("transient", { status: response.status, codes: ["malformed"] });
	}
	return {
		number: json.number,
		url: json.html_url,
		nodeId: json.node_id,
		createdAt: json.created_at,
	};
}

function matching(items, marker) {
	const matches = [];
	for (const item of items ?? []) {
		if (item == null || item.pull_request != null) continue;
		if (typeof item.body !== "string" || !item.body.includes(marker)) continue;
		matches.push({ number: item.number, url: item.html_url });
	}
	return matches;
}

export async function findIssueByMarker(api, { marker, label, creator, since, maxPages = DEFAULT_MAX_PAGES }) {
	const path = `/repos/${api.repo}/issues`;
	const query = {
		state: "all",
		labels: label,
		creator,
		since,
		sort: "created",
		direction: "desc",
		per_page: 100,
	};
	const first = await api.paginate(path, query, { maxPages });
	const matches = matching(first.items, marker);
	let complete = first.complete === true;
	if (matches.length === 0) {
		const { labels: _label, ...withoutLabel } = query;
		const second = await api.paginate(path, withoutLabel, { maxPages });
		matches.push(...matching(second.items, marker));
		complete = complete && second.complete === true;
	}
	return { matches, complete };
}

export function createStateCache(api, { label, ttlMs = DEFAULT_TTL_MS, now = () => new Date() } = {}) {
	const path = `/repos/${api.repo}/issues`;
	let map = null;
	let etag = null;
	let lastStartedAt = null;
	let lastSuccessAt = null;
	let inFlight = null;

	function currentMs() {
		const value = now();
		return value instanceof Date ? value.getTime() : new Date(value).getTime();
	}

	function currentIso() {
		return new Date(currentMs()).toISOString();
	}

	function start() {
		if (inFlight != null) return inFlight;
		lastStartedAt = currentMs();
		const pending = (async () => {
			try {
				const collected = [];
				let next = path;
				let query = { state: "all", labels: label, per_page: 100 };
				let headers = etag ? { "If-None-Match": etag } : {};
				for (let page = 0; page < CACHE_MAX_PAGES; page += 1) {
					const response = await api.request("GET", next, { query, headers });
					if (page === 0 && response.status === 304) {
						lastSuccessAt = currentIso();
						return;
					}
					if (response.status !== 200) throw unexpected("GET", next, response);
					if (page === 0) etag = headerValue(response.headers, "etag");
					if (Array.isArray(response.json)) collected.push(...response.json);
					const link = nextLink(headerValue(response.headers, "link"));
					if (!link) break;
					next = link;
					query = undefined;
					headers = {};
				}
				const result = new Map();
				for (const item of collected) {
					if (item == null || typeof item.number !== "number") continue;
					result.set(item.number, { state: item.state, comments: item.comments });
				}
				map = result;
				lastSuccessAt = currentIso();
			} catch {
				// A failed refresh keeps the last map and stays silent by contract.
			} finally {
				if (inFlight === pending) inFlight = null;
			}
		})();
		inFlight = pending;
		return pending;
	}

	function get() {
		if (inFlight == null && (lastStartedAt === null || currentMs() - lastStartedAt > ttlMs)) start();
		return map;
	}

	return {
		get,
		refresh: () => start(),
		at: () => lastSuccessAt,
	};
}
