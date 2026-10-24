/* Thread page (C11): one session as a chat, driven by GET /api/threads/<sid>?since= every 3 s while
 * visible and the C12 feedback routes for answers. Every piece of session text becomes a text node
 * through h(); nothing is ever parsed as HTML. Buttons lock before the first await, so a double tap
 * sends once; a send that fails keeps its reason in the bubble until the next attempt.
 */
(() => {
	"use strict";

	const POLL_MS = 3000;
	const NEAR_BOTTOM_PX = 160;
	const POST_HEADERS = { "content-type": "application/json", "x-inbox": "1" };
	const KIND_LABEL = { question: "질문", permission: "권한 요청", turn: "보고", blocked: "막힘", done: "끝남", progress: "진행", notice: "알림", board: "Review" };
	const PERMISSION = [
		{ choice: "Allow once", label: "이번만 허용", style: "" },
		{ choice: "Deny", label: "거부", style: "ghost" },
		{ choice: "Deny with feedback", label: "거부하고 이유 쓰기", style: "ghost" },
	];
	const CLOSE_LINE = { "answered-terminal": "터미널에서 답함", superseded: "다음 작업으로 넘어감", "timed-out": "시간 초과", cancelled: "취소됨", expired: "만료됨", "session-closed": "세션 닫힘", "closed-by-owner": "닫음", "handed-off": "새 세션으로 넘어감" };
	const DELIVERED_LINE = { bridge: "전달됨 ✓", message: "전달됨 ✓", "late-message": "늦게 전달됨", dropped: "터미널 답이 먼저 들어가 이 답은 쓰이지 않음", refused: "전달되지 않음" };
	const BRIDGE_HINT = { none: "터미널에서 답해 주세요", "terminal-only": "리로드 후에는 터미널에서 답해 주세요" };
	// Why the session waits (item.state.reasons[0]) as the newest progress line says it; the same map as src/summary.mjs.
	const WAIT_LABEL = { "terminal-background-sessions": "백그라운드 작업", "terminal-monitors": "모니터", "senpi-codemode": "분리 실행 작업", "senpi-task": "하위 작업", "omo-dag": "작업 흐름", "omo-inbox": "Review 답", "omo-desk": "Review 답", "ask-user": "질문 답", scheduled: "목표 이어가기", "reload-grace": "다시 불러온 뒤 확인", dialog: "권한 답" };
	const PROGRESS_KEY = "inbox.progressLines";
	const LOADING_TEXT = "불러오는 중";
	const LOAD_FAILED_TEXT = "불러오지 못했습니다";
	const REC_MARKERS = ["권장", "추천", "(Recommended)", "recommended"];
	const QUICK_KINDS = new Set(["turn", "blocked", "done"]);
	// Next actions (README "Next actions"): a final is a needs-you turn/done/blocked item; its next verdict's reason shows as
	// 다음 · <reason> for these states (an ask final gets no line), and for done/plan/ship the actions take the chips' place.
	const FINAL_KINDS = new Set(["turn", "done", "blocked"]);
	const NEXT_LINE_STATES = new Set(["done", "plan", "ship", "blocked", "stalled"]);
	const NEXT_REPLACES_CHIPS = new Set(["done", "plan", "ship"]);
	const NO_RESPONSE_TEXT = "세션이 응답하지 않습니다";
	const STALE_TEXT = "상황이 바뀌었습니다. 다시 확인해 주세요.";
	const ACTION_ERROR = { plan_missing: "계획 파일을 찾지 못했습니다.", cwd_missing: "세션 폴더가 없어 열지 못했습니다.", no_launcher: "터미널을 찾지 못했습니다.", launch_failed: "세션을 열지 못했습니다.", forbidden: "이 기기에서는 열 수 없습니다." };
	const TEXT_ANSWER_KINDS = new Set(["turn", "blocked", "done", "notice"]);
	const SENDING_TEXT = "보내는 중";
	const OFFLINE_TEXT = "세션이 꺼져 있어 다시 열면 전달됩니다";
	const EXPLAINING_TEXT = "더 쉬운 설명을 만드는 중";
	const EMPTY_TEXT = "아직 온 것이 없습니다";
	const NOTHING_STAGED_TEXT = "고른 것이나 쓴 글이 없습니다";
	const FAILED_TEXT = "보내지 못했습니다";
	const SAY_MAX = 160;

	// same as web/board.js
	function spoken(...pieces) {
		return pieces
			.filter(Boolean)
			.map((piece) => String(piece).trim())
			.filter(Boolean)
			.map((piece) => (/[.!?。]$/.test(piece) ? piece : `${piece}.`))
			.join(" ");
	}

	// same as web/board.js
	function sayChunks(text) {
		const out = [];
		for (const sentence of String(text).replace(/\s+/g, " ").trim().split(/(?<=[.!?。])\s+/)) {
			let rest = sentence;
			while (rest.length > SAY_MAX) {
				const cut = rest.lastIndexOf(" ", SAY_MAX);
				const at = cut > SAY_MAX / 4 ? cut : SAY_MAX;
				out.push(rest.slice(0, at));
				rest = rest.slice(at).trim();
			}
			if (rest) out.push(rest);
		}
		return out;
	}

	// same as web/board.js
	function koreanVoice() {
		const voices = window.speechSynthesis.getVoices().filter((v) => /^ko\b/i.test(String(v.lang).replace("_", "-")));
		return voices.find((v) => v.default) || voices.find((v) => v.localService) || voices[0] || null;
	}

	function speakItem(item, group) {
		const itemId = idOf(item);
		const parts = [];
		const headline = group.querySelector(".headline");
		const context = group.querySelector(".context");
		const body = group.querySelector(".body");
		const ask = group.querySelector(".ask");
		if (headline) parts.push(headline.textContent);
		if (context) parts.push(`하던 일. ${context.textContent.replace(/^하던 일\s*·\s*/, "")}`);
		if (body) parts.push(body.textContent);
		if (ask) parts.push(ask.textContent);
		// The choices exactly as the bubble shows them: each question's text and options, reply options, permission buttons.
		const optionLine = (option, index) => {
			const label = (option.querySelector(".label") || option).textContent;
			const why = option.querySelector(".why");
			return `${index + 1}번. ${label}${option.classList.contains("rec") ? ", 추천" : ""}. ${why ? why.textContent : ""}`;
		};
		for (const block of group.querySelectorAll(".question")) {
			const qtext = block.querySelector(".qtext");
			const header = qtext && qtext.querySelector("b");
			if (qtext) parts.push(header ? `${header.textContent}. ${qtext.textContent.slice(header.textContent.length)}` : qtext.textContent);
			[...block.querySelectorAll(".opt")].forEach((option, index) => parts.push(optionLine(option, index)));
		}
		[...group.querySelectorAll(".opts .opt")].filter((option) => !option.closest(".question")).forEach((option, index) => parts.push(optionLine(option, index)));
		const perms = [...group.querySelectorAll('[data-action="perm"]')].map((button) => button.textContent);
		if (perms.length) parts.push(`선택지. ${perms.join(", ")}`);
		const queue = sayChunks(spoken(...parts));
		const voice = koreanVoice();
		queue.forEach((text, index) => {
			const utterance = new SpeechSynthesisUtterance(text);
			utterance.lang = "ko-KR";
			if (voice) utterance.voice = voice;
			utterance.onend = () => {
				if (index === queue.length - 1 && ui.listening === itemId) {
					ui.listening = null;
					refreshItem(itemId);
				}
			};
			utterance.onerror = (error) => {
				if (ui.listening === itemId && error.error !== "interrupted" && error.error !== "canceled") {
					ui.listening = null;
					refreshItem(itemId);
				}
			};
			window.speechSynthesis.speak(utterance);
		});
	}

	const sid = decodeURIComponent(location.pathname.split("/")[2] || "");
	const apiThread = `/api/threads/${encodeURIComponent(sid)}`;
	const els = {
		title: document.getElementById("title"),
		chips: document.getElementById("chips"),
		notice: document.getElementById("notice"),
		noticeText: document.getElementById("noticeText"),
		retry: document.getElementById("retry"),
		chat: document.getElementById("chat"),
		composer: document.getElementById("composer"),
		quick: document.getElementById("quick"),
		nextActions: document.getElementById("nextActions"),
		compose: document.getElementById("compose"),
		reply: document.getElementById("reply"),
		send: document.getElementById("send"),
		composeStatus: document.getElementById("composeStatus"),
		progressToggle: document.getElementById("progressToggle"),
	};

	const state = {
		thread: null,
		items: [],
		lastSeq: 0,
		maxNonReadSeq: 0,
		readSeq: 0,
		deliveredHow: new Map(),
		loaded: false,
		gone: false,
		requestSeq: 0,
		timer: null,
		newestProgress: null,
	};
	// Per-item view state that must survive a rebuild of the item's nodes.
	const ui = {
		nodes: new Map(),
		rawOpen: new Set(),
		staged: new Map(),
		busy: new Set(),
		error: new Map(),
		explain: new Map(),
		feedbackOpen: new Set(),
		// itemId -> { status: loading | ok | error, data }: an episode's 원문 is fetched once when it is opened, never per poll.
		episodes: new Map(),
		// itemIds of the progress lines whose owner request bubble is opened past its 6 lines.
		requestOpen: new Set(),
		termOpen: null,
		listening: null,
		hit: null,
		composerBusy: false,
		// One next action in flight locks every next button; nextSig is the rendered bar; handoff is the trailing system line.
		nextBusy: false,
		nextSig: null,
		handoff: null,
		// Issue reporting: the per-message entry names its item; renders and read marks wait until it closes.
		reportPick: null,
		reporting: false,
		pendingData: null,
	};
	let diagnostics = null;
	let reportUi = null;
	let reportRegistry = null;
	let reportEmbedded = false;
	let reportRegistered = false;
	let reportHandle = null;
	let reportOptions = null;
	let reportSetupObserver = null;

	function recordAction(name) {
		if (diagnostics) diagnostics.recordAction(name);
	}

	function reportVisible() {
		return Array.from(els.chat.querySelectorAll('.group[data-item]')).filter((group) => {
			const box = group.getBoundingClientRect();
			return box.width > 0 && box.bottom > 0 && box.top < innerHeight;
		});
	}

	function reportItem(itemId) {
		return state.items.find((item) => idOf(item) === itemId) || null;
	}

	function reportLabel(item) {
		return clip(headlineOf(item), 80) || idOf(item);
	}

	function reportDescriptor(item) {
		const group = els.chat.querySelector(`.group[data-item="${CSS.escape(idOf(item))}"]`);
		if (!group) return null;
		const box = group.getBoundingClientRect();
		return {
			kind: "record",
			key: `thread:${sid}:${idOf(item)}`,
			label: reportLabel(item),
			rect: { x: box.left, y: box.top, w: box.width, h: box.height },
			framePath: [],
		};
	}

	// The child reports through the parent's registry when it is embedded; origin and contentWindow
	// identity are checked there. Anything else falls back to the entry's plain /issues/new link.
	function reportContext() {
		const picked = ui.reportPick ? reportItem(ui.reportPick) : null;
		const target = picked ? reportDescriptor(picked) : null;
		const visible = reportVisible().slice(0, 50).map((group) => group.getAttribute("data-item"));
		const built = metaBuild();
		return {
			page: "thread",
			source: { kind: "thread", threadId: sid, itemId: picked ? idOf(picked) : null, observedSeq: state.lastSeq },
			target,
			view: {
				width: innerWidth,
				height: innerHeight,
				dpr: devicePixelRatio,
				scale: 1,
				scrollX,
				scrollY,
				theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
				locale: navigator.language || "ko-KR",
				embedded: reportEmbedded,
				viewerOpen: false,
			},
			excerpt: picked ? reportLabel(picked) : null,
			excerptEnabled: Boolean(picked),
			visibleIds: visible,
			diagnostics: diagnostics ? diagnostics.snapshot() : [],
			clientBuild: built,
		};
	}

	function metaBuild() {
		const stamp = document.querySelector('meta[name="inbox-build"]');
		const digest = stamp && typeof stamp.content === "string" ? stamp.content.trim() : "";
		return /^[0-9a-f]{64}$/.test(digest) ? { kind: "page_response_manifest", version: null, digest } : null;
	}

	function reportTargets() {
		const out = [{ kind: "page", key: `thread:${sid}`, label: "대화", rect: { x: 0, y: 0, w: innerWidth, h: innerHeight }, framePath: [] }];
		for (const group of reportVisible()) {
			const item = reportItem(group.getAttribute("data-item"));
			const target = item ? reportDescriptor(item) : null;
			if (target) out.push(target);
		}
		return out;
	}

	function deferReportRender() {
		ui.reporting = true;
	}

	function resumeReportRender() {
		ui.reporting = false;
		const pending = ui.pendingData;
		ui.pendingData = null;
		if (pending) applyData(pending);
		else void load();
	}

	// ---------- helpers ----------

	// Every piece of session text goes through here as a text node; nothing is parsed as HTML.
	function h(tag, attrs, ...children) {
		const el = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs || {})) {
			if (value == null || value === false) continue;
			el.setAttribute(key, value === true ? "" : value);
		}
		for (const child of children.flat()) {
			if (child == null || child === false) continue;
			el.append(child instanceof Node ? child : String(child));
		}
		return el;
	}

	// 원문 보기 Markdown: only this code creates elements, through h(); HTML in the text stays literal text.
	function inlineMd(text) {
		const out = [];
		const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|(?<![\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g;
		let last = 0;
		for (const m of text.matchAll(re)) {
			if (m.index > last) out.push(text.slice(last, m.index));
			if (m[1]) out.push(h("code", null, m[2]));
			else if (m[3] !== undefined) out.push(h("strong", null, ...inlineMd(m[3])));
			else if (m[4] !== undefined) out.push(h("a", { href: m[5], target: "_blank", rel: "noopener noreferrer" }, m[4]));
			else out.push(h("em", null, m[6]));
			last = m.index + m[0].length;
		}
		if (last < text.length) out.push(text.slice(last));
		return out;
	}

	const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
	const MD_BLOCK_START = /^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/;
	const mdCells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

	function markdown(source) {
		const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
		const blocks = [];
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			if (!line.trim()) {
				i += 1;
				continue;
			}
			const fence = line.match(/^\s*(```|~~~)/);
			if (fence) {
				const body = [];
				i += 1;
				while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
				i += 1;
				blocks.push(h("pre", null, h("code", null, body.join("\n"))));
				continue;
			}
			const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
			if (heading) {
				blocks.push(h("p", { class: `md-h md-h${Math.min(heading[1].length, 3)}` }, ...inlineMd(heading[2])));
				i += 1;
				continue;
			}
			if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
				blocks.push(h("hr"));
				i += 1;
				continue;
			}
			if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1] || "")) {
				const head = mdCells(line);
				const rows = [];
				i += 2;
				while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(mdCells(lines[i++]));
				blocks.push(h("div", { class: "md-table" }, h("table", null,
					h("thead", null, h("tr", null, head.map((cell) => h("th", null, ...inlineMd(cell))))),
					h("tbody", null, rows.map((row) => h("tr", null, row.map((cell) => h("td", null, ...inlineMd(cell)))))),
				)));
				continue;
			}
			if (/^\s*>/.test(line)) {
				const body = [];
				while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
				blocks.push(h("blockquote", null, ...markdown(body.join("\n"))));
				continue;
			}
			const first = line.match(MD_LIST);
			if (first) {
				const ordered = /\d/.test(first[2]);
				const items = [];
				while (i < lines.length && MD_LIST.test(lines[i])) {
					const m = lines[i++].match(MD_LIST);
					items.push(h("li", m[1].length >= 2 ? { class: "md-sub" } : null, ...inlineMd(m[3])));
				}
				blocks.push(h(ordered ? "ol" : "ul", ordered ? { start: parseInt(first[2], 10) } : null, items));
				continue;
			}
			const para = [line];
			i += 1;
			while (i < lines.length && lines[i].trim() && !MD_BLOCK_START.test(lines[i])) para.push(lines[i++]);
			blocks.push(h("p", null, ...inlineMd(para.join("\n"))));
		}
		return blocks;
	}

	function postJson(path, body) {
		return fetch(path, { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
	}

	async function readJson(res) {
		try {
			return await res.json();
		} catch {
			return null;
		}
	}

	function monthDay(date) {
		return `${date.getMonth() + 1}월 ${date.getDate()}일`;
	}

	function relativeTime(iso) {
		const at = Date.parse(iso);
		if (Number.isNaN(at)) return "";
		const minutes = Math.floor((Date.now() - at) / 60000);
		if (minutes < 1) return "방금";
		if (minutes < 60) return `${minutes}분 전`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}시간 전`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}일 전`;
		return monthDay(new Date(at));
	}

	function absoluteTime(iso) {
		const at = Date.parse(iso);
		return Number.isNaN(at) ? "" : new Date(at).toLocaleString("ko-KR");
	}

	// HH:MM of a message inside an episode's 원문.
	function clockTime(iso) {
		const at = Date.parse(iso);
		if (Number.isNaN(at)) return "";
		const date = new Date(at);
		return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	}

	// 🔥 Nm: minutes until the prompt cache goes cold (epoch ms from /cache, or an ISO string); empty once it has.
	function fireText(until) {
		const at = typeof until === "number" ? until : /^\d+$/.test(String(until)) ? Number(until) : Date.parse(until);
		const left = at - Date.now();
		if (!(left > 0)) return "";
		return `🔥 ${Math.ceil(left / 60000)}m`;
	}

	function clip(text, n) {
		const value = String(text ?? "");
		return value.length <= n ? value : `${value.slice(0, Math.max(0, n - 1))}…`;
	}

	function idOf(item) {
		return String(item.id ?? item.itemId ?? "");
	}

	function summaryOf(item) {
		const wrap = item.summary;
		return wrap && wrap.summary && typeof wrap.summary === "object" ? wrap.summary : null;
	}

	function questionsOf(item) {
		const list = item.raw && item.raw.request && Array.isArray(item.raw.request.questions) ? item.raw.request.questions : [];
		return list.filter((q) => q && typeof q === "object");
	}

	function optionLabel(option) {
		return typeof option === "string" ? option : option && typeof option === "object" ? String(option.label ?? "") : "";
	}

	function optionsOf(question) {
		return (Array.isArray(question.options) ? question.options : [])
			.map((option) => (typeof option === "string" ? { label: option, description: null } : option))
			.filter((option) => option && typeof option === "object" && optionLabel(option) !== "");
	}

	function dialogChoices(item) {
		const offered = item.raw && item.raw.dialog && Array.isArray(item.raw.dialog.options) ? item.raw.dialog.options.map(optionLabel).filter(Boolean) : [];
		return offered.length ? PERMISSION.filter((entry) => offered.includes(entry.choice)) : PERMISSION;
	}

	// The original text behind the bubble, as 원문 보기 shows it.
	function rawTextOf(item) {
		const raw = item.raw && typeof item.raw === "object" ? item.raw : {};
		const parts = [];
		if (typeof raw.text === "string" && raw.text.trim()) parts.push(raw.text);
		for (const q of questionsOf(item)) {
			const lines = [[q.header, q.question].filter(Boolean).join(": ")];
			for (const option of optionsOf(q)) lines.push(`- ${optionLabel(option)}${option.description ? `: ${option.description}` : ""}`);
			parts.push(lines.filter(Boolean).join("\n"));
		}
		if (raw.dialog && typeof raw.dialog === "object") {
			const options = Array.isArray(raw.dialog.options) ? raw.dialog.options.map((option) => `- ${optionLabel(option)}`) : [];
			parts.push([raw.dialog.title, ...options].filter(Boolean).join("\n"));
		}
		if (raw.goal && typeof raw.goal === "object") {
			parts.push([raw.goal.objective ? `목표: ${raw.goal.objective}` : "", raw.goal.reason ? `이유: ${raw.goal.reason}` : ""].filter(Boolean).join("\n"));
		}
		if (raw.notice && typeof raw.notice === "object") parts.push([raw.notice.title, raw.notice.body].filter(Boolean).join("\n"));
		if (typeof raw.request === "string" && raw.request.trim()) parts.push(`[요청]\n${raw.request}`);
		return parts.filter(Boolean).join("\n\n");
	}

	// The closed episode behind a final: its 원문 is the whole span, served by the episode route.
	function episodeOf(item) {
		const episode = item.meta && item.meta.episode && typeof item.meta.episode === "object" ? item.meta.episode : null;
		return episode && episode.closeReason && episode.key ? episode : null;
	}

	// The wait the newest progress line shows while the thread works: the reason label and the desk boards it waits on.
	function waitOf(item) {
		const thread = state.thread || {};
		if (item.kind !== "progress" || thread.status !== "working" || idOf(item) !== state.newestProgress) return null;
		const wait = item.state && typeof item.state === "object" ? item.state : null;
		if (!wait || wait.state !== "waiting") return null;
		const reasons = Array.isArray(wait.reasons) ? wait.reasons : [];
		const label = reasons.length ? WAIT_LABEL[String(reasons[0]).replace(/^hold:/, "")] || "다음 신호" : "";
		const boards = (Array.isArray(wait.boards) ? wait.boards : [])
			.filter((board) => board && typeof board === "object" && /^https?:\/\//i.test(String(board.url ?? "")))
			.map((board) => ({ title: String(board.title ?? ""), url: String(board.url) }));
		return { label, boards };
	}

	// The item's next verdict (the contract shape) or null.
	function nextOf(item) {
		const next = item && item.next;
		return next && typeof next === "object" && typeof next.state === "string" ? next : null;
	}

	function nextActionsOf(next) {
		return (next && Array.isArray(next.actions) ? next.actions : []).filter((action) => action && typeof action === "object" && typeof action.id === "string" && action.id && action.label);
	}

	function isFinal(item) {
		return item.policy === "needs-you" && FINAL_KINDS.has(item.kind);
	}

	// The actionable closed final (the same rule as src/threads.mjs actionableFinal): the newest final when it closed as
	// session-closed, no newer needs-you item exists and the thread has no handoff. The session quit; its next still offers
	// the plan and continue actions.
	function actionableFinal() {
		const thread = state.thread || {};
		if (thread.handoff) return null;
		let index = -1;
		for (let i = state.items.length - 1; i >= 0; i--) {
			if (isFinal(state.items[i])) {
				index = i;
				break;
			}
		}
		if (index < 0) return null;
		const final = state.items[index];
		if (final.status !== "closed" || final.closedReason !== "session-closed") return null;
		for (let i = index + 1; i < state.items.length; i++) {
			if (state.items[i].policy === "needs-you") return null;
		}
		return final;
	}

	// The item whose next line and actions the page shows: the newest open item when it carries a next, else the
	// actionable closed final when its next still has actions.
	function nextItem() {
		const open = newestOpen();
		if (open) return nextOf(open) ? open : null;
		const final = actionableFinal();
		return final && nextActionsOf(nextOf(final)).length ? final : null;
	}

	function headlineOf(item) {
		const summary = summaryOf(item);
		if (summary && summary.headline) return String(summary.headline);
		const first = rawTextOf(item).split("\n").find((line) => line.trim()) || "";
		return clip(first.trim(), 40) || KIND_LABEL[item.kind] || item.kind;
	}

	function kindLabel(item) {
		const summary = summaryOf(item);
		if (summary && summary.kind === "approval" && (item.kind === "question" || item.kind === "turn")) return "승인 요청";
		return KIND_LABEL[item.kind] || String(item.kind);
	}

	// ★권장: a summary option marked rec whose label is one of the raw options, else the first raw option
	// whose label or description carries a marker (the same rule as src/summary.mjs recommendedOption).
	function recommendedOf(item, question) {
		const options = optionsOf(question);
		const summary = summaryOf(item);
		const fromSummary = (summary && Array.isArray(summary.options) ? summary.options : []).find(
			(option) => option && option.rec && options.some((raw) => optionLabel(raw) === option.label),
		);
		if (fromSummary) return { label: fromSummary.label, why: fromSummary.why || null };
		const hit = options.find((option) => REC_MARKERS.some((marker) => optionLabel(option).includes(marker) || String(option.description ?? "").includes(marker)));
		return hit ? { label: optionLabel(hit), why: null } : null;
	}

	function stagedOf(itemId) {
		let entry = ui.staged.get(itemId);
		if (!entry) {
			entry = { selected: new Map(), text: new Map(), feedback: "" };
			ui.staged.set(itemId, entry);
		}
		return entry;
	}

	function selectedSet(itemId, qid) {
		const entry = stagedOf(itemId);
		let set = entry.selected.get(qid);
		if (!set) {
			set = new Set();
			entry.selected.set(qid, set);
		}
		return set;
	}

	function collectAnswers(item) {
		const entry = stagedOf(idOf(item));
		const answers = {};
		for (const q of questionsOf(item)) {
			const qid = String(q.id ?? "");
			const selected = [...(entry.selected.get(qid) || [])];
			const text = (entry.text.get(qid) || "").trim();
			if (!selected.length && !text) continue;
			answers[qid] = text ? { selected, text } : { selected };
		}
		return Object.keys(answers).length ? { answers } : null;
	}

	function failText(res, body) {
		const error = body && typeof body === "object" ? body.error : null;
		if (res.status === 409 && error === "closed") return `이미 닫혔습니다 · ${CLOSE_LINE[body.reason] || body.reason || "닫힘"}`;
		if (res.status === 409 && error === "not_live") return "세션이 꺼져 있어 지금은 만들 수 없습니다";
		if (error === "question_incomplete") return NOTHING_STAGED_TEXT;
		if (error === "invalid_answer") return `보낼 수 없는 답입니다${Array.isArray(body.details) && body.details.length ? ` · ${body.details[0]}` : ""}`;
		if (res.status === 403) return "이 주소에서는 보낼 수 없습니다";
		return `${FAILED_TEXT} (HTTP ${res.status})`;
	}

	// ---------- header ----------

	function threadTitle() {
		const thread = state.thread || {};
		return thread.title || `세션 ${sid.slice(0, 8)}`;
	}

	function statusChip() {
		const thread = state.thread || {};
		const newest = state.items.length ? state.items[state.items.length - 1] : null;
		const kind = newest ? newest.kind : "";
		let label = thread.status === "working" ? "🤖 진행 중" : thread.status === "ended" ? "✅ 끝남" : "🙋 내 차례";
		if (thread.status === "needs-you" && kind === "blocked") label = "⛔ 막힘";
		if (kind === "notice" && thread.status !== "working") label = "🔔 알림";
		const style = thread.status === "working" ? "chip-working" : thread.status === "ended" ? "chip-ended" : kind === "blocked" ? "chip-blocked" : "chip-needs";
		return h("span", { class: `chip ${style}`, id: "statusChip" }, label);
	}

	function renderHeader() {
		const thread = state.thread || {};
		const title = threadTitle();
		els.title.textContent = title;
		document.title = `${title} · Inbox`;
		const where = [thread.product, thread.branch].filter(Boolean).join(" · ");
		const fire = thread.cacheUntil ? fireText(thread.cacheUntil) : "";
		const chips = [
			where ? h("span", { class: "chip chip-ended where", title: where }, where) : null,
			statusChip(),
			thread.off ? h("span", { class: "chip chip-ended" }, "세션 꺼짐") : null,
			fire ? h("span", { class: "fire", "data-until": thread.cacheUntil }, fire) : null,
		];
		els.chips.replaceChildren(...chips.filter(Boolean));
		const hideToggle = document.getElementById("hideToggle");
		hideToggle.textContent = thread.hidden ? "숨김 해제" : "숨기기";
		hideToggle.setAttribute("aria-pressed", thread.hidden ? "true" : "false");
	}

	// ---------- bubbles ----------

	function kindChip(item) {
		return h("span", { class: "kind", "data-kind": item.kind }, kindLabel(item));
	}

	function optionNode(item, question, option, rec, live, chosen) {
		const qid = String(question.id ?? "");
		const label = optionLabel(option);
		const isRec = rec !== null && rec.label === label;
		const why = isRec && rec.why ? rec.why : option.description || null;
		const star = isRec ? h("span", { class: "star" }, "★권장") : null;
		const text = h("span", { class: "label" }, label);
		const whyNode = why ? h("span", { class: "why" }, why) : null;
		if (question.multiSelect === true) {
			const input = h("input", { type: "checkbox", "data-qid": qid, "data-label": label, "data-key": `check:${qid}:${label}`, disabled: !live || null });
			input.checked = chosen;
			return h("label", { class: `opt check${isRec ? " rec" : ""}` }, input, star, text, whyNode);
		}
		return h(
			"button",
			{ type: "button", class: `opt${isRec ? " rec" : ""}`, "data-action": "pick", "data-qid": qid, "data-label": label, "aria-pressed": chosen ? "true" : "false", disabled: !live || null },
			star,
			text,
			whyNode,
		);
	}

	function questionNode(item, question, live) {
		const itemId = idOf(item);
		const qid = String(question.id ?? "");
		const staged = stagedOf(itemId);
		const answered = new Set();
		for (const answer of item.answers || []) {
			const given = answer.payload && answer.payload.answers ? answer.payload.answers[qid] : null;
			for (const label of given && Array.isArray(given.selected) ? given.selected : []) answered.add(label);
		}
		const chosenSet = live ? staged.selected.get(qid) || new Set() : answered;
		const rec = recommendedOf(item, question);
		const options = optionsOf(question);
		const ordered = rec ? [...options.filter((option) => optionLabel(option) === rec.label), ...options.filter((option) => optionLabel(option) !== rec.label)] : options;
		const header = question.header ? h("b", null, String(question.header)) : null;
		const text = question.question ? String(question.question) : "";
		// A lone question whose headline is the question itself needs no second copy of it.
		const line = [question.header, question.question].filter(Boolean).join(": ");
		const head = headlineOf(item).replace(/…$/, "");
		const showText = (header || text) && (questionsOf(item).length > 1 || !(head && line.startsWith(head)));
		const write = h("textarea", { placeholder: "직접 쓰기", "aria-label": "직접 쓰기", rows: "1", "data-qid": qid, "data-key": `write:${qid}`, disabled: !live || null });
		write.value = staged.text.get(qid) || "";
		return h(
			"div",
			{ class: "question", "data-qid": qid },
			showText ? h("p", { class: "qtext" }, header, text) : null,
			ordered.length ? h("div", { class: "opts" }, ...ordered.map((option) => optionNode(item, question, option, rec, live, chosenSet.has(optionLabel(option))))) : null,
			live ? h("div", { class: "write" }, write) : null,
		);
	}

	function questionBlock(item, live) {
		const questions = questionsOf(item);
		if (!questions.length) return [];
		const itemId = idOf(item);
		const busy = ui.busy.has(itemId);
		const nodes = questions.map((question) => questionNode(item, question, live && !busy));
		if (live) {
			const button = h("button", { type: "button", class: "btn", "data-action": "send", "data-key": "send", disabled: busy || !collectAnswers(item) || null }, "보내기");
			nodes.push(h("div", { class: "actions" }, button));
		}
		return nodes;
	}

	function permissionBlock(item, live) {
		if (!live) return [];
		const itemId = idOf(item);
		const busy = ui.busy.has(itemId);
		const dialogTitle = item.raw && item.raw.dialog && item.raw.dialog.title ? String(item.raw.dialog.title) : "";
		const head = headlineOf(item).replace(/…$/, "");
		const title = dialogTitle && !(head && dialogTitle.startsWith(head)) ? dialogTitle : "";
		const buttons = dialogChoices(item).map((entry) =>
			h("button", { type: "button", class: `btn ${entry.style}`.trim(), "data-action": "perm", "data-choice": entry.choice, "data-key": `perm:${entry.choice}`, disabled: busy || null }, entry.label),
		);
		const nodes = [];
		if (title) nodes.push(h("p", { class: "qtext" }, title));
		nodes.push(h("div", { class: "actions" }, ...buttons));
		if (ui.feedbackOpen.has(itemId)) {
			const area = h("textarea", { placeholder: "거부하는 이유", "aria-label": "거부하는 이유", rows: "1", "data-key": "feedback", "data-feedback": "", disabled: busy || null });
			area.value = stagedOf(itemId).feedback;
			nodes.push(h("div", { class: "write" }, area, h("button", { type: "button", class: "btn", "data-action": "feedback", "data-key": "feedback-send", disabled: busy || null }, "보내기")));
		}
		return nodes;
	}

	// Summary options on a report, blocked or done bubble: a one-tap reply with that label.
	function replyOptions(item, live) {
		const summary = summaryOf(item);
		const options = summary && Array.isArray(summary.options) ? summary.options.filter((option) => option && option.label) : [];
		if (!live || !options.length) return [];
		const busy = ui.busy.has(idOf(item));
		const ordered = [...options.filter((option) => option.rec), ...options.filter((option) => !option.rec)];
		return [
			h(
				"div",
				{ class: "opts" },
				...ordered.map((option) =>
					h(
						"button",
						{ type: "button", class: `opt${option.rec ? " rec" : ""}`, "data-action": "reply", "data-label": String(option.label), disabled: busy || null },
						option.rec ? h("span", { class: "star" }, "★권장") : null,
						h("span", { class: "label" }, String(option.label)),
						option.why ? h("span", { class: "why" }, String(option.why)) : null,
					),
				),
			),
		];
	}

	// 원문 of an episode final: every message of the span in order, each with its time, from the episode route.
	function episodeNodes(item) {
		const entry = ui.episodes.get(idOf(item));
		if (!entry || entry.status === "loading") return [h("p", { class: "ep-state" }, LOADING_TEXT)];
		if (entry.status === "error") return [h("p", { class: "ep-state error" }, LOAD_FAILED_TEXT, h("button", { type: "button", "data-action": "episode" }, "다시 시도"))];
		const data = entry.data && typeof entry.data === "object" ? entry.data : {};
		const messages = [...(Array.isArray(data.lines) ? data.lines : []), data.final].filter((message) => message && typeof message === "object");
		if (!messages.length) return markdown(rawTextOf(item));
		return messages.map((message) =>
			h(
				"div",
				{ class: "ep-msg" },
				h("time", { class: "ep-at", datetime: message.at, title: absoluteTime(message.at) }, clockTime(message.at)),
				h("div", { class: "ep-body" }, ...markdown(String(message.text ?? ""))),
			),
		);
	}

	// isNext: this item is nextItem(), so its verdict shows as 다음 · <reason>.
	function agentBubble(item, isNext) {
		const itemId = idOf(item);
		const summary = summaryOf(item);
		const live = item.status === "open";
		const next = isNext ? nextOf(item) : null;
		const nextLine = next && NEXT_LINE_STATES.has(next.state) && next.reason ? `다음 · ${String(next.reason)}` : "";
		const headline = headlineOf(item);
		// What the bubble already shows verbatim (question lines, the dialog title and its choices); a heuristic body that only repeats it is dropped.
		const dialog = item.raw && item.raw.dialog && typeof item.raw.dialog === "object" ? item.raw.dialog : null;
		const questionText = dialog
			? [dialog.title, ...(Array.isArray(dialog.options) ? dialog.options.map(optionLabel) : [])].filter(Boolean).join("\n")
			: questionsOf(item)
				.map((q) => [q.header, q.question].filter(Boolean).join(": "))
				.join("\n");
		let body = summary && summary.body ? String(summary.body) : item.kind === "notice" && item.raw && item.raw.notice ? String(item.raw.notice.body || "") : "";
		// A heuristic body repeats the headline as its first line; show only what follows it.
		const head = headline.replace(/…$/, "");
		if (head && body.startsWith(head)) body = body.slice(head.length).replace(/^[\s.!?。]+/, "");
		const showBody = body && body !== headline && !(questionText && questionText.includes(body.replace(/…$/, "")));
		const askText = summary && summary.ask ? String(summary.ask) : "";
		const ask = askText && item.kind !== "question" && item.kind !== "permission" && askText !== headline && !body.includes(askText) ? askText : "";
		const listening = ui.listening === itemId;
		// The heuristic strings already read "...답이 없으면..."; only a model's bare consequence gets the label.
		const noAnswer = summary && summary.ifNoAnswer ? String(summary.ifNoAnswer) : "";
		const noAnswerLine = noAnswer ? (noAnswer.includes("답이 없으면") ? noAnswer : `답이 없으면 · ${noAnswer}`) : "";
		const terms = summary && Array.isArray(summary.terms) ? summary.terms.filter((term) => term && term.term) : [];
		const popover = ui.termOpen && ui.termOpen.itemId === itemId ? terms[ui.termOpen.n] : null;
		const popId = popover ? `pop-${itemId}-${ui.termOpen.n}` : null;
		const usedTerms = new Set();
		const termField = (text, className, prefix = "") => {
			const value = String(text ?? "");
			const matches = terms
				.map((term, n) => ({ term, n, index: usedTerms.has(n) ? -1 : value.indexOf(String(term.term)) }))
				.filter((match) => match.index >= 0)
				.sort((a, b) => a.index - b.index || b.term.term.length - a.term.term.length || a.n - b.n);
			const parts = [];
			if (prefix) parts.push(prefix);
			let last = 0;
			for (const match of matches) {
				if (match.index < last) continue;
				if (match.index > last) parts.push(value.slice(last, match.index));
				const open = ui.termOpen && ui.termOpen.itemId === itemId && ui.termOpen.n === match.n;
				parts.push(h("button", {
					type: "button",
					class: "term",
					"data-action": "term",
					"data-term": String(match.n),
					"aria-expanded": open ? "true" : "false",
					"aria-controls": `pop-${itemId}-${match.n}`,
				}, String(match.term.term)));
				usedTerms.add(match.n);
				last = match.index + String(match.term.term).length;
			}
			if (last < value.length) parts.push(value.slice(last));
			return h("p", { class: className }, ...parts);
		};
		const rawOpen = ui.rawOpen.has(itemId);
		const explaining = ui.explain.has(itemId);
		const error = ui.error.get(itemId);
		const status = error ? error : ui.busy.has(itemId) ? SENDING_TEXT : explaining ? EXPLAINING_TEXT : "";
		const hint = live && item.kind === "question" && BRIDGE_HINT[item.bridge] ? BRIDGE_HINT[item.bridge] : "";
		const bubble = h(
			"div",
			{ class: "bubble" },
			h("div", { class: "head" }, kindChip(item)),
			termField(headline, "headline"),
			summary && summary.context ? termField(summary.context, "context", "하던 일 · ") : null,
			showBody ? termField(body, "body") : null,
			ask ? termField(ask, "ask") : null,
			nextLine ? h("p", { class: "next" }, nextLine) : null,
			popover ? h("div", { class: "term-pop", id: popId }, h("b", null, String(popover.term)), h("span", null, String(popover.meaning || ""))) : null,
			...(item.kind === "question" ? questionBlock(item, live) : []),
			...(item.kind === "permission" ? permissionBlock(item, live) : []),
			...(item.kind !== "question" && item.kind !== "permission" ? replyOptions(item, live) : []),
			noAnswerLine && live ? h("p", { class: "noanswer" }, noAnswerLine) : null,
			hint ? h("p", { class: "hint" }, hint) : null,
			status ? h("p", { class: `status${error ? " error" : ""}`, role: "status" }, status) : null,
			h(
				"div",
				{ class: "foot" },
				("speechSynthesis" in window) ? h("button", { type: "button", class: "text", "data-action": "listen", "aria-pressed": listening ? "true" : "false" }, listening ? "멈추기" : "듣기") : null,
				h("button", { type: "button", class: "text", "data-action": "raw", "aria-expanded": rawOpen ? "true" : "false" }, rawOpen ? "원문 닫기" : "원문 보기"),
				h("button", { type: "button", class: "text", "data-action": "explain", disabled: explaining || null }, "더 쉽게"),
				h("time", { datetime: item.createdAt, "data-at": item.createdAt, title: absoluteTime(item.createdAt) }, relativeTime(item.createdAt)),
			),
			h(
				"div",
				{ class: "report-entry" },
				h("button", { type: "button", class: "text", "data-action": "report", "data-report-item": itemId, "data-key": "report" }, "제보"),
			),
			h("div", { class: "raw", hidden: !rawOpen || null }, episodeOf(item) ? episodeNodes(item) : markdown(rawTextOf(item))),
		);
		return h("article", { class: `msg agent${ui.hit === itemId ? " hit" : ""}`, "data-msg": itemId }, bubble);
	}

	function answerText(item, answer) {
		const payload = answer.payload && typeof answer.payload === "object" ? answer.payload : {};
		if (item.kind === "question") {
			const questions = questionsOf(item);
			const lines = [];
			for (const [qid, value] of Object.entries(payload.answers && typeof payload.answers === "object" ? payload.answers : {})) {
				if (!value || typeof value !== "object") continue;
				const parts = [];
				if (Array.isArray(value.selected) && value.selected.length) parts.push(value.selected.join(", "));
				if (value.text) parts.push(String(value.text));
				const q = questions.find((entry) => String(entry.id ?? "") === qid);
				const head = questions.length > 1 && q && (q.header || q.question) ? `${q.header || q.question}: ` : "";
				if (parts.length) lines.push(head + parts.join(" / "));
			}
			if (payload.comment) lines.push(String(payload.comment));
			return lines.join("\n");
		}
		if (item.kind === "permission") {
			const found = PERMISSION.find((entry) => entry.choice === payload.choice);
			const label = found ? found.label : String(payload.choice ?? "");
			return payload.feedbackText ? `${label}: ${payload.feedbackText}` : label;
		}
		return String(payload.text ?? payload.comment ?? "");
	}

	// The next action a bubble answers with (close, run, new-session), from the server's answer payload; null for a reply.
	function actionOf(answer) {
		const payload = answer.payload && typeof answer.payload === "object" ? answer.payload : {};
		return typeof payload.action === "string" && payload.action ? payload.action : null;
	}

	function deliveryState(item, answer) {
		const action = actionOf(answer);
		const record = state.deliveredHow.get(`${idOf(item)}:${answer.deliveryId}`);
		const how = record ? record.how : Array.isArray(item.deliveredIds) && item.deliveredIds.includes(answer.deliveryId) ? "message" : null;
		if (how) {
			let text = DELIVERED_LINE[how] || "전달됨 ✓";
			if (how === "refused" && record && record.detail) text += ` · ${record.detail === "dialog closed" ? "대화창이 닫힘" : String(record.detail)}`;
			return { text, warn: how === "refused" || how === "dropped", resend: false };
		}
		// A control the session never acked within 60 s cannot be resent; the session is not answering.
		if (answer.deliveryUnconfirmed) return action ? { text: NO_RESPONSE_TEXT, warn: true, resend: false } : { text: OFFLINE_TEXT, warn: false, resend: true };
		return { text: SENDING_TEXT, warn: false, resend: false };
	}

	function userBubble(item, answer) {
		const delivery = deliveryState(item, answer);
		const busy = ui.busy.has(idOf(item));
		return h(
			"article",
			{ class: "msg user", "data-answer": answer.answerId || answer.deliveryId },
			h("div", { class: "bubble" }, answerText(item, answer)),
			delivery
				? h(
					"div",
					{ class: `state${delivery.warn ? " warn" : ""}` },
					h("span", null, delivery.text),
					delivery.resend ? h("button", { type: "button", "data-action": "resend", "data-delivery": answer.deliveryId, disabled: busy || null }, "다시 보내기") : null,
				)
				: null,
		);
	}

	// The owner's request above an episode's lines (his mockup: his request, the lines, then the agent's message): an
	// owner bubble that is a button; text past 6 lines stays clipped until a tap opens it.
	function requestBubble(item, request) {
		const open = ui.requestOpen.has(idOf(item));
		return h("article", { class: "msg user request" }, h("button", { type: "button", class: "bubble", "data-action": "request", "data-key": "request", "aria-expanded": open ? "true" : "false" }, h("span", { class: "text" }, request)));
	}

	function toggleRequest(itemId) {
		if (ui.requestOpen.has(itemId)) ui.requestOpen.delete(itemId);
		else ui.requestOpen.add(itemId);
		refreshItem(itemId);
	}

	// A request bubble whose text runs past its 6 lines, or one already opened, is the tap target that opens or closes it.
	function markRequestMore(node) {
		for (const bubble of node.querySelectorAll(".request .bubble")) {
			const text = bubble.querySelector(".text");
			bubble.classList.toggle("more", bubble.getAttribute("aria-expanded") === "true" || (text !== null && text.scrollHeight > text.clientHeight + 1));
		}
	}

	// itemId -> the request to show above that progress line: the first line of an episode and a line whose request differs
	// from the previous line's (the thread payload drops repeats, so a line without one carries the previous request on),
	// unless the nearest earlier owner bubble already says the same (a request sent from the phone is a bubble already).
	function requestsOf(items) {
		const out = new Map();
		const lastOf = new Map();
		let lastOwner = null;
		for (const item of items) {
			const episode = item.meta && item.meta.episode && typeof item.meta.episode === "object" ? item.meta.episode : null;
			const key = item.kind === "progress" && episode && typeof episode.key === "string" && episode.key ? episode.key : null;
			const request = key && item.raw && typeof item.raw.request === "string" ? item.raw.request.trim() : "";
			if (request && request !== lastOf.get(key)) {
				lastOf.set(key, request);
				if (request !== lastOwner) {
					out.set(idOf(item), request);
					lastOwner = request;
				}
			}
			for (const answer of Array.isArray(item.answers) ? item.answers : []) lastOwner = answerText(item, answer).trim();
		}
		return out;
	}

	function sysLine(text, extra) {
		return h("article", { class: `msg sys${extra ? ` ${extra}` : ""}` }, h("div", { class: "line" }, text));
	}

	// external: a desk board's absolute http(s) url (validated by the server), opened in a new tab.
	function linkLine(label, href, external) {
		return h("article", { class: "msg sys" }, h("div", { class: "line" }, `${label} · `, h("a", external ? { href, target: "_blank", rel: "noopener noreferrer" } : { href }, "열기")));
	}

	function safeHref(url, prefix) {
		const value = typeof url === "string" ? url : "";
		if (prefix) return value.startsWith(prefix) ? value : null;
		return value.startsWith("/") && !value.startsWith("//") ? value : value.startsWith("https://") ? value : null;
	}

	// The handoff after a new-session launch, one centered line after the last item: 새 세션을 여는 중 while it launches,
	// 새 세션에서 이어감 · 열기 linking the new thread once it connected. Returns true when a line was appended.
	function renderHandoff() {
		const thread = state.thread || {};
		const handoff = thread.handoff && typeof thread.handoff === "object" ? thread.handoff : null;
		const to = handoff && typeof handoff.to === "string" ? handoff.to : "";
		const sig = handoff ? JSON.stringify([to, handoff.status]) : null;
		if (ui.handoff && ui.handoff.sig === sig) {
			if (els.chat.lastElementChild !== ui.handoff.node) els.chat.append(ui.handoff.node);
			return false;
		}
		if (ui.handoff) ui.handoff.node.remove();
		ui.handoff = null;
		if (!handoff) return false;
		const line = handoff.status === "connected" && to ? linkLine("새 세션에서 이어감", `/s/${encodeURIComponent(to)}`) : sysLine(handoff.status === "connected" ? "새 세션에서 이어감" : "새 세션을 여는 중");
		const node = h("section", { class: "group", "data-handoff": handoff.status }, line);
		els.chat.append(node);
		ui.handoff = { sig, node };
		return true;
	}

	// wait: waitOf(item), the suffix and board links of the newest progress line of a working thread.
	// request: requestsOf(items).get(itemId), the owner's request shown above this progress line.
	// isNext: the item is nextItem(), whose bubble shows the 다음 · line.
	function buildItem(item, wait, request, isNext) {
		const nodes = [];
		const synthetic = item.raw && typeof item.raw === "object" && item.raw.synthetic === true;
		if (item.kind === "progress") {
			if (request) nodes.push(requestBubble(item, request));
			const suffix = wait ? ` · 기다리는 중${wait.label ? `: ${wait.label}` : ""}` : "";
			nodes.push(sysLine(`${headlineOf(item)}${suffix}`, "progress"));
			for (const board of wait ? wait.boards : []) nodes.push(linkLine(board.title || "Review", board.url, true));
		} else if (!synthetic) {
			nodes.push(agentBubble(item, isNext));
		}
		for (const answer of Array.isArray(item.answers) ? item.answers : []) nodes.push(userBubble(item, answer));
		if (item.kind === "board") {
			const href = safeHref(item.raw && item.raw.url, "/p/");
			if (href) nodes.push(linkLine("Review", href));
		}
		if (item.kind === "notice") {
			const href = safeHref(item.raw && item.raw.notice ? item.raw.notice.url : null);
			if (href) nodes.push(linkLine("알림", href));
		}
		if (item.status === "closed" && item.closedReason && item.closedReason !== "answered-phone" && item.kind !== "progress") {
			nodes.push(sysLine(CLOSE_LINE[item.closedReason] || String(item.closedReason)));
		}
		return nodes;
	}

	function signatureOf(item, request, isNext) {
		const itemId = idOf(item);
		const hows = (Array.isArray(item.answers) ? item.answers : []).map((answer) => state.deliveredHow.get(`${itemId}:${answer.deliveryId}`) || null);
		const episode = ui.episodes.get(itemId);
		const termOpen = ui.termOpen && ui.termOpen.itemId === itemId ? ui.termOpen.n : null;
		const view = [ui.busy.has(itemId), ui.error.get(itemId) || null, ui.explain.has(itemId), ui.feedbackOpen.has(itemId), ui.hit === itemId, waitOf(item), episode ? episode.status : null, request || null, ui.requestOpen.has(itemId), termOpen, ui.listening === itemId, isNext];
		return JSON.stringify([item, hows, view]);
	}

	function focusKey() {
		const active = document.activeElement;
		if (!active || !els.chat.contains(active)) return null;
		const group = active.closest("[data-item]");
		const key = active.getAttribute("data-key");
		return group && key ? { itemId: group.getAttribute("data-item"), key } : null;
	}

	function restoreFocus(target, node) {
		if (!target) return;
		const el = node.querySelector(`[data-key="${CSS.escape(target.key)}"]`);
		if (!el) return;
		el.focus({ preventScroll: true });
		if (el.tagName === "TEXTAREA") el.setSelectionRange(el.value.length, el.value.length);
	}

	function nearBottom() {
		return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
	}

	function scrollToBottom() {
		window.scrollTo(0, document.documentElement.scrollHeight);
	}

	function renderItems() {
		els.chat.setAttribute("aria-busy", "false");
		if (!state.items.length) {
			ui.nodes.clear();
			ui.handoff = null;
			els.chat.replaceChildren(h("p", { class: "empty" }, EMPTY_TEXT));
			return;
		}
		const empty = els.chat.querySelector(".empty");
		if (empty) empty.remove();
		const stick = state.loaded && nearBottom();
		const focus = focusKey();
		const requests = requestsOf(state.items);
		const target = nextItem();
		let appended = false;
		for (const item of state.items) {
			const itemId = idOf(item);
			if (!itemId) continue;
			const request = requests.get(itemId) || null;
			const isNext = item === target;
			const sig = signatureOf(item, request, isNext);
			const existing = ui.nodes.get(itemId);
			if (existing && existing.sig === sig) continue;
			const wait = waitOf(item);
			const node = h("section", { class: "group", "data-item": itemId, "data-kind": item.kind, "data-boards": wait && wait.boards.length ? true : null, "data-request": request ? true : null }, ...buildItem(item, wait, request, isNext));
			if (existing) {
				existing.node.replaceWith(node);
				if (focus && focus.itemId === itemId) restoreFocus(focus, node);
			} else {
				els.chat.append(node);
				appended = true;
			}
			markRequestMore(node);
			ui.nodes.set(itemId, { sig, node });
			if (ui.termOpen && ui.termOpen.itemId === itemId) positionTermPopover(itemId, ui.termOpen.n);
		}
		if (renderHandoff()) appended = true;
		if (appended && stick) scrollToBottom();
	}

	function renderTimes() {
		for (const el of els.chat.querySelectorAll("time[data-at]")) el.textContent = relativeTime(el.getAttribute("data-at"));
		for (const el of els.chips.querySelectorAll(".fire[data-until]")) {
			const text = fireText(el.getAttribute("data-until"));
			el.textContent = text;
			el.hidden = text === "";
		}
	}

	function refreshItem(itemId) {
		renderItems();
		const entry = ui.nodes.get(itemId);
		return entry ? entry.node : null;
	}

	function positionTermPopover(itemId, n) {
		const node = ui.nodes.get(itemId)?.node;
		const button = node && node.querySelector(`[data-action="term"][data-term="${n}"]`);
		const bubble = button && button.closest(".bubble");
		const popover = bubble && bubble.querySelector(".term-pop");
		if (!button || !bubble || !popover) return;
		requestAnimationFrame(() => {
			popover.style.top = `${button.getBoundingClientRect().bottom - bubble.getBoundingClientRect().top + 6}px`;
		});
	}

	function closeTermPopover(focus = false) {
		if (!ui.termOpen) return;
		const { itemId, n } = ui.termOpen;
		ui.termOpen = null;
		const node = refreshItem(itemId);
		if (focus && node) node.querySelector(`[data-action="term"][data-term="${n}"]`)?.focus();
	}

	// ---------- composer ----------

	function newestOpen() {
		for (let i = state.items.length - 1; i >= 0; i--) {
			if (state.items[i].status === "open") return state.items[i];
		}
		return null;
	}

	// The newest open needs-you item: a question takes a comment, a report/막힘/끝남/알림 takes a reply, anything else gets a free message.
	function composerTarget() {
		for (let i = state.items.length - 1; i >= 0; i--) {
			const item = state.items[i];
			if (item.status !== "open" || item.policy !== "needs-you") continue;
			if (item.kind === "question") return { item, mode: "comment" };
			if (TEXT_ANSWER_KINDS.has(item.kind)) return { item, mode: "text" };
			break;
		}
		return { item: null, mode: "message" };
	}

	// The chips and the next actions bar. For a done/plan/ship verdict the actions take the chips' place; for ask, blocked
	// and stalled the chips stay (the existing rule) and the actions follow them, close as a ghost button set apart by a gap.
	function renderComposer() {
		const open = newestOpen();
		const thread = state.thread || {};
		const target = nextItem();
		const next = target ? nextOf(target) : null;
		const replaces = next !== null && NEXT_REPLACES_CHIPS.has(next.state);
		els.quick.hidden = replaces || !((open && QUICK_KINDS.has(open.kind)) || thread.status === "working");
		renderNextActions(target, next);
	}

	// [{action, ghost}] in display order: primary first as the server sends them; after the chips, close moves last as the ghost.
	function nextButtons(next) {
		const actions = nextActionsOf(next);
		if (NEXT_REPLACES_CHIPS.has(next.state)) return actions.map((action) => ({ action, ghost: false }));
		return [...actions.filter((action) => action.kind !== "close"), ...actions.filter((action) => action.kind === "close")].map((action) => ({ action, ghost: action.kind === "close" }));
	}

	function renderNextActions(target, next) {
		const entries = target && next ? nextButtons(next) : [];
		const sig = JSON.stringify([target ? idOf(target) : null, entries]);
		if (ui.nextSig === sig) return;
		ui.nextSig = sig;
		const active = document.activeElement;
		const focused = active && els.nextActions.contains(active) ? active.getAttribute("data-next") : null;
		els.nextActions.replaceChildren(
			...entries.map(({ action, ghost }) =>
				h("button", { type: "button", class: `next-btn${action.primary === true ? " primary" : ""}${ghost ? " ghost" : ""}`, "data-next": action.id, disabled: ui.nextBusy || null }, String(action.label)),
			),
		);
		els.nextActions.hidden = entries.length === 0;
		if (focused) els.nextActions.querySelector(`[data-next="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
	}

	// A tap locks every next button until the response.
	function setNextBusy(busy) {
		ui.nextBusy = busy;
		for (const button of els.nextActions.querySelectorAll("button")) button.disabled = busy;
	}

	function setComposeStatus(text, error) {
		els.composeStatus.textContent = text;
		els.composeStatus.classList.toggle("error", Boolean(error));
	}

	function lockComposer(busy) {
		ui.composerBusy = busy;
		els.send.disabled = busy;
		els.reply.disabled = busy;
		for (const button of els.quick.querySelectorAll("button")) button.disabled = busy;
	}

	function sessionOff() {
		return state.thread && state.thread.live === false && sid !== "_notices";
	}

	function gateSend(send) {
		if (sessionOff()) openReopenSheet(send);
		else return send();
	}

	function closeSheet(dim, sheet, onKey, returnFocus) {
		document.removeEventListener("keydown", onKey);
		dim.remove();
		sheet.remove();
		if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
	}

	// Every sheet: one dim layer, a dialog with a title, its lines and a button row; Escape or a tap on the dim closes it and
	// focus returns (to returnFocus when given: the tapped button, which a lock has already blurred). buttons: [{key, label,
	// primary, onTap}]; a tap closes the sheet, then runs onTap.
	function openSheet({ title, lines, buttons, returnFocus = document.activeElement }) {
		const dim = h("div", { class: "sheet-dim", "data-sheet": "dim" });
		const sheet = h(
			"div",
			{ class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "sheetTitle" },
			h("h3", { id: "sheetTitle" }, title),
			...lines,
			h("div", { class: "sheet-row" }, ...buttons.map((button) => h("button", { type: "button", class: button.primary ? "pri" : null, "data-sheet": button.key }, button.label))),
		);
		const onKey = (event) => {
			if (event.key === "Escape") dismiss();
		};
		const dismiss = () => closeSheet(dim, sheet, onKey, returnFocus);
		dim.addEventListener("click", dismiss);
		for (const button of buttons) {
			sheet.querySelector(`[data-sheet="${button.key}"]`).addEventListener("click", (event) => {
				event.currentTarget.disabled = true;
				dismiss();
				void button.onTap();
			});
		}
		document.body.append(dim, sheet);
		document.addEventListener("keydown", onKey);
		(sheet.querySelector(".pri") || sheet.querySelector("button")).focus();
	}

	function reopenSession() {
		recordAction("reopen_session");
		setComposeStatus("세션을 여는 중입니다.", false);
		return postJson(`${apiThread}/reopen`, {}).then(async (res) => {
			const body = await readJson(res);
			if (res.ok) setComposeStatus("세션을 열었습니다. 연결되면 전달됩니다.", false);
			else if (res.status === 409 && body && body.error === "live") setComposeStatus("", false);
			else if (res.status === 409 && body && body.error === "cwd_missing") setComposeStatus("세션 폴더가 없어 열지 못했습니다. 답은 다음에 열 때 전달됩니다.", false);
			else if (res.status === 409 && body && body.error === "no_session") setComposeStatus("열 세션을 찾지 못했습니다. 답은 다음에 열 때 전달됩니다.", false);
			else if (res.status === 503) setComposeStatus("터미널을 찾지 못했습니다. 답은 다음에 열 때 전달됩니다.", false);
			else if (res.status === 403) setComposeStatus("이 기기에서는 열 수 없습니다. 답은 다음에 열 때 전달됩니다.", false);
			else setComposeStatus("세션을 열지 못했습니다. 답은 다음에 열 때 전달됩니다.", false);
		}).catch((error) => {
			console.error("thread: reopen failed", error);
			setComposeStatus("세션을 열지 못했습니다. 답은 다음에 열 때 전달됩니다.", false);
		});
	}

	function openReopenSheet(send) {
		openSheet({
			title: "세션이 꺼져 있습니다",
			lines: [h("p", null, "다시 열면 이 답을 바로 전달합니다.")],
			buttons: [
				{ key: "reopen", label: "다시 열고 보내기", primary: true, onTap: async () => { if (await send() === true) await reopenSession(); } },
				{ key: "later", label: "나중에 전달", primary: false, onTap: () => send() },
			],
		});
	}

	// ---------- next actions ----------

	// warnings: the verdict's warnings, or the ones a 409 confirm_required answered with (then returnFocus is the tapped button).
	function openCloseSheet(item, action, warnings, returnFocus) {
		openSheet({
			title: "세션을 닫을까요?",
			lines: [h("ul", null, ...warnings.map((warning) => h("li", null, warning)))],
			buttons: [
				{ key: "close", label: "닫기", primary: true, onTap: () => postAction(item, action, { confirm: true }) },
				{ key: "cancel", label: "취소", primary: false, onTap: () => {} },
			],
			...(returnFocus ? { returnFocus } : {}),
		});
	}

	function openNewSessionSheet(item, next, action) {
		const plan = next.facts && next.facts.plan && typeof next.facts.plan === "object" ? next.facts.plan : null;
		openSheet({
			title: "새 세션에서 실행할까요?",
			lines: [h("div", { class: "facts" }, h("p", null, `폴더 · ${plan ? String(plan.root ?? "") : ""}`), h("p", null, `첫 메시지 · ${String(action.prompt ?? "")}`))],
			buttons: [
				{
					key: "launch",
					label: "실행",
					primary: true,
					onTap: () => {
						setComposeStatus("새 세션을 여는 중입니다.", false);
						return postAction(item, action, {});
					},
				},
				{ key: "cancel", label: "취소", primary: false, onTap: () => {} },
			],
		});
	}

	function actionFailText(res, body) {
		const error = body && typeof body === "object" ? body.error : null;
		if (ACTION_ERROR[error]) return ACTION_ERROR[error];
		if (res.status === 503) return ACTION_ERROR.no_launcher;
		if (res.status === 502) return ACTION_ERROR.launch_failed;
		if (res.status === 403) return ACTION_ERROR.forbidden;
		return failText(res, body);
	}

	// POST /api/items/<id>/action {action, confirm?}; true when the server took it. A confirm_required answer opens the
	// close sheet with the server's warnings; stale shows its line and refreshes at once.
	async function postAction(item, action, extra) {
		if (ui.nextBusy) return false;
		const tapped = document.activeElement;
		setNextBusy(true);
		try {
			const res = await postJson(`/api/items/${encodeURIComponent(idOf(item))}/action`, { action: action.id, ...extra });
			const body = await readJson(res);
			if (res.ok) {
				const via = body && typeof body === "object" ? body.via : null;
				if (action.kind === "close") setComposeStatus(via === "offline" ? "세션을 닫았습니다." : "세션을 닫는 중입니다.", false);
				else if (action.kind === "new-session") {
					const session = body && typeof body.session === "string" ? body.session : "";
					els.composeStatus.classList.remove("error");
					els.composeStatus.replaceChildren("새 세션을 열었습니다. ", session ? h("a", { href: `/s/${encodeURIComponent(session)}` }, "열기") : null);
				} else setComposeStatus("", false);
				await load();
				return true;
			}
			const error = body && typeof body === "object" ? body.error : null;
			if (res.status === 409 && error === "confirm_required") {
				const warnings = (Array.isArray(body.warnings) ? body.warnings : []).map((warning) => String(warning)).filter(Boolean);
				setComposeStatus("", false);
				setNextBusy(false);
				openCloseSheet(item, action, warnings, tapped && els.nextActions.contains(tapped) ? tapped : null);
				return false;
			}
			if (res.status === 409 && error === "stale") {
				setComposeStatus(STALE_TEXT, false);
				await load();
				return false;
			}
			setComposeStatus(actionFailText(res, body), true);
			return false;
		} catch (error) {
			console.error("thread: action failed", error);
			setComposeStatus(FAILED_TEXT, true);
			return false;
		} finally {
			setNextBusy(false);
		}
	}

	// continue goes like a reply (the reopen sheet first when the session is off); close asks when the verdict carries
	// warnings; new-session always asks; run posts at once.
	function runNext(item, next, action) {
		if (action.kind === "continue") return gateSend(() => postAction(item, action, {}));
		if (action.kind === "close") {
			const warnings = (Array.isArray(next.warnings) ? next.warnings : []).map((warning) => String(warning)).filter(Boolean);
			if (warnings.length) return openCloseSheet(item, action, warnings);
			return postAction(item, action, {});
		}
		if (action.kind === "new-session") return openNewSessionSheet(item, next, action);
		return postAction(item, action, {});
	}

	function onNextClick(event) {
		const button = event.target.closest("[data-next]");
		if (!button || button.disabled || ui.nextBusy) return;
		const target = nextItem();
		const next = target ? nextOf(target) : null;
		const id = button.getAttribute("data-next");
		const action = nextActionsOf(next).find((entry) => entry.id === id);
		if (target && action) void runNext(target, next, action);
	}

	async function sendComposer(text, fromQuick, bypassGate = false) {
		const value = String(text ?? "").trim();
		if (!value || ui.composerBusy) return;
		if (!bypassGate && sessionOff()) return gateSend(() => sendComposer(text, fromQuick, true));
		lockComposer(true);
		setComposeStatus(SENDING_TEXT, false);
		const target = composerTarget();
		try {
			let res;
			let body = null;
			recordAction(target.mode === "message" ? "send_reply" : "answer");
			if (target.mode === "comment") res = await postJson(`/api/items/${encodeURIComponent(idOf(target.item))}/answer`, { comment: value });
			else if (target.mode === "text") res = await postJson(`/api/items/${encodeURIComponent(idOf(target.item))}/answer`, { text: value });
			else res = await postJson(`${apiThread}/message`, { text: value });
			if (!res.ok) body = await readJson(res);
			// A report that closed between polls still takes the words as the next message.
			if (!res.ok && res.status === 409 && target.mode === "text") {
				res = await postJson(`${apiThread}/message`, { text: value });
				body = res.ok ? null : await readJson(res);
			}
			if (!res.ok) {
				setComposeStatus(failText(res, body), true);
				return false;
			}
			if (!fromQuick) els.reply.value = "";
			setComposeStatus("", false);
			await load();
			return true;
		} catch (error) {
			console.error("thread: send failed", error);
			setComposeStatus(FAILED_TEXT, true);
			return false;
		} finally {
			lockComposer(false);
		}
	}

	// ---------- item actions ----------

	async function sendAnswer(item, body, bypassGate = false) {
		const itemId = idOf(item);
		if (ui.busy.has(itemId)) return;
		if (!bypassGate && sessionOff()) return gateSend(() => sendAnswer(item, body, true));
		recordAction("answer");
		ui.busy.add(itemId);
		ui.error.delete(itemId);
		refreshItem(itemId);
		let stored = false;
		try {
			const res = await postJson(`/api/items/${encodeURIComponent(itemId)}/answer`, body);
			if (!res.ok) {
				ui.error.set(itemId, failText(res, await readJson(res)));
			} else {
				stored = true;
				ui.staged.delete(itemId);
				ui.feedbackOpen.delete(itemId);
			}
		} catch (error) {
			console.error("thread: answer failed", error);
			ui.error.set(itemId, FAILED_TEXT);
		} finally {
			ui.busy.delete(itemId);
		}
		refreshItem(itemId);
		await load();
		return stored;
	}

	async function resend(item, answer, bypassGate = false) {
		const itemId = idOf(item);
		if (ui.busy.has(itemId)) return;
		if (!bypassGate && sessionOff()) return gateSend(() => resend(item, answer, true));
		const payload = answer.payload && typeof answer.payload === "object" ? answer.payload : {};
		const asMessage = item.status === "closed" && TEXT_ANSWER_KINDS.has(item.kind) && payload.text;
		ui.busy.add(itemId);
		ui.error.delete(itemId);
		refreshItem(itemId);
		let stored = false;
		try {
			const res = asMessage ? await postJson(`${apiThread}/message`, { text: payload.text }) : await postJson(`/api/items/${encodeURIComponent(itemId)}/answer`, payload);
			if (!res.ok) ui.error.set(itemId, failText(res, await readJson(res)));
			else stored = true;
		} catch (error) {
			console.error("thread: resend failed", error);
			ui.error.set(itemId, FAILED_TEXT);
		} finally {
			ui.busy.delete(itemId);
		}
		refreshItem(itemId);
		await load();
		return stored;
	}

	async function toggleHidden() {
		recordAction("hide_thread");
		const current = state.thread && state.thread.hidden === true;
		try {
			const res = await postJson(`${apiThread}/hide`, { hidden: !current });
			const json = await readJson(res);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			state.thread.hidden = json.hidden;
			renderHeader();
		} catch (error) {
			console.error("thread: hide failed", error);
			setComposeStatus("숨기지 못했습니다.", true);
		}
	}

	async function explain(item) {
		const itemId = idOf(item);
		if (ui.explain.has(itemId)) return;
		ui.explain.set(itemId, state.lastSeq);
		ui.error.delete(itemId);
		refreshItem(itemId);
		try {
			const res = await postJson(`/api/items/${encodeURIComponent(itemId)}/explain`, {});
			if (!res.ok) {
				ui.explain.delete(itemId);
				ui.error.set(itemId, failText(res, await readJson(res)));
			}
		} catch (error) {
			console.error("thread: explain failed", error);
			ui.explain.delete(itemId);
			ui.error.set(itemId, "요청하지 못했습니다");
		}
		refreshItem(itemId);
	}

	// GET the episode behind a final once; 다시 시도 after a failure calls this again.
	async function loadEpisode(item) {
		const itemId = idOf(item);
		const episode = episodeOf(item);
		const current = ui.episodes.get(itemId);
		if (!episode || (current && current.status !== "error")) return;
		ui.episodes.set(itemId, { status: "loading", data: null });
		refreshItem(itemId);
		try {
			const res = await fetch(`${apiThread}/episodes/${encodeURIComponent(episode.key)}`, { headers: { accept: "application/json" }, cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			ui.episodes.set(itemId, { status: "ok", data: await res.json() });
		} catch (error) {
			console.error("thread: episode load failed", error);
			ui.episodes.set(itemId, { status: "error", data: null });
		}
		refreshItem(itemId);
	}

	function toggleRaw(item, node) {
		const itemId = idOf(item);
		const pre = node.querySelector(".raw");
		const button = node.querySelector('[data-action="raw"]');
		const open = !ui.rawOpen.has(itemId);
		if (open) ui.rawOpen.add(itemId);
		else ui.rawOpen.delete(itemId);
		if (pre) pre.hidden = !open;
		if (button) {
			button.textContent = open ? "원문 닫기" : "원문 보기";
			button.setAttribute("aria-expanded", open ? "true" : "false");
		}
		if (open && !ui.episodes.has(itemId)) void loadEpisode(item);
	}

	function syncSend(itemId, node) {
		const item = state.items.find((entry) => idOf(entry) === itemId);
		const button = node.querySelector('[data-action="send"]');
		if (item && button) button.disabled = ui.busy.has(itemId) || !collectAnswers(item);
	}

	function pick(item, node, button) {
		const itemId = idOf(item);
		const qid = button.getAttribute("data-qid") || "";
		const label = button.getAttribute("data-label") || "";
		const questions = questionsOf(item);
		const staged = stagedOf(itemId);
		if (questions.length === 1) {
			const text = (staged.text.get(qid) || "").trim();
			return sendAnswer(item, { answers: { [qid]: text ? { selected: [label], text } : { selected: [label] } } });
		}
		const set = selectedSet(itemId, qid);
		const already = set.has(label);
		set.clear();
		if (!already) set.add(label);
		const scope = button.closest(".question") || node;
		for (const other of scope.querySelectorAll('[data-action="pick"]')) other.setAttribute("aria-pressed", other === button && !already ? "true" : "false");
		syncSend(itemId, node);
		return undefined;
	}

	function onChatClick(event) {
		const button = event.target.closest("[data-action]");
		if (!button || button.disabled) return;
		const group = button.closest("[data-item]");
		if (!group) return;
		const itemId = group.getAttribute("data-item");
		const item = state.items.find((entry) => idOf(entry) === itemId);
		if (!item) return;
		const action = button.getAttribute("data-action");
		if (action === "listen") {
			if (ui.listening === itemId) {
				window.speechSynthesis.cancel();
				ui.listening = null;
				refreshItem(itemId);
				return;
			}
			window.speechSynthesis.cancel();
			if (window.speechSynthesis.paused) window.speechSynthesis.resume();
			ui.listening = itemId;
			refreshItem(itemId);
			speakItem(item, group);
			return;
		}
		if (action === "term") {
			const n = Number(button.getAttribute("data-term"));
			const previous = ui.termOpen;
			ui.termOpen = ui.termOpen && ui.termOpen.itemId === itemId && ui.termOpen.n === n ? null : { itemId, n };
			if (previous && previous.itemId !== itemId) refreshItem(previous.itemId);
			refreshItem(itemId);
			return;
		}
		if (action === "report") return openReport(itemId, button);
		if (action === "raw") { recordAction("toggle_original"); return toggleRaw(item, group); }
		if (action === "request") return toggleRequest(itemId);
		if (action === "episode") return void loadEpisode(item);
		if (action === "explain") return void explain(item);
		if (action === "pick") return void pick(item, group, button);
		if (action === "send") {
			const body = collectAnswers(item);
			if (!body) {
				ui.error.set(itemId, NOTHING_STAGED_TEXT);
				refreshItem(itemId);
				return;
			}
			return void sendAnswer(item, body);
		}
		if (action === "reply") return void sendAnswer(item, { text: button.getAttribute("data-label") || "" });
		if (action === "perm") {
			const choice = button.getAttribute("data-choice") || "";
			if (choice === "Deny with feedback") {
				if (!ui.feedbackOpen.has(itemId)) {
					ui.feedbackOpen.add(itemId);
					const node = refreshItem(itemId);
					const area = node ? node.querySelector("[data-feedback]") : null;
					if (area) area.focus();
					return;
				}
				const feedbackText = stagedOf(itemId).feedback.trim();
				if (!feedbackText) {
					ui.error.set(itemId, "이유를 써 주세요");
					refreshItem(itemId);
					return;
				}
				return void sendAnswer(item, { choice, feedbackText });
			}
			return void sendAnswer(item, { choice });
		}
		if (action === "feedback") {
			const feedbackText = stagedOf(itemId).feedback.trim();
			if (!feedbackText) {
				ui.error.set(itemId, "이유를 써 주세요");
				refreshItem(itemId);
				return;
			}
			return void sendAnswer(item, { choice: "Deny with feedback", feedbackText });
		}
		if (action === "resend") {
			const deliveryId = button.getAttribute("data-delivery");
			const answer = (item.answers || []).find((entry) => entry.deliveryId === deliveryId);
			if (answer) return void resend(item, answer);
		}
	}

	function onChatInput(event) {
		const target = event.target;
		const group = target.closest("[data-item]");
		if (!group) return;
		const itemId = group.getAttribute("data-item");
		const staged = stagedOf(itemId);
		if (target.tagName === "TEXTAREA") {
			if (target.hasAttribute("data-feedback")) staged.feedback = target.value;
			else if (target.hasAttribute("data-qid")) staged.text.set(target.getAttribute("data-qid"), target.value);
		} else if (target.type === "checkbox" && target.hasAttribute("data-qid")) {
			const set = selectedSet(itemId, target.getAttribute("data-qid"));
			const label = target.getAttribute("data-label") || "";
			if (target.checked) set.add(label);
			else set.delete(label);
		}
		syncSend(itemId, group);
	}

	// ---------- data ----------

	function absorb(events) {
		for (const event of events) {
			if (!event || typeof event.seq !== "number") continue;
			if (event.seq > state.lastSeq) state.lastSeq = event.seq;
			if (event.type !== "read" && event.seq > state.maxNonReadSeq) state.maxNonReadSeq = event.seq;
			if (event.type === "delivered") state.deliveredHow.set(`${event.itemId}:${event.deliveryId}`, { how: event.how, detail: event.detail ?? null });
			if (event.type === "summary") {
				const pending = ui.explain.get(event.itemId);
				if (pending !== undefined && event.seq > pending) ui.explain.delete(event.itemId);
			}
		}
	}

	// POST read once new non-read events arrived while the page is visible; the read event itself never re-triggers it.
	function markRead() {
		if (ui.reporting) return;
		if (document.visibilityState !== "visible" || state.maxNonReadSeq <= state.readSeq) return;
		const seq = state.lastSeq;
		state.readSeq = seq;
		postJson(`${apiThread}/read`, { seq }).catch((error) => console.error("thread: read failed", error));
	}

	function applyHash() {
		const id = decodeURIComponent(location.hash.slice(1));
		if (!id || ui.hit === id) return;
		const entry = ui.nodes.get(id);
		if (!entry) return;
		ui.hit = id;
		const node = refreshItem(id) || entry.node;
		const msg = node.querySelector(".msg") || node;
		msg.scrollIntoView({ block: "center" });
	}

	function showNotice(text, retry) {
		els.noticeText.textContent = text;
		els.retry.hidden = !retry;
		els.notice.hidden = false;
	}

	async function load() {
		if (state.gone) return;
		const seq = ++state.requestSeq;
		const startedAt = performance.now();
		let data;
		try {
			const res = await fetch(`${apiThread}?since=${state.lastSeq}`, { headers: { accept: "application/json" }, cache: "no-store" });
			if (res.status === 404) {
				if (seq !== state.requestSeq) return;
				state.gone = true;
				stopTimer();
				els.chat.setAttribute("aria-busy", "false");
				showNotice("대화를 찾을 수 없습니다", false);
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = await res.json();
			if (diagnostics) diagnostics.recordRequest({ route: "thread_detail", status: res.status, durationMs: Math.round(performance.now() - startedAt), errorCode: null });
		} catch (error) {
			if (seq !== state.requestSeq) return;
			els.chat.setAttribute("aria-busy", "false");
			showNotice("대화를 불러오지 못했습니다", true);
			console.error("thread: load failed", error);
			return;
		}
		if (seq !== state.requestSeq) return;
		if (ui.reporting) {
			ui.pendingData = data;
			return;
		}
		applyData(data);
	}

	function applyData(data) {
		const first = !state.loaded;
		state.thread = data.thread && typeof data.thread === "object" ? data.thread : {};
		state.items = Array.isArray(data.items) ? data.items.filter((item) => item && typeof item === "object" && idOf(item)) : [];
		state.newestProgress = state.items.reduce((found, item) => (item.kind === "progress" ? idOf(item) : found), null);
		absorb(Array.isArray(data.events) ? data.events : []);
		if (first && state.thread.unread === 0) state.readSeq = state.lastSeq;
		els.notice.hidden = true;
		renderHeader();
		renderItems();
		renderTimes();
		renderComposer();
		state.loaded = true;
		if (first && !location.hash) scrollToBottom();
		applyHash();
		markRead();
	}

	function startTimer() {
		stopTimer();
		state.timer = setInterval(() => {
			if (document.visibilityState === "visible") load();
		}, POLL_MS);
	}

	function stopTimer() {
		if (state.timer !== null) {
			clearInterval(state.timer);
			state.timer = null;
		}
	}

	// ---------- progress lines (과정 보기) ----------

	function showProgress(on) {
		els.progressToggle.setAttribute("aria-pressed", on ? "true" : "false");
		els.chat.setAttribute("data-progress", on ? "on" : "off");
	}

	function storedProgress() {
		try {
			return localStorage.getItem(PROGRESS_KEY) !== "off";
		} catch {
			return true;
		}
	}

	// ---------- issue reporting ----------

	// The parent's own entry re-registers the Inbox adapter when it is clicked, so an embedded
	// message report must claim the shared registry itself instead of activating that entry. The
	// reporter still lives in the parent-owned registry; only this frame's thread adapter becomes current.
	function registerReportAdapter() {
		if (!reportOptions) return false;
		const options = reportEmbedded
			? { ...reportOptions, origin: location.origin, frameWindow: window }
			: { ...reportOptions, origin: location.origin };
		if (reportHandle && typeof reportRegistry.unregister === "function") {
			try {
				reportRegistry.unregister(reportHandle);
			} catch (error) {
				// the previous record is already gone
			}
		}
		reportHandle = reportRegistry.register(options);
		reportRegistered = true;
		return true;
	}

	// The parent registers its page adapter while this frame boots, which can happen after the
	// frame's first registration. Its reporter mount is the one observable that follows that
	// registration, so claim the registry once more then and disconnect immediately.
	function claimReportAdapterAfterParentSetup() {
		let parentDocument;
		try {
			parentDocument = window.parent.document;
		} catch (error) {
			return;
		}
		const disconnect = () => {
			if (reportSetupObserver) {
				reportSetupObserver.disconnect();
				reportSetupObserver = null;
			}
		};
		const claim = () => {
			if (!parentDocument.querySelector("#issue-report")) return false;
			disconnect();
			const current = typeof reportRegistry.current === "function" ? reportRegistry.current() : null;
			if (!current || !reportHandle || current.id !== reportHandle.id) registerReportAdapter();
			return true;
		};
		reportSetupObserver = new MutationObserver(() => {
			claim();
		});
		reportSetupObserver.observe(parentDocument.documentElement, { childList: true, subtree: true });
		claim();
	}

	// The parent creates its registry before the first thread iframe gets its src and announces it
	// with a same-origin event. A load that started before the registry existed waits for one of
	// those, and never creates a frame-local registry while embedded.
	function parentReportRegistry() {
		try {
			const registry = window.parent.__inboxIssueAdapters;
			return registry && typeof registry.register === "function" ? registry : null;
		} catch (error) {
			return null;
		}
	}

	function waitForParentReportRegistry() {
		const current = parentReportRegistry();
		if (current) return Promise.resolve(current);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (registry) => {
				if (settled || !registry) return;
				settled = true;
				window.removeEventListener("inbox-issue-adapters-ready", onReady);
				window.removeEventListener("load", onLoad);
				resolve(registry);
			};
			function onReady() {
				finish(parentReportRegistry());
			}
			function onLoad() {
				finish(parentReportRegistry());
			}
			window.addEventListener("inbox-issue-adapters-ready", onReady);
			window.addEventListener("load", onLoad);
			// A registry that appeared with an already-dispatched load event is checked once here;
			// this is not a poll.
			if (document.readyState === "complete") finish(parentReportRegistry());
		});
	}

	async function openReport(itemId, opener) {
		ui.reportPick = itemId || null;
		if (reportEmbedded && reportRegistry && reportOptions) {
			try {
				registerReportAdapter();
			} catch (error) {
				console.error("thread: embedded report registration failed", error);
				reportRegistered = false;
				location.assign("/issues/new");
				return;
			}
		}
		if (reportUi) {
			await reportUi.open({ opener });
			return;
		}
		location.assign("/issues/new");
	}

	async function loadIssueBadge() {
		const badge = document.getElementById("issuesBadge");
		if (!badge) return;
		try {
			const res = await fetch("/api/issues?limit=1", { headers: { accept: "application/json", "x-inbox": "1" }, cache: "no-store" });
			if (!res.ok) return;
			const body = await res.json();
			const mod = await import("/web/issues.js");
			const data = mod.issueBadgeFromCounts(body && body.counts);
			badge.textContent = data.text;
			badge.hidden = data.hidden;
			badge.setAttribute("aria-label", data.label);
		} catch (error) {
			console.error("thread: issue badge failed", error);
		}
	}

	async function bootReporting() {
		reportEmbedded = document.documentElement.hasAttribute("data-embed");
		reportOptions = {
			page: "thread",
			getContext: reportContext,
			getTargets: reportTargets,
			deferRender: deferReportRender,
			resumeRender: resumeReportRender,
		};
		const parentRegistryReady = reportEmbedded ? waitForParentReportRegistry() : null;
		try {
			const [adapterMod, diagMod] = await Promise.all([import("/web/issue-adapters.js"), import("/web/issue-diagnostics.js")]);
			diagnostics = diagMod.createDiagnostics({ now: () => performance.now() });
			diagnostics.attachWindowListeners(window);
			if (reportEmbedded) {
				reportRegistry = await parentRegistryReady;
				if (!reportRegistry) throw new Error("parent registry is unavailable");
			} else {
				reportRegistry = adapterMod.createAdapterRegistry({ ownerWindow: window });
			}
			registerReportAdapter();
			if (reportEmbedded) claimReportAdapterAfterParentSetup();
			const [draftsMod, reportMod] = await Promise.all([
				import("/web/issue-drafts.js"),
				import("/web/issue-report.js"),
			]);
			let image = null;
			try {
				const imageMod = await import("/web/issue-image.js");
				image = imageMod.createIssueImage({ document, now: () => performance.now() });
			} catch (error) {
				console.error("thread: image editor unavailable", error);
			}
			let capabilities = null;
			try {
				const res = await fetch("/api/issues/capabilities", { headers: { accept: "application/json", "x-inbox": "1" } });
				if (res.ok) capabilities = await res.json();
			} catch (error) {
				console.error("thread: issue capabilities failed", error);
			}
			const build = metaBuild();
			reportUi = reportMod.mountIssueReport({
				document,
				window,
				adapters: reportRegistry,
				drafts: draftsMod,
				diagnostics,
				image,
				fetchImpl: (url, init) => window.fetch(url, init),
				now: () => Date.now(),
				uuid: () => crypto.randomUUID(),
				buildId: build ? build.digest : null,
				capabilities,
				pageKey: sid,
			});
			await reportUi.ready;
		} catch (error) {
			console.error("thread: issue reporting unavailable", error);
			reportUi = null;
		}
		loadIssueBadge();
	}

	// A page-level entry reports the page, not a message still picked from the last menu open.
	document.addEventListener("click", (event) => {
		const entry = event.target.closest("[data-issue-report]");
		if (entry) ui.reportPick = null;
	}, true);

	// The embedded page entry opens the reporter on the shared registry; its plain href stays for a failed registration.
	document.addEventListener("click", (event) => {
		const entry = event.target.closest("[data-issue-report]");
		if (!entry || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		if (reportEmbedded && reportRegistered) {
			event.preventDefault();
			void openReport(null, entry);
		}
	});

	window.addEventListener("pagehide", () => {
		if (reportSetupObserver) reportSetupObserver.disconnect();
		if (reportRegistry && reportHandle && typeof reportRegistry.unregister === "function") {
			try {
				reportRegistry.unregister(reportHandle);
			} catch {
				// the frame is going away
			}
		}
	});

	// ---------- wiring ----------

	els.progressToggle.addEventListener("click", () => {
		const on = els.progressToggle.getAttribute("aria-pressed") !== "true";
		recordAction("toggle_progress");
		try {
			localStorage.setItem(PROGRESS_KEY, on ? "on" : "off");
		} catch (error) {
			console.error("thread: progress setting not saved", error);
		}
		showProgress(on);
	});
	showProgress(storedProgress());
	document.getElementById("hideToggle").addEventListener("click", () => void toggleHidden());
	els.chat.addEventListener("click", onChatClick);
	els.chat.addEventListener("input", onChatInput);
	els.chat.addEventListener("change", onChatInput);
	// The reporter owns its clicks and Escape. Touching its interior must not dismiss the term
	// popover (which would also re-render the thread while reporting is active).
	function insideReporter(target) {
		const dialog = reportUi && reportUi.element;
		return Boolean(dialog && target && dialog.contains(target));
	}

	document.addEventListener("click", (event) => {
		if (ui.reporting || insideReporter(event.target)) return;
		if (event.target.closest("[data-action=\"report\"], [data-issue-report]")) return;
		if (ui.termOpen && !event.target.closest(".term, .term-pop")) closeTermPopover();
	});
	document.addEventListener("keydown", (event) => {
		if (ui.reporting || insideReporter(event.target)) return;
		if (event.key === "Escape" && ui.termOpen) closeTermPopover(true);
	});
	if ("speechSynthesis" in window) {
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible" && ui.listening && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
				const itemId = ui.listening;
				ui.listening = null;
				refreshItem(itemId);
			}
		});
	}
	els.retry.addEventListener("click", () => load());
	els.compose.addEventListener("submit", (event) => {
		event.preventDefault();
		sendComposer(els.reply.value, false);
	});
	els.reply.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
			event.preventDefault();
			sendComposer(els.reply.value, false);
		}
	});
	els.quick.addEventListener("click", (event) => {
		const button = event.target.closest("[data-quick]");
		if (button && !button.disabled) sendComposer(button.getAttribute("data-quick"), true);
	});
	els.nextActions.addEventListener("click", onNextClick);
	window.addEventListener("hashchange", () => {
		ui.hit = null;
		applyHash();
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			load();
			startTimer();
		} else {
			stopTimer();
		}
	});
	if ("ResizeObserver" in window) {
		new ResizeObserver(() => {
			document.documentElement.style.setProperty("--composer-h", `${Math.ceil(els.composer.getBoundingClientRect().height)}px`);
		}).observe(els.composer);
	}

	if (!sid) {
		els.chat.setAttribute("aria-busy", "false");
		showNotice("대화를 찾을 수 없습니다", false);
		return;
	}
	void bootReporting();
	load();
	if (document.visibilityState === "visible") startTimer();
})();
