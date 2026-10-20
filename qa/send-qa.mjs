/* Real-browser QA for the omo-inbox proposal page send row (round3): 재요청/승인 send once and leave for the inbox, no 닫기,
 * and a floating 멈추기 that stays on screen while 듣기 reads.
 *
 * Usage: bun qa/send-qa.mjs [app dir, default the repo] [screenshot dir, default a new temp dir]
 * Starts <app>/src/server.mjs on a temp OMO_INBOX_HOME (port 4391), submits three proposals (one frame + one question each)
 * and drives one Bun.WebView through CDP: phone 390x844 with touch, then desktop 1440x900. Speech is a recorder stub.
 * Exit 0 only when every check passes. The temp home is deleted at the end; screenshots stay in the printed dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { framePng } from "./frame.mjs";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = 4391;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "inbox-qa-send-"));
const EMPTY_TEXT = "고른 것이나 의견이 없습니다.";
const FAILED_TEXT = "보내지 못했습니다.";
const CLOSED_TEXT = "이미 끝난 Review입니다.";

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (o) => JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));

// Same recorder as read-aloud-qa.mjs: headless Chrome cannot be heard, so speech is counted instead.
const STUB = `(() => {
	window.__spoken = [];
	window.__cancels = 0;
	const fake = { speaking: false, pending: false, paused: false, getVoices: () => [], cancel() { window.__cancels++; }, resume() {}, speak(u) { window.__spoken.push(u); } };
	Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true, writable: true });
	return window.speechSynthesis === fake;
})()`;

// window.fetch answers the feedback POST with the given status; everything else goes through. Returns the restore expression.
const failFeedback = (status) => `(() => { window.__realFetch = window.__realFetch || window.fetch; window.fetch = (url, init) => String(url).includes("/feedback") ? Promise.resolve(new Response('{"error":"forced"}', { status: ${status}, headers: { "content-type": "application/json" } })) : window.__realFetch.call(window, url, init); return true; })()`;
const RESTORE_FETCH = "(() => { if (window.__realFetch) window.fetch = window.__realFetch; return true; })()";

// The floating 멈추기 as the page shows it: the fixed button with that text, its place against the viewport and against #aiFab.
const FLOATING = `(() => {
	const inView = (r) => r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
	const fab = document.getElementById("aiFab").getBoundingClientRect();
	const listen = document.getElementById("listenBtn");
	const hits = [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "멈추기" && !b.hidden && getComputedStyle(b).position === "fixed");
	return {
		count: hits.length,
		listenText: listen.textContent,
		listenInView: inView(listen.getBoundingClientRect()),
		fab: { l: fab.left, t: fab.top, r: fab.right, b: fab.bottom },
		hits: hits.map((b) => {
			const r = b.getBoundingClientRect();
			const onTop = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
			const intersects = !(r.right <= fab.left || r.left >= fab.right || r.bottom <= fab.top || r.top >= fab.bottom);
			return { id: b.id, inView: inView(r), onTop, intersects, l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
		}),
	};
})()`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-send-"));
const home = path.join(tmp, "home");
const src = path.join(tmp, "board");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(src, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));
fs.writeFileSync(path.join(src, "board.png"), framePng());
fs.writeFileSync(
	path.join(src, "board.json"),
	JSON.stringify({
		title: "보내기 QA",
		lead: "보내기 줄과 떠 있는 멈추기를 확인합니다.",
		sections: [{ title: "화면", desc: "휴대폰 화면", cards: [{ badge: "1", title: "끌기 확인", layout: "one", say: "휴대폰에서 끌어 보는 화면입니다.", frames: [["화면", "board.png"]] }] }],
		questions: [
			{
				id: "q1",
				text: "어느 쪽으로 할까요?",
				help: "하나를 고릅니다.",
				options: [
					{ value: "a", label: "가", rec: true, why: "가가 단순합니다." },
					{ value: "b", label: "나", why: "나가 유연합니다." },
				],
			},
		],
	}),
);

const listening = new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("server.json timeout")), 15000);
	const w = fs.watch(home, (_e, f) => {
		if (f === "server.json" && fs.existsSync(path.join(home, "server.json"))) {
			clearTimeout(t);
			w.close();
			resolve();
		}
	});
});
const server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], { cwd: APP, env: { ...process.env, OMO_INBOX_HOME: home }, stdout: "ignore", stderr: "ignore" });
const view = new Bun.WebView({ width: 1440, height: 900 });
const ev = (expr) => view.evaluate(expr);
const cdp = (m, p) => view.cdp(m, p || {});
const waitFor = (cond, ms, what) =>
	ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
// A sent page navigates away, and an evaluate can't be awaited across that, so the arrival is polled from here with a bounded deadline.
const waitPath = async (want, ms) => {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		try {
			if ((await ev("location.pathname")) === want) return true;
		} catch {
			// the old document went away mid-navigation: ask again
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
};
const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))");
// resolves once the page has stopped scrolling (scrollIntoView and the reading outline both scroll)
const stable = () => ev("new Promise((resolve) => { let last = -1; let n = 0; const f = () => { if (scrollY === last) { if (++n >= 12) return resolve(true); } else { n = 0; last = scrollY; } requestAnimationFrame(f); }; f(); })");
const touch = (type, points) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points });
const tap = async (x, y) => {
	await touch("touchStart", [{ x, y, id: 0 }]);
	await touch("touchEnd", []);
	await settle();
};
const click = async (x, y) => {
	await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
	await settle();
};
const shot = async (name) => {
	const res = await cdp("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(path.join(OUT, name), Buffer.from(res.data, "base64"));
	console.log(`saved ${path.join(OUT, name)}`);
};
const rectOf = (selector) => ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
// A touch lands only inside the viewport, so a target below the fold is scrolled to the middle first.
const bringIn = async (selector) => {
	await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
	await stable();
};
const phone = async () => {
	await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
};
const desktop = async () => {
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
	await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
};
const open = async (id) => {
	await view.navigate(`${base}/p/${encodeURIComponent(id)}`);
	await waitFor("document.querySelectorAll('.frame canvas').length === 1 && [...document.querySelectorAll('.frame canvas')].every((c) => c.width > 0) && !document.getElementById('listenBtn').hidden && !document.getElementById('sendRow').hidden", 30000, "proposal page ready");
};
const sendRow = () => ev("({ path: location.pathname, status: document.getElementById('status').textContent, sendOn: !document.getElementById('sendBtn').disabled, approveOn: !document.getElementById('approveBtn').disabled, closeBtn: Boolean(document.getElementById('closeBtn')), buttons: [...document.querySelectorAll('#sendRow button')].map((b) => b.textContent.trim()) })");
const feedbackEvents = async (id) => {
	const data = await (await fetch(`${base}/api/p/${encodeURIComponent(id)}`)).json();
	return (data.events || []).filter((e) => e.type === "feedback").map((e) => ({ seq: e.seq, verdict: e.verdict, comment: e.comment, answers: e.answers }));
};
const submit = async (title) => {
	const res = await fetch(`${base}/api/proposals`, { method: "POST", headers: POST, body: JSON.stringify({ cwd: src, srcDir: src, title }) });
	const body = await res.json();
	if (!body.summary || !body.summary.id) throw new Error(`submit failed: ${res.status} ${JSON.stringify(body)}`);
	return body.summary.id;
};

// (s6) at the current viewport: 듣기 on, 정할 것 scrolled into view, the floating 멈추기 fully on screen and clear of #aiFab; pressing it stops.
async function floatingStop(label, press, shotName) {
	check(`${label}: speech stub installed`, (await ev(STUB)) === true);
	await ev("document.getElementById('listenBtn').click()");
	const started = await ev("({ spoken: window.__spoken.length, text: document.getElementById('listenBtn').textContent, hidden: document.getElementById('stopFab').hidden })");
	await ev("document.getElementById('decideCard').scrollIntoView({ block: 'center' })");
	await stable();
	const f = await FLOATING_STATE();
	const hit = f.hits[0];
	check(`${label}: 듣기 starts reading, the title-bar button says 멈추기 and the floating 멈추기 appears`, started.spoken > 0 && started.text === "멈추기" && started.hidden === false, fmt(started));
	check(`${label}: with 정할 것 in view, one floating 멈추기 is fully inside the viewport, at least 44 px tall, on top, and does not intersect #aiFab`, f.count === 1 && hit && hit.inView && hit.onTop && hit.h >= 44 && !hit.intersects, fmt(f));
	await shot(shotName);
	const cancelsBefore = await ev("window.__cancels");
	await press(hit.cx, hit.cy);
	const after = await ev("({ cancels: window.__cancels, text: document.getElementById('listenBtn').textContent, pressed: document.getElementById('listenBtn').getAttribute('aria-pressed'), hidden: document.getElementById('stopFab').hidden, visible: [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === '멈추기' && !b.hidden).length, outlined: document.querySelectorAll('.reading').length })");
	check(`${label}: pressing the floating 멈추기 cancels the speech, 듣기 is back and the floating control is hidden`, after.cancels === cancelsBefore + 1 && after.text === "듣기" && after.pressed === "false" && after.hidden === true && after.visible === 0 && after.outlined === 0, fmt({ cancelsBefore, after }));
}
const FLOATING_STATE = () => ev(FLOATING);

try {
	await listening;
	// Safety: every POST below must hit the server this script started on its temp home, never the live one.
	const health = await (await fetch(`${base}/api/health`)).json();
	if (health.port !== PORT || health.pid !== server.pid) throw new Error(`not our server on ${PORT}: ${fmt(health)}, spawned pid ${server.pid}`);
	console.log(`server up: ${fmt(health)} (spawned pid ${server.pid})`);
	const idA = await submit("보내기 QA 승인");
	const idB = await submit("보내기 QA 재요청");
	const idC = await submit("보내기 QA 머무름");
	console.log(`proposals ${idA} ${idB} ${idC}`);

	// ===== phone 390, proposal C: nothing is sent here =====
	await view.navigate("about:blank");
	await phone();
	await open(idC);
	const s1 = await sendRow();
	check("(s1) no #closeBtn, and no 닫기 among the send row buttons", !s1.closeBtn && !s1.buttons.includes("닫기") && fmt(s1.buttons) === fmt(["재요청", "승인"]), fmt(s1));
	await bringIn("#sendRow");
	await shot("send-row-390.png");

	// (s4) 재요청 with nothing picked, written or marked
	const sb = await rectOf("#sendBtn");
	await tap(sb.cx, sb.cy);
	await waitFor(`document.getElementById('status').textContent === ${JSON.stringify(EMPTY_TEXT)}`, 3000, "empty status").catch(() => {});
	const s4 = await sendRow();
	const s4Events = await feedbackEvents(idC);
	check("(s4) 재요청 with nothing stays on the page, says 고른 것이나 의견이 없습니다., both buttons enabled, nothing sent", s4.path === `/p/${idC}` && s4.status === EMPTY_TEXT && s4.sendOn && s4.approveOn && s4Events.length === 0, fmt({ s4, events: s4Events.length }));

	// (s5) the feedback POST fails with 500
	const ta = await rectOf("#comment");
	await tap(ta.cx, ta.cy);
	await cdp("Input.insertText", { text: "의견입니다" });
	await settle();
	check("(s5) fetch override installed", (await ev(failFeedback(500))) === true);
	await bringIn("#sendRow");
	const sb5 = await rectOf("#sendBtn");
	await tap(sb5.cx, sb5.cy);
	await waitFor(`document.getElementById('status').textContent === ${JSON.stringify(FAILED_TEXT)}`, 5000, "failed status").catch(() => {});
	const s5 = await sendRow();
	const s5Events = await feedbackEvents(idC);
	check("(s5) a 500 on the feedback POST stays on the page, says 보내지 못했습니다., both buttons enabled, nothing stored", s5.path === `/p/${idC}` && s5.status === FAILED_TEXT && s5.sendOn && s5.approveOn && s5Events.length === 0, fmt({ s5, events: s5Events.length }));
	// (s5b) and a 409 keeps the page too, with its own text
	check("(s5b) fetch override set to 409", (await ev(failFeedback(409))) === true);
	await tap(sb5.cx, sb5.cy);
	await waitFor(`document.getElementById('status').textContent === ${JSON.stringify(CLOSED_TEXT)}`, 5000, "closed status").catch(() => {});
	const s5b = await sendRow();
	check("(s5b) a 409 stays on the page, says 이미 끝난 Review입니다., both buttons enabled", s5b.path === `/p/${idC}` && s5b.status === CLOSED_TEXT && s5b.sendOn && s5b.approveOn, fmt(s5b));
	check("(s5b) fetch restored", (await ev(RESTORE_FETCH)) === true);

	// (s6) at 390: the floating 멈추기
	await floatingStop("(s6) 390", tap, "stop-fab-390.png");

	// ===== phone 390, proposal A: two quick taps on 승인 =====
	await open(idA);
	await bringIn('#questions label:has(input[value="a"])');
	const opt = await rectOf('#questions label:has(input[value="a"])');
	await tap(opt.cx, opt.cy);
	const picked = await ev("document.querySelector('input[name=\"q_q1\"][value=\"a\"]').checked");
	await bringIn("#sendRow");
	const ab = await rectOf("#approveBtn");
	// two taps, nothing between them
	await touch("touchStart", [{ x: ab.cx, y: ab.cy, id: 0 }]);
	await touch("touchEnd", []);
	await touch("touchStart", [{ x: ab.cx, y: ab.cy, id: 0 }]);
	await touch("touchEnd", []);
	const t0 = performance.now();
	const atInboxA = await waitPath("/", 5000);
	const tookA = Math.round(performance.now() - t0);
	await waitFor("document.readyState === 'complete' && document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') !== 'true' && document.getElementById('list').children.length > 0", 10000, "inbox loaded").catch(() => {});
	await settle();
	const eventsA = await feedbackEvents(idA);
	check("(s2) option picked, two touch taps on 승인: exactly one feedback event (approve) and the page is at the inbox within 5 s", picked === true && atInboxA && eventsA.length === 1 && eventsA[0].verdict === "approve" && eventsA[0].answers && eventsA[0].answers.q1 === "a", fmt({ picked, atInboxA, tookMs: tookA, eventsA }));
	const inbox = await ev("({ path: location.pathname, title: document.title, rows: document.getElementById('list') ? document.getElementById('list').children.length : -1, text: (document.getElementById('list') || {}).textContent })");
	await view.navigate(`${base}/boards`);
	await waitFor("document.readyState === 'complete' && document.querySelectorAll('.row').length > 0", 10000, "Review rows").catch(() => {});
	const reviews = await ev("({ path: location.pathname, rows: [...document.querySelectorAll('.row')].map((row) => row.textContent) })");
	check("(s2) the inbox lists the sent proposals", inbox.path === "/" && inbox.rows > 0 && reviews.path === "/boards" && reviews.rows.some((text) => String(text).includes("보내기 QA 승인")), fmt({ path: reviews.path, rows: reviews.rows.length }));
	await shot("inbox-after-approve-390.png");

	// ===== phone 390, proposal B: 재요청 with a comment, two clicks in one task =====
	await open(idB);
	await bringIn("#comment");
	const tb = await rectOf("#comment");
	await tap(tb.cx, tb.cy);
	await cdp("Input.insertText", { text: "여백을 더 주세요" });
	await settle();
	const typed = await ev("document.getElementById('comment').value");
	await bringIn("#sendRow");
	// the lock must hold before the click handler yields: the second click of the same task must find both buttons disabled
	const locked = await ev("(() => { const s = document.getElementById('sendBtn'); const a = document.getElementById('approveBtn'); s.click(); const afterFirst = { send: s.disabled, approve: a.disabled }; s.click(); a.click(); return afterFirst; })()");
	const atInboxB = await waitPath("/", 5000);
	await waitFor("document.readyState === 'complete' && document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') !== 'true'", 10000, "inbox loaded").catch(() => {});
	const eventsB = await feedbackEvents(idB);
	check("(s3) 재요청 with a comment: both buttons are disabled synchronously by the first click, exactly one change event, page at the inbox", typed === "여백을 더 주세요" && locked.send === true && locked.approve === true && atInboxB && eventsB.length === 1 && eventsB[0].verdict === "change" && eventsB[0].comment === "여백을 더 주세요", fmt({ typed, locked, atInboxB, eventsB }));

	// ===== desktop 1440, proposal C: the floating 멈추기 again =====
	await desktop();
	await open(idC);
	await floatingStop("(s6) 1440", click, "stop-fab-1440.png");
	const s6c = await sendRow();
	check("(s6) 1440: the send row still has only 재요청 and 승인", fmt(s6c.buttons) === fmt(["재요청", "승인"]) && !s6c.closeBtn, fmt(s6c.buttons));
} catch (error) {
	check("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	await view.close();
	server.kill();
	await server.exited;
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`cleanup: server stopped, browser closed, temp removed ${!fs.existsSync(tmp)}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
