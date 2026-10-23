/* Q05: durable drafts and uncertain sends in a real browser IndexedDB.
 *
 * Same origin as /web/issue-drafts.js, phone viewport. The scenario saves a draft and reloads,
 * freezes one outbox envelope, races two tabs at one revision, aborts a transaction, and probes an
 * unavailable indexedDB stub. Every browser action is recorded in order.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DRAFT_ID = "draft-q05";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const STORE_ID = "store-a";
const DRAFT_TEXT = "초안 텍스트";
const CAPTURE = {
	captureId: "55555555-5555-4555-8555-555555555555",
	observedAt: "2026-10-23T00:00:00.000Z",
	page: "inbox",
	source: null,
	target: null,
	clientBuild: null,
	view: {
		width: 390,
		height: 844,
		dpr: 1,
		scale: 1,
		scrollX: 0,
		scrollY: 0,
		theme: "light",
		locale: "ko-KR",
		embedded: false,
		viewerOpen: false,
	},
	excerpt: null,
	excerptTruncated: false,
	visibleIds: [],
	diagnostics: [],
	contextStatus: "captured",
	visual: { kind: "none", reason: "not_requested" },
};

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function sameJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const page = await newQaPage(browser, { width, height, scheme });
	const actions = [];
	const storage = { origin: null, draftId: DRAFT_ID, requestId: REQUEST_ID, storeId: STORE_ID };
	const act = (step, detail, signal) => {
		actions.push({ step, detail, signal });
	};
	let second = null;
	try {
		await page.goto(ctx.base + "/", { waitUntil: "load" });
		act("navigate", ctx.base + "/", "page.goto(waitUntil=load) resolved");

		const setup = await page.evaluate(`(async () => {
			const mod = await import('/web/issue-drafts.js');
			const db = await mod.openDraftDb({ indexedDB: window.indexedDB, origin: location.origin, storeId: '${STORE_ID}' });
			const capture = Object.freeze(${JSON.stringify(CAPTURE)});
			const draft = { draftId: '${DRAFT_ID}', tabId: 'tab-a', revision: 0, text: '${DRAFT_TEXT}', cursor: 5, evidence: capture };
			window.__q05 = { mod, db, draft };
			const saved = await mod.saveDraft(db, draft);
			return { saved, origin: location.origin };
		})()`);
		act("save-draft", "saveDraft(draftId=draft-q05, revision=0)", "saveDraft resolved after transaction complete");
		storage.origin = setup.origin;
		storage.saved = setup.saved;
		check("Q05 draft save resolves ok after commit", setup.saved && setup.saved.ok === true, JSON.stringify(setup.saved));
		check("Q05 save advances the revision to 1", setup.saved && setup.saved.revision === 1, JSON.stringify(setup.saved && setup.saved.revision));

		await page.reload();
		act("reload", "page.reload()", "reload resolved");
		const readBack = await page.evaluate(`(async () => {
			const mod = await import('/web/issue-drafts.js');
			const db = await mod.openDraftDb({ indexedDB: window.indexedDB, origin: location.origin, storeId: '${STORE_ID}' });
			window.__q05 = { mod, db };
			const record = await mod.readDraft(db, '${DRAFT_ID}');
			return { record };
		})()`);
		act("read-back", "readDraft after reload", "readDraft resolved");
		const record = readBack.record;
		storage.readBack = record;
		check("Q05 reload returns the same draftId", Boolean(record) && record.draftId === DRAFT_ID, record ? record.draftId : "missing");
		check("Q05 reload returns identical text", Boolean(record) && record.text === DRAFT_TEXT, record ? record.text : "missing");
		check("Q05 reload returns identical cursor", Boolean(record) && record.cursor === 5, String(record ? record.cursor : "missing"));
		check("Q05 reload returns identical capture", Boolean(record) && sameJson(record.evidence, CAPTURE), record ? JSON.stringify(record.evidence) : "missing");

		const marker = await page.evaluate(`(() => {
			const el = document.createElement('div');
			el.id = 'q05-draft-marker';
			el.textContent = '${DRAFT_TEXT}';
			el.style.cssText = 'position:fixed;top:16px;left:16px;padding:12px;background:#fff;color:#111;border:2px solid #111;font:16px sans-serif;z-index:2147483647';
			document.body.appendChild(el);
			return el.textContent;
		})()`);
		act("marker", "inject #q05-draft-marker with the reloaded draft text", "page.evaluate resolved");
		check("Q05 visible marker shows the reloaded draft text", marker === DRAFT_TEXT, marker);

		const freeze = await page.evaluate(`(async () => {
			const { mod, db } = window.__q05;
			const envelope = { v: 1, storeId: '${STORE_ID}', requestId: '${REQUEST_ID}', description: '${DRAFT_TEXT}' };
			const frozen = await mod.freezeToOutbox(db, '${REQUEST_ID}', envelope);
			const pending = await mod.listPending(db, { origin: location.origin, storeId: '${STORE_ID}' });
			return { frozen, pending, envelope };
		})()`);
		act("freeze-outbox", "freezeToOutbox(requestId) then listPending", "both resolved after transaction complete");
		storage.outbox = freeze;
		check("Q05 outbox freeze resolves ok", freeze.frozen && freeze.frozen.ok === true, JSON.stringify(freeze.frozen));
		check("Q05 listPending returns one entry", Array.isArray(freeze.pending) && freeze.pending.length === 1, String(freeze.pending && freeze.pending.length));
		check(
			"Q05 outbox envelope is byte-identical",
			Array.isArray(freeze.pending) && freeze.pending.length === 1 && sameJson(freeze.pending[0].envelope, freeze.envelope),
			Array.isArray(freeze.pending) && freeze.pending[0] ? JSON.stringify(freeze.pending[0].envelope) : "missing",
		);

		second = await newQaPage(browser, { width, height, scheme });
		await second.goto(ctx.base + "/", { waitUntil: "load" });
		const secondSetup = await second.evaluate(`(async () => {
			const mod = await import('/web/issue-drafts.js');
			const db = await mod.openDraftDb({ indexedDB: window.indexedDB, origin: location.origin, storeId: '${STORE_ID}' });
			window.__q05 = { mod, db };
			const record = await mod.readDraft(db, '${DRAFT_ID}');
			return { revision: record ? record.revision : null, text: record ? record.text : null };
		})()`);
		act("second-tab", "second page opened on the same origin", `read revision=${secondSetup.revision}`);
		check("Q05 second tab reads the same revision", secondSetup.revision === (record ? record.revision : -1), String(secondSetup.revision));

		const revision = secondSetup.revision;
		const saveA = `(async () => {
			const { mod, db } = window.__q05;
			const result = await mod.saveDraft(db, { draftId: '${DRAFT_ID}', tabId: 'tab-a', revision: ${revision}, text: '탭 A 저장', cursor: 3 });
			return { ok: result.ok === true, conflict: result.conflict === true, revision: result.revision ?? null, text: result.record ? result.record.text : (result.theirs ? result.theirs.text : null) };
		})()`;
		const saveB = `(async () => {
			const { mod, db } = window.__q05;
			const result = await mod.saveDraft(db, { draftId: '${DRAFT_ID}', tabId: 'tab-b', revision: ${revision}, text: '탭 B 저장', cursor: 4 });
			return { ok: result.ok === true, conflict: result.conflict === true, revision: result.revision ?? null, text: result.record ? result.record.text : (result.theirs ? result.theirs.text : null) };
		})()`;
		const [resultA, resultB] = await Promise.all([page.evaluate(saveA), second.evaluate(saveB)]);
		act("two-tab-race", `both tabs write revision ${revision}`, `A ok=${resultA.ok} conflict=${resultA.conflict}; B ok=${resultB.ok} conflict=${resultB.conflict}`);
		const successes = [resultA, resultB].filter((entry) => entry.ok === true).length;
		const conflicts = [resultA, resultB].filter((entry) => entry.conflict === true).length;
		storage.race = { revision, resultA, resultB };
		check("Q05 exactly one of two stale writes succeeds", successes === 1, JSON.stringify({ resultA, resultB }));
		check("Q05 exactly one of two stale writes conflicts", conflicts === 1, JSON.stringify({ resultA, resultB }));

		const latest = await page.evaluate(`(async () => {
			const { mod, db } = window.__q05;
			const record = await mod.readDraft(db, '${DRAFT_ID}');
			return { revision: record ? record.revision : null, tabId: record ? record.tabId : null, text: record ? record.text : null };
		})()`);
		storage.race.after = latest;
		check("Q05 conflict did not merge both texts", latest.text === "탭 A 저장" || latest.text === "탭 B 저장", String(latest.text));

		// Same-tab stale write: the tabId guard alone would allow this. Only the revision CAS keeps
		// the newest record from being overwritten by an older revision of the same tab.
		const staleSameTab = await page.evaluate(`(async () => {
			const { mod, db } = window.__q05;
			const result = await mod.saveDraft(db, { draftId: '${DRAFT_ID}', tabId: '${latest.tabId}', revision: ${latest.revision - 1}, text: '같은 탭 낡은 저장', cursor: 0 });
			const record = await mod.readDraft(db, '${DRAFT_ID}');
			return { ok: result.ok === true, conflict: result.conflict === true, revision: record ? record.revision : null, text: record ? record.text : null };
		})()`);
		act("same-tab-stale", `same tab ${latest.tabId} writes revision ${latest.revision - 1} against ${latest.revision}`, `ok=${staleSameTab.ok} conflict=${staleSameTab.conflict}`);
		storage.staleSameTab = staleSameTab;
		check("Q05 same-tab stale revision conflicts", staleSameTab.ok === false && staleSameTab.conflict === true, JSON.stringify(staleSameTab));
		check("Q05 same-tab stale revision does not overwrite", staleSameTab.revision === latest.revision && staleSameTab.text === latest.text, JSON.stringify(staleSameTab));

		const abortProbe = await page.evaluate(`(async () => {
			const { mod, db } = window.__q05;
			const before = await mod.readDraft(db, '${DRAFT_ID}');
			let code = null;
			try {
				await mod.saveDraft(db, { draftId: '${DRAFT_ID}', tabId: 'tab-a', revision: before.revision, text: '절대 저장되면 안 됨', cursor: 1 }, { onTransaction(tx) { tx.abort(); } });
			} catch (error) {
				code = error && error.code ? error.code : String(error);
			}
			const after = await mod.readDraft(db, '${DRAFT_ID}');
			return { code, beforeText: before.text, afterText: after.text, beforeRevision: before.revision, afterRevision: after.revision };
		})()`);
		act("abort-probe", "start saveDraft then transaction.abort()", `rejected code=${abortProbe.code}`);
		storage.abort = abortProbe;
		check('Q05 aborted transaction rejects with code "aborted"', abortProbe.code === "aborted", String(abortProbe.code));
		check("Q05 aborted transaction leaves the previous record intact", abortProbe.afterText === abortProbe.beforeText && abortProbe.afterRevision === abortProbe.beforeRevision, JSON.stringify(abortProbe));

		const unavailable = await page.evaluate(`(async () => {
			const mod = await import('/web/issue-drafts.js');
			const stub = {
				open() {
					const request = { result: null, error: new Error('indexedDB denied'), onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
					queueMicrotask(() => { if (typeof request.onerror === 'function') request.onerror({ target: request }); });
					return request;
				}
			};
			let code = null;
			try {
				await mod.openDraftDb({ indexedDB: stub, origin: location.origin, storeId: '${STORE_ID}' });
			} catch (error) {
				code = error && error.code ? error.code : String(error);
			}
			const draft = mod.applyDraftEvent(mod.createDraftState({ draftId: 'draft-send-without-save' }), { type: 'edit', text: '저장 없이 보내기', cursor: 3 });
			return { code, status: draft.status, text: draft.text };
		})()`);
		act("unavailable-probe", "stub indexedDB open() fires onerror", `rejected code=${unavailable.code}; pure edit status=${unavailable.status}`);
		storage.unavailable = unavailable;
		check('Q05 unavailable indexedDB rejects with "storage_unavailable"', unavailable.code === "storage_unavailable", String(unavailable.code));
		check("Q05 pure state still accepts edit for send-without-save", unavailable.status === "editing" && unavailable.text === "저장 없이 보내기", JSON.stringify(unavailable));

		// Quota denial on a real write path: wrap the open database's transaction so the draft put is
		// denied with QuotaExceededError before any record is written. The transaction is a real
		// IndexedDB transaction; only its put is refused.
		const quota = await page.evaluate(`(async () => {
			const { mod, db } = window.__q05;
			const before = await mod.readDraft(db, '${DRAFT_ID}');
			const quotaError = new DOMException('quota exceeded', 'QuotaExceededError');
			const real = db._idb;
			const wrapped = Object.create(db);
			wrapped._idb = new Proxy(real, {
				get(target, prop) {
					if (prop === 'transaction') {
						return (names, mode) => {
							const tx = target.transaction(names, mode);
							const handlers = Object.create(null);
							tx.onabort = () => handlers.onabort && handlers.onabort({ target: tx });
							tx.oncomplete = () => handlers.oncomplete && handlers.oncomplete({ target: tx });
							tx.onerror = (event) => handlers.onerror && handlers.onerror(event);
							return new Proxy(tx, {
								get(t, key) {
									if (key === 'error') return quotaError;
									if (key === 'objectStore') {
										return (name) => {
											const store = t.objectStore(name);
											return new Proxy(store, {
												get(s, storeKey) {
													if (storeKey === 'put') {
														return () => {
															queueMicrotask(() => { try { t.abort(); } catch {} });
															return { error: null, onsuccess: null, onerror: null };
														};
													}
													const value = s[storeKey];
													return typeof value === 'function' ? value.bind(s) : value;
												},
											});
										};
									}
									if (key in handlers) return handlers[key];
									const value = t[key];
									return typeof value === 'function' ? value.bind(t) : value;
								},
								set(t, key, value) {
									if (key === 'onabort' || key === 'oncomplete' || key === 'onerror') {
										handlers[key] = value;
										return true;
									}
									t[key] = value;
									return true;
								},
							});
						};
					}
					const value = target[prop];
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
			let code = null;
			try {
				await mod.saveDraft(wrapped, { draftId: '${DRAFT_ID}', tabId: '${latest.tabId}', revision: before.revision, text: '할당량 초과 저장', cursor: 0 });
			} catch (error) {
				code = error && error.code ? error.code : String(error);
			}
			const after = await mod.readDraft(db, '${DRAFT_ID}');
			return { code, beforeRevision: before.revision, beforeText: before.text, afterRevision: after.revision, afterText: after.text };
		})()`);
		act("quota-probe", "deny the draft put with QuotaExceededError inside a real transaction", `rejected code=${quota.code}`);
		storage.quota = quota;
		check('Q05 quota-denied write rejects with code "quota"', quota.code === "quota", String(quota.code));
		check("Q05 quota-denied write leaves the record intact", quota.afterRevision === quota.beforeRevision && quota.afterText === quota.beforeText, JSON.stringify(quota));

		const shot = await page.screenshot({ type: "png" });
		const shotPath = evidence("Q05-draft.png", Buffer.from(shot));
		act("screenshot", shotPath, "page.screenshot resolved");
		check("Q05 screenshot saved", fs.existsSync(shotPath) && fs.statSync(shotPath).size > 0, shotPath);
	} finally {
		evidence("Q05-actions.json", JSON.stringify(actions, null, "\t"));
		evidence("Q05-storage.json", JSON.stringify(storage, null, "\t"));
		if (second) await second.close().catch(() => second.dispose?.());
		await page.close().catch(() => page.dispose?.());
	}
}
