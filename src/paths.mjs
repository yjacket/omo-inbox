import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 4387;
export const TAILNET_PORT = 4388;

const CONFIG_DEFAULT = {
	v: 1,
	port: DEFAULT_PORT,
	publicBase: null,
	pcTailnetIps: [],
	owner: null,
};

export function homeDir(env = process.env) {
	return env.OMO_INBOX_HOME || path.join(os.homedir(), ".omo-inbox");
}

export function layout(env = process.env) {
	const home = homeDir(env);
	return {
		home,
		app: path.join(home, "app"),
		data: path.join(home, "data"),
		proposals: path.join(home, "data", "proposals"),
		mailbox: path.join(home, "mailbox"),
		logs: path.join(home, "logs"),
		push: path.join(home, "push"),
		config: path.join(home, "config.json"),
		serverJson: path.join(home, "server.json"),
		launcher: path.join(home, "launch-hidden.vbs"),
	};
}

export function readConfig(env = process.env) {
	try {
		const raw = fs.readFileSync(layout(env).config, "utf8").replace(/^\uFEFF/, "");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
	} catch {
		// missing or broken config falls back to the defaults below
	}
	return { ...CONFIG_DEFAULT };
}

export function agentDir(env = process.env) {
	return (
		env.INBOX_AGENT_DIR ||
		env.OMO_CODING_AGENT_DIR ||
		env.SENPI_CODING_AGENT_DIR ||
		env.PI_CODING_AGENT_DIR ||
		path.join(os.homedir(), ".omo", "agent")
	);
}

export function safeSegment(s) {
	return String(s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}
