/* Q16: issue reporting in the standalone thread and through a parent-owned registry.
 *
 * Happy track (390x844 light): type 기존 답장 into #reply, open the per-message 제보 entry, send and
 * close; the reply text and focus remain, the issue names the displayed item and observation seq.
 * While the composer is open, a visibilitychange poll is injected and must be deferred (no DOM
 * replacement, no read mark) until close. Escape closes once, the same message entry reopens the
 * retained capture, and a second Escape cancels without sending. Then the original composer answer
 * goes through its own API: exactly one answer event and one mailbox record.
 *
 * Embedded track (720x900): a same-origin parent mounts the reporter and registry, an iframe to
 * /s/qa-issue-a registers its adapter through window.parent, and a click on the child's message
 * entry opens the parent dialog with the child source. A second iframe whose parent registry denies
 * registration falls back to /issues/new without sending anything. data/threads and the mailbox are
 * byte-identical across every report lifecycle. Every wait is an awaited DOM event or named 10 s
 * deadline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const viewport = { width: 390, height: 844, scheme: "light" };

const DEADLINE_MS = 10_000;
const REPLY = "기존 답장";
const DESCRIPTION = "답장을 쓰던 중 제보 버튼이 겹칩니다";

function qaRoot() {
	return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function hashTree(root) {
	const out = [];
	const walk = (dir) => {
		let names;
		try {
			names = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
			// Atomic writes stage a .tmp-<pid>-<random> next to the destination and rename it; the
			// staging name is never committed state, and reading it races the rename.
			if (entry.isFile() && /\.tmp-\d+-[0-9a-f]+$/i.test(entry.name)) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push({ file: path.relative(root, full).split(path.sep).join("/"), sha256: crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") });
		}
	};
	walk(root);
	return out;
}

function mailboxFiles(home) {
	const dir = path.join(home, "mailbox");
	try {
		return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join("/"))
			.sort();
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

function hashCode(root) {
	const files = {};
	for (const entry of hashTree(root)) files[entry.file] = entry.sha256;
	return files;
}

function waitForFile(root, baseline, timeoutMs = DEADLINE_MS) {
	return new Promise((resolve, reject) => {
		const exists = () => {
			try {
				return fs.readdirSync(path.join(root, "mailbox"), { recursive: true }).length;
			} catch {
				return 0;
			}
		};
		const now = exists();
		if (now > baseline) {
			resolve(now);
			return;
		}
		const watcher = fs.watch(root, () => {
			const count = exists();
			if (count > baseline) {
				clearTimeout(timer);
				watcher.close();
				resolve(count);
			}
		});
		watcher.on("error", (error) => {
			clearTimeout(timer);
			watcher.close();
			reject(error);
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`mailbox did not grow within ${timeoutMs}ms`));
		}, timeoutMs);
	});
}

function waitForDom(predicateSource, label) {
	return `new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(${JSON.stringify(label)} + ' did not appear within 9000ms')), 9000);
		let observer = null;
		const test = () => {
			let value = null;
			try { value = (${predicateSource})(); } catch { value = null; }
			if (!value) return false;
			clearTimeout(timer);
			if (observer) observer.disconnect();
			resolve(value);
			return true;
		};
		observer = new MutationObserver(() => test());
		observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
		test();
	})`;
}

// Event-driven wait for state that lives in an embedded same-origin thread. Parent-document
// mutations do not fire for child renders, so the child's contentDocument is observed too; the
// predicate wakes on either document and only resolves once the child condition itself is true.
function waitForEmbeddedDom(frameSelector, predicateSource, label) {
	return `new Promise((resolve, reject) => {
		const deadline = setTimeout(() => {
			cleanup();
			reject(new Error(${JSON.stringify(label)} + ' did not resolve within ${DEADLINE_MS}ms'));
		}, ${DEADLINE_MS});
		let parentObserver = null;
		let childObserver = null;
		let frame = null;
		let doc = null;
		const onLoad = (event) => {
			if (frame && event.target === frame) attach();
		};
		const cleanup = () => {
			clearTimeout(deadline);
			if (parentObserver) parentObserver.disconnect();
			if (childObserver) childObserver.disconnect();
			document.removeEventListener('load', onLoad, true);
		};
		const test = () => {
			let value = null;
			try { value = (${predicateSource})(); } catch { value = null; }
			if (!value) return false;
			cleanup();
			resolve(value);
			return true;
		};
		const attach = () => {
			if (childObserver) { childObserver.disconnect(); childObserver = null; }
			const next = document.querySelector(${JSON.stringify(frameSelector)});
			frame = next;
			doc = next && next.contentDocument;
			if (doc && doc.documentElement) {
				childObserver = new MutationObserver(() => test());
				childObserver.observe(doc.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
			}
			test();
		};
		parentObserver = new MutationObserver(() => {
			const next = document.querySelector(${JSON.stringify(frameSelector)});
			if (next !== frame || (next && next.contentDocument !== doc)) {
				attach();
				return;
			}
			test();
		});
		parentObserver.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
		document.addEventListener('load', onLoad, true);
		attach();
	})`;
}

const THREAD_STATE = `(() => {
	const dialog = document.querySelector('#issue-report');
	const reply = document.querySelector('#reply');
	const attach = document.querySelector('#issue-attach-list');
	const active = document.activeElement;
	const sourceRow = document.querySelector('#issue-attach-list [data-item="source"]');
	return {
		url: location.pathname,
		reply: reply ? reply.value : null,
		replySelection: reply ? [reply.selectionStart, reply.selectionEnd] : null,
		dialogOpen: Boolean(dialog && dialog.open),
		modal: dialog ? dialog.matches(':modal') : false,
		status: document.querySelector('#issue-status')?.textContent ?? '',
		chip: document.querySelector('#issue-target-label')?.textContent ?? '',
		attachHidden: attach ? attach.hidden : null,
		sourceValue: sourceRow ? sourceRow.textContent : null,
		sourceDetail: sourceRow ? sourceRow.parentElement.querySelector('.issue-report__attach-detail')?.textContent ?? null : null,
		termOpen: Boolean(document.querySelector('.term-pop')),
		headline: document.querySelector('.headline')?.textContent ?? null,
		controls: [...document.querySelectorAll('.tool, [data-action="report"]')].map((node) => {
			const box = node.getBoundingClientRect();
			return { text: (node.textContent || '').trim(), width: box.width, height: box.height };
		}),
		items: [...document.querySelectorAll('.group[data-item]')].map((group) => group.getAttribute('data-item')),
		itemCount: document.querySelectorAll('.group[data-item]').length,
		reportEntries: document.querySelectorAll('[data-action="report"]').length,
		pageEntry: Boolean(document.querySelector('[data-issue-report]')),
		issuesLink: document.querySelector('a[href="/issues"]')?.textContent ?? null,
		registry: (() => {
			try {
				const registry = window.__inboxIssueAdapters;
				const current = registry && registry.current();
				return current ? { page: current.page, frame: current.frame } : null;
			} catch { return null; }
		})(),
		badge: document.querySelector('#issuesBadge') ? { hidden: document.querySelector('#issuesBadge').hidden, text: document.querySelector('#issuesBadge').textContent } : null,
		active: active ? { tag: active.tagName, id: active.id, action: active.getAttribute('data-action'), item: active.getAttribute('data-report-item'), insideDialog: dialog ? dialog.contains(active) : false } : null,
		overflow: document.documentElement.scrollWidth > innerWidth,
	};
})()`;

// The REAL Inbox page is the parent: its registry and its reporter are the ones this frame shares.
const REAL_EMBED_STATE = `(() => {
	const frame = document.querySelector('iframe.thread');
	const doc = frame && frame.contentDocument;
	const dialog = doc ? doc.querySelector('#issue-report') : null;
	const sourceRow = doc ? doc.querySelector('#issue-attach-list [data-item="source"]') : null;
	const parentDialog = document.querySelector('#issue-report');
	return {
		current: window.__inboxIssueAdapters ? window.__inboxIssueAdapters.current() : null,
		parentUrl: location.pathname,
		parentDialogOpen: Boolean(parentDialog && parentDialog.open),
		frameSrc: frame ? frame.getAttribute('src') : null,
		childReady: Boolean(doc && doc.querySelector('[data-action="report"]')),
		dialogOpen: Boolean(dialog && dialog.open),
		source: sourceRow ? sourceRow.textContent : null,
		sourceDetail: sourceRow ? sourceRow.parentElement.querySelector('.issue-report__attach-detail')?.textContent ?? null : null,
		chip: doc ? doc.querySelector('#issue-target-label')?.textContent ?? '' : '',
		status: doc ? doc.querySelector('#issue-status')?.textContent ?? '' : '',
		childReply: doc ? doc.querySelector('#reply')?.value ?? null : null,
		childTerm: doc ? Boolean(doc.querySelector('.term-pop')) : null,
		childItemIds: doc ? [...doc.querySelectorAll('.group[data-item]')].map((group) => group.getAttribute('data-item')) : [],
		childControls: doc ? [...doc.querySelectorAll('.tool, [data-action="report"]')].map((node) => {
			const box = node.getBoundingClientRect();
			return { text: (node.textContent || '').trim(), width: box.width, height: box.height };
		}) : [],
		overflow: document.documentElement.scrollWidth > innerWidth,
	};
})()`;

function keys(name) {
	const map = {
		Escape: { key: "Escape", code: "Escape", vk: 27 },
		Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	};
	return map[name];
}

async function pressKey(page, sessionId, name) {
	const spec = keys(name);
	if (!spec) throw new Error(`unknown key ${name}`);
	const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
	await page.cdp.send("Input.dispatchKeyEvent", { type: spec.text ? "keyDown" : "rawKeyDown", ...base, ...(spec.text ? { text: spec.text } : {}) }, sessionId);
	await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
}

function armStatus(text) {
	return `(() => {
		const node = document.querySelector('#issue-status');
		window.__q16status = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('status did not become ${text}')), 9000);
			if (node.textContent === ${JSON.stringify(text)}) { clearTimeout(timer); resolve(node.textContent); return; }
			const observer = new MutationObserver(() => {
				if (node.textContent === ${JSON.stringify(text)}) { clearTimeout(timer); observer.disconnect(); resolve(node.textContent); }
			});
			observer.observe(node, { childList: true, characterData: true, subtree: true });
		});
		window.__q16status.catch(() => {});
		return true;
	})()`;
}

function armClose() {
	return `(() => {
		const dialog = document.querySelector('#issue-report');
		window.__q16close = new Promise((resolve, reject) => {
			if (!dialog.open) { resolve('already-closed'); return; }
			const timer = setTimeout(() => reject(new Error('dialog did not close')), 9000);
			dialog.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); }, { once: true });
		});
		window.__q16close.catch(() => {});
		window.__q16focus = new Promise((resolve) => {
			const onFocus = (event) => {
				clearTimeout(timer);
				document.removeEventListener('focusin', onFocus, true);
				resolve({ action: event.target.getAttribute && event.target.getAttribute('data-action'), item: event.target.getAttribute && event.target.getAttribute('data-report-item'), id: event.target.id || null });
			};
			const timer = setTimeout(() => { document.removeEventListener('focusin', onFocus, true); resolve(null); }, 4000);
			document.addEventListener('focusin', onFocus, true);
		});
		window.__q16focus.catch(() => {});
		return true;
	})()`;
}

async function armPoll(page) {
	await page.evaluate(`(() => {
		window.__q16poll = new Promise((resolve, reject) => {
			const real = window.fetch;
			const timer = setTimeout(() => { window.fetch = real; reject(new Error('thread poll did not run')); }, 9000);
			window.fetch = (input, init) => {
				const url = typeof input === 'string' ? input : input.url;
				const pending = real(input, init);
				if (String(url).includes('/api/threads/')) pending.then(() => { clearTimeout(timer); window.fetch = real; resolve('polled'); }, () => {});
				return pending;
			};
			document.dispatchEvent(new Event('visibilitychange'));
		});
		window.__q16poll.catch(() => {});
		return true;
	})()`);
}

function sameJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

export default async function run({ browser, ctx, width, height, scheme = "light", check, evidence }) {
	const { newQaPage, pinQaPage, withDeadline } = await import(pathToFileURL(path.join(qaRoot(), "issues-fixture.mjs")).href);
	const actions = [];
	const http = [];
	const record = { viewport: { width, height, scheme }, steps: {} };
	const act = (step, detail, signal) => actions.push({ step, detail: detail === undefined ? null : detail, signal: signal === undefined ? null : signal });
	const page = await withDeadline(newQaPage(browser, { width, height, scheme }), DEADLINE_MS, "q16_page");
	const stateEval = (name) => withDeadline(page.evaluate(THREAD_STATE), DEADLINE_MS, name);
	const attachSource = async (name) => {
		await withDeadline(page.click("#issue-attach-toggle"), DEADLINE_MS, name);
		return withDeadline(page.evaluate("(() => { const row = document.querySelector('#issue-attach-list [data-item=\"source\"]'); return row ? { value: row.textContent, detail: row.parentElement.querySelector('.issue-report__attach-detail')?.textContent ?? null } : null; })()"), DEADLINE_MS, name + "_read");
	};
	let sessionId = null;
	let embeddedPage = null;
	const dataThreads = path.join(ctx.home, "data", "threads");
	const dataProposals = path.join(ctx.home, "data", "proposals");
	const mailboxDir = path.join(ctx.home, "mailbox");
	try {
		const seededThread = await withDeadline(ctx.get("/api/threads/" + encodeURIComponent(ctx.fixtures.threads.a)), DEADLINE_MS, "q16_thread_seed");
		http.push({ side: "node", label: "thread-seed", status: seededThread.status, body: seededThread.json });
		const itemId = seededThread.items[0].id;
		// A visible term gives the term-state track something the reporter must leave alone.
		const summarySeed = { kind: "report", headline: "추가조사 표시", context: "확인", body: "본문", ask: null, options: [], ifNoAnswer: null, terms: [{ term: "추가조사 표시", meaning: "더 살펴볼 항목" }], title: null };
		const summaryPost = await withDeadline(ctx.post(`/api/items/${encodeURIComponent(itemId)}/summary`, { text: JSON.stringify(summarySeed), model: "qa/stub" }), DEADLINE_MS, "q16_summary_seed");
		http.push({ side: "node", label: "summary-seed", status: summaryPost.status });
		const thread = await withDeadline(ctx.get("/api/threads/" + encodeURIComponent(ctx.fixtures.threads.a)), DEADLINE_MS, "q16_thread_seed_after_summary");
		const observedSeq = thread.events.at(-1).seq;
		record.seed = { threadId: ctx.fixtures.threads.a, itemId, observedSeq, summaryPost: summaryPost.status };
		await withDeadline(page.goto(ctx.base + "/s/" + encodeURIComponent(ctx.fixtures.threads.a), { waitUntil: "load" }), DEADLINE_MS, "q16_goto_thread");
		act("navigate", "/s/qa-issue-a", "page.goto(load) resolved");
		sessionId = await page.resolveSessionId();
		await withDeadline(page.evaluate(waitForDom(`() => document.querySelector('.group[data-item]') && document.querySelector('[data-action="report"]') && document.querySelector('.term') ? true : null`, "q16_items")), DEADLINE_MS, "q16_items");
		const initial = await stateEval("q16_initial");
		record.steps.initial = initial;
		check("Q16 the thread offers 제보함, the 제보 entry and one message entry per bubble", initial.pageEntry === true && initial.reportEntries >= 1 && initial.issuesLink !== null && initial.itemCount === 1, JSON.stringify(initial));
		check("Q16 the standalone thread keeps its own adapter registry", initial.registry && initial.registry.page === "thread" && initial.registry.frame === false, JSON.stringify(initial.registry));
		const threadHashBefore = hashTree(dataThreads);
		const proposalHashBefore = hashTree(dataProposals);
		const mailboxBefore = hashCode(mailboxDir);
		check("Q16 the new header links and each message report button have 44px hit areas at 390x844", initial.controls.length >= 3 && initial.controls.every((entry) => entry.width >= 44 && entry.height >= 44), JSON.stringify(initial.controls));
		act("measure", "new report controls at 390x844", JSON.stringify(initial.controls));

		await withDeadline(page.evaluate("document.querySelector('.term').click()"), DEADLINE_MS, "q16_open_term");
		await withDeadline(page.evaluate(waitForDom("() => document.querySelector('.term-pop') ? true : null", "q16_term")), DEADLINE_MS, "q16_term");
		await withDeadline(page.fill("#reply", REPLY), DEADLINE_MS, "q16_fill_reply");
		await withDeadline(page.evaluate("(() => { const r = document.querySelector('#reply'); r.focus(); r.setSelectionRange(2, 2); return [r.selectionStart, r.selectionEnd]; })()"), DEADLINE_MS, "q16_cursor");
		act("fill", "#reply", "page.fill resolved; cursor at 2");
		await withDeadline(page.click(`[data-action="report"][data-report-item="${itemId}"]`), DEADLINE_MS, "q16_open_message_report");
		act("click", `[data-action="report"][data-report-item="${itemId}"]`, "page.click resolved");
		await withDeadline(page.evaluate(waitForDom("() => { const d = document.querySelector('#issue-report'); return d && d.open ? true : null; }", "q16_dialog")), DEADLINE_MS, "q16_dialog");
		let s = await stateEval("q16_open_state");
		const source = await attachSource("q16_attach_open");
		record.steps.opened = { ...s, source };
		check("Q16 the message entry opens the composer with the reply text and cursor untouched", s.dialogOpen === true && s.modal === true && s.reply === REPLY && sameJson(s.replySelection, [2, 2]) && s.active.insideDialog === true, JSON.stringify({ reply: s.reply, selection: s.replySelection, active: s.active }));
		check("Q16 the frozen source names the displayed item and observation seq", source && source.value.includes(ctx.fixtures.threads.a) && source.detail === `seq ${observedSeq}` && s.chip.includes(ctx.fixtures.threads.a), JSON.stringify(source));
		await withDeadline(page.click("#issue-description"), DEADLINE_MS, "q16_description_click");
		const termKept = await stateEval("q16_term_kept");
		record.steps.term = { before: initial.termOpen, opened: s.termOpen, afterReporterClick: termKept.termOpen };
		check("Q16 a click inside the reporter leaves the term popover and reply text intact", termKept.termOpen === true && termKept.reply === REPLY && sameJson(termKept.replySelection, [2, 2]) && termKept.itemCount === s.itemCount, JSON.stringify(record.steps.term));
		const threadShot = await withDeadline(page.screenshot({ type: "png" }), DEADLINE_MS, "q16_thread_shot");
		evidence("Q16-thread.png", Buffer.from(threadShot));
		act("screenshot", "Q16-thread.png", "page.screenshot resolved");

		await armPoll(page);
		const polled = await withDeadline(page.evaluate("window.__q16poll"), DEADLINE_MS, "q16_poll");
		const afterPoll = await stateEval("q16_after_poll");
		record.steps.poll = { polled, afterPoll };
		check("Q16 a poll and re-render request during reporting leaves the DOM, reply and capture untouched", polled === "polled" && afterPoll.dialogOpen === true && afterPoll.reply === REPLY && afterPoll.itemCount === s.itemCount && afterPoll.sourceValue === s.sourceValue, JSON.stringify(afterPoll));

		await withDeadline(page.evaluate(armStatus("접수했습니다")), DEADLINE_MS, "q16_arm_status");
		await withDeadline(page.fill("#issue-description", DESCRIPTION), DEADLINE_MS, "q16_fill_description");
		await withDeadline(page.click("#issue-send"), DEADLINE_MS, "q16_send");
		act("click", "#issue-send", "page.click resolved; awaiting 접수했습니다");
		await withDeadline(page.evaluate("window.__q16status"), DEADLINE_MS, "q16_accepted");
		await withDeadline(page.evaluate(armClose()), DEADLINE_MS, "q16_arm_close");
		await pressKey(page, sessionId, "Escape");
		act("keyboard", "Escape", "CDP key event dispatched; awaiting dialog close and focus");
		await withDeadline(page.evaluate("window.__q16close"), DEADLINE_MS, "q16_close");
		await withDeadline(page.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"), DEADLINE_MS, "q16_close_frames");
		s = await stateEval("q16_closed");
		record.steps.closed = s;
		check("Q16 closing keeps the reply text and returns focus to the message entry", s.dialogOpen === false && s.reply === REPLY && s.active && s.active.action === "report" && s.active.item === itemId, JSON.stringify({ reply: s.reply, active: s.active }));

		const list = await withDeadline(ctx.get("/api/issues?limit=50"), DEADLINE_MS, "q16_issue_list");
		const issueId = list.items[0].id;
		const detail = await withDeadline(ctx.get("/api/issues/" + issueId), DEADLINE_MS, "q16_issue_detail");
		http.push({ side: "node", label: "issue-detail", status: detail.status, body: detail.json });
		record.steps.issue = { issueId, source: detail.issue.source, description: detail.issue.description, events: detail.events.length };
		check("Q16 the issue points to the displayed item and seq and carries the report text", list.items.length === 1 && detail.issue.source.kind === "thread" && detail.issue.source.threadId === ctx.fixtures.threads.a && detail.issue.source.itemId === itemId && detail.issue.source.observedSeq === observedSeq && detail.issue.description === DESCRIPTION, JSON.stringify(record.steps.issue));

		// A canceled dialog reopens the same frozen capture; nothing was sent by the report.
		await withDeadline(page.click(`[data-action="report"][data-report-item="${itemId}"]`), DEADLINE_MS, "q16_reopen_message");
		await withDeadline(page.evaluate(waitForDom("() => document.querySelector('#issue-report')?.open ? true : null", "q16_reopen_dialog")), DEADLINE_MS, "q16_reopen_dialog");
		const reopened = await attachSource("q16_attach_reopened");
		await withDeadline(page.evaluate(armClose()), DEADLINE_MS, "q16_arm_cancel_close");
		await pressKey(page, sessionId, "Escape");
		await withDeadline(page.evaluate("window.__q16close"), DEADLINE_MS, "q16_cancel_close");
		const canceled = await stateEval("q16_canceled");
		record.steps.cancel = { reopened, canceled };
		check("Q16 a reopened dialog shows the same item/seq and Escape cancels without sending", reopened && reopened.value.includes(ctx.fixtures.threads.a) && reopened.detail === `seq ${observedSeq}` && canceled.dialogOpen === false && canceled.reply === REPLY, JSON.stringify(record.steps.cancel));

		const threadHashAfterReports = hashTree(dataThreads);
		const proposalHashAfterReports = hashTree(dataProposals);
		const mailboxAfterReports = hashCode(mailboxDir);
		const mailboxNamesAfterReports = mailboxFiles(ctx.home);
		const hashOf = (list) => new Map(list.map((entry) => [entry.file, entry.sha256]));
		const beforeByFile = hashOf(threadHashBefore);
		const afterByFile = hashOf(threadHashAfterReports);
		const changedFiles = [...new Set([...beforeByFile.keys(), ...afterByFile.keys()])]
			.filter((file) => beforeByFile.get(file) !== afterByFile.get(file))
			.sort();
		const readOnlyChanges = changedFiles.length === 0 || changedFiles.every((file) => /\/events\/\d+-read\.json$/.test(file));
		const diff = {
			dataThreads: { before: threadHashBefore, after: threadHashAfterReports, equal: sameJson(threadHashBefore, threadHashAfterReports), changedFiles, readOnlyChanges },
			dataProposals: { before: proposalHashBefore, after: proposalHashAfterReports, equal: sameJson(proposalHashBefore, proposalHashAfterReports) },
			mailbox: { before: mailboxBefore, after: mailboxAfterReports, equal: sameJson(mailboxBefore, mailboxAfterReports) },
			issues: list.items.map((item) => item.id),
		};
		record.sourceDiff = diff;
		evidence("Q16-source-diff.json", JSON.stringify(diff, null, "\t"));
		check("Q16 reporting leaves data/threads byte-identical apart from the page's own read mark, data/proposals and the mailbox bytes untouched", readOnlyChanges === true && diff.dataProposals.equal === true && diff.mailbox.equal === true, JSON.stringify({ changedFiles, proposals: diff.dataProposals.equal, mailbox: diff.mailbox.equal }));

		// The original composer still answers through its own API and writes exactly one mailbox record.
		const eventsBefore = (await withDeadline(ctx.get("/api/threads/" + encodeURIComponent(ctx.fixtures.threads.a)), DEADLINE_MS, "q16_thread_before_answer")).events.length;
		const preClick = await withDeadline(page.evaluate("(() => ({ sendDisabled: document.querySelector('#send').disabled, reply: document.querySelector('#reply').value, dialogOpen: Boolean(document.querySelector('#issue-report')?.open), status: document.querySelector('#composeStatus').textContent }))()"), DEADLINE_MS, "q16_pre_click");
		const mailboxWait = waitForFile(ctx.home, mailboxNamesAfterReports.length);
		await withDeadline(page.click("#send"), DEADLINE_MS, "q16_send_original");
		act("click", "#send", "the original composer answer");
		const sheet = await withDeadline(page.evaluate(waitForDom("() => document.querySelector('[data-sheet=\"later\"]') ? true : null", "q16_reopen_sheet")), DEADLINE_MS, "q16_reopen_sheet");
		if (sheet) {
			await withDeadline(page.click('[data-sheet="later"]'), DEADLINE_MS, "q16_send_later");
			act("click", '[data-sheet="later"]', "deliver without reopening the session");
		}
		await withDeadline(mailboxWait, DEADLINE_MS, "q16_mailbox");
		record.steps.composer = { preClick, sheet };
		const threadAfter = await withDeadline(ctx.get("/api/threads/" + encodeURIComponent(ctx.fixtures.threads.a)), DEADLINE_MS, "q16_thread_after_answer");
		const answerEvents = threadAfter.events.filter((event) => event.type === "answer" && event.itemId === itemId);
		const mailboxAfterAnswer = mailboxFiles(ctx.home);
		const addedMailbox = mailboxAfterAnswer.filter((file) => !mailboxNamesAfterReports.includes(file));
		const replyAfterAnswer = await stateEval("q16_after_answer");
		record.steps.answer = { eventsBefore, eventsAfter: threadAfter.events.length, answerEvents: answerEvents.length, mailbox: mailboxAfterAnswer, addedMailbox, reply: replyAfterAnswer.reply };
		check("Q16 the original answer still runs through its own API with exactly one new answer event and mailbox record", answerEvents.length === 1 && addedMailbox.length === 1 && addedMailbox[0].includes(itemId) && replyAfterAnswer.reply === "" && threadAfter.events.filter((event) => event.type === "answer").length === 1, JSON.stringify(record.steps.answer));
		check("Q16 the report added no thread event of its own", threadAfter.events.filter((event) => event.type !== "answer" && event.type !== "read" && event.seq > observedSeq).length === 0, JSON.stringify(threadAfter.events.filter((event) => event.seq > observedSeq)));

		// Embedded in the REAL Inbox split view: same registry, same page listeners, same reporter mount.
		embeddedPage = await withDeadline(newQaPage(browser, { width: 720, height: 900, scheme }), DEADLINE_MS, "q16_embedded_page");
		await withDeadline(embeddedPage.goto(ctx.base + "/?s=" + encodeURIComponent(ctx.fixtures.threads.a), { waitUntil: "load" }), DEADLINE_MS, "q16_goto_real_inbox");
		act("navigate", "/?s=qa-issue-a", "real Inbox split view");
		await withDeadline(embeddedPage.evaluate(waitForEmbeddedDom("iframe.thread", `() => {
			const frame = document.querySelector('iframe.thread');
			const doc = frame && frame.contentDocument;
			if (!doc || !doc.querySelector('[data-action="report"]') || !doc.querySelector('#issue-report')) return null;
			const controls = [...doc.querySelectorAll('.tool, [data-action="report"]')];
			if (controls.length < 3) return null;
			if (!controls.every((node) => { const box = node.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; })) return null;
			return window.__inboxIssueAdapters && window.__inboxIssueAdapters.current() && window.__inboxIssueAdapters.current().page === 'thread' ? true : null;
		}`, "q16_real_embedded_ready")), DEADLINE_MS, "q16_real_embedded_ready");
		const embeddedBefore = await withDeadline(embeddedPage.evaluate(REAL_EMBED_STATE), DEADLINE_MS, "q16_embedded_before");
		record.steps.embedded = embeddedBefore;
		check("Q16 the real Inbox iframe registers its thread adapter through the shared parent registry", embeddedBefore.current && embeddedBefore.current.page === "thread" && embeddedBefore.current.frame === true && embeddedBefore.childReady === true && embeddedBefore.parentDialogOpen === false, JSON.stringify(embeddedBefore.current));
		check("Q16 the embedded thread's new report controls have 44px hit areas at 720x900", embeddedBefore.childControls.length >= 3 && embeddedBefore.childControls.every((entry) => entry.width >= 44 && entry.height >= 44), JSON.stringify(embeddedBefore.childControls));

		await withDeadline(embeddedPage.evaluate(`(() => {
			const frame = document.querySelector('iframe.thread');
			const doc = frame.contentDocument;
			doc.querySelector('#reply').value = '임베디드 답장';
			const dialog = doc.querySelector('#issue-report');
			window.__q16ChildOpen = new Promise((resolve, reject) => {
				if (dialog.open) { resolve('already-open'); return; }
				const timer = setTimeout(() => { observer.disconnect(); reject(new Error('embedded dialog did not open')); }, 9000);
				const observer = new MutationObserver(() => { if (dialog.open) { clearTimeout(timer); observer.disconnect(); resolve('open'); } });
				observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
			});
			window.__q16ChildOpen.catch(() => {});
			doc.querySelector('[data-item="' + ${JSON.stringify(itemId)} + '"] [data-action="report"]').click();
			return true;
		})()`), DEADLINE_MS, "q16_embedded_click");
		await withDeadline(embeddedPage.evaluate("window.__q16ChildOpen"), DEADLINE_MS, "q16_embedded_dialog");
		await withDeadline(embeddedPage.evaluate(`document.querySelector('iframe.thread').contentDocument.querySelector('#issue-attach-toggle').click()`), DEADLINE_MS, "q16_embedded_attach");
		const embeddedOpen = await withDeadline(embeddedPage.evaluate(REAL_EMBED_STATE), DEADLINE_MS, "q16_embedded_open");
		record.steps.embeddedOpen = embeddedOpen;
		const capturedSeq = Number((embeddedOpen.sourceDetail || "").match(/^seq (\d+)$/)?.[1] ?? 0);
		check("Q16 the embedded message report keeps the THREAD adapter current and captures the displayed item and seq", embeddedOpen.current && embeddedOpen.current.page === "thread" && embeddedOpen.current.frame === true && embeddedOpen.dialogOpen === true && embeddedOpen.parentDialogOpen === false && embeddedOpen.childReply === "임베디드 답장" && embeddedOpen.source.includes(itemId) && capturedSeq > 0 && capturedSeq >= observedSeq, JSON.stringify({ current: embeddedOpen.current, source: embeddedOpen.source, detail: embeddedOpen.sourceDetail, parentDialogOpen: embeddedOpen.parentDialogOpen, reply: embeddedOpen.childReply }));
		const embeddedShot = await withDeadline(embeddedPage.screenshot({ type: "png" }), DEADLINE_MS, "q16_embedded_shot");
		evidence("Q16-embedded.png", Buffer.from(embeddedShot));
		act("screenshot", "Q16-embedded.png", "page.screenshot resolved");
		await withDeadline(embeddedPage.evaluate(`(() => {
			const dialog = document.querySelector('iframe.thread').contentDocument.querySelector('#issue-report');
			window.__q16ChildClose = new Promise((resolve, reject) => {
				if (!dialog.open) { resolve('already-closed'); return; }
				const timer = setTimeout(() => reject(new Error('embedded dialog did not close')), 9000);
				dialog.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); }, { once: true });
			});
			window.__q16ChildClose.catch(() => {});
			return true;
		})()`), DEADLINE_MS, "q16_embedded_arm_close");
		await withDeadline(embeddedPage.evaluate("document.querySelector('iframe.thread').contentDocument.querySelector('#issue-close').click()"), DEADLINE_MS, "q16_embedded_close");
		await withDeadline(embeddedPage.evaluate("window.__q16ChildClose"), DEADLINE_MS, "q16_embedded_closed");
		const embeddedClosed = await withDeadline(embeddedPage.evaluate(REAL_EMBED_STATE), DEADLINE_MS, "q16_embedded_closed_state");
		record.steps.embeddedClosed = embeddedClosed;
		check("Q16 closing the embedded report keeps the child reply and the thread source", embeddedClosed.dialogOpen === false && embeddedClosed.childReply === "임베디드 답장" && embeddedClosed.current.page === "thread" && embeddedClosed.parentDialogOpen === false, JSON.stringify({ reply: embeddedClosed.childReply, current: embeddedClosed.current, parentDialogOpen: embeddedClosed.parentDialogOpen }));

		// Denied parent registration: the frame keeps its plain /issues/new entry and sends nothing.
		await withDeadline(embeddedPage.evaluate(`(() => {
			window.__inboxIssueAdapters = { register() { const error = new Error('denied'); error.code = 'origin_denied'; throw error; }, current() { return null; } };
			const frame = document.createElement('iframe');
			frame.id = 'thread-frame-denied';
			// Subscribe before the src/append so a fast load cannot be missed.
			window.__q16DeniedLoad = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('denied frame did not load')), 9000);
				frame.addEventListener('load', () => { clearTimeout(timer); resolve(true); }, { once: true });
			});
			window.__q16DeniedLoad.catch(() => {});
			frame.src = '/s/' + ${JSON.stringify(ctx.fixtures.threads.b)};
			document.body.append(frame);
			return true;
		})()`), DEADLINE_MS, "q16_denied_frame");
		await withDeadline(embeddedPage.evaluate("window.__q16DeniedLoad"), DEADLINE_MS, "q16_denied_loaded");
		const deniedBefore = await withDeadline(embeddedPage.evaluate("(() => { const f = document.getElementById('thread-frame-denied'); return { href: f.contentDocument.querySelector('[data-issue-report]')?.getAttribute('href'), dialog: Boolean(f.contentDocument.querySelector('#issue-report')?.open), childReporter: Boolean(f.contentDocument.querySelector('#issue-report')) }; })()"), DEADLINE_MS, "q16_denied_before");
		const deniedNav = embeddedPage.waitForURL(/\/issues\/new$/, { timeout: 9000 });
		await withDeadline(embeddedPage.evaluate("document.getElementById('thread-frame-denied').contentDocument.querySelector('[data-issue-report]').click()"), DEADLINE_MS, "q16_denied_click");
		await withDeadline(deniedNav, DEADLINE_MS, "q16_denied_navigate");
		const deniedUrl = new URL(embeddedPage.url()).pathname;
		const deniedAfter = await withDeadline(embeddedPage.evaluate("(() => ({ parentUrl: location.pathname, parentDialog: Boolean(document.querySelector('#issue-report')?.open) }))()"), DEADLINE_MS, "q16_denied_after");
		record.steps.denied = { before: deniedBefore, after: { childUrl: deniedUrl, ...deniedAfter } };
		// The embedded page's base target is _top, so the plain fallback lands on /issues/new in the top frame.
		check("Q16 denied iframe registration falls back to the plain /issues/new entry without opening a report", deniedBefore.href === "/issues/new" && deniedBefore.dialog === false && deniedBefore.childReporter === false && deniedUrl === "/issues/new" && deniedAfter.parentUrl === "/issues/new", JSON.stringify(record.steps.denied));
		const issuesAfterDenied = await withDeadline(ctx.get("/api/issues?limit=50"), DEADLINE_MS, "q16_issues_after_denied");
		const mailboxFinal = mailboxFiles(ctx.home);
		check("Q16 no report or answer came from the embedded/denied attempts", issuesAfterDenied.items.length === 1 && sameJson(mailboxFinal, mailboxAfterAnswer), JSON.stringify({ issues: issuesAfterDenied.items.length, mailbox: mailboxFinal }));

		// A parent without a registry: the embedded frame waits for the readiness event instead of
		// creating a frame-local registry and reporter of its own.
		await withDeadline(embeddedPage.goto(ctx.base + "/?s=" + encodeURIComponent(ctx.fixtures.threads.a), { waitUntil: "load" }), DEADLINE_MS, "q16_unregistered_parent_goto");
		await withDeadline(embeddedPage.evaluate(waitForEmbeddedDom("iframe.thread", `() => {
			const frame = document.querySelector('iframe.thread');
			const doc = frame && frame.contentDocument;
			return doc && doc.querySelector('[data-action="report"]') && window.__inboxIssueAdapters ? true : null;
		}`, "q16_unregistered_parent_ready")), DEADLINE_MS, "q16_unregistered_parent_ready");
		await withDeadline(embeddedPage.evaluate(`(() => {
			delete window.__inboxIssueAdapters;
			const frame = document.createElement('iframe');
			frame.id = 'thread-frame-unregistered';
			window.__q16UnregisteredLoad = new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('unregistered frame did not load')), 9000);
				frame.addEventListener('load', () => { clearTimeout(timer); resolve(true); }, { once: true });
			});
			window.__q16UnregisteredLoad.catch(() => {});
			frame.src = '/s/' + ${JSON.stringify(ctx.fixtures.threads.b)};
			document.body.append(frame);
			return true;
		})()`), DEADLINE_MS, "q16_unregistered_frame");
		await withDeadline(embeddedPage.evaluate("window.__q16UnregisteredLoad"), DEADLINE_MS, "q16_unregistered_loaded");
		const unregistered = await withDeadline(embeddedPage.evaluate(`(() => {
			const frame = document.getElementById('thread-frame-unregistered');
			const doc = frame.contentDocument;
			return { ownRegistry: Boolean(frame.contentWindow.__inboxIssueAdapters), reporter: Boolean(doc.querySelector('#issue-report')), href: doc.querySelector('[data-issue-report]')?.getAttribute('href') ?? null };
		})()`), DEADLINE_MS, "q16_unregistered_state");
		record.steps.unregistered = unregistered;
		check("Q16 an embedded frame under a parent without a registry never creates its own and keeps the plain entry", unregistered.ownRegistry === false && unregistered.reporter === false && unregistered.href === "/issues/new", JSON.stringify(unregistered));

		// The 1280x900 track runs inside the real Inbox split view. A standalone /s/ page redirects to
		// /?s= at >=720px by design, so measuring it there would race the navigation.
		await withDeadline(pinQaPage(embeddedPage, { width: 1280, height: 900, scheme }), DEADLINE_MS, "q16_desktop_pin");
		await withDeadline(embeddedPage.goto(ctx.base + "/?s=" + encodeURIComponent(ctx.fixtures.threads.a), { waitUntil: "load" }), DEADLINE_MS, "q16_goto_desktop_inbox");
		act("navigate", "/?s=qa-issue-a", "real Inbox split view at 1280x900");
		await withDeadline(embeddedPage.evaluate(waitForEmbeddedDom("iframe.thread", `() => {
			const frame = document.querySelector('iframe.thread');
			const doc = frame && frame.contentDocument;
			if (!doc || frame.getBoundingClientRect().width <= 0) return null;
			const controls = [...doc.querySelectorAll('.tool, [data-action="report"]')];
			if (controls.length < 3 || !doc.querySelector('[data-action="report"]')) return null;
			return controls.every((node) => { const box = node.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }) ? true : null;
		}`, "q16_desktop_controls")), DEADLINE_MS, "q16_desktop_controls");
		const desktop = await withDeadline(embeddedPage.evaluate(REAL_EMBED_STATE), DEADLINE_MS, "q16_desktop");
		record.steps.desktop = { controls: desktop.childControls, overflow: desktop.overflow };
		check("Q16 the new report controls keep 44px hit areas at 1280x900 embedded", desktop.childControls.length >= 3 && desktop.childControls.every((entry) => entry.width >= 44 && entry.height >= 44) && desktop.overflow === false, JSON.stringify(record.steps.desktop));

		record.http = http;
		record.actions = actions;
		evidence("Q16-actions.json", JSON.stringify({ viewport: record.viewport, seed: record.seed, actions, http, steps: record.steps }, null, "\t"));
		const overflow = initial.overflow === false && s.overflow === false;
		check("Q16 the narrow thread has no horizontal overflow", overflow === true, JSON.stringify({ initial: initial.overflow, closed: s.overflow }));
	} catch (error) {
		record.error = error && error.stack ? error.stack : String(error);
		record.http = http;
		record.actions = actions;
		try { evidence("Q16-actions.json", JSON.stringify(record, null, "\t")); } catch {}
		throw error;
	} finally {
		try { await withDeadline(page.close(), DEADLINE_MS, "q16_page_close"); } catch {}
		try { if (embeddedPage) await withDeadline(embeddedPage.close(), DEADLINE_MS, "q16_embedded_page_close"); } catch {}
	}
}
