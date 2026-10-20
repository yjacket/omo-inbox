/* Inbox service worker: push display, notification actions, app badge. */
"use strict";

/** Absolute form of a page url; a relative one resolves against the registration scope when there is one. */
function resolveUrl(raw, scope) {
	const url = String(raw || "/");
	if (scope) {
		try {
			return new URL(url, scope).href;
		} catch {
			/* an unusable scope falls through to the raw value */
		}
	}
	try {
		return new URL(url).href;
	} catch {
		return url;
	}
}

/** True when a window client already shows the target page; the fragment is a scroll target, not a page. */
function samePage(candidate, target) {
	try {
		const client = new URL(candidate, target);
		const wanted = new URL(target);
		return client.origin === wanted.origin && client.pathname === wanted.pathname && client.search === wanted.search;
	} catch {
		return candidate === target;
	}
}

/** Focus the window already showing the target, else open it. Returns whether a window was focused. */
async function focusOrOpen(target, clients) {
	let windows = [];
	try {
		windows = (await clients.matchAll({ type: "window", includeUncontrolled: true })) || [];
	} catch {
		windows = [];
	}
	for (const client of windows) {
		if (!client || !samePage(client.url, target)) continue;
		try {
			await client.focus();
			return true;
		} catch {
			/* a window that refuses focus is not the one we meant */
		}
	}
	await clients.openWindow(target);
	return false;
}

/**
 * The notificationclick body, pure so a Node test can drive it with stubs.
 * `action` is the clicked action id: `rec` answers the item with its recommended option, anything else -
 * including a body tap, which arrives as "" - opens the thread. A `rec` whose POST fails (409 closed,
 * 400 incomplete, offline) also opens the thread, because nothing was delivered from the phone.
 */
async function handleClick(payload, action, fetchImpl, clientsImpl) {
	const data = payload && typeof payload === "object" ? payload : {};
	const clients = clientsImpl || {};
	const scope = typeof clients.scope === "string" ? clients.scope : "";
	const url = resolveUrl(data.url || "/", scope);
	const rec = data.rec;
	if (action === "rec" && data.itemId && rec && rec.questionId && rec.label && typeof fetchImpl === "function") {
		const body = JSON.stringify({ answers: { [rec.questionId]: { selected: [rec.label] } } });
		let answered = false;
		try {
			const res = await fetchImpl(`/api/items/${encodeURIComponent(data.itemId)}/answer`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-inbox": "1" },
				body,
				keepalive: true,
			});
			answered = Boolean(res && res.ok);
		} catch {
			answered = false;
		}
		if (answered) return { answered: true, opened: false, url };
	}
	const focused = await focusOrOpen(url, clients);
	return { answered: false, opened: true, focused, url };
}

// Everything below runs in the service worker only; importing this file in Node registers nothing.
const inWorkerContext = typeof self !== "undefined" && self !== null && typeof self.addEventListener === "function";

if (inWorkerContext) {
	const clientStore = () => ({
		matchAll: (options) => self.clients.matchAll(options),
		openWindow: (url) => self.clients.openWindow(url),
		scope: self.registration && self.registration.scope,
	});
	const doFetch = (url, init) => fetch(url, init);

	self.addEventListener("install", () => {
		self.skipWaiting();
	});

	self.addEventListener("activate", (event) => {
		event.waitUntil(self.clients.claim());
	});

	self.addEventListener("push", (event) => {
		let data = {};
		try {
			data = event.data ? event.data.json() : {};
		} catch {
			data = { title: "Inbox", body: event.data ? event.data.text() : "" };
		}
		const options = {
			body: data.body || "",
			tag: data.tag || undefined,
			renotify: typeof data.renotify === "boolean" ? data.renotify : Boolean(data.tag),
			data: { url: data.url || "/", itemId: data.itemId || null, rec: data.rec || null },
		};
		if (Array.isArray(data.actions) && data.actions.length) options.actions = data.actions;
		if (typeof data.badge === "number") self.registration.setAppBadge?.(data.badge);
		event.waitUntil(self.registration.showNotification(data.title || "Inbox", options));
	});

	self.addEventListener("notificationclick", (event) => {
		event.notification.close();
		const data = (event.notification && event.notification.data) || {};
		event.waitUntil(handleClick(data, event.action || "", doFetch, clientStore()));
	});
}

export { handleClick };
