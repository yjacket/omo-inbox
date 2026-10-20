/* Real-browser QA for the split view: the threads list at / and the thread at /s/<sid> side by side when the window
 * is WIDE (at least 720 CSS px), the single list on a phone, and the handovers between the two when the URL or the
 * window width says the other layout.
 *
 * Usage: bun qa/split-qa.mjs [app dir, default the repo] [output dir, default a new temp dir]
 * Starts <app>/src/server.mjs on a temp OMO_INBOX_HOME (port 4398, INBOX_NO_TAILSCALE=1, would-be pushes go to the
 * INBOX_PUSH_SINK file, reopens to the INBOX_REOPEN_SINK file), seeds three session threads through the session API
 * (one needing you, two in progress), then drives one Bun.WebView through CDP: phone 390x844 with touch, an unfolded
 * Galaxy Z Fold 840x1000 with touch, desktop 1280x800 with a mouse, 1280 in the dark scheme, and a 1280 -> 390 resize.
 * The CSP frame-ancestors value of / and /s/<sid> is read from the response headers. Screenshots (split-390.png,
 * split-840.png, split-1280.png, split-1280-dark.png) land in the output dir; the temp home is deleted at the end.
 * Exit 0 only when every check passes; the last line is `N/N checks passed`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = 4398;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "split-qa-out-"));
const A = "qa-split-a";
const B = "qa-split-b";
const C = "qa-split-c";
const POLL_TEXT = "폴링 확인용 새 진행 줄";

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (o) => JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));
const near = (a, b) => typeof a === "number" && Math.abs(a - b) <= 2;

// ---------- temp home, server, seeding ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "split-qa-"));
const home = path.join(tmp, "home");
const sink = path.join(tmp, "push.jsonl");
const reopenSink = path.join(tmp, "reopen.jsonl");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));

async function must(method, route, body) {
	const res = await fetch(base + route, { method, headers: method === "POST" ? POST : { accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	let json = null;
	try {
		json = await res.json();
	} catch {
		json = null;
	}
	if (res.status !== 200) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(json)}`);
	return json;
}

async function seed() {
	await must("POST", `/api/threads/${A}/meta`, { title: "결제 모듈 커밋 방식", product: "omo-inbox", branch: "feat/pay", firstRequest: "결제 모듈을 커밋해 줘" });
	await must("POST", `/api/threads/${A}/items`, { kind: "turn", policy: "needs-you", dedupeKey: "turn:split-a:1", raw: { text: "커밋을 두 개로 나눌지 정해 주세요.", request: "결제 모듈을 커밋해 줘" } });
	await must("POST", `/api/threads/${B}/meta`, { title: "README 정리", product: "omo-inbox", branch: "docs", firstRequest: "README를 정리해 줘" });
	await must("POST", `/api/threads/${B}/items`, { kind: "progress", policy: "progress", dedupeKey: "turn:split-b:1", raw: { text: "README 1장을 다시 쓰는 중입니다.", request: "README를 정리해 줘" } });
	await must("POST", `/api/threads/${C}/meta`, { title: "테스트 정리", product: "omo-inbox", branch: "main", firstRequest: "테스트를 정리해 줘" });
	await must("POST", `/api/threads/${C}/items`, { kind: "progress", policy: "progress", dedupeKey: "turn:split-c:1", raw: { text: "테스트 파일 3개를 옮겼습니다.", request: "테스트를 정리해 줘" } });
}

// ---------- browser ----------

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
const server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], { cwd: APP, env: { ...process.env, OMO_INBOX_HOME: home, INBOX_NO_TAILSCALE: "1", INBOX_PUSH_SINK: sink, INBOX_REOPEN_SINK: reopenSink }, stdout: "ignore", stderr: "ignore" });
const view = new Bun.WebView({ width: 1280, height: 800 });
const ev = (expr) => view.evaluate(expr);
const cdp = (m, p) => view.cdp(m, p || {});
const waitFor = (cond, ms, what) =>
	ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
// A navigation or a location.replace ends the document, and an evaluate can't be awaited across that, so the arrival
// is polled from here; the result is the last location seen.
const waitLoc = async (pred, ms) => {
	const t0 = performance.now();
	let last = null;
	while (performance.now() - t0 < ms) {
		try {
			last = await ev("({ path: location.pathname, search: location.search, ready: document.readyState })");
			if (last.ready !== "loading" && pred(last)) return { ok: true, ...last };
		} catch {
			// the old document went away mid-navigation: ask again
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return { ok: false, ...last };
};
const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))");
const touch = (type, points) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points });
const tap = async (x, y) => {
	await touch("touchStart", [{ x, y, id: 0 }]);
	await touch("touchEnd", []);
};
const click = async (x, y) => {
	await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
};
const shot = async (name) => {
	const res = await cdp("Page.captureScreenshot", { format: "png" });
	const file = path.join(OUT, name);
	fs.writeFileSync(file, Buffer.from(res.data, "base64"));
	console.log(`saved ${file}`);
};
const rowRect = (sid) =>
	ev(`(() => { const r = document.querySelector('#list .row[data-session=${JSON.stringify(sid)}]').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const metrics = async (width, height, touchOn) => {
	await cdp("Emulation.setTouchEmulationEnabled", touchOn ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
	await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: touchOn ? 2 : 1, mobile: touchOn });
};
const LIST_READY = "document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#list .row[data-session]').length >= 3";
const FRAME_READY = (sid) =>
	`(() => { const f = document.querySelector('iframe'); if (!f || f.getAttribute('src') !== ${JSON.stringify(`/s/${encodeURIComponent(sid)}`)}) return false; const d = f.contentDocument; const chat = d && d.getElementById('chat'); return Boolean(chat) && chat.getAttribute('aria-busy') === 'false'; })()`;
const SPLIT_STATE = `(() => {
	const frames = [...document.querySelectorAll("iframe")];
	const f = frames[0] || null;
	const fr = f ? f.getBoundingClientRect() : null;
	const page = document.querySelector(".page").getBoundingClientRect();
	const current = [...document.querySelectorAll('#list .row[aria-current="page"]')].map((row) => row.getAttribute("data-session"));
	const rows = [...document.querySelectorAll("#list .row[data-session]")].map((row) => row.getAttribute("data-session"));
	const sel = document.querySelector('#list .row[aria-current="page"]');
	return {
		path: location.pathname,
		search: location.search,
		iframes: frames.length,
		src: f ? f.getAttribute("src") : null,
		frame: fr ? { l: fr.left, r: fr.right, t: fr.top, h: fr.height } : null,
		vw: innerWidth,
		vh: innerHeight,
		left: page.width,
		rows,
		current,
		selBg: sel ? getComputedStyle(sel).backgroundColor : null,
		otherBg: rows.length > 1 ? getComputedStyle(document.querySelector('#list .row[data-session]:not([aria-current])')).backgroundColor : null,
		marker: window.__splitQa === true,
	};
})()`;
const FRAME_INSIDE = `(() => {
	const d = document.querySelector("iframe").contentDocument;
	const back = d.querySelector("a.back");
	const baseEl = d.querySelector("base");
	return { embed: d.documentElement.hasAttribute("data-embed"), back: back ? getComputedStyle(back).display : null, base: baseEl ? baseEl.target : null };
})()`;
// The next /api/threads list response, consumed by the page's own load(): the fetch is wrapped once, and the promise
// settles in the task after the page has parsed (and rendered) that response.
const NEXT_POLL = `new Promise((resolve, reject) => {
	const orig = window.fetch;
	const t = setTimeout(() => { window.fetch = orig; reject(new Error("timeout: list poll")); }, 15000);
	window.fetch = function (input, init) {
		const p = orig.apply(this, arguments);
		const url = String(input);
		if (url === "/api/threads" || url.startsWith("/api/threads?")) {
			window.fetch = orig;
			p.then((res) => {
				const json = res.json.bind(res);
				res.json = () => json().then((data) => { setTimeout(() => { clearTimeout(t); resolve(true); }, 0); return data; });
			});
		}
		return p;
	};
})`;

const openWide = async (pathAndQuery, sid) => {
	await view.navigate("about:blank");
	await view.navigate(`${base}${pathAndQuery}`);
	await waitFor(LIST_READY, 15000, "list ready");
	await waitFor(FRAME_READY(sid), 15000, `iframe ${sid} ready`);
	await settle();
};

// One WIDE viewport: auto-select, pane geometry, a row tap without reload, back, the poll, the embedded page, and
// /s/<sid> as the top window landing on /?s=<sid>.
async function wide(label, width, height, touchOn, shotName, pollText) {
	await view.navigate("about:blank");
	await metrics(width, height, touchOn);
	await openWide("/", A);
	let s = await ev(SPLIT_STATE);
	check(
		`(${label}) / auto-selects the first row: ?s=<first>, that row aria-current="page", iframe src /s/<first>`,
		s.rows[0] === A && s.search === `?s=${A}` && s.current.length === 1 && s.current[0] === A && s.src === `/s/${A}` && s.iframes === 1,
		fmt({ first: s.rows[0], search: s.search, current: s.current, src: s.src, iframes: s.iframes }),
	);
	check(`(${label}) the selected row has its own background`, Boolean(s.selBg) && s.selBg !== s.otherBg, fmt({ selBg: s.selBg, otherBg: s.otherBg }));
	check(`(${label}) the left pane is 340px wide (+-2)`, near(s.left, 340), fmt({ left: s.left }));
	check(
		`(${label}) the iframe fills the rest: right edge == viewport width, height == viewport height (+-2)`,
		Boolean(s.frame) && near(s.frame.r, s.vw) && near(s.frame.h, s.vh) && near(s.frame.t, 0) && near(s.frame.l, s.left),
		fmt({ frame: s.frame, vw: s.vw, vh: s.vh }),
	);
	const inside = await ev(FRAME_INSIDE);
	check(`(${label}) inside the iframe html has data-embed, a.back is not displayed, links target _top`, inside.embed && inside.back === "none" && inside.base === "_top", fmt(inside));
	await shot(shotName);

	await ev("window.__splitQa = true");
	const r = await rowRect(B);
	if (touchOn) await tap(r.cx, r.cy);
	else await click(r.cx, r.cy);
	await waitFor(FRAME_READY(B), 15000, `iframe ${B} ready after the tap`);
	s = await ev(SPLIT_STATE);
	check(
		`(${label}) a tap on another row changes the URL and the iframe src without reloading the top document`,
		s.marker && s.path === "/" && s.search === `?s=${B}` && s.src === `/s/${B}` && s.iframes === 1 && s.current.length === 1 && s.current[0] === B,
		fmt({ marker: s.marker, path: s.path, search: s.search, src: s.src, iframes: s.iframes, current: s.current }),
	);

	await ev("history.back()");
	const back = await waitLoc((l) => l.path === "/" && l.search === `?s=${A}`, 10000);
	let backReady = true;
	try {
		await waitFor(FRAME_READY(A), 15000, `iframe ${A} ready after back`);
	} catch {
		backReady = false;
	}
	s = await ev(SPLIT_STATE);
	check(
		`(${label}) history.back() restores the previous selection (URL, aria-current, iframe src) in the same document`,
		back.ok && backReady && s.marker && s.search === `?s=${A}` && s.src === `/s/${A}` && s.current.length === 1 && s.current[0] === A,
		fmt({ back, backReady, marker: s.marker, search: s.search, src: s.src, current: s.current }),
	);

	// A new line on thread C changes the list, so the next poll really re-renders the rows.
	await must("POST", `/api/threads/${C}/items`, { kind: "progress", policy: "progress", dedupeKey: `turn:split-c:${label}`, raw: { text: pollText, request: "테스트를 정리해 줘" } });
	let polled = true;
	try {
		await ev(NEXT_POLL);
	} catch {
		polled = false;
	}
	s = await ev(SPLIT_STATE);
	const cLine = await ev(`(document.querySelector('#list .row[data-session=${JSON.stringify(C)}]') || {}).textContent || ""`);
	check(
		`(${label}) after the next list poll re-renders the rows, the selection is still marked`,
		polled && cLine.includes(pollText) && s.marker && s.current.length === 1 && s.current[0] === A && s.src === `/s/${A}` && s.search === `?s=${A}`,
		fmt({ polled, rerendered: cLine.includes(pollText), current: s.current, src: s.src, search: s.search }),
	);

	await view.navigate("about:blank");
	await view.navigate(`${base}/s/${encodeURIComponent(C)}`);
	const landed = await waitLoc((l) => l.path === "/" && l.search === `?s=${C}`, 10000);
	let landedReady = true;
	try {
		await waitFor(FRAME_READY(C), 15000, `iframe ${C} ready after the handover`);
	} catch {
		landedReady = false;
	}
	check(`(${label}) /s/<sid> opened as the top window ends at /?s=<sid> with that thread in the iframe`, landed.ok && landedReady, fmt({ landed, landedReady }));
}

let exitError = null;
try {
	await listening;
	await seed();

	// ===== a) phone 390x844 with touch =====
	await view.navigate("about:blank");
	await metrics(390, 844, true);
	await view.navigate(`${base}/`);
	await waitFor(LIST_READY, 15000, "list ready at 390");
	await settle();
	let s = await ev(SPLIT_STATE);
	check("(a) 390: / is the single list with no iframe and no ?s=", s.iframes === 0 && s.search === "" && s.current.length === 0, fmt({ iframes: s.iframes, search: s.search, current: s.current }));
	await shot("split-390.png");
	const r = await rowRect(A);
	await tap(r.cx, r.cy);
	const went = await waitLoc((l) => l.path === `/s/${A}`, 10000);
	check("(a) 390: a row tap navigates the top window to /s/<sid>", went.ok, fmt(went));
	let backLink = null;
	try {
		await waitFor("document.getElementById('chat') && document.getElementById('chat').getAttribute('aria-busy') === 'false'", 15000, "thread ready at 390");
		backLink = await ev(`(() => { const b = document.querySelector("a.back"); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), display: getComputedStyle(b).display, w: r.width, h: r.height, embed: document.documentElement.hasAttribute("data-embed"), top: window.top === window.self }; })()`);
	} catch (error) {
		backLink = { error: String(error) };
	}
	check(
		"(a) 390: the thread page shows a visible ‹ Inbox and is not embedded",
		Boolean(backLink) && typeof backLink.text === "string" && backLink.text.includes("Inbox") && backLink.text.includes("‹") && backLink.display !== "none" && backLink.w > 0 && backLink.h > 0 && !backLink.embed && backLink.top,
		fmt(backLink),
	);
	await view.navigate("about:blank");
	await view.navigate(`${base}/?s=${encodeURIComponent(B)}`);
	const replaced = await waitLoc((l) => l.path === `/s/${B}`, 10000);
	check("(a) 390: /?s=<sid> replaces itself with /s/<sid>", replaced.ok, fmt(replaced));

	// ===== b) unfolded Fold 840x1000 with touch, desktop 1280x800 with a mouse =====
	await wide("b 840", 840, 1000, true, "split-840.png", `${POLL_TEXT} 840`);
	await wide("b 1280", 1280, 800, false, "split-1280.png", `${POLL_TEXT} 1280`);

	// ===== e) the dark scheme at 1280 =====
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await openWide(`/?s=${encodeURIComponent(A)}`, A);
	const darkState = await ev(`(() => { const d = document.querySelector("iframe").contentDocument; return { top: matchMedia("(prefers-color-scheme: dark)").matches, frame: d.defaultView.matchMedia("(prefers-color-scheme: dark)").matches, bg: getComputedStyle(document.body).backgroundColor, frameBg: getComputedStyle(d.body).backgroundColor }; })()`);
	check("(e) 1280 dark: the list and the embedded thread both render the dark scheme", darkState.top && darkState.frame, fmt(darkState));
	await shot("split-1280-dark.png");
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

	// ===== c) 1280 -> 390 with a selection =====
	await openWide(`/?s=${encodeURIComponent(B)}`, B);
	await metrics(390, 844, true);
	const shrank = await waitLoc((l) => l.path === `/s/${B}`, 10000);
	check("(c) a resize 1280 -> 390 with ?s=<sid> ends the top window at /s/<sid>", shrank.ok, fmt(shrank));

	// ===== d) the CSP header =====
	for (const route of ["/", `/s/${encodeURIComponent(A)}`]) {
		const res = await fetch(base + route);
		await res.arrayBuffer();
		const csp = res.headers.get("content-security-policy") || "";
		const xfo = res.headers.get("x-frame-options");
		check(`(d) ${route}: the CSP says frame-ancestors 'self' (and no X-Frame-Options DENY)`, res.status === 200 && csp.includes("frame-ancestors 'self'") && !csp.includes("frame-ancestors 'none'") && (xfo === null || xfo.toUpperCase() === "SAMEORIGIN"), fmt({ status: res.status, csp, xfo }));
	}
} catch (error) {
	exitError = error;
	check("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	try {
		await view.close();
	} catch {
		// already gone
	}
	server.kill();
	await server.exited;
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`cleanup: server stopped, browser closed, temp removed ${!fs.existsSync(tmp)}; output in ${OUT}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed || exitError ? 1 : 0);
