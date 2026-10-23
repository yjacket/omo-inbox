import test from "node:test";
import assert from "node:assert/strict";
import {
	DRAFT_STATUSES,
	applyDraftEvent,
	createDraftState,
	freezeToOutbox,
	saveDraft,
} from "../web/issue-drafts.js";

const DRAFT_ID = "draft-q05-state";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function base() {
	return createDraftState({
		draftId: DRAFT_ID,
		tabId: "tab-a",
		revision: 0,
		text: "초안 텍스트",
		cursor: 5,
		evidence: { captureId: "capture-a", page: "inbox" },
	});
}

function envelope(requestId = REQUEST_ID) {
	return { v: 1, storeId: "store-a", requestId, description: "초안 텍스트" };
}

function frozen() {
	return applyDraftEvent(base(), { type: "freeze", requestId: REQUEST_ID, envelope: envelope() });
}

function stateAt(status) {
	if (status === "editing") return base();
	if (status === "saved") return applyDraftEvent(base(), { type: "saved" });
	if (status === "save-failed") return applyDraftEvent(base(), { type: "storage-failed", reason: "quota" });
	if (status === "sending") return applyDraftEvent(frozen(), { type: "sent" });
	if (status === "pending-unknown") return applyDraftEvent(frozen(), { type: "response-lost" });
	if (status === "accepted") return applyDraftEvent(frozen(), { type: "accepted", receipt: { requestId: REQUEST_ID, seq: 1 } });
	if (status === "conflict") return applyDraftEvent(frozen(), { type: "conflict", currentSeq: 4, state: "investigating" });
	if (status === "store-changed") return applyDraftEvent(frozen(), { type: "store-changed", newStoreId: "store-b" });
	if (status === "discarded") return applyDraftEvent(base(), { type: "discard" });
	throw new Error(`unhandled status ${status}`);
}

test("createDraftState starts editable and copies the capture", () => {
	const evidence = { captureId: "capture-a" };
	const state = createDraftState({ draftId: DRAFT_ID, text: "hello", cursor: 2, evidence });
	assert.equal(state.status, "editing");
	assert.equal(state.text, "hello");
	assert.equal(state.cursor, 2);
	evidence.captureId = "mutated";
	assert.equal(state.evidence.captureId, "capture-a");
});

test("table-driven transitions keep the documented status", () => {
	const cases = [
		{ name: "edit", state: base(), event: { type: "edit", text: "new", cursor: 3 }, status: "editing" },
		{ name: "capture", state: base(), event: { type: "capture", evidence: { captureId: "b" } }, status: "editing" },
		{ name: "freeze", state: base(), event: { type: "freeze", requestId: REQUEST_ID, envelope: envelope() }, status: "sending" },
		{ name: "sent", state: frozen(), event: { type: "sent" }, status: "sending" },
		{ name: "response-lost", state: frozen(), event: { type: "response-lost" }, status: "pending-unknown" },
		{ name: "accepted", state: frozen(), event: { type: "accepted", receipt: { seq: 1 } }, status: "accepted" },
		{ name: "conflict", state: frozen(), event: { type: "conflict", currentSeq: 2, state: "open" }, status: "conflict" },
		{ name: "store-changed", state: frozen(), event: { type: "store-changed", newStoreId: "store-b" }, status: "store-changed" },
		{ name: "storage-failed", state: base(), event: { type: "storage-failed", reason: "quota" }, status: "save-failed" },
		{ name: "discard", state: frozen(), event: { type: "discard" }, status: "discarded" },
	];
	for (const item of cases) {
		const next = applyDraftEvent(item.state, item.event);
		assert.equal(next.status, item.status, item.name);
		assert.notEqual(next, item.state, `${item.name} returns a new state`);
	}
});

test("freeze pins requestId and envelope against later events", () => {
	const first = frozen();
	const again = applyDraftEvent(first, { type: "freeze", requestId: OTHER_REQUEST_ID, envelope: envelope(OTHER_REQUEST_ID) });
	assert.equal(again.requestId, REQUEST_ID);
	assert.deepEqual(again.envelope, envelope());
	const edited = applyDraftEvent(again, { type: "edit", text: "다른 텍스트", cursor: 1 });
	assert.equal(edited.requestId, REQUEST_ID);
	assert.deepEqual(edited.envelope, envelope());
	assert.equal(edited.text, "초안 텍스트");
	const captured = applyDraftEvent(again, { type: "capture", evidence: { captureId: "other" } });
	assert.deepEqual(captured.evidence, { captureId: "capture-a", page: "inbox" });
	assert.ok(Object.isFrozen(again.envelope));
});

test("response-lost becomes pending-unknown, never failed or accepted", () => {
	const next = applyDraftEvent(frozen(), { type: "response-lost" });
	assert.equal(next.status, "pending-unknown");
	assert.notEqual(next.status, "save-failed");
	assert.notEqual(next.status, "accepted");
	assert.equal(next.requestId, REQUEST_ID);
	assert.deepEqual(next.envelope, envelope());
});

test("store-changed keeps local text and envelope and requires a new report", () => {
	const next = applyDraftEvent(frozen(), { type: "store-changed", newStoreId: "store-b" });
	assert.equal(next.status, "store-changed");
	assert.equal(next.storeId, "store-b");
	assert.equal(next.text, "초안 텍스트");
	assert.deepEqual(next.envelope, envelope());
	assert.equal(next.requestId, REQUEST_ID);
	assert.equal(next.requiresNewReport, true);
});

test("conflict records the server state without merging text or envelope", () => {
	const local = applyDraftEvent(frozen(), { type: "edit", text: "local text" });
	assert.equal(local.text, "초안 텍스트");
	const next = applyDraftEvent(local, { type: "conflict", currentSeq: 7, state: "resolved" });
	assert.equal(next.status, "conflict");
	assert.equal(next.text, "초안 텍스트");
	assert.deepEqual(next.envelope, envelope());
	assert.deepEqual(next.conflict, { currentSeq: 7, state: "resolved" });
});

test("storage failure keeps the description and reports save-failed", () => {
	const next = applyDraftEvent(base(), { type: "storage-failed", reason: "quota" });
	assert.equal(next.status, "save-failed");
	assert.equal(next.text, "초안 텍스트");
	assert.deepEqual(next.failure, { reason: "quota" });
});

test("discard works from every status", () => {
	for (const status of DRAFT_STATUSES) {
		const next = applyDraftEvent(stateAt(status), { type: "discard" });
		assert.equal(next.status, "discarded", status);
	}
});

test("discarded drafts do not silently return to editing", () => {
	const discarded = applyDraftEvent(base(), { type: "discard" });
	const edited = applyDraftEvent(discarded, { type: "edit", text: "revived", cursor: 1 });
	assert.equal(edited.status, "discarded");
	assert.equal(edited.text, "초안 텍스트");
});

function memoryDb(seed = {}, { denyQuota = false } = {}) {
	const stores = {
		drafts: new Map(Object.entries(seed.drafts ?? {})),
		outbox: new Map(Object.entries(seed.outbox ?? {})),
		receipts: new Map(Object.entries(seed.receipts ?? {})),
	};
	const idb = {
		transaction(names) {
			const tx = { oncomplete: null, onabort: null, onerror: null, error: null, aborted: false };
			const complete = () => queueMicrotask(() => {
				if (!tx.aborted) tx.oncomplete?.();
			});
			tx.objectStore = (name) => {
				const records = stores[name];
				if (!records) throw new Error(`missing store ${name}`);
				return {
					get(key) {
						const request = { result: undefined, error: null, onsuccess: null, onerror: null };
						queueMicrotask(() => {
							request.result = records.get(key);
							request.onsuccess?.();
							complete();
						});
						return request;
					},
					put(record) {
						if (denyQuota && name === "drafts") throw new DOMException("quota", "QuotaExceededError");
						records.set(record.draftId ?? record.requestId, structuredClone(record));
						return { error: null, onsuccess: null, onerror: null };
					},
				};
			};
			tx.abort = () => {
				tx.aborted = true;
				tx.error = new DOMException("abort", "AbortError");
				queueMicrotask(() => tx.onabort?.());
			};
			return tx;
		},
	};
	return { db: { _idb: idb, origin: "https://inbox.test", storeId: "store-a" }, stores };
}

test("saveDraft maps a quota-denied write to quota and leaves the record intact", async () => {
	const seeded = { draftId: DRAFT_ID, tabId: "tab-a", revision: 3, text: "보존", cursor: 1, origin: "https://inbox.test", storeId: "store-a" };
	const { db, stores } = memoryDb({ drafts: { [DRAFT_ID]: seeded } }, { denyQuota: true });
	await assert.rejects(
		saveDraft(db, { draftId: DRAFT_ID, tabId: "tab-a", revision: 3, text: "할당량 초과", cursor: 2 }),
		(error) => error.code === "quota",
	);
	assert.deepEqual(stores.drafts.get(DRAFT_ID), seeded);
});

test("a stale write from the same tab conflicts instead of silently overwriting", async () => {
	const seeded = { draftId: DRAFT_ID, tabId: "tab-a", revision: 4, text: "최신", cursor: 2, origin: "https://inbox.test", storeId: "store-a" };
	const { db, stores } = memoryDb({ drafts: { [DRAFT_ID]: seeded } });
	const result = await saveDraft(db, { draftId: DRAFT_ID, tabId: "tab-a", revision: 3, text: "낡은", cursor: 0 });
	assert.equal(result.ok, false);
	assert.equal(result.conflict, true);
	assert.equal(result.theirs.text, "최신");
	assert.deepEqual(stores.drafts.get(DRAFT_ID), seeded);
});

test("freezeToOutbox refuses an entry frozen by another store", async () => {
	const foreign = { requestId: REQUEST_ID, envelope: { description: "다른 스토어" }, origin: "https://inbox.test", storeId: "store-b" };
	const { db, stores } = memoryDb({ outbox: { [REQUEST_ID]: foreign } });
	const result = await freezeToOutbox(db, REQUEST_ID, envelope());
	assert.equal(result.ok, false);
	assert.equal(result.conflict, true);
	assert.deepEqual(stores.outbox.get(REQUEST_ID), foreign);
});

test("accepted without a frozen request does not claim acceptance", () => {
	const next = applyDraftEvent(base(), { type: "accepted", receipt: { seq: 1 } });
	assert.equal(next.status, "editing");
	assert.equal(next.receipt, null);
});
