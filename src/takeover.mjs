import nodeFs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { filesEqual, readJsonSafe, removePath, sameDir, syncDir, writeIfChanged } from "./install.mjs";

const SKILL_HOMES = [
	[".agents", "skills", "visual-board"],
	[".claude", "skills", "visual-board"],
];
const RULE_PARTS = [".claude", "rules", "visual-board.md"];

export function shimContent(inboxHome) {
	const cli = pathToFileURL(path.join(inboxHome, "app", "src", "cli.mjs")).href;
	return [
		`import { main } from ${JSON.stringify(cli)};`,
		"process.exitCode = await main(process.argv.slice(2));",
		"",
	].join("\n");
}

function paths(deps) {
	const { deskHome, inboxHome } = deps;
	return {
		deskBin: path.join(deskHome, "app", "bin", "desk.mjs"),
		deskApp: path.join(deskHome, "app"),
		shimMarker: path.join(deskHome, "app", "SHIM.json"),
		disabled: path.join(deskHome, "disabled"),
		config: path.join(inboxHome, "config.json"),
		takeover: path.join(inboxHome, "takeover.json"),
		appDir: deps.appDir ?? path.join(inboxHome, "app"),
	};
}

function writeConfigMode(fs, file, mode) {
	const current = readJsonSafe(file) ?? {};
	writeIfChanged(file, `${JSON.stringify({ ...current, mode }, null, 2)}\n`);
}

function copyMissing(fs, srcRoot, dstRoot) {
	let count = 0;
	if (!fs.existsSync(srcRoot)) return count;
	for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dst = path.join(dstRoot, entry.name);
		if (fs.existsSync(dst)) continue;
		fs.mkdirSync(dstRoot, { recursive: true });
		fs.cpSync(path.join(srcRoot, entry.name), dst, { recursive: true });
		count += 1;
	}
	return count;
}

function copyMailbox(fs, srcRoot, dstRoot) {
	let count = 0;
	if (!fs.existsSync(srcRoot)) return count;
	for (const session of fs.readdirSync(srcRoot, { withFileTypes: true })) {
		if (!session.isDirectory()) continue;
		const dstDir = path.join(dstRoot, session.name);
		for (const file of fs.readdirSync(path.join(srcRoot, session.name))) {
			if (!file.endsWith(".json")) continue;
			const dst = path.join(dstDir, file);
			if (fs.existsSync(dst)) continue;
			fs.mkdirSync(dstDir, { recursive: true });
			fs.copyFileSync(path.join(srcRoot, session.name, file), dst);
			count += 1;
		}
	}
	return count;
}

function finish(deps, lines) {
	if (deps.log) for (const { step, result } of lines) deps.log(`${step}: ${result}`);
	return lines;
}

export async function takeover(deps) {
	const fs = deps.fs ?? nodeFs;
	const now = deps.now ?? Date.now;
	const p = paths(deps);
	const lines = [];
	const out = (step, result) => lines.push({ step, result });
	const skip = (reason) => {
		out("takeover", `skipped (${reason})`);
		return finish(deps, lines);
	};

	const config = fs.existsSync(p.config) ? readJsonSafe(p.config) : null;
	if (!config) return skip("not installed");
	if (config.mode === "primary") return skip("already primary");
	if (!fs.existsSync(p.deskBin) || fs.existsSync(p.disabled)) return skip("no active desk");

	// 2. record the takeover (also what handback reads)
	const source = readJsonSafe(path.join(deps.deskHome, "app", "source.json")) ?? null;
	fs.mkdirSync(deps.inboxHome, { recursive: true });
	fs.writeFileSync(p.takeover, `${JSON.stringify({ v: 1, at: now(), desk: { home: deps.deskHome, source } }, null, 2)}\n`);
	out("record", "written");

	// 3. additive import - desk data is only read
	const proposals = copyMissing(fs, path.join(deps.deskHome, "data", "proposals"), path.join(deps.inboxHome, "data", "proposals"));
	const mailbox = copyMailbox(fs, path.join(deps.deskHome, "inbox"), path.join(deps.inboxHome, "mailbox"));
	out("import", `${proposals} proposals, ${mailbox} mailbox files`);

	// 4. desk uninstall
	const result = await deps.run(process.execPath, [p.deskBin, "uninstall"]);
	if (!result || result.code !== 0) {
		out("takeover", "failed (desk uninstall)");
		return finish(deps, lines);
	}
	out("desk uninstall", "ok");

	// 5. keep desk disabled
	fs.mkdirSync(deps.deskHome, { recursive: true });
	fs.writeFileSync(p.disabled, "disabled\n");
	out("disabled", "written");

	// 6. shim so `desk ...` keeps working through inbox
	fs.mkdirSync(path.dirname(p.deskBin), { recursive: true });
	fs.writeFileSync(p.deskBin, shimContent(deps.inboxHome));
	fs.writeFileSync(p.shimMarker, `${JSON.stringify({ by: "omo-inbox" })}\n`);
	out("shim", "written");

	// 7. primary mode: skill + rule
	writeConfigMode(fs, p.config, "primary");
	out("mode", "primary");
	const skillSrc = path.join(p.appDir, "skill");
	if (fs.existsSync(skillSrc)) {
		const statuses = SKILL_HOMES.map((parts) => syncDir(skillSrc, path.join(deps.userHome, ...parts)));
		out("skill", statuses.includes("written") ? "written" : "unchanged");
	} else out("skill", "skipped");
	const ruleSrc = path.join(p.appDir, "rules", "visual-board.md");
	if (fs.existsSync(ruleSrc)) {
		out("rule", writeIfChanged(path.join(deps.userHome, ...RULE_PARTS), fs.readFileSync(ruleSrc, "utf8")));
	} else out("rule", "skipped");
	return finish(deps, lines);
}

export async function handback(deps) {
	const fs = deps.fs ?? nodeFs;
	const now = deps.now ?? Date.now;
	const p = paths(deps);
	const lines = [];
	const out = (step, result) => lines.push({ step, result });

	const record = fs.existsSync(p.takeover) ? readJsonSafe(p.takeover) : null;
	const config = fs.existsSync(p.config) ? readJsonSafe(p.config) : null;
	if (!record) {
		out("handback", "skipped (no takeover)");
		return finish(deps, lines);
	}
	if (config?.mode !== "primary") {
		out("handback", "skipped (not primary)");
		return finish(deps, lines);
	}

	// 2. shim app only
	const marker = fs.existsSync(p.shimMarker) ? readJsonSafe(p.shimMarker) : null;
	out("shim", marker?.by === "omo-inbox" ? removePath(p.deskApp) : "kept (not ours)");

	// 3. skill + rule only when unmodified
	const skillSrc = path.join(p.appDir, "skill");
	const skillResults = SKILL_HOMES.map((parts) => {
		const dst = path.join(deps.userHome, ...parts);
		if (!fs.existsSync(dst)) return "absent";
		if (!fs.existsSync(skillSrc) || !sameDir(skillSrc, dst)) return "kept (modified)";
		return removePath(dst);
	});
	out("skill", skillResults.find((r) => r === "kept (modified)") ?? (skillResults.includes("removed") ? "removed" : "absent"));
	const ruleDst = path.join(deps.userHome, ...RULE_PARTS);
	const ruleSrc = path.join(p.appDir, "rules", "visual-board.md");
	if (!fs.existsSync(ruleDst)) out("rule", "absent");
	else if (!filesEqual(ruleSrc, ruleDst)) out("rule", "kept (modified)");
	else out("rule", removePath(ruleDst));

	// 4. re-enable desk
	out("disabled", removePath(p.disabled));

	// 5. reinstall desk per channel
	const src = record.desk?.source;
	if (src?.channel === "package" || src?.channel === "checkout") {
		const args = [path.join(src.source, "bin", "desk.mjs"), "install"];
		if (src.channel === "package") args.push("--from-package");
		const result = await deps.run(process.execPath, args);
		out("desk", result && result.code === 0 ? "reinstalled" : "failed (desk install)");
	} else out("desk", "manual (/desk install)");

	// 6. trial mode
	writeConfigMode(fs, p.config, "trial");
	out("mode", "trial");

	// 7. archive the record
	fs.renameSync(p.takeover, path.join(deps.inboxHome, `takeover-${now()}.json`));
	out("record", "archived");
	return finish(deps, lines);
}
