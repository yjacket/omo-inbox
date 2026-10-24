/* Entry point for the issue-reporting QA scenarios.
 *
 * Usage: bun qa/issues-qa.mjs <appDir> <outDir> --scenario QNN [--width 390 --height 844
 *        --scheme light|dark] [--probe-failure] [--q01 <review.md>]
 *        bun qa/issues-qa.mjs <appDir> <outDir> --all|--present-only [--width W --height H
 *        --scheme light|dark] [--q01 <review.md>]
 *
 * Creates a private temp root, starts the isolated server fixture, launches an owned headless
 * browser, runs the requested scenario, then closes the browser and the server in finally and
 * removes the temp root. Writes <outDir>/manifest.json and prints "<passed>/<total> checks passed"
 * as its last line. Exit 0 only when every check passed AND the teardown receipt proves the child
 * exited, the port refuses connections and home/runTmp read back ENOENT.
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
import { createIssueQa, openQaBrowser, reapQaBrowserProcesses, removeTree, runIssueScenario, withDeadline } from "./issues-fixture.mjs";

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
let ctx = null;
let browser = null;
let cleanup = null;
let browserRecord = null;
let harnessError = null;
let closeTimedOut = false;
let closeReap = null;

try {
	ctx = await createIssueQa({ appDir: args.appDir, runTmp, evidenceDir: args.outDir, port: 0 });
	browser = await withDeadline(openQaBrowser(ctx, { width: args.width, height: args.height, scheme: args.scheme }), 60_000, "harness_browser_launch");
	if (ctx.port <= 0) throw new Error("server reported no port");
	if (args.probeFailure) {
		const id = (args.scenario || "Q06").toUpperCase();
		const viewport = await effectiveViewport(id, args);
		const result = await probeFailure(ctx, browser, viewport.width, viewport.height, viewport.scheme, id);
		scenarios.push({ ...result, viewport: viewport.viewport, viewportSource: viewport.viewportSource });
	} else if (args.all || args.presentOnly) {
		notes.push(`Q01 is a review document, not an executable scenario; receipt: ${q01 === "absent" ? "absent" : q01.path}`);
		for (const id of EXPECTED) {
			if (!scenarioExists(id)) {
				scenarios.push({ id, status: "missing" });
				continue;
			}
			const viewport = await effectiveViewport(id, args);
			const result = await runIssueScenario(id, { browser, ctx, width: viewport.width, height: viewport.height, scheme: viewport.scheme });
			scenarios.push({ ...result, status: "present", viewport: viewport.viewport, viewportSource: viewport.viewportSource });
		}
	} else {
		const id = args.scenario.toUpperCase();
		const viewport = await effectiveViewport(id, args);
		const result = await runIssueScenario(id, { browser, ctx, width: viewport.width, height: viewport.height, scheme: viewport.scheme });
		scenarios.push({ ...result, status: "present", viewport: viewport.viewport, viewportSource: viewport.viewportSource });
	}
	if (browser.qaRecord) browserRecord = browser.qaRecord;
	if (args.probeCloseTimeout || args.probeCloseHolder) armCloseProbe(browser, ctx, args);
} catch (error) {
	harnessError = error && error.stack ? error.stack : String(error);
	console.error(`harness error - ${harnessError}`);
	scenarios.push({ id: args.scenario || "harness", status: "present", checks: [{ name: "harness ran", ok: false, detail: harnessError }], passed: 0, failed: 1 });
} finally {
	if (browser) {
		try {
			// Under parallel QA load a Chrome close can outlive 10 s. The named 30 s deadline is
			// the close budget; when it expires the reaper below finishes the teardown by profile
			// path. Only a leftover process or an unremovable profile fails the run.
			await withDeadline(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, "harness_browser_close");
		} catch (error) {
			const message = error && error.message ? error.message : String(error);
			if (error && error.code === "deadline" && error.operation === "harness_browser_close") {
				closeTimedOut = true;
				console.error(`browser close exceeded ${BROWSER_CLOSE_TIMEOUT_MS}ms - reaping ${ctx ? ctx.profileDir : "the private profile"}`);
			} else {
				console.error(`browser close failed - ${message}`);
				harnessError ??= `browser close failed: ${message}`;
			}
		} finally {
			// Even if browser.close stalls or rejects, reap the private-profile Chrome processes
			// before ctx.close so the profile can be removed and the port read-back is honest.
			if (ctx) {
				closeReap = await reapQaBrowserProcesses(ctx.profileDir).catch((error) => ({ matched: [], killed: [], remaining: [], error: error && error.message ? error.message : String(error) }));
				if (closeReap && closeReap.matched.length === 0 && closeTimedOut) await reapQaBrowserProcesses(ctx.profileDir).catch(() => null);
			}
		}
	}
	if (ctx) {
		try {
			cleanup = await withDeadline(ctx.close({ closeTimedOut, closeReap }), 60_000, "harness_ctx_close");
		} catch (error) {
			const message = error && error.message ? error.message : String(error);
			console.error(`server cleanup failed - ${message}`);
			harnessError ??= `server cleanup failed: ${message}`;
			try {
				cleanup = JSON.parse(fs.readFileSync(path.join(args.outDir, "cleanup.json"), "utf8"));
			} catch {
				cleanup = null;
			}
		}
	} else {
		try {
			cleanup = JSON.parse(fs.readFileSync(path.join(args.outDir, "cleanup.json"), "utf8"));
		} catch {
			cleanup = null;
		}
	}
	if (!browserRecord && fs.existsSync(path.join(args.outDir, "browser.json"))) {
		try {
			browserRecord = JSON.parse(fs.readFileSync(path.join(args.outDir, "browser.json"), "utf8"));
		} catch {
			browserRecord = null;
		}
	}
	const cleanupIssues = cleanupProblems(cleanup);
	if (cleanupIssues.length) console.error(`cleanup not clean - ${cleanupIssues.join("; ")}`);
	if (closeTimedOut) {
		console.error(`browser close timed out after ${BROWSER_CLOSE_TIMEOUT_MS}ms; ${cleanupIssues.length ? "reaper cleanup did not finish" : "reaper finished the cleanup"}`);
	}
	const rootRemoval = await removeTree(runTmp);
	if (!rootRemoval.removed) {
		// Never throw out of cleanup: the manifest below still records the read-back and the CLI
		// exits nonzero because the temp root did not go away.
		console.error(`temp cleanup failed - ${rootRemoval.error}`);
		harnessError ??= `temp cleanup failed: ${rootRemoval.error}`;
	}
	let runTmpReadBack = "ENOENT";
	try {
		fs.statSync(runTmp);
		runTmpReadBack = "PRESENT";
	} catch (error) {
		runTmpReadBack = error.code || "ERROR";
	}
	const missing = scenarios.filter((scenario) => scenario.status === "missing").map((scenario) => scenario.id);
	const cleanupFile = path.join(args.outDir, "cleanup.json");
	const cleanupRecorded = fs.existsSync(cleanupFile);
	const manifest = {
		scenarios,
		matrix: args.all || args.presentOnly ? { expected: EXPECTED, present: scenarios.filter((scenario) => scenario.status === "present").map((scenario) => scenario.id), missing } : null,
		q01,
		browser: browserRecord,
		port: ctx ? ctx.port : null,
		cleanup: cleanup ? { ...cleanup, runTmp, runTmpReadBack, receiptFile: cleanupFile, receiptRecorded: cleanupRecorded } : { runTmp, runTmpReadBack, receipt: null, receiptFile: cleanupFile, receiptRecorded: cleanupRecorded },
	};
	if (notes.length) manifest.notes = notes;
	fs.writeFileSync(path.join(args.outDir, "manifest.json"), JSON.stringify(manifest, null, "\t"));
	const total = scenarios.reduce((sum, scenario) => sum + (scenario.checks?.length ?? 0), 0);
	const passed = scenarios.reduce((sum, scenario) => sum + (scenario.passed ?? 0), 0);
	console.log(`${passed}/${total} checks passed`);
	const failed = scenarios.reduce((sum, scenario) => sum + (scenario.failed ?? 0), 0);
	const teardownOk = cleanupOk(cleanup, runTmpReadBack) && cleanupRecorded;
	if (closeTimedOut && !teardownOk) harnessError ??= "browser close timed out and cleanup did not finish cleanly";
	const matrixOk = !args.all || missing.length === 0;
	const ok = failed === 0 && total > 0 && harnessError === null && teardownOk && matrixOk;
	process.exit(ok ? 0 : 1);
}
