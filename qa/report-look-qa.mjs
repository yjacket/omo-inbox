/* Visual and layout QA for the report surfaces: the inspector toolbar (web/report-overlay.js), the composer
 * (web/report.js) and 제보함 (web/reports.html) at phone and desktop widths, in the light and dark schemes.
 *
 * Usage: bun qa/report-look-qa.mjs [app dir, default the repo] [output dir, default a new temp dir]
 * Starts the fake GitHub and <app>/src/server.mjs from qa/report-fixture.mjs on a temp home (port 4405,
 * INBOX_GITHUB_API at the fake, INBOX_NO_TAILSCALE=1, pushes and reopens go to sink files), seeds two threads and one
 * Review, then stores three reports so 제보함 shows one row of each state: a failed one (the fake answers 422 to the
 * issue create), a sent one with a picture (#1, open), and a pending one (the fake holds its create open for the rest
 * of the run). One Bun.WebView is then driven through CDP in four passes: 390x844 touch and 1280x800 mouse, each in
 * light and dark (Emulation.setEmulatedMedia prefers-color-scheme). Each pass captures pick mode on /, the composer
 * with a picture opened from a bubble's 제보 on /s/<sid> (the split view's /?s=<sid> at 1280), /issues with its
 * pending, failed and sent rows, and /issues/new: 16 screenshots named <screen>-<width>-<scheme>.png (screens pick,
 * composer, issues, new) land in the output dir; the temp home is deleted at the end.
 *
 * Checks (one PASS/FAIL line each; exit 0 only when every check passes; the last line is `N/N checks passed`):
 * L1 the 제보 entry is as tall as its neighbor (+-1 px): / #reportLink vs #issuesLink; /s/<sid> [data-issue-report]
 *    vs the 제보함 .tool; /boards and /p/<id> .back siblings; the bubble foot 제보 vs 더 쉽게.
 * L2 every composer and 제보함 button/link (and the pick toolbar's 취소) has a bounding box of at least 44x44 CSS px.
 * L3 document.scrollingElement.scrollWidth <= innerWidth on every captured screen.
 * L4 in dark the composer's background and text colors differ from the light pass at the same width, and the status
 *    text's contrast ratio against its background is at least 4.5 (computed in the page from computed colors).
 * L5 the inspector toolbar does not cover the element under the pointer at the screen center.
 * L6 the computed --bg of / and /s/<sid> is the DESIGN.md value (#f3f4f6 light, #111214 dark): the old palette holds.
 * Plus the screens' own content: the seeded 제보함 counts, the composer's redrawn picture (captioned 화면을 다시 그린 그림,
 * decoded, and shaped like the picked bubble), the three row texts of /issues, and the 16 screenshot files.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { framePng } from "./frame.mjs";
import { seedBoard, seedThread, startFakeGitHub, startInboxServer, submit } from "./report-fixture.mjs";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = 4405;
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "report-look-qa-out-"));
const A = "qa-look-a"; // the thread with the question bubble; first in the list, so / auto-selects it when wide
const B = "qa-look-b";
const TAP = 44;
const CONTRAST_MIN = 4.5;
// DESIGN.md: web/inbox.html and web/thread.html `--bg` in the light and dark tables.
const BG = { light: "#f3f4f6", dark: "#111214" };
const PICTURE_DRAWN = "화면을 다시 그린 그림";
const PICTURE_PENDING = "그림 만드는 중";
const FAILED_DETAIL = "GitHub가 내용을 받지 않았습니다";
const PASSES = [
	{ width: 390, height: 844, touch: true, scheme: "light" },
	{ width: 390, height: 844, touch: true, scheme: "dark" },
	{ width: 1280, height: 800, touch: false, scheme: "light" },
	{ width: 1280, height: 800, touch: false, scheme: "dark" },
];

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (o) => JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));
const near1 = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- temp home, fake GitHub, server ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-look-qa-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const fake = startFakeGitHub({ private: true, hasIssues: true });
let server = null;
let board = null;
let view = null;
let exitError = null;

// ---------- seeding ----------

async function reportRow(base, id) {
	const res = await fetch(`${base}/api/reports/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } });
	return res.ok ? res.json() : null;
}

async function reportList(base) {
	const res = await fetch(`${base}/api/reports?limit=50`, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`GET /api/reports -> ${res.status}`);
	return res.json();
}

/** Poll the record until pred(row) holds; a QA script has no event for the publisher, so this is a bounded poll. */
async function untilRow(base, id, pred, ms, what) {
	const t0 = Date.now();
	let last = null;
	while (Date.now() - t0 < ms) {
		last = await reportRow(base, id);
		if (last && pred(last)) return last;
		await sleep(100);
	}
	throw new Error(`deadline: ${what} (${ms}ms); last ${fmt(last)}`);
}

async function untilList(base, pred, ms, what) {
	const t0 = Date.now();
	let last = null;
	while (Date.now() - t0 < ms) {
		last = await reportList(base);
		if (pred(last)) return last;
		await sleep(100);
	}
	throw new Error(`deadline: ${what} (${ms}ms); last ${fmt(last)}`);
}

function createBody(description, image) {
	return {
		v: 2,
		reportId: crypto.randomUUID(),
		description,
		page: { kind: "issues", route: "/issues/new", url: "/issues/new", title: "제보함", frames: [] },
		element: null,
		view: { layout: { w: 390, h: 844 }, visual: { x: 0, y: 0, w: 390, h: 844, scale: 1 }, scroll: { x: 0, y: 0 }, dpr: 2, colorScheme: "light", pointer: "coarse" },
		source: null,
		image,
	};
}

async function seed(base) {
	await seedThread(base, {
		id: A,
		title: "결제 모듈 커밋 방식",
		product: "omo-inbox",
		branch: "feat/pay",
		firstRequest: "결제 모듈을 커밋해 줘",
		items: [{ kind: "turn", policy: "needs-you", dedupeKey: "turn:look-a:1", raw: { text: "커밋을 두 개로 나눌지 정해 주세요.", request: "결제 모듈을 커밋해 줘" } }],
	});
	await seedThread(base, {
		id: B,
		title: "README 정리",
		product: "omo-inbox",
		branch: "docs",
		firstRequest: "README를 정리해 줘",
		items: [{ kind: "progress", policy: "progress", dedupeKey: "turn:look-b:1", raw: { text: "README 1장을 다시 쓰는 중입니다.", request: "README를 정리해 줘" } }],
	});
	board = await seedBoard(base, { title: "제보 화면 QA", kind: "decision" });

	// failed: the issue create answers 422 (validation) -> `보내지 못했습니다 · GitHub가 내용을 받지 않았습니다`
	fake.setMode({ status: { "^/repos/[^/]+/[^/]+/issues$": 422 } });
	const failed = await submit(base, createBody("보내기 버튼이 두 번 눌립니다", null));
	await untilRow(base, failed.id, (row) => row.state === "failed", 15000, "failed report");
	fake.setMode({ status: null });

	// sent with a picture: the asset goes to the fake, the issue becomes #1 and the state cache learns it is open
	const png = framePng(320, 180);
	const sent = await submit(base, createBody("글자가 잘립니다", { provenance: "upload", png: png.toString("base64"), width: 320, height: 180 }));
	await untilRow(base, sent.id, (row) => row.state === "sent" && row.github && typeof row.github.number === "number", 15000, "sent report");
	await untilList(base, (list) => list.items.some((row) => row.id === sent.id && row.github && row.github.state === "open"), 15000, "sent row state open");

	// pending: the fake holds the create open; with a long request timeout the record stays `creating` for the run
	fake.setMode({ hangCreate: 1 });
	const pending = await submit(base, createBody("제보함 줄 간격이 좁습니다", null));
	await untilRow(base, pending.id, (row) => row.state === "pending" && row.delivery && row.delivery.state === "creating", 15000, "pending report");

	const list = await reportList(base);
	check(
		"seed: 제보함 has one pending, one failed and one sent row (newest first)",
		list.counts.pending === 1 && list.counts.failed === 1 && list.counts.sent === 1 && list.items.map((row) => row.state).join(",") === "pending,sent,failed",
		fmt({ counts: list.counts, order: list.items.map((row) => row.state) }),
	);
	return { failed: failed.id, sent: sent.id, pending: pending.id, boardId: board.summary.id };
}

// ---------- browser helpers ----------

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
		await sleep(50);
	}
	return { ok: false, ...last };
};
const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))))");
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
const press = async (pass, x, y) => (pass.touch ? tap(x, y) : click(x, y));
const shot = async (name) => {
	const res = await cdp("Page.captureScreenshot", { format: "png" });
	const file = path.join(OUT, name);
	fs.writeFileSync(file, Buffer.from(res.data, "base64"));
	console.log(`saved ${file}`);
};
const metrics = async (pass) => {
	await cdp("Emulation.setTouchEmulationEnabled", pass.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
	await cdp("Emulation.setDeviceMetricsOverride", { width: pass.width, height: pass.height, deviceScaleFactor: pass.touch ? 2 : 1, mobile: pass.touch });
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: pass.scheme }] });
};
const open = async (route) => {
	await view.navigate("about:blank");
	await view.navigate(`${base()}${route}`);
};
let serverBase = null;
const base = () => serverBase;

// The thread document: the top document on a phone, the split view's iframe document when wide.
const DOC = (wide) => (wide ? "document.querySelector('iframe').contentDocument" : "document");
const FRAME_OFFSET = `(() => { const f = document.querySelector("iframe"); if (!f) return { x: 0, y: 0 }; const r = f.getBoundingClientRect(); return { x: r.left + f.clientLeft, y: r.top + f.clientTop }; })()`;
const CHAT_READY = (docExpr) => `(() => { const D = ${docExpr}; const chat = D && D.getElementById("chat"); return Boolean(chat) && chat.getAttribute("aria-busy") === "false" && Boolean(D.defaultView.__inboxReporter) && Boolean(D.querySelector(".foot [data-action='report']")); })()`;
const BADGE_SHOWN = (docExpr, id) => `(() => { const D = ${docExpr}; const b = D && D.getElementById(${JSON.stringify(id)}); return Boolean(b) && !b.hidden && b.textContent.trim() !== ""; })()`;
const LIST_READY = "document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#list .row[data-session]').length >= 2 && Boolean(window.__inboxReporter)";
const SPLIT_READY = `(() => { const f = document.querySelector("iframe"); if (!f) return false; const d = f.contentDocument; const chat = d && d.getElementById("chat"); return Boolean(chat) && chat.getAttribute("aria-busy") === "false"; })()`;
const TOOLBAR = `(() => { const tb = document.querySelector("[data-report-overlay] [role='toolbar']"); if (!tb || tb.getClientRects().length === 0) return null; const r = tb.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; })()`;
const BOX = `(() => { const box = document.querySelector("[data-report-overlay] [data-report-box]"); if (!box || box.hidden || box.getClientRects().length === 0) return null; const r = box.getBoundingClientRect(); const label = document.querySelector("[data-report-overlay] [data-report-label]"); return { l: r.left, t: r.top, r: r.right, b: r.bottom, via: "box", label: label && !label.hidden ? label.textContent : null }; })()`;
// The element under the screen center, following same-origin iframes; its box in top-window coordinates.
const UNDER_CENTER = `(() => { const x = innerWidth / 2, y = innerHeight / 2; let doc = document, el = doc.elementFromPoint(x, y), ox = 0, oy = 0; while (el && el.tagName === "IFRAME" && el.contentDocument) { const fr = el.getBoundingClientRect(); ox += fr.left + el.clientLeft; oy += fr.top + el.clientTop; doc = el.contentDocument; el = doc.elementFromPoint(x - ox, y - oy); } if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left + ox, t: r.top + oy, r: r.right + ox, b: r.bottom + oy, via: "elementFromPoint", tag: el.tagName.toLowerCase() }; })()`;
const DIALOG = `(document.querySelector("dialog[data-report-composer][open]") || (document.querySelector("iframe") && document.querySelector("iframe").contentDocument && document.querySelector("iframe").contentDocument.querySelector("dialog[data-report-composer][open]")) || null)`;
const PICTURE = `(() => { const d = ${DIALOG}; if (!d) return null; const caption = d.querySelector(".report__caption"); const thumb = d.querySelector(".report__thumb"); return { caption: caption ? caption.textContent : null, thumbShown: Boolean(thumb) && !thumb.hidden && thumb.getClientRects().length > 0, decoded: Boolean(thumb) && thumb.complete && thumb.naturalWidth > 0, natural: thumb ? [thumb.naturalWidth, thumb.naturalHeight] : null, w: thumb ? thumb.getBoundingClientRect().width : 0, h: thumb ? thumb.getBoundingClientRect().height : 0 }; })()`;
// The bubble's 제보 button center plus what the redraw should cover: the bubble's box padded by 12 px and clipped to
// the thread window's viewport (web/report-snapshot.js), so the picture's aspect can be compared with the bubble's.
const FOOT_TARGET = (docExpr) => `(() => { const D = ${docExpr}; const W = D.defaultView; const el = D.querySelector(".foot [data-action='report']"); if (!el) return null; el.scrollIntoView({ block: "center", inline: "nearest" }); const r = el.getBoundingClientRect(); const g = el.closest("[data-item]").getBoundingClientRect(); const x = Math.max(g.left - 12, 0); const y = Math.max(g.top - 12, 0); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, bubble: { x: g.left, y: g.top, w: g.width, h: g.height }, expect: { w: Math.min(g.right + 12, W.innerWidth) - x, h: Math.min(g.bottom + 12, W.innerHeight) - y } }; })()`;
const SCROLL = "({ sw: document.scrollingElement.scrollWidth, iw: innerWidth })";
// Every visible button and link under the root: text and box, so a short one is named in the FAIL line.
const CONTROLS = (rootExpr) => `(() => { const root = ${rootExpr}; if (!root) return null; const out = []; for (const el of root.querySelectorAll("button, a[href]")) { if (el.hidden || el.closest("[hidden]") || el.getClientRects().length === 0) continue; const r = el.getBoundingClientRect(); out.push({ text: (el.textContent || "").trim().slice(0, 10), w: r.width, h: r.height }); } return out; })()`;
const HEIGHTS = (docExpr, entrySel, neighborSel) => `(() => { const D = ${docExpr}; const a = D.querySelector(${JSON.stringify(entrySel)}); const b = D.querySelector(${JSON.stringify(neighborSel)}); const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { text: el.textContent.trim().slice(0, 10), w: r.width, h: r.height }; }; return { entry: box(a), neighbor: box(b) }; })()`;
const PALETTE = (docExpr) => `(() => { const D = ${docExpr}; const cs = getComputedStyle(D.documentElement); return { bg: cs.getPropertyValue("--bg").trim(), htmlBg: cs.backgroundColor, dark: D.defaultView.matchMedia("(prefers-color-scheme: dark)").matches }; })()`;
const COMPOSER_COLORS = `(() => {
	const d = ${DIALOG};
	if (!d) return null;
	const parse = (s) => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ""); if (!m) return null; const p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
	const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
	const ratio = (x, y) => { const lx = lum(x), ly = lum(y); return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05); };
	const status = d.querySelector(".report__status");
	let bg = null;
	for (let el = status; el; el = el.parentElement) { const c = parse(getComputedStyle(el).backgroundColor); if (c && c.a > 0) { bg = c; break; } }
	const fg = parse(getComputedStyle(status).color);
	const cs = getComputedStyle(d);
	return { bg: cs.backgroundColor, ink: cs.color, statusColor: getComputedStyle(status).color, statusBg: bg ? "rgb(" + bg.r + ", " + bg.g + ", " + bg.b + ")" : null, ratio: fg && bg ? ratio(fg, bg) : null };
})()`;
const centerOf = (docExpr, sel) =>
	ev(`(() => { const D = ${docExpr}; const el = D.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "nearest" }); const r = el.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);

const tapOk = (controls) => Array.isArray(controls) && controls.length > 0 && controls.every((c) => c.w >= TAP - 0.01 && c.h >= TAP - 0.01);
const shortOnes = (controls) => (Array.isArray(controls) ? controls.filter((c) => !(c.w >= TAP - 0.01 && c.h >= TAP - 0.01)) : controls);
const inside = (box, tb) => box.l >= tb.l && box.t >= tb.t && box.r <= tb.r && box.b <= tb.b;
const contains = (tb, x, y) => x >= tb.l && x <= tb.r && y >= tb.t && y <= tb.b;

function heightCheck(label, where, pair) {
	check(
		`L1 (${label}) ${where}: the 제보 entry is as tall as its neighbor (+-1 px)`,
		Boolean(pair.entry) && Boolean(pair.neighbor) && near1(pair.entry.h, pair.neighbor.h),
		fmt(pair),
	);
}

function paletteCheck(label, route, palette, scheme) {
	check(`L6 (${label}) ${route}: computed --bg is the DESIGN.md ${scheme} value ${BG[scheme]}`, palette.bg === BG[scheme] && palette.dark === (scheme === "dark"), fmt(palette));
}

const lightColors = new Map(); // width -> the composer's light colors, compared in the dark pass

// ---------- one pass: width x scheme ----------

async function pass(p, ids) {
	const label = `${p.width} ${p.scheme}`;
	const wide = p.width >= 720; // the split view: /s/<sid> lands on /?s=<sid> with the thread in an iframe
	const cx = p.width / 2;
	const cy = p.height / 2;
	await view.navigate("about:blank");
	await metrics(p);

	// ===== / : palette, header heights, pick mode =====
	await open("/");
	await waitFor(LIST_READY, 15000, `list ready at ${label}`);
	if (wide) await waitFor(SPLIT_READY, 15000, `split frame ready at ${label}`);
	await waitFor(BADGE_SHOWN("document", "issueBadge"), 15000, `제보함 badge at ${label}`);
	await settle();
	paletteCheck(label, "/", await ev(PALETTE("document")), p.scheme);
	heightCheck(label, "/ (#reportLink vs #issuesLink)", await ev(HEIGHTS("document", "#reportLink", "#issuesLink")));
	const entry = await centerOf("document", "#reportLink");
	await press(p, entry.cx, entry.cy);
	await waitFor(`${TOOLBAR} !== null`, 10000, `pick toolbar at ${label}`);
	await settle();
	let under = null;
	if (!p.touch) {
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
		await settle();
		under = await ev(BOX);
	}
	if (under === null) under = await ev(UNDER_CENTER);
	const toolbar = await ev(TOOLBAR);
	check(
		`L5 (${label}) /: the pick toolbar does not cover the element under the pointer at the screen center`,
		Boolean(toolbar) && Boolean(under) && !inside(under, toolbar) && !contains(toolbar, cx, cy) && (p.touch || under.via === "box"),
		fmt({ toolbar, under, center: { x: cx, y: cy } }),
	);
	const cancel = await ev(CONTROLS(`document.querySelector("[data-report-overlay] [role='toolbar']")`));
	check(`L2 (${label}) /: the pick toolbar's 취소 is at least 44x44`, tapOk(cancel), fmt(cancel));
	let scroll = await ev(SCROLL);
	check(`L3 (${label}) pick: no horizontal overflow (scrollWidth <= innerWidth)`, scroll.sw <= scroll.iw, fmt(scroll));
	await shot(`pick-${p.width}-${p.scheme}.png`);

	// ===== /s/<sid> : palette, tool heights, bubble foot heights, the composer with a picture =====
	await open(`/s/${encodeURIComponent(A)}`);
	if (wide) {
		const landed = await waitLoc((l) => l.path === "/" && l.search === `?s=${A}`, 10000);
		if (!landed.ok) throw new Error(`/s/${A} did not land on /?s=${A} at ${label}: ${fmt(landed)}`);
		await waitFor(LIST_READY, 15000, `list ready for /?s= at ${label}`);
	}
	const D = DOC(wide);
	await waitFor(CHAT_READY(D), 15000, `thread ready at ${label}`);
	await waitFor(BADGE_SHOWN(D, "issuesBadge"), 15000, `thread 제보함 badge at ${label}`);
	await settle();
	paletteCheck(label, "/s/<sid>", await ev(PALETTE(D)), p.scheme);
	heightCheck(label, "/s/<sid> ([data-issue-report] vs the 제보함 .tool)", await ev(HEIGHTS(D, ".tools .tool[data-issue-report]", ".tools .tool[href='/issues']")));
	heightCheck(label, "/s/<sid> bubble foot (제보 vs 더 쉽게)", await ev(HEIGHTS(D, ".foot [data-action='report']", ".foot [data-action='explain']")));
	const foot = await ev(FOOT_TARGET(D));
	if (!foot) throw new Error(`no bubble 제보 button at ${label}`);
	await settle();
	const offset = wide ? await ev(FRAME_OFFSET) : { x: 0, y: 0 };
	await press(p, foot.cx + offset.x, foot.cy + offset.y);
	await waitFor(`${DIALOG} !== null`, 10000, `composer open at ${label}`);
	await waitFor(`(() => { const s = ${PICTURE}; return s && s.caption !== ${JSON.stringify(PICTURE_PENDING)} && (s.caption !== ${JSON.stringify(PICTURE_DRAWN)} || s.decoded); })()`, 20000, `picture settled at ${label}`);
	await settle();
	const picture = await ev(PICTURE);
	check(
		`(${label}) /s/<sid>: the bubble's 제보 opens the composer with the redrawn picture (caption ${PICTURE_DRAWN}, thumb decoded)`,
		Boolean(picture) && picture.caption === PICTURE_DRAWN && picture.thumbShown && picture.decoded && picture.h > 0,
		fmt(picture),
	);
	// The redraw must be the bubble: its width:height is the padded bubble box's (+-15%), not a sliver of a squeezed layout.
	const expectAspect = foot.expect.w / foot.expect.h;
	const gotAspect = picture && picture.natural && picture.natural[1] > 0 ? picture.natural[0] / picture.natural[1] : null;
	check(
		`(${label}) /s/<sid>: the redrawn picture has the bubble's shape (natural width:height within 15% of the padded bubble box)`,
		typeof gotAspect === "number" && Math.abs(gotAspect - expectAspect) / expectAspect <= 0.15,
		fmt({ natural: picture && picture.natural, bubble: foot.bubble, expect: foot.expect, expectAspect, gotAspect }),
	);
	const composerControls = await ev(CONTROLS(DIALOG));
	check(`L2 (${label}) composer: every button/link is at least 44x44`, tapOk(composerControls), fmt({ count: Array.isArray(composerControls) ? composerControls.length : null, short: shortOnes(composerControls) }));
	scroll = await ev(SCROLL);
	check(`L3 (${label}) composer: no horizontal overflow (scrollWidth <= innerWidth)`, scroll.sw <= scroll.iw, fmt(scroll));
	const colors = await ev(COMPOSER_COLORS);
	if (p.scheme === "light") lightColors.set(p.width, colors);
	else {
		const light = lightColors.get(p.width);
		check(
			`L4 (${label}) composer: dark background and text colors differ from the light pass`,
			Boolean(colors) && Boolean(light) && colors.bg !== light.bg && colors.ink !== light.ink,
			fmt({ light, dark: colors }),
		);
		check(`L4 (${label}) composer: status text contrast ratio >= ${CONTRAST_MIN}`, Boolean(colors) && typeof colors.ratio === "number" && colors.ratio >= CONTRAST_MIN, fmt({ statusColor: colors && colors.statusColor, statusBg: colors && colors.statusBg, ratio: colors && colors.ratio }));
	}
	await shot(`composer-${p.width}-${p.scheme}.png`);

	// ===== /issues : the three states, control sizes =====
	await open("/issues");
	await waitFor(
		`(() => { const app = document.getElementById("app"); const rows = [...document.querySelectorAll("#list .row")]; const states = new Set(rows.map((r) => r.dataset.state)); const thumb = document.querySelector("#list .thumb"); return app && app.getAttribute("aria-busy") === "false" && rows.length >= 3 && states.has("pending") && states.has("failed") && states.has("sent") && Boolean(thumb) && thumb.complete && thumb.naturalWidth > 0 && /열림/.test((document.querySelector('#list .row[data-state="sent"] .state') || {}).textContent || ""); })()`,
		20000,
		`제보함 rows at ${label}`,
	);
	await settle();
	const rows = await ev(`[...document.querySelectorAll("#list .row")].map((r) => ({ state: r.dataset.state, title: (r.querySelector(".title") || {}).textContent, text: (r.querySelector(".state") || {}).textContent, actions: [...r.querySelectorAll(".row-actions button")].map((b) => b.textContent), thumb: Boolean(r.querySelector(".thumb")), link: Boolean(r.querySelector(".title a")) }))`);
	const byState = Object.fromEntries(rows.map((r) => [r.state, r]));
	check(
		`(${label}) /issues: pending reads GitHub로 보내는 중, failed reads 보내지 못했습니다 · ${FAILED_DETAIL} with 다시 시도, sent reads #1 열림 with 처리 맡기기, a link and a thumbnail`,
		rows.length === 3 &&
			byState.pending?.text === "GitHub로 보내는 중" &&
			byState.failed?.text === `보내지 못했습니다 · ${FAILED_DETAIL}` &&
			byState.failed?.actions.join() === "다시 시도" &&
			byState.sent?.text === "#1 열림" &&
			byState.sent?.actions.join() === "처리 맡기기" &&
			byState.sent?.link === true &&
			byState.sent?.thumb === true,
		fmt(rows),
	);
	const listControls = await ev(CONTROLS("document"));
	check(`L2 (${label}) /issues: every button/link is at least 44x44`, tapOk(listControls), fmt({ count: Array.isArray(listControls) ? listControls.length : null, short: shortOnes(listControls) }));
	scroll = await ev(SCROLL);
	check(`L3 (${label}) issues: no horizontal overflow (scrollWidth <= innerWidth)`, scroll.sw <= scroll.iw, fmt(scroll));
	await shot(`issues-${p.width}-${p.scheme}.png`);

	// ===== /issues/new : the text-only composer =====
	await open("/issues/new");
	await waitFor("document.getElementById('app') && document.getElementById('app').getAttribute('aria-busy') === 'false' && document.getElementById('description') && document.getElementById('send')", 15000, `/issues/new at ${label}`);
	await settle();
	const newControls = await ev(CONTROLS("document"));
	check(`L2 (${label}) /issues/new: every button/link is at least 44x44`, tapOk(newControls), fmt({ count: Array.isArray(newControls) ? newControls.length : null, short: shortOnes(newControls) }));
	scroll = await ev(SCROLL);
	check(`L3 (${label}) new: no horizontal overflow (scrollWidth <= innerWidth)`, scroll.sw <= scroll.iw, fmt(scroll));
	await shot(`new-${p.width}-${p.scheme}.png`);

	// ===== /boards and /p/<id> : .back siblings =====
	await open("/boards");
	await waitFor("document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') === 'false'", 15000, `/boards at ${label}`);
	await waitFor(BADGE_SHOWN("document", "issueBadge"), 15000, `/boards 제보함 badge at ${label}`);
	await settle();
	heightCheck(label, "/boards (.back siblings)", await ev(HEIGHTS("document", ".tools .back[data-issue-report]", ".tools .back[href='/issues']")));

	await open(`/p/${encodeURIComponent(ids.boardId)}`);
	await waitFor("document.getElementById('title') && document.getElementById('title').textContent.trim() !== ''", 15000, `/p/<id> at ${label}`);
	await waitFor(BADGE_SHOWN("document", "issueBadge"), 15000, `/p/<id> 제보함 badge at ${label}`);
	await settle();
	heightCheck(label, "/p/<id> (.back siblings)", await ev(HEIGHTS("document", "nav.top .back[data-issue-report]", "nav.top .back[href='/issues']")));
}

// ---------- run ----------

try {
	server = await startInboxServer({ app: APP, port: PORT, home, env: { INBOX_GITHUB_API: fake.url, INBOX_GITHUB_TIMEOUT_MS: "600000" } });
	serverBase = server.base;
	const ids = await seed(serverBase);
	view = new Bun.WebView({ width: 1280, height: 800 });
	for (const p of PASSES) await pass(p, ids);
	const shots = fs.readdirSync(OUT).filter((name) => /^(pick|composer|issues|new)-(390|1280)-(light|dark)\.png$/.test(name));
	check("16 screenshots saved as <screen>-<width>-<scheme>.png", shots.length === 16, fmt({ count: shots.length }));
} catch (error) {
	exitError = error;
	check("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	try {
		if (view) await view.close();
	} catch {
		// already gone
	}
	try {
		if (server) await server.stop();
	} catch (error) {
		console.log(`cleanup: server stop failed: ${error && error.message ? error.message : error}`);
	}
	await fake.stop();
	if (board && board.dir) fs.rmSync(board.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`cleanup: server stopped, fake GitHub stopped, browser closed, temp removed ${!fs.existsSync(tmp)}; output in ${OUT}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed || exitError ? 1 : 0);
