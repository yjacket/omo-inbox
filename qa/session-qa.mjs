#!/usr/bin/env bun
/**
 * Real-session QA for omo-inbox (plan todos 28, 34 and 46).
 *
 * Starts the inbox server from this checkout on a temp home (port 4395, INBOX_NO_TAILSCALE=1,
 * INBOX_PUSH_SINK file), then drives the real `omo` TUI in a Bun PTY with only the builtin ask-user/goal
 * extensions plus this checkout's extension/omo-inbox.ts. Every scenario is judged from the session
 * transcript jsonl, the inbox API and the rendered PTY screen, never from the model's own claims.
 *
 * S12-S24 (plan todo 16) judge the episode flow: one owner request = one line per assistant message + one final report.
 * They add the terminal builtin (background bash, monitor), INBOX_EPISODE_STALL_MS, a fake desk (S14) and a primary-mode run (S13).
 * S25-S26 (plan todo 18) judge next actions against a real session: owner close and a new-session handoff.
 * Both delete ORCA_TERMINAL_HANDLE and set next.closeTab false, so close never touches a real Orca tab.
 *
 * Usage: bun qa/session-qa.mjs [S1 S2 ...]   (no argument = S1-S26 + the bridge-off run)
 * Env: QA_EVIDENCE_DIR (where the per-scenario evidence files go), QA_EVIDENCE_PREFIX, QA_MODEL, QA_KEEP=1.
 */
import { spawn as nodeSpawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const EVIDENCE = process.env.QA_EVIDENCE_DIR ? path.resolve(process.env.QA_EVIDENCE_DIR) : path.join(REPO, ".omo", "evidence", "omo-inbox");
const EVIDENCE_PREFIX = process.env.QA_EVIDENCE_PREFIX ?? "task-49";
const PORT = 4395;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = process.env.QA_MODEL || "anthropic-subscription/claude-haiku-4-5";
const COLS = 120;
const ROWS = 40;
const FORBIDDEN_PORTS = new Set([4377, 4378, 4387, 4388]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// A small terminal screen emulator, enough to tell what the TUI shows right now (overlay gone or not).
// ---------------------------------------------------------------------------------------------

export class Screen {
	constructor(cols = COLS, rows = ROWS) {
		this.cols = cols;
		this.rows = rows;
		this.grid = Array.from({ length: rows }, () => this.blank());
		this.history = [];
		this.x = 0;
		this.y = 0;
		this.saved = [0, 0];
		this.state = "ground";
		this.params = "";
		this.decoder = new TextDecoder("utf-8");
	}

	blank() {
		return Array.from({ length: this.cols }, () => " ");
	}

	feed(bytes) {
		const text = typeof bytes === "string" ? bytes : this.decoder.decode(bytes, { stream: true });
		for (const ch of text) this.step(ch);
	}

	step(ch) {
		switch (this.state) {
			case "ground":
				return this.ground(ch);
			case "esc":
				if (ch === "[") {
					this.state = "csi";
					this.params = "";
				} else if (ch === "]" || ch === "P" || ch === "_" || ch === "^") {
					this.state = "str";
				} else if (ch === "7") {
					this.saved = [this.x, this.y];
					this.state = "ground";
				} else if (ch === "8") {
					[this.x, this.y] = this.saved;
					this.state = "ground";
				} else if (ch === "(" || ch === ")" || ch === "#") {
					this.state = "skip1";
				} else {
					this.state = "ground";
				}
				return undefined;
			case "skip1":
				this.state = "ground";
				return undefined;
			case "str":
				if (ch === "\x07") this.state = "ground";
				else if (ch === "\x1b") this.state = "strEsc";
				return undefined;
			case "strEsc":
				this.state = ch === "\\" ? "ground" : "str";
				return undefined;
			case "csi":
				if (ch >= "0" && ch <= "?") {
					this.params += ch;
					return undefined;
				}
				if (ch >= " " && ch <= "/") return undefined;
				this.state = "ground";
				return this.csi(ch);
			default:
				this.state = "ground";
				return undefined;
		}
	}

	ground(ch) {
		if (ch === "\x1b") this.state = "esc";
		else if (ch === "\r") this.x = 0;
		else if (ch === "\n") this.lineFeed();
		else if (ch === "\b") this.x = Math.max(0, this.x - 1);
		else if (ch === "\t") this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8);
		else if (ch >= " " && ch !== "\x7f") this.put(ch);
	}

	lineFeed() {
		if (this.y < this.rows - 1) {
			this.y += 1;
			return;
		}
		this.history.push(this.grid.shift().join("").trimEnd());
		this.grid.push(this.blank());
	}

	put(ch) {
		const width = Math.max(1, Bun.stringWidth(ch));
		if (this.x + width > this.cols) {
			this.x = 0;
			this.lineFeed();
		}
		this.grid[this.y][this.x] = ch;
		if (width === 2) this.grid[this.y][this.x + 1] = "";
		this.x += width;
	}

	csi(final) {
		const priv = this.params.startsWith("?") || this.params.startsWith(">") || this.params.startsWith("=");
		if (priv) return;
		const args = this.params.split(";").map((value) => (value === "" ? NaN : Number(value)));
		const n = (index, fallback = 1) => (Number.isFinite(args[index]) && args[index] > 0 ? args[index] : fallback);
		switch (final) {
			case "A":
				this.y = Math.max(0, this.y - n(0));
				break;
			case "B":
				this.y = Math.min(this.rows - 1, this.y + n(0));
				break;
			case "C":
				this.x = Math.min(this.cols - 1, this.x + n(0));
				break;
			case "D":
				this.x = Math.max(0, this.x - n(0));
				break;
			case "E":
				this.y = Math.min(this.rows - 1, this.y + n(0));
				this.x = 0;
				break;
			case "F":
				this.y = Math.max(0, this.y - n(0));
				this.x = 0;
				break;
			case "G":
				this.x = Math.min(this.cols - 1, n(0) - 1);
				break;
			case "d":
				this.y = Math.min(this.rows - 1, n(0) - 1);
				break;
			case "H":
			case "f":
				this.y = Math.min(this.rows - 1, n(0) - 1);
				this.x = Math.min(this.cols - 1, n(1) - 1);
				break;
			case "J": {
				const mode = Number.isFinite(args[0]) ? args[0] : 0;
				if (mode === 0) {
					this.eraseRow(this.y, this.x, this.cols);
					for (let row = this.y + 1; row < this.rows; row += 1) this.eraseRow(row, 0, this.cols);
				} else if (mode === 1) {
					for (let row = 0; row < this.y; row += 1) this.eraseRow(row, 0, this.cols);
					this.eraseRow(this.y, 0, this.x + 1);
				} else if (mode === 2 || mode === 3) {
					for (let row = 0; row < this.rows; row += 1) this.eraseRow(row, 0, this.cols);
					if (mode === 3) this.history = [];
				}
				break;
			}
			case "K": {
				const mode = Number.isFinite(args[0]) ? args[0] : 0;
				if (mode === 0) this.eraseRow(this.y, this.x, this.cols);
				else if (mode === 1) this.eraseRow(this.y, 0, this.x + 1);
				else this.eraseRow(this.y, 0, this.cols);
				break;
			}
			case "X":
				this.eraseRow(this.y, this.x, this.x + n(0));
				break;
			case "P": {
				const row = this.grid[this.y];
				row.splice(this.x, n(0));
				while (row.length < this.cols) row.push(" ");
				break;
			}
			case "@": {
				const row = this.grid[this.y];
				row.splice(this.x, 0, ...Array.from({ length: n(0) }, () => " "));
				row.length = this.cols;
				break;
			}
			case "L":
				for (let i = 0; i < n(0); i += 1) {
					this.grid.splice(this.y, 0, this.blank());
					this.grid.pop();
				}
				break;
			case "M":
				for (let i = 0; i < n(0); i += 1) {
					this.grid.splice(this.y, 1);
					this.grid.push(this.blank());
				}
				break;
			case "S":
				for (let i = 0; i < n(0); i += 1) this.lineFeed();
				break;
			case "s":
				this.saved = [this.x, this.y];
				break;
			case "u":
				[this.x, this.y] = this.saved;
				break;
			default:
				break;
		}
	}

	eraseRow(row, from, to) {
		for (let col = from; col < Math.min(to, this.cols); col += 1) this.grid[row][col] = " ";
	}

	/** The rows currently on screen (no scrollback), trailing blanks trimmed. */
	visible() {
		return this.grid.map((row) => row.join("").trimEnd()).join("\n").replace(/\n+$/, "");
	}

	/** Scrollback plus the visible rows. */
	full() {
		return [...this.history, this.visible()].join("\n");
	}
}

// ---------------------------------------------------------------------------------------------
// The omo TUI in a PTY.
// ---------------------------------------------------------------------------------------------

export class OmoPty {
	/** @param {{cwd:string, sessionDir:string, env:Record<string,string>, extra?:string[], extensions?:string[], model?:string, deleteEnv?:string[]}} options */
	constructor(options) {
		this.options = options;
		this.screen = new Screen();
		this.raw = "";
		this.exited = null;
	}

	args() {
		const { sessionDir, extensions = [], extra = [], model = MODEL } = this.options;
		// Keep the eval tool: in this runtime a background shell is started from eval (tool.bash run_in_background); with
		// eval excluded the top-level bash ran every job in the foreground, so no scenario ever reached its waiting turn end.
		const args = ["--no-extensions", "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--offline"];
		for (const extension of extensions) args.push("-e", extension);
		args.push("--session-dir", sessionDir, "--model", model, "--thinking", "off", ...extra);
		return args;
	}

	start() {
		const { cwd, env, deleteEnv = [] } = this.options;
		const childEnv = { ...process.env, ...env, TERM: "xterm-256color", NO_COLOR: "1" };
		for (const key of deleteEnv) delete childEnv[key];
		this.proc = Bun.spawn(["omo", ...this.args()], {
			cwd,
			env: childEnv,
			terminal: {
				cols: COLS,
				rows: ROWS,
				data: (_term, data) => {
					this.screen.feed(data);
					this.raw += Buffer.from(data).toString("utf8");
				},
			},
		});
		this.proc.exited.then((code) => {
			this.exited = code;
		});
		return this;
	}

	type(text) {
		this.proc.terminal.write(text);
	}

	enter() {
		this.proc.terminal.write("\r");
	}

	/** Type a prompt and submit it. Bracketed paste keeps newlines out of the picture. */
	prompt(text) {
		this.type(text);
		return sleep(400).then(() => this.enter());
	}

	visible() {
		return this.screen.visible();
	}

	full() {
		return this.screen.full();
	}

	async waitForScreen(test, timeoutMs, label) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.exited !== null) throw new Error(`omo exited (${this.exited}) while waiting for ${label}`);
			if (test(this.screen.visible(), this.screen.full())) return true;
			await sleep(150);
		}
		throw new Error(`timed out (${timeoutMs} ms) waiting for ${label}\n--- screen ---\n${this.screen.visible()}`);
	}

	async stop() {
		if (this.exited !== null) return;
		try {
			this.proc.terminal.write("\x03");
			await sleep(300);
			this.proc.terminal.write("\x03");
			await Promise.race([this.proc.exited, sleep(4000)]);
		} catch {
			// already gone
		}
		if (this.exited === null) {
			await killTree(this.proc.pid);
			await Promise.race([this.proc.exited, sleep(3000)]);
		}
	}
}

/**
 * `omo` is a launcher: killing its pid leaves the senpi child running (seen live: a "killed" session kept working and
 * kept the run from exiting). Stop the whole tree.
 */
async function killTree(pid) {
	if (!pid) return;
	const child = Bun.spawn(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
	await child.exited;
}

export { sleep, PORT, BASE, MODEL, REPO, EVIDENCE, FORBIDDEN_PORTS, nodeSpawn, crypto, fs, os, path };

// ---------------------------------------------------------------------------------------------
// Harness: isolated server, API client, transcript reader, evidence writer.
// ---------------------------------------------------------------------------------------------

const H = { root: "", home: "", sink: "", reopenSink: "", server: null, serverEnv: {}, runLines: [] };
const EXTENSION = path.join(REPO, "extension", "omo-inbox.ts").replace(/\\/g, "/");
const BASE_EXTENSIONS = ["builtin:ask-user", "builtin:goal", EXTENSION];
const OVERLAY = /Ask user · |Type your own answer/;
const PERMISSION_DIALOG = /Permission required: /;

function say(line) {
	console.log(line);
	H.runLines.push(line);
}

/** extension.log (the episode verdict lines live there): byte size now, and the verdict lines written since `t.logStart`. */
function logSize() {
	try {
		return fs.statSync(path.join(H.home, "logs", "extension.log")).size;
	} catch {
		return 0;
	}
}

function verdictsOf(t) {
	try {
		return fs.readFileSync(path.join(H.home, "logs", "extension.log")).subarray(t.logStart).toString("utf8").split("\n").filter((line) => /capture: (line-only|close) /.test(line));
	} catch {
		return [];
	}
}

function evidence(file, content) {
	fs.mkdirSync(EVIDENCE, { recursive: true });
	fs.writeFileSync(path.join(EVIDENCE, file), typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

/** Poll `fn` until it returns a truthy value; throws (retryable for model-dependent steps) on timeout. */
async function until(fn, timeoutMs, label, { retryable = false, everyMs = 250 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await fn();
		if (last) return last;
		await sleep(everyMs);
	}
	const error = new Error(`timed out after ${timeoutMs} ms: ${label}`);
	error.retryable = retryable;
	throw error;
}

async function api(method, route, body) {
	const response = await fetch(BASE + route, {
		method,
		headers: { "content-type": "application/json", "x-inbox": "1" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(8000),
	});
	let json = null;
	try {
		json = await response.json();
	} catch {
		// empty body
	}
	return { status: response.status, body: json };
}

async function health() {
	try {
		const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
		return await response.json();
	} catch {
		return null;
	}
}

async function startServer() {
	if (await health()) throw new Error(`port ${PORT} already answers; refusing to reuse it`);
	H.server = Bun.spawn(["node", path.join(REPO, "src", "server.mjs")], {
		cwd: REPO,
		env: { ...process.env, ...H.serverEnv },
		stdout: "ignore",
		stderr: "ignore",
	});
	const up = await until(async () => {
		const answer = await health();
		return answer && answer.name === "omo-inbox" && answer.port === PORT && answer.pid === H.server.pid ? answer : null;
	}, 15000, "our server answers /api/health");
	return up;
}

async function stopServer() {
	H.server.kill();
	await H.server.exited;
	await until(async () => !(await health()), 8000, "server stops answering");
}

/** A syntactically valid but unroutable push subscription: the pusher appends to INBOX_PUSH_SINK instead of sending. */
async function subscribeFake() {
	const ecdh = crypto.createECDH("prime256v1");
	ecdh.generateKeys();
	const subscription = {
		endpoint: "https://push.example.invalid/session-qa",
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") },
	};
	const response = await api("POST", "/api/push/subscribe", { subscription });
	if (response.status !== 200) throw new Error(`subscribe failed: ${response.status}`);
}

function sinkEntries() {
	try {
		return fs.readFileSync(H.sink, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/** Pushes for one item, ignoring the subscribe welcome and cache reminders. */
const sinkFor = (itemId) => sinkEntries().filter((entry) => entry.payload?.itemId === itemId && !String(entry.payload?.title ?? "").startsWith("🔥"));

// --- transcript ---

function findJsonl(dir) {
	const files = [];
	const walk = (current) => {
		for (const entry of fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }) : []) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) files.push(full);
		}
	};
	walk(dir);
	return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
}

function readTranscript(dir) {
	const file = findJsonl(dir);
	if (!file) return { file: null, entries: [], sid: null };
	const entries = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// a half-written last line
		}
	}
	return { file, entries, sid: entries.find((entry) => entry.type === "session")?.id ?? null };
}

const textOf = (message) => (typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(""));
const messagesOf = (entries) => entries.filter((entry) => entry.type === "message").map((entry) => ({ ...entry.message, entryId: entry.id, at: entry.timestamp }));
const toolResults = (entries, toolName) => messagesOf(entries).filter((message) => message.role === "toolResult" && message.toolName === toolName);
/**
 * Externally admitted messages (session_control_delivery) are stored as custom_message entries, not role=user messages;
 * both count as "the user said this" for the model.
 */
const deliveryMessages = (entries) => entries
	.filter((entry) => entry.type === "custom_message" && entry.customType === "session_control_delivery")
	.map((entry) => ({ role: "user", content: [{ type: "text", text: entry.content }], at: entry.timestamp, entryId: entry.id, sender: entry.details?.sender, viaDelivery: true }));
const userMessages = (entries) => [...messagesOf(entries).filter((message) => message.role === "user"), ...deliveryMessages(entries)].sort((a, b) => String(a.at).localeCompare(String(b.at)));

// --- inbox views ---

async function threadView(sid) {
	const response = await api("GET", `/api/threads/${encodeURIComponent(sid)}`);
	return response.status === 200 ? response.body : null;
}

async function itemsOf(sid, kind) {
	const view = await threadView(sid);
	return (view?.items ?? []).filter((item) => !kind || item.kind === kind);
}

const eventsFor = (view, itemId, type) => (view?.events ?? []).filter((event) => event.itemId === itemId && (!type || event.type === type));

const squash = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * The thread's firstRequest is the scenario prompt (the server keeps up to 600 chars) and the first, heuristic summary of
 * the item opens its context with `요청: ` plus that prompt (clipped to 120 chars by the heuristic).
 */
async function checkFirstRequest(t, prompt, itemId) {
	const view = await until(async () => {
		const current = await threadView(t.sid);
		return current?.thread?.firstRequest ? current : null;
	}, 15000, "thread.firstRequest is set").catch(() => null);
	const firstRequest = view?.thread?.firstRequest ?? "";
	t.snap("threadMeta", view?.thread ?? null);
	t.check("thread.firstRequest equals the scenario prompt", squash(firstRequest) === squash(prompt).slice(0, 600), JSON.stringify(firstRequest).slice(0, 300));
	const heuristic = await until(async () => {
		const current = await threadView(t.sid);
		return eventsFor(current, itemId, "summary").find((event) => event.source === "heuristic") ?? null;
	}, 15000, `a heuristic summary event for ${itemId}`).catch(() => null);
	const context = heuristic?.summary?.context ?? "";
	t.snap("heuristicSummary", heuristic);
	t.check("the heuristic context starts with 요청: plus that prompt", context.startsWith(`요청: ${squash(prompt).slice(0, 60)}`), JSON.stringify(context));
}

// --- scenario plumbing ---

class Run {
	constructor(name) {
		this.name = name;
		this.checks = [];
		this.api = {};
		this.pty = {};
		this.jsonl = [];
		this.notes = [];
		this.omo = null;
		this.secondOmo = null;
		this.logStart = logSize();
		this.sessionDir = path.join(H.root, "sessions", name);
	}

	check(label, ok, detail = "") {
		this.checks.push({ label, ok: Boolean(ok), detail: String(detail ?? "").slice(0, 500) });
		say(`  ${ok ? "ok  " : "FAIL"} ${label}${detail && !ok ? ` (${String(detail).slice(0, 300)})` : ""}`);
	}

	note(text) {
		this.notes.push(text);
		say(`  note ${text}`);
	}

	snap(label, value) {
		this.api[label] = value;
	}

	screen(label) {
		if (this.omo) this.pty[label] = this.omo.visible();
	}

	excerpt(label, entries) {
		this.jsonl.push({ label, entries });
	}

	get passed() {
		return this.checks.length > 0 && this.checks.every((entry) => entry.ok);
	}

	async open({ cwd = H.work, extra = [], extensions = BASE_EXTENSIONS, env = {}, deleteEnv = [] } = {}) {
		fs.mkdirSync(this.sessionDir, { recursive: true });
		this.omo = new OmoPty({
			cwd,
			sessionDir: this.sessionDir,
			env: { ...H.omoEnv, ...env },
			extensions,
			extra,
			deleteEnv,
		}).start();
		await this.omo.waitForScreen((visible) => /❯/.test(visible), 90000, "the omo prompt");
		this.screen("start");
		return this.omo;
	}

	/** Types a prompt, then waits for the transcript to name the session. */
	async prompt(text) {
		await this.omo.prompt(text);
		this.sid = await until(() => readTranscript(this.sessionDir).sid, 30000, "the session jsonl appears");
		return this.sid;
	}

	transcript() {
		return readTranscript(this.sessionDir);
	}

	/** The newest open question item whose request matches `waitForAnswer`. */
	async waitQuestion(waitForAnswer) {
		return until(async () => (await itemsOf(this.sid, "question")).find((item) => item.status === "open" && item.raw?.request?.waitForAnswer === waitForAnswer), 90000, `an open question item (waitForAnswer ${waitForAnswer})`, { retryable: true });
	}

	async waitItem(kind, pickFn = () => true, timeoutMs = 90000) {
		return until(async () => (await itemsOf(this.sid, kind)).find((item) => item.status === "open" && pickFn(item)), timeoutMs, `an open ${kind} item`, { retryable: true });
	}

	async deliveredHow(itemId, timeoutMs) {
		return until(async () => {
			const view = await threadView(this.sid);
			const event = eventsFor(view, itemId, "delivered")[0];
			return event ? event.how : null;
		}, timeoutMs, `a delivered event for ${itemId}`);
	}

	async finish() {
		this.screen("final");
		if (this.secondOmo) {
			this.pty.newSessionFull = this.secondOmo.full();
			await this.secondOmo.stop();
		}
		if (this.omo) {
			this.pty.finalFull = this.omo.full();
			const transcript = this.transcript();
			this.excerpt("tool and user messages", messagesOf(transcript.entries)
				.filter((message) => message.role !== "assistant" || textOf(message).trim())
				.filter((message) => message.toolName !== "todo")
				.map((message) => ({ role: message.role, toolName: message.toolName, at: message.at, text: textOf(message).slice(0, 600), details: message.role === "toolResult" ? message.details : undefined })));
			await this.omo.stop();
		}
		if (this.sid) this.snap("finalThread", await threadView(this.sid));
		this.snap("pushSink", sinkEntries());
		const id = this.name;
		evidence(`${EVIDENCE_PREFIX}-${id}-checks.txt`, `${id} ${this.passed ? "PASS" : "FAIL"}\n${this.checks.map((entry) => `${entry.ok ? "ok  " : "FAIL"} ${entry.label}${entry.detail ? ` :: ${entry.detail}` : ""}`).join("\n")}\n${this.notes.map((line) => `note ${line}`).join("\n")}\n`);
		evidence(`${EVIDENCE_PREFIX}-${id}-pty.txt`, Object.entries(this.pty).map(([label, text]) => `===== ${label} =====\n${text}`).join("\n\n") + "\n");
		evidence(`${EVIDENCE_PREFIX}-${id}-jsonl.txt`, this.jsonl.map((part) => `===== ${part.label} =====\n${part.entries.map((entry) => JSON.stringify(entry)).join("\n")}`).join("\n\n") + "\n");
		evidence(`${EVIDENCE_PREFIX}-${id}-api.json`, this.api);
		evidence(`${EVIDENCE_PREFIX}-${id}-verdicts.txt`, `${verdictsOf(this).join("\n")}\n`);
	}
}

const askPrompt = (waitForAnswer) => `ask_user_question 도구를 정확히 한 번 호출해. waitForAnswer는 ${waitForAnswer}, required는 false, 질문 하나(header: 색, question: 무슨 색을 좋아해?), 선택지 빨강과 파랑(multiSelect false). ${waitForAnswer ? "답을 받으면 한 줄로 '선택: <라벨>' 이라고만 답해." : "질문 후에는 '질문했음' 한 줄만 답하고 끝내."}`;
const greetingPrompt = "도구를 쓰지 말고 '안녕하세요, 준비됐습니다.' 한 줄로만 답해.";
const answerBody = (item, label) => ({ answers: { [item.raw.request.questions[0].id]: { selected: [label] } } });

const ANSWER_FRAME = "[Answer to question";
const LATE_FRAME = "[omo-inbox] 폰에서 늦게 온 답";

// --- scenarios ---

async function s1(t) {
	await t.open();
	await t.prompt(askPrompt(true));
	const question = await t.waitQuestion(true);
	t.snap("questionOpen", question);
	await until(() => OVERLAY.test(t.omo.visible()), 15000, "the ask overlay on screen");
	t.screen("overlay");
	await checkFirstRequest(t, askPrompt(true), question.id);
	t.check("open question item shows both options", JSON.stringify(question.raw.request.questions[0].options).includes("빨강") && JSON.stringify(question.raw.request.questions[0].options).includes("파랑"));
	const startedAt = Date.now();
	const answer = await api("POST", `/api/items/${question.id}/answer`, answerBody(question, "파랑"));
	t.snap("answerResponse", answer);
	t.check("POST answer 파랑 returns 200", answer.status === 200, JSON.stringify(answer));
	const result = await until(() => toolResults(t.transcript().entries, "ask_user_question")[0], 15000, "the ask_user_question toolResult");
	t.check("toolResult names 파랑 within 15 s", JSON.stringify(result).includes("파랑") && Date.now() - startedAt < 15000, JSON.stringify(result).slice(0, 300));
	t.check("toolResult is resolved by the phone bridge", result.details?.resolvedBy === "omo_inbox", JSON.stringify(result.details?.resolvedBy));
	t.excerpt("ask_user_question toolResult", [result]);
	const how = await t.deliveredHow(question.id, 15000);
	t.check("delivered how=bridge", how === "bridge", how);
	await until(() => !OVERLAY.test(t.omo.visible()), 15000, "the ask overlay leaves the screen");
	t.screen("afterAnswer");
	t.check("overlay is gone from the PTY screen", !OVERLAY.test(t.omo.visible()));
	const closed = await until(async () => (await itemsOf(t.sid, "question")).find((item) => item.id === question.id && item.status === "closed"), 15000, "the question item closes");
	t.snap("questionClosed", closed);
	t.check("item closes answered-phone", closed.closedReason === "answered-phone", closed.closedReason);
}

async function s2(t) {
	await t.open();
	await t.prompt(askPrompt(false));
	const question = await t.waitQuestion(false);
	t.snap("questionOpen", question);
	t.check("async question item has waitForAnswer false", question.raw.request.waitForAnswer === false);
	const answer = await api("POST", `/api/items/${question.id}/answer`, answerBody(question, "파랑"));
	t.snap("answerResponse", answer);
	t.check("POST answer 파랑 returns 200", answer.status === 200, JSON.stringify(answer));
	const framed = await until(() => userMessages(t.transcript().entries).find((message) => textOf(message).startsWith(ANSWER_FRAME) && textOf(message).includes("파랑")), 30000, "the [Answer to question user message");
	t.check("jsonl has the [Answer to question user message naming 파랑", true, textOf(framed).slice(0, 300));
	t.excerpt("answer frame", [{ role: framed.role, text: textOf(framed), at: framed.at }]);
	const how = await t.deliveredHow(question.id, 15000);
	t.check("delivered how=bridge", how === "bridge", how);
	await until(() => !OVERLAY.test(t.omo.visible()), 15000, "the ask overlay leaves the screen");
	t.check("overlay is gone from the PTY screen", !OVERLAY.test(t.omo.visible()));
	const after = await until(() => messagesOf(t.transcript().entries).find((message) => message.role === "assistant" && message.at > framed.at && textOf(message).includes("파랑")), 60000, "an assistant reply that uses the answer").catch(() => null);
	t.note(`assistant reply after the answer: ${after ? textOf(after).slice(0, 120) : "none seen"}`);
}

async function s3(t) {
	await t.open();
	await t.prompt(askPrompt(true));
	const question = await t.waitQuestion(true);
	t.snap("questionOpen", question);
	await until(() => OVERLAY.test(t.omo.visible()), 15000, "the ask overlay on screen");
	t.screen("overlay");
	t.omo.type("1");
	const closed = await until(async () => (await itemsOf(t.sid, "question")).find((item) => item.id === question.id && item.status === "closed"), 20000, "the question item closes after the terminal answer");
	t.snap("questionClosed", closed);
	t.check("item closes answered-terminal", closed.closedReason === "answered-terminal", closed.closedReason);
	const result = await until(() => toolResults(t.transcript().entries, "ask_user_question")[0], 15000, "the ask_user_question toolResult");
	t.excerpt("ask_user_question toolResult", [result]);
	t.check("toolResult names 빨강 (option 1) and was answered locally", JSON.stringify(result).includes("빨강") && result.details?.resolvedBy === "local_ui", JSON.stringify(result.details?.resolvedBy));
	const late = await api("POST", `/api/items/${question.id}/answer`, answerBody(question, "파랑"));
	t.snap("lateAnswerResponse", late);
	t.check("a later phone answer gets 409 closed with the reason", late.status === 409 && late.body?.error === "closed" && late.body?.reason === "answered-terminal", JSON.stringify(late));
	const view = await threadView(t.sid);
	t.check("no answer event was stored for the phone", (view.events ?? []).filter((event) => event.type === "answer" && event.itemId === question.id).length === 0);
}

async function s4(t) {
	await t.open();
	await t.prompt(greetingPrompt);
	const turn = await t.waitItem("turn", (item) => item.policy === "needs-you", 90000);
	t.snap("turnOpen", turn);
	await checkFirstRequest(t, greetingPrompt, turn.id);
	t.check("turn item is needs-you with a summary", turn.summary?.summary?.headline, JSON.stringify(turn.summary).slice(0, 300));
	const summaryStart = Date.now();
	const modelled = await until(async () => (await itemsOf(t.sid, "turn")).find((item) => item.id === turn.id && item.summary?.source === "model"), 90000, "the turn summary source becomes model").catch(() => null);
	const current = modelled ?? (await itemsOf(t.sid, "turn")).find((item) => item.id === turn.id) ?? turn;
	t.check("the turn summary source becomes model within 90 s", Boolean(modelled), `source ${current.summary?.source ?? "?"} after ${Date.now() - summaryStart} ms`);
	t.note(`summary source: ${current.summary?.source ?? "?"}, model ${current.summary?.model ?? "?"}, ${Date.now() - summaryStart} ms after the heuristic appeared`);
	const extensionLog = path.join(H.home, "logs", "extension.log");
	const latencyLine = (fs.existsSync(extensionLog) ? fs.readFileSync(extensionLog, "utf8") : "")
		.split("\n")
		.filter((line) => /summarize: .+: answered in \d+ ms/.test(line))
		.at(-1) ?? "";
	const latency = /summarize: (.+): answered in (\d+) ms/.exec(latencyLine);
	t.note(`extension.log summary latency: ${latencyLine || "(none)"}`);
	t.check("extension.log names the winning model", Boolean(latency) && latency[1] === current.summary?.model, latency?.[1] ?? "none");
	t.check("the winning model answered in under 60 s", Boolean(latency) && Number(latency[2]) < 60000, latency?.[2] ?? "none");
	t.snap("turnSummary", current);
	const before = messagesOf(t.transcript().entries).length;
	const text = "고마워 이제 끝내자";
	const answer = await api("POST", `/api/items/${turn.id}/answer`, { text });
	t.snap("answerResponse", answer);
	t.check("POST answer text returns 200", answer.status === 200, JSON.stringify(answer));
	const message = await until(() => userMessages(t.transcript().entries).find((entry) => textOf(entry).includes(text)), 20000, "the phone text as a user message");
	t.check("jsonl gets the answer as an omo-inbox delivery", message.viaDelivery === true && message.sender?.platform === "omo-inbox", JSON.stringify(message.sender));
	const reply = await until(() => messagesOf(t.transcript().entries).find((entry) => entry.role === "assistant" && entry.at > message.at && textOf(entry).trim()), 60000, "a new assistant turn after the answer");
	t.check("a new assistant turn follows", Boolean(reply), reply ? textOf(reply).slice(0, 120) : "");
	t.excerpt("answer and reply", [{ role: message.role, text: textOf(message), at: message.at }, { role: reply.role, text: textOf(reply), at: reply.at }]);
	const how = await t.deliveredHow(turn.id, 15000);
	t.check("delivered how=message", how === "message", how);
	void before;
}

async function s5(t) {
	await t.open({ extra: ["--permission-preset", "ask", "--tools", "bash"], extensions: [...BASE_EXTENSIONS, "builtin:permission-system"] });
	await t.prompt("bash 도구로 `echo hi` 를 실행하고 출력만 한 줄로 알려줘.");
	const permission = await t.waitItem("permission", () => true, 90000);
	t.snap("permissionOpen", permission);
	await until(() => PERMISSION_DIALOG.test(t.omo.visible()), 15000, "the permission dialog on screen");
	t.screen("dialog");
	t.check("permission item carries the dialog options", JSON.stringify(permission.raw?.dialog?.options ?? []).includes("Allow once"), JSON.stringify(permission.raw?.dialog));
	const answer = await api("POST", `/api/items/${permission.id}/answer`, { choice: "Allow once" });
	t.snap("answerResponse", answer);
	t.check("POST answer Allow once returns 200", answer.status === 200, JSON.stringify(answer));
	const how = await t.deliveredHow(permission.id, 15000);
	t.check("delivered how=bridge", how === "bridge", how);
	const result = await until(() => toolResults(t.transcript().entries, "bash").find((message) => /\bhi\b/.test(textOf(message))), 30000, "a bash toolResult with hi");
	t.check("the tool ran: bash toolResult contains hi", true, textOf(result).slice(0, 200));
	t.excerpt("bash toolResult", [{ role: result.role, toolName: result.toolName, text: textOf(result), at: result.at }]);
	await until(() => !PERMISSION_DIALOG.test(t.omo.visible()), 15000, "the permission dialog leaves the screen");
	t.check("permission dialog is gone from the PTY screen", !PERMISSION_DIALOG.test(t.omo.visible()));
}

async function s6(t) {
	// Part A: a question answered in the terminal inside the 15 s hold-off never pushes.
	await t.open();
	await t.prompt(askPrompt(true));
	const question = await t.waitQuestion(true);
	await until(() => OVERLAY.test(t.omo.visible()), 15000, "the ask overlay on screen");
	const created = Date.parse(question.createdAt);
	t.omo.type("1");
	const closed = await until(async () => (await itemsOf(t.sid, "question")).find((item) => item.id === question.id && item.status === "closed"), 20000, "the question closes");
	const answeredAfter = Date.now() - created;
	t.check("the terminal answered inside the 15 s hold", answeredAfter < 15000, `${answeredAfter} ms after creation`);
	t.check("item closed answered-terminal", closed.closedReason === "answered-terminal", closed.closedReason);
	await sleep(Math.max(0, created + 20000 - Date.now()));
	const partA = sinkFor(question.id);
	t.snap("partA", { itemId: question.id, createdAt: question.createdAt, pushes: partA });
	t.check("push sink has no entry for the terminal-answered question (20 s after creation)", partA.length === 0, JSON.stringify(partA));
	// Part B: a plain turn end with no terminal input pushes exactly once, after the 30 s hold. While the model summary is
	// still the heuristic one the push waits up to 30 s more (policy.mjs SUMMARY_WAIT_MS), so it lands 30-60 s after creation.
	const HOLD_MS = 30000;
	const SUMMARY_WAIT_MS = 30000;
	const turnFor = async () => (await itemsOf(t.sid, "turn")).find((item) => item.policy === "needs-you" && item.status === "open");
	const turn = await until(turnFor, 90000, "the open turn item after the answered question", { retryable: true });
	const turnCreated = Date.parse(turn.createdAt);
	await sleep(Math.max(0, turnCreated + 22000 - Date.now()));
	const early = sinkFor(turn.id);
	t.check("no push for the turn 22 s after it was created (30 s hold)", early.length === 0, JSON.stringify(early));
	await until(() => sinkFor(turn.id).length > 0, HOLD_MS + SUMMARY_WAIT_MS + 15000 - Math.max(0, Date.now() - turnCreated), "the turn push reaches the sink").catch(() => null);
	const late = sinkFor(turn.id);
	t.snap("partB", { itemId: turn.id, createdAt: turn.createdAt, pushes: late });
	t.check("push sink has exactly one entry for the turn", late.length === 1, JSON.stringify(late));
	const pushedAfter = late[0] ? Date.parse(late[0].at) - turnCreated : -1;
	t.check("the push fired at or after the 30 s hold and within hold + summary wait", pushedAfter >= HOLD_MS - 1000 && pushedAfter <= HOLD_MS + SUMMARY_WAIT_MS + 5000, `${pushedAfter} ms after creation`);
	t.check("the push payload links to the thread item", late[0]?.payload?.url === `/s/${t.sid}#${turn.id}` && late[0]?.payload?.tag === `s-${t.sid}`, JSON.stringify(late[0]?.payload));
	await sleep(5000);
	t.check("still exactly one entry after another 5 s", sinkFor(turn.id).length === 1);
}

async function s7(t) {
	await t.open();
	await t.prompt("안녕, 준비 됐니? 도구 없이 한 줄로 답해.");
	await until(async () => (await threadView(t.sid)) !== null, 30000, "the thread exists on the server");
	const firstTurn = await t.waitItem("turn", () => true, 90000);
	t.snap("firstTurn", firstTurn);
	// The first turn proved the pipe works. Now: server down, a second turn ends, server comes back.
	await stopServer();
	t.check("server is down", (await health()) === null);
	const userCount = userMessages(t.transcript().entries).length;
	await t.omo.prompt("도구 없이 '두 번째 답입니다.' 한 줄로만 답해.");
	await until(() => userMessages(t.transcript().entries).length > userCount && messagesOf(t.transcript().entries).some((message) => message.role === "assistant" && textOf(message).includes("두 번째 답입니다")), 60000, "the second assistant reply while the server is down", { retryable: true });
	const downAt = Date.now();
	const footerDown = await until(() => t.omo.visible().includes("Inbox 서버 꺼짐"), 35000, "the footer shows Inbox 서버 꺼짐").catch(() => false);
	t.screen("serverDown");
	t.note(`S7 footer delay: ${footerDown === true ? `${Date.now() - downAt} ms` : "not seen"} from the second reply to Inbox 서버 꺼짐`);
	t.check("footer shows Inbox 서버 꺼짐 while the server is down", footerDown === true && Date.now() - downAt <= 35000, `${Date.now() - downAt} ms after the second reply; footer: ${t.omo.visible().split("\n").slice(-2).join(" | ")}`);
	await startServer();
	const restartedAt = Date.now();
	// Episode flow: a final carries its text in raw.final, which the thread GET omits; the episode GET serves it.
	const second = await until(async () => {
		for (const item of await itemsOf(t.sid, "turn")) {
			if (item.id !== firstTurn.id && (await episodeTextOf(t.sid, item)).includes("두 번째 답입니다")) return item;
		}
		return null;
	}, 30000, "the second turn item appears within 30 s of the restart");
	t.snap("secondTurn", second);
	t.check("the missed turn item appears after the server restart", Boolean(second), `${Date.now() - restartedAt} ms after restart`);
	t.check("it appeared within 30 s", Date.now() - restartedAt < 30000, `${Date.now() - restartedAt} ms`);
	t.check("the first turn survived the restart", (await itemsOf(t.sid, "turn")).some((item) => item.id === firstTurn.id));
	const recovered = await until(() => /🙋/.test(t.omo.visible()) && !t.omo.visible().includes("Inbox 서버 꺼짐"), 45000, "the footer returns to a 🙋 count").catch(() => false);
	t.screen("serverBack");
	t.check("footer recovers after the restart", recovered === true, t.omo.visible().split("\n").slice(-2).join(" | "));
}

/**
 * Reload (C8): a blocking question's overlay is modal and swallows typed text, so `/reload` can only be typed while a
 * question is pending without an overlay: an async one (waitForAnswer false). After the reload the builtin reattaches
 * it to the terminal without our wrapper, so the item must say terminal-only, a phone answer becomes the late message,
 * and the terminal can still answer it.
 */
async function s8(t) {
	await t.open();
	await t.prompt(askPrompt(false));
	const question = await t.waitQuestion(false);
	t.snap("questionOpen", question);
	const live = await until(async () => (await itemsOf(t.sid, "question")).find((item) => item.id === question.id && item.bridge === "live"), 15000, "bridge state live before the reload").catch(() => null);
	t.check("before the reload the item bridge state is live", live?.bridge === "live", JSON.stringify(live?.bridge));
	// A running tool shows "Running <tool> (… esc to interrupt)" without "Working"; /reload during it is refused.
	await until(() => !OVERLAY.test(t.omo.visible()) && !/Working|esc to interrupt/.test(t.omo.visible()), 60000, "the agent turn ended with the editor free", { retryable: true });
	t.screen("beforeReload");
	await t.omo.prompt("/reload");
	const detached = await until(async () => (await itemsOf(t.sid, "question")).find((item) => item.id === question.id && item.bridge === "terminal-only"), 45000, "bridge state terminal-only after the reload").catch(() => null);
	t.screen("afterReload");
	t.snap("afterReload", detached);
	t.check("after /reload the item bridge state is terminal-only", detached?.bridge === "terminal-only", JSON.stringify((await itemsOf(t.sid, "question")).find((item) => item.id === question.id)?.bridge));
	t.check("the question item is still open after the reload", detached?.status === "open", detached?.status);
	const answer = await api("POST", `/api/items/${question.id}/answer`, answerBody(question, "파랑"));
	t.snap("answerResponse", answer);
	t.check("POST answer 파랑 returns 200", answer.status === 200, JSON.stringify(answer));
	const how = await t.deliveredHow(question.id, 20000);
	t.check("delivered how=late-message", how === "late-message", how);
	const late = await until(() => userMessages(t.transcript().entries).find((message) => textOf(message).startsWith(LATE_FRAME)), 30000, "the late-answer user message");
	t.check("jsonl has the [omo-inbox] late answer naming 파랑", textOf(late).includes("파랑"), textOf(late).slice(0, 200));
	t.check("the late answer is an omo-inbox delivery, not the [Answer to question frame", late.viaDelivery === true && late.sender?.platform === "omo-inbox" && !textOf(late).startsWith(ANSWER_FRAME), JSON.stringify(late.sender));
	t.excerpt("late answer", [{ role: late.role, text: textOf(late), at: late.at }]);
	// The question is still pending in the terminal: alt+a opens it, option 1 answers it.
	await until(() => !/Working|esc to interrupt/.test(t.omo.visible()), 90000, "the turn started by the late message ended", { retryable: true });
	t.omo.type("\x1ba");
	await until(() => OVERLAY.test(t.omo.visible()), 15000, "the pending question opens in the terminal");
	t.screen("terminalOverlay");
	t.omo.type("1");
	const framed = await until(() => userMessages(t.transcript().entries).find((message) => textOf(message).startsWith(ANSWER_FRAME) && textOf(message).includes("빨강")), 30000, "the [Answer to question user message naming 빨강");
	t.check("the terminal still answers it: jsonl has the [Answer to question message naming 빨강", true, textOf(framed).slice(0, 300));
	t.excerpt("terminal answer frame", [{ role: framed.role, text: textOf(framed), at: framed.at }]);
	await until(() => !OVERLAY.test(t.omo.visible()), 15000, "the ask overlay leaves the screen");
	t.check("overlay is gone from the PTY screen", !OVERLAY.test(t.omo.visible()));
	t.screen("afterTerminalAnswer");
	const closed = await until(async () => (await itemsOf(t.sid, "question")).find((item) => item.id === question.id && item.status === "closed"), 8000, "the question item closes").catch(() => null);
	t.snap("questionAfterTerminalAnswer", closed ?? (await itemsOf(t.sid, "question")).find((item) => item.id === question.id));
	t.check("after the terminal answer the item closes answered-terminal", closed?.closedReason === "answered-terminal", JSON.stringify(closed?.closedReason));
}

/**
 * Steer (C8): a free message sent while the agent is inside a long bash command is admitted as a steer, so the
 * session_control_delivery entry lands in the transcript before that turn's final reply instead of after it.
 */
async function s9(t) {
	// A plain `sleep` is detached by the bash tool's wait heuristic, so the command busy-waits for 25 s in the foreground instead.
	await t.open({ extra: ["--tools", "bash"] });
	await t.prompt("bash 도구로 `node -e \"const t=Date.now();while(Date.now()-t<25000);console.log('done')\"` 를 정확히 그대로 실행하고, 끝나면 '완료' 한 줄로만 답해. 다른 도구는 쓰지 마.");
	const isBashCall = (message) => message.role === "assistant" && (message.content ?? []).some((part) => part.type === "toolCall" && part.name === "bash");
	await until(() => {
		const messages = messagesOf(t.transcript().entries);
		const call = messages.findIndex(isBashCall);
		return call >= 0 && !messages.slice(call).some((message) => message.role === "toolResult" && message.toolName === "bash");
	}, 90000, "the agent is inside the long bash command", { retryable: true });
	await until(async () => (await threadView(t.sid)) !== null, 30000, "the thread exists on the server");
	t.screen("duringSleep");
	const response = await api("POST", `/api/threads/${encodeURIComponent(t.sid)}/message`, { text: "멈춰" });
	t.snap("messageResponse", response);
	t.check("POST /message returns 200", response.status === 200, JSON.stringify(response));
	const delivery = await until(() => t.transcript().entries.find((entry) => entry.type === "custom_message" && entry.customType === "session_control_delivery" && String(entry.content).includes("멈춰")), 30000, "the session_control_delivery entry for 멈춰");
	const entries = t.transcript().entries;
	t.excerpt("delivery entry", [delivery]);
	t.check("the delivery entry says deliverAs steer", /"deliverAs"\s*:\s*"steer"/.test(JSON.stringify(delivery)), JSON.stringify(delivery).slice(0, 400));
	// The turn that ran the sleep: from the assistant message with the bash call to its final assistant message without a tool call.
	const messages = entries.filter((entry) => entry.type === "message" || entry.id === delivery.id);
	const deliveryAt = messages.findIndex((entry) => entry.id === delivery.id);
	const callAt = messages.findIndex((entry) => entry.type === "message" && isBashCall(entry.message));
	const finalBefore = messages.slice(callAt + 1, deliveryAt).some((entry) => entry.message?.role === "assistant" && !isBashCall(entry.message) && textOf(entry.message).trim());
	t.check("the steer is recorded before the turn's final reply (not after the turn ended)", callAt >= 0 && deliveryAt > callAt && !finalBefore, `bash call at ${callAt}, delivery at ${deliveryAt}, a final reply came first: ${finalBefore}`);
	const how = await t.deliveredHow(response.body?.itemId, 20000).catch(() => null);
	t.check("the server records the message delivered", how === "message", how);
}

/** Debug switch INBOX_BRIDGE=off: no bridge, the item says terminal-only answers, the phone answer is a late message. */
async function sBridgeOff(t) {
	await t.open({ env: { INBOX_BRIDGE: "off" } });
	await t.prompt(askPrompt(false));
	const question = await t.waitQuestion(false);
	t.snap("questionOpen", question);
	const withBridge = await until(async () => (await itemsOf(t.sid, "question")).find((item) => item.id === question.id && item.bridge), 15000, "a bridge state on the question item").catch(() => null);
	t.check("item bridge state is none (the phone says 터미널에서 답해 주세요)", withBridge?.bridge === "none", JSON.stringify(withBridge?.bridge));
	const answer = await api("POST", `/api/items/${question.id}/answer`, answerBody(question, "파랑"));
	t.snap("answerResponse", answer);
	t.check("POST answer returns 200", answer.status === 200, JSON.stringify(answer));
	const how = await t.deliveredHow(question.id, 20000);
	t.check("delivered how=late-message", how === "late-message", how);
	const late = await until(() => userMessages(t.transcript().entries).find((message) => textOf(message).startsWith(LATE_FRAME)), 30000, "the late-answer user message");
	t.check("jsonl has the [omo-inbox] late answer naming 파랑", textOf(late).includes("파랑"), textOf(late).slice(0, 200));
	t.check("the late answer is an omo-inbox delivery, not the [Answer to question frame", late.viaDelivery === true && late.sender?.platform === "omo-inbox" && !textOf(late).startsWith(ANSWER_FRAME), JSON.stringify(late.sender));
	t.excerpt("late answer", [{ role: late.role, text: textOf(late), at: late.at }]);
}

/**
 * Reload right after a turn end (seen live on the keepwarm session): the settle wait is 2.5 s, so a /reload sent
 * the moment the turn ends drops the old copy's classification. The reloaded copy must still post exactly one
 * needs-you turn item for that reply, and the thread must read needs-you, not working.
 */
async function s10(t) {
	const phrase = "열 번째 시나리오 답입니다";
	await t.open();
	await t.prompt(`다른 도구 쓰지 말고 '${phrase}' 한 줄로만 답해.`);
	const reply = await until(() => messagesOf(t.transcript().entries).find((message) => message.role === "assistant" && textOf(message).includes(phrase)), 90000, "the assistant reply", { retryable: true, everyMs: 50 });
	await until(() => !OVERLAY.test(t.omo.visible()) && !/Working|esc to interrupt/.test(t.omo.visible()), 30000, "the turn ended with the editor free", { everyMs: 50 });
	const reloadAt = Date.now();
	await t.omo.prompt("/reload");
	t.note(`S10 /reload sent ${reloadAt - Date.parse(reply.at)} ms after the reply was written`);
	t.screen("afterReload");
	// Episode flow: the reply is in the final's episode (raw.final / line text), served only by the episode GET.
	const turnFor = async () => {
		const found = [];
		for (const item of await itemsOf(t.sid, "turn")) if ((await episodeTextOf(t.sid, item)).includes(phrase)) found.push(item);
		return found;
	};
	// A restored episode waits out the 60 s reload grace (README, Capture) before its flip closes it.
	const posted = await until(async () => (await turnFor()).find((item) => item.policy === "needs-you" && item.status === "open"), 100000, "the needs-you turn item after the reload").catch(() => null);
	if (posted) t.note(`S10 final created ${Date.parse(posted.createdAt) - reloadAt} ms after the reload`);
	t.snap("turnAfterReload", posted);
	t.check("a needs-you turn item for the reply exists after the reload", Boolean(posted), JSON.stringify(posted?.dedupeKey ?? null));
	const extensionLog = path.join(H.home, "logs", "extension.log");
	const logText = fs.existsSync(extensionLog) ? fs.readFileSync(extensionLog, "utf8") : "";
	t.note(`S10 recovery path ran: ${logText.includes("re-armed the turn end a reload dropped")}`);
	const all = await turnFor();
	t.check("exactly one turn item for that reply (no duplicate across the reload)", all.length === 1, JSON.stringify(all.map((item) => item.dedupeKey)));
	const view = await threadView(t.sid);
	t.check("the thread reads needs-you, not working", view?.thread?.status === "needs-you", JSON.stringify(view?.thread?.status));
}

/** Closing a session (decision board 261019-uzq7): /quit closes its open turn item as session-closed and the thread reads ended. */
async function s11(t) {
	await t.open();
	await t.prompt(greetingPrompt);
	const turn = await t.waitItem("turn", (item) => item.policy === "needs-you", 90000);
	t.snap("turnOpen", turn);
	await until(() => !OVERLAY.test(t.omo.visible()) && !/Working|esc to interrupt/.test(t.omo.visible()), 30000, "the turn ended with the editor free");
	await t.omo.prompt("/quit");
	const closed = await until(async () => (await itemsOf(t.sid, "turn")).find((item) => item.id === turn.id && item.status === "closed"), 20000, "the turn item closes after /quit").catch(() => null);
	t.snap("turnAfterQuit", closed);
	t.check("after /quit the open turn item closes as session-closed", closed?.closedReason === "session-closed", JSON.stringify(closed?.closedReason ?? null));
	const view = await threadView(t.sid);
	t.check("the thread reads ended (끝남), not needs-you", view?.thread?.status === "ended", JSON.stringify(view?.thread?.status));
}

// ---------------------------------------------------------------------------------------------
// Episode flow (plan todo 16): S12-S24. One owner request = one gray line per assistant message + one final report.
// Waits run on real background jobs (qa-job.mjs, written into the work dir) and a monitor, never on the model's say-so.
// ---------------------------------------------------------------------------------------------

const DEFAULT_STALL_MS = 600000;
const NEW_EXTENSIONS = [...BASE_EXTENSIONS, "builtin:terminal"];
// A background job is a wait whether the model starts it as a background shell or as a detached eval cell (IS-4).
const WAIT_BG = /capture: line-only - wait=\S*(terminal-background-sessions|senpi-codemode)/;
const WAIT_MONITOR = /capture: line-only - wait=\S*terminal-monitors/;
const fwd = (value) => String(value).replace(/\\/g, "/");
const code = (text) => `\`${text}\``;
const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
const isFinal = (item) => Boolean(item?.meta?.episode?.closeReason);

const jobCommand = (seconds, label, pidFile) => `node ${fwd(path.join(H.work, "qa-job.mjs"))} ${seconds} ${label}${pidFile ? ` ${fwd(pidFile)}` : ""}`;
const bgJob = (seconds, label, pidFile) => `bash 도구를 run_in_background: true 로 호출해 ${code(jobCommand(seconds, label, pidFile))} 를 실행해`;
/** A goal objective that runs `count` background jobs one after the other and completes the goal at the end. */
const chainGoal = (count, seconds, tag) => {
	const jobs = Array.from({ length: count }, (_, index) => code(jobCommand(seconds, `${tag}${index + 1}`))).join(", ");
	return `세션 QA 목표: 백그라운드 작업 ${count}개를 차례로 실행한다. 각각 bash 도구를 run_in_background: true 로 호출해서 ${jobs} 순서로 하나씩 실행한다. 작업 하나를 시작하면 다른 도구를 쓰지 말고 '단계 대기 중' 한 줄만 말한 뒤 턴을 끝낸다. 작업 완료 알림이 오면 다음 작업을 시작한다. 마지막 작업까지 끝나면 update_goal 로 목표를 complete 처리하고 '모두 끝' 한 줄로 답한다.`;
};

/** The mode the extension reads from config.json when it loads (the server treats a missing mode as primary). */
function setMode(mode) {
	fs.writeFileSync(path.join(H.home, "config.json"), JSON.stringify(mode ? { ...H.config, mode } : H.config));
}

/** Restart the server with another INBOX_EPISODE_STALL_MS (state lives in the home, so threads survive). */
async function setStall(ms) {
	if (H.stallMs === ms) return;
	await stopServer();
	H.serverEnv.INBOX_EPISODE_STALL_MS = String(ms);
	H.stallMs = ms;
	await startServer();
}

async function episodeOf(sid, key) {
	const response = await api("GET", `/api/threads/${encodeURIComponent(sid)}/episodes/${encodeURIComponent(key)}`);
	return response.status === 200 ? response.body : null;
}

/** Every message text of the item's episode (lines + final), or the item's own text when it has no episode. */
async function episodeTextOf(sid, item) {
	const key = item.meta?.episode?.key;
	if (!key) return String(item.raw?.text ?? "");
	const episode = await episodeOf(sid, key);
	return [...(episode?.lines ?? []).map((line) => line.text), episode?.final?.text].filter(Boolean).join("\n");
}

const threadItems = async (t) => (await threadView(t.sid))?.items ?? [];
const finalsOf = async (t) => (await threadItems(t)).filter(isFinal).sort(byCreated);
const linesOf = async (t) => (await threadItems(t)).filter((item) => item.kind === "progress").sort(byCreated);
const waitFinals = (t, count, timeoutMs) => until(async () => {
	const found = await finalsOf(t);
	return found.length >= count ? found : null;
}, timeoutMs, `${count} episode final(s)`, { retryable: true, everyMs: 1000 });
const waitVerdict = (t, pattern, count, timeoutMs) => until(() => {
	const hits = verdictsOf(t).filter((line) => pattern.test(line));
	return hits.length >= count ? hits : null;
}, timeoutMs, `${count} verdict log line(s) matching ${pattern}`, { retryable: true, everyMs: 500 });
const editorFree = (t, timeoutMs = 60000) => until(() => !OVERLAY.test(t.omo.visible()) && !/Working|esc to interrupt/.test(t.omo.visible()), timeoutMs, "the turn ended with the editor free", { retryable: true });

/** Thread pushes of one session (not board pushes, not cache reminders). */
const threadPushes = (sid) => sinkEntries().filter((entry) => entry.payload?.tag === `s-${sid}` && String(entry.payload?.url ?? "").startsWith("/s/") && !String(entry.payload?.title ?? "").startsWith("🔥"));
const pushesBefore = (sid, item) => threadPushes(sid).filter((entry) => Date.parse(entry.at) < Date.parse(item.createdAt));

/** Waits (bounded) until `expected` pushes exist, then 8 s more so an extra push would show; returns the final list. */
async function settlePushes(t, expected) {
	if (expected > 0) await until(() => threadPushes(t.sid).length >= expected, 120000, `${expected} thread push(es) for the session`).catch(() => null);
	await sleep(8000);
	return threadPushes(t.sid);
}

function checkPushes(t, label, final, pushes, expected) {
	t.check(`${label}: no push before the final exists`, pushesBefore(t.sid, final).length === 0, JSON.stringify(pushesBefore(t.sid, final).map((entry) => entry.payload?.itemId)));
	t.check(`${label}: exactly ${expected} thread push(es) in total`, pushes.length === expected, JSON.stringify(pushes.map((entry) => ({ itemId: entry.payload?.itemId, at: entry.at }))));
	t.snap(`${label}-pushes`, pushes);
}

/** The episode GET against the transcript: every assistant message with text of the span must be in it. */
async function checkEpisode(t, label, finalItem, { exactLines = false } = {}) {
	const meta = finalItem.meta.episode;
	const episode = await episodeOf(t.sid, meta.key);
	t.snap(`${label}-episode`, episode);
	t.check(`${label}: the episode GET answers for ${meta.key}`, episode !== null);
	if (episode === null) return null;
	const messages = messagesOf(t.transcript().entries).filter((message) => message.role === "assistant" && textOf(message).trim() && Date.parse(message.at) >= meta.openedAt - 2000 && Date.parse(message.at) <= meta.closedAt + 3000);
	const haystack = squash([...episode.lines.map((line) => line.text), episode.final?.text].join(" "));
	// 40 chars only: the episode GET redacts paths (C:/Users/...) that a longer prefix of the transcript text may contain.
	const missing = messages.filter((message) => !haystack.includes(squash(textOf(message)).slice(0, 40)));
	t.check(`${label}: the episode GET holds every assistant message of the span (${messages.length})`, messages.length > 0 && missing.length === 0, JSON.stringify(missing.map((message) => textOf(message).slice(0, 60))));
	if (exactLines) {
		t.check(`${label}: one line per assistant message plus the final`, episode.lines.length + (episode.final ? 1 : 0) === messages.length, `${episode.lines.length} lines + final ${Boolean(episode.final)} vs ${messages.length} messages`);
	}
	return { episode, meta, messages };
}

async function s12(t) {
	await t.open({ extensions: NEW_EXTENSIONS });
	await t.prompt(`/goal ${chainGoal(3, 25, "A")}`);
	const waits = await waitVerdict(t, WAIT_BG, 3, 330000);
	t.check("three turn ends read as waiting on terminal-background-sessions", waits.length >= 3, `${waits.length}`);
	const [final] = await waitFinals(t, 1, 240000);
	t.snap("final", final);
	const pushes = await settlePushes(t, 1);
	checkPushes(t, "S12", final, pushes, 1);
	t.check("S12: the single push is the final", pushes[0]?.payload?.itemId === final.id, JSON.stringify(pushes[0]?.payload?.itemId));
	t.check("S12: exactly one final in the thread", (await finalsOf(t)).length === 1);
	t.check("S12: the last verdict is a close, every earlier one a line-only", verdictsOf(t).slice(0, -1).every((line) => /line-only/.test(line)) && /capture: close /.test(verdictsOf(t).at(-1) ?? ""), JSON.stringify(verdictsOf(t).slice(-3)));
	await checkEpisode(t, "S12", final, { exactLines: true });
}

/** Primary mode: the session waits on its own board (wake source omo-inbox hold); only the board push goes out until the final. */
async function s13(t) {
	setMode("primary");
	const sid = crypto.randomUUID();
	const nonce = crypto.randomBytes(3).toString("hex");
	const title = `QA 보드 ${nonce}`;
	const boardDir = path.join(H.root, "boards", `s13-${nonce}`);
	fs.mkdirSync(boardDir, { recursive: true });
	fs.writeFileSync(path.join(boardDir, "board.json"), JSON.stringify({ title, lead: "세션 QA용 보드입니다.", questions: [{ id: "q1", text: "어느 쪽으로 할까요?", options: [{ value: "a", label: "A안", rec: true, why: "기본입니다." }, { value: "b", label: "B안", why: "대안입니다." }] }] }));
	await t.open({ extensions: NEW_EXTENSIONS, extra: ["--session-id", sid] });
	await t.prompt(`bash 도구로 ${code(`node ${fwd(path.join(REPO, "bin", "inbox.mjs"))} submit ${fwd(boardDir)} --session ${sid}`)} 를 실행해서 보드를 올려. id 가 출력되면 '보드 올림, 답 기다리는 중' 한 줄만 말하고 턴을 끝내. 보드에 대한 답이 후속 메시지로 오면 '답 받음' 한 줄로 답하고 끝내.`);
	t.check("the omo session id is the one the board names", t.sid === sid, `${t.sid} vs ${sid}`);
	const proposal = await until(async () => ((await api("GET", "/api/proposals")).body?.items ?? []).find((item) => JSON.stringify(item).includes(title)), 90000, "the board is submitted", { retryable: true });
	t.snap("proposal", proposal);
	const waits = await waitVerdict(t, /capture: line-only - wait=\S*hold:omo-inbox/, 1, 90000);
	t.check("the turn end reads as waiting on the own board (hold:omo-inbox)", waits.length >= 1, JSON.stringify(waits));
	const boardPush = () => sinkEntries().filter((entry) => String(entry.payload?.url ?? "").includes(`/p/${proposal.id}`));
	await until(() => boardPush().length >= 1, 30000, "the board push reaches the sink");
	t.check("exactly one board push while waiting", boardPush().length === 1, JSON.stringify(boardPush().map((entry) => entry.payload?.title)));
	t.check("no thread push while the board is open", threadPushes(t.sid).length === 0, JSON.stringify(threadPushes(t.sid).map((entry) => entry.payload?.itemId)));
	t.check("no final while the board is open", (await finalsOf(t)).length === 0);
	const answer = await api("POST", `/api/p/${proposal.id}/feedback`, { rev: 1, verdict: "approve", answers: { q1: "a" }, comment: "A안으로 진행해 주세요" });
	t.snap("feedbackResponse", answer);
	t.check("POST board feedback returns 200", answer.status === 200, JSON.stringify(answer));
	const [final] = await waitFinals(t, 1, 240000);
	t.snap("final", final);
	const pushes = await settlePushes(t, 1);
	checkPushes(t, "S13", final, pushes, 1);
	t.check("S13: the board still has exactly one push (own feedback never notifies)", boardPush().length === 1);
	await checkEpisode(t, "S13", final);
}

async function startFakeDesk(boards) {
	const requests = [];
	const server = http.createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		if (req.method === "GET" && String(req.url).startsWith("/api/here")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ waiting: boards(), mine: [], theirs: [], pending: [] }));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: server.address().port,
		requests,
		close: () => new Promise((resolve) => {
			server.closeAllConnections?.();
			server.close(() => resolve());
		}),
	};
}

/** Trial mode with a fake desk (temp home, port 0) that holds a waiting board: the newest line says so; the inbox pushes nothing. */
async function s14(t) {
	const boardTitle = "QA 데스크 보드";
	let boardUrl = "";
	const desk = await startFakeDesk(() => [{ id: "b-qa-desk", title: boardTitle, url: boardUrl, status: "mine", since: new Date().toISOString(), seq: 1 }]);
	boardUrl = `http://127.0.0.1:${desk.port}/p/b-qa-desk`;
	try {
		const deskHome = path.join(H.root, "deskhome");
		fs.mkdirSync(deskHome, { recursive: true });
		fs.writeFileSync(path.join(deskHome, "config.json"), JSON.stringify({ port: desk.port }));
		await t.open({ extensions: NEW_EXTENSIONS, env: { INBOX_DESK_HOME: deskHome } });
		await t.prompt(`${bgJob(40, "D")}. 시작하면 '대기 중' 한 줄만 말하고 턴을 끝내. 완료 알림이 오면 '끝' 한 줄로 답해.`);
		await waitVerdict(t, WAIT_BG, 1, 90000);
		// The background job stands in for desk's own wake source (the desk extension is not loaded); the board comes from the fake desk.
		const waiting = await until(async () => {
			const line = (await linesOf(t)).at(-1);
			return line?.state?.state === "waiting" && (line.state.boards ?? []).length > 0 ? line : null;
		}, 45000, "the newest line waits with the desk board", { retryable: true });
		t.snap("waitingLine", waiting);
		t.check("the newest line state is waiting", waiting.state.state === "waiting");
		t.check("the line carries the desk board title", waiting.state.boards[0].title === boardTitle, JSON.stringify(waiting.state.boards));
		t.check("the line carries the desk board url", waiting.state.boards[0].url === boardUrl, JSON.stringify(waiting.state.boards));
		t.check("no thread push and no desk-board push from the inbox", threadPushes(t.sid).length === 0 && !sinkEntries().some((entry) => JSON.stringify(entry.payload ?? "").includes("b-qa-desk")), JSON.stringify(sinkEntries().map((entry) => entry.payload?.title)));
		t.check("the fake desk saw only GETs without start=1", desk.requests.length > 0 && desk.requests.every((request) => request.startsWith("GET ") && !request.includes("start=1")), JSON.stringify(desk.requests.slice(0, 5)));
		await waitFinals(t, 1, 200000).catch((error) => t.note(`the job's final did not appear: ${error.message}`));
	} finally {
		await desk.close();
	}
}

/**
 * Goal active, the background job's process is killed: the exit wakes the agent, and when it stops with nothing pending
 * the one final is `stalled` (the goal is unfinished). Shared by S15 and S23.
 */
async function goalStallFlow(t) {
	await t.open({ extensions: NEW_EXTENSIONS });
	const pidFile = fwd(path.join(H.work, `${t.name}.pid`));
	fs.rmSync(pidFile, { force: true });
	await t.prompt(`/goal 세션 QA 목표: ${bgJob(600, "K", pidFile)}. 시작하면 '대기 중' 한 줄만 말하고 턴을 끝낸다. 작업이 끝났거나 종료됐다는 알림이 오기 전에는 update_goal 을 호출하지 않는다. 알림이 오면 update_goal 로 목표를 complete 처리하고 '작업 종료됨' 한 줄로 답한 뒤 턴을 끝낸다. 다른 작업은 하지 않는다.`);
	// The model may start the job as a background shell or a detached eval cell: either is a wait the episode must ride out.
	await waitVerdict(t, /capture: line-only - wait=\S*(terminal-background-sessions|senpi-codemode)/, 1, 180000);
	await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim(), 30000, "the job wrote its pid", { retryable: true });
	t.check("before the kill: no final and no push", (await finalsOf(t)).length === 0 && threadPushes(t.sid).length === 0);
	// The model sometimes starts the job twice (a background shell and an eval cell): stopping "the job" means every copy.
	const pids = fs.readFileSync(pidFile, "utf8").split(/\s+/).filter(Boolean).map(Number);
	t.note(`${t.name}: killing job pid(s) ${pids.join(", ")}`);
	for (const pid of pids) {
		try {
			process.kill(pid);
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
	const [final] = await waitFinals(t, 1, 420000);
	t.snap("final", final);
	const pushes = await settlePushes(t, 1);
	const label = t.name;
	checkPushes(t, label, final, pushes, 1);
	// Forbidding update_goal outright made the goal continuation push the model into asking the owner (a real question,
	// so the episode rightly stayed open); the scenario now completes the goal after the exit notice. The product
	// contract is that the close reason follows the goal state at the close (active -> stalled, complete -> done, blocked -> blocked).
	const goalChange = toolResults(t.transcript().entries, "update_goal").map((result) => (JSON.stringify(result).match(/status\\*"\s*:\s*\\*"(complete|blocked)/) ?? [])[1]).filter(Boolean).at(-1) ?? null;
	const expected = goalChange === "complete" ? "done" : goalChange === "blocked" ? "blocked" : "stalled";
	t.note(`${label}: goal state at the close: ${goalChange ?? "active"}`);
	t.check(`${label}: the one final's close reason follows the goal state (${expected})`, final.meta.episode.closeReason === expected && (expected !== "stalled" || final.meta.stalled === true), JSON.stringify({ goalChange, meta: final.meta }));
	t.check(`${label}: the push is the final`, pushes[0]?.payload?.itemId === final.id);
	t.check(`${label}: the verdict log says close ${expected}`, verdictsOf(t).some((line) => line.includes(`capture: close ${expected} `)), JSON.stringify(verdictsOf(t).slice(-3)));
	t.check(`${label}: exactly one final`, (await finalsOf(t)).length === 1);
	await checkEpisode(t, label, final);
	return final;
}

async function s15(t) {
	await goalStallFlow(t);
}

/** /reload while the session waits on a background job, with and without a goal: no stalled push, the same episode goes on. */
async function reloadPart(t, withGoal) {
	const tag = withGoal ? "goal" : "nogoal";
	t.sessionDir = path.join(H.root, "sessions", `${t.name}-${tag}`);
	t.sid = null;
	await t.open({ extensions: NEW_EXTENSIONS });
	const job = bgJob(75, `R${tag}`);
	if (withGoal) await t.prompt(`/goal 세션 QA 목표: ${job}. 시작하면 '대기 중' 한 줄만 말하고 턴을 끝낸다. 작업 완료 알림이 오기 전에는 update_goal 을 호출하지 않는다. 알림이 오면 update_goal 로 목표를 complete 처리하고 '끝' 한 줄로 답한다.`);
	else await t.prompt(`${job}. 시작하면 '대기 중' 한 줄만 말하고 턴을 끝내. 완료 알림이 오면 '끝' 한 줄로 답해.`);
	await waitVerdict(t, WAIT_BG, 1, 90000);
	await editorFree(t);
	if ((await finalsOf(t)).length > 0) {
		// The model completed the goal before the job ended: the reload would no longer land mid-wait.
		const error = new Error(`reload (${tag}): the model closed the work before the reload`);
		error.retryable = true;
		throw error;
	}
	const linesBefore = (await linesOf(t)).length;
	const seen = verdictsOf(t).length;
	await t.omo.prompt("/reload");
	const after = await until(() => verdictsOf(t).slice(seen).find((line) => WAIT_BG.test(line)), 60000, "a verdict log line after the reload").catch(() => null);
	t.screen(`afterReload-${tag}`);
	t.check(`reload (${tag}): the verdict log after the reload still shows the job wait`, Boolean(after), JSON.stringify(verdictsOf(t).slice(seen)));
	t.check(`reload (${tag}): no final and no push right after the reload`, (await finalsOf(t)).length === 0 && threadPushes(t.sid).length === 0);
	t.check(`reload (${tag}): the reload did not drop or duplicate lines`, (await linesOf(t)).length >= linesBefore);
	const finals = await waitFinals(t, 1, 240000);
	const final = finals[0];
	t.snap(`final-${tag}`, final);
	const pushes = await settlePushes(t, 1);
	checkPushes(t, `S16 ${tag}`, final, pushes, 1);
	t.check(`reload (${tag}): exactly one final and it is not stalled`, finals.length === 1 && (await finalsOf(t)).length === 1 && final.meta.episode.closeReason !== "stalled", JSON.stringify(final.meta.episode));
	await checkEpisode(t, `S16 ${tag}`, final, { exactLines: true });
	t.snap(`verdicts-${tag}`, verdictsOf(t));
}

async function s16(t) {
	await reloadPart(t, false);
	await t.omo.stop();
	await reloadPart(t, true);
}

/** A question mid-episode: question push, answer, then the final push (two pushes in all). */
async function s17(t) {
	await t.open({ extensions: NEW_EXTENSIONS });
	await t.prompt("먼저 '시작합니다' 한 줄을 말하고, 그다음 ask_user_question 도구를 정확히 한 번 호출해. waitForAnswer는 true, required는 false, 질문 하나(header: 색, question: 무슨 색을 좋아해?), 선택지 빨강과 파랑(multiSelect false). 답을 받으면 '선택: <라벨>' 이라고만 답해.");
	const question = await t.waitQuestion(true);
	await until(() => threadPushes(t.sid).length >= 1, 60000, "the question push reaches the sink");
	t.check("the first push is the question", threadPushes(t.sid)[0]?.payload?.itemId === question.id, JSON.stringify(threadPushes(t.sid)[0]?.payload?.itemId));
	const answer = await api("POST", `/api/items/${question.id}/answer`, answerBody(question, "파랑"));
	t.check("POST answer 파랑 returns 200", answer.status === 200, JSON.stringify(answer));
	const [final] = await waitFinals(t, 1, 240000);
	t.snap("final", final);
	const pushes = await settlePushes(t, 2);
	t.check("two pushes in all: the question, then the final", pushes.length === 2 && pushes[0].payload?.itemId === question.id && pushes[1].payload?.itemId === final.id, JSON.stringify(pushes.map((entry) => entry.payload?.itemId)));
	t.check("the final push comes after the answer", Date.parse(pushes[1]?.at) > Date.parse(final.createdAt) - 1);
	await checkEpisode(t, "S17", final);
}

/** A terminal message mid-work joins the running episode: no extra push; raw.request is the opener, raw.lastRequest the interjection. */
async function s18(t) {
	await t.open({ extensions: NEW_EXTENSIONS });
	const opener = `${bgJob(50, "I")}. 시작하면 '대기 중' 한 줄만 말하고 턴을 끝내. 완료 알림이 오면 '끝' 한 줄로 답해.`;
	const interjection = "추가 요청: 작업이 끝나면 '추가 요청도 확인함' 이라고 한 줄 덧붙여 줘.";
	await t.prompt(opener);
	await waitVerdict(t, WAIT_BG, 1, 90000);
	await editorFree(t);
	await t.omo.prompt(interjection);
	const [final] = await waitFinals(t, 1, 240000);
	t.snap("final", final);
	const pushes = await settlePushes(t, 1);
	checkPushes(t, "S18", final, pushes, 1);
	t.check("raw.request is the opener", squash(final.raw?.request).includes(squash(opener).slice(0, 40)), JSON.stringify(final.raw?.request).slice(0, 200));
	t.check("raw.lastRequest is the interjection", squash(final.raw?.lastRequest).includes("추가 요청"), JSON.stringify(final.raw?.lastRequest).slice(0, 200));
	t.check("the episode counts an interjection", final.meta.episode.interjections >= 1, JSON.stringify(final.meta.episode));
	t.check("one episode: a single final", (await finalsOf(t)).length === 1);
	await checkEpisode(t, "S18", final);
}

/** /quit mid-episode: no push, the open lines close as session-closed. */
async function s19(t) {
	await t.open({ extensions: NEW_EXTENSIONS });
	await t.prompt(`${bgJob(120, "Q")}. 시작하면 '대기 중' 한 줄만 말하고 턴을 끝내.`);
	await waitVerdict(t, WAIT_BG, 1, 90000);
	await until(async () => (await linesOf(t)).length >= 1, 30000, "a line exists");
	await editorFree(t);
	await t.omo.prompt("/quit");
	await until(() => t.omo.exited !== null, 30000, "omo exits after /quit");
	const closed = await until(async () => {
		const lines = await linesOf(t);
		return lines.length > 0 && lines.every((line) => line.status === "closed") ? lines : null;
	}, 30000, "the lines close").catch(() => null);
	t.snap("linesAfterQuit", closed ?? (await linesOf(t)));
	t.check("no line is left open after /quit", Boolean(closed));
	t.check("the newest line closed session-closed", (closed ?? []).at(-1)?.closedReason === "session-closed", JSON.stringify((closed ?? []).map((line) => line.closedReason)));
	await sleep(8000);
	t.check("no push and no final after /quit", threadPushes(t.sid).length === 0 && (await finalsOf(t)).length === 0, JSON.stringify(threadPushes(t.sid).map((entry) => entry.payload?.itemId)));
	t.check("the thread reads ended", (await threadView(t.sid))?.thread?.status === "ended", JSON.stringify((await threadView(t.sid))?.thread?.status));
}

/**
 * No goal, a monitor on a file that never appears, INBOX_EPISODE_STALL_MS 60000 (below the goal monitor backstop of 270 s):
 * the watchdog posts one stalled final at the deadline. Shared by S20 and S24.
 */
async function monitorStallFlow(t) {
	await setStall(60000);
	await t.open({ extensions: NEW_EXTENSIONS });
	const never = fwd(path.join(H.work, `never-${t.name}.txt`));
	await t.prompt(`monitor 도구를 호출해: description 은 'QA 파일 감시', path 는 ${never}, event 는 create (command 는 쓰지 마). 등록되면 '감시 중' 한 줄만 말하고 턴을 끝내. 파일이 생길 때까지 다른 도구는 쓰지 말고 기다려.`);
	await waitVerdict(t, WAIT_MONITOR, 1, 120000);
	const [final] = await waitFinals(t, 1, 240000);
	t.snap("final", final);
	const lastLine = (await linesOf(t)).at(-1);
	const gap = Date.parse(final.createdAt) - Date.parse(lastLine?.createdAt);
	t.check("the stalled final lands at the 60 s deadline after the last line", gap >= 55000 && gap <= 120000, `${gap} ms after the last line`);
	const pushes = await settlePushes(t, 1);
	const label = t.name;
	checkPushes(t, label, final, pushes, 1);
	t.check(`${label}: the final is stalled`, final.meta.episode.closeReason === "stalled" && final.meta.stalled === true, JSON.stringify(final.meta));
	t.check(`${label}: the push is the stalled final`, pushes[0]?.payload?.itemId === final.id);
	t.check(`${label}: exactly one final`, (await finalsOf(t)).length === 1);
	await checkEpisode(t, label, final);
	return final;
}

async function s20(t) {
	await monitorStallFlow(t);
}

/** After a stalled final A (S15 or S20 flow), a new terminal request B is its own episode; A stays exactly as it was. */
async function continueAfterStall(t, finalA, requestB, label) {
	const keyA = finalA.meta.episode.key;
	const episodeA = JSON.stringify(await episodeOf(t.sid, keyA));
	const linesA = new Set((JSON.parse(episodeA)?.lines ?? []).map((line) => line.id));
	await t.omo.prompt(requestB);
	const finals = await waitFinals(t, 2, 300000);
	const finalB = finals.find((item) => item.meta.episode.key !== keyA);
	t.check(`${label}: B has its own episode key`, Boolean(finalB) && finalB.meta.episode.key !== keyA, JSON.stringify(finals.map((item) => item.meta.episode.key)));
	if (!finalB) return;
	t.snap("finalB", finalB);
	t.check(`${label}: B's final request is B's request`, squash(finalB.raw?.request).includes(squash(requestB).slice(0, 30)), JSON.stringify(finalB.raw?.request).slice(0, 200));
	const report = await checkEpisode(t, `${label} B`, finalB);
	t.check(`${label}: B's episode holds none of A's lines`, report !== null && report.episode.lines.every((line) => !linesA.has(line.id)));
	const after = (await finalsOf(t)).find((item) => item.meta.episode.key === keyA);
	t.check(`${label}: A's final is unchanged (${finalA.meta.episode.closeReason})`, after?.id === finalA.id && after.meta.episode.closeReason === finalA.meta.episode.closeReason, JSON.stringify(after?.meta));
	t.check(`${label}: A's episode GET is unchanged`, JSON.stringify(await episodeOf(t.sid, keyA)) === episodeA);
}

/** S15's stalled final, then request B: a background job whose completion wakes the agent; B finishes. */
async function s23(t) {
	const finalA = await goalStallFlow(t);
	const requestB = `새 요청 B: ${bgJob(20, "B")}. 시작하면 'B 대기' 한 줄만 말하고 턴을 끝내. 완료 알림이 오면 update_goal 로 목표를 complete 처리하고 'B 끝' 한 줄로 답해.`;
	await continueAfterStall(t, finalA, requestB, "S23");
}

/** S20's stalled push, then request B typed at the terminal (no reload). */
async function s24(t) {
	const finalA = await monitorStallFlow(t);
	await continueAfterStall(t, finalA, "새 요청 B: 도구를 쓰지 말고 'B 요청 답입니다' 한 줄로만 답해.", "S24");
}

/** The omo process dies (no /quit, no bye) mid-episode with a goal; resumed, the same episode ends with one final and one push. */
async function s22(t) {
	await t.open({ extensions: NEW_EXTENSIONS });
	await t.prompt(`/goal ${chainGoal(3, 25, "P")}`);
	// Kill mid-episode: two lines exist and no final yet (the model may or may not end a turn between jobs).
	await until(async () => (await linesOf(t)).length >= 2 && (await finalsOf(t)).length === 0, 240000, "two lines before any final", { retryable: true });
	const before = await until(async () => {
		const lines = await linesOf(t);
		return lines.length >= 2 ? lines : null;
	}, 60000, "at least two lines before the kill", { retryable: true });
	const key = before[0].meta?.episode?.key;
	const transcript = t.transcript();
	t.pty.beforeKill = t.omo.full();
	await killTree(t.omo.proc.pid);
	await Promise.race([t.omo.proc.exited, sleep(10000)]);
	t.snap("linesBeforeKill", before);
	t.check("killing the process closes nothing (no bye)", (await threadItems(t)).every((item) => item.closedReason !== "session-closed"));
	await t.open({ extensions: NEW_EXTENSIONS, extra: ["--session", transcript.file] });
	await t.omo.prompt("재시작했어. 남은 단계는 건너뛰고 update_goal 로 목표를 complete 처리한 뒤 '재시작 후 끝' 한 줄로 답해.");
	const finals = await waitFinals(t, 1, 300000);
	const final = finals[0];
	t.snap("final", final);
	const pushes = await settlePushes(t, 1);
	checkPushes(t, "S22", final, pushes, 1);
	t.check("S22: the final has the episode key from before the restart", final.meta.episode.key === key, `${final.meta.episode.key} vs ${key}`);
	// A system wake inside the first final's push hold reopens the same episode: that final closes superseded and is never
	// pushed, and the later final covers the whole span (plan todos 2 and 9).
	const s22Finals = await finalsOf(t);
	const s22Superseded = s22Finals.filter((item) => item.closedReason === "superseded");
	t.check("S22: exactly one final that was not superseded by a reopen", s22Finals.length - s22Superseded.length === 1, JSON.stringify(s22Finals.map((item) => [item.id, item.status, item.closedReason ?? null, item.pushedAt ?? null])));
	t.check("S22: a superseded final was never pushed and shares the episode key", s22Superseded.every((item) => !item.pushedAt && item.meta?.episode?.key === key));
	const report = await checkEpisode(t, "S22", final);
	const ids = new Set((report?.episode.lines ?? []).map((line) => line.id));
	t.check("S22: the episode holds the lines from before the restart", before.every((line) => ids.has(line.id)), JSON.stringify(before.map((line) => line.id)));
	t.check("S22: it also holds lines or the final from after the restart", (report?.episode.lines.length ?? 0) + 1 > before.length);
}

/** No goal, a background wait: the thread reads working (진행 중), no close and no push until the job is done. */
async function s21(t) {
	await t.open({ extensions: NEW_EXTENSIONS });
	await t.prompt(`${bgJob(30, "W")}. 시작하면 '대기 중' 한 줄만 말하고 턴을 끝내. 완료 알림이 오면 '끝' 한 줄로 답해.`);
	await waitVerdict(t, WAIT_BG, 1, 90000);
	await until(async () => (await linesOf(t)).length >= 1, 30000, "the waiting line exists");
	const view = await threadView(t.sid);
	t.check("while it waits the thread reads working, not needs-you", view?.thread?.status === "working", JSON.stringify(view?.thread?.status));
	t.check("while it waits there is no final and no push", (await finalsOf(t)).length === 0 && threadPushes(t.sid).length === 0);
	const [final] = await waitFinals(t, 1, 180000);
	t.snap("final", final);
	const pushes = await settlePushes(t, 1);
	checkPushes(t, "S21", final, pushes, 1);
	t.check("S21: the one push is the final", pushes[0]?.payload?.itemId === final.id);
	t.check("S21: every verdict before the last was line-only, the last a close", verdictsOf(t).slice(0, -1).every((line) => /line-only/.test(line)) && /capture: close /.test(verdictsOf(t).at(-1) ?? ""), JSON.stringify(verdictsOf(t)));
	await checkEpisode(t, "S21", final, { exactLines: true });
}

/** Write the temp inbox config the two next-action scenarios run with: close never touches an Orca tab. */
function setCloseTabOff() {
	fs.writeFileSync(path.join(H.home, "config.json"), JSON.stringify({ ...H.config, next: { closeTab: false } }));
}

/** Reopen launches (new-session and reopen) written to INBOX_REOPEN_SINK instead of spawning a terminal. */
function reopenEntries() {
	try {
		return fs.readFileSync(H.reopenSink, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/** The final's next verdict, computed asynchronously by the server after the final appears. */
const waitNext = (t, itemId, timeoutMs = 60000) => until(async () => (await threadItems(t)).find((item) => item.id === itemId)?.next ?? null, timeoutMs, `the next verdict for ${itemId}`, { retryable: true, everyMs: 500 });

const exitOf = async (pty, timeoutMs, label) => (await until(() => (pty.exited !== null ? { code: pty.exited } : null), timeoutMs, label)).code;

/**
 * S25 (GAP-15): the owner taps close on a real session's done final. The server writes a session-control file, the
 * extension shuts the session down, the bye closes the thread's items as closed-by-owner, and the PTY exits.
 */
async function s25(t) {
	setCloseTabOff();
	await t.open({ extensions: NEW_EXTENSIONS, deleteEnv: ["ORCA_TERMINAL_HANDLE"] });
	await t.prompt("안녕이라고만 답해");
	const finals = await waitFinals(t, 1, 180000);
	const final = finals[0];
	t.snap("final", final);
	t.check("the final reads needs-you", final.policy === "needs-you", JSON.stringify(final.policy));
	const next = await waitNext(t, final.id);
	t.snap("next", next);
	t.check("the done final's next state is done", next.state === "done", JSON.stringify(next.state));
	t.check("the done final offers the close action", next.actions.some((action) => action.id === "close"), JSON.stringify(next.actions.map((action) => action.id)));
	const wasOpen = (await threadItems(t)).filter((item) => item.status === "open").map((item) => item.id);
	const response = await api("POST", `/api/items/${final.id}/action`, { action: "close" });
	t.snap("closeResponse", response);
	t.check("POST action close returns 200 through the session control", response.status === 200 && response.body?.via === "session", JSON.stringify(response));
	const exitCode = await exitOf(t.omo, 60000, "the PTY exits after close").catch((error) => {
		t.note(error.message);
		return null;
	});
	t.check("the PTY exits after close", exitCode !== null, String(exitCode));
	if (exitCode !== null) t.note(`S25 exit code: ${exitCode}`);
	const closed = await until(async () => {
		const items = await threadItems(t);
		return items.length > 0 && items.every((item) => item.status === "closed") ? items : null;
	}, 30000, "the thread's items close").catch(() => null);
	t.snap("itemsAfterClose", closed ?? (await threadItems(t)));
	t.check("every item that was open closes closed-by-owner", wasOpen.length > 0 && wasOpen.every((id) => {
		const item = (closed ?? []).find((entry) => entry.id === id);
		return item?.closedReason === "closed-by-owner";
	}), JSON.stringify((closed ?? []).map((item) => [item.id, item.closedReason])));
	const view = await threadView(t.sid);
	t.check("the thread reads ended", view?.thread?.status === "ended", JSON.stringify(view?.thread?.status));
}

/**
 * S26 (GAP-15): the owner taps new-session on a plan final. The launcher goes to INBOX_REOPEN_SINK; the scenario reads
 * the sid and kickoff from the Windows Terminal attempt, starts that session for real, and checks the handoff, the old
 * session's exit and handed-off close, the expanded skill in the new transcript and the new thread's executes slug.
 */
async function s26(t) {
	setCloseTabOff();
	const project = path.join(H.root, "s26-project");
	fs.mkdirSync(path.join(project, ".omo", "plans"), { recursive: true });
	fs.writeFileSync(path.join(project, ".omo", "plans", "qa-plan.md"), "- [ ] 1. say hello\n");
	const skillDir = process.env.QA_ULW_EXECUTE_SKILL || path.join(os.homedir(), ".bun", "install", "global", "node_modules", "omo-ai", "plugin", "skills", "ulw-execute");
	if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) throw new Error(`S26 needs the ulw-execute skill: ${skillDir} is missing (set QA_ULW_EXECUTE_SKILL)`);
	const skillBody = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
	const skillMarker = skillBody.split("\n").find((line) => /^## /.test(line)) ?? "";
	const prompt = "다음 문장만 그대로 출력해: 별도 실행은 새 세션에서 /ulw-execute qa-plan 으로 시작합니다.";
	await t.open({ cwd: project, extensions: NEW_EXTENSIONS, deleteEnv: ["ORCA_TERMINAL_HANDLE"] });
	await t.prompt(prompt);
	const final = (await waitFinals(t, 1, 180000))[0];
	t.snap("final", final);
	t.check("the final reads needs-you", final.policy === "needs-you", JSON.stringify(final.policy));
	const next = await waitNext(t, final.id);
	t.snap("next", next);
	t.check("the plan final's next state is plan", next.state === "plan", JSON.stringify(next.state));
	t.check("the plan fact points at the temp project's qa-plan", next.facts?.plan?.slug === "qa-plan" && next.facts?.plan?.root === project, JSON.stringify(next.facts?.plan));
	const wasOpen = (await threadItems(t)).filter((item) => item.status === "open").map((item) => item.id);
	const response = await api("POST", `/api/items/${final.id}/action`, { action: "new-session" });
	t.snap("newSessionResponse", response);
	t.check("POST action new-session returns 200 through the reopen sink", response.status === 200 && response.body?.via === "sink", JSON.stringify(response));
	const newSid = response.body?.session ?? null;
	const launch = await until(() => reopenEntries().find((entry) => entry.kind === "launch" && entry.sid === newSid), 15000, "the launch line in the reopen sink").catch(() => null);
	t.snap("reopenSink", reopenEntries());
	t.check("the reopen sink has the launch for the returned sid", Boolean(launch), JSON.stringify(newSid));
	const attempt = Array.isArray(launch?.attempts) ? launch.attempts.find((entry) => entry.via === "wt") : null;
	t.check("the launch has a Windows Terminal attempt", Boolean(attempt), JSON.stringify(launch?.attempts?.map((entry) => entry.via)));
	const argv = Array.isArray(attempt?.args) ? attempt.args : [];
	const kickoff = argv.at(-1) ?? "";
	t.check("the WT attempt carries --session-id with the sink sid", argv.includes("--session-id") && argv[argv.indexOf("--session-id") + 1] === newSid, JSON.stringify(argv));
	t.check("the WT attempt's kickoff is /skill:ulw-execute qa-plan", kickoff === "/skill:ulw-execute qa-plan", JSON.stringify(kickoff));
	if (!newSid || kickoff !== "/skill:ulw-execute qa-plan") return;
	const newDir = path.join(H.root, "sessions", "S26-new");
	fs.mkdirSync(newDir, { recursive: true });
	const fresh = new OmoPty({
		cwd: project,
		sessionDir: newDir,
		env: { ...H.omoEnv },
		extensions: NEW_EXTENSIONS,
		extra: ["--skill", skillDir, "--session-id", newSid, kickoff],
		deleteEnv: ["ORCA_TERMINAL_HANDLE"],
	}).start();
	t.secondOmo = fresh;
	t.note("S26: --no-skills stays; the runtime merges explicit --skill paths under it, so the kickoff skill loads (resource-loader.js: skillPaths = merge(cliEnabledSkills, additionalSkillPaths))");
	await fresh.waitForScreen((visible) => /❯/.test(visible), 90000, "the new session's omo prompt");
	t.pty.newSession = fresh.visible();
	const handoff = await until(async () => {
		// GET /api/threads/<sid> returns {thread, items, events}; the latest handoff lives on thread.handoff.
		const view = await threadView(t.sid);
		return view?.thread?.handoff?.status === "connected" ? view.thread.handoff : null;
	}, 60000, "the old thread's handoff becomes connected", { retryable: true, everyMs: 500 }).catch((error) => {
		t.note(error.message);
		return null;
	});
	t.snap("handoff", handoff);
	t.check("the old thread's handoff becomes connected to the new sid", handoff?.to === newSid && handoff?.via === "sink" && handoff?.slug === "qa-plan", JSON.stringify(handoff));
	const exitCode = await exitOf(t.omo, 60000, "the old PTY exits after the handoff").catch((error) => {
		t.note(error.message);
		return null;
	});
	t.check("the old PTY exits after the handoff", exitCode !== null, String(exitCode));
	if (exitCode !== null) t.note(`S26 old exit code: ${exitCode}`);
	const closed = await until(async () => {
		const items = await threadItems(t);
		return items.length > 0 && items.every((item) => item.status === "closed") ? items : null;
	}, 30000, "the old thread's items close").catch(() => null);
	t.snap("itemsAfterHandoff", closed ?? (await threadItems(t)));
	t.check("every old item that was open closes handed-off", wasOpen.length > 0 && wasOpen.every((id) => {
		const item = (closed ?? []).find((entry) => entry.id === id);
		return item?.closedReason === "handed-off";
	}), JSON.stringify((closed ?? []).map((item) => [item.id, item.closedReason])));
	const jsonl = await until(() => {
		const file = fs.existsSync(newDir) ? fs.readdirSync(newDir).find((name) => name.endsWith(`_${newSid}.jsonl`)) : null;
		return file ? path.join(newDir, file) : null;
	}, 60000, `the new session's *_${newSid}.jsonl`).catch((error) => {
		t.note(error.message);
		return null;
	});
	t.check("the new session's jsonl exists", Boolean(jsonl), jsonl ?? newDir);
	const firstUser = jsonl ? await until(() => {
		const transcript = readTranscript(newDir);
		const message = userMessages(transcript.entries)[0];
		return message ? { message, entries: transcript.entries } : null;
	}, 90000, "the new session's first user message").catch(() => null) : null;
	const firstText = firstUser ? textOf(firstUser.message) : "";
	t.excerpt("new session first user message", firstUser ? [{ role: firstUser.message.role, text: firstText.slice(0, 1200), at: firstUser.message.at }] : []);
	t.check("the first user message carries the expanded ulw-execute skill block", firstText.includes('The user explicitly invoked the "ulw-execute" skill') && firstText.includes('<skill-instruction name="ulw-execute"'), firstText.slice(0, 300));
	t.check("the first user message carries the skill body", skillMarker !== "" && firstText.includes(skillMarker), skillMarker);
	t.check("the first user message is not an unknown-command reply", !/unknown command|skill not loaded/i.test(firstText), firstText.slice(0, 300));
	const threadJson = path.join(H.home, "data", "threads", newSid, "thread.json");
	const executes = await until(() => {
		try {
			return JSON.parse(fs.readFileSync(threadJson, "utf8")).executes ?? null;
		} catch {
			return null;
		}
	}, 60000, `the new thread.json executes qa-plan`).catch((error) => {
		t.note(error.message);
		return null;
	});
	t.snap("threadJson", fs.existsSync(threadJson) ? JSON.parse(fs.readFileSync(threadJson, "utf8")) : null);
	t.check("the new thread.json has executes qa-plan", executes === "qa-plan", JSON.stringify(executes));
	await fresh.stop();
	const stopped = await until(() => (fresh.exited !== null ? true : null), 15000, "the new session stops").catch(() => null);
	t.check("the new session stops after the abort", stopped === true, String(fresh.exited));
}

const SCENARIOS = [
	["S1", s1],
	["S2", s2],
	["S3", s3],
	["S4", s4],
	["S5", s5],
	["S6", s6],
	["S7", s7],
	["S8", s8],
	["S9", s9],
	["S10", s10],
	["S11", s11],
	["S12", s12],
	["S13", s13],
	["S14", s14],
	["S15", s15],
	["S16", s16],
	["S17", s17],
	["S18", s18],
	["S19", s19],
	["S20", s20],
	["S21", s21],
	["S22", s22],
	["S23", s23],
	["S24", s24],
	["S25", s25],
	["S26", s26],
];
const EXTRA = [["B1", sBridgeOff]];

async function runScenario(name, fn, attempts = 2) {
	let run;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		run = new Run(name);
		say(`${name} (attempt ${attempt}/${attempts})`);
		if (!(await health())) await startServer();
		// Every attempt starts from the default mode (trial extension) and the long stall deadline.
		setMode(null);
		await setStall(DEFAULT_STALL_MS);
		let retry = false;
		try {
			await fn(run);
		} catch (error) {
			run.check(`scenario ran to completion`, false, error.message);
			if (run.omo) run.screen("errorScreen");
			retry = error.retryable === true && attempt < attempts;
		}
		try {
			await run.finish();
		} catch (error) {
			say(`  finish failed: ${error.message}`);
		}
		if (run.passed || !retry) break;
		say(`  retrying ${name}: the model did not produce the expected step`);
	}
	say(`${name} ${run.passed ? "PASS" : "FAIL"}`);
	return run;
}

async function main() {
	if (FORBIDDEN_PORTS.has(PORT)) throw new Error("refusing a forbidden port");
	const only = process.argv.slice(2).map((arg) => arg.toUpperCase());
	H.root = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-sessqa-"));
	H.home = path.join(H.root, "home");
	H.work = path.join(H.root, "work");
	H.sink = path.join(H.root, "push.jsonl");
	H.reopenSink = path.join(H.root, "reopen.jsonl");
	for (const dir of [H.home, path.join(H.home, "app"), H.work, path.join(H.root, "agent"), path.join(H.root, "user"), path.join(H.root, "sessions")]) fs.mkdirSync(dir, { recursive: true });
	// QA_SUMMARY_MODELS=a,b overrides the server's summary model list (diagnosis only; the default run uses the shipped list).
	const summary = process.env.QA_SUMMARY_MODELS ? { summary: { enabled: true, models: process.env.QA_SUMMARY_MODELS.split(",") } } : {};
	H.config = { v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null, ...summary };
	H.stallMs = DEFAULT_STALL_MS;
	setMode(null);
	// The background job every episode scenario waits on: it prints START, then DONE after N seconds (a kill leaves no DONE).
	fs.writeFileSync(path.join(H.work, "qa-job.mjs"), `import fs from "node:fs";\nconst [seconds = "20", label = "job", pidFile] = process.argv.slice(2);\nif (pidFile) fs.appendFileSync(pidFile, String(process.pid) + "\\n");\nconsole.log("JOB-" + label + "-START");\nsetTimeout(() => console.log("JOB-" + label + "-DONE"), Number(seconds) * 1000);\n`);
	// A checkout-channel marker keeps the extension's package tick from running `install --from-package`.
	fs.writeFileSync(path.join(H.home, "app", "source.json"), JSON.stringify({ channel: "checkout", source: REPO }));
	H.serverEnv = {
		INBOX_EPISODE_STALL_MS: String(DEFAULT_STALL_MS),
		OMO_INBOX_HOME: H.home,
		INBOX_NO_TAILSCALE: "1",
		INBOX_PUSH_SINK: H.sink,
		INBOX_REOPEN_SINK: H.reopenSink,
		INBOX_AGENT_DIR: path.join(H.root, "agent"),
		INBOX_USER_HOME: path.join(H.root, "user"),
	};
	H.omoEnv = { ...H.serverEnv, INBOX_URL: BASE, INBOX_NO_ENSURE: "1" };
	say(`session-qa: root ${H.root}, port ${PORT}, model ${MODEL}`);
	const runs = [];
	try {
		await startServer();
		await subscribeFake();
		for (const [name, fn] of SCENARIOS) if (only.length === 0 || only.includes(name)) runs.push(await runScenario(name, fn));
		for (const [name, fn] of EXTRA) if (only.length === 0 || only.includes(name)) runs.push(await runScenario(name, fn));
	} finally {
		try {
			H.server?.kill();
		} catch {
			// already stopped
		}
	}
	const mainRuns = runs.filter((run) => /^S\d+$/.test(run.name));
	const passed = mainRuns.filter((run) => run.passed).length;
	say(`${passed}/${only.length === 0 ? SCENARIOS.length : mainRuns.length} scenarios passed`);
	for (const run of runs.filter((entry) => !/^S\d+$/.test(entry.name))) say(`${run.name} (bridge disabled via INBOX_BRIDGE=off): ${run.passed ? "PASS" : "FAIL"}`);
	evidence(`${EVIDENCE_PREFIX}-run.txt`, `${H.runLines.join("\n")}\n`);
	if (process.env.QA_KEEP !== "1") {
		try {
			fs.rmSync(H.root, { recursive: true, force: true });
		} catch (error) {
			// Windows keeps the folder locked while a scenario's child process is still exiting; the verdict stands.
			say(`cleanup: could not remove ${H.root} (${error.code ?? error.message}); remove it once its processes exit`);
		}
	}
	return runs.every((run) => run.passed) ? 0 : 1;
}

if (import.meta.main) {
	process.exitCode = await main();
}
