import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCreate, deriveTitle, fingerprint, redactReport, rowState } from "./reports-contract.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPORT_PAGE = path.join(path.resolve(HERE, ".."), "web", "reports.html");

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pageNumber(value) {
	if (value === null) return null;
	if (!/^\d+$/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}

export function createReportsHttp({
	store,
	publisher,
	stateCache,
	sendJson,
	readJsonBody,
	bodyLimit,
	allowAccess,
	allowOrigin,
	handoff,
	productOf,
	repo = null,
	log = () => {},
	now = () => new Date(),
}) {
	function guard(res, access, level) {
		if (allowAccess(access, null, level)) return true;
		sendJson(res, 403, { error: "forbidden" });
		return false;
	}

	function guardMutation(res, req, access, level) {
		if (!guard(res, access, level)) return false;
		if (allowOrigin(req.headers, access)) return true;
		sendJson(res, 403, { error: "forbidden" });
		return false;
	}

	function statesNow() {
		const states = stateCache.get();
		return states instanceof Map ? states : null;
	}

	function githubOf(record, states) {
		if (record.github == null) return null;
		const cached = states ? states.get(record.github.number) : undefined;
		return {
			number: record.github.number,
			url: record.github.url,
			state: cached?.state ?? null,
			comments: cached?.comments ?? null,
		};
	}

	function rowOf(record, states) {
		const delivery = record.delivery ?? {};
		const state = rowState(delivery.state);
		return {
			id: record.id,
			title: deriveTitle(record.report?.description ?? ""),
			createdAt: record.createdAt,
			state,
			detail: state === "failed" ? delivery.lastError?.detail ?? null : null,
			github: githubOf(record, states),
			image: record.image != null,
			handoff: record.handoff == null ? null : { at: record.handoff.at, via: record.handoff.via },
		};
	}

	function sendImage(res, bytes) {
		res.writeHead(200, {
			"content-type": "image/png",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'",
			"cache-control": "private, no-store",
		});
		res.end(bytes);
	}

	function fail(res, status, body) {
		sendJson(res, status, body);
		return true;
	}

	function notFound(res) {
		return fail(res, 404, { error: "not_found" });
	}

	function validId(parts) {
		return parts.length >= 4 && UUID_V4.test(parts[3]);
	}

	function handleList(res, query) {
		const limitParam = query.has("limit") ? query.get("limit") : null;
		const limit = pageNumber(limitParam);
		if (limit === undefined || (limit !== null && (limit < 1 || limit > 100))) {
			return fail(res, 400, { error: "bad_input", fields: ["limit"] });
		}
		const cursor = query.has("cursor") ? query.get("cursor") : null;
		const page = store.list({ limit: limit ?? 50, cursor });
		const states = statesNow();
		return fail(res, 200, {
			items: page.items.map((record) => rowOf(record, states)),
			counts: store.counts(),
			nextCursor: page.nextCursor,
			repo,
			statesAt: stateCache.at(),
		});
	}

	function handleDetail(res, id) {
		const record = store.get(id);
		if (record == null) return notFound(res);
		const delivery = record.delivery ?? {};
		return fail(res, 200, {
			...rowOf(record, statesNow()),
			delivery: {
				state: delivery.state ?? null,
				attempts: delivery.attempts ?? 0,
				nextAttemptAt: delivery.nextAttemptAt ?? null,
			},
		});
	}

	async function handleGet(res, parts, query, access) {
		if (!(parts.length >= 3 && parts[1] === "api" && parts[2] === "reports")) return false;
		if (!guard(res, access, "read")) return true;

		if (parts.length === 3) return handleList(res, query);
		if (parts.length === 4) {
			if (!validId(parts)) return notFound(res);
			return handleDetail(res, parts[3]);
		}
		if (parts.length === 5 && parts[4] === "image") {
			if (!validId(parts)) return notFound(res);
			const bytes = store.image(parts[3]);
			if (bytes == null) return notFound(res);
			sendImage(res, bytes);
			return true;
		}
		return notFound(res);
	}

	async function handleCreate(res, req, access) {
		if (!guardMutation(res, req, access, "feedback")) return true;
		let body;
		try {
			body = await readJsonBody(req, bodyLimit);
		} catch (error) {
			if (error && error.code === "too_long") return fail(res, 413, { error: "too_long" });
			if (error && error.code === "bad_input") return fail(res, 400, { error: "bad_input" });
			log(`report create body failed: ${error && error.stack ? error.stack : error}`);
			return fail(res, 500, { error: "internal" });
		}

		const checked = validateCreate(body);
		if (!checked.ok) return fail(res, 400, { error: "bad_input", fields: checked.fields });

		let report = redactReport(checked.value);
		if (report.source !== null) {
			report = { ...report, source: { ...report.source, product: productOf(report.source) } };
		}
		const png = checked.png;
		const pngSha = png == null ? null : sha256(png);
		const imageMeta = report.image == null
			? null
			: { width: report.image.width, height: report.image.height, provenance: report.image.provenance };
		let result;
		try {
			result = store.create({
				id: report.reportId,
				fingerprint: fingerprint(report, pngSha),
				report,
				png,
				imageMeta,
			});
		} catch (error) {
			if (error && error.code === "key_reused") return fail(res, 409, { error: "key_reused" });
			log(`report create failed: ${error && error.stack ? error.stack : error}`);
			return fail(res, 500, { error: "internal" });
		}

		const state = rowState(result.record.delivery.state);
		if (result.created) {
			publisher.kick(report.reportId);
			return fail(res, 201, { ok: true, id: report.reportId, state, github: null });
		}
		return fail(res, 200, {
			ok: true,
			id: report.reportId,
			state,
			github: githubOf(result.record, statesNow()),
			replay: true,
		});
	}

	function handleRetry(res, id) {
		const record = store.get(id);
		if (record == null) return notFound(res);
		let ok;
		try {
			ok = publisher.retry(id);
		} catch (error) {
			log(`report retry failed: ${error && error.stack ? error.stack : error}`);
			return fail(res, 500, { error: "internal" });
		}
		if (!ok) return fail(res, 409, { error: "not_failed" });
		return fail(res, 200, { ok: true, state: "pending" });
	}

	async function handleHandoff(res, id) {
		const record = store.get(id);
		if (record == null) return notFound(res);
		if (record.delivery?.state !== "sent") return fail(res, 409, { error: "not_sent" });
		let result;
		try {
			result = await handoff({ record });
		} catch (error) {
			log(`report handoff failed: ${error && error.stack ? error.stack : error}`);
			return fail(res, 500, { error: "internal" });
		}
		if (!result || result.ok !== true) {
			const code = result?.error;
			if (code === "cwd_missing") return fail(res, 409, { error: "cwd_missing" });
			if (code === "no_launcher") return fail(res, 503, { error: "no_launcher" });
			if (code === "launch_failed") return fail(res, 502, { error: "launch_failed" });
			log(`report handoff refused: ${code ?? "unknown"}`);
			return fail(res, 500, { error: "internal" });
		}
		store.update(id, { handoff: { at: now().toISOString(), session: result.session, via: result.via } });
		return fail(res, 200, { ok: true, via: result.via, session: result.session });
	}

	async function handlePost(res, req, parts, access) {
		if (!(parts.length >= 3 && parts[1] === "api" && parts[2] === "reports")) return false;
		if (parts.length === 3) return handleCreate(res, req, access);
		if (parts.length === 4) return notFound(res);
		if (parts.length === 5) {
			if (!validId(parts)) return notFound(res);
			if (parts[4] === "retry") {
				if (!guardMutation(res, req, access, "feedback")) return true;
				return handleRetry(res, parts[3]);
			}
			if (parts[4] === "handoff") {
				if (!guardMutation(res, req, access, "reopen")) return true;
				return handleHandoff(res, parts[3]);
			}
		}
		return notFound(res);
	}

	return { handleGet, handlePost };
}
