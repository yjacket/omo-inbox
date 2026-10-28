/* 제보함 (web/reports.html): the report list at /issues and the text-only composer at /issues/new.
 *
 * List: GET /api/reports?limit=50, newest first. A row shows the title (linked to the GitHub issue once it is sent),
 * the relative time, the state as text (`GitHub로 보내는 중`; `보내지 못했습니다 · <detail>` with `다시 시도`; `#<n> 열림` /
 * `#<n> 닫힘` with `댓글 <c>`), the stored picture as a 64 px thumbnail, and for a sent row `처리 맡기기` (`다시 맡기기` once
 * it was handed off, with `맡김 · <when>`). The list polls every 5 s while a row is pending, and while the server's
 * GitHub states are cold (`statesAt` null or older than 60 s, a sent row on screen) it fetches again after 3 s, up to
 * 5 times per page load, so `#<n> 열림/닫힘` fills in after a server restart. It pages with `더 보기`.
 *
 * Composer: `문제 제보`, one description and `보내기`. The create body is the Contracts shape with page kind "issues", no
 * element, no source, no picture and a fresh uuid v4 per report; a retry replays the same body (same reportId) until
 * the text changes or the server answers 409. The status then follows the record: `보내는 중` -> `GitHub로 보내는 중` ->
 * `GitHub #<n>에 올렸습니다` with `열기` and `처리 맡기기`, or `보내지 못했습니다 · <detail>` with `다시 시도`.
 *
 * Text is only ever set with textContent; nothing here loads a cross-origin URL (the page's CSP allows img-src 'self'). */

const LIMIT = 50;
const REFRESH_MS = 5000;
const STATES_STALE_MS = 60000;
const STATES_WARM_MS = 3000;
const STATES_WARM_MAX = 5;
const POLL_FAST_MS = 1000;
const POLL_FAST_COUNT = 30;
const POLL_SLOW_MS = 5000;
const DESCRIPTION_MAX_BYTES = 8192;
const POST_HEADERS = Object.freeze({ "content-type": "application/json", "x-inbox": "1" });

const TEXT = Object.freeze({
	empty: "아직 제보가 없습니다",
	loadFailed: "목록을 불러오지 못했습니다.",
	retry: "다시 시도",
	retryFailed: "다시 시도하지 못했습니다.",
	more: "더 보기",
	pending: "GitHub로 보내는 중",
	failed: "보내지 못했습니다",
	open: "열림",
	closed: "닫힘",
	comments: "댓글",
	handoff: "처리 맡기기",
	handoffAgain: "다시 맡기기",
	handedOff: "맡김",
	handoffWorking: "새 세션을 여는 중입니다.",
	handoffDone: "새 세션에 맡겼습니다.",
	handoffError: Object.freeze({
		cwd_missing: "이 저장소의 폴더를 찾지 못했습니다.",
		no_launcher: "터미널을 찾지 못했습니다.",
		launch_failed: "세션을 열지 못했습니다.",
		not_sent: "아직 GitHub에 올라가지 않았습니다.",
	}),
	compose: "문제 제보",
	description: "설명",
	placeholder: "무엇이 이상한지 적어 주세요",
	send: "보내기",
	sending: "보내는 중",
	serverFailed: "서버에 보내지 못했습니다",
	badInput: "내용을 확인해 주세요",
	forbidden: "이 기기에서는 보낼 수 없습니다",
	tooLong: "설명은 8192바이트까지",
	openIssue: "열기",
	list: "제보함",
});

const app = document.getElementById("app");
const mode = location.pathname.replace(/\/+$/, "") === "/issues/new" ? "new" : "list";

// The old reporter's drafts database is replaced by the inspector reporter's own storage; drop it.
try {
	indexedDB.deleteDatabase("inbox-issues-v1");
} catch {}

/* ---------- shared ---------- */

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function ctlButton(text) {
	const button = el("button", "ctl", text);
	button.type = "button";
	return button;
}

/** Relative time as the Inbox list prints it. */
function relativeTime(iso, nowMs) {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const minutes = Math.floor(Math.max(0, nowMs - at) / 60000);
	if (minutes < 1) return "방금";
	if (minutes < 60) return `${minutes}분 전`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}시간 전`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}일 전`;
	const date = new Date(at);
	return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function reportPath(id, suffix) {
	return `/api/reports/${encodeURIComponent(id)}${suffix || ""}`;
}

function post(path) {
	return fetch(path, { method: "POST", headers: POST_HEADERS, body: "{}" });
}

async function readJson(res) {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

function sentText(github) {
	let text = `#${github.number}`;
	if (github.state === "open") text += ` ${TEXT.open}`;
	else if (github.state === "closed") text += ` ${TEXT.closed}`;
	if (typeof github.comments === "number" && github.comments > 0) text += ` · ${TEXT.comments} ${github.comments}`;
	return text;
}

function failedText(detail) {
	return typeof detail === "string" && detail !== "" ? `${TEXT.failed} · ${detail}` : TEXT.failed;
}

function stateText(row) {
	if (row.state === "sent") return row.github ? sentText(row.github) : "";
	if (row.state === "failed") return failedText(row.detail);
	return TEXT.pending;
}

/** POST /api/reports/<id>/handoff -> { ok: true, via } or { ok: false, code, text } with the fixed Korean texts. */
async function requestHandoff(id) {
	let res;
	try {
		res = await post(reportPath(id, "/handoff"));
	} catch {
		return { ok: false, code: null, text: TEXT.handoffError.launch_failed };
	}
	const json = await readJson(res);
	if (res.ok) return { ok: true, via: json && typeof json.via === "string" ? json.via : null };
	const code = json && typeof json.error === "string" ? json.error : null;
	const known = code !== null && Object.hasOwn(TEXT.handoffError, code);
	return { ok: false, code, text: known ? TEXT.handoffError[code] : TEXT.handoffError.launch_failed };
}

/* ---------- list (/issues) ---------- */

function startList() {
	const state = { rows: [], nextCursor: null, statesAt: null, warmups: 0, loaded: false, seq: 0, timer: null, notes: new Map() };

	const notice = el("div", "notice");
	notice.id = "notice";
	notice.setAttribute("role", "status");
	notice.hidden = true;
	const noticeRetry = el("button", null, TEXT.retry);
	noticeRetry.type = "button";
	notice.append(el("span", null, TEXT.loadFailed), noticeRetry);
	const list = el("ol", "rows");
	list.id = "list";
	list.hidden = true;
	const empty = el("p", "empty", TEXT.empty);
	empty.id = "empty";
	empty.hidden = true;
	const more = ctlButton(TEXT.more);
	more.id = "more";
	more.classList.add("more");
	more.hidden = true;
	app.replaceChildren(notice, list, empty, more);

	function setNote(id, text, error) {
		if (text === null) state.notes.delete(id);
		else state.notes.set(id, { text, error: Boolean(error) });
		const note = list.querySelector(`.row[data-id="${CSS.escape(id)}"] .note`);
		if (!note) return;
		note.textContent = text === null ? "" : text;
		note.classList.toggle("error", Boolean(error));
	}

	function renderRow(row, nowMs) {
		const item = el("li", "row");
		item.dataset.id = row.id;
		item.dataset.state = row.state;

		const main = el("div", "main");
		const title = el("p", "title");
		if (row.state === "sent" && row.github && typeof row.github.url === "string") {
			const link = el("a", null, row.title);
			link.href = row.github.url;
			link.target = "_blank";
			link.rel = "noopener";
			title.append(link);
		} else {
			title.textContent = row.title;
		}
		main.append(title, el("p", "state", stateText(row)));
		if (row.handoff && typeof row.handoff.at === "string") {
			main.append(el("p", "handed", `${TEXT.handedOff} · ${relativeTime(row.handoff.at, nowMs)}`));
		}
		const actions = el("div", "row-actions");
		if (row.state === "failed") {
			const button = ctlButton(TEXT.retry);
			button.dataset.action = "retry";
			button.addEventListener("click", () => retry(row.id, button));
			actions.append(button);
		}
		if (row.state === "sent") {
			const button = ctlButton(row.handoff ? TEXT.handoffAgain : TEXT.handoff);
			button.dataset.action = "handoff";
			button.addEventListener("click", () => handoff(row.id, button));
			actions.append(button);
		}
		if (actions.childElementCount > 0) main.append(actions);
		const note = el("p", "note");
		note.setAttribute("role", "status");
		const saved = state.notes.get(row.id);
		if (saved) {
			note.textContent = saved.text;
			note.classList.toggle("error", saved.error);
		}
		main.append(note);

		const side = el("div", "side");
		const when = el("time", "when", relativeTime(row.createdAt, nowMs));
		when.dateTime = row.createdAt;
		side.append(when);
		if (row.image) {
			const img = el("img", "thumb");
			img.src = reportPath(row.id, "/image");
			img.alt = "";
			img.height = 64;
			img.decoding = "async";
			side.append(img);
		}

		item.append(main, side);
		return item;
	}

	function render() {
		const nowMs = Date.now();
		list.replaceChildren(...state.rows.map((row) => renderRow(row, nowMs)));
		list.hidden = state.rows.length === 0;
		empty.hidden = state.rows.length !== 0;
		more.hidden = state.nextCursor === null;
		more.disabled = false;
		app.setAttribute("aria-busy", "false");
	}

	async function fetchPage(cursor) {
		const query = cursor === null ? `?limit=${LIMIT}` : `?limit=${LIMIT}&cursor=${encodeURIComponent(cursor)}`;
		const res = await fetch(`/api/reports${query}`, { headers: { accept: "application/json" }, cache: "no-store" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		return {
			items: Array.isArray(data.items) ? data.items : [],
			nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
			statesAt: typeof data.statesAt === "string" ? data.statesAt : null,
		};
	}

	/** Reload from the top, covering at least the rows already on screen so `더 보기` pages survive a refresh. */
	async function load() {
		const seq = ++state.seq;
		const shown = state.rows.length;
		try {
			let page = await fetchPage(null);
			const items = page.items.slice();
			const statesAt = page.statesAt;
			let cursor = page.nextCursor;
			while (items.length < shown && cursor !== null) {
				page = await fetchPage(cursor);
				items.push(...page.items);
				cursor = page.nextCursor;
			}
			if (seq !== state.seq) return;
			state.rows = items;
			state.nextCursor = cursor;
			state.statesAt = statesAt;
			state.loaded = true;
			notice.hidden = true;
			render();
		} catch (error) {
			if (seq !== state.seq) return;
			app.setAttribute("aria-busy", "false");
			notice.hidden = false;
			console.error("reports: load failed", error);
		}
		schedule();
	}

	async function loadMore() {
		if (state.nextCursor === null) return;
		const seq = ++state.seq;
		more.disabled = true;
		try {
			const page = await fetchPage(state.nextCursor);
			if (seq !== state.seq) return;
			state.rows = state.rows.concat(page.items);
			state.nextCursor = page.nextCursor;
			state.statesAt = page.statesAt;
			notice.hidden = true;
			render();
		} catch (error) {
			if (seq !== state.seq) return;
			more.disabled = false;
			notice.hidden = false;
			console.error("reports: load more failed", error);
		}
		schedule();
	}

	/** The server's GitHub states are cold when it has never refreshed them or did so over a minute ago. */
	function statesCold() {
		if (state.statesAt === null) return true;
		const at = Date.parse(state.statesAt);
		return !Number.isFinite(at) || Date.now() - at > STATES_STALE_MS;
	}

	/** Poll every 5 s while a row is still on its way to GitHub, and 3 s after a cold-state answer (5 times at most),
	 * both only while the tab is visible. */
	function schedule() {
		if (state.timer !== null) {
			clearTimeout(state.timer);
			state.timer = null;
		}
		if (document.visibilityState !== "visible") return;
		let delay = state.rows.some((row) => row.state === "pending") ? REFRESH_MS : null;
		if (statesCold() && state.warmups < STATES_WARM_MAX && state.rows.some((row) => row.state === "sent")) {
			state.warmups += 1;
			delay = delay === null ? STATES_WARM_MS : Math.min(delay, STATES_WARM_MS);
		}
		if (delay === null) return;
		state.timer = setTimeout(load, delay);
	}

	async function retry(id, button) {
		button.disabled = true;
		setNote(id, null);
		let res = null;
		try {
			res = await post(reportPath(id, "/retry"));
		} catch {
			res = null;
		}
		// 200: queued again; 409 not_failed or 404: the row moved on without us. Either way the list is the truth.
		if (res !== null && res.status < 500) {
			await load();
			return;
		}
		setNote(id, TEXT.retryFailed, true);
		button.disabled = false;
	}

	async function handoff(id, button) {
		button.disabled = true;
		setNote(id, TEXT.handoffWorking);
		const result = await requestHandoff(id);
		if (result.ok) {
			setNote(id, TEXT.handoffDone);
			await load();
			return;
		}
		setNote(id, result.text, true);
		if (result.code === "not_sent") {
			await load();
			return;
		}
		button.disabled = false;
	}

	noticeRetry.addEventListener("click", () => load());
	more.addEventListener("click", () => loadMore());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") load();
		else schedule();
	});
	load();
}

/* ---------- composer (/issues/new) ---------- */

function media(win, query) {
	if (typeof win.matchMedia !== "function") return false;
	const result = win.matchMedia(query);
	return Boolean(result && result.matches);
}

/** The Contracts `view`: layout and visual viewports, scroll, dpr, scheme and pointer of this window. */
function describeView(win) {
	const layout = { w: Number(win.innerWidth) || 0, h: Number(win.innerHeight) || 0 };
	const viewport = win.visualViewport;
	const visual = {
		x: viewport ? Number(viewport.offsetLeft) || 0 : 0,
		y: viewport ? Number(viewport.offsetTop) || 0 : 0,
		w: viewport ? Number(viewport.width) || 0 : layout.w,
		h: viewport ? Number(viewport.height) || 0 : layout.h,
		scale: viewport ? Number(viewport.scale) || 1 : 1,
	};
	return {
		layout,
		visual,
		scroll: { x: Number(win.scrollX) || 0, y: Number(win.scrollY) || 0 },
		dpr: Number(win.devicePixelRatio) || 1,
		colorScheme: media(win, "(prefers-color-scheme: dark)") ? "dark" : "light",
		pointer: media(win, "(pointer: coarse)") ? "coarse" : "fine",
	};
}

function createBody(reportId, description) {
	return {
		v: 2,
		reportId,
		description,
		page: { kind: "issues", route: "/issues/new", url: "/issues/new", title: document.title, frames: [] },
		element: null,
		view: describeView(window),
		source: null,
		image: null,
	};
}

function startComposer() {
	const section = el("section", "compose");
	const label = el("label", "label", TEXT.description);
	label.htmlFor = "description";
	const textarea = el("textarea");
	textarea.id = "description";
	textarea.placeholder = TEXT.placeholder;
	textarea.rows = 5;
	textarea.autofocus = true;
	const status = el("p", "status");
	status.id = "status";
	status.setAttribute("role", "status");
	const note = el("p", "status note");
	note.id = "note";
	note.setAttribute("role", "status");
	const actions = el("div", "actions");
	const sendButton = el("button", "btn", TEXT.send);
	sendButton.type = "button";
	sendButton.id = "send";
	sendButton.disabled = true;
	actions.append(sendButton);
	section.append(el("h2", null, TEXT.compose), label, textarea, status, note, actions);
	app.replaceChildren(section);
	app.setAttribute("aria-busy", "false");
	textarea.focus();

	let reportId = crypto.randomUUID();
	let lastBody = null;
	let keyRetried = false;
	let accepted = null;
	let busy = false;
	let polls = 0;
	let pollTimer = null;

	function setStatus(text, error) {
		status.textContent = text;
		status.classList.toggle("error", Boolean(error));
	}

	function setNote(text, error) {
		note.textContent = text;
		note.classList.toggle("error", Boolean(error));
	}

	function syncSend() {
		sendButton.disabled = busy || accepted !== null || textarea.value.trim() === "";
	}

	function clearControls(className) {
		for (const node of actions.querySelectorAll(`.${className}`)) node.remove();
	}

	function failed(text, retryable) {
		busy = false;
		textarea.readOnly = false;
		setStatus(text, true);
		if (retryable) {
			sendButton.hidden = true;
			const button = ctlButton(TEXT.retry);
			button.classList.add("resend");
			button.dataset.action = "retry";
			button.addEventListener("click", () => submit());
			actions.append(button);
		}
		syncSend();
	}

	async function submit() {
		const description = textarea.value;
		if (busy || accepted !== null || description.trim() === "") return;
		if (new TextEncoder().encode(description).length > DESCRIPTION_MAX_BYTES) {
			setStatus(TEXT.tooLong, true);
			return;
		}
		if (lastBody !== null && lastBody.description !== description) {
			reportId = crypto.randomUUID();
			lastBody = null;
			keyRetried = false;
		}
		const body = lastBody === null ? createBody(reportId, description) : lastBody;
		lastBody = body;
		busy = true;
		textarea.readOnly = true;
		clearControls("resend");
		sendButton.hidden = false;
		syncSend();
		setStatus(TEXT.sending);
		let res;
		try {
			res = await fetch("/api/reports", { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
		} catch {
			failed(TEXT.serverFailed, true);
			return;
		}
		if (res.status === 201 || res.status === 200) {
			onAccepted();
			return;
		}
		if (res.status === 409 && !keyRetried) {
			// key_reused: the same id was stored with other content; take a fresh id and send once more
			keyRetried = true;
			reportId = crypto.randomUUID();
			lastBody = { ...body, reportId };
			busy = false;
			await submit();
			return;
		}
		if (res.status === 400 || res.status === 413) {
			failed(TEXT.badInput, false);
			return;
		}
		if (res.status === 403) {
			failed(TEXT.forbidden, false);
			return;
		}
		failed(TEXT.serverFailed, true);
	}

	function onAccepted() {
		accepted = reportId;
		busy = false;
		textarea.readOnly = true;
		sendButton.hidden = true;
		syncSend();
		setStatus(TEXT.pending);
		const listLink = el("a", "ctl", TEXT.list);
		listLink.id = "list-link";
		listLink.href = "/issues";
		actions.append(listLink);
		polls = 0;
		poll();
	}

	/** Follow the record: every second for 30 s, then every 5 s while the page is open. */
	async function poll() {
		pollTimer = null;
		let row = null;
		try {
			const res = await fetch(reportPath(accepted), { headers: { accept: "application/json" }, cache: "no-store" });
			if (res.ok) row = await res.json();
		} catch {
			row = null;
		}
		if (row !== null && row.state !== "pending") {
			showResult(row);
			return;
		}
		if (row !== null) setStatus(TEXT.pending);
		polls += 1;
		pollTimer = setTimeout(poll, polls < POLL_FAST_COUNT ? POLL_FAST_MS : POLL_SLOW_MS);
	}

	function showResult(row) {
		clearControls("result");
		setNote("");
		if (row.state === "sent" && row.github) {
			setStatus(`GitHub #${row.github.number}에 올렸습니다`);
			const open = el("a", "ctl result", TEXT.openIssue);
			open.href = row.github.url;
			open.target = "_blank";
			open.rel = "noopener";
			const hand = ctlButton(row.handoff ? TEXT.handoffAgain : TEXT.handoff);
			hand.classList.add("result");
			hand.dataset.action = "handoff";
			hand.addEventListener("click", async () => {
				hand.disabled = true;
				setNote(TEXT.handoffWorking);
				const result = await requestHandoff(row.id);
				if (result.ok) {
					setNote(TEXT.handoffDone);
					hand.textContent = TEXT.handoffAgain;
				} else {
					setNote(result.text, true);
				}
				hand.disabled = false;
			});
			actions.append(open, hand);
			return;
		}
		if (row.state === "failed") {
			setStatus(failedText(row.detail), true);
			const button = ctlButton(TEXT.retry);
			button.classList.add("result");
			button.dataset.action = "retry";
			button.addEventListener("click", async () => {
				button.disabled = true;
				let res = null;
				try {
					res = await post(reportPath(row.id, "/retry"));
				} catch {
					res = null;
				}
				if (res !== null && res.status < 500) {
					clearControls("result");
					setStatus(TEXT.pending);
					polls = 0;
					if (pollTimer !== null) clearTimeout(pollTimer);
					poll();
					return;
				}
				setNote(TEXT.retryFailed, true);
				button.disabled = false;
			});
			actions.append(button);
		}
	}

	textarea.addEventListener("input", () => {
		if (actions.querySelector(".resend") !== null) {
			clearControls("resend");
			sendButton.hidden = false;
		}
		syncSend();
	});
	sendButton.addEventListener("click", () => submit());
}

if (mode === "new") startComposer();
else {
	startList();
	import("/web/report.js").then(({ mountReporter }) => mountReporter({ page: { kind: "issues", route: "/issues" }, sourceOf: () => null }));
}
