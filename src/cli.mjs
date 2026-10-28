import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { identityFor } from "./identity.mjs";
import { agentDir, layout, readConfig } from "./paths.mjs";
import { feedbackMessage } from "./message.mjs";
import { URGENCIES, validateNotice } from "./notices.mjs";
import * as client from "./client.mjs";

const NAME = "omo-inbox";
const DEFAULT_WAIT_SEC = 600;
const HEALTH_TIMEOUT_MS = 1500;

const CLI = `node "${String(process.argv[1] ?? "inbox.mjs").replace(/\\/g, "/")}"`;

const USAGE = [
	`usage: ${CLI} <command> [--json]`,
	"  submit <boardDir> [--title t] [--note n] [--new] [--session id] [--session-file path]",
	"  revise <id> <boardDir> [--note n] [--session id] [--session-file path]",
	"  reply <id> <text...> | --file <path> | - [--session id] [--session-file path]",
	"  close <id> <summary...> [--session id] [--session-file path]",
	"  show <id>",
	"  list [--product p] [--feature f] [--status s]",
	"  pending [--session id] [--session-file path]",
	"  wait <id> [--timeout sec]",
	"  server status|start|stop|restart",
	"  notify --producer p --key k --title t [--body b] [--urgency now|soon|fyi] [--session id] [--expires iso]",
	"  threads [--status s]",
	"  mode",
	"  takeover",
	"  handback",
	"  install [--from-package] [--no-tailscale] [--no-autostart] | uninstall | doctor",
].join("\n");

const VALUE_FLAGS = new Set([
	"title", "note", "file", "timeout", "product", "feature", "status", "session", "session-file",
	"producer", "key", "body", "urgency", "expires",
]);

/** Reports a missing value the same way sessionOf does: a usage line, never a placeholder. */
function needed(flags, name) {
	if (!flags.has(name)) throw new Error(`usage: --${name} is required`);
	const value = flags.get(name);
	if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
		throw new Error(`usage: --${name} needs a value`);
	}
	return value;
}

function out(line) {
	process.stdout.write(line + "\n");
}

function err(line) {
	process.stderr.write(line + "\n");
}

function parse(rest) {
	const flags = new Map();
	const pos = [];
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (token.startsWith("--")) {
			const name = token.slice(2);
			flags.set(name, VALUE_FLAGS.has(name) ? rest[++i] : true);
		} else {
			pos.push(token);
		}
	}
	return { flags, pos };
}

/**
 * The CLI's single ownership resolver. An explicit option wins over both env vars; an ID-only
 * option records the file as null, and a --session-file value is recorded exactly as given
 * (never read or inferred). A missing, blank or option-like value is a usage error.
 */
function sessionOf(env, flags = new Map()) {
	const option = (name) => {
		if (!flags.has(name)) return undefined;
		const value = flags.get(name);
		if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) {
			throw new Error(`usage: --${name} needs a value`);
		}
		return value;
	};
	const idFlag = option("session");
	const fileFlag = option("session-file");
	const id = idFlag !== undefined ? idFlag : env.INBOX_SESSION || env.PI_SESSION_ID || null;
	const file = fileFlag !== undefined ? fileFlag : idFlag !== undefined ? null : env.PI_SESSION_FILE || null;
	return { id: id || null, file: file || null };
}

async function call(method, route, body, env) {
	try {
		return await client.api(method, route, body, env);
	} catch {
		return { status: 0, json: null };
	}
}

function mapError(res) {
	if (res.status === 0) {
		err("server unreachable");
		return 3;
	}
	const error = res.json && typeof res.json === "object" ? res.json.error : null;
	if (error === "not_found") {
		err("not found");
		return 4;
	}
	if (error === "closed") {
		err("proposal is closed");
		return 5;
	}
	err(error ? String(error) : `unexpected server status ${res.status}`);
	return 1;
}

async function ensureOk(env) {
	try {
		const ok = await client.ensure(env);
		if (!ok) {
			err("server unreachable");
			return 3;
		}
		return 0;
	} catch (error) {
		err(error && error.message ? error.message : String(error));
		return 3;
	}
}

async function cmdSubmit(rest, json) {
	const { flags, pos } = parse(rest);
	const boardDir = pos[0];
	if (!boardDir) {
		err(`usage: ${CLI} submit <boardDir>`);
		return 1;
	}
	const env = process.env;
	const session = sessionOf(env, flags);
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const srcDir = path.resolve(boardDir);
	const identity = await identityFor(process.cwd());
	const res = await call(
		"POST",
		"/api/proposals",
		{
			cwd: process.cwd(),
			identity: { ...identity, session },
			title: flags.get("title") ?? null,
			srcDir,
			note: flags.get("note") ?? null,
			force: flags.get("new") === true,
		},
		env,
	);
	if (res.status === 200) {
		if (json) {
			out(JSON.stringify(res.json));
			return 0;
		}
		out(`id: ${res.json.summary.id}`);
		out(`url: ${res.json.url}`);
		out(`owner: ${res.json.summary.owner ?? "none"}`);
		if (res.json.existing) out("note: already submitted");
		return 0;
	}
	if (res.status === 400 && res.json && res.json.error === "invalid_board") {
		for (const detail of res.json.details || []) err(detail);
		return 2;
	}
	if (res.status === 409 && res.json && res.json.error === "duplicate") {
		err(
			`open proposal exists: ${res.json.id} ${res.json.url} - use: ${CLI} revise ${res.json.id} ${srcDir}, or ${CLI} submit --new`,
		);
		return 8;
	}
	return mapError(res);
}

async function cmdRevise(rest, json) {
	const { flags, pos } = parse(rest);
	const [id, boardDir] = pos;
	if (!id || !boardDir) {
		err(`usage: ${CLI} revise <id> <boardDir>`);
		return 1;
	}
	const env = process.env;
	const session = sessionOf(env, flags);
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const res = await call(
		"POST",
		`/api/p/${encodeURIComponent(id)}/revise`,
		{ srcDir: path.resolve(boardDir), note: flags.get("note") ?? null, session },
		env,
	);
	if (res.status === 200) {
		if (json) {
			out(JSON.stringify(res.json));
			return 0;
		}
		out(`id: ${res.json.summary.id}`);
		out(`rev: ${res.json.summary.rev}`);
		out(`url: ${res.json.url}`);
		out(`owner: ${res.json.summary.owner ?? "none"}`);
		return 0;
	}
	if (res.status === 400 && res.json && res.json.error === "invalid_board") {
		for (const detail of res.json.details || []) err(detail);
		return 2;
	}
	return mapError(res);
}

function replyText(flags, pos) {
	if (flags.has("file")) return fs.readFileSync(String(flags.get("file")), "utf8");
	if (pos.length === 2 && pos[1] === "-") return fs.readFileSync(0, "utf8");
	return pos.slice(1).join(" ");
}

async function cmdReply(rest, json) {
	const { flags, pos } = parse(rest);
	const id = pos[0];
	if (!id) {
		err(`usage: ${CLI} reply <id> <text...>`);
		return 1;
	}
	const text = replyText(flags, pos);
	const env = process.env;
	const session = sessionOf(env, flags);
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const res = await call("POST", `/api/p/${encodeURIComponent(id)}/reply`, { text, session }, env);
	if (res.status === 200) {
		if (json) {
			out(JSON.stringify(res.json));
			return 0;
		}
		out(`ok ${id} ${res.json.summary.status}`);
		return 0;
	}
	return mapError(res);
}

function recordDate() {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function cmdClose(rest, json) {
	const { flags, pos } = parse(rest);
	const id = pos[0];
	if (!id) {
		err(`usage: ${CLI} close <id> <summary...>`);
		return 1;
	}
	const env = process.env;
	const session = sessionOf(env, flags);
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const summary = pos.slice(1).join(" ");
	const res = await call("POST", `/api/p/${encodeURIComponent(id)}/close`, { summary, session }, env);
	if (res.status === 200) {
		if (json) {
			out(JSON.stringify(res.json));
			return 0;
		}
		out(`ok ${id} closed`);
		const detail = await call("GET", `/api/p/${encodeURIComponent(id)}`, null, env);
		const events = detail.status === 200 && Array.isArray(detail.json.events) ? detail.json.events : [];
		const feedback = [...events].reverse().find((event) => event.type === "feedback") || null;
		const approved = Boolean(feedback) && feedback.verdict === "approve";
		const url = detail.status === 200 && detail.json.url ? detail.json.url : `${client.baseUrl(env)}/p/${id}`;
		out(`record: ${approved ? "VISUAL-APPROVED" : "VISUAL-CLOSED"} ${recordDate()} ${id} ${url}`);
		return 0;
	}
	return mapError(res);
}

function eventBlock(event) {
	const head = `#${event.seq} ${event.type} ${event.at ?? ""}`;
	if (event.type === "feedback") {
		const verdict = event.verdict === "approve" ? "approve" : event.verdict === "ack" ? "ack" : "change";
		const lines = [`${head} ${verdict}`];
		if (event.comment) lines.push(`  ${event.comment}`);
		return lines.join("\n");
	}
	if (event.type === "reply") return `${head}\n  ${event.text ?? ""}`;
	if (event.type === "closed") return `${head}\n  ${event.summary ?? ""}`;
	if (event.note) return `${head}\n  ${event.note}`;
	return head;
}

async function cmdShow(rest, json) {
	const { pos } = parse(rest);
	const id = pos[0];
	if (!id) {
		err(`usage: ${CLI} show <id>`);
		return 1;
	}
	const env = process.env;
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const res = await call("GET", `/api/p/${encodeURIComponent(id)}`, null, env);
	if (res.status !== 200) return mapError(res);
	if (json) {
		out(JSON.stringify(res.json));
		return 0;
	}
	const summary = res.json.summary;
	const chip = summary.kind === "report"
		? `${summary.status} 갱신 ${summary.rev} report`
		: `${summary.status} ${summary.rev}안`;
	out(`${res.json.proposal.title} (${summary.id}) ${chip}`);
	out(`url: ${res.json.url}`);
	for (const event of res.json.events) out(eventBlock(event));
	return 0;
}

async function cmdList(rest, json) {
	const { flags } = parse(rest);
	const env = process.env;
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const query = new URLSearchParams();
	for (const key of ["product", "feature", "status"]) {
		const value = flags.get(key);
		if (value != null && value !== true) query.set(key, String(value));
	}
	const suffix = query.toString() ? `?${query}` : "";
	const res = await call("GET", `/api/proposals${suffix}`, null, env);
	if (res.status !== 200) return mapError(res);
	if (json) {
		out(JSON.stringify(res.json));
		return 0;
	}
	for (const item of res.json.items) {
		out(`${item.id}\t${item.status}\t${item.product.name}\t${item.feature.branch}\t${item.title}`);
	}
	return 0;
}

async function cmdPending(rest, json) {
	const { flags } = parse(rest);
	const env = process.env;
	const session = sessionOf(env, flags);
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const query = new URLSearchParams({ cwd: process.cwd() });
	if (session.id) query.set("session", session.id);
	const res = await call("GET", `/api/here?${query}`, null, env);
	if (res.status !== 200) return mapError(res);
	if (json) {
		out(JSON.stringify(res.json));
		return 0;
	}
	out(res.json.notice ?? "none");
	return 0;
}

async function waitMessage(env, detail, event) {
	let board = {};
	try {
		const res = await client.api("GET", `/files/${detail.summary.id}/revs/${event.rev}/board.json`, null, env);
		if (res.status === 200 && res.json && typeof res.json === "object") board = res.json;
	} catch {
		// a missing board still yields the first, most important line of the message
	}
	const cropDir = path.join(layout(env).proposals, detail.summary.id);
	return feedbackMessage({ summary: detail.summary, board, event, url: detail.url, cropDir, cli: CLI });
}

async function cmdWait(rest, json) {
	const { flags, pos } = parse(rest);
	const id = pos[0];
	if (!id) {
		err(`usage: ${CLI} wait <id> [--timeout sec]`);
		return 1;
	}
	const env = process.env;
	const timeoutMs = Math.max(0, Number(flags.get("timeout") ?? DEFAULT_WAIT_SEC)) * 1000 || DEFAULT_WAIT_SEC * 1000;
	const pollMs = Number(env.INBOX_WAIT_POLL_MS) || 2000;
	const started = Date.now();
	out(`WAITING ${id}`);
	for (;;) {
		const res = await call("GET", `/api/p/${encodeURIComponent(id)}`, null, env);
		if (res.status === 404) {
			err("not found");
			return 4;
		}
		if (res.status === 200) {
			const status = res.json.summary.status;
			if (status === "theirs") {
				const events = Array.isArray(res.json.events) ? res.json.events : [];
				const event = [...events].reverse().find((item) => item.type === "feedback") || null;
				if (json) {
					out(JSON.stringify(res.json));
					return 0;
				}
				out(`FEEDBACK ${id} ${event ? event.seq : ""}`);
				if (event) out(await waitMessage(env, res.json, event));
				return 0;
			}
			if (status === "closed") {
				if (json) {
					out(JSON.stringify(res.json));
					return 0;
				}
				out(`CLOSED ${id}`);
				return 0;
			}
		}
		if (Date.now() - started >= timeoutMs) return 6;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

// ---- task 19: notify, threads, mode, takeover and handback --------------------------------------

async function cmdNotify(rest, json) {
	const { flags } = parse(rest);
	const env = process.env;
	let body;
	try {
		const urgency = flags.has("urgency") ? needed(flags, "urgency") : "soon";
		if (!URGENCIES.includes(urgency)) {
			err(`usage: --urgency must be one of ${URGENCIES.join(", ")}`);
			return 1;
		}
		body = { v: 1, producer: needed(flags, "producer"), dedupeKey: needed(flags, "key"), title: needed(flags, "title"), body: "", urgency };
	} catch (error) {
		err(error.message);
		return 1;
	}
	for (const [flag, key] of [["body", "body"], ["session", "session"], ["expires", "expiresAt"]]) {
		const value = flags.get(flag);
		if (typeof value === "string") body[key] = value;
	}
	const checked = validateNotice(body);
	if (!checked.ok) {
		for (const detail of checked.errors) err(detail);
		return 2;
	}
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const res = await call("POST", "/api/notices", checked.notice, env);
	if (res.status === 200 || res.status === 201) {
		if (json) {
			out(JSON.stringify(res.json));
			return 0;
		}
		const itemId = res.json && res.json.item ? res.json.item.itemId : null;
		out(itemId ? `ok ${itemId}` : "ok");
		return 0;
	}
	if (res.status === 400 && res.json && Array.isArray(res.json.details)) {
		for (const detail of res.json.details) err(detail);
		return 2;
	}
	return mapError(res);
}

async function cmdThreads(rest, json) {
	const { flags } = parse(rest);
	const env = process.env;
	const ensured = await ensureOk(env);
	if (ensured) return ensured;
	const query = new URLSearchParams();
	const status = flags.get("status");
	if (typeof status === "string") query.set("status", status);
	const res = await call("GET", `/api/threads${query.toString() ? `?${query}` : ""}`, null, env);
	if (res.status !== 200) return mapError(res);
	if (json) {
		out(JSON.stringify(res.json));
		return 0;
	}
	for (const row of (res.json && res.json.items) || []) {
		const newest = row.newest ?? {};
		out([row.status ?? "", row.title ?? "", row.product ?? "", row.branch ?? "", newest.headline ?? ""].join("\t"));
	}
	return 0;
}

function cmdMode(rest, json) {
	const mode = readConfig(process.env).mode === "primary" ? "primary" : "trial";
	if (json) {
		out(JSON.stringify({ mode }));
		return 0;
	}
	out(mode);
	return 0;
}

/** Runs one child to completion; takeover/handback own no other process seam. */
function runProcess(cmd, args) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child;
		try {
			child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: 1, stdout, stderr: String((error && error.message) || error) });
			return;
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolve({ code: 1, stdout, stderr: stderr + error.message }));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

function takeoverDeps(env) {
	const userHome = env.INBOX_USER_HOME || os.homedir();
	return {
		deskHome: env.INBOX_DESK_HOME || path.join(userHome, ".omo-desk"),
		inboxHome: layout(env).home,
		userHome,
		agentDir: agentDir(env),
		appDir: layout(env).app,
		run: runProcess,
		now: Date.now,
		log: (line) => out(line),
	};
}

/** A takeover/handback that never ran is not an ok exit: the caller asked for a switch. */
function switched(lines) {
	return !lines.some(({ step, result }) => (step === "takeover" || step === "handback") && /failed|skipped/.test(result));
}

async function cmdTakeover(rest, json) {
	const mod = await import("./takeover.mjs");
	const result = await mod.takeover(takeoverDeps(process.env));
	if (json) out(JSON.stringify(result));
	return switched(result) ? 0 : 1;
}

async function cmdHandback(rest, json) {
	const mod = await import("./takeover.mjs");
	const result = await mod.handback(takeoverDeps(process.env));
	if (json) out(JSON.stringify(result));
	return switched(result) ? 0 : 1;
}

async function health(env) {
	try {
		const response = await fetch(client.baseUrl(env) + "/api/health", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		const json = await response.json();
		if (json && json.name === NAME) return json;
	} catch {
		// a stopped server is the normal "stopped" answer
	}
	return null;
}

function runningLine(healthJson) {
	return `running pid=${healthJson.pid} port=${healthJson.port} version=${healthJson.version}`;
}

async function cmdServer(rest, json) {
	const action = rest[0];
	const env = process.env;
	if (action === "status") {
		const live = await health(env);
		if (!live) {
			out("stopped");
			return 7;
		}
		if (json) {
			out(JSON.stringify(live));
			return 0;
		}
		out(runningLine(live));
		return 0;
	}
	if (action === "stop") {
		await call("POST", "/api/shutdown", {}, env);
		out("stopped");
		return 0;
	}
	if (action === "start" || action === "restart") {
		if (action === "restart") await call("POST", "/api/shutdown", {}, env);
		const launchEnv = { ...env };
		delete launchEnv.INBOX_NO_ENSURE;
		const ok = await client.ensure(launchEnv);
		const live = await health(env);
		if (!ok || !live) {
			out("stopped");
			return 1;
		}
		if (json) {
			out(JSON.stringify(live));
			return 0;
		}
		out(runningLine(live));
		return 0;
	}
	err(`usage: ${CLI} server status|start|stop|restart`);
	return 1;
}

async function cmdInstall(rest, json) {
	const { flags } = parse(rest);
	const mod = await import("./install.mjs");
	const result = await mod.install({
		fromPackage: flags.get("from-package") === true,
		noTailscale: flags.get("no-tailscale") === true,
		noAutostart: flags.get("no-autostart") === true,
	});
	if (json) out(JSON.stringify({ ok: result.ok, lines: result.lines }));
	else for (const line of result.lines) out(line);
	return result.ok ? 0 : 1;
}

async function cmdUninstall(rest, json) {
	const mod = await import("./install.mjs");
	const result = await mod.uninstall({});
	if (json) out(JSON.stringify({ ok: result.ok, lines: result.lines }));
	else for (const line of result.lines) out(line);
	return result.ok ? 0 : 1;
}

async function cmdDoctor(rest, json) {
	const mod = await import("./install.mjs");
	const result = await mod.doctor({});
	if (json) out(JSON.stringify({ ok: result.ok, lines: result.lines }));
	else for (const line of result.lines) out(line);
	return result.ok ? 0 : 1;
}

export async function main(argv = []) {
	const json = argv.includes("--json");
	const args = argv.filter((token) => token !== "--json");
	const [command, ...rest] = args;
	try {
		switch (command) {
			case "submit":
				return await cmdSubmit(rest, json);
			case "revise":
				return await cmdRevise(rest, json);
			case "reply":
				return await cmdReply(rest, json);
			case "close":
				return await cmdClose(rest, json);
			case "show":
				return await cmdShow(rest, json);
			case "list":
				return await cmdList(rest, json);
			case "pending":
				return await cmdPending(rest, json);
			case "wait":
				return await cmdWait(rest, json);
			case "server":
				return await cmdServer(rest, json);
			case "notify":
				return await cmdNotify(rest, json);
			case "threads":
				return await cmdThreads(rest, json);
			case "mode":
				return cmdMode(rest, json);
			case "takeover":
				return await cmdTakeover(rest, json);
			case "handback":
				return await cmdHandback(rest, json);
			case "install":
				return await cmdInstall(rest, json);
			case "uninstall":
				return await cmdUninstall(rest, json);
			case "doctor":
				return await cmdDoctor(rest, json);
			default:
				err(USAGE);
				return 1;
		}
	} catch (error) {
		err(error && error.message ? error.message : String(error));
		return 1;
	}
}
