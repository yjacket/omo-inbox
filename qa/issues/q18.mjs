/* Q18: Review revisions and the fullscreen viewer report through the page's own adapter.
 *
 * The real page (web/proposal.html + web/board.js) mounts web/issue-report.js from its closure:
 * nothing is injected here. The scenario seeds a one-revision decision Review and a one-revision
 * report Review through the fixture server's own API, then on `/p/<id>` at 390x844 light:
 *
 * Happy path: a mouse click on the frame opens the fullscreen viewer, a wheel zooms it, 표시하기 and
 * a drag draw one mark with a typed note, the viewer's own 제보 opens the composer (history gains
 * exactly the reporter token on top of the viewer entry), 첨부 확인 shows the frozen source
 * `Review <id> r1` with the open frame, the viewer flag and the zoom. While the composer stays
 * open, revision 2 is created through the fixture API and the page's next poll absorbs it without
 * repainting (one tab, no banner, capture still r1, typed text intact). Back closes only the
 * reporter (viewer open, marks kept, focus on the viewer's 제보, the deferred revision applied
 * once: two tabs and the banner); the next Back closes the viewer and restores the page. The
 * restored draft is sent and the stored issue names revision 1 with its frame while the Review is
 * at revision 2 and has no feedback event.
 *
 * Failure track: a display capture whose stream arrives after 초안 버리기 is dropped and its tracks
 * stopped (the wait is the editor's own track.stop() calls, hooked per track); with the viewer in
 * drawing mode and 첨부 확인 expanded, the target picker keeps its height and a touch tap on an option
 * chooses the target and draws no Review mark; a report sent from a closed Review and from an older revision leaves
 * data/proposals, data/threads and mailbox byte-identical and appends no Review event. Afterwards
 * the real 확인 with a comment (theirs, pending delivery, mailbox file) and the comment-less 확인
 * (closed, no delivery) keep their old semantics. Every wait is an awaited event (dialog close,
 * MutationObserver, PerformanceObserver, fs.watch) under a named 10 s deadline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { framePng } from "../frame.mjs";
import { decisionRev1, decisionRev2, reportRev1 } from "./fixture-data.mjs";

export const viewport = { width: 390, height: 844, scheme: "light" };

const DEADLINE_MS = 10_000;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const FRAME_LABEL = "제보 버튼";
const DESCRIPTION = "뷰어에서 1안 그림을 확대하면 표시가 어긋납니다";
const CLOSED_DESCRIPTION = "끝난 Review에서 보내는 제보입니다";
const OLDER_DESCRIPTION = "지난 안에서 보내는 제보입니다";
const MARK_NOTE = "버튼이 잘립니다";
const ACK_COMMENT = "확인했습니다";

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function writeBoard(root, name, board) {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(board));
	fs.writeFileSync(path.join(dir, "frame.png"), framePng());
	return dir;
}

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Sorted relative paths with the sha256 of every file under root; a missing root is an empty tree. */
function fingerprint(root) {
	const files = {};
	const walk = (dir) => {
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) files[path.relative(root, full).split(path.sep).join("/")] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
		}
	};
	walk(root);
	const digest = crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex");
	return { root, count: Object.keys(files).length, digest, files };
}

function diffFingerprints(before, after) {
	const added = Object.keys(after.files).filter((file) => !(file in before.files));
	const removed = Object.keys(before.files).filter((file) => !(file in after.files));
	const changed = Object.keys(after.files).filter((file) => file in before.files && before.files[file] !== after.files[file]);
	return { identical: before.digest === after.digest, added, removed, changed };
}

/** Resolve when predicate(root listing) returns non-null; fs.watch (recursive) under a named deadline. */
function waitForFiles(root, predicate, name, timeoutMs = DEADLINE_MS) {
	return new Promise((resolve, reject) => {
		let watcher = null;
		let timer = null;
		const done = (fn, value) => {
			clearTimeout(timer);
			watcher?.close();
			fn(value);
		};
		const test = () => {
			let value = null;
			try {
				value = predicate();
			} catch {
				value = null;
			}
			if (value !== null && value !== undefined && value !== false) done(resolve, value);
		};
		timer = setTimeout(() => {
			const error = new Error(`${name} did not settle within ${timeoutMs}ms`);
			error.name = `deadline:${name}`;
			done(reject, error);
		}, timeoutMs);
		fs.mkdirSync(root, { recursive: true });
		try {
			watcher = fs.watch(root, { recursive: true }, () => test());
			watcher.on("error", (error) => done(reject, error));
		} catch (error) {
			done(reject, error);
			return;
		}
		test();
	});
}

// ---------- page-side expressions ----------

/** A promise expression that resolves once `test()` returns a value; MutationObserver on the document, bounded. */
function waitForDom(testSource, name, timeoutMs = 9000) {
	return `new Promise((resolve, reject) => {
		const test = ${testSource};
		const probe = () => { try { const v = test(); return v === null || v === undefined || v === false ? null : v; } catch { return null; } };
		const first = probe();
		if (first !== null) { resolve(first); return; }
		const timer = setTimeout(() => { observer.disconnect(); reject(new Error(${JSON.stringify(name)} + " did not happen within ${timeoutMs}ms")); }, ${timeoutMs});
		const observer = new MutationObserver(() => { const v = probe(); if (v !== null) { clearTimeout(timer); observer.disconnect(); resolve(v); } });
		observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
	})`;
}

const PAGE_STATE = `(() => {
	const vb = window.__vb;
	const viewer = document.getElementById("viewer");
	const dialog = document.querySelector("#issue-report");
	const banner = document.getElementById("revBanner");
	const active = document.activeElement;
	const rect = (node) => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
	const report = document.getElementById("vReport");
	const headerReport = document.querySelector("nav.top a[data-issue-report]");
	const issuesLink = document.querySelector("nav.top a[href='/issues']");
	const badge = document.getElementById("issueBadge");
	return {
		path: location.pathname + location.search,
		history: history.state,
		historyLength: history.length,
		viewerHidden: viewer.hidden,
		viewer: { open: vb.viewer.open, label: vb.viewer.label, scale: vb.viewer.scale, drawing: vb.viewer.drawing, selected: Boolean(vb.viewer.selected) },
		marks: vb.marks.map((m) => ({ rev: m.rev, frame: m.frame, comment: m.comment, w: m.w, h: m.h })),
		marksList: document.querySelectorAll("#marks .mark").length,
		rev: vb.rev, latest: vb.latest, revs: vb.revs.map((r) => r.n), events: vb.events.map((e) => e.type), readOnly: vb.readOnly, closed: vb.closed,
		tabs: [...document.querySelectorAll("#tabs button")].map((b) => ({ text: b.textContent, selected: b.getAttribute("aria-selected") })),
		banner: { hidden: banner.hidden, text: document.getElementById("revBannerText").textContent },
		closedBanner: { hidden: document.getElementById("closedBanner").hidden, text: document.getElementById("closedBanner").textContent },
		oldNoteHidden: document.getElementById("oldNote").hidden,
		bodyLocked: document.body.classList.contains("viewer-open"),
		mainInert: document.querySelector("main").inert,
		sheetHidden: document.getElementById("vSheet").hidden,
		dialog: dialog ? { present: true, open: dialog.open, modal: dialog.matches(":modal"), status: dialog.dataset.status } : { present: false },
		active: active ? { id: active.id || null, tag: active.tagName, inViewer: viewer.contains(active), inDialog: Boolean(dialog && dialog.contains(active)) } : null,
		vReport: report ? { text: report.textContent, href: report.getAttribute("href"), rect: rect(report), hidden: report.hidden } : null,
		headerReport: headerReport ? { text: headerReport.textContent, href: headerReport.getAttribute("href"), rect: rect(headerReport) } : null,
		issuesLink: issuesLink ? { text: issuesLink.textContent.trim(), href: issuesLink.getAttribute("href"), rect: rect(issuesLink) } : null,
		viewportWidth: innerWidth,
		badge: badge ? { hidden: badge.hidden, text: badge.textContent } : null,
		ackHidden: document.getElementById("ackBtn") ? document.getElementById("ackBtn").hidden : "removed",
		comment: document.getElementById("comment").value,
		status: document.getElementById("status").textContent,
	};
})()`;

const REPORT_STATE = `(() => {
	const dialog = document.querySelector("#issue-report");
	if (!dialog) return { present: false };
	const list = document.querySelector("#issue-attach-list");
	const items = {};
	for (const value of list.querySelectorAll("[data-item]")) items[value.dataset.item] = value.textContent;
	const image = document.querySelector(".issue-image");
	const excerpt = document.querySelector("#issue-excerpt");
	const capture = document.querySelector("#issue-capture");
	return {
		present: true, open: dialog.open, modal: dialog.matches(":modal"), status: dialog.dataset.status,
		statusText: document.querySelector("#issue-status").textContent,
		text: document.querySelector("#issue-description").value,
		chip: document.querySelector("#issue-target-label").textContent,
		pickLabel: document.querySelector("#issue-target-pick").textContent,
		pickerHidden: document.querySelector("#issue-picker").hidden,
		options: [...document.querySelectorAll("#issue-picker [role=option]")].map((o) => o.textContent),
		summary: document.querySelector("#issue-attach-summary").textContent,
		listHidden: list.hidden,
		items,
		excerpt: excerpt ? { checked: excerpt.checked } : null,
		captureHidden: capture ? capture.hidden : null,
		image: image ? { state: image.dataset.state, status: image.querySelector(".issue-image__status") ? image.querySelector(".issue-image__status").textContent : null } : null,
		link: document.querySelector("#issue-link").getAttribute("href"),
		receiptHidden: document.querySelector("#issue-receipt").hidden,
		history: history.state,
		activeId: document.activeElement ? document.activeElement.id : null,
	};
})()`;

const DIALOG_CLOSE_WAIT = `window.__q18close = new Promise((resolve, reject) => {
	const dialog = document.querySelector("#issue-report");
	if (!dialog.open) { resolve("already-closed"); return; }
	const timer = setTimeout(() => reject(new Error("dialog did not close within 9000ms")), 9000);
	dialog.addEventListener("close", () => { clearTimeout(timer); resolve("closed"); }, { once: true });
}); true`;

const DIALOG_OPEN_WAIT = waitForDom("() => { const d = document.querySelector('#issue-report'); return d && d.open ? true : null; }", "dialog open");

/** The picker's own box against its options: a usable picker shows a whole option row whose center hits the option. */
const PICKER_GEOMETRY = `(() => {
	const picker = document.querySelector("#issue-picker");
	const pr = picker.getBoundingClientRect();
	const list = document.querySelector("#issue-attach-list");
	return {
		hidden: picker.hidden,
		attachmentsOpen: !list.hidden,
		rect: { x: pr.left, y: pr.top, w: pr.width, h: pr.height },
		clientHeight: picker.clientHeight,
		scrollHeight: picker.scrollHeight,
		options: [...picker.querySelectorAll("[role=option]")].map((option) => {
			const r = option.getBoundingClientRect();
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return { text: option.textContent, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, hit: hit ? hit.tagName + (hit.id ? "#" + hit.id : "") : null, hitInside: Boolean(hit && option.contains(hit)), visibleIntersection: Math.max(0, Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top)) };
		}),
	};
})()`;

/** 44 CSS px in both directions on the clickable element itself (plan Scope: new controls at every width). */
const tappable = (rect) => Boolean(rect) && rect.w >= 44 && rect.h >= 44;

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, pinQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const { identityFor } = await import(pathToFileURL(path.join(qaRoot(), "..", "src", "identity.mjs")).href);
	const history = [];
	const states = { viewport: { width, height, scheme }, stylesheet: null, seeds: {}, steps: {}, failures: {}, acks: {}, http: [] };
	const note = (step, detail) => history.push({ step, at: new Date().toISOString(), ...detail });
	const request = async (label, route, init = {}) => {
		const res = await fetch(ctx.base + route, { ...init, signal: AbortSignal.timeout(DEADLINE_MS) });
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		states.http.push({ label, method: init.method ?? "GET", route, status: res.status });
		return { status: res.status, body };
	};
	const get = (label, route) => request(label, route);
	const post = (label, route, body) => request(label, route, { method: "POST", headers: POST, body: JSON.stringify(body) });
	const evalIn = (page, expression, name) => withDeadline(page.evaluate(expression), DEADLINE_MS, name);
	const waitDom = (page, testSource, name) => evalIn(page, waitForDom(testSource, name), name);
	const cdp = async (page, method, params) => page.cdp.send(method, params, await page.resolveSessionId());
	const mouse = (page, type, x, y, extra = {}) => cdp(page, "Input.dispatchMouseEvent", { type, x, y, ...extra });
	const key = async (page, name, code, windowsVirtualKeyCode) => {
		await cdp(page, "Input.dispatchKeyEvent", { type: "keyDown", key: name, code, windowsVirtualKeyCode });
		await cdp(page, "Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode });
	};
	const shot = async (page, name) => {
		const bytes = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, `q18_shot_${name}`);
		const file = evidence(name, Buffer.from(bytes));
		note("screenshot", { file: name });
		return file;
	};
	// The bottom-anchored dialog shifts its content when an async status line appears; a tap needs the rect of a settled frame.
	const settledRectOf = async (page, selector, name) => {
		let last = await rectOf(page, selector);
		for (let attempt = 0; attempt < 6; attempt++) {
			await evalIn(page, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", name + "_frame");
			const next = await rectOf(page, selector);
			if (next && last && next.l === last.l && next.t === last.t && next.w === last.w && next.h === last.h) return next;
			last = next;
		}
		return last;
	};
	const rectOf = (page, selector) => evalIn(page, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`, `q18_rect_${selector}`);
	const roots = () => ({ proposals: path.join(ctx.home, "data", "proposals"), threads: path.join(ctx.home, "data", "threads"), mailbox: path.join(ctx.home, "mailbox") });
	const snapshotSources = () => Object.fromEntries(Object.entries(roots()).map(([name, root]) => [name, fingerprint(root)]));
	const sourceDiff = (before, after) => Object.fromEntries(Object.keys(before).map((name) => [name, diffFingerprints(before[name], after[name])]));
	const allIdentical = (diff) => Object.values(diff).every((entry) => entry.identical);
	// 첨부 확인 is a toggle on one dialog instance: open it only when its list is hidden.
	const openAttachments = async (page, name) => {
		const hidden = await evalIn(page, "document.querySelector('#issue-attach-list').hidden", name + "_probe");
		if (hidden) await withDeadline(page.click("#issue-attach-toggle"), DEADLINE_MS, name + "_click");
		await waitDom(page, "() => document.querySelector('#issue-attach-list').hidden ? null : true", name);
	};
	const framesSized = "() => { const canvases = [...document.querySelectorAll('#sections .frame canvas')]; return canvases.length > 0 && canvases.every((c) => c.width > 0) && document.querySelector('#issue-report') && document.getElementById('vReport') ? true : null; }";

	// ---- seed: a one-revision decision Review and a one-revision report Review ----
	const identity = { ...(await identityFor(ctx.home, {})), session: { id: "qa-owner", file: null } };
	const boardRoot = path.join(ctx.runTmp, "boards");
	const r1 = writeBoard(boardRoot, "q18-decision-r1", decisionRev1);
	const r2 = writeBoard(boardRoot, "q18-decision-r2", decisionRev2);
	const reportDir = writeBoard(boardRoot, "q18-report-r1", reportRev1);
	// The store refuses a second open board with the fixture's identity and title; these carry their own titles.
	const created = await post("create-decision", "/api/proposals", { cwd: r1, identity, srcDir: r1, title: "Q18 제보 흐름 결정" });
	const id = created.body?.summary?.id;
	const createdReport = await post("create-report", "/api/proposals", { cwd: reportDir, identity, srcDir: reportDir, title: "Q18 제보 기능 완료 보고" });
	const reportId = createdReport.body?.summary?.id;
	states.seeds = { decision: created.body?.summary ?? created.body, report: createdReport.body?.summary ?? createdReport.body };
	check("Q18 seeds a one-revision decision Review and a one-revision report Review", created.status === 200 && typeof id === "string" && created.body.summary.rev === 1 && createdReport.status === 200 && typeof reportId === "string" && createdReport.body.summary.kind === "report", JSON.stringify({ created: created.status, id, report: createdReport.status, reportId }));
	const submittedHash = (await get("detail-initial", `/api/p/${encodeURIComponent(id)}`)).body?.events?.find((event) => event.type === "submitted")?.hash ?? null;
	// The composer stylesheet this run exercised: the worktree file and the bytes the fixture server actually served.
	const stylesheetPath = path.join(qaRoot(), "..", "web", "issue-report.css");
	const servedStylesheet = await fetch(`${ctx.base}/web/issue-report.css`, { signal: AbortSignal.timeout(DEADLINE_MS) });
	states.stylesheet = { path: stylesheetPath, sha256: sha256(fs.readFileSync(stylesheetPath)), servedSha256: sha256(Buffer.from(await servedStylesheet.arrayBuffer())), servedStatus: servedStylesheet.status };
	note("stylesheet", states.stylesheet);
	check("Q18 the served web/issue-report.css is the worktree file (sha256 recorded for this run)", servedStylesheet.status === 200 && states.stylesheet.sha256 === states.stylesheet.servedSha256, JSON.stringify(states.stylesheet));

	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q18_new_page");
	try {
		// A phone has touch: emulated from the first document on, so the later touch taps reach the renderer with its input mode settled.
		await cdp(page, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		// ---- the page with its own entries ----
		await withDeadline(page.goto(`${ctx.base}/p/${encodeURIComponent(id)}`, { waitUntil: "load" }), DEADLINE_MS, "q18_goto");
		await waitDom(page, framesSized, "q18_frames_sized");
		const loaded = await evalIn(page, PAGE_STATE, "q18_loaded");
		states.steps.loaded = loaded;
		note("loaded", { history: loaded.history, path: loaded.path });
		check(`Q18 the header has 제보함 (/issues, badge hidden) and 제보 (/issues/new), each at least 44x44 CSS px at ${width}px, and the reporter is mounted`, loaded.viewportWidth === width && loaded.issuesLink?.href === "/issues" && loaded.issuesLink.text === "제보함" && loaded.badge?.hidden === true && loaded.headerReport?.href === "/issues/new" && loaded.headerReport.text === "제보" && tappable(loaded.headerReport.rect) && tappable(loaded.issuesLink.rect) && loaded.dialog.present && !loaded.dialog.open, JSON.stringify({ viewportWidth: loaded.viewportWidth, issuesLink: loaded.issuesLink, headerReport: loaded.headerReport, badge: loaded.badge, dialog: loaded.dialog }));
		check("Q18 the page shows revision 1 as the only tab, no marks, no banner", loaded.tabs.length === 1 && loaded.tabs[0].selected === "true" && loaded.rev === 1 && loaded.marks.length === 0 && loaded.banner.hidden === true && loaded.history === null, JSON.stringify({ tabs: loaded.tabs, rev: loaded.rev, history: loaded.history }));

		// ---- open the frame in the viewer with a mouse click ----
		await evalIn(page, "document.querySelector('#sections .frame').scrollIntoView({ block: 'center' }); true", "q18_scroll_frame");
		const canvas = await rectOf(page, "#sections .frame canvas");
		await mouse(page, "mouseMoved", canvas.cx, canvas.cy);
		await mouse(page, "mousePressed", canvas.cx, canvas.cy, { button: "left", buttons: 1, clickCount: 1 });
		await mouse(page, "mouseReleased", canvas.cx, canvas.cy, { button: "left", buttons: 0, clickCount: 1 });
		await waitDom(page, "() => document.getElementById('viewer').hidden ? null : true", "q18_viewer_open");
		const opened = await evalIn(page, PAGE_STATE, "q18_viewer_opened");
		states.steps.viewerOpened = opened;
		note("viewer-open", { history: opened.history, label: opened.viewer.label });
		const viewerToken = opened.history && opened.history.vbViewer;
		check(`Q18 a click on the frame opens the viewer with its own history entry and a 제보 action in .vbar of at least 44x44 CSS px at ${width}px`, opened.viewer.open && !opened.viewerHidden && opened.viewer.label === FRAME_LABEL && Number.isInteger(viewerToken) && opened.bodyLocked && opened.mainInert && opened.vReport && opened.vReport.text === "제보" && opened.vReport.href === "/issues/new" && !opened.vReport.hidden && tappable(opened.vReport.rect), JSON.stringify({ viewer: opened.viewer, history: opened.history, vReport: opened.vReport }));

		// ---- zoom with the wheel, draw one mark with 표시하기, type its note ----
		const stage = await rectOf(page, "#vStage");
		await mouse(page, "mouseMoved", stage.cx, stage.cy);
		await cdp(page, "Input.dispatchMouseEvent", { type: "mouseWheel", x: stage.cx, y: stage.cy, deltaX: 0, deltaY: -400 });
		const zoomed = await waitDom(page, "() => window.__vb.viewer.scale > 1.2 ? window.__vb.viewer.scale : null", "q18_zoomed");
		// The capture carries the viewer zoom to two decimals.
		const zoomShown = Math.round(zoomed * 100) / 100;
		await withDeadline(page.click("#vDraw"), DEADLINE_MS, "q18_click_draw");
		await waitDom(page, "() => window.__vb.viewer.drawing ? true : null", "q18_drawing_on");
		const img = await rectOf(page, "#vImg");
		const x0 = Math.max(stage.l + 4, img.l + img.w * 0.2);
		const y0 = Math.max(stage.t + 4, img.t + img.h * 0.3);
		const x1 = Math.min(stage.l + stage.w - 4, img.l + img.w * 0.6);
		const y1 = Math.min(stage.t + stage.h - 4, img.t + img.h * 0.6);
		await mouse(page, "mouseMoved", x0, y0);
		await mouse(page, "mousePressed", x0, y0, { button: "left", buttons: 1, clickCount: 1 });
		await mouse(page, "mouseMoved", (x0 + x1) / 2, (y0 + y1) / 2, { button: "left", buttons: 1 });
		await mouse(page, "mouseMoved", x1, y1, { button: "left", buttons: 1 });
		await mouse(page, "mouseReleased", x1, y1, { button: "left", buttons: 0, clickCount: 1 });
		await waitDom(page, "() => window.__vb.marks.length === 1 && !document.getElementById('vSheet').hidden ? true : null", "q18_mark_drawn");
		await cdp(page, "Input.insertText", { text: MARK_NOTE });
		const marked = await evalIn(page, PAGE_STATE, "q18_marked");
		states.steps.marked = { ...marked, zoomed };
		note("zoom-and-mark", { scale: marked.viewer.scale, marks: marked.marks });
		check("Q18 the wheel zooms the picture and one 표시하기 drag draws exactly one mark on revision 1 with its typed note", zoomed > 1.2 && marked.viewer.scale === zoomed && marked.marks.length === 1 && marked.marks[0].rev === 1 && marked.marks[0].frame === FRAME_LABEL && marked.marks[0].comment === MARK_NOTE && marked.viewer.drawing === false && marked.marksList === 1, JSON.stringify({ zoomed, marks: marked.marks, drawing: marked.viewer.drawing }));
		await shot(page, "Q18-viewer.png");

		// ---- the viewer's 제보 opens the composer over the viewer ----
		await withDeadline(page.click("#vReport"), DEADLINE_MS, "q18_click_vreport");
		await evalIn(page, DIALOG_OPEN_WAIT, "q18_reporter_open");
		const justOpened = await evalIn(page, REPORT_STATE, "q18_reporter_just_opened");
		await openAttachments(page, "q18_attach_list");
		const reporter = await evalIn(page, REPORT_STATE, "q18_reporter_state");
		const overViewer = await evalIn(page, PAGE_STATE, "q18_page_under_reporter");
		states.steps.reporterOpen = { reporter, page: overViewer };
		note("reporter-open", { history: reporter.history, source: reporter.items.source });
		const reporterToken = reporter.history && reporter.history.issueReport;
		check("Q18 the reporter's history entry keeps the viewer token and adds exactly its own", typeof reporterToken === "string" && reporter.history.vbViewer === viewerToken && Object.keys(reporter.history).sort().join() === "issueReport,vbViewer", JSON.stringify(reporter.history));
		check("Q18 the composer is modal over the open viewer, focused on the description, with the viewer and its mark untouched", justOpened.open && justOpened.modal && justOpened.activeId === "issue-description" && overViewer.viewer.open && !overViewer.viewerHidden && overViewer.marks.length === 1 && overViewer.viewer.scale === zoomed, JSON.stringify({ open: justOpened.open, modal: justOpened.modal, active: justOpened.activeId, viewer: overViewer.viewer }));
		check("Q18 첨부 확인 names the frozen source Review <id> r1 (also the target chip) with the viewer flag, the zoom and the frame excerpt", reporter.items.source === `Review ${id} r1` && reporter.chip === `Review ${id} r1` && /뷰어/.test(reporter.items.view ?? "") && (reporter.items.view ?? "").includes(`배율 ${zoomShown}`) && (reporter.items.excerpt ?? "").includes(FRAME_LABEL) && (reporter.items.excerpt ?? "").includes(MARK_NOTE) && reporter.excerpt?.checked === true, JSON.stringify({ chip: reporter.chip, ...reporter.items }));
		await shot(page, "Q18-reporter.png");
		await withDeadline(page.fill("#issue-description", DESCRIPTION), DEADLINE_MS, "q18_fill_description");

		// ---- revision 2 arrives while the composer is open: absorbed, not painted, capture unchanged ----
		const revised = await post("revise", `/api/p/${encodeURIComponent(id)}/revise`, { srcDir: r2, session: { id: "qa-owner" }, note: "두 번째 안" });
		check("Q18 the fixture API creates revision 2 while the composer is open", revised.status === 200 && revised.body?.summary?.rev === 2, JSON.stringify({ status: revised.status, rev: revised.body?.summary?.rev }));
		const polled = await evalIn(page, `new Promise((resolve, reject) => {
			const since = performance.now();
			const wanted = ${JSON.stringify(`/api/p/${encodeURIComponent(id)}?since=`)};
			const timer = setTimeout(() => { observer.disconnect(); reject(new Error("no poll completed after the revise within 9000ms")); }, 9000);
			const observer = new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) {
					if (entry.name.includes(wanted) && entry.startTime >= since) { clearTimeout(timer); observer.disconnect(); resolve({ name: entry.name, startTime: entry.startTime, since }); return; }
				}
			});
			observer.observe({ type: "resource", buffered: false });
		})`, "q18_poll_after_revise");
		const deferred = await evalIn(page, PAGE_STATE, "q18_deferred_state");
		const deferredReporter = await evalIn(page, REPORT_STATE, "q18_deferred_reporter");
		states.steps.deferred = { polled, page: deferred, reporter: deferredReporter };
		note("revision-2-absorbed", { revs: deferred.revs, tabs: deferred.tabs.length, banner: deferred.banner });
		check("Q18 the poll after the revise is absorbed (state knows revision 2) but not painted while the composer is open: one tab, no banner", deferred.revs.join() === "1,2" && deferred.latest === 2 && deferred.events.includes("revised") && deferred.tabs.length === 1 && deferred.banner.hidden === true && deferred.rev === 1, JSON.stringify({ polled: polled.name, revs: deferred.revs, latest: deferred.latest, tabs: deferred.tabs, banner: deferred.banner }));
		check("Q18 the frozen capture still names revision 1 and the typed text survived the queued update", deferredReporter.items.source === `Review ${id} r1` && deferredReporter.text === DESCRIPTION && deferredReporter.open, JSON.stringify({ source: deferredReporter.items.source, text: deferredReporter.text }));

		// ---- Back closes only the reporter; the deferred revision paints once; viewer and marks persist ----
		await evalIn(page, DIALOG_CLOSE_WAIT, "q18_arm_close");
		await evalIn(page, `window.__q18tabs = ${waitForDom("() => document.querySelectorAll('#tabs button').length === 2 ? true : null", "two tabs after close")}; true`, "q18_arm_tabs");
		// Listeners registered after the page's and the reporter's: they record what the reporter's capture handler let through.
		await evalIn(page, `(() => {
			window.__q18pop = [];
			const snap = (phase) => ({ phase, viewerOpen: window.__vb.viewer.open, dialogOpen: document.querySelector("#issue-report").open, state: JSON.stringify(history.state) });
			window.addEventListener("popstate", () => window.__q18pop.push(snap("late-bubble")));
			window.addEventListener("popstate", () => window.__q18pop.push(snap("late-capture")), true);
			return true;
		})()`, "q18_arm_pop_probe");
		await evalIn(page, "history.back(); true", "q18_back_1");
		const closedHow = await evalIn(page, "window.__q18close", "q18_reporter_closed");
		await evalIn(page, "window.__q18tabs", "q18_tabs_painted");
		const popProbe = await evalIn(page, "window.__q18pop", "q18_pop_probe");
		const afterBack1 = await evalIn(page, PAGE_STATE, "q18_after_back_1");
		states.steps.afterBack1 = { closedHow, popProbe, page: afterBack1 };
		note("popstate-probe", { popProbe });
		note("back-1", { history: afterBack1.history, viewerOpen: afterBack1.viewer.open, tabs: afterBack1.tabs.length, active: afterBack1.active });
		check("Q18 Back closes only the reporter: the viewer stays open with its mark and zoom, focus returns to the viewer's 제보, the viewer token is current again", closedHow === "closed" && !afterBack1.dialog.open && afterBack1.viewer.open && !afterBack1.viewerHidden && afterBack1.marks.length === 1 && afterBack1.viewer.scale === zoomed && afterBack1.history && afterBack1.history.vbViewer === viewerToken && afterBack1.history.issueReport === undefined && afterBack1.active?.id === "vReport", JSON.stringify({ closedHow, dialog: afterBack1.dialog, viewer: afterBack1.viewer, history: afterBack1.history, active: afterBack1.active }));
		check("Q18 the deferred revision paints once after the composer closes: two tabs, the 2안 banner, revision 1 still selected", afterBack1.tabs.length === 2 && afterBack1.tabs[0].selected === "true" && afterBack1.tabs[1].text === "2안" && afterBack1.banner.hidden === false && afterBack1.banner.text === "새 안(2안)이 올라왔습니다." && afterBack1.rev === 1, JSON.stringify({ tabs: afterBack1.tabs, banner: afterBack1.banner, rev: afterBack1.rev }));
		await shot(page, "Q18-viewer-back.png");

		// ---- the next Back closes the viewer and restores the page ----
		await evalIn(page, `window.__q18viewer = ${waitForDom("() => document.getElementById('viewer').hidden ? true : null", "viewer closed")}; true`, "q18_arm_viewer_close");
		await evalIn(page, "history.back(); true", "q18_back_2");
		await evalIn(page, "window.__q18viewer", "q18_viewer_closed");
		// The hidden viewer's focused 제보 is blurred by the focus fixup at the next rendering update.
		await evalIn(page, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))", "q18_focus_fixup");
		const afterBack2 = await evalIn(page, PAGE_STATE, "q18_after_back_2");
		states.steps.afterBack2 = afterBack2;
		note("back-2", { history: afterBack2.history, viewerOpen: afterBack2.viewer.open, path: afterBack2.path });
		// The viewer was opened by a real mouse click on the frame canvas, which is not focusable: pressing on it moved focus to
		// body before the viewer recorded its opener, so there is nothing to restore and focus ends on body, outside the viewer.
		check("Q18 the second Back closes the viewer as before: page unlocked, main interactive, mark kept in 표시한 곳, history back at the page entry; opened from the non-focusable canvas, focus ends on body (not in the hidden viewer)", !afterBack2.viewer.open && afterBack2.viewerHidden && !afterBack2.bodyLocked && afterBack2.mainInert === false && afterBack2.marks.length === 1 && afterBack2.marksList === 1 && afterBack2.history === null && afterBack2.path === `/p/${encodeURIComponent(id)}` && afterBack2.active && !afterBack2.active.inDialog && !afterBack2.active.inViewer && afterBack2.active.tag === "BODY" && afterBack2.active.id === null && afterBack2.tabs.length === 2 && afterBack2.rev === 1, JSON.stringify({ viewer: afterBack2.viewer, locked: afterBack2.bodyLocked, inert: afterBack2.mainInert, marks: afterBack2.marksList, history: afterBack2.history, path: afterBack2.path, active: afterBack2.active }));
		await shot(page, "Q18-revision.png");

		// ---- a focusable opener: the viewer gives focus back to the element that had it when the frame was tapped ----
		// Real presses on the canvas move focus to body first, so the frame's own touch-tap path (pointerdown/pointerup, then
		// click; board.js opens on the click) is driven with DOM events, which cannot move focus: the header 제보함 link stays
		// the active element the viewer records as its opener.
		await evalIn(page, `window.__q18viewerOpen = ${waitForDom("() => document.getElementById('viewer').hidden ? null : true", "viewer opened from a focused link")}; true`, "q18_arm_viewer_open_focus");
		const openerTap = await evalIn(page, `(() => {
			const link = document.querySelector("nav.top a[href='/issues']");
			link.focus({ preventScroll: true });
			const canvas = document.querySelector("#sections .frame canvas");
			const r = canvas.getBoundingClientRect();
			const init = { pointerId: 701, pointerType: "touch", isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true };
			const before = document.activeElement === link ? "issuesLink" : document.activeElement.tagName;
			canvas.dispatchEvent(new PointerEvent("pointerdown", init));
			canvas.dispatchEvent(new PointerEvent("pointerup", init));
			canvas.dispatchEvent(new MouseEvent("click", { clientX: init.clientX, clientY: init.clientY, bubbles: true, cancelable: true }));
			return { focusedBeforeTap: before, marks: window.__vb.marks.length };
		})()`, "q18_tap_from_focused_link");
		await evalIn(page, "window.__q18viewerOpen", "q18_viewer_open_focus");
		const openedFromLink = await evalIn(page, PAGE_STATE, "q18_opened_from_link");
		await evalIn(page, `window.__q18viewer = ${waitForDom("() => document.getElementById('viewer').hidden ? true : null", "viewer closed by Back (focused opener)")}; true`, "q18_arm_viewer_close_focus");
		await evalIn(page, "history.back(); true", "q18_back_focus");
		await evalIn(page, "window.__q18viewer", "q18_viewer_closed_focus");
		const restoredFocus = await evalIn(page, PAGE_STATE, "q18_focus_restored");
		const focusIsLink = await evalIn(page, "document.activeElement === document.querySelector(\"nav.top a[href='/issues']\")", "q18_focus_is_link");
		states.steps.focusableOpener = { openerTap, opened: { active: openedFromLink.active, history: openedFromLink.history, viewer: openedFromLink.viewer }, closed: { active: restoredFocus.active, focusIsLink, history: restoredFocus.history, viewer: restoredFocus.viewer, marks: restoredFocus.marks.length } };
		note("focusable-opener", states.steps.focusableOpener);
		check("Q18 a focusable opener gets focus back: with the header 제보함 link focused, the frame's touch-tap path opens the viewer (focus on the dialog) and Back closes it with focus returned to that very link, marks and history as before", openerTap.focusedBeforeTap === "issuesLink" && openerTap.marks === 1 && openedFromLink.viewer.open && openedFromLink.active?.id === "viewer" && Number.isInteger(openedFromLink.history?.vbViewer) && !restoredFocus.viewer.open && restoredFocus.viewerHidden && restoredFocus.active?.tag === "A" && restoredFocus.active.inViewer === false && focusIsLink === true && restoredFocus.history === null && restoredFocus.marks.length === 1 && !restoredFocus.bodyLocked, JSON.stringify(states.steps.focusableOpener));

		// ---- the restored draft is sent: the issue names revision 1 while the Review is at revision 2 ----
		const mailboxBefore = fingerprint(roots().mailbox);
		await withDeadline(page.click("nav.top a[data-issue-report]"), DEADLINE_MS, "q18_click_header_report");
		await evalIn(page, DIALOG_OPEN_WAIT, "q18_reporter_reopen");
		await waitDom(page, `() => document.querySelector('#issue-description').value === ${JSON.stringify(DESCRIPTION)} ? true : null`, "q18_draft_restored");
		await openAttachments(page, "q18_attach_list_2");
		const restored = await evalIn(page, REPORT_STATE, "q18_restored_state");
		states.steps.restored = restored;
		check("Q18 the header 제보 restores the draft with its text and the revision-1 capture (the page now has revision 2)", restored.open && restored.text === DESCRIPTION && restored.items.source === `Review ${id} r1`, JSON.stringify({ text: restored.text, source: restored.items.source }));
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q18_send");
		await waitDom(page, "() => document.querySelector('#issue-status').textContent === '접수했습니다' ? true : null", "q18_accepted");
		const sent = await evalIn(page, REPORT_STATE, "q18_sent_state");
		const issueId = typeof sent.link === "string" && sent.link.startsWith("/issues/") ? sent.link.slice("/issues/".length) : null;
		const detail = await get("issue-detail", `/api/issues/${issueId}`);
		const proposalAfter = await get("proposal-after-report", `/api/p/${encodeURIComponent(id)}`);
		const mailboxAfter = fingerprint(roots().mailbox);
		states.steps.sent = { sent, issue: detail.body, proposal: { summary: proposalAfter.body?.summary, events: proposalAfter.body?.events?.map((event) => ({ seq: event.seq, type: event.type, rev: event.rev })) }, mailboxDiff: diffFingerprints(mailboxBefore, mailboxAfter) };
		note("sent", { issueId, source: detail.body?.issue?.source });
		const source = detail.body?.issue?.source;
		check("Q18 the stored issue names revision 1 with the open frame and the recorded content hash while the Review is at revision 2", detail.status === 200 && source?.kind === "proposal" && source.proposalId === id && source.revision === 1 && source.frame?.label === FRAME_LABEL && source.frame?.path === "frame.png" && source.recordedContentHash === submittedHash && proposalAfter.body?.summary?.rev === 2, JSON.stringify({ status: detail.status, source, submittedHash, rev: proposalAfter.body?.summary?.rev }));
		const evidence0 = Array.isArray(detail.body?.evidence) ? detail.body.evidence[0] : null;
		check("Q18 the issue's reference check reads matched against the stored revision and the view says the viewer was open at the zoom", evidence0?.referenceCheck?.status === "matched" && evidence0?.context?.view?.viewerOpen === true && evidence0?.context?.view?.scale === zoomShown && evidence0?.context?.excerpt?.includes(MARK_NOTE), JSON.stringify({ reference: evidence0?.referenceCheck, view: evidence0?.context?.view, excerpt: evidence0?.context?.excerpt }));
		check("Q18 the report appended no Review event and wrote no mailbox file", proposalAfter.body?.events?.map((event) => event.type).join() === "submitted,revised" && states.steps.sent.mailboxDiff.identical, JSON.stringify({ events: proposalAfter.body?.events?.map((event) => event.type), mailbox: states.steps.sent.mailboxDiff }));
		await evalIn(page, DIALOG_CLOSE_WAIT, "q18_arm_close_2");
		await withDeadline(page.click("#issue-close"), DEADLINE_MS, "q18_close_sent");
		await evalIn(page, "window.__q18close", "q18_sent_closed");
		const afterSent = await evalIn(page, PAGE_STATE, "q18_after_sent");
		check("Q18 닫기 after the receipt pops the reporter token and leaves the page where it was", !afterSent.dialog.open && afterSent.history === null && afterSent.path === `/p/${encodeURIComponent(id)}` && afterSent.marks.length === 1, JSON.stringify({ dialog: afterSent.dialog, history: afterSent.history, path: afterSent.path }));

		// ---- failure: a display capture completing after 초안 버리기 is dropped and its tracks stopped ----
		await withDeadline(page.click("nav.top a[data-issue-report]"), DEADLINE_MS, "q18_click_report_3");
		await evalIn(page, DIALOG_OPEN_WAIT, "q18_reporter_open_3");
		await withDeadline(page.click("#issue-new"), DEADLINE_MS, "q18_new_report");
		await waitDom(page, "() => document.querySelector('#issue-report').dataset.status === 'editing' ? true : null", "q18_new_editing");
		const fresh = await evalIn(page, REPORT_STATE, "q18_fresh_state");
		check("Q18 새 제보 starts an editing draft with 화면 캡처 available in this secure context", fresh.status === "editing" && fresh.text === "" && fresh.captureHidden === false, JSON.stringify({ status: fresh.status, captureHidden: fresh.captureHidden }));
		await evalIn(page, `(() => {
			const media = navigator.mediaDevices;
			const q = { original: media.getDisplayMedia, called: 0, constraints: null, tracks: null };
			q.late = new Promise((resolve) => { q.resolveLate = resolve; });
			media.getDisplayMedia = function (constraints) { q.called += 1; q.constraints = constraints; return q.late; };
			window.__q18media = q;
			return true;
		})()`, "q18_media_override");
		await withDeadline(page.click("#issue-capture"), DEADLINE_MS, "q18_click_capture");
		await waitDom(page, "() => document.querySelector('.issue-image').dataset.state === 'loading' ? true : null", "q18_capture_loading");
		await withDeadline(page.click("#issue-discard"), DEADLINE_MS, "q18_discard");
		await waitDom(page, "() => document.querySelector('#issue-discard-confirm').hidden ? null : true", "q18_discard_confirm");
		await withDeadline(page.click("#issue-discard-yes"), DEADLINE_MS, "q18_discard_yes");
		await waitDom(page, "() => document.querySelector('.issue-image').dataset.state === 'empty' ? true : null", "q18_capture_cancelled");
		const late = await evalIn(page, `(async () => {
			const q = window.__q18media;
			const canvas = document.createElement("canvas");
			canvas.width = 64; canvas.height = 48;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#ff2d55"; ctx.fillRect(0, 0, 64, 48);
			const stream = canvas.captureStream(5);
			q.tracks = stream.getTracks();
			const before = q.tracks.map((track) => track.readyState);
			// track.stop() fires no event on the stopped track, so the editor's own stop() call on every track is the signal:
			// each track's stop is hooked before the stream is handed over, and the wait ends when the last one ran (bounded).
			const stopCalls = [];
			const allStopped = Promise.all(q.tracks.map((track) => new Promise((resolve) => {
				const original = track.stop;
				track.stop = function () { const result = original.call(this); stopCalls.push({ id: this.id, readyState: this.readyState, imageState: document.querySelector(".issue-image").dataset.state }); resolve(true); return result; };
			})));
			const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("the editor did not stop the late stream's tracks within 9000ms")), 9000));
			q.resolveLate(stream);
			await Promise.race([allStopped, deadline]);
			navigator.mediaDevices.getDisplayMedia = q.original;
			const image = document.querySelector(".issue-image");
			return { called: q.called, constraints: q.constraints, before, stopCalls, after: q.tracks.map((track) => track.readyState), imageState: image.dataset.state, summary: document.querySelector("#issue-attach-summary").textContent, status: document.querySelector("#issue-report").dataset.status, text: document.querySelector("#issue-description").value, restored: navigator.mediaDevices.getDisplayMedia === q.original };
		})()`, "q18_late_capture");
		states.failures.lateCapture = late;
		note("late-capture", late);
		check("Q18 failure: the display capture that completes after 초안 버리기 is dropped (editor stays empty, no 사진 attached) and the editor stops every track of the late stream (awaited stop() calls, no fixed wait)", late.called === 1 && late.constraints?.video === true && late.constraints?.audio === false && late.before.length > 0 && late.before.every((state) => state === "live") && late.stopCalls.length === late.before.length && late.stopCalls.every((call) => call.readyState === "ended" && call.imageState === "empty") && late.after.every((state) => state === "ended") && late.imageState === "empty" && !late.summary.includes("사진") && late.status === "editing" && late.restored, JSON.stringify(late));

		// ---- failure: a touch tap in the picker chooses a target and draws no Review mark ----
		await evalIn(page, DIALOG_CLOSE_WAIT, "q18_arm_close_3");
		await key(page, "Escape", "Escape", 27);
		await evalIn(page, "window.__q18close", "q18_closed_by_escape");
		await evalIn(page, "document.querySelector('#sections .frame').scrollIntoView({ block: 'center' }); true", "q18_scroll_frame_2");
		const canvas2 = await rectOf(page, "#sections .frame canvas");
		await mouse(page, "mouseMoved", canvas2.cx, canvas2.cy);
		await mouse(page, "mousePressed", canvas2.cx, canvas2.cy, { button: "left", buttons: 1, clickCount: 1 });
		await mouse(page, "mouseReleased", canvas2.cx, canvas2.cy, { button: "left", buttons: 0, clickCount: 1 });
		await waitDom(page, "() => document.getElementById('viewer').hidden ? null : true", "q18_viewer_open_2");
		await withDeadline(page.click("#vDraw"), DEADLINE_MS, "q18_click_draw_2");
		await waitDom(page, "() => window.__vb.viewer.drawing ? true : null", "q18_drawing_on_2");
		const marksBefore = await evalIn(page, "window.__vb.marks.length", "q18_marks_before_touch");
		await withDeadline(page.click("#vReport"), DEADLINE_MS, "q18_click_vreport_2");
		await evalIn(page, DIALOG_OPEN_WAIT, "q18_reporter_open_4");
		// The long 첨부 확인 list stays open: the dialog body overflows at 390x844 and the picker must still keep its own height
		// (web/issue-report.css lays the body out in max-content rows; this run's sha256 is in states.stylesheet).
		await openAttachments(page, "q18_attach_open_for_picker");
		await withDeadline(page.click("#issue-target-pick"), DEADLINE_MS, "q18_open_picker");
		await waitDom(page, "() => document.querySelectorAll('#issue-picker [role=option]').length > 0 ? true : null", "q18_picker_options");
		const pickerState = await evalIn(page, REPORT_STATE, "q18_picker_state");
		// Synthesized touch points are offset by the page scroll in this headless build (mouse points are not); the viewer
		// covers the page, so scrolling it to the top changes nothing visible and makes both coordinate spaces agree.
		await evalIn(page, "window.scrollTo(0, 0); true", "q18_scroll_top");
		const option = await settledRectOf(page, "#issue-picker [role=option]", "q18_option_rect");
		const pickerGeometry = await evalIn(page, PICKER_GEOMETRY, "q18_picker_geometry");
		states.failures.pickerWithAttachments = { stylesheet: states.stylesheet, geometry: pickerGeometry };
		note("picker-with-attachments-open", { stylesheetSha256: states.stylesheet?.sha256, rect: pickerGeometry.rect, clientHeight: pickerGeometry.clientHeight, scrollHeight: pickerGeometry.scrollHeight, options: pickerGeometry.options.map((o) => ({ text: o.text, h: o.rect.h, hit: o.hit, hitInside: o.hitInside, visible: o.visibleIntersection })) });
		check("Q18 with 첨부 확인 expanded the target picker keeps its height: its box holds every 44px option row (no 10px strip) and each option's center hits the option itself", pickerGeometry.attachmentsOpen && !pickerGeometry.hidden && pickerGeometry.options.length === 2 && pickerGeometry.rect.h >= 88 && pickerGeometry.clientHeight >= pickerGeometry.scrollHeight - 1 && pickerGeometry.options.every((o) => o.rect.h >= 44 && o.visibleIntersection >= 44 && o.hitInside), JSON.stringify({ stylesheet: states.stylesheet?.sha256, geometry: pickerGeometry }));
		await shot(page, "Q18-picker.png");
		const atPoint = await evalIn(page, `(() => {
			const o = document.querySelector("#issue-picker [role=option]");
			const r = o.getBoundingClientRect();
			const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
			const name = (e) => e.tagName + (e.id ? "#" + e.id : "") + (e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : "");
			const d = document.querySelector("#issue-report").getBoundingClientRect();
			const v = window.visualViewport;
			const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return { t: b.top, h: b.height, l: b.left, w: b.width, display: s.display, visibility: s.visibility, pointerEvents: s.pointerEvents, position: s.position, inert: e.inert }; };
			return { rect: { l: r.left, t: r.top, w: r.width, h: r.height }, cx, cy, stack: document.elementsFromPoint(cx, cy).map(name), stackLeft: document.elementsFromPoint(r.left + 20, cy).map(name), picker: box("#issue-picker"), option: box("#issue-picker [role=option]"), label: box(".issue-report__label"), textarea: box("#issue-description"), target: box("#issue-target"), bodyBox: box(".issue-report__body"), bodyScroll: document.querySelector(".issue-report__body").scrollTop, dialog: { t: d.top, h: d.height }, innerHeight, scrollY, visual: v ? { h: v.height, top: v.offsetTop, scale: v.scale } : null, pickerModel: (() => { const u = document.querySelector("#issue-picker"); const s = getComputedStyle(u); const li = getComputedStyle(o); return { height: s.height, maxHeight: s.maxHeight, minHeight: s.minHeight, overflow: s.overflow, scrollHeight: u.scrollHeight, clientHeight: u.clientHeight, childCount: u.children.length, tap: s.getPropertyValue("--issue-tap"), li: { float: li.float, position: li.position, display: li.display, height: li.height, margin: li.margin } }; })() };
		})()`, "q18_element_at_point");
		await evalIn(page, `(() => {
			window.__q18touch = [];
			const log = (event) => window.__q18touch.push({ type: event.type, pointerType: event.pointerType ?? null, target: event.target && event.target.id ? "#" + event.target.id : event.target && event.target.getAttribute ? (event.target.getAttribute("role") || event.target.tagName) : String(event.target) });
			for (const type of ["touchstart", "touchend", "pointerdown", "pointerup", "click"]) document.addEventListener(type, log, true);
			return true;
		})()`, "q18_arm_touch_probe");
		await cdp(page, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: option.cx, y: option.cy, id: 0 }] });
		await cdp(page, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		await waitDom(page, `() => document.querySelector('#issue-picker').hidden && document.querySelector('#issue-target-label').textContent.includes(${JSON.stringify(FRAME_LABEL)}) ? document.querySelector('#issue-target-label').textContent : null`, "q18_target_chosen").catch((error) => { states.failures.touchPickError = String(error && error.message ? error.message : error); });
		// A drag on the covered viewer stage (above the bottom sheet, on the modal backdrop) must not reach the stage either.
		const dialogTop = await evalIn(page, "document.querySelector('#issue-report').getBoundingClientRect().top", "q18_dialog_top");
		const stage2 = await rectOf(page, "#vStage");
		const dragY = Math.max(stage2.t + 8, Math.min(stage2.t + 40, dialogTop - 80));
		await cdp(page, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: stage2.cx - 40, y: dragY, id: 0 }] });
		await cdp(page, "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: stage2.cx + 40, y: dragY + 30, id: 0 }] });
		await cdp(page, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		const touchProbe = await evalIn(page, "window.__q18touch", "q18_touch_probe");
		const picked = await evalIn(page, REPORT_STATE, "q18_picked_state");
		const pickedPage = await evalIn(page, PAGE_STATE, "q18_picked_page");
		states.failures.touchPick = { before: marksBefore, options: pickerState.options, option, atPoint, touchProbe, picked, page: pickedPage };
		note("touch-pick", { chip: picked.chip, marks: pickedPage.marks.length, drawing: pickedPage.viewer.drawing });
		check("Q18 failure: with 첨부 확인 still expanded the picker lists the open frame and its mark; a touch tap picks the frame and draws no Review mark even in drawing mode", pickerState.options.length === 2 && pickerState.options[0].includes(FRAME_LABEL) && pickerState.options[1].includes("표시 1") && pickerState.listHidden === false && picked.listHidden === false && picked.chip.includes(FRAME_LABEL) && picked.pickerHidden && pickedPage.marks.length === marksBefore && marksBefore === 1 && pickedPage.viewer.drawing === true && pickedPage.viewer.open && picked.open && touchProbe.some((entry) => entry.type === "click" && entry.target === "option"), JSON.stringify({ options: pickerState.options, attachmentsOpen: !picked.listHidden, chip: picked.chip, marks: pickedPage.marks.length, before: marksBefore, drawing: pickedPage.viewer.drawing, atPoint, option, touchProbe: touchProbe.slice(0, 8), error: states.failures.touchPickError ?? null }));
		if (!picked.pickerHidden) {
			await key(page, "Escape", "Escape", 27);
			await waitDom(page, "() => document.querySelector('#issue-picker').hidden ? true : null", "q18_picker_closed_by_escape");
			note("picker-escape", { reason: "the touch tap left the picker open; one Escape closed only the picker" });
		}
		await evalIn(page, DIALOG_CLOSE_WAIT, "q18_arm_close_4");
		await key(page, "Escape", "Escape", 27);
		await evalIn(page, "window.__q18close", "q18_closed_by_escape_2");
		const afterEscape = await evalIn(page, PAGE_STATE, "q18_after_escape");
		check("Q18 Escape closes only the reporter above the viewer; the viewer stays open with its mark", !afterEscape.dialog.open && afterEscape.viewer.open && !afterEscape.viewerHidden && afterEscape.marks.length === 1 && afterEscape.history && afterEscape.history.vbViewer !== undefined && afterEscape.history.issueReport === undefined && afterEscape.active?.id === "vReport", JSON.stringify({ dialog: afterEscape.dialog, viewer: afterEscape.viewer, history: afterEscape.history, active: afterEscape.active }));
		await evalIn(page, `window.__q18viewer = ${waitForDom("() => document.getElementById('viewer').hidden ? true : null", "viewer closed by 닫기")}; true`, "q18_arm_viewer_close_2");
		await withDeadline(page.click("#vClose"), DEADLINE_MS, "q18_vclose");
		await evalIn(page, "window.__q18viewer", "q18_viewer_closed_2");
		const afterClose = await evalIn(page, PAGE_STATE, "q18_after_vclose");
		check("Q18 닫기 closes the viewer and steps back over its history entry as before", !afterClose.viewer.open && afterClose.viewerHidden && afterClose.history === null && afterClose.marks.length === 1 && !afterClose.bodyLocked, JSON.stringify({ viewer: afterClose.viewer, history: afterClose.history }));

		// ---- failure: a report from a closed Review and from an older revision appends nothing to the Review sources ----
		const closedId = ctx.fixtures.decision.id;
		const closedCall = await post("close-fixture-decision", `/api/p/${encodeURIComponent(closedId)}/close`, { summary: "끝", session: { id: "qa-owner" } });
		check("Q18 the fixture decision Review is closed for the closed-Review report", closedCall.status === 200 && closedCall.body?.summary?.status === "closed", JSON.stringify({ status: closedCall.status, summary: closedCall.body?.summary?.status }));
		const closedEventsBefore = (await get("closed-events-before", `/api/p/${encodeURIComponent(closedId)}`)).body?.events?.map((event) => event.type) ?? null;
		await withDeadline(page.goto(`${ctx.base}/p/${encodeURIComponent(closedId)}`, { waitUntil: "load" }), DEADLINE_MS, "q18_goto_closed");
		await waitDom(page, framesSized, "q18_closed_frames");
		const closedPage = await evalIn(page, PAGE_STATE, "q18_closed_page");
		const before = snapshotSources();
		await withDeadline(page.click("nav.top a[data-issue-report]"), DEADLINE_MS, "q18_closed_report");
		await evalIn(page, DIALOG_OPEN_WAIT, "q18_closed_reporter_open");
		await withDeadline(page.fill("#issue-description", CLOSED_DESCRIPTION), DEADLINE_MS, "q18_closed_fill");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q18_closed_send");
		await waitDom(page, "() => document.querySelector('#issue-status').textContent === '접수했습니다' ? true : null", "q18_closed_accepted");
		const closedSent = await evalIn(page, REPORT_STATE, "q18_closed_sent");
		const closedIssueId = typeof closedSent.link === "string" ? closedSent.link.slice("/issues/".length) : null;
		const closedIssue = await get("closed-issue", `/api/issues/${closedIssueId}`);
		const after = snapshotSources();
		const closedDiff = sourceDiff(before, after);
		const closedEventsAfter = (await get("closed-events-after", `/api/p/${encodeURIComponent(closedId)}`)).body?.events?.map((event) => event.type) ?? null;
		states.failures.closedReview = { page: { closed: closedPage.closed, closedBanner: closedPage.closedBanner, rev: closedPage.rev }, issue: closedIssue.body?.issue, events: { before: closedEventsBefore, after: closedEventsAfter }, diff: closedDiff };
		note("closed-review-report", { issueId: closedIssueId, diff: Object.fromEntries(Object.entries(closedDiff).map(([k, v]) => [k, v.identical])) });
		check("Q18 failure: a report from a closed Review is accepted with its revision and causes no feedback: Review events unchanged, data/proposals, data/threads and mailbox byte-identical", closedPage.closed === true && closedPage.closedBanner.hidden === false && closedIssue.status === 200 && closedIssue.body?.issue?.source?.proposalId === closedId && closedIssue.body.issue.source.revision === 2 && allIdentical(closedDiff) && JSON.stringify(closedEventsBefore) === JSON.stringify(closedEventsAfter) && closedEventsAfter?.at(-1) === "closed", JSON.stringify({ closed: closedPage.closed, source: closedIssue.body?.issue?.source, diff: closedDiff, events: closedEventsAfter }));
		await shot(page, "Q18-closed.png");

		await withDeadline(page.goto(`${ctx.base}/p/${encodeURIComponent(id)}?rev=1`, { waitUntil: "load" }), DEADLINE_MS, "q18_goto_older");
		await waitDom(page, framesSized, "q18_older_frames");
		const olderPage = await evalIn(page, PAGE_STATE, "q18_older_page");
		const beforeOlder = snapshotSources();
		await withDeadline(page.click("nav.top a[data-issue-report]"), DEADLINE_MS, "q18_older_report");
		await evalIn(page, DIALOG_OPEN_WAIT, "q18_older_reporter_open");
		await withDeadline(page.fill("#issue-description", OLDER_DESCRIPTION), DEADLINE_MS, "q18_older_fill");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q18_older_send");
		await waitDom(page, "() => document.querySelector('#issue-status').textContent === '접수했습니다' ? true : null", "q18_older_accepted");
		const olderSent = await evalIn(page, REPORT_STATE, "q18_older_sent");
		const olderIssue = await get("older-issue", `/api/issues/${typeof olderSent.link === "string" ? olderSent.link.slice("/issues/".length) : "missing"}`);
		const olderDiff = sourceDiff(beforeOlder, snapshotSources());
		states.failures.olderRevision = { page: { rev: olderPage.rev, readOnly: olderPage.readOnly, oldNoteHidden: olderPage.oldNoteHidden }, issue: olderIssue.body?.issue, diff: olderDiff };
		check("Q18 an older (read-only) revision can be reported: the issue names revision 1 of a revision-2 Review and the sources stay byte-identical", olderPage.rev === 1 && olderPage.readOnly === true && olderPage.oldNoteHidden === false && olderIssue.status === 200 && olderIssue.body?.issue?.source?.revision === 1 && olderIssue.body.issue.source.proposalId === id && allIdentical(olderDiff), JSON.stringify({ page: states.failures.olderRevision.page, source: olderIssue.body?.issue?.source, diff: olderDiff }));

		// ---- the real 확인 flows keep their old semantics ----
		const fixtureReport = ctx.fixtures.report.id;
		await withDeadline(page.goto(`${ctx.base}/p/${encodeURIComponent(fixtureReport)}`, { waitUntil: "load" }), DEADLINE_MS, "q18_goto_report");
		await waitDom(page, framesSized, "q18_report_frames");
		const reportPage = await evalIn(page, PAGE_STATE, "q18_report_page");
		check("Q18 the report Review shows 확인 and keeps its own 제보 entries", reportPage.ackHidden === false && reportPage.headerReport?.href === "/issues/new" && reportPage.rev === 2, JSON.stringify({ ack: reportPage.ackHidden, header: reportPage.headerReport, rev: reportPage.rev }));
		await withDeadline(page.fill("#comment", ACK_COMMENT), DEADLINE_MS, "q18_fill_ack_comment");
		const mailboxDir = path.join(roots().mailbox, "qa-owner");
		const mailboxWait = waitForFiles(roots().mailbox, () => (fs.existsSync(mailboxDir) ? fs.readdirSync(mailboxDir).filter((name) => name.startsWith(`${fixtureReport}-`)) : []).find(Boolean) ?? null, "q18_ack_mailbox");
		await withDeadline(page.click("#ackBtn"), DEADLINE_MS, "q18_click_ack");
		const mailboxFile = await mailboxWait;
		const ackDetail = await get("ack-with-comment", `/api/p/${encodeURIComponent(fixtureReport)}`);
		const ackFeedback = ackDetail.body?.events?.find((event) => event.type === "feedback");
		states.acks.withComment = { mailboxFile, summary: ackDetail.body?.summary, feedback: ackFeedback, events: ackDetail.body?.events?.map((event) => event.type) };
		note("ack-with-comment", { mailboxFile, status: ackDetail.body?.summary?.status });
		check("Q18 real 확인 with a comment: status theirs, routed to the owner, delivery pending, mailbox file written, no closed event", ackDetail.body?.summary?.status === "theirs" && ackFeedback?.verdict === "ack" && ackFeedback.comment === ACK_COMMENT && ackFeedback.delivery === "pending" && ackFeedback.routed === "qa-owner" && typeof mailboxFile === "string" && !ackDetail.body.events.some((event) => event.type === "closed"), JSON.stringify({ status: ackDetail.body?.summary?.status, feedback: ackFeedback && { verdict: ackFeedback.verdict, comment: ackFeedback.comment, delivery: ackFeedback.delivery, routed: ackFeedback.routed }, mailboxFile }));

		await withDeadline(page.goto(`${ctx.base}/p/${encodeURIComponent(reportId)}`, { waitUntil: "load" }), DEADLINE_MS, "q18_goto_report_2");
		await waitDom(page, framesSized, "q18_report_2_frames");
		const eventsDir = path.join(roots().proposals, reportId, "events");
		const closedWait = waitForFiles(eventsDir, () => fs.readdirSync(eventsDir).find((name) => name.endsWith("-closed.json")) ?? null, "q18_commentless_closed");
		await withDeadline(page.click("#ackBtn"), DEADLINE_MS, "q18_click_ack_2");
		const closedFile = await closedWait;
		const ack2 = await get("commentless-ack", `/api/p/${encodeURIComponent(reportId)}`);
		const ack2Feedback = ack2.body?.events?.find((event) => event.type === "feedback");
		const ack2Closed = ack2.body?.events?.find((event) => event.type === "closed");
		const ownerMailbox = fs.existsSync(mailboxDir) ? fs.readdirSync(mailboxDir).filter((name) => name.startsWith(`${reportId}-`)) : [];
		states.acks.commentless = { closedFile, summary: ack2.body?.summary, feedback: ack2Feedback, closed: ack2Closed, events: ack2.body?.events?.map((event) => event.type), ownerMailbox };
		note("ack-commentless", { closedFile, status: ack2.body?.summary?.status });
		check("Q18 real comment-less 확인: closed by the user, delivery none, no mailbox file", ack2.body?.summary?.status === "closed" && ack2Feedback?.verdict === "ack" && ack2Feedback.comment === null && ack2Feedback.delivery === "none" && ack2Closed?.by === "user" && ownerMailbox.length === 0 && typeof closedFile === "string", JSON.stringify({ status: ack2.body?.summary?.status, feedback: ack2Feedback && { verdict: ack2Feedback.verdict, comment: ack2Feedback.comment, delivery: ack2Feedback.delivery }, closed: ack2Closed && { by: ack2Closed.by }, ownerMailbox, closedFile }));

		// ---- desktop width: the header entries and the viewer bar ----
		// The wrapped goto re-pins the scenario viewport; the raw goto keeps the desktop pin applied after it.
		await withDeadline(page.qaGoto(`${ctx.base}/p/${encodeURIComponent(id)}`, { waitUntil: "load" }), DEADLINE_MS, "q18_goto_desktop");
		await pinQaPage(page, { width: 1280, height: 800, scheme });
		await waitDom(page, framesSized, "q18_desktop_frames");
		const desktop = await evalIn(page, PAGE_STATE, "q18_desktop_state");
		check("Q18 desktop: the header keeps 제보함 and 제보 beside the Review chips at 1280px, each at least 44x44 CSS px", desktop.viewportWidth === 1280 && tappable(desktop.headerReport?.rect) && tappable(desktop.issuesLink?.rect) && desktop.headerReport.rect.y < 80, JSON.stringify({ viewportWidth: desktop.viewportWidth, header: desktop.headerReport, issues: desktop.issuesLink }));
		await shot(page, "Q18-desktop.png");
		const canvas3 = await rectOf(page, "#sections .frame canvas");
		await mouse(page, "mouseMoved", canvas3.cx, canvas3.cy);
		await mouse(page, "mousePressed", canvas3.cx, canvas3.cy, { button: "left", buttons: 1, clickCount: 1 });
		await mouse(page, "mouseReleased", canvas3.cx, canvas3.cy, { button: "left", buttons: 0, clickCount: 1 });
		await waitDom(page, "() => document.getElementById('viewer').hidden ? null : true", "q18_desktop_viewer");
		const desktopViewer = await evalIn(page, PAGE_STATE, "q18_desktop_viewer_state");
		states.steps.desktop = { header: desktop.headerReport, issues: desktop.issuesLink, vReport: desktopViewer.vReport };
		check("Q18 desktop: the viewer's 제보 action is at least 44x44 CSS px at 1280px", desktopViewer.viewer.open && tappable(desktopViewer.vReport?.rect), JSON.stringify({ viewportWidth: desktopViewer.viewportWidth, vReport: desktopViewer.vReport }));
		await shot(page, "Q18-viewer-desktop.png");
		await cdp(page, "Emulation.setTouchEmulationEnabled", { enabled: false });
		await pinQaPage(page, { width, height, scheme });
	} finally {
		evidence("Q18-history.json", JSON.stringify(history, null, "\t"));
		evidence("Q18-states.json", JSON.stringify(states, null, "\t"));
		evidence("Q18-source-diff.json", JSON.stringify({ closedReview: states.failures.closedReview?.diff ?? null, olderRevision: states.failures.olderRevision?.diff ?? null, viewerReport: states.steps.sent ? { mailbox: states.steps.sent.mailboxDiff, proposalEvents: states.steps.sent.proposal } : null, roots: roots() }, null, "\t"));
		try {
			await withDeadline(page.close(), DEADLINE_MS, "q18_page_close");
		} catch {
			// the page may already be gone
		}
	}
}
