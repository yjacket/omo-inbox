const probes = new WeakMap();
const SVG = "http://www.w3.org/2000/svg";
const XHTML = "http://www.w3.org/1999/xhtml";

function decode(win, source, deadlineMs) {
	const image = new win.Image();
	image.src = source;
	return new Promise((resolve, reject) => {
		const timer = win.setTimeout(() => reject(new Error("timeout")), deadlineMs);
		image.decode().then(() => {
			win.clearTimeout(timer);
			resolve(image);
		}, (error) => {
			win.clearTimeout(timer);
			reject(error);
		});
	});
}

function capability(win, deadlineMs) {
	if (!probes.has(win)) {
		probes.set(win, (async () => {
			try {
				const image = await decode(win, "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="${SVG}" width="8" height="8"><foreignObject width="8" height="8"><div xmlns="${XHTML}" style="width:8px;height:8px;background:#d21e3c"></div></foreignObject></svg>`), deadlineMs);
				const canvas = win.document.createElement("canvas");
				canvas.width = canvas.height = 8;
				const ctx = canvas.getContext("2d");
				ctx.drawImage(image, 0, 0);
				return [...ctx.getImageData(4, 4, 1, 1).data].every((value, i) => Math.abs(value - [210, 30, 60, 255][i]) <= 2);
			} catch {
				return false;
			}
		})());
	}
	return probes.get(win);
}

export async function snapshotElement(el, { pad = 12, maxSide = 4096, maxPixels = 2097152, scale, deadlineMs = 5000 } = {}) {
	const doc = el.ownerDocument;
	const win = doc.defaultView;
	const controller = new win.AbortController();
	let timer;
	try {
		const started = win.performance.now();
		const remaining = () => Math.max(1, deadlineMs - (win.performance.now() - started));
		const capture = async () => {
			if (!await capability(win, remaining())) return { ok: false, reason: "unsupported" };
			const r = el.getBoundingClientRect();
			const v = win.visualViewport;
			const x = Math.max(r.left - pad, v?.offsetLeft ?? 0);
			const y = Math.max(r.top - pad, v?.offsetTop ?? 0);
			const w = Math.min(r.right + pad, (v?.offsetLeft ?? 0) + (v?.width ?? win.innerWidth)) - x;
			const h = Math.min(r.bottom + pad, (v?.offsetTop ?? 0) + (v?.height ?? win.innerHeight)) - y;
			if (w <= 0 || h <= 0 || r.width <= 0 || r.height <= 0) return { ok: false, reason: "offscreen" };
			const walker = doc.createTreeWalker(el, win.NodeFilter.SHOW_ELEMENT);
			let count = 1;
			while (walker.nextNode()) if (++count > 1000) return { ok: false, reason: "too_large" };
			const s = Math.min(scale ?? win.devicePixelRatio, win.devicePixelRatio, 2, Math.min(maxSide, 4096) / w, Math.min(maxSide, 4096) / h, Math.sqrt(Math.min(maxPixels, 2097152) / (w * h)));
			const width = Math.max(1, Math.floor(w * s));
			const height = Math.max(1, Math.floor(h * s));
			const warnings = new Set();
			const jobs = [];
			const rules = [];
			let bytes = 0;
			let serial = 0;
			const dataURL = (blob) => new Promise((resolve, reject) => {
				const reader = new win.FileReader();
				reader.onload = () => resolve(reader.result);
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(blob);
			});
			const embedBackground = async (style) => {
				const value = style.getPropertyValue("background-image");
				const matches = [...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)];
				if (!matches.length) return;
				try {
					let result = value;
					for (const match of matches) {
						const url = new win.URL(match[1] ?? match[2] ?? match[3].trim(), doc.baseURI);
						if (url.origin !== win.location.origin) throw new Error("origin");
						const response = await win.fetch(url.href, { signal: controller.signal, redirect: "error" });
						if (!response.ok || Number(response.headers.get("content-length")) > 8388608 - bytes) throw new Error("size");
						const reader = response.body.getReader();
						const chunks = [];
						try {
							for (;;) {
								const { done, value: chunk } = await reader.read();
								if (done) break;
								bytes += chunk.byteLength;
								if (bytes > 8388608) throw new Error("size");
								chunks.push(chunk);
							}
						} finally {
							await reader.cancel();
						}
						const data = await dataURL(new win.Blob(chunks, { type: response.headers.get("content-type") || "image/png" }));
						result = result.replace(match[0], `url("${data}")`);
					}
					style.setProperty("background-image", result);
				} catch (error) {
					if (error.name === "SecurityError") throw error;
					style.setProperty("background-image", "none");
					warnings.add("css-image");
				}
			};
			const copyStyle = (source, target, pseudo) => {
				const cs = win.getComputedStyle(source, pseudo);
				for (const prop of cs) {
					const value = cs.getPropertyValue(prop);
					target.style.setProperty(prop, value);
					// Only background images are fetched; other URL-bearing styles cannot escape the snapshot.
					if (prop !== "background-image" && /url\(/i.test(value)) target.style.setProperty(prop, "none");
				}
				jobs.push(() => embedBackground(target.style));
				return cs;
			};
			const clone = (source) => {
				if (source.matches("script,style,link,iframe,object,embed,[data-report-overlay],[data-report-selected]")) return null;
				let target = source.cloneNode(false);
				const tag = source.localName;
				if (["input", "textarea", "select"].includes(tag)) {
					target = doc.createElement("span");
					target.textContent = tag === "input" && source.type === "password" ? "\u2022".repeat(source.value.length) : "";
				}
				for (const attr of [...target.attributes]) {
					if (/^on/i.test(attr.name) || ["src", "srcset", "loading", "href", "xlink:href", "poster", "value", "data-report-overlay", "data-report-selected"].includes(attr.name.toLowerCase())) target.removeAttribute(attr.name);
				}
				copyStyle(source, target);
				const id = String(serial++);
				target.setAttribute("data-snap", id);
				for (const pseudo of ["::before", "::after"]) {
					const content = win.getComputedStyle(source, pseudo).content;
					if (!content || content === "none" || content === "normal") continue;
					const holder = doc.createElement("span");
					copyStyle(source, holder, pseudo);
					rules.push({ id, pseudo, holder });
				}
				if (tag === "img" || tag === "canvas") {
					try {
						let data;
						if (tag === "canvas") {
							data = source.toDataURL("image/png");
						} else {
							const url = new win.URL(source.currentSrc || source.src, doc.baseURI);
							if (url.origin !== win.location.origin || !source.complete || !source.naturalWidth) throw new Error("image");
							const rect = source.getBoundingClientRect();
							const canvas = doc.createElement("canvas");
							canvas.width = Math.max(1, Math.floor(rect.width * s));
							canvas.height = Math.max(1, Math.floor(rect.height * s));
							canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
							data = canvas.toDataURL("image/png");
						}
						if (tag === "canvas") {
							const image = doc.createElement("img");
							for (const attr of target.attributes) image.setAttribute(attr.name, attr.value);
							target = image;
						}
						target.setAttribute("src", data);
					} catch (error) {
						if (tag !== "canvas" && error.name === "SecurityError") throw error;
						warnings.add(tag === "canvas" ? "canvas" : "image");
						if (tag === "canvas") target = Object.assign(doc.createElement("span"), { style: target.style.cssText });
					}
				}
				if (!["input", "textarea", "select", "canvas"].includes(tag)) {
					for (const child of source.childNodes) {
						const copied = child.nodeType === 1 ? clone(child) : child.nodeType === 3 ? child.cloneNode() : null;
						if (copied) target.append(copied);
					}
				}
				return target;
			};
			const copied = clone(el);
			if (!copied) return { ok: false, reason: "offscreen" };
			let next = 0;
			await Promise.all([0, 1].map(async () => {
				while (next < jobs.length) await jobs[next++]();
			}));
			const svg = doc.createElementNS(SVG, "svg");
			svg.setAttribute("width", width);
			svg.setAttribute("height", height);
			svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
			const foreign = doc.createElementNS(SVG, "foreignObject");
			for (const [key, value] of Object.entries({ x: 0, y: 0, width: w, height: h })) foreign.setAttribute(key, value);
			const wrapper = doc.createElementNS(XHTML, "div");
			const background = win.getComputedStyle(doc.body || doc.documentElement).backgroundColor;
			wrapper.style.cssText = `position:relative;width:${w}px;height:${h}px;background:${background};`;
			const style = doc.createElement("style");
			style.textContent = rules.map(({ id, pseudo, holder }) => `[data-snap="${id}"]${pseudo}{${holder.style.cssText}}`).join("\n");
			wrapper.append(style, copied);
			// Important physical offsets override copied logical inset/size declarations too.
			for (const [key, value] of Object.entries({ position: "absolute", margin: "0", left: `${r.left - x}px`, top: `${r.top - y}px`, width: `${r.width}px`, height: `${r.height}px`, "box-sizing": "border-box", transform: "none" })) copied.style.setProperty(key, value, "important");
			foreign.append(wrapper);
			svg.append(foreign);
			const xml = new win.XMLSerializer().serializeToString(svg);
			const image = await decode(win, "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml), remaining());
			const canvas = doc.createElement("canvas");
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#fff";
			ctx.fillRect(0, 0, width, height);
			ctx.fillStyle = background;
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(image, 0, 0, width, height);
			ctx.strokeStyle = "#1463ff";
			ctx.lineWidth = 2 * s;
			ctx.strokeRect((r.left - x) * s, (r.top - y) * s, r.width * s, r.height * s);
			return { ok: true, png: canvas.toDataURL("image/png").split(",")[1], width, height, warnings: [...warnings] };
		};
		return await Promise.race([capture(), new Promise((resolve) => {
			timer = win.setTimeout(() => {
				controller.abort();
				resolve({ ok: false, reason: "timeout" });
			}, deadlineMs);
		})]);
	} catch (error) {
		return { ok: false, reason: error.name === "SecurityError" ? "tainted" : error.message === "timeout" ? "timeout" : "unsupported" };
	} finally {
		win.clearTimeout(timer);
		controller.abort();
	}
}
