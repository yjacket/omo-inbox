/* Q20: integrated regression and ideal-state evidence matrix.
 *
 * Combined failure case (real UI): the Review viewer is opened at revision 1 in a page and the
 * reporter is opened there, so its source/excerpt/observedSeq come from the product adapter's
 * freezeCapture - no hand-built capture objects and no hard-coded revision or excerpt. Revision 2
 * is created through the fixture API while the reporter is open. The display capture is forced to
 * fail by replacing navigator.mediaDevices.getDisplayMedia in the page with a rejecting
 * NotAllowedError; the editor itself handles that failure (labeled simulatedDenial:true). The
 * create response is dropped after the server committed, two maintainers triage concurrently at
 * the same expectedSeq, the tab reloads, and the same requestId resolves to the original receipt.
 * The final assertions read the persisted record bytes: created.json, events/*.json and the
 * evidence context.json.
 *
 * Then the five-width (390/720/1024/1280/1440) x light/dark x 100%/150% zoom x keyboard-only
 * matrix runs over the four integrated pages (inbox, thread, boards, proposal) and the issues
 * list. Every cell saves `<page>-<width>-<scheme>-<zoom>.png`, records the effective visual
 * viewport scale, whether documentElement.scrollWidth <= innerWidth (no horizontal overflow), a
 * real Tab/Shift+Tab/Escape pass (`kb` is true only when focus stayed in the document and Escape
 * kept the URL), the report surface and the scheme.
 *
 * Source isolation: data/proposals, data/threads and mailbox digests are taken AFTER a warm-up
 * navigation of every page (the pages' own read-state write happens there and is explicitly
 * outside the scenario window) and compared after the whole matrix. The pre-combined snapshot is
 * recorded for reference but not asserted: the combined case legitimately creates its own
 * proposal through the fixture API. The scenario writes Q20-actions.json and
 * Q20-cleanup.json; every wait is an awaited DOM event, response, file appearance or navigation
 * under a named 10 s deadline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decisionRev1, decisionRev2, deriveUuids } from "./fixture-data.mjs";

export const viewport = { width: 390, height: 844, scheme: "light" };

const DEADLINE_MS = 10_000;
const WIDTHS = [390, 720, 1024, 1280, 1440];
const SCHEMES = ["light", "dark"];
const ZOOMS = [100, 150];
const IDS = deriveUuids("ulw-q20-combined", 12);
const TRIAGE_A = IDS[2];
const TRIAGE_B = IDS[3];
const DESCRIPTION = "Q20 예전 수정본에서 본 문제가 그대로 남아 있습니다";
const REV1_EXCERPT = "제보 흐름의 첫 결정입니다.";
const REV2_TEXT = "두 번째 수정본입니다.";
const POST = { "content-type": "application/json", "x-inbox": "1" };

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function waitForDom(predicate, label) {
	return `new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(${JSON.stringify(label)} + ' did not appear within 9000ms')), 9000);
		let observer = null;
		const test = () => {
			let value = null;
			try { value = (${predicate})(); } catch { value = null; }
			if (!value) return false;
			clearTimeout(timer);
			if (observer) observer.disconnect();
			resolve(value);
			return true;
		};
		observer = new MutationObserver(() => test());
		observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
		test();
	})`;
}

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashTree(root) {
	const files = {};
	if (!fs.existsSync(root)) return files;
	const walk = (dir, rel) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.isFile() && /\.tmp-\d+-[0-9a-f]+$/i.test(entry.name)) continue;
			const full = path.join(dir, entry.name);
			const key = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(full, key);
			else if (entry.isFile()) files[key.split(path.sep).join("/")] = sha256(fs.readFileSync(full));
		}
	};
	walk(root, "");
	return files;
}

function digestTree(root) {
	return sha256(JSON.stringify(hashTree(root)));
}

function isolationSnapshot(home) {
	const dirs = ["data/proposals", "data/threads", "mailbox"];
	return Object.fromEntries(dirs.map((dir) => [dir, { digest: digestTree(path.join(home, dir)), files: hashTree(path.join(home, dir)) }]));
}

/** Await a file created by a committed server write; fs.watch on the parent, named 10 s deadline. */
function awaitPath(file, label) {
	let watcher = null;
	return new Promise((resolve, reject) => {
		let timer = null;
		const finish = (error) => {
			if (timer !== null) clearTimeout(timer);
			watcher?.close();
			if (error) reject(error);
			else resolve(file);
		};
		const check = () => {
			if (fs.existsSync(file)) finish(null);
		};
		timer = setTimeout(() => finish(new Error(`${label} did not appear within ${DEADLINE_MS}ms`)), DEADLINE_MS);
		try {
			watcher = fs.watch(path.dirname(file), () => check());
			watcher.on("error", (error) => finish(error));
			check();
		} catch (error) {
			finish(error);
		}
	});
}

async function bodyOf(res) {
	const text = await res.text();
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return text;
	}
}

async function call(base, route, init = {}) {
	const res = await fetch(base + route, { ...init, signal: AbortSignal.timeout(DEADLINE_MS) });
	return { status: res.status, body: await bodyOf(res) };
}

async function postRaw(base, route, raw) {
	return call(base, route, { method: "POST", headers: POST, body: raw });
}

async function cdp(page, method, params, sessionId) {
	return page.cdp.send(method, params, sessionId);
}

async function setScheme(page, scheme, sessionId) {
	await cdp(page, "Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }, sessionId);
}

async function setZoom(page, zoom, sessionId) {
	await cdp(page, "Emulation.setPageScaleFactor", { pageScaleFactor: zoom / 100 }, sessionId);
}

async function key(page, sessionId, name, { shift = false } = {}) {
	const isTab = name === "Tab";
	const base = {
		key: name,
		code: isTab ? "Tab" : "Escape",
		windowsVirtualKeyCode: isTab ? 9 : 27,
		nativeVirtualKeyCode: isTab ? 9 : 27,
		modifiers: shift ? 8 : 0,
	};
	await cdp(page, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
	await cdp(page, "Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
}

function pageReady(name) {
	if (name === "inbox") return "() => document.querySelector('#list .row[data-session]') ? true : null";
	// At >=720px /s/<id> becomes the split view at /?s=<id>, so accept the list + frame there.
	if (name === "thread") return "() => document.querySelector('#reply') || document.querySelector('#thread-frame') || (document.querySelector('#list .row[data-session]') && document.querySelector('[data-issue-report]')) ? true : null";
	if (name === "boards") return "() => document.querySelector('#list') && document.querySelector('#list').getAttribute('aria-busy') === 'false' ? true : null";
	if (name === "proposal") return "() => document.querySelector('#tabs') && document.querySelector('#title')?.textContent ? true : null";
	return "() => { const app = document.getElementById('issues-app'); return app && app.dataset.route === 'list' && (document.querySelector('#issue-rows .row') || document.querySelector('#issue-rows .empty') || document.querySelector('.empty')) ? true : null; }";
}

function pagePath(name, ctx) {
	if (name === "inbox") return "/";
	if (name === "thread") return `/s/${encodeURIComponent(ctx.fixtures.threads.a)}`;
	if (name === "boards") return "/boards";
	if (name === "proposal") return `/p/${encodeURIComponent(ctx.fixtures.decision.id)}`;
	return "/issues";
}

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const actions = [];
	const record = { combined: {}, matrix: [], sourceIsolation: {}, cleanup: null };
	const act = (step, detail, signal) => actions.push({ step, detail, signal, at: new Date().toISOString() });
	const save = (name, data) => evidence(name, typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, "\t"));
	const saveJson = (name, data) => save(name, JSON.stringify(data, null, "\t"));
	const beforeCombined = isolationSnapshot(ctx.home);

	let page = null;
	let sidePage = null;
	try {
		const capabilities = await ctx.get("/api/issues/capabilities");
		const storeId = capabilities.storeId;
		record.combined.capabilities = { storeId, build: capabilities.build };
		check("Q20 capabilities give the store id used by the combined case", typeof storeId === "string" && /^[0-9a-f-]{36}$/.test(storeId), storeId);

		// ---- a fresh proposal at revision 1, created through the fixture HTTP API ----
		const identityModule = await import(pathToFileURL(path.join(ctx.appDir, "src", "identity.mjs")).href);
		const identity = await identityModule.identityFor(ctx.home, {});
		const owner = { ...identity, session: { id: "qa-owner", file: null } };
		const sourceDir = path.join(ctx.runTmp, "q20-proposal-r1");
		const reviseDir = path.join(ctx.runTmp, "q20-proposal-r2");
		// A distinct title gives this mixed-case proposal its own id, away from the seeded fixtures.
		const sourceBoard = { ...decisionRev1, title: "Q20 통합 회귀 결정" };
		const reviseBoard = { ...decisionRev2, title: sourceBoard.title };
		for (const [dir, board] of [[sourceDir, sourceBoard], [reviseDir, reviseBoard]]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(board));
			fs.copyFileSync(ctx.fixtures.frame, path.join(dir, "frame.png"));
		}
		const seeded = await ctx.post("/api/proposals", { cwd: sourceDir, identity: owner, srcDir: sourceDir });
		const proposalId = seeded.summary.id;
		record.combined.proposal = { id: proposalId, rev: seeded.summary.rev };
		check("Q20 the fixture API seeds a fresh proposal at revision 1", typeof proposalId === "string" && seeded.summary.rev === 1, JSON.stringify(record.combined.proposal));

		// ---- open revision 1, then the real viewer, then the reporter over the viewer ----
		page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q20_page");
		const sessionId = await withDeadline(page.resolveSessionId(), DEADLINE_MS, "q20_session");
		const oldUrl = `${ctx.base}/p/${encodeURIComponent(proposalId)}?rev=1`;
		await withDeadline(page.goto(oldUrl, { waitUntil: "load" }), DEADLINE_MS, "q20_goto_rev1");
		await withDeadline(page.evaluate(waitForDom(pageReady("proposal"), "q20_rev1_ready")), DEADLINE_MS, "q20_rev1_ready");
		// The page's reporter is mounted asynchronously after its board data arrives. Its dialog and
		// bound entry anchors are the readiness signal; opening the viewer before that leaves the
		// report link as a plain anchor and would navigate to /issues/new instead.
		await withDeadline(page.evaluate(waitForDom(`() => {
			const state = window.__vb;
			const dialog = document.getElementById('issue-report');
			return state && state.summary && state.rev === 1 && state.boards && state.boards[1] && dialog && !dialog.open ? true : null;
		}`, "q20_report_mounted")), DEADLINE_MS, "q20_report_mounted");
		const oldTab = await withDeadline(page.evaluate(`(() => ({
			location: location.pathname + location.search,
			text: document.body.innerText.slice(0, 700),
			tabs: [...document.querySelectorAll('#tabs button')].map((node) => ({ text: node.textContent.trim(), selected: node.getAttribute('aria-selected') })),
			report: Boolean(document.querySelector('[data-issue-report]'))
		}))()`), DEADLINE_MS, "q20_old_tab");
		record.combined.oldTab = oldTab;
		act("navigate", oldUrl, "old tab loaded revision 1");
		check("Q20 the old tab displays revision 1 before revision 2 is created", oldTab.location.includes("rev=1") && oldTab.text.includes(REV1_EXCERPT) && !oldTab.text.includes(REV2_TEXT) && oldTab.tabs.length === 1 && oldTab.report === true, JSON.stringify({ location: oldTab.location, tabs: oldTab.tabs, hasRev1: oldTab.text.includes(REV1_EXCERPT) }));

		const framePoint = await withDeadline(page.evaluate(`(() => {
			const node = document.querySelector('#sections .frame canvas') || document.querySelector('#sections .frame');
			node.scrollIntoView({ block: 'center' });
			const rect = node.getBoundingClientRect();
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		})()`), DEADLINE_MS, "q20_frame_point");
		for (const type of ["mousePressed", "mouseReleased"]) {
			await cdp(page, "Input.dispatchMouseEvent", { type, x: framePoint.x, y: framePoint.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, sessionId);
		}
		await withDeadline(page.evaluate(waitForDom("() => document.getElementById('viewer').hidden ? null : true", "q20_viewer_open")), DEADLINE_MS, "q20_viewer_open");
		const viewer = await withDeadline(page.evaluate(`(() => {
			const v = window.__vb && window.__vb.viewer ? window.__vb.viewer : null;
			const tab = document.querySelector('#tabs button[aria-selected="true"]');
			return { open: Boolean(v && v.open), label: v ? v.label : null, tab: tab ? tab.textContent.trim() : null, location: location.pathname + location.search, report: Boolean(document.getElementById('vReport')) };
		})()`), DEADLINE_MS, "q20_viewer_state");
		record.combined.viewer = viewer;
		act("viewer-open", "real mouse click on the revision-1 frame", JSON.stringify(viewer));
		check("Q20 the real Review viewer opens revision 1 and offers its 제보 action", viewer.open === true && viewer.location.includes("rev=1") && viewer.tab === "1안" && typeof viewer.label === "string" && viewer.report === true, JSON.stringify(viewer));

		await withDeadline(page.click("#vReport"), DEADLINE_MS, "q20_click_vreport");
		await withDeadline(page.evaluate(waitForDom("() => document.getElementById('issue-report')?.open ? true : null", "q20_reporter_open")), DEADLINE_MS, "q20_reporter_open");
		await withDeadline(page.click("#issue-attach-toggle"), DEADLINE_MS, "q20_open_attachments");
		await withDeadline(page.evaluate(waitForDom("() => document.getElementById('issue-attach-list')?.hidden === false ? true : null", "q20_attachments_open")), DEADLINE_MS, "q20_attachments_open");
		const opened = await withDeadline(page.evaluate(`(() => {
			const items = {};
			for (const item of document.querySelectorAll('#issue-attach-list [data-item]')) items[item.dataset.item] = item.textContent;
			return {
				open: document.getElementById('issue-report').open,
				items,
				chip: document.getElementById('issue-target-label')?.textContent ?? '',
				pathname: location.pathname
			};
		})()`), DEADLINE_MS, "q20_reporter_opened");
		record.combined.opened = opened;
		act("report-open", "the viewer's 제보 button opens the reporter over revision 1", JSON.stringify(opened));
		check("Q20 the reporter opens over the revision-1 viewer with the adapter-frozen source", opened.open === true && opened.pathname === `/p/${proposalId}` && opened.items.source === `Review ${proposalId} r1` && opened.chip === `Review ${proposalId} r1` && typeof opened.items.excerpt === "string" && opened.items.excerpt.includes(viewer.label), JSON.stringify(opened));

		// ---- forced display-capture denial: the PAGE rejects, the editor handles it ----
		const override = await withDeadline(page.evaluate(`(() => {
			const media = navigator.mediaDevices;
			const original = media.getDisplayMedia;
			window.__q20media = { original, called: 0, constraints: null, errorName: null };
			media.getDisplayMedia = function (constraints) {
				window.__q20media.called += 1;
				window.__q20media.constraints = constraints;
				const error = new DOMException('wrong window was selected', 'NotAllowedError');
				window.__q20media.errorName = error.name;
				return Promise.reject(error);
			};
			return { secure: isSecureContext, replaced: media.getDisplayMedia !== original, captureVisible: !document.getElementById('issue-capture').hidden };
		})()`), DEADLINE_MS, "q20_capture_override");
		record.combined.captureOverride = override;
		check("Q20 the real capture control is available and navigator.mediaDevices.getDisplayMedia is overridden in the page", override.secure === true && override.replaced === true && override.captureVisible === true, JSON.stringify(override));
		await withDeadline(page.click("#issue-capture"), DEADLINE_MS, "q20_click_capture");
		await withDeadline(page.evaluate(waitForDom("() => document.querySelector('.issue-image')?.dataset.state === 'error' ? true : null", "q20_capture_denied")), DEADLINE_MS, "q20_capture_denied");
		const denied = await withDeadline(page.evaluate(`(() => {
			const q = window.__q20media;
			const image = document.querySelector('.issue-image');
			const summary = document.getElementById('issue-attach-summary').textContent;
			navigator.mediaDevices.getDisplayMedia = q.original;
			return {
				called: q.called,
				constraints: q.constraints,
				errorName: q.errorName,
				imageState: image.dataset.state,
				summary,
				restored: navigator.mediaDevices.getDisplayMedia === q.original
			};
		})()`), DEADLINE_MS, "q20_capture_result");
		record.combined.denied = { ...denied, simulatedDenial: true, note: "navigator.mediaDevices.getDisplayMedia was replaced in the page to reject with NotAllowedError; the product editor handled the denial and retained no pixels" };
		act("capture-denied", "#issue-capture through the editor's real getDisplayMedia path", JSON.stringify(record.combined.denied));
		check("Q20 the editor handles the wrong-window/denied capture as an empty image, retains no pixels and restores the page API", denied.called === 1 && denied.constraints?.video === true && denied.constraints?.audio === false && denied.errorName === "NotAllowedError" && denied.imageState === "error" && denied.restored === true, JSON.stringify(record.combined.denied));

		await withDeadline(page.fill("#issue-description", DESCRIPTION), DEADLINE_MS, "q20_fill_description");

		// ---- revision 2 arrives through the fixture API while the reporter is open ----
		const revised = await ctx.post(`/api/p/${encodeURIComponent(proposalId)}/revise`, { srcDir: reviseDir, session: { id: "qa-owner" }, note: "Q20 두 번째 수정본" });
		const whileOpen = await withDeadline(page.evaluate(`(() => ({
			open: document.getElementById('issue-report').open,
			source: document.querySelector('#issue-attach-list [data-item="source"]')?.textContent ?? '',
			text: document.getElementById('issue-description')?.value ?? null
		}))()`), DEADLINE_MS, "q20_after_revise");
		record.combined.whileOpen = { revised: { status: revised.status, rev: revised.summary?.rev }, ...whileOpen };
		act("revise", "POST /api/p/<id>/revise while the reporter is open", JSON.stringify(record.combined.whileOpen));
		check("Q20 revision 2 is created through the fixture API while the reporter is open and the frozen source stays r1 with the typed text", revised.status === 200 && revised.summary?.rev === 2 && whileOpen.open === true && whileOpen.source === `Review ${proposalId} r1` && whileOpen.text === DESCRIPTION, JSON.stringify(record.combined.whileOpen));

		// ---- the create response is lost after the server committed ----
		await withDeadline(page.evaluate(`(() => {
			const real = window.fetch.bind(window);
			window.__q20RealFetch = real;
			window.fetch = async (input, init) => {
				const url = typeof input === 'string' ? input : input.url;
				const method = (init && init.method) || (input && input.method) || 'GET';
				const response = await real(input, init);
				if (method === 'POST' && url === '/api/issues') {
					window.__q20Envelope = init.body;
					window.__q20Lost = { status: response.status, body: await response.clone().json() };
					throw new TypeError('Q20 create response lost after the server committed');
				}
				return response;
			};
			return true;
		})()`), DEADLINE_MS, "q20_install_lost_response");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q20_send");
		await withDeadline(page.evaluate(waitForDom("() => window.__q20Lost ? true : null", "q20_lost_captured")), DEADLINE_MS, "q20_lost_captured");
		const lost = await withDeadline(page.evaluate(`(() => ({
			envelope: window.__q20Envelope ? JSON.parse(window.__q20Envelope) : null,
			response: window.__q20Lost,
			status: document.getElementById('issue-status')?.textContent ?? '',
			text: document.getElementById('issue-description')?.value ?? null,
			retry: (() => { const node = document.getElementById('issue-retry'); return node && !node.hidden ? node.textContent : null; })()
		}))()`), DEADLINE_MS, "q20_lost_state");
		const envelope = lost.envelope;
		const requestId = envelope?.requestId;
		const captureId = envelope?.evidence?.captureId;
		const observedSeq = envelope?.evidence?.source?.observedSeq;
		record.combined.envelope = envelope && {
			requestId,
			description: envelope.description,
			captureId,
			page: envelope.evidence.page,
			source: envelope.evidence.source,
			visual: envelope.evidence.visual,
			excerpt: envelope.evidence.excerpt,
			excerptEnabled: envelope.evidence.excerptEnabled,
			visibleIds: envelope.evidence.visibleIds,
		};
		record.combined.lost = { rejected: lost.response, status: lost.status, retry: lost.retry };
		act("create-lost-response", "POST /api/issues committed, then the response was dropped", JSON.stringify({ status: lost.response?.status, requestId }));
		check("Q20 the create response is lost after the server committed (201, receipt seq 1)", lost.response?.status === 201 && lost.response?.body?.receipt?.seq === 1 && lost.response?.body?.receipt?.requestId === requestId, JSON.stringify({ status: lost.response?.status, receipt: lost.response?.body?.receipt }));
		check("Q20 the real adapter froze revision 1 with the open-time observedSeq, the viewer excerpt and a truthful none/denied visual", envelope?.evidence?.source?.kind === "proposal" && envelope.evidence.source.proposalId === proposalId && envelope.evidence.source.revision === 1 && Number.isSafeInteger(observedSeq) && observedSeq >= 0 && envelope.evidence.page === "proposal" && typeof envelope.evidence.excerpt === "string" && envelope.evidence.excerpt.includes(viewer.label) && envelope.evidence.visual?.kind === "none" && envelope.evidence.visual?.reason === "denied" && envelope.evidence.visual?.simulatedDenial === undefined, JSON.stringify(record.combined.envelope));
		check("Q20 the editor keeps the text and offers the same-request retry after the lost response", lost.text === DESCRIPTION && typeof lost.retry === "string" && lost.status.includes("접수 확인 중"), JSON.stringify({ text: lost.text, retry: lost.retry, status: lost.status }));

		// The harness barrier after the server's write: the record bytes exist before we move on.
		const recordDir = path.join(ctx.home, "data", "issues", "records", requestId);
		await awaitPath(path.join(recordDir, "created.json"), "q20_committed_record");

		// ---- concurrent triage at expectedSeq 1: exactly one wins, the loser retries ----
		const triage = (triageId) => JSON.stringify({ v: 1, storeId, requestId: triageId, expectedSeq: 1, command: { type: "triage", category: "inbox-ui", severity: "normal", note: "Q20 maintainer triage" } });
		const [first, second] = await Promise.all([
			postRaw(ctx.base, `/api/issues/${requestId}/commands`, triage(TRIAGE_A)),
			postRaw(ctx.base, `/api/issues/${requestId}/commands`, triage(TRIAGE_B)),
		]);
		const winner = first.status === 200 ? { requestId: TRIAGE_A, ...first } : second.status === 200 ? { requestId: TRIAGE_B, ...second } : null;
		const loser = first.status === 200 ? { requestId: TRIAGE_B, ...second } : { requestId: TRIAGE_A, ...first };
		record.combined.concurrent = { first: { status: first.status, body: first.body }, second: { status: second.status, body: second.body }, winner, loser };
		act("concurrent-triage", "two POST /commands at expectedSeq 1", `${first.status}/${second.status}`);
		check("Q20 concurrent triage commits exactly one event and returns one version_conflict", Boolean(winner) && loser.status === 409 && loser.body.error === "version_conflict" && winner.body.currentSeq === 2 && winner.body.state === "investigating", JSON.stringify(record.combined.concurrent));

		const loserRaw = JSON.stringify({ v: 1, storeId, requestId: loser.requestId, expectedSeq: 2, command: { type: "triage", category: "inbox-ui", severity: "normal", note: "Q20 retried after concurrent conflict" } });
		const retried = await postRaw(ctx.base, `/api/issues/${requestId}/commands`, loserRaw);
		record.combined.retriedTriage = { status: retried.status, body: retried.body };
		act("retry-triage", "loser retried at expectedSeq 2 with the same requestId", `${retried.status}`);
		check("Q20 the conflicting triage retries at the next sequence and advances once", retried.status === 200 && retried.body.currentSeq === 3 && retried.body.state === "investigating", JSON.stringify(record.combined.retriedTriage));

		// ---- reload, then the same page replays the frozen request through the product UI ----
		await withDeadline(page.goto(oldUrl, { waitUntil: "load" }), DEADLINE_MS, "q20_reload");
		await withDeadline(page.evaluate(waitForDom(pageReady("proposal"), "q20_reload_ready")), DEADLINE_MS, "q20_reload_ready");
		await withDeadline(page.click("nav.top a[data-issue-report]"), DEADLINE_MS, "q20_reopen_reporter");
		await withDeadline(page.evaluate(waitForDom("() => document.getElementById('issue-report')?.open ? true : null", "q20_reopen_ready")), DEADLINE_MS, "q20_reopen_ready");
		// The product's mount-time resume drains the frozen outbox entry: it GETs the deterministic
		// issue id (the requestId) and stores the original receipt under that same id, then clears the
		// outbox. Waiting for the persisted receipt is a bounded observation of that real state.
		const resumed = await withDeadline(page.evaluate(`(async () => {
			const open = () => new Promise((resolve, reject) => {
				const request = indexedDB.open('inbox-issues-v1');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const read = (db, store, key) => new Promise((resolve, reject) => {
				const tx = db.transaction(store, 'readonly');
				const get = tx.objectStore(store).get(key);
				get.onsuccess = () => resolve(get.result ?? null);
				get.onerror = () => reject(get.error);
			});
			const db = await open();
			try {
				const deadline = Date.now() + 9000;
				while (Date.now() < deadline) {
					const receipt = await read(db, 'receipts', ${JSON.stringify(requestId)});
					if (receipt) {
						const outbox = await read(db, 'outbox', ${JSON.stringify(requestId)});
						return { outbox: outbox ? { requestId: outbox.requestId } : null, receipt: { requestId: receipt.requestId, receipt: receipt.receipt } };
					}
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				throw new Error('the resumed receipt did not appear within 9000ms');
			} finally {
				db.close();
			}
		})()`), DEADLINE_MS, "q20_resumed_receipt");
		record.combined.resumed = resumed;
		act("reload", "page reload; the outbox resumes the same requestId", JSON.stringify(resumed));
		check("Q20 the reload replays the same requestId to the original receipt and drains its outbox entry", resumed.receipt?.requestId === requestId && resumed.receipt?.receipt?.requestId === requestId && resumed.receipt.receipt.seq === 1 && resumed.outbox === null, JSON.stringify(resumed));

		// ---- assert the PERSISTED bytes, not the API projection ----
		const created = JSON.parse(fs.readFileSync(path.join(recordDir, "created.json"), "utf8"));
		const eventNames = fs.readdirSync(path.join(recordDir, "events")).filter((name) => /^\d+\.json$/.test(name)).sort();
		const events = eventNames.map((name) => JSON.parse(fs.readFileSync(path.join(recordDir, "events", name), "utf8")));
		const context = JSON.parse(fs.readFileSync(path.join(recordDir, "evidence", captureId, "context.json"), "utf8"));
		const detail = await ctx.get(`/api/issues/${requestId}`);
		const list = await ctx.get("/api/issues?limit=100");
		const image = await call(ctx.base, `/api/issues/${requestId}/evidence/${captureId}/image`);
		const createdEvent = events[0];
		record.combined.persisted = {
			created,
			events: events.map((event) => ({ seq: event.seq, type: event.type, requestId: event.requestId, acceptedAt: event.acceptedAt, state: event.state, actor: event.actor })),
			context: {
				captureId: context.captureId,
				page: context.page,
				source: context.source,
				excerpt: context.excerpt,
				visual: context.visual,
				visibleIds: context.visibleIds,
			},
			listMatches: list.items.filter((item) => item.id === requestId).length,
			imageStatus: image.status,
			referenceCheck: detail.evidence?.[0]?.referenceCheck ?? null,
		};
		saveJson("Q20-combined.json", record.combined);
		check("Q20 one issue keeps the revision-1 source with the open-time observedSeq after revision 2 and triage", created.id === requestId && created.source?.kind === "proposal" && created.source.proposalId === proposalId && created.source.revision === 1 && created.source.observedSeq === observedSeq && record.combined.persisted.listMatches === 1, JSON.stringify({ created: { id: created.id, source: created.source }, observedSeq, listMatches: record.combined.persisted.listMatches }));
		check("Q20 visual provenance stays none/denied in the persisted context and no image was invented", context.visual?.kind === "none" && context.visual?.reason === "denied" && context.visual?.pixels === undefined && context.page === "proposal" && context.source?.revision === 1 && context.excerpt === envelope.evidence.excerpt && image.status === 404, JSON.stringify({ visual: context.visual, page: context.page, excerpt: context.excerpt, imageStatus: image.status }));
		check("Q20 the original receipt is persisted unrewritten and the current state is investigating after the triage race", createdEvent?.type === "created" && createdEvent.requestId === requestId && createdEvent.acceptedAt === created.createdAt && events.length === 3 && events.map((event) => event.type).join() === "created,triage,triage" && events[1].state === "investigating" && events[2].state === "investigating" && events[2].seq === 3 && detail.currentSeq === 3 && detail.state === "investigating" && record.combined.persisted.referenceCheck?.status === "matched", JSON.stringify(record.combined.persisted.events));

		save("Q20-combined-rev1.png", Buffer.from(await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q20_combined_shot")));
		await withDeadline(page.goto(`${ctx.base}/issues/${requestId}`, { waitUntil: "load" }), DEADLINE_MS, "q20_goto_issue_detail");
		await withDeadline(page.evaluate(waitForDom("() => document.getElementById('issues-app')?.dataset.route === 'detail' ? true : null", "q20_issue_detail")), DEADLINE_MS, "q20_issue_detail");
		save("Q20-combined-issue.png", Buffer.from(await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q20_issue_shot")));
		check("Q20 combined failure-case artifacts were written", ["Q20-combined.json", "Q20-combined-rev1.png", "Q20-combined-issue.png"].every((name) => fs.existsSync(path.join(ctx.evidenceDir, name))), ctx.evidenceDir);

		// ---- source isolation warm-up, then the baseline is taken AFTER the warm-up writes ----
		sidePage = await withDeadline(newQaPage(browser, { width: 390, height: 844, scheme: "light" }), DEADLINE_MS, "q20_warm_page");
		const sideSession = await withDeadline(sidePage.resolveSessionId(), DEADLINE_MS, "q20_warm_session");
		for (const name of ["inbox", "thread", "boards", "proposal", "issues"]) {
			await setScheme(sidePage, "light", sideSession);
			await setZoom(sidePage, 100, sideSession);
			await withDeadline(sidePage.goto(ctx.base + pagePath(name, ctx), { waitUntil: "load" }), DEADLINE_MS, `q20_warm_${name}`);
			await withDeadline(sidePage.evaluate(waitForDom(pageReady(name), `q20_warm_${name}_ready`)), DEADLINE_MS, `q20_warm_${name}_ready`);
		}
		await withDeadline(sidePage.close(), DEADLINE_MS, "q20_warm_close").catch(() => sidePage.dispose?.());
		sidePage = null;
		act("warm-up", "inbox, thread, boards, proposal, issues at 390/light/100", "the pages' read-state writes happen before the baseline");
		const matrixBaseline = isolationSnapshot(ctx.home);
		record.sourceIsolation.before = matrixBaseline;
		record.sourceIsolation.beforeCombined = beforeCombined;

		// ---- five widths x two schemes x two zooms x five pages ----
		const pages = ["inbox", "thread", "boards", "proposal", "issues"];
		let screenshots = 0;
		for (const pageWidth of WIDTHS) {
			const matrixPage = await withDeadline(newQaPage(browser, { width: pageWidth, height: 900, scheme: "light" }), DEADLINE_MS, `q20_matrix_page_${pageWidth}`);
			try {
				const matrixSession = await withDeadline(matrixPage.resolveSessionId(), DEADLINE_MS, `q20_matrix_session_${pageWidth}`);
				for (const name of pages) {
					await setScheme(matrixPage, "light", matrixSession);
					await setZoom(matrixPage, 100, matrixSession);
					const url = ctx.base + pagePath(name, ctx);
					await withDeadline(matrixPage.goto(url, { waitUntil: "load" }), DEADLINE_MS, `q20_matrix_goto_${name}_${pageWidth}`);
					await withDeadline(matrixPage.evaluate(waitForDom(pageReady(name), `q20_matrix_ready_${name}_${pageWidth}`)), DEADLINE_MS, `q20_matrix_ready_${name}_${pageWidth}`);
					for (const currentScheme of SCHEMES) {
						for (const zoom of ZOOMS) {
							await setScheme(matrixPage, currentScheme, matrixSession);
							await setZoom(matrixPage, zoom, matrixSession);
							await key(matrixPage, matrixSession, "Tab");
							await key(matrixPage, matrixSession, "Tab");
							await key(matrixPage, matrixSession, "Tab", { shift: true });
							const keyboard = await withDeadline(matrixPage.evaluate(`(() => {
								const active = document.activeElement;
								return {
									tag: active ? active.tagName : null,
									id: active && active.id ? active.id : null,
									text: active && active.textContent ? active.textContent.trim().slice(0, 40) : null,
									inside: Boolean(active && document.body.contains(active))
								};
							})()`), DEADLINE_MS, `q20_keyboard_${name}_${pageWidth}_${currentScheme}_${zoom}`);
							const beforeEscape = await withDeadline(matrixPage.evaluate("location.href"), DEADLINE_MS, `q20_url_before_${name}_${pageWidth}`);
							await key(matrixPage, matrixSession, "Escape");
							const afterEscape = await withDeadline(matrixPage.evaluate("location.href"), DEADLINE_MS, `q20_url_after_${name}_${pageWidth}`);
							const metrics = await withDeadline(matrixPage.evaluate(`(() => ({
								innerWidth,
								innerHeight,
								scale: visualViewport ? visualViewport.scale : null,
								visualWidth: visualViewport ? Math.round(visualViewport.width) : null,
								scrollWidth: document.documentElement.scrollWidth,
								report: Boolean(document.querySelector('[data-issue-report]')),
								issuesRoute: document.getElementById('issues-app') ? document.getElementById('issues-app').dataset.route : null,
								colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
								reportRect: (() => {
									const node = document.querySelector('[data-issue-report]') || document.getElementById('issues-new') || document.getElementById('issues-back');
									if (!node) return null;
									const rect = node.getBoundingClientRect();
									return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), right: Math.round(rect.right) };
								})()
							}))()`), DEADLINE_MS, `q20_metrics_${name}_${pageWidth}_${currentScheme}_${zoom}`);
							const shot = await withDeadline(matrixPage.screenshot({ type: "png" }), DEADLINE_MS, `q20_shot_${name}_${pageWidth}_${currentScheme}_${zoom}`);
							const file = `screens/${name}-${pageWidth}-${currentScheme}-${zoom}.png`;
							const saved = evidence(file, Buffer.from(shot));
							screenshots += 1;
							const documentOverflow = metrics.scrollWidth > metrics.innerWidth;
							const zoomOk = Math.abs((metrics.scale ?? 0) - zoom / 100) < 0.05;
							const reportOk = name === "issues" ? metrics.issuesRoute === "list" : metrics.report === true;
							const reportInside = Boolean(metrics.reportRect) && metrics.reportRect.width > 0 && metrics.reportRect.height > 0 && (name !== "issues" || (metrics.reportRect.width >= 44 && metrics.reportRect.height >= 44)) && metrics.reportRect.x >= 0 && metrics.reportRect.right <= metrics.innerWidth + 1;
							const keyboardOk = keyboard.inside === true && keyboard.tag !== "BODY" && keyboard.tag !== "HTML" && beforeEscape === afterEscape;
							const schemeOk = metrics.colorScheme === currentScheme;
							const cell = {
								page: name,
								url: pagePath(name, ctx),
								width: pageWidth,
								height: 900,
								scheme: currentScheme,
								zoom,
								screenshot: file,
								screenshotBytes: fs.statSync(saved).size,
								metrics,
								keyboard,
								escapeKeptLocation: beforeEscape === afterEscape,
								documentOverflow,
								kb: keyboardOk,
							};
							record.matrix.push(cell);
							check(`Q20 ${name} ${pageWidth}px ${currentScheme} ${zoom}% has no horizontal overflow and keeps the report surface usable with keyboard focus`, zoomOk && reportOk && reportInside && keyboardOk && schemeOk && !documentOverflow && cell.screenshotBytes > 0, JSON.stringify({ documentOverflow, zoomOk, reportOk, reportInside, keyboardOk, schemeOk, metrics, keyboard }));
						}
					}
				}
			} finally {
				await withDeadline(matrixPage.close(), DEADLINE_MS, `q20_matrix_close_${pageWidth}`).catch(() => matrixPage.dispose?.());
			}
		}
		check("Q20 the responsive matrix wrote every 5x2x2x5 screenshot", screenshots === WIDTHS.length * SCHEMES.length * ZOOMS.length * pages.length && record.matrix.every((cell) => cell.screenshotBytes > 0), JSON.stringify({ screenshots, expected: 100 }));
		record.matrixOverflow = record.matrix.filter((cell) => cell.documentOverflow).map((cell) => ({ page: cell.page, width: cell.width, scheme: cell.scheme, zoom: cell.zoom, scrollWidth: cell.metrics.scrollWidth, innerWidth: cell.metrics.innerWidth }));
		const keyboardMatrix = record.matrix.filter((cell) => cell.kb === true);
		check("Q20 aggregate matrix and keyboard-only matrix covered every page, width, scheme and zoom", keyboardMatrix.length === record.matrix.length && record.matrix.length === 100 && record.matrix.every((cell) => cell.kb === true) && record.matrixOverflow.length === 0, JSON.stringify({ cells: record.matrix.length, keyboardCells: keyboardMatrix.length, overflowCells: record.matrixOverflow.length, overflow: record.matrixOverflow }));

		// ---- source isolation digests ----
		const after = isolationSnapshot(ctx.home);
		record.sourceIsolation.after = after;
		const equal = (dir) => JSON.stringify(matrixBaseline[dir].files) === JSON.stringify(after[dir].files);
		record.sourceIsolation.matrix = {
			proposals: equal("data/proposals"),
			threads: equal("data/threads"),
			mailbox: equal("mailbox"),
		};
		record.sourceIsolation.scenario = { ...record.sourceIsolation.matrix };
		record.sourceIsolation.fromCombined = {
			proposals: JSON.stringify(beforeCombined["data/proposals"].files) === JSON.stringify(after["data/proposals"].files),
			threads: JSON.stringify(beforeCombined["data/threads"].files) === JSON.stringify(after["data/threads"].files),
			mailbox: JSON.stringify(beforeCombined.mailbox.files) === JSON.stringify(after.mailbox.files),
		};
		saveJson("Q20-source-isolation.json", record.sourceIsolation);
		check("Q20 source isolation digests are unchanged before/after the whole matrix (data/proposals, data/threads, mailbox)", record.sourceIsolation.matrix.proposals && record.sourceIsolation.matrix.threads && record.sourceIsolation.matrix.mailbox, JSON.stringify(record.sourceIsolation.matrix));
		check("Q20 the scenario window after the warm-up leaves proposals, threads and mailbox byte-identical", record.sourceIsolation.scenario.proposals && record.sourceIsolation.scenario.threads && record.sourceIsolation.scenario.mailbox, JSON.stringify({ window: record.sourceIsolation.scenario, fromCombined: record.sourceIsolation.fromCombined }));
	} finally {
		if (page) await withDeadline(page.close(), DEADLINE_MS, "q20_page_close").catch(() => page.dispose?.());
		if (sidePage) await withDeadline(sidePage.close(), DEADLINE_MS, "q20_side_close").catch(() => sidePage.dispose?.());
		record.cleanup = {
			pagesClosed: true,
			screenshots: record.matrix.length,
			screenshotDir: path.join(ctx.evidenceDir, "screens"),
			scenarioTempRoot: ctx.runTmp,
			harnessCleanup: path.join(ctx.evidenceDir, "cleanup.json"),
			note: "browser and server are owned by qa/issues-qa.mjs; its per-profile reaper and teardown receipt are the cleanup authority",
		};
		saveJson("Q20-cleanup.json", record.cleanup);
		saveJson("Q20-actions.json", { actions, combined: record.combined, matrix: record.matrix, matrixOverflow: record.matrixOverflow, sourceIsolation: record.sourceIsolation });
	}
}
