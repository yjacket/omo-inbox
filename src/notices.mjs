// Notices (C10): any extension can publish a signal for the inbox without
// importing inbox code. A notice is a small validated payload that becomes an
// item of kind "notice" in its session thread (or the 알림 pseudo-thread).

export const NOTICE_VERSION = 1;
export const MAX_TITLE = 80;
export const MAX_BODY = 500;
export const URGENCIES = ["now", "soon", "fyi"];
export const NOTICE_ACTIONS = ["ack", "open-url"];

const PRODUCER = /^[a-z0-9-]{1,40}$/;
const DEDUPE_KEY = /^[A-Za-z0-9._:-]{1,80}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const TOP_KEYS = new Set(["v", "producer", "dedupeKey", "title", "body", "urgency", "session", "cwd", "expiresAt", "url", "actions"]);

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMs(now) {
	if (now instanceof Date) return now.getTime();
	return now;
}

function pushString(value, path, errors, { min = 0, max = Infinity } = {}) {
	if (typeof value !== "string") {
		errors.push(`${path}: must be a string`);
		return;
	}
	if (value.length < min) errors.push(`${path}: must be at least ${min} characters`);
	if (value.length > max) errors.push(`${path}: must be at most ${max} characters`);
}

function validateShape(body, errors) {
	if (body.v !== NOTICE_VERSION) errors.push(`v: must be ${NOTICE_VERSION}`);
	if (!PRODUCER.test(body.producer ?? "")) errors.push("producer: must match /^[a-z0-9-]{1,40}$/");
	if (!DEDUPE_KEY.test(body.dedupeKey ?? "")) errors.push("dedupeKey: must match /^[A-Za-z0-9._:-]{1,80}$/");
	pushString(body.title, "title", errors, { min: 1, max: MAX_TITLE });
	if (typeof body.title === "string" && body.title.length >= 1 && body.title.trim() === "") {
		errors.push("title: must not be blank");
	}
	pushString(body.body, "body", errors, { max: MAX_BODY });
	if (!URGENCIES.includes(body.urgency)) errors.push(`urgency: must be one of ${URGENCIES.join(", ")}`);
	if (body.session !== undefined) pushString(body.session, "session", errors, { min: 1 });
	if (body.cwd !== undefined) pushString(body.cwd, "cwd", errors, { min: 1 });
	if (body.expiresAt !== undefined) {
		if (typeof body.expiresAt !== "string") errors.push("expiresAt: must be a string");
		else if (!ISO_INSTANT.test(body.expiresAt) || Number.isNaN(Date.parse(body.expiresAt))) {
			errors.push("expiresAt: must be an ISO timestamp");
		}
	}
	if (body.url !== undefined) {
		if (typeof body.url !== "string") errors.push("url: must be a string");
		else if (body.url.startsWith("//") || (ABSOLUTE_URL.test(body.url) && !body.url.startsWith("https://"))) {
			errors.push("url: must be a relative path or an https URL");
		}
	}
	if (body.actions !== undefined) {
		if (!Array.isArray(body.actions)) errors.push("actions: must be an array");
		else {
			for (const [index, action] of body.actions.entries()) {
				if (!NOTICE_ACTIONS.includes(action)) errors.push(`actions[${index}]: must be one of ${NOTICE_ACTIONS.join(", ")}`);
			}
		}
	}
}

// Returns {ok: true, notice} with only known keys, or {ok: false, errors} with
// one "<path>: <message>" line per problem.
export function validateNotice(body) {
	if (!isPlainObject(body)) return { ok: false, errors: ["notice: must be a JSON object"] };
	const errors = [];
	for (const key of Object.keys(body)) {
		if (!TOP_KEYS.has(key)) errors.push(`${key}: unknown key`);
	}
	validateShape(body, errors);
	if (errors.length > 0) return { ok: false, errors };
	const notice = {};
	for (const key of ["v", "producer", "dedupeKey", "title", "body", "urgency", "session", "cwd", "expiresAt", "url", "actions"]) {
		if (body[key] !== undefined) notice[key] = body[key];
	}
	return { ok: true, notice };
}

// The threads.createItem input for a validated notice: an fyi notice never
// needs the user, anything else does. meta carries the expiry anchor the
// server uses to close the item on read.
export function noticeItemInput(notice, now) {
	const at = toMs(now);
	return {
		kind: "notice",
		policy: notice.urgency === "fyi" ? "fyi" : "needs-you",
		dedupeKey: `${notice.producer}:${notice.dedupeKey}`,
		raw: { notice: { ...notice } },
		meta: { createdAt: at, expiresAt: notice.expiresAt ?? null },
	};
}

// A notice is expired from its expiresAt instant onward; without one it never
// expires.
export function isExpired(notice, now) {
	if (!notice || notice.expiresAt === undefined || notice.expiresAt === null) return false;
	const end = Date.parse(notice.expiresAt);
	if (Number.isNaN(end)) return false;
	return end <= toMs(now);
}
