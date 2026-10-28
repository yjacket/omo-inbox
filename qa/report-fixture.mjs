/* Isolated fake GitHub and inbox server for report QA.
 *
 * startFakeGitHub({private, hasIssues}) runs a Bun.serve on port 0 that answers the
 * small slice of the GitHub REST API the report publisher uses. Every request is
 * recorded with its Authorization header reduced to `Bearer <redacted>`; the token
 * itself never appears in `requests`.
 *
 * startInboxServer({app, port, home, env}) writes a report config into a fresh home,
 * spawns `node <app>/src/server.mjs` with a clean child env, and waits up to 10 s for
 * /api/health. stop() tree-kills the PID (taskkill on Windows) and verifies it is gone.
 *
 * Usage: bun qa/report-fixture.mjs --self-test
 * The self-test prints PASS/FAIL lines and ends with `N/N checks passed` (exit 0),
 * or `P/N checks passed` (exit 1) when a check fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { framePng } from "./frame.mjs";

const TOKEN = "qa-fake-token";
const HEALTH_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 10_000;
const POST_JSON = { "content-type": "application/json", "x-inbox": "1" };

function sha1(bytes) {
	return crypto.createHash("sha1").update(bytes).digest("hex");
}

function gitBlobSha(bytes) {
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	return sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
}

function sha256Hex(text) {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function errorBody(status, message, extra) {
	const body = { message };
	if (extra) Object.assign(body, extra);
	return body;
}

function jsonResponse(status, body, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
	});
}

function decodeSegments(pathname) {
	return pathname
		.split("/")
		.filter((segment, index) => index > 0 || segment !== "")
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		});
}

function queryObject(searchParams) {
	const out = {};
	for (const [key, value] of searchParams) out[key] = value;
	return out;
}

function labelObject(name, labels) {
	const found = labels.find((label) => label.name === name);
	return found ? { ...found } : { name, color: "ededed", description: null };
}

function issueView(issue, labels) {
	return {
		number: issue.number,
		title: issue.title,
		body: issue.body,
		state: issue.state,
		comments: issue.comments,
		labels: issue.labels.map((name) => labelObject(name, labels)),
		user: { login: issue.user.login },
		html_url: issue.html_url,
		url: issue.url,
		node_id: issue.node_id,
		created_at: issue.created_at,
		updated_at: issue.updated_at,
	};
}

/**
 * Fake GitHub API on port 0.
 * Returns {url, requests, issues, files, refs, modes, setMode(mode), stop()}.
 */
export function startFakeGitHub({ private: privateRepo = true, hasIssues = true } = {}) {
	const knownTrees = new Set();
	const issues = [];
	const labels = [];
	const files = {};
	const refs = { main: { sha: sha1(Buffer.from("main")), type: "commit" } };
	const requests = [];
	const hangs = [];
	const mode = {
		private: privateRepo === true,
		hasIssues: hasIssues === true,
		failCreate: 0,
		hangCreate: 0,
		status: {},
	};
	let nextIssueNumber = 1;
	let nextObject = 1;
	let stopped = false;

	function objectId(prefix) {
		nextObject += 1;
		return sha1(`${prefix}:${nextObject}`);
	}

	function forcedStatus(pathname) {
		for (const [pattern, code] of Object.entries(mode.status ?? {})) {
			let re;
			try {
				re = new RegExp(pattern);
			} catch {
				continue;
			}
			if (re.test(pathname)) return code;
		}
		return null;
	}

	function forcedResponse(code) {
		if (code === 401) return jsonResponse(401, errorBody(401, "Bad credentials"));
		if (code === 403) return jsonResponse(403, errorBody(403, "Resource not accessible by integration"));
		if (code === 404) return jsonResponse(404, errorBody(404, "Not Found"));
		if (code === 422) return jsonResponse(422, errorBody(422, "Validation Failed", { errors: [] }));
		return jsonResponse(code, errorBody(code, `Forced status ${code}`));
	}

	function labelFor(name) {
		return labelObject(name, labels);
	}

	function listIssues(searchParams, url) {
		const state = searchParams.get("state") || "open";
		const labelFilter = (searchParams.get("labels") || "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
		const creator = searchParams.get("creator") || "";
		const since = searchParams.get("since") || "";
		const sinceMs = since ? Date.parse(since) : null;
		const perPage = Math.min(100, Math.max(1, Number.parseInt(searchParams.get("per_page") || "30", 10) || 30));
		const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);

		const filtered = issues
			.filter((issue) => state === "all" || issue.state === state)
			.filter((issue) => labelFilter.every((name) => issue.labels.includes(name)))
			.filter((issue) => !creator || issue.user.login === creator)
			.filter((issue) => sinceMs === null || Date.parse(issue.created_at) >= sinceMs)
			.sort((a, b) => b.number - a.number);

		const etag = `"${sha256Hex(JSON.stringify({ state, labels: labelFilter, creator, since, perPage, page, numbers: filtered.map((issue) => issue.number) })).slice(0, 32)}"`;
		const total = filtered.length;
		const start = (page - 1) * perPage;
		const items = filtered.slice(start, start + perPage).map((issue) => issueView(issue, labels));

		const links = [];
		const linkFor = (p, rel) => {
			const next = new URL(url);
			next.searchParams.set("page", String(p));
			next.searchParams.set("per_page", String(perPage));
			links.push(`<${next.toString()}>; rel="${rel}"`);
		};
		const lastPage = Math.max(1, Math.ceil(total / perPage));
		if (start + perPage < total) linkFor(page + 1, "next");
		if (page < lastPage) linkFor(lastPage, "last");
		if (page > 1) linkFor(page - 1, "prev");
		linkFor(1, "first");

		const headers = { etag, "x-ratelimit-remaining": "4999" };
		if (links.length > 0) headers.link = links.join(", ");
		return { items, etag, headers };
	}

	function addRef(branch, sha) {
		refs[branch] = { sha, type: "commit" };
	}

	async function handle(req) {
		const url = new URL(req.url);
		const pathname = decodeSegments(url.pathname).join("/");
		const decodedPath = "/" + pathname;
		const searchParams = url.searchParams;
		let body = null;
		if (req.method !== "GET" && req.method !== "HEAD") {
			const text = await req.text();
			if (text) {
				try {
					body = JSON.parse(text);
				} catch {
					body = text;
				}
			}
		}

		const authorization = req.headers.get("authorization");
		const auth = authorization === `Bearer ${TOKEN}`;
		requests.push({
			method: req.method,
			path: decodedPath,
			query: queryObject(searchParams),
			body,
			authorization: authorization ? "Bearer <redacted>" : null,
			auth,
		});

		const forced = forcedStatus(decodedPath);
		if (forced !== null) return forcedResponse(forced);

		const parts = pathname.split("/");
		if (parts[0] !== "repos") {
			if (pathname === "user") return jsonResponse(200, { login: "yjacket" });
			return jsonResponse(404, errorBody(404, "Not Found"));
		}

		const owner = parts[1];
		const repo = parts[2];
		if (!owner || !repo) return jsonResponse(404, errorBody(404, "Not Found"));
		const rest = parts.slice(3);
		const fullName = `${owner}/${repo}`;

		if (rest.length === 0) {
			return jsonResponse(200, {
				full_name: fullName,
				private: mode.private,
				has_issues: mode.hasIssues,
				default_branch: "main",
			});
		}

		if (rest[0] === "labels") {
			if (rest.length === 1) {
				if (req.method === "GET") return jsonResponse(200, labels.map((label) => ({ ...label })));
				if (req.method === "POST") {
					const name = typeof body?.name === "string" ? body.name : "";
					if (!name) return jsonResponse(422, errorBody(422, "Validation Failed", { errors: [{ code: "missing_field" }] }));
					if (labels.some((label) => label.name === name)) {
						return jsonResponse(422, errorBody(422, "Validation Failed", { errors: [{ code: "already_exists" }] }));
					}
					const created = {
						name,
						color: typeof body.color === "string" ? body.color.replace(/^#/, "") : "ededed",
						description: typeof body.description === "string" ? body.description : null,
					};
					labels.push(created);
					return jsonResponse(201, { ...created, url: `${url.origin}/repos/${fullName}/labels/${encodeURIComponent(name)}` });
				}
			}
			if (rest.length === 2) {
				const name = rest[1];
				if (req.method === "GET") {
					const found = labels.find((label) => label.name === name);
					return found ? jsonResponse(200, { ...found }) : jsonResponse(404, errorBody(404, "Not Found"));
				}
				if (req.method === "POST") {
					const found = labels.find((label) => label.name === name);
					const created = {
						name,
						color: typeof body?.color === "string" ? body.color.replace(/^#/, "") : found?.color ?? "ededed",
						description: typeof body?.description === "string" ? body.description : found?.description ?? null,
					};
					if (found) Object.assign(found, created);
					else labels.push(created);
					return jsonResponse(found ? 200 : 201, { ...created });
				}
			}
			return jsonResponse(404, errorBody(404, "Not Found"));
		}

		if (rest[0] === "git" && rest[1] === "ref" && rest[2] === "heads" && rest.length === 4) {
			const branch = rest[3];
			const ref = refs[branch];
			if (!ref) return jsonResponse(404, errorBody(404, "Not Found"));
			return jsonResponse(200, {
				ref: `refs/heads/${branch}`,
				object: { sha: ref.sha, type: "commit", url: `${url.origin}/repos/${fullName}/git/commits/${ref.sha}` },
			});
		}

		if (rest[0] === "git" && rest[1] === "trees" && rest.length === 2 && req.method === "POST") {
			const tree = Array.isArray(body?.tree) ? body.tree : [];
			const sha = objectId("tree");
			knownTrees.add(sha);
			return jsonResponse(201, {
				sha,
				url: `${url.origin}/repos/${fullName}/git/trees/${sha}`,
				tree: tree.map((entry) => ({ ...entry })),
				truncated: false,
			});
		}

		if (rest[0] === "git" && rest[1] === "commits" && rest.length === 2 && req.method === "POST") {
			if (typeof body?.tree !== "string" || !knownTrees.has(body.tree)) return jsonResponse(422, { message: "Invalid request.", errors: [{ resource: "Commit", field: "tree", code: "invalid" }] });
			const sha = objectId("commit");
			return jsonResponse(201, {
				sha,
				url: `${url.origin}/repos/${fullName}/git/commits/${sha}`,
				message: body?.message ?? "",
				tree: { sha: body?.tree ?? null },
				parents: (body?.parents ?? []).map((parent) => ({ sha: parent })),
			});
		}

		if (rest[0] === "git" && rest[1] === "refs" && rest.length === 2 && req.method === "POST") {
			const ref = typeof body?.ref === "string" ? body.ref : "";
			const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
			if (!branch || typeof body?.sha !== "string") {
				return jsonResponse(422, errorBody(422, "Validation Failed", { errors: [{ code: "invalid" }] }));
			}
			if (refs[branch]) return jsonResponse(422, errorBody(422, "Reference already exists", { errors: [{ code: "already_exists" }] }));
			addRef(branch, body.sha);
			return jsonResponse(201, { ref, object: { sha: body.sha, type: "commit" } });
		}

		if (rest[0] === "contents" && rest.length >= 2) {
			const filePath = rest.slice(1).join("/");
			if (req.method === "GET") {
				const file = files[filePath];
				if (!file) return jsonResponse(404, errorBody(404, "Not Found"));
				return jsonResponse(200, {
					type: "file",
					path: filePath,
					name: filePath.split("/").pop(),
					sha: file.sha,
					size: file.bytes.length,
					encoding: "base64",
					content: file.bytes.toString("base64"),
					url: `${url.origin}/repos/${fullName}/contents/${filePath}`,
					html_url: `https://github.com/${fullName}/blob/${file.branch}/${filePath}`,
				});
			}
			if (req.method === "PUT") {
				const branch = typeof body?.branch === "string" ? body.branch : searchParams.get("ref") || "main";
				if (!refs[branch]) return jsonResponse(404, errorBody(404, "Not Found"));
				let bytes;
				try {
					bytes = Buffer.from(typeof body?.content === "string" ? body.content : "", "base64");
				} catch {
					return jsonResponse(422, errorBody(422, "Validation Failed", { errors: [{ code: "invalid" }] }));
				}
				const sha = gitBlobSha(bytes);
				const existing = files[filePath];
				if (existing && body?.sha !== existing.sha) {
					return jsonResponse(422, errorBody(422, "Validation Failed", { errors: [{ code: "sha_missing" }] }));
				}
				files[filePath] = { path: filePath, sha, bytes, branch, message: body?.message ?? "" };
				return jsonResponse(existing ? 200 : 201, {
					content: { sha, size: bytes.length, path: filePath, name: filePath.split("/").pop() },
					commit: { sha: objectId("commit"), message: body?.message ?? "" },
				});
			}
		}

		if (rest[0] === "issues") {
			if (rest.length === 1 && req.method === "GET") {
				const etagValue = req.headers.get("if-none-match");
				const listed = listIssues(searchParams, url);
				if (etagValue === listed.etag) {
					return new Response(null, { status: 304, headers: { etag: listed.etag, "x-ratelimit-remaining": "4999" } });
				}
				return jsonResponse(200, listed.items, listed.headers);
			}
			if (rest.length === 1 && req.method === "POST") {
				if (mode.failCreate > 0) {
					mode.failCreate -= 1;
					return jsonResponse(503, errorBody(503, "Service Unavailable"));
				}
				const number = nextIssueNumber;
				nextIssueNumber += 1;
				const labelNames = Array.isArray(body?.labels)
					? body.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter((name) => typeof name === "string" && name)
					: [];
				const createdAt = new Date().toISOString();
				const issue = {
					number,
					title: typeof body?.title === "string" ? body.title : "",
					body: typeof body?.body === "string" ? body.body : "",
					labels: labelNames,
					state: "open",
					comments: 0,
					user: { login: "yjacket" },
					html_url: `https://github.com/${fullName}/issues/${number}`,
					url: `${url.origin}/repos/${fullName}/issues/${number}`,
					node_id: `I_${number}`,
					created_at: createdAt,
					updated_at: createdAt,
				};
				issues.push(issue);
				const view = issueView(issue, labels);
				if (mode.hangCreate > 0) {
					mode.hangCreate -= 1;
					await new Promise((resolve) => hangs.push(resolve));
				}
				return jsonResponse(201, view);
			}
		}

		return jsonResponse(404, errorBody(404, "Not Found"));
	}

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			try {
				return await handle(req);
			} catch (error) {
				return jsonResponse(500, errorBody(500, String(error?.message ?? error)));
			}
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port,
		requests,
		issues,
		files,
		refs,
		labels,
		modes: mode,
		setMode(next = {}) {
			if (next.private !== undefined) mode.private = next.private === true;
			if (next.hasIssues !== undefined) mode.hasIssues = next.hasIssues === true;
			if (next.failCreate !== undefined) mode.failCreate = Math.max(0, Number(next.failCreate) || 0);
			if (next.hangCreate !== undefined) mode.hangCreate = Math.max(0, Number(next.hangCreate) || 0);
			if (next.status !== undefined) mode.status = next.status == null ? {} : { ...next.status };
			return { ...mode, status: { ...mode.status } };
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			for (const resolve of hangs.splice(0)) resolve();
			server.stop(true);
		},
	};
}

// ---------- inbox server ----------

function waitForFile(file, timeoutMs, name) {
	if (fs.existsSync(file)) {
		try {
			return Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8")));
		} catch {
			// a writer may be between create and close; wait for the next event
		}
	}
	return new Promise((resolve, reject) => {
		let watcher;
		const timer = setTimeout(() => {
			watcher?.close();
			reject(new Error(`deadline: ${name} (${timeoutMs}ms)`));
		}, timeoutMs);
		const finish = () => {
			try {
				const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
				clearTimeout(timer);
				watcher?.close();
				resolve(parsed);
			} catch {
				// keep waiting for a complete write
			}
		};
		try {
			watcher = fs.watch(path.dirname(file), (_event, changed) => {
				if (changed === path.basename(file) || changed === null) finish();
			});
			watcher.on("error", (error) => {
				clearTimeout(timer);
				watcher?.close();
				reject(error);
			});
		} catch (error) {
			clearTimeout(timer);
			reject(error);
			return;
		}
		finish();
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanEnv(extra) {
	const base = {};
	for (const key of ["Path", "PATH", "SystemRoot", "TEMP", "TMP"]) {
		if (typeof process.env[key] === "string" && process.env[key] !== "") base[key] = process.env[key];
	}
	return {
		...base,
		OMO_INBOX_HOME: extra.home,
		INBOX_NO_TAILSCALE: "1",
		INBOX_PUSH_SINK: extra.pushSink,
		INBOX_REOPEN_SINK: extra.reopenSink,
		GITHUB_TOKEN: TOKEN,
		INBOX_GITHUB_API: extra.apiBase,
		INBOX_REPORT_RETRY_MS: "200",
		INBOX_REPORT_RECONCILE_MS: "500",
		INBOX_GITHUB_TIMEOUT_MS: "1500",
		...(extra.env ?? {}),
	};
}

function taskkill(pid) {
	return new Promise((resolve) => {
		execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
	});
}

function running(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

/**
 * Start <app>/src/server.mjs on a private home configured for report QA.
 * Returns {base, pid, home, logs, stop(), restart()}.
 */
export async function startInboxServer({ app, port = 0, home, env = {} } = {}) {
	if (typeof app !== "string" || !app) throw new Error("startInboxServer: app is required");
	if (typeof home !== "string" || !home) throw new Error("startInboxServer: home is required");
	const appDir = path.resolve(app);
	const homeDir = path.resolve(home);
	const checkout = path.join(homeDir, "checkout");
	fs.mkdirSync(checkout, { recursive: true });
	fs.mkdirSync(path.join(homeDir, "logs"), { recursive: true });
	fs.writeFileSync(
		path.join(homeDir, "config.json"),
		JSON.stringify({
			v: 1,
			port,
			publicBase: null,
			pcTailnetIps: [],
			owner: null,
			reports: { repo: "yjacket/omo-inbox", folder: checkout },
		}),
	);

	const pushSink = env.INBOX_PUSH_SINK || path.join(homeDir, "push.jsonl");
	const reopenSink = env.INBOX_REOPEN_SINK || path.join(homeDir, "reopen.jsonl");
	const apiBase = env.INBOX_GITHUB_API || "http://127.0.0.1:1";
	const childEnv = cleanEnv({ home: homeDir, pushSink, reopenSink, apiBase, env });
	const stdoutFile = path.join(homeDir, "logs", "server.out.log");
	const stderrFile = path.join(homeDir, "logs", "server.err.log");

	let child = null;
	let base = null;
	let logs = null;
	let stopped = false;

	async function launch() {
		const outFd = fs.openSync(stdoutFile, "a");
		const errFd = fs.openSync(stderrFile, "a");
		child = spawn("node", [path.join(appDir, "src", "server.mjs")], {
			cwd: appDir,
			env: childEnv,
			stdio: ["ignore", outFd, errFd],
			windowsHide: true,
		});
		fs.closeSync(outFd);
		fs.closeSync(errFd);
		const pid = child.pid;
		if (!pid) throw new Error("server child did not start");
		child.on("error", () => {});
		const serverJson = await waitForFile(path.join(homeDir, "server.json"), HEALTH_TIMEOUT_MS, "server.json");
		const actualPort = Number(serverJson?.port);
		if (!Number.isInteger(actualPort) || actualPort <= 0) throw new Error("server.json has no port");
		base = `http://127.0.0.1:${actualPort}`;
		const started = Date.now();
		let lastError = null;
		while (Date.now() - started < HEALTH_TIMEOUT_MS) {
			try {
				const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
				const body = await res.json().catch(() => null);
				if (res.ok && body?.name === "omo-inbox") {
					logs = { stdout: stdoutFile, stderr: stderrFile };
					return { base, pid };
				}
				lastError = new Error(`health ${res.status}`);
			} catch (error) {
				lastError = error;
			}
			if (!running(pid)) break;
			await sleep(25);
		}
		throw new Error(`deadline: /api/health did not answer within ${HEALTH_TIMEOUT_MS}ms${lastError ? ` (${lastError.message})` : ""}`);
	}

	async function stop() {
		if (stopped) return;
		stopped = true;
		const pid = child?.pid;
		if (!pid) return;
		await taskkill(pid);
		const started = Date.now();
		while (running(pid)) {
			if (Date.now() - started > STOP_TIMEOUT_MS) throw new Error(`pid ${pid} still alive after taskkill`);
			await sleep(25);
		}
	}

	try {
		await launch();
	} catch (error) {
		if (child?.pid) {
			await taskkill(child.pid);
			const started = Date.now();
			while (running(child.pid) && Date.now() - started < STOP_TIMEOUT_MS) await sleep(25);
		}
		throw error;
	}

	return {
		get base() {
			return base;
		},
		get pid() {
			return child?.pid ?? null;
		},
		home: homeDir,
		get logs() {
			return logs;
		},
		stop,
		async restart() {
			await stop();
			stopped = false;
			try {
				fs.rmSync(path.join(homeDir, "server.json"), { force: true });
			} catch {
				// a stale file is harmless; launch waits for the new one anyway
			}
			await launch();
			return { base, pid: child?.pid ?? null };
		},
	};
}

// ---------- seeding ----------

async function postJson(base, route, body) {
	const res = await fetch(base + route, {
		method: "POST",
		headers: POST_JSON,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = text;
	}
	if (!res.ok) throw new Error(`POST ${route} -> ${res.status} ${typeof json === "string" ? json : JSON.stringify(json)}`);
	return json;
}

/**
 * Seed one session thread through the server's own session API.
 * seedThread(base, {id, title, product, branch, firstRequest, items: [{kind, policy, dedupeKey, raw}]})
 */
export async function seedThread(base, { id, title = "QA thread", product = "omo-inbox", branch = "main", firstRequest = "QA request", items = [] } = {}) {
	if (!id) throw new Error("seedThread: id is required");
	const session = await postJson(base, `/api/threads/${encodeURIComponent(id)}/meta`, {
		title,
		product,
		branch,
		firstRequest,
	});
	for (const [index, item] of items.entries()) {
		const kind = item.kind ?? "progress";
		const policy = item.policy ?? (kind === "turn" ? "needs-you" : "progress");
		await postJson(base, `/api/threads/${encodeURIComponent(id)}/items`, {
			kind,
			policy,
			dedupeKey: item.dedupeKey ?? `turn:${id}:${index + 1}`,
			raw: item.raw ?? { text: item.text ?? `QA item ${index + 1}`, request: firstRequest },
			...(item.meta === undefined ? {} : { meta: item.meta }),
		});
	}
	return session;
}

/**
 * Seed one Review board. Pass an existing `dir`, or let the helper build a
 * minimal PNG board under os.tmpdir. seedBoard(base, {dir, title, kind, frame})
 */
export async function seedBoard(base, { dir, title = "QA Review", kind = "decision", frame } = {}) {
	let boardDir = dir;
	if (!boardDir) {
		boardDir = fs.mkdtempSync(path.join(os.tmpdir(), "report-fixture-board-"));
		const png = frame && Buffer.isBuffer(frame) ? frame : framePng(640, 360);
		fs.writeFileSync(path.join(boardDir, "frame.png"), png);
		fs.writeFileSync(
			path.join(boardDir, "board.json"),
			JSON.stringify({
				title,
				kind,
				sections: [{ title: "QA", cards: [{ title: "Frame", frames: [["QA frame", "frame.png"]] }] }],
			}),
		);
	}
	const json = await postJson(base, "/api/proposals", { srcDir: boardDir, cwd: boardDir });
	return { ...json, dir: boardDir };
}

/** Submit a report create body through the server API. */
export async function submit(base, body) {
	return postJson(base, "/api/reports", body);
}

// ---------- self-test ----------

async function selfTest() {
	const checks = [];
	const check = (name, ok, detail) => {
		checks.push({ name, ok });
		console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
	};
	const fake = startFakeGitHub({ private: true, hasIssues: true });
	const repo = "/repos/yjacket/omo-inbox";
	const authHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
	try {
		const user = await fetch(`${fake.url}/user`, { headers: authHeaders });
		const userJson = await user.json();
		check("GET /user returns yjacket", user.status === 200 && userJson.login === "yjacket");

		const repoRes = await fetch(fake.url + repo, { headers: authHeaders });
		const repoJson = await repoRes.json();
		check("GET repo returns private/has_issues/default_branch", repoJson.private === true && repoJson.has_issues === true && repoJson.default_branch === "main");

		const recorded = fake.requests.at(-1);
		check("Authorization is recorded only as Bearer <redacted>", recorded.authorization === "Bearer <redacted>" && recorded.auth === true && !JSON.stringify(fake.requests).includes(TOKEN));

		const tree = await fetch(fake.url + repo + "/git/trees", { method: "POST", headers: authHeaders, body: JSON.stringify({ tree: [{ path: ".gitkeep", mode: "100644", type: "blob", content: "" }] }) });
		const treeJson = await tree.json();
		const commit = await fetch(fake.url + repo + "/git/commits", { method: "POST", headers: authHeaders, body: JSON.stringify({ message: "qa", tree: treeJson.sha, parents: [] }) });
		const commitJson = await commit.json();
		const ref = await fetch(fake.url + repo + "/git/refs", { method: "POST", headers: authHeaders, body: JSON.stringify({ ref: "refs/heads/inbox-report-assets", sha: commitJson.sha }) });
		const refGet = await fetch(fake.url + repo + "/git/ref/heads/inbox-report-assets", { headers: authHeaders });
		const refJson = await refGet.json();
		check("branch tree/commit/ref bootstrap", tree.status === 201 && commit.status === 201 && ref.status === 201 && refJson.object?.sha === commitJson.sha, `ref=${refJson.ref}`);

		const bytes = framePng(32, 18);
		const expectedBlob = gitBlobSha(bytes);
		const put = await fetch(fake.url + repo + "/contents/reports/2026/10/qa.png", {
			method: "PUT",
			headers: authHeaders,
			body: JSON.stringify({ message: "asset", content: bytes.toString("base64"), branch: "inbox-report-assets" }),
		});
		const putJson = await put.json();
		const getFile = await fetch(fake.url + repo + "/contents/reports/2026/10/qa.png?ref=inbox-report-assets", { headers: authHeaders });
		const getJson = await getFile.json();
		check("PUT/GET contents stores bytes and returns blob sha", put.status === 201 && putJson.content.sha === expectedBlob && getJson.sha === expectedBlob && Buffer.from(getJson.content, "base64").equals(bytes));

		const created = [];
		for (let i = 1; i <= 3; i += 1) {
			const res = await fetch(fake.url + repo + "/issues", {
				method: "POST",
				headers: authHeaders,
				body: JSON.stringify({ title: `Issue ${i}`, body: `body ${i}`, labels: ["inbox-report"] }),
			});
			created.push({ status: res.status, json: await res.json() });
		}
		check("POST issues assigns 1..3 and github html_url", created.every((item, index) => item.status === 201 && item.json.number === index + 1 && item.json.html_url === `https://github.com/yjacket/omo-inbox/issues/${index + 1}`));

		const page1 = await fetch(fake.url + repo + "/issues?per_page=2&page=1&labels=inbox-report", { headers: authHeaders });
		const page1Json = await page1.json();
		const link = page1.headers.get("link") || "";
		const nextUrl = /<([^>]+)>\s*;\s*rel="next"/.exec(link)?.[1];
		const page2 = nextUrl ? await fetch(nextUrl, { headers: authHeaders }) : null;
		const page2Json = page2 ? await page2.json() : [];
		check("GET issues paginates with Link per_page=2", page1Json.length === 2 && /rel="next"/.test(link) && page2Json.length === 1, `page1=${page1Json.length} page2=${page2Json.length}`);

		const filtered = await fetch(fake.url + repo + "/issues?state=open&labels=inbox-report&creator=yjacket&per_page=100", { headers: authHeaders });
		const filteredJson = await filtered.json();
		check("GET issues filters state/labels/creator", filteredJson.length === 3 && filteredJson.every((issue) => issue.state === "open" && issue.user.login === "yjacket" && issue.labels.some((label) => label.name === "inbox-report")));

		const etag = page1.headers.get("etag");
		const notModified = await fetch(fake.url + repo + "/issues?per_page=2&page=1&labels=inbox-report", { headers: { ...authHeaders, "if-none-match": etag } });
		check("GET issues ETag answers 304", Boolean(etag) && notModified.status === 304, `etag=${etag}`);

		fake.setMode({ failCreate: 1 });
		const failed = await fetch(fake.url + repo + "/issues", { method: "POST", headers: authHeaders, body: JSON.stringify({ title: "fail", body: "", labels: ["inbox-report"] }) });
		const afterFail = await fetch(fake.url + repo + "/issues", { method: "POST", headers: authHeaders, body: JSON.stringify({ title: "after", body: "", labels: ["inbox-report"] }) });
		const afterJson = await afterFail.json();
		check("failCreate:1 answers 503 once then creates", failed.status === 503 && afterFail.status === 201 && afterJson.number === 4);

		fake.setMode({ status: { "^/user$": 401 } });
		const unauthorized = await fetch(`${fake.url}/user`, { headers: authHeaders });
		const unauthorizedJson = await unauthorized.json();
		fake.setMode({ status: null });
		check("status mode forces 401 (failure scenario)", unauthorized.status === 401 && unauthorizedJson.message === "Bad credentials");

		fake.setMode({ private: false });
		const publicRepo = await (await fetch(fake.url + repo, { headers: authHeaders })).json();
		fake.setMode({ private: true });
		check("private:false is reflected by GET repo", publicRepo.private === false);

		await fake.stop();
		let closed = false;
		try {
			await fetch(`${fake.url}/user`, { signal: AbortSignal.timeout(500) });
		} catch {
			closed = true;
		}
		check("stop closes the fake server", closed);
	} catch (error) {
		check("self-test completed without an exception", false, String(error?.stack ?? error));
		try {
			await fake.stop();
		} catch {
			// already stopped
		}
	}
	const passed = checks.filter((item) => item.ok).length;
	const all = checks.length;
	console.log(`${passed}/${all} checks passed`);
	if (passed !== all) process.exitCode = 1;
	return passed === all;
}

if (import.meta.main && process.argv.includes("--self-test")) {
	await selfTest();
}
