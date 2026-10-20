import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir, readConfig } from "./paths.mjs";
import { launchServer } from "./launch.mjs";

const NAME = "omo-inbox";
const HEALTH_TIMEOUT_MS = 1500;
const ENSURE_ATTEMPTS = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The board server this CLI talks to: an explicit INBOX_URL, else the configured port. */
export function baseUrl(env = process.env) {
	return env.INBOX_URL || "http://127.0.0.1:" + readConfig(env).port;
}

/** One request against the server. POSTs carry the JSON + x-inbox guard the server requires. */
export async function api(method, route, body, env = process.env) {
	const init = { method };
	if (body !== undefined && body !== null) {
		init.headers = { "content-type": "application/json", "x-inbox": "1" };
		init.body = JSON.stringify(body);
	}
	const response = await fetch(baseUrl(env) + route, init);
	const text = await response.text();
	let json = null;
	try {
		json = text === "" ? null : JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: response.status, json };
}

function ownVersion() {
	try {
		const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (parsed && typeof parsed.version === "string") return parsed.version;
	} catch {
		// an unreadable package.json only means the version check is skipped
	}
	return null;
}

/** The version of the app installed under <home>/app; null when it is missing or unreadable. */
function installedVersion(env) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(homeDir(env), "app", "package.json"), "utf8"));
		if (parsed && typeof parsed.version === "string") return parsed.version;
	} catch {
		// a missing installed package.json only means the version check is skipped
	}
	return null;
}

async function probe(env) {
	try {
		const response = await fetch(baseUrl(env) + "/api/health", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		const json = JSON.parse(await response.text());
		if (json && typeof json === "object") return json;
	} catch {
		// no answer is a normal outcome: the caller launches the server
	}
	return null;
}

function foreign(env) {
	const error = new Error(`${baseUrl(env)} is held by another process (not ${NAME})`);
	error.code = "foreign";
	return error;
}

async function start(env, version) {
	await launchServer({ env });
	const waitMs = Number(env.INBOX_ENSURE_POLL_MS) || 500;
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		await sleep(waitMs);
		const health = await probe(env);
		if (health && health.name !== NAME) throw foreign(env);
		if (health && health.ok === true) {
			if (version !== null && health.version !== version) {
				process.stderr.write(`server version ${health.version} differs from cli ${version}\n`);
			}
			return true;
		}
	}
	return false;
}

/** Wait, at most ENSURE_ATTEMPTS polls, for a server that was just shut down to stop answering health. */
async function waitForShutdown(env) {
	const waitMs = Number(env.INBOX_ENSURE_POLL_MS) || 500;
	for (let attempt = 0; attempt < ENSURE_ATTEMPTS; attempt++) {
		await sleep(waitMs);
		if (!(await probe(env))) return;
	}
}

/**
 * Make sure the board server at this CLI's base URL is the right one and alive.
 * INBOX_NO_ENSURE=1 answers the health question only and never launches anything.
 */
export async function ensure(env = process.env) {
	const health = await probe(env);
	if (health && health.name !== NAME) throw foreign(env);
	if (env.INBOX_NO_ENSURE === "1") return Boolean(health && health.ok === true);
	const version = ownVersion();
	if (health && version !== null && health.version !== version) {
		// Only a stale install of our own version is safe to shut down; anything else
		// means the CLI is running from a different checkout than the installed app.
		if (installedVersion(env) === version) {
			await api("POST", "/api/shutdown", {}, env);
			await waitForShutdown(env);
			return start(env, version);
		}
		process.stderr.write(`server version ${health.version} differs from cli ${version}; run install to update\n`);
		return true;
	}
	if (health) return true;
	return start(env, version);
}
