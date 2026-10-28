/* Inspector overlay: while a report target is being picked, draws the DevTools-style content box
 * and its label over the page, plus the top-center hint/cancel toolbar.
 *
 * The overlay is a manual popover, so it renders in the top layer above an open modal <dialog>
 * and its ::backdrop. The root, box and label are pointer-transparent; only the toolbar takes
 * input. That is what keeps document.elementFromPoint() over the box naming the page element,
 * which is how the picker (web/report-pick.js) identifies what the user is pointing at.
 *
 * After the pick, while the composer dialog is open, showSelected() swaps the popover for a
 * plain fixed outline. A plain element under the dialog's backdrop is the point: the selection
 * stays visible as context without competing with the dialog.
 */

const CSS_HREF = "/web/report-overlay.css";
const DEFAULT_HINT = "고를 곳을 누르세요";
const CANCEL_TEXT = "취소";

export function createOverlay(doc) {
	if (!doc || typeof doc.createElement !== "function") throw new TypeError("createOverlay needs a document");
	const win = doc.defaultView;

	// Stylesheet: one link per document, even when several overlays are created.
	if (doc.head && !doc.head.querySelector("link[data-report-overlay-style]")) {
		const link = doc.createElement("link");
		link.rel = "stylesheet";
		link.href = CSS_HREF;
		link.setAttribute("data-report-overlay-style", "");
		doc.head.append(link);
	}

	// Layout-critical properties are inline at creation: before the stylesheet applies, nothing here
	// may become an in-flow block and squeeze the host page's layout. The stylesheet keeps the visuals.
	const root = doc.createElement("div");
	root.setAttribute("popover", "manual");
	root.setAttribute("data-report-overlay", "");
	root.style.cssText = "position: fixed; inset: 0; box-sizing: border-box; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; overflow: visible; background: transparent; pointer-events: none;";

	const box = doc.createElement("div");
	box.setAttribute("data-report-box", "");
	box.style.cssText = "position: absolute; box-sizing: border-box; margin: 0; pointer-events: none;";

	const label = doc.createElement("div");
	label.setAttribute("data-report-label", "");
	label.style.cssText = "position: absolute; margin: 0; pointer-events: none;";
	label.hidden = true;

	const bar = doc.createElement("div");
	bar.setAttribute("role", "toolbar");
	bar.style.cssText = "position: fixed; top: 12px; left: 50%; margin: 0; transform: translateX(-50%); pointer-events: auto;";

	// The toolbar sits at the top by default. A pointer moving toward something under it,
	// or a touch landing on it, moves it to the opposite edge so that spot becomes pickable.
	const setEdge = (edge) => {
		bar.setAttribute("data-edge", edge);
		if (edge === "bottom") {
			bar.style.top = "auto";
			bar.style.bottom = "max(12px, env(safe-area-inset-bottom))";
		} else {
			bar.style.top = "12px";
			bar.style.bottom = "";
		}
	};
	const toggleEdge = () => setEdge(bar.getAttribute("data-edge") === "bottom" ? "top" : "bottom");
	const overCancel = (event) => {
		if (event.target === cancel || cancel.contains(event.target)) return true;
		try {
			const el = doc.elementFromPoint(event.clientX, event.clientY);
			return Boolean(el && (el === cancel || cancel.contains(el)));
		} catch {
			return false;
		}
	};
	const onBarEnter = (event) => {
		if (destroyed) return;
		if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
		// Approaching 취소 must not flip the bar out from under the click.
		if (overCancel(event)) return;
		toggleEdge();
	};
	const onBarDown = (event) => {
		if (destroyed || event.pointerType !== "touch") return;
		if (event.target === cancel || cancel.contains(event.target)) return;
		toggleEdge();
	};
	setEdge("top");
	bar.addEventListener("pointerenter", onBarEnter);
	bar.addEventListener("pointerdown", onBarDown);

	const hint = doc.createElement("span");
	hint.setAttribute("data-report-hint", "");
	hint.textContent = DEFAULT_HINT;

	const cancel = doc.createElement("button");
	cancel.type = "button";
	cancel.setAttribute("data-report-cancel", "");
	cancel.textContent = CANCEL_TEXT;

	const hintId = `report-overlay-hint-${Math.random().toString(36).slice(2, 10)}`;
	hint.id = hintId;
	bar.setAttribute("aria-label", DEFAULT_HINT);
	bar.append(hint, cancel);
	root.append(box, label, bar);

	const selected = doc.createElement("div");
	selected.setAttribute("data-report-selected", "");
	selected.style.cssText = "position: fixed; left: 0; top: 0; box-sizing: border-box; margin: 0; pointer-events: none;";
	selected.hidden = true;

	let cancelFn = null;
	let lastRect = null;
	let destroyed = false;

	const coarseQuery = typeof win?.matchMedia === "function" ? win.matchMedia("(pointer: coarse)") : null;
	const isCoarse = () => Boolean(coarseQuery && coarseQuery.matches);

	const popoverOpen = () => {
		try {
			return root.matches(":popover-open");
		} catch {
			return false;
		}
	};

	const closePopover = () => {
		if (!popoverOpen()) return;
		try {
			root.hidePopover();
		} catch {
			// The node may have been moved or removed by the page between the two calls.
		}
	};

	const ensureSelectedMounted = () => {
		if (!doc.body) return;
		if (selected.parentNode !== doc.body) doc.body.append(selected);
	};

	const applyRect = (el, rect) => {
		el.style.left = `${rect.x}px`;
		el.style.top = `${rect.y}px`;
		el.style.width = `${rect.w}px`;
		el.style.height = `${rect.h}px`;
	};

	const placeLabel = (rect) => {
		// CSS pixels relative to the root (the root spans the viewport). Measure once shown;
		// before the popover is open offset sizes are 0, so use a small estimate.
		let width = label.offsetWidth;
		let height = label.offsetHeight;
		if (!width) width = Math.min(240, label.textContent.length * 7 + 12);
		if (!height) height = 21;

		const view = win?.visualViewport || null;
		const left = view ? view.offsetLeft : 0;
		const top = view ? view.offsetTop : 0;
		const widthLimit = view ? view.width : win?.innerWidth || doc.documentElement.clientWidth || 0;
		const heightLimit = view ? view.height : win?.innerHeight || doc.documentElement.clientHeight || 0;

		const above = rect.y - height - 4 >= top;
		const rawX = rect.x;
		const rawY = above ? rect.y - height - 4 : rect.y + rect.h + 4;
		const maxX = left + widthLimit - width - 4;
		const maxY = top + heightLimit - height - 4;
		label.style.left = `${Math.max(left + 4, Math.min(maxX, rawX))}px`;
		label.style.top = `${Math.max(top + 4, Math.min(maxY, rawY))}px`;
	};

	const showLabel = (text) => {
		label.textContent = text;
		label.hidden = isCoarse() || text === "";
		return !label.hidden;
	};

	const refreshLabel = () => {
		if (!lastRect || label.hidden) return;
		placeLabel(lastRect);
	};

	const onCoarseChange = () => {
		if (!lastRect) return;
		if (isCoarse()) label.hidden = true;
		else if (label.textContent !== "") label.hidden = false;
		refreshLabel();
	};

	if (coarseQuery) {
		if (typeof coarseQuery.addEventListener === "function") coarseQuery.addEventListener("change", onCoarseChange);
		else if (typeof coarseQuery.addListener === "function") coarseQuery.addListener(onCoarseChange);
	}

	const onCancel = () => {
		if (destroyed) return;
		if (typeof cancelFn === "function") cancelFn();
	};
	cancel.addEventListener("click", onCancel);

	return {
		showPicking() {
			if (destroyed) return;
			setEdge("top");
			ensureSelectedMounted();
			selected.hidden = true;
			closePopover();
			const parent = doc.querySelector("dialog:modal") || doc.body;
			if (root.parentNode !== parent) parent.append(root);
			try {
				root.showPopover();
			} catch {
				// A page in a partially-loaded state can lack the top layer; the fixed root still draws.
			}
		},

		showSelected() {
			if (destroyed) return;
			closePopover();
			box.hidden = true;
			label.hidden = true;
			ensureSelectedMounted();
			selected.hidden = false;
			if (lastRect) applyRect(selected, lastRect);
			else {
				selected.style.left = "0px";
				selected.style.top = "0px";
				selected.style.width = "0px";
				selected.style.height = "0px";
			}
		},

		hide() {
			if (destroyed) return;
			closePopover();
			box.hidden = true;
			label.hidden = true;
			selected.hidden = true;
		},

		highlight(rect, text) {
			if (destroyed) return;
			if (rect === null || rect === undefined) {
				lastRect = null;
				box.hidden = true;
				label.hidden = true;
				selected.hidden = true;
				return;
			}
			const value = {
				x: Number(rect.x) || 0,
				y: Number(rect.y) || 0,
				w: Number(rect.w) || 0,
				h: Number(rect.h) || 0,
			};
			lastRect = value;
			box.hidden = false;
			applyRect(box, value);
			applyRect(selected, value);
			const shown = showLabel(text === null || text === undefined ? "" : String(text));
			if (shown) placeLabel(value);
		},

		setHint(text) {
			if (destroyed) return;
			hint.textContent = text === null || text === undefined ? DEFAULT_HINT : String(text);
			bar.setAttribute("aria-label", hint.textContent);
		},

		onCancel(fn) {
			if (destroyed) return;
			cancelFn = typeof fn === "function" ? fn : null;
		},

		contains(node) {
			if (!node || destroyed) return false;
			return root.contains(node) || selected.contains(node);
		},

		destroy() {
			if (destroyed) return;
			destroyed = true;
			bar.removeEventListener("pointerenter", onBarEnter);
			bar.removeEventListener("pointerdown", onBarDown);
			cancel.removeEventListener("click", onCancel);
			if (coarseQuery) {
				if (typeof coarseQuery.removeEventListener === "function") coarseQuery.removeEventListener("change", onCoarseChange);
				else if (typeof coarseQuery.removeListener === "function") coarseQuery.removeListener(onCoarseChange);
			}
			closePopover();
			root.remove();
			selected.remove();
			doc.head?.querySelector("link[data-report-overlay-style]")?.remove();
		},
	};
}
