/* Q13: the minimal composer and the receipt-safe send flow, in a real browser on `/`.
 *
 * QA scaffolding (wave D wires the real pages): the scenario injects the `<a data-issue-report>`
 * trigger into the inbox header tools, registers an inbox adapter whose context is the first
 * visible thread row, and mounts web/issue-report.js with an instrumented fetch (modes: normal,
 * drop = throw after the server committed, malformed = replace a 2xx body, hang = never resolve),
 * a controllable uuid() and, when wanted, a denied indexedDB or a wrong storeId. The page's own
 * script is untouched; a host input proves the dialog never steals or clears underlying inputs.
 *
 * Happy path (390x844 light): click the trigger (the page's own history.state keeps its fields and
 * gains only the reporter token), fill #issue-description, open 첨부 확인 and require the retained
 * values themselves (excerpt text, visible ids, view fields, build digest) each with 지우기, remove
 * one item, pick a record target with the keyboard (and pick it back after removing its row), prove
 * the focus trap, click #issue-send and
 * require 접수했습니다, exactly one issue, a receipt whose link names it and whose create event
 * matches, the frozen source equal to the visible thread, and Escape closing with focus back on
 * the opener, the token popped and the page's history.state restored untouched.
 *
 * Failure track: empty description blocked without a request; response dropped after commit ->
 * 접수 확인 중 with locked text, retry while offline queued, the online event resolves to the exact
 * original receipt with one issue, reload resumes nothing; a draft saved on thread A and restored
 * on a page showing B keeps A's source, excerpt and observation time through a removal, the saved
 * IndexedDB record then holds only the approved context (the removed ids and the deselected excerpt
 * text are absent from every stored byte while source and observation time stay), a second restore
 * shows exactly that, and only 초안 버리기 recaptures B; reload mid-send resumes the outbox exactly
 * once with the same requestId;
 * denied IndexedDB requires 저장 없이 보내기; 409 key_reused and 409 store_changed keep the text and
 * need the explicit new request/store; a malformed success body stays 접수 확인 중 and resolves to
 * the original receipt; a 403 rejected at the fetch boundary retires its outbox entry, the edited
 * resend is a new request and a reload posts nothing (the real issue count stays equal). Every
 * wait is an awaited event (MutationObserver on #issue-status, dialog close event, online event)
 * under a named 10 s deadline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const viewport = { width: 390, height: 844, scheme: "light" };

const DEADLINE_MS = 10_000;
const HOST_VALUE = "호스트 입력값";
const DESCRIPTION = "보내기 버튼이 눌리지 않습니다";
const WRONG_STORE = "99999999-9999-4999-8999-999999999999";
const REUSED_ID = "13131313-1313-4313-8313-131313131313";
const REUSED_CAPTURE = "14141414-1414-4414-8414-141414141414";
const PAGE_STATE = { viewer: "preserve-viewer", custom: 42 };
const OTHER_THREAD = "q13-other-thread";

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

// ---------- page-side scaffolding ----------

function setupExpression({ denyIndexedDb = false, storeId = null, source = null } = {}) {
	return `(async () => {
		const prev = window.__q13;
		if (prev && prev.report) { try { prev.report.destroy(); } catch {} }
		const q = { http: prev ? prev.http : [], mode: 'normal', forceNext: null, deferred: 0, resumed: 0, imageMounted: false };
		window.__q13 = q;
		if (!document.querySelector('[data-issue-report]')) {
			const anchor = document.createElement('a');
			anchor.dataset.issueReport = '';
			anchor.href = '/issues/new';
			anchor.className = 'ctl';
			anchor.id = 'q13-report';
			anchor.textContent = '제보';
			const tools = document.querySelector('nav.tools') || document.body;
			tools.prepend(anchor);
		}
		if (!document.querySelector('#q13-host-input')) {
			const host = document.createElement('input');
			host.id = 'q13-host-input';
			host.type = 'text';
			host.value = ${JSON.stringify(HOST_VALUE)};
			host.setAttribute('aria-label', 'host input');
			host.style.cssText = 'position:fixed;left:8px;bottom:8px;width:200px;z-index:1';
			document.body.append(host);
		}
		const [reportMod, draftsMod, diagMod, adaptersMod] = await Promise.all([
			import('/web/issue-report.js'), import('/web/issue-drafts.js'), import('/web/issue-diagnostics.js'), import('/web/issue-adapters.js')
		]);
		let image = null;
		try {
			const imageMod = await import('/web/issue-image.js');
			image = imageMod.createIssueImage({ document, now: () => performance.now() });
			q.imageMounted = true;
		} catch (error) {
			q.imageError = String(error && error.message ? error.message : error);
		}
		const registry = window.__inboxIssueAdapters && window.__inboxIssueAdapters.__q13 ? window.__inboxIssueAdapters : adaptersMod.createAdapterRegistry({ ownerWindow: window });
		registry.__q13 = true;
		const visibleRows = () => Array.from(document.querySelectorAll('.row[data-session]')).filter((row) => {
			const box = row.getBoundingClientRect();
			return box.width > 0 && box.bottom > 0 && box.top < innerHeight;
		});
		const rowLabel = (row) => ((row.querySelector('.title') || row.querySelector('.line') || row).textContent || '').trim().slice(0, 80) || row.dataset.session;
		const handle = registry.register({
			page: 'inbox',
			getContext() {
				const rows = visibleRows();
				const first = rows[0] || null;
				// QA knob: a page "showing another thread" for the restore-baseline track.
				const override = ${JSON.stringify(source)};
				const threadId = override || (first ? first.dataset.session : null);
				return {
					page: 'inbox',
					source: threadId ? { kind: 'thread', threadId, itemId: null, observedSeq: 0 } : null,
					target: null,
					view: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: 1, scrollX, scrollY, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', locale: navigator.language || 'ko-KR', embedded: false, viewerOpen: false },
					excerpt: override ? 'override ' + override : (first ? rowLabel(first) : null),
					excerptEnabled: false,
					visibleIds: override ? [override] : rows.slice(0, 50).map((row) => row.dataset.session),
					diagnostics: [],
					clientBuild: null
				};
			},
			getTargets() {
				const rows = visibleRows();
				return [
					{ kind: 'page', key: 'inbox', label: 'Inbox', rect: { x: 0, y: 0, w: innerWidth, h: innerHeight }, framePath: [] },
					...rows.map((row) => { const box = row.getBoundingClientRect(); return { kind: 'record', key: 'thread:' + row.dataset.session, label: rowLabel(row), rect: { x: box.left, y: box.top, w: box.width, h: box.height }, framePath: [] }; })
				];
			},
			deferRender() { q.deferred += 1; },
			resumeRender() { q.resumed += 1; }
		});
		const diagnostics = diagMod.createDiagnostics({ now: () => performance.now() });
		const fetchImpl = async (url, init) => {
			const method = (init && init.method) || 'GET';
			const entry = { seq: q.http.length + 1, method, url: String(url), mode: q.mode, status: null, note: null, document: q.documentId };
			q.http.push(entry);
			if (q.mode === 'hang' && method === 'POST') { entry.note = 'never resolved (hang)'; return new Promise(() => {}); }
			if (q.mode === 'forbidden' && method === 'POST') { q.mode = 'normal'; entry.status = 403; entry.note = '403 rejected at the fetch boundary; the server never saw this request'; return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } }); }
			const res = await fetch(url, init);
			entry.status = res.status;
			if (q.mode === 'drop' && method === 'POST') { q.mode = 'normal'; entry.note = 'response dropped after the server committed'; throw new TypeError('Failed to fetch'); }
			if (q.mode === 'malformed' && method === 'POST') { q.mode = 'normal'; entry.note = 'body replaced with {} (malformed success)'; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }
			return res;
		};
		q.documentId = (prev && prev.documentId ? prev.documentId : 0) + 1;
		const uuid = () => { if (q.forceNext) { const value = q.forceNext; q.forceNext = null; return value; } return crypto.randomUUID(); };
		let indexedDbOption;
		if (${denyIndexedDb ? "true" : "false"}) {
			indexedDbOption = { open() {
				const request = { result: null, error: new Error('indexedDB denied'), onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
				queueMicrotask(() => { if (typeof request.onerror === 'function') request.onerror({ target: request }); });
				return request;
			} };
		}
		const options = { document, window, adapters: registry, drafts: draftsMod, diagnostics, image, fetchImpl, now: () => Date.now(), uuid, buildId: null };
		if (indexedDbOption) options.indexedDB = indexedDbOption;
		if (${JSON.stringify(storeId)}) options.capabilities = { storeId: ${JSON.stringify(storeId)} };
		const report = reportMod.mountIssueReport(options);
		q.report = report; q.registry = registry; q.handle = handle; q.TEXT = reportMod.TEXT; q.image = image;
		q.waitStatus = (text, timeoutMs = 9000) => new Promise((resolve, reject) => {
			const node = document.querySelector('#issue-status');
			if (node.textContent === text) { resolve(node.textContent); return; }
			const timer = setTimeout(() => { observer.disconnect(); reject(new Error('status did not become ' + JSON.stringify(text) + ' (now ' + JSON.stringify(node.textContent) + ')')); }, timeoutMs);
			const observer = new MutationObserver(() => { if (node.textContent === text) { clearTimeout(timer); observer.disconnect(); resolve(node.textContent); } });
			observer.observe(node, { childList: true, characterData: true, subtree: true });
		});
		q.waitClose = (timeoutMs = 9000) => new Promise((resolve, reject) => {
			const dialog = document.querySelector('#issue-report');
			if (!dialog.open) { resolve('already-closed'); return; }
			const timer = setTimeout(() => reject(new Error('dialog did not close')), timeoutMs);
			dialog.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); }, { once: true });
		});
		q.waitOnline = (timeoutMs = 9000) => new Promise((resolve, reject) => {
			if (navigator.onLine) { resolve('already-online'); return; }
			const timer = setTimeout(() => reject(new Error('online event did not fire')), timeoutMs);
			window.addEventListener('online', () => { clearTimeout(timer); resolve('online'); }, { once: true });
		});
		const resumed = await report.ready;
		const rows = visibleRows();
		return {
			trigger: Boolean(document.querySelector('[data-issue-report]')),
			adapter: handle,
			resumed,
			visibleThread: rows[0] ? rows[0].dataset.session : null,
			rowCount: document.querySelectorAll('.row[data-session]').length,
			hostValue: document.querySelector('#q13-host-input').value,
			imageMounted: q.imageMounted,
			imageError: q.imageError || null,
			stylesheet: Boolean(document.querySelector('link[data-issue-report-style]')),
			storeId: report.state().storeId
		};
	})()`;
}

const STATE = `(() => {
	const q = window.__q13;
	const s = q.report.state();
	const dialog = document.querySelector('#issue-report');
	const textarea = document.querySelector('#issue-description');
	const retry = document.querySelector('#issue-retry');
	const send = document.querySelector('#issue-send');
	return {
		status: s.status, text: s.text, requestId: s.requestId, attempts: s.attempts, autoRetried: s.autoRetried, outbox: s.outbox, storage: s.storage,
		failure: s.failure, receipt: s.receipt, issueId: s.issueId, replayed: s.replayed, generation: s.generation, storeId: s.storeId,
		target: s.target, removed: s.removed, excerptEnabled: s.excerptEnabled, retired: s.retired,
		envelope: s.envelope ? { requestId: s.envelope.requestId, storeId: s.envelope.storeId, description: s.envelope.description, captureId: s.envelope.evidence.captureId, source: s.envelope.evidence.source, target: s.envelope.evidence.target, visibleIds: s.envelope.evidence.visibleIds.length, visual: s.envelope.evidence.visual.kind } : null,
		context: s.context ? { captureId: s.context.captureId, observedAt: s.context.observedAt, source: s.context.source, target: s.context.target, excerpt: s.context.excerpt, visibleIds: s.context.visibleIds.length, diagnostics: s.context.diagnostics.length, contextStatus: s.context.contextStatus } : null,
		open: dialog.open, modal: dialog.matches(':modal'), statusText: document.querySelector('#issue-status').textContent, statusTone: document.querySelector('#issue-status').dataset.tone,
		textareaValue: textarea.value, readOnly: textarea.readOnly, activeId: document.activeElement ? document.activeElement.id : null, activeInDialog: dialog.contains(document.activeElement),
		chip: document.querySelector('#issue-target-label').textContent, pickLabel: document.querySelector('#issue-target-pick').textContent, pickerHidden: document.querySelector('#issue-picker').hidden,
		retry: { hidden: retry.hidden, text: retry.textContent, action: retry.dataset.action, disabled: retry.disabled }, sendDisabled: send.disabled, sendHidden: send.hidden,
		copyHidden: document.querySelector('#issue-copy').hidden, copyText: document.querySelector('#issue-copy').textContent,
		link: document.querySelector('#issue-link').getAttribute('href'), receiptHidden: document.querySelector('#issue-receipt').hidden,
		historyToken: history.state && history.state.issueReport ? history.state.issueReport : null, historyState: history.state, deferred: q.deferred, resumed: q.resumed,
		hostValue: document.querySelector('#q13-host-input').value, rowCount: document.querySelectorAll('.row[data-session]').length,
		onLine: navigator.onLine, httpCount: q.http.length, posts: q.http.filter((entry) => entry.method === 'POST' && entry.url === '/api/issues').length
	};
})()`;

// The 첨부 확인 list as the user sees it: one row per retained item with its posted value and 지우기.
const ATTACH = `(() => {
	const list = document.querySelector('#issue-attach-list');
	return {
		hidden: list.hidden,
		summary: document.querySelector('#issue-attach-summary').textContent,
		items: Array.from(list.querySelectorAll('li')).filter((li) => li.querySelector('[data-item]')).map((li) => ({
			key: li.querySelector('[data-item]').dataset.item,
			name: li.querySelector('.issue-report__attach-name').textContent,
			value: li.querySelector('[data-item]').textContent,
			removable: Boolean(li.querySelector('[data-remove="' + li.querySelector('[data-item]').dataset.item + '"]'))
		})),
		excerptToggle: Boolean(document.querySelector('#issue-excerpt')),
		buildMeta: (document.querySelector('meta[name="inbox-build"]') || {}).content || null
	};
})()`;

// The draft record as IndexedDB keeps it, read through the page's own drafts module.
const STORED_DRAFT = `(async () => {
	const q = window.__q13;
	const s = q.report.state();
	const draftsMod = await import('/web/issue-drafts.js');
	const db = await draftsMod.openDraftDb({ indexedDB, origin: location.origin, storeId: s.storeId });
	try {
		const saved = await draftsMod.readDraft(db, s.draftId);
		return {
			draftId: s.draftId,
			found: saved !== null,
			bytes: JSON.stringify(saved),
			fields: saved ? Object.keys(saved).sort() : [],
			text: saved ? saved.text : null,
			removed: saved ? saved.removed : null,
			excerptEnabled: saved ? saved.excerptEnabled : null,
			evidence: saved && saved.evidence ? { source: saved.evidence.source, observedAt: saved.evidence.observedAt, excerpt: saved.evidence.excerpt, visibleIds: saved.evidence.visibleIds, clientBuild: saved.evidence.clientBuild } : null,
			state: { excerptEnabled: s.excerptEnabled, excerpt: s.context.excerpt, visibleIds: s.context.visibleIds, removed: s.removed }
		};
	} finally {
		db.close();
	}
})()`;

function arm(text) {
	return `(() => { window.__q13.armed = window.__q13.waitStatus(${JSON.stringify(text)}); window.__q13.armed.catch(() => {}); return true; })()`;
}

const KEYS = {
	Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Tab: { key: "Tab", code: "Tab", vk: 9 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
};

async function pressKey(page, sessionId, name, { shift = false } = {}) {
	const spec = KEYS[name];
	const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: shift ? 8 : 0 };
	await page.cdp.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text } : {}) }, sessionId);
	await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
}

async function setOffline(page, sessionId, offline) {
	await page.cdp.send("Network.enable", {}, sessionId);
	await page.cdp.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
}

function receiptOfCreateEvent(detail) {
	const created = (detail.events || []).find((event) => event.seq === 1);
	return created ? { requestId: created.requestId, seq: created.seq, acceptedAt: created.acceptedAt } : null;
}

function sameJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

// ---------- scenario ----------

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const { TEXT } = await import(pathToFileURL(path.join(ctx.appDir, "web", "issue-report.js")).href);
	const { freezeCapture } = await import(pathToFileURL(path.join(ctx.appDir, "web", "issue-context.js")).href);
	const actions = [];
	const http = [];
	const record = { viewport: { width, height, scheme }, steps: {} };
	const act = (step, detail, signal) => actions.push({ step, detail: detail === undefined ? null : detail, signal: signal === undefined ? null : signal });
	const nodeRequest = async (label, fn) => {
		try {
			const result = await fn();
			http.push({ side: "node", label, status: result.status, body: result.json === undefined ? result : result.json });
			return result;
		} catch (error) {
			http.push({ side: "node", label, status: error.status ?? null, body: error.body ?? String(error.message ?? error) });
			throw error;
		}
	};
	const issueCount = async (label) => (await nodeRequest(label, () => ctx.get("/api/issues?limit=100"))).items.length;
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q13_new_page");
	const flushPageHttp = async () => {
		const entries = await page.evaluate("window.__q13 ? window.__q13.http.splice(0) : []");
		for (const entry of entries) http.push({ side: "page", ...entry });
	};
	const state = async (name) => withDeadline(page.evaluate(STATE), DEADLINE_MS, name);
	const awaitArmed = async (name) => withDeadline(page.evaluate("window.__q13.armed"), DEADLINE_MS, name);
	let sessionId = null;
	const mount = async (name, options) => {
		const setup = await withDeadline(page.evaluate(setupExpression(options)), DEADLINE_MS, name);
		sessionId = await page.resolveSessionId();
		return setup;
	};
	try {
		const caps = await nodeRequest("capabilities", () => ctx.get("/api/issues/capabilities"));
		const storeId = caps.storeId;
		record.storeId = storeId;

		await withDeadline(page.goto(`${ctx.base}/`, { waitUntil: "load" }), DEADLINE_MS, "q13_goto_inbox");
		act("navigate", `${ctx.base}/`, "page.goto(load) resolved");
		const setup = await mount("q13_setup", {});
		record.steps.setup = setup;
		act("mount", "inject trigger, host input, inbox adapter, instrumented fetch; mount composer", `resumed=${setup.resumed.length} imageMounted=${setup.imageMounted}`);
		check("Q13 composer mounts on the inbox with the trigger, an inbox adapter and an empty outbox", setup.trigger && setup.adapter && setup.adapter.page === "inbox" && Array.isArray(setup.resumed) && setup.resumed.length === 0 && setup.stylesheet === true && setup.visibleThread !== null, JSON.stringify(setup));
		const visibleThread = setup.visibleThread;

		// ---- open by pointer; the page's own history.state must survive the reporter's token ----
		await withDeadline(page.evaluate(`history.replaceState(${JSON.stringify(PAGE_STATE)}, "", location.href)`), DEADLINE_MS, "q13_page_state");
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_click_trigger");
		act("click", "[data-issue-report]", "page.click resolved");
		let s = await state("q13_state_open");
		record.steps.opened = s;
		check("Q13 clicking the trigger opens the native modal dialog at the description field", s.open === true && s.modal === true && s.activeId === "issue-description" && typeof s.historyToken === "string" && s.deferred === 1 && s.status === "editing", JSON.stringify({ open: s.open, modal: s.modal, active: s.activeId, token: s.historyToken, deferred: s.deferred }));
		check("Q13 the reporter's history entry keeps the page's own state fields and adds only its token", sameJson(s.historyState, { ...PAGE_STATE, issueReport: s.historyToken }), JSON.stringify(s.historyState));
		check("Q13 the frozen capture names the visible thread as its source", s.context && s.context.source && s.context.source.kind === "thread" && s.context.source.threadId === visibleThread && s.context.contextStatus === "captured", JSON.stringify(s.context));
		const forced = await withDeadline(page.evaluate(`(() => {
			const dialog = document.querySelector('#issue-report');
			const forcedFields = dialog.querySelectorAll('select, input[name="title"], input[name="category"], input[name="severity"], input[type="text"]:not(.issue-image__note input)');
			const required = Array.from(dialog.querySelectorAll('[required]')).map((node) => node.id);
			return { forcedFields: forcedFields.length, required };
		})()`), DEADLINE_MS, "q13_forced_fields");
		check("Q13 the description is the only required input; no title, category or severity field exists", forced.forcedFields === 0 && sameJson(forced.required, ["issue-description"]), JSON.stringify(forced));

		// ---- type and save ----
		await withDeadline(page.fill("#issue-description", DESCRIPTION), DEADLINE_MS, "q13_fill");
		act("fill", "#issue-description", "page.fill resolved (input events)");
		await withDeadline(page.evaluate("window.__q13.report.flush()"), DEADLINE_MS, "q13_flush_save");
		s = await state("q13_state_saved");
		record.steps.saved = s;
		check("Q13 the typed description is saved and reported only after the transaction completes", s.text === DESCRIPTION && s.storage === "saved" && s.statusText === TEXT.status.saved && s.textareaValue === DESCRIPTION && s.copyHidden === true, JSON.stringify({ text: s.text, storage: s.storage, status: s.statusText, copyHidden: s.copyHidden }));

		// ---- context review: the retained values themselves, each with 지우기; one removal ----
		await withDeadline(page.click("#issue-attach-toggle"), DEADLINE_MS, "q13_attach_toggle");
		await withDeadline(page.click("#issue-excerpt"), DEADLINE_MS, "q13_include_excerpt");
		act("click", "#issue-attach-toggle, #issue-excerpt (선택한 내용 포함)", "page.click resolved");
		// Every save re-renders the list; wait for the save chain before touching a row control.
		await withDeadline(page.evaluate("window.__q13.report.flush()"), DEADLINE_MS, "q13_flush_excerpt");
		const attach = await withDeadline(page.evaluate(ATTACH), DEADLINE_MS, "q13_attach_list");
		s = await state("q13_state_attach");
		record.steps.attachments = { ...attach, context: s.context };
		const row = (key) => attach.items.find((item) => item.key === key) || null;
		const reviewOk = attach.hidden === false
			&& row("source") && row("source").value.includes(visibleThread) && row("source").removable
			&& row("excerpt") && row("excerpt").value === s.context.excerpt && typeof s.context.excerpt === "string" && s.context.excerpt !== "" && row("excerpt").removable
			&& row("visibleIds") && row("visibleIds").value.split(", ").includes(visibleThread) && row("visibleIds").removable
			&& row("view") && row("view").value.includes(`${width}×${height}`) && row("view").removable
			&& row("clientBuild") && row("clientBuild").value === attach.buildMeta && /^[0-9a-f]{64}$/.test(attach.buildMeta) && row("clientBuild").removable
			&& attach.items.every((item) => !/\d+(개|건|자)$/.test(item.value));
		check("Q13 첨부 확인 lists the retained values themselves (source, excerpt text, visible ids, view fields, build digest), each with 지우기", Boolean(reviewOk), JSON.stringify(attach));
		await withDeadline(page.click('#issue-attach-list [data-remove="visibleIds"]'), DEADLINE_MS, "q13_remove_visible");
		act("click", '[data-remove="visibleIds"]', "page.click resolved");
		s = await state("q13_state_removed");
		const attachAfter = await withDeadline(page.evaluate(ATTACH), DEADLINE_MS, "q13_attach_after");
		record.steps.afterRemoval = { context: s.context, removed: s.removed, text: s.text, items: attachAfter.items.map((item) => item.key) };
		check("Q13 removing one item drops only it: the rest, the excerpt text and the description stay", attachAfter.hidden === false && !attachAfter.items.some((item) => item.key === "visibleIds") && attachAfter.items.some((item) => item.key === "excerpt" && item.value === s.context.excerpt) && s.context.visibleIds === 0 && s.context.source && s.context.source.threadId === visibleThread && s.text === DESCRIPTION && sameJson(s.removed, ["visibleIds"]), JSON.stringify({ items: attachAfter.items, after: s.context, removed: s.removed }));

		// ---- keyboard target picker ----
		await withDeadline(page.click("#issue-target-pick"), DEADLINE_MS, "q13_open_picker");
		const picker = await withDeadline(page.evaluate(`(() => { const options = Array.from(document.querySelectorAll('#issue-picker [role="option"]')); return { count: options.length, active: document.activeElement.getAttribute('data-index'), kinds: options.map((o) => o.querySelector('.issue-report__option-kind').textContent) }; })()`), DEADLINE_MS, "q13_picker_state");
		await pressKey(page, sessionId, "ArrowDown");
		await pressKey(page, sessionId, "Enter");
		act("keyboard", "ArrowDown, Enter in #issue-picker", "CDP key events dispatched");
		const generationBefore = s.generation;
		s = await state("q13_state_target");
		record.steps.target = { picker, target: s.target, chip: s.chip, generation: s.generation };
		check("Q13 the keyboard picker selects an adapter-approved record target and starts a new generation", picker.count >= 2 && picker.active === "0" && s.target && s.target.kind === "record" && s.target.key === `thread:${visibleThread}` && s.chip.includes(s.target.label) && s.pickLabel === TEXT.change && s.pickerHidden === true && s.generation > generationBefore && s.context.target && s.context.target.key === s.target.key, JSON.stringify({ picker, target: s.target, chip: s.chip, pickLabel: s.pickLabel }));

		// ---- 지우기 on the 위치 row, then pick again: the capture carries what the chip shows ----
		await withDeadline(page.evaluate("window.__q13.report.flush()"), DEADLINE_MS, "q13_flush_target");
		await withDeadline(page.click('#issue-attach-list [data-remove="target"]'), DEADLINE_MS, "q13_remove_target");
		const targetRemoved = await state("q13_state_target_removed");
		await withDeadline(page.click("#issue-target-pick"), DEADLINE_MS, "q13_reopen_picker");
		await pressKey(page, sessionId, "ArrowDown");
		await pressKey(page, sessionId, "Enter");
		act("click+keyboard", '[data-remove="target"], then #issue-target-pick, ArrowDown, Enter', "page.click resolved; CDP key events dispatched");
		s = await state("q13_state_target_repicked");
		record.steps.targetAgain = { removed: { target: targetRemoved.target, contextTarget: targetRemoved.context.target, removed: targetRemoved.removed, chip: targetRemoved.chip }, repicked: { target: s.target, contextTarget: s.context.target, removed: s.removed, chip: s.chip } };
		check("Q13 removing the 위치 row drops the target from the capture; picking again puts it back in the capture, not only in the chip", targetRemoved.target === null && targetRemoved.context.target === null && sameJson(targetRemoved.removed, ["visibleIds", "target"]) && s.target && s.target.key === `thread:${visibleThread}` && s.context.target && s.context.target.key === s.target.key && sameJson(s.removed, ["visibleIds"]) && s.chip.includes(s.target.label), JSON.stringify(record.steps.targetAgain));

		// ---- focus trap ----
		await withDeadline(page.evaluate("document.querySelector('#issue-send').focus()"), DEADLINE_MS, "q13_focus_send");
		await pressKey(page, sessionId, "Tab");
		const afterTab = await withDeadline(page.evaluate("({ id: document.activeElement.id, inDialog: document.querySelector('#issue-report').contains(document.activeElement) })"), DEADLINE_MS, "q13_after_tab");
		await pressKey(page, sessionId, "Tab", { shift: true });
		const afterShiftTab = await withDeadline(page.evaluate("({ id: document.activeElement.id, inDialog: document.querySelector('#issue-report').contains(document.activeElement) })"), DEADLINE_MS, "q13_after_shift_tab");
		record.steps.focusTrap = { afterTab, afterShiftTab };
		check("Q13 Tab past the last control and Shift+Tab before the first stay inside the dialog", afterTab.inDialog === true && afterTab.id === "issue-close" && afterShiftTab.inDialog === true && afterShiftTab.id === "issue-send", JSON.stringify({ afterTab, afterShiftTab }));

		const composerShot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q13_composer_screenshot");
		const composerPath = evidence("Q13-composer.png", Buffer.from(composerShot));
		check("Q13 composer screenshot saved", fs.existsSync(composerPath) && fs.statSync(composerPath).size > 0, composerPath);

		// ---- send ----
		await withDeadline(page.evaluate(arm(TEXT.status.accepted)), DEADLINE_MS, "q13_arm_accepted");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_click_send");
		act("click", "#issue-send", "page.click resolved; awaiting #issue-status == 접수했습니다");
		await awaitArmed("q13_await_accepted");
		s = await state("q13_state_sent");
		record.steps.sent = s;
		check("Q13 보내기 yields 접수했습니다 with a seq-1 receipt for the frozen request", s.status === "sent" && s.statusText === TEXT.status.accepted && s.statusTone === "ok" && s.receipt && s.receipt.seq === 1 && s.receipt.requestId === s.requestId && s.issueId === s.requestId && s.replayed === false && s.sendHidden === true && s.receiptHidden === false, JSON.stringify({ status: s.status, text: s.statusText, receipt: s.receipt, issueId: s.issueId }));
		const firstId = s.issueId;
		const firstReceipt = s.receipt;
		const list1 = await nodeRequest("list-after-first", () => ctx.get("/api/issues?limit=100"));
		const detail1 = await nodeRequest("detail-first", () => ctx.get(`/api/issues/${firstId}`));
		check("Q13 exactly one issue exists and its source is the visible thread", list1.items.length === 1 && list1.items[0].id === firstId && detail1.issue.source && detail1.issue.source.kind === "thread" && detail1.issue.source.threadId === visibleThread && detail1.issue.description === DESCRIPTION, JSON.stringify({ count: list1.items.length, source: detail1.issue.source }));
		const serverReceipt1 = receiptOfCreateEvent(detail1);
		let pageStatus = null;
		try {
			const res = await fetch(`${ctx.base}/issues/${firstId}`, { signal: AbortSignal.timeout(DEADLINE_MS) });
			pageStatus = res.status;
			http.push({ side: "node", label: "receipt-link-page", status: res.status, body: `${res.headers.get("content-type")} (${(await res.text()).length} bytes)` });
		} catch (error) {
			pageStatus = String(error.message ?? error);
		}
		record.steps.receiptLink = { href: s.link, pageStatus, serverReceipt: serverReceipt1 };
		check("Q13 the receipt link names the issue whose create event is the receipt", s.link === `/issues/${firstId}` && sameJson(serverReceipt1, firstReceipt) && detail1.evidence && detail1.evidence[0] && detail1.evidence[0].captureId === s.envelope.captureId && s.envelope.target && s.envelope.target.kind === "record" && s.envelope.visibleIds === 0, JSON.stringify({ link: s.link, serverReceipt: serverReceipt1, clientReceipt: firstReceipt, manifestCapture: detail1.evidence && detail1.evidence[0] && detail1.evidence[0].captureId, envelopeCapture: s.envelope.captureId, pageStatus }));
		check("Q13 the underlying page input and rows are untouched after the send", s.hostValue === HOST_VALUE && s.rowCount === setup.rowCount, JSON.stringify({ hostValue: s.hostValue, rows: s.rowCount, before: setup.rowCount }));

		const receiptShot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q13_receipt_screenshot");
		const receiptPath = evidence("Q13-receipt.png", Buffer.from(receiptShot));
		check("Q13 receipt screenshot saved", fs.existsSync(receiptPath) && fs.statSync(receiptPath).size > 0, receiptPath);

		// ---- Escape closes, focus returns, token popped ----
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); return true; })()"), DEADLINE_MS, "q13_arm_close");
		await pressKey(page, sessionId, "Escape");
		act("keyboard", "Escape", "CDP key event dispatched; awaiting dialog close");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close");
		s = await state("q13_state_closed");
		record.steps.closed = s;
		check("Q13 Escape closes only the reporter, keeps the receipt, returns focus to the opener and pops its history token", s.open === false && s.status === "sent" && s.activeId === "q13-report" && s.historyToken === null && s.resumed === 1 && s.hostValue === HOST_VALUE, JSON.stringify({ open: s.open, status: s.status, active: s.activeId, token: s.historyToken, resumed: s.resumed }));
		check("Q13 closing restores the page's own history.state untouched", sameJson(s.historyState, PAGE_STATE), JSON.stringify(s.historyState));

		// ---- failure: empty description ----
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_reopen");
		await withDeadline(page.click("#issue-new"), DEADLINE_MS, "q13_new_report");
		const postsBefore = (await state("q13_state_new")).posts;
		await withDeadline(page.evaluate(arm(TEXT.status.empty)), DEADLINE_MS, "q13_arm_empty");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_empty");
		await awaitArmed("q13_await_empty");
		s = await state("q13_state_empty");
		record.steps.empty = { statusText: s.statusText, status: s.status, posts: s.posts, postsBefore, activeId: s.activeId };
		check("Q13 failure: an empty description is blocked without any request", s.statusText === TEXT.status.empty && s.statusTone === "error" && s.status === "editing" && s.posts === postsBefore && s.requestId === null && (await issueCount("list-after-empty")) === 1, JSON.stringify(record.steps.empty));

		// ---- failure: response dropped after commit -> offline retry -> online auto-retry ----
		const DROPPED = "응답이 사라진 제보";
		await withDeadline(page.fill("#issue-description", DROPPED), DEADLINE_MS, "q13_fill_dropped");
		await withDeadline(page.evaluate("(() => { window.__q13.mode = 'drop'; return true; })()"), DEADLINE_MS, "q13_mode_drop");
		await withDeadline(page.evaluate(arm(TEXT.status.network)), DEADLINE_MS, "q13_arm_network");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_dropped");
		act("click", "#issue-send (fetch mode drop)", "awaiting #issue-status == network/pending text");
		await awaitArmed("q13_await_network");
		s = await state("q13_state_dropped");
		const droppedId = s.requestId;
		const count2 = await issueCount("list-after-drop");
		record.steps.dropped = { ...s, count: count2 };
		check("Q13 failure: a response dropped after commit shows 접수 확인 중, keeps the text locked and never claims success", s.status === "failed" && s.failure && s.failure.kind === "retryable" && s.failure.code === "network" && s.failure.uncertain === true && s.textareaValue === DROPPED && s.readOnly === true && s.sendDisabled === true && s.retry.hidden === false && s.retry.text === TEXT.retry && count2 === 2 && typeof droppedId === "string", JSON.stringify({ status: s.status, failure: s.failure, statusText: s.statusText, readOnly: s.readOnly, count: count2 }));

		await setOffline(page, sessionId, true);
		const offlineProbe = await withDeadline(page.evaluate("navigator.onLine"), DEADLINE_MS, "q13_offline_probe");
		await withDeadline(page.evaluate(arm(TEXT.status.offline)), DEADLINE_MS, "q13_arm_offline");
		await withDeadline(page.click("#issue-retry"), DEADLINE_MS, "q13_retry_offline");
		act("click", "#issue-retry while offline", "awaiting #issue-status == offline text");
		await awaitArmed("q13_await_offline");
		s = await state("q13_state_offline");
		record.steps.offline = { onLine: offlineProbe, status: s.status, failure: s.failure, requestId: s.requestId, attempts: s.attempts };
		check("Q13 failure: retry while offline is queued under the same requestId without a request", offlineProbe === false && s.failure && s.failure.code === "offline" && s.failure.queued === true && s.requestId === droppedId && s.statusText === TEXT.status.offline, JSON.stringify(record.steps.offline));

		await withDeadline(page.evaluate(arm(TEXT.status.accepted)), DEADLINE_MS, "q13_arm_online_accept");
		await withDeadline(page.evaluate("(() => { window.__q13.online = window.__q13.waitOnline(); window.__q13.online.catch(() => {}); return true; })()"), DEADLINE_MS, "q13_arm_online_event");
		await setOffline(page, sessionId, false);
		const onlineEvent = await withDeadline(page.evaluate("window.__q13.online"), DEADLINE_MS, "q13_await_online_event");
		await awaitArmed("q13_await_online_accept");
		s = await state("q13_state_online");
		const detailDropped = await nodeRequest("detail-dropped", () => ctx.get(`/api/issues/${droppedId}`));
		const count2b = await issueCount("list-after-online");
		await flushPageHttp();
		const droppedPosts = http.filter((entry) => entry.side === "page" && entry.method === "POST" && entry.url === "/api/issues" && entry.note && entry.note.includes("dropped"));
		record.steps.online = { onlineEvent, status: s.status, receipt: s.receipt, serverReceipt: receiptOfCreateEvent(detailDropped), autoRetried: s.autoRetried, count: count2b };
		check("Q13 failure: the online event retries once by GET and yields the exact original receipt with one issue", onlineEvent === "online" && s.status === "sent" && s.requestId === droppedId && s.autoRetried === true && sameJson(s.receipt, receiptOfCreateEvent(detailDropped)) && s.replayed === true && count2b === 2 && droppedPosts.length === 1 && detailDropped.issue.description === DROPPED, JSON.stringify(record.steps.online));

		// ---- reload after acceptance: nothing to resume ----
		await withDeadline(page.reload(), DEADLINE_MS, "q13_reload_after_accept");
		act("reload", "page.reload()", "reload resolved");
		const setup2 = await mount("q13_setup_after_reload", {});
		record.steps.reloadAfterAccept = setup2.resumed;
		check("Q13 failure: reload after acceptance resumes nothing and the issue count is unchanged", setup2.resumed.length === 0 && (await issueCount("list-after-reload")) === 2, JSON.stringify(setup2.resumed));

		// ---- restore: a draft saved on thread A, reopened on a page showing B, keeps A through edits ----
		const RESTORED = "다시 연 초안";
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_for_restore");
		await withDeadline(page.fill("#issue-description", RESTORED), DEADLINE_MS, "q13_fill_restore");
		await withDeadline(page.click("#issue-attach-toggle"), DEADLINE_MS, "q13_attach_toggle_restore");
		await withDeadline(page.click("#issue-excerpt"), DEADLINE_MS, "q13_include_excerpt_restore");
		await withDeadline(page.evaluate("window.__q13.report.flush()"), DEADLINE_MS, "q13_flush_restore");
		s = await state("q13_state_saved_a");
		const savedA = { context: s.context, storage: s.storage, text: s.text };
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_saved_a");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_saved_a");
		await withDeadline(page.reload(), DEADLINE_MS, "q13_reload_for_restore");
		act("reload", "page.reload(); the adapter now reports another thread", "reload resolved");
		await mount("q13_setup_other_thread", { source: OTHER_THREAD });
		// The restore is asynchronous (draft read + verdict); the status line turns 초안 저장됨 exactly then.
		await withDeadline(page.evaluate(arm(TEXT.status.saved)), DEADLINE_MS, "q13_arm_restore");
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_restored");
		act("click", "[data-issue-report] with a saved draft and the page showing another thread", "awaiting #issue-status == 초안 저장됨 (restore)");
		await awaitArmed("q13_await_restore");
		s = await state("q13_state_restored");
		const restored = { context: s.context, text: s.text, storage: s.storage };
		check("Q13 restore: the saved draft comes back with thread A's capture although the page shows B", savedA.storage === "saved" && savedA.context.source.threadId === visibleThread && typeof savedA.context.excerpt === "string" && s.text === RESTORED && s.context.source.threadId === visibleThread && s.context.excerpt === savedA.context.excerpt && s.context.observedAt === savedA.context.observedAt && s.context.visibleIds > 0, JSON.stringify({ savedA, restored, pageShows: OTHER_THREAD }));
		await withDeadline(page.click("#issue-attach-toggle"), DEADLINE_MS, "q13_attach_toggle_restored");
		const restoredList = await withDeadline(page.evaluate(ATTACH), DEADLINE_MS, "q13_attach_restored");
		const restoredIds = await withDeadline(page.evaluate("window.__q13.report.state().context.visibleIds"), DEADLINE_MS, "q13_restored_ids");
		await withDeadline(page.click('#issue-attach-list [data-remove="visibleIds"]'), DEADLINE_MS, "q13_remove_visible_restored");
		act("click", '[data-remove="visibleIds"] on the restored draft', "page.click resolved");
		s = await state("q13_state_restored_removed");
		record.steps.restore = { savedA, restored, items: restoredList.items, afterRemoval: s.context };
		check("Q13 restore: removing visible ids edits A's frozen capture - source, excerpt and observation time stay A's, never B's", restoredList.items.some((item) => item.key === "excerpt" && item.value === savedA.context.excerpt) && s.context.visibleIds === 0 && s.context.source.threadId === visibleThread && s.context.excerpt === savedA.context.excerpt && s.context.observedAt === savedA.context.observedAt && s.text === RESTORED, JSON.stringify(record.steps.restore));

		// ---- the saved record holds only the approved context: no copy of removed or deselected bytes ----
		await withDeadline(page.evaluate("window.__q13.report.flush()"), DEADLINE_MS, "q13_flush_removed_restored");
		await withDeadline(page.click("#issue-excerpt"), DEADLINE_MS, "q13_deselect_excerpt_restored");
		act("click", "#issue-excerpt (선택한 내용 포함 off) on the restored draft", "page.click resolved");
		await withDeadline(page.evaluate("window.__q13.report.flush()"), DEADLINE_MS, "q13_flush_approved");
		const storedDraft = await withDeadline(page.evaluate(STORED_DRAFT), DEADLINE_MS, "q13_read_stored_draft");
		const excerptA = savedA.context.excerpt;
		const otherIds = restoredIds.filter((id) => id !== visibleThread);
		record.steps.storedDraft = { ...storedDraft, excerptA, otherIds };
		const approvedOnly = storedDraft.found && storedDraft.evidence !== null
			&& storedDraft.evidence.visibleIds.length === 0 && storedDraft.evidence.excerpt === null && storedDraft.excerptEnabled === false && sameJson(storedDraft.removed, ["visibleIds"])
			&& !storedDraft.bytes.includes(excerptA) && otherIds.length > 0 && otherIds.every((id) => !storedDraft.bytes.includes(id))
			&& storedDraft.bytes.split(visibleThread).length - 1 === 1
			&& storedDraft.evidence.source.threadId === visibleThread && storedDraft.evidence.observedAt === savedA.context.observedAt
			&& storedDraft.text === RESTORED && storedDraft.state.excerpt === null && storedDraft.state.visibleIds.length === 0;
		check("Q13 the saved IndexedDB record holds only the approved context: the removed ids and the deselected excerpt text are absent from every stored byte, source and observation time stay A's", Boolean(approvedOnly), JSON.stringify(record.steps.storedDraft));
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_approved");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_approved");
		await withDeadline(page.reload(), DEADLINE_MS, "q13_reload_approved");
		act("reload", "page.reload(); the adapter still reports another thread", "reload resolved");
		await mount("q13_setup_other_thread_again", { source: OTHER_THREAD });
		await withDeadline(page.evaluate(arm(TEXT.status.saved)), DEADLINE_MS, "q13_arm_restore_approved");
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_restored_approved");
		act("click", "[data-issue-report] with the approved-only draft saved", "awaiting #issue-status == 초안 저장됨 (restore)");
		await awaitArmed("q13_await_restore_approved");
		s = await state("q13_state_restored_approved");
		const approvedList = await withDeadline(page.evaluate(ATTACH), DEADLINE_MS, "q13_attach_restored_approved");
		record.steps.restoredApproved = { context: s.context, removed: s.removed, excerptEnabled: s.excerptEnabled, items: approvedList.items.map((item) => item.key), excerptToggle: approvedList.excerptToggle, text: s.text };
		check("Q13 restoring that draft shows exactly the reviewed evidence: no removed id or deselected excerpt comes back, no toggle offers it, source and observation time stay A's", s.text === RESTORED && s.context.visibleIds === 0 && s.context.excerpt === null && s.excerptEnabled === false && approvedList.excerptToggle === false && !approvedList.items.some((item) => item.key === "visibleIds" || item.key === "excerpt") && s.context.source.threadId === visibleThread && s.context.observedAt === savedA.context.observedAt && sameJson(s.removed, ["visibleIds"]), JSON.stringify(record.steps.restoredApproved));
		await withDeadline(page.click("#issue-discard"), DEADLINE_MS, "q13_discard");
		await withDeadline(page.click("#issue-discard-yes"), DEADLINE_MS, "q13_discard_yes");
		act("click", "#issue-discard, #issue-discard-yes", "page.click resolved");
		s = await state("q13_state_discarded");
		record.steps.discarded = { context: s.context, text: s.text };
		check("Q13 restore: only the explicit 초안 버리기 recaptures the page now shown (B), as a whole", s.text === "" && s.status === "editing" && s.context.source.threadId === OTHER_THREAD && s.context.observedAt !== savedA.context.observedAt && sameJson(s.removed, []), JSON.stringify(record.steps.discarded));
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_discarded");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_discarded");

		// ---- reload mid-send: outbox resumes exactly once ----
		const HANGING = "새로 고침 중 보낸 제보";
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_hang");
		await withDeadline(page.fill("#issue-description", HANGING), DEADLINE_MS, "q13_fill_hang");
		await withDeadline(page.evaluate("(() => { window.__q13.mode = 'hang'; return true; })()"), DEADLINE_MS, "q13_mode_hang");
		await withDeadline(page.evaluate(arm(TEXT.status.sending)), DEADLINE_MS, "q13_arm_sending");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_hang");
		act("click", "#issue-send (fetch mode hang)", "awaiting #issue-status == 보내는 중 (outbox written, request in flight)");
		await awaitArmed("q13_await_sending");
		s = await state("q13_state_hanging");
		const hangingId = s.requestId;
		record.steps.hanging = { status: s.status, outbox: s.outbox, requestId: hangingId };
		await flushPageHttp();
		await withDeadline(page.reload(), DEADLINE_MS, "q13_reload_mid_send");
		act("reload", "page.reload() while the create request hangs", "reload resolved");
		const setup3 = await mount("q13_setup_resume", {});
		const resumeAgain = await withDeadline(page.evaluate("window.__q13.report.resume()"), DEADLINE_MS, "q13_resume_again");
		const detailHanging = await nodeRequest("detail-hanging", () => ctx.get(`/api/issues/${hangingId}`));
		const count3 = await issueCount("list-after-resume");
		record.steps.resumed = { first: setup3.resumed, again: resumeAgain, count: count3 };
		check("Q13 failure: reload mid-send resumes the outbox exactly once with the same requestId", s.outbox === "written" && setup3.resumed.length === 1 && setup3.resumed[0].requestId === hangingId && setup3.resumed[0].outcome === "accepted" && setup3.resumed[0].via === "replay" && resumeAgain.length === 0 && count3 === 3 && detailHanging.issue.description === HANGING, JSON.stringify(record.steps.resumed));
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_after_resume");
		s = await state("q13_state_after_resume");
		record.steps.afterResume = { text: s.text, status: s.status, log: await page.evaluate("window.__q13.report.log().filter((e) => e.step === 'draft-verdict')") };
		check("Q13 failure: the consumed draft is not restored for a second send", s.status === "editing" && s.text === "" && s.requestId === null, JSON.stringify(record.steps.afterResume));
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_after_resume");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_after_resume");

		// ---- denied IndexedDB: send only through 저장 없이 보내기 ----
		const UNSAVED = "저장 없이 보내는 제보";
		const setup4 = await mount("q13_setup_denied", { denyIndexedDb: true });
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_denied");
		s = await state("q13_state_denied_open");
		const deniedOpen = { storage: s.storage, statusText: s.statusText };
		await withDeadline(page.fill("#issue-description", UNSAVED), DEADLINE_MS, "q13_fill_denied");
		const postsBeforeDenied = (await state("q13_state_denied_filled")).posts;
		await withDeadline(page.evaluate(arm(TEXT.status.saveFailed)), DEADLINE_MS, "q13_arm_save_failed");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_denied");
		await awaitArmed("q13_await_save_failed");
		s = await state("q13_state_denied_frozen");
		record.steps.denied = { open: deniedOpen, resumed: setup4.resumed, frozen: { status: s.status, outbox: s.outbox, statusText: s.statusText, retry: s.retry, copy: { hidden: s.copyHidden, text: s.copyText }, sendDisabled: s.sendDisabled, posts: s.posts, postsBefore: postsBeforeDenied } };
		check("Q13 failure: denied IndexedDB blocks the send until 저장 없이 보내기, offers 설명 복사 and says recovery is unavailable", deniedOpen.storage === "unavailable" && s.status === "frozen" && s.outbox === "skipped" && s.statusText === TEXT.status.saveFailed && s.retry.hidden === false && s.retry.text === TEXT.sendWithoutSave && s.retry.action === "send-without-save" && s.copyHidden === false && s.copyText === TEXT.copy && s.sendDisabled === true && s.posts === postsBeforeDenied && s.textareaValue === UNSAVED, JSON.stringify(record.steps.denied));
		await withDeadline(page.evaluate(arm(TEXT.status.accepted)), DEADLINE_MS, "q13_arm_denied_accept");
		await withDeadline(page.click("#issue-retry"), DEADLINE_MS, "q13_send_without_save");
		act("click", "#issue-retry (저장 없이 보내기)", "awaiting 접수했습니다");
		await awaitArmed("q13_await_denied_accept");
		s = await state("q13_state_denied_sent");
		const count4 = await issueCount("list-after-denied");
		record.steps.denied.sent = { status: s.status, receipt: s.receipt, count: count4 };
		check("Q13 failure: 저장 없이 보내기 sends once and is accepted", s.status === "sent" && s.receipt && s.receipt.seq === 1 && count4 === 4, JSON.stringify(record.steps.denied.sent));
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_denied");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_denied");

		// ---- 409 key_reused ----
		const seedEvidence = freezeCapture({ page: "inbox", source: null, target: null, view: { width: 390, height: 844, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "ko-KR", embedded: false, viewerOpen: false }, uuid: () => REUSED_CAPTURE, now: () => Date.now() });
		await nodeRequest("pre-create-reused", () => ctx.post("/api/issues", { v: 1, storeId, requestId: REUSED_ID, description: "다른 내용으로 먼저 쓰인 요청", evidence: JSON.parse(JSON.stringify(seedEvidence)) }));
		const REUSED_TEXT = "같은 번호로 보내는 제보";
		await mount("q13_setup_reused", {});
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_reused");
		await withDeadline(page.fill("#issue-description", REUSED_TEXT), DEADLINE_MS, "q13_fill_reused");
		await withDeadline(page.evaluate(`(() => { window.__q13.forceNext = ${JSON.stringify(REUSED_ID)}; return true; })()`), DEADLINE_MS, "q13_force_reused_id");
		await withDeadline(page.evaluate(arm(TEXT.status.keyReused)), DEADLINE_MS, "q13_arm_key_reused");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_reused");
		act("click", "#issue-send with requestId forced to a used id", "awaiting key_reused status");
		await awaitArmed("q13_await_key_reused");
		s = await state("q13_state_key_reused");
		record.steps.keyReused = { status: s.status, failure: s.failure, requestId: s.requestId, textareaValue: s.textareaValue, readOnly: s.readOnly, retry: s.retry };
		check("Q13 failure: 409 key_reused keeps the text editable and offers 새 요청으로 보내기", s.status === "failed" && s.failure && s.failure.code === "key_reused" && s.failure.needsNewRequest === true && s.requestId === REUSED_ID && s.textareaValue === REUSED_TEXT && s.readOnly === false && s.retry.text === TEXT.newRequest && s.retry.action === "renew" && s.sendDisabled === true, JSON.stringify(record.steps.keyReused));
		await withDeadline(page.evaluate(arm(TEXT.status.accepted)), DEADLINE_MS, "q13_arm_renew_accept");
		await withDeadline(page.click("#issue-retry"), DEADLINE_MS, "q13_renew");
		await awaitArmed("q13_await_renew_accept");
		s = await state("q13_state_renewed");
		const count6 = await issueCount("list-after-renew");
		const detailReused = await nodeRequest("detail-reused-original", () => ctx.get(`/api/issues/${REUSED_ID}`));
		record.steps.renewed = { status: s.status, requestId: s.requestId, envelope: s.envelope, count: count6, originalDescription: detailReused.issue.description };
		check("Q13 failure: 새 요청으로 보내기 sends the same text under a fresh requestId and never rewrites the used one", s.status === "sent" && s.requestId !== REUSED_ID && s.envelope.description === REUSED_TEXT && s.envelope.requestId === s.requestId && count6 === 6 && detailReused.issue.description === "다른 내용으로 먼저 쓰인 요청", JSON.stringify(record.steps.renewed));
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_renewed");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_renewed");

		// ---- 409 store_changed ----
		const MOVED = "저장소가 바뀐 제보";
		await mount("q13_setup_store", { storeId: WRONG_STORE });
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_store");
		await withDeadline(page.fill("#issue-description", MOVED), DEADLINE_MS, "q13_fill_store");
		await withDeadline(page.evaluate(arm(TEXT.status.storeChanged)), DEADLINE_MS, "q13_arm_store_changed");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_store");
		await awaitArmed("q13_await_store_changed");
		s = await state("q13_state_store_changed");
		record.steps.storeChanged = { status: s.status, failure: s.failure, envelopeStore: s.envelope && s.envelope.storeId, textareaValue: s.textareaValue, retry: s.retry };
		check("Q13 failure: 409 store_changed keeps the text and requires 새 제보로 보내기", s.status === "failed" && s.failure && s.failure.code === "store_changed" && s.failure.needsNewStore === true && s.envelope.storeId === WRONG_STORE && s.textareaValue === MOVED && s.retry.text === TEXT.newStore && s.retry.action === "renew-store", JSON.stringify(record.steps.storeChanged));
		await withDeadline(page.evaluate(arm(TEXT.status.accepted)), DEADLINE_MS, "q13_arm_store_accept");
		await withDeadline(page.click("#issue-retry"), DEADLINE_MS, "q13_renew_store");
		await awaitArmed("q13_await_store_accept");
		s = await state("q13_state_store_sent");
		const count7 = await issueCount("list-after-store");
		record.steps.storeRenewed = { status: s.status, envelopeStore: s.envelope && s.envelope.storeId, requestId: s.requestId, count: count7 };
		check("Q13 failure: 새 제보로 보내기 resends the same text under the server's current store", s.status === "sent" && s.envelope.storeId === storeId && s.envelope.description === MOVED && count7 === 7, JSON.stringify(record.steps.storeRenewed));
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_store");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_store");

		// ---- malformed success body ----
		const MALFORMED = "본문이 깨진 응답";
		await mount("q13_setup_malformed", {});
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_malformed");
		await withDeadline(page.fill("#issue-description", MALFORMED), DEADLINE_MS, "q13_fill_malformed");
		await withDeadline(page.evaluate("(() => { window.__q13.mode = 'malformed'; return true; })()"), DEADLINE_MS, "q13_mode_malformed");
		await withDeadline(page.evaluate(arm(TEXT.status.pending)), DEADLINE_MS, "q13_arm_pending");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_malformed");
		act("click", "#issue-send (fetch mode malformed)", "awaiting 접수 확인 중");
		await awaitArmed("q13_await_pending");
		s = await state("q13_state_malformed");
		const malformedId = s.requestId;
		const count8 = await issueCount("list-after-malformed");
		record.steps.malformed = { status: s.status, failure: s.failure, textareaValue: s.textareaValue, readOnly: s.readOnly, count: count8 };
		check("Q13 failure: a malformed success body is 접수 확인 중 with the text kept, never success", s.status === "failed" && s.failure && s.failure.code === "malformed" && s.failure.uncertain === true && s.statusText === TEXT.status.pending && s.textareaValue === MALFORMED && s.readOnly === true && count8 === 8, JSON.stringify(record.steps.malformed));
		await withDeadline(page.evaluate(arm(TEXT.status.accepted)), DEADLINE_MS, "q13_arm_malformed_accept");
		await withDeadline(page.click("#issue-retry"), DEADLINE_MS, "q13_retry_malformed");
		await awaitArmed("q13_await_malformed_accept");
		s = await state("q13_state_malformed_sent");
		const detailMalformed = await nodeRequest("detail-malformed", () => ctx.get(`/api/issues/${malformedId}`));
		const count8b = await issueCount("list-after-malformed-retry");
		record.steps.malformedResolved = { status: s.status, receipt: s.receipt, serverReceipt: receiptOfCreateEvent(detailMalformed), count: count8b };
		check("Q13 failure: 다시 보내기 resolves the malformed send to the original receipt without a second issue", s.status === "sent" && s.requestId === malformedId && sameJson(s.receipt, receiptOfCreateEvent(detailMalformed)) && count8b === 8, JSON.stringify(record.steps.malformedResolved));
		await withDeadline(page.evaluate("(() => { window.__q13.closed = window.__q13.waitClose(); window.__q13.closed.catch(() => {}); window.__q13.report.close(); return true; })()"), DEADLINE_MS, "q13_close_malformed");
		await withDeadline(page.evaluate("window.__q13.closed"), DEADLINE_MS, "q13_await_close_malformed");

		// ---- definitive rejection -> edited resend -> reload: the rejected envelope is never posted ----
		const REJECTED = "거부된 제보는 다시 보내지 않는다";
		const REPLACEMENT = "고쳐서 다시 보내는 제보";
		await mount("q13_setup_rejected", {});
		await withDeadline(page.click("[data-issue-report]"), DEADLINE_MS, "q13_open_rejected");
		await withDeadline(page.fill("#issue-description", REJECTED), DEADLINE_MS, "q13_fill_rejected");
		await withDeadline(page.evaluate("(() => { window.__q13.mode = 'forbidden'; return true; })()"), DEADLINE_MS, "q13_mode_forbidden");
		await withDeadline(page.evaluate(arm(TEXT.status.forbidden)), DEADLINE_MS, "q13_arm_forbidden");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_rejected");
		act("click", "#issue-send (fetch mode forbidden: 403 before the server)", "awaiting 이 기기에서는 보낼 수 없습니다");
		await awaitArmed("q13_await_forbidden");
		s = await state("q13_state_rejected");
		const rejectedId = s.requestId;
		const count9 = await issueCount("list-after-rejected");
		record.steps.rejected = { status: s.status, failure: s.failure, outbox: s.outbox, retired: s.retired, requestId: rejectedId, textareaValue: s.textareaValue, readOnly: s.readOnly, count: count9 };
		check("Q13 failure: a definitive 403 keeps the text editable and retires its outbox entry (no issue created)", s.status === "failed" && s.failure && s.failure.kind === "rejected" && s.failure.code === "forbidden" && s.outbox === "rejected" && Array.isArray(s.retired) && s.retired.length === 1 && s.retired[0].requestId === rejectedId && s.retired[0].outcome === "rejected" && s.textareaValue === REJECTED && s.readOnly === false && count9 === 8, JSON.stringify(record.steps.rejected));
		await withDeadline(page.fill("#issue-description", REPLACEMENT), DEADLINE_MS, "q13_fill_replacement");
		await withDeadline(page.evaluate(arm(TEXT.status.accepted)), DEADLINE_MS, "q13_arm_replacement");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q13_send_replacement");
		act("click", "#issue-send with the edited text", "awaiting 접수했습니다");
		await awaitArmed("q13_await_replacement");
		s = await state("q13_state_replacement");
		const replacementId = s.requestId;
		const count10 = await issueCount("list-after-replacement");
		record.steps.replacement = { status: s.status, requestId: replacementId, retired: s.retired, description: s.envelope && s.envelope.description, count: count10 };
		check("Q13 failure: the edited resend is a NEW request that supersedes the rejected one", s.status === "sent" && typeof replacementId === "string" && replacementId !== rejectedId && s.envelope.description === REPLACEMENT && s.retired.length === 1 && s.retired[0].requestId === rejectedId && s.retired[0].outcome === "superseded" && s.retired[0].supersededBy === replacementId && count10 === 9, JSON.stringify(record.steps.replacement));
		await flushPageHttp();
		await withDeadline(page.reload(), DEADLINE_MS, "q13_reload_after_rejected");
		act("reload", "page.reload() after the replacement was accepted", "reload resolved");
		const setupAfterRejected = await mount("q13_setup_after_rejected", {});
		const count10b = await issueCount("list-after-rejected-reload");
		let rejectedLookup = null;
		try {
			rejectedLookup = (await nodeRequest("detail-rejected", () => ctx.get(`/api/issues/${rejectedId}`))).status ?? 200;
		} catch (error) {
			rejectedLookup = error.status ?? String(error.message ?? error);
		}
		record.steps.rejectedReload = { resumed: setupAfterRejected.resumed, count: count10b, rejectedLookup };
		check("Q13 failure: reload after the replacement posts nothing - the rejected envelope is gone and the real issue count stays equal", setupAfterRejected.resumed.length === 0 && count10b === 9 && rejectedLookup === 404, JSON.stringify(record.steps.rejectedReload));

		await flushPageHttp();
		const finalHost = await withDeadline(page.evaluate("document.querySelector('#q13-host-input').value"), DEADLINE_MS, "q13_final_host");
		check("Q13 the host input survived the whole failure track", finalHost === HOST_VALUE, JSON.stringify(finalHost));
	} finally {
		try {
			await flushPageHttp();
		} catch {
			// the page may already be gone
		}
		evidence("Q13-actions.json", JSON.stringify({ actions, record }, null, "\t"));
		evidence("Q13-http.txt", http.map((entry) => entry.side === "page"
			? `### page #${entry.seq} ${entry.method} ${entry.url} [mode=${entry.mode}${entry.document ? ` doc=${entry.document}` : ""}]\nstatus: ${entry.status}\n${entry.note ? `note: ${entry.note}\n` : ""}`
			: `### node ${entry.label}\nstatus: ${entry.status}\nbody: ${typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body)}\n`).join("\n"));
		await withDeadline(page.close(), DEADLINE_MS, "q13_page_close").catch(() => page.dispose?.());
	}
}
