/* Element and view descriptors for report picking: a unique selector, a readable
 * DOM path, a Korean role label, a bounded text excerpt, and the layout/view
 * values the report contract stores. Browser ES module with no imports.
 */

const MAX_SELECTOR_BYTES = 2048;
const MAX_PATH_LEVELS = 64;
const MAX_TEXT_CHARS = 40;
const EXCERPT_BYTES = 512;
const DEFAULT_DOM_PATH = 32;

const DATA_ATTRS = ["data-action", "data-key", "data-id", "data-item", "data-testid", "data-issue-report"];
const CLASS_NAME = /^[a-z][a-z-]{2,}$/;
const CLASS_EXCLUDED = /^(active|selected|open|loading|hidden)$/;
const VOLATILE_ID = /\d{3,}|^[0-9]|:/;

const ROLE_WORD = {
	a: "링크",
	button: "버튼",
	iframe: "프레임",
	img: "이미지",
	input: "입력란",
	li: "항목",
	select: "입력란",
	svg: "도식",
	textarea: "입력란",
};
const FIELD_TAGS = new Set(["input", "textarea", "select"]);

function tagOf(el) {
	return String(el && el.tagName ? el.tagName : "").toLowerCase();
}

function byteLength(text) {
	return new TextEncoder().encode(text).length;
}

function escapeIdent(value) {
	const text = String(value);
	if (typeof globalThis.CSS === "object" && globalThis.CSS !== null && typeof globalThis.CSS.escape === "function") {
		return globalThis.CSS.escape(text);
	}
	return text.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function escapeAttr(value) {
	return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function classListOf(el) {
	const list = el && el.classList;
	if (!list) return [];
	const out = [];
	if (typeof list[Symbol.iterator] === "function") {
		for (const name of list) out.push(String(name));
	} else if (typeof list.length === "number") {
		for (let i = 0; i < list.length; i += 1) out.push(String(list[i]));
	}
	return out.filter((name) => CLASS_NAME.test(name) && !CLASS_EXCLUDED.test(name) && !name.startsWith("is-"));
}

function allClassesOf(el) {
	const list = el && el.classList;
	if (!list) return [];
	const out = [];
	if (typeof list[Symbol.iterator] === "function") {
		for (const name of list) out.push(String(name));
	} else if (typeof list.length === "number") {
		for (let i = 0; i < list.length; i += 1) out.push(String(list[i]));
	}
	return out;
}

function attribute(el, name) {
	if (!el || typeof el.getAttribute !== "function") return null;
	const value = el.getAttribute(name);
	return typeof value === "string" ? value : null;
}

// Candidate selectors for one element in preference order; each carries the
// stability word the contract records when it wins.
function candidates(el) {
	const tag = tagOf(el);
	const out = [];
	const id = el && typeof el.id === "string" ? el.id : "";
	if (id !== "" && !VOLATILE_ID.test(id)) out.push({ selector: `#${escapeIdent(id)}`, stability: "id" });
	for (const name of DATA_ATTRS) {
		const value = attribute(el, name);
		if (value !== null && value !== "" && [...value].length <= 80) {
			out.push({ selector: `${tag}[${name}="${escapeAttr(value)}"]`, stability: "data" });
		}
	}
	const lists = classListOf(el);
	for (const name of lists) out.push({ selector: `${tag}.${escapeIdent(name)}`, stability: "class" });
	for (let i = 0; i < lists.length; i += 1) {
		for (let j = i + 1; j < lists.length; j += 1) {
			out.push({ selector: `${tag}.${escapeIdent(lists[i])}.${escapeIdent(lists[j])}`, stability: "class" });
		}
	}
	if (tag !== "") out.push({ selector: tag, stability: "structural" });
	return out;
}

function uniqueInDocument(el, selector) {
	const doc = el && el.ownerDocument;
	if (!doc || typeof doc.querySelectorAll !== "function") return false;
	const found = doc.querySelectorAll(selector);
	return found && found.length === 1 && found[0] === el;
}

function nthOfType(el) {
	const parent = el && el.parentElement;
	const tag = tagOf(el);
	if (!parent || !parent.children) return `${tag}:nth-of-type(1)`;
	let index = 0;
	for (let i = 0; i < parent.children.length; i += 1) {
		const sibling = parent.children[i];
		if (tagOf(sibling) === tag) {
			index += 1;
			if (sibling === el) return `${tag}:nth-of-type(${index})`;
		}
	}
	return `${tag}:nth-of-type(1)`;
}

// One segment that is unique among the element's siblings, or nth-of-type.
function siblingSegment(el) {
	const parent = el && el.parentElement;
	if (!parent || !parent.children) return nthOfType(el);
	for (const candidate of candidates(el)) {
		let count = 0;
		let match = false;
		for (const sibling of parent.children) {
			if (siblingMatches(sibling, candidate.selector, el)) {
				count += 1;
				if (sibling === el) match = true;
			}
		}
		if (count === 1 && match) return candidate.selector;
	}
	return nthOfType(el);
}

// Minimal sibling matcher for the candidates this module emits. It never sees
// arbitrary selectors: only #id, tag[attr="v"], tag.class, tag, and chains.
function siblingMatches(el, selector, target) {
	const tag = tagOf(el);
	if (selector === tag) return true;
	let rest = selector;
	if (rest.startsWith("#")) return el.id === unescapeIdent(rest.slice(1));
	const colon = rest.indexOf(":");
	if (colon !== -1) rest = rest.slice(0, colon);
	const bracket = rest.indexOf("[");
	if (bracket !== -1) {
		const name = rest.slice(bracket + 1, rest.indexOf("="));
		const quoted = rest.slice(rest.indexOf("=") + 1, rest.lastIndexOf("]"));
		const value = unescapeAttr(quoted.replace(/^"|"$/g, ""));
		return tagOf(el) === rest.slice(0, bracket) && attribute(el, name) === value;
	}
	const pieces = rest.split(".");
	const wanted = pieces.slice(1);
	if (pieces[0] !== "" && pieces[0] !== tag) return false;
	const have = allClassesOf(el);
	return wanted.every((name) => have.includes(unescapeIdent(name)));
}

function unescapeIdent(text) {
	return String(text).replace(/\\([^0-9a-fA-F])/g, "$1");
}

function unescapeAttr(text) {
	return String(text).replace(/\\(.)/g, "$1");
}

export function uniqueSelector(el) {
	if (!el || !el.ownerDocument || el.isConnected === false) return { selector: null, stability: "unavailable" };
	for (const candidate of candidates(el)) {
		if (byteLength(candidate.selector) > MAX_SELECTOR_BYTES) continue;
		if (uniqueInDocument(el, candidate.selector)) return { selector: candidate.selector, stability: candidate.stability };
	}
	const parts = [];
	let node = el;
	let levels = 0;
	while (node && levels < MAX_PATH_LEVELS) {
		parts.unshift(siblingSegment(node));
		levels += 1;
		const path = parts.join(" > ");
		if (byteLength(path) > MAX_SELECTOR_BYTES) return { selector: null, stability: "unavailable" };
		if (uniqueInDocument(el, path)) return { selector: path, stability: "structural" };
		if (!node.parentElement) break;
		node = node.parentElement;
	}
	const path = parts.join(" > ");
	if (path === "" || byteLength(path) > MAX_SELECTOR_BYTES) return { selector: null, stability: "unavailable" };
	return { selector: path, stability: "structural" };
}

function pathSegment(el) {
	const tag = tagOf(el);
	const id = el && typeof el.id === "string" && el.id !== "" ? `#${escapeIdent(el.id)}` : "";
	const classes = allClassesOf(el).slice(0, 2).map((name) => `.${escapeIdent(name)}`).join("");
	return `${tag}${id}${classes}`;
}

export function domPath(el, options = {}) {
	const max = Number.isInteger(options.max) && options.max > 0 ? options.max : DEFAULT_DOM_PATH;
	const segments = [];
	let node = el;
	while (node && node.nodeType !== 9) {
		segments.unshift(pathSegment(node));
		node = node.parentElement;
	}
	const truncated = segments.length > max;
	return { path: (truncated ? segments.slice(segments.length - max) : segments).join(" > "), truncated };
}

function collapse(text) {
	return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

function clipChars(text, max) {
	const chars = [...text];
	return chars.length <= max ? text : chars.slice(0, max).join("");
}

function labelledByText(el) {
	const ids = collapse(attribute(el, "aria-labelledby"));
	if (ids === "") return "";
	const doc = el.ownerDocument;
	const words = [];
	for (const id of ids.split(" ")) {
		let target = null;
		if (doc && typeof doc.getElementById === "function") target = doc.getElementById(id);
		if (!target && doc && typeof doc.querySelectorAll === "function") {
			const found = doc.querySelectorAll(`#${escapeIdent(id)}`);
			target = found && found.length > 0 ? found[0] : null;
		}
		if (!target) continue;
		const text = typeof target.innerText === "string" ? target.innerText : target.textContent;
		const part = collapse(text);
		if (part !== "") words.push(part);
	}
	return words.join(" ");
}

function roleWordOf(el) {
	const tag = tagOf(el);
	if (ROLE_WORD[tag]) return ROLE_WORD[tag];
	if (/^h[1-6]$/.test(tag)) return "제목";
	return "영역";
}

export function elementLabel(el) {
	const word = roleWordOf(el);
	let text = collapse(attribute(el, "aria-label"));
	if (text === "") text = labelledByText(el);
	if (text === "") {
		const visible = typeof el.innerText === "string" ? el.innerText : el.textContent;
		text = collapse(visible);
	}
	if (text === "") text = collapse(attribute(el, "alt"));
	if (text === "") return word;
	return `${word} · ${clipChars(text, MAX_TEXT_CHARS)}`;
}

function truncateUtf8(text, maxBytes) {
	const encoder = new TextEncoder();
	if (encoder.encode(text).length <= maxBytes) return { text, truncated: false };
	const chars = [...text];
	let out = "";
	for (const ch of chars) {
		const next = out + ch;
		if (encoder.encode(next).length > maxBytes) break;
		out = next;
	}
	return { text: out, truncated: true };
}

export function textExcerpt(el, options = {}) {
	const max = Number.isInteger(options.max) && options.max >= 0 ? options.max : EXCERPT_BYTES;
	if (FIELD_TAGS.has(tagOf(el))) return { text: "", truncated: false };
	const visible = typeof el.innerText === "string" ? el.innerText : el.textContent;
	return truncateUtf8(collapse(visible), max);
}

export function devtoolsLabel(el, rect) {
	const tag = tagOf(el);
	const id = el && typeof el.id === "string" && el.id !== "" ? `#${el.id}` : "";
	const classes = allClassesOf(el).slice(0, 2).map((name) => `.${name}`).join("");
	const width = Math.round(Number(rect && rect.width) || 0);
	const height = Math.round(Number(rect && rect.height) || 0);
	return `${tag}${id}${classes} ${width}×${height}`;
}

function round(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

export function describeElement(el) {
	const selector = uniqueSelector(el);
	const path = domPath(el);
	const excerpt = textExcerpt(el);
	const box = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : {};
	return {
		selector: selector.selector,
		selectorStability: selector.stability,
		domPath: path.path,
		domPathTruncated: path.truncated,
		tag: tagOf(el),
		role: attribute(el, "role") || null,
		label: elementLabel(el),
		textExcerpt: excerpt.text,
		excerptTruncated: excerpt.truncated,
		rect: {
			x: round(box.x),
			y: round(box.y),
			w: round(box.width),
			h: round(box.height),
		},
	};
}

function media(win, query) {
	if (!win || typeof win.matchMedia !== "function") return false;
	const result = win.matchMedia(query);
	return Boolean(result && result.matches);
}

export function describeView(win) {
	const layout = {
		w: Number(win.innerWidth) || 0,
		h: Number(win.innerHeight) || 0,
	};
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
