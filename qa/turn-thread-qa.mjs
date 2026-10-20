/* Real-browser QA for the turn thread (plan todo 19): the thread chips, the hide button, and the reopen sheet end to end.
 *
 * Usage: bun qa/turn-thread-qa.mjs
 * Starts src/server.mjs on a temp OMO_INBOX_HOME (port 4396) with INBOX_REOPEN_SINK set to a temp file, so a reopen
 * is recorded as a JSON line instead of launching a terminal. Seeds a dead thread D1 (a turn item asking for a direct
 * check, cwd and sessionFile on disk), a live primed thread V1, and a board item in V1 from a proposal. Then it drives
 * one Bun.WebView through CDP: phone 390x844 with touch, then desktop 1280x800.
 * Screenshots (task-19-*.png) land in .omo/evidence/inbox-turn-review/. The last line is `N/N checks passed`;
 * exit 0 only when every check passes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4396;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const OUT = path.join(APP, ".omo", "evidence", "inbox-turn-review");
const PREFIX = "task-19-";
const D1 = "qa-dead-0001";
const D2 = "qa-dead-0002";
const D3 = "qa-dead-0003";
const V1 = "qa-live-0001";
const D1_ASK = "직접 확인해 주세요";
const SENT_TEXT = "세션을 열었습니다. 연결되면 전달됩니다.";
const FAILED_TEXT = "보내지 못했습니다";

const checks = [];
function record(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
function expect(condition, message) {
	if (!condition) throw new Error(message);
}
async function step(name, fn) {
	try {
		const detail = await fn();
		record(name, true, detail);
	} catch (error) {
		record(name, false, error.message);
	}
}
async function until(fn, ms, what) {
	const t0 = Date.now();
	for (;;) {
		if (await fn()) return true;
		if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ---------- temp home, server, seeding ----------

const scratch = path.join(process.env.TMPDIR || os.tmpdir(), "scratch-19");
fs.mkdirSync(scratch, { recursive: true });
const tmp = fs.mkdtempSync(path.join(scratch, "turn-thread-qa-"));
const home = path.join(tmp, "home");
const cwdDir = path.join(tmp, "work");
const boardDir = path.join(tmp, "board");
const sessionFile = path.join(tmp, "dead-session.jsonl");
const sink = path.join(tmp, "reopen.jsonl");
const pushSink = path.join(tmp, "push.jsonl");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(cwdDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(sessionFile, "");
fs.cpSync(path.join(APP, "skill", "example"), boardDir, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));

async function api(method, route, body) {
	const res = await fetch(base + route, { method, headers: method === "POST" ? POST : { accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	let json = null;
	try {
		json = await res.json();
	} catch {
		json = null;
	}
	return { status: res.status, json };
}
async function must(method, route, body) {
	const res = await api(method, route, body);
	if (res.status !== 200) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(res.json)}`);
	return res.json;
}
const prime = (sid) => must("GET", `/api/here?cwd=${encodeURIComponent(cwdDir)}&session=${encodeURIComponent(sid)}`);
const eventsOf = async (sid) => (await must("GET", `/api/threads/${encodeURIComponent(sid)}`)).events;
const answersOf = async (sid, itemId) => (await eventsOf(sid)).filter((event) => event.type === "answer" && (itemId === undefined || event.itemId === itemId));
const hiddenOf = async (sid) => (await must("GET", `/api/threads/${encodeURIComponent(sid)}`)).thread.hidden;
const sinkLines = () => (fs.existsSync(sink) ? fs.readFileSync(sink, "utf8").split("\n").filter(Boolean) : []);

// ---------- browser helpers ----------

let view = null;
const ev = (expr) => view.evaluate(expr);
const cdp = (method, params) => view.cdp(method, params || {});
const waitFor = (cond, ms, what) =>
	ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))");
const stable = () => ev("new Promise((resolve) => { let last = -1; let n = 0; const f = () => { if (scrollY === last) { if (++n >= 12) return resolve(true); } else { n = 0; last = scrollY; } requestAnimationFrame(f); }; f(); })");
const touch = (type, points) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points });
const click = async (x, y) => {
	await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
	await settle();
};
const rectOf = (selector) =>
	ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`no element ${selector}`)}); const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const bringIn = async (selector) => {
	await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
	await stable();
};
const clickSel = async (selector) => {
	await bringIn(selector);
	const r = await rectOf(selector);
	await click(r.cx, r.cy);
};
const shot = async (name) => {
	const res = await cdp("Page.captureScreenshot", { format: "png" });
	const file = path.join(OUT, `${PREFIX}${name}`);
	fs.writeFileSync(file, Buffer.from(res.data, "base64"));
	console.log(`saved ${file}`);
};
const shotClip = async (name, selector) => {
	const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height, scale: 1 }; })()`);
	const res = await cdp("Page.captureScreenshot", { format: "png", clip: r });
	const file = path.join(OUT, `${PREFIX}${name}`);
	fs.writeFileSync(file, Buffer.from(res.data, "base64"));
	console.log(`saved ${file}`);
};
const dark = async () => {
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await settle();
};
const light = async () => {
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
	await settle();
};
const phone = async () => {
	await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
};
const desktop = async () => {
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
	await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
};
async function openThread(sid, count) {
	await view.navigate(`${base}/s/${encodeURIComponent(sid)}`);
	await waitFor(`document.getElementById('chat') && document.getElementById('chat').getAttribute('aria-busy') === 'false' && document.querySelectorAll('section[data-item]').length >= ${count}`, 15000, `thread ${sid} ready`);
	await settle();
}
// Counts the reopen POSTs made by the page and the ones that finished, and can fail the next message POST of D1 once.
// It lives in the page, so it is installed again after every navigation (installed only once per document).
const hookFetch = () =>
	ev(`(() => {
		window.__reopenPosts = 0;
		window.__reopenDone = 0;
		window.__failNext = false;
		if (window.__hooked) return true;
		window.__hooked = true;
		const orig = window.fetch.bind(window);
		window.fetch = (input, init) => {
			const url = String(input);
			const method = String((init && init.method) || "GET").toUpperCase();
			const isReopen = method === "POST" && url.endsWith("/reopen");
			if (isReopen) window.__reopenPosts++;
			if (window.__failNext && method === "POST" && url.endsWith("/api/threads/${D1}/message")) {
				window.__failNext = false;
				return Promise.resolve(new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
			}
			return orig(input, init).then((res) => {
				if (isReopen) {
					window.__reopenStatus = res.status;
					res.clone().text().then((t) => { window.__reopenBody = t; window.__reopenDone++; }, () => { window.__reopenDone++; });
				}
				return res;
			});
		};
		return true;
	})()`);
const typeText = (value) =>
	ev(`(() => { const el = document.getElementById("reply"); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return el.value; })()`);
const sheetOpen = () => ev(`Boolean(document.querySelector(".sheet"))`);
const composeStatus = () => ev(`document.getElementById("composeStatus").textContent`);
const replyValue = () => ev(`document.getElementById("reply").value`);

// ---------- run ----------

let server = null;
let serverExit = null;
try {
	server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], {
		cwd: APP,
		env: { ...process.env, OMO_INBOX_HOME: home, INBOX_NO_TAILSCALE: "1", INBOX_PUSH_SINK: pushSink, INBOX_REOPEN_SINK: sink },
		stdout: "ignore",
		stderr: "ignore",
	});
	serverExit = server.exited;
	console.log(`server pid ${server.pid}`);
	await until(async () => {
		try {
			return (await fetch(`${base}/api/threads`, { headers: { accept: "application/json" } })).status === 200;
		} catch {
			return false;
		}
	}, 15000, "server listening");

	// seed: D1 dead with an ask, V1 live and primed, and a board item of V1 from a proposal
	await must("POST", `/api/threads/${D1}/meta`, { title: "직접 확인 세션", product: "omo-inbox", branch: "qa-dead", firstRequest: "직접 확인해 줘", cwd: cwdDir, sessionFile });
	const d1 = await must("POST", `/api/threads/${D1}/items`, { kind: "turn", policy: "needs-you", dedupeKey: "turn:d1:1", raw: { text: `확인이 필요한 부분이 있습니다. ${D1_ASK}` } });
	const d1Item = d1.item.id;
	// D2: a dead session with an open question (the option buttons send through the answer path)
	await must("POST", `/api/threads/${D2}/meta`, { title: "질문 남은 세션", product: "omo-inbox", branch: "qa-dead-q", firstRequest: "방식을 골라 줘", cwd: cwdDir, sessionFile });
	const d2 = await must("POST", `/api/threads/${D2}/items`, {
		kind: "question",
		policy: "needs-you",
		dedupeKey: "q:d2-1",
		raw: {
			text: "작업 방식을 정해 주세요.",
			request: { requestId: "d2-1", questions: [{ id: "q1", header: "방식", question: "어떻게 할까요?", options: [{ label: "나눠서", description: "두 번에 나눕니다" }, { label: "한 번에", description: "한 번에 합니다" }], multiSelect: false }], waitForAnswer: true, required: false, timeoutMs: 600000, askedAt: new Date().toISOString() },
		},
	});
	const d2Item = d2.item.id;
	// D3: a dead session whose newest open item is a report, so the quick reply chips show
	await must("POST", `/api/threads/${D3}/meta`, { title: "보고 남은 세션", product: "omo-inbox", branch: "qa-dead-r", firstRequest: "정리해 줘", cwd: cwdDir, sessionFile });
	const d3 = await must("POST", `/api/threads/${D3}/items`, { kind: "turn", policy: "needs-you", dedupeKey: "turn:d3:1", raw: { text: "정리했습니다. 남은 폴더는 직접 지워 주세요." } });
	const d3Item = d3.item.id;
	await must("POST", `/api/threads/${V1}/meta`, { title: "살아 있는 세션", product: "omo-inbox", branch: "qa-live", firstRequest: "계속 진행해 줘", cwd: cwdDir });
	await prime(V1);
	await must("POST", "/api/proposals", {
		cwd: cwdDir,
		identity: { product: { key: "omo-inbox", name: "omo-inbox", remote: null }, feature: { key: "omo-inbox#qa-live", branch: "qa-live", worktree: cwdDir }, session: { id: V1, file: null } },
		title: "턴 스레드 확인",
		srcDir: boardDir,
	});

	view = new Bun.WebView({ width: 1280, height: 800 });
	await view.navigate("about:blank");
	await phone();
	await light();

	await step("(1) D1 header shows 내 차례 and 세션 꺼짐, and the hide button reads 숨기기", async () => {
		await openThread(D1, 1);
		await hookFetch();
		await shotClip("header-390.png", "header");
		const info = await ev(`({ chip: (document.getElementById("statusChip") || {}).textContent, chips: [...document.querySelectorAll("#chips .chip")].map((c) => c.textContent), hide: document.getElementById("hideToggle").textContent })`);
		expect(info.chip === "🙋 내 차례" && info.chips.includes("세션 꺼짐"), `chip ${info.chip} chips ${info.chips}`);
		expect(info.hide === "숨기기", `hide button reads ${info.hide}`);
	});

	await step("(2) send to a dead session opens the sheet with reopen focused", async () => {
		await typeText("테스트 답");
		await clickSel("#send");
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		const sheet = await ev(`(() => { const s = document.querySelector(".sheet"); return { h3: s.querySelector("h3").textContent, p: s.querySelector("p").textContent, buttons: [...s.querySelectorAll("button")].map((b) => b.textContent), focus: document.activeElement && document.activeElement.textContent, focusSheet: document.activeElement && document.activeElement.getAttribute("data-sheet") }; })()`);
		expect(sheet.h3 === "세션이 꺼져 있습니다", `h3 ${sheet.h3}`);
		expect(sheet.p === "다시 열면 이 답을 바로 전달합니다.", `p ${sheet.p}`);
		expect(sheet.buttons.includes("다시 열고 보내기") && sheet.buttons.includes("나중에 전달"), `buttons ${sheet.buttons}`);
		expect(sheet.focusSheet === "reopen", `focus is on ${sheet.focus}`);
		await shot("sheet-390-light.png");
	});

	await step("(3) Escape closes the sheet, sends nothing, and keeps the text", async () => {
		const before = (await answersOf(D1, d1Item)).length;
		await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await settle();
		expect(!(await sheetOpen()), "sheet still open after Escape");
		expect((await replyValue()) === "테스트 답", `textarea is ${await replyValue()}`);
		expect((await answersOf(D1, d1Item)).length === before, "an answer was sent on Escape");
	});

	await step("(4) a click on the dim cancels and sends nothing", async () => {
		const before = (await answersOf(D1, d1Item)).length;
		await clickSel("#send");
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		await dark();
		await shot("sheet-390-dark.png");
		await light();
		await click(5, 5);
		await settle();
		expect(!(await sheetOpen()), "sheet still open after the dim click");
		expect((await answersOf(D1, d1Item)).length === before, "an answer was sent on the dim click");
		expect(sinkLines().length === 0, "the sink got a line on the dim click");
	});

	await step("(5) 나중에 전달 sends the answer without reopening", async () => {
		const before = (await answersOf(D1, d1Item)).length;
		await clickSel("#send");
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		await clickSel('[data-sheet="later"]');
		await until(async () => (await answersOf(D1, d1Item)).length === before + 1, 8000, "later answer");
		expect(sinkLines().length === 0, `sink has ${sinkLines().length} line(s)`);
	});

	await step("(6) 다시 열고 보내기 sends and writes exactly one reopen line", async () => {
		const before = (await answersOf(D1)).length;
		await typeText("테스트 답");
		await clickSel("#send");
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		await clickSel('[data-sheet="reopen"]');
		await until(async () => (await answersOf(D1)).length === before + 1, 8000, "reopen answer");
		await waitFor(`window.__reopenDone === 1 && window.__reopenPosts === 1`, 8000, "reopen finished");
		const lines = sinkLines();
		const got = await ev(`JSON.stringify([window.__reopenStatus, window.__reopenBody])`);
		expect(lines.length === 1, `sink has ${lines.length} line(s), reopen response ${got}`);
		const entry = JSON.parse(lines[0]);
		expect(entry.sid === D1, `sink sid ${entry.sid}`);
		expect(Array.isArray(entry.attempts) && entry.attempts.length > 0, "sink attempts empty");
		await waitFor(`document.getElementById("composeStatus").textContent === ${JSON.stringify(SENT_TEXT)}`, 8000, "reopen status");
	});

	await step("(7) a second reopen within 60 s does not launch again", async () => {
		await typeText("테스트 답");
		await clickSel("#send");
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		await clickSel('[data-sheet="reopen"]');
		await waitFor(`window.__reopenDone === 2 && window.__reopenPosts === 2`, 8000, "second reopen finished");
		expect(sinkLines().length === 1, `sink has ${sinkLines().length} line(s) after the second reopen`);
		expect((await composeStatus()) === SENT_TEXT, `status is ${await composeStatus()}`);
	});

	await step("(8) a live thread sends with no sheet", async () => {
		await openThread(V1, 0);
		const before = (await eventsOf(V1)).length;
		await typeText("V1 답");
		await clickSel("#send");
		await until(async () => (await eventsOf(V1)).length > before, 8000, "V1 message event");
		expect(!(await sheetOpen()), "a sheet opened for a live thread");
		expect((await replyValue()) === "", "the live thread's textarea was not cleared");
	});

	await step("(9) the V1 thread shows a Review link line and a Review kind label", async () => {
		await waitFor(`[...document.querySelectorAll(".msg.sys .line")].some((e) => e.textContent.startsWith("Review · "))`, 8000, "Review link line");
		await waitFor(`[...document.querySelectorAll('.kind[data-kind="board"]')].some((e) => e.textContent === "Review")`, 8000, "Review kind label");
	});

	await step("(10) the hide button toggles the thread's hidden flag", async () => {
		await openThread(D1, 1);
		await clickSel("#hideToggle");
		await waitFor(`document.getElementById("hideToggle").textContent === "숨김 해제"`, 8000, "hidden label");
		expect((await hiddenOf(D1)) === true, "row is not hidden after the first click");
		await clickSel("#hideToggle");
		await waitFor(`document.getElementById("hideToggle").textContent === "숨기기"`, 8000, "shown label");
		expect((await hiddenOf(D1)) === false, "row is still hidden after the second click");
	});

	await step("(11) a failed send never reopens and keeps the text", async () => {
		const linesBefore = sinkLines().length;
		await hookFetch();
		await ev(`window.__failNext = true`);
		await typeText("실패 테스트");
		await clickSel("#send");
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		await clickSel('[data-sheet="reopen"]');
		await waitFor(`document.getElementById("composeStatus").textContent.includes(${JSON.stringify(FAILED_TEXT)})`, 8000, "failure text");
		expect(sinkLines().length === linesBefore, "the sink grew after a failed send");
		expect((await ev("window.__reopenPosts")) === 0, "a reopen POST was made after a failed send");
		expect((await replyValue()) === "실패 테스트", `textarea is ${await replyValue()}`);
	});

	await step("(12) an option button on a dead session asks first: Escape returns focus to the option, 나중에 전달 sends one answer", async () => {
		const opt = `section[data-item="${d2Item}"] .opt[data-label="나눠서"]`;
		const linesBefore = sinkLines().length;
		await openThread(D2, 1);
		await clickSel(opt);
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet on option");
		await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await settle();
		expect(!(await sheetOpen()), "sheet still open after Escape");
		const focus = await ev(`(document.activeElement && document.activeElement.getAttribute("data-label")) || (document.activeElement && document.activeElement.tagName)`);
		expect(focus === "나눠서", `focus after Escape is on ${focus}`);
		expect((await answersOf(D2, d2Item)).length === 0, "an answer was sent on Escape");
		await clickSel(opt);
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet again");
		await clickSel('[data-sheet="later"]');
		await until(async () => (await answersOf(D2, d2Item)).length === 1, 8000, "option answer");
		expect(sinkLines().length === linesBefore, "the sink grew on 나중에 전달");
	});

	await step("(13) a quick reply on a dead session asks first and 나중에 전달 sends it", async () => {
		const linesBefore = sinkLines().length;
		await openThread(D3, 1);
		await waitFor(`!document.getElementById("quick").hidden`, 8000, "quick chips");
		await clickSel('#quick [data-quick="계속해"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet on quick reply");
		await clickSel('[data-sheet="later"]');
		await until(async () => (await answersOf(D3, d3Item)).length === 1, 8000, "quick answer");
		const answers = await answersOf(D3, d3Item);
		expect(JSON.stringify(answers[0].payload) === JSON.stringify({ text: "계속해" }), `payload ${JSON.stringify(answers[0].payload)}`);
		expect(sinkLines().length === linesBefore, "the sink grew on 나중에 전달");
	});

	await step("(14) a live thread whose newest item is done shows 🙋 내 차례 in the header, not ✅ 끝남", async () => {
		await prime(V1);
		await must("POST", `/api/threads/${V1}/items`, { kind: "done", policy: "needs-you", dedupeKey: "done:v1:1", raw: { text: "목표를 마쳤습니다." } });
		await openThread(V1, 1);
		await waitFor(`(document.getElementById("statusChip") || {}).textContent === "🙋 내 차례"`, 8000, "내 차례 chip");
		const chip = await ev(`document.getElementById("statusChip").textContent`);
		expect(chip === "🙋 내 차례", `chip ${chip}`);
	});

	// the desktop sheet, taken after the checks so no state they rely on changes
	// At 1280 the thread lives in iframe.thread of the split view (/?s=<sid>); the same assertions run on its document.
	await desktop();
	await step("(15) desktop split view: the D1 thread opens in the iframe (back link hidden via data-embed, URL /?s=<sid>) and the reply sheet opens", async () => {
		await view.navigate(`${base}/?s=${encodeURIComponent(D1)}`);
		const frame = "document.querySelector('iframe.thread').contentDocument";
		await waitFor(`${frame} && ${frame}.getElementById('chat') && ${frame}.getElementById('chat').getAttribute('aria-busy') === 'false' && ${frame}.querySelectorAll('section[data-item]').length >= 1`, 15000, `thread ${D1} ready in the iframe`);
		await settle();
		const info = await ev(`(() => { const d = ${frame}; const back = d.querySelector("a.back"); return { path: location.pathname + location.search, embed: d.documentElement.hasAttribute("data-embed"), backShown: Boolean(back) && d.defaultView.getComputedStyle(back).display !== "none" }; })()`);
		expect(info.path === `/?s=${encodeURIComponent(D1)}`, `top URL ${info.path}`);
		expect(info.embed && !info.backShown, `data-embed ${info.embed}, back link shown ${info.backShown}`);
		await ev(`(() => { const el = ${frame}.getElementById("reply"); el.value = "데스크톱 답"; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
		await ev(`${frame}.getElementById("send").scrollIntoView({ block: "center" })`);
		await settle();
		const r = await ev(`(() => { const f = document.querySelector("iframe.thread").getBoundingClientRect(); const b = ${frame}.getElementById("send").getBoundingClientRect(); return { cx: f.left + b.left + b.width / 2, cy: f.top + b.top + b.height / 2 }; })()`);
		await click(r.cx, r.cy);
		await waitFor(`Boolean(${frame}.querySelector(".sheet"))`, 8000, "desktop sheet");
		await shot("sheet-1280-light.png");
		await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await settle();
	});
} catch (error) {
	record("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	try {
		await view?.close();
		console.log("browser closed");
	} catch {
		console.log("browser already gone");
	}
	if (server) {
		server.kill();
		await serverExit;
		console.log(`server pid ${server.pid} exited: ${server.exitCode !== null || server.killed}`);
	}
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`temp removed ${!fs.existsSync(tmp)}; output in ${OUT}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
