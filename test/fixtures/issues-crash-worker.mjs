import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createIssuesStore } from "../../src/issues-store.mjs";

export const AT = "2026-10-23T12:00:00.000Z";
export const idFor = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const owner = { actor: "owner", via: "local", buildId: "a".repeat(64), resolveReference: async () => ({ status: "missing", checkedAt: AT }) };
export const maintainer = { ...owner, actor: "maintainer" };

export function capture(captureId = idFor(2), visual = true) {
	return {
		captureId, observedAt: AT, page: "thread",
		source: { kind: "thread", threadId: "reported-source", itemId: "item-a", observedSeq: 3 },
		target: null, clientBuild: { kind: "page_response_manifest", version: "1", digest: "b".repeat(64) },
		view: { width: 390, height: 844, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "en", embedded: false, viewerOpen: false },
		excerpt: "Frozen excerpt", excerptTruncated: false, visibleIds: ["item-a"], diagnostics: [], contextStatus: "captured",
		visual: visual ? {
			kind: "raster", provenance: "user_upload", acquiredAt: AT, sourceMatchesContext: "unverified",
			width: 2, height: 1, encoding: "rgba8-base64", pixels: Buffer.from([231, 113, 49, 255, 10, 20, 30, 255]).toString("base64"),
			masks: [{ x: 0, y: 0, w: 1, h: 1 }], marks: [{ rect: { x: 1, y: 0, w: 1, h: 1 }, text: "Visible" }],
		} : { kind: "none", reason: "not_requested" },
	};
}

export function createBody(storeId, requestId = idFor(1), evidence = capture()) {
	return { v: 1, storeId, requestId, description: "First line\nsecond line", evidence };
}

export function commandBody(storeId, requestId, expectedSeq, command) {
	return { v: 1, storeId, requestId, expectedSeq, command };
}

// The barrier is outside product code: interception stops the real child after
// the actual synchronous write/rename, before execution can publish another file.
function barrier(point) {
	fs.writeSync(1, `${JSON.stringify({ barrier: point, pid: process.pid })}\n`);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

async function worker() {
	const input = JSON.parse(process.env.ISSUES_CRASH_INPUT);
	const point = process.env.ISSUES_CRASH_POINT;
	const store = createIssuesStore({ dataDir: input.dataDir, now: () => new Date(AT) });
	if (point === "lock_acquired") barrier(point);
	const write = fs.writeFileSync;
	fs.writeFileSync = function(file, ...args) {
		const result = write.call(this, file, ...args);
		if (point === "after_evidence_staging" && path.basename(String(file)) === "manifest.json") barrier(point);
		return result;
	};
	const rename = fs.renameSync;
	fs.renameSync = function(from, to) {
		const result = rename.call(this, from, to);
		const normalized = String(to).replaceAll("\\", "/");
		if (point === "after_event_rename" && /\/events\/\d+\.json$/.test(normalized)) barrier(point);
		if (point === "after_evidence_publish" && /\/evidence\/[0-9a-f-]+$/.test(normalized)) barrier(point);
		if (point === "after_record_rename" && /\/records\/[0-9a-f-]+$/.test(normalized)) barrier(point);
		return result;
	};
	const result = input.id
		? await store.command(input.id, input.body, input.actor === "maintainer" ? maintainer : owner)
		: await store.create(input.body, owner);
	if (point === "before_response") barrier(point);
	fs.writeSync(1, `${JSON.stringify(result)}\n`);
	store.close();
}

export function terminateAtBarrier({ dataDir, body, id, point, actor = "owner", onBarrier }) {
	return new Promise((resolve, reject) => {
		const child = spawn("node", [fileURLToPath(import.meta.url)], {
			env: { ...process.env, ISSUES_CRASH_POINT: point, ISSUES_CRASH_INPUT: JSON.stringify({ dataDir, body, id, actor }) },
			stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let reached = null;
		let failure = null;
		const timer = setTimeout(() => {
			failure = new Error(`deadline:issues-crash-${point}`);
			child.kill("SIGKILL");
		}, 10_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (reached) return;
			const line = stdout.split("\n").find((entry) => entry.includes('"barrier"'));
			if (!line || !stdout.includes("\n")) return;
			try {
				reached = JSON.parse(line);
				if (reached.barrier !== point) throw new Error(`unexpected barrier ${reached.barrier}`);
				onBarrier?.(reached);
			} catch (error) {
				failure = error;
			}
			child.kill("SIGKILL");
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (failure) reject(failure);
			else if (!reached) reject(new Error(`No ${point} barrier: code=${code} signal=${signal}\n${stdout}${stderr}`));
			else resolve({ point, pid: reached.pid, code, signal, stdout, stderr });
		});
	});
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await worker();
