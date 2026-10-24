/* Q19: the packaged issue reporter in an isolated install, and its records across reinstall.
 *
 * Uses the real install() with fake reg/tailscale/spawn runners to copy the worktree into its own
 * temp home (no registry, serve or user setting is touched), starts that installed copy on port 0,
 * submits an issue through the installed /issues/new page, reads it on /issues, appends an image
 * and confirms it on the detail page (a maintainer request_check opens 해결 확인), captures the
 * capabilities manifest identity, then uninstalls and reinstalls data-preservingly. The same issue
 * and its image bytes must read back from the reinstalled copy. Finally a pending outbox entry
 * written under a different storeId is refused by the draft store and is never posted.
 *
 * Every wait is an awaited event (server.json fs.watch, child exit, DOM MutationObserver) under a
 * named 10 s deadline. Ports are ephemeral (0); the home and every asset are this scenario's temp.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const viewport = { width: 390, height: 844, scheme: "light" };

const DEADLINE_MS = 10_000;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const DESCRIPTION = "설치본에서 제보 화면이 열리지 않습니다";
const APPEND_TEXT = "설치본 재시작 뒤에도 남아야 하는 사진";
const FOREIGN_REQUEST = "19191999-1919-4999-8999-191919191999";
const WRONG_STORE = "88888888-8888-4888-8888-888888888888";

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
	return sha256(fs.readFileSync(file));
}

function sha256Tree(root) {
	const out = {};
	if (!fs.existsSync(root)) return out;
	const walk = (dir, rel) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const key = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(full, key);
			else out[key] = sha256File(full);
		}
	};
	walk(root, "");
	return out;
}

function withDeadline(promise, ms, name) {
	let timer;
	const limit = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(`${name} did not settle within ${ms}ms`);
			error.name = `deadline:${name}`;
			reject(error);
		}, ms);
	});
	return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}

function waitForServerJson(home) {
	const file = path.join(home, "server.json");
	let watcher = null;
	let settled = false;
	const dispose = () => {
		watcher?.close();
		watcher = null;
	};
	const changed = new Promise((resolve, reject) => {
		const settle = () => {
			if (settled) return;
			try {
				const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
				if (typeof parsed.port === "number" && parsed.port > 0) {
					settled = true;
					dispose();
					resolve(parsed);
				}
			} catch {
				// the write is observed between open and close; the next event carries content
			}
		};
		try {
			watcher = fs.watch(home, (_event, name) => {
				if (name !== null && name !== "server.json") return;
				settle();
			});
			watcher.on("error", (error) => {
				if (settled) return;
				settled = true;
				dispose();
				reject(error);
			});
			settle();
		} catch (error) {
			settled = true;
			dispose();
			reject(error);
		}
	});
	// one named 10 s deadline; the watcher is closed on rejection as well as success.
	return withDeadline(changed, DEADLINE_MS, "q19_server_json").catch((error) => {
		dispose();
		throw error;
	});
}

/** Ports the given process is listening on, read before a kill (win32 netstat; empty elsewhere). */
function listeningPorts(pid) {
	if (process.platform !== "win32" || !pid) return [];
	try {
		const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: DEADLINE_MS, windowsHide: true });
		const ports = new Set();
		for (const entry of (out.stdout ?? "").split(/\r?\n/)) {
			const cols = entry.trim().split(/\s+/);
			if (cols.length < 5 || cols[3] !== "LISTENING" || cols[4] !== String(pid)) continue;
			const match = cols[1].match(/:(\d+)$/);
			if (match) ports.add(Number(match[1]));
		}
		return [...ports];
	} catch {
		return [];
	}
}

async function waitExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
	await withDeadline(exited, DEADLINE_MS, "q19_server_exit");
	return child.exitCode !== null || child.signalCode !== null;
}

async function portAccepts(port) {
	const probe = new Promise((resolve) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
	return withDeadline(probe, DEADLINE_MS, "q19_port_accept");
}

async function portClosed(port) {
	const probe = new Promise((resolve) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", (error) => {
			socket.destroy();
			resolve(error.code === "ECONNREFUSED" || error.code === "ECONNRESET");
		});
	});
	return withDeadline(probe, DEADLINE_MS, "q19_port_closed");
}

async function request(base, route, init = {}, allowed = []) {
	const res = await fetch(base + route, { ...init, signal: AbortSignal.timeout(DEADLINE_MS) });
	const text = await res.text();
	let body = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (res.status < 200 || res.status >= 300) {
		if (!allowed.includes(res.status)) {
			const error = new Error(`${init.method ?? "GET"} ${route} -> ${res.status} ${text.slice(0, 300)}`);
			error.status = res.status;
			error.body = body;
			throw error;
		}
	}
	return { status: res.status, body, headers: Object.fromEntries(res.headers.entries()), bytes: Buffer.from(text, "utf8") };
}

function installFixture({ repoRoot, home, userHome, agent, root }) {
	let started = false;
	const reg = (args) => {
		if (args[0] === "query") return { status: 1, stdout: "", stderr: "" };
		if (args[0] === "add" || args[0] === "delete") return { status: 0, stdout: "", stderr: "" };
		return { status: 1, stdout: "", stderr: "unexpected" };
	};
	const fetchImpl = async (url) => {
		if (url.endsWith("/api/health")) return started ? { ok: true } : { ok: false };
		if (url.endsWith("/api/shutdown")) {
			started = false;
			return { ok: true };
		}
		return { ok: false };
	};
	const spawnImpl = () => {
		started = true;
		return { pid: 1919, unref() {} };
	};
	const env = {
		...process.env,
		OMO_INBOX_HOME: home,
		INBOX_USER_HOME: userHome,
		OMO_CODING_AGENT_DIR: agent,
		INBOX_NO_TAILSCALE: "1",
		INBOX_RUN_VALUE: "ulw-q19-run",
		TMPDIR: path.join(root, "tmp"),
		TMP: path.join(root, "tmp"),
		TEMP: path.join(root, "tmp"),
		NODE_COMPILE_CACHE: path.join(root, "node-cache"),
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "bun-cache"),
	};
	fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
	return {
		opts: {
			env,
			repoRoot,
			userHome,
			runners: { reg, tailscale: () => ({ status: 1, stdout: "", stderr: "not called" }), spawn: spawnImpl },
			fetch: fetchImpl,
		},
		env,
	};
}

function assetList(root) {
	const pick = (dir, pattern) =>
		fs.readdirSync(path.join(root, dir))
			.filter((name) => pattern.test(name))
			.sort()
			.map((name) => `${dir}/${name}`);
	return [...pick("src", /^issues-.*\.mjs$/), ...pick("web", /^(?:issue-.*\.(?:js|css)|issues\.(?:html|js|css))$/)];
}

function assetsMatch(source, installed) {
	return assetList(source).map((asset) => ({
		asset,
		present: fs.existsSync(path.join(installed, asset)),
		equal: fs.existsSync(path.join(installed, asset)) && fs.readFileSync(path.join(installed, asset)).equals(fs.readFileSync(path.join(source, asset))),
	}));
}

function noQaImports(installed) {
	const importQa = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'][^"']*\bqa\//;
	const hits = [];
	for (const dir of ["src", "web"]) {
		for (const name of fs.readdirSync(path.join(installed, dir))) {
			if (!/\.(?:mjs|js)$/.test(name)) continue;
			if (importQa.test(fs.readFileSync(path.join(installed, dir, name), "utf8"))) hits.push(`${dir}/${name}`);
		}
	}
	return hits;
}

function waitForDom(predicate, label) {
	return `new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(${JSON.stringify(label)} + ' did not appear within 9000ms')), 9000);
		let observer = null;
		const test = () => {
			let value = null;
			try { value = (${predicate})(); } catch { value = null; }
			if (!value) return false;
			clearTimeout(timer);
			if (observer) observer.disconnect();
			resolve(value);
			return true;
		};
		observer = new MutationObserver(() => test());
		observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
		test();
	})`;
}

const NEW_OPEN = `() => {
	const app = document.getElementById('issues-app');
	const dialog = document.getElementById('issue-report');
	return app?.dataset.route === 'new' && dialog?.open ? { route: app.dataset.route, render: app.dataset.render, status: document.getElementById('issue-status')?.textContent ?? '' } : null;
}`;

const NEW_ACCEPTED = `() => {
	const app = document.getElementById('issues-app');
	const id = app?.dataset.accepted ?? null;
	const dialog = document.getElementById('issue-report');
	const link = document.getElementById('issue-link')?.getAttribute('href') ?? null;
	return id ? { id, status: document.getElementById('issue-status')?.textContent ?? '', link, accepted: id } : null;
}`;

const LIST_ROW = `(id) => {
	const app = document.getElementById('issues-app');
	if (app?.dataset.route !== 'list') return null;
	const row = document.querySelector('#issue-rows .row[data-id="' + id + '"]');
	return row ? { id: row.dataset.id, chip: row.querySelector('.chip')?.textContent ?? '', count: app.dataset.count ?? null } : null;
}`;

const CONTROL_RECTS = `() => Array.from(document.querySelectorAll('a[href], button, [role="button"], label.btn'), (node) => {
	const rect = node.getBoundingClientRect();
	const style = getComputedStyle(node);
	if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none') return null;
	const id = node.id ? '#' + node.id : '';
	const cls = typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
	return { control: id || cls || node.tagName.toLowerCase(), label: (node.textContent || '').trim().slice(0, 40), width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 };
}).filter(Boolean)`;

const DETAIL_STATE = `(id) => {
	const app = document.getElementById('issues-app');
	if (app?.dataset.route !== 'detail') return null;
	return {
		id, state: app.dataset.state ?? null, seq: app.dataset.seq ?? null,
		status: document.getElementById('issue-status')?.textContent ?? '',
		confirmDisabled: document.getElementById('issue-confirm')?.disabled ?? null,
		history: [...document.querySelectorAll('#issue-history li')].map((li) => ({ type: li.dataset.type, seq: li.dataset.seq })),
	};
}`;

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline: fixtureDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const deadline = (promise, ms, name) => fixtureDeadline(promise, ms, name);
	const installModule = await import(pathToFileURL(path.join(ctx.appDir, "src", "install.mjs")).href);
	const contextModule = await import(pathToFileURL(path.join(ctx.appDir, "web", "issue-context.js")).href);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ulw-D-task19-"));
	const home = path.join(root, "home");
	const userHome = path.join(root, "user");
	const agent = path.join(root, "agent");
	const evidenceDir = ctx.evidenceDir;
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(userHome, { recursive: true });
	fs.mkdirSync(agent, { recursive: true });
	fs.mkdirSync(evidenceDir, { recursive: true });

	const record = { viewport: { width, height, scheme }, root, install: {}, lifecycle: {}, retention: {}, outbox: {}, cleanup: null };
	let server = null;
	let page = null;
	let installFailure = null;
	const cleanup = { rootRemoved: false, readBack: "PRESENT", serverExited: null, portClosed: null };

	const save = (name, data) => evidence(name, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, "\t"));
	const options = () => installFixture({ repoRoot: ctx.appDir, home, userHome, agent, root });

	async function startInstalled(installedApp) {
		const configFile = path.join(home, "config.json");
		let config = {};
		try {
			config = JSON.parse(fs.readFileSync(configFile, "utf8"));
		} catch {
			config = {};
		}
		fs.writeFileSync(configFile, `${JSON.stringify({ ...config, v: 1, port: 0, publicBase: null }, null, 2)}\n`);
		fs.rmSync(path.join(home, "server.json"), { force: true });
		const logFd = fs.openSync(path.join(root, "server.log"), "a");
		const spawnStarted = Date.now();
		const child = spawn(process.execPath, [path.join(installedApp, "src", "server.mjs")], {
			cwd: installedApp,
			env: {
				...process.env,
				OMO_INBOX_HOME: home,
				INBOX_NO_TAILSCALE: "1",
				INBOX_PUSH_SINK: path.join(root, "push.jsonl"),
				INBOX_REOPEN_SINK: path.join(root, "reopen.jsonl"),
				TMPDIR: path.join(root, "tmp"),
				TMP: path.join(root, "tmp"),
				TEMP: path.join(root, "tmp"),
			},
			stdio: ["ignore", logFd, logFd],
			windowsHide: true,
		});
		fs.closeSync(logFd);
		// Ownership is registered before any await: a startup rejection must still stop this child.
		const target = { child, port: null, base: null, ports: [], timings: { spawnMs: Date.now() - spawnStarted } };
		server = target;
		try {
			// Step 1: process spawned. Step 2: server.json appears (one named 10 s deadline).
			const jsonStarted = Date.now();
			const info = await waitForServerJson(home);
			target.timings.serverJsonMs = Date.now() - jsonStarted;
			// Step 3: the advertised port accepts (one named 10 s deadline).
			const acceptStarted = Date.now();
			const accepted = await portAccepts(info.port);
			target.timings.portAcceptMs = Date.now() - acceptStarted;
			if (!accepted) {
				const error = new Error(`q19_port_accept: port ${info.port} did not accept within ${DEADLINE_MS}ms`);
				error.name = "deadline:q19_port_accept";
				throw error;
			}
			target.port = info.port;
			target.ports = [info.port];
			target.base = `http://127.0.0.1:${info.port}`;
			return target;
		} catch (error) {
			// Capture whichever port the child opened, then stop and reap it before reporting failure.
			target.ports = target.port ? [target.port] : listeningPorts(child.pid);
			target.timings.failed = true;
			target.timings.error = error && error.message ? error.message : String(error);
			child.kill();
			await waitExit(child).catch(() => false);
			throw error;
		}
	}

	async function stopInstalled(target) {
		if (!target || !target.child) return { serverExited: true, portClosed: true, ports: [] };
		let exited = false;
		const known = target.ports?.length ? [...target.ports] : target.port ? [target.port] : [];
		if (target.base) {
			try {
				await request(target.base, "/api/shutdown", { method: "POST", headers: POST, body: "{}" }, []);
			} catch {
				// the exit wait below is the source of truth
			}
		}
		try {
			exited = await waitExit(target.child);
		} catch {
			if (known.length === 0) known.push(...listeningPorts(target.child.pid));
			target.child.kill();
			exited = await waitExit(target.child).catch(() => target.child.exitCode !== null || target.child.signalCode !== null);
		}
		const ports = [];
		for (const port of known) ports.push({ port, closed: await portClosed(port).catch(() => false) });
		return { serverExited: exited, portClosed: ports.every((entry) => entry.closed), ports };
	}

	try {
		// ---- 1. isolated install with fake runners ----
		const fixture = options();
		const installed = await installModule.install({ ...fixture.opts, noAutostart: true, noTailscale: true });
		record.install.lines = installed.lines;
		check("Q19 the fake-runner install copies the package into a private temp home", installed.ok === true && line(installed.lines, "app") === "app: written", installed.lines.join(" | "));
		const installedApp = path.join(home, "app");
		const assets = assetsMatch(ctx.appDir, installedApp);
		record.install.assets = assets;
		check("Q19 the isolated copy contains every issue runtime module and stylesheet byte-for-byte", assets.length >= 16 && assets.every((entry) => entry.present && entry.equal), JSON.stringify(assets.filter((entry) => !entry.present || !entry.equal)));
		const qaHits = noQaImports(installedApp);
		check("Q19 no installed runtime module imports a QA path", qaHits.length === 0, JSON.stringify(qaHits));
		const sourceMeta = JSON.parse(fs.readFileSync(path.join(installedApp, "source.json"), "utf8"));
		record.install.source = sourceMeta;

		// ---- 2. the installed copy serves on port 0; capture manifest identity ----
		server = await startInstalled(installedApp);
		record.install.startup = server.timings;
		const caps = await request(server.base, "/api/issues/capabilities");
		const storeId = caps.body.storeId;
		const buildInfo = caps.body.build;
		record.install.capabilities = { storeId, build: buildInfo, limits: caps.body.limits, features: caps.body.features };
		check("Q19 the installed server reports its manifest build identity", server.port > 0 && /^[0-9a-f]{64}$/.test(buildInfo?.buildId ?? "") && buildInfo.channel === "checkout" && typeof storeId === "string", JSON.stringify({ port: server.port, build: buildInfo, storeId }));

		// Isolation markers: a report lifecycle may not touch proposals, threads or the mailbox.
		for (const dir of [path.join("data", "proposals"), path.join("data", "threads"), "mailbox"]) {
			fs.mkdirSync(path.join(home, dir), { recursive: true });
			fs.writeFileSync(path.join(home, dir, "q19-marker.json"), JSON.stringify({ dir, at: "before-report" }));
		}
		const isolationDirs = [path.join("data", "proposals"), path.join("data", "threads"), "mailbox"];
		const isolationBefore = isolationDirs.map((dir) => sha256Tree(path.join(home, dir)));

		// ---- 3. submit and read through the installed pages ----
		page = await deadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q19_new_page");
		await deadline(page.goto(`${server.base}/issues/new`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_new");
		const opened = await deadline(page.evaluate(waitForDom(NEW_OPEN, "q19_new_open")), DEADLINE_MS, "q19_new_open");
		record.lifecycle.opened = opened;
		check("Q19 the installed /issues/new opens the shared reporter", opened.route === "new" && Boolean(opened.status !== undefined), JSON.stringify(opened));
		record.hitAreas = record.hitAreas ?? {};
		record.hitAreas.mobileNew = (await deadline(page.evaluate(`(${CONTROL_RECTS})()`), DEADLINE_MS, "q19_controls_new_mobile")).map((entry) => ({ ...entry, route: "/issues/new" }));
		await deadline(page.fill("#issue-description", DESCRIPTION), DEADLINE_MS, "q19_fill");
		await deadline(page.click("#issue-send"), DEADLINE_MS, "q19_send");
		const accepted = await deadline(page.evaluate(waitForDom(NEW_ACCEPTED, "q19_accepted")), DEADLINE_MS, "q19_accepted");
		record.lifecycle.accepted = accepted;
		check("Q19 an issue submitted through the installed page is accepted on a verified receipt", /^[0-9a-f-]{36}$/.test(accepted.id) && accepted.status === "접수했습니다" && accepted.link === `/issues/${accepted.id}`, JSON.stringify(accepted));
		const issueId = accepted.id;

		const apiList = await request(server.base, "/api/issues?limit=100");
		record.lifecycle.apiList = { count: apiList.body.items?.length ?? null, ids: (apiList.body.items ?? []).map((item) => item.id), counts: apiList.body.counts };
		check("Q19 the installed API lists the submitted issue", apiList.body.items?.some((item) => item.id === issueId), JSON.stringify(record.lifecycle.apiList));
		await deadline(page.goto(`${server.base}/issues`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_list");
		record.lifecycle.listImmediate = await deadline(page.evaluate("({ url: location.href, title: document.title, route: document.getElementById('issues-app')?.dataset.route ?? null, text: document.body.innerText.slice(0, 400), scripts: [...document.scripts].map((s) => s.src) })"), DEADLINE_MS, "q19_list_immediate");
		const listReady = await deadline(page.evaluate(waitForDom("() => document.querySelector('#issue-rows .row') ? { rows: document.querySelectorAll('#issue-rows .row').length } : null", "q19_list_ready")), DEADLINE_MS, "q19_list_ready");
		record.lifecycle.listReady = listReady;
		const row = await deadline(page.evaluate(`(${LIST_ROW})(${JSON.stringify(issueId)})`), DEADLINE_MS, "q19_list_row");
		record.lifecycle.list = row;
		check("Q19 the installed /issues list reads the submitted issue", row.id === issueId && row.chip === "접수", JSON.stringify(row));

		// ---- 4. append an image, request a check, confirm on the detail page ----
		const context = contextModule.freezeCapture({
			page: "issues",
			source: null,
			target: null,
			view: { width, height, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: scheme, locale: "ko-KR", embedded: false, viewerOpen: false },
			uuid: () => "19191911-1919-4919-8919-191919191911",
			now: () => Date.parse("2026-10-24T00:00:00.000Z"),
		});
		const capture = {
			...context,
			visual: {
				kind: "raster", provenance: "user_upload", acquiredAt: null, sourceMatchesContext: "unverified",
				width: 2, height: 2, encoding: "rgba8-base64",
				pixels: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]).toString("base64"),
				masks: [], marks: [],
			},
		};
		const append = await request(server.base, `/api/issues/${issueId}/feedback`, {
			method: "POST", headers: POST,
			body: JSON.stringify({ v: 1, storeId, requestId: "19191912-1919-4919-8919-191919191912", expectedSeq: 1, command: { type: "append_evidence", evidence: capture, note: APPEND_TEXT } }),
		});
		const imageBefore = await fetch(`${server.base}/api/issues/${issueId}/evidence/${capture.captureId}/image`, { signal: AbortSignal.timeout(DEADLINE_MS) });
		const imageBeforeBytes = Buffer.from(await imageBefore.arrayBuffer());
		record.lifecycle.append = { status: append.status, seq: append.body.currentSeq, imageStatus: imageBefore.status, imageSha256: sha256(imageBeforeBytes), captureId: capture.captureId };
		check("Q19 the installed copy stores appended evidence with image bytes", append.status === 200 && append.body.currentSeq === 2 && imageBefore.status === 200 && imageBefore.headers.get("content-type") === "image/png" && imageBeforeBytes.length > 0, JSON.stringify(record.lifecycle.append));
		const checkCommand = await request(server.base, `/api/issues/${issueId}/commands`, {
			method: "POST", headers: POST,
			body: JSON.stringify({ v: 1, storeId, requestId: "19191913-1919-4919-8919-191919191913", expectedSeq: 2, command: { type: "request_check", note: "설치본에서 고쳤습니다. 확인해 주세요.", correction: { kind: "inbox-build", buildId: buildInfo.buildId, summary: "제보 화면 수정" }, evidence: null } }),
		});
		record.lifecycle.requestCheck = { status: checkCommand.status, seq: checkCommand.body.currentSeq, state: checkCommand.body.state, check: checkCommand.body.correctionCheck };
		check("Q19 a maintainer request_check opens 확인 요청 in the installed store", checkCommand.status === 200 && checkCommand.body.currentSeq === 3 && checkCommand.body.state === "needs-check" && checkCommand.body.correctionCheck?.status === "matched", JSON.stringify(record.lifecycle.requestCheck));

		await deadline(page.goto(`${server.base}/issues/${issueId}`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_detail");
		record.lifecycle.detailImmediate = await deadline(page.evaluate("({ url: location.href, route: document.getElementById('issues-app')?.dataset.route ?? null, state: document.getElementById('issues-app')?.dataset.state ?? null, seq: document.getElementById('issues-app')?.dataset.seq ?? null, text: document.body.innerText.slice(0, 300) })"), DEADLINE_MS, "q19_detail_immediate");
		const detailReady = await deadline(page.evaluate(waitForDom("() => { const app = document.getElementById('issues-app'); if (!app || app.dataset.route !== 'detail') return null; const confirm = document.getElementById('issue-confirm'); return confirm ? { state: app.dataset.state ?? null, seq: app.dataset.seq ?? null, disabled: confirm.disabled } : null; }", "q19_detail")), DEADLINE_MS, "q19_detail");
		check("Q19 the installed detail page reads the issue and enables 해결 확인", detailReady.state === "needs-check" && detailReady.seq === "3" && detailReady.disabled === false, JSON.stringify(detailReady));
		await deadline(page.click("#issue-confirm"), DEADLINE_MS, "q19_confirm");
		const resolved = await deadline(page.evaluate(waitForDom("() => { const app = document.getElementById('issues-app'); if (!app || app.dataset.route !== 'detail' || app.dataset.state !== 'resolved') return null; return { state: app.dataset.state, seq: app.dataset.seq ?? null, status: document.getElementById('issue-status')?.textContent ?? '', history: [...document.querySelectorAll('#issue-history li')].map((li) => ({ type: li.dataset.type, seq: li.dataset.seq })) }; }", "q19_resolved")), DEADLINE_MS, "q19_resolved");
		record.lifecycle.resolved = resolved;
		check("Q19 confirm through the installed detail page resolves the issue at sequence 4", resolved.state === "resolved" && resolved.seq === "4" && resolved.history.map((entry) => entry.type).join() === "created,append_evidence,request_check,confirm", JSON.stringify(resolved));
		const shot = await deadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q19_screenshot");
		save("Q19-installed.png", Buffer.from(shot));
		check("Q19 the installed detail screenshot is saved", fs.existsSync(path.join(evidenceDir, "Q19-installed.png")) && fs.statSync(path.join(evidenceDir, "Q19-installed.png")).size > 0, path.join(evidenceDir, "Q19-installed.png"));

		const afterReport = isolationDirs.map((dir) => sha256Tree(path.join(home, dir)));
		record.lifecycle.isolation = { before: isolationBefore, after: afterReport };
		check("Q19 a report lifecycle leaves data/proposals, data/threads and the mailbox byte-identical", JSON.stringify(isolationBefore) === JSON.stringify(afterReport), JSON.stringify(record.lifecycle.isolation));

		// ---- 4b. 44 CSS px hit areas on every new link/button at 390x844 and 1280x800 ----
		const measureControls = async (target, label, route) =>
			(await deadline(target.evaluate(`(${CONTROL_RECTS})()`), DEADLINE_MS, label)).map((entry) => ({ ...entry, route }));
		record.hitAreas.mobileDetail = await measureControls(page, "q19_controls_detail_mobile", `/issues/${issueId}`);
		await deadline(page.goto(`${server.base}/issues`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_list_mobile");
		await deadline(page.evaluate(waitForDom("() => document.querySelector('#issue-rows .row') ? true : null", "q19_list_ready_mobile")), DEADLINE_MS, "q19_list_ready_mobile");
		record.hitAreas.mobileList = await measureControls(page, "q19_controls_list_mobile", "/issues");
		const desktopPage = await deadline(newQaPage(browser, { width: 1280, height: 800, scheme }), DEADLINE_MS, "q19_desktop_page");
		try {
			await deadline(desktopPage.goto(`${server.base}/issues/new`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_new_desktop");
			await deadline(desktopPage.evaluate(waitForDom(NEW_OPEN, "q19_new_open_desktop")), DEADLINE_MS, "q19_new_open_desktop");
			record.hitAreas.desktopNew = await measureControls(desktopPage, "q19_controls_new_desktop", "/issues/new");
			await deadline(desktopPage.goto(`${server.base}/issues`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_list_desktop");
			await deadline(desktopPage.evaluate(waitForDom("() => document.querySelector('#issue-rows .row') ? true : null", "q19_list_ready_desktop")), DEADLINE_MS, "q19_list_ready_desktop");
			record.hitAreas.desktopList = await measureControls(desktopPage, "q19_controls_list_desktop", "/issues");
			await deadline(desktopPage.goto(`${server.base}/issues/${issueId}`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_detail_desktop");
			await deadline(desktopPage.evaluate(waitForDom("() => document.getElementById('issue-confirm') ? true : null", "q19_detail_desktop")), DEADLINE_MS, "q19_detail_desktop");
			record.hitAreas.desktopDetail = await measureControls(desktopPage, "q19_controls_detail_desktop", `/issues/${issueId}`);
			save("Q19-installed-desktop.png", Buffer.from(await deadline(desktopPage.screenshot({ type: "png" }), DEADLINE_MS, "q19_desktop_screenshot")));
		} finally {
			await deadline(desktopPage.close(), DEADLINE_MS, "q19_desktop_close").catch(() => desktopPage.dispose?.());
		}
		const controls = Object.values(record.hitAreas).flat();
		// Every header/detail control of the installed issues page, including #issues-back, must meet
		// the contract hit area; nothing is exempted by copying the old nav styling.
		const undersized = controls.filter((entry) => entry.width < 44 || entry.height < 44);
		check(
			"Q19 every installed issues-page link and button is at least 44x44 CSS px at 390x844 and 1280x800",
			controls.some((entry) => entry.control === "#issues-back") && controls.length >= 20 && undersized.length === 0,
			JSON.stringify({ count: controls.length, undersized }),
		);

		// ---- 5. uninstall and reinstall keep the issue and evidence ----
		const recordsBefore = sha256Tree(path.join(home, "data", "issues", "records"));
		record.retention.before = { records: recordsBefore, imageSha256: sha256(imageBeforeBytes), detail: (await request(server.base, `/api/issues/${issueId}`)).body };
		const stopped = await stopInstalled(server);
		server = null;
		record.lifecycle.stopped = stopped;
		check("Q19 the installed server exits and its port refuses connections before uninstall", stopped.serverExited === true && stopped.portClosed === true, JSON.stringify(stopped));

		const uninstalled = await installModule.uninstall(fixture.opts);
		record.retention.uninstall = uninstalled.lines;
		const recordsAfterUninstall = sha256Tree(path.join(home, "data", "issues", "records"));
		record.retention.afterUninstall = { appGone: !fs.existsSync(installedApp), records: recordsAfterUninstall };
		check("Q19 uninstall removes the app but keeps every issue and evidence byte", line(uninstalled.lines, "app") === "app: removed" && !fs.existsSync(installedApp) && JSON.stringify(recordsAfterUninstall) === JSON.stringify(recordsBefore), JSON.stringify({ lines: uninstalled.lines, appGone: !fs.existsSync(installedApp), equal: JSON.stringify(recordsAfterUninstall) === JSON.stringify(recordsBefore) }));

		const fixtureAgain = options();
		const reinstalled = await installModule.install({ ...fixtureAgain.opts, noAutostart: true, noTailscale: true });
		const reinstalledApp = path.join(home, "app");
		const assetsAgain = assetsMatch(ctx.appDir, reinstalledApp);
		record.retention.reinstall = { lines: reinstalled.lines, assets: assetsAgain };
		check("Q19 reinstall restores the package and every issue runtime asset", reinstalled.ok === true && assetsAgain.every((entry) => entry.present && entry.equal), reinstalled.lines.join(" | "));

		server = await startInstalled(reinstalledApp);
		record.retention.startup = server.timings;
		const capsAgain = await request(server.base, "/api/issues/capabilities");
		const detailAgain = await request(server.base, `/api/issues/${issueId}`);
		const imageAgain = await fetch(`${server.base}/api/issues/${issueId}/evidence/${capture.captureId}/image`, { signal: AbortSignal.timeout(DEADLINE_MS) });
		const imageAgainBytes = Buffer.from(await imageAgain.arrayBuffer());
		const recordsAfterReinstall = sha256Tree(path.join(home, "data", "issues", "records"));
		record.retention.afterReinstall = {
			build: capsAgain.body.build, storeId: capsAgain.body.storeId,
			detailStatus: detailAgain.status, state: detailAgain.body.state, currentSeq: detailAgain.body.currentSeq,
			description: detailAgain.body.issue.description, events: detailAgain.body.events.map((event) => [event.seq, event.type]),
			imageStatus: imageAgain.status, imageSha256: sha256(imageAgainBytes),
			records: recordsAfterReinstall,
		};
		check(
			"Q19 the reinstalled copy rebuilds the same manifest identity and reads the issue and image bytes back",
			JSON.stringify(capsAgain.body.build) === JSON.stringify(buildInfo) && capsAgain.body.storeId === storeId &&
				detailAgain.status === 200 && detailAgain.body.state === "resolved" && detailAgain.body.currentSeq === 4 &&
				detailAgain.body.issue.description === DESCRIPTION && detailAgain.body.events.map((event) => event.type).join() === "created,append_evidence,request_check,confirm" &&
				imageAgain.status === 200 && sha256(imageAgainBytes) === sha256(imageBeforeBytes) && JSON.stringify(recordsAfterReinstall) === JSON.stringify(recordsBefore),
			JSON.stringify(record.retention.afterReinstall),
		);

		// ---- 6. a pending outbox under another storeId is refused, never posted ----
		await deadline(page.goto(`${server.base}/issues/new`, { waitUntil: "load" }), DEADLINE_MS, "q19_goto_new_again");
		await deadline(page.evaluate(waitForDom(NEW_OPEN, "q19_new_open_again")), DEADLINE_MS, "q19_new_open_again");
		const foreignResult = await deadline(page.evaluate(`(async () => {
			const drafts = await import('/web/issue-drafts.js');
			const db = await drafts.openDraftDb({ indexedDB, origin: location.origin, storeId: ${JSON.stringify(storeId)} });
			const foreignEnvelope = { v: 1, storeId: ${JSON.stringify(WRONG_STORE)}, requestId: ${JSON.stringify(FOREIGN_REQUEST)}, description: '다른 저장소의 대기 항목', evidence: null };
			await new Promise((resolve, reject) => {
				const tx = db._idb.transaction(['outbox'], 'readwrite');
				tx.objectStore('outbox').put({ requestId: ${JSON.stringify(FOREIGN_REQUEST)}, envelope: foreignEnvelope, origin: location.origin, storeId: ${JSON.stringify(WRONG_STORE)} });
				tx.oncomplete = resolve;
				tx.onabort = () => reject(tx.error);
			});
			const frozen = await drafts.freezeToOutbox(db, ${JSON.stringify(FOREIGN_REQUEST)}, { v: 1, storeId: ${JSON.stringify(storeId)}, requestId: ${JSON.stringify(FOREIGN_REQUEST)}, description: '새 저장소로 보내면 안 되는 항목', evidence: null });
			const raw = await new Promise((resolve, reject) => {
				const tx = db._idb.transaction(['outbox'], 'readonly');
				const get = tx.objectStore('outbox').get(${JSON.stringify(FOREIGN_REQUEST)});
				get.onsuccess = () => resolve(get.result);
				get.onerror = () => reject(get.error);
			});
			const pending = await drafts.listPending(db);
			db.close();
			return { frozen, rawStoreId: raw?.storeId ?? null, rawDescription: raw?.envelope?.description ?? null, pending: pending.length };
		})()`), DEADLINE_MS, "q19_foreign_outbox");
		record.outbox.refused = foreignResult;
		check(
			"Q19 a pending outbox entry with a different storeId is refused and is not overwritten",
			foreignResult.frozen?.ok === false && foreignResult.frozen?.conflict === true && foreignResult.rawStoreId === WRONG_STORE && foreignResult.rawDescription === "다른 저장소의 대기 항목" && foreignResult.pending === 0,
			JSON.stringify(foreignResult),
		);
		const countBefore = (await request(server.base, "/api/issues?limit=100")).body.items.length;
		await deadline(page.reload(), DEADLINE_MS, "q19_reload_resume");
		await deadline(page.evaluate(waitForDom(NEW_OPEN, "q19_resume_ready")), DEADLINE_MS, "q19_resume_ready");
		const foreignLookup = await request(server.base, `/api/issues/${FOREIGN_REQUEST}`, {}, [404]);
		const countAfter = (await request(server.base, "/api/issues?limit=100")).body.items.length;
		const rawAfter = await deadline(page.evaluate(`(async () => {
			const drafts = await import('/web/issue-drafts.js');
			const db = await drafts.openDraftDb({ indexedDB, origin: location.origin, storeId: ${JSON.stringify(storeId)} });
			const raw = await new Promise((resolve, reject) => {
				const tx = db._idb.transaction(['outbox'], 'readonly');
				const get = tx.objectStore('outbox').get(${JSON.stringify(FOREIGN_REQUEST)});
				get.onsuccess = () => resolve(get.result);
				get.onerror = () => reject(get.error);
			});
			db.close();
			return raw ? { storeId: raw.storeId, requestId: raw.requestId } : null;
		})()`), DEADLINE_MS, "q19_foreign_after_reload");
		record.outbox.afterReload = { foreignLookup: foreignLookup.status, countBefore, countAfter, raw: rawAfter };
		check(
			"Q19 reloading the reinstalled page never sends the foreign outbox entry into the new store",
			foreignLookup.status === 404 && countBefore === 1 && countAfter === 1 && rawAfter?.storeId === WRONG_STORE,
			JSON.stringify(record.outbox.afterReload),
		);
	} catch (error) {
		installFailure = error && error.stack ? error.stack : String(error);
		check("Q19 scenario ran to completion", false, installFailure);
	} finally {
		if (page) await deadline(page.close(), DEADLINE_MS, "q19_page_close").catch(() => page.dispose?.());
		if (server) {
			const stopped = await stopInstalled(server).catch((error) => ({ serverExited: false, portClosed: false, ports: [], error: String(error) }));
			cleanup.serverExited = stopped.serverExited;
			cleanup.portClosed = stopped.portClosed;
			cleanup.ports = stopped.ports ?? [];
			cleanup.startup = server.timings ?? null;
		} else {
			// nothing was spawned, so there is nothing to have stopped
			cleanup.serverExited = true;
			cleanup.portClosed = true;
			cleanup.ports = [];
		}
		try {
			fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		} catch {
			// reported by the read-back below
		}
		try {
			fs.statSync(root);
			cleanup.readBack = "PRESENT";
		} catch (error) {
			cleanup.readBack = error.code || "ERROR";
		}
		cleanup.rootRemoved = cleanup.readBack === "ENOENT";
		record.cleanup = cleanup;
		save("Q19-cleanup.json", { ...cleanup, root, renderPng: "Q19-installed.png", temporary: true });
		save("Q19-retention.json", record);
		const installReport = [
			"Q19 isolated install",
			...(record.install.lines ?? []),
			"",
			"installed assets:",
			...(record.install.assets ?? []).map((entry) => `${entry.present && entry.equal ? "ok" : "MISSING"} ${entry.asset}`),
			"",
			`source.json: ${JSON.stringify(record.install.source ?? null)}`,
			`capabilities: ${JSON.stringify(record.install.capabilities ?? null)}`,
			`reinstalled assets: ${JSON.stringify((record.retention.reinstall?.assets ?? []).filter((entry) => !entry.present || !entry.equal))}`,
						"README heading sequences:",
			...readmeHeadings(ctx.appDir),
		].join("\n");
		save("Q19-install.txt", installReport);
		check("Q19 cleanup removed the temp install root", cleanup.rootRemoved && cleanup.readBack === "ENOENT" && cleanup.serverExited === true && cleanup.portClosed === true, JSON.stringify(cleanup));
	}
}

function line(lines, step) {
	return lines.find((entry) => entry.startsWith(`${step}:`));
}

function readmeHeadings(root) {
	const read = (name) => fs.readFileSync(path.join(root, name), "utf8").split(/\r?\n/).filter((entry) => /^#{2,3} /.test(entry));
	const en = read("README.md");
	const ko = read("README.ko.md");
	const levels = (entries) => entries.map((entry) => entry.match(/^#+/)[0]).join(",");
	return [
		`README.md: ${en.length} headings [${levels(en)}]`,
		`README.ko.md: ${ko.length} headings [${levels(ko)}]`,
		`sequence agrees: ${en.length === ko.length && levels(en) === levels(ko)}`,
	];
}
