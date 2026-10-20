/* Proposal page: board + marks + conversation + revisions. Served at /p/<id>, data from /api/p/<id>. */
(function () {
	"use strict";

	const POLL_MS = 3000;
	const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.esm.min.mjs";
	// htmlLabels must be false at the top level too: foreignObject labels taint the canvas and break crops.
	const MERMAID_CONFIG = {
		startOnLoad: false,
		htmlLabels: false,
		flowchart: { htmlLabels: false },
		securityLevel: "strict",
		suppressErrorRendering: true,
	};
	const MMD_PAD = 8;
	const CROP_PAD = 0.35;
	// Longest edge of an encoded crop. A big mark on a full-size screenshot must stay under the server's 5 MiB crop limit.
	const CROP_MAX_PX = 1600;
	const MIN_MARK_PX = 8;
	const DEFAULT_HEADERS = { "content-type": "application/json", "x-inbox": "1" };
	const EVENT_LABELS = { submitted: "제출", feedback: "내 의견", reply: "세션 답", revised: "고친 안", closed: "끝남" };
	const STATUS_LABELS = { mine: "🙋 내 차례", theirs: "🤖 처리 중", closed: "끝남" };
	const PROMPT_HEAD = [
		"나는 개발자다. 코딩 에이전트가 보여 준 Review를 보고 있고, 잘 모르는 부분을 물어보고 결정하려 한다.",
		"먼저 각 질문의 선택지 차이를 쉽게 설명하고 추천과 이유를 말해 줘. 내가 정하면 Review에 붙일 결론을 3줄 이내로 정리해 줘.",
		"",
	];
	const PROMPT_LEAD = "\n\n[도식 원본 - 그림은 Review에 있고 여기는 글로 된 원본]";

	const $ = (id) => document.getElementById(id);
	const el = {
		title: $("title"),
		threadLink: $("threadLink"),
		chips: $("chips"),
		lead: $("lead"),
		causeCard: $("causeCard"),
		cause: $("cause"),
		listenBtn: $("listenBtn"),
		restartBtn: $("restartBtn"),
		tabs: $("tabs"),
		loadError: $("loadError"),
		revBanner: $("revBanner"),
		revBannerText: $("revBannerText"),
		revBannerBtn: $("revBannerBtn"),
		closedBanner: $("closedBanner"),
		oldNote: $("oldNote"),
		sections: $("sections"),
		marksCard: $("marksCard"),
		marks: $("marks"),
		decideCard: $("decideCard"),
		side: $("side"),
		questions: $("questions"),
		commentWrap: $("commentWrap"),
		comment: $("comment"),
		sendRow: $("sendRow"),
		sendBtn: $("sendBtn"),
		approveBtn: $("approveBtn"),
		ackBtn: $("ackBtn"),
		status: $("status"),
		thread: $("thread"),
		fab: $("aiFab"),
		stopFab: $("stopFab"),
		panel: $("aiPanel"),
		targets: $("aiTargets"),
		aiMsg: $("aiMsg"),
		stage: $("mmdStage"),
		main: document.querySelector("main"),
		viewer: $("viewer"),
		vLabel: $("vLabel"),
		vDraw: $("vDraw"),
		vClose: $("vClose"),
		vStage: $("vStage"),
		vImg: $("vImg"),
		vCanvas: $("vCanvas"),
		vSheet: $("vSheet"),
		vNum: $("vNum"),
		vNote: $("vNote"),
		vDel: $("vDel"),
	};
	const theme = getComputedStyle(document.documentElement);
	const MARK_COLOR = theme.getPropertyValue("--mark").trim() || "#1463ff";
	const MARK_FILL = theme.getPropertyValue("--mark-fill").trim() || "rgba(20,99,255,0.10)";
	const MARK_TINT = theme.getPropertyValue("--mark-tint").trim() || "rgba(20,99,255,0.12)";
	const MIN_DIAGRAM_PX = Number.parseFloat(theme.getPropertyValue("--frame-min")) || 150;

	const idMatch = location.pathname.match(/^\/p\/([^/]+)/);
	const id = idMatch ? decodeURIComponent(idMatch[1]) : null;

	const state = {
		id,
		summary: null,
		revs: [],
		events: [],
		lastSeq: 0,
		latest: 0,
		rev: 0,
		readOnly: false,
		closed: false,
		outcome: null,
		boards: {},
		marks: [],
		caps: null,
		prompt: null,
		mermaid: null,
		bannerRev: null,
		// The full-screen frame viewer; scale is relative to the fitted picture, tx/ty place its top-left in the stage.
		viewer: { open: false, label: "", scale: 1, tx: 0, ty: 0, drawing: false, selected: null },
	};
	window.__vb = state;

	let pollTimer = null;
	let mmdCounter = 0;

	// ---------- helpers ----------

	function esc(value) {
		return String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
	}

	function encPath(rel) {
		return String(rel).split("/").map(encodeURIComponent).join("/");
	}

	function frameUrl(rev, rel) {
		return `/files/${encodeURIComponent(id)}/revs/${rev}/${encPath(rel)}`;
	}

	function cropUrl(rel) {
		return `/files/${encodeURIComponent(id)}/${encPath(rel)}`;
	}

	function ago(iso) {
		const t = Date.parse(iso);
		if (!Number.isFinite(t)) return "";
		const minutes = Math.floor(Math.max(0, Date.now() - t) / 60000);
		if (minutes < 1) return "방금";
		if (minutes < 60) return `${minutes}분 전`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}시간 전`;
		const days = Math.floor(hours / 24);
		if (days < 7) return `${days}일 전`;
		const at = new Date(t);
		return `${at.getMonth() + 1}월 ${at.getDate()}일`;
	}

	// Session start from the latest event with a session log file (<utc stamp>_<id>.jsonl), as local "M월 D일 HH:mm"; "" without one.
	function sessionStart() {
		const latest = [...state.events].reverse().find((ev) => ev.session && ev.session.file);
		if (!latest) return "";
		const stamp = String(latest.session.file).split(/[\\/]/).pop().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
		if (!stamp) return "";
		const [, y, mo, d, h, mi, s, ms] = stamp.map(Number);
		const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
		const two = (n) => String(n).padStart(2, "0");
		return `${at.getMonth() + 1}월 ${at.getDate()}일 ${two(at.getHours())}:${two(at.getMinutes())}`;
	}

	async function api(path, options) {
		const res = await fetch(path, { cache: "no-store", ...options });
		if (!res.ok) {
			const error = new Error(`${res.status} ${path}`);
			error.status = res.status;
			throw error;
		}
		return res.json();
	}

	async function fetchText(url, { optional = false } = {}) {
		let res;
		try {
			res = await fetch(url);
		} catch (error) {
			if (optional) return "";
			throw error;
		}
		if (!res.ok) {
			if (optional) return "";
			throw new Error(`${res.status} ${url}`);
		}
		return res.text();
	}

	function setStatus(text) {
		el.status.textContent = text;
	}

	function isReport() {
		return Boolean(state.summary && state.summary.kind === "report");
	}

	// Report boards call their revisions 갱신; decision boards keep 안.
	function revLabel(n) {
		return isReport() ? `갱신 ${n}` : `${n}안`;
	}

	function canMark() {
		return !state.readOnly && !state.closed;
	}

	function visibleMarks() {
		return state.marks.filter((mark) => mark.rev === state.rev);
	}

	function anyChecked() {
		return Boolean(el.questions.querySelector("input:checked"));
	}

	// ---------- header, tabs, banners ----------

	function chip(key, value, extraClass) {
		return `<span class="chip${extraClass ? ` ${extraClass}` : ""}"><i>${esc(key)}</i><span title="${esc(value)}">${esc(value)}</span></span>`;
	}

	function renderHeader() {
		const s = state.summary;
		document.title = s.title;
		el.title.textContent = s.title;
		const chips = [chip("제품", s.product.name || s.product.key), chip("기능", s.feature.branch)];
		if (isReport()) chips.push('<span class="chip">보고</span>');
		const started = sessionStart();
		if (started) chips.push(`<span class="chip">세션 ${esc(started)} 시작</span>`);
		chips.push(`<span class="chip status ${esc(s.status)}">${esc(STATUS_LABELS[s.status] || s.status)}</span>`);
		if (s.status === "theirs" && s.approved) chips.push('<span class="chip ok">승인</span>');
		el.chips.innerHTML = chips.join("");
		// The owning session's thread, when the board is bound to one; an ownerless board has no page to link to.
		if (el.threadLink) {
			const owner = s.owner ? String(s.owner) : "";
			el.threadLink.hidden = !owner;
			if (owner) el.threadLink.href = `/s/${encodeURIComponent(owner)}`;
		}
	}

	function renderTabs() {
		el.tabs.innerHTML = "";
		for (const r of state.revs) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "tab");
			button.setAttribute("aria-selected", String(r.n === state.rev));
			button.textContent = revLabel(r.n);
			button.addEventListener("click", () => selectRev(r.n));
			el.tabs.appendChild(button);
		}
	}

	function showRevBanner(n) {
		state.bannerRev = n;
		el.revBannerText.textContent = isReport() ? `갱신 ${n}이 올라왔습니다.` : `새 안(${n}안)이 올라왔습니다.`;
		el.revBanner.hidden = false;
	}

	function hideRevBanner() {
		state.bannerRev = null;
		el.revBanner.hidden = true;
	}

	function updateMode() {
		document.body.classList.toggle("readonly", state.readOnly);
		document.body.classList.toggle("closed", state.closed);
		el.oldNote.hidden = !state.readOnly;
		el.closedBanner.hidden = !state.closed;
		if (state.closed) el.closedBanner.textContent = state.outcome ? `끝남: ${state.outcome}` : "끝남";

		const inputsOn = canMark();
		const marks = visibleMarks();
		const typed = el.comment.value.trim() !== "";
		const formHasContent = typed || marks.length > 0 || anyChecked();

		el.decideCard.hidden = state.closed && !formHasContent;
		for (const input of el.questions.querySelectorAll("input")) input.disabled = !inputsOn;
		el.commentWrap.hidden = !inputsOn && !(state.closed && typed);
		el.comment.disabled = !inputsOn;
		el.sendRow.hidden = !inputsOn;
		const report = isReport();
		el.sendBtn.hidden = report;
		el.approveBtn.hidden = report;
		// A decision board's send row holds exactly 재요청/승인, so 확인 is not in its DOM at all.
		if (report) el.ackBtn.hidden = false;
		else el.ackBtn.remove();
		el.marksCard.hidden = !inputsOn && marks.length === 0;
		for (const node of el.marks.querySelectorAll("textarea,button")) node.disabled = !inputsOn;
		syncViewer();
	}

	// ---------- revisions and boards ----------

	async function loadBoard(rev) {
		if (state.boards[rev]) return state.boards[rev];
		let board;
		try {
			board = await api(frameUrl(rev, "board.json"));
		} catch (error) {
			console.error("board.json for revision", rev, error);
			board = { title: state.summary ? state.summary.title : "", sections: [], questions: [] };
		}
		state.boards[rev] = board;
		return board;
	}

	async function selectRev(wanted, { replace = true } = {}) {
		const n = state.revs.some((r) => r.n === wanted) ? wanted : state.latest;
		if (n === state.rev) return;
		stopListening();
		forgetListening();
		state.rev = n;
		state.readOnly = n !== state.latest;
		if (replace) {
			const url = new URL(location.href);
			url.searchParams.set("rev", String(n));
			history.replaceState(null, "", url);
		}
		if (state.bannerRev === n) hideRevBanner();
		await loadBoard(n);
		if (state.rev !== n) return;
		renderTabs();
		renderCause();
		renderDecide();
		renderMarks();
		updateMode();
		await renderBoard();
	}

	async function renderBoard() {
		const rev = state.rev;
		const board = state.boards[rev] || {};
		el.lead.textContent = board.lead || "";
		el.sections.innerHTML = "";
		const frames = [];
		const pending = [];
		for (const section of board.sections || []) {
			const group = document.createElement("section");
			group.className = "group";
			group.innerHTML = `<h2>${esc(section.title)}</h2>${section.desc ? `<p>${esc(section.desc)}</p>` : ""}`;
			for (const card of section.cards || []) {
				const node = document.createElement("div");
				node.className = "card";
				const badge = card.badge ? `<span class="badge${card.gray ? " gray" : ""}">${esc(card.badge)}</span>` : "";
				node.innerHTML =
					`<h3>${badge}${esc(card.title || "")}</h3>` +
					`<div class="frames ${esc(card.layout || "")}"></div>` +
					(card.note ? `<p class="note">${esc(card.note)}</p>` : "");
				const box = node.querySelector(".frames");
				for (const [label, rel] of card.frames || []) {
					const isMmd = /\.mmd$/i.test(rel);
					const wrap = document.createElement("div");
					wrap.className = `frame${card.diagram || isMmd ? " diagram" : ""}`;
					box.appendChild(wrap);
					frames.push({ section: section.title, label, rel });
					pending.push(isMmd ? mountMermaid(wrap, label, rev, rel) : mountImage(wrap, label, rev, rel));
				}
				group.appendChild(node);
			}
			el.sections.appendChild(group);
		}
		const sources = await Promise.all(pending);
		if (state.rev !== rev) return;
		state.prompt = buildPrompt(board, frames, sources);
	}

	function pillFor(label) {
		const pill = document.createElement("span");
		pill.className = "pill";
		pill.textContent = label;
		return pill;
	}

	function mountImage(wrap, label, rev, rel) {
		const img = new Image();
		img.alt = label;
		const canvas = document.createElement("canvas");
		wrap.append(img, canvas, pillFor(label));
		attach(wrap, label, img, canvas);
		img.src = frameUrl(rev, rel);
		if (/\.svg$/i.test(rel)) return fetchText(frameUrl(rev, rel.replace(/\.svg$/i, ".mmd")), { optional: true });
		return Promise.resolve("");
	}

	async function mountMermaid(wrap, label, rev, rel) {
		const pill = pillFor(label);
		wrap.appendChild(pill);
		let source = "";
		try {
			source = await fetchText(frameUrl(rev, rel));
			const rendered = await renderMermaid(source);
			if (!wrap.isConnected) return source;
			const img = new Image();
			img.alt = label;
			const canvas = document.createElement("canvas");
			wrap.insertBefore(img, pill);
			wrap.insertBefore(canvas, pill);
			attach(wrap, label, img, canvas);
			img.src = rendered;
		} catch (error) {
			console.error("mermaid frame", label, error);
			if (!wrap.isConnected) return source;
			wrap.classList.add("still", "plain");
			const note = document.createElement("p");
			note.className = "fallback";
			note.textContent = "그림을 그리지 못해 원문을 보여 줍니다.";
			const pre = document.createElement("pre");
			pre.textContent = source;
			wrap.insertBefore(note, pill);
			wrap.insertBefore(pre, pill);
		}
		return source;
	}

	function ensureMermaid() {
		if (!state.mermaid) {
			state.mermaid = import(MERMAID_URL).then((mod) => {
				const mermaid = mod.default || mod;
				mermaid.initialize(MERMAID_CONFIG);
				return mermaid;
			});
			state.mermaid.catch(() => {
				// a failed load is reported per frame; allow a retry on the next frame
				state.mermaid = null;
			});
		}
		return state.mermaid;
	}

	async function renderMermaid(source) {
		const mermaid = await ensureMermaid();
		mmdCounter += 1;
		const { svg } = await mermaid.render(`inbox-mmd-${mmdCounter}`, source);
		el.stage.innerHTML = svg;
		const root = el.stage.querySelector("svg");
		if (!root) throw new Error("mermaid returned no svg");
		// Explicit viewBox/width/height from the real bbox: without them the last ER row is clipped and naturalWidth is 0.
		const box = root.getBBox();
		const width = Math.ceil(box.width + MMD_PAD * 2);
		const height = Math.ceil(box.height + MMD_PAD * 2);
		root.setAttribute("viewBox", `${box.x - MMD_PAD} ${box.y - MMD_PAD} ${width} ${height}`);
		root.setAttribute("width", String(width));
		root.setAttribute("height", String(height));
		root.removeAttribute("style");
		root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
		const text = new XMLSerializer().serializeToString(root);
		el.stage.innerHTML = "";
		return URL.createObjectURL(new Blob([text], { type: "image/svg+xml;charset=utf-8" }));
	}

	// ---------- marks ----------

	function drawMark(c, x, y, w, h, n, scale) {
		const s = scale || 1;
		const r = 11 * s;
		c.save();
		c.fillStyle = MARK_FILL;
		c.fillRect(x, y, w, h);
		c.setLineDash([]);
		c.lineWidth = 6 * s;
		c.strokeStyle = "rgba(255,255,255,0.95)";
		c.strokeRect(x, y, w, h);
		c.setLineDash([10 * s, 6 * s]);
		c.lineWidth = 3 * s;
		c.strokeStyle = MARK_COLOR;
		c.strokeRect(x, y, w, h);
		if (n) {
			c.setLineDash([]);
			c.beginPath();
			c.arc(x, y, r + 2 * s, 0, Math.PI * 2);
			c.fillStyle = "#fff";
			c.fill();
			c.beginPath();
			c.arc(x, y, r, 0, Math.PI * 2);
			c.fillStyle = MARK_COLOR;
			c.fill();
			c.fillStyle = "#fff";
			c.font = `bold ${Math.round(12 * s)}px sans-serif`;
			c.textAlign = "center";
			c.textBaseline = "middle";
			c.fillText(String(n), x, y + 0.5);
		}
		c.restore();
	}

	function attach(wrap, label, img, canvas) {
		const ctx = canvas.getContext("2d");
		const diagram = wrap.classList.contains("diagram");
		let start = null;
		let cur = null;
		// Pointer-down position in client px, for telling a tap from a drag; tapped carries a tap from pointerup to the click that follows.
		let down = null;
		let tapped = false;
		function size() {
			if (diagram) {
				// Measure at fit width first; a diagram shorter than the frame minimum is shown at that height and scrolls sideways.
				wrap.classList.remove("wide");
				wrap.classList.toggle("wide", img.getBoundingClientRect().height < MIN_DIAGRAM_PX);
			}
			const r = img.getBoundingClientRect();
			const b = wrap.getBoundingClientRect();
			// The canvas sits in the frame's scrolled content, so its offset includes the frame's scroll position.
			canvas.style.left = `${r.left - b.left + wrap.scrollLeft}px`;
			canvas.style.top = `${r.top - b.top + wrap.scrollTop}px`;
			canvas.style.width = `${r.width}px`;
			canvas.style.height = `${r.height}px`;
			canvas.width = Math.round(r.width);
			canvas.height = Math.round(r.height);
			redraw();
		}
		function pos(e) {
			const b = canvas.getBoundingClientRect();
			return {
				x: Math.max(0, Math.min(canvas.width, e.clientX - b.left)),
				y: Math.max(0, Math.min(canvas.height, e.clientY - b.top)),
			};
		}
		function redraw() {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			visibleMarks().forEach((m, i) => {
				if (m.frame === label) drawMark(ctx, m.x * canvas.width, m.y * canvas.height, m.w * canvas.width, m.h * canvas.height, i + 1);
			});
			if (start && cur) {
				drawMark(ctx, Math.min(start.x, cur.x), Math.min(start.y, cur.y), Math.abs(cur.x - start.x), Math.abs(cur.y - start.y), 0);
			}
		}
		wrap._redraw = redraw;
		wrap._size = size;
		img.addEventListener("load", size);
		if (img.complete && img.naturalWidth) size();
		canvas.addEventListener("pointerdown", (e) => {
			tapped = false;
			// a second finger is a gesture, not a tap
			down = down && down.id !== e.pointerId ? null : { id: e.pointerId, x: e.clientX, y: e.clientY };
			// touch never draws inline: the finger scrolls the page, a tap opens the viewer
			if (e.pointerType === "touch" || !canMark() || !down) return;
			if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
			start = pos(e);
			cur = start;
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!start) return;
			cur = pos(e);
			redraw();
		});
		canvas.addEventListener("pointerup", (e) => {
			const tap = down && down.id === e.pointerId && Math.max(Math.abs(e.clientX - down.x), Math.abs(e.clientY - down.y)) < MIN_MARK_PX;
			down = null;
			if (tap) {
				start = null;
				cur = null;
				redraw();
				tapped = true;
				return;
			}
			if (!start) return;
			const end = pos(e);
			const x = Math.min(start.x, end.x);
			const y = Math.min(start.y, end.y);
			const w = Math.abs(end.x - start.x);
			const h = Math.abs(end.y - start.y);
			start = null;
			cur = null;
			if (w < MIN_MARK_PX || h < MIN_MARK_PX) {
				redraw();
				return;
			}
			state.marks.push({
				rev: state.rev,
				frame: label,
				x: x / canvas.width,
				y: y / canvas.height,
				w: w / canvas.width,
				h: h / canvas.height,
				comment: "",
				img,
			});
			redrawAll();
			renderMarks();
			updateMode();
		});
		canvas.addEventListener("pointercancel", () => {
			down = null;
			start = null;
			cur = null;
			redraw();
		});
		// Open on click, which comes after pointerup: the viewer then cannot receive the touch's compatibility events.
		canvas.addEventListener("click", () => {
			if (!tapped) return;
			tapped = false;
			openViewer(label, img, diagram);
		});
	}

	function redrawAll() {
		for (const wrap of document.querySelectorAll(".frame")) if (wrap._redraw) wrap._redraw();
	}

	function resizeAll() {
		for (const wrap of document.querySelectorAll(".frame")) if (wrap._size) wrap._size();
	}

	function cropOf(mark, n) {
		const img = mark.img;
		const W = img.naturalWidth || img.width;
		const H = img.naturalHeight || img.height;
		if (!W || !H) return null;
		const sx = Math.max(0, (mark.x - mark.w * CROP_PAD) * W);
		const sy = Math.max(0, (mark.y - mark.h * CROP_PAD) * H);
		const sw = Math.min(W - sx, mark.w * (1 + 2 * CROP_PAD) * W);
		const sh = Math.min(H - sy, mark.h * (1 + 2 * CROP_PAD) * H);
		const k = Math.min(1, CROP_MAX_PX / Math.max(sw, sh));
		const c = document.createElement("canvas");
		c.width = Math.max(1, Math.round(sw * k));
		c.height = Math.max(1, Math.round(sh * k));
		const g = c.getContext("2d");
		g.fillStyle = "#fff";
		g.fillRect(0, 0, c.width, c.height);
		try {
			g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
			drawMark(g, (mark.x * W - sx) * k, (mark.y * H - sy) * k, mark.w * W * k, mark.h * H * k, n, Math.max(1, (W * k) / 1280));
			return c.toDataURL("image/png");
		} catch (error) {
			console.error("crop failed", mark.frame, error);
			return null;
		}
	}

	function removeMark(mark) {
		const at = state.marks.indexOf(mark);
		if (at !== -1) state.marks.splice(at, 1);
		redrawAll();
		renderMarks();
		updateMode();
	}

	function renderMarks() {
		const list = visibleMarks();
		if (!list.length) {
			el.marks.innerHTML = '<p class="empty">아직 표시한 곳이 없습니다.</p>';
			return;
		}
		el.marks.innerHTML = "";
		list.forEach((mark, i) => {
			mark.crop = cropOf(mark, i + 1);
			const item = document.createElement("div");
			item.className = "mark";
			const picture = mark.crop ? `<img alt="표시 ${i + 1}" src="${mark.crop}">` : '<div class="nocrop"></div>';
			item.innerHTML =
				`${picture}<div><b><span class="num">${i + 1}</span>${esc(mark.frame)}</b>` +
				'<textarea placeholder="의견"></textarea></div>' +
				'<button class="del" type="button">지우기</button>';
			const textarea = item.querySelector("textarea");
			textarea.value = mark.comment;
			// the viewer's comment field writes through to this one
			mark.listNote = textarea;
			textarea.addEventListener("input", () => {
				mark.comment = textarea.value;
			});
			item.querySelector(".del").addEventListener("click", () => removeMark(mark));
			el.marks.appendChild(item);
		});
	}

	// ---------- viewer ----------

	const VIEW_MAX_SCALE = 8;
	const VIEW_HIT_SLOP = 6;
	const WHEEL_STEP = 0.0015;
	const WHEEL_PINCH_STEP = 0.01;
	const vv = state.viewer;
	const vctx = el.vCanvas.getContext("2d");
	// Pointers down on the stage, by id, in stage px.
	const vpoints = new Map();
	// The picture fitted to the stage at scale 1, and the stage itself, both in CSS px.
	const vpicture = { w: 0, h: 0 };
	const vsize = { w: 0, h: 0 };
	let vsource = null;
	// null | { type: "pan", last } | { type: "draw", start, cur } | { type: "pinch", d0, s0, px, py }
	let vgesture = null;
	let vtap = null;
	let vopener = null;
	let vtoken = 0;
	// The mark whose comment the sheet's field holds.
	let vnoted = null;

	function vNatural() {
		const rect = vsource.getBoundingClientRect();
		return { w: vsource.naturalWidth || rect.width || 1, h: vsource.naturalHeight || rect.height || 1 };
	}

	// Keep the picture on screen: centered on an axis where it is smaller than the stage, edge to edge where it is larger.
	function vClamp() {
		const iw = vpicture.w * vv.scale;
		const ih = vpicture.h * vv.scale;
		vv.tx = iw <= vsize.w ? (vsize.w - iw) / 2 : Math.min(0, Math.max(vsize.w - iw, vv.tx));
		vv.ty = ih <= vsize.h ? (vsize.h - ih) / 2 : Math.min(0, Math.max(vsize.h - ih, vv.ty));
	}

	function vLayout(fresh) {
		const r = el.vStage.getBoundingClientRect();
		if (!r.width || !r.height) return;
		// keep the picture point at the stage center fixed across a resize or rotation
		const keep = !fresh && vpicture.w ? { x: (vsize.w / 2 - vv.tx) / (vpicture.w * vv.scale), y: (vsize.h / 2 - vv.ty) / (vpicture.h * vv.scale) } : { x: 0.5, y: 0.5 };
		vsize.w = r.width;
		vsize.h = r.height;
		const nat = vNatural();
		const fit = Math.min(r.width / nat.w, r.height / nat.h);
		vpicture.w = nat.w * fit;
		vpicture.h = nat.h * fit;
		el.vImg.style.width = `${vpicture.w}px`;
		el.vImg.style.height = `${vpicture.h}px`;
		vv.tx = vsize.w / 2 - keep.x * vpicture.w * vv.scale;
		vv.ty = vsize.h / 2 - keep.y * vpicture.h * vv.scale;
		vClamp();
		const dpr = window.devicePixelRatio || 1;
		el.vCanvas.width = Math.round(r.width * dpr);
		el.vCanvas.height = Math.round(r.height * dpr);
		el.vCanvas.style.width = `${r.width}px`;
		el.vCanvas.style.height = `${r.height}px`;
		vRender();
	}

	function vPoint(e) {
		const b = el.vStage.getBoundingClientRect();
		return { x: e.clientX - b.left, y: e.clientY - b.top };
	}

	// The box between two stage points, clipped to the picture, in stage px.
	function vBox(a, b) {
		const x0 = Math.max(Math.min(a.x, b.x), vv.tx);
		const y0 = Math.max(Math.min(a.y, b.y), vv.ty);
		const x1 = Math.min(Math.max(a.x, b.x), vv.tx + vpicture.w * vv.scale);
		const y1 = Math.min(Math.max(a.y, b.y), vv.ty + vpicture.h * vv.scale);
		return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
	}

	// Marks of the open frame, numbered like the inline canvases and the list: by position among this revision's marks.
	function vFrameMarks() {
		const entries = [];
		visibleMarks().forEach((mark, i) => {
			if (mark.frame === vv.label) entries.push({ mark, n: i + 1 });
		});
		return entries;
	}

	function vRect(mark) {
		const w = vpicture.w * vv.scale;
		const h = vpicture.h * vv.scale;
		return { x: vv.tx + mark.x * w, y: vv.ty + mark.y * h, w: mark.w * w, h: mark.h * h };
	}

	// The selected box's number, comment and 지우기 sit in a sheet at the bottom of the viewer.
	function vSyncSheet() {
		const entry = vv.selected && canMark() ? vFrameMarks().find((item) => item.mark === vv.selected) : null;
		el.vSheet.hidden = !entry;
		if (!entry) {
			vnoted = null;
			if (document.activeElement === el.vNote) el.viewer.focus({ preventScroll: true });
			return;
		}
		el.vNum.textContent = String(entry.n);
		if (vnoted !== entry.mark) {
			vnoted = entry.mark;
			el.vNote.value = entry.mark.comment;
		}
	}

	// The on-screen keyboard shrinks the visual viewport, not the layout one: lift the sheet by the height it covers.
	function vLift() {
		const v = window.visualViewport;
		const covered = v && Math.abs(v.scale - 1) < 0.01 ? window.innerHeight - v.height - v.offsetTop : 0;
		el.vSheet.style.bottom = `${Math.max(0, covered)}px`;
	}

	function vRender() {
		if (!vv.open) return;
		el.vImg.style.transform = `translate(${vv.tx}px, ${vv.ty}px) scale(${vv.scale})`;
		const dpr = window.devicePixelRatio || 1;
		vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		vctx.clearRect(0, 0, vsize.w, vsize.h);
		const entries = vFrameMarks();
		if (vv.selected && !entries.some((entry) => entry.mark === vv.selected)) vv.selected = null;
		for (const { mark, n } of entries) {
			const r = vRect(mark);
			if (mark === vv.selected) {
				vctx.fillStyle = MARK_TINT;
				vctx.fillRect(r.x, r.y, r.w, r.h);
			}
			drawMark(vctx, r.x, r.y, r.w, r.h, n);
		}
		if (vgesture && vgesture.type === "draw") {
			const b = vBox(vgesture.start, vgesture.cur);
			drawMark(vctx, b.x, b.y, b.w, b.h, 0);
		}
		vSyncSheet();
	}

	// Called from updateMode: the draw toggle and delete exist only while the proposal accepts marks.
	function syncViewer() {
		if (!vv.open) return;
		const can = canMark();
		if (!can) vv.drawing = false;
		el.vDraw.hidden = !can;
		el.vDraw.setAttribute("aria-pressed", String(vv.drawing));
		el.vStage.classList.toggle("drawing", vv.drawing);
		vRender();
	}

	function openViewer(label, source, diagram) {
		if (vv.open) return;
		vsource = source;
		vopener = document.activeElement;
		Object.assign(vv, { open: true, label, scale: 1, tx: 0, ty: 0, drawing: false, selected: null });
		vpoints.clear();
		vgesture = null;
		vtap = null;
		el.vLabel.textContent = label;
		el.vLabel.title = label;
		el.viewer.classList.toggle("light", diagram);
		el.vImg.alt = label;
		el.vImg.src = source.currentSrc || source.src;
		el.viewer.hidden = false;
		document.body.classList.add("viewer-open");
		for (const node of [el.main, el.fab, el.stopFab, el.panel]) node.inert = true;
		vtoken += 1;
		history.pushState({ vbViewer: vtoken }, "", location.href);
		vLayout(true);
		syncViewer();
		el.viewer.focus({ preventScroll: true });
	}

	// Closing by button also steps back over the history entry opening pushed, but only while that entry is still current.
	function closeViewer({ popped = false } = {}) {
		if (!vv.open) return;
		Object.assign(vv, { open: false, drawing: false, selected: null });
		vpoints.clear();
		vgesture = null;
		vtap = null;
		vsource = null;
		el.viewer.hidden = true;
		el.vImg.removeAttribute("src");
		document.body.classList.remove("viewer-open");
		for (const node of [el.main, el.fab, el.stopFab, el.panel]) node.inert = false;
		if (vopener && vopener.isConnected && vopener !== document.body) vopener.focus({ preventScroll: true });
		vopener = null;
		if (!popped && history.state && history.state.vbViewer === vtoken) history.back();
	}

	function vSelectAt(p) {
		if (!canMark()) return;
		let hit = null;
		let best = Infinity;
		for (const { mark } of vFrameMarks()) {
			const r = vRect(mark);
			if (p.x < r.x - VIEW_HIT_SLOP || p.x > r.x + r.w + VIEW_HIT_SLOP || p.y < r.y - VIEW_HIT_SLOP || p.y > r.y + r.h + VIEW_HIT_SLOP) continue;
			if (r.w * r.h < best) {
				best = r.w * r.h;
				hit = mark;
			}
		}
		vv.selected = hit;
	}

	// A finished drag becomes a mark exactly like an inline one: normalized to the picture, then the same list and mode updates.
	function vFinishDraw(a, b) {
		const box = vBox(a, b);
		if (box.w < MIN_MARK_PX || box.h < MIN_MARK_PX) return null;
		const w = vpicture.w * vv.scale;
		const h = vpicture.h * vv.scale;
		const mark = {
			rev: state.rev,
			frame: vv.label,
			x: (box.x - vv.tx) / w,
			y: (box.y - vv.ty) / h,
			w: box.w / w,
			h: box.h / h,
			comment: "",
			img: vsource,
		};
		state.marks.push(mark);
		// one 표시하기 press draws one box; the new box is selected so its comment can be written right away
		vv.drawing = false;
		vv.selected = mark;
		redrawAll();
		renderMarks();
		updateMode();
		return mark;
	}

	function vPinchFrom() {
		const [a, b] = [...vpoints.values()];
		const mx = (a.x + b.x) / 2;
		const my = (a.y + b.y) / 2;
		return { mx, my, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
	}

	function vEnd(e) {
		if (!vpoints.has(e.pointerId)) return;
		const p = vPoint(e);
		const up = e.type === "pointerup";
		const tap = up && vtap && vtap.id === e.pointerId && Math.max(Math.abs(p.x - vtap.x), Math.abs(p.y - vtap.y)) < MIN_MARK_PX;
		const drawing = up && vgesture && vgesture.type === "draw" ? vgesture : null;
		vpoints.delete(e.pointerId);
		vtap = null;
		// one finger left after a pinch pans; it never starts a box mid-gesture
		vgesture = vpoints.size ? { type: "pan", last: [...vpoints.values()][0] } : null;
		const made = !tap && drawing ? vFinishDraw(drawing.start, p) : null;
		if (tap) vSelectAt(p);
		vRender();
		// with a mouse the keyboard is already there; on a phone the field waits for a tap instead of raising the keyboard
		if (made && e.pointerType === "mouse") el.vNote.focus({ preventScroll: true });
	}

	function vZoomAt(x, y, scale, px, py) {
		vv.scale = Math.min(VIEW_MAX_SCALE, Math.max(1, scale));
		vv.tx = x - px * vv.scale;
		vv.ty = y - py * vv.scale;
		vClamp();
	}

	el.vStage.addEventListener("pointerdown", (e) => {
		if (e.pointerType === "mouse" && e.button !== 0) return;
		if (vpoints.size >= 2) return;
		el.vStage.setPointerCapture(e.pointerId);
		const p = vPoint(e);
		vpoints.set(e.pointerId, p);
		if (vpoints.size === 1) {
			vtap = { id: e.pointerId, x: p.x, y: p.y };
			vgesture = vv.drawing && canMark() ? { type: "draw", start: p, cur: p } : { type: "pan", last: p };
		} else {
			// a second finger turns whatever was going on into a pinch
			vtap = null;
			const from = vPinchFrom();
			vgesture = { type: "pinch", d0: from.d, s0: vv.scale, px: (from.mx - vv.tx) / vv.scale, py: (from.my - vv.ty) / vv.scale };
		}
		vRender();
	});
	el.vStage.addEventListener("pointermove", (e) => {
		if (!vpoints.has(e.pointerId)) return;
		const p = vPoint(e);
		vpoints.set(e.pointerId, p);
		if (vtap && vtap.id === e.pointerId && Math.max(Math.abs(p.x - vtap.x), Math.abs(p.y - vtap.y)) >= MIN_MARK_PX) vtap = null;
		if (!vgesture) return;
		if (vgesture.type === "pinch") {
			const from = vPinchFrom();
			vZoomAt(from.mx, from.my, (vgesture.s0 * from.d) / vgesture.d0, vgesture.px, vgesture.py);
		} else if (vgesture.type === "pan") {
			vv.tx += p.x - vgesture.last.x;
			vv.ty += p.y - vgesture.last.y;
			vgesture.last = p;
			vClamp();
		} else {
			vgesture.cur = p;
		}
		vRender();
	});
	el.vStage.addEventListener("pointerup", vEnd);
	el.vStage.addEventListener("pointercancel", vEnd);
	el.vStage.addEventListener(
		"wheel",
		(e) => {
			e.preventDefault();
			const p = vPoint(e);
			const unit = e.deltaMode === 1 ? 16 : 1;
			const k = Math.exp(-e.deltaY * unit * (e.ctrlKey ? WHEEL_PINCH_STEP : WHEEL_STEP));
			vZoomAt(p.x, p.y, vv.scale * k, (p.x - vv.tx) / vv.scale, (p.y - vv.ty) / vv.scale);
			vRender();
		},
		{ passive: false },
	);
	el.vDraw.addEventListener("click", () => {
		vv.drawing = !vv.drawing;
		syncViewer();
	});
	el.vClose.addEventListener("click", () => closeViewer());
	el.vNote.addEventListener("input", () => {
		const mark = vv.selected;
		if (!mark) return;
		mark.comment = el.vNote.value;
		if (mark.listNote) mark.listNote.value = mark.comment;
	});
	if (window.visualViewport) {
		window.visualViewport.addEventListener("resize", vLift);
		window.visualViewport.addEventListener("scroll", vLift);
	}
	el.vDel.addEventListener("click", () => {
		const mark = vv.selected;
		vv.selected = null;
		if (mark) removeMark(mark);
	});
	window.addEventListener("popstate", () => closeViewer({ popped: true }));
	document.addEventListener("keydown", (e) => {
		if (!vv.open || e.key !== "Escape") return;
		e.preventDefault();
		closeViewer();
	});

	// ---------- read aloud ----------

	// Short pieces: Chrome cuts off a long utterance, and 멈추기 then acts at once.
	const SAY_MAX = 160;
	// The run in progress; a stopped or replaced run ignores its late utterance events.
	let reading = null;
	// Where a run stopped partway ({ rev, at, text } of the piece being read), so the next 듣기 goes on from there.
	let resumeAt = null;

	// Sentences joined for the ear: each piece ends with a full stop unless it already ends a sentence.
	function spoken(...pieces) {
		return pieces
			.filter(Boolean)
			.map((piece) => String(piece).trim())
			.filter(Boolean)
			.map((piece) => (/[.!?。]$/.test(piece) ? piece : `${piece}.`))
			.join(" ");
	}

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

	// A row of 이 안이 나온 이유 for the ear: who, then what was said. A revise without a note says nothing.
	function spokenEvent(ev) {
		if (ev.type === "feedback") {
			const marks = (ev.marks || []).map((mark) => mark.comment);
			return spoken("내 의견", ...answerLines(ev), ev.comment, ...marks);
		}
		if (ev.type === "reply") return spoken("세션 답", ev.text);
		return ev.note ? spoken("바뀐 점", ev.note) : "";
	}

	// What 듣기 reads, in order, each with the node to outline and bring into view while it is read.
	function listenParts() {
		const board = state.boards[state.rev] || {};
		const parts = [];
		const newest = state.events[state.events.length - 1];
		if (newest && newest.type === "reply" && newest.text) parts.push({ text: spoken("세션 답", newest.text), node: null });
		for (const ev of causeEvents()) {
			const text = spokenEvent(ev);
			if (text) parts.push({ text, node: el.causeCard });
		}
		parts.push({ text: spoken(state.summary.title), node: el.title });
		if (board.lead) parts.push({ text: spoken(board.lead), node: el.lead });
		const groups = el.sections.querySelectorAll("section.group");
		(board.sections || []).forEach((section, si) => {
			const group = groups[si] || null;
			parts.push({ text: spoken(section.title, section.desc), node: group });
			const cards = group ? group.querySelectorAll(".card") : [];
			(section.cards || []).forEach((card, ci) => {
				const text = spoken(card.title, card.say || card.note);
				if (text) parts.push({ text, node: cards[ci] || group });
			});
		});
		(board.questions || []).forEach((q, qi) => {
			parts.push({ text: spoken(`질문 ${qi + 1}`, q.text, q.help), node: el.decideCard });
			q.options.forEach((o, oi) => {
				parts.push({ text: spoken(`${oi + 1}번, ${o.label}${o.rec ? ", 추천" : ""}`, o.why), node: el.decideCard });
			});
		});
		parts.push({ text: "여기까지입니다.", node: null });
		return parts;
	}

	function markReading(node) {
		for (const old of document.querySelectorAll(".reading")) old.classList.remove("reading");
		if (!node) return;
		node.classList.add("reading");
		if (document.visibilityState === "visible") node.scrollIntoView({ block: "center", behavior: "smooth" });
	}

	// The title-bar button turns into 멈추기, and the floating 멈추기 stays on screen while the page scrolls card by card.
	// Stopped partway, it offers 이어 듣기 and 처음부터 instead of 듣기.
	function setListening(on) {
		el.listenBtn.textContent = on ? "멈추기" : resumeAt ? "이어 듣기" : "듣기";
		el.listenBtn.setAttribute("aria-pressed", String(on));
		el.restartBtn.hidden = on || !resumeAt;
		el.stopFab.hidden = !on;
	}

	// Stops the run and remembers the piece it was on; the run's own end forgets it instead.
	function stopListening() {
		if (!reading) return;
		const run = reading;
		reading = null;
		resumeAt = run.at > 0 ? { rev: state.rev, at: run.at, text: run.texts[run.at] } : null;
		window.speechSynthesis.cancel();
		markReading(null);
		setListening(false);
	}

	function forgetListening() {
		resumeAt = null;
		if (!reading) setListening(false);
	}

	// The device's own voice: its default Korean voice when it has one; otherwise the engine picks one for ko-KR.
	function koreanVoice() {
		const voices = window.speechSynthesis.getVoices().filter((v) => /^ko\b/i.test(String(v.lang).replace("_", "-")));
		return voices.find((v) => v.default) || voices.find((v) => v.localService) || voices[0] || null;
	}

	function startListening({ fromTop = false } = {}) {
		if (!state.summary) return;
		const synth = window.speechSynthesis;
		if (synth.speaking || synth.pending) synth.cancel();
		if (synth.paused) synth.resume();
		const run = { at: 0, texts: [] };
		reading = run;
		const voice = koreanVoice();
		const queue = [];
		for (const part of listenParts()) {
			for (const text of sayChunks(part.text)) {
				const index = queue.length;
				const utterance = new SpeechSynthesisUtterance(text);
				utterance.lang = "ko-KR";
				if (voice) utterance.voice = voice;
				utterance.onstart = () => {
					if (reading !== run) return;
					run.at = index;
					markReading(part.node);
				};
				utterance.onerror = (e) => {
					if (reading !== run || e.error === "interrupted" || e.error === "canceled") return;
					console.error("read aloud", e.error);
					stopListening();
				};
				queue.push(utterance);
				run.texts.push(text);
			}
		}
		queue[queue.length - 1].onend = () => {
			if (reading !== run) return;
			run.at = 0;
			stopListening();
		};
		// Go on from the stopped piece; if new events shifted the pieces, find it by its text, else start over.
		let from = 0;
		if (!fromTop && resumeAt && resumeAt.rev === state.rev) {
			from = run.texts[resumeAt.at] === resumeAt.text ? resumeAt.at : Math.max(0, run.texts.indexOf(resumeAt.text));
		}
		run.at = from;
		resumeAt = null;
		setListening(true);
		for (const utterance of queue.slice(from)) synth.speak(utterance);
	}

	// ---------- questions and comment ----------

	function renderDecide() {
		const board = state.boards[state.rev] || {};
		const heading = el.decideCard.querySelector("h3");
		if (heading) heading.textContent = isReport() ? "확인" : "정할 것";
		el.side.hidden = !board.sideSession;
		el.side.textContent = board.sideSession || "";
		el.questions.innerHTML = "";
		for (const q of isReport() ? [] : board.questions || []) {
			const node = document.createElement("div");
			node.className = "q";
			const options = (q.options || [])
				.map(
					(o) =>
						`<label><input type="radio" name="q_${esc(q.id)}" value="${esc(o.value)}"><span>${esc(o.label)}` +
						`${o.rec ? ' <span class="rec">추천</span>' : ""}</span>${o.why ? `<span class="why">${esc(o.why)}</span>` : ""}</label>`,
				)
				.join("");
			node.innerHTML = `<b>${esc(q.text)}</b>${q.help ? `<p class="qhelp">${esc(q.help)}</p>` : ""}<div class="opts">${options}</div>`;
			el.questions.appendChild(node);
		}
		el.comment.placeholder = board.commentPlaceholder || "전체 의견";
	}

	// ---------- conversation ----------

	function answerLines(ev) {
		const board = state.boards[ev.rev] || {};
		const questions = board.questions || [];
		return Object.entries(ev.answers || {}).map(([qid, value]) => {
			const question = questions.find((q) => q.id === qid);
			const option = question && (question.options || []).find((o) => o.value === value);
			return `${question ? question.text : qid}: ${option ? option.label : value}`;
		});
	}

	function eventNode(ev) {
		const li = document.createElement("li");
		li.className = `ev ${esc(ev.type)}`;
		li.dataset.seq = String(ev.seq);
		let extra = "";
		let body = "";
		if (ev.type === "submitted" || ev.type === "revised") {
			extra = `<span class="tag">${revLabel(ev.rev)}</span>`;
			body = ev.note ? esc(ev.note) : "";
		} else if (ev.type === "feedback") {
			extra = `<span class="tag">${revLabel(ev.rev)}</span>${ev.verdict === "approve" ? '<span class="verdict approve">승인</span>' : ""}`;
			const answers = answerLines(ev);
			if (answers.length) body += `<ul>${answers.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
			if (ev.comment) body += esc(ev.comment);
			const marks = ev.marks || [];
			if (marks.length) {
				body += `<div class="crops">${marks
					.map((mark) => {
						const caption = `<span class="num">${mark.n}</span>${esc(mark.frame)}${mark.comment ? ` ${esc(mark.comment)}` : ""}`;
						const picture = mark.crop ? `<img alt="표시 ${mark.n}" src="${cropUrl(mark.crop)}">` : "";
						return `<figure>${picture}<figcaption>${caption}</figcaption></figure>`;
					})
					.join("")}</div>`;
			}
		} else if (ev.type === "reply") {
			body = esc(ev.text || "");
		} else if (ev.type === "closed") {
			body = ev.summary ? esc(ev.summary) : "";
		}
		li.innerHTML =
			`<div class="evh"><span class="who">${esc(EVENT_LABELS[ev.type] || ev.type)}</span>${extra}` +
			`<span class="when" title="${esc(ev.at || "")}">${esc(ago(ev.at))}</span></div><div class="evb">${body}</div>`;
		return li;
	}

	function renderThread() {
		el.thread.innerHTML = "";
		for (const ev of state.events) el.thread.appendChild(eventNode(ev));
	}

	function appendEvents(list) {
		for (const ev of list) el.thread.appendChild(eventNode(ev));
	}

	// ---------- why this revision ----------

	// What led to the revision on screen, in order: the feedback and replies after the previous revision opened, then its revise event.
	// Nothing for revision 1, or when nothing was said before it and its revise note is empty.
	function causeEvents() {
		const n = state.rev;
		if (n < 2) return [];
		const opened = state.events.findIndex((ev) => (ev.type === "submitted" || ev.type === "revised") && ev.rev === n - 1);
		const revised = state.events.findIndex((ev) => ev.type === "revised" && ev.rev === n);
		if (revised === -1) return [];
		const said = state.events.slice(opened + 1, revised).filter((ev) => ev.type === "feedback" || ev.type === "reply");
		if (!said.length && !state.events[revised].note) return [];
		return [...said, state.events[revised]];
	}

	// The card's rows are 대화 rows. Feedback rows name questions and options from the board they answered, so that board is loaded first.
	async function renderCause() {
		const n = state.rev;
		const rows = causeEvents();
		if (!rows.length) {
			el.causeCard.hidden = true;
			return;
		}
		if (!state.boards[n - 1]) await loadBoard(n - 1);
		if (state.rev !== n) return;
		const heading = el.causeCard.querySelector("h3");
		if (heading) heading.textContent = isReport() ? "이 갱신이 나온 이유" : "이 안이 나온 이유";
		el.cause.innerHTML = "";
		for (const ev of rows) el.cause.appendChild(eventNode(ev));
		el.causeCard.hidden = false;
	}

	// ---------- data flow ----------

	function absorb(data) {
		state.summary = data.summary;
		state.revs = data.revs;
		state.latest = data.summary.rev;
		const fresh = [];
		for (const ev of data.events) {
			if (ev.seq <= state.lastSeq) continue;
			state.events.push(ev);
			state.lastSeq = ev.seq;
			fresh.push(ev);
		}
		return fresh;
	}

	function applyFresh(fresh) {
		appendEvents(fresh);
		for (const ev of fresh) {
			if (ev.type === "revised") {
				loadBoard(ev.rev);
				renderTabs();
				if (ev.rev !== state.rev) showRevBanner(ev.rev);
			} else if (ev.type === "closed") {
				state.closed = true;
				state.outcome = ev.summary ?? null;
			}
		}
		renderCause();
		renderHeader();
		updateMode();
	}

	async function poll() {
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
		if (document.visibilityState !== "visible") return;
		try {
			const data = await api(`/api/p/${encodeURIComponent(id)}?since=${state.lastSeq}`);
			const fresh = absorb(data);
			if (fresh.length) applyFresh(fresh);
			else renderHeader();
		} catch (error) {
			console.error("poll", error);
		}
		schedule();
	}

	function schedule() {
		if (pollTimer || document.visibilityState !== "visible") return;
		pollTimer = setTimeout(poll, POLL_MS);
	}

	// ---------- sending ----------

	function setBusy(busy) {
		el.sendBtn.disabled = busy;
		el.approveBtn.disabled = busy;
		el.ackBtn.disabled = busy;
	}

	// Both buttons lock before the first await, so a double tap sends once. A sent proposal is the session's from here on:
	// the page leaves for the inbox, and the session closes the proposal with `inbox close` after the work.
	async function send(verdict) {
		if (!canMark() || el.sendBtn.disabled) return;
		setBusy(true);
		const board = state.boards[state.rev] || {};
		const answers = {};
		for (const q of board.questions || []) {
			const picked = el.questions.querySelector(`input[name="q_${q.id}"]:checked`);
			if (picked) answers[q.id] = picked.value;
		}
		const comment = el.comment.value.trim();
		const marks = visibleMarks().map((m, i) => ({ n: i + 1, frame: m.frame, x: m.x, y: m.y, w: m.w, h: m.h, comment: m.comment || null, crop: m.crop || null }));
		if (verdict === "change" && !Object.keys(answers).length && !comment && !marks.length) {
			setStatus("고른 것이나 의견이 없습니다.");
			setBusy(false);
			return;
		}
		setStatus("보내는 중…");
		const headers = window.__vbSendHeaders || DEFAULT_HEADERS;
		try {
			const res = await fetch(`/api/p/${encodeURIComponent(id)}/feedback`, {
				method: "POST",
				headers,
				body: JSON.stringify({ rev: state.rev, verdict, answers, comment: comment || null, marks }),
			});
			if (res.ok) {
				location.replace("/");
				return;
			}
			setStatus(res.status === 409 ? "이미 끝난 Review입니다." : "보내지 못했습니다.");
		} catch (error) {
			console.error("send", error);
			setStatus("보내지 못했습니다.");
		}
		setBusy(false);
	}

	// ---------- AI panel ----------

	function buildPrompt(board, frames, sources) {
		const head = PROMPT_HEAD.concat([`[Review] ${board.title || (state.summary ? state.summary.title : "")}`, board.lead || "", ""]);
		for (const section of board.sections || []) {
			head.push(`[구획] ${section.title}${section.desc ? ` - ${section.desc}` : ""}`);
			for (const card of section.cards || []) for (const text of [card.say, card.note]) if (text) head.push(`- ${text}`);
		}
		head.push("");
		(board.questions || []).forEach((q, i) => {
			head.push(`[질문 ${i + 1}] ${q.text}${q.help ? ` - ${q.help}` : ""}`);
			for (const o of q.options || []) head.push(`  * ${o.label}${o.rec ? " (추천)" : ""}${o.why ? `: ${o.why}` : ""}`);
		});
		const blocks = [];
		frames.forEach((frame, i) => {
			const source = (sources[i] || "").trim();
			if (source) blocks.push(`\n[도식 ${frame.label}]\n\`\`\`mermaid\n${source}\n\`\`\``);
		});
		return { head: head.join("\n"), blocks };
	}

	// The largest prompt whose encoded length fits; null when even the head does not fit.
	function promptFor(limit) {
		const prompt = state.prompt;
		if (!prompt) return "";
		if (encodeURIComponent(prompt.head).length > limit) return null;
		let diagrams = "";
		for (const block of prompt.blocks) {
			if (encodeURIComponent(prompt.head + PROMPT_LEAD + diagrams + block).length <= limit) diagrams += block;
		}
		return prompt.head + (diagrams ? PROMPT_LEAD + diagrams : "");
	}

	function copySync(text) {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.left = "-10000px";
		document.body.appendChild(area);
		area.select();
		let ok = false;
		try {
			ok = document.execCommand("copy");
		} catch {
			ok = false;
		}
		area.remove();
		return ok;
	}

	function copyText(text) {
		if (copySync(text)) return Promise.resolve();
		if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
		return Promise.reject(new Error("clipboard unavailable"));
	}

	async function postOpen(body) {
		const res = await fetch("/api/open", { method: "POST", headers: DEFAULT_HEADERS, body: JSON.stringify(body) });
		if (!res.ok) throw new Error(`open ${res.status}`);
		return res.json();
	}

	function renderTargets() {
		el.targets.innerHTML = "";
		for (const target of (state.caps && state.caps.targets) || []) {
			const button = document.createElement("button");
			button.type = "button";
			button.dataset.target = target.id;
			button.innerHTML = `${esc(target.label)}${target.hint ? `<small>${esc(target.hint)}</small>` : ""}`;
			el.targets.appendChild(button);
		}
	}

	async function loadCaps() {
		try {
			state.caps = await api("/api/caps");
		} catch (error) {
			console.error("caps", error);
			state.caps = { open: false, targets: [] };
		}
		renderTargets();
	}

	function openTarget(target) {
		el.aiMsg.textContent = "";
		const full = promptFor(Infinity);
		if (target.copy) {
			copyText(full).then(
				() => {
					el.aiMsg.textContent = "복사했습니다.";
				},
				() => {
					el.aiMsg.textContent = "복사하지 못했습니다.";
				},
			);
			return;
		}
		const template = String(target.url || "");
		const wantsPrompt = template.includes("{q}");
		const fitted = wantsPrompt ? promptFor(target.maxEncoded || Infinity) : null;
		const tooLong = wantsPrompt && fitted === null;
		const longNote = "내용이 길어 복사해 두었습니다. 열린 창에 붙여 넣으세요.";

		if (state.caps && state.caps.open === true) {
			const body = { target: target.id, proposalId: id };
			if (wantsPrompt) {
				if (tooLong) body.useHome = true;
				else body.q = fitted;
			}
			const copied = tooLong ? copyText(full) : Promise.resolve();
			copied
				.then(() => postOpen(body))
				.then(
					() => {
						el.aiMsg.textContent = tooLong ? longNote : "열었습니다.";
					},
					(error) => {
						console.error("open", error);
						el.aiMsg.textContent = "열지 못했습니다.";
					},
				);
			return;
		}

		// Tailnet: no server-side launcher. Open synchronously inside the click so mobile popup blockers allow it.
		let url;
		if (tooLong) url = target.home || template.replace(/\{q\}/g, "");
		else url = template.replace(/\{q\}/g, encodeURIComponent(fitted || "")).replace(/\{board\}/g, location.href);
		const copiedFirst = tooLong && copySync(full);
		const win = window.open(url, "_blank");
		if (!win) {
			el.aiMsg.textContent = "열지 못했습니다.";
			return;
		}
		try {
			win.opener = null;
		} catch {
			// cross-origin window: nothing to detach
		}
		if (!tooLong) {
			el.aiMsg.textContent = "열었습니다.";
			return;
		}
		if (copiedFirst) {
			el.aiMsg.textContent = longNote;
			return;
		}
		copyText(full).then(
			() => {
				el.aiMsg.textContent = longNote;
			},
			() => {
				el.aiMsg.textContent = "복사하지 못했습니다.";
			},
		);
	}

	// ---------- boot ----------

	function showLoadError(message) {
		el.loadError.textContent = message;
		el.loadError.hidden = false;
		el.decideCard.hidden = true;
		el.marksCard.hidden = true;
		$("threadCard").hidden = true;
		el.fab.hidden = true;
	}

	async function init() {
		if (!id) {
			showLoadError("Review를 찾을 수 없습니다.");
			return;
		}
		let data;
		try {
			data = await api(`/api/p/${encodeURIComponent(id)}`);
		} catch (error) {
			console.error("load", error);
			showLoadError(error.status === 404 ? "Review를 찾을 수 없습니다." : "Review를 불러오지 못했습니다.");
			return;
		}
		absorb(data);
		state.closed = data.summary.status === "closed";
		const closedEvent = state.events.find((ev) => ev.type === "closed");
		state.outcome = closedEvent ? closedEvent.summary ?? null : data.summary.outcome;
		await Promise.all(state.revs.map((r) => loadBoard(r.n)));
		renderHeader();
		renderThread();
		const wanted = Number.parseInt(new URLSearchParams(location.search).get("rev") || "", 10);
		await selectRev(Number.isFinite(wanted) ? wanted : state.latest, { replace: false });
		loadCaps();
		schedule();
	}

	el.sendBtn.addEventListener("click", () => send("change"));
	el.approveBtn.addEventListener("click", () => send("approve"));
	el.ackBtn.addEventListener("click", () => send("ack"));
	el.listenBtn.hidden = !("speechSynthesis" in window && "SpeechSynthesisUtterance" in window);
	el.listenBtn.addEventListener("click", () => (reading ? stopListening() : startListening()));
	el.restartBtn.addEventListener("click", () => startListening({ fromTop: true }));
	el.stopFab.addEventListener("click", stopListening);
	el.revBannerBtn.addEventListener("click", () => {
		if (state.bannerRev != null) selectRev(state.bannerRev);
	});
	el.comment.addEventListener("input", () => {
		if (state.closed) updateMode();
	});
	el.fab.addEventListener("click", () => {
		el.panel.hidden = !el.panel.hidden;
		el.aiMsg.textContent = "";
	});
	el.targets.addEventListener("click", (e) => {
		const button = e.target.closest("button[data-target]");
		if (!button || !state.caps) return;
		const target = state.caps.targets.find((t) => t.id === button.dataset.target);
		if (target) openTarget(target);
	});
	window.addEventListener("resize", () => {
		resizeAll();
		if (vv.open) vLayout(false);
	});
	document.addEventListener("visibilitychange", () => {
		// Back on the page after the engine dropped the speech (a phone does in the background): show 이어 듣기, not a dead 멈추기.
		if (document.visibilityState === "visible" && reading && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) stopListening();
		if (document.visibilityState === "visible") poll();
		else if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
	});

	init();
})();
