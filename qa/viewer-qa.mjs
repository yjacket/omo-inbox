/* Real-browser QA for the omo-inbox frame viewer (web/board.js + web/proposal.html): 표시하기, the comment sheet, pinch/pan,
 * the .mmd frame, and a feedback send (the page leaves for the inbox, so (j) comes back to the proposal).
 *
 * Usage: bun qa/viewer-qa.mjs [--app <repo>, default the repo] [--port 4392] [--save <dir>, default a new temp dir]
 * Starts <app>/src/server.mjs on a temp OMO_INBOX_HOME, submits a board (wide PNG frame + wide flowchart LR .mmd frame),
 * then drives one Bun.WebView: phone pass (390x844, touch) and desktop pass (1440x900, mouse). Exit 0 only when every check passes.
 * The temp dir is deleted at the end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
	const i = args.indexOf(flag);
	return i === -1 ? fallback : args[i + 1];
};
const APP = path.resolve(opt("--app", path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
const PORT = Number(opt("--port", "4392"));
const SAVE = opt("--save", null) ?? fs.mkdtempSync(path.join(os.tmpdir(), "inbox-qa-viewer-"));
const POST_HEADERS = { "content-type": "application/json", "x-inbox": "1" };
const PNG_LABEL = "화면 스크린샷";
const MMD_LABEL = "흐름 도식";
const TOL = 0.02;

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const near = (a, b) => Math.abs(a - b) <= TOL;
const fmt = (o) => JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v));

/** Runs in the page: a screenshot-like wide frame with clear regions to look at when zoomed. */
function drawFrame(w, h) {
	const c = document.createElement("canvas");
	c.width = w;
	c.height = h;
	const g = c.getContext("2d");
	g.fillStyle = "#f4f6fa";
	g.fillRect(0, 0, w, h);
	g.fillStyle = "#1f2a44";
	g.fillRect(0, 0, w, 90);
	g.fillStyle = "#fff";
	g.font = "bold 48px sans-serif";
	g.fillText(`Wide screenshot ${w}x${h}`, 40, 62);
	for (let i = 0; i < 6; i++) {
		const x = 40 + i * 390;
		g.fillStyle = "#fff";
		g.fillRect(x, 140, 350, 700);
		g.fillStyle = `hsl(${i * 55}, 65%, 55%)`;
		g.fillRect(x + 20, 160, 310, 160);
		g.fillStyle = "#1f2a44";
		g.font = "bold 34px sans-serif";
		g.fillText(`Panel ${i + 1}`, x + 24, 380);
		g.font = "26px sans-serif";
		g.fillStyle = "#4a556b";
		for (let l = 0; l < 8; l++) g.fillText(`Row ${l + 1} lorem ipsum`, x + 24, 430 + l * 48);
	}
	return c.toDataURL("image/png");
}

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-qa-viewer-"));
	const home = path.join(tmp, "home");
	const srcDir = path.join(tmp, "board");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(srcDir, { recursive: true });
	fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));
	console.log(`app: ${APP}\ntemp: ${tmp}\nport: ${PORT}\nsave: ${SAVE}`);
	fs.mkdirSync(SAVE, { recursive: true });

	const base = `http://127.0.0.1:${PORT}`;
	const view = new Bun.WebView({ width: 1440, height: 900 });
	let server = null;
	const cdp = (method, params) => view.cdp(method, params || {});
	const ev = (expr) => view.evaluate(expr);
	const waitFor = (cond, ms = 15000, what = cond) =>
		ev(
			`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify("timeout: " + what)})); else setTimeout(tick, 25); }; tick(); })`,
		);
	// resolves once the page has stopped scrolling (a swipe leaves a fling that would move a frame out from under the next tap)
	const stable = () => ev("new Promise((resolve) => { let last = -1; let n = 0; const f = () => { if (scrollY === last) { if (++n >= 12) return resolve(true); } else { n = 0; last = scrollY; } requestAnimationFrame(f); }; f(); })");
	const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))");
	const touch = (type, points) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points });
	const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, ...extra });
	const shot = async (name) => {
		const res = await cdp("Page.captureScreenshot", { format: "png" });
		const file = path.join(SAVE, name);
		fs.writeFileSync(file, Buffer.from(res.data, "base64"));
		console.log(`saved ${file}`);
	};
	const V = () => ev("(() => { const v = window.__vb.viewer; return { open: v.open, label: v.label, scale: v.scale, tx: v.tx, ty: v.ty, drawing: v.drawing, selected: Boolean(v.selected), marks: window.__vb.marks.length }; })()");
	const geom = () =>
		ev("(() => { const i = document.getElementById('vImg').getBoundingClientRect(); const s = document.getElementById('vStage').getBoundingClientRect(); return { img: { l: i.left, t: i.top, w: i.width, h: i.height }, stage: { l: s.left, t: s.top, w: s.width, h: s.height } }; })()");
	const rectOf = (selector) =>
		ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
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

	// A finger that rests before lifting leaves no velocity, so Chromium starts no fling; a fling would swallow the next tap's click.
	const rest = () => new Promise((resolve) => setTimeout(resolve, 150));
	// one-finger helpers
	async function tap(x, y) {
		await touch("touchStart", [{ x, y, id: 0 }]);
		await touch("touchEnd", []);
		await settle();
	}
	async function drag(x0, y0, x1, y1, steps = 8) {
		await touch("touchStart", [{ x: x0, y: y0, id: 0 }]);
		for (let i = 1; i <= steps; i++) await touch("touchMove", [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, id: 0 }]);
		await rest();
		await touch("touchEnd", []);
		await settle();
	}
	async function pinch(cx, cy, d0, d1, steps = 8) {
		const pts = (d) => [
			{ x: cx - d, y: cy, id: 0 },
			{ x: cx + d, y: cy, id: 1 },
		];
		await touch("touchStart", pts(d0));
		for (let i = 1; i <= steps; i++) await touch("touchMove", pts(d0 + ((d1 - d0) * i) / steps));
		await rest();
		await touch("touchEnd", []);
		await settle();
	}
	/** Screen points for a box given as fractions of the visible part of the picture. */
	async function visibleBox(fx0, fx1, fy0, fy1) {
		const g = await geom();
		const u0 = Math.max(0, (g.stage.l - g.img.l) / g.img.w);
		const u1 = Math.min(1, (g.stage.l + g.stage.w - g.img.l) / g.img.w);
		const v0 = Math.max(0, (g.stage.t - g.img.t) / g.img.h);
		const v1 = Math.min(1, (g.stage.t + g.stage.h - g.img.t) / g.img.h);
		const nx0 = u0 + (u1 - u0) * fx0;
		const nx1 = u0 + (u1 - u0) * fx1;
		const ny0 = v0 + (v1 - v0) * fy0;
		const ny1 = v0 + (v1 - v0) * fy1;
		return {
			norm: { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 },
			from: { x: g.img.l + nx0 * g.img.w, y: g.img.t + ny0 * g.img.h },
			to: { x: g.img.l + nx1 * g.img.w, y: g.img.t + ny1 * g.img.h },
		};
	}
	const markMatches = (mark, norm) => near(mark.x, norm.x) && near(mark.y, norm.y) && near(mark.w, norm.w) && near(mark.h, norm.h);
	const lastMark = () => ev("(() => { const m = window.__vb.marks[window.__vb.marks.length - 1]; return m ? { frame: m.frame, rev: m.rev, x: m.x, y: m.y, w: m.w, h: m.h, comment: m.comment, hasImg: m.img instanceof HTMLImageElement } : null; })()");

	try {
		await view.navigate("about:blank");
		await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

		// the board
		const dataUrl = await ev(`(${drawFrame.toString()})(2400, 900)`);
		fs.writeFileSync(path.join(srcDir, "shot.png"), Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
		fs.writeFileSync(path.join(srcDir, "flow.mmd"), "flowchart LR\n  A[입력] --> B[검사] --> C[변환] --> D[저장] --> E[알림] --> F[확인] --> G[완료] --> H[정리] --> I[보고] --> J[끝]\n");
		fs.writeFileSync(
			path.join(srcDir, "board.json"),
			JSON.stringify({
				title: "viewer qa",
				sections: [
					{
						title: "화면",
						cards: [
							{ title: "넓은 스크린샷", layout: "one", frames: [[PNG_LABEL, "shot.png"]] },
							{ title: "흐름", layout: "one", diagram: true, frames: [[MMD_LABEL, "flow.mmd"]] },
						],
					},
				],
			}),
		);

		const listening = new Promise((resolve, reject) => {
			const signal = AbortSignal.timeout(15000);
			const watcher = fs.watch(home, (_e, file) => {
				if (file === "server.json" && fs.existsSync(path.join(home, "server.json"))) {
					watcher.close();
					resolve();
				}
			});
			signal.addEventListener("abort", () => {
				watcher.close();
				reject(new Error("server.json did not appear"));
			});
		});
		server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], {
			cwd: APP,
			env: { ...process.env, OMO_INBOX_HOME: home },
			stdout: "pipe",
			stderr: "pipe",
		});
		await listening;
		const health = await (await fetch(`${base}/api/health`)).json();
		console.log(`server up: ${fmt(health)} (spawned pid ${server.pid})`);
		// Safety: every POST below must hit the server this script started on its temp home, never the live one.
		if (health.port !== PORT || health.pid !== server.pid) throw new Error(`not our server on ${PORT}: ${fmt(health)}, spawned pid ${server.pid}`);
		const created = await fetch(`${base}/api/proposals`, { method: "POST", headers: POST_HEADERS, body: JSON.stringify({ cwd: srcDir, srcDir, title: "viewer qa" }) });
		const createdBody = await created.json();
		const id = createdBody.summary && createdBody.summary.id;
		if (!id) throw new Error(`submit failed: ${created.status} ${JSON.stringify(createdBody)}`);
		console.log(`proposal ${id}`);

		// ===== phone pass =====
		await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
		await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await view.navigate(`${base}/p/${encodeURIComponent(id)}`);
		await waitFor("document.querySelectorAll('.frame canvas').length === 2 && [...document.querySelectorAll('.frame canvas')].every((c) => c.width > 0)", 40000, "both frames sized");
		const pageInfo = await ev("({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, wide: [...document.querySelectorAll('.frame')].map((f) => f.className) })");
		console.log(`phone page: ${fmt(pageInfo)}`);
		check("phone viewport is 390 wide and the .mmd frame is a wide diagram", pageInfo.w === 390 && pageInfo.wide.some((c) => c.includes("diagram") && c.includes("wide")), fmt(pageInfo));

		const legend = await ev("[...document.querySelectorAll('.legend span')].map((s) => s.textContent)");
		check("(polish) legend keeps only the red-line entry", legend.length === 1 && legend[0] === "빨간 실선: 바뀐 곳", fmt(legend));

		// (a) finger swipe over the inline frame scrolls the page, draws nothing
		const pngTop = await ev("(() => { const f = document.querySelector('.frame'); return f.getBoundingClientRect().top + scrollY; })()");
		await ev(`window.scrollTo(0, ${Math.max(0, pngTop - 420)})`);
		await settle();
		const y0 = await ev("scrollY");
		const fr = await rectOf(".frame");
		await drag(fr.cx, fr.cy, fr.cx, fr.cy - 220, 10);
		await waitFor(`scrollY > ${y0} + 40`, 4000, "page scrolled").catch(() => {});
		await stable();
		const a = await ev("({ y: scrollY, marks: window.__vb.marks.length, open: window.__vb.viewer.open })");
		check("(a) swipe over an inline frame scrolls the page and creates no mark", a.y > y0 + 40 && a.marks === 0 && !a.open, `scrollY ${y0} -> ${a.y}, marks ${a.marks}, viewer open ${a.open}`);

		// (b) tap opens the viewer
		await ev(`window.scrollTo(0, ${Math.max(0, pngTop - 420)})`);
		await stable();
		const histBefore = await ev("({ len: history.length, href: location.href })");
		const fr2 = await rectOf(".frame");
		await tap(fr2.cx, fr2.cy);
		await waitFor("window.__vb.viewer.open", 4000, "viewer open").catch(() => {});
		const b = await ev(
			"(() => { const d = document.getElementById('viewer'); return { open: window.__vb.viewer.open, hidden: d.hidden, role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), label: document.getElementById('vLabel').textContent, bodyLocked: getComputedStyle(document.body).overflow, histState: history.state, histLen: history.length, draw: document.getElementById('vDraw').getAttribute('aria-pressed'), imgSrc: document.getElementById('vImg').src.slice(-12), marks: window.__vb.marks.length }; })()",
		);
		check("(b) a tap opens the viewer (dialog, aria-modal, label, body locked, one history entry)", b.open && !b.hidden && b.role === "dialog" && b.modal === "true" && b.label === PNG_LABEL && b.bodyLocked === "hidden" && b.histState && b.histState.vbViewer && b.histLen === histBefore.len + 1 && b.marks === 0, fmt(b));
		await shot("viewer-390-fit.png");
		const s1 = await V();
		const ov1 = await ev("({ doc: document.documentElement.scrollWidth, viewer: document.getElementById('viewer').scrollWidth, inner: innerWidth })");

		// (c) pinch
		const st = await rectOf("#vStage");
		await pinch(st.cx, st.cy, 25, 100);
		const s2 = await V();
		check("(c) a two-finger pinch increases the scale", s1.scale === 1 && s2.scale > 1.5 && s2.scale <= 8 && s2.marks === 0, `scale ${s1.scale} -> ${s2.scale}`);

		// (d) one-finger drag with drawing off pans, no mark
		const g2 = await geom();
		await drag(st.cx + 60, st.cy, st.cx - 80, st.cy, 8);
		const s3 = await V();
		const g3 = await geom();
		check("(d) one-finger drag with drawing off pans and creates no mark", Math.abs(g3.img.l - g2.img.l) > 40 && s3.marks === 0 && !s3.drawing, `img.left ${Math.round(g2.img.l)} -> ${Math.round(g3.img.l)}, marks ${s3.marks}`);
		await shot("viewer-390-zoomed-drawing-off.png");

		// (e) drawing on: a drag creates one mark matching the dragged region, zoomed in and at fit
		const dr = await rectOf("#vDraw");
		if (args.includes("--debug")) await ev("(() => { window.__log = []; for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'click']) document.addEventListener(t, (e) => window.__log.push(t + ':' + (e.pointerId ?? '') + ':' + (e.target.id || e.target.tagName)), true); })()");
		await tap(dr.cx, dr.cy);
		if (args.includes("--debug")) console.log(`debug after tapping draw: rect ${fmt(dr)} log ${await ev("JSON.stringify(window.__log)")}`);
		const s4 = await V();
		const box1 = await visibleBox(0.25, 0.75, 0.3, 0.7);
		await drag(box1.from.x, box1.from.y, box1.to.x, box1.to.y, 8);
		const m1 = await lastMark();
		const s5 = await V();
		if (args.includes("--debug")) console.log(`debug after drag: ${fmt({ s4, s5, box1 })} log ${await ev("JSON.stringify(window.__log)")}`);
		const e1 = s4.drawing && s5.marks === 1 && m1 && markMatches(m1, box1.norm) && m1.frame === PNG_LABEL && m1.rev === 1 && m1.comment === "" && m1.hasImg;
		check("(e) drawing on, a drag zoomed in creates one mark matching the dragged region (+-2%)", Boolean(e1), `want ${fmt(box1.norm)} got ${fmt(m1)} scale ${s5.scale}`);
		const sh1 = await ev("(() => { const s = document.getElementById('vSheet'); const d = document.getElementById('vDraw'); return { sheet: !s.hidden, num: document.getElementById('vNum').textContent, note: document.getElementById('vNote').value, pressed: d.getAttribute('aria-pressed'), label: d.textContent }; })()");
		check("(polish) the button reads 표시하기, turns off after one box, and the new box's sheet shows its number", sh1.label === "표시하기" && !s5.drawing && sh1.pressed === "false" && s5.selected && sh1.sheet && sh1.num === "1" && sh1.note === "", fmt({ sh1, drawing: s5.drawing }));
		// back to fit with a pinch-in, then a second mark
		const st2 = await rectOf("#vStage");
		await pinch(st2.cx, st2.cy, 110, 18, 10);
		const s6 = await V();
		const dr2 = await rectOf("#vDraw");
		await tap(dr2.cx, dr2.cy);
		const box2 = await visibleBox(0.35, 0.6, 0.2, 0.8);
		await drag(box2.from.x, box2.from.y, box2.to.x, box2.to.y, 8);
		const m2 = await lastMark();
		const s7 = await V();
		check("(e) a drag at fit scale also matches (+-2%), two marks now", s6.scale < 1.2 && s7.marks === 2 && m2 && markMatches(m2, box2.norm), `scale ${s6.scale}, want ${fmt(box2.norm)} got ${fmt(m2)}`);
		// (polish) write the comment in the viewer: it lands on the mark and in the bottom list
		const NOTE = "버튼 위치";
		const nt = await rectOf("#vNote");
		await tap(nt.cx, nt.cy);
		await cdp("Input.insertText", { text: NOTE });
		await settle();
		const cm = await ev("(() => { const m = window.__vb.marks[window.__vb.marks.length - 1]; const list = [...document.querySelectorAll('#marks .mark textarea')].map((t) => t.value); return { comment: m.comment, list, focused: document.activeElement && document.activeElement.id, num: document.getElementById('vNum').textContent }; })()");
		check("(polish) a comment typed in the viewer sheet is the mark's comment and shows in the bottom list", cm.comment === NOTE && cm.list[1] === NOTE && cm.num === "2", fmt(cm));
		await shot("viewer-390-sheet.png");
		const del = await ev("(() => { const b = document.getElementById('vDel'); const r = b.getBoundingClientRect(); return { hidden: b.hidden, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: b.textContent }; })()");

		// (f) tap outside: the sheet goes away; tap the first box: its own (empty) comment; 지우기 in the sheet removes it
		const listBefore = await ev("document.querySelectorAll('#marks .mark').length");
		const g7 = await geom();
		await tap(g7.stage.l + 12, g7.stage.t + 12);
		const off = await ev("({ sheet: !document.getElementById('vSheet').hidden, selected: Boolean(window.__vb.viewer.selected) })");
		const first = await ev("(() => { const m = window.__vb.marks[0]; return { x: m.x, y: m.y, w: m.w, h: m.h }; })()");
		await tap(g7.img.l + (first.x + first.w / 2) * g7.img.w, g7.img.t + (first.y + first.h / 2) * g7.img.h);
		const sel = await V();
		const del2 = await ev("(() => { const b = document.getElementById('vDel'); const r = b.getBoundingClientRect(); return { sheet: !document.getElementById('vSheet').hidden, num: document.getElementById('vNum').textContent, note: document.getElementById('vNote').value, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: b.textContent }; })()");
		const placedOk = del2.sheet && del2.num === "1" && del2.note === "" && del2.h >= 40 && del2.w >= 40 && del2.text === "지우기";
		if (del2.sheet) await tap(del2.cx, del2.cy);
		const after = await ev("({ marks: window.__vb.marks.length, list: document.querySelectorAll('#marks .mark').length, open: window.__vb.viewer.open, sheetHidden: document.getElementById('vSheet').hidden, kept: window.__vb.marks.map((m) => m.comment) })");
		check("(f) tap outside hides the sheet; tap a box, press 지우기 in the sheet: gone from state and list, the other box keeps its comment", !off.sheet && !off.selected && sel.selected && placedOk && listBefore === 2 && after.marks === 1 && after.list === 1 && after.sheetHidden && after.open && after.kept[0] === NOTE, `off ${fmt(off)}, sheet ${fmt(del2)}, list ${listBefore} -> ${after.list}, kept ${fmt(after.kept)}`);
		void del;

		// (g) back closes the viewer, page stays on the same proposal
		const marksKept = await ev("window.__vb.marks.length");
		await ev("history.back()");
		await waitFor("!window.__vb.viewer.open", 4000, "viewer closed by back").catch(() => {});
		const g = await ev("({ open: window.__vb.viewer.open, hidden: document.getElementById('viewer').hidden, path: location.pathname, locked: document.body.classList.contains('viewer-open'), id: window.__vb.id, marks: window.__vb.marks.length, inert: document.querySelector('main').inert })");
		check("(g) history.back() closes the viewer; same proposal, body unlocked, marks kept", !g.open && g.hidden && g.path === `/p/${id}` && g.id === id && !g.locked && !g.inert && g.marks === marksKept, fmt(g));

		// (h) the .mmd frame opens and accepts a drawn mark
		await ev("document.querySelector('.frame.diagram').scrollIntoView({ block: 'center' })");
		await stable();
		const fd = await rectOf(".frame.diagram");
		await tap(fd.cx, fd.cy);
		await waitFor("window.__vb.viewer.open", 4000, "mmd viewer open").catch(() => {});
		const h0 = await V();
		const drh = await rectOf("#vDraw");
		await tap(drh.cx, drh.cy);
		const boxH = await visibleBox(0.3, 0.6, 0.15, 0.85);
		await drag(boxH.from.x, boxH.from.y, boxH.to.x, boxH.to.y, 8);
		const mh = await lastMark();
		const h1 = await V();
		await shot("viewer-390-mmd.png");
		check("(h) the .mmd frame opens and accepts a drawn mark", h0.open && h0.label === MMD_LABEL && h1.marks === 2 && mh && mh.frame === MMD_LABEL && markMatches(mh, boxH.norm), `label ${h0.label}, want ${fmt(boxH.norm)} got ${fmt(mh)}`);
		const ov2 = await ev("({ doc: document.documentElement.scrollWidth, viewer: document.getElementById('viewer').scrollWidth, inner: innerWidth })");
		// close with the button: one history entry gone, same page
		const hb = await ev("history.length");
		const clr = await rectOf("#vClose");
		await tap(clr.cx, clr.cy);
		await waitFor("!window.__vb.viewer.open", 4000, "closed by button").catch(() => {});
		await settle();
		const hc = await ev("({ open: window.__vb.viewer.open, path: location.pathname, state: history.state, len: history.length })");
		console.log(`close button: history ${hb} -> ${fmt(hc)}`);
		const ov3 = await ev("({ doc: document.documentElement.scrollWidth, inner: innerWidth })");

		// (i) no horizontal overflow at 390
		check("(i) no horizontal overflow at 390 (page, viewer open, viewer with mmd, closed)", [ov1.doc, ov1.viewer, ov2.doc, ov2.viewer, ov3.doc].every((w) => w <= 390), `${fmt({ ov1, ov2, ov3 })}`);

		// (j) feedback with viewer-drawn marks stores crop files; round3: a sent page leaves for the inbox
		await ev("document.getElementById('sendBtn').scrollIntoView({ block: 'center' })");
		const marksBeforeSend = await ev("window.__vb.marks.length");
		await ev("document.getElementById('sendBtn').click()");
		const atInbox = await waitPath("/", 30000);
		const stored = await (await fetch(`${base}/api/p/${encodeURIComponent(id)}`)).json();
		const feedbacks = (stored.events || []).filter((e) => e.type === "feedback");
		const feedback = feedbacks[0];
		const crops = ((feedback && feedback.marks) || []).map((m) => m.crop).filter(Boolean);
		const files = crops.map((rel) => {
			const file = path.join(home, "data", "proposals", id, rel);
			if (!fs.existsSync(file)) return { rel, ok: false };
			const buf = fs.readFileSync(file);
			return { rel, ok: buf.length > 500 && buf.readUInt32BE(0) === 0x89504e47, bytes: buf.length, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
		});
		check("(j) feedback with viewer-drawn marks stores crop files, one feedback event, and the page leaves for the inbox", atInbox && feedbacks.length === 1 && marksBeforeSend === 2 && crops.length === 2 && files.every((f) => f.ok), `inbox ${atInbox}, feedback events ${feedbacks.length}, ${fmt(files)}`);
		const fbComments = ((feedback && feedback.marks) || []).map((m) => m.comment);
		// back to the proposal for the thread checks (a fresh navigation: re-apply the phone emulation)
		await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
		await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await view.navigate(`${base}/p/${encodeURIComponent(id)}`);
		await waitFor("document.querySelectorAll('.frame canvas').length === 2 && [...document.querySelectorAll('.frame canvas')].every((c) => c.width > 0)", 40000, "frames sized after coming back");
		await waitFor("document.querySelector('#thread .ev.feedback')", 15000, "feedback in thread").catch(() => {});
		const verdictTags = await ev("document.querySelectorAll('#thread .ev.feedback .verdict').length");
		check("(polish) the viewer comment is sent with its box, and 의견 보내기 shows no verdict tag in the conversation", fbComments.includes(NOTE) && feedback.verdict === "change" && verdictTags === 0, fmt({ fbComments, verdict: feedback && feedback.verdict, verdictTags }));

		// ===== read-only revision: viewer opens, no draw toggle =====
		const revised = await fetch(`${base}/api/p/${encodeURIComponent(id)}/revise`, { method: "POST", headers: POST_HEADERS, body: JSON.stringify({ cwd: srcDir, srcDir, note: "r2" }) });
		console.log(`revise status ${revised.status}`);
		if (revised.ok) {
			// Stay on the touch-emulated document (a fresh navigation drops the emulation): wait for the 2안 tab, then go 2안 -> 1안.
			await waitFor("document.querySelectorAll('#tabs button').length === 2", 20000, "2안 tab");
			await ev("document.querySelectorAll('#tabs button')[1].click()");
			await waitFor("window.__vb.rev === 2 && document.querySelectorAll('.frame canvas').length === 2 && [...document.querySelectorAll('.frame canvas')].every((c) => c.width > 0)", 30000, "rev 2 rendered");
			await ev("document.querySelectorAll('#tabs button')[0].click()");
			await waitFor("window.__vb.rev === 1 && document.body.classList.contains('readonly') && document.querySelectorAll('.frame canvas').length === 2 && [...document.querySelectorAll('.frame canvas')].every((c) => c.width > 0)", 30000, "readonly page");
			await ev("document.querySelector('.frame').scrollIntoView({ block: 'center' })");
			await stable();
			const rf = await rectOf(".frame");
			if (args.includes("--debug")) await ev("(() => { window.__log = []; for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click', 'scroll']) document.addEventListener(t, (e) => window.__log.push(Math.round(e.timeStamp) + ' ' + t + ':' + (e.pointerId ?? '') + ':' + (e.target.id || e.target.tagName)), true); window.__log.push('installed ' + Math.round(performance.now()) + ' open=' + window.__vb.viewer.open + ' scrollY=' + scrollY); })()");
			await tap(rf.cx, rf.cy);
			if (args.includes("--debug")) console.log(`debug readonly: rect ${fmt(rf)} hit ${await ev(`(() => { const e = document.elementFromPoint(${rf.cx}, ${rf.cy}); return e ? e.tagName + '.' + e.className : null; })()`)} log ${await ev("JSON.stringify(window.__log)")}`);
			await waitFor("window.__vb.viewer.open", 4000, "readonly viewer").catch(() => {});
			const ro = await ev("({ open: window.__vb.viewer.open, drawHidden: document.getElementById('vDraw').hidden, delHidden: document.getElementById('vSheet').hidden })");
			check("(extra) a past revision still opens the viewer, without draw toggle or delete", ro.open && ro.drawHidden && ro.delHidden, fmt(ro));
			await ev("history.back()");
			await waitFor("!window.__vb.viewer.open", 4000, "closed").catch(() => {});
		} else {
			check("(extra) revise API for the read-only case", false, `status ${revised.status}`);
		}

		// ===== desktop pass =====
		await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
		await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
		await view.navigate(`${base}/p/${encodeURIComponent(id)}?rev=2`);
		await waitFor("document.querySelectorAll('.frame canvas').length === 2 && [...document.querySelectorAll('.frame canvas')].every((c) => c.width > 0)", 40000, "desktop frames sized");
		await ev("document.querySelector('.frame').scrollIntoView({ block: 'center' })");
		await settle();
		const dc = await rectOf(".frame canvas");
		const x0 = dc.l + dc.w * 0.2;
		const y0d = dc.t + dc.h * 0.2;
		const x1 = dc.l + dc.w * 0.45;
		const y1 = dc.t + dc.h * 0.7;
		await mouse("mouseMoved", x0, y0d);
		await mouse("mousePressed", x0, y0d, { button: "left", buttons: 1, clickCount: 1 });
		await mouse("mouseMoved", (x0 + x1) / 2, (y0d + y1) / 2, { button: "left", buttons: 1 });
		await mouse("mouseMoved", x1, y1, { button: "left", buttons: 1 });
		await mouse("mouseReleased", x1, y1, { button: "left", buttons: 0, clickCount: 1 });
		await settle();
		const k = await ev("({ marks: window.__vb.marks.length, open: window.__vb.viewer.open })");
		const mk = await lastMark();
		check("(k) PC: inline mouse drag still creates a mark (no viewer)", k.marks === 1 && !k.open && mk && near(mk.x, 0.2) && near(mk.y, 0.2) && near(mk.w, 0.25) && near(mk.h, 0.5), `${fmt(k)} ${fmt(mk)}`);

		// (l) click opens the viewer
		const cx = dc.cx;
		const cy = dc.t + dc.h * 0.9;
		await mouse("mouseMoved", cx, cy);
		await mouse("mousePressed", cx, cy, { button: "left", buttons: 1, clickCount: 1 });
		await mouse("mouseReleased", cx, cy, { button: "left", buttons: 0, clickCount: 1 });
		await waitFor("window.__vb.viewer.open", 4000, "viewer open by click").catch(() => {});
		const l = await V();
		check("(l) PC: a click opens the viewer, and still only one mark", l.open && l.label === PNG_LABEL && l.marks === 1, fmt(l));

		// (m) wheel zooms around the cursor
		const gm0 = await geom();
		const wx = gm0.stage.l + gm0.stage.w * 0.62;
		const wy = gm0.stage.t + gm0.stage.h * 0.45;
		const under = (g) => ({ u: (wx - g.img.l) / g.img.w, v: (wy - g.img.t) / g.img.h });
		const p0 = under(gm0);
		await mouse("mouseMoved", wx, wy);
		await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: wx, y: wy, deltaX: 0, deltaY: -500 });
		await settle();
		const sm = await V();
		const gm1 = await geom();
		const p1 = under(gm1);
		check("(m) PC: mouse wheel zooms in around the cursor", sm.scale > 1.5 && sm.scale <= 8 && Math.abs(p1.u - p0.u) < 0.01 && Math.abs(p1.v - p0.v) < 0.01, `scale ${sm.scale}, point under cursor ${fmt(p0)} -> ${fmt(p1)}`);

		// draw once in the viewer with the mouse for the 1440 screenshot
		await ev("document.getElementById('vDraw').click()");
		const boxD = await visibleBox(0.3, 0.7, 0.3, 0.7);
		await mouse("mouseMoved", boxD.from.x, boxD.from.y);
		await mouse("mousePressed", boxD.from.x, boxD.from.y, { button: "left", buttons: 1, clickCount: 1 });
		await mouse("mouseMoved", (boxD.from.x + boxD.to.x) / 2, (boxD.from.y + boxD.to.y) / 2, { button: "left", buttons: 1 });
		await mouse("mouseMoved", boxD.to.x, boxD.to.y, { button: "left", buttons: 1 });
		await mouse("mouseReleased", boxD.to.x, boxD.to.y, { button: "left", buttons: 0, clickCount: 1 });
		await settle();
		const md = await lastMark();
		check("(extra) PC: mouse drag in the viewer with drawing on creates a mark (+-2%)", md && markMatches(md, boxD.norm), `want ${fmt(boxD.norm)} got ${fmt(md)}`);
		const focusD = await ev("({ focused: document.activeElement && document.activeElement.id, sheet: !document.getElementById('vSheet').hidden, drawing: window.__vb.viewer.drawing })");
		check("(polish) PC: after a mouse-drawn box the comment field has focus", focusD.focused === "vNote" && focusD.sheet && !focusD.drawing, fmt(focusD));
		await cdp("Input.insertText", { text: "여백" });
		await settle();
		await shot("viewer-1440.png");

		// (n) Esc closes
		await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await waitFor("!window.__vb.viewer.open", 4000, "closed by Esc").catch(() => {});
		await settle();
		const n = await ev("({ open: window.__vb.viewer.open, hidden: document.getElementById('viewer').hidden, locked: document.body.classList.contains('viewer-open'), path: location.pathname + location.search })");
		check("(n) PC: Esc closes the viewer", !n.open && n.hidden && !n.locked, fmt(n));
	} finally {
		let serverNote = "no server";
		if (server) {
			server.kill();
			await server.exited;
			serverNote = `server pid ${server.pid} stopped`;
		}
		await view.close();
		fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		console.log(`cleanup: ${serverNote}; browser closed; deleted ${tmp} (still exists: ${fs.existsSync(tmp)})`);
	}
}

try {
	await main();
} catch (error) {
	check("run completed", false, error && error.stack ? error.stack : String(error));
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
