import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { AdapterRegistrationError, createAdapterRegistry } from "../web/issue-adapters.js";

const ORIGIN = "http://127.0.0.1:4389";

function fakeElement({ contentWindow, contentDocument = {}, id = "", name = "" } = {}) {
	const element = {
		id,
		contentDocument,
		getAttribute(key) {
			return key === "name" ? name : null;
		},
	};
	Object.defineProperty(element, "contentWindow", {
		get() {
			if (contentWindow instanceof Error) throw contentWindow;
			return contentWindow;
		},
	});
	return element;
}

function fakeWindow(origin = ORIGIN) {
	return { location: { origin } };
}

function fakeOwner(elements = [], origin = ORIGIN) {
	return {
		location: { origin },
		document: {
			querySelectorAll(selector) {
				assert.equal(selector, "iframe");
				return elements;
			},
		},
	};
}

function context(overrides = {}) {
	return {
		page: "thread",
		source: { kind: "thread", threadId: "qa-issue-a", itemId: "item-a1", observedSeq: 7 },
		target: null,
		view: { width: 720, height: 900 },
		excerpt: "the displayed item",
		excerptEnabled: true,
		...overrides,
	};
}

function adapter(overrides = {}) {
	return {
		page: "inbox",
		getContext: () => context(),
		getTargets: () => [],
		deferRender() {},
		resumeRender() {},
		...overrides,
	};
}

function rejection(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return null;
}

test("parent adapter freezes one immutable capture owned by the registry", () => {
	const owner = fakeOwner();
	const registry = createAdapterRegistry({ ownerWindow: owner });
	const live = context();
	const handle = registry.register(adapter({ getContext: () => live }));
	assert.deepEqual(registry.current(), { id: handle.id, page: "inbox", origin: ORIGIN, frame: false, framePath: [] });
	const frozen = registry.freeze();
	assert.equal(frozen.excerpt, "the displayed item");
	assert.ok(Object.isFrozen(frozen));
	assert.ok(Object.isFrozen(frozen.source));
	live.excerpt = "later projection";
	live.source.observedSeq = 99;
	assert.throws(() => {
		frozen.source.observedSeq = 123;
	}, TypeError);
	assert.equal(registry.freeze().excerpt, "the displayed item");
	assert.equal(registry.freeze().source.observedSeq, 7);
	assert.equal(registry.freeze(), frozen);
	assert.equal(registry.unregister(handle), true);
	assert.equal(registry.current(), null);
	assert.equal(registry.freeze(), frozen, "unregistering cannot erase the parent-owned capture");
	assert.equal(registry.unregister(handle), false);
});

test("same-origin frame registration is verified and a stale frame cannot overwrite capture or draft", () => {
	const firstWindow = fakeWindow();
	const first = fakeElement({ contentWindow: firstWindow, id: "thread-frame-a" });
	const owner = fakeOwner([first]);
	const registry = createAdapterRegistry({ ownerWindow: owner });
	const handleA = registry.register(
		adapter({ page: "thread", origin: ORIGIN, frameWindow: firstWindow, getContext: () => context() }),
	);
	assert.equal(handleA.frame, true);
	assert.deepEqual(handleA.framePath, ["thread-frame-a"]);
	const captured = registry.freeze();
	const serialized = JSON.stringify(captured);
	const parentDraft = { text: "parent text", revision: 2 };

	const secondWindow = fakeWindow();
	const second = fakeElement({ contentWindow: secondWindow, id: "thread-frame-b" });
	owner.document.querySelectorAll = () => [second];
	const handleB = registry.register(
		adapter({ page: "thread", origin: ORIGIN, frameWindow: secondWindow, getContext: () => context({ excerpt: "thread b" }) }),
	);
	assert.equal(handleB.framePath[0], "thread-frame-b");
	const stale = rejection(() =>
		registry.register(adapter({ page: "thread", origin: ORIGIN, frameWindow: firstWindow, getContext: () => context({ excerpt: "stale" }) })),
	);
	assert.ok(stale instanceof AdapterRegistrationError);
	assert.equal(stale.code, "stale_frame");
	assert.equal(JSON.stringify(registry.freeze()), serialized);
	assert.deepEqual(parentDraft, { text: "parent text", revision: 2 });
	const fresh = registry.freeze({ fresh: true });
	assert.equal(fresh.excerpt, "thread b");
	assert.equal(JSON.stringify(captured), serialized, "a new generation leaves the previous capture intact");
	assert.equal(registry.current().framePath[0], "thread-frame-b");
});

test("a removed frame's getter is not consulted by a fresh freeze", () => {
	const frameWindow = fakeWindow();
	const element = fakeElement({ contentWindow: frameWindow, id: "frame-removed" });
	const owner = fakeOwner([element]);
	const registry = createAdapterRegistry({ ownerWindow: owner });
	let reads = 0;
	registry.register(
		adapter({
			page: "thread",
			origin: ORIGIN,
			frameWindow,
			getContext: () => {
				reads++;
				return context();
			},
		}),
	);
	assert.equal(registry.freeze().excerpt, "the displayed item");
	owner.document.querySelectorAll = () => [];
	assert.equal(registry.freeze({ fresh: true }), null);
	assert.equal(reads, 1);
});

test("denied, cross-origin and unloaded frames yield explicit registration failures", () => {
	const denied = fakeElement({ contentWindow: new Error("SecurityError"), contentDocument: null });
	const deniedRegistry = createAdapterRegistry({ ownerWindow: fakeOwner([denied]) });
	const deniedError = rejection(() =>
		deniedRegistry.register(adapter({ page: "thread", origin: ORIGIN, frameWindow: {} })),
	);
	assert.equal(deniedError.code, "origin_denied");

	const wrongWindow = fakeWindow("https://evil.example");
	const crossElement = fakeElement({ contentWindow: wrongWindow });
	const crossRegistry = createAdapterRegistry({ ownerWindow: fakeOwner([crossElement]) });
	const crossError = rejection(() =>
		crossRegistry.register(adapter({ page: "thread", origin: ORIGIN, frameWindow: wrongWindow })),
	);
	assert.equal(crossError.code, "cross_origin");

	const unloadedWindow = fakeWindow();
	const unloadedElement = fakeElement({ contentWindow: unloadedWindow, contentDocument: null });
	const unloadedRegistry = createAdapterRegistry({ ownerWindow: fakeOwner([unloadedElement]) });
	const unloadedError = rejection(() =>
		unloadedRegistry.register(adapter({ page: "thread", origin: ORIGIN, frameWindow: unloadedWindow })),
	);
	assert.equal(unloadedError.code, "unloaded_frame");

	assert.equal(deniedRegistry.freeze(), null);
	assert.deepEqual(deniedRegistry.standalone(), { href: "/issues/new", contextStatus: "unavailable" });
});

test("adapter registry reads no message channel", () => {
	const owner = fakeOwner();
	owner.addEventListener = () => {
		throw new Error("the registry must not subscribe to messages");
	};
	owner.postMessage = () => {
		throw new Error("the registry must not post messages");
	};
	const registry = createAdapterRegistry({ ownerWindow: owner });
	registry.register(adapter());
	assert.equal(registry.freeze().excerpt, "the displayed item");
	assert.equal(registry.current().page, "inbox");
});

test("listTargets returns only bounded, finite descriptors with frame ownership", () => {
	const frameWindow = fakeWindow();
	const element = fakeElement({ contentWindow: frameWindow, id: "thread-frame-q9" });
	const registry = createAdapterRegistry({ ownerWindow: fakeOwner([element]) });
	registry.register(
		adapter({
			page: "thread",
			origin: ORIGIN,
			frameWindow,
			getTargets: () => [
				{ kind: "record", key: "k".repeat(200), label: "가".repeat(100), rect: { x: 10.5, y: -2, w: 300.25, h: 0 }, framePath: [] },
				{ kind: "bad", key: "x", label: "x", rect: { x: 0, y: 0, w: 1, h: 1 }, framePath: [] },
				{ kind: "control", key: "send", label: "보내기", rect: { x: Number.NaN, y: 0, w: 1, h: 1 }, framePath: [] },
				{ kind: "page", key: "page", label: "화면", rect: { x: 0, y: 0, w: 1, h: 1 }, framePath: ["other-frame"] },
			],
		}),
	);
	const targets = registry.listTargets();
	assert.equal(targets.length, 2);
	assert.equal(Buffer.byteLength(targets[0].key, "utf8"), 160);
	assert.ok(Buffer.byteLength(targets[0].label, "utf8") <= 160);
	assert.ok(!targets[0].label.includes("\uFFFD"));
	assert.deepEqual(targets[0].rect, { x: 10.5, y: -2, w: 300.25, h: 0 });
	assert.deepEqual(targets[0].framePath, ["thread-frame-q9"]);
	assert.deepEqual(targets[1].framePath, ["thread-frame-q9"], "an adapter-supplied framePath cannot override verified ownership");
	assert.ok(Object.isFrozen(targets));
	assert.ok(Object.isFrozen(targets[0].rect));
});

test("registration, capture and targets accept genuine objects from another realm", () => {
	const realm = vm.createContext({});
	const owner = fakeOwner();
	const registry = createAdapterRegistry({ ownerWindow: owner });
	const childOptions = vm.runInContext(
		`({
			page: "inbox",
			getContext() {
				return { page: "inbox", source: { kind: "thread", threadId: "child-thread", itemId: null, observedSeq: 4 }, excerpt: "child excerpt" };
			},
			getTargets() {
				return [{ kind: "record", key: "child-key", label: "child label", rect: { x: 0.5, y: -2, w: 12.25, h: 8 }, framePath: ["forged-frame"] }];
			},
			deferRender() {},
			resumeRender() {}
		})`,
		realm,
	);
	assert.notEqual(Object.getPrototypeOf(childOptions), Object.prototype);
	const childContext = childOptions.getContext();
	assert.notEqual(Object.getPrototypeOf(childContext), Object.prototype);
	const handle = registry.register(childOptions);
	assert.equal(handle.frame, false);
	const frozen = registry.freeze();
	assert.equal(frozen.excerpt, "child excerpt");
	assert.equal(frozen.source.threadId, "child-thread");
	assert.equal(Object.getPrototypeOf(frozen), Object.prototype, "accepted capture is copied into the registry realm");
	assert.equal(Object.getPrototypeOf(frozen.source), Object.prototype);
	const targets = registry.listTargets();
	assert.equal(targets.length, 1);
	assert.deepEqual(targets[0].rect, { x: 0.5, y: -2, w: 12.25, h: 8 });
	assert.equal(Object.getPrototypeOf(targets[0].rect), Object.prototype);
	assert.deepEqual(targets[0].framePath, [], "a parent-realm registry ignores a child-supplied framePath");
});

test("a same-origin frame window from another realm registers with verified ownership", () => {
	const realm = vm.createContext({});
	const childWindow = vm.runInContext(`({ location: { origin: "${ORIGIN}" } })`, realm);
	const element = fakeElement({ contentWindow: childWindow, id: "child-frame-realm" });
	const registry = createAdapterRegistry({ ownerWindow: fakeOwner([element]) });
	const childOptions = vm.runInContext(
		`({ page: "thread", origin: "${ORIGIN}", getContext() { return { page: "thread" }; }, getTargets() { return [{ kind: "record", key: "k", label: "l", rect: { x: 1, y: 2, w: 3, h: 4 }, framePath: ["forged-frame"] }]; } })`,
		realm,
	);
	childOptions.frameWindow = childWindow;
	const handle = registry.register(childOptions);
	assert.equal(handle.frame, true);
	assert.deepEqual(handle.framePath, ["child-frame-realm"]);
	assert.deepEqual(registry.freeze(), { page: "thread" });
	assert.deepEqual(registry.listTargets()[0].framePath, ["child-frame-realm"]);
});

test("deferAll and resumeAll run once per open cycle and cover every registration", () => {
	const frameWindow = fakeWindow();
	const element = fakeElement({ contentWindow: frameWindow, id: "frame-defer" });
	const registry = createAdapterRegistry({ ownerWindow: fakeOwner([element]) });
	const calls = { defer: 0, resume: 0 };
	registry.register(adapter({ deferRender: () => calls.defer++, resumeRender: () => calls.resume++ }));
	registry.register(
		adapter({ page: "thread", origin: ORIGIN, frameWindow, deferRender: () => calls.defer++, resumeRender: () => calls.resume++ }),
	);
	assert.equal(registry.deferAll(), true);
	assert.equal(registry.deferAll(), false);
	assert.deepEqual(calls, { defer: 2, resume: 0 });
	assert.equal(registry.resumeAll(), true);
	assert.equal(registry.resumeAll(), false);
	assert.deepEqual(calls, { defer: 2, resume: 2 });
});

test("registration and capture failures are typed, not silent", () => {
	const registry = createAdapterRegistry({ ownerWindow: fakeOwner() });
	assert.equal(registry.freeze(), null);
	assert.equal(registry.listTargets().length, 0);
	assert.equal(rejection(() => registry.register({ page: "unknown" })).code, "bad_input");
	assert.equal(rejection(() => registry.register(adapter({ getContext: "nope" }))).code, "bad_input");
	assert.throws(() => createAdapterRegistry({}), TypeError);
	const asyncRegistry = createAdapterRegistry({ ownerWindow: fakeOwner() });
	asyncRegistry.register(adapter({ getContext: async () => context() }));
	assert.throws(() => asyncRegistry.freeze(), TypeError);
});
