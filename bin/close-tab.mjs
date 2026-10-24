#!/usr/bin/env node
import { orcaPathFor, pathExists } from "../src/reopen.mjs";
import { closeTabAfterExit } from "../src/tabclose.mjs";

function parseArgs(argv) {
	const options = { pid: null, terminal: null };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--pid") options.pid = argv[++index];
		else if (arg === "--terminal") options.terminal = argv[++index];
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));
const pid = Number(options.pid);
if (!Number.isInteger(pid) || pid <= 0 || typeof options.terminal !== "string") {
	process.exitCode = 1;
} else {
	const orcaPath = orcaPathFor(process.env, pathExists);
	if (!orcaPath) {
		process.exitCode = 1;
	} else {
		const result = await closeTabAfterExit({ pid, terminal: options.terminal, orcaPath });
		process.exitCode = result === "closed" ? 0 : 1;
	}
}
