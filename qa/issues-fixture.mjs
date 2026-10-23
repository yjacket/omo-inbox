/* Isolated, event-driven fixture for the issue-reporting QA scenarios.
 *
 * createIssueQa starts <appDir>/src/server.mjs on port 0 with a private home and profile under
 * runTmp, waits for home/server.json through fs.watch (one bounded timer, no polling loop), and
 * seeds two threads and two Review boards through the server's own HTTP API. The real child keeps
 * its own timers (ledger D3); deterministic synchronization is exposed through ctx.barriers, which
 * subscribe with fs.watch to push.jsonl and server.log. Every HTTP call and barrier carries a named
 * rejecting deadline. An initialization failure tears down whatever was started and still writes
 * cleanup.json before rethrowing.
 *
 * runIssueScenario imports qa/issues/<id>.mjs and records checks; openQaBrowser launches an owned
 * headless Chromium through omowright with its own profile (never the user's browser profile).
 *
 * Nothing in this file is imported by src/ or web/.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { framePng } from "./frame.mjs";
import { identityFor } from "../src/identity.mjs";
import { boards, threads, uuids } from "./issues/fixture-data.mjs";

const SERVER_JSON_TIMEOUT_MS = 15_000;
const HTTP_TIMEOUT_MS = 10_000;
const BARRIER_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 10_000;
const PORT_CLOSE_TIMEOUT_MS = 3_000;
const POST = { "content-type": "application/json", "x-inbox": "1" };

export class IssueQaError extends Error {
	constructor(code, message) {
		super(message ?? code);
		this.name = "IssueQaError";
		this.code = code;
	}
}

/**
 * Bound any scenario promise with a named rejecting deadline. The timer is cleared as soon as the
 * wrapped promise settles (resolve or reject), and the rejection error is named "deadline:<name>".
 * Scenarios wrap every navigation, response, locator read and screenshot in this.
 */
export function withDeadline(promise, ms, name) {
	let timer;
	const limit = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`${name} did not settle within ${ms}ms`);
			error.name = `deadline:${name}`;
			error.code = "deadline";
			error.operation = name;
			reject(error);
		}, ms);
	});
	return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}

function timeout(ms, code, message) {
	let timer;
	const promise = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new IssueQaError(code, message)), ms);
	});
	return { promise, cancel: () => clearTimeout(timer) };
}

function waitForServerJson(home) {
	const file = path.join(home, "server.json");
	const timer = timeout(SERVER_JSON_TIMEOUT_MS, "server_json_timeout", `server.json was not written within ${SERVER_JSON_TIMEOUT_MS}ms`);
	let watcher;
	const changed = new Promise((resolve, reject) => {
		try {
			watcher = fs.watch(home, (event, name) => {
				if (name !== "server.json" && name !== null) return;
				try {
					const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
					if (typeof parsed.port === "number" && parsed.port > 0) resolve(parsed);
				} catch {
					// the write can be observed between open and close; the next event carries the content
				}
			});
			watcher.on("error", reject);
		} catch (error) {
			reject(error);
		}
	});
	return Promise.race([changed, timer.promise]).finally(() => {
		timer.cancel();
		watcher?.close();
	});
}

function writeBoardFolder(root, name, board) {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(board));
	fs.writeFileSync(path.join(dir, "frame.png"), framePng());
	return dir;
}

async function request(base, route, init, label) {
	const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
	let res;
	try {
		res = await fetch(base + route, { ...init, signal });
	} catch (error) {
		throw new IssueQaError(
			"http_deadline",
			`${label} failed within ${HTTP_TIMEOUT_MS}ms: ${error && error.message ? error.message : String(error)}`,
		);
	}
	const bodyTimer = timeout(HTTP_TIMEOUT_MS, "http_body_timeout", `${label} body was not read within ${HTTP_TIMEOUT_MS}ms`);
	let text;
	try {
		text = await Promise.race([res.text(), bodyTimer.promise]);
	} catch (error) {
		throw error instanceof IssueQaError ? error : new IssueQaError("http_body_timeout", `${label} body read failed: ${error && error.message ? error.message : String(error)}`);
	} finally {
		bodyTimer.cancel();
	}
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	const headers = Object.fromEntries(res.headers.entries());
	if (res.status < 200 || res.status >= 300) {
		const error = new IssueQaError("http_status", `${label} -> ${res.status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
		error.status = res.status;
		error.body = body;
		throw error;
	}
	// Any 2xx resolves. The parsed JSON fields stay at the top level so existing scenarios that
	// read `created.receipt` keep working; `status`, `headers` and `json` describe the response.
	const result = { status: res.status, headers };
	if (body && typeof body === "object" && !Array.isArray(body)) {
		for (const [key, value] of Object.entries(body)) {
			if (!(key in result)) result[key] = value;
		}
	}
	Object.defineProperty(result, "json", { value: body, enumerable: false, configurable: true });
	Object.defineProperty(result, "__response", { value: { status: res.status, headers }, enumerable: false });
	return result;
}

async function tcpClosed(port) {
	const timer = timeout(PORT_CLOSE_TIMEOUT_MS, "port_check_timeout", `port ${port} did not answer within ${PORT_CLOSE_TIMEOUT_MS}ms`);
	const probe = new Promise((resolve) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", (error) => {
			socket.destroy();
			resolve(error.code === "ECONNREFUSED" || error.code === "ECONNRESET" || error.code === "EHOSTUNREACH");
		});
	});
	try {
		return await Promise.race([probe, timer.promise]);
	} catch {
		return false;
	} finally {
		timer.cancel();
	}
}

/** Watch one file inside root for a change that satisfies evaluate(); null means "not yet". */
function barrier(root, file, evaluate, code, timeoutMs = BARRIER_TIMEOUT_MS) {
	const name = path.basename(file);
	const timer = timeout(timeoutMs, code, `${name} barrier did not resolve within ${timeoutMs}ms`);
	let watcher;
	const changed = new Promise((resolve, reject) => {
		const settle = () => {
			try {
				const value = evaluate();
				if (value === null) return false;
				watcher?.close();
				resolve(value);
				return true;
			} catch {
				return false;
			}
		};
		try {
			watcher = fs.watch(root, (_event, changedName) => {
				if (changedName !== null && changedName !== name) return;
				settle();
			});
			watcher.on("error", reject);
			settle();
		} catch (error) {
			reject(error);
		}
	});
	return Promise.race([changed, timer.promise]).finally(() => {
		timer.cancel();
		watcher?.close();
	});
}

async function stopChild(child) {
	if (!child) return true;
	if (child.exitCode !== null || child.signalCode !== null) return true;
	const exited = new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) resolve();
		else child.once("exit", () => resolve());
	});
	child.kill();
	const timer = timeout(EXIT_TIMEOUT_MS, "exit_timeout", `server did not exit within ${EXIT_TIMEOUT_MS}ms after kill`);
	try {
		await Promise.race([exited, timer.promise]);
	} catch {
		// reported below
	} finally {
		timer.cancel();
	}
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Remove a tree. fs.rmSync's retry options are the repository convention
 * (test/helpers/tmp-home.mjs:10). On Bun 1.4.2 those options do not absorb the browser-profile
 * lock: a probe with a live Chrome process holding the private profile observed
 * `EBUSY: resource busy or locked, rm '...\\profile'` thrown by the first fs.rmSync call even
 * with { maxRetries: 20, retryDelay: 100 }. One bounded fallback loop therefore re-attempts
 * every 100 ms inside a named 10 s deadline, and only for retryable codes. The whole removal
 * rejects by name instead of hanging; the caller reports the real outcome.
 */
export async function removeTree(target, { attempts = 100, deadlineMs = 10_000 } = {}) {
	try {
		fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		return { removed: true, attempts: 1, fallback: false };
	} catch (firstError) {
		return removeTreeFallback(target, firstError, attempts, deadlineMs);
	}
}

const RETRYABLE_REMOVE_CODES = ["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"];

async function removeTreeFallback(target, firstError, attempts, deadlineMs) {
	let last = firstError;
	let used = 0;
	const end = Date.now() + deadlineMs;
	const loop = (async () => {
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (Date.now() >= end) break;
			used = attempt + 1;
			const pause = timeout(100, "remove_tree_retry_backoff", "remove_tree retry backoff did not elapse");
			try {
				await pause.promise;
			} catch {
				// the bounded pause always rejects at its deadline; that is the elapse
			} finally {
				pause.cancel();
			}
			try {
				fs.rmSync(target, { recursive: true, force: true });
				return { removed: true, attempts: attempt + 1, fallback: true, firstError: firstError && firstError.code ? firstError.code : String(firstError) };
			} catch (error) {
				last = error;
				if (!RETRYABLE_REMOVE_CODES.includes(error && error.code)) break;
			}
		}
		return { removed: false, attempts: used, fallback: true, error: last && last.code ? last.code : String(last) };
	})();
	try {
		return await withDeadline(loop, deadlineMs, "remove_tree_deadline");
	} catch (error) {
		return { removed: false, attempts: used, fallback: true, error: last && last.code ? last.code : String(last), deadline: error && error.name ? error.name : "deadline" };
	}
}

async function teardown({ child, port, root, home, evidence, error = null }) {
	const serverExited = await stopChild(child);
	const portClosed = port > 0 ? await tcpClosed(port) : true;
	const removed = [];
	const removalLog = [];
	const reaped = [];
	let names = [];
	try {
		names = fs.existsSync(root) ? fs.readdirSync(root) : [];
	} catch {
		names = [];
	}
	for (const entry of names) {
		const target = path.join(root, entry);
		if (entry === "profile") {
			// A browser process that outlived its close keeps the private profile locked. Reap by
			// this exact profile path first: the reaper resolves only after the killed PIDs are gone.
			reaped.push({ attempt: "initial", ...(await reapQaBrowserProcesses(target).catch((reapError) => ({ matched: [], killed: [], remaining: [], error: reapError && reapError.message ? reapError.message : String(reapError) }))) });
		}
		let outcome = await removeTree(target);
		if (!outcome.removed && entry === "profile") {
			reaped.push({ attempt: "retry", ...(await reapQaBrowserProcesses(target).catch((reapError) => ({ matched: [], killed: [], remaining: [], error: reapError && reapError.message ? reapError.message : String(reapError) }))) });
			outcome = await removeTree(target);
		}
		removalLog.push({
			entry,
			removed: outcome.removed === true,
			attempts: outcome.attempts,
			fallback: outcome.fallback === true,
			...(outcome.error ? { error: outcome.error } : {}),
			...(outcome.deadline ? { deadline: outcome.deadline } : {}),
		});
		if (outcome.removed) removed.push(target);
	}
	let readBack = "ENOENT";
	try {
		fs.statSync(home);
		readBack = "PRESENT";
	} catch (statError) {
		readBack = statError.code || "ERROR";
	}
	const receipt = { serverExited, portClosed, removed, readBack, removalLog, reaped };
	if (error) receipt.error = error && error.message ? error.message : String(error);
	try {
		fs.mkdirSync(evidence, { recursive: true });
		fs.writeFileSync(path.join(evidence, "cleanup.json"), JSON.stringify(receipt, null, "\t"));
	} catch {
		// the caller still receives the receipt
	}
	return receipt;
}

export async function createIssueQa({ appDir, runTmp, evidenceDir, port = 0 } = {}) {
	if (!appDir || !runTmp || !evidenceDir) throw new IssueQaError("bad_input", "createIssueQa needs appDir, runTmp and evidenceDir");
	const app = path.resolve(appDir);
	const root = path.resolve(runTmp);
	const evidence = path.resolve(evidenceDir);
	fs.mkdirSync(evidence, { recursive: true });
	const home = path.join(root, "home");
	const profileDir = path.join(root, "profile");
	const boardRoot = path.join(root, "boards");
	const pushFile = path.join(root, "push.jsonl");
	const reopenFile = path.join(root, "reopen.jsonl");
	const logFile = path.join(root, "server.log");

	let child = null;
	let actualPort = 0;
	let logFd = null;
	try {
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(profileDir, { recursive: true });
		fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port, publicBase: null, pcTailnetIps: [], owner: null }));

		logFd = fs.openSync(logFile, "a");
		const listening = waitForServerJson(home);
		child = spawn(process.execPath, [path.join(app, "src", "server.mjs")], {
			cwd: app,
			env: {
				...process.env,
				OMO_INBOX_HOME: home,
				INBOX_NO_TAILSCALE: "1",
				INBOX_PUSH_SINK: pushFile,
				INBOX_REOPEN_SINK: reopenFile,
			},
			stdio: ["ignore", logFd, logFd],
			windowsHide: true,
		});

		const serverJson = await listening;
		fs.closeSync(logFd);
		logFd = null;
		actualPort = serverJson.port;
		const base = `http://127.0.0.1:${actualPort}`;

		const get = async (route) => request(base, route, { headers: { accept: "application/json" } }, `GET ${route}`);
		const post = async (route, body) => request(base, route, { method: "POST", headers: POST, body: JSON.stringify(body) }, `POST ${route}`);

		const identity = await identityFor(home, {});
		const owner = { ...identity, session: { id: "qa-owner", file: null } };

		// Threads and one item each, through the same routes a session uses.
		await post(`/api/threads/${threads.a.session}/meta`, {
			title: threads.a.title,
			product: threads.a.product,
			branch: threads.a.branch,
			firstRequest: threads.a.firstRequest,
		});
		await post(`/api/threads/${threads.a.session}/items`, threads.a.item);
		await post(`/api/threads/${threads.b.session}/meta`, {
			title: threads.b.title,
			product: threads.b.product,
			branch: threads.b.branch,
			firstRequest: threads.b.firstRequest,
		});
		await post(`/api/threads/${threads.b.session}/items`, threads.b.item);

		// Two boards, two revisions each. Titles come from board.json, identity marks the owner.
		const decisionDirs = boards.decision.map((board, index) => writeBoardFolder(boardRoot, `decision-r${index + 1}`, board));
		const reportDirs = boards.report.map((board, index) => writeBoardFolder(boardRoot, `report-r${index + 1}`, board));
		const decision = await post("/api/proposals", { cwd: decisionDirs[0], identity: owner, srcDir: decisionDirs[0] });
		const decisionId = decision.summary.id;
		await post(`/api/p/${encodeURIComponent(decisionId)}/revise`, { srcDir: decisionDirs[1], session: { id: "qa-owner" }, note: "두 번째 결정 수정본" });
		const report = await post("/api/proposals", { cwd: reportDirs[0], identity: owner, srcDir: reportDirs[0] });
		const reportId = report.summary.id;
		await post(`/api/p/${encodeURIComponent(reportId)}/revise`, { srcDir: reportDirs[1], session: { id: "qa-owner" }, note: "두 번째 보고 수정본" });

		const readLines = () => {
			if (!fs.existsSync(pushFile)) return [];
			const text = fs.readFileSync(pushFile, "utf8");
			if (text.trim() === "") return [];
			return text
				.split(/\r?\n/)
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line));
		};

		let closed = null;
		const ctx = {
			appDir: app,
			runTmp: root,
			base,
			port: actualPort,
			home,
			profileDir,
			evidenceDir: evidence,
			child,
			fixtures: {
				threads: { a: threads.a.session, b: threads.b.session },
				decision: { id: decisionId, revs: [1, 2] },
				report: { id: reportId, revs: [1, 2] },
				uuids,
				frame: path.join(decisionDirs[0], "frame.png"),
			},
			push: {
				file: pushFile,
				async entries() {
					return readLines();
				},
			},
			// Event barriers for scenarios: each subscribes with fs.watch and rejects on a named
			// 10 s deadline. The child keeps real timers; these observe its sinks, not its clock.
			barriers: {
				pushEntry({ timeoutMs = BARRIER_TIMEOUT_MS } = {}) {
					const baseline = readLines().length;
					return barrier(
						root,
						pushFile,
						() => {
							const all = readLines();
							return all.length > baseline ? all.slice(baseline) : null;
						},
						"push_entry_timeout",
						timeoutMs,
					);
				},
				serverLog(pattern, { timeoutMs = BARRIER_TIMEOUT_MS } = {}) {
					const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
					return barrier(
						root,
						logFile,
						() => {
							if (!fs.existsSync(logFile)) return null;
							const text = fs.readFileSync(logFile, "utf8");
							const match = regex.exec(text);
							return match ? { file: logFile, text, line: match[0] } : null;
						},
						"server_log_timeout",
						timeoutMs,
					);
				},
			},
			post,
			get,
			async close() {
				if (closed) return closed;
				closed = await teardown({ child, port: actualPort, root, home, evidence });
				return closed;
			},
		};
		return ctx;
	} catch (error) {
		if (logFd !== null) {
			try {
				fs.closeSync(logFd);
			} catch {
				// best effort
			}
		}
		const receipt = await teardown({ child, port: actualPort, root, home, evidence, error });
		if (error && typeof error === "object") error.cleanup = receipt;
		throw error;
	}
}

const DEFAULT_SKILL_ROOT = "C:/Users/yjack/.bun/install/global/node_modules/omo-ai/plugin/skills/browser";

function browserCandidates() {
	return [
		process.env.OMO_QA_BROWSER,
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	].filter((candidate) => typeof candidate === "string" && candidate !== "");
}

export function resolveQaBrowserPath() {
	const found = browserCandidates().find((candidate) => fs.existsSync(candidate));
	if (!found) throw new IssueQaError("no_browser", "no Chrome or Edge executable found; set OMO_QA_BROWSER");
	return found;
}

function qaSkillRoot() {
	return process.env.OMO_BROWSER_SKILL_ROOT || DEFAULT_SKILL_ROOT;
}

/**
 * Kill every process whose command line carries this harness's private profile path. On Windows
 * Chrome for Testing keeps <runTmp>/profile locked through helper processes that outlive the
 * browser (notably chrome_crashpad_handler.exe --database=<profile>\Crashpad). Matching the exact
 * unique mkdtemp path - not an image name - catches those helpers while never touching a process
 * that merely runs another Chrome. The harness and its PowerShell child both carry the path in
 * their own command lines, so they are excluded by name and the harness by PID. Bounded by a
 * named deadline.
 */
export async function reapQaBrowserProcesses(profileDir, { timeoutMs = 10_000, selfPid = process.pid } = {}) {
	if (process.platform !== "win32" || !profileDir) return { matched: [], killed: [], remaining: [], error: null };
	const needle = path.resolve(profileDir).replace(/'/g, "''");
	// Every match is stopped, then each PID is awaited independently. The shared 8 s limit keeps
	// the wait bounded, and the caller's named 10 s deadline bounds the whole PowerShell command.
	const command = [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$selfPid = ${Number(selfPid)}`,
		"$excluded = @('node.exe', 'bun.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe', 'conhost.exe')",
		`$matches = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $selfPid -and $_.Name -notin $excluded -and $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name } })`,
		"foreach ($match in $matches) { Stop-Process -Id $match.pid -Force -ErrorAction SilentlyContinue }",
		"$limit = (Get-Date).AddSeconds(8)",
		"foreach ($match in $matches) { while ((Get-Process -Id $match.pid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $limit)) { Start-Sleep -Milliseconds 50 } }",
		"$remaining = @($matches | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue } | ForEach-Object { $_.pid })",
		"[pscustomobject]@{ matched = @($matches); remaining = @($remaining) } | ConvertTo-Json -Depth 4 -Compress",
	].join("; ");
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let out = "";
	child.stdout.on("data", (chunk) => {
		out += String(chunk);
	});
	const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
	const timer = timeout(timeoutMs, "browser_reap_timeout", `browser processes did not stop within ${timeoutMs}ms`);
	try {
		await Promise.race([exited, timer.promise]);
	} catch (error) {
		try {
			child.kill();
		} catch {
			// best effort
		}
		throw error;
	} finally {
		timer.cancel();
	}
	const line = out.trim().split(/\r?\n/).filter((value) => value.trim() !== "").pop();
	let parsed = null;
	if (line) {
		try {
			parsed = JSON.parse(line);
		} catch {
			parsed = null;
		}
	}
	const toIds = (value) => {
		const list = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
		return list.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
	};
	const listed = parsed?.matched === undefined || parsed?.matched === null ? [] : Array.isArray(parsed.matched) ? parsed.matched : [parsed.matched];
	const matched = listed
		.map((item) => ({ pid: Number(item?.pid), name: typeof item?.name === "string" ? item.name : "" }))
		.filter((item) => Number.isInteger(item.pid) && item.pid > 0);
	const remaining = toIds(parsed?.remaining);
	const killed = matched.map((item) => item.pid).filter((pid) => !remaining.includes(pid));
	return { matched, killed, remaining, error: null };
}

export async function openQaBrowser(ctx, { width = 1280, height = 800, scheme = "light" } = {}) {
	const root = qaSkillRoot();
	const modulePath = path.join(root, "scripts", "omowright.mjs");
	const { loadOmowright } = await import(pathToFileURL(modulePath).href);
	const { omowright } = await loadOmowright();
	const browserPath = resolveQaBrowserPath();
	const browserArgs = [
		"--headless=new",
		"--no-first-run",
		"--no-default-browser-check",
		`--user-data-dir=${ctx.profileDir}`,
		`--window-size=${width},${height}`,
	];
	const dialogPolicy = { accept: true };
	const browser = await omowright.connectPipe({
		browserPath,
		browserArgs,
		storageRoot: ctx.profileDir,
		dialogPolicy,
	});
	// Always reap this private profile after closing: the tracked child can exit before the real
	// Chrome process, which would keep the profile locked and leak a process past cleanup.
	const closeBrowser = browser.close.bind(browser);
	browser.close = async () => {
		try {
			return await closeBrowser();
		} finally {
			browser.qaReaped = await reapQaBrowserProcesses(ctx.profileDir);
		}
	};
	browser.qaPath = browserPath;
	browser.qaScheme = scheme;
	browser.qaRecord = {
		skillRoot: path.resolve(root),
		omowright: path.resolve(modulePath),
		browserPath,
		profileDir: ctx.profileDir,
		storageRoot: ctx.profileDir,
		browserArgs,
		dialogPolicy,
		width,
		height,
		scheme,
	};
	fs.mkdirSync(ctx.evidenceDir, { recursive: true });
	fs.writeFileSync(path.join(ctx.evidenceDir, "browser.json"), JSON.stringify(browser.qaRecord, null, "\t"));
	return browser;
}

export async function pinQaPage(page, { width, height, scheme = "light" }) {
	const { repinViewport } = await loadQaOmowright();
	await repinViewport(page, { width, height });
	const sessionId = await page.resolveSessionId();
	await page.cdp.send(
		"Emulation.setEmulatedMedia",
		{ features: [{ name: "prefers-color-scheme", value: scheme === "dark" ? "dark" : "light" }] },
		sessionId,
	);
	return { width, height, scheme };
}

export async function newQaPage(browser, { width, height, scheme = "light" } = {}) {
	// The agent-tab manager owns the record it re-pins after every main-frame navigation; creating
	// the tab through it with our viewport keeps that record in agreement with the CDP override.
	const { createAgentTabs } = await loadQaOmowright();
	const manager = createAgentTabs(browser);
	const tab = await manager.create("about:blank", { viewport: { width, height } });
	const page = tab.page;
	await pinQaPage(page, { width, height, scheme });
	// A cross-document navigation lands on a fresh renderer session, so reapply the pin after
	// every completed goto; the wrapper keeps it part of the awaited signal.
	const goto = page.goto.bind(page);
	// The failure probe aborts a navigation and closes the page; it uses the raw goto so the
	// post-navigation viewport re-pin never waits on a page that is already gone.
	page.qaGoto = goto;
	page.goto = async (...args) => {
		const result = await goto(...args);
		await pinQaPage(page, { width, height, scheme });
		return result;
	};
	return page;
}

let omowrightPromise = null;
async function loadQaOmowright() {
	omowrightPromise ??= (async () => {
		const root = qaSkillRoot();
		const { loadOmowright } = await import(pathToFileURL(path.join(root, "scripts", "omowright.mjs")).href);
		return (await loadOmowright()).omowright;
	})();
	return omowrightPromise;
}

export async function runIssueScenario(id, { browser, ctx, width = 390, height = 844, scheme = "light" } = {}) {
	const checks = [];
	const check = (name, ok, detail) => {
		const entry = { name, ok: ok === true, detail: detail === undefined ? null : detail };
		checks.push(entry);
		console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.detail === null ? "" : ` - ${entry.detail}`}`);
	};
	const evidence = (name, data) => {
		fs.mkdirSync(ctx.evidenceDir, { recursive: true });
		const file = path.join(ctx.evidenceDir, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, data);
		return file;
	};
	const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "issues", `${String(id).toLowerCase()}.mjs`);
	try {
		const module = await import(pathToFileURL(file).href);
		if (typeof module.default !== "function") throw new IssueQaError("missing_scenario", `${id} has no default export`);
		await module.default({ browser, ctx, width, height, scheme, check, evidence });
	} catch (error) {
		check(`${id} scenario ran`, false, error && error.stack ? error.stack : String(error));
	}
	const passed = checks.filter((entry) => entry.ok).length;
	const failed = checks.length - passed;
	return { id, checks, passed, failed };
}
