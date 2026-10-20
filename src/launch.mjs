import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./paths.mjs";

export const SERVER_NODE_ARGS = ["--max-semi-space-size=1", "--max-old-space-size=128"];

const WMI_TIMEOUT_MS = 30_000;

export const WMI_CREATE_SCRIPT =
	"$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; " +
	"$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:INBOX_LAUNCH_CMD; CurrentDirectory=$env:INBOX_LAUNCH_CWD; ProcessStartupInformation=$si}; " +
	"'{0} {1}' -f $r.ReturnValue, $r.ProcessId";

// A detached child's 'error' (e.g. ENOENT) has no other listener, so it is swallowed here to keep
// the launch contract promise-shaped. Leave a breadcrumb so the failure is not invisible.
function logLaunchError(error, home) {
	try {
		const logs = path.join(home, "logs");
		fs.mkdirSync(logs, { recursive: true });
		fs.appendFileSync(path.join(logs, "launch.log"), `${new Date().toISOString()} ${error?.stack ?? error?.message ?? String(error)}\n`);
	} catch {
		// logging is best effort: it must never break the launch path
	}
}

function quoteArg(arg) {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function isNodeExe(execPath) {
	return /^node(\.exe)?$/i.test(path.basename(execPath));
}

function findNode(env, platform) {
	const pathValue = env.PATH ?? env.Path ?? "";
	for (const dir of pathValue.split(platform === "win32" ? ";" : ":")) {
		const candidate = path.join(dir, platform === "win32" ? "node.exe" : "node");
		if (dir && fs.existsSync(candidate)) return candidate;
	}
	throw new Error("Node executable not found on PATH for the omo-inbox server");
}

export function launchServer({ env = process.env, script = path.join(homeDir(env), "app", "src", "server.mjs"), execPath = process.execPath, platform = process.platform, spawnImpl = spawn, home = homeDir(env) } = {}) {
	const args = [...SERVER_NODE_ARGS, script];
	const resolveNode = () => (isNodeExe(execPath) ? execPath : findNode(env, platform));
	const spawnChild = (node, wmiError) => {
		const child = spawnImpl(node, args, { detached: true, stdio: "ignore", windowsHide: true, cwd: home, env });
		child.on?.("error", (error) => logLaunchError(error, home));
		child.unref?.();
		return { via: "spawn", pid: child.pid, ...(wmiError ? { wmiError } : {}) };
	};
	const sandboxed = Object.keys(env).some((key) => {
		const upper = key.toUpperCase();
		return upper.startsWith("OMO_INBOX_") || upper.startsWith("INBOX_");
	});
	if (platform !== "win32" || sandboxed) return Promise.resolve().then(() => spawnChild(resolveNode()));
	return new Promise((resolve, reject) => {
		let node;
		try {
			node = resolveNode();
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		let out = "";
		let timer;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		let ps;
		try {
			ps = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WMI_CREATE_SCRIPT], {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
				env: { ...env, INBOX_LAUNCH_CMD: [node, ...args].map(quoteArg).join(" "), INBOX_LAUNCH_CWD: home },
			});
		} catch (error) {
			finish(spawnChild(node, `spawn: ${error.message}`));
			return;
		}
		timer = setTimeout(() => {
			ps.kill?.();
			finish(spawnChild(node, "wmi: timed out"));
		}, WMI_TIMEOUT_MS);
		timer.unref?.();
		ps.stdout?.on("data", (chunk) => {
			out += chunk;
		});
		ps.on("error", (error) => finish(spawnChild(node, `spawn: ${error.message}`)));
		ps.on("close", (code) => {
			const [returnValue, pid] = out.trim().split(/\s+/).map(Number);
			if (code === 0 && returnValue === 0 && pid > 0) finish({ via: "wmi", pid });
			else finish(spawnChild(node, `wmi: exit ${code}, output "${out.trim()}"`));
		});
	});
}
