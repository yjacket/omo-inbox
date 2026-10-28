/* Real-browser QA for the report inspector: the header 제보 anchor, the cross-document overlay, picking in the split
 * view's iframe, the phone touch path, the Review viewer's pick mode and wheel firewall, the bubble footer entry,
 * the /issues list entry, and the composer draft.
 *
 * Usage: bun qa/report-pick-qa.mjs [app dir, default the repo] [output dir, default a new temp dir]
 * Starts the isolated fake GitHub and inbox server from qa/report-fixture.mjs (port 4403, temp home, synthetic token),
 * seeds two threads (one with a live question), and one Review with a PNG frame. One Bun.WebView drives the checks
 * through CDP: desktop 1280x800 with a mouse, phone 390x844 with touch. Exit 0 only when every check passes; the last
 * line is `N/N checks passed`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { framePng } from "./frame.mjs";
import { seedBoard, seedThread, startFakeGitHub, startInboxServer } from "./report-fixture.mjs";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = 4403;
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "report-pick-qa-out-"));
const SCRATCH = "C:/Windows/Temp/ulw-inspector-ktUlUR/task25";
const A = "qa-pick-a";
const B = "qa-pick-b";
const REPORT_TEXT = "inspector desktop report";

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (o) => JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));
const near = (a, b) => typeof a === "number" && Math.abs(a - b) <= 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(fn, ms, what) {
	const t0 = performance.now();
	let last = null;
	while (performance.now() - t0 < ms) {
		last = await fn();
		if (last) return last;
		await sleep(30);
	}
	throw new Error(`timeout: ${what}${last ? ` (${fmt(last)})` : ""}`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const tmp = fs.mkdtempSync(path.join(SCRATCH, "pick-qa-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });

const fake = startFakeGitHub({ private: true, hasIssues: true });
let server = null;
let view = null;
let exitError = null;

try {
	server = await startInboxServer({ app: APP, port: PORT, home, env: { INBOX_GITHUB_API: fake.url } });
	const base = server.base;
	console.log(`app: ${APP}\nfake github: ${fake.url}\nserver: ${base}\ntemp: ${tmp}\nout: ${OUT}`);

	// Two threads; A carries a live question (with option buttons), then progress lines for enough height to scroll.
	await seedThread(base, {
		id: A,
		title: "결제 모듈 커밋 방식",
		product: "omo-inbox",
		branch: "feat/pay",
		firstRequest: "결제 모듈을 커밋해 줘",
		items: [
			{ kind: "progress", raw: { text: "결제 모듈을 살펴보는 중입니다.", request: "결제 모듈을 커밋해 줘" } },
			{
				kind: "question",
				policy: "needs-you",
				raw: {
					text: "커밋을 어떻게 나눌까요?",
					request: {
						questions: [
							{
								id: "q1",
								header: "커밋",
								question: "커밋을 어떻게 나눌까요?",
								options: [
									{ label: "두 개로 나누기", description: "결제와 테스트를 따로 커밋합니다." },
									{ label: "한 번에 커밋", description: "한 커밋으로 묶습니다." },
								],
							},
						],
					},
				},
			},
			{ kind: "progress", raw: { text: "테스트 파일도 함께 확인했습니다.", request: "결제 모듈을 커밋해 줘" } },
			...Array.from({ length: 12 }, (_v, i) => ({ kind: "progress", raw: { text: `커밋 준비 진행 상황 ${i + 1}번째 줄입니다. 화면을 아래로 길게 늘리는 확인용 진행 기록입니다.`, request: "결제 모듈을 커밋해 줘" } })),
		],
	});
	await seedThread(base, {
		id: B,
		title: "README 정리",
		product: "omo-inbox",
		branch: "docs",
		firstRequest: "README를 정리해 줘",
		items: [{ kind: "progress", raw: { text: "README 1장을 다시 쓰는 중입니다.", request: "README를 정리해 줘" } }],
	});
	const board = await seedBoard(base, { title: "pick qa review", frame: framePng(640, 360) });
	const boardId = board.summary?.id;
	if (!boardId) throw new Error(`board seed failed: ${fmt(board)}`);
	console.log(`board: ${boardId}`);

	view = new Bun.WebView({ width: 1280, height: 800 });
	await view.navigate("about:blank");
	const ev = (expr) => view.evaluate(expr);
	const cdp = (method, params) => view.cdp(method, params || {});
	const waitFor = (cond, ms, what) =>
		ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
	const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))");
	const metrics = async (width, height, touchOn) => {
		await cdp("Emulation.setTouchEmulationEnabled", touchOn ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
		await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: touchOn ? 2 : 1, mobile: touchOn });
	};
	const shot = async (name) => {
		const res = await cdp("Page.captureScreenshot", { format: "png" });
		const file = path.join(OUT, name);
		fs.writeFileSync(file, Buffer.from(res.data, "base64"));
		console.log(`saved ${file}`);
	};
	const move = (x, y) => cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	const click = async (x, y) => {
		await move(x, y);
		await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
		await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
		await settle();
	};
	const wheel = async (x, y, deltaY, modifiers = 0) => {
		await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY, modifiers });
		await settle();
	};
	const touch = (type, points) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points });
	const tap = async (x, y) => {
		await touch("touchStart", [{ x, y, id: 0 }]);
		await touch("touchEnd", []);
		await settle();
	};
	const dragTouch = async (x0, y0, x1, y1, steps = 10) => {
		await touch("touchStart", [{ x: x0, y: y0, id: 0 }]);
		for (let i = 1; i <= steps; i += 1) await touch("touchMove", [{ x: x0 + ((x1 - x0) * i) / steps, y: y0 + ((y1 - y0) * i) / steps, id: 0 }]);
		await touch("touchEnd", []);
		await settle();
	};
	const dragMouse = async (x0, y0, x1, y1, steps = 10) => {
		await move(x0, y0);
		await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
		for (let i = 1; i <= steps; i += 1) await move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
		await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
		await settle();
	};
	const escape = async () => {
		await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
		await settle();
	};
	const rectOf = (selector) =>
		ev(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
	const composer = () =>
		ev(`(() => { const d = document.querySelector("[data-report-composer]"); if (!d) return { exists: false }; const label = d.querySelector(".report__label"); const selector = d.querySelector("[data-selector]"); const ta = d.querySelector("textarea"); return { exists: true, open: Boolean(d.open), label: label ? label.textContent : null, selector: selector ? selector.getAttribute("data-selector") : null, text: ta ? ta.value : null }; })()`);
	const overlay = () =>
		ev(`(() => { const o = document.querySelector("[data-report-overlay]"); const b = document.querySelector("[data-report-box]"); const l = document.querySelector("[data-report-label]"); const c = document.querySelector("[data-report-composer]"); const r = b ? b.getBoundingClientRect() : null; return { exists: Boolean(o), open: o ? o.matches(":popover-open") : false, boxHidden: b ? b.hidden : null, box: r ? { l: r.left, t: r.top, w: r.width, h: r.height } : null, label: l ? l.textContent : null, labelHidden: l ? l.hidden : null, composer: c ? Boolean(c.open) : false }; })()`);
	const fillComposer = async (text) => {
		await ev(`(() => { const t = document.querySelector("[data-report-composer] textarea"); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); return t.value; })()`);
		await settle();
	};
	const sendComposer = async () => {
		await ev(`document.querySelector('[data-report-composer] [data-action="send"]').click()`);
		await settle();
	};
	const waitChat = (sid) => waitFor(`document.getElementById("chat") && document.getElementById("chat").getAttribute("aria-busy") === "false"`, 20000, `thread ${sid} ready`);
	const openThreadPhone = async (sid) => {
		await scenario(PHONE, `${base}/s/${encodeURIComponent(sid)}`);
		await waitChat(sid);
		await waitFor("Boolean(window.__inboxReporter)", 10000, "reporter mounted");
		await settle();
	};
	const openInboxDesktop = async () => {
		await scenario(DESKTOP, `${base}/`);
		await waitFor(`document.getElementById("list") && document.getElementById("list").getAttribute("aria-busy") === "false" && document.querySelectorAll("#list .row[data-session]").length >= 2`, 20000, "inbox list");
		await waitFor(`(() => { const f = document.querySelector("iframe"); if (!f) return false; const d = f.contentDocument; return Boolean(d) && d.getElementById("chat") && d.getElementById("chat").getAttribute("aria-busy") === "false"; })()`, 20000, "split frame");
		await waitFor("Boolean(window.__inboxReporter)", 10000, "reporter mounted");
		await settle();
	};
	const loadUrl = async (url) => {
		await view.navigate(url);
		const want = url === "about:blank" ? null : new URL(url);
		const loaded = want === null
			? `document.readyState === "complete" && location.href === "about:blank"`
			: `document.readyState === "complete" && location.origin === ${JSON.stringify(want.origin)} && location.pathname === ${JSON.stringify(want.pathname)}`;
		try {
			await waitFor(loaded, 20000, `load ${url}`);
		} catch (error) {
			const state = await ev("({ href: location.href, ready: document.readyState, width: innerWidth })").catch((e) => ({ error: String(e) }));
			throw new Error(`${error.message} (${fmt(state)})`);
		}
	};
	// Metrics are set only on a blank document: resizing / under 720 px rewrites its URL to /s/<sid>.
	const scenario = async (size, url) => {
		await loadUrl("about:blank");
		await metrics(size.width, size.height, size.touch);
		await loadUrl(url);
	};
	const DESKTOP = { width: 1280, height: 800, touch: false };
	const PHONE = { width: 390, height: 844, touch: true };
	const startPickFromHeader = async (selector) => {
		const r = await rectOf(selector);
		if (!r) throw new Error(`header anchor missing: ${selector}`);
		await click(r.cx, r.cy);
	};
	const waitComposer = () => waitFor("(() => { const d = document.querySelector('[data-report-composer]'); return Boolean(d && d.open); })()", 10000, "composer open");
	// Resolves after scrollY holds for three animation frames: momentum is over, not merely paused.
	const scrollSettled = (ms, what) => ev(`new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(new Error(${JSON.stringify(`timeout: ${what}`)})), ${ms}); let last = scrollY; let still = 0; const check = () => { if (scrollY === last) still += 1; else { last = scrollY; still = 0; } if (still >= 3) { clearTimeout(deadline); resolve(true); return; } requestAnimationFrame(check); }; requestAnimationFrame(check); })`);
	const scrollIntoViewSettled = (selector, ms, what) => ev(`new Promise((resolve, reject) => { const deadline = setTimeout(() => reject(new Error(${JSON.stringify(`timeout: ${what}`)})), ${ms}); const target = document.querySelector(${JSON.stringify(selector)}); if (!target) { clearTimeout(deadline); reject(new Error(${JSON.stringify(`missing: ${what}`)})); return; } target.scrollIntoView({ block: "center" }); let last = scrollY; let still = 0; const check = () => { if (scrollY === last) still += 1; else { last = scrollY; still = 0; } if (still >= 3) { clearTimeout(deadline); resolve(true); return; } requestAnimationFrame(check); }; requestAnimationFrame(check); })`);

	// ===== P1: desktop split, header 제보, row hover/click =====

	await openInboxDesktop();
	const row = await ev(`(() => { const e = document.querySelector("#list .row[data-session]"); const r = e.getBoundingClientRect(); return { title: (e.querySelector(".title") || {}).textContent || "", l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
	const hrefBefore = await ev("location.href");
	await startPickFromHeader("#reportLink");
	await waitFor("(() => { const h = document.querySelector('[data-report-hint]'); return Boolean(h && h.textContent.includes('고를 곳을 누르세요')); })()", 5000, "pick toolbar");
	let ov = await overlay();
	check("(P1) header 제보 starts pick mode with the 고를 곳을 누르세요 toolbar", ov.open === true && (await ev("document.querySelector('[data-report-overlay]')?.textContent.includes('고를 곳을 누르세요')")) === true, fmt({ open: ov.open, label: ov.label }));
	await shot("pick-1280.png");
	await move(row.cx, row.cy);
	await settle();
	ov = await overlay();
	const p1Hover = ov;
	await click(row.cx, row.cy);
	await waitComposer();
	const p1 = await composer();
	const p1Href = await ev("location.href");
	const picked1 = await ev(`(() => { const s = document.querySelector('[data-selector]')?.getAttribute('data-selector'); if (!s) return null; let e = null; try { e = document.querySelector(s); } catch {} if (!e) return null; const r = e.getBoundingClientRect(); const x = ${row.cx}, y = ${row.cy}; const row = document.querySelector('#list .row[data-session]'); return { selector: s, tag: e.tagName, inRow: Boolean(row && row.contains(e)), contains: x >= r.left && x <= r.right && y >= r.top && y <= r.bottom, rect: { l: r.left, t: r.top, w: r.width, h: r.height } }; })()`);
	const p1BoxOk = Boolean(p1Hover.box && picked1) && near(p1Hover.box.l, picked1.rect.l) && near(p1Hover.box.t, picked1.rect.t) && near(p1Hover.box.w, picked1.rect.w) && near(p1Hover.box.h, picked1.rect.h);
	check("(P1) hovering the row center draws the box of the deepest element under the pointer (+-2 px), inside the row", p1BoxOk && picked1.inRow === true && picked1.contains === true && typeof p1Hover.label === "string" && /^\S+ \d+×\d+$/.test(p1Hover.label), fmt({ hoverBox: p1Hover.box, picked: picked1, label: p1Hover.label }));
	check("(P1) clicking the row leaves location.href unchanged and opens the composer", p1.open === true && p1Href === hrefBefore, fmt({ before: hrefBefore, after: p1Href, open: p1.open }));
	let p1Row = null;
	let p1Presses = 0;
	for (let i = 0; i < 6; i += 1) {
		await ev(`document.querySelector('[data-report-composer] [data-action="up"]').click()`);
		await settle();
		p1Presses += 1;
		const cur = await ev(`(() => { const d = document.querySelector('[data-report-composer]'); const s = document.querySelector('[data-selector]').getAttribute('data-selector'); const label = d.querySelector('.report__label').textContent; const row = document.querySelector('#list .row[data-session]'); const title = row ? (row.querySelector('.title') || {}).textContent || '' : ''; let e = null; try { e = s ? document.querySelector(s) : null; } catch {} return { selector: s, label, isRow: Boolean(e && row && e === row && e.tagName === 'A' && e.classList.contains('row') && title !== '' && e.textContent.includes(title)), hasTitle: Boolean(title !== '' && label.includes(title)) }; })()`);
		if (cur.isRow && cur.hasTitle) {
			p1Row = cur;
			break;
		}
	}
	check("(P1) 상위 widens the pick to the row element and its title label", Boolean(p1Row), fmt({ presses: p1Presses, row: p1Row, title: row.title }));

	// P5: Escape during a fresh pick ends it and restores focus to the header anchor.
	await escape();
	await waitFor("(() => { const o = document.querySelector('[data-report-overlay]'); return !o || !o.matches(':popover-open'); })()", 5000, "pick ended");
	await startPickFromHeader("#reportLink");
	await escape();
	let focusOk = true;
	try {
		await waitFor("document.activeElement && document.activeElement.matches('[data-issue-report]')", 5000, "focus back on 제보");
	} catch {
		focusOk = false;
	}
	const afterEscape = await ev("({ pick: (document.querySelector('[data-report-overlay]') || {}).matches ? document.querySelector('[data-report-overlay]').matches(':popover-open') : false, dialog: Boolean((document.querySelector('[data-report-composer]') || {}).open), focus: document.activeElement && document.activeElement.textContent })");
	check("(P5) Escape during pick removes the toolbar, opens no dialog, and focuses the 제보 anchor", afterEscape.pick === false && afterEscape.dialog === false && focusOk && /제보/.test(afterEscape.focus || ""), fmt(afterEscape));

	// Failure scenario: the toolbar's 취소 must be clickable through the firewall.
	await startPickFromHeader("#reportLink");
	const cancelRect = await rectOf("[data-report-cancel]");
	await click(cancelRect.cx, cancelRect.cy);
	let cancelOk = true;
	try {
		await waitFor("(() => { const o = document.querySelector('[data-report-overlay]'); return !o || !o.matches(':popover-open'); })()", 5000, "cancel ended pick");
	} catch {
		cancelOk = false;
	}
	const cancelled = await ev("({ pick: (document.querySelector('[data-report-overlay]') || {}).matches ? document.querySelector('[data-report-overlay]').matches(':popover-open') : false, dialog: Boolean((document.querySelector('[data-report-composer]') || {}).open) })");
	check("(P5) the toolbar's 취소 click passes the firewall and ends pick mode without a dialog", cancelOk && cancelled.pick === false && cancelled.dialog === false, fmt(cancelled));

	// ===== P9: draft survives close and reload =====

	await startPickFromHeader("#reportLink");
	await move(row.cx, row.cy);
	await waitFor("(() => { const b = document.querySelector('[data-report-box]'); return b && !b.hidden; })()", 5000, "highlight row");
	await settle();
	await click(row.cx, row.cy);
	await waitComposer();
	const draftText = `draft-${Date.now()}`;
	await fillComposer(draftText);
	await escape();
	await waitFor("(() => { const d = document.querySelector('[data-report-composer]'); return !d || !d.open; })()", 5000, "composer closed");
	await openInboxDesktop();
	await startPickFromHeader("#reportLink");
	await move(row.cx, row.cy);
	await settle();
	await click(row.cx, row.cy);
	await waitComposer();
	const restored = await composer();
	check("(P9) a typed draft is restored after close, reload, and reopening the composer", restored.text === draftText, fmt({ want: draftText, got: restored.text }));
	await escape();
	await ev("localStorage.removeItem('inbox.reportDraft')");

	// ===== P2: split view, pick a bubble inside the iframe =====

	await openInboxDesktop();
	await startPickFromHeader("#reportLink");
	await ev(`(() => { const d = document.querySelector("iframe").contentDocument; const list = d.querySelectorAll(".msg.agent .bubble"); const e = list[list.length - 1]; if (e) e.scrollIntoView({ block: "center" }); })()`);
	await settle();
	const bubble = await ev(`(() => {
		const f = document.querySelector("iframe");
		const fr = f.getBoundingClientRect();
		const d = f.contentDocument;
		const list = d.querySelectorAll(".msg.agent .bubble");
		const e = list[list.length - 1];
		if (!e) return null;
		const r = e.getBoundingClientRect();
		const group = e.closest("section[data-item]");
		return { frame: { l: fr.left + f.clientLeft, t: fr.top + f.clientTop }, child: { l: r.left, t: r.top, w: r.width, h: r.height }, item: group ? group.getAttribute("data-item") : null, x: fr.left + f.clientLeft + r.left + r.width / 2, y: fr.top + f.clientTop + r.top + r.height / 2 };
	})()`);
	if (!bubble) throw new Error("no bubble inside the split frame");
	await move(bubble.x, bubble.y);
	await settle();
	ov = await overlay();
	const p2Hover = ov;
	await click(bubble.x, bubble.y);
	await waitComposer();
	const p2Dialog = await ev("(() => { const d = document.querySelector('[data-report-composer]'); return { open: Boolean(d && d.open), inTop: d ? d.ownerDocument === document : false }; })()");
	const picked2 = await ev(`(() => {
		const f = document.querySelector("iframe");
		if (!f) return null;
		const fr = f.getBoundingClientRect();
		const d = f.contentDocument;
		const s = document.querySelector("[data-selector]")?.getAttribute("data-selector");
		if (!s) return null;
		let e = null;
		try { e = d.querySelector(s); } catch {}
		if (!e) return null;
		const r = e.getBoundingClientRect();
		const group = e.closest("section[data-item]");
		return { selector: s, groupItem: group ? group.getAttribute("data-item") : null, rect: { l: fr.left + f.clientLeft + r.left, t: fr.top + f.clientTop + r.top, w: r.width, h: r.height } };
	})()`);
	const p2BoxOk = Boolean(p2Hover.box && picked2) && near(p2Hover.box.l, picked2.rect.l) && near(p2Hover.box.t, picked2.rect.t) && near(p2Hover.box.w, picked2.rect.w) && near(p2Hover.box.h, picked2.rect.h);
	check("(P2) hovering a bubble maps the box of the picked deepest element to the top document (+-2 px)", p2BoxOk, fmt({ got: p2Hover.box, picked: picked2, label: p2Hover.label }));
	check("(P2) clicking the iframe bubble opens the composer in the top document", p2Dialog.open === true && p2Dialog.inTop === true, fmt(p2Dialog));
	let p2Group = null;
	let p2Presses = 0;
	for (let i = 0; i < 6; i += 1) {
		await ev(`document.querySelector('[data-report-composer] [data-action="up"]').click()`);
		await settle();
		p2Presses += 1;
		const cur = await ev(`(() => { const d = document.querySelector("[data-report-composer]"); const f = document.querySelector("iframe"); const s = document.querySelector("[data-selector]").getAttribute("data-selector"); const label = d.querySelector(".report__label").textContent; let e = null; try { e = s ? f.contentDocument.querySelector(s) : null; } catch {} return { selector: s, label, groupItem: e && e.matches("section[data-item]") ? e.getAttribute("data-item") : null }; })()`);
		if (cur.groupItem !== null && cur.groupItem === bubble.item) {
			p2Group = cur;
			break;
		}
	}
	check("(P2) 상위 widens the bubble pick to its section[data-item]", Boolean(p2Group), fmt({ presses: p2Presses, group: p2Group, wantItem: bubble.item }));
	const beforeIssues = fake.issues.length;
	await fillComposer(REPORT_TEXT);
	await sendComposer();
	const created = await waitUntil(() => fake.issues[fake.issues.length - 1], 15000, "fake issue");
	check("(P2) sending creates a fake GitHub issue", fake.issues.length === beforeIssues + 1 && Boolean(created && created.body), fmt({ count: fake.issues.length }));
	const m = /```json\n([\s\S]*?)\n```/.exec(created.body);
	let machine = null;
	try {
		machine = m ? JSON.parse(m[1]) : null;
	} catch {
		machine = null;
	}
	const frameUrl = machine && Array.isArray(machine.page.frames) ? machine.page.frames[0]?.url : null;
	check("(P2) the POSTed page.frames[0].url is /s/<sid>", frameUrl === `/s/${A}`, fmt({ frameUrl, frames: machine && machine.page.frames }));
	await escape();
	await settle();

	// ===== P6: 상위/하위 on a text span inside a button =====

	await openThreadPhone(A);
	await startPickFromHeader("header [data-issue-report]");
	const spanPoint = await ev(`(() => { const b = [...document.querySelectorAll("button.opt")].find((x) => x.querySelector("span.label")); if (!b) return null; b.scrollIntoView({ block: "center" }); const s = b.querySelector("span.label"); const r = s.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: s.textContent }; })()`);
	if (!spanPoint) throw new Error("no option button span");
	await settle();
	const spanRect = await ev(`(() => { const b = [...document.querySelectorAll("button.opt")].find((x) => x.querySelector("span.label")); const r = b.querySelector("span.label").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	await tap(spanRect.x, spanRect.y);
	await waitComposer();
	const beforeUp = await composer();
	await ev(`document.querySelector('[data-report-composer] [data-action="up"]').click()`);
	await settle();
	const afterUp = await composer();
	check("(P6) picking a span inside a button and pressing 상위 switches the label to `버튼 · ...`", typeof afterUp.label === "string" && afterUp.label.startsWith("버튼 · ") && afterUp.label !== beforeUp.label, fmt({ before: beforeUp.label, after: afterUp.label }));
	await ev(`document.querySelector('[data-report-composer] [data-action="down"]').click()`);
	await settle();
	const afterDown = await composer();
	check("(P6) pressing 하위 returns to the original span selection", afterDown.label === beforeUp.label, fmt({ want: beforeUp.label, got: afterDown.label }));
	await escape();
	await settle();

	// ===== P7: bubble footer 제보 opens without pick mode =====

	await openThreadPhone(A);
	const reportPoint = await ev(`(() => { const b = [...document.querySelectorAll('.msg.agent [data-action="report"]')].pop(); if (!b) return null; b.scrollIntoView({ block: "center" }); return true; })()`);
	if (!reportPoint) throw new Error("no bubble footer report button");
	await settle();
	const reportRect = await ev(`(() => { const b = [...document.querySelectorAll('.msg.agent [data-action="report"]')].pop(); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	await tap(reportRect.x, reportRect.y);
	await waitComposer();
	const p7 = await composer();
	const p7Overlay = await overlay();
	const p7Target = await ev(`(() => { const s = document.querySelector('[data-selector]').getAttribute('data-selector'); const button = [...document.querySelectorAll('.msg.agent [data-action="report"]')].pop(); const group = button ? button.closest('section[data-item]') : null; let hit = null; try { hit = s ? document.querySelector(s) : null; } catch {} return { selector: s, isGroup: Boolean(group && hit === group), groupItem: group ? group.getAttribute('data-item') : null }; })()`);
	check("(P7) the bubble footer 제보 opens the composer without pick mode", p7.open === true && p7Overlay.open === false, fmt({ composer: p7.open, pick: p7Overlay.open }));
	check("(P7) the footer selection is the bubble's section, not the button", p7Target.isGroup === true, fmt(p7Target));
	await escape();
	await settle();

	// ===== P3: phone /s, touch drag scroll, then tap 원문 보기 =====

	await openThreadPhone(A);
	await startPickFromHeader("header [data-issue-report]");
	await shot("pick-390.png");
	await ev("scrollTo(0, 0)");
	await settle();
	const y0 = await ev("scrollY");
	await touch("touchStart", [{ x: 195, y: 700, id: 0 }]);
	for (let i = 1; i <= 12; i += 1) await touch("touchMove", [{ x: 195, y: 700 - (250 * i) / 12, id: 0 }]);
	const dragSettled = scrollSettled(5000, "touch scroll settled");
	await touch("touchEnd", []);
	await dragSettled;
	await settle();
	let scrolled = true;
	try {
		await waitFor(`scrollY > ${y0} + 40`, 4000, "touch scroll with pick on");
	} catch {
		scrolled = false;
	}
	const p3a = await ev("({ y: scrollY, max: Math.max(0, document.documentElement.scrollHeight - innerHeight), dialog: Boolean((document.querySelector('[data-report-composer]') || {}).open), pick: document.querySelector('[data-report-overlay]').matches(':popover-open') })");
	check("(P3) a 250 px upward touch drag scrolls while picking, with no dialog", scrolled && p3a.y > y0 + 40 && p3a.dialog === false, fmt({ y0, got: p3a }));
	await scrollIntoViewSettled('.msg.agent [data-action="raw"]', 5000, "raw scroll settled");
	await settle();
	const rawBefore = await ev(`(() => { const b = document.querySelector('.msg.agent [data-action="raw"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, expanded: b.getAttribute("aria-expanded") }; })()`);
	await tap(rawBefore.x, rawBefore.y);
	await waitComposer();
	const rawAfter = await ev(`(() => { const b = document.querySelector('.msg.agent [data-action="raw"]'); return b ? b.getAttribute("aria-expanded") : null; })()`);
	const p3b = await composer();
	await shot("composer-390.png");
	check("(P3) tapping the bubble's 원문 보기 keeps aria-expanded and opens the composer for `버튼 · 원문 보기`", rawAfter === rawBefore.expanded && p3b.open === true && p3b.label === "버튼 · 원문 보기", fmt({ before: rawBefore.expanded, after: rawAfter, label: p3b.label }));
	await escape();
	await settle();

	// ===== P4: Review viewer pick mode, drag does not draw, image click opens composer =====

	await scenario(DESKTOP, `${base}/p/${encodeURIComponent(boardId)}`);
	await waitFor("document.querySelectorAll('.frame canvas').length >= 1", 30000, "review frame");
	await waitFor("Boolean(window.__vb && window.__vb.summary)", 15000, "review data");
	await settle();
	const frameImg = await rectOf(".frame canvas");
	await click(frameImg.cx, frameImg.cy);
	await waitFor("window.__vb.viewer.open === true", 5000, "viewer open");
	await startPickFromHeader("#vReport");
	await waitFor("document.querySelector('[data-report-overlay]').matches(':popover-open')", 5000, "viewer pick mode");
	await shot("pick-viewer.png");
	const marksBefore = await ev("document.querySelectorAll('#marks .mark').length");
	const stage = await rectOf("#vStage");
	await dragMouse(stage.cx - 60, stage.cy, stage.cx + 60, stage.cy, 12);
	const p4a = await ev("({ marks: document.querySelectorAll('#marks .mark').length, dialog: Boolean((document.querySelector('[data-report-composer]') || {}).open), open: window.__vb.viewer.open })");
	check("(P4) a 120 px mouse drag across the viewer image makes no mark and opens no dialog", p4a.marks === marksBefore && p4a.dialog === false && p4a.open === true, fmt(p4a));
	const imagePoint = await ev("(() => { const r = document.getElementById('vImg').getBoundingClientRect(); return { x: Math.min(innerWidth - 10, Math.max(10, r.left + r.width / 2)), y: Math.min(innerHeight - 10, Math.max(10, r.top + r.height / 2)) }; })()");
	await click(imagePoint.x, imagePoint.y);
	await waitComposer();
	const p4b = await composer();
	check("(P4) clicking the viewer image opens a composer labelled 이미지 ...", typeof p4b.label === "string" && p4b.label.startsWith("이미지"), fmt({ label: p4b.label, selector: p4b.selector }));
	await escape();
	await waitFor("(() => { const d = document.querySelector('[data-report-composer]'); return !d || !d.open; })()", 5000, "composer closed");
	const p4c = await ev("({ dialog: Boolean((document.querySelector('[data-report-composer]') || {}).open), open: window.__vb.viewer.open, hidden: document.getElementById('viewer').hidden })");
	check("(P4) Escape closes the composer and leaves the viewer open", p4c.dialog === false && p4c.open === true && p4c.hidden === false, fmt(p4c));

	// ===== P11: the picker firewalls wheel input, then Escape restores viewer zoom =====

	await startPickFromHeader("#vReport");
	await waitFor("document.querySelector('[data-report-overlay]').matches(':popover-open')", 5000, "viewer pick mode for wheel");
	const scale0 = await ev("window.__vb.viewer.scale");
	const wheelPoint = await ev("(() => { const r = document.getElementById('vStage').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
	await wheel(wheelPoint.x, wheelPoint.y, -240, 0);
	const scale1 = await ev("window.__vb.viewer.scale");
	await wheel(wheelPoint.x, wheelPoint.y, -240, 2);
	const scale2 = await ev("window.__vb.viewer.scale");
	check("(P11) mouseWheel and Ctrl+wheel over the image are swallowed while picking", scale1 === scale0 && scale2 === scale0, fmt({ scale0, wheel: scale1, ctrlWheel: scale2 }));
	await escape();
	await waitFor("(() => { const o = document.querySelector('[data-report-overlay]'); return !o || !o.matches(':popover-open'); })()", 5000, "viewer pick ended");
	await wheel(wheelPoint.x, wheelPoint.y, -240, 0);
	const scale3 = await ev("window.__vb.viewer.scale");
	check("(P11) after Escape the same wheel zooms the open viewer", scale3 > scale0, fmt({ scale0, after: scale3 }));
	check("(P11) the viewer stays open through pick mode and Escape", (await ev("window.__vb.viewer.open")) === true, fmt(await ev("({ open: window.__vb.viewer.open, hidden: document.getElementById('viewer').hidden })")));
	await ev("document.getElementById('vClose').click()");
	await settle();

	// ===== P8: phone Review, tapping a frame image while picking keeps the viewer closed =====

	await scenario(PHONE, `${base}/p/${encodeURIComponent(boardId)}`);
	await waitFor("document.querySelectorAll('.frame canvas').length >= 1", 30000, "review frame phone");
	await waitFor("Boolean(window.__vb && window.__vb.summary)", 15000, "review data phone");
	await settle();
	await startPickFromHeader("nav.top [data-issue-report]");
	await ev(`(() => { const c = document.querySelector(".frame canvas"); if (c) c.scrollIntoView({ block: "center" }); })()`);
	await settle();
	const inline = await rectOf(".frame canvas");
	await tap(inline.cx, inline.cy);
	await waitComposer();
	const p8 = await ev("({ open: window.__vb.viewer.open, hidden: document.getElementById('viewer').hidden, dialog: Boolean((document.querySelector('[data-report-composer]') || {}).open) })");
	check("(P8) tapping a frame image while picking keeps the viewer hidden and opens the composer", p8.open === false && p8.hidden === true && p8.dialog === true, fmt(p8));
	await escape();
	await settle();

	// ===== P10: /issues header 제보 picks a list row and the composer sends kind issues =====

	await scenario(DESKTOP, `${base}/issues`);
	await waitFor("document.querySelectorAll('#list .row').length >= 1", 20000, "issues rows");
	await waitFor("Boolean(window.__inboxReporter)", 10000, "issues reporter");
	await settle();
	const issuesHref = await ev("location.href");
	const irow = await ev(`(() => { const e = document.querySelector("#list .row"); const r = e.getBoundingClientRect(); const title = e.querySelector(".title"); return { title: title ? title.textContent : "", x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	await startPickFromHeader('header [data-issue-report]');
	await move(irow.x, irow.y);
	await settle();
	const iov = await overlay();
	check("(P10) /issues header 제보 enters pick mode", iov.open === true, fmt({ open: iov.open, label: iov.label }));
	await click(irow.x, irow.y);
	await waitComposer();
	const p10 = await composer();
	const issuesAfter = await ev("location.href");
	check("(P10) clicking a row opens the composer without navigating", issuesAfter === issuesHref && p10.open === true && typeof p10.label === "string" && p10.label.includes(irow.title), fmt({ before: issuesHref, after: issuesAfter, label: p10.label, wantTitle: irow.title }));
	const beforeIssues2 = fake.issues.length;
	await fillComposer("issues page inspector report");
	await sendComposer();
	const created2 = await waitUntil(() => (fake.issues.length > beforeIssues2 ? fake.issues[fake.issues.length - 1] : null), 15000, "issues fake issue");
	const m2 = /```json\n([\s\S]*?)\n```/.exec(created2.body);
	let machine2 = null;
	try {
		machine2 = m2 ? JSON.parse(m2[1]) : null;
	} catch {
		machine2 = null;
	}
	const kindOk = machine2 && machine2.page && machine2.page.kind === "issues";
	const labelOk = machine2 && machine2.element && typeof machine2.element.label === "string" && machine2.element.label.includes(irow.title);
	check("(P10) the sent body has page kind issues and the row's label", kindOk === true && labelOk === true, fmt({ page: machine2 && machine2.page, element: machine2 && machine2.element }));

	// ===== P12: the picking toolbar dodges out of the way of the elements under it =====

	const toolbarState = () =>
		ev(`(() => { const t = document.querySelector('[data-report-overlay] [role="toolbar"]'); const c = document.querySelector('[data-report-composer]'); const o = document.querySelector('[data-report-overlay]'); return { edge: t ? t.getAttribute('data-edge') : null, open: Boolean(o && o.matches(':popover-open')), composer: Boolean(c && c.open) }; })()`);

	await scenario(PHONE, `${base}/`);
	await waitFor("Boolean(window.__inboxReporter)", 10000, "inbox reporter for dodge");
	await settle();
	const phoneHref = await ev("location.href");
	await startPickFromHeader("#reportLink");
	await waitFor("document.querySelector('[data-report-overlay]')?.matches(':popover-open')", 5000, "dodge pick mode");
	const topBar = await rectOf('[data-report-overlay] [role="toolbar"]');
	const issuesRect = await rectOf("#issuesLink");
	const coversIssues = Boolean(topBar && issuesRect)
		&& topBar.l < issuesRect.l + issuesRect.w && topBar.l + topBar.w > issuesRect.l
		&& topBar.t < issuesRect.t + issuesRect.h && topBar.t + topBar.h > issuesRect.t;
	const startEdge = await toolbarState();
	check("(P12) the phone pick toolbar starts at top and covers the 제보함 header anchor", startEdge.edge === "top" && coversIssues === true, fmt({ edge: startEdge.edge, bar: topBar, issues: issuesRect }));
	const hintRect = await rectOf("[data-report-hint]");
	await tap(hintRect.cx, hintRect.cy);
	await waitFor("document.querySelector('[data-report-overlay] [role=\"toolbar\"]')?.getAttribute('data-edge') === 'bottom'", 5000, "toolbar flipped to bottom");
	const flipped = await toolbarState();
	check("(P12) a touch tap on the hint flips the toolbar to the bottom without opening the composer", flipped.edge === "bottom" && flipped.open === true && flipped.composer === false, fmt(flipped));
	const issuesCenter = await rectOf("#issuesLink");
	await tap(issuesCenter.cx, issuesCenter.cy);
	await waitComposer();
	const p12a = await composer();
	const p12Target = await ev(`(() => { const s = document.querySelector('[data-selector]')?.getAttribute('data-selector'); const want = document.querySelector('#issuesLink'); let hit = null; try { hit = s ? document.querySelector(s) : null; } catch {} return { selector: s, isIssuesLink: Boolean(hit && hit === want), href: location.href }; })()`);
	check("(P12) after the flip the 제보함 anchor picks a 링크 composer without navigating", p12a.open === true && typeof p12a.label === "string" && p12a.label.startsWith("링크") && p12Target.isIssuesLink === true && p12Target.href === phoneHref, fmt({ label: p12a.label, selector: p12Target.selector, href: p12Target.href }));
	await escape();
	await waitFor("(() => { const d = document.querySelector('[data-report-composer]'); return !d || !d.open; })()", 5000, "dodge composer closed");

	await scenario(DESKTOP, `${base}/`);
	await waitFor("Boolean(window.__inboxReporter)", 10000, "desktop reporter for dodge");
	await settle();
	await startPickFromHeader("#reportLink");
	await waitFor("document.querySelector('[data-report-overlay]')?.matches(':popover-open')", 5000, "desktop dodge pick mode");
	const deskBar = await rectOf('[data-report-overlay] [role="toolbar"]');
	await move(deskBar.cx, deskBar.cy);
	await waitFor("document.querySelector('[data-report-overlay] [role=\"toolbar\"]')?.getAttribute('data-edge') === 'bottom'", 5000, "desktop toolbar flipped to bottom");
	const deskFlipped = await toolbarState();
	check("(P12) a mouse entering the toolbar flips it to the bottom", deskFlipped.edge === "bottom" && deskFlipped.composer === false, fmt(deskFlipped));
	const deskCancel = await rectOf("[data-report-cancel]");
	await click(deskCancel.cx, deskCancel.cy);
	let deskCancelOk = true;
	try {
		await waitFor("(() => { const o = document.querySelector('[data-report-overlay]'); return !o || !o.matches(':popover-open'); })()", 5000, "desktop cancel ended pick");
	} catch {
		deskCancelOk = false;
	}
	const deskEnded = await toolbarState();
	check("(P12) 취소 still ends pick mode from the bottom edge", deskCancelOk && deskEnded.open === false && deskEnded.composer === false, fmt(deskEnded));
} catch (error) {
	exitError = error;
	check("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	try {
		if (view) await view.close();
	} catch {
		// already closed
	}
	try {
		if (server) await server.stop();
	} catch (error) {
		console.error(`server stop failed: ${error?.message ?? error}`);
	}
	try {
		await fake.stop();
	} catch (error) {
		console.error(`fake stop failed: ${error?.message ?? error}`);
	}
	let removed = false;
	try {
		fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		removed = !fs.existsSync(tmp);
	} catch (error) {
		console.error(`temp remove failed: ${error?.message ?? error}`);
	}
	console.log(`cleanup: view.closed=true server.stopped=true fake.stopped=true temp.removed=${removed}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed || exitError ? 1 : 0);
