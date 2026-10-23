/* Q06: open the seeded Inbox on a phone viewport, wait for the page's own /api/threads response
 * (subscribed before navigation), check the seeded row is visible inside the viewport, and save
 * the screenshot plus the ordered action log. Every scenario await is bounded with a named 10 s
 * deadline so a stalled load rejects instead of hanging. runFailureProbe proves a FAIL is recorded
 * and records navigation truthfully: "aborted" only when the navigation really did not settle.
 */
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { threads } from "./fixture-data.mjs";

const DEADLINE_MS = 10_000;

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function loadOmowright() {
	const root = process.env.OMO_BROWSER_SKILL_ROOT || "C:/Users/yjack/.bun/install/global/node_modules/omo-ai/plugin/skills/browser";
	const module = await import(pathToFileURL(path.join(root, "scripts", "omowright.mjs")).href);
	return (await module.loadOmowright()).omowright;
}

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const { createNetworkSnoop } = await loadOmowright();
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q06_new_page");
	const actions = [];
	try {
		const snoop = createNetworkSnoop(page, { match: { url: "/api/threads" }, bodies: true });
		const listResponse = withDeadline(
			snoop.waitFor({ url: /\/api\/threads(\?|$)/ }, { timeoutMs: DEADLINE_MS }),
			DEADLINE_MS,
			"q06_api_threads_response",
		);
		actions.push({ step: "subscribe", detail: "network snoop waits for /api/threads", signal: "snoop.waitFor armed before navigation" });
		try {
			await withDeadline(page.goto(ctx.base + "/", { waitUntil: "load" }), DEADLINE_MS, "q06_goto");
			actions.push({ step: "navigate", detail: ctx.base + "/", signal: "page.goto(waitUntil=load) resolved within 10000ms" });
			const response = await listResponse;
			actions.push({ step: "list-response", detail: "/api/threads", signal: `snoop.waitFor resolved status=${response.status}` });
			check("Q06 inbox loaded its own /api/threads response", response.status === 200, `status=${response.status} url=${response.url}`);

			const measured = await withDeadline(
				page.evaluate(`(() => {
				const el = document.querySelector('#list .row[data-session="qa-issue-a"]');
				if (!el) return { found: false };
				el.scrollIntoView({ block: "center" });
				const r = el.getBoundingClientRect();
				return {
					found: true,
					text: (el.textContent || "").replace(/\\s+/g, " ").trim(),
					rect: { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
					viewport: { width: innerWidth, height: innerHeight },
				};
			})()`),
				DEADLINE_MS,
				"q06_measure_row",
			);
			actions.push({ step: "measure-row", detail: "qa-issue-a after scrollIntoView", signal: "page.evaluate resolved within 10000ms" });
			const inside =
				measured.found === true &&
				measured.rect.width > 0 &&
				measured.rect.height > 0 &&
				measured.rect.x >= 0 &&
				measured.rect.y >= 0 &&
				measured.rect.right <= measured.viewport.width + 0.5 &&
				measured.rect.bottom <= measured.viewport.height + 0.5;
			check("Q06 row data-session=qa-issue-a exists", measured.found === true, JSON.stringify(measured.rect ?? null));
			check("Q06 row lies inside the viewport", inside, JSON.stringify({ rect: measured.rect, viewport: measured.viewport }));
			check("Q06 row text contains the seeded title", typeof measured.text === "string" && measured.text.includes(threads.a.title), measured.text);

			const shot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q06_screenshot");
			const shotPath = evidence("Q06-inbox.png", Buffer.from(shot));
			actions.push({ step: "screenshot", detail: shotPath, signal: "page.screenshot resolved within 10000ms" });
			check("Q06 screenshot saved", fs.existsSync(shotPath) && fs.statSync(shotPath).size > 0, shotPath);
		} finally {
			snoop.dispose();
			evidence("Q06-actions.json", JSON.stringify(actions, null, "\t"));
		}
	} finally {
		await withDeadline(page.close(), DEADLINE_MS, "q06_page_close").catch(() => page.dispose?.());
	}
}

export async function runFailureProbe({ browser, ctx, width = 390, height = 844, scheme = "light", check, evidence }) {
	const { newQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q06_failure_new_page");
	const observed = { checks: [], navigation: null, closedEarly: false };
	try {
		await withDeadline(page.goto(ctx.base + "/", { waitUntil: "load" }), DEADLINE_MS, "q06_failure_initial_goto");
		const present = await withDeadline(
			page.evaluate(`Boolean(document.querySelector('#list .row[data-session="qa-issue-missing"]'))`),
			DEADLINE_MS,
			"q06_failure_missing_row",
		);
		check('Q06 failure probe: row "qa-issue-missing" exists', present === true, `present=${present}`);
		observed.checks.push({ name: "missing row exists", ok: present === true });
		evidence("Q06-failure.json", JSON.stringify(observed, null, "\t"));

		// Raw goto: the page is closed before the navigation settles, so do not run the viewport
		// re-pin that page.goto normally applies after a completed navigation.
		let navigationError = null;
		const navigation = page.qaGoto(ctx.base + "/boards", { waitUntil: "commit" }).then(
			() => ({ settled: true, error: null }),
			(error) => {
				navigationError = error && error.message ? error.message : String(error);
				return { settled: false, error: navigationError };
			},
		);
		observed.closedEarly = true;
		await withDeadline(page.close(), DEADLINE_MS, "q06_failure_page_close").catch(() => {});
		let outcome;
		try {
			outcome = await withDeadline(navigation, DEADLINE_MS, "q06_failure_navigation");
		} catch (error) {
			outcome = { settled: false, error: error && error.message ? error.message : String(error), deadline: error && error.name ? error.name : "unknown" };
		}
		// Truthful record: "aborted" only when the navigation promise rejected (it did not settle);
		// "settled" when goto completed; "pending" when it survived every deadline.
		let state;
		if (outcome.settled) state = "settled";
		else if (outcome.deadline) state = "pending";
		else state = "aborted";
		observed.navigation = {
			url: ctx.base + "/boards",
			closedEarly: true,
			state,
			settled: outcome.settled === true,
			aborted: state === "aborted",
			outcome: state,
			error: navigationError ?? outcome.error ?? null,
		};
	} finally {
		evidence("Q06-failure.json", JSON.stringify(observed, null, "\t"));
		if (!page.closed) await withDeadline(page.close(), DEADLINE_MS, "q06_failure_final_close").catch(() => {});
	}
}
