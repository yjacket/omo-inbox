/* Entry point for the issue-reporting QA scenarios.
 *
 * Usage: bun qa/issues-qa.mjs <appDir> <outDir> --scenario QNN [--width 390 --height 844
 *        --scheme light|dark] [--probe-failure] [--q01 <review.md>]
 *        bun qa/issues-qa.mjs <appDir> <outDir> --all|--present-only [--width W --height H
 *        --scheme light|dark] [--q01 <review.md>]
 *
 * Creates a private temp root, starts the isolated server fixture, launches an owned headless
 * browser, runs the requested scenario, then closes the browser and the server in finally and
 * removes the temp root. Writes <outDir>/manifest.json. On success the last line is
 * "<passed>/<total> checks passed". On failure the checks line may still appear, but the LAST
 * stdout line is "RUN FAILED: <reason>" with the teardown problem (entry, error and holder PIDs)
 * in the lines just above it, and the exit code is nonzero. Exit 0 only when every check passed
 * AND the teardown receipt proves the child exited, the port refuses connections and home/runTmp
 * read back ENOENT. In aggregate mode every scenario fixture is reaped by its exact profile path
 * (including second browsers a scenario opened) before the aggregate receipt is built.
 *
 * Viewport: an explicit --width/--height/--scheme flag wins; otherwise a scenario module MAY export
 * `viewport = { width, height, scheme? }` (Q09 needs the 720px split view); otherwise the harness
 * default is 390x844/light. Every scenario result records the effective viewport plus whether each
 * dimension came from the flag, the scenario or the default.
 *
 * --all enumerates the expected matrix Q02..Q20 from a constant, lists every missing module as
 * {id, status:"missing"} and exits nonzero when one is missing or failed. --present-only runs the
 * modules that exist, still lists the missing ones, and exits nonzero only on a failed check.
 * --q01 records the separately authored Q01 review receipt path and its sha256, else q01:"absent".
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIssueQa, openQaBrowser, profileHolders, reapQaBrowserProcesses, removeTree, runIssueScenario, withDeadline } from "./issues-fixture.mjs";
import { IS_COVERAGE } from "./issues/fixture-data.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED = ["Q02", "Q03", "Q04", "Q05", "Q06", "Q07", "Q08", "Q09", "Q10", "Q11", "Q12", "Q13", "Q14", "Q15", "Q16", "Q17", "Q18", "Q19", "Q20"];

const DEFAULT_VIEWPORT = { width: 390, height: 844, scheme: "light" };
// A close that outlives this named deadline is finished through the profile reaper below.
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;

function usage(message) {
	if (message) console.error(message);
	console.error("usage: bun qa/issues-qa.mjs <appDir> <outDir> --scenario QNN [--width 390 --height 844 --scheme light|dark] [--probe-failure] [--probe-close-timeout] [--probe-close-holder] [--q01 <review.md>]");
	console.error("       bun qa/issues-qa.mjs <appDir> <outDir> --all|--present-only [--width W --height H --scheme light|dark] [--q01 <review.md>]");
	console.error("       viewport: explicit flag > scenario export > 390x844/light");
	process.exit(1);
}

function parseArgs(argv) {
	const positional = [];
	const options = { scenario: null, width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height, scheme: DEFAULT_VIEWPORT.scheme, all: false, presentOnly: false, probeFailure: false, probeCloseTimeout: false, probeCloseHolder: false, q01: null, explicit: { width: false, height: false, scheme: false } };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--scenario") options.scenario = argv[++index];
		else if (arg === "--width") {
			options.width = Number(argv[++index]);
			options.explicit.width = true;
		} else if (arg === "--height") {
			options.height = Number(argv[++index]);
			options.explicit.height = true;
		} else if (arg === "--scheme") {
			options.scheme = argv[++index];
			options.explicit.scheme = true;
		}
		else if (arg === "--all") options.all = true;
		else if (arg === "--present-only") options.presentOnly = true;
		else if (arg === "--probe-failure") options.probeFailure = true;
		else if (arg === "--probe-close-timeout") options.probeCloseTimeout = true;
		else if (arg === "--probe-close-holder") options.probeCloseHolder = true;
		else if (arg === "--q01") options.q01 = argv[++index];
		else if (arg.startsWith("--")) usage(`unknown option: ${arg}`);
		else positional.push(arg);
	}
	if (positional.length < 2) usage("missing appDir or outDir");
	if (!options.all && !options.presentOnly && !options.scenario) usage("--scenario QNN, --all or --present-only is required");
	if (options.all && options.presentOnly) usage("--all and --present-only are mutually exclusive");
	if ((options.all || options.presentOnly) && options.probeFailure) usage("--probe-failure runs one scenario, not a matrix");
	if ((options.all || options.presentOnly) && (options.probeCloseTimeout || options.probeCloseHolder)) usage("close probes run one scenario, not a matrix");
	if (options.probeCloseTimeout && options.probeCloseHolder) usage("--probe-close-timeout and --probe-close-holder are mutually exclusive");
	if (!["light", "dark"].includes(options.scheme)) usage(`--scheme must be light or dark, got ${options.scheme}`);
	if (!Number.isFinite(options.width) || !Number.isFinite(options.height) || options.width <= 0 || options.height <= 0) usage("width and height must be positive numbers");
	if (options.q01 && !fs.existsSync(path.resolve(options.q01))) usage(`--q01 receipt not found: ${options.q01}`);
	return { appDir: path.resolve(positional[0]), outDir: path.resolve(positional[1]), ...options };
}

async function effectiveViewport(id, args) {
	let declared = null;
	const file = path.join(HERE, "issues", `${id.toLowerCase()}.mjs`);
	if (fs.existsSync(file)) {
		try {
			const module = await import(pathToFileURL(file).href);
			if (module.viewport && typeof module.viewport === "object") declared = module.viewport;
		} catch {
			// the scenario import below reports the real failure
		}
	}
	const pick = (dimension) => {
		if (args.explicit[dimension]) return { value: args[dimension], source: "flag" };
		if (declared && declared[dimension] !== undefined) {
			const valid =
				dimension === "scheme"
					? ["light", "dark"].includes(declared[dimension])
					: Number.isFinite(declared[dimension]) && declared[dimension] > 0;
			if (valid) return { value: declared[dimension], source: "scenario" };
		}
		return { value: DEFAULT_VIEWPORT[dimension], source: "default" };
	};
	const width = pick("width");
	const height = pick("height");
	const scheme = pick("scheme");
	return {
		width: width.value,
		height: height.value,
		scheme: scheme.value,
		viewport: { width: width.value, height: height.value, scheme: scheme.value },
		viewportSource: { width: width.source, height: height.source, scheme: scheme.source },
	};
}

function scenarioExists(id) {
	return fs.existsSync(path.join(HERE, "issues", `${id.toLowerCase()}.mjs`));
}

function q01Record(file) {
	if (!file) return "absent";
	const abs = path.resolve(file);
	const sha256 = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
	return { status: "present", path: abs, sha256 };
}

// A receipt is clean only when the server left, the port is closed, the private profile is gone
// and no reaper attempt left a browser process behind. A close timeout by itself is not a failure:
// the reaper finishing the teardown makes the run clean and records closeTimedOut:true.
function cleanupProblems(cleanup) {
	if (!cleanup) return ["cleanup receipt is missing"];
	const problems = [];
	if (cleanup.aggregate === true) {
		// The aggregate receipt is built from each scenario's FINAL disk/process state after the
		// exact-profile reaper ran, so early removal attempts that were later resolved are kept in
		// reaped/initialProblems for the record but must not fail the run.
		if (Array.isArray(cleanup.problems)) problems.push(...cleanup.problems);
		if (cleanup.serverExited !== true) problems.push("one or more scenario servers did not exit");
		if (cleanup.portClosed !== true) problems.push("one or more scenario ports stayed open");
		if (cleanup.readBack !== "ENOENT") problems.push("one or more scenario fixtures read back " + cleanup.readBack);
		return problems;
	}
	const reaped = Array.isArray(cleanup.reaped) ? cleanup.reaped : [];
	const matched = [];
	for (const attempt of reaped) {
		if (attempt && attempt.error) problems.push(`browser reaper failed: ${attempt.error}`);
		const remaining = attempt && Array.isArray(attempt.remaining) ? attempt.remaining : [];
		if (remaining.length) problems.push(`browser processes remain: ${remaining.join(",")}`);
		if (attempt && Array.isArray(attempt.matched)) matched.push(...attempt.matched);
	}
	const logs = Array.isArray(cleanup.removalLog) ? cleanup.removalLog : [];
	const profile = logs.find((entry) => entry.entry === "profile");
	if (profile && profile.removed !== true) {
		const holders = Array.isArray(cleanup.holders) ? cleanup.holders : [];
		const reported = holders.length
			? holders.map((item) => `${item.name || "process"} pid ${item.pid}`).join(", ")
			: matched.length
				? matched.map((item) => `${item.name || "process"} pid ${item.pid}`).join(", ")
				: "no matching browser process";
		problems.push(`profile was not removed${profile.error ? ` (${profile.error})` : ""}; holder: ${reported}`);
	}
	return problems;
}

// Simulate a close that never settles: the 30 s named deadline is the only way out. With a holder
// absent the reaper must still finish the run cleanly; with `--probe-close-holder` a detached child
// process holds the profile open, so the reaper leaves it and the run must report it.
function armCloseProbe(browser, ctx, args) {
	const lockFile = path.join(ctx.profileDir, "close-probe-holder.lock");
	let holder = null;
	if (args.probeCloseHolder) {
		// The cwd inside the profile is what Windows refuses to remove; the open file alone can be
		// deleted (Node opens with FILE_SHARE_DELETE), so the detached holder keeps both.
		holder = spawn(
			process.execPath,
			["-e", "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'w');fs.writeSync(fd,'held');setInterval(()=>{},1000);", lockFile],
			{ detached: true, cwd: ctx.profileDir, stdio: "ignore", windowsHide: true },
		);
		holder.unref();
	}
	const holderName = path.basename(process.execPath);
	const record = {
		simulatedStuckClose: true,
		holder: holder ? { pid: holder.pid, name: holderName, lockFile } : null,
		expectedExit: args.probeCloseHolder ? 1 : 0,
	};
	fs.writeFileSync(path.join(args.outDir, "close-probe.json"), JSON.stringify(record, null, "\t"));
	browser.close = () => new Promise(() => {});
	if (holder) console.error(`close probe holder started - ${holderName} pid ${holder.pid} holds ${lockFile} and cwd`);
	else console.error("close probe - browser close is stalled with no holder");
}

// Every browser a scenario opens lives under its private fixture root: the primary profile plus
// second profiles such as Q12's native-capture directories. Reap every one by its exact path
// until no matching process remains, bounded by the same 30 s named close deadline.
function scenarioProfileDirs(root) {
	const found = [];
	const walk = (dir, depth) => {
		if (depth > 4) return;
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const full = path.join(dir, entry.name);
			if (entry.name === "profile" || entry.name.startsWith("q12-native-")) found.push(full);
			else walk(full, depth + 1);
		}
	};
	walk(root, 0);
	return found;
}

function summarizeReap(passes) {
	const matched = [];
	const killed = [];
	const remaining = [];
	let error = null;
	for (const pass of passes) {
		if (Array.isArray(pass.matched)) matched.push(...pass.matched);
		if (Array.isArray(pass.killed)) killed.push(...pass.killed);
		if (Array.isArray(pass.remaining)) remaining.push(...pass.remaining);
		if (pass.error) error ??= pass.error;
	}
	return { matched, killed, remaining, error, passes: passes.length };
}

async function reapFixtureProfiles(root, { deadlineMs = BROWSER_CLOSE_TIMEOUT_MS } = {}) {
	const passes = [];
	const end = Date.now() + deadlineMs;
	for (let cycle = 0; cycle < 400; cycle++) {
		const dirs = scenarioProfileDirs(root);
		if (dirs.length === 0) break;
		let seen = 0;
		let failed = null;
		for (const dir of dirs) {
			const result = await reapQaBrowserProcesses(dir).catch((error) => ({ matched: [], killed: [], remaining: [], error: error && error.message ? error.message : String(error) }));
			passes.push(result);
			seen += (result.matched?.length ?? 0) + (result.remaining?.length ?? 0);
			if (result.error) failed = result.error;
		}
		if (failed) break;
		if (seen === 0) break;
		if (Date.now() >= end) break;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return passes;
}

function cleanupOk(cleanup, runTmpReadBack) {
	return (
		Boolean(cleanup) &&
		cleanup.serverExited === true &&
		cleanup.portClosed === true &&
		cleanup.readBack === "ENOENT" &&
		runTmpReadBack === "ENOENT" &&
		cleanupProblems(cleanup).length === 0
	);
}

async function probeFailure(ctx, browser, width, height, scheme, id) {
	const { evidenceDir } = ctx;
	const file = path.join(HERE, "issues", `${id.toLowerCase()}.mjs`);
	const checks = [];
	const check = (name, ok, detail) => {
		const entry = { name, ok: ok === true, detail: detail === undefined ? null : detail };
		checks.push(entry);
		console.log(`${entry.ok ? "PASS" : "FAIL"} ${name}${entry.detail === null ? "" : ` - ${entry.detail}`}`);
	};
	const evidence = (name, data) => {
		fs.mkdirSync(evidenceDir, { recursive: true });
		const target = path.join(evidenceDir, name);
		fs.writeFileSync(target, data);
		return target;
	};
	try {
		const module = await import(pathToFileURL(file).href);
		if (typeof module.runFailureProbe !== "function") throw new Error(`${id} has no runFailureProbe export`);
		await module.runFailureProbe({ browser, ctx, width, height, scheme, check, evidence });
	} catch (error) {
		check(`${id} failure probe ran`, false, error && error.stack ? error.stack : String(error));
	}
	const passed = checks.filter((entry) => entry.ok).length;
	return { id, status: "present", checks, passed, failed: checks.length - passed };
}

const args = parseArgs(process.argv.slice(2));
const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ulw-A-task6-"));
fs.mkdirSync(args.outDir, { recursive: true });
const scenarios = [];
const notes = [];
const q01 = q01Record(args.q01);
const aggregateMode = args.all || args.presentOnly;
const scenarioCleanups = [];
let ctx = null;
let browser = null;
let cleanup = null;
let browserRecord = null;
let harnessError = null;
let closeTimedOut = false;
let closeReap = null;

async function runIsolatedScenario(id, viewport) {
	const scenarioTmp = path.join(runTmp, id);
	const scenarioDir = path.join(args.outDir, id);
	fs.mkdirSync(scenarioTmp, { recursive: true });
	fs.mkdirSync(scenarioDir, { recursive: true });
	let localCtx = null;
	let localBrowser = null;
	let result = null;
	let receipt = null;
	let localTimedOut = false;
	let localReap = null;
	let localError = null;
	const startedAt = Date.now();
	try {
		localCtx = await createIssueQa({ appDir: args.appDir, runTmp: scenarioTmp, evidenceDir: scenarioDir, port: 0 });
		localBrowser = await withDeadline(openQaBrowser(localCtx, { width: viewport.width, height: viewport.height, scheme: viewport.scheme }), 60_000, "scenario_browser_launch_" + id);
		if (localCtx.port <= 0) throw new Error("server reported no port");
		result = await runIssueScenario(id, { browser: localBrowser, ctx: localCtx, width: viewport.width, height: viewport.height, scheme: viewport.scheme });
	} catch (error) {
		localError = error && error.stack ? error.stack : String(error);
		console.error("scenario " + id + " failed - " + localError);
		result = { id, checks: [{ name: id + " scenario ran", ok: false, detail: localError }], passed: 0, failed: 1 };
	} finally {
		if (localBrowser) {
			try {
				await withDeadline(localBrowser.close(), BROWSER_CLOSE_TIMEOUT_MS, "scenario_browser_close_" + id);
			} catch (error) {
				const message = error && error.message ? error.message : String(error);
				if (error && error.code === "deadline" && error.operation === "scenario_browser_close_" + id) {
					localTimedOut = true;
					console.error("scenario " + id + " browser close timed out - reaping");
				} else {
					localError ??= "browser close failed: " + message;
				}
			} finally {
				if (localCtx) {
					// Before the server teardown removes the fixture, reap every profile a scenario opened
					// (the primary one and second browsers like Q12's) by exact path.
					const passes = await reapFixtureProfiles(scenarioTmp);
					localReap = passes.length
						? summarizeReap(passes)
						: { matched: [], killed: [], remaining: [], error: null };
				}
			}
		}
		if (localCtx) {
			try {
				receipt = await withDeadline(localCtx.close({ closeTimedOut: localTimedOut, closeReap: localReap }), 60_000, "scenario_ctx_close_" + id);
			} catch (error) {
				localError ??= "server cleanup failed: " + (error && error.message ? error.message : String(error));
				try { receipt = JSON.parse(fs.readFileSync(path.join(scenarioDir, "cleanup.json"), "utf8")); } catch { receipt = null; }
			}
		} else {
			try { receipt = JSON.parse(fs.readFileSync(path.join(scenarioDir, "cleanup.json"), "utf8")); } catch { receipt = null; }
		}
		const removal = await removeTree(scenarioTmp);
		let readBack = "ENOENT";
		try { fs.statSync(scenarioTmp); readBack = "PRESENT"; } catch (error) { readBack = error.code || "ERROR"; }
		const problems = cleanupProblems(receipt);
		scenarioCleanups.push({ id, receipt, readBack, problems, closeTimedOut: localTimedOut, removal, error: localError });
	}
	return {
		...result,
		status: "present",
		total: result.checks.length,
		durationMs: Date.now() - startedAt,
		evidenceDir: scenarioDir,
		viewport: viewport.viewport,
		viewportSource: viewport.viewportSource,
	};
}

try {
	if (aggregateMode) {
		notes.push("Q01 is a review document, not an executable scenario; receipt: " + (q01 === "absent" ? "absent" : q01.path));
		notes.push("every executable scenario ran against its own fresh fixture home, so state from another scenario cannot change its counts");
		for (const id of EXPECTED) {
			if (!scenarioExists(id)) {
				scenarios.push({ id, status: "missing", evidenceDir: path.join(args.outDir, id) });
				continue;
			}
			const viewport = await effectiveViewport(id, args);
			scenarios.push(await runIsolatedScenario(id, viewport));
		}
		// Every browser a scenario opened may outlive its page close (a Chrome helper can recreate
		// a profile entry just after ctx.close reports the profile removed). For every scenario run
		// root, reap each profile directory by exact path with the 30 s bounded close, then retry the
		// removal and derive the FINAL clean state from the real disk and process table. Early
		// failures stay in initialProblems/reaped for the record; only an actual leftover fails.
		for (const run of scenarioCleanups) {
			run.initialProblems = cleanupProblems(run.receipt);
			const fixtureDir = path.join(runTmp, run.id);
			const passes = await reapFixtureProfiles(fixtureDir);
			const reap = summarizeReap(passes);
			const removal = fs.existsSync(fixtureDir) ? await removeTree(fixtureDir) : { removed: true, attempts: 0, fallback: false };
			run.retryRemoval = { reap, removal };
			run.readBack = fs.existsSync(fixtureDir) ? "PRESENT" : "ENOENT";
			const problems = [];
			if (run.receipt) {
				if (run.receipt.serverExited !== true) problems.push("server did not exit");
				if (run.receipt.portClosed !== true) problems.push("port stayed open");
				if (run.receipt.readBack !== "ENOENT") problems.push(`fixture home read back ${run.receipt.readBack}`);
			}
			run.finalHolders = [];
			if (run.readBack !== "ENOENT") {
				const holders = await profileHolders(fixtureDir).catch(() => []);
				run.finalHolders = holders;
				const profile = (run.receipt?.removalLog ?? []).find((entry) => entry.entry === "profile");
				const holderText = holders.length ? holders.map((item) => `${item.name || "process"} pid ${item.pid}`).join(", ") : "no matching browser process";
				problems.push(`fixture was not removed${profile?.error ? ` (${profile.error})` : removal.error ? ` (${removal.error})` : ""}; holder: ${holderText}`);
			}
			if (reap.remaining.length) problems.push(`browser processes remain: ${reap.remaining.join(",")}`);
			if (reap.error) problems.push(`browser reaper failed: ${reap.error}`);
			run.problems = problems;
			if (run.problems.length) console.error("fixture " + run.id + " final cleanup problem - " + run.problems.join("; "));
		}
		const mergedLog = [];
		const mergedReaped = [];
		for (const run of scenarioCleanups) {
			if (Array.isArray(run.receipt?.removalLog)) mergedLog.push(...run.receipt.removalLog);
			if (Array.isArray(run.receipt?.reaped)) mergedReaped.push(...run.receipt.reaped);
			if (Array.isArray(run.retryRemoval?.reap?.matched) && run.retryRemoval.reap.matched.length) mergedReaped.push({ attempt: "aggregate-retry", ...run.retryRemoval.reap });
		}
		const cleanRuns = scenarioCleanups.filter((run) => run.receipt && run.receipt.serverExited === true && run.receipt.portClosed === true && run.receipt.readBack === "ENOENT" && run.readBack === "ENOENT" && run.problems.length === 0);
		cleanup = {
			aggregate: true,
			serverExited: scenarioCleanups.length > 0 && cleanRuns.length === scenarioCleanups.length,
			portClosed: scenarioCleanups.length > 0 && cleanRuns.length === scenarioCleanups.length,
			readBack: scenarioCleanups.length > 0 && cleanRuns.length === scenarioCleanups.length ? "ENOENT" : "PRESENT",
			removalLog: mergedLog,
			reaped: mergedReaped,
			holders: scenarioCleanups.flatMap((run) => run.finalHolders ?? []),
			closeTimedOut: scenarioCleanups.some((run) => run.closeTimedOut),
			problems: scenarioCleanups.flatMap((run) => run.problems.map((problem) => `${run.id}: ${problem}`)),
			perScenario: scenarioCleanups.map((run) => ({ id: run.id, checkpoint: run.receipt ? { serverExited: run.receipt.serverExited, portClosed: run.receipt.portClosed, readBack: run.receipt.readBack } : null, runTmpReadBack: run.readBack, retryRemoval: run.retryRemoval ?? null, initialProblems: run.initialProblems, problems: run.problems })),
		};
		if (!cleanup.serverExited) harnessError = "one or more isolated scenario fixtures did not clean up";
		fs.writeFileSync(path.join(args.outDir, "cleanup.json"), JSON.stringify(cleanup, null, "\t"));
		browserRecord = { aggregate: true, isolatedFixtures: true, runs: scenarioCleanups.map((run) => run.id) };
	} else {
		ctx = await createIssueQa({ appDir: args.appDir, runTmp, evidenceDir: args.outDir, port: 0 });
		browser = await withDeadline(openQaBrowser(ctx, { width: args.width, height: args.height, scheme: args.scheme }), 60_000, "harness_browser_launch");
		if (ctx.port <= 0) throw new Error("server reported no port");
		if (args.probeFailure) {
			const id = (args.scenario || "Q06").toUpperCase();
			const viewport = await effectiveViewport(id, args);
			const result = await probeFailure(ctx, browser, viewport.width, viewport.height, viewport.scheme, id);
			scenarios.push({ ...result, viewport: viewport.viewport, viewportSource: viewport.viewportSource });
		} else {
			const id = args.scenario.toUpperCase();
			const viewport = await effectiveViewport(id, args);
			const scenarioDir = path.join(args.outDir, id);
			fs.mkdirSync(scenarioDir, { recursive: true });
			const previousEvidenceDir = ctx.evidenceDir;
			ctx.evidenceDir = scenarioDir;
			const startedAt = Date.now();
			try {
				const result = await runIssueScenario(id, { browser, ctx, width: viewport.width, height: viewport.height, scheme: viewport.scheme });
				scenarios.push({ ...result, status: "present", total: result.checks.length, durationMs: Date.now() - startedAt, evidenceDir: scenarioDir, viewport: viewport.viewport, viewportSource: viewport.viewportSource });
			} finally {
				ctx.evidenceDir = previousEvidenceDir;
			}
		}
		if (browser.qaRecord) browserRecord = browser.qaRecord;
		if (args.probeCloseTimeout || args.probeCloseHolder) armCloseProbe(browser, ctx, args);
	}
} catch (error) {
	harnessError = error && error.stack ? error.stack : String(error);
	console.error("harness error - " + harnessError);
	scenarios.push({ id: args.scenario || "harness", status: "present", checks: [{ name: "harness ran", ok: false, detail: harnessError }], passed: 0, failed: 1 });
} finally {
	if (!aggregateMode && browser) {
		try {
			await withDeadline(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, "harness_browser_close");
		} catch (error) {
			const message = error && error.message ? error.message : String(error);
			if (error && error.code === "deadline" && error.operation === "harness_browser_close") {
				closeTimedOut = true;
				console.error("browser close exceeded " + BROWSER_CLOSE_TIMEOUT_MS + "ms - reaping " + (ctx ? ctx.profileDir : "the private profile"));
			} else {
				console.error("browser close failed - " + message);
				harnessError ??= "browser close failed: " + message;
			}
		} finally {
			if (ctx) {
				closeReap = await reapQaBrowserProcesses(ctx.profileDir).catch((error) => ({ matched: [], killed: [], remaining: [], error: error && error.message ? error.message : String(error) }));
				if (closeReap && closeReap.matched.length === 0 && closeTimedOut) await reapQaBrowserProcesses(ctx.profileDir).catch(() => null);
			}
		}
	}
	if (!aggregateMode) {
		if (ctx) {
			try {
				cleanup = await withDeadline(ctx.close({ closeTimedOut, closeReap }), 60_000, "harness_ctx_close");
			} catch (error) {
				const message = error && error.message ? error.message : String(error);
				console.error("server cleanup failed - " + message);
				harnessError ??= "server cleanup failed: " + message;
				try { cleanup = JSON.parse(fs.readFileSync(path.join(args.outDir, "cleanup.json"), "utf8")); } catch { cleanup = null; }
			}
		} else {
			try { cleanup = JSON.parse(fs.readFileSync(path.join(args.outDir, "cleanup.json"), "utf8")); } catch { cleanup = null; }
		}
	}
	if (!browserRecord && fs.existsSync(path.join(args.outDir, "browser.json"))) {
		try { browserRecord = JSON.parse(fs.readFileSync(path.join(args.outDir, "browser.json"), "utf8")); } catch { browserRecord = null; }
	}
	const cleanupIssues = cleanupProblems(cleanup);
	if (cleanupIssues.length) console.error("cleanup not clean - " + cleanupIssues.join("; "));
	if (closeTimedOut) console.error("browser close timed out after " + BROWSER_CLOSE_TIMEOUT_MS + "ms; " + (cleanupIssues.length ? "reaper cleanup did not finish" : "reaper finished the cleanup"));
	let rootRemoval = await removeTree(runTmp);
	if (!rootRemoval.removed) {
		const rootReap = await reapQaBrowserProcesses(runTmp).catch((error) => ({ matched: [], remaining: [], error: error && error.message ? error.message : String(error) }));
		const retry = await removeTree(runTmp);
		rootRemoval = { ...retry, firstError: rootRemoval.error, reap: { matched: rootReap.matched?.length ?? 0, remaining: rootReap.remaining?.length ?? 0 } };
	}
	if (!rootRemoval.removed) {
		console.error("temp cleanup failed - " + rootRemoval.error);
		harnessError ??= "temp cleanup failed: " + rootRemoval.error;
	}
	let runTmpReadBack = "ENOENT";
	try { fs.statSync(runTmp); runTmpReadBack = "PRESENT"; } catch (error) { runTmpReadBack = error.code || "ERROR"; }
	const missing = scenarios.filter((scenario) => scenario.status === "missing").map((scenario) => scenario.id);
	const cleanupFile = path.join(args.outDir, "cleanup.json");
	const cleanupRecorded = fs.existsSync(cleanupFile);
	const total = scenarios.reduce((sum, scenario) => sum + (scenario.checks?.length ?? 0), 0);
	const passed = scenarios.reduce((sum, scenario) => sum + (scenario.passed ?? 0), 0);
	const failed = scenarios.reduce((sum, scenario) => sum + (scenario.failed ?? 0), 0);
	const teardownOk = cleanupOk(cleanup, runTmpReadBack) && cleanupRecorded;
	if (closeTimedOut && !teardownOk) harnessError ??= "browser close timed out and cleanup did not finish cleanly";
	const failureReasons = [];
	if (failed > 0) failureReasons.push(`${failed} check(s) failed`);
	if (missing.length > 0) failureReasons.push(`missing scenarios: ${missing.join(", ")}`);
	if (harnessError) failureReasons.push(`harness error: ${String(harnessError).split("\n")[0]}`);
	if (!teardownOk) {
		failureReasons.push(
			cleanupIssues.length
				? `teardown not clean - ${cleanupIssues.join("; ")}`
				: `teardown not clean - cleanup receipt ${cleanupRecorded ? `missing or runTmp read back ${runTmpReadBack}` : "missing"}`,
		);
	}
	const matrixOk = !args.all || missing.length === 0;
	const allPassed = failed === 0 && total > 0 && harnessError === null && teardownOk && matrixOk;
	const coverage = Object.fromEntries(Object.entries(IS_COVERAGE).map(([ideal, row]) => {
		const evidence = row.checks.map((anchor) => {
			const scenario = scenarios.find((entry) => entry.id === anchor.scenario);
			if (!scenario || scenario.status === "missing") return { scenario: anchor.scenario, check: anchor.match, status: "missing" };
			const check = (scenario.checks ?? []).find((entry) => entry.name.includes(anchor.match));
			if (!check) return { scenario: anchor.scenario, check: anchor.match, status: "missing" };
			return { scenario: anchor.scenario, check: check.name, status: check.ok ? "passed" : "failed" };
		});
		return [ideal, { property: row.property, scenarios: row.scenarios, evidence, passed: evidence.length > 0 && evidence.every((entry) => entry.status === "passed") }];
	}));
	const manifest = {
		allPassed,
		scenarios,
		totals: { passed, total, failed },
		matrix: args.all || args.presentOnly ? { expected: EXPECTED, present: scenarios.filter((scenario) => scenario.status === "present").map((scenario) => scenario.id), missing } : null,
		coverage: { source: "qa/issues/fixture-data.mjs", rows: coverage },
		q01,
		browser: browserRecord,
		port: ctx ? ctx.port : null,
		cleanup: cleanup ? { ...cleanup, runTmp, runTmpReadBack, receiptFile: cleanupFile, receiptRecorded: cleanupRecorded } : { runTmp, runTmpReadBack, receipt: null, receiptFile: cleanupFile, receiptRecorded: cleanupRecorded },
	};
	if (notes.length) manifest.notes = notes;
	fs.writeFileSync(path.join(args.outDir, "manifest.json"), JSON.stringify(manifest, null, "\t"));
	console.log(passed + "/" + total + " checks passed");
	if (!allPassed) {
		// A run that failed must never end on a line that reads like success: the cleanup detail and
		// the final RUN FAILED line carry the entry, error and holder PIDs on stdout.
		for (const issue of cleanupIssues) console.log("cleanup: " + issue);
		if (cleanup && Array.isArray(cleanup.holders) && cleanup.holders.length) {
			console.log("cleanup holders: " + cleanup.holders.map((item) => `${item.name || "process"} pid ${item.pid}`).join(", "));
		}
		console.log("RUN FAILED: " + failureReasons.join("; "));
		process.exit(1);
	}
	process.exit(0);
}
