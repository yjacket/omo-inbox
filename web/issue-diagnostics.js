/* Bounded, allowlisted operational diagnostics for issue reports.
 *
 * Memory-only ring buffer keyed by an injected monotonic clock. Callers name application actions
 * and classify completed requests explicitly; the only global hooks here are error and
 * unhandledrejection listeners that observe without suppressing browser handling. Raw messages,
 * stacks, rejection reasons, URLs with query/hash and form data are never read into the buffer:
 * entries carry only the tagged fields allowed by src/issues-contract.mjs.
 */

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 30000;
const MAX_STATUS = 599;
const MAX_DURATION_MS = 600000;

// Fixed vocabulary copied verbatim from src/issues-contract.mjs (a browser module imports nothing).
// test/issues-diagnostics.test.mjs asserts deep equality with the contract exports.
export const ACTIONS = Object.freeze([
	"open_report", "pick_target", "open_review", "open_viewer", "close_viewer",
	"change_revision", "select_thread", "toggle_original", "toggle_progress",
	"answer", "ack", "approve", "request_change", "hide_thread", "reopen_session",
	"send_reply", "issue_submit", "issue_comment", "issue_confirm", "issue_reopen",
]);
export const ROUTES = Object.freeze([
	"threads_list", "thread_detail", "thread_episode", "item_answer", "thread_message",
	"thread_reopen", "proposals_list", "proposal_detail", "proposal_feedback",
	"issue_capabilities", "issue_create", "issue_detail", "issue_command",
	"issue_feedback", "other",
]);
export const ERROR_CODES = Object.freeze([
	"bad_input", "forbidden", "not_found", "closed", "too_long", "bad_rev",
	"duplicate", "key_reused", "version_conflict", "store_changed",
	"invalid_transition", "corrupt_record", "network", "aborted", "other",
]);
export const ERROR_CLASSES = Object.freeze([
	"Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
	"URIError", "EvalError", "DOMException", "ResourceError",
	"UnhandledRejection", "other",
]);
export const SCRIPT_NAMES = Object.freeze([
	"board.js", "thread.js", "sw.js", "issues.js", "issue-context.js",
	"issue-adapters.js", "issue-drafts.js", "issue-report.js",
	"inbox-inline", "boards-inline", "other",
]);

const ACTION_SET = new Set(ACTIONS);
const ROUTE_SET = new Set(ROUTES);
const CODE_SET = new Set(ERROR_CODES);
const CLASS_SET = new Set(ERROR_CLASSES);
const SCRIPT_SET = new Set(SCRIPT_NAMES);

function positiveSetting(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function chosen(value, allowed, fallback) {
	return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function integerIn(value, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return min;
	const rounded = Math.trunc(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function durationIn(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return value > MAX_DURATION_MS ? MAX_DURATION_MS : value;
}

/** Last path segment without query/hash; the full source string is never retained. */
function servedBasename(file) {
	if (typeof file !== "string") return "";
	const withoutQuery = file.split(/[?#]/, 1)[0];
	const slash = Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf("\\"));
	return withoutQuery.slice(slash + 1);
}

function errorClassName(error) {
	const name = error && error.constructor ? error.constructor.name : "";
	return typeof name === "string" && name.length > 0 ? name : "Error";
}

export function createDiagnostics({ now, limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS } = {}) {
	if (typeof now !== "function") throw new TypeError("createDiagnostics needs an injected now() function");
	// The envelope contract caps both quantities; a caller cannot widen them past it.
	const capacity = Math.min(positiveSetting(limit, DEFAULT_LIMIT), DEFAULT_LIMIT);
	const window = Math.min(positiveSetting(windowMs, DEFAULT_WINDOW_MS), DEFAULT_WINDOW_MS);
	const events = [];

	function add(entry) {
		const at = now();
		if (typeof at !== "number" || !Number.isFinite(at)) return;
		events.push({ at, entry });
		if (events.length > capacity) events.splice(0, events.length - capacity);
	}

	function recordAction(name) {
		// The contract's ACTIONS enum has no catch-all, so an unknown action is dropped rather
		// than retained under a token validateCreate would reject.
		if (typeof name === "string" && ACTION_SET.has(name)) add({ type: "action", name });
	}

	function recordRequest({ route, status, durationMs, errorCode } = {}) {
		const code = errorCode === null || errorCode === undefined ? null : chosen(errorCode, CODE_SET, "other");
		add({
			type: "request",
			route: chosen(route, ROUTE_SET, "other"),
			status: integerIn(status, 0, MAX_STATUS),
			durationMs: durationIn(durationMs),
			errorCode: code,
		});
	}

	function recordScript({ file, line, column, errorClass } = {}) {
		const basename = servedBasename(file);
		add({
			type: "script",
			file: SCRIPT_SET.has(basename) ? basename : "other",
			line: integerIn(line, 0, Number.MAX_SAFE_INTEGER),
			column: integerIn(column, 0, Number.MAX_SAFE_INTEGER),
			errorClass: chosen(errorClass, CLASS_SET, "other"),
		});
	}

	/** Newest entries inside (atMs - windowMs, atMs], relative to atMs, capped at the limit. */
	function snapshot(atMs = now()) {
		const at = typeof atMs === "number" && Number.isFinite(atMs) ? atMs : now();
		const oldest = at - window;
		const inside = [];
		for (const event of events) {
			if (event.at > at || event.at < oldest) continue;
			inside.push(event);
		}
		inside.sort((left, right) => left.at - right.at);
		if (inside.length > capacity) inside.splice(0, inside.length - capacity);
		return inside.map(({ at: eventAt, entry }) => ({ ...entry, atMs: eventAt - at }));
	}

	/** Observe errors without suppressing default handling; messages, stacks and reasons stay unread. */
	function attachWindowListeners(target) {
		if (!target || typeof target.addEventListener !== "function") throw new TypeError("attachWindowListeners needs an event target");
		const onError = (event) => {
			const filename = event && typeof event.filename === "string" ? event.filename : "";
			const isResourceError = Boolean(event && event.target && event.target !== target && filename.length === 0);
			if (isResourceError) {
				recordScript({ file: "", line: 0, column: 0, errorClass: "ResourceError" });
			} else {
				recordScript({
					file: filename,
					line: event ? event.lineno : 0,
					column: event ? event.colno : 0,
					errorClass: errorClassName(event ? event.error : null),
				});
			}
		};
		const onRejection = () => {
			recordScript({ file: "", line: 0, column: 0, errorClass: "UnhandledRejection" });
		};
		target.addEventListener("error", onError);
		target.addEventListener("unhandledrejection", onRejection);
		return () => {
			target.removeEventListener("error", onError);
			target.removeEventListener("unhandledrejection", onRejection);
		};
	}

	return { recordAction, recordRequest, recordScript, attachWindowListeners, snapshot };
}
