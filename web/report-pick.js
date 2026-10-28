/* Capture page input without disabling native touch scrolling. Frame listeners
 * use their own viewport coordinates for hit testing and top coordinates to draw.
 */
export function startPick({ win, overlay, describeLabel, onPick, onCancel }) {
	let stopped = false;
	let state = "picking";
	let tracking = null;
	let hover = null;
	let point = null;
	let dirty = true;
	let frameId;
	let clearGuard = null;
	const pointers = new Set();
	const realms = new Map();
	const frames = new Map();
	const blocked = ["pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "dragstart", "selectstart"];
	const prevent = new Set(["click", "dblclick", "auxclick", "contextmenu", "dragstart", "selectstart"]);
	const passive = { capture: true, passive: true };

	function offset(realm) {
		let x = 0;
		let y = 0;
		while (realm !== win) {
			const frame = realm.frameElement;
			if (!frame) break;
			const rect = frame.getBoundingClientRect();
			x += rect.left + frame.clientLeft;
			y += rect.top + frame.clientTop;
			realm = frame.ownerDocument.defaultView;
		}
		return { x, y };
	}

	function hit(doc, x, y) {
		const element = doc.elementFromPoint(x, y);
		if (!element || overlay.contains(element)) return null;
		let el = element;
		// Painted layers may refuse pointer events (the viewer image and its mark
		// canvas), so elementFromPoint stops at their container. Descend into
		// such children; a canvas gives way to any other qualifying sibling.
		for (;;) {
			let next = null;
			let canvas = null;
			for (const child of [...el.children].reverse()) {
				if (overlay.contains(child)) continue;
				const style = doc.defaultView.getComputedStyle(child);
				if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents !== "none") continue;
				const rect = child.getBoundingClientRect();
				if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
				if (child.tagName === "CANVAS") {
					canvas ??= child;
					continue;
				}
				next = child;
				break;
			}
			next ??= canvas;
			if (!next) break;
			el = next;
		}
		if (el.tagName === "IFRAME") {
			try {
				const child = el.contentDocument;
				if (child) {
					const rect = el.getBoundingClientRect();
					return hit(child, x - rect.left - el.clientLeft, y - rect.top - el.clientTop) || el;
				}
			} catch {
				// Cross-origin frames are selectable as a frame, never inspected.
			}
		}
		return el;
	}

	function highlight() {
		if (!hover || !hover.isConnected) {
			hover = null;
			overlay.highlight(null, null);
			return;
		}
		const bounds = hover.getBoundingClientRect();
		const origin = offset(hover.ownerDocument.defaultView);
		const rect = { x: bounds.left + origin.x, y: bounds.top + origin.y, w: bounds.width, h: bounds.height };
		overlay.highlight(rect, describeLabel(hover, { ...rect, width: bounds.width, height: bounds.height }));
	}

	function locate(event, realm) {
		const origin = offset(realm);
		point = { x: event.clientX + origin.x, y: event.clientY + origin.y };
		hover = hit(win.document, point.x, point.y);
		highlight();
	}

	function guardClick(element) {
		clearGuard?.();
		const targets = [...realms.keys()];
		const remove = () => {
			for (const realm of targets) {
				realm.removeEventListener("click", swallow, true);
				realm.removeEventListener("pointerdown", remove, true);
			}
			clearGuard = null;
		};
		const swallow = (event) => {
			if (overlay.contains(event.target)) return;
			// The compatibility click may target an ancestor after DOM changes.
			if (event.target !== element && !event.target?.contains?.(element) && !element.contains(event.target)) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			remove();
		};
		for (const realm of targets) {
			realm.addEventListener("click", swallow, true);
			realm.addEventListener("pointerdown", remove, true);
		}
		clearGuard = remove;
	}

	function pick(element) {
		if (!element) return;
		guardClick(element);
		onPick({ element });
	}

	function gesture() {
		if (state === "tracking") state = "gesturing";
		dirty = true;
	}

	function attach(realm) {
		if (realms.has(realm)) return;
		const removers = [];
		const listen = (target, type, fn, options = true) => {
			target.addEventListener(type, fn, options);
			removers.push(() => target.removeEventListener(type, fn, options));
		};
		realms.set(realm, removers);
		let scale = realm.visualViewport?.scale;
		const handle = (event) => {
			if (overlay.contains(event.target)) return;
			if (event.type === "pointerdown" || event.type === "click") clearGuard?.();
			event.stopImmediatePropagation();
			if (prevent.has(event.type) || (event.type === "pointerdown" && event.pointerType === "mouse")) event.preventDefault();
			if (event.type === "pointerdown") {
				pointers.add(event.pointerId);
				if (pointers.size > 1) gesture();
				else if (event.isPrimary && event.button === 0) {
					locate(event, realm);
					tracking = { x: point.x, y: point.y, time: event.timeStamp, target: hover, id: event.pointerId };
					state = "tracking";
				}
			} else if (event.type === "pointermove") {
				const origin = offset(realm);
				if (tracking && Math.hypot(event.clientX + origin.x - tracking.x, event.clientY + origin.y - tracking.y) > 8) gesture();
				if (event.pointerType !== "touch" && state !== "gesturing") locate(event, realm);
			} else if (event.type === "pointercancel") {
				gesture();
				pointers.delete(event.pointerId);
				if (!pointers.size) {
					state = "picking";
					tracking = null;
				}
			} else if (event.type === "pointerup") {
				const origin = offset(realm);
				const chosen = state === "tracking" && tracking?.id === event.pointerId
					&& Math.hypot(event.clientX + origin.x - tracking.x, event.clientY + origin.y - tracking.y) <= 8
					&& event.timeStamp - tracking.time <= 500 ? tracking.target : null;
				pointers.delete(event.pointerId);
				if (!pointers.size) {
					state = "picking";
					tracking = null;
				}
				pick(chosen);
			}
		};
		for (const type of blocked) listen(realm, type, handle);
		for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "wheel"]) {
			listen(realm, type, (event) => {
				if (!overlay.contains(event.target)) event.stopImmediatePropagation();
			}, passive);
		}
		listen(realm, "keydown", (event) => {
			if (overlay.contains(event.target)) return;
			if (event.key !== "Escape" && event.key !== "Enter") return;
			event.stopImmediatePropagation();
			event.preventDefault();
			if (event.key === "Escape") onCancel();
			else pick(hover);
		});
		listen(realm, "scroll", gesture, passive);
		listen(realm, "resize", () => { dirty = true; });
		if (realm.visualViewport) {
			const viewport = () => {
				if (realm.visualViewport.scale !== scale) gesture();
				scale = realm.visualViewport.scale;
				dirty = true;
			};
			listen(realm.visualViewport, "resize", viewport, passive);
			listen(realm.visualViewport, "scroll", viewport, passive);
		}
		for (const frame of realm.document.querySelectorAll("iframe")) {
			if (!frames.has(frame)) {
				const load = () => {
					const previous = frames.get(frame).realm;
					for (const remove of realms.get(previous) || []) remove();
					realms.delete(previous);
					frames.get(frame).realm = null;
					discover(frame);
					dirty = true;
				};
				frame.addEventListener("load", load, true);
				frames.set(frame, { load, realm: null });
			}
			discover(frame);
		}
	}

	function discover(frame) {
		try {
			if (frame.contentDocument) {
				frames.get(frame).realm = frame.contentWindow;
				attach(frame.contentWindow);
			}
		} catch {
			// Reading a cross-origin frame is forbidden by the browser.
		}
	}

	function tick() {
		if (stopped) return;
		if (dirty && point) hover = hit(win.document, point.x, point.y);
		dirty = false;
		highlight();
		frameId = win.requestAnimationFrame(tick);
	}

	attach(win);
	frameId = win.requestAnimationFrame(tick);
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			win.cancelAnimationFrame(frameId);
			for (const removers of realms.values()) for (const remove of removers) remove();
			for (const [frame, { load }] of frames) frame.removeEventListener("load", load, true);
			realms.clear();
			frames.clear();
			// Only the gesture's one-shot compatibility-click guard outlives stop:
			// onPick commonly stops synchronously, before the browser emits click.
		},
	};
}
