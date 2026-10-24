/* Q17: reporting from the Review list at 390x844 in the light scheme.
 *
 * The real /boards page (no QA scaffolding: the page's own inline script registers its adapter,
 * diagnostics and reporter) is driven through the browser: the header 제보/제보함 links, a Review
 * row chosen through the reporter's 위치 선택 without leaving /boards, a submitted report whose
 * frozen source is that picked proposal and whose frozen target names it, and an issue receipt
 * that is separate from the proposal. The failure track proves an empty closed list still offers the entry,
 * and that a failed list refresh while the composer is open keeps the typed text, the 전체 filter
 * and the scroll position until close; the queued failure is applied once after close, and 다시 시도
 * recovers. Before/after the report lifecycle the proposal directory hash, the proposal counts and
 * the issue counts are equal, and the page's fetch log contains no proposal mutation.
 *
 * Every wait is a DOM event or an already-settled fetch observed under a named 10 s deadline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const viewport = { width: 390, height: 844, scheme: "light" };

const DEADLINE_MS = 10_000;
const HTTP_TIMEOUT_MS = 10_000;
const DESCRIPTION = "Review 목록에서 보낸 제보입니다";
const EMPTY_DESCRIPTION = "끝난 Review 목록에서 보낸 제보입니다";
const FILTERED = "필터가 유지되어야 하는 제보";
const HOST_TEXT = "작성 중인 설명";

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function shaTree(root) {
	const files = [];
	const walk = (dir, prefix) => {
		for (const name of fs.readdirSync(dir).sort()) {
			const full = path.join(dir, name);
			const rel = prefix ? `${prefix}/${name}` : name;
			const stat = fs.statSync(full);
			if (stat.isDirectory()) walk(full, rel);
			else if (stat.isFile()) files.push(rel);
		}
	};
	walk(root, "");
	const hash = crypto.createHash("sha256");
	for (const rel of files) {
		hash.update(rel);
		hash.update("\u0000");
		hash.update(fs.readFileSync(path.join(root, rel)));
		hash.update("\u0000");
	}
	return { files, sha256: hash.digest("hex") };
}

function listReady(minRows = 0) {
	return `new Promise((resolve, reject) => {
		const done = () => {
			const list = document.getElementById('list');
			if (!list || list.getAttribute('aria-busy') !== 'false') return null;
			const rows = document.querySelectorAll('#list .row[data-id]').length;
			if (rows < ${minRows}) return null;
			const empty = document.querySelector('#list .empty');
			return { rows, empty: empty ? empty.textContent : null, location: location.pathname + location.search };
		};
		const now = done();
		if (now) { resolve(now); return; }
		const observer = new MutationObserver(() => {
			const value = done();
			if (value) { observer.disconnect(); clearTimeout(timer); resolve(value); }
		});
		observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
		const timer = setTimeout(() => { observer.disconnect(); reject(new Error('list did not settle')); }, 9000);
	})`;
}

const REPORT_READY = `new Promise((resolve, reject) => {
	const done = () => document.querySelector('#issue-report') && document.querySelector('#issue-report').open === false && window.__inboxIssueAdapters ? true : null;
	const now = done();
	if (now) { resolve(now); return; }
	const observer = new MutationObserver(() => {
		const value = done();
		if (value) { observer.disconnect(); clearTimeout(timer); resolve(value); }
	});
	observer.observe(document.body, { subtree: true, childList: true });
	const timer = setTimeout(() => { observer.disconnect(); reject(new Error('reporter was not mounted')); }, 9000);
})`;

const DIALOG_OPEN = `new Promise((resolve, reject) => {
	const done = () => { const dialog = document.querySelector('#issue-report'); return dialog && dialog.open ? true : null; };
	const now = done();
	if (now) { resolve(now); return; }
	const observer = new MutationObserver(() => {
		const value = done();
		if (value) { observer.disconnect(); clearTimeout(timer); resolve(value); }
	});
	observer.observe(document.body, { subtree: true, childList: true, attributes: true });
	const timer = setTimeout(() => { observer.disconnect(); reject(new Error('dialog did not open')); }, 9000);
})`;

function statusIs(text) {
	return `new Promise((resolve, reject) => {
		const node = document.getElementById('issue-status');
		const done = () => node.textContent === ${JSON.stringify(text)};
		if (done()) { resolve(node.textContent); return; }
		const observer = new MutationObserver(() => { if (done()) { observer.disconnect(); clearTimeout(timer); resolve(node.textContent); } });
		observer.observe(node, { childList: true, characterData: true, subtree: true });
		const timer = setTimeout(() => { observer.disconnect(); reject(new Error('status stayed ' + JSON.stringify(node.textContent))); }, 9000);
	})`;
}

const CLOSE_ARMED = `new Promise((resolve, reject) => {
	const dialog = document.querySelector('#issue-report');
	if (!dialog || !dialog.open) { resolve('already-closed'); return; }
	const timer = setTimeout(() => reject(new Error('dialog did not close')), 9000);
	dialog.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); }, { once: true });
})`;

async function pressEscape(page, withDeadline) {
	const sessionId = await withDeadline(page.resolveSessionId(), DEADLINE_MS, "q17_session");
	const base = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
	await withDeadline(page.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId), DEADLINE_MS, "q17_escape_down");
	await withDeadline(page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId), DEADLINE_MS, "q17_escape_up");
}

const SNAPSHOT = `(() => {
	const dialog = document.querySelector('#issue-report');
	const checked = document.querySelector('#status input[name=status]:checked');
	const badge = document.getElementById('issueBadge');
	const listMarkup = (() => {
		const markup = document.getElementById('list').innerHTML;
		let hash = 0;
		for (let i = 0; i < markup.length; i += 1) hash = (hash * 31 + markup.charCodeAt(i)) | 0;
		return markup.length + ':' + hash;
	})();
	return {
		location: location.pathname + location.search,
		pathname: location.pathname,
		listMarkup,
		title: document.title,
		rows: [...document.querySelectorAll('#list .row[data-id]')].map((row) => ({ id: row.getAttribute('data-id'), href: row.getAttribute('href'), title: (row.querySelector('.title') || {}).textContent || '' })),
		empty: (document.querySelector('#list .empty') || {}).textContent || null,
		noticeHidden: document.getElementById('notice').hidden,
		filter: checked ? checked.value : null,
		scrollY,
		dialogOpen: Boolean(dialog && dialog.open),
		status: (document.getElementById('issue-status') || {}).textContent || '',
		text: (document.getElementById('issue-description') || {}).value || '',
		chip: (document.getElementById('issue-target-label') || {}).textContent || '',
		keyBadge: badge ? { hidden: badge.hidden, text: badge.textContent, label: badge.getAttribute('aria-label') } : null,
		reportCount: { hidden: document.getElementById('reportCount').hidden, text: document.getElementById('reportCount').textContent },
		trigger: Boolean(document.querySelector('[data-issue-report]')),
		triggerHref: document.querySelector('[data-issue-report]') ? document.querySelector('[data-issue-report]').getAttribute('href') : null,
		listHref: (document.querySelector('.tools a[href="/issues"]') || {}).getAttribute ? document.querySelector('.tools a[href="/issues"]').getAttribute('href') : null,
	};
})()`;

// Installed before any report interaction on each page so the whole lifecycle is observed.
const TRACKER = `(() => {
	const realFetch = window.fetch.bind(window);
	window.__q17 = { realFetch, calls: [], failProposals: false, failureDone: null, failures: 0 };
	window.fetch = (input, init) => {
		const url = typeof input === 'string' ? input : input.url;
		const method = String((init && init.method) || 'GET').toUpperCase();
		window.__q17.calls.push({ url, method });
		if (window.__q17.failProposals && url.startsWith('/api/proposals')) {
			window.__q17.failures += 1;
			return Promise.resolve({
				status: 500,
				get ok() {
					const done = window.__q17.failureDone;
					window.__q17.failureDone = null;
					if (done) done();
					return false;
				},
			});
		}
		return realFetch(input, init);
	};
	return true;
})()`;

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const actions = [];
	const record = { viewport: { width, height, scheme }, http: {}, reports: {}, failure: {}, proposals: {} };
	const act = (step, detail, signal) => actions.push({ step, detail, signal, at: new Date().toISOString() });
	const evalIn = (page, expression, name) => withDeadline(page.evaluate(expression), DEADLINE_MS, name);
	const request = async (label, route) => {
		const res = await fetch(ctx.base + route, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		act(`http:${label}`, `GET ${route} -> ${res.status}`, "fetch settled within 10000ms");
		return { status: res.status, body };
	};
	const proposalsDir = path.join(ctx.home, "data", "proposals");
	const before = {
		tree: shaTree(proposalsDir),
		proposals: await request("proposals-before", "/api/proposals?status=all"),
		issues: await request("issues-before", "/api/issues?limit=1"),
	};
	record.proposals.before = { tree: before.tree, counts: before.proposals.body && before.proposals.body.counts, issueCounts: before.issues.body && before.issues.body.counts };

	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q17_new_page");
	let wide = null;
	try {
		await withDeadline(page.goto(`${ctx.base}/boards`, { waitUntil: "load" }), DEADLINE_MS, "q17_goto_boards");
		act("goto", "/boards", "load event");
		const ready = await evalIn(page, REPORT_READY, "q17_reporter_ready");
		// The page's first list request can finish before the dynamic imports install diagnostics.
		// Use the page's own retry hook so the later request is recorded before the capture.
		await evalIn(page, "(() => { document.getElementById('retry').click(); return true; })()", "q17_record_list_request");
		const list = await evalIn(page, listReady(1), "q17_list_ready");
		const start = await evalIn(page, SNAPSHOT, "q17_start_snapshot");
		const overflow = await evalIn(page, `(() => {
			const filters = document.querySelector('.filters').getBoundingClientRect();
			const seg = document.getElementById('status').getBoundingClientRect();
			return {
				width: innerWidth,
				scrollWidth: document.documentElement.scrollWidth,
				clientWidth: document.documentElement.clientWidth,
				filters: { left: filters.left, right: filters.right, width: filters.width },
				seg: { left: seg.left, right: seg.right, width: seg.width },
			};
		})()`, "q17_overflow_measurement");
		record.overflow = overflow;
		check(`Q17 /boards fits ${width}px without horizontal overflow`, overflow.scrollWidth <= overflow.width && overflow.clientWidth <= overflow.width, JSON.stringify(overflow));
		evidence(`Q17-boards-${width}.png`, Buffer.from(await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q17_overflow_screenshot")));
		act("measure", `scrollWidth ${overflow.scrollWidth} <= innerWidth ${overflow.width} at ${width}px`, "page.evaluate resolved");
		const tracker = await evalIn(page, TRACKER, "q17_install_tracker");
		const hitAreas = await evalIn(page, `(() => ['[data-issue-report]', '.tools a[href="/issues"]'].flatMap((selector) => [...document.querySelectorAll(selector)].map((el) => { const box = el.getBoundingClientRect(); return { selector, label: el.textContent.trim(), width: box.width, height: box.height }; })))()`, "q17_hit_areas");
		record.hitAreas = { narrow: hitAreas };
		record.starts = { ready, list, start, tracker };
		check("Q17 the new header links have 44px hit areas at 390x844", tracker === true && hitAreas.length === 2 && hitAreas.every((box) => box.width >= 44 && box.height >= 44), JSON.stringify(hitAreas));
		check("Q17 the real Review page mounts the reporter from its own script", ready === true, JSON.stringify({ ready }));
		check("Q17 the header has independent 제보/제보함 links", start.trigger === true && start.triggerHref === "/issues/new" && start.listHref === "/issues", JSON.stringify({ trigger: start.trigger, triggerHref: start.triggerHref, listHref: start.listHref }));
		check("Q17 the seeded Review rows still render and navigate to /p/", list.rows >= 2 && start.rows.every((row) => row.href && row.href.startsWith("/p/")), JSON.stringify(start.rows));
		check("Q17 the 제보함 badge is a separate element from the Review 보고 count", start.keyBadge && start.keyBadge.hidden === true && typeof start.reportCount.text === "string", JSON.stringify({ keyBadge: start.keyBadge, reportCount: start.reportCount }));

		// ---- happy: pick a Review row as the target without navigating, then send ----
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q17_open_reporter");
		await evalIn(page, DIALOG_OPEN, "q17_dialog_open");
		const opened = await evalIn(page, SNAPSHOT, "q17_opened_snapshot");
		record.reports.opened = opened;
		check("Q17 the entry opens the composer without navigating and leaves the list DOM unchanged", opened.dialogOpen === true && opened.pathname === "/boards" && opened.location === "/boards" && opened.listMarkup === start.listMarkup, JSON.stringify({ open: opened.dialogOpen, location: opened.location, pathname: opened.pathname, listMarkup: opened.listMarkup, before: start.listMarkup }));

		const row = start.rows[0];
		await withDeadline(page.click("#issue-target-pick"), DEADLINE_MS, "q17_open_picker");
		const options = await evalIn(page, "(() => [...document.querySelectorAll('#issue-picker [role=option]')].map((option) => ({ index: option.getAttribute('data-index'), text: option.textContent })))()", "q17_picker_options");
		const picked = options.find((option) => option.text.includes(row.title));
		check("Q17 위치 선택 offers the visible Review rows with their titles", Boolean(picked), JSON.stringify({ options, title: row.title }));
		const beforePick = {
			proposals: await request("proposals-after-picker-open", "/api/proposals?status=all"),
			issues: await request("issues-after-picker-open", "/api/issues?limit=1"),
		};
		await withDeadline(page.click(`#issue-picker [data-index="${picked.index}"]`), DEADLINE_MS, "q17_pick_target");
		act("click", `picker option ${picked.index} (${row.title})`, "page.click resolved");
		const afterPick = await evalIn(page, SNAPSHOT, "q17_after_pick");
		const pickCounts = await request("proposals-after-pick", "/api/proposals?status=all");
		record.reports.picked = { row, beforePick: beforePick.proposals.body.counts, afterPickCounts: pickCounts.body.counts, snapshot: afterPick };
		check("Q17 selecting a Review row keeps /boards, the list DOM and names it in the target chip", afterPick.pathname === "/boards" && afterPick.location === "/boards" && afterPick.listMarkup === start.listMarkup && afterPick.dialogOpen === true && afterPick.chip.includes(row.title), JSON.stringify({ location: afterPick.location, listMarkup: afterPick.listMarkup, before: start.listMarkup, chip: afterPick.chip, title: row.title }));
		check("Q17 selecting a target invokes no proposal mutation and leaves the Review counts equal", JSON.stringify(beforePick.proposals.body.counts) === JSON.stringify(pickCounts.body.counts) && afterPick.rows.length === start.rows.length && afterPick.rows[0].id === row.id, JSON.stringify({ before: beforePick.proposals.body.counts, after: pickCounts.body.counts }));

		const composerShot = Buffer.from(await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q17_composer_screenshot"));
		evidence("Q17-composer.png", composerShot);
		act("screenshot", "Q17-composer.png", "page.screenshot resolved");

		await withDeadline(page.fill("#issue-description", DESCRIPTION), DEADLINE_MS, "q17_fill_description");
		const accepted = evalIn(page, statusIs("접수했습니다"), "q17_accepted");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q17_send");
		act("click", "#issue-send", "awaiting 접수했습니다");
		await accepted;
		const sent = await evalIn(page, SNAPSHOT, "q17_sent_snapshot");
		const receipt = await evalIn(page, "(() => { const link = document.getElementById('issue-link'); return { href: link ? link.getAttribute('href') : null, receiptHidden: document.getElementById('issue-receipt').hidden, status: document.getElementById('issue-status').textContent }; })()", "q17_receipt");
		record.reports.sent = { snapshot: sent, receipt };
		check("Q17 보내기 yields 접수했습니다 and a separate issue receipt link", sent.status === "접수했습니다" && receipt.receiptHidden === false && /^\/issues\/[0-9a-f-]{36}$/.test(receipt.href ?? ""), JSON.stringify({ status: sent.status, receipt }));
		const issueId = receipt.href.slice("/issues/".length);
		const detail = await request("issue-detail", `/api/issues/${issueId}`);
		const context = detail.body && detail.body.evidence && detail.body.evidence[0] && detail.body.evidence[0].context;
		record.reports.detail = { status: detail.status, description: detail.body && detail.body.issue && detail.body.issue.description, source: detail.body && detail.body.issue && detail.body.issue.source, context };
		check("Q17 the issue is a separate record whose frozen source and target name the picked proposal and title", detail.status === 200 && detail.body.issue.description === DESCRIPTION && detail.body.issue.source && detail.body.issue.source.kind === "proposal" && detail.body.issue.source.proposalId === row.id && context && context.page === "boards" && context.target && context.target.kind === "record" && context.target.key === `proposal:${row.id}` && context.target.label === row.title && context.source && context.source.kind === "proposal" && context.source.proposalId === row.id, JSON.stringify(record.reports.detail));
		check("Q17 the frozen capture lists the visible Review ids and bounded diagnostics", context && context.visibleIds.includes(row.id) && context.visibleIds.length === start.rows.length && Array.isArray(context.diagnostics) && context.diagnostics.some((entry) => entry.type === "action" && entry.name === "open_report") && context.diagnostics.some((entry) => entry.type === "request" && entry.route === "proposals_list"), JSON.stringify({ visibleIds: context && context.visibleIds, diagnostics: context && context.diagnostics }));
		const sentShot = Buffer.from(await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q17_boards_screenshot"));
		evidence("Q17-boards.png", sentShot);
		act("screenshot", "Q17-boards.png", "page.screenshot resolved");
		check("Q17 the report lifecycle leaves /boards and its list DOM in place", sent.pathname === "/boards" && sent.location === "/boards" && sent.listMarkup === start.listMarkup && sent.rows.length === start.rows.length && sent.dialogOpen === true, JSON.stringify({ location: sent.location, listMarkup: sent.listMarkup, before: start.listMarkup, rows: sent.rows.length }));
		const closed = evalIn(page, CLOSE_ARMED, "q17_close");
		await pressEscape(page, withDeadline);
		act("keyboard", "Escape", "awaiting dialog close");
		await closed;
		const afterClose = await evalIn(page, SNAPSHOT, "q17_after_close");
		check("Q17 Escape closes only the reporter and keeps /boards", afterClose.dialogOpen === false && afterClose.location === "/boards", JSON.stringify({ open: afterClose.dialogOpen, location: afterClose.location }));
		const firstCalls = await evalIn(page, "window.__q17 ? window.__q17.calls : []", "q17_first_fetch_log");

		// ---- empty closed list still offers the entry and can report ----
		await withDeadline(page.goto(`${ctx.base}/boards?status=closed`, { waitUntil: "load" }), DEADLINE_MS, "q17_goto_closed");
		await evalIn(page, REPORT_READY, "q17_closed_ready");
		await evalIn(page, TRACKER, "q17_closed_tracker");
		const emptyList = await evalIn(page, listReady(0), "q17_closed_list");
		const emptyShot = await evalIn(page, SNAPSHOT, "q17_closed_snapshot");
		record.failure.empty = { emptyList, emptyShot };
		check("Q17 an empty closed Review list still renders the empty state on the closed filter", emptyList.rows === 0 && emptyList.empty === "검토할 것이 없습니다." && emptyShot.filter === "closed", JSON.stringify({ emptyList, filter: emptyShot.filter }));
		check("Q17 the report entry exists on the empty closed list", emptyShot.trigger === true, JSON.stringify({ trigger: emptyShot.trigger }));
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q17_open_closed");
		await evalIn(page, DIALOG_OPEN, "q17_closed_open");
		await withDeadline(page.fill("#issue-description", EMPTY_DESCRIPTION), DEADLINE_MS, "q17_fill_closed");
		const emptyAccepted = evalIn(page, statusIs("접수했습니다"), "q17_closed_accepted");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q17_send_closed");
		act("click", "#issue-send on the empty closed list", "awaiting 접수했습니다");
		await emptyAccepted;
		const emptySent = await evalIn(page, SNAPSHOT, "q17_closed_sent");
		record.failure.empty.sent = emptySent;
		check("Q17 a report from the empty closed list is accepted without leaving the filter", emptySent.status === "접수했습니다" && emptySent.location === "/boards?status=closed" && emptySent.rows.length === 0, JSON.stringify({ status: emptySent.status, location: emptySent.location, rows: emptySent.rows.length }));
		const emptyClosed = evalIn(page, CLOSE_ARMED, "q17_closed_close");
		await pressEscape(page, withDeadline);
		await emptyClosed;
		const emptyCalls = await evalIn(page, "window.__q17 ? window.__q17.calls : []", "q17_empty_fetch_log");

		// ---- all filter + failed refresh while the composer is open ----
		await withDeadline(page.goto(`${ctx.base}/boards?status=all`, { waitUntil: "load" }), DEADLINE_MS, "q17_goto_all");
		await evalIn(page, REPORT_READY, "q17_all_ready");
		await evalIn(page, TRACKER, "q17_all_tracker");
		const allList = await evalIn(page, listReady(1), "q17_all_list");
		// Tall enough that 120px of scroll room survives the notice appearing and disappearing at 1024x800.
		await evalIn(page, "(() => { const spacer = document.createElement('div'); spacer.id = 'q17-spacer'; spacer.style.height = '1200px'; document.body.append(spacer); scrollTo(0, 120); return true; })()", "q17_spacer");
		await evalIn(page, "new Promise((resolve) => requestAnimationFrame(() => resolve(scrollY)))", "q17_scroll_ready");
		const beforeOpen = await evalIn(page, SNAPSHOT, "q17_before_open");
		check("Q17 the 전체 filter shows the rows and the page is scrolled", allList.rows >= 2 && beforeOpen.filter === "all" && beforeOpen.scrollY > 0, JSON.stringify({ rows: allList.rows, filter: beforeOpen.filter, scrollY: beforeOpen.scrollY }));
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q17_open_failure");
		await evalIn(page, DIALOG_OPEN, "q17_failure_open");
		await withDeadline(page.fill("#issue-description", FILTERED), DEADLINE_MS, "q17_fill_failure");
		const during = await evalIn(page, `new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('failed refresh did not settle')), 9000);
			window.__q17.failureDone = () => { clearTimeout(timer); resolve(true); };
			window.__q17.failProposals = true;
			document.getElementById('retry').click();
		}).then(() => ${SNAPSHOT})`, "q17_during_failure");
		const failures = await evalIn(page, "window.__q17.failures", "q17_failure_count");
		record.failure.during = { tracker, failures, during };
		check("Q17 a failed list refresh while the composer is open keeps the typed text", tracker === true && failures === 1 && during.dialogOpen === true && during.text === FILTERED && during.status !== "접수했습니다", JSON.stringify({ failures, text: during.text, status: during.status }));
		check("Q17 the failed refresh keeps the 전체 filter, the rows and the scroll position", during.filter === "all" && during.location.endsWith("status=all") && during.rows.length === beforeOpen.rows.length && during.scrollY === beforeOpen.scrollY, JSON.stringify({ filter: during.filter, location: during.location, rows: during.rows.length, before: beforeOpen.rows.length, scrollY: during.scrollY, beforeScroll: beforeOpen.scrollY }));
		check("Q17 the deferred failure has not painted the notice over the open composer", during.noticeHidden === true, JSON.stringify({ noticeHidden: during.noticeHidden }));
		const failureClosed = evalIn(page, CLOSE_ARMED, "q17_failure_close");
		await pressEscape(page, withDeadline);
		act("keyboard", "Escape with a queued failed refresh", "awaiting dialog close");
		await failureClosed;
		const resumed = await evalIn(page, SNAPSHOT, "q17_resumed_snapshot");
		record.failure.resumed = resumed;
		check("Q17 closing applies the queued failure once and keeps the filter, rows and scroll", resumed.dialogOpen === false && resumed.noticeHidden === false && resumed.filter === "all" && resumed.rows.length === beforeOpen.rows.length && resumed.scrollY === beforeOpen.scrollY, JSON.stringify({ open: resumed.dialogOpen, noticeHidden: resumed.noticeHidden, filter: resumed.filter, rows: resumed.rows.length, scrollY: resumed.scrollY }));
		await evalIn(page, "(() => { window.fetch = window.__q17.realFetch; return true; })()", "q17_restore_fetch");
		const retryAccepted = evalIn(page, "new Promise((resolve, reject) => { const notice = document.getElementById('notice'); const done = () => notice.hidden === true ? true : null; const now = done(); if (now) { resolve(now); return; } const observer = new MutationObserver(() => { const value = done(); if (value) { observer.disconnect(); clearTimeout(timer); resolve(value); } }); observer.observe(notice, { attributes: true, attributeFilter: ['hidden'] }); const timer = setTimeout(() => { observer.disconnect(); reject(new Error('notice stayed visible')); }, 9000); })", "q17_retry_notice");
		const probe = `(() => { const row = document.querySelector('#list .row[data-id]'); const notice = document.getElementById('notice'); return { scrollY, active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null, noticeHidden: notice.hidden, noticeTop: notice.getBoundingClientRect().top, rowTop: row.getBoundingClientRect().top, docHeight: document.documentElement.scrollHeight }; })()`;
		const beforeRetry = await evalIn(page, probe, "q17_before_retry_probe");
		// Activate through the DOM: a driver click would scroll the sticky-covered button into view and
		// move the very scroll position this step asserts.
		await evalIn(page, "(() => { document.getElementById('retry').click(); return true; })()", "q17_retry");
		act("click", "#retry after restoring fetch", "awaiting notice hidden");
		await retryAccepted;
		const afterRetry = await evalIn(page, probe, "q17_after_retry_probe");
		record.failure.scrollProbe = { beforeRetry, afterRetry };
		const recovered = await evalIn(page, SNAPSHOT, "q17_recovered");
		record.failure.recovered = recovered;
		// Hiding the notice shortens the document by its own height. Chrome may anchor the first row in
		// place by lowering scrollY; either the numeric scroll or the visible row position must persist.
		check("Q17 다시 시도 recovers the list with the filter and scroll kept", recovered.noticeHidden === true && recovered.filter === "all" && recovered.rows.length === beforeOpen.rows.length && (recovered.scrollY === beforeOpen.scrollY || afterRetry.rowTop === beforeRetry.rowTop), JSON.stringify({ noticeHidden: recovered.noticeHidden, rows: recovered.rows.length, filter: recovered.filter, scrollY: recovered.scrollY, beforeScroll: beforeOpen.scrollY, rowTop: afterRetry.rowTop, rowTopBeforeRetry: beforeRetry.rowTop }));
		await evalIn(page, "(() => { document.getElementById('q17-spacer')?.remove(); return true; })()", "q17_remove_spacer");

		// ---- lifecycle isolation: proposals bytes, counts and fetch log ----
		const after = {
			tree: shaTree(proposalsDir),
			proposals: await request("proposals-after", "/api/proposals?status=all"),
			issues: await request("issues-after", "/api/issues?limit=1"),
		};
		record.proposals.after = { tree: after.tree, counts: after.proposals.body && after.proposals.body.counts, issueCounts: after.issues.body && after.issues.body.counts };
		const allCalls = await evalIn(page, "window.__q17 ? window.__q17.calls : []", "q17_fetch_log");
		const calls = [...firstCalls, ...emptyCalls, ...allCalls];
		record.http.fetchLog = calls;
		check("Q17 request logging covers the lifecycle from before target selection", firstCalls.some((entry) => entry.url.startsWith("/api/proposals")) && firstCalls.some((entry) => entry.method === "POST") && allCalls.some((entry) => entry.url.startsWith("/api/proposals")), JSON.stringify({ first: firstCalls, all: allCalls }));
		const mutations = calls.filter((entry) => entry.method !== "GET" && (entry.url.startsWith("/api/p") || entry.url.startsWith("/api/proposals")));
		check("Q17 no proposal event is appended: the proposal directory sha256 is byte-identical", before.tree.sha256 === after.tree.sha256 && before.tree.files.join() === after.tree.files.join(), JSON.stringify({ before: before.tree.sha256, after: after.tree.sha256, files: after.tree.files }));
		check("Q17 Review counts are unchanged and the page sent no proposal mutation", JSON.stringify(before.proposals.body.counts) === JSON.stringify(after.proposals.body.counts) && mutations.length === 0, JSON.stringify({ before: before.proposals.body.counts, after: after.proposals.body.counts, mutations }));
		check("Q17 the issue count grew only by the two submitted reports", before.issues.body.counts && after.issues.body.counts && ["open", "investigating", "needs-check", "resolved"].every((state) => after.issues.body.counts[state] === before.issues.body.counts[state] + (state === "open" ? 2 : 0)), JSON.stringify({ before: before.issues.body.counts, after: after.issues.body.counts }));

		// ---- desktop width: the same header keeps its layout ----
		wide = await withDeadline(newQaPage(browser, { width: 1280, height: 800, scheme }), DEADLINE_MS, "q17_wide_page");
		await withDeadline(wide.goto(`${ctx.base}/boards`, { waitUntil: "load" }), DEADLINE_MS, "q17_wide_goto");
		await evalIn(wide, REPORT_READY, "q17_wide_ready");
		await evalIn(wide, listReady(1), "q17_wide_list");
		const wideOverflow = await evalIn(wide, "({ scrollWidth: document.documentElement.scrollWidth, innerWidth, trigger: Boolean(document.querySelector('[data-issue-report]')) })", "q17_wide_snapshot");
		const wideHitAreas = await evalIn(wide, `(() => ['[data-issue-report]', '.tools a[href="/issues"]'].flatMap((selector) => [...document.querySelectorAll(selector)].map((el) => { const box = el.getBoundingClientRect(); return { selector, width: box.width, height: box.height }; })))()`, "q17_wide_hit_areas");
		record.wide = { ...wideOverflow, hitAreas: wideHitAreas };
		check("Q17 the 1280px Review page shows the entry without horizontal overflow", wideOverflow.trigger === true && wideOverflow.scrollWidth <= wideOverflow.innerWidth, JSON.stringify(wideOverflow));
		check("Q17 the new header links have 44px hit areas at 1280px", wideHitAreas.length === 2 && wideHitAreas.every((box) => box.width >= 44 && box.height >= 44), JSON.stringify(wideHitAreas));
		evidence("Q17-boards-1280.png", Buffer.from(await withDeadline(wide.screenshot({ type: "png" }), DEADLINE_MS, "q17_wide_screenshot")));
		act("screenshot", "Q17-boards-1280.png", "page.screenshot resolved");
	} finally {
		evidence("Q17-actions.json", JSON.stringify({ actions, record }, null, "\t"));
		const treeAfter = (() => {
			try {
				return shaTree(path.join(ctx.home, "data", "proposals"));
			} catch (error) {
				return { files: [], sha256: null, error: String(error && error.message ? error.message : error) };
			}
		})();
		evidence("Q17-source-diff.json", JSON.stringify({
			proposals: { before: before.tree, after: treeAfter, identical: before.tree.sha256 === treeAfter.sha256 },
			reviewCounts: { before: before.proposals.body && before.proposals.body.counts, after: record.proposals.after && record.proposals.after.counts },
			fetchLog: record.http.fetchLog ?? [],
		}, null, "\t"));
		if (wide) await withDeadline(wide.close(), DEADLINE_MS, "q17_wide_close").catch(() => wide.dispose?.());
		await withDeadline(page.close(), DEADLINE_MS, "q17_page_close").catch(() => page.dispose?.());
	}
}
