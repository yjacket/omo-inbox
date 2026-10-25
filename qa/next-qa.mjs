/* Real-browser QA for next actions (plan todo 17): the verdict line, the action bar, close and new-session, the sheets,
 * stale/confirm answers, provider-free plan roots and pre-update threads. Runs every scenario at 390x844 and 1280x800.
 *
 * Usage: bun qa/next-qa.mjs
 * Starts src/server.mjs on a temp OMO_INBOX_HOME (port 4402, INBOX_NO_TAILSCALE=1) with INBOX_PUSH_SINK and
 * INBOX_REOPEN_SINK pointing at temp files, so a launch is a JSON line instead of a terminal. Seeds through the session
 * API, keeps live sessions live with /api/here, then drives one Bun.WebView through CDP: phone 390x844 with touch, then
 * desktop 1280x800 (the thread in the split view's iframe). Screenshots task-17-*.png land in the evidence dir (or
 * INBOX_QA_OUT). The last line is `N/N checks passed`; exit 0 only when every check passes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4402;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const OUT = process.env.INBOX_QA_OUT ? path.resolve(process.env.INBOX_QA_OUT) : path.join(APP, ".omo", "evidence", "inbox-next-action", "task-17");
const PREFIX = "task-17-";
const PLAN_SLUG = "comprehensive-tool-grouping";
const STALE_TEXT = "상황이 바뀌었습니다. 다시 확인해 주세요.";
const EXAMPLE_A = ["wanted: 남은 일이 없는지 확인", "For you: 작업은 모두 끝났습니다.", "Now: 남은 작업 없음. Next: 없음."].join("\n");
const EXAMPLE_B = [
	"wanted: 계획 실행",
	"For you: 계획 파일이 준비됐고 아직 남은 항목이 있습니다.",
	"Now: 미완료 항목 4개가 남았습니다.",
	`Next: \`/ulw-execute ${PLAN_SLUG}\` 로 새 세션에서 이어가세요.`,
].join("\n");
const ASK_TEXT = ["Next: 없음.", "어떻게 할지 알려 주세요."].join("\n");
const KICKOFF = `/skill:ulw-execute ${PLAN_SLUG}`;

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
		record(name, false, error && error.stack ? error.stack : String(error));
	}
}
async function until(fn, ms, what) {
	const t0 = Date.now();
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ---------- temp home, repos, server ----------

const scratch = path.join(process.env.TMPDIR || os.tmpdir(), "scratch-17");
fs.mkdirSync(scratch, { recursive: true });
const tmp = fs.mkdtempSync(path.join(scratch, "next-qa-"));
const home = path.join(tmp, "home");
const work = path.join(tmp, "work");
const planRoot = path.join(tmp, "plan-root");
const sink = path.join(tmp, "reopen.jsonl");
const pushSink = path.join(tmp, "push.jsonl");
const S13 = { phone: "qa-next-pre-390", desktop: "qa-next-pre-1280" };
const S13_ITEM = { phone: "i-261024-pa390", desktop: "i-261024-pa1280" };
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(planRoot, ".omo", "plans"), { recursive: true });
fs.writeFileSync(path.join(planRoot, ".omo", "plans", `${PLAN_SLUG}.md`), ["# comprehensive tool grouping", "", "- [ ] group the tools", "- [x] survey the tools", ""].join("\n"));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null, summary: { enabled: false }, progress: { modelLines: false } }));

function git(args, cwd) {
	const out = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	if (out.status !== 0) throw new Error(`git ${args.join(" ")} -> ${out.status}: ${out.stderr || out.stdout}`);
	return out.stdout;
}
function repo(name) {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir, { recursive: true });
	git(["init", "-q", "-b", "main", dir], tmp);
	git(["-C", dir, "config", "user.email", "qa@example.test"], tmp);
	git(["-C", dir, "config", "user.name", "QA"], tmp);
	fs.writeFileSync(path.join(dir, "base.txt"), "base\n");
	git(["-C", dir, "add", "-A"], tmp);
	git(["-C", dir, "commit", "-q", "-m", "base"], tmp);
	return dir;
}
function commitAll(dir) {
	git(["-C", dir, "add", "-A"], tmp);
	git(["-C", dir, "commit", "-q", "-m", "qa clean"], tmp);
}

// Pre-update threads (todo 17 S13): an open done final with no next event, and no new post after the server starts.
function writePreUpdateThread(sid, itemId, title) {
	const dir = path.join(home, "data", "threads", sid);
	fs.mkdirSync(path.join(dir, "events"), { recursive: true });
	const at = new Date().toISOString();
	fs.writeFileSync(path.join(dir, "thread.json"), JSON.stringify({
		v: 1, session: sid, cwd: work, product: "omo-inbox", feature: "omo-inbox#qa", worktree: null, branch: "qa",
		title, titleSource: "qa", firstRequest: title, created: at, ended: null, sessionFile: null, hidden: false, executes: null,
	}));
	fs.writeFileSync(path.join(dir, "events", "000001-item.json"), JSON.stringify({
		seq: 1, at, type: "item", itemId, kind: "turn", policy: "needs-you", dedupeKey: `turn:${sid}:1`, createdAt: at, raw: { text: EXAMPLE_A }, meta: {},
	}));
}
writePreUpdateThread(S13.phone, S13_ITEM.phone, "이전 데이터 확인");
writePreUpdateThread(S13.desktop, S13_ITEM.desktop, "이전 데이터 확인");
// The pre-update thread stays live across the run (a future stamp never falls outside the 90 s window).
fs.mkdirSync(path.join(home, "data"), { recursive: true });
const live = {};
live[S13.phone] = Date.now() + 3_600_000;
live[S13.desktop] = Date.now() + 3_600_000;
fs.writeFileSync(path.join(home, "data", "live.json"), JSON.stringify(live));

async function api(method, route, body) {
	const res = await fetch(base + route, {
		method,
		headers: method === "POST" ? POST : { accept: "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
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
const prime = (sid, cwd = work) => must("GET", `/api/here?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sid)}`);
const eventsOf = async (sid) => (await must("GET", `/api/threads/${encodeURIComponent(sid)}`)).events;
const threadOf = (sid) => must("GET", `/api/threads/${encodeURIComponent(sid)}`);
const itemOf = async (sid, itemId) => (await threadOf(sid)).items.find((item) => item.id === itemId) ?? null;
const rowsOf = async () => (await must("GET", "/api/threads")).items;
const sinkLines = () => (fs.existsSync(sink) ? fs.readFileSync(sink, "utf8").split("\n").filter(Boolean) : []);
function mailboxFiles(sid) {
	const dir = path.join(home, "mailbox", sid);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) }));
}
function controlFiles(sid) {
	const dir = path.join(home, "control", sid);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) }));
}
function watchDir(dir, matches, ms, what) {
	return new Promise((resolve, reject) => {
		let watcher = null;
		let timer = null;
		const finish = (error, value) => {
			if (timer) clearTimeout(timer);
			if (watcher) watcher.close();
			if (error) reject(error);
			else resolve(value);
		};
		const scan = () => {
			try {
				const found = matches();
				if (found) finish(null, found);
			} catch (error) {
				finish(error);
			}
		};
		fs.mkdirSync(dir, { recursive: true });
		watcher = fs.watch(dir, scan);
		timer = setTimeout(() => finish(new Error(`timeout: ${what}`)), ms);
		scan();
	});
}
const watchControl = (sid, action, itemId, ms = 10000) => {
	const dir = path.join(home, "control", sid);
	return watchDir(dir, () => controlFiles(sid).find((file) => file.action === action && (!itemId || file.itemId === itemId)) ?? null, ms, `control ${action} for ${sid}`);
};
const watchSink = (count, ms = 10000) => watchDir(tmp, () => (sinkLines().length > count ? JSON.parse(sinkLines()[sinkLines().length - 1]) : null), ms, `sink line ${count + 1}`);

async function meta(sid, { cwd, worktree = null, title }) {
	await must("POST", `/api/threads/${encodeURIComponent(sid)}/meta`, { title, product: "omo-inbox", feature: "omo-inbox#qa", branch: "qa", firstRequest: title, cwd, worktree });
}
async function seedFinal(sid, text, kind = "turn") {
	const out = await must("POST", `/api/threads/${encodeURIComponent(sid)}/items`, { kind, policy: "needs-you", dedupeKey: `turn:${sid}:1`, raw: { text } });
	return out.item.id;
}
async function waitNext(sid, itemId, predicate = () => true, ms = 15000) {
	return until(async () => {
		const item = await itemOf(sid, itemId);
		return item && item.next && predicate(item.next) ? item.next : null;
	}, ms, `next for ${itemId}`);
}
const dim = (mode) => (mode === "phone" ? "390" : "1280");
const sidFor = (key, mode) => `qa-next-${key}-${dim(mode)}`;

// ---------- browser helpers ----------

let view = null;
let wide = false;
let inFrame = false;
const evTop = (expr) => view.evaluate(expr);
const ev = (expr) =>
	inFrame
		? view.evaluate(`(() => { const w = document.querySelector("iframe.thread").contentWindow; const s = w.document.createElement("script"); s.textContent = ${JSON.stringify(`window.__qaResult = (async () => (${expr}\n))();`)}; w.document.head.append(s); s.remove(); return w.__qaResult; })()`)
		: view.evaluate(expr);
const cdp = (method, params) => view.cdp(method, params || {});
const waitFor = (cond, ms, what) =>
	ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))");
const stable = () => ev("new Promise((resolve) => { let last = -1; let n = 0; const f = () => { if (scrollY === last) { if (++n >= 12) return resolve(true); } else { n = 0; last = scrollY; } requestAnimationFrame(f); }; f(); })");
const touch = (type, points) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points });
const click = async (x, y) => {
	if (wide) {
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
		await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
	} else {
		await touch("touchStart", [{ x, y, id: 0 }]);
		await touch("touchEnd", []);
	}
	await settle();
};
const rectOf = async (selector) => {
	const r = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`no element ${selector}`)}); const b = el.getBoundingClientRect(); return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; })()`);
	if (!inFrame) return r;
	const o = await evTop(`(() => { const b = document.querySelector("iframe.thread").getBoundingClientRect(); return { x: b.left, y: b.top }; })()`);
	return { cx: r.cx + o.x, cy: r.cy + o.y };
};
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
const phone = async () => {
	await view.navigate("about:blank");
	await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	wide = false;
	inFrame = false;
};
const desktop = async () => {
	await view.navigate("about:blank");
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
	await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	wide = true;
	inFrame = false;
};
const setMode = (mode) => (mode === "phone" ? phone() : desktop());
async function openList() {
	inFrame = false;
	await view.navigate(`${base}/`);
	await waitFor("document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') === 'false'", 15000, "list ready");
	await settle();
}
async function openThread(sid, count = 1) {
	inFrame = false;
	await view.navigate("about:blank");
	if (wide) {
		await view.navigate(`${base}/?s=${encodeURIComponent(sid)}`);
		await waitFor(`(() => { const f = document.querySelector("iframe.thread"); try { return Boolean(f && f.contentDocument && f.contentDocument.readyState !== "loading" && f.contentDocument.getElementById("chat")); } catch { return false; } })()`, 15000, `split iframe ${sid}`);
		inFrame = true;
	} else {
		await view.navigate(`${base}/s/${encodeURIComponent(sid)}`);
	}
	await waitFor(`document.getElementById('chat') && document.getElementById('chat').getAttribute('aria-busy') === 'false' && document.querySelectorAll('section[data-item]').length >= ${count}`, 15000, `thread ${sid} ready`);
	await settle();
}
const nextState = () =>
	ev(`(() => ({ line: [...document.querySelectorAll(".msg.agent .next")].map((e) => e.textContent), quickHidden: document.getElementById("quick").hidden, quick: [...document.querySelectorAll("#quick button")].filter((b) => b.offsetParent !== null).map((b) => b.textContent), actionsHidden: document.getElementById("nextActions").hidden, actions: [...document.querySelectorAll("#nextActions button")].map((b) => ({ id: b.getAttribute("data-next"), text: b.textContent, primary: b.classList.contains("primary"), ghost: b.classList.contains("ghost"), disabled: b.disabled, top: Math.round(b.getBoundingClientRect().top), height: Math.round(b.getBoundingClientRect().height) })), chipBox: (() => { const b = [...document.querySelectorAll("#quick button")].find((e) => e.offsetParent !== null); if (!b) return null; const r = b.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; })(), chip: (document.getElementById("statusChip") || {}).textContent || "", sys: [...document.querySelectorAll(".msg.sys .line")].map((e) => e.textContent).filter(Boolean) }))()`);
const sheetState = () =>
	ev(`(() => { const sheet = document.querySelector(".sheet"); if (!sheet) return null; return { title: sheet.querySelector("h3").textContent, lines: [...sheet.querySelectorAll("p, li")].map((e) => e.textContent), buttons: [...sheet.querySelectorAll("button")].map((b) => b.textContent), focus: document.activeElement && document.activeElement.getAttribute("data-sheet") }; })()`);
const listState = () =>
	evTop(`(() => ({ rows: [...document.querySelectorAll("#list .row[data-session]")].map((row) => ({ session: row.getAttribute("data-session"), status: row.closest("section.group")?.getAttribute("data-status"), next: [...row.querySelectorAll(".chip.next")].map((c) => c.textContent) })) }))()`);
const found = (rows, sid) => rows.find((row) => row.session === sid) ?? null;
function launchFolder(entry) {
	for (const attempt of entry.attempts || []) {
		const args = attempt.args || [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "-d" && args[i + 1]) return args[i + 1];
			if (typeof args[i] === "string" && args[i].startsWith("path:") && args[i].length > 5) return args[i].slice(5);
		}
	}
	return null;
}
// A launch attempt carries --session-id, the new sid and the exact kickoff: as separate wt argv entries, or inside the
// orca command string (`omo --session-id <sid> "<kickoff>"`). The bare slug does not count.
function launchExact(entry, sid, kickoff) {
	return (entry.attempts || []).some((attempt) => {
		const args = (attempt.args || []).map(String);
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--session-id" && args[i + 1] === sid && args[i + 2] === kickoff) return true;
		}
		return args.some((arg) => arg.includes(`--session-id ${sid} "${kickoff}"`));
	});
}

// Intercept the page's action POSTs so S10 can assert the HTTP answer, not only what the UI did with it.
const captureActionPosts = () =>
	ev(`(() => {
		window.__qaActionResponses = [];
		window.__qaRealFetch = window.__qaRealFetch || window.fetch;
		window.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input && input.url;
			const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
			const res = await window.__qaRealFetch.call(window, input, init);
			if (method === "POST" && /\\/api\\/items\\/[^/]+\\/action$/.test(String(url))) {
				let body = null;
				try { body = await res.clone().json(); } catch {}
				window.__qaActionResponses.push({ status: res.status, body });
			}
			return res;
		};
		return true;
	})()`);
const actionPosts = () => ev("window.__qaActionResponses || []");

// ---------- scenarios ----------

async function s1(mode) {
	const sid = sidFor("done", mode);
	const label = `(S1/${mode})`;
	await step(`${label} done final shows 다음 · 남은 일이 없습니다, hides the chips and puts 세션 닫기 primary`, async () => {
		await meta(sid, { cwd: work, title: "남은 일 확인" });
		await prime(sid);
		const itemId = await seedFinal(sid, EXAMPLE_A);
		await waitNext(sid, itemId, (next) => next.state === "done");
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="close"]')`, 10000, "close action");
		const state = await nextState();
		expect(state.line.some((line) => line === "다음 · 남은 일이 없습니다"), `line ${JSON.stringify(state.line)}`);
		expect(state.quickHidden, "the quick chips are visible");
		expect(state.actions.length === 1 && state.actions[0].id === "close" && state.actions[0].primary && !state.actions[0].ghost, `actions ${JSON.stringify(state.actions)}`);
		await shot(`s1-done-${dim(mode)}.png`);
	});
	await step(`${label} tapping 세션 닫기 writes one close control and the owner bubble reads 세션 닫기`, async () => {
		const itemId = (await itemOf(sid, (await eventsOf(sid)).find((event) => event.type === "item").itemId)).id;
		const control = watchControl(sid, "close", itemId);
		await clickSel('#nextActions [data-next="close"]');
		const file = await control;
		expect(file.type === "session-control" && file.v === 1, `control ${JSON.stringify(file)}`);
		await waitFor(`[...document.querySelectorAll(".msg.user .bubble")].some((e) => e.textContent === "세션 닫기")`, 8000, "owner bubble");
		expect(controlFiles(sid).length === 1, `controls ${controlFiles(sid).length}`);
	});
}

async function s2(mode) {
	const sid = sidFor("plan", mode);
	const label = `(S2/${mode})`;
	let itemId = null;
	await step(`${label} plan final offers 새 세션에서 실행 primary with the plan line`, async () => {
		await meta(sid, { cwd: planRoot, worktree: planRoot, title: "계획 실행 대기" });
		await prime(sid, planRoot);
		itemId = await seedFinal(sid, EXAMPLE_B);
		await waitNext(sid, itemId, (next) => next.state === "plan");
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="new-session"]')`, 10000, "new session action");
		const state = await nextState();
		expect(state.line.some((line) => line === `다음 · 계획 ${PLAN_SLUG} 실행 대기`), `line ${JSON.stringify(state.line)}`);
		expect(state.actions[0].id === "new-session" && state.actions[0].primary, `actions ${JSON.stringify(state.actions)}`);
		await shot(`s2-plan-${dim(mode)}.png`);
	});
	await step(`${label} the sheet shows the folder and kickoff, and 실행 writes a launch sink line`, async () => {
		const before = sinkLines().length;
		await clickSel('#nextActions [data-next="new-session"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "new session sheet");
		const sheet = await sheetState();
		expect(sheet.title === "새 세션에서 실행할까요?", `title ${sheet.title}`);
		expect(sheet.lines.some((line) => line === `폴더 · ${planRoot}`), `folder line ${JSON.stringify(sheet.lines)}`);
		expect(sheet.lines.some((line) => line === `첫 메시지 · ${KICKOFF}`), `kickoff line ${JSON.stringify(sheet.lines)}`);
		await shot(`s2-sheet-${dim(mode)}.png`);
		const line = watchSink(before);
		await clickSel('[data-sheet="launch"]');
		const entry = await line;
		expect(entry.kind === "launch", `entry ${JSON.stringify(entry)}`);
		expect(sinkLines().length === before + 1, `sink gained ${sinkLines().length - before} line(s)`);
		expect(launchExact(entry, entry.sid, KICKOFF), `attempts ${JSON.stringify(entry.attempts)}`);
		await waitFor(`[...document.querySelectorAll(".msg.sys .line")].some((e) => e.textContent.includes("새 세션을 여는 중"))`, 10000, "launching line");
		const newSid = entry.sid;
		const oldControl = watchControl(sid, "close", itemId);
		await must("GET", `/api/here?cwd=${encodeURIComponent(planRoot)}&session=${encodeURIComponent(newSid)}`);
		const control = await oldControl;
		expect(control.action === "close" && control.itemId === itemId, `control ${JSON.stringify(control)}`);
		await waitFor(`[...document.querySelectorAll(".msg.sys .line")].some((e) => e.textContent === "새 세션에서 이어감 · 열기")`, 12000, "connected handoff line");
		const handoff = await ev(`[...document.querySelectorAll(".msg.sys")].find((e) => e.textContent.startsWith("새 세션에서 이어감"))?.querySelector("a")?.getAttribute("href")`);
		expect(handoff === `/s/${newSid}`, `handoff link ${handoff}`);
		await settle();
		expect(sinkLines().length === before + 1, `sink gained ${sinkLines().length - before} line(s) after the handoff connected`);
		await shot(`s2-connected-${dim(mode)}.png`);
	});
}

async function s3(mode) {
	const sid = sidFor("ship", mode);
	const label = `(S3/${mode})`;
	const dir = repo(`ship-${dim(mode)}`);
	fs.writeFileSync(path.join(dir, "untracked.txt"), "one\n");
	await step(`${label} a dirty repo at final time shows the ship reason and 커밋·푸시 primary`, async () => {
		await meta(sid, { cwd: dir, worktree: dir, title: "마무리 남음" });
		await prime(sid, dir);
		const itemId = await seedFinal(sid, EXAMPLE_A);
		await waitNext(sid, itemId, (next) => next.state === "ship");
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="commit-push"]')`, 10000, "commit push action");
		const state = await nextState();
		expect(state.line.some((line) => line === "다음 · 커밋 안 된 변경 1개"), `line ${JSON.stringify(state.line)}`);
		expect(state.actions[0].id === "commit-push" && state.actions[0].primary && state.actions[0].text === "커밋·푸시", `actions ${JSON.stringify(state.actions)}`);
		await shot(`s3-ship-${dim(mode)}.png`);
	});
	await step(`${label} tapping 커밋·푸시 writes the mailbox answer 변경을 커밋하고 푸시해`, async () => {
		await clickSel('#nextActions [data-next="commit-push"]');
		const file = await until(() => mailboxFiles(sid).find((entry) => entry.text === "변경을 커밋하고 푸시해") ?? null, 10000, "commit-push mailbox");
		expect(file.text === "변경을 커밋하고 푸시해", `mailbox ${JSON.stringify(file)}`);
	});
}

async function s4(mode) {
	const sid = sidFor("ask", mode);
	const label = `(S4/${mode})`;
	await step(`${label} an ask final keeps four chips, shows no 다음 line and puts the ghost 세션 닫기 last on the chips' row at their height`, async () => {
		await meta(sid, { cwd: work, title: "답을 기다립니다" });
		await prime(sid);
		const itemId = await seedFinal(sid, ASK_TEXT);
		await waitNext(sid, itemId, (next) => next.state === "ask");
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="close"]')`, 10000, "close action");
		const state = await nextState();
		expect(!state.quickHidden && state.quick.length === 4, `quick ${JSON.stringify(state.quick)} hidden ${state.quickHidden}`);
		expect(state.line.length === 0, `next line ${JSON.stringify(state.line)}`);
		const last = state.actions[state.actions.length - 1];
		expect(last.id === "close" && last.ghost && !last.primary, `actions ${JSON.stringify(state.actions)}`);
		expect(state.chipBox && last.top === state.chipBox.top && last.height === state.chipBox.height, `close ${JSON.stringify(last)} chip ${JSON.stringify(state.chipBox)}`);
		await shot(`s4-ask-${dim(mode)}.png`);
	});
}

async function s5(mode) {
	const sid = sidFor("off-done", mode);
	const label = `(S5/${mode})`;
	let itemId = null;
	await step(`${label} an off session's done final closes without a sheet`, async () => {
		await meta(sid, { cwd: work, title: "꺼진 세션 끝남" });
		itemId = await seedFinal(sid, EXAMPLE_A);
		await waitNext(sid, itemId, (next) => next.state === "done");
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="close"]')`, 10000, "close action");
		await clickSel('#nextActions [data-next="close"]');
		expect(!(await ev(`Boolean(document.querySelector(".sheet"))`)), "a sheet opened for an off close");
		const item = await until(async () => { const it = await itemOf(sid, itemId); return it.status === "closed" ? it : null; }, 10000, "offline close");
		expect(item.closedReason === "closed-by-owner", `reason ${item.closedReason}`);
	});
	await step(`${label} the thread becomes 끝남 with the 닫음 line`, async () => {
		await waitFor(`(document.getElementById("statusChip") || {}).textContent === "✅ 끝남" && [...document.querySelectorAll(".msg.sys .line")].some((e) => e.textContent === "닫음")`, 10000, "closed thread");
		await shot(`s5-closed-${dim(mode)}.png`);
	});
}

async function s6(mode) {
	const sid = sidFor("off-plan", mode);
	const label = `(S6/${mode})`;
	await step(`${label} an off session's plan final launches a new session from the sink`, async () => {
		await meta(sid, { cwd: planRoot, worktree: planRoot, title: "꺼진 세션 계획" });
		const itemId = await seedFinal(sid, EXAMPLE_B);
		await waitNext(sid, itemId, (next) => next.state === "plan");
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="new-session"]')`, 10000, "new session action");
		const before = sinkLines().length;
		const line = watchSink(before);
		await clickSel('#nextActions [data-next="new-session"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		await clickSel('[data-sheet="launch"]');
		const entry = await line;
		expect(entry.kind === "launch" && launchExact(entry, entry.sid, KICKOFF), `entry ${JSON.stringify(entry)}`);
		expect(sinkLines().length === before + 1, `sink gained ${sinkLines().length - before} line(s)`);
		const item = await until(async () => { const it = await itemOf(sid, itemId); return it.status === "closed" ? it : null; }, 10000, "offline handoff close");
		expect(item.closedReason === "handed-off", `reason ${item.closedReason}`);
		await waitFor(`[...document.querySelectorAll(".msg.sys .line")].some((e) => e.textContent === "새 세션으로 넘어감")`, 10000, "handed-off line");
		await shot(`s6-handoff-${dim(mode)}.png`);
	});
}

async function s7(mode) {
	const sid = sidFor("warn", mode);
	const label = `(S7/${mode})`;
	const dir = repo(`warn-${dim(mode)}`);
	fs.writeFileSync(path.join(dir, "untracked.txt"), "one\n");
	await step(`${label} a dirty close asks with the 커밋 안 된 변경 1개 warning`, async () => {
		await meta(sid, { cwd: dir, worktree: dir, title: "닫기 경고" });
		await prime(sid, dir);
		const itemId = await seedFinal(sid, EXAMPLE_A);
		await waitNext(sid, itemId, (next) => next.state === "ship");
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="close"]')`, 10000, "close action");
		await clickSel('#nextActions [data-next="close"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "warning sheet");
		const sheet = await sheetState();
		expect(sheet.title === "세션을 닫을까요?", `title ${sheet.title}`);
		expect(sheet.lines.includes("커밋 안 된 변경 1개"), `lines ${JSON.stringify(sheet.lines)}`);
		await shot(`s7-warning-${dim(mode)}.png`);
	});
	await step(`${label} 취소 keeps the item open and 닫기 writes the close control`, async () => {
		const session = (await threadOf(sid)).items.find((item) => item.policy === "needs-you" && item.kind === "turn");
		await clickSel('[data-sheet="cancel"]');
		await waitFor(`!document.querySelector(".sheet")`, 8000, "sheet closed");
		expect((await itemOf(sid, session.id)).status === "open", "the item closed on 취소");
		await clickSel('#nextActions [data-next="close"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "warning sheet again");
		const control = watchControl(sid, "close", session.id);
		await clickSel('[data-sheet="close"]');
		const file = await control;
		expect(file.action === "close" && file.itemId === session.id, `control ${JSON.stringify(file)}`);
	});
}

async function s8(mode) {
	const label = `(S8/${mode})`;
	const doneSid = sidFor("row-done", mode);
	const planSid = sidFor("row-plan", mode);
	const shipSid = sidFor("row-ship", mode);
	const askSid = sidFor("row-ask", mode);
	const dir = repo(`row-${dim(mode)}`);
	fs.writeFileSync(path.join(dir, "untracked.txt"), "one\n");
	await step(`${label} the list labels 내 차례 rows 할 일 없음, 실행 대기, 마무리 남음 and leaves the ask row blank`, async () => {
		for (const [sid, cwd, text, state] of [
			[doneSid, work, EXAMPLE_A, "done"],
			[planSid, planRoot, EXAMPLE_B, "plan"],
			[shipSid, dir, EXAMPLE_A, "ship"],
			[askSid, work, ASK_TEXT, "ask"],
		]) {
			await meta(sid, { cwd, worktree: cwd, title: `목록 ${state}` });
			await prime(sid, cwd);
			const itemId = await seedFinal(sid, text);
			await waitNext(sid, itemId, (next) => next.state === state);
		}
		await openList();
		const rows = await listState();
		const local = (sid) => found(rows.rows, sid);
		expect(local(doneSid)?.status === "needs-you" && local(doneSid)?.next.includes("할 일 없음"), `done row ${JSON.stringify(local(doneSid))}`);
		expect(local(planSid)?.next.includes("실행 대기"), `plan row ${JSON.stringify(local(planSid))}`);
		expect(local(shipSid)?.next.includes("마무리 남음"), `ship row ${JSON.stringify(local(shipSid))}`);
		expect(local(askSid)?.status === "needs-you" && local(askSid)?.next.length === 0, `ask row ${JSON.stringify(local(askSid))}`);
		await shot(`s8-list-${dim(mode)}.png`);
	});
}

async function s9(mode) {
	const sid = sidFor("working", mode);
	const label = `(S9/${mode})`;
	await step(`${label} a working thread keeps four chips and shows no next buttons`, async () => {
		await meta(sid, { cwd: work, title: "일하는 중" });
		await prime(sid);
		await must("POST", `/api/threads/${encodeURIComponent(sid)}/items`, { kind: "progress", policy: "progress", dedupeKey: `line:${sid}:1`, raw: { text: "파일을 고치는 중입니다." } });
		await openThread(sid, 1);
		await waitFor(`(document.getElementById("statusChip") || {}).textContent === "🤖 진행 중"`, 10000, "working chip");
		const state = await nextState();
		expect(!state.quickHidden && state.quick.length === 4, `quick hidden ${state.quickHidden} ${JSON.stringify(state.quick)}`);
		expect(state.actionsHidden && state.actions.length === 0, `actions ${JSON.stringify(state.actions)} hidden ${state.actionsHidden}`);
		await shot(`s9-working-${dim(mode)}.png`);
	});
}

async function s10(mode) {
	const label = `(S10/${mode})`;
	const staleSid = sidFor("stale", mode);
	const staleDir = repo(`stale-${dim(mode)}`);
	fs.writeFileSync(path.join(staleDir, "untracked.txt"), "one\n");
	await step(`${label} a commit-push that no longer applies answers stale and shows 상황이 바뀌었습니다`, async () => {
		await meta(staleSid, { cwd: staleDir, worktree: staleDir, title: "바뀐 상황" });
		await prime(staleSid, staleDir);
		const itemId = await seedFinal(staleSid, EXAMPLE_A);
		await waitNext(staleSid, itemId, (next) => next.state === "ship");
		commitAll(staleDir);
		await openThread(staleSid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="commit-push"]')`, 10000, "commit push action");
		await captureActionPosts();
		await clickSel('#nextActions [data-next="commit-push"]');
		await waitFor(`document.getElementById("composeStatus").textContent === ${JSON.stringify(STALE_TEXT)}`, 10000, "stale text");
		await waitFor(`document.querySelector('#nextActions [data-next="close"]')`, 10000, "refreshed actions");
		const stalePosts = await actionPosts();
		expect(stalePosts.length === 1 && stalePosts[0].status === 409 && stalePosts[0].body?.error === "stale", `stale response ${JSON.stringify(stalePosts)}`);
		await shot(`s10-stale-${dim(mode)}.png`);
	});
	const confirmSid = sidFor("confirm", mode);
	const confirmDir = repo(`confirm-${dim(mode)}`);
	await step(`${label} a done final made dirty later answers confirm_required and opens the warning sheet`, async () => {
		await meta(confirmSid, { cwd: confirmDir, worktree: confirmDir, title: "나중에 더러워짐" });
		await prime(confirmSid, confirmDir);
		const itemId = await seedFinal(confirmSid, EXAMPLE_A);
		await waitNext(confirmSid, itemId, (next) => next.state === "done");
		// Load the clean done verdict first, then dirty the repo: the page keeps showing done and only the tap-time probe
		// inside POST /action can see the change, so the warning sheet can only come from the 409.
		await openThread(confirmSid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="close"]')`, 10000, "close action");
		fs.writeFileSync(path.join(confirmDir, "late.txt"), "late\n");
		await captureActionPosts();
		await clickSel('#nextActions [data-next="close"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 10000, "confirm sheet");
		const sheet = await sheetState();
		expect(sheet.title === "세션을 닫을까요?", `title ${sheet.title}`);
		expect(sheet.lines.includes("커밋 안 된 변경 1개"), `lines ${JSON.stringify(sheet.lines)}`);
		const confirmPosts = await actionPosts();
		const confirmPost = confirmPosts.find((post) => post.status === 409 && post.body?.error === "confirm_required");
		expect(confirmPosts.length === 1 && confirmPost, `confirm response ${JSON.stringify(confirmPosts)}`);
		expect(Array.isArray(confirmPost.body.warnings) && confirmPost.body.warnings.includes("커밋 안 된 변경 1개"), `warnings ${JSON.stringify(confirmPost.body)}`);
		await clickSel('[data-sheet="cancel"]');
		expect((await itemOf(confirmSid, itemId)).status === "open", "the item closed on 취소");
	});
}

async function s11(mode) {
	const sid = sidFor("main-plan", mode);
	const label = `(S11/${mode})`;
	const main = repo(`main-plan-${dim(mode)}`);
	const linked = path.join(tmp, `linked-plan-${dim(mode)}`);
	git(["-C", main, "worktree", "add", "-q", linked, "-b", `qa-${dim(mode)}`], tmp);
	// Only the main checkout has the plan; a linked worktree gets tracked files, so this stays untracked there.
	fs.mkdirSync(path.join(main, ".omo", "plans"), { recursive: true });
	fs.writeFileSync(path.join(main, ".omo", "plans", `${PLAN_SLUG}.md`), "- [ ] a row\n");
	await step(`${label} a plan found only in the main checkout shows and launches with that folder`, async () => {
		await meta(sid, { cwd: linked, worktree: linked, title: "메인 계획" });
		await prime(sid, linked);
		const itemId = await seedFinal(sid, EXAMPLE_B);
		const next = await waitNext(sid, itemId, (n) => n.state === "plan");
		expect(next.facts.plan && samePath(next.facts.plan.root, main), `plan root ${JSON.stringify(next.facts.plan)}`);
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="new-session"]')`, 10000, "new session action");
		await clickSel('#nextActions [data-next="new-session"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		const sheet = await sheetState();
		expect(sheet.lines.includes(`폴더 · ${main}`), `folder lines ${JSON.stringify(sheet.lines)}`);
		const before = sinkLines().length;
		const line = watchSink(before);
		await clickSel('[data-sheet="launch"]');
		const entry = await line;
		expect(sinkLines().length === before + 1, `sink gained ${sinkLines().length - before} line(s)`);
		expect(launchExact(entry, entry.sid, KICKOFF), `attempts ${JSON.stringify(entry.attempts)}`);
		const folder = launchFolder(entry);
		expect(folder && samePath(folder, main), `launch folder ${folder} attempts ${JSON.stringify(entry.attempts)}`);
		await shot(`s11-main-plan-${dim(mode)}.png`);
	});
}

async function s12(mode) {
	const sid = sidFor("quit", mode);
	const label = `(S12/${mode})`;
	await step(`${label} a quit session's plan final shows 실행 대기 in the list and 새 세션에서 실행 without 세션 닫기`, async () => {
		await meta(sid, { cwd: planRoot, worktree: planRoot, title: "종료한 세션 계획" });
		await prime(sid, planRoot);
		const itemId = await seedFinal(sid, EXAMPLE_B);
		await waitNext(sid, itemId, (next) => next.state === "plan");
		await must("POST", "/api/bye", { session: sid, closed: true });
		await waitNext(sid, itemId, (next) => next.state === "plan" && next.actions.some((action) => action.id === "new-session") && !next.actions.some((action) => action.id === "close"));
		const rows = await rowsOf();
		const row = rows.find((entry) => entry.session === sid);
		expect(row.status === "ended" && row.next?.label === "실행 대기", `row ${JSON.stringify(row)}`);
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="new-session"]')`, 10000, "new session action");
		const state = await nextState();
		expect(!state.actions.some((action) => action.id === "close"), `actions ${JSON.stringify(state.actions)}`);
		expect(state.actions.some((action) => action.id === "new-session"), `actions ${JSON.stringify(state.actions)}`);
		await shot(`s12-quit-${dim(mode)}.png`);
	});
	await step(`${label} 실행 launches once and the thread shows the handoff line`, async () => {
		const before = sinkLines().length;
		const line = watchSink(before);
		await clickSel('#nextActions [data-next="new-session"]');
		await waitFor(`Boolean(document.querySelector(".sheet"))`, 8000, "sheet");
		await clickSel('[data-sheet="launch"]');
		const entry = await line;
		expect(entry.kind === "launch" && launchExact(entry, entry.sid, KICKOFF), `entry ${JSON.stringify(entry)}`);
		expect(sinkLines().length === before + 1, `sink ${sinkLines().length - before} line(s)`);
		await waitFor(`document.querySelector('section[data-handoff] .line')`, 10000, "handoff line");
		const handoff = await ev(`document.querySelector("section[data-handoff] .line").textContent`);
		expect(handoff === "새 세션을 여는 중", `handoff ${handoff}`);
	});
}

async function s13(mode) {
	const sid = S13[mode];
	const itemId = S13_ITEM[mode];
	const label = `(S13/${mode})`;
	await step(`${label} a pre-update open done final is backfilled: list 할 일 없음 and thread 세션 닫기`, async () => {
		await waitNext(sid, itemId, (next) => next.state === "done");
		await openList();
		const rows = await listState();
		const row = found(rows.rows, sid);
		expect(row?.next.includes("할 일 없음"), `row ${JSON.stringify(row)}`);
		await openThread(sid, 1);
		await waitFor(`document.querySelector('#nextActions [data-next="close"]')`, 10000, "backfilled close action");
		const state = await nextState();
		expect(state.actions.some((action) => action.id === "close"), `actions ${JSON.stringify(state.actions)}`);
		await shot(`s13-pre-update-${dim(mode)}.png`);
	});
}

const SCENARIOS = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13];

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

	view = new Bun.WebView({ width: 1280, height: 800 });
	for (const mode of ["phone", "desktop"]) {
		await setMode(mode);
		console.log(`--- ${mode} ${dim(mode)}x${mode === "phone" ? "844" : "800"} ---`);
		for (const scenario of SCENARIOS) await scenario(mode);
	}
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
	try {
		fs.rmdirSync(scratch);
	} catch {}
	console.log(`temp removed ${!fs.existsSync(tmp)}; output in ${OUT}`);
}
const failed = checks.filter((entry) => !entry.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
