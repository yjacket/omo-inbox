/* Q15: issue reporting inside the Inbox split navigation (720x900, light).
 *
 * This scenario uses the real page integration in web/inbox.html: header 제보함/제보 links, the
 * server-fed issue badge, the registered inbox adapter, deferred list refresh/iframe replacement
 * and the draft-safe 720px handoff. It seeds one needs-check issue so the badge carries a real
 * count, then proves the badge is separate from Review and 내 차례.
 *
 * Happy path: select thread A, then thread B (real list selection and iframe replacement, no
 * document navigation), open the reporter, pick row A as the target without moving selection or
 * the frame, send, and read the issue's source identity from GET /api/issues/<id>. Failure tracks:
 * while typing, a queued list refresh is held, the viewport crosses 720->719->720 with the typed
 * text, cursor, capture and the single dialog intact; a removed source stays null; a first POST
 * that fails before the server is replayed byte-identically after reload with one issue; a denied
 * IndexedDB page keeps the same unsaved text while the pending handoff waits, and only close lets
 * the handoff proceed. Normal Back after reporting returns the split list to thread A. Source
 * isolation hashes data/proposals, data/threads and mailbox from a baseline taken before the first
 * row interaction, across the report lifecycle.
 *
 * Every wait is an awaited DOM mutation or HTTP response under a named 10 s deadline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const viewport = { width: 720, height: 900, scheme: "light" };

const DEADLINE_MS = 10_000;
const SEED_ISSUE = "15151501-1515-4515-8515-151515151501";
const SEED_CAPTURE = "15151511-1515-4515-8515-151515151511";
const SEED_CHECK = "15151521-1515-4515-8515-151515151521";
const DESCRIPTION = "Q15 제보 버튼이 보이지 않습니다\n둘째 줄도 남깁니다.";
const CURSOR = 5;
const QUEUED_TEXT = "Q15 대기 업데이트";
const REPLAY_TEXT = "Q15 응답을 잃은 제보";
// Fails the next POST before it reaches the server, then records every wire body. Survives reload
// through sessionStorage so the replay POST is captured in the same list as the failed first one.
const REPLAY_INTERCEPT = `(() => {
	if (window.top !== window) return;
	const original = window.fetch.bind(window);
	window.__q15Posts = JSON.parse(sessionStorage.getItem('q15Posts') || '[]');
	window.__q15Replay = new Promise((resolve) => { window.__q15ResolveReplay = resolve; });
	if (window.__q15Posts.length >= 2) window.__q15ResolveReplay(window.__q15Posts);
	window.fetch = async (input, init) => {
		if (input !== '/api/issues' || init?.method !== 'POST') return original(input, init);
		if (sessionStorage.getItem('q15FailNext') === 'yes') {
			sessionStorage.removeItem('q15FailNext');
			window.__q15Posts.push({ raw: init.body, failedBeforeServer: true });
			sessionStorage.setItem('q15Posts', JSON.stringify(window.__q15Posts));
			throw new TypeError('Q15 dropped response');
		}
		const response = await original(input, init);
		let json = null;
		try { json = await response.clone().json(); } catch {}
		window.__q15Posts.push({ raw: init.body, status: response.status, response: json });
		sessionStorage.setItem('q15Posts', JSON.stringify(window.__q15Posts));
		if (window.__q15Posts.length >= 2) window.__q15ResolveReplay(window.__q15Posts);
		return response;
	};
	return true;
})()`;

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function waitForDom(predicateSource, label) {
	return `new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(${JSON.stringify(label)} + ' did not appear within 9000ms')), 9000);
		let observer = null;
		const test = () => {
			let value = null;
			try { value = (${predicateSource})(); } catch { value = null; }
			if (!value) return false;
			clearTimeout(timer);
			if (observer) observer.disconnect();
			resolve(value);
			return true;
		};
		observer = new MutationObserver(() => test());
		observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
		test();
	})`;
}

function seedCapture() {
	return {
		captureId: SEED_CAPTURE,
		observedAt: "2026-10-23T00:00:00.000Z",
		page: "inbox",
		source: null,
		target: null,
		clientBuild: null,
		view: { width: 720, height: 900, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "ko-KR", embedded: false, viewerOpen: false },
		excerpt: null,
		excerptTruncated: false,
		visibleIds: [],
		diagnostics: [],
		contextStatus: "captured",
		visual: { kind: "none", reason: "not_requested" },
	};
}

const HEADER = `(() => {
	const box = (node) => { const r = node.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
	const tools = [...document.querySelectorAll('nav.tools > *')].map((node) => ({ id: node.id || node.textContent.trim(), text: node.textContent.trim(), ...box(node) }));
	const heads = box(document.querySelector('.top .heads'));
	const nav = box(document.querySelector('nav.tools'));
	const overlap = !(heads.right <= nav.left || heads.bottom <= nav.top || nav.right <= heads.left || nav.bottom <= heads.top);
	const issues = document.getElementById('issuesLink');
	const report = document.getElementById('reportLink');
	const review = document.getElementById('reviewLink');
	const badge = document.getElementById('issueBadge');
	const need = document.getElementById('needsYou');
	return {
		width: innerWidth, height: innerHeight,
		issues: { href: issues.getAttribute('href'), ...box(issues) },
		report: { href: report.getAttribute('href'), trigger: report.matches('[data-issue-report]'), ...box(report) },
		review: box(review),
		tools, heads, nav, overlap,
		badge: { hidden: badge.hidden, text: badge.textContent, label: issues.getAttribute('aria-label') },
		reviewBadge: { hidden: document.getElementById('reviewBadge').hidden, text: document.getElementById('reviewBadge').textContent },
		needsYou: { hidden: need.hidden, text: need.textContent },
		overflow: document.documentElement.scrollWidth > innerWidth,
		dialogCount: document.querySelectorAll('#issue-report').length,
	};
})()`;

const SPLIT = `(() => ({
	path: location.pathname + location.search,
	marker: window.__q15Marker ?? null,
	frame: (() => { const node = document.querySelector('iframe.thread'); return node ? { src: node.getAttribute('src'), mark: node.dataset.mark ?? null, same: window.__q15Frame === node } : null; })(),
	selected: document.querySelector('.row[aria-current="page"]')?.getAttribute('data-session') ?? null,
	rows: document.querySelectorAll('.row[data-session]').length,
	rowSessions: [...document.querySelectorAll('.row[data-session]')].map((row) => row.getAttribute('data-session')),
}))()`;

const DIALOG = `(() => {
	const dialog = document.querySelector('#issue-report');
	const textarea = document.querySelector('#issue-description');
	return {
		open: dialog ? dialog.open : false,
		modal: dialog ? dialog.matches(':modal') : false,
		count: document.querySelectorAll('#issue-report').length,
		status: dialog ? dialog.dataset.status : null,
		statusText: document.querySelector('#issue-status')?.textContent ?? null,
		text: textarea ? textarea.value : null,
		cursor: textarea ? textarea.selectionStart : null,
		readOnly: textarea ? textarea.readOnly : null,
		chip: document.querySelector('#issue-target-label')?.textContent ?? null,
		pickerHidden: document.querySelector('#issue-picker')?.hidden ?? null,
		deferred: document.getElementById('list')?.dataset.deferred ?? null,
		pending: document.getElementById('list')?.dataset.pending ?? null,
		link: document.querySelector('#issue-link')?.getAttribute('href') ?? null,
		activeInDialog: dialog ? dialog.contains(document.activeElement) : false,
		header: (() => {
			const report = document.getElementById('reportLink');
			const issues = document.getElementById('issuesLink');
			return {
				reportHeight: Math.round(report.getBoundingClientRect().height),
				issuesHeight: Math.round(issues.getBoundingClientRect().height),
				badgeHidden: document.getElementById('issueBadge').hidden,
				badgeText: document.getElementById('issueBadge').textContent,
			};
		})(),
	};
})()`;

function hashTree(root) {
	const hash = crypto.createHash("sha256");
	const walk = (dir, rel) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		} catch (error) {
			if (error && error.code === "ENOENT") {
				hash.update(`missing:${rel}\n`);
				return;
			}
			throw error;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(full, child);
			else hash.update(`${child}:${fs.readFileSync(full).toString("base64")}\n`);
		}
	};
	walk(root, "");
	return hash.digest("hex");
}

function sourceHashes(home) {
	return {
		proposals: hashTree(path.join(home, "data", "proposals")),
		threads: hashTree(path.join(home, "data", "threads")),
		mailbox: hashTree(path.join(home, "mailbox")),
	};
}

function sameJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, pinQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const { TEXT } = await import(pathToFileURL(path.join(ctx.appDir, "web", "issue-report.js")).href);
	const actions = [];
	const record = { viewport: { width, height, scheme }, steps: {} };
	const act = (step, detail, signal) => actions.push({ step, detail: detail === undefined ? null : detail, signal: signal === undefined ? null : signal });
	const evalIn = (page, expression, name) => withDeadline(page.evaluate(expression), DEADLINE_MS, name);
	const wait = (page, predicate, name) => evalIn(page, waitForDom(predicate, name), name);
	const saveShot = async (page, name, label) => {
		const shot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, label);
		const file = evidence(name, Buffer.from(shot));
		check(`${label} saved`, fs.existsSync(file) && fs.statSync(file).size > 0, file);
		return file;
	};

	// ---- seed one needs-check issue over HTTP ----
	const caps = await ctx.get("/api/issues/capabilities");
	const storeId = caps.storeId;
	const serverBuild = caps.build?.buildId ?? null;
	const created = await ctx.post("/api/issues", { v: 1, storeId, requestId: SEED_ISSUE, description: "Q15 배지 확인용 제보", evidence: seedCapture() });
	const checked = await ctx.post(`/api/issues/${SEED_ISSUE}/commands`, {
		v: 1,
		storeId,
		requestId: SEED_CHECK,
		expectedSeq: 1,
		command: { type: "request_check", note: "배지 확인용 수정안", correction: { kind: "inbox-build", buildId: serverBuild, summary: "Q15 배지" }, evidence: null },
	});
	const seededList = await ctx.get("/api/issues?limit=1");
	record.seed = { created: created.status, checked: checked.status, state: checked.state, counts: seededList.counts };
	check("Q15 seed issue is needs-check so the badge has a real count", checked.state === "needs-check" && seededList.counts["needs-check"] === 1, JSON.stringify(record.seed));

	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q15_new_page");
	try {
		// Observe the registry/iframe order and the same-origin ready event from inside the page.
		const earlySession = await page.resolveSessionId();
		await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
			if (window.top !== window) return;
			window.__q15RegistryAtFrame = null;
			window.__q15ReadySeen = 0;
			const install = () => {
				const probe = document.createElement('iframe');
				probe.id = 'q15-ready-probe';
				probe.style.display = 'none';
				document.documentElement.appendChild(probe);
				try {
					const doc = probe.contentDocument;
					doc.open();
					doc.write('<!doctype html><title>q15</title>');
					doc.close();
					probe.contentWindow.addEventListener('inbox-issue-adapters-ready', () => { window.__q15ReadySeen += 1; });
				} catch {}
				new MutationObserver(() => {
					const frame = document.querySelector('iframe.thread');
					if (frame && window.__q15RegistryAtFrame === null) window.__q15RegistryAtFrame = Boolean(window.__inboxIssueAdapters);
				}).observe(document.documentElement, { childList: true, subtree: true });
			};
			if (document.documentElement) install();
			else document.addEventListener('DOMContentLoaded', install, { once: true });
		})()` }, earlySession);
		await withDeadline(page.goto(`${ctx.base}/`, { waitUntil: "load" }), DEADLINE_MS, "q15_goto_inbox");
		act("navigate", `${ctx.base}/`, "page.goto(load) resolved");
		await wait(page, `() => document.querySelector('.row[data-session="${ctx.fixtures.threads.a}"]') && !document.getElementById('issueBadge').hidden ? true : null`, "q15_rows_and_badge");
		// Isolation baseline before the first row interaction; selections below must not write source data.
		await wait(page, "() => window.__q15RegistryAtFrame !== null ? true : null", "q15_adapter_ready");
		const adapterOrder = await evalIn(page, `(() => ({
			registryAtFrame: window.__q15RegistryAtFrame,
			readySeen: window.__q15ReadySeen,
			hasRegistry: Boolean(window.__inboxIssueAdapters),
			targets: window.__inboxIssueAdapters ? window.__inboxIssueAdapters.listTargets().map((target) => [target.kind, target.key, target.label]) : [],
		}))()`, "q15_adapter_order");
		record.steps.adapterOrder = adapterOrder;
		check("Q15 the adapter registry exists when the thread iframe is created and announces itself to an existing same-origin child", adapterOrder.registryAtFrame === true && adapterOrder.hasRegistry === true && adapterOrder.readySeen >= 1, JSON.stringify(adapterOrder));
		const hashesBaseline = sourceHashes(ctx.home);
		record.hashesBaseline = hashesBaseline;
		const threads = await ctx.get("/api/threads");
		const header720 = await evalIn(page, HEADER, "q15_header_720");
		record.steps.header720 = header720;
		check("Q15 the header has 제보함, the report trigger and a server-fed issue badge", header720.issues.href === "/issues" && header720.report.trigger === true && header720.report.href === "/issues/new" && header720.badge.hidden === false && header720.badge.text === "1", JSON.stringify({ issues: header720.issues, report: header720.report, badge: header720.badge }));
		const reviewExpected = String(threads.reviews?.mine ?? 0);
		const needsExpected = String(threads.counts?.needsYou ?? 0);
		check("Q15 the issue badge never changes the Review badge or 내 차례 counts", header720.badge.text === "1" && (threads.reviews?.mine ? header720.reviewBadge.text === reviewExpected && header720.reviewBadge.hidden === false : header720.reviewBadge.hidden === true) && (threads.counts?.needsYou > 0 ? header720.needsYou.text.includes(needsExpected) : header720.needsYou.hidden === true), JSON.stringify({ issue: header720.badge, review: header720.reviewBadge, reviewExpected, needsYou: header720.needsYou, needsExpected }));
		check("Q15 the split tools stay inside 720px without overlapping", header720.overflow === false && header720.overlap === false && header720.tools.every((tool) => tool.right <= header720.width) && header720.issues.right <= header720.report.left && header720.report.right <= header720.review.left, JSON.stringify({ tools: header720.tools, heads: header720.heads, nav: header720.nav, overlap: header720.overlap }));
		check("Q15 new header controls keep 44px hit areas at 720px", [header720.issues, header720.report].every((control) => control.width >= 44 && control.height >= 44), JSON.stringify({ issues: header720.issues, report: header720.report }));

		// ---- 390 and 1280 header checks (same document, no thread handoff) ----
		await evalIn(page, `history.replaceState(null, "", "/")`, "q15_clear_s");
		await withDeadline(pinQaPage(page, { width: 390, height: 844, scheme }), DEADLINE_MS, "q15_pin_390");
		await wait(page, "() => innerWidth === 390 && document.querySelector('.row[data-session]') ? true : null", "q15_at_390");
		const header390 = await evalIn(page, HEADER, "q15_header_390");
		record.steps.header390 = header390;
		check("Q15 at 390px the tools and the issue badge stay inside the viewport without covering 내 차례", header390.overflow === false && header390.overlap === false && header390.tools.every((tool) => tool.right <= 390) && header390.badge.hidden === false, JSON.stringify({ tools: header390.tools, heads: header390.heads, nav: header390.nav, overlap: header390.overlap }));
		check("Q15 new header controls keep 44px hit areas at 390x844", header390.height === 844 && [header390.issues, header390.report].every((control) => control.width >= 44 && control.height >= 44), JSON.stringify({ issues: header390.issues, report: header390.report, height: header390.height }));
		await saveShot(page, "Q15-390.png", "Q15-390.png");
		await withDeadline(pinQaPage(page, { width: 1280, height: 900, scheme }), DEADLINE_MS, "q15_pin_1280");
		await wait(page, "() => innerWidth === 1280 && document.querySelector('.row[data-session]') ? true : null", "q15_at_1280");
		const header1280 = await evalIn(page, HEADER, "q15_header_1280");
		record.steps.header1280 = header1280;
		check("Q15 at 1280px the tools and the issue badge stay inside the viewport without covering 내 차례", header1280.overflow === false && header1280.overlap === false && header1280.tools.every((tool) => tool.right <= 1280) && header1280.badge.hidden === false, JSON.stringify({ tools: header1280.tools, heads: header1280.heads, nav: header1280.nav, overlap: header1280.overlap }));
		check("Q15 new header controls keep 44px hit areas at 1280px", [header1280.issues, header1280.report].every((control) => control.width >= 44 && control.height >= 44), JSON.stringify({ issues: header1280.issues, report: header1280.report }));
		await withDeadline(pinQaPage(page, { width, height, scheme }), DEADLINE_MS, "q15_pin_720");
		await wait(page, "() => innerWidth === 720 && document.querySelector('iframe.thread') ? true : null", "q15_back_to_720");

		// ---- real list selection and iframe replacement ----
		await evalIn(page, `window.__q15Marker = "same-document"; true`, "q15_marker");
		const rowB = `.row[data-session="${ctx.fixtures.threads.b}"]`;
		const rowA = `.row[data-session="${ctx.fixtures.threads.a}"]`;
		await withDeadline(page.click(rowA), DEADLINE_MS, "q15_select_a");
		await wait(page, `() => location.search === "?s=${ctx.fixtures.threads.a}" && document.querySelector('iframe.thread')?.getAttribute('src') === "/s/${ctx.fixtures.threads.a}" ? true : null`, "q15_iframe_a");
		const onA = await evalIn(page, SPLIT, "q15_split_a");
		await withDeadline(page.click(rowB), DEADLINE_MS, "q15_select_b");
		await wait(page, `() => location.search === "?s=${ctx.fixtures.threads.b}" && document.querySelector('iframe.thread')?.getAttribute('src') === "/s/${ctx.fixtures.threads.b}" ? true : null`, "q15_iframe_b");
		const onB = await evalIn(page, SPLIT, "q15_split_b");
		record.steps.selection = { onA, onB };
		check("Q15 real row selection changes the URL and replaces the thread iframe without navigating the list document", onA.marker === "same-document" && onA.selected === ctx.fixtures.threads.a && onA.frame?.src === `/s/${ctx.fixtures.threads.a}` && onB.selected === ctx.fixtures.threads.b && onB.frame?.src === `/s/${ctx.fixtures.threads.b}`, JSON.stringify({ onA, onB }));
		const hashesAfterSelect = sourceHashes(ctx.home);
		record.hashesAfterSelect = hashesAfterSelect;
		check("Q15 selecting rows after the pre-interaction baseline writes no source data", sameJson(hashesBaseline, hashesAfterSelect), JSON.stringify({ baseline: hashesBaseline, afterSelect: hashesAfterSelect }));
		await evalIn(page, `window.__q15Frame = document.querySelector('iframe.thread'); window.__q15Frame.dataset.mark = "keep"; true`, "q15_frame_marker");

		// The scenario's own queued item is written before the report lifecycle starts, so the
		// source-isolation baseline below covers everything the report does from open to send.
		await ctx.post(`/api/threads/${ctx.fixtures.threads.b}/items`, { kind: "progress", policy: "progress", dedupeKey: "turn:q15:queued", raw: { text: QUEUED_TEXT, request: "Q15 대기 업데이트" } });
		const rowCountBefore = (await evalIn(page, SPLIT, "q15_rows_before_queue")).rows;
		const hashesBefore = sourceHashes(ctx.home);
		record.hashesBefore = hashesBefore;

		// ---- open the reporter; pick row A as the target without navigation ----
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q15_open_report");
		await wait(page, "() => document.querySelector('#issue-report')?.open === true && document.querySelector('#issue-description') === document.activeElement ? true : null", "q15_report_open");
		const opened = await evalIn(page, DIALOG, "q15_dialog_open");
		record.steps.opened = opened;
		check("Q15 the report trigger opens one modal dialog with the list deferred", opened.open === true && opened.modal === true && opened.count === 1 && opened.deferred === "1" && opened.header.reportHeight >= 44, JSON.stringify(opened));

		await withDeadline(page.click("#issue-target-pick"), DEADLINE_MS, "q15_open_picker");
		const picked = await evalIn(page, `(() => {
			const options = [...document.querySelectorAll('#issue-picker [role="option"]')];
			const option = options.find((node) => node.textContent.includes("결제 화면 문제 제보"));
			if (!option) return { count: options.length, picked: false, labels: options.map((node) => node.textContent) };
			option.click();
			return { count: options.length, picked: true, labels: options.map((node) => node.textContent) };
		})()`, "q15_pick_target");
		const afterPick = await evalIn(page, SPLIT, "q15_split_after_pick");
		const dialogAfterPick = await evalIn(page, DIALOG, "q15_dialog_after_pick");
		record.steps.target = { picked, afterPick, dialog: dialogAfterPick };
		check("Q15 picking row A as the target does not navigate, change selection or replace the selected row B iframe", picked.picked === true && afterPick.marker === "same-document" && afterPick.selected === ctx.fixtures.threads.b && afterPick.frame?.same === true && afterPick.frame.mark === "keep" && afterPick.path === `/?s=${ctx.fixtures.threads.b}` && dialogAfterPick.pickerHidden === true && typeof dialogAfterPick.chip === "string" && dialogAfterPick.chip.includes("결제 화면 문제 제보"), JSON.stringify({ picked, afterPick, chip: dialogAfterPick.chip }));

		// ---- type; queued list refresh is deferred ----
		await withDeadline(page.fill("#issue-description", DESCRIPTION), DEADLINE_MS, "q15_fill");
		await evalIn(page, `(() => { const field = document.querySelector('#issue-description'); field.focus(); field.setSelectionRange(${CURSOR}, ${CURSOR}); return field.selectionStart; })()`, "q15_cursor");
		await evalIn(page, "document.getElementById('retry').click(); true", "q15_trigger_load");
		await wait(page, "() => document.getElementById('list')?.dataset.pending === '1' ? true : null", "q15_pending_payload");
		const queued = await evalIn(page, DIALOG, "q15_dialog_queued");
		const splitQueued = await evalIn(page, SPLIT, "q15_split_queued");
		record.steps.queued = { dialog: queued, split: splitQueued, rowCountBefore };
		check("Q15 a queued list update is held while the reporter owns the dialog", queued.pending === "1" && queued.text === DESCRIPTION && splitQueued.rows === rowCountBefore && splitQueued.frame?.same === true, JSON.stringify({ queued, splitQueued, rowCountBefore }));

		// ---- 720 -> 719 -> 720 while typing ----
		await withDeadline(pinQaPage(page, { width: 719, height: 900, scheme }), DEADLINE_MS, "q15_pin_719");
		await wait(page, "() => innerWidth === 719 ? true : null", "q15_at_719");
		const at719 = await evalIn(page, DIALOG, "q15_dialog_719");
		const split719 = await evalIn(page, SPLIT, "q15_split_719");
		record.steps.at719 = { dialog: at719, split: split719 };
		check("Q15 at 719px the typed text, cursor, capture and single dialog survive without navigation", at719.open === true && at719.count === 1 && at719.text === DESCRIPTION && at719.cursor === CURSOR && at719.chip.includes("결제 화면 문제 제보") && split719.marker === "same-document" && split719.path === `/?s=${ctx.fixtures.threads.b}` && split719.frame?.mark === "keep", JSON.stringify({ at719, split719 }));
		const file719 = await saveShot(page, "Q15-719.png", "Q15-719.png");
		record.steps.shot719 = file719;

		await withDeadline(pinQaPage(page, { width, height, scheme }), DEADLINE_MS, "q15_pin_720_again");
		await wait(page, "() => innerWidth === 720 ? true : null", "q15_at_720_again");
		const at720 = await evalIn(page, DIALOG, "q15_dialog_720");
		const split720 = await evalIn(page, SPLIT, "q15_split_720");
		record.steps.at720 = { dialog: at720, split: split720 };
		check("Q15 returning to 720px keeps the same dialog, text and cursor", at720.open === true && at720.count === 1 && at720.text === DESCRIPTION && at720.cursor === CURSOR && split720.marker === "same-document" && split720.frame?.same === true, JSON.stringify({ at720, split720 }));
		const file720 = await saveShot(page, "Q15-720.png", "Q15-720.png");
		record.steps.shot720 = file720;

		// ---- send and inspect the source identity ----
		await evalIn(page, `(() => {
			window.__q15Accepted = new Promise((resolve, reject) => {
				const node = document.querySelector('#issue-status');
				const limit = setTimeout(() => reject(new Error('accepted status did not arrive (now ' + JSON.stringify(node.textContent) + ')')), 9000);
				const test = () => {
					if (node.textContent !== ${JSON.stringify(TEXT.status.accepted)}) return false;
					clearTimeout(limit);
					resolve(true);
					return true;
				};
				const observer = new MutationObserver(test);
				observer.observe(node, { childList: true, characterData: true, subtree: true });
				test();
			});
			window.__q15Accepted.catch(() => {});
			return true;
		})()`, "q15_arm_accepted");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q15_send");
		await evalIn(page, `window.__q15Accepted`, "q15_wait_accepted");
		act("send", "#issue-send", "awaiting #issue-status == 접수했습니다");
		const sent = await evalIn(page, DIALOG, "q15_dialog_sent");
		record.steps.sent = sent;
		check("Q15 sending yields one receipt and the issue link", sent.status === "sent" && sent.statusText === TEXT.status.accepted && /^\/issues\/[0-9a-f-]{36}$/.test(sent.link ?? ""), JSON.stringify({ status: sent.status, text: sent.statusText, link: sent.link }));
		const issueId = sent.link.slice("/issues/".length);
		const list = await ctx.get("/api/issues?limit=100");
		const detail = await ctx.get(`/api/issues/${issueId}`);
		const newest = list.items[0];
		record.steps.issue = { issueId, newest, source: detail.issue.source, events: detail.events.map((event) => [event.seq, event.type]), manifests: detail.evidence.map((entry) => entry.captureId) };
		check("Q15 the accepted issue source is the picked row A, not the selected row B", newest.id === issueId && detail.issue.description === DESCRIPTION && detail.issue.source && detail.issue.source.kind === "thread" && detail.issue.source.threadId === ctx.fixtures.threads.a && detail.issue.source.threadId !== ctx.fixtures.threads.b && detail.events.length === 1 && detail.events[0].seq === 1, JSON.stringify(record.steps.issue));
		const sentSplit = await evalIn(page, SPLIT, "q15_split_sent");
		record.steps.sentSplit = sentSplit;
		record.hashesAtSend = sourceHashes(ctx.home);
		check("Q15 sending keeps the selected row B and its iframe, proving source did not come from navigation", sentSplit.selected === ctx.fixtures.threads.b && sentSplit.path === `/?s=${ctx.fixtures.threads.b}` && sentSplit.frame?.same === true && detail.evidence[0]?.context?.source?.threadId === ctx.fixtures.threads.a, JSON.stringify({ sentSplit, source: detail.issue.source, contextSource: detail.evidence[0]?.context?.source }));
		const captureId = detail.evidence[0]?.captureId ?? null;
		const contextPath = captureId ? path.join(ctx.home, "data", "issues", "records", issueId, "evidence", captureId, "context.json") : null;
		const evidenceContext = contextPath && fs.existsSync(contextPath) ? JSON.parse(fs.readFileSync(contextPath, "utf8")) : null;
		record.steps.context = { captureId, context: evidenceContext };
		check("Q15 the captured source and target are row A while the visible ids are both split rows", evidenceContext && evidenceContext.contextStatus === "captured" && evidenceContext.source && evidenceContext.source.threadId === ctx.fixtures.threads.a && evidenceContext.source.threadId !== ctx.fixtures.threads.b && evidenceContext.target && evidenceContext.target.kind === "record" && evidenceContext.target.key === `thread:${ctx.fixtures.threads.a}` && evidenceContext.visibleIds.includes(ctx.fixtures.threads.a) && evidenceContext.visibleIds.includes(ctx.fixtures.threads.b), JSON.stringify(record.steps.context));

		// ---- close, then normal Back ----
		await withDeadline(page.click("#issue-close"), DEADLINE_MS, "q15_close");
		await wait(page, "() => document.querySelector('#issue-report')?.open !== true ? true : null", "q15_closed");
		await wait(page, "() => document.getElementById('list')?.dataset.pending == null ? true : null", "q15_resumed");
		const closed = await evalIn(page, SPLIT, "q15_after_close");
		record.steps.closed = closed;
		record.hashesAtClose = sourceHashes(ctx.home);
		check("Q15 closing resumes the list and keeps the split selection on row B", closed.path === `/?s=${ctx.fixtures.threads.b}` && closed.marker === "same-document" && closed.selected === ctx.fixtures.threads.b, JSON.stringify(closed));
		await wait(page, `() => document.getElementById('list')?.textContent.includes(${JSON.stringify(QUEUED_TEXT)}) ? true : null`, "q15_queued_applied");
		const afterBackTokens = (await evalIn(page, SPLIT, "q15_before_back")).path;
		await evalIn(page, "history.back(); true", "q15_back");
		await wait(page, `() => location.search === "?s=${ctx.fixtures.threads.a}" && document.querySelector('iframe.thread')?.getAttribute('src') === "/s/${ctx.fixtures.threads.a}" ? true : null`, "q15_back_to_a");
		const back = await evalIn(page, SPLIT, "q15_after_back");
		record.steps.back = { before: afterBackTokens, after: back };
		check("Q15 normal Back after reporting returns to the previous selection and its iframe", back.path === `/?s=${ctx.fixtures.threads.a}` && back.selected === ctx.fixtures.threads.a && back.frame?.src === `/s/${ctx.fixtures.threads.a}` && back.marker === "same-document", JSON.stringify(record.steps.back));
		const hashesAfter = sourceHashes(ctx.home);
		record.hashesAfter = hashesAfter;
		// The queued progress item is this scenario's own write; it lands only when close resumes the
		// list. The report lifecycle itself ends at send, so compare that window byte-for-byte.
		check("Q15 the report lifecycle from before open through send leaves data/proposals, data/threads and mailbox byte-identical", sameJson(hashesBefore, record.hashesAtSend), JSON.stringify({ before: hashesBefore, atSend: record.hashesAtSend }));
		check("Q15 letting the queued update land after close touches only that thread's data", hashesAfter.proposals === hashesBefore.proposals && hashesAfter.mailbox === hashesBefore.mailbox && sameJson(record.hashesAtClose, hashesAfter), JSON.stringify({ atClose: record.hashesAtClose, after: hashesAfter }));

		const finalBadge = await evalIn(page, HEADER, "q15_header_final");
		record.steps.headerFinal = finalBadge;
		check("Q15 after reporting the issue badge still counts needs-check and is separate from Review/내 차례", finalBadge.badge.text === "1" && finalBadge.badge.hidden === false, JSON.stringify(finalBadge.badge));
		// The split page's jobs are done; free it before the remaining isolated pages start.
		await withDeadline(page.close(), DEADLINE_MS, "q15_main_close_early").catch(() => page.dispose?.());

		// ---- removed source: a report sent afterwards carries null source ----
		const removed = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q15_remove_page");
		try {
			await withDeadline(removed.goto(`${ctx.base}/`, { waitUntil: "load" }), DEADLINE_MS, "q15_remove_goto");
			await wait(removed, `() => document.querySelector('.row[data-session="${ctx.fixtures.threads.a}"]') && !document.getElementById('issueBadge').hidden && window.__inboxIssueAdapters?.current()?.page === 'thread' ? true : null`, "q15_remove_ready");
			await withDeadline(removed.click("[data-issue-report]"), DEADLINE_MS, "q15_remove_open");
			await wait(removed, "() => document.querySelector('#issue-report')?.open === true ? true : null", "q15_remove_open_wait");
			await withDeadline(removed.click("#issue-target-pick"), DEADLINE_MS, "q15_remove_pick_open");
			const removePick = await evalIn(removed, `(() => {
				const options = [...document.querySelectorAll('#issue-picker [role="option"]')];
				const option = options.find((node) => node.textContent.includes("결제 화면 문제 제보"));
				if (!option) return { picked: false, labels: options.map((node) => node.textContent) };
				option.click();
				return { picked: true };
			})()`, "q15_remove_pick");
			if (!removePick.picked) throw new Error(`Q15 removed-source pick missing: ${JSON.stringify(removePick)}`);
			await wait(removed, "() => document.querySelector('#issue-picker').hidden ? true : null", "q15_remove_pick_done");
			await withDeadline(removed.click("#issue-attach-toggle"), DEADLINE_MS, "q15_remove_attach_open");
			await wait(removed, "() => document.querySelector('[data-remove=\"source\"]') ? true : null", "q15_remove_source_row");
			await withDeadline(removed.click('[data-remove="source"]'), DEADLINE_MS, "q15_remove_source");
			await wait(removed, "() => !document.querySelector('[data-remove=\"source\"]') ? true : null", "q15_remove_source_done");
			const removedText = "Q15 출처를 지운 제보";
			await withDeadline(removed.fill("#issue-description", removedText), DEADLINE_MS, "q15_remove_fill");
			await wait(removed, "() => document.querySelector('#issue-status')?.textContent === '초안 저장됨' ? true : null", "q15_remove_saved");
			await evalIn(removed, `(() => {
				window.__q15RemovedAccepted = new Promise((resolve, reject) => {
					const node = document.querySelector('#issue-status');
					const limit = setTimeout(() => reject(new Error('removed-source accepted status did not arrive')), 9000);
					const test = () => {
						if (node.textContent !== ${JSON.stringify(TEXT.status.accepted)}) return false;
						clearTimeout(limit); resolve(true); return true;
					};
					const observer = new MutationObserver(test);
					observer.observe(node, { childList: true, characterData: true, subtree: true });
					test();
				});
				window.__q15RemovedAccepted.catch(() => {});
				return true;
			})()`, "q15_remove_arm");
			await withDeadline(removed.click("#issue-send"), DEADLINE_MS, "q15_remove_send");
			await evalIn(removed, "window.__q15RemovedAccepted", "q15_remove_accepted");
			const removedLink = await evalIn(removed, "document.querySelector('#issue-link').getAttribute('href')", "q15_remove_link");
			const removedDetail = await ctx.get(`/api${removedLink}`);
			record.steps.removedSource = { link: removedLink, source: removedDetail.issue?.source ?? null, target: removedDetail.evidence?.[0]?.context?.target?.key ?? null };
			check("Q15 a removed source stays null in the accepted issue even after picking row A", removedDetail.issue?.source === null && removedDetail.issue?.description === removedText, JSON.stringify(record.steps.removedSource));
		} finally {
			await withDeadline(removed.close(), DEADLINE_MS, "q15_remove_close_page").catch(() => removed.dispose?.());
		}

		// ---- failed first POST before the server, reload, replay: one identical request ----
		const replay = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q15_replay_page");
		const replaySession = await replay.resolveSessionId();
		await replay.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: REPLAY_INTERCEPT }, replaySession);
		try {
			await withDeadline(replay.goto(`${ctx.base}/`, { waitUntil: "load" }), DEADLINE_MS, "q15_replay_goto");
			await wait(replay, `() => document.querySelector('.row[data-session="${ctx.fixtures.threads.a}"]') && !document.getElementById('issueBadge').hidden && document.querySelector('iframe.thread') ? true : null`, "q15_replay_ready");
			await withDeadline(replay.click(rowB), DEADLINE_MS, "q15_replay_select_b");
			await wait(replay, `() => document.querySelector('.row[aria-current="page"]')?.getAttribute('data-session') === "${ctx.fixtures.threads.b}" ? true : null`, "q15_replay_b");
			await withDeadline(replay.click("[data-issue-report]"), DEADLINE_MS, "q15_replay_open");
			await wait(replay, "() => document.querySelector('#issue-report')?.open === true ? true : null", "q15_replay_open_wait");
			await withDeadline(replay.click("#issue-target-pick"), DEADLINE_MS, "q15_replay_pick_open");
			const replayPick = await evalIn(replay, `(() => {
				const options = [...document.querySelectorAll('#issue-picker [role="option"]')];
				const option = options.find((node) => node.textContent.includes("결제 화면 문제 제보"));
				if (!option) return { picked: false, labels: options.map((node) => node.textContent) };
				option.click();
				return { picked: true };
			})()`, "q15_replay_pick");
			if (!replayPick.picked) throw new Error(`Q15 replay pick missing: ${JSON.stringify(replayPick)}`);
			await wait(replay, "() => document.querySelector('#issue-picker').hidden ? true : null", "q15_replay_pick_done");
			await withDeadline(replay.fill("#issue-description", REPLAY_TEXT), DEADLINE_MS, "q15_replay_fill");
			await wait(replay, "() => document.querySelector('#issue-status')?.textContent === '초안 저장됨' ? true : null", "q15_replay_saved");
			await evalIn(replay, "sessionStorage.setItem('q15FailNext', 'yes'); true", "q15_replay_fail_flag");
			await withDeadline(replay.click("#issue-send"), DEADLINE_MS, "q15_replay_send");
			await wait(replay, "() => document.querySelector('#issue-report')?.dataset.status === 'failed' ? true : null", "q15_replay_failed");
			const failedPosts = await evalIn(replay, "JSON.parse(sessionStorage.getItem('q15Posts') || '[]')", "q15_replay_posts_failed");
			check("Q15 the first send failed before the server and left one outbox request", failedPosts.length === 1 && failedPosts[0].failedBeforeServer === true, JSON.stringify(failedPosts.map((entry) => ({ status: entry.status ?? null, failed: entry.failedBeforeServer === true, bytes: entry.raw.length }))));
			await withDeadline(replay.goto(`${ctx.base}/`, { waitUntil: "load" }), DEADLINE_MS, "q15_replay_reload");
			await wait(replay, `() => document.querySelector('.row[data-session="${ctx.fixtures.threads.a}"]') && document.querySelector('iframe.thread') ? true : null`, "q15_replay_reloaded");
			const replayedPosts = await evalIn(replay, "window.__q15Replay", "q15_replay_wait");
			const firstRaw = replayedPosts[0]?.raw ?? "";
			const replayRaw = replayedPosts[1]?.raw ?? "";
			const requestId = JSON.parse(firstRaw).requestId;
			const replayDetail = await ctx.get(`/api/issues/${requestId}`);
			const replayList = await ctx.get("/api/issues?limit=100");
			const pendingCount = await evalIn(replay, `(async () => {
				const mod = await import('/web/issue-drafts.js');
				const db = await mod.openDraftDb({ indexedDB, origin: location.origin, storeId: ${JSON.stringify(storeId)} });
				try { return (await mod.listPending(db)).length; } finally { db.close(); }
			})()`, "q15_replay_pending");
			record.steps.replay = {
				posts: replayedPosts.length,
				firstEqualsReplay: firstRaw === replayRaw,
				bytes: firstRaw.length,
				requestId,
				status: replayedPosts[1]?.status ?? null,
				source: replayDetail.issue?.source ?? null,
				oneIssue: replayList.items.filter((item) => item.id === requestId).length,
				pendingCount,
			};
			check("Q15 reload replays the dropped request with the same requestId and byte-identical payload", replayedPosts.length === 2 && firstRaw === replayRaw && JSON.parse(replayRaw).requestId === requestId && replayedPosts[1].status === 201, JSON.stringify(record.steps.replay));
			check("Q15 the replay keeps picked row A as the source, creates one issue and drains the outbox", replayDetail.issue?.source?.threadId === ctx.fixtures.threads.a && replayList.items.filter((item) => item.id === requestId).length === 1 && pendingCount === 0, JSON.stringify(record.steps.replay));
		} finally {
			await withDeadline(replay.close(), DEADLINE_MS, "q15_replay_close_page").catch(() => replay.dispose?.());
		}

		// ---- storage denied: handoff waits for close ----
		const denied = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q15_denied_page");
		const deniedSession = await denied.resolveSessionId();
		await denied.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
			source: `Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() {
				const request = { result: null, error: new Error("denied for Q15"), onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
				queueMicrotask(() => { if (typeof request.onerror === "function") request.onerror({ target: request }); });
				return request;
			} } });`,
		}, deniedSession);
		try {
			await withDeadline(denied.goto(`${ctx.base}/`, { waitUntil: "load" }), DEADLINE_MS, "q15_denied_goto");
			await wait(denied, `() => document.querySelector('.row[data-session="${ctx.fixtures.threads.a}"]') && document.querySelector('iframe.thread') && !document.getElementById('issueBadge').hidden ? true : null`, "q15_denied_rows");
			await evalIn(denied, `window.__q15Marker = "denied-document"; true`, "q15_denied_marker");
			await withDeadline(denied.click("[data-issue-report]"), DEADLINE_MS, "q15_denied_open");
			await wait(denied, "() => location.pathname === '/' && document.querySelector('#issue-report')?.open === true && document.getElementById('list')?.dataset.deferred === '1' ? true : null", "q15_denied_open_wait");
			const deniedText = "저장이 막혀도 입력을 잃지 않습니다";
			const prePin = await evalIn(denied, "({ path: location.pathname + location.search, deferred: document.getElementById('list')?.dataset.deferred ?? null, open: document.querySelector('#issue-report')?.open ?? false })", "q15_denied_pre_pin");
			check("Q15 denied page defers before the breakpoint handoff", prePin.deferred === "1" && prePin.open === true, JSON.stringify(prePin));
			await withDeadline(denied.fill("#issue-description", deniedText), DEADLINE_MS, "q15_denied_fill");
			await evalIn(denied, `(() => { const field = document.querySelector('#issue-description'); field.focus(); field.setSelectionRange(5, 5); return true; })()`, "q15_denied_cursor");
			await withDeadline(pinQaPage(denied, { width: 719, height: 900, scheme }), DEADLINE_MS, "q15_denied_pin_719");
			await wait(denied, "() => innerWidth === 719 ? true : null", "q15_denied_at_719");
			const postPin = await evalIn(denied, "({ path: location.pathname + location.search, deferred: document.getElementById('list')?.dataset.deferred ?? null, open: document.querySelector('#issue-report')?.open ?? false })", "q15_denied_post_pin");
			check("Q15 denied page stays on the split document at 719", postPin.path.startsWith("/?") && postPin.deferred === "1" && postPin.open === true, JSON.stringify(postPin));
			const denied719 = await evalIn(denied, DIALOG, "q15_denied_dialog_719");
			const deniedSplit = await evalIn(denied, SPLIT, "q15_denied_split_719");
			record.steps.denied = { dialog: denied719, split: deniedSplit, text: deniedText };
			check("Q15 with storage denied the pending 719px handoff waits: the dialog, text, cursor and document stay put", denied719.open === true && denied719.count === 1 && denied719.text === deniedText && denied719.cursor === 5 && deniedSplit.marker === "denied-document" && deniedSplit.path === `/?s=${ctx.fixtures.threads.a}`, JSON.stringify({ denied719, deniedSplit }));
			await withDeadline(denied.click("#issue-close"), DEADLINE_MS, "q15_denied_close");
			// 719px has no split view: the handoff goes to the thread page, whose own narrow entry
			// returns to the list at ?s=. Either way the open document was replaced only after close.
			await wait(denied, "() => window.__q15Marker == null ? true : null", "q15_denied_handoff");
			const handoff = await evalIn(denied, `({ path: location.pathname + location.search, marker: window.__q15Marker ?? null, dialogOpen: document.querySelector('#issue-report')?.open ?? false })`, "q15_denied_after");
			record.steps.deniedHandoff = handoff;
			check("Q15 after close the pending handoff proceeds instead of during typing", handoff.marker === null && handoff.dialogOpen === false && (handoff.path === `/?s=${ctx.fixtures.threads.a}` || handoff.path === `/s/${ctx.fixtures.threads.a}`), JSON.stringify(handoff));
		} finally {
			await withDeadline(denied.close(), DEADLINE_MS, "q15_denied_close_page").catch(() => denied.dispose?.());
		}
	} finally {
		await withDeadline(page.close(), DEADLINE_MS, "q15_close_page").catch(() => page.dispose?.());
	}

	record.actions = actions;
	const actionsFile = evidence("Q15-split-actions.json", JSON.stringify(record, null, "\t"));
	check("Q15 split actions evidence saved", fs.existsSync(actionsFile) && fs.statSync(actionsFile).size > 0, actionsFile);
}
