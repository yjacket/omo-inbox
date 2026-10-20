/**
 * Shared helpers for the omo-inbox senpi extension (plan todo 3).
 *
 * senpi evaluates extensions through jiti/vm, where dynamic import() of repo
 * modules fails with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING, so safeSegment,
 * the child-session markers and the home/port resolution are embedded copies of
 * src/paths.mjs. test/extension.test.mjs keeps safeSegment equal to src/paths.mjs.
 */
import os from "node:os";
import path from "node:path";

/** Child-session markers: any non-empty value makes the extension inert. */
export const CHILD_ENV = ["OMO_SENPI_TASK_RPC_CHILD", "SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID"];

/** Same default port as src/paths.mjs DEFAULT_PORT. */
export const DEFAULT_PORT = 4387;

/** Same rule as src/paths.mjs safeSegment. */
export function safeSegment(value) {
	return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/** <home>: deps.home -> OMO_INBOX_HOME -> ~/.omo-inbox. */
export function resolveHome(env, home) {
	return home ?? env.OMO_INBOX_HOME ?? path.join(os.homedir(), ".omo-inbox");
}

/** <agentDir>: deps.agentDir -> INBOX_AGENT_DIR -> OMO_CODING_AGENT_DIR -> SENPI_/PI_CODING_AGENT_DIR -> ~/.omo/agent. */
export function resolveAgentDir(env, agentDir) {
	return agentDir ?? env.INBOX_AGENT_DIR ?? env.OMO_CODING_AGENT_DIR ?? env.SENPI_CODING_AGENT_DIR ?? env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".omo", "agent");
}

/** The port from config.json, else DEFAULT_PORT. */
export function resolvePort(config) {
	return config && Number(config.port) > 0 ? Number(config.port) : DEFAULT_PORT;
}
