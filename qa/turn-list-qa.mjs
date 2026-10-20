/* Real-browser QA for the thread list status, hidden group and Review badge.
 *
 * Usage: bun qa/turn-list-qa.mjs [app dir, default the repo] [screenshot dir]
 * Starts the real server on port 4395 with a temp home, seeds four status fixtures,
 * and drives one Bun.WebView at phone and desktop sizes. The temp home is removed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = 4395;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(APP, ".omo", "evidence", "inbox-turn-review");
const SCRATCH_ROOT = path.join(process.env.TMPDIR || os.tmpdir(), "scratch-18");
const checks = [];

function check(name, ok, detail = "") {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(SCRATCH_ROOT, "qa-"));
const home = path.join(tmp, "home");
const work = path.join(tmp, "work");
const boardDir = path.join(tmp, "board");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.cpSync(path.join(APP, "skill", "example"), boardDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));

async function api(method, route, body) {
	const res = await fetch(base + route, {
		method,
		headers: method === "POST" ? POST : { accept: "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json = null;
	try {
		json = await res.json();
	} catch {}
	return { status: res.status, json };
}

async function must(method, route, body) {
	const res = await api(method, route, body);
	if (res.status !== 200) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(res.json)}`);
	return res.json;
}

async function seedThread(sid, kind, title, ask = null) {
	await must("POST", `/api/threads/${sid}/meta`, { title, cwd: work });
	const out = await must("POST", `/api/threads/${sid}/items`, {
		kind,
		policy: "needs-you",
		dedupeKey: `${kind}:${sid}:1`,
		raw: { text: "검증용 작업을 마쳤습니다.", request: "검증 동작을 확인해 주세요." },
	});
	if (kind === "turn") {
		await must("POST", `/api/items/${out.item.id}/summary`, {
			text: JSON.stringify({
				kind: "report",
				headline: `${title} 결과`,
				context: "목록 상태를 확인하는 중",
				body: "검증용 작업을 마쳤습니다.",
				ask,
				options: [],
				terms: [],
			}),
			model: "qa/stub",
			simpler: false,
		});
	}
	return out.item.id;
}

let server;
let view;
let serverWatch;
let serverTimer;
let serverPid = null;
let cleanupReceipt = "not completed";

function serverReady() {
	return new Promise((resolve, reject) => {
		serverTimer = setTimeout(() => reject(new Error("server.json timeout")), 15000);
		serverWatch = fs.watch(home, (_event, filename) => {
			if (String(filename) === "server.json" && fs.existsSync(path.join(home, "server.json"))) {
				clearTimeout(serverTimer);
				serverWatch.close();
				serverWatch = null;
				resolve();
			}
		});
	});
}

const waitFor = (condition, what, timeoutMs = 15000) =>
	view.evaluate(`new Promise((resolve, reject) => {
		const done = () => {
			try { if (${condition}) { observer.disconnect(); clearTimeout(timer); resolve(true); } } catch {}
		};
		const observer = new MutationObserver(done);
		observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(`timeout: ${what}`)})); }, ${timeoutMs});
		done();
	})`);

async function navigateList() {
	await view.navigate(`${base}/`);
	await waitFor(`document.getElementById("list")?.getAttribute("aria-busy") === "false"`, "list loaded");
}

async function screenshot(name) {
	const image = await view.cdp("Page.captureScreenshot", { format: "png" });
	const file = path.join(OUT, name);
	fs.writeFileSync(file, Buffer.from(image.data, "base64"));
	console.log(`saved ${file}`);
}

const state = `(() => {
	const sections = [...document.querySelectorAll("#list section.group")].map((section) => ({
		status: section.dataset.status,
		label: section.querySelector("h2")?.textContent || "",
		count: section.querySelector(".sum")?.textContent || "",
		rows: [...section.querySelectorAll(".row[data-session]")].map((row) => ({
			session: row.dataset.session,
			title: row.querySelector(".title")?.textContent || "",
			chips: [...row.querySelectorAll(".meta .chip")].map((chip) => chip.textContent),
		})),
	}));
	return {
		sections,
		count: document.getElementById("needsYou").hidden ? null : document.getElementById("needsYou").textContent,
		badge: { hidden: document.getElementById("reviewBadge").hidden, text: document.getElementById("reviewBadge").textContent },
		link: { text: document.getElementById("reviewLink").textContent, label: document.getElementById("reviewLink").getAttribute("aria-label") },
		overflow: document.documentElement.scrollWidth > innerWidth,
	};
})()`;

try {
	const ready = serverReady();
	server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], {
		cwd: APP,
		env: { ...process.env, OMO_INBOX_HOME: home, INBOX_NO_TAILSCALE: "1" },
		stdout: "ignore",
		stderr: "ignore",
	});
	serverPid = server.pid;
	await ready;
	const health = await (await fetch(`${base}/api/health`)).json();
	if (health.port !== PORT || health.pid !== serverPid) throw new Error(`not our server on ${PORT}: ${JSON.stringify(health)}, spawned PID ${serverPid}`);
	console.log(`server up: port ${health.port}, PID ${serverPid}`);

	const L1 = "qa-list-live-0001";
	const L2 = "qa-list-ended-0001";
	const L3 = "qa-list-off-todo-001";
	const L4 = "qa-list-off-question1";
	await seedThread(L1, "turn", "L1 live report");
	await seedThread(L2, "turn", "L2 finished report");
	await seedThread(L3, "turn", "L3 unfinished task", "폴더를 직접 지워 주세요");
	await seedThread(L4, "question", "L4 open question");

	view = new Bun.WebView({ width: 390, height: 844 });
	await view.navigate("about:blank");
	await view.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await must("GET", `/api/here?cwd=${encodeURIComponent(work)}&session=${encodeURIComponent(L1)}`);
	await navigateList();
	const list = await view.evaluate(state);
	const needs = list.sections.find((section) => section.status === "needs-you");
	const ended = list.sections.find((section) => section.status === "ended");
	const needsIds = (needs?.rows || []).map((row) => row.session);
	const endedIds = (ended?.rows || []).map((row) => row.session);
	check("(1) 내 차례 contains L1, L3, L4 and 끝남 contains L2", [L1, L3, L4].every((sid) => needsIds.includes(sid)) && endedIds.includes(L2), JSON.stringify({ needsIds, endedIds }));

	const rowBySid = Object.fromEntries(list.sections.flatMap((section) => section.rows).map((row) => [row.session, row]));
	const offChip = (sid) => rowBySid[sid]?.chips.includes("세션 꺼짐") === true;
	check("(2) only L3 and L4 have 세션 꺼짐 chips", offChip(L3) && offChip(L4) && !offChip(L1) && !offChip(L2), JSON.stringify(Object.fromEntries([L1, L2, L3, L4].map((sid) => [sid, rowBySid[sid]?.chips]))));
	check("(3) header count is 🙋 3", list.count === "🙋 3", JSON.stringify({ count: list.count }));
	await screenshot("task-18-list-390-light.png");

	await view.navigate(`${base}/s/${L4}`);
	await waitFor(`document.getElementById("hideToggle")`, "L4 thread loaded");
	await view.evaluate(`document.getElementById("hideToggle").click()`);
	await waitFor(`document.getElementById("hideToggle")?.textContent === "숨김 해제"`, "L4 hidden");
	await navigateList();
	let hidden = await view.evaluate(state);
	const hiddenSection = hidden.sections.at(-1);
	const hiddenIds = (hiddenSection?.rows || []).map((row) => row.session);
	check("(4) hiding L4 removes it from 내 차례, appends folded 숨긴 대화 count 1, and lowers 🙋 to 2",
		!(hidden.sections.find((section) => section.status === "needs-you")?.rows || []).some((row) => row.session === L4) &&
		hiddenSection?.status === "hidden" && hiddenSection.label === "숨긴 대화" && hiddenSection.count === "1" &&
		hiddenIds.includes(L4) && hidden.count === "🙋 2" &&
		(await view.evaluate(`document.querySelector('section[data-status="hidden"] .fold')?.textContent`)) === "펼치기" &&
		(await view.evaluate(`document.querySelector('section[data-status="hidden"] .rows')?.hidden`)) === true,
		JSON.stringify({ hiddenSection, count: hidden.count }));
	await view.evaluate(`document.querySelector('section[data-status="hidden"] .fold').click()`);
	await waitFor(`!document.querySelector('section[data-status="hidden"] .rows')?.hidden`, "hidden rows opened");
	const expandedBeforeReload = await view.evaluate(`document.querySelector('section[data-status="hidden"] .row[data-session="${L4}"]') !== null && document.querySelector('section[data-status="hidden"] .fold')?.textContent === "접기"`);
	await screenshot("task-18-hidden-open-390.png");
	await view.navigate(`${base}/`);
	await waitFor(`document.querySelector('section[data-status="hidden"] .rows:not([hidden])')`, "hidden group stayed open after reload");
	hidden = await view.evaluate(state);
	check("(5) localStorage keeps the hidden group open after reload",
		expandedBeforeReload && (await view.evaluate(`document.querySelector('section[data-status="hidden"] .fold')?.textContent`)) === "접기" &&
		hidden.sections.at(-1)?.rows.some((row) => row.session === L4),
		JSON.stringify({ expandedBeforeReload, fold: await view.evaluate(`document.querySelector('section[data-status="hidden"] .fold')?.textContent`) }));

	await view.navigate(`${base}/s/${L4}`);
	await waitFor(`document.getElementById("hideToggle")?.textContent === "숨김 해제"`, "unhide control loaded");
	await view.evaluate(`document.getElementById("hideToggle").click()`);
	await waitFor(`document.getElementById("hideToggle")?.textContent === "숨기기"`, "L4 unhidden");
	await navigateList();
	const unhidden = await view.evaluate(state);
	check("(6) unhiding L4 restores it to 내 차례 and removes 숨긴 대화",
		unhidden.sections.some((section) => section.status === "needs-you" && section.rows.some((row) => row.session === L4)) &&
		!unhidden.sections.some((section) => section.status === "hidden"),
		JSON.stringify(unhidden.sections.map((section) => [section.status, section.rows.map((row) => row.session)])));

	check("(7) with no proposals the Review badge is hidden and the link says Review",
		unhidden.badge.hidden && unhidden.link.text === "Review" && unhidden.link.label === null,
		JSON.stringify({ badge: unhidden.badge, link: unhidden.link }));

	const proposal = await must("POST", "/api/proposals", { cwd: boardDir, srcDir: boardDir, title: "Turn list badge QA" });
	if (!proposal.summary?.id) throw new Error(`proposal creation did not return an id: ${JSON.stringify(proposal)}`);
	await waitFor(`document.getElementById("reviewBadge")?.hidden === false`, "Review badge refreshed");
	const badged = await view.evaluate(state);
	await view.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await screenshot("task-18-list-390-dark.png");
	await view.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
	await view.cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
	await view.cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	const desktopState = await view.evaluate(state);
	await screenshot("task-18-list-1280.png");
	const desktopFits = desktopState.badge.text === "1" && desktopState.overflow === false;
	// At 1280 the split view auto-selected the first row (?s=); drop it so going back to 390 stays on the list instead of opening that thread.
	await view.evaluate(`history.replaceState(null, "", "/")`);
	await view.cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await view.cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	check("(8) a proposal waiting on the owner shows badge 1 and accessible label; desktop list has no overflow",
		badged.badge.hidden === false && badged.badge.text === "1" && badged.link.label === "Review, 내 차례 1건" && desktopFits,
		JSON.stringify({ proposal: proposal.summary.id, badge: badged.badge, link: badged.link, desktop: { overflow: desktopState.overflow, badge: desktopState.badge } }));

	await must("GET", `/api/here?cwd=${encodeURIComponent(work)}&session=${encodeURIComponent(L2)}`);
	await waitFor(`document.querySelector('section[data-status="needs-you"] .row[data-session="${L2}"]')`, "L2 returned to 내 차례");
	const returned = await view.evaluate(state);
	check("(9) priming L2 moves it from 끝남 to 내 차례 on the next poll",
		returned.sections.some((section) => section.status === "needs-you" && section.rows.some((row) => row.session === L2)) &&
		!returned.sections.some((section) => section.status === "ended" && section.rows.some((row) => row.session === L2)),
		JSON.stringify(returned.sections.map((section) => [section.status, section.rows.map((row) => row.session)])));
	await screenshot("task-18-list-390-final.png");

	await must("POST", `/api/threads/${L2}/items`, { kind: "done", policy: "needs-you", dedupeKey: `done:${L2}:1`, raw: { text: "목표를 마쳤습니다." } });
	await navigateList();
	const doneRow = await view.evaluate(state);
	const doneChips = doneRow.sections.find((section) => section.status === "needs-you")?.rows.find((row) => row.session === L2)?.chips || [];
	check("(10) a live thread whose newest item is done stays in 내 차례 with the 🙋 내 차례 chip, not ✅ 끝남",
		doneChips.includes("🙋 내 차례") && !doneChips.includes("✅ 끝남"), JSON.stringify(doneChips));
} catch (error) {
	check("run completed", false, error?.stack || String(error));
} finally {
	if (serverWatch) serverWatch.close();
	if (serverTimer) clearTimeout(serverTimer);
	if (view) await view.close();
	if (server) {
		server.kill();
		await server.exited;
		cleanupReceipt = `server PID ${serverPid} exited with ${server.exitCode}`;
	}
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	try {
		fs.rmdirSync(SCRATCH_ROOT);
	} catch {}
	console.log(`cleanup: ${cleanupReceipt}; browser closed; scratch removed ${!fs.existsSync(tmp)}`);
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
