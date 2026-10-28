import test from "node:test";
import assert from "node:assert/strict";
import {
	uniqueSelector,
	domPath,
	elementLabel,
	textExcerpt,
	devtoolsLabel,
	describeElement,
	describeView,
} from "../web/report-describe.js";

// The module runs in browsers, where CSS.escape exists. Supply the same shape
// for the fake tree; every identifier the module emits goes through it.
globalThis.CSS = {
	escape(value) {
		return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
	},
};

class FakeClassList {
	constructor(names) {
		this.names = [...names];
	}
	contains(name) {
		return this.names.includes(name);
	}
	[Symbol.iterator]() {
		return this.names[Symbol.iterator]();
	}
}

class FakeElement {
	constructor(doc, tagName, options = {}) {
		this.ownerDocument = doc;
		this.tagName = tagName.toUpperCase();
		this.nodeType = 1;
		this.id = options.id || "";
		this.classList = new FakeClassList(options.classes || []);
		this.attributes = { ...(options.attrs || {}) };
		if (this.id) this.attributes.id = this.id;
		this.parentElement = null;
		this.children = [];
		this.innerText = options.innerText || "";
		this.textContent = options.textContent ?? this.innerText;
		this.value = options.value ?? "";
		this.isConnected = options.connected !== false;
		this.rect = options.rect || { x: 0, y: 0, width: 0, height: 0 };
	}
	append(...kids) {
		for (const kid of kids) {
			kid.parentElement = this;
			kid.ownerDocument = this.ownerDocument;
			kid.isConnected = this.isConnected;
			this.children.push(kid);
		}
		return kids.length === 1 ? kids[0] : kids;
	}
	getAttribute(name) {
		return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
	}
	getBoundingClientRect() {
		return this.rect;
	}
}

function unescapeIdent(text) {
	return String(text).replace(/\\(.)/g, "$1");
}

function parseSegment(selector) {
	const parsed = { tag: null, id: null, classes: [], attrs: [], nth: null };
	let rest = selector;
	if (rest.startsWith("#")) {
		parsed.id = unescapeIdent(rest.slice(1));
		return parsed;
	}
	const tag = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
	if (tag) {
		parsed.tag = tag[1].toLowerCase();
		rest = rest.slice(tag[0].length);
	}
	while (rest.length > 0) {
		if (rest.startsWith(".")) {
			const name = /^\.([^.#[:]+)/.exec(rest);
			if (!name) throw new Error(`bad class in ${selector}`);
			parsed.classes.push(unescapeIdent(name[1]));
			rest = rest.slice(name[0].length);
		} else if (rest.startsWith("[")) {
			const attr = /^\[([^\]=]+)="([^"]*)"\]/.exec(rest);
			if (!attr) throw new Error(`bad attribute in ${selector}`);
			parsed.attrs.push([attr[1], attr[2].replace(/\\(.)/g, "$1")]);
			rest = rest.slice(attr[0].length);
		} else if (rest.startsWith(":")) {
			const nth = /^:nth-of-type\((\d+)\)/.exec(rest);
			if (!nth) throw new Error(`bad pseudo in ${selector}`);
			parsed.nth = Number(nth[1]);
			rest = rest.slice(nth[0].length);
		} else {
			throw new Error(`unparsed selector ${selector} at ${rest}`);
		}
	}
	return parsed;
}

function matchesSegment(el, parsed) {
	if (parsed.tag && el.tagName.toLowerCase() !== parsed.tag) return false;
	if (parsed.id !== null && el.id !== parsed.id) return false;
	if (!parsed.classes.every((name) => el.classList.contains(name))) return false;
	if (!parsed.attrs.every(([name, value]) => el.getAttribute(name) === value)) return false;
	if (parsed.nth !== null) {
		const parent = el.parentElement;
		if (!parent) return false;
		const siblings = parent.children.filter((kid) => kid.tagName === el.tagName);
		if (siblings.indexOf(el) + 1 !== parsed.nth) return false;
	}
	return true;
}

class FakeDocument {
	constructor() {
		this.documentElement = null;
	}
	allElements() {
		const out = [];
		const walk = (el) => {
			out.push(el);
			for (const kid of el.children) walk(kid);
		};
		if (this.documentElement) walk(this.documentElement);
		return out;
	}
	querySelectorAll(selector) {
		let pool = this.allElements();
		for (const part of selector.split(" > ")) {
			const parsed = parseSegment(part);
			pool = pool.filter((el) => matchesSegment(el, parsed));
		}
		return pool;
	}
	getElementById(id) {
		return this.allElements().find((el) => el.id === id) || null;
	}
}

function makeTree(build) {
	const doc = new FakeDocument();
	const html = new FakeElement(doc, "html");
	doc.documentElement = html;
	const body = html.append(new FakeElement(doc, "body"));
	const el = (tag, options) => new FakeElement(doc, tag, options);
	build({ doc, html, body, el });
	return { doc, html, body, el };
}

test("id is the preferred selector", () => {
	const { body, el } = makeTree(() => {});
	const button = body.append(el("button", { id: "send" }));
	assert.deepEqual(uniqueSelector(button), { selector: "#send", stability: "id" });
});

test("volatile ids are skipped", () => {
	const { body, el } = makeTree(() => {});
	const button = body.append(el("button", { id: "item-1234", classes: ["save-btn"] }));
	const result = uniqueSelector(button);
	assert.equal(result.selector, "button.save-btn");
	assert.equal(result.stability, "class");
});

test("data-action attribute becomes a data selector", () => {
	const { body, el } = makeTree(() => {});
	body.append(el("button", { classes: ["one"] }));
	const target = body.append(el("button", { attrs: { "data-action": "send" } }));
	assert.deepEqual(uniqueSelector(target), { selector: 'button[data-action="send"]', stability: "data" });
});

test("two identical buttons yield an nth-of-type path for the second", () => {
	const { body, el } = makeTree(() => {});
	body.append(el("button", { classes: ["go"] }));
	const second = body.append(el("button", { classes: ["go"] }));
	const result = uniqueSelector(second);
	assert.equal(result.selector, "button:nth-of-type(2)");
	assert.equal(result.stability, "structural");
});

test("transient classes are not used as a selector", () => {
	const { body, el } = makeTree(() => {});
	const button = body.append(el("button", { classes: ["active", "is-open", "loading"] }));
	const result = uniqueSelector(button);
	assert.equal(result.selector, "button");
	assert.equal(result.stability, "structural");
});

test("a stable class is used when the tag is not unique", () => {
	const { body, el } = makeTree(() => {});
	body.append(el("button", { classes: ["cancel-btn"] }));
	const target = body.append(el("button", { classes: ["send-btn"] }));
	assert.deepEqual(uniqueSelector(target), { selector: "button.send-btn", stability: "class" });
});

test("a class pair is tried when a single class is not unique", () => {
	const { body, el } = makeTree(() => {});
	body.append(el("button", { classes: ["send-btn", "wide"] }));
	const target = body.append(el("button", { classes: ["send-btn", "narrow"] }));
	body.append(el("button", { classes: ["narrow", "wide"] }));
	const result = uniqueSelector(target);
	assert.equal(result.selector, "button.send-btn.narrow");
	assert.equal(result.stability, "class");
});

test("elementLabel uses the Korean role word and visible text", () => {
	const { body, el } = makeTree(() => {});
	const cases = [
		["button", { innerText: "  보내기  " }, "버튼 · 보내기"],
		["a", { innerText: "열기" }, "링크 · 열기"],
		["iframe", {}, "프레임"],
		["img", { attrs: { alt: "사진" } }, "이미지 · 사진"],
		["input", { attrs: { "aria-label": "이름" } }, "입력란 · 이름"],
		["h2", { innerText: "제목" }, "제목 · 제목"],
		["li", { innerText: "항목" }, "항목 · 항목"],
		["svg", {}, "도식"],
		["div", {}, "영역"],
	];
	for (const [tag, options, expected] of cases) {
		assert.equal(elementLabel(body.append(el(tag, options))), expected, tag);
	}
});

test("aria-labelledby text wins over visible text", () => {
	const { body, el } = makeTree(() => {});
	const label = body.append(el("span", { id: "lbl", innerText: "저장" }));
	const button = body.append(el("button", { attrs: { "aria-labelledby": "lbl", "aria-label": "" }, innerText: "다른 글" }));
	assert.equal(elementLabel(button), "버튼 · 저장");
	assert.equal(label.innerText, "저장");
});

test("input values never reach the excerpt", () => {
	const { body, el } = makeTree(() => {});
	const area = body.append(el("textarea", { value: "secret", innerText: "secret" }));
	assert.deepEqual(textExcerpt(area), { text: "", truncated: false });
	const input = body.append(el("input", { value: "hunter2" }));
	assert.deepEqual(textExcerpt(input), { text: "", truncated: false });
});

test("textExcerpt distinguishes invisible DOM text from visible text", () => {
	const { body, el } = makeTree(() => {});
	const div = body.append(el("div", { innerText: "  첫 줄\n\n 둘째   줄 " }));
	assert.deepEqual(textExcerpt(div), { text: "첫 줄 둘째 줄", truncated: false });
});

test("textExcerpt truncates on a UTF-8 byte boundary", () => {
	const { body, el } = makeTree(() => {});
	const div = body.append(el("div", { innerText: "가".repeat(300) }));
	const result = textExcerpt(div, { max: 512 });
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= 512);
	assert.equal(result.text.length, 170);
});

test("devtoolsLabel shows tag, id, two classes and rounded size", () => {
	const { body, el } = makeTree(() => {});
	const button = body.append(el("button", { id: "send", classes: ["primary", "wide", "extra"] }));
	assert.equal(devtoolsLabel(button, { width: 100.4, height: 32.6 }), "button#send.primary.wide 100×33");
});

test("domPath truncates from the top and reports it", () => {
	const { body, el } = makeTree(() => {});
	let node = body;
	for (let i = 0; i < 40; i += 1) node = node.append(el("div", { classes: [`level-${i}`] }));
	const result = domPath(node, { max: 10 });
	const parts = result.path.split(" > ");
	assert.equal(parts.length, 10);
	assert.equal(result.truncated, true);
	assert.equal(parts[0], "div.level-30");
	assert.equal(parts[9], "div.level-39");
});

test("domPath caps at 32 segments by default", () => {
	const { body, el } = makeTree(() => {});
	let node = body;
	for (let i = 0; i < 40; i += 1) node = node.append(el("div"));
	const result = domPath(node);
	assert.equal(result.path.split(" > ").length, 32);
	assert.equal(result.truncated, true);
});

test("describeElement builds the contract descriptor with a rounded rect", () => {
	const { body, el } = makeTree(() => {});
	const button = body.append(el("button", {
		id: "send",
		classes: ["primary", "wide"],
		attrs: { role: "button" },
		innerText: "보내기",
		rect: { x: 1.234, y: -2.345, width: 100.005, height: 32.555 },
	}));
	const descriptor = describeElement(button);
	assert.equal(descriptor.selector, "#send");
	assert.equal(descriptor.selectorStability, "id");
	assert.equal(descriptor.domPath, "html > body > button#send.primary.wide");
	assert.equal(descriptor.domPathTruncated, false);
	assert.equal(descriptor.tag, "button");
	assert.equal(descriptor.role, "button");
	assert.equal(descriptor.label, "버튼 · 보내기");
	assert.equal(descriptor.textExcerpt, "보내기");
	assert.equal(descriptor.excerptTruncated, false);
	assert.deepEqual(descriptor.rect, { x: 1.23, y: -2.35, w: 100.01, h: 32.56 });
});

test("a disconnected element has no selector", () => {
	const { el } = makeTree(() => {});
	const ghost = el("button", { id: "ghost", connected: false });
	assert.deepEqual(uniqueSelector(ghost), { selector: null, stability: "unavailable" });
});

test("describeView reads layout, visual viewport, scheme and pointer", () => {
	const win = {
		innerWidth: 390,
		innerHeight: 844,
		scrollX: 3,
		scrollY: 7,
		devicePixelRatio: 3,
		visualViewport: { offsetLeft: 1, offsetTop: 2, width: 388, height: 800, scale: 1.5 },
		matchMedia(query) {
			return { matches: query === "(prefers-color-scheme: dark)" || query === "(pointer: coarse)" };
		},
	};
	assert.deepEqual(describeView(win), {
		layout: { w: 390, h: 844 },
		visual: { x: 1, y: 2, w: 388, h: 800, scale: 1.5 },
		scroll: { x: 3, y: 7 },
		dpr: 3,
		colorScheme: "dark",
		pointer: "coarse",
	});
});

test("describeView defaults to light and fine without matches", () => {
	const win = {
		innerWidth: 1280,
		innerHeight: 800,
		scrollX: 0,
		scrollY: 0,
		devicePixelRatio: 1,
		matchMedia() {
			return { matches: false };
		},
	};
	const view = describeView(win);
	assert.equal(view.colorScheme, "light");
	assert.equal(view.pointer, "fine");
	assert.deepEqual(view.visual, { x: 0, y: 0, w: 1280, h: 800, scale: 1 });
});
