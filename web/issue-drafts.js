/* Issue draft/outbox/receipt storage.
 *
 * The pure state layer at the top is importable by Node and never touches IndexedDB. The storage
 * layer below receives its indexedDB implementation as an argument, so a module-level import in a
 * browser and a Node test both stay inert until a caller opens the database.
 *
 * Durability rule: every write resolves on the transaction's complete event, never on request
 * success. An aborted transaction therefore rejects instead of reporting a false save.
 */

export const DRAFT_STATUSES = Object.freeze([
	"editing",
	"saved",
	"save-failed",
	"sending",
	"pending-unknown",
	"accepted",
	"conflict",
	"store-changed",
	"discarded",
]);

export const DRAFT_DB_NAME = "inbox-issues-v1";
export const DRAFT_DB_VERSION = 1;

function cloneValue(value) {
	if (value === null || value === undefined || typeof value !== "object") return value;
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
	if (value === null || typeof value !== "object") return value;
	for (const key of Object.keys(value)) deepFreeze(value[key]);
	return Object.freeze(value);
}

function newDraftId() {
	const cryptoImpl = globalThis.crypto;
	if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") return cryptoImpl.randomUUID();
	return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isLocked(state) {
	return state.requestId !== null && (state.status === "sending" || state.status === "pending-unknown" || state.status === "accepted");
}

/** A fresh in-memory draft. `initial` only seeds fields; no persistent side effect happens here. */
export function createDraftState(initial = {}) {
	const source = initial && typeof initial === "object" ? initial : {};
	return {
		draftId: typeof source.draftId === "string" && source.draftId !== "" ? source.draftId : newDraftId(),
		tabId: typeof source.tabId === "string" && source.tabId !== "" ? source.tabId : null,
		revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
		storeId: typeof source.storeId === "string" && source.storeId !== "" ? source.storeId : null,
		text: typeof source.text === "string" ? source.text : "",
		cursor: Number.isInteger(source.cursor) && source.cursor >= 0 ? source.cursor : 0,
		evidence: source.evidence === undefined ? null : cloneValue(source.evidence),
		status: "editing",
		requestId: null,
		envelope: null,
		receipt: null,
		conflict: null,
		failure: null,
		requiresNewReport: false,
	};
}

/**
 * Pure transition. Returns a new state and never mutates the input. Once a draft is frozen, its
 * requestId and envelope are pinned: later freeze/edit/capture events cannot replace them.
 */
export function applyDraftEvent(state, event) {
	if (!state || typeof state !== "object") throw new TypeError("applyDraftEvent needs a draft state");
	if (!event || typeof event !== "object") throw new TypeError("applyDraftEvent needs an event");
	const next = { ...state };
	const type = event.type;

	if (next.status === "discarded" && type !== "discard") return next;

	switch (type) {
		case "edit": {
			if (isLocked(next)) return next;
			if (typeof event.text === "string") next.text = event.text;
			if (Number.isInteger(event.cursor) && event.cursor >= 0) next.cursor = event.cursor;
			if (next.status === "saved" || next.status === "save-failed") next.status = "editing";
			else if (next.status !== "conflict" && next.status !== "store-changed") next.status = "editing";
			return next;
		}
		case "capture": {
			if (isLocked(next)) return next;
			next.evidence = cloneValue(event.evidence);
			if (next.status === "saved" || next.status === "save-failed") next.status = "editing";
			return next;
		}
		case "freeze": {
			if (next.requestId !== null) return next;
			next.requestId = typeof event.requestId === "string" ? event.requestId : null;
			next.envelope = event.envelope === undefined ? null : deepFreeze(cloneValue(event.envelope));
			next.status = "sending";
			next.requiresNewReport = false;
			return next;
		}
		case "sent": {
			next.status = "sending";
			return next;
		}
		case "response-lost": {
			next.status = "pending-unknown";
			return next;
		}
		case "accepted": {
			// A receipt can only complete an envelope that was frozen first; otherwise there is no
			// request it could belong to.
			if (next.requestId === null) return next;
			next.receipt = cloneValue(event.receipt);
			next.status = "accepted";
			next.requiresNewReport = false;
			return next;
		}
		case "conflict": {
			next.conflict = { currentSeq: event.currentSeq, state: cloneValue(event.state) };
			next.status = "conflict";
			return next;
		}
		case "store-changed": {
			next.storeId = typeof event.newStoreId === "string" ? event.newStoreId : next.storeId;
			next.status = "store-changed";
			next.requiresNewReport = true;
			return next;
		}
		case "storage-failed": {
			next.failure = { reason: event.reason };
			next.status = "save-failed";
			return next;
		}
		case "saved": {
			next.status = "saved";
			next.failure = null;
			return next;
		}
		case "discard": {
			next.status = "discarded";
			next.receipt = null;
			next.conflict = null;
			next.requiresNewReport = false;
			return next;
		}
		default:
			return next;
	}
}

export class DraftStorageError extends Error {
	constructor(code, cause) {
		super(`issue draft storage: ${code}`);
		this.name = "DraftStorageError";
		this.code = code;
		this.cause = cause;
	}
}

function codeFromCause(cause) {
	const name = cause && typeof cause.name === "string" ? cause.name : "";
	if (name === "QuotaExceededError") return "quota";
	if (name === "AbortError") return "aborted";
	return null;
}

function toStorageError(cause, fallback = "storage_unavailable") {
	return new DraftStorageError(codeFromCause(cause) || fallback, cause);
}

function isOpenDb(db) {
	return Boolean(db && db._idb && typeof db._idb.transaction === "function" && typeof db.origin === "string" && typeof db.storeId === "string");
}

function openTransaction(db, names, mode) {
	try {
		return db._idb.transaction(names, mode);
	} catch (cause) {
		throw toStorageError(cause, "storage_unavailable");
	}
}

function transactionFailure(tx, fallback) {
	return toStorageError(tx.error, fallback);
}

/**
 * Open (or create) the shared issue-drafts database. The returned wrapper stamps every record with
 * its own origin and storeId and scopes every read/write to them.
 */
export function openDraftDb(options = {}) {
	return new Promise((resolve, reject) => {
		const { indexedDB: idb, origin, storeId } = options || {};
		if (!idb || typeof idb.open !== "function") {
			reject(toStorageError(new Error("IndexedDB is unavailable")));
			return;
		}
		if (typeof origin !== "string" || origin === "" || typeof storeId !== "string" || storeId === "") {
			reject(new TypeError("openDraftDb needs a nonempty origin and storeId"));
			return;
		}
		let request;
		try {
			request = idb.open(DRAFT_DB_NAME, DRAFT_DB_VERSION);
		} catch (cause) {
			reject(toStorageError(cause));
			return;
		}
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		request.onupgradeneeded = () => {
			try {
				const database = request.result;
				if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "draftId" });
				if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "requestId" });
				if (!database.objectStoreNames.contains("receipts")) database.createObjectStore("receipts", { keyPath: "requestId" });
			} catch (cause) {
				finish(reject, toStorageError(cause));
			}
		};
		request.onblocked = () => finish(reject, new DraftStorageError("blocked", new Error("database upgrade was blocked")));
		request.onerror = () => finish(reject, toStorageError(request.error, "storage_unavailable"));
		request.onsuccess = () => {
			const database = request.result;
			if (!database) {
				finish(reject, toStorageError(new Error("IndexedDB returned no database")));
				return;
			}
			if (typeof database.onversionchange === "function" || "onversionchange" in database) {
				database.onversionchange = () => database.close();
			}
			finish(resolve, {
				_idb: database,
				name: DRAFT_DB_NAME,
				origin,
				storeId,
				close() {
					database.close();
				},
			});
		};
	});
}

/**
 * Read-modify-write a draft guarded by revision and tabId. A stale revision (or another tab at the
 * same revision) resolves `{ ok:false, conflict:true, theirs }` without writing.
 */
export function saveDraft(db, draft, options = {}) {
	return new Promise((resolve, reject) => {
		if (!isOpenDb(db)) {
			reject(new TypeError("saveDraft needs an open draft db"));
			return;
		}
		if (!draft || typeof draft !== "object" || typeof draft.draftId !== "string" || draft.draftId === "") {
			reject(new TypeError("saveDraft needs a draftId"));
			return;
		}
		let tx;
		try {
			tx = openTransaction(db, ["drafts"], "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		let outcome = null;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		tx.oncomplete = () => finish(resolve, outcome);
		tx.onabort = () => finish(reject, transactionFailure(tx, "aborted"));
		tx.onerror = () => {
			/* the abort event carries the typed failure */
		};
		const baseRevision = Number.isInteger(draft.revision) && draft.revision >= 0 ? draft.revision : 0;
		const store = tx.objectStore("drafts");
		const get = store.get(draft.draftId);
		get.onerror = () => finish(reject, toStorageError(get.error, "storage_unavailable"));
		get.onsuccess = () => {
			const theirs = get.result || null;
			if (theirs !== null) {
				const sameScope = theirs.origin === db.origin && theirs.storeId === db.storeId;
				const sameRevision = theirs.revision === baseRevision;
				const sameTab = theirs.tabId === draft.tabId;
				if (!sameScope || !sameRevision || !sameTab) {
					outcome = { ok: false, conflict: true, theirs };
					return;
				}
			} else if (baseRevision !== 0) {
				outcome = { ok: false, conflict: true, theirs: null };
				return;
			}
			const record = {
				...draft,
				origin: db.origin,
				storeId: db.storeId,
				revision: baseRevision + 1,
			};
			let put;
			try {
				put = store.put(record);
			} catch (cause) {
				try {
					tx.abort();
				} catch {
					/* already aborting */
				}
				finish(reject, toStorageError(cause));
				return;
			}
			put.onerror = () => finish(reject, toStorageError(put.error, "storage_unavailable"));
			outcome = { ok: true, revision: record.revision, record };
		};
		if (typeof options.onTransaction === "function") {
			try {
				options.onTransaction(tx);
			} catch (cause) {
				try {
					tx.abort();
				} catch {
					/* already aborting */
				}
				finish(reject, toStorageError(cause, "aborted"));
			}
		}
	});
}

/** Read one scoped draft. Resolves null for a missing or foreign-store record. */
export function readDraft(db, draftId) {
	return new Promise((resolve, reject) => {
		if (!isOpenDb(db)) {
			reject(new TypeError("readDraft needs an open draft db"));
			return;
		}
		let tx;
		try {
			tx = openTransaction(db, ["drafts"], "readonly");
		} catch (error) {
			reject(error);
			return;
		}
		let record = null;
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		tx.oncomplete = () => finish(resolve, record);
		tx.onabort = () => finish(reject, transactionFailure(tx, "aborted"));
		const get = tx.objectStore("drafts").get(draftId);
		get.onsuccess = () => {
			const found = get.result;
			record = found && found.origin === db.origin && found.storeId === db.storeId ? found : null;
		};
		get.onerror = () => finish(reject, toStorageError(get.error, "storage_unavailable"));
	});
}

/** Freeze a reviewed envelope under a requestId. Resolves only when the outbox transaction commits. */
export function freezeToOutbox(db, requestId, envelope) {
	return new Promise((resolve, reject) => {
		if (!isOpenDb(db)) {
			reject(new TypeError("freezeToOutbox needs an open draft db"));
			return;
		}
		if (typeof requestId !== "string" || requestId === "") {
			reject(new TypeError("freezeToOutbox needs a requestId"));
			return;
		}
		let tx;
		try {
			tx = openTransaction(db, ["outbox"], "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		let outcome = null;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		tx.oncomplete = () => finish(resolve, outcome);
		tx.onabort = () => finish(reject, transactionFailure(tx, "aborted"));
		const store = tx.objectStore("outbox");
		const get = store.get(requestId);
		get.onerror = () => finish(reject, toStorageError(get.error, "storage_unavailable"));
		get.onsuccess = () => {
			const existing = get.result;
			if (existing) {
				if (existing.origin === db.origin && existing.storeId === db.storeId) {
					outcome = { ok: true, requestId, reused: true, envelope: existing.envelope };
					return;
				}
				// A request ID belongs to the origin/store that froze it. Never overwrite a foreign
				// pending entry: a different store must not inherit this envelope.
				outcome = { ok: false, conflict: true, theirs: existing };
				return;
			}
			const record = { requestId, envelope: cloneValue(envelope), origin: db.origin, storeId: db.storeId };
			let put;
			try {
				put = store.put(record);
			} catch (cause) {
				try {
					tx.abort();
				} catch {
					/* already aborting */
				}
				finish(reject, toStorageError(cause));
				return;
			}
			put.onerror = () => finish(reject, toStorageError(put.error, "storage_unavailable"));
			outcome = { ok: true, requestId, reused: false, envelope: record.envelope };
		};
	});
}

/** Store a receipt and drop its outbox payload in one transaction. */
export function recordReceipt(db, requestId, receipt) {
	return new Promise((resolve, reject) => {
		if (!isOpenDb(db)) {
			reject(new TypeError("recordReceipt needs an open draft db"));
			return;
		}
		let tx;
		try {
			tx = openTransaction(db, ["receipts", "outbox"], "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		tx.oncomplete = () => finish(resolve, { ok: true, requestId, receipt });
		tx.onabort = () => finish(reject, transactionFailure(tx, "aborted"));
		const receipts = tx.objectStore("receipts");
		const outbox = tx.objectStore("outbox");
		const put = receipts.put({ requestId, receipt: cloneValue(receipt), origin: db.origin, storeId: db.storeId });
		put.onerror = () => finish(reject, toStorageError(put.error, "storage_unavailable"));
		const clear = outbox.delete(requestId);
		clear.onerror = () => finish(reject, toStorageError(clear.error, "storage_unavailable"));
	});
}

/** Remove one outbox entry. */
export function clearOutbox(db, requestId) {
	return new Promise((resolve, reject) => {
		if (!isOpenDb(db)) {
			reject(new TypeError("clearOutbox needs an open draft db"));
			return;
		}
		let tx;
		try {
			tx = openTransaction(db, ["outbox"], "readwrite");
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		tx.oncomplete = () => finish(resolve, { ok: true, requestId });
		tx.onabort = () => finish(reject, transactionFailure(tx, "aborted"));
		const remove = tx.objectStore("outbox").delete(requestId);
		remove.onerror = () => finish(reject, toStorageError(remove.error, "storage_unavailable"));
	});
}

/** Pending outbox entries for one origin/store identity. */
export function listPending(db, scope = {}) {
	return new Promise((resolve, reject) => {
		if (!isOpenDb(db)) {
			reject(new TypeError("listPending needs an open draft db"));
			return;
		}
		const origin = typeof scope.origin === "string" ? scope.origin : db.origin;
		const storeId = typeof scope.storeId === "string" ? scope.storeId : db.storeId;
		let tx;
		try {
			tx = openTransaction(db, ["outbox"], "readonly");
		} catch (error) {
			reject(error);
			return;
		}
		let pending = [];
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			fn(value);
		};
		tx.oncomplete = () => finish(resolve, pending);
		tx.onabort = () => finish(reject, transactionFailure(tx, "aborted"));
		const all = tx.objectStore("outbox").getAll();
		all.onerror = () => finish(reject, toStorageError(all.error, "storage_unavailable"));
		all.onsuccess = () => {
			pending = (all.result || []).filter((record) => record.origin === origin && record.storeId === storeId);
		};
	});
}
