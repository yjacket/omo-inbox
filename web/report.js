/* Report composer and inspector entry (web/report.js).
 *
 * mountReporter({ page, sourceOf, doc }) turns every `[data-issue-report]` anchor of the document into
 * the inspect-mode entry: an unmodified primary click starts a pick (web/report-pick.js drawing through
 * web/report-overlay.js) instead of navigating, and the picked element opens the `문제 제보` dialog. In the
 * split view the embedded thread page finds the top window's reporter on `window.top.__inboxReporter`
 * and delegates to it, so a pick inside the frame opens the composer in the top document.
 *
 * The composer freezes the element descriptor (web/report-describe.js), the frame's view, the page info
 * and the page-provided source at selection time, draws the element with web/report-snapshot.js, and
 * sends the Contracts create body to POST /api/reports with one reportId per opening; a 409 key_reused
 * (the content changed after a failed send) takes a fresh id once. After 201 it follows the record with
 * GET /api/reports/<id> (every second for 30 s, then every 5 s) until GitHub answered: `GitHub #<n>에
 * 올렸습니다` with `열기` and `처리 맡기기`, or `보내지 못했습니다 · <detail>` with `다시 시도`.
 *
 * Text is only ever set with textContent. The reporter adds exactly one history entry while it is
 * active (picking or composing) and ends on Back. Its popstate and Escape handlers are capture-phase
 * listeners registered at mount and stop the event before the page's own close handlers see it; the
 * entry copies the page's own history.state keys, so a page handler that still runs (Chromium fires
 * window-target popstate listeners in registration order) finds its own token untouched. */

import { describeElement, describeView, devtoolsLabel, uniqueSelector } from "./report-describe.js";
import { createOverlay } from "./report-overlay.js";
import { startPick } from "./report-pick.js";
import { snapshotElement } from "./report-snapshot.js";

const CSS_HREF = "/web/report.css";
const DRAFT_KEY = "inbox.reportDraft";
const POST_HEADERS = Object.freeze({ "content-type": "application/json", "x-inbox": "1" });
const POLL_FAST_MS = 1000;
const POLL_FAST_COUNT = 30;
const POLL_SLOW_MS = 5000;
const PNG_MAX_SIDE = 4096;
const PNG_MAX_PIXELS = 2097152;
const PNG_MAX_BYTES = 8388608;
const TITLE_MAX_BYTES = 160;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const TEXT = Object.freeze({
	title: "문제 제보",
	whole: "화면 전체",
	up: "상위",
	down: "하위",
	repick: "다시 고르기",
	remove: "빼기",
	drawing: "그림 만드는 중",
	noPicture: "그림 없음",
	removePicture: "그림 빼기",
	addPhoto: "사진 추가",
	snapshotCaption: "화면을 다시 그린 그림",
	uploadCaption: "올린 사진",
	uploadFailed: "사진을 읽지 못했습니다",
	description: "설명",
	placeholder: "무엇이 이상한지 적어 주세요",
	send: "보내기",
	close: "닫기",
	sending: "보내는 중",
	pending: "GitHub로 보내는 중",
	failed: "보내지 못했습니다",
	serverFailed: "서버에 보내지 못했습니다",
	badInput: "내용을 확인해 주세요",
	tooLarge: "그림이 너무 큽니다",
	forbidden: "이 기기에서는 보낼 수 없습니다",
	retry: "다시 시도",
	retryFailed: "다시 시도하지 못했습니다.",
	open: "열기",
	handoff: "처리 맡기기",
	handoffAgain: "다시 맡기기",
	handoffWorking: "새 세션을 여는 중입니다.",
	handoffDone: "새 세션에 맡겼습니다.",
	handoffError: Object.freeze({
		cwd_missing: "이 저장소의 폴더를 찾지 못했습니다.",
		no_launcher: "터미널을 찾지 못했습니다.",
		launch_failed: "세션을 열지 못했습니다.",
		not_sent: "아직 GitHub에 올라가지 않았습니다.",
	}),
});

const NO_PICTURE = Object.freeze({ state: "none", provenance: null, png: null, width: 0, height: 0 });

/* ---------- small helpers ---------- */

function clipBytes(text, max) {
	const encoder = new TextEncoder();
	if (encoder.encode(text).length <= max) return text;
	let out = "";
	for (const ch of text) {
		const next = out + ch;
		if (encoder.encode(next).length > max) break;
		out = next;
	}
	return out;
}

function decodedBytes(base64) {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.floor((base64.length * 3) / 4) - padding;
}

/** uuid v4; crypto.randomUUID needs a secure context, which a plain-http tailnet address is not. */
function uuid(win) {
	const c = win.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	const bytes = new Uint8Array(16);
	c.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function frameOf(doc) {
	try {
		return doc?.defaultView?.frameElement ?? null;
	} catch {
		return null;
	}
}

function isFrame(el) {
	return typeof el.tagName === "string" && el.tagName.toUpperCase() === "IFRAME";
}

function frameDocument(frame) {
	try {
		return frame.contentDocument || null;
	} catch {
		return null;
	}
}

/** The element's box in the reporter window's viewport coordinates, iframe borders included. */
function topRect(el, win) {
	const box = el.getBoundingClientRect();
	let x = box.left;
	let y = box.top;
	let realm = el.ownerDocument.defaultView;
	while (realm && realm !== win) {
		const frame = frameOf(realm.document);
		if (!frame) break;
		const fr = frame.getBoundingClientRect();
		x += fr.left + frame.clientLeft;
		y += fr.top + frame.clientTop;
		realm = frame.ownerDocument.defaultView;
	}
	return { x, y, w: box.width, h: box.height };
}

/** `상위`: parentElement, except that the body (or html) of a frame document goes to the iframe element. */
function parentOf(el) {
	const doc = el.ownerDocument;
	const frame = frameOf(doc);
	if (frame && (el === doc.body || el === doc.documentElement)) return frame;
	return el.parentElement;
}

/** True when node is el or inside it, following iframe boundaries upward. */
function isWithin(el, node) {
	let current = node;
	while (current) {
		if (el.contains(current)) return true;
		current = frameOf(current.ownerDocument);
	}
	return false;
}

/** `하위`: the element the user went up from when it is still inside, else the first child with a box. */
function childOf(el, stack) {
	const last = stack.length > 0 ? stack[stack.length - 1] : null;
	if (last && last !== el && last.isConnected && isWithin(el, last)) return last;
	if (isFrame(el)) {
		const doc = frameDocument(el);
		return doc?.body ?? null;
	}
	for (const child of el.children) {
		const box = child.getBoundingClientRect();
		if (box.width > 0 && box.height > 0) return child;
	}
	return null;
}

function ensureStylesheet(doc) {
	if (!doc.head || doc.head.querySelector("link[data-report-style]")) return;
	const link = doc.createElement("link");
	link.rel = "stylesheet";
	link.href = CSS_HREF;
	link.setAttribute("data-report-style", "");
	doc.head.append(link);
}

function isEmbedded(win) {
	try {
		return win.top !== win && Boolean(win.top.document);
	} catch {
		// a cross-origin top window is not ours to use
		return false;
	}
}

/** The top window's reporter (split view), looked up at call time so load order does not matter. */
function findDelegate(win) {
	try {
		const top = win.top;
		if (top && top !== win && top.__inboxReporter && typeof top.__inboxReporter.openPick === "function") return top.__inboxReporter;
	} catch {
		// a cross-origin top window is not ours to use
	}
	return null;
}

const boundEntries = new WeakSet();

function bindEntries(doc, api) {
	for (const node of doc.querySelectorAll("[data-issue-report]")) {
		if (boundEntries.has(node)) continue;
		boundEntries.add(node);
		node.addEventListener("click", (event) => {
			if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			api.openPick(event.currentTarget);
		});
	}
}

/* ---------- the reporter ---------- */

function createReporter({ win, doc, pageInfo, sourceOf }) {
	ensureStylesheet(doc);

	// session
	let active = false;
	let closing = false;
	let entry = false;
	let opener = null;
	let picker = null;
	let repicking = false;
	let overlay = null;

	// selection
	let element = null;
	let frozen = null; // { descriptor, view, frames, source }
	let stack = [];
	let picture = NO_PICTURE;
	let pictureSeq = 0;

	// sending
	let reportId = null;
	let accepted = null;
	let busy = false;
	let keyRetried = false;
	let polls = 0;
	let pollTimer = null;

	// dialog
	let dialog = null;
	let dialogOpen = false;
	let ui = null;

	function el(tag, className, text) {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function ctl(text) {
		const button = el("button", "report__ctl", text);
		button.type = "button";
		return button;
	}

	function locked() {
		return busy || accepted !== null;
	}

	/* ---- overlay ---- */

	function ensureOverlay() {
		if (overlay === null) overlay = createOverlay(doc);
		return overlay;
	}

	function showOutline() {
		const box = ensureOverlay();
		if (element === null) {
			box.highlight(null, null);
			return;
		}
		box.highlight(topRect(element, win), null);
		box.showSelected();
	}

	/* ---- history ---- */

	function ownsEntry() {
		const state = win.history?.state;
		return Boolean(state && typeof state === "object" && state.reportPick === true);
	}

	function onPopstateCapture(event) {
		if (!active || ownsEntry()) return;
		event.stopImmediatePropagation();
		finish();
	}

	function pushEntry() {
		entry = false;
		if (!win.history || typeof win.history.pushState !== "function") return;
		const state = win.history.state;
		const base = state && typeof state === "object" && !Array.isArray(state) ? state : {};
		try {
			win.history.pushState({ ...base, reportPick: true }, "");
			entry = true;
		} catch {
			entry = false;
		}
	}

	/* ---- session ---- */

	function begin(explicitOpener) {
		if (active) return;
		active = true;
		closing = false;
		opener = explicitOpener && typeof explicitOpener.focus === "function" ? explicitOpener : doc.activeElement;
		element = null;
		frozen = null;
		stack = [];
		pictureSeq += 1;
		picture = NO_PICTURE;
		reportId = uuid(win);
		accepted = null;
		busy = false;
		keyRetried = false;
		polls = 0;
		if (pollTimer !== null) {
			win.clearTimeout(pollTimer);
			pollTimer = null;
		}
		if (ui !== null) {
			ui.textarea.readOnly = false;
			restoreDraft();
			setStatus("", false);
			setNote("", false);
			clearResult();
			ui.send.hidden = false;
		}
		pushEntry();
	}

	/** Programmatic end: pop our history entry first when it is current; the popstate finishes. */
	function leave() {
		if (!active || closing) return;
		if (entry && ownsEntry() && typeof win.history.back === "function") {
			closing = true;
			win.history.back();
			return;
		}
		finish();
	}

	function finish() {
		if (!active) return;
		active = false;
		closing = false;
		entry = false;
		if (picker !== null) {
			picker.stop();
			picker = null;
		}
		repicking = false;
		if (overlay !== null) overlay.hide();
		hideComposer();
		if (pollTimer !== null) {
			win.clearTimeout(pollTimer);
			pollTimer = null;
		}
		const fallback = doc.querySelector("[data-issue-report]");
		const target = opener?.isConnected && opener !== doc.body ? opener : fallback;
		opener = null;
		if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
	}

	/* ---- picking ---- */

	function openPick(explicitOpener) {
		if (picker !== null) return;
		begin(explicitOpener);
		repicking = dialogOpen;
		if (dialogOpen) hideComposer();
		const box = ensureOverlay();
		box.onCancel(cancelPick);
		box.setHint(null);
		box.showPicking();
		picker = startPick({ win, overlay: box, describeLabel: devtoolsLabel, onPick, onCancel: cancelPick });
	}

	function onPick({ element: picked }) {
		if (picker === null) return;
		picker.stop();
		picker = null;
		repicking = false;
		select(picked, true);
		openComposer();
	}

	function cancelPick() {
		if (picker === null) return;
		picker.stop();
		picker = null;
		if (repicking) {
			repicking = false;
			showOutline();
			openComposer();
			return;
		}
		leave();
	}

	function openFor(target, explicitOpener) {
		if (!target || !target.ownerDocument || typeof target.getBoundingClientRect !== "function") return;
		if (picker !== null) {
			picker.stop();
			picker = null;
			repicking = false;
		}
		begin(explicitOpener);
		select(target, true);
		openComposer();
	}

	/* ---- selection ---- */

	function sourceFor(target) {
		let fn = null;
		try {
			fn = target.ownerDocument.defaultView.__inboxReportSource;
		} catch {
			fn = null;
		}
		if (typeof fn !== "function") fn = sourceOf;
		if (typeof fn !== "function") return null;
		try {
			const source = fn(target);
			return source === undefined ? null : source;
		} catch (error) {
			console.error("report: sourceOf failed", error);
			return null;
		}
	}

	/** The top-level frame holding the element, as the contract's single `frames` entry. */
	function framesOf(target) {
		let realm = target.ownerDocument.defaultView;
		let frame = null;
		while (realm && realm !== win) {
			frame = frameOf(realm.document);
			if (!frame) return [];
			realm = frame.ownerDocument.defaultView;
		}
		if (!frame) return [];
		let url = "/";
		try {
			url = frame.contentWindow.location.pathname;
		} catch {
			url = "/";
		}
		return [{ selector: uniqueSelector(frame).selector ?? "iframe", url }];
	}

	function select(target, fresh) {
		if (fresh) stack = [];
		element = target;
		frozen = {
			descriptor: describeElement(target),
			view: describeView(target.ownerDocument.defaultView),
			frames: framesOf(target),
			source: sourceFor(target),
		};
		// Start the redraw before the outline and the composer touch the page, so the snapshot never
		// captures a frame in which the overlay or the modal dialog changed the layout.
		startSnapshot(target);
		showOutline();
		render();
	}

	function removeElement() {
		if (element === null) return;
		element = null;
		stack = [];
		frozen = { descriptor: null, view: frozen.view, frames: [], source: frozen.source };
		pictureSeq += 1;
		picture = NO_PICTURE;
		showOutline();
		render();
	}

	function goUp() {
		if (element === null || locked()) return;
		const parent = parentOf(element);
		if (!parent) return;
		stack.push(element);
		select(parent, false);
	}

	function goDown() {
		if (element === null || locked()) return;
		const child = childOf(element, stack);
		if (!child) return;
		if (stack.length > 0 && stack[stack.length - 1] === child) stack.pop();
		select(child, false);
	}

	/* ---- picture ---- */

	function startSnapshot(target) {
		const seq = ++pictureSeq;
		picture = { state: "pending", provenance: null, png: null, width: 0, height: 0 };
		snapshotElement(target).then((result) => {
			if (seq !== pictureSeq) return;
			picture = result?.ok
				? { state: "ok", provenance: "snapshot", png: result.png, width: result.width, height: result.height }
				: NO_PICTURE;
			renderPicture();
		}, (error) => {
			if (seq !== pictureSeq) return;
			console.error("report: snapshot failed", error);
			picture = NO_PICTURE;
			renderPicture();
		});
	}

	function removePicture() {
		pictureSeq += 1;
		picture = NO_PICTURE;
		renderPicture();
	}

	function drawToPng(image, width, height) {
		const canvas = doc.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		canvas.getContext("2d").drawImage(image, 0, 0, width, height);
		return { png: canvas.toDataURL("image/png").split(",")[1], width, height };
	}

	/** A chosen or pasted image file as PNG within the contract's size limits. */
	async function fileToPng(file) {
		const url = win.URL.createObjectURL(file);
		try {
			const image = new win.Image();
			image.src = url;
			await image.decode();
			const w0 = image.naturalWidth;
			const h0 = image.naturalHeight;
			if (!(w0 > 0 && h0 > 0)) throw new Error("empty image");
			const s = Math.min(1, PNG_MAX_SIDE / w0, PNG_MAX_SIDE / h0, Math.sqrt(PNG_MAX_PIXELS / (w0 * h0)));
			return drawToPng(image, Math.max(1, Math.floor(w0 * s)), Math.max(1, Math.floor(h0 * s)));
		} finally {
			win.URL.revokeObjectURL(url);
		}
	}

	/** The same picture at half the pixel count: the one re-export for a PNG over 8 MiB. */
	async function halve(current) {
		const image = new win.Image();
		image.src = `data:image/png;base64,${current.png}`;
		await image.decode();
		return drawToPng(image, Math.max(1, Math.floor(current.width * Math.SQRT1_2)), Math.max(1, Math.floor(current.height * Math.SQRT1_2)));
	}

	async function loadUpload(file) {
		if (locked()) return;
		const seq = ++pictureSeq;
		setNote("", false);
		let result;
		try {
			result = await fileToPng(file);
		} catch (error) {
			if (seq !== pictureSeq) return;
			console.error("report: upload not decoded", error);
			setNote(TEXT.uploadFailed, true);
			return;
		}
		if (seq !== pictureSeq) return;
		picture = { state: "ok", provenance: "upload", png: result.png, width: result.width, height: result.height };
		renderPicture();
	}

	async function outgoingImage() {
		if (picture.state !== "ok") return null;
		if (decodedBytes(picture.png) > PNG_MAX_BYTES) {
			const seq = pictureSeq;
			const smaller = await halve(picture);
			if (seq === pictureSeq) picture = { ...picture, ...smaller };
		}
		return { provenance: picture.provenance, png: picture.png, width: picture.width, height: picture.height };
	}

	/* ---- dialog ---- */

	function buildDialog() {
		dialog = el("dialog", "report");
		dialog.setAttribute("data-report-composer", "");

		const head = el("div", "report__head");
		const title = el("h2", "report__title", TEXT.title);
		title.id = "report-title";
		dialog.setAttribute("aria-labelledby", title.id);
		head.append(title);

		const body = el("div", "report__body");

		const card = el("div", "report__card");
		const target = el("div", "report__target");
		const thumb = el("img", "report__thumb");
		thumb.alt = "";
		thumb.height = 64;
		thumb.decoding = "async";
		thumb.hidden = true;
		const meta = el("div", "report__meta");
		const label = el("p", "report__label", TEXT.whole);
		const selector = el("p", "report__selector", "");
		selector.setAttribute("data-selector", "");
		meta.append(label, selector);
		target.append(thumb, meta);

		const controls = el("div", "report__controls");
		const up = ctl(TEXT.up);
		up.dataset.action = "up";
		const down = ctl(TEXT.down);
		down.dataset.action = "down";
		const repick = ctl(TEXT.repick);
		repick.dataset.action = "repick";
		const remove = ctl(TEXT.remove);
		remove.dataset.action = "remove";
		controls.append(up, down, repick, remove);

		const pictureRow = el("div", "report__picture");
		const caption = el("p", "report__caption", TEXT.noPicture);
		const removePictureButton = ctl(TEXT.removePicture);
		removePictureButton.dataset.action = "remove-picture";
		removePictureButton.hidden = true;
		const addPhoto = ctl(TEXT.addPhoto);
		addPhoto.dataset.action = "add-photo";
		const file = el("input", "report__file");
		file.type = "file";
		file.accept = "image/*";
		file.tabIndex = -1;
		file.setAttribute("aria-hidden", "true");
		pictureRow.append(caption, removePictureButton, addPhoto, file);
		card.append(target, controls, pictureRow);

		const field = el("div", "report__field");
		const fieldLabel = el("label", "report__field-label", TEXT.description);
		fieldLabel.htmlFor = "report-description";
		const textarea = el("textarea", "report__text");
		textarea.id = "report-description";
		textarea.placeholder = TEXT.placeholder;
		textarea.rows = 4;
		textarea.autofocus = true;
		field.append(fieldLabel, textarea);
		body.append(card, field);

		const foot = el("div", "report__foot");
		const status = el("p", "report__status", "");
		status.setAttribute("role", "status");
		const result = el("div", "report__result");
		const note = el("p", "report__note", "");
		note.setAttribute("role", "status");
		const actions = el("div", "report__actions");
		const close = ctl(TEXT.close);
		close.dataset.action = "close";
		const send = el("button", "report__btn", TEXT.send);
		send.type = "button";
		send.dataset.action = "send";
		send.disabled = true;
		actions.append(close, send);
		foot.append(status, result, note, actions);

		dialog.append(head, body, foot);
		doc.body.append(dialog);
		ui = { thumb, label, selector, up, down, repick, remove, caption, removePictureButton, addPhoto, file, textarea, status, result, note, send, close };

		up.addEventListener("click", goUp);
		down.addEventListener("click", goDown);
		repick.addEventListener("click", () => {
			if (locked()) return;
			openPick(opener);
		});
		remove.addEventListener("click", () => {
			if (locked()) return;
			removeElement();
		});
		removePictureButton.addEventListener("click", () => {
			if (locked()) return;
			removePicture();
		});
		addPhoto.addEventListener("click", () => {
			if (locked()) return;
			file.click();
		});
		file.addEventListener("change", () => {
			const chosen = file.files?.[0];
			file.value = "";
			if (chosen) void loadUpload(chosen);
		});
		dialog.addEventListener("paste", (event) => {
			const items = event.clipboardData?.items;
			if (!items) return;
			for (const item of items) {
				if (item.kind !== "file" || typeof item.type !== "string" || !item.type.startsWith("image/")) continue;
				const pasted = item.getAsFile();
				if (!pasted) continue;
				event.preventDefault();
				void loadUpload(pasted);
				return;
			}
		});
		textarea.addEventListener("input", () => {
			saveDraft();
			if (result.querySelector("[data-action=\"resend\"]") !== null) {
				clearResult();
				send.hidden = false;
			}
			syncSend();
		});
		send.addEventListener("click", () => void sendReport());
		close.addEventListener("click", () => leave());
		dialog.addEventListener("cancel", (event) => {
			event.preventDefault();
			leave();
		});
		dialog.addEventListener("close", () => {
			if (dialogOpen) {
				dialogOpen = false;
				leave();
			}
		});
		dialog.addEventListener("keydown", (event) => {
			if (event.key !== "Tab") return;
			const nodes = Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((node) => !node.hidden && node.closest("[hidden]") === null);
			if (nodes.length === 0) return;
			const first = nodes[0];
			const last = nodes[nodes.length - 1];
			if (event.shiftKey && (doc.activeElement === first || !dialog.contains(doc.activeElement))) {
				event.preventDefault();
				last.focus({ preventScroll: true });
			} else if (!event.shiftKey && doc.activeElement === last) {
				event.preventDefault();
				first.focus({ preventScroll: true });
			}
		});
	}

	function onKeydownCapture(event) {
		if (!dialogOpen || event.key !== "Escape" || event.isComposing) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		leave();
	}

	function openComposer() {
		if (dialog === null) {
			buildDialog();
			restoreDraft();
		}
		render();
		if (!dialogOpen) {
			dialogOpen = true;
			if (!dialog.open) dialog.showModal();
		}
		ui.textarea.focus({ preventScroll: true });
	}

	function hideComposer() {
		if (dialog === null || !dialogOpen) return;
		dialogOpen = false;
		if (dialog.open) dialog.close();
	}

	/* ---- rendering ---- */

	function render() {
		if (ui === null) return;
		const has = element !== null && frozen !== null && frozen.descriptor !== null;
		const descriptor = has ? frozen.descriptor : null;
		ui.label.textContent = has ? descriptor.label : TEXT.whole;
		ui.selector.textContent = has ? (descriptor.selector ?? descriptor.domPath) : "";
		ui.selector.setAttribute("data-selector", has && descriptor.selector !== null ? descriptor.selector : "");
		ui.up.disabled = !has || locked() || parentOf(element) === null;
		ui.down.disabled = !has || locked() || childOf(element, stack) === null;
		ui.repick.disabled = locked();
		ui.remove.disabled = !has || locked();
		renderPicture();
		syncSend();
	}

	function renderPicture() {
		if (ui === null) return;
		const ok = picture.state === "ok";
		ui.thumb.hidden = !ok;
		if (ok) ui.thumb.src = `data:image/png;base64,${picture.png}`;
		else ui.thumb.removeAttribute("src");
		if (picture.state === "pending") ui.caption.textContent = TEXT.drawing;
		else if (ok) ui.caption.textContent = picture.provenance === "upload" ? TEXT.uploadCaption : TEXT.snapshotCaption;
		else ui.caption.textContent = TEXT.noPicture;
		ui.removePictureButton.hidden = !ok;
		ui.removePictureButton.disabled = locked();
		ui.addPhoto.disabled = locked();
	}

	function syncSend() {
		if (ui === null) return;
		ui.send.disabled = busy || accepted !== null || ui.textarea.value.trim() === "";
	}

	function setStatus(text, error) {
		ui.status.textContent = text;
		ui.status.classList.toggle("is-error", Boolean(error));
	}

	function setNote(text, error) {
		ui.note.textContent = text;
		ui.note.classList.toggle("is-error", Boolean(error));
	}

	function clearResult() {
		ui.result.replaceChildren();
	}

	/* ---- draft ---- */

	function saveDraft() {
		try {
			win.localStorage.setItem(DRAFT_KEY, ui.textarea.value);
		} catch {
			// storage may be unavailable; the text stays in the field
		}
	}

	function restoreDraft() {
		let draft = "";
		try {
			const stored = win.localStorage.getItem(DRAFT_KEY);
			if (typeof stored === "string") draft = stored;
		} catch {
			draft = "";
		}
		ui.textarea.value = draft;
	}

	function clearDraft() {
		try {
			win.localStorage.removeItem(DRAFT_KEY);
		} catch {
			// nothing to remove
		}
	}

	/* ---- sending ---- */

	function pageUrl() {
		const loc = win.location;
		let url = loc.pathname;
		if (url === "/") {
			const sid = new win.URLSearchParams(loc.search).get("s");
			if (sid) url += `?s=${encodeURIComponent(sid)}`;
		}
		return url;
	}

	async function buildBody() {
		const has = element !== null && frozen !== null && frozen.descriptor !== null;
		return {
			v: 2,
			reportId,
			description: ui.textarea.value,
			page: {
				kind: pageInfo.kind,
				route: pageInfo.route,
				url: pageUrl(),
				title: clipBytes(String(doc.title || ""), TITLE_MAX_BYTES),
				frames: has ? frozen.frames : [],
			},
			element: has ? frozen.descriptor : null,
			view: frozen !== null ? frozen.view : describeView(win),
			source: frozen !== null ? frozen.source : null,
			image: await outgoingImage(),
		};
	}

	function sendReport() {
		if (busy || accepted !== null || ui.textarea.value.trim() === "") return Promise.resolve();
		keyRetried = false;
		return submit();
	}

	async function submit() {
		busy = true;
		setStatus(TEXT.sending, false);
		setNote("", false);
		clearResult();
		ui.send.hidden = false;
		render();
		let body;
		try {
			body = await buildBody();
		} catch (error) {
			console.error("report: body not built", error);
			failed(TEXT.badInput, {});
			return;
		}
		let res;
		try {
			res = await win.fetch("/api/reports", { method: "POST", headers: POST_HEADERS, body: JSON.stringify(body) });
		} catch {
			failed(TEXT.serverFailed, { resend: true });
			return;
		}
		if (res.status === 201 || res.status === 200) {
			let json = null;
			try {
				json = await res.json();
			} catch {
				json = null;
			}
			onAccepted(json && typeof json.id === "string" ? json.id : reportId);
			return;
		}
		if (res.status === 409) {
			if (!keyRetried) {
				// key_reused: the id was stored with other content; take a fresh id and send once more
				keyRetried = true;
				reportId = uuid(win);
				busy = false;
				await submit();
				return;
			}
			failed(TEXT.serverFailed, { resend: true });
			return;
		}
		if (res.status === 400) {
			failed(TEXT.badInput, {});
			return;
		}
		if (res.status === 413) {
			failed(TEXT.tooLarge, { removePicture: true });
			return;
		}
		if (res.status === 403) {
			failed(TEXT.forbidden, {});
			return;
		}
		failed(TEXT.serverFailed, { resend: true });
	}

	function failed(text, { resend = false, removePicture: offerRemove = false }) {
		busy = false;
		setStatus(text, true);
		clearResult();
		if (resend) {
			ui.send.hidden = true;
			const button = ctl(TEXT.retry);
			button.dataset.action = "resend";
			button.addEventListener("click", () => {
				clearResult();
				ui.send.hidden = false;
				void sendReport();
			});
			ui.result.append(button);
		}
		if (offerRemove && picture.state === "ok") {
			const button = ctl(TEXT.removePicture);
			button.dataset.action = "remove-picture";
			button.addEventListener("click", () => {
				removePicture();
				clearResult();
				setStatus("", false);
			});
			ui.result.append(button);
		}
		render();
	}

	function onAccepted(id) {
		accepted = id;
		busy = false;
		ui.textarea.readOnly = true;
		ui.send.hidden = true;
		setStatus(TEXT.pending, false);
		render();
		polls = 0;
		void poll();
	}

	async function poll() {
		pollTimer = null;
		if (!dialogOpen || accepted === null) return;
		const id = accepted;
		let row = null;
		try {
			const res = await win.fetch(`/api/reports/${encodeURIComponent(id)}`, { headers: { accept: "application/json" }, cache: "no-store" });
			if (res.ok) row = await res.json();
		} catch {
			row = null;
		}
		if (!dialogOpen || accepted !== id) return;
		if (row !== null && row.state === "sent" && row.github && typeof row.github.number === "number") {
			showSent(row);
			return;
		}
		if (row !== null && row.state === "failed") {
			showFailed(row);
			return;
		}
		setStatus(TEXT.pending, false);
		polls += 1;
		pollTimer = win.setTimeout(() => void poll(), polls < POLL_FAST_COUNT ? POLL_FAST_MS : POLL_SLOW_MS);
	}

	function showSent(row) {
		clearResult();
		setNote("", false);
		setStatus(`GitHub #${row.github.number}에 올렸습니다`, false);
		clearDraft();
		const open = el("a", "report__ctl", TEXT.open);
		open.href = typeof row.github.url === "string" ? row.github.url : "";
		open.target = "_blank";
		open.rel = "noopener";
		const hand = ctl(row.handoff ? TEXT.handoffAgain : TEXT.handoff);
		hand.dataset.action = "handoff";
		hand.addEventListener("click", () => void handoff(row.id, hand));
		ui.result.append(open, hand);
	}

	function showFailed(row) {
		clearResult();
		setNote("", false);
		const detail = typeof row.detail === "string" && row.detail !== "" ? ` · ${row.detail}` : "";
		setStatus(`${TEXT.failed}${detail}`, true);
		const button = ctl(TEXT.retry);
		button.dataset.action = "retry";
		button.addEventListener("click", () => void retry(row.id, button));
		ui.result.append(button);
	}

	async function retry(id, button) {
		button.disabled = true;
		let res = null;
		try {
			res = await win.fetch(`/api/reports/${encodeURIComponent(id)}/retry`, { method: "POST", headers: POST_HEADERS, body: "{}" });
		} catch {
			res = null;
		}
		// 200: queued again; 409 not_failed or 404: the record moved on. Either way the record is the truth.
		if (res !== null && res.status < 500) {
			clearResult();
			setStatus(TEXT.pending, false);
			polls = 0;
			if (pollTimer !== null) win.clearTimeout(pollTimer);
			await poll();
			return;
		}
		setNote(TEXT.retryFailed, true);
		button.disabled = false;
	}

	async function handoff(id, button) {
		button.disabled = true;
		setNote(TEXT.handoffWorking, false);
		let res = null;
		try {
			res = await win.fetch(`/api/reports/${encodeURIComponent(id)}/handoff`, { method: "POST", headers: POST_HEADERS, body: "{}" });
		} catch {
			res = null;
		}
		let json = null;
		if (res !== null) {
			try {
				json = await res.json();
			} catch {
				json = null;
			}
		}
		if (res?.ok) {
			setNote(TEXT.handoffDone, false);
			button.textContent = TEXT.handoffAgain;
		} else {
			const code = json && typeof json.error === "string" ? json.error : null;
			setNote(code !== null && Object.hasOwn(TEXT.handoffError, code) ? TEXT.handoffError[code] : TEXT.handoffError.launch_failed, true);
		}
		button.disabled = false;
	}

	// Registered once, as early as the page mounts: window-target popstate listeners run in registration
	// order, so a later page handler is stopped here and an earlier one finds its own state keys intact.
	win.addEventListener("popstate", onPopstateCapture, true);
	win.addEventListener("keydown", onKeydownCapture, true);

	return { openPick, openFor, close: leave };
}

/* ---------- entry ---------- */

export function mountReporter({ page, sourceOf, doc = document } = {}) {
	const win = doc.defaultView;
	if (typeof sourceOf === "function") win.__inboxReportSource = sourceOf;
	let api = win.__inboxReporter && typeof win.__inboxReporter.openPick === "function" ? win.__inboxReporter : null;
	if (api === null) {
		const pageInfo = {
			kind: page && typeof page.kind === "string" ? page.kind : "inbox",
			route: page && typeof page.route === "string" ? page.route : "/",
		};
		if (isEmbedded(win)) {
			// Same-origin frame: the top window's reporter owns picking and the composer; a frame whose
			// top never mounted one (opened on its own) gets a local reporter the first time it is used.
			let local = null;
			const target = () => {
				const delegate = findDelegate(win);
				if (delegate !== null) return delegate;
				if (local === null) local = createReporter({ win, doc, pageInfo, sourceOf });
				return local;
			};
			api = {
				openPick: (opener) => target().openPick(opener),
				openFor: (element, opener) => target().openFor(element, opener),
				close: () => target().close(),
			};
		} else {
			api = createReporter({ win, doc, pageInfo, sourceOf });
		}
		win.__inboxReporter = api;
	}
	bindEntries(doc, api);
	return api;
}
