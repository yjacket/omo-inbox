import { isUuidV4 } from "./issues-contract.mjs";

const UUID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUSH = Object.freeze({ title: "제보한 문제의 수정안이 왔습니다", body: "제보함에서 확인해 주세요." });

function pageNumber(value, name) {
	if (value === null) return null;
	if (!/^\d+$/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}

// The issue namespace has its own error shape. Old proposal errors, including the
// duplicate error that embeds a /p/ URL, must never leak through these routes.
const LOCAL_STATUS = Object.freeze({ bad_input: 400, too_long: 413 });

function issueError(res, sendJson, error) {
	const status = error && typeof error.status === "number" ? error.status : LOCAL_STATUS[error?.code];
	if (typeof status === "number" && typeof error.code === "string") {
		const body = { error: error.code };
		if (Array.isArray(error.fields) && error.fields.length) body.fields = error.fields.slice(0, 50);
		if (Number.isSafeInteger(error.currentSeq)) body.currentSeq = error.currentSeq;
		if (typeof error.state === "string") body.state = error.state;
		return sendJson(res, status, body);
	}
	throw error;
}

export function createIssuesHttp({
	store,
	sendJson,
	readJsonBody,
	buildInfo,
	buildStamp = () => buildInfo.buildId,
	pusher = null,
	log = () => {},
	now = () => new Date(),
	resolveReference = async () => ({ status: "unversioned", checkedAt: now().toISOString() }),
	proposalStore = null,
	bodyLimit,
	allowAccess,
	allowOrigin,
}) {
	const capabilities = () => ({
		...store.capabilities(),
		build: { ...buildInfo, buildId: buildStamp() },
		features: { create: true, feedback: true, commands: true, evidence: true },
	});

	function guard(res, access, headers, level = "read") {
		if (allowAccess(access, headers, level)) return true;
		sendJson(res, 403, { error: "forbidden" });
		return false;
	}

	function guardMutation(res, req, access, level) {
		if (!guard(res, access, req.headers, level)) return false;
		if (allowOrigin(req.headers, access)) return true;
		sendJson(res, 403, { error: "forbidden" });
		return false;
	}

	function sendImage(res, image) {
		res.writeHead(200, {
			"content-type": "image/png",
			"content-length": String(image.bytes.length),
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'",
			"cache-control": "private, no-store",
		});
		res.end(image.bytes);
	}

	// Correction identity is checked through direct proposal-store reads, never a
	// GET handler. A missing proposal or revision is bad input before any commit.
	async function resolveCorrection(correction) {
		const checkedAt = now().toISOString();
		if (correction.kind === "inbox-build") {
			const current = buildStamp();
			const status = typeof correction.buildId === "string" && current !== null && correction.buildId === current ? "matched" : "unversioned";
			return { ok: true, check: { status, checkedAt } };
		}
		if (!proposalStore) return { ok: true, check: { status: "unversioned", checkedAt } };
		let data;
		try {
			data = proposalStore.get(correction.proposalId);
		} catch (error) {
			if (error && (error.code === "not_found" || error.code === "bad_input" || error.code === "gone")) {
				return { ok: false, fields: ["command.correction.proposalId"] };
			}
			throw error;
		}
		if (!data.revs.some((rev) => rev.n === correction.revision)) {
			return { ok: false, fields: ["command.correction.revision"] };
		}
		try {
			proposalStore.board(correction.proposalId, correction.revision);
		} catch (error) {
			if (error && error.code === "bad_rev") return { ok: false, fields: ["command.correction.revision"] };
			throw error;
		}
		return { ok: true, check: { status: "matched", checkedAt } };
	}

	function notifyCheck(id) {
		if (!pusher || typeof pusher.notify !== "function") return;
		Promise.resolve()
			.then(() => pusher.notify({ ...PUSH, url: `/issues/${id}`, tag: `issue:${id}` }))
			.catch((error) => log(`issue push failed: ${error && error.stack ? error.stack : error}`));
	}

	async function handleGet(res, parts, query, access) {
		if (!guard(res, access, null)) return;
		if (parts.length === 4 && parts[3] === "capabilities") {
			return sendJson(res, 200, capabilities());
		}
		if (parts.length === 3) {
			const state = query.has("state") ? query.get("state") : null;
			const q = query.has("q") ? query.get("q") : null;
			const cursor = query.has("cursor") ? query.get("cursor") : null;
			const limit = pageNumber(query.has("limit") ? query.get("limit") : null, "limit");
			if (limit === undefined) return sendJson(res, 400, { error: "bad_input", fields: ["limit"] });
			try {
				return sendJson(res, 200, store.list({ state, q, cursor, limit: limit ?? 50 }));
			} catch (error) {
				return issueError(res, sendJson, error);
			}
		}
		if (parts.length === 7 && parts[4] === "evidence" && parts[6] === "image") {
			if (!isUuidV4(parts[3]) || !isUuidV4(parts[5])) return sendJson(res, 400, { error: "bad_input", fields: [isUuidV4(parts[3]) ? "captureId" : "id"] });
			try {
				return sendImage(res, store.evidenceImage(parts[3], parts[5]));
			} catch (error) {
				return issueError(res, sendJson, error);
			}
		}
		if (parts.length === 4) {
			if (!isUuidV4(parts[3])) return sendJson(res, 400, { error: "bad_input", fields: ["id"] });
			const after = pageNumber(query.has("after") ? query.get("after") : null, "after");
			const limit = pageNumber(query.has("limit") ? query.get("limit") : null, "limit");
			if (after === undefined) return sendJson(res, 400, { error: "bad_input", fields: ["after"] });
			if (limit === undefined) return sendJson(res, 400, { error: "bad_input", fields: ["limit"] });
			try {
				const detail = store.get(parts[3], { after: after ?? 0, limit: limit ?? 50 });
				return sendJson(res, 200, { ...detail, capabilities: capabilities() });
			} catch (error) {
				return issueError(res, sendJson, error);
			}
		}
		return sendJson(res, 404, { error: "not_found" });
	}

	async function handlePost(res, req, parts, access) {
		const route = parts[3] ?? null;
		const command = parts.length === 5 ? parts[4] : null;
		if (parts.length === 3) {
			if (!guardMutation(res, req, access, "feedback")) return;
			let body;
			try {
				body = await readJsonBody(req, bodyLimit);
			} catch (error) {
				return issueError(res, sendJson, error);
			}
			try {
				const result = await store.create(body, { actor: "owner", via: access, resolveReference, buildId: buildInfo.buildId });
				return sendJson(res, result.status, result.body);
			} catch (error) {
				return issueError(res, sendJson, error);
			}
		}
		if (parts.length === 5 && (command === "feedback" || command === "commands")) {
			if (!isUuidV4(route)) return sendJson(res, 400, { error: "bad_input", fields: ["id"] });
			if (command === "feedback") {
				if (!guardMutation(res, req, access, "feedback")) return;
			} else if (!guardMutation(res, req, access, "session")) return;
			let body;
			try {
				body = await readJsonBody(req, bodyLimit);
			} catch (error) {
				return issueError(res, sendJson, error);
			}
			try {
				// D8: the store calls this for request_check before publishing. The
				// check is persisted on the committed event and returned by every read,
				// so the HTTP layer does not decorate the response itself.
				const result = await store.command(route, body, {
					actor: command === "feedback" ? "owner" : "maintainer",
					via: access,
					resolveReference,
					resolveCorrection,
					buildId: buildInfo.buildId,
				});
				sendJson(res, result.status, result.body);
				if (result.event && result.event.type === "request_check") notifyCheck(route);
			} catch (error) {
				return issueError(res, sendJson, error);
			}
			return;
		}
		return sendJson(res, 404, { error: "not_found" });
	}

	return { handleGet, handlePost, capabilities };
}

export const ISSUE_PAGE = "issues.html";
export const ISSUE_UUID = UUID_PATH;
