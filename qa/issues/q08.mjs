/* Q08: bounded issue diagnostics in a real browser.
 *
 * Imports web/issue-diagnostics.js into the page, records one named action, a real failed
 * same-origin request, and synthetic error/unhandledrejection events whose text and URLs carry
 * tokens. The snapshot and a frozen capture that embeds it must contain only permitted tokens,
 * codes and locations. The failure probe throws and rejects with real token-bearing errors and
 * proves the browser still handles those events while the retained envelope stays clean.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEADLINE_MS = 10_000;
const FORBIDDEN = ["sk-SECRETTOKEN", "token=abc", "?token", "example.invalid"];

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function clean(serialized) {
	return FORBIDDEN.filter((needle) => serialized.includes(needle));
}

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q08_new_page");
	const actions = [];
	const act = (step, detail, signal) => actions.push({ step, detail, signal });
	try {
		await withDeadline(page.goto(ctx.base + "/", { waitUntil: "load" }), DEADLINE_MS, "q08_goto");
		act("navigate", ctx.base + "/", "page.goto(waitUntil=load) resolved within 10000ms");

		const observed = await withDeadline(
			page.evaluate(`(async () => {
				const mod = await import('/web/issue-diagnostics.js');
				let clock = 1000;
				const diagnostics = mod.createDiagnostics({ now: () => clock });
				diagnostics.attachWindowListeners(window);

				clock = 1500;
				diagnostics.recordAction('open_report');
				diagnostics.recordAction('not_a_contract_action');

				const response = await fetch('/api/issues/00000000-0000-4000-8000-000000000000?token=abc', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
				clock = 2600;
				diagnostics.recordRequest({ route: 'issue_detail', status: response.status, durationMs: 37.5, errorCode: 'not_found' });

				clock = 3000;
				const errorEvent = new ErrorEvent('error', {
					message: 'sk-SECRETTOKEN https://example.invalid/q?token=abc',
					filename: location.origin + '/web/board.js?token=abc',
					lineno: 12,
					colno: 34,
					error: new TypeError('sk-SECRETTOKEN'),
				});
				Object.defineProperty(errorEvent, 'message', { get() { throw new Error('diagnostics read the error message'); } });
				const errorHandledNormally = window.dispatchEvent(errorEvent);
				clock = 3100;
				const rejectionEvent = new Event('unhandledrejection');
				Object.defineProperty(rejectionEvent, 'reason', { get() { throw new Error('diagnostics read the rejection reason'); } });
				const rejectionHandledNormally = window.dispatchEvent(rejectionEvent);

				clock = 4000;
				const snapshot = diagnostics.snapshot(4000);
				const capture = Object.freeze({
					page: 'inbox',
					contextStatus: 'captured',
					view: Object.freeze({ width: innerWidth, height: innerHeight, theme: 'light' }),
					diagnostics: Object.freeze(snapshot.map((entry) => Object.freeze({ ...entry }))),
				});
				return {
					status: response.status,
					snapshot,
					errorHandledNormally,
					rejectionHandledNormally,
					errorDefaultPrevented: errorEvent.defaultPrevented,
					rejectionDefaultPrevented: rejectionEvent.defaultPrevented,
					serializedSnapshot: JSON.stringify(snapshot),
					serializedCapture: JSON.stringify(capture),
				};
			})()`),
			DEADLINE_MS,
			"q08_observe",
		);
		act("record-action", "recordAction(open_report); recordAction(not_a_contract_action)", "named action recorded, unknown token dropped");
		act("failed-request", "fetch /api/issues/00000000-0000-4000-8000-000000000000?token=abc", `HTTP ${observed.status}; snapshot records only the route template`);
		act("synthetic-error", "dispatch ErrorEvent with token message and board.js?token=abc", `dispatch returned ${observed.errorHandledNormally}, defaultPrevented=${observed.errorDefaultPrevented}`);
		act("synthetic-rejection", "dispatch unhandledrejection with throwing reason getter", `dispatch returned ${observed.rejectionHandledNormally}, defaultPrevented=${observed.rejectionDefaultPrevented}`);
		act("snapshot", "snapshot(4000)", `${observed.snapshot.length} bounded entries`);

		check("Q08 named click is retained as the allowlisted action", observed.snapshot.some((entry) => entry.type === "action" && entry.name === "open_report"), JSON.stringify(observed.snapshot.filter((entry) => entry.type === "action")));
		check("Q08 failed same-origin request is recorded as a route template", observed.status === 404 && observed.snapshot.some((entry) => entry.type === "request" && entry.route === "issue_detail" && entry.status === 404 && entry.errorCode === "not_found"), JSON.stringify(observed.snapshot.filter((entry) => entry.type === "request")));
		check("Q08 synthetic error records only board.js location and class", observed.snapshot.some((entry) => entry.type === "script" && entry.file === "board.js" && entry.line === 12 && entry.column === 34 && entry.errorClass === "TypeError"), JSON.stringify(observed.snapshot.filter((entry) => entry.type === "script")));
		check("Q08 synthetic rejection records only the UnhandledRejection class", observed.snapshot.some((entry) => entry.type === "script" && entry.errorClass === "UnhandledRejection"), JSON.stringify(observed.snapshot.filter((entry) => entry.type === "script")));
		check("Q08 error and rejection listeners do not suppress default handling", observed.errorHandledNormally === true && observed.rejectionHandledNormally === true && observed.errorDefaultPrevented === false && observed.rejectionDefaultPrevented === false, JSON.stringify({ errorHandledNormally: observed.errorHandledNormally, rejectionHandledNormally: observed.rejectionHandledNormally, errorDefaultPrevented: observed.errorDefaultPrevented, rejectionDefaultPrevented: observed.rejectionDefaultPrevented }));

		const allowedKeys = {
			action: ["atMs", "name", "type"],
			request: ["atMs", "durationMs", "errorCode", "route", "status", "type"],
			script: ["atMs", "column", "errorClass", "file", "line", "type"],
		};
		const keysOk = observed.snapshot.every((entry) => {
			const expected = allowedKeys[entry.type];
			if (!expected) return false;
			return Object.keys(entry).sort().join(",") === expected.join(",");
		});
		const bounded = observed.snapshot.every((entry) => Number.isFinite(entry.atMs) && entry.atMs <= 0 && entry.atMs >= -30000);
		check("Q08 snapshot entries carry only permitted tagged fields", keysOk, JSON.stringify(observed.snapshot));
		check("Q08 snapshot atMs lies in [-30000,0]", bounded && observed.snapshot.length > 0, JSON.stringify(observed.snapshot.map((entry) => entry.atMs)));

		const snapshotLeaks = clean(observed.serializedSnapshot);
		const captureLeaks = clean(observed.serializedCapture);
		check("Q08 serialized snapshot contains none of the synthetic token bytes", snapshotLeaks.length === 0, JSON.stringify(snapshotLeaks));
		check("Q08 frozen capture embedding the snapshot contains none of the token bytes", captureLeaks.length === 0, JSON.stringify(captureLeaks));

		evidence("Q08-diagnostics.json", JSON.stringify({ ...observed, snapshotLeaks, captureLeaks }, null, "\t"));
	} finally {
		evidence("Q08-actions.json", JSON.stringify(actions, null, "\t"));
		await withDeadline(page.close(), DEADLINE_MS, "q08_page_close").catch(() => page.dispose?.());
	}
}

export async function runFailureProbe({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q08_failure_new_page");
	const actions = [];
	try {
		await withDeadline(page.goto(ctx.base + "/", { waitUntil: "load" }), DEADLINE_MS, "q08_failure_goto");
		actions.push({ step: "navigate", detail: ctx.base + "/", signal: "page.goto(waitUntil=load) resolved within 10000ms" });
		const observed = await withDeadline(
			page.evaluate(`(async () => {
				const mod = await import('/web/issue-diagnostics.js');
				let clock = 0;
				const diagnostics = mod.createDiagnostics({ now: () => clock });
				diagnostics.attachWindowListeners(window);
				const seen = { error: false, rejection: false, errorPrevented: null, rejectionPrevented: null };
				const waitFor = (type, key) => new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error('q08 failure ' + type + ' deadline')), 10000);
					window.addEventListener(type, (event) => {
						seen[key] = true;
						seen[key === 'error' ? 'errorPrevented' : 'rejectionPrevented'] = event.defaultPrevented;
						clearTimeout(timer);
						resolve();
					}, { once: true });
				});
				const errorSeen = waitFor('error', 'error');
				const rejectionSeen = waitFor('unhandledrejection', 'rejection');
				window.setTimeout(() => { throw new Error('sk-SECRETTOKEN https://example.invalid/q?token=abc'); }, 0);
				Promise.reject(new Error('sk-SECRETTOKEN https://example.invalid/r?token=abc'));
				await Promise.all([errorSeen, rejectionSeen]);
				clock = 1;
				const snapshot = diagnostics.snapshot(1);
				const envelope = Object.freeze({
					v: 1,
					description: 'failure probe report',
					evidence: Object.freeze({
						page: 'inbox',
						contextStatus: 'captured',
						diagnostics: Object.freeze(snapshot.map((entry) => Object.freeze({ ...entry }))),
					}),
				});
				return { seen, snapshot, serialized: JSON.stringify(envelope) };
			})()`),
			DEADLINE_MS,
			"q08_failure_observe",
		);
		actions.push({ step: "throw-and-reject", detail: "setTimeout throw + Promise.reject carrying sk-SECRETTOKEN and ?token=abc", signal: `error=${observed.seen.error} rejection=${observed.seen.rejection}` });
		actions.push({ step: "retain-envelope", detail: "frozen create-shaped envelope embedding the snapshot", signal: `${observed.snapshot.length} diagnostic entries` });

		check("Q08 failure probe observed the real error event", observed.seen.error === true, JSON.stringify(observed.seen));
		check("Q08 failure probe observed the real unhandled rejection", observed.seen.rejection === true, JSON.stringify(observed.seen));
		check("Q08 failure probe did not suppress default browser handling", observed.seen.errorPrevented === false && observed.seen.rejectionPrevented === false, JSON.stringify(observed.seen));
		const leaks = clean(observed.serialized);
		check("Q08 failure probe retained envelope contains no token or URL-query bytes", leaks.length === 0, JSON.stringify(leaks));
		evidence("Q08-failure.json", JSON.stringify({ ...observed, leaks }, null, "\t"));
	} finally {
		evidence("Q08-failure-actions.json", JSON.stringify(actions, null, "\t"));
		await withDeadline(page.close(), DEADLINE_MS, "q08_failure_page_close").catch(() => page.dispose?.());
	}
}
