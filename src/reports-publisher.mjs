import { deriveTitle, FAILURE_TEXT } from "./reports-contract.mjs";
import { buildRewriteRequest, findLeaks, leakSources, parseRewrite } from "./reports-rewrite.mjs";

export function createPublisher({
	store, api, assets, issues, body, config, publicBase, serverBuild, version,
	notify = () => {}, onSent = () => {}, log = () => {}, now = () => new Date(),
	setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
	retryMs = 5000, reconcileMs = 60000,
}) {
	const queue = [];
	const enqueued = new Set();
	const timers = new Map();
	let running = null;
	let stopped = false;
	let repo = null;
	let labelReady = false;

	const clock = () => new Date(now()).getTime();
	function update(record, delivery, patch = {}) {
		const result = store.update(record.id, {
			...patch, delivery: { ...record.delivery, ...delivery },
		});
		if (result.delivery.state === "sent" && record.delivery.state !== "sent") {
			try {
				Promise.resolve(onSent(result)).catch(() => {});
			} catch {
				// A callback failure must not change a successfully persisted delivery.
			}
		}
		log(`report ${record.id} ${result.delivery.state}${result.delivery.lastError ? " " + result.delivery.lastError.kind : ""}`);
		return result;
	}

	function schedule(record) {
		if (stopped || timers.has(record.id)) return;
		const delay = Math.max(0, Date.parse(record.delivery.nextAttemptAt) - clock());
		timers.set(record.id, setTimer(() => {
			timers.delete(record.id);
			return kick(record.id);
		}, delay));
	}

	async function fail(record, kind) {
		if (record.delivery.state === "failed") return;
		update(record, {
			state: "failed", nextAttemptAt: null,
			lastError: { kind, detail: FAILURE_TEXT[kind] },
		});
		try {
			await notify({
				title: "제보를 GitHub에 올리지 못했습니다",
				body: Array.from(record.issueRequest?.title ?? deriveTitle(record.report.description)).slice(0, 80).join(""),
				url: "/issues", tag: "report:" + record.id,
			});
		} catch {
			// Notification delivery must not retry or change the persisted failure.
		}
	}

	// A held report waits for the owner's retry; it posts nothing and is never retried by a timer.
	async function hold(record, kind) {
		update(record, {
			state: "held", nextAttemptAt: null,
			lastError: { kind, detail: FAILURE_TEXT[kind] },
		});
		try {
			await notify({
				title: "제보를 공개 저장소에 올리지 않았습니다",
				body: FAILURE_TEXT[kind],
				url: "/issues", tag: "report:" + record.id,
			});
		} catch {
			// Notification delivery must not change the persisted hold.
		}
		return { ok: true, state: "held" };
	}

	async function backoff(record, state) {
		const attempts = record.delivery.attempts + 1;
		if (attempts >= 8) {
			await fail(update(record, { attempts }), "transient");
			return;
		}
		const delay = Math.min(30 * 60 * 1000, retryMs * 2 ** (attempts - 1)) * (0.5 + 0.5 * random());
		schedule(update(record, {
			state, attempts, nextAttemptAt: new Date(clock() + delay).toISOString(),
		}));
	}

	async function processRecord(id) {
		let record = store.get(id);
		if (!record || ["sent", "failed", "held"].includes(record.delivery.state)) return;
		if (record.delivery.nextAttemptAt && Date.parse(record.delivery.nextAttemptAt) > clock()) {
			schedule(record);
			return;
		}
		let creating = false;
		try {
			if (repo === null) repo = await api.repoInfo();
			if (repo.hasIssues === false) return await fail(record, "issues_disabled");
			// A public repo gets the model's rewrite and the masked picture, never the report as written.
			const open = repo.private !== true;
			if (open && record.rewrite == null) {
				if (record.delivery.state !== "rewriting") update(record, { state: "rewriting", nextAttemptAt: null });
				return;
			}
			if (!labelReady) {
				await issues.ensureLabel(api, { name: config.label, color: "d93f0b", description: "Inbox 제보" });
				labelReady = true;
			}
			if (stopped) return;

			// A persisted creating state means the POST may already have succeeded.
			// A retry_wait with uncertainty is a rate-limited marker lookup.
			if (["creating", "reconciling"].includes(record.delivery.state) ||
				(record.delivery.state === "retry_wait" && record.delivery.uncertainSince)) {
				record = update(record, { state: "reconciling", nextAttemptAt: null });
				const found = await issues.findIssueByMarker(api, {
					marker: body.marker(id), label: config.label, creator: await api.login(),
					since: new Date(Date.parse(record.delivery.uncertainSince) - 10 * 60 * 1000),
				});
				if (found.matches.length) {
					const matches = [...found.matches].sort((a, b) => a.number - b.number);
					for (const _extra of matches.slice(1)) log(`report ${id} reconciling duplicate`);
					update(record, { state: "sent", nextAttemptAt: null, lastError: null }, { github: matches[0] });
					return;
				}
				if (!found.complete) return await backoff(record, "reconciling");
				if (record.delivery.creates >= 3) return await fail(record, "transient");
			}
			if (stopped) return;
			if ((open ? record.report?.mask?.width > 0 : record.image) && !record.asset) {
				record = update(record, { state: "uploading", nextAttemptAt: null });
				await assets.ensureAssetsBranch(api, { branch: config.assetsBranch });
				if (stopped) return;
				const asset = await assets.putAsset(api, {
					branch: config.assetsBranch, path: assets.assetPath(record),
					bytes: open ? store.maskedImage(id) : store.image(id), message: "Add inbox report " + id,
				});
				record = store.update(id, { asset });
			}
			if (stopped) return;
			if (record.issueRequest === null && open) {
				record = store.update(id, {
					issueRequest: body.buildPublicIssue({
						record, repo: config.repo, assetsBranch: config.assetsBranch, label: config.label, serverBuild, version,
					}),
				});
			}
			if (record.issueRequest === null) {
				record = store.update(id, {
					issueRequest: body.buildIssue({
						record, title: deriveTitle(record.report.description),
						repo: config.repo, assetsBranch: config.assetsBranch, label: config.label,
						publicBase, serverBuild, version,
					}),
				});
			}
			record = update(record, {
				state: "creating", uncertainSince: new Date(clock()).toISOString(),
				creates: record.delivery.creates + 1, nextAttemptAt: null,
			});
			creating = true;
			const github = await issues.createIssue(api, record.issueRequest);
			creating = false;
			update(record, { state: "sent", nextAttemptAt: null, lastError: null }, { github });
		} catch (error) {
			const kind = error.kind ?? "transient";
			if (kind === "rate_limit") {
				schedule(update(record, {
					state: "retry_wait",
					uncertainSince: creating ? null : record.delivery.uncertainSince,
					nextAttemptAt: new Date(error.retryAt ?? clock() + retryMs).toISOString(),
				}));
			} else if (kind === "transient" || kind === "malformed") {
				if (creating) {
					schedule(update(record, {
						state: "reconciling", nextAttemptAt: new Date(clock() + reconcileMs).toISOString(),
					}));
				} else {
					await backoff(record, record.delivery.uncertainSince ? "reconciling" : "retry_wait");
				}
			} else {
				await fail(record, kind === "validation" && error.codes?.includes("attachment_conflict") ? "attachment_conflict" : kind);
			}
		}
	}

	async function drain() {
		while (!stopped && queue.length) {
			const id = queue.shift();
			try {
				await processRecord(id);
			} finally {
				enqueued.delete(id);
			}
		}
	}

	function kick(id) {
		if (stopped) return Promise.resolve();
		if (!enqueued.has(id)) {
			enqueued.add(id);
			queue.push(id);
		}
		if (!running) {
			// Defer the drain so concurrent kicks share one FIFO worker.
			running = Promise.resolve().then(drain).finally(() => { running = null; });
		}
		return running;
	}

	function start() {
		stopped = false;
		for (const record of store.unfinished().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) kick(record.id);
		return running ?? Promise.resolve();
	}

	/** Ids of reports waiting for a model rewrite, oldest first. */
	function rewriteWanted() {
		return store.unfinished()
			.filter((record) => record.delivery.state === "rewriting")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
			.map((record) => record.id);
	}

	/** The model request for a report waiting for its rewrite, or null. Carries the original picture. */
	function rewriteRequest(id) {
		const record = store.get(id);
		if (!record || record.delivery.state !== "rewriting") return null;
		const png = record.image ? store.image(id) : null;
		return buildRewriteRequest(record, png ? png.toString("base64") : null);
	}

	/**
	 * The model's answer for a waiting report. An unparsable answer or one that copies a text
	 * of the picture, a page id, a path, an address or an email holds the report; a clean one
	 * is stored and the report goes on to GitHub.
	 */
	async function rewritten(id, { text, model = null } = {}) {
		const record = store.get(id);
		if (!record || record.delivery.state !== "rewriting") return { ok: false, error: "not_waiting" };
		const parsed = parseRewrite(text);
		if (parsed === null) return hold(record, "rewrite_failed");
		const leaks = findLeaks(`${parsed.title}\n${parsed.body}`, leakSources(record.report));
		if (leaks.length) {
			log(`report ${id} rewrite leak ${leaks.join(",")}`);
			return hold(record, "leak");
		}
		const stored = store.update(id, { rewrite: { ...parsed, model, at: new Date(clock()).toISOString() } });
		update(stored, { state: "queued", nextAttemptAt: null, lastError: null });
		kick(id);
		return { ok: true, state: "pending" };
	}

	/** The extension could not rewrite: no image-capable model (`no_model`) or the call failed. */
	async function rewriteUnavailable(id, kind) {
		const record = store.get(id);
		if (!record || record.delivery.state !== "rewriting") return { ok: false, error: "not_waiting" };
		return hold(record, kind === "no_model" ? "no_model" : "rewrite_failed");
	}

	function retry(id) {
		let record = store.get(id);
		if (!record || !["failed", "held"].includes(record.delivery.state)) return false;
		// A held report asks the model again rather than reusing a refused answer.
		if (record.delivery.state === "held") record = store.update(id, { rewrite: null });
		update(record, {
			state: "queued", attempts: 0, lastError: null, nextAttemptAt: null, uncertainSince: null,
		});
		kick(id);
		return true;
	}

	function stop() {
		stopped = true;
		for (const timer of timers.values()) clearTimer(timer);
		timers.clear();
		for (const id of queue) enqueued.delete(id);
		queue.length = 0;
	}

	return { start, kick, retry, stop, rewriteWanted, rewriteRequest, rewritten, rewriteUnavailable };
}
