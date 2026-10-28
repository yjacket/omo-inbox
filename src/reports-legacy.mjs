// One-time migration of the old issue store's open reports into the report
// ledger. The old tree is only read; nothing under data/issues is written.

import fs from "node:fs";
import path from "node:path";
import { pngInfo, redactReport } from "./reports-contract.mjs";

const PAGE_KINDS = new Set(["inbox", "thread", "boards", "proposal", "issues"]);
const MARKER = ".legacy-migrated.json";

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function directories(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
	} catch {
		return [];
	}
}

function latestEvent(eventsDir) {
	let latest = null;
	for (const entry of fs.readdirSync(eventsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
		const event = readJson(path.join(eventsDir, entry.name));
		if (!isObject(event) || !Number.isSafeInteger(event.seq)) continue;
		if (latest === null || event.seq > latest.seq) latest = event;
	}
	return latest;
}

function newestContext(evidenceDir) {
	let chosen = null;
	let chosenScore = -Infinity;
	for (const entry of directories(evidenceDir)) {
		const context = readJson(path.join(evidenceDir, entry.name, "context.json"));
		if (!isObject(context)) continue;
		const parsed = Date.parse(context.observedAt);
		const score = Number.isNaN(parsed) ? 0 : parsed;
		if (chosen === null || score > chosenScore || (score === chosenScore && entry.name > chosen.name)) {
			chosen = { name: entry.name, context };
			chosenScore = score;
		}
	}
	return chosen;
}

function mapView(view) {
	const source = isObject(view) ? view : {};
	const width = finiteOr(source.width, 0);
	const height = finiteOr(source.height, 0);
	return {
		layout: { w: width, h: height },
		visual: {
			x: 0,
			y: 0,
			w: width,
			h: height,
			scale: finiteOr(source.scale, 1),
		},
		scroll: { x: finiteOr(source.scrollX, 0), y: finiteOr(source.scrollY, 0) },
		dpr: finiteOr(source.dpr, 1),
		colorScheme: source.theme === "dark" ? "dark" : "light",
		pointer: "fine",
	};
}

function mapSource(source, target, productOf) {
	if (!isObject(source)) return null;
	let mapped = null;
	if (source.kind === "proposal" && typeof source.proposalId === "string" && source.proposalId !== "") {
		mapped = {
			kind: "proposal",
			proposalId: source.proposalId,
			revision: Number.isInteger(source.revision) && source.revision > 0 ? source.revision : null,
			frame: target.kind === "frame" ? target.label : null,
		};
	} else if (source.kind === "thread" && typeof source.threadId === "string" && source.threadId !== "") {
		mapped = {
			kind: "thread",
			threadId: source.threadId,
			itemId: typeof source.itemId === "string" ? source.itemId : null,
		};
	}
	if (mapped === null) return null;
	mapped.product = productOf(mapped);
	return mapped;
}

function mapRecord({ id, created, event, evidence, productOf }) {
	const context = isObject(evidence?.context) ? evidence.context : {};
	const target = isObject(context.target) ? context.target : {};
	const label = typeof target.label === "string" && target.label !== "" ? target.label : "화면 전체";
	const pageKind = PAGE_KINDS.has(context.page) ? context.page : "issues";
	const source = mapSource(created.source, target, productOf);

	let png = null;
	if (evidence) {
		try {
			png = fs.readFileSync(path.join(evidence.dir, "image.png"));
		} catch {
			png = null;
		}
	}
	const info = png === null ? null : pngInfo(png);
	const image = info === null ? null : { provenance: "legacy", width: info.width, height: info.height };

	const report = redactReport({
		v: 2,
		reportId: id,
		description: typeof created.description === "string" ? created.description : "",
		page: { kind: pageKind, route: "/", url: "/", title: "", frames: [] },
		element: null,
		view: mapView(context.view),
		source,
		image,
	});

	return {
		report,
		png: info === null ? null : png,
		imageMeta: image,
		legacy: {
			issueId: id,
			createdAt: typeof created.createdAt === "string" ? created.createdAt : event.acceptedAt ?? "",
			target: label,
		},
		createdAt: typeof created.createdAt === "string" ? created.createdAt : undefined,
	};
}

export function migrateLegacy({ dataDir, store, productOf, now = () => new Date(), log = () => {} } = {}) {
	const recordsDir = path.join(dataDir, "issues", "records");
	const markerPath = path.join(dataDir, "reports", MARKER);
	if (!fs.existsSync(recordsDir) || !fs.statSync(recordsDir).isDirectory() || fs.existsSync(markerPath)) {
		return { migrated: 0, skipped: 0 };
	}

	let migrated = 0;
	let skipped = 0;
	const ids = [];
	for (const entry of directories(recordsDir)) {
		const id = entry.name;
		const recordDir = path.join(recordsDir, id);
		if (fs.existsSync(path.join(dataDir, "issues", "tombstones", `${id}.json`))) {
			skipped++;
			continue;
		}
		const created = readJson(path.join(recordDir, "created.json"));
		if (!isObject(created) || typeof created.id !== "string" || created.id !== id) {
			skipped++;
			continue;
		}
		let event;
		try {
			event = latestEvent(path.join(recordDir, "events"));
		} catch {
			event = null;
		}
		if (event === null || event.state === "resolved") {
			skipped++;
			continue;
		}
		const found = newestContext(path.join(recordDir, "evidence"));
		const evidence = found === null ? null : { ...found, dir: path.join(recordDir, "evidence", found.name) };
		const mapped = mapRecord({ id, created, event, evidence, productOf });
		store.create({
			id,
			fingerprint: `legacy:${id}`,
			report: mapped.report,
			png: mapped.png,
			imageMeta: mapped.imageMeta,
			legacy: mapped.legacy,
			createdAt: mapped.createdAt,
		});
		migrated++;
		ids.push(id);
		log(`legacy report migrated: ${id}`);
	}

	const clock = now();
	const at = clock instanceof Date ? clock.toISOString() : new Date(clock).toISOString();
	fs.mkdirSync(path.dirname(markerPath), { recursive: true });
	fs.writeFileSync(markerPath, JSON.stringify({ at, ids }));
	return { migrated, skipped };
}
