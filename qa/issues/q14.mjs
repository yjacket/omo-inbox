/* Q14: 제보함 list, detail and the owner confirmation loop at 1280x800 in the dark scheme.
 *
 * Seeds three issues through the real HTTP API (one with a matched Review source and a display
 * capture plus a maintainer reproduction and a matched build check; one with a missing source and
 * an unknown build; one with no source and no image), then drives web/issues.html in the harness
 * browser: search, open the detail, read original and correction evidence, comment, #issue-confirm,
 * #issue-reopen, and prove through GET that the sequence and history are preserved and the list
 * reflects the state. The failure track covers a missing source, a 500 list response, an empty
 * search, a stale command (409 with the current sequence shown and the page refreshed), a malformed
 * success (200 {} on a comment: uncertain, text kept, the SAME requestId replayed on 다시 보내기), a
 * stale reopen (409 keeps the typed explanation for the fresh sequence), an append image that must
 * survive a comment and the refresh it causes, an unknown build and a confirmed purge (410
 * afterwards, no reachable image bytes, no resurrection from the old create or command envelopes).
 * The standalone route /issues/new mounts the shared reporter: a text-only report is accepted on a
 * verified receipt, and a 200 that carries only ok:true and an id stays uncertain with the text kept
 * until the retry resolves it. Every wait is an awaited DOM mutation, navigation or HTTP response
 * inside a named 10 s deadline; nothing sleeps.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { framePng } from "../frame.mjs";

export const viewport = { width: 1280, height: 800, scheme: "dark" };

const DEADLINE_MS = 10_000;
const HTTP_TIMEOUT_MS = 10_000;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const UNKNOWN_BUILD = "f".repeat(64);
const ISSUE_A = "14141401-1414-4141-8141-141414141401";
const ISSUE_B = "14141402-1414-4141-8141-141414141402";
const ISSUE_C = "14141403-1414-4141-8141-141414141403";
const CAPTURE_A = "14141411-1414-4141-8141-141414141411";
const CAPTURE_B = "14141412-1414-4141-8141-141414141412";
const CAPTURE_C = "14141413-1414-4141-8141-141414141413";
const REPRO_A = "14141421-1414-4141-8141-141414141421";
const CHECK_A = "14141431-1414-4141-8141-141414141431";
const CHECK_B = "14141432-1414-4141-8141-141414141432";
const EXTERNAL_COMMENT = "14141441-1414-4141-8141-141414141441";
const EXTERNAL_COMMENT_2 = "14141442-1414-4141-8141-141414141442";
const FAKE_ID = "14141451-1414-4141-8141-141414141451";
const UNCERTAIN_TEXT = "uncertain: 응답 없이 보낸 의견";
const REOPEN_TEXT = "reopen: 아직 문제가 남아 있습니다";
const IMAGE_COMMENT = "사진을 고른 채 남기는 의견";
const STANDALONE_TEXT = "출처 없이 보내는 제보 <b>inert</b>";
const FAKE_TEXT = "가짜 접수 응답에 넘어가면 안 되는 설명";
const DESCRIPTION_A = "결제 화면에서 제보 버튼이 보이지 않습니다 <script>alert(1)</script><img src=x onerror=alert(1)>\n두 번째 줄입니다.";
const DESCRIPTION_B = "목록 화면이 비어 보입니다";
const DESCRIPTION_C = "검색 결과 문구를 다듬어 주세요";
const RED = Buffer.from([255, 0, 0, 255]).toString("base64");
const GREEN = Buffer.from([0, 255, 0, 255]).toString("base64");
const BLUE_2X2 = Buffer.from([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255]).toString("base64");

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function capture(captureId, source, visual) {
	return {
		captureId,
		observedAt: "2026-10-23T00:00:00.000Z",
		page: "proposal",
		source,
		target: { kind: "control", key: "btn:report", label: "제보 버튼", rect: { x: 12, y: 24.5, w: 88, h: 44 }, framePath: [] },
		clientBuild: null,
		view: { width: 390, height: 844, dpr: 2, scale: 1, scrollX: 0, scrollY: 0, theme: "dark", locale: "ko-KR", embedded: false, viewerOpen: false },
		excerpt: "제보 버튼",
		excerptTruncated: false,
		visibleIds: [],
		diagnostics: [],
		contextStatus: "captured",
		visual,
	};
}

function raster(provenance, pixels, width = 1, height = 1) {
	return { kind: "raster", provenance, acquiredAt: null, sourceMatchesContext: "unverified", width, height, encoding: "rgba8-base64", pixels, masks: [], marks: [] };
}

/* Waits inside the page for a predicate over the DOM; a MutationObserver fires the check and a
 * 9 s timer rejects, so the harness deadline around the evaluate stays the outer bound. */
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

const RENDER_AT_LEAST = (route, minimum) => `() => {
	const app = document.getElementById('issues-app');
	if (!app || app.dataset.route !== ${JSON.stringify(route)}) return null;
	const render = Number(app.dataset.render || 0);
	return render >= ${minimum} ? { render, route: app.dataset.route, state: app.dataset.state ?? null, seq: app.dataset.seq ?? null, error: app.dataset.error ?? null, count: app.dataset.count ?? null } : null;
}`;

const DETAIL_AT = (state, seq) => `() => {
	const app = document.getElementById('issues-app');
	if (!app || app.dataset.route !== 'detail' || app.dataset.busy) return null;
	if (app.dataset.state !== ${JSON.stringify(state)} || app.dataset.seq !== ${JSON.stringify(String(seq))}) return null;
	return { render: Number(app.dataset.render), state: app.dataset.state, seq: app.dataset.seq, status: document.getElementById('issue-status')?.textContent ?? '' };
}`;

const IMAGE_READY = `() => {
	const send = document.getElementById('issue-append-send');
	const status = document.getElementById('issue-status')?.textContent ?? '';
	const canvas = Boolean(document.querySelector('#issue-append-editor canvas'));
	if (!send || send.disabled || !canvas || !status.includes('준비됨')) return null;
	return { status, ready: !send.disabled, canvas };
}`;

const IMAGE_STATE = `({
	status: document.getElementById('issue-status')?.textContent ?? '',
	ready: !(document.getElementById('issue-append-send')?.disabled ?? true),
	canvas: Boolean(document.querySelector('#issue-append-editor canvas')),
	text: document.getElementById('issue-comment')?.value ?? null,
})`;

const PENDING_SHOWN = `() => {
	const app = document.getElementById('issues-app');
	const box = document.getElementById('issue-pending');
	if (!app || app.dataset.busy || !app.dataset.pending || !box || box.hidden) return null;
	return {
		pending: app.dataset.pending,
		seq: app.dataset.seq,
		status: document.getElementById('issue-status')?.textContent ?? '',
		box: box.textContent,
		retry: document.getElementById('issue-retry')?.textContent ?? null,
		text: document.getElementById('issue-comment')?.value ?? null,
		history: document.querySelectorAll('#issue-history li').length,
		disabled: ['issue-comment-send', 'issue-confirm', 'issue-reopen', 'issue-purge'].map((id) => document.getElementById(id)?.disabled),
	};
}`;

const NEW_SNAPSHOT = `(() => {
	const app = document.getElementById('issues-app');
	const dialog = document.getElementById('issue-report');
	const retry = document.getElementById('issue-retry');
	return {
		route: app?.dataset.route ?? null,
		report: app?.dataset.report ?? null,
		accepted: app?.dataset.accepted ?? null,
		open: dialog?.open ?? null,
		modal: dialog ? dialog.matches(':modal') : null,
		dialogStatus: dialog?.dataset.status ?? null,
		status: document.getElementById('issue-status')?.textContent ?? '',
		tone: document.getElementById('issue-status')?.dataset.tone ?? null,
		chip: document.getElementById('issue-target-label')?.textContent ?? '',
		photoHidden: document.querySelector('.issue-report__photo')?.hidden ?? null,
		text: document.getElementById('issue-description')?.value ?? null,
		readOnly: document.getElementById('issue-description')?.readOnly ?? null,
		sendHidden: document.getElementById('issue-send')?.hidden ?? null,
		retry: retry ? { hidden: retry.hidden, text: retry.textContent, action: retry.dataset.action } : null,
		receiptHidden: document.getElementById('issue-receipt')?.hidden ?? null,
		link: document.getElementById('issue-link')?.getAttribute('href') ?? null,
		title: document.title,
		overflow: { scrollWidth: document.documentElement.scrollWidth, innerWidth },
	};
})()`;

/* Picks a file through CDP, the only way a headless profile fills a file input; the bytes are an
 * owned synthetic PNG written under ctx.runTmp, never a user file. */
async function chooseFile(page, withDeadline, selector, file, name) {
	const sessionId = await page.resolveSessionId();
	const { result } = await withDeadline(page.cdp.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})` }, sessionId), DEADLINE_MS, `${name}_element`);
	await withDeadline(page.cdp.send("DOM.setFileInputFiles", { objectId: result.objectId, files: [file] }, sessionId), DEADLINE_MS, `${name}_files`);
}

const LIST_SNAPSHOT = `(() => {
	const app = document.getElementById('issues-app');
	const rows = [...document.querySelectorAll('#issue-rows .row')].map((row) => ({
		id: row.dataset.id,
		title: row.querySelector('.title')?.textContent ?? '',
		state: row.dataset.state,
		chip: row.querySelector('.chip')?.textContent ?? '',
		meta: [...row.querySelectorAll('.where')].map((el) => el.textContent),
		height: Math.round(row.getBoundingClientRect().height),
	}));
	const filters = [...document.querySelectorAll('.seg label')].map((label) => ({
		text: label.querySelector('span')?.textContent ?? '',
		count: label.querySelector('.count')?.textContent ?? '',
		checked: label.querySelector('input')?.checked === true,
		height: Math.round(label.getBoundingClientRect().height),
	}));
	const badge = document.getElementById('issues-badge');
	const empty = document.querySelector('#issues-app .empty');
	const notice = document.querySelector('#issues-app .notice');
	return {
		render: app?.dataset.render ?? null,
		count: app?.dataset.count ?? null,
		error: app?.dataset.error ?? null,
		rows,
		filters,
		badge: { hidden: badge?.hidden ?? null, text: badge?.textContent ?? null, label: badge?.getAttribute('aria-label') ?? null },
		empty: { hidden: empty?.hidden ?? null, text: empty?.textContent ?? '' },
		notice: { hidden: notice?.hidden ?? null, text: notice?.textContent ?? '' },
		search: document.getElementById('issue-search')?.value ?? null,
		location: location.pathname + location.search,
		title: document.title,
		scheme: getComputedStyle(document.documentElement).colorScheme,
		background: getComputedStyle(document.documentElement).backgroundColor,
		newLink: { hidden: document.getElementById('issues-new')?.hidden ?? null, height: Math.round(document.getElementById('issues-new')?.getBoundingClientRect().height ?? 0) },
	};
})()`;

const DETAIL_SNAPSHOT = `(() => {
	const app = document.getElementById('issues-app');
	const text = (sel) => document.querySelector(sel)?.textContent ?? null;
	const facts = {};
	for (const dd of document.querySelectorAll('.facts dd')) facts[dd.dataset.key] = { value: dd.querySelector('a, span')?.textContent ?? '', note: dd.querySelector('.note')?.textContent ?? null, href: dd.querySelector('a')?.getAttribute('href') ?? null };
	const evidence = [...document.querySelectorAll('.ev')].map((card) => ({
		provenance: card.dataset.provenance,
		label: card.querySelector('.ev-label')?.textContent ?? '',
		note: card.querySelector('.chip-note')?.textContent ?? null,
		image: card.querySelector('.ev-image') ? { src: card.querySelector('.ev-image').getAttribute('src'), complete: card.querySelector('.ev-image').complete, naturalWidth: card.querySelector('.ev-image').naturalWidth } : null,
		meta: [...card.querySelectorAll('.ev-meta')].map((el) => el.textContent),
	}));
	const history = [...document.querySelectorAll('#issue-history li')].map((li) => ({
		seq: li.dataset.seq,
		type: li.dataset.type,
		readOnly: li.dataset.readonly === 'true',
		label: li.querySelector('.ev-label')?.textContent ?? '',
		actor: li.querySelector('.actor')?.textContent ?? '',
		chip: li.querySelector('.chip')?.textContent ?? null,
		text: li.querySelector('.text')?.textContent ?? null,
		check: li.querySelector('.check') ? { status: li.querySelector('.check').dataset.check, text: li.querySelector('.check').textContent } : null,
	}));
	const buttons = {};
	for (const id of ['issue-confirm', 'issue-reopen', 'issue-purge', 'issue-comment-send', 'issue-append-send']) {
		const el = document.getElementById(id);
		buttons[id] = el ? { disabled: el.disabled, text: el.textContent, height: Math.round(el.getBoundingClientRect().height) } : null;
	}
	return {
		render: app?.dataset.render ?? null,
		state: app?.dataset.state ?? null,
		seq: app?.dataset.seq ?? null,
		title: text('#issue-detail .head .title'),
		chip: text('#issue-detail .head .chip'),
		description: text('#issue-description-text'),
		injected: document.querySelectorAll('#issues-app script, #issues-app img[onerror], #issues-app img[src="x"]').length,
		facts,
		evidence,
		history,
		buttons,
		status: text('#issue-status'),
		purgeBox: { hidden: document.getElementById('issue-purge-box')?.hidden ?? null, text: document.getElementById('issue-purge-box')?.textContent ?? '' },
		gone: text('#issue-detail .gone'),
		pageText: document.getElementById('issues-app')?.textContent ?? '',
		documentTitle: document.title,
	};
})()`;

export default async function run({ browser, ctx, width, height, scheme = "dark", check, evidence }) {
	const { newQaPage, pinQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const actions = [];
	const states = { viewport: { width, height, scheme }, seeds: {}, list: {}, detail: {}, http: {}, failures: {}, standalone: {} };
	const act = (step, detail, signal) => actions.push({ step, detail, signal, at: new Date().toISOString() });
	const request = async (label, route, init = {}) => {
		const res = await fetch(ctx.base + route, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
		const text = await res.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		act(`http:${label}`, `${init.method ?? "GET"} ${route} -> ${res.status}`, "fetch settled within 10000ms");
		return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body, bytes: text.length };
	};
	const post = (label, route, body) => request(label, route, { method: "POST", headers: POST, body: JSON.stringify(body) });
	const evalIn = (page, expression, name) => withDeadline(page.evaluate(expression), DEADLINE_MS, name);
	const waitRender = (page, route, minimum, name) => evalIn(page, waitForDom(RENDER_AT_LEAST(route, minimum), name), name);
	const waitDetail = (page, state, seq, name) => evalIn(page, waitForDom(DETAIL_AT(state, seq), name), name);

	// ---- seed over HTTP ----
	const caps = await request("capabilities", "/api/issues/capabilities");
	const storeId = caps.body?.storeId;
	const serverBuild = caps.body?.build?.buildId ?? null;
	check("Q14 capabilities give a store id and a server build", typeof storeId === "string" && /^[0-9a-f]{64}$/.test(serverBuild ?? ""), JSON.stringify({ storeId, serverBuild }));
	const matchedSource = { kind: "proposal", proposalId: ctx.fixtures.decision.id, revision: 1, observedSeq: 0, recordedContentHash: null, frame: null };
	const missingSource = { kind: "proposal", proposalId: "q14-missing-proposal", revision: 1, observedSeq: 0, recordedContentHash: null, frame: null };
	const createA = { v: 1, storeId, requestId: ISSUE_A, description: DESCRIPTION_A, evidence: capture(CAPTURE_A, matchedSource, raster("display_capture", RED)) };
	const createB = { v: 1, storeId, requestId: ISSUE_B, description: DESCRIPTION_B, evidence: capture(CAPTURE_B, missingSource, raster("user_upload", BLUE_2X2, 2, 2)) };
	const createC = { v: 1, storeId, requestId: ISSUE_C, description: DESCRIPTION_C, evidence: { ...capture(CAPTURE_C, null, { kind: "none", reason: "not_requested" }), page: "issues", target: null, excerpt: null } };
	const seededA = await post("create-a", "/api/issues", createA);
	const seededB = await post("create-b", "/api/issues", createB);
	const seededC = await post("create-c", "/api/issues", createC);
	states.seeds = { a: seededA.body, b: seededB.body, c: seededC.body };
	check("Q14 three issues are seeded (201)", seededA.status === 201 && seededB.status === 201 && seededC.status === 201, JSON.stringify([seededA.status, seededB.status, seededC.status]));
	check("Q14 seed B carries a missing source reference", seededB.body?.referenceCheck?.status === "missing", JSON.stringify(seededB.body?.referenceCheck));
	const checkA = await post("request-check-a", `/api/issues/${ISSUE_A}/commands`, {
		v: 1, storeId, requestId: CHECK_A, expectedSeq: 1,
		command: { type: "request_check", note: "제보 화면을 고쳤습니다. 확인해 주세요.", correction: { kind: "inbox-build", buildId: serverBuild, summary: "제보 버튼 노출 수정" }, evidence: capture(REPRO_A, null, raster("reproduction", GREEN)) },
	});
	check("Q14 maintainer request_check on A is matched and needs-check", checkA.status === 200 && checkA.body?.correctionCheck?.status === "matched" && checkA.body?.state === "needs-check", `${checkA.status} ${JSON.stringify(checkA.body?.correctionCheck)}`);
	const checkB = await post("request-check-b", `/api/issues/${ISSUE_B}/commands`, {
		v: 1, storeId, requestId: CHECK_B, expectedSeq: 1,
		command: { type: "request_check", note: "다른 빌드에서 고쳤습니다", correction: { kind: "inbox-build", buildId: UNKNOWN_BUILD, summary: "알 수 없는 빌드" }, evidence: null },
	});
	check("Q14 unknown build on B stays unversioned", checkB.status === 200 && checkB.body?.correctionCheck?.status === "unversioned", `${checkB.status} ${JSON.stringify(checkB.body?.correctionCheck)}`);
	states.seeds.checks = { a: checkA.body, b: checkB.body };

	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q14_new_page");
	let narrow = null;
	try {
		// ---- list ----
		await withDeadline(page.goto(`${ctx.base}/issues`, { waitUntil: "load" }), DEADLINE_MS, "q14_goto_list");
		act("goto", "/issues", "load event");
		await waitRender(page, "list", 1, "q14_list_rendered");
		const list = await evalIn(page, LIST_SNAPSHOT, "q14_list_snapshot");
		states.list.initial = list;
		check("Q14 list renders the three seeded rows newest first", list.rows.length === 3 && list.rows.map((row) => row.id).join() === [ISSUE_C, ISSUE_B, ISSUE_A].join(), JSON.stringify(list.rows.map((row) => [row.id, row.chip])));
		check("Q14 list rows carry state text, category and severity", list.rows.every((row) => row.chip !== "" && row.meta.length === 2), JSON.stringify(list.rows[0]));
		check("Q14 header badge counts needs-check only", list.badge.hidden === false && list.badge.text === "2" && list.filters.find((entry) => entry.text === "확인 요청")?.count === "2" && list.filters.find((entry) => entry.text === "접수")?.count === "1", JSON.stringify(list.badge));
		const expectedBackground = scheme === "dark" ? "rgb(17, 18, 20)" : "rgb(243, 244, 246)";
		check(`Q14 list paints the ${scheme} scheme background`, list.scheme.includes(scheme) && list.background === expectedBackground, JSON.stringify({ scheme: list.scheme, background: list.background, expected: expectedBackground }));
		check("Q14 list controls have 44px hit areas", list.filters.every((entry) => entry.height >= 44) && list.newLink.height >= 44 && list.rows.every((row) => row.height >= 44), JSON.stringify({ filters: list.filters.map((entry) => entry.height), newLink: list.newLink.height, rows: list.rows.map((row) => row.height) }));
		const listShot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q14_list_screenshot");
		const listFile = evidence("Q14-list.png", Buffer.from(listShot));
		act("screenshot", listFile, "page.screenshot resolved");
		check("Q14 list screenshot saved", fs.existsSync(listFile) && fs.statSync(listFile).size > 0, listFile);

		// ---- search ----
		await withDeadline(page.fill("#issue-search", "결제"), DEADLINE_MS, "q14_fill_search");
		await withDeadline(page.click(".search .ctl"), DEADLINE_MS, "q14_submit_search");
		act("search", "결제", "click on the search button");
		await waitRender(page, "list", Number(list.render) + 1, "q14_search_rendered");
		const searched = await evalIn(page, LIST_SNAPSHOT, "q14_search_snapshot");
		states.list.searched = searched;
		check("Q14 search narrows the list to the matching issue and keeps the query in the URL", searched.rows.length === 1 && searched.rows[0].id === ISSUE_A && searched.location.includes("q=%EA%B2%B0%EC%A0%9C"), JSON.stringify({ rows: searched.rows.map((row) => row.id), location: searched.location }));
		check("Q14 the title renders the description's markup as inert text", searched.rows[0].title.includes("<script>") && searched.rows[0].title.includes("onerror="), searched.rows[0].title);

		// ---- detail ----
		await withDeadline(page.click(`#issue-rows .row[data-id="${ISSUE_A}"]`), DEADLINE_MS, "q14_open_detail");
		act("open", `/issues/${ISSUE_A}`, "click on the row");
		await waitRender(page, "detail", 1, "q14_detail_rendered");
		await pinQaPage(page, { width, height, scheme });
		await evalIn(page, waitForDom("() => [...document.querySelectorAll('.ev-image')].length === 2 && [...document.querySelectorAll('.ev-image')].every((img) => img.complete && img.naturalWidth > 0) ? true : null", "q14_images_loaded"), "q14_images_loaded");
		const detail = await evalIn(page, DETAIL_SNAPSHOT, "q14_detail_snapshot");
		states.detail.initial = detail;
		check("Q14 detail shows needs-check at sequence 2", detail.state === "needs-check" && detail.seq === "2" && detail.chip === "확인 요청", JSON.stringify({ state: detail.state, seq: detail.seq, chip: detail.chip }));
		check("Q14 description renders as text and injects no active HTML", detail.description === DESCRIPTION_A && detail.injected === 0, JSON.stringify({ injected: detail.injected, description: detail.description }));
		const original = detail.evidence.find((entry) => entry.provenance === "display_capture");
		const reproduction = detail.evidence.find((entry) => entry.provenance === "reproduction");
		check("Q14 the original capture is labelled as a display capture with its image", original && original.label === "화면 캡처" && original.note === null && original.image && original.image.complete && original.image.naturalWidth === 1, JSON.stringify(original));
		check("Q14 the reproduction is labelled as a reproduction, never as the original", reproduction && reproduction.label === "재현 화면" && reproduction.note === "원본 화면 아님" && !reproduction.label.includes("원본") && !reproduction.label.includes("캡처"), JSON.stringify(reproduction));
		check("Q14 the correction check reads 확인됨 without an install claim", detail.facts.appliedBuild?.value === "확인됨" && !/설치|배포/.test(detail.pageText) && detail.history[1]?.check?.status === "matched" && detail.history[1]?.check?.text.startsWith("확인됨"), JSON.stringify({ applied: detail.facts.appliedBuild, check: detail.history[1]?.check }));
		check("Q14 provenance rows are separate and labelled", ["observed", "observedBuild", "accepted", "acceptedBuild", "source", "correction", "appliedBuild", "confirmed", "pageBuild"].every((key) => key in detail.facts) && detail.facts.source.href === `/p/${encodeURIComponent(ctx.fixtures.decision.id)}` && detail.facts.source.note === "기록 비교 일치" && detail.facts.confirmed.value === "없음", JSON.stringify(detail.facts));
		check("Q14 the maintainer event is read-only in the history", detail.history.length === 2 && detail.history[0].type === "created" && detail.history[1].type === "request_check" && detail.history[1].readOnly === true && detail.history[1].text === "제보 화면을 고쳤습니다. 확인해 주세요.", JSON.stringify(detail.history));
		check("Q14 owner actions follow needs-check", detail.buttons["issue-confirm"]?.disabled === false && detail.buttons["issue-reopen"]?.disabled === false && detail.buttons["issue-purge"]?.disabled === false, JSON.stringify(detail.buttons));
		check("Q14 detail buttons have 44px hit areas", ["issue-confirm", "issue-reopen", "issue-purge", "issue-comment-send"].every((id) => detail.buttons[id]?.height >= 44), JSON.stringify(Object.fromEntries(Object.entries(detail.buttons).map(([id, entry]) => [id, entry?.height]))));

		// ---- comment, confirm, reopen ----
		await withDeadline(page.fill("#issue-comment", "아직 그대로입니다. 버튼이 안 보여요."), DEADLINE_MS, "q14_fill_comment");
		await withDeadline(page.click("#issue-comment-send"), DEADLINE_MS, "q14_send_comment");
		act("comment", "아직 그대로입니다. 버튼이 안 보여요.", "click on #issue-comment-send");
		const afterComment = await waitDetail(page, "needs-check", 3, "q14_comment_applied");
		check("Q14 comment advances the sequence to 3 and keeps the state", afterComment.seq === "3" && afterComment.status.startsWith("의견을 보냈습니다"), JSON.stringify(afterComment));
		await withDeadline(page.click("#issue-confirm"), DEADLINE_MS, "q14_click_confirm");
		act("confirm", "#issue-confirm", "click");
		const afterConfirm = await waitDetail(page, "resolved", 4, "q14_confirm_applied");
		const resolvedView = await evalIn(page, DETAIL_SNAPSHOT, "q14_resolved_snapshot");
		states.detail.resolved = resolvedView;
		check("Q14 confirm moves needs-check to resolved at sequence 4", afterConfirm.state === "resolved" && afterConfirm.seq === "4" && resolvedView.buttons["issue-confirm"].disabled === true && resolvedView.buttons["issue-reopen"].disabled === false, JSON.stringify({ afterConfirm, confirm: resolvedView.buttons["issue-confirm"], reopen: resolvedView.buttons["issue-reopen"] }));
		await withDeadline(page.click("#issue-reopen"), DEADLINE_MS, "q14_click_reopen");
		act("reopen", "#issue-reopen", "click");
		const afterReopen = await waitDetail(page, "open", 5, "q14_reopen_applied");
		const reopened = await evalIn(page, DETAIL_SNAPSHOT, "q14_reopened_snapshot");
		states.detail.reopened = reopened;
		check("Q14 reopen moves resolved to open at sequence 5", afterReopen.state === "open" && afterReopen.seq === "5" && reopened.chip === "접수", JSON.stringify(afterReopen));
		check("Q14 history keeps every step in order", reopened.history.map((entry) => `${entry.seq}:${entry.type}`).join() === "1:created,2:request_check,3:comment,4:confirm,5:reopen" && reopened.history[2].text === "아직 그대로입니다. 버튼이 안 보여요.", JSON.stringify(reopened.history.map((entry) => [entry.seq, entry.type, entry.chip])));
		check("Q14 the confirmation row keeps the confirmation and notes the reopen", reopened.facts.confirmed.value !== "없음" && reopened.facts.confirmed.note === "이후 다시 열림" && reopened.buttons["issue-confirm"].disabled === true && reopened.buttons["issue-reopen"].disabled === true, JSON.stringify(reopened.facts.confirmed));
		const detailShot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q14_detail_screenshot");
		const detailFile = evidence("Q14-detail.png", Buffer.from(detailShot));
		act("screenshot", detailFile, "page.screenshot resolved");
		check("Q14 detail screenshot saved", fs.existsSync(detailFile) && fs.statSync(detailFile).size > 0, detailFile);

		const verifyA = await request("verify-a", `/api/issues/${ISSUE_A}`);
		states.http.a = { state: verifyA.body?.state, currentSeq: verifyA.body?.currentSeq, events: verifyA.body?.events?.map((event) => [event.seq, event.type, event.actor, event.state]) };
		check("Q14 GET detail preserves the sequence and the history", verifyA.body?.currentSeq === 5 && verifyA.body?.state === "open" && verifyA.body?.events?.map((event) => event.type).join() === "created,request_check,comment,confirm,reopen", JSON.stringify(states.http.a));

		// ---- list reflects the state ----
		await withDeadline(page.goto(`${ctx.base}/issues`, { waitUntil: "load" }), DEADLINE_MS, "q14_goto_list_again");
		await waitRender(page, "list", 1, "q14_list_after_loop");
		const listAfter = await evalIn(page, LIST_SNAPSHOT, "q14_list_after_snapshot");
		states.list.afterLoop = listAfter;
		check("Q14 the list reflects the reopened state and the badge drops to one", listAfter.rows.find((row) => row.id === ISSUE_A)?.chip === "접수" && listAfter.badge.text === "1" && listAfter.filters.find((entry) => entry.text === "접수")?.count === "2", JSON.stringify({ a: listAfter.rows.find((row) => row.id === ISSUE_A), badge: listAfter.badge }));

		// ---- failure track: missing source and unknown build ----
		await withDeadline(page.goto(`${ctx.base}/issues/${ISSUE_B}`, { waitUntil: "load" }), DEADLINE_MS, "q14_goto_b");
		await waitRender(page, "detail", 1, "q14_detail_b_rendered");
		const detailB = await evalIn(page, DETAIL_SNAPSHOT, "q14_detail_b_snapshot");
		states.failures.missingSource = { source: detailB.facts.source, applied: detailB.facts.appliedBuild, check: detailB.history[1]?.check };
		check("Q14 a missing source is shown as missing, not as matched", detailB.facts.source?.note === "기록 비교 없음" && detailB.facts.source?.href === "/p/q14-missing-proposal", JSON.stringify(detailB.facts.source));
		check("Q14 an unknown build reads 미확인", detailB.facts.appliedBuild?.value === "미확인" && detailB.history[1]?.check?.status === "unversioned" && detailB.history[1]?.check?.text.startsWith("미확인"), JSON.stringify({ applied: detailB.facts.appliedBuild, check: detailB.history[1]?.check }));

		// ---- failure track: stale command ----
		const externalComment = { v: 1, storeId, requestId: EXTERNAL_COMMENT, expectedSeq: 2, command: { type: "comment", text: "외부에서 먼저 남긴 의견" } };
		const external = await post("external-comment-b", `/api/issues/${ISSUE_B}/feedback`, externalComment);
		check("Q14 an external comment advances B to sequence 3 behind the page's back", external.status === 200 && external.body?.currentSeq === 3, `${external.status} ${JSON.stringify(external.body?.currentSeq)}`);
		await withDeadline(page.fill("#issue-comment", "stale: 늦게 보낸 의견"), DEADLINE_MS, "q14_fill_stale");
		await withDeadline(page.click("#issue-comment-send"), DEADLINE_MS, "q14_send_stale");
		act("stale-comment", "expectedSeq 2 against currentSeq 3", "click on #issue-comment-send");
		const afterStale = await waitDetail(page, "needs-check", 3, "q14_stale_refreshed");
		const staleView = await evalIn(page, DETAIL_SNAPSHOT, "q14_stale_snapshot");
		const staleText = await evalIn(page, "document.getElementById('issue-comment')?.value ?? null", "q14_stale_text");
		states.failures.stale = { status: afterStale.status, seq: afterStale.seq, history: staleView.history.map((entry) => [entry.seq, entry.type, entry.text]), textKept: staleText };
		check("Q14 a stale command shows the 409 with the current sequence and refreshes the page", afterStale.status.includes("다른 변경이 먼저 반영되었습니다") && afterStale.status.includes("현재 순번 3") && afterStale.seq === "3", JSON.stringify(afterStale));
		check("Q14 the stale comment is not applied and its text is kept", staleView.history.length === 3 && staleView.history[2].text === "외부에서 먼저 남긴 의견" && !staleView.history.some((entry) => (entry.text ?? "").includes("stale")) && staleText === "stale: 늦게 보낸 의견", JSON.stringify(states.failures.stale));

		// ---- failure track: a malformed success is uncertain; the text stays and the same request is replayed ----
		await evalIn(page, `(() => {
			const realFetch = window.fetch.bind(window);
			window.__q14RealFetch = realFetch;
			window.fetch = (input, init) => {
				const url = typeof input === 'string' ? input : input.url;
				if (init && init.method === 'POST' && url.endsWith('/feedback')) return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
				return realFetch(input, init);
			};
			return true;
		})()`, "q14_install_malformed");
		await withDeadline(page.fill("#issue-comment", UNCERTAIN_TEXT), DEADLINE_MS, "q14_fill_uncertain");
		await withDeadline(page.click("#issue-comment-send"), DEADLINE_MS, "q14_send_uncertain");
		act("malformed-comment", "feedback POST answered 200 {} (no receipt)", "click on #issue-comment-send");
		const pendingView = await evalIn(page, waitForDom(PENDING_SHOWN, "q14_pending_shown"), "q14_pending_shown");
		const serverPending = await request("detail-b-pending", `/api/issues/${ISSUE_B}`);
		states.failures.malformed = { ...pendingView, serverSeq: serverPending.body?.currentSeq };
		await evalIn(page, "(() => { document.getElementById('issue-pending')?.scrollIntoView({ block: 'end' }); return true; })()", "q14_scroll_pending");
		evidence("Q14-pending.png", Buffer.from(await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q14_pending_screenshot")));
		act("screenshot", "Q14-pending.png", "page.screenshot resolved");
		check("Q14 a malformed success is uncertain: text kept, same-request retry offered, nothing claimed", pendingView.text === UNCERTAIN_TEXT && pendingView.retry === "다시 보내기" && pendingView.status.includes("접수 확인 중") && !pendingView.status.includes("보냈습니다") && pendingView.seq === "3" && pendingView.history === 3 && pendingView.disabled.every(Boolean) && serverPending.body?.currentSeq === 3, JSON.stringify(states.failures.malformed));
		await evalIn(page, "(() => { window.fetch = window.__q14RealFetch; return true; })()", "q14_restore_fetch_malformed");
		await withDeadline(page.click("#issue-retry"), DEADLINE_MS, "q14_click_retry");
		act("retry-same-request", `replay of ${pendingView.pending}`, "click on #issue-retry");
		const retried = await waitDetail(page, "needs-check", 4, "q14_retry_applied");
		const retriedView = await evalIn(page, DETAIL_SNAPSHOT, "q14_retry_snapshot");
		const retriedText = await evalIn(page, "document.getElementById('issue-comment')?.value ?? null", "q14_retry_text");
		const retriedPending = await evalIn(page, "({ pending: document.getElementById('issues-app')?.dataset.pending ?? null, boxHidden: document.getElementById('issue-pending')?.hidden ?? null })", "q14_retry_pending");
		const serverRetried = await request("detail-b-retried", `/api/issues/${ISSUE_B}`);
		const committed = serverRetried.body?.events?.find((entry) => entry.seq === 4);
		states.failures.malformedRetry = { status: retried.status, text: retriedText, pendingAfter: retriedPending, committed: committed ? { requestId: committed.requestId, type: committed.type, text: committed.command?.text } : null, sentRequestId: pendingView.pending };
		check("Q14 the retry replays the same requestId once and only then clears the text", retried.status.startsWith("의견을 보냈습니다") && retriedText === "" && retriedPending.pending === null && retriedPending.boxHidden === true && committed?.requestId === pendingView.pending && committed?.command?.text === UNCERTAIN_TEXT && retriedView.history.length === 4 && retriedView.history[3].text === UNCERTAIN_TEXT, JSON.stringify(states.failures.malformedRetry));

		// ---- failure track: a stale reopen keeps its explanation for the fresh sequence ----
		const externalComment2 = { v: 1, storeId, requestId: EXTERNAL_COMMENT_2, expectedSeq: 4, command: { type: "comment", text: "다시 열기 전에 끼어든 의견" } };
		const external2 = await post("external-comment-b-2", `/api/issues/${ISSUE_B}/feedback`, externalComment2);
		check("Q14 a second external comment advances B to sequence 5 behind the page's back", external2.status === 200 && external2.body?.currentSeq === 5, `${external2.status} ${JSON.stringify(external2.body?.currentSeq)}`);
		await withDeadline(page.fill("#issue-comment", REOPEN_TEXT), DEADLINE_MS, "q14_fill_reopen");
		await withDeadline(page.click("#issue-reopen"), DEADLINE_MS, "q14_click_stale_reopen");
		act("stale-reopen", "expectedSeq 4 against currentSeq 5 with an explanation typed", "click on #issue-reopen");
		const staleReopen = await waitDetail(page, "needs-check", 5, "q14_stale_reopen_refreshed");
		const staleReopenView = await evalIn(page, DETAIL_SNAPSHOT, "q14_stale_reopen_snapshot");
		const staleReopenText = await evalIn(page, "document.getElementById('issue-comment')?.value ?? null", "q14_stale_reopen_text");
		states.failures.staleReopen = { status: staleReopen.status, seq: staleReopen.seq, text: staleReopenText, history: staleReopenView.history.map((entry) => [entry.seq, entry.type]), reopen: staleReopenView.buttons["issue-reopen"] };
		check("Q14 a stale reopen shows the 409 with the current sequence, refreshes and keeps the explanation", staleReopen.status.includes("다른 변경이 먼저 반영되었습니다") && staleReopen.status.includes("현재 순번 5") && staleReopenText === REOPEN_TEXT && staleReopenView.history.length === 5 && !staleReopenView.history.some((entry) => entry.type === "reopen") && staleReopenView.buttons["issue-reopen"].disabled === false, JSON.stringify(states.failures.staleReopen));
		await withDeadline(page.click("#issue-reopen"), DEADLINE_MS, "q14_click_reopen_again");
		act("reopen-again", "fresh expectedSeq 5 with the kept explanation", "click on #issue-reopen");
		const reopenedB = await waitDetail(page, "open", 6, "q14_reopen_b_applied");
		const reopenedBView = await evalIn(page, DETAIL_SNAPSHOT, "q14_reopen_b_snapshot");
		const reopenedBText = await evalIn(page, "document.getElementById('issue-comment')?.value ?? null", "q14_reopen_b_text");
		states.failures.reopenAgain = { status: reopenedB.status, text: reopenedBText, last: reopenedBView.history[5] };
		check("Q14 the kept explanation goes out with the fresh sequence and is cleared only then", reopenedB.state === "open" && reopenedBView.history[5]?.type === "reopen" && reopenedBView.history[5]?.text === REOPEN_TEXT && reopenedBText === "", JSON.stringify(states.failures.reopenAgain));

		// ---- append image: a comment in between and the refresh it causes must not lose the selected image ----
		const pngFile = path.join(ctx.runTmp, "q14-append.png");
		fs.writeFileSync(pngFile, framePng(64, 32));
		await chooseFile(page, withDeadline, "#issue-append-file", pngFile, "q14_choose_image");
		act("choose-image", "64x32 PNG through DOM.setFileInputFiles", "file input change");
		const ready = await evalIn(page, waitForDom(IMAGE_READY, "q14_image_ready"), "q14_image_ready");
		check("Q14 a chosen image is previewed and the photo send is live", ready.status.includes("64×32") && ready.ready === true && ready.canvas === true, JSON.stringify(ready));
		await withDeadline(page.fill("#issue-comment", IMAGE_COMMENT), DEADLINE_MS, "q14_fill_comment_with_image");
		await withDeadline(page.click("#issue-comment-send"), DEADLINE_MS, "q14_send_comment_with_image");
		act("comment-with-image", IMAGE_COMMENT, "click on #issue-comment-send while an image is selected");
		const afterImageComment = await waitDetail(page, "open", 7, "q14_comment_with_image_applied");
		const keptImage = await evalIn(page, IMAGE_STATE, "q14_image_kept");
		states.failures.imageKept = { ...keptImage, status: afterImageComment.status };
		await evalIn(page, "(() => { document.getElementById('issue-status')?.scrollIntoView({ block: 'end' }); return true; })()", "q14_scroll_image");
		evidence("Q14-image-kept.png", Buffer.from(await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q14_image_kept_screenshot")));
		act("screenshot", "Q14-image-kept.png", "page.screenshot resolved");
		check("Q14 sending a comment keeps the selected image and its send button live after the refresh", afterImageComment.status.startsWith("의견을 보냈습니다") && keptImage.canvas === true && keptImage.ready === true && keptImage.text === "", JSON.stringify(states.failures.imageKept));
		await withDeadline(page.click("#issue-append-send"), DEADLINE_MS, "q14_send_image");
		act("send-image", "#issue-append-send after the refresh", "click");
		const afterAppend = await waitDetail(page, "open", 8, "q14_append_applied");
		const appendView = await evalIn(page, DETAIL_SNAPSHOT, "q14_append_snapshot");
		const appendState = await evalIn(page, IMAGE_STATE, "q14_append_editor_state");
		const serverAppend = await request("detail-b-appended", `/api/issues/${ISSUE_B}`);
		const appended = serverAppend.body?.evidence?.find((manifest) => manifest.seq === 8);
		states.failures.appended = { status: afterAppend.status, editor: appendState, evidence: appendView.evidence.map((entry) => [entry.provenance, entry.label]), server: appended ? { kind: appended.visual?.kind, provenance: appended.visual?.provenance, width: appended.visual?.width, height: appended.visual?.height } : null };
		check("Q14 the image lands as appended owner evidence and the editor is cleared only after that receipt", afterAppend.status.startsWith("사진을 보냈습니다") && appended?.visual?.kind === "raster" && appended?.visual?.provenance === "user_upload" && appended?.visual?.width === 64 && appended?.visual?.height === 32 && appendState.canvas === false && appendState.ready === false && appendView.evidence.length === 2 && appendView.evidence[1].label === "올린 사진" && appendView.history[7]?.type === "append_evidence", JSON.stringify(states.failures.appended));
		await chooseFile(page, withDeadline, "#issue-append-file", pngFile, "q14_choose_image_again");
		const readyAgain = await evalIn(page, waitForDom(IMAGE_READY, "q14_image_ready_again"), "q14_image_ready_again");
		check("Q14 reselecting after the refresh re-arms the live photo send", readyAgain.ready === true && readyAgain.canvas === true, JSON.stringify(readyAgain));

		// ---- failure track: empty search and a 500 list ----
		await withDeadline(page.goto(`${ctx.base}/issues?q=${encodeURIComponent("zzz없는검색어")}`, { waitUntil: "load" }), DEADLINE_MS, "q14_goto_empty_search");
		await waitRender(page, "list", 1, "q14_empty_rendered");
		const emptyView = await evalIn(page, LIST_SNAPSHOT, "q14_empty_snapshot");
		states.failures.emptySearch = { rows: emptyView.rows.length, empty: emptyView.empty, search: emptyView.search, count: emptyView.count };
		check("Q14 an empty search shows the empty text and no rows", emptyView.rows.length === 0 && emptyView.empty.hidden === false && emptyView.empty.text === "검색 결과가 없습니다" && emptyView.search === "zzz없는검색어" && emptyView.count === "0", JSON.stringify(states.failures.emptySearch));
		await evalIn(page, `(() => {
			const realFetch = window.fetch.bind(window);
			window.__q14RealFetch = realFetch;
			window.fetch = (input, init) => {
				const url = typeof input === 'string' ? input : input.url;
				if (url.startsWith('/api/issues?')) return Promise.resolve(new Response(JSON.stringify({ error: 'corrupt_record' }), { status: 500, headers: { 'content-type': 'application/json' } }));
				return realFetch(input, init);
			};
			return true;
		})()`, "q14_install_500");
		await withDeadline(page.click(".seg label:nth-child(2)"), DEADLINE_MS, "q14_click_open_filter");
		act("list-500", "state filter 접수 with the list route answering 500", "click on the filter");
		await waitRender(page, "list", Number(emptyView.render) + 1, "q14_500_rendered");
		const failed = await evalIn(page, LIST_SNAPSHOT, "q14_500_snapshot");
		states.failures.list500 = { error: failed.error, rows: failed.rows.length, notice: failed.notice, empty: failed.empty, count: failed.count };
		check("Q14 a 500 list response shows the error, clears the rows and offers a retry", failed.error === "500" && failed.rows.length === 0 && failed.notice.hidden === false && failed.notice.text.includes("목록을 불러오지 못했습니다") && failed.notice.text.includes("기록이 손상되었습니다") && failed.notice.text.includes("다시 시도") && failed.count === "0", JSON.stringify(states.failures.list500));
		await evalIn(page, "(() => { window.fetch = window.__q14RealFetch; return true; })()", "q14_restore_fetch");
		await withDeadline(page.click("#issues-app .notice button"), DEADLINE_MS, "q14_click_retry");
		act("list-retry", "다시 시도 after restoring fetch", "click on the retry button");
		await waitRender(page, "list", Number(failed.render) + 1, "q14_retry_rendered");
		const recovered = await evalIn(page, LIST_SNAPSHOT, "q14_retry_snapshot");
		states.failures.listRetry = { error: recovered.error, rows: recovered.rows.map((row) => [row.id, row.chip]), notice: recovered.notice.hidden };
		// The search query and the 접수 filter are still active, so the honest result is the empty text again.
		check("Q14 the retry clears the error and shows the empty search result again", recovered.error === null && recovered.notice.hidden === true && recovered.rows.length === 0 && recovered.empty.hidden === false && recovered.empty.text === "검색 결과가 없습니다", JSON.stringify(states.failures.listRetry));

		// ---- failure track: confirmed purge ----
		await withDeadline(page.goto(`${ctx.base}/issues/${ISSUE_B}`, { waitUntil: "load" }), DEADLINE_MS, "q14_goto_b_purge");
		await waitRender(page, "detail", 1, "q14_detail_b_purge_rendered");
		const imageBefore = await request("image-b-before", `/api/issues/${ISSUE_B}/evidence/${CAPTURE_B}/image`);
		check("Q14 B's image is served before the purge", imageBefore.status === 200 && imageBefore.headers["content-type"] === "image/png", String(imageBefore.status));
		await withDeadline(page.click("#issue-purge"), DEADLINE_MS, "q14_click_purge");
		act("purge", "#issue-purge", "click");
		const purgeBox = await evalIn(page, waitForDom("() => { const box = document.getElementById('issue-purge-box'); return box && !box.hidden ? { text: box.textContent } : null; }", "q14_purge_box"), "q14_purge_box");
		check("Q14 purge asks for a second confirmation naming the issue", purgeBox.text.includes(DESCRIPTION_B) && purgeBox.text.includes("되돌릴 수 없습니다"), purgeBox.text);
		await withDeadline(page.click("#issue-purge-confirm"), DEADLINE_MS, "q14_click_purge_confirm");
		act("purge-confirm", "#issue-purge-confirm", "click");
		const gone = await evalIn(page, waitForDom("() => document.getElementById('issues-app')?.dataset.state === 'tombstone' ? true : null", "q14_tombstone"), "q14_tombstone");
		const goneView = await evalIn(page, DETAIL_SNAPSHOT, "q14_gone_snapshot");
		states.failures.purge = { gone: goneView.gone, chip: goneView.chip, status: goneView.status, hasDescription: goneView.pageText.includes(DESCRIPTION_B) };
		check("Q14 a confirmed purge shows the deleted state without the description", gone === true && goneView.chip === "삭제됨" && goneView.gone?.includes("삭제된 제보입니다") && goneView.description === null && goneView.pageText.includes(DESCRIPTION_B) === false, JSON.stringify(states.failures.purge));
		const detailAfter = await request("detail-b-after", `/api/issues/${ISSUE_B}`);
		const imageAfter = await request("image-b-after", `/api/issues/${ISSUE_B}/evidence/${CAPTURE_B}/image`);
		const replayCreate = await post("replay-create-b", "/api/issues", createB);
		const replayCommand = await post("replay-comment-b", `/api/issues/${ISSUE_B}/feedback`, externalComment);
		const listAfterPurge = await request("list-after-purge", "/api/issues?limit=50");
		states.http.purge = { detail: detailAfter.status, image: { status: imageAfter.status, bytes: imageAfter.bytes, type: imageAfter.headers["content-type"] }, replayCreate: replayCreate.status, replayCommand: replayCommand.status, listIds: listAfterPurge.body?.items?.map((item) => item.id), counts: listAfterPurge.body?.counts };
		check("Q14 the purged issue answers 410 and serves no image bytes", detailAfter.status === 410 && imageAfter.status === 410 && !imageAfter.headers["content-type"]?.startsWith("image/"), JSON.stringify(states.http.purge));
		check("Q14 an old create or command retry cannot resurrect the purged issue", replayCreate.status === 410 && replayCommand.status === 410 && !listAfterPurge.body?.items?.some((item) => item.id === ISSUE_B), JSON.stringify({ replayCreate: replayCreate.status, replayCommand: replayCommand.status, ids: states.http.purge.listIds }));

		// ---- standalone composer: /issues/new is the shared reporter without a source ----
		await withDeadline(page.goto(`${ctx.base}/issues/new`, { waitUntil: "load" }), DEADLINE_MS, "q14_goto_new");
		act("goto", "/issues/new", "load event");
		await waitRender(page, "new", 1, "q14_new_rendered");
		await evalIn(page, waitForDom("() => document.getElementById('issue-report')?.open ? true : null", "q14_new_dialog_open"), "q14_new_dialog_open");
		const newView = await evalIn(page, NEW_SNAPSHOT, "q14_new_snapshot");
		states.standalone.opened = newView;
		check("Q14 /issues/new opens the shared composer as a modal text-only report", newView.open === true && newView.modal === true && newView.photoHidden === true && newView.accepted === null && newView.sendHidden === false && newView.title.includes("문제 제보"), JSON.stringify(newView));
		await withDeadline(page.fill("#issue-description", STANDALONE_TEXT), DEADLINE_MS, "q14_fill_standalone");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q14_send_standalone");
		act("standalone-send", STANDALONE_TEXT, "click on #issue-send");
		const acceptedId = await evalIn(page, waitForDom("() => document.getElementById('issues-app')?.dataset.accepted || null", "q14_standalone_accepted"), "q14_standalone_accepted");
		const sentView = await evalIn(page, NEW_SNAPSHOT, "q14_standalone_sent_snapshot");
		const createdRecord = await request("detail-standalone", `/api/issues/${acceptedId}`);
		states.standalone.sent = { id: acceptedId, view: sentView, record: { status: createdRecord.status, description: createdRecord.body?.issue?.description, source: createdRecord.body?.issue?.source, contextStatus: createdRecord.body?.evidence?.[0]?.context?.contextStatus, visual: createdRecord.body?.evidence?.[0]?.visual?.kind } };
		check("Q14 the standalone report is accepted on a verified receipt and reads back text-only without a source", sentView.status === "접수했습니다" && sentView.receiptHidden === false && sentView.link === `/issues/${acceptedId}` && createdRecord.status === 200 && createdRecord.body?.issue?.description === STANDALONE_TEXT && createdRecord.body?.issue?.source === null && createdRecord.body?.evidence?.[0]?.context?.contextStatus === "unavailable" && createdRecord.body?.evidence?.[0]?.visual?.kind === "none", JSON.stringify(states.standalone.sent));
		const newShot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q14_new_screenshot");
		evidence("Q14-new.png", Buffer.from(newShot));
		act("screenshot", "Q14-new.png", "page.screenshot resolved");

		// ---- a 200 that carries only ok:true and an id is not an acceptance ----
		await withDeadline(page.goto(`${ctx.base}/issues/new`, { waitUntil: "load" }), DEADLINE_MS, "q14_goto_new_again");
		await waitRender(page, "new", 1, "q14_new_rendered_again");
		await evalIn(page, waitForDom("() => document.getElementById('issue-report')?.open ? true : null", "q14_new_dialog_open_again"), "q14_new_dialog_open_again");
		await evalIn(page, `(() => {
			const realFetch = window.fetch.bind(window);
			window.__q14RealFetch = realFetch;
			window.fetch = (input, init) => {
				const url = typeof input === 'string' ? input : input.url;
				if (init && init.method === 'POST' && url === '/api/issues') return Promise.resolve(new Response(JSON.stringify({ ok: true, id: ${JSON.stringify(FAKE_ID)} }), { status: 200, headers: { 'content-type': 'application/json' } }));
				return realFetch(input, init);
			};
			return true;
		})()`, "q14_install_fake_receipt");
		await withDeadline(page.fill("#issue-description", FAKE_TEXT), DEADLINE_MS, "q14_fill_fake");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q14_send_fake");
		act("fake-receipt", `create POST answered 200 {ok:true,id:${FAKE_ID}}`, "click on #issue-send");
		const fakeView = await evalIn(page, waitForDom(`() => {
			const retry = document.getElementById('issue-retry');
			const status = document.getElementById('issue-status')?.textContent ?? '';
			if (!retry || retry.hidden || !status.includes('접수 확인 중')) return null;
			return ${NEW_SNAPSHOT};
		}`, "q14_fake_uncertain"), "q14_fake_uncertain");
		const fakeLookup = await request("detail-fake", `/api/issues/${FAKE_ID}`);
		states.standalone.fake = { view: fakeView, serverStatus: fakeLookup.status };
		check("Q14 a 200 with only ok:true and an id is uncertain, never accepted, and the text is kept", fakeView.accepted === null && fakeView.receiptHidden === true && fakeView.text === FAKE_TEXT && fakeView.status.includes("접수 확인 중") && fakeView.retry?.text === "다시 보내기" && fakeLookup.status === 404, JSON.stringify(states.standalone.fake));
		await evalIn(page, "(() => { window.fetch = window.__q14RealFetch; return true; })()", "q14_restore_fetch_fake");
		await withDeadline(page.click("#issue-retry"), DEADLINE_MS, "q14_click_fake_retry");
		act("retry-standalone", "다시 보내기 with the original requestId after restoring fetch", "click on #issue-retry");
		const retriedId = await evalIn(page, waitForDom("() => document.getElementById('issues-app')?.dataset.accepted || null", "q14_fake_retry_accepted"), "q14_fake_retry_accepted");
		const retriedRecord = await request("detail-retried-standalone", `/api/issues/${retriedId}`);
		states.standalone.retried = { id: retriedId, status: retriedRecord.status, description: retriedRecord.body?.issue?.description };
		check("Q14 the retry resolves the uncertain report under its own requestId, not the fake id", retriedId !== FAKE_ID && retriedRecord.status === 200 && retriedRecord.body?.issue?.description === FAKE_TEXT, JSON.stringify(states.standalone.retried));

		// ---- 390px dark: the same screens on a phone ----
		narrow = await withDeadline(newQaPage(browser, { width: 390, height: 844, scheme }), DEADLINE_MS, "q14_narrow_page");
		await withDeadline(narrow.goto(`${ctx.base}/issues`, { waitUntil: "load" }), DEADLINE_MS, "q14_narrow_list");
		await waitRender(narrow, "list", 1, "q14_narrow_list_rendered");
		const narrowList = await evalIn(narrow, LIST_SNAPSHOT, "q14_narrow_list_snapshot");
		const narrowOverflow = await evalIn(narrow, "({ scrollWidth: document.documentElement.scrollWidth, innerWidth })", "q14_narrow_overflow");
		states.list.narrow = { rows: narrowList.rows.length, overflow: narrowOverflow };
		// A, C and the two standalone reports remain; the purged B is gone.
		check("Q14 the phone list has no horizontal overflow", narrowOverflow.scrollWidth <= narrowOverflow.innerWidth && narrowList.rows.length === 4 && !narrowList.rows.some((row) => row.id === ISSUE_B), JSON.stringify(states.list.narrow));
		const narrowListShot = await withDeadline(narrow.screenshot({ type: "png" }), DEADLINE_MS, "q14_narrow_list_screenshot");
		evidence("Q14-list-390.png", Buffer.from(narrowListShot));
		await withDeadline(narrow.goto(`${ctx.base}/issues/${ISSUE_A}`, { waitUntil: "load" }), DEADLINE_MS, "q14_narrow_detail");
		await waitRender(narrow, "detail", 1, "q14_narrow_detail_rendered");
		const narrowDetailOverflow = await evalIn(narrow, "({ scrollWidth: document.documentElement.scrollWidth, innerWidth })", "q14_narrow_detail_overflow");
		states.detail.narrow = narrowDetailOverflow;
		check("Q14 the phone detail has no horizontal overflow", narrowDetailOverflow.scrollWidth <= narrowDetailOverflow.innerWidth, JSON.stringify(narrowDetailOverflow));
		const narrowDetailShot = await withDeadline(narrow.screenshot({ type: "png" }), DEADLINE_MS, "q14_narrow_detail_screenshot");
		evidence("Q14-detail-390.png", Buffer.from(narrowDetailShot));
		await withDeadline(narrow.goto(`${ctx.base}/issues/new`, { waitUntil: "load" }), DEADLINE_MS, "q14_narrow_new");
		await waitRender(narrow, "new", 1, "q14_narrow_new_rendered");
		await evalIn(narrow, waitForDom("() => document.getElementById('issue-report')?.open ? true : null", "q14_narrow_new_open"), "q14_narrow_new_open");
		const narrowNew = await evalIn(narrow, NEW_SNAPSHOT, "q14_narrow_new_snapshot");
		states.standalone.narrow = narrowNew;
		check("Q14 the phone composer opens without horizontal overflow", narrowNew.open === true && narrowNew.overflow.scrollWidth <= narrowNew.overflow.innerWidth, JSON.stringify(narrowNew.overflow));
		const narrowNewShot = await withDeadline(narrow.screenshot({ type: "png" }), DEADLINE_MS, "q14_narrow_new_screenshot");
		evidence("Q14-new-390.png", Buffer.from(narrowNewShot));
		act("screenshot", "Q14-list-390.png, Q14-detail-390.png, Q14-new-390.png", "page.screenshot resolved");
	} finally {
		evidence("Q14-states.json", JSON.stringify(states, null, "\t"));
		evidence("Q14-actions.json", JSON.stringify(actions, null, "\t"));
		if (narrow) await withDeadline(narrow.close(), DEADLINE_MS, "q14_narrow_close").catch(() => narrow.dispose?.());
		await withDeadline(page.close(), DEADLINE_MS, "q14_page_close").catch(() => page.dispose?.());
	}
}
