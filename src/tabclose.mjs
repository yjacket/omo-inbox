import { spawn } from "node:child_process";

const TERMINAL_RE = /^[A-Za-z0-9_:.-]{1,120}$/;

function defaultIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function defaultWait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function closeTabAfterExit({ pid, terminal, orcaPath, isAlive = defaultIsAlive, wait = defaultWait, spawnImpl = spawn, intervalMs = 200, maxWaitMs = 30000 }) {
	if (typeof terminal !== "string" || !TERMINAL_RE.test(terminal)) return "bad_terminal";
	let waited = 0;
	while (isAlive(pid)) {
		if (waited >= maxWaitMs) return "timeout";
		await wait(intervalMs);
		waited += intervalMs;
	}
	return new Promise((resolve) => {
		let child;
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		try {
			child = spawnImpl(orcaPath, ["terminal", "close", "--terminal", terminal, "--tab", "--json"], { windowsHide: true, stdio: "ignore" });
		} catch {
			return finish("failed");
		}
		child.on("error", () => finish("failed"));
		child.on("close", (code) => finish(code === 0 ? "closed" : "failed"));
	});
}
