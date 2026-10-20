/* Isolated-home QA for `inbox takeover` / `inbox handback` (plan todo 29, contracts C2/C7).
 *
 * Usage: node qa/takeover-qa.mjs [desk repo, default C:/dev/omo/omo-desk]
 * Exit 0 only when every check passes; the last line is `N/N checks passed`.
 *
 * Everything runs against OS temp dirs:
 *   <tmp>/desk  (OMO_DESK_HOME)  port 4396 - pre-written config, never the 4377 default
 *   <tmp>/inbox (OMO_INBOX_HOME) port 4397
 *   <tmp>/user  (DESK_USER_HOME / INBOX_USER_HOME) and <tmp>/agent (the agent dirs) hold the
 *   skill/rule and the extensions, so the real ~/.omo-desk, ~/.omo-inbox and home are untouched.
 * The Run values are QA names only (DESK_RUN_VALUE/INBOX_RUN_VALUE) and every install passes
 * --no-autostart, so HKCU\...\Run is written once (by handback's desk reinstall) and cleaned up.
 * tailscale is skipped in both homes (DESK_NO_TAILSCALE/INBOX_NO_TAILSCALE=1) - this script never
 * runs tailscale and never opens ports 4377/4378/4387/4388: the only request to 4377 is the
 * before/after /api/health GET that proves the live desk was left alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const INBOX_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESK_REPO = path.resolve(process.argv[2] || "C:/dev/omo/omo-desk");
const NODE = process.execPath;
const DESK_PORT = 4396;
const INBOX_PORT = 4397;
const LIVE_PORT = 4377;
const DESK_RUN_VALUE = "omo-desk-qa";
const INBOX_RUN_VALUE = "omo-inbox-qa";
const SESSION = "qa-sess-1";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const checks = [];
let failures = 0;
function check(name, ok, detail) {
	checks.push({ name, ok });
	if (!ok) failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const note = (line) => console.log(`note ${line}`);

// ---- process / fs helpers -------------------------------------------------------------------------

function baselineEnv() {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		const upper = key.toUpperCase();
		if (upper.startsWith("DESK_") || upper.startsWith("INBOX_")) delete env[key];
		if (upper === "OMO_DESK_HOME" || upper === "OMO_INBOX_HOME" || upper === "OMO_CODING_AGENT_DIR") delete env[key];
		if (upper === "SENPI_CODING_AGENT_DIR" || upper === "PI_CODING_AGENT_DIR" || upper === "PI_SESSION_ID" || upper === "PI_SESSION_FILE") delete env[key];
	}
	return env;
}

function run(cmd, args, { env, cwd, timeoutMs = 180_000 } = {}) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child;
		try {
			child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: -1, stdout, stderr: String(error && error.message ? error.message : error) });
			return;
		}
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: -1, stdout, stderr: stderr + (error && error.message ? error.message : String(error)) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function health(port, timeoutMs = 2000) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return null;
		const json = await response.json().catch(() => null);
		return json && typeof json === "object" ? json : null;
	} catch {
		return null;
	}
}

async function shutdown(port, guard) {
	const live = await health(port);
	if (!live) return true;
	try {
		await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
			method: "POST",
			headers: { "content-type": "application/json", [guard]: "1" },
			body: "{}",
			signal: AbortSignal.timeout(3000),
		});
	} catch {
		// the health poll below is the source of truth
	}
	for (let i = 0; i < 40; i++) {
		if (!(await health(port, 400))) return true;
		await sleep(100);
	}
	if (Number.isInteger(live.pid) && live.pid > 0) {
		try {
			process.kill(live.pid);
		} catch {
			// already gone
		}
	}
	for (let i = 0; i < 20; i++) {
		if (!(await health(port, 400))) return true;
		await sleep(100);
	}
	return false;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return null;
	}
}

function sameDir(a, b) {
	const snapshot = (root) => {
		if (!fs.existsSync(root)) return null;
		const files = {};
		const walk = (dir, rel) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				const key = rel ? `${rel}/${entry.name}` : entry.name;
				if (entry.isDirectory()) walk(full, key);
				else files[key] = fs.readFileSync(full);
			}
		};
		walk(root, "");
		return files;
	};
	const left = snapshot(a);
	const right = snapshot(b);
	if (left === null || right === null) return left === right;
	const keys = Object.keys(left).sort();
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && Buffer.compare(left[key], right[key]) === 0);
}

/** Content hash of a tree: sorted relative path + bytes of every file. A missing tree hashes to null. */
function hashTree(root) {
	if (!fs.existsSync(root)) return null;
	const hash = crypto.createHash("sha256");
	const walk = (dir, rel) => {
		const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const key = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(full, key);
			else hash.update(`${key}\n`).update(fs.readFileSync(full)).update("\n");
		}
	};
	walk(root, "");
	return hash.digest("hex");
}

/** Content hash of one file; a missing file hashes to null. */
function hashFile(file) {
	if (!fs.existsSync(file)) return null;
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function findFiles(root, predicate) {
	const found = [];
	if (!fs.existsSync(root)) return found;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) found.push(...findFiles(full, predicate));
		else if (predicate(entry.name)) found.push(full);
	}
	return found;
}

function lines(text) {
	return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function hasLine(text, want) {
	return lines(text).includes(want);
}

function hasPrefixLine(text, prefix) {
	return lines(text).some((line) => line.startsWith(prefix));
}

function regQuery(valueName) {
	return run("reg.exe", ["query", RUN_KEY, "/v", valueName]);
}

function regDelete(valueName) {
	return run("reg.exe", ["delete", RUN_KEY, "/v", valueName, "/f"]);
}

// ---- the run --------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omo-inbox-takeover-qa-"));
const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-inbox-takeover-bad-"));
const deskHome = path.join(tmp, "desk");
const inboxHome = path.join(tmp, "inbox");
const userHome = path.join(tmp, "user");
const agentHome = path.join(tmp, "agent");
const deskCli = path.join(deskHome, "app", "bin", "desk.mjs");
const inboxCli = path.join(INBOX_REPO, "bin", "inbox.mjs");
const inboxApp = path.join(inboxHome, "app");
const deskData = path.join(deskHome, "data");

const deskEnv = {
	OMO_DESK_HOME: deskHome,
	DESK_USER_HOME: userHome,
	DESK_AGENT_DIR: agentHome,
	DESK_RUN_VALUE,
	DESK_NO_TAILSCALE: "1",
	DESK_URL: `http://127.0.0.1:${DESK_PORT}`,
	DESK_ENSURE_POLL_MS: "200",
};
const inboxEnv = {
	OMO_INBOX_HOME: inboxHome,
	INBOX_USER_HOME: userHome,
	INBOX_AGENT_DIR: agentHome,
	INBOX_DESK_HOME: deskHome,
	INBOX_RUN_VALUE,
	INBOX_NO_TAILSCALE: "1",
	INBOX_ENSURE_POLL_MS: "200",
};
// The takeover/handback children spawn desk's own CLI, so both families of overrides must be present.
const bothEnv = { ...deskEnv, ...inboxEnv, DESK_USER_HOME: userHome, DESK_AGENT_DIR: agentHome };

const env = (extra) => ({ ...baselineEnv(), ...extra });
const skillHomes = [path.join(userHome, ".agents", "skills", "visual-board"), path.join(userHome, ".claude", "skills", "visual-board")];
const ruleFile = path.join(userHome, ".claude", "rules", "visual-board.md");
const hashSkillRule = () => `${hashTree(skillHomes[0])}|${hashTree(skillHomes[1])}|${hashFile(ruleFile)}`;
const fileBytes = (file) => {
	try {
		return fs.readFileSync(file).toString("hex");
	} catch {
		return null;
	}
};

let liveBefore = null;
let liveAfter = null;
let serversStopped = false;

try {
	// ===== 0. preflight: the ports this script owns are free, and the live desk is recorded =====
	liveBefore = await health(LIVE_PORT);
	note(`live desk ${LIVE_PORT} health (before): ${liveBefore ? `pid=${liveBefore.pid} name=${liveBefore.name}` : "no answer"}`);
	const busy = [];
	for (const port of [DESK_PORT, INBOX_PORT]) if (await health(port)) busy.push(port);
	check(`ports ${DESK_PORT}/${INBOX_PORT} are free before the run`, busy.length === 0, busy.length ? `busy: ${busy.join(", ")}` : "");
	if (busy.length > 0) throw new Error(`port ${busy[0]} is already in use; refusing to run`);

	// ===== 1. temp desk home: config pinned to 4396, then desk's own install =====
	fs.mkdirSync(deskHome, { recursive: true });
	fs.writeFileSync(path.join(deskHome, "config.json"), `${JSON.stringify({ v: 1, port: DESK_PORT }, null, 2)}\n`);
	const deskInstall = await run(NODE, [path.join(DESK_REPO, "bin", "desk.mjs"), "install", "--no-tailscale", "--no-autostart"], { env: env(deskEnv), cwd: DESK_REPO });
	console.log("--- desk install ---\n" + deskInstall.stdout + deskInstall.stderr);
	check("desk install exits 0", deskInstall.code === 0, `code ${deskInstall.code}`);
	check("desk install wrote the app and started its server on 4396", hasPrefixLine(deskInstall.stdout, "app: written") && hasPrefixLine(deskInstall.stdout, `server: started:`), lines(deskInstall.stdout).slice(0, 3).join(" / "));
	check("desk install kept the temp port 4396 in config.json", readJson(path.join(deskHome, "config.json"))?.port === DESK_PORT);
	const deskHealth = await health(DESK_PORT);
	check(`the temp desk answers health on ${DESK_PORT} as omo-desk`, deskHealth?.name === "omo-desk", JSON.stringify(deskHealth));
	check("desk install wrote the skill and the rule into the temp user home", fs.existsSync(path.join(skillHomes[0], "SKILL.md")) && fs.existsSync(path.join(skillHomes[1], "SKILL.md")) && fs.existsSync(ruleFile));

	// ===== 2. seed: two boards + one pending feedback in the desk inbox dir =====
	const boards = [];
	for (const suffix of ["A", "B"]) {
		const dir = path.join(tmp, `board-${suffix}`);
		fs.cpSync(path.join(INBOX_REPO, "skill", "example"), dir, { recursive: true });
		boards.push(dir);
	}
	const submitted = [];
	for (const [index, dir] of boards.entries()) {
		const result = await run(NODE, [deskCli, "submit", dir, "--title", `QA 보드 ${index === 0 ? "A" : "B"}`, "--session", SESSION], { env: env(deskEnv), cwd: dir });
		console.log(`--- desk submit ${index} ---\n` + result.stdout + result.stderr);
		submitted.push({ code: result.code, id: (lines(result.stdout).find((line) => line.startsWith("id: ")) || "").slice(4) || null });
	}
	check("desk submit returns 0 twice with two distinct ids", submitted.every((item) => item.code === 0 && item.id) && submitted[0].id !== submitted[1].id, JSON.stringify(submitted.map((item) => item.id)));
	const feedback = await fetch(`http://127.0.0.1:${DESK_PORT}/api/p/${encodeURIComponent(submitted[1].id)}/feedback`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-desk": "1" },
		body: JSON.stringify({ rev: 1, verdict: "change", comment: "QA 의견: 여기를 고쳐 주세요.", answers: {} }),
	});
	const feedbackBody = await feedback.json().catch(() => null);
	console.log("--- desk feedback ---\n" + JSON.stringify(feedbackBody));
	const deskInboxFiles = findFiles(path.join(deskHome, "inbox"), (name) => name.endsWith(".json"));
	check("one feedback is pending in the desk inbox dir for the owner session", feedback.status === 200 && feedbackBody?.delivery === "pending" && deskInboxFiles.length === 1 && path.basename(path.dirname(deskInboxFiles[0])) === SESSION, `${feedback.status} ${JSON.stringify(feedbackBody)} files=${deskInboxFiles.length}`);
	const deskDataBefore = hashTree(deskData);
	check("the seeded desk data tree has content to compare against", typeof deskDataBefore === "string" && deskDataBefore.length === 64);
	const skillRuleAfterDesk = hashSkillRule();

	// ===== 3. inbox install: trial mode, no skill and no rule =====
	fs.mkdirSync(inboxHome, { recursive: true });
	fs.writeFileSync(path.join(inboxHome, "config.json"), `${JSON.stringify({ v: 1, port: INBOX_PORT }, null, 2)}\n`);
	const inboxInstall = await run(NODE, [inboxCli, "install", "--no-tailscale", "--no-autostart"], { env: env(inboxEnv), cwd: INBOX_REPO });
	console.log("--- inbox install ---\n" + inboxInstall.stdout + inboxInstall.stderr);
	check("inbox install exits 0", inboxInstall.code === 0, `code ${inboxInstall.code}`);
	check("inbox install reports trial mode and writes neither skill nor rule", hasLine(inboxInstall.stdout, "mode: trial") && hasLine(inboxInstall.stdout, "skill: skipped (trial)") && hasLine(inboxInstall.stdout, "rule: skipped (trial)"));
	check("the inbox config mode is trial", readJson(path.join(inboxHome, "config.json"))?.mode === "trial");
	check("inbox install left desk's skill and rule byte-identical (it wrote nothing)", hashSkillRule() === skillRuleAfterDesk);
	const inboxHealth = await health(INBOX_PORT);
	check(`the temp inbox answers health on ${INBOX_PORT} as omo-inbox`, inboxHealth?.name === "omo-inbox", JSON.stringify(inboxHealth));

	// ===== 4. takeover =====
	const takeover = await run(NODE, [inboxCli, "takeover"], { env: env(bothEnv), cwd: INBOX_REPO });
	console.log("--- inbox takeover ---\n" + takeover.stdout + takeover.stderr);
	check("inbox takeover exits 0", takeover.code === 0, `code ${takeover.code}`);
	check(
		"takeover printed its whole step list",
		["record: written", `import: 2 proposals, 1 mailbox files`, "desk uninstall: ok", "disabled: written", "shim: written", "mode: primary"].every((line) => hasLine(takeover.stdout, line)),
		lines(takeover.stdout).join(" / "),
	);
	const inboxProposals = fs.existsSync(path.join(inboxHome, "data", "proposals")) ? fs.readdirSync(path.join(inboxHome, "data", "proposals")).sort() : [];
	check("takeover imported both proposals into the inbox data dir", inboxProposals.length === 2 && submitted.every((item) => inboxProposals.includes(item.id)), inboxProposals.join(","));
	const mailbox = findFiles(path.join(inboxHome, "mailbox"), (name) => name.endsWith(".json"));
	check("the pending feedback sits in the inbox mailbox under the same file name", mailbox.length === 1 && path.basename(mailbox[0]) === path.basename(deskInboxFiles[0]), mailbox.map((f) => path.relative(inboxHome, f)).join(","));
	check("takeover did not change the desk data tree", hashTree(deskData) === deskDataBefore);
	check(`the desk server is stopped (nothing answers on ${DESK_PORT})`, (await health(DESK_PORT)) === null);
	check("the desk home is disabled", fs.existsSync(path.join(deskHome, "disabled")));
	const shim = deskCli;
	const shimText = fs.existsSync(shim) ? fs.readFileSync(shim, "utf8") : "";
	const shimMarker = readJson(path.join(deskHome, "app", "SHIM.json"));
	check(
		"the shim imports the inbox CLI and SHIM.json marks it as omo-inbox's",
		shimText.includes(`${inboxApp.replace(/\\/g, "/")}/src/cli.mjs`) && shimText.includes("import { main }") && shimMarker?.by === "omo-inbox",
		shimText.split("\n")[0],
	);
	check("the inbox config mode is primary", readJson(path.join(inboxHome, "config.json"))?.mode === "primary");
	check("the skill dirs hold the inbox app's copies", skillHomes.every((dir) => sameDir(path.join(inboxApp, "skill"), dir)));
	check("the rule holds the inbox app's copy", fileBytes(ruleFile) !== null && fileBytes(ruleFile) === fileBytes(path.join(inboxApp, "rules", "visual-board.md")));
	// The import landed after the inbox server had started, so restart it to prove a fresh read.
	const restartInbox = await run(NODE, [inboxCli, "server", "restart"], { env: env(inboxEnv), cwd: INBOX_REPO });
	console.log("--- inbox server restart ---\n" + restartInbox.stdout + restartInbox.stderr);
	check("the inbox server restarts on 4397", restartInbox.code === 0 && (await health(INBOX_PORT))?.name === "omo-inbox");
	const shimList = await run(NODE, [shim, "list"], { env: env(inboxEnv), cwd: tmp });
	console.log("--- desk (shim) list ---\n" + shimList.stdout + shimList.stderr);
	check(
		"the shim runs `desk list` against the inbox server and lists both imported proposals",
		shimList.code === 0 && submitted.every((item) => lines(shimList.stdout).some((line) => line.startsWith(item.id))),
		`code ${shimList.code}: ${lines(shimList.stdout).join(" | ")}`,
	);

	// ===== 5. handback =====
	// desk uninstall removed <deskHome>/config.json, so desk's reinstall would fall back to port 4377
	// and could shut a live server down. Pin the temp port again before handback runs that install.
	fs.writeFileSync(path.join(deskHome, "config.json"), `${JSON.stringify({ v: 1, port: DESK_PORT }, null, 2)}\n`);
	const handback = await run(NODE, [inboxCli, "handback"], { env: env(bothEnv), cwd: INBOX_REPO });
	console.log("--- inbox handback ---\n" + handback.stdout + handback.stderr);
	check("inbox handback exits 0", handback.code === 0, `code ${handback.code}`);
	check(
		"handback removed the shim and the skill/rule, reinstalled desk, and set trial",
		["shim: removed", "skill: removed", "rule: removed", "disabled: removed", "desk: reinstalled", "mode: trial", "record: archived"].every((line) => hasLine(handback.stdout, line)),
		lines(handback.stdout).join(" / "),
	);
	// handback prints only its own steps, so the skip shows up in the desk config its install wrote:
	// a tailscale run would have stored publicBase (and a 443 baseline).
	const deskConfigBack = readJson(path.join(deskHome, "config.json"));
	check(
		"handback's desk install skipped tailscale (no publicBase, no 443 baseline stored)",
		Boolean(deskConfigBack) && deskConfigBack.publicBase === null && !("baseline443" in deskConfigBack),
		JSON.stringify(deskConfigBack),
	);
	const deskBinText = fs.existsSync(path.join(deskHome, "app", "bin", "desk.mjs")) ? fs.readFileSync(path.join(deskHome, "app", "bin", "desk.mjs"), "utf8") : "";
	check(
		"the desk app is back (its own CLI and server, not the shim)",
		deskBinText.includes(`"../src/cli.mjs"`) && !deskBinText.includes("/inbox/app/src/cli.mjs") && fs.existsSync(path.join(deskHome, "app", "src", "server.mjs")),
		deskBinText.split("\n")[1],
	);
	check("desk's disabled marker is gone", !fs.existsSync(path.join(deskHome, "disabled")));
	const archived = fs.existsSync(inboxHome) ? fs.readdirSync(inboxHome).filter((name) => /^takeover-\d+\.json$/.test(name)) : [];
	check("the takeover record is archived as takeover-<epoch>.json", !fs.existsSync(path.join(inboxHome, "takeover.json")) && archived.length === 1, archived.join(","));
	check("the mode is trial again", readJson(path.join(inboxHome, "config.json"))?.mode === "trial");
	const inboxProposalsAfter = fs.existsSync(path.join(inboxHome, "data", "proposals")) ? fs.readdirSync(path.join(inboxHome, "data", "proposals")).sort() : [];
	check("the inbox data is kept (both proposals remain)", inboxProposalsAfter.length === 2 && submitted.every((item) => inboxProposalsAfter.includes(item.id)), inboxProposalsAfter.join(","));
	check("desk's skill and rule are back in the temp user home", fs.existsSync(path.join(skillHomes[0], "SKILL.md")) && fs.existsSync(ruleFile) && sameDir(path.join(deskHome, "app", "skill"), skillHomes[0]));
	const doctor = await run(NODE, [path.join(deskHome, "app", "bin", "desk.mjs"), "doctor"], { env: env(deskEnv), cwd: DESK_REPO });
	console.log("--- desk doctor (reinstalled app) ---\n" + doctor.stdout + doctor.stderr);
	check("desk doctor exits 0 with every line ok", doctor.code === 0 && lines(doctor.stdout).length > 0 && lines(doctor.stdout).every((line) => line.endsWith(": ok")), lines(doctor.stdout).join(" / "));
	const deskBack = await health(DESK_PORT);
	check(`the reinstalled desk answers health on ${DESK_PORT}`, deskBack?.name === "omo-desk", JSON.stringify(deskBack));

	// ===== 6. failure path: a desk uninstall that exits 1 stops takeover before the shim =====
	const badDeskHome = path.join(badRoot, "desk");
	const badInboxHome = path.join(badRoot, "inbox");
	const badUserHome = path.join(badRoot, "user");
	const badBin = path.join(badDeskHome, "app", "bin", "desk.mjs");
	const marker = path.join(badRoot, "stub-ran.txt");
	fs.mkdirSync(path.dirname(badBin), { recursive: true });
	const stubText = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran\\n");\nprocess.exit(1);\n`;
	fs.writeFileSync(badBin, stubText);
	fs.writeFileSync(path.join(badDeskHome, "app", "source.json"), `${JSON.stringify({ v: 1, channel: "checkout", source: DESK_REPO }, null, 2)}\n`);
	fs.mkdirSync(badInboxHome, { recursive: true });
	fs.writeFileSync(path.join(badInboxHome, "config.json"), `${JSON.stringify({ v: 1, port: 4399 }, null, 2)}\n`);
	const badEnv = {
		OMO_INBOX_HOME: badInboxHome,
		INBOX_USER_HOME: badUserHome,
		INBOX_AGENT_DIR: path.join(badRoot, "agent"),
		INBOX_DESK_HOME: badDeskHome,
		INBOX_RUN_VALUE,
		INBOX_NO_TAILSCALE: "1",
		OMO_DESK_HOME: badDeskHome,
		DESK_USER_HOME: badUserHome,
		DESK_AGENT_DIR: path.join(badRoot, "agent"),
		DESK_RUN_VALUE,
		DESK_NO_TAILSCALE: "1",
	};
	const badTakeover = await run(NODE, [inboxCli, "takeover"], { env: env(badEnv), cwd: INBOX_REPO });
	console.log("--- inbox takeover (desk uninstall exits 1) ---\n" + badTakeover.stdout + badTakeover.stderr);
	check("takeover with a failing desk uninstall exits 1 and says failed (desk uninstall)", badTakeover.code === 1 && hasLine(badTakeover.stdout, "takeover: failed (desk uninstall)"), `code ${badTakeover.code}`);
	check("the forced-failure takeover really ran the desk bin", hasLine(badTakeover.stdout, "record: written") && fs.existsSync(marker));
	check("it stopped before the shim (no SHIM.json, no disabled)", !fs.existsSync(path.join(badDeskHome, "app", "SHIM.json")) && !fs.existsSync(path.join(badDeskHome, "disabled")));
	check("it left the desk app intact", fs.existsSync(badBin) && fs.readFileSync(badBin, "utf8") === stubText);
	check("it wrote neither skill nor rule and kept mode trial", !fs.existsSync(path.join(badUserHome, ".agents", "skills", "visual-board")) && !fs.existsSync(path.join(badUserHome, ".claude", "rules", "visual-board.md")) && readJson(path.join(badInboxHome, "config.json"))?.mode === undefined);
} catch (error) {
	check("the QA script itself runs to the end", false, error && error.stack ? error.stack.split("\n")[0] : String(error));
} finally {
	// ===== 7. stop every server, drop the QA Run value, remove the temp dirs =====
	const deskStopped = await shutdown(DESK_PORT, "x-desk");
	const inboxStopped = await shutdown(INBOX_PORT, "x-inbox");
	serversStopped = deskStopped && inboxStopped;
	check(`no server answers on ${DESK_PORT} or ${INBOX_PORT} after the run`, serversStopped);
	const before = await regQuery(DESK_RUN_VALUE);
	if (before.code === 0) await regDelete(DESK_RUN_VALUE);
	const after = await regQuery(DESK_RUN_VALUE);
	check(`the QA Run value ${DESK_RUN_VALUE} is not left in HKCU`, after.code !== 0, before.code === 0 ? "removed after handback wrote it" : "never written");
	liveAfter = await health(LIVE_PORT);
	note(`live desk ${LIVE_PORT} health (after): ${liveAfter ? `pid=${liveAfter.pid} name=${liveAfter.name}` : "no answer"}`);
	check("the live desk at 4377 was never disturbed (health pid unchanged)", (liveBefore?.pid ?? null) === (liveAfter?.pid ?? null), `before=${liveBefore?.pid ?? "-"} after=${liveAfter?.pid ?? "-"}`);
	if (!process.env.QA_KEEP) {
		for (const dir of [tmp, badRoot]) fs.rmSync(dir, { recursive: true, force: true });
	}
	const passed = checks.filter((item) => item.ok).length;
	console.log(`\n${passed}/${checks.length} checks passed`);
	if (failures > 0) {
		console.log("failed:");
		for (const item of checks.filter((entry) => !entry.ok)) console.log(`- ${item.name}`);
	}
	process.exitCode = failures === 0 ? 0 : 1;
}
