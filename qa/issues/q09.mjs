/* Q09: same-origin pane adapter ownership at the 720px split view.
 *
 * Loads the seeded Inbox so the thread iframe exists, installs the parent registry, registers the
 * frame through window.parent.__inboxIssueAdapters, freezes its seed, mutates the seed and replaces
 * the frame with another row. The parent-owned capture must stay byte-identical, and the removed
 * frame's late registration must be refused. The failure probe registers fake denied, cross-origin
 * and unloaded frames: each yields unavailable context and the standalone /issues/new fallback,
 * with no postMessage command surface.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const viewport = { width: 720, height: 900 };

const DEADLINE_MS = 10_000;

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function waitForFrameReady(threadId) {
	return `new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('q09 thread iframe was not ready')), 9000);
		let armed = false;
		const done = () => { if (!armed) return; armed = false; clearTimeout(timer); resolve(true); };
		const check = (frame) => {
			if (!frame || !frame.contentWindow || !frame.contentDocument) return;
			if (!frame.contentWindow.location.href.includes(${JSON.stringify(threadId)})) return;
			if (frame.contentDocument.readyState === 'complete') done();
		};
		const arm = (frame) => {
			if (armed) return;
			armed = true;
			frame.addEventListener('load', () => check(frame));
			check(frame);
		};
		const current = document.querySelector('iframe.thread');
		if (current) arm(current);
		const observer = new MutationObserver(() => {
			const frame = document.querySelector('iframe.thread');
			if (!frame) return;
			observer.disconnect();
			arm(frame);
		});
		observer.observe(document.body, { childList: true, subtree: true });
	})`;
}

function parentSetupExpression(frameId) {
	return `(async () => {
		const mod = await import('/web/issue-adapters.js');
		const registry = mod.createAdapterRegistry({ ownerWindow: window });
		const frame = document.querySelector('iframe.thread');
		frame.id = ${JSON.stringify(frameId)};
		window.__q09 = { mod, registry, child: frame.contentWindow, deferred: 0, resumed: 0 };
		return { frameId: frame.id, origin: location.origin };
	})()`;
}

// Evaluated inside the iframe's own execution context, so every object literal below belongs to
// the child realm. The child itself calls the parent registry through window.parent.
function childRegisterExpression(seed) {
	return `(() => {
		window.__q09Seed = ${JSON.stringify(seed)};
		const options = {
			page: 'thread',
			origin: location.origin,
			frameWindow: window,
			getContext() {
				const seed = window.__q09Seed;
				return {
					page: 'thread',
					source: { kind: 'thread', threadId: seed.threadId, itemId: seed.itemId, observedSeq: seed.observedSeq },
					target: null,
					view: { width: innerWidth, height: innerHeight, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: 'light', locale: 'ko-KR', embedded: false, viewerOpen: false },
					excerpt: seed.text,
					excerptEnabled: true,
					visibleIds: [seed.itemId],
					diagnostics: [],
					clientBuild: null,
					contextStatus: 'captured',
					visual: { kind: 'none', reason: 'not_requested' }
				};
			},
			getTargets() {
				const seed = window.__q09Seed;
				return [
					{ kind: 'record', key: 'item:' + seed.itemId, label: seed.text, rect: { x: 12.5, y: 24, w: 300, h: 80.25 }, framePath: [] },
					{ kind: 'page', key: 'thread', label: '대화', rect: { x: 0, y: 0, w: innerWidth, h: innerHeight }, framePath: [] },
					{ kind: 'record', key: 'forged', label: 'forged', rect: { x: 1, y: 2, w: 3, h: 4 }, framePath: ['nonexistent-frame'] }
				];
			},
			deferRender() { window.parent.__q09.deferred += 1; },
			resumeRender() { window.parent.__q09.resumed += 1; }
		};
		const handle = window.parent.__inboxIssueAdapters.register(options);
		return {
			handle,
			childPrototypeMatches: Object.getPrototypeOf(options) === Object.prototype,
			parentPrototypeMatches: Object.getPrototypeOf(options) === window.parent.Object.prototype,
			contextRealm: Object.getPrototypeOf(options.getContext()) === Object.prototype,
			targetRealm: Object.getPrototypeOf(options.getTargets()[0]) === Object.prototype
		};
	})()`;
}

async function failureChecks(page, check, withDeadline) {
	const result = await withDeadline(
		page.evaluate(`(async () => {
			const mod = await import('/web/issue-adapters.js');
			const contextMod = await import('/web/issue-context.js');
			const origin = location.origin;
			const empty = { getContext() { return null; }, getTargets() { return []; } };
			const codeOf = (fn) => {
				try { fn(); return 'accepted'; } catch (error) { return error && error.code ? error.code : String(error); }
			};
			const deniedOwner = {
				location: { origin },
				document: { querySelectorAll() { return [{ get contentWindow() { throw new DOMException('denied', 'SecurityError'); }, contentDocument: null }]; } }
			};
			const denied = mod.createAdapterRegistry({ ownerWindow: deniedOwner });
			const deniedCode = codeOf(() => denied.register({ ...empty, page: 'thread', origin, frameWindow: {} }));

			const crossWindow = { location: { origin: 'https://cross.example' } };
			const crossOwner = {
				location: { origin },
				document: { querySelectorAll() { return [{ contentWindow: crossWindow, contentDocument: {} }]; } }
			};
			const cross = mod.createAdapterRegistry({ ownerWindow: crossOwner });
			const crossCode = codeOf(() => cross.register({ ...empty, page: 'thread', origin, frameWindow: crossWindow }));

			const unloadedWindow = { location: { origin } };
			const unloadedOwner = {
				location: { origin },
				document: { querySelectorAll() { return [{ contentWindow: unloadedWindow, contentDocument: null }]; } }
			};
			const unloaded = mod.createAdapterRegistry({ ownerWindow: unloadedOwner });
			const unloadedCode = codeOf(() => unloaded.register({ ...empty, page: 'thread', origin, frameWindow: unloadedWindow }));

			const unavailable = contextMod.describeUnavailable('no_adapter', {
				uuid: () => '00000000-0000-4000-8000-000000000009',
				now: () => 1761177600000
			});
			const standalone = denied.standalone();

			const registry = window.__q09.registry;
			const before = JSON.stringify(registry.freeze());
			const currentBefore = JSON.stringify(registry.current());
			const marker = new Promise((resolve) => {
				const onMessage = (event) => {
					if (!event.data || event.data.type !== 'q09-marker') return;
					window.removeEventListener('message', onMessage);
					resolve(event.data.type);
				};
				window.addEventListener('message', onMessage);
			});
			window.postMessage({ type: 'inbox-issue-register', page: 'thread', captured: 'arbitrary' }, origin);
			window.postMessage({ type: 'q09-marker' }, origin);
			const markerType = await marker;
			const after = JSON.stringify(registry.freeze());
			return {
				deniedCode, crossCode, unloadedCode, standalone,
				unavailable: { status: unavailable.contextStatus, source: unavailable.source, excerpt: unavailable.excerpt },
				message: { markerType, captureUnchanged: before === after, currentUnchanged: JSON.stringify(registry.current()) === currentBefore }
			};
		})()`),
		DEADLINE_MS,
		"q09_failure_probe",
	);
	check("Q09 denied frame registration is refused", result.deniedCode === "origin_denied", result.deniedCode);
	check("Q09 cross-origin frame registration is refused", result.crossCode === "cross_origin", result.crossCode);
	check("Q09 unloaded frame registration is refused", result.unloadedCode === "unloaded_frame", result.unloadedCode);
	check(
		"Q09 refused frames yield unavailable context with no invented source",
		result.unavailable.status === "unavailable" && result.unavailable.source === null && result.unavailable.excerpt === null,
		JSON.stringify(result.unavailable),
	);
	check(
		"Q09 standalone reporting fallback stays available",
		result.standalone && result.standalone.href === "/issues/new" && result.standalone.contextStatus === "unavailable",
		JSON.stringify(result.standalone),
	);
	check(
		"Q09 arbitrary postMessage neither registers nor replaces the capture",
		result.message.markerType === "q09-marker" && result.message.captureUnchanged === true && result.message.currentUnchanged === true,
		JSON.stringify(result.message),
	);
	return result;
}

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q09_new_page");
	const record = { viewport: { width, height } };
	try {
		const threadA = ctx.fixtures.threads.a;
		const threadB = ctx.fixtures.threads.b;
		await withDeadline(page.goto(`${ctx.base}/?s=${encodeURIComponent(threadA)}`, { waitUntil: "load" }), DEADLINE_MS, "q09_goto_split");
		await withDeadline(page.evaluate(waitForFrameReady(threadA)), DEADLINE_MS, "q09_iframe_ready");

		const seedA = { threadId: threadA, itemId: "item-a1", observedSeq: 7, text: "표시된 항목 A" };
		const parentSetup = await withDeadline(page.evaluate(parentSetupExpression("thread-frame-a")), DEADLINE_MS, "q09_parent_setup");
		// The script element is parsed and executed by the child document in its own realm; the
		// parent only waits for the child's completion event. CSP allows inline scripts but not eval.
		const childCode = `window.__q09ChildResult = ${childRegisterExpression(seedA)}; window.dispatchEvent(new Event('q09-child-ready'));`;
		const setup = await withDeadline(
			page.evaluate(`(async () => {
				const child = document.querySelector('iframe.thread').contentWindow;
				const done = new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('q09 child script did not report')), 9000);
					child.addEventListener('q09-child-ready', () => { clearTimeout(timer); resolve(); }, { once: true });
				});
				const script = child.document.createElement('script');
				script.textContent = ${JSON.stringify(childCode)};
				child.document.head.append(script);
				script.remove();
				await done;
				return child.__q09ChildResult;
			})()`),
			DEADLINE_MS,
			"q09_register_frame_a_in_child",
		);
		record.registration = { ...setup, parentSetup };
		check("Q09 iframe adapter registers through the parent registry", setup.handle && setup.handle.frame === true, JSON.stringify(setup.handle));
		check("Q09 registered frame identity is recorded", setup.handle && setup.handle.framePath[0] === "thread-frame-a", JSON.stringify(setup.handle && setup.handle.framePath));
		check(
			"Q09 adapter, context and targets are genuine child-realm objects",
			setup.childPrototypeMatches === true && setup.parentPrototypeMatches === false && setup.contextRealm === true && setup.targetRealm === true,
			JSON.stringify({ child: setup.childPrototypeMatches, parent: setup.parentPrototypeMatches, context: setup.contextRealm, target: setup.targetRealm }),
		);

		const frozen = await withDeadline(
			page.evaluate(`(() => {
				const registry = window.__q09.registry;
				const child = window.__q09.child;
				const first = registry.freeze();
				const capture = JSON.parse(JSON.stringify(first));
				const targets = registry.listTargets();
				child.__q09Seed.observedSeq = 99;
				child.__q09Seed.text = 'later projection';
				const second = registry.freeze();
				const deferredFirst = registry.deferAll();
				const deferredSecond = registry.deferAll();
				const resumedFirst = registry.resumeAll();
				const resumedSecond = registry.resumeAll();
				return {
					capture,
					freezeStable: JSON.stringify(second) === JSON.stringify(first),
					sameReference: first === second,
					current: registry.current(),
					targets,
					deferred: window.__q09.deferred,
					resumed: window.__q09.resumed,
					deferredFirst,
					deferredSecond,
					resumedFirst,
					resumedSecond
				};
			})()`),
			DEADLINE_MS,
			"q09_freeze_seed",
		);
		record.frozen = frozen;
		check("Q09 first freeze captures the displayed source", frozen.capture.source.observedSeq === 7 && frozen.capture.excerpt === "표시된 항목 A", JSON.stringify(frozen.capture.source));
		check("Q09 later seed mutation cannot replace the frozen capture", frozen.freezeStable === true && frozen.sameReference === true, JSON.stringify({ stable: frozen.freezeStable, same: frozen.sameReference }));
		check("Q09 registry current() reports the child-realm frame adapter", frozen.current && frozen.current.page === "thread" && frozen.current.frame === true, JSON.stringify(frozen.current));
		check("Q09 adapter targets are bounded descriptors", Array.isArray(frozen.targets) && frozen.targets.length === 3 && frozen.targets[0].framePath[0] === "thread-frame-a", JSON.stringify(frozen.targets));
		check(
			"Q09 target-supplied framePath is rejected in favor of verified ownership",
			Array.isArray(frozen.targets) && frozen.targets[2] && frozen.targets[2].framePath[0] === "thread-frame-a",
			JSON.stringify(frozen.targets && frozen.targets[2] && frozen.targets[2].framePath),
		);
		check("Q09 deferAll/resumeAll run one cycle per open", frozen.deferredFirst && !frozen.deferredSecond && frozen.resumedFirst && !frozen.resumedSecond && frozen.deferred === 1 && frozen.resumed === 1, JSON.stringify({ deferred: frozen.deferred, resumed: frozen.resumed }));

		const replacement = await withDeadline(
			page.evaluate(`(async () => {
				const registry = window.__q09.registry;
				const oldChild = window.__q09.child;
				const before = JSON.stringify(registry.freeze());
				const oldFrame = document.querySelector('iframe.thread');
				oldFrame.id = 'thread-frame-old';
				window.__q09.oldParent = oldChild.parent;
				const ready = new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('replacement iframe was not ready')), 9000);
					const check = () => {
						const frame = document.querySelector('iframe.thread');
						if (!frame || frame.contentWindow === oldChild || !frame.contentWindow || !frame.contentDocument) return false;
						if (!frame.contentWindow.location.href.includes(${JSON.stringify(threadB)})) return false;
						if (frame.contentDocument.readyState !== 'complete') return false;
						clearTimeout(timer);
						resolve(frame);
						return true;
					};
					const observer = new MutationObserver(() => {
						const frame = document.querySelector('iframe.thread');
						if (!frame) return;
						frame.addEventListener('load', check);
						if (check()) observer.disconnect();
					});
					observer.observe(document.body, { childList: true, subtree: true });
					if (check()) observer.disconnect();
				});
				document.querySelector('.row[data-session=${JSON.stringify(threadB)}]').click();
				const frame = await ready;
				frame.id = 'thread-frame-b';
				const child = frame.contentWindow;
				child.__q09Seed = { threadId: ${JSON.stringify(threadB)}, itemId: 'item-b1', observedSeq: 3, text: '표시된 항목 B' };
				const staleCode = (() => {
					try {
						window.__q09.oldParent.__inboxIssueAdapters.register({
							page: 'thread', origin: location.origin, frameWindow: oldChild,
							getContext() { return { page: 'thread' }; },
							getTargets() { return []; }
						});
						return 'accepted';
					} catch (error) {
						return error && error.code ? error.code : String(error);
					}
				})();
				const afterStale = JSON.stringify(registry.freeze());
				const handle = child.parent.__inboxIssueAdapters.register({
					page: 'thread', origin: location.origin, frameWindow: child,
					getContext() { return { page: 'thread', source: { kind: 'thread', threadId: child.__q09Seed.threadId, itemId: child.__q09Seed.itemId, observedSeq: child.__q09Seed.observedSeq }, excerpt: child.__q09Seed.text, excerptEnabled: true }; },
					getTargets() { return [{ kind: 'record', key: 'item:b', label: child.__q09Seed.text, rect: { x: 1, y: 2, w: 3, h: 4 }, framePath: [] }]; }
				});
				const storedAfterB = JSON.stringify(registry.freeze());
				const fresh = registry.freeze({ fresh: true });
				return {
					staleCode,
					captureBefore: before,
					captureAfterStale: afterStale,
					storedAfterB,
					fresh,
					handle,
					current: registry.current(),
					replaced: frame.contentWindow !== oldChild
				};
			})()`),
			DEADLINE_MS,
			"q09_replace_frame",
		);
		record.replacement = replacement;
		check("Q09 selecting another row replaced the iframe", replacement.replaced === true, String(replacement.replaced));
		check("Q09 stale frame registration is refused", replacement.staleCode === "stale_frame", replacement.staleCode);
		check("Q09 parent-owned capture survives frame replacement", replacement.captureAfterStale === replacement.captureBefore && replacement.storedAfterB === replacement.captureBefore, JSON.stringify({ stale: replacement.captureAfterStale === replacement.captureBefore, afterB: replacement.storedAfterB === replacement.captureBefore }));
		check("Q09 explicit fresh freeze reads the new frame", replacement.fresh && replacement.fresh.excerpt === "표시된 항목 B" && replacement.fresh.source.observedSeq === 3, JSON.stringify(replacement.fresh && replacement.fresh.source));
		check("Q09 new frame adapter is current after replacement", replacement.current && replacement.current.framePath[0] === "thread-frame-b", JSON.stringify(replacement.current));

		const failures = await failureChecks(page, check, withDeadline);
		record.failure = failures;

		await withDeadline(
			page.evaluate(`(() => {
				const chip = document.createElement('div');
				chip.id = 'q09-pane-marker';
				chip.textContent = 'Q09 parent-owned capture retained (source A)';
				chip.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:10px 14px;border:2px solid #15171b;border-radius:8px;background:#fff;color:#15171b;font:14px system-ui,sans-serif';
				document.body.appendChild(chip);
			})()`),
			DEADLINE_MS,
			"q09_marker",
		);
		const shot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q09_screenshot");
		const shotPath = evidence("Q09-pane.png", Buffer.from(shot));
		record.screenshot = shotPath;
		check("Q09 split-pane screenshot saved", fs.existsSync(shotPath) && fs.statSync(shotPath).size > 0, shotPath);
	} finally {
		evidence("Q09-adapters.json", JSON.stringify(record, null, "\t"));
		await withDeadline(page.close(), DEADLINE_MS, "q09_page_close").catch(() => page.dispose?.());
	}
}

export async function runFailureProbe({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q09_failure_new_page");
	const record = {};
	try {
		await withDeadline(page.goto(ctx.base + "/", { waitUntil: "load" }), DEADLINE_MS, "q09_failure_goto");
		await withDeadline(
			page.evaluate(`(async () => {
				const mod = await import('/web/issue-adapters.js');
				const registry = mod.createAdapterRegistry({ ownerWindow: window });
				window.__q09 = { registry };
				registry.register({ page: 'inbox', getContext() { return { page: 'inbox' }; }, getTargets() { return []; } });
				registry.freeze();
			})()`),
			DEADLINE_MS,
			"q09_failure_registry",
		);
		record.result = await failureChecks(page, check, withDeadline);
	} finally {
		evidence("Q09-adapters-failure.json", JSON.stringify(record, null, "\t"));
		await withDeadline(page.close(), DEADLINE_MS, "q09_failure_page_close").catch(() => page.dispose?.());
	}
}
