/* Real-browser QA for report sending (todo 26): the inspector composer and the /issues list against a fake GitHub.
 *
 * Usage: bun qa/report-send-qa.mjs [app dir, default the repo] [output dir, default a new temp dir]
 * Starts the isolated fake GitHub and <app>/src/server.mjs on port 4404 with a fresh home, then drives one
 * Bun.WebView through the happy pick/send path, a transient outage, an ambiguous create, a restart, auth and
 * public-repo failures, the list and its badge, handoff, the legacy migration, the text-only composer, redaction,
 * the legacy redirect, and the warm state-cache path. Every wait is a named deadline on an observed DOM change.
 * Exit 0 only when every check passes; the last line is `N/N checks passed`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { framePng } from "./frame.mjs";
import { startFakeGitHub, startInboxServer } from "./report-fixture.mjs";
import { marker } from "../src/reports-body.mjs";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = 4404;
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "report-send-qa-"));
const POST = { "content-type": "application/json", "x-inbox": "1" };
const SCRATCH_ROOT = "C:/Windows/Temp/ulw-inspector-ktUlUR/task26";
const SCENARIO = "report-send-qa";
const TITLE_S1 = "글자가 잘립니다";
const TITLE_S2 = "S2 일시적인 장애";
const TITLE_S4 = "S4 재시작 뒤 전송";
const TITLE_S5 = "S5 인증 실패";
const TITLE_S6 = "S6 공개 저장소";
const LEGACY_TEXT = "와이어프레임으로 구성하는게 더 적절";
const LEGACY_CREATED_AT = "2026-10-27T15:32:14.822Z";
const PUSH_FAILED_TITLE = "제보를 GitHub에 올리지 못했습니다";

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok: Boolean(ok) });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (value) => JSON.stringify(value, (_key, item) => (typeof item === "number" ? Math.round(item * 100) / 100 : item));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(SCRATCH_ROOT, `${SCENARIO}-`));

function nodeDir() {
	for (const dir of String(process.env.PATH ?? process.env.Path ?? "").split(";")) {
		if (dir && fs.existsSync(path.join(dir, "node.exe"))) return dir;
	}
	throw new Error("node.exe is not on PATH");
}

function qaPath() {
	const bin = path.join(scratch, "bin");
	fs.mkdirSync(bin, { recursive: true });
	for (const name of ["omo.exe", "wt.exe"]) fs.writeFileSync(path.join(bin, name), "");
	const system = process.env.SystemRoot || "C:/Windows";
	return [bin, nodeDir(), path.join(system, "System32"), system].join(";");
}

function freshHome(name) {
	const home = path.join(scratch, name);
	fs.mkdirSync(home, { recursive: true });
	return home;
}

function readJson(file, fallback = null) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function readLines(file) {
	try {
		return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function treeHashes(dir) {
	const result = {};
	function walk(current, prefix) {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const file = path.join(current, entry.name);
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(file, rel);
			else result[rel] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		}
	}
	if (fs.existsSync(dir)) walk(dir, "");
	return result;
}

async function tcpClosed(port) {
	const timer = new Promise((resolve) => setTimeout(() => resolve(false), 10_000));
	const probe = new Promise((resolve) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", (error) => {
			socket.destroy();
			resolve(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH"].includes(error.code));
		});
	});
	return Promise.race([probe, timer]);
}

const fake = startFakeGitHub({ private: true, hasIssues: true });
let server = null;
let view = null;
let pushSink = null;
let reopenSink = null;

async function apiJson(route, options = {}) {
	const res = await fetch(server.base + route, {
		...options,
		headers: { accept: "application/json", ...(options.method === "POST" ? POST : {}), ...(options.headers ?? {}) },
		signal: AbortSignal.timeout(15_000),
	});
	const text = await res.text();
	let json = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		json = text;
	}
	return { status: res.status, json, headers: res.headers };
}

async function postJson(route, body = {}) {
	const result = await apiJson(route, { method: "POST", body: JSON.stringify(body) });
	if (result.status >= 300) throw new Error(`POST ${route} -> ${result.status} ${JSON.stringify(result.json)}`);
	return result.json;
}

async function reportList(limit = 100) {
	const result = await apiJson(`/api/reports?limit=${limit}`);
	if (result.status !== 200) throw new Error(`GET /api/reports -> ${result.status}`);
	return result.json;
}

async function reportByTitle(title) {
	const list = await reportList();
	return list.items.find((row) => row.title === title) ?? null;
}

async function reportDetail(id) {
	const result = await apiJson(`/api/reports/${encodeURIComponent(id)}`);
	return result.status === 200 ? result.json : null;
}

async function waitHost(fn, ms, name) {
	const started = Date.now();
	let last = null;
	while (Date.now() - started < ms) {
		try {
			last = await fn();
			if (last) return last;
		} catch (error) {
			last = error;
		}
		await sleep(25);
	}
	throw new Error(`deadline: ${name} (${ms}ms)${last instanceof Error ? ` - ${last.message}` : ""}`);
}

function recordOf(id) {
	return readJson(path.join(server.home, "data", "reports", id, "report.json"));
}

function postIssuesFor(markerText) {
	return fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues") && typeof request.body?.body === "string" && request.body.body.includes(markerText));
}

function issueFor(markerText) {
	return fake.issues.find((issue) => issue.body.includes(markerText)) ?? null;
}

async function subscribePush() {
	const point = Buffer.concat([Buffer.from([0x04]), crypto.randomBytes(64)]).toString("base64url");
	const auth = crypto.randomBytes(16).toString("base64url");
	await postJson("/api/push/subscribe", { subscription: { endpoint: "https://push.example.invalid/qa", keys: { p256dh: point, auth } } });
}

/* ---------- browser ---------- */

const ev = (expression) => view.evaluate(expression);
const cdp = (method, params) => view.cdp(method, params || {});

function waitChange(condition, ms, name) {
	return ev(`new Promise((resolve, reject) => {
		const label = ${JSON.stringify(name)};
		const check = () => {
			let ok = false;
			try { ok = Boolean(${condition}); } catch (error) { ok = false; }
			if (!ok) return;
			clearTimeout(limit);
			observer.disconnect();
			resolve(true);
		};
		const observer = new MutationObserver(check);
		const limit = setTimeout(() => {
			observer.disconnect();
			reject(new Error("deadline: " + label + " (" + ${ms} + "ms)"));
		}, ${ms});
		observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
		queueMicrotask(check);
	})`);
}

async function openPage(route, ready, name) {
	await view.navigate(server.base + route);
	await waitChange(ready, 15_000, name);
}

function fill(selector, text) {
	return ev(`(() => {
		const node = document.querySelector(${JSON.stringify(selector)});
		if (!node) return null;
		const setter = node.tagName === "TEXTAREA" || node.tagName === "INPUT"
			? Object.getOwnPropertyDescriptor(node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set
			: null;
		if (setter) setter.call(node, ${JSON.stringify(text)});
		else node.value = ${JSON.stringify(text)};
		node.dispatchEvent(new Event("input", { bubbles: true }));
		return node.value;
	})()`);
}

function click(selector) {
	return ev(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
}

function textOf(selector) {
	return ev(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node ? node.textContent : null; })()`);
}

function rectOf(selector) {
	return ev(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);
}

async function clickAt(x, y) {
	await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function shot(name) {
	const result = await cdp("Page.captureScreenshot", { format: "png" });
	const file = path.join(OUT, name);
	fs.writeFileSync(file, Buffer.from(result.data, "base64"));
	console.log(`saved ${file}`);
}

async function sendComposer(text) {
	await openPage("/issues/new", `document.getElementById("description") && !document.getElementById("send").hidden`, "composer /issues/new");
	await fill("#description", text);
	await waitChange(`!document.getElementById("send").disabled`, 5000, "composer send enabled");
	await click("#send");
}

async function waitStatus(text, ms, name) {
	return waitChange(`document.getElementById("status")?.textContent === ${JSON.stringify(text)}`, ms, name);
}

/* ---------- scenarios ---------- */

async function s1() {
	await openPage("/issues", `window.__inboxReporter && document.querySelector("[data-issue-report]")`, "issues page");
	await ev(`document.querySelector("[data-issue-report]").click()`);
	await waitChange(`document.querySelector("[data-report-hint]") !== null`, 5000, "pick overlay");
	const rect = await rectOf(".top h1");
	await clickAt(rect.x, rect.y);
	await waitChange(`document.querySelector("dialog[open]") !== null && document.querySelector("dialog[open] #report-description") !== null`, 8000, "composer dialog");
	const selector = await ev(`document.querySelector("dialog[open] [data-selector]")?.textContent ?? null`);
	await waitChange(`document.querySelector("dialog[open] .report__thumb") && !document.querySelector("dialog[open] .report__thumb").hidden`, 10_000, "snapshot thumbnail");
	await fill("dialog[open] #report-description", TITLE_S1);
	await waitChange(`!document.querySelector("dialog[open] [data-action=send]").disabled`, 5000, "send enabled");
	await click("dialog[open] [data-action=send]");
	await waitChange(`document.querySelector("dialog[open] .report__status")?.textContent === "GitHub #1에 올렸습니다"`, 15_000, "dialog sent status");
	await shot("s1-happy.png");

	const row = await reportByTitle(TITLE_S1);
	const issue = row ? issueFor(marker(row.id)) : null;
	const record = row ? recordOf(row.id) : null;
	check("S1 report reached GitHub #1 with the dialog status", issue?.number === 1 && (await textOf("dialog[open] .report__status")) === "GitHub #1에 올렸습니다");
	check("S1 every fake request carried the bearer token", fake.requests.length > 0 && fake.requests.every((request) => request.auth === true), fmt({ requests: fake.requests.length }));
	const paths = fake.requests.map((request) => `${request.method} ${request.path}`);
	check(
		"S1 fake saw repo lookup, label ensure and the assets branch bootstrap",
		paths.includes("GET /repos/yjacket/omo-inbox") &&
			paths.some((line) => /labels\/inbox-report/.test(line)) &&
			paths.includes("POST /repos/yjacket/omo-inbox/git/trees") &&
			paths.includes("POST /repos/yjacket/omo-inbox/git/commits") &&
			paths.includes("POST /repos/yjacket/omo-inbox/git/refs"),
		fmt({ bootstrap: paths.filter((line) => /repos\/yjacket\/omo-inbox(\/git|$)/.test(line)) }),
	);
	const put = fake.requests.find((request) => request.method === "PUT" && /\/contents\/reports\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/.test(request.path));
	check(
		"S1 PUT contents uploaded reports/<YYYY>/<MM>/<id>.png on inbox-report-assets",
		Boolean(put) && put.body?.branch === "inbox-report-assets" && put.auth === true,
		put ? fmt({ path: put.path, branch: put.body?.branch }) : "no PUT",
	);
	const created = fake.requests.find((request) => request.method === "POST" && request.path.endsWith("/issues"));
	check(
		"S1 POST issues uses the inbox-report label and the description as title",
		Boolean(created) && JSON.stringify(created.body?.labels) === JSON.stringify(["inbox-report"]) && created.body?.title === TITLE_S1,
		created ? fmt({ labels: created.body?.labels, title: created.body?.title }) : "no POST issues",
	);
	const body = created?.body?.body ?? "";
	const jsonBlock = /```json\n([\s\S]*?)\n```/.exec(body)?.[1] ?? "";
	let machine = null;
	try {
		machine = JSON.parse(jsonBlock);
	} catch {
		machine = null;
	}
	check(
		"S1 issue body has the marker, 위치 section, selector and the assets blob link",
		body.includes(marker(row.id)) && body.includes("### 위치") && typeof selector === "string" && selector !== "" && body.includes(selector) && body.includes("../blob/inbox-report-assets/reports/"),
		fmt({ selector, hasMarker: body.includes(marker(row.id)), hasBlob: body.includes("../blob/inbox-report-assets/reports/") }),
	);
	check("S1 machine block parses with schema inbox-report/v2", machine?.schema === "inbox-report/v2" && machine?.reportId === row.id && record?.report?.element?.selector === selector, fmt({ schema: machine?.schema }));
}

async function s2() {
	fake.setMode({ failCreate: 2 });
	await sendComposer(TITLE_S2);
	await waitStatus("GitHub로 보내는 중", 10_000, "S2 pending status");
	await waitStatus("GitHub #2에 올렸습니다", 15_000, "S2 sent status");
	await shot("s2-outage.png");
	const row = await reportByTitle(TITLE_S2);
	const issues = row ? fake.issues.filter((issue) => issue.body.includes(marker(row.id))) : [];
	check("S2 a transient outage retries into GitHub #2", row?.state === "sent" && row?.github?.number === 2 && issues.length === 1, fmt({ state: row?.state, number: row?.github?.number, issues: issues.length }));
}

async function s3() {
	fake.setMode({ hangCreate: 1 });
	await sendComposer("S3 모호한 생성");
	await waitStatus("GitHub #3에 올렸습니다", 20_000, "S3 reconciled status");
	const row = await reportByTitle("S3 모호한 생성");
	const issues = row ? fake.issues.filter((issue) => issue.body.includes(marker(row.id))) : [];
	check("S3 an ambiguous create reconciles to the one issue it made", row?.state === "sent" && row?.github?.number === 3 && issues.length === 1, fmt({ state: row?.state, number: row?.github?.number, issues: issues.length }));
}

async function s4() {
	fake.setMode({ status: { ".": 503 } });
	await sendComposer(TITLE_S4);
	await waitChange(`document.getElementById("status")?.textContent === "GitHub로 보내는 중"`, 10_000, "S4 pending before restart");
	await server.restart();
	fake.setMode({ status: null });
	const row = await reportByTitle(TITLE_S4);
	const sent = await waitHost(async () => {
		const detail = await reportDetail(row.id);
		return detail?.state === "sent" ? detail : null;
	}, 20_000, "S4 sent after restart");
	await shot("s4-restart.png");
	const issues = fake.issues.filter((issue) => issue.body.includes(marker(row.id)));
	check("S4 an unfinished report is sent after the server restarts", sent.state === "sent" && sent.github?.number === 4 && issues.length === 1, fmt({ state: sent.state, number: sent.github?.number, issues: issues.length }));
}

async function s5() {
	fake.setMode({ status: { ".": 401 } });
	await sendComposer(TITLE_S5);
	await waitStatus("보내지 못했습니다 · GitHub 인증을 확인해야 합니다", 15_000, "S5 auth failure");
	const row = await reportByTitle(TITLE_S5);
	await openPage("/issues", `document.querySelector('.row[data-id="${row.id}"]')`, "S5 failure row");
	await waitChange(`document.querySelector('.row[data-id="${row.id}"] .state')?.textContent === "보내지 못했습니다 · GitHub 인증을 확인해야 합니다"`, 10_000, "S5 failure list text");
	await shot("s5-auth-failed.png");
	const failureLines = readLines(pushSink).filter((line) => line?.payload?.title === PUSH_FAILED_TITLE);
	check("S5 the list shows the auth failure and the push sink got exactly one failure line", failureLines.length === 1, fmt({ failureLines: failureLines.length }));
	fake.setMode({ status: null });
	await click(`.row[data-id="${row.id}"] [data-action=retry]`);
	await waitChange(`document.querySelector('.row[data-id="${row.id}"] .state')?.textContent?.startsWith("#") && document.querySelector('.row[data-id="${row.id}"] .state').textContent.includes("열림")`, 20_000, "S5 retried row open");
	const list = await reportList();
	const after = list.items.find((item) => item.id === row.id);
	check("S5 retry after clearing the mode reaches #5 열림", after?.state === "sent" && after.github?.number === 5, fmt({ state: after?.state, number: after?.github?.number }));
}

async function s6() {
	fake.setMode({ private: false });
	await server.restart();
	await sendComposer(TITLE_S6);
	await waitStatus("보내지 못했습니다 · 공개 저장소에는 올리지 않습니다", 15_000, "S6 public repo failure");
	const row = await reportByTitle(TITLE_S6);
	const attempts = row ? postIssuesFor(marker(row.id)) : [];
	check("S6 a public repo fails without creating an issue", row?.state === "failed" && row?.detail === "공개 저장소에는 올리지 않습니다" && attempts.length === 0, fmt({ state: row?.state, detail: row?.detail, posts: attempts.length }));
	fake.setMode({ private: true });
	await server.restart();
}

async function s7() {
	const rows = await reportList();
	const ids = rows.items.map((row) => row.id);
	await openPage("/issues", `document.querySelectorAll("#list .row").length >= ${ids.length}`, "S7 list");
	const domIds = await ev(`[...document.querySelectorAll("#list .row")].map((row) => row.dataset.id)`);
	check("S7 the list shows every row newest first", JSON.stringify(domIds) === JSON.stringify(ids), fmt({ api: ids, dom: domIds }));

	const target = fake.issues.find((issue) => issue.number === 5);
	target.state = "closed";
	target.comments = 2;
	const closedId = rows.items.find((row) => row.github?.number === 5)?.id ?? null;
	await server.restart();
	await openPage("/issues", `document.querySelector(".row[data-id='${closedId}']")`, "S7 cold list");
	await waitChange(`document.querySelector(".row[data-id='${closedId}'] .state")?.textContent === "#5 닫힘 · 댓글 2"`, 10_000, "S7 closed row auto-refresh");
	await shot("s7-list-closed.png");
	check("S7 a cold cache fills the closed row within 10 s without a reload", (await ev(`document.querySelector(".row[data-id='${closedId}'] .state")?.textContent`)) === "#5 닫힘 · 댓글 2");

	await openPage("/", `document.getElementById("issueBadge")`, "inbox header");
	await waitChange(`document.getElementById("issueBadge") && !document.getElementById("issueBadge").hidden`, 10_000, "pending badge");
	const badge = await textOf("#issueBadge");
	check("S7 the header badge counts pending plus failed reports", badge === "1", fmt({ badge }));
}

async function s8() {
	const row = await reportByTitle(TITLE_S5);
	const before = readLines(reopenSink).length;
	await openPage("/issues", `document.querySelector('.row[data-id="${row.id}"] [data-action=handoff]')`, "S8 handoff row");
	await click(`.row[data-id="${row.id}"] [data-action=handoff]`);
	await waitChange(`document.querySelector('.row[data-id="${row.id}"] .note')?.textContent === "새 세션에 맡겼습니다." && document.querySelector('.row[data-id="${row.id}"] [data-action=handoff]')?.textContent === "다시 맡기기"`, 15_000, "S8 handoff done");
	const button = await textOf(`.row[data-id="${row.id}"] [data-action=handoff]`);
	const lines = readLines(reopenSink);
	const launch = lines[lines.length - 1];
	const message = `inbox-report yjacket/omo-inbox#${row.github.number}`;
	const folder = path.join(server.home, "checkout");
	const attemptText = JSON.stringify(launch?.attempts ?? []);
	check(
		"S8 handoff writes one launch with the issue message and the checkout folder",
		lines.length === before + 1 && launch?.kind === "launch" && attemptText.includes(message) && (attemptText.includes(folder) || attemptText.includes(folder.replaceAll("\\", "/"))),
		fmt({ lines: lines.length, kind: launch?.kind, attempts: launch?.attempts }),
	);
	check("S8 the row note and the 다시 맡기기 button follow", (await ev(`document.querySelector('.row[data-id="${row.id}"] .note')?.textContent`)) === "새 세션에 맡겼습니다." && button === "다시 맡기기", fmt({ button }));
}

function writeLegacyRecord(dataDir, id, proposalId) {
	const dir = path.join(dataDir, "issues", "records", id);
	fs.mkdirSync(path.join(dir, "events"), { recursive: true });
	const source = { kind: "proposal", proposalId, revision: 1, observedSeq: 1, recordedContentHash: "57c64b491567c18f3cdf29591d67da16228044a752642f51ae9c4091f0e19a21", frame: null };
	fs.writeFileSync(path.join(dir, "created.json"), JSON.stringify({ v: 1, id, storeId: crypto.randomUUID(), title: LEGACY_TEXT, description: LEGACY_TEXT, createdAt: LEGACY_CREATED_AT, source }));
	fs.writeFileSync(path.join(dir, "events", ".committed.json"), JSON.stringify({ seq: 1, hash: "a9eb5b059607b49672ff233065e122a34d7708b96d61051d786dfb8266ef046e" }));
	fs.writeFileSync(path.join(dir, "events", "000001.json"), JSON.stringify({ v: 1, type: "created", seq: 1, requestId: id, acceptedAt: LEGACY_CREATED_AT, actor: "owner", via: "pc", state: "open", command: null }));
	const captureId = crypto.randomUUID();
	const evidence = path.join(dir, "evidence", captureId);
	fs.mkdirSync(evidence, { recursive: true });
	fs.writeFileSync(
		path.join(evidence, "context.json"),
		JSON.stringify({
			captureId,
			observedAt: "2026-10-27T15:31:31.520Z",
			page: "proposal",
			source,
			target: { kind: "frame", key: "frame:보고서 순서", label: "보고서 순서", rect: { x: 45, y: 358.390625, w: 690, h: 745.9375 }, framePath: [] },
			view: { width: 795, height: 1270, dpr: 1, scale: 1, scrollX: 0, scrollY: 0, theme: "light", locale: "ko", embedded: false, viewerOpen: false },
			excerpt: null,
			excerptTruncated: false,
		}),
	);
}

async function seedReview() {
	const dir = path.join(scratch, "legacy-board");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "frame.png"), framePng(320, 180));
	fs.writeFileSync(
		path.join(dir, "board.json"),
		JSON.stringify({ title: "S9 이전 제보", kind: "decision", sections: [{ title: "화면", cards: [{ title: "프레임", frames: [["화면", "frame.png"]] }] }] }),
	);
	const created = await postJson("/api/proposals", { srcDir: dir, cwd: APP });
	if (!created?.summary?.id || !created.summary.product?.key) throw new Error(`proposal seed failed: ${JSON.stringify(created)}`);
	return created.summary;
}

async function s9() {
	await server.stop();
	const home = freshHome("home-legacy");
	const env = { INBOX_GITHUB_API: fake.url, INBOX_PUSH_SINK: pushSink, INBOX_REOPEN_SINK: reopenSink, PATH: qaPath() };
	server = await startInboxServer({ app: APP, port: PORT, home, env });
	const proposal = await seedReview();
	const legacyId = crypto.randomUUID();
	await server.stop();
	const dataDir = path.join(home, "data");
	writeLegacyRecord(dataDir, legacyId, proposal.id);
	const before = treeHashes(path.join(dataDir, "issues"));
	server = await startInboxServer({ app: APP, port: PORT, home, env });
	await waitHost(async () => (await reportDetail(legacyId)) ?? null, 10_000, "S9 migrated report");
	const row = await reportDetail(legacyId);
	const issue = await waitHost(async () => issueFor(marker(legacyId)), 15_000, "S9 legacy issue");
	const body = issue.body;
	check(
		"S9 the legacy record becomes a sent issue with its provenance and product",
		body.includes("이전 제보함에서 옮긴 제보입니다") && body.includes(LEGACY_TEXT) && body.includes(`- 출처: Review ${proposal.id}`) && /(?:^|\n)- 제품: .+/m.test(body),
		fmt({ proposal: proposal.id, product: proposal.product.key }),
	);
	check("S9 GET /api/reports keeps the legacy createdAt", row.createdAt === LEGACY_CREATED_AT, fmt({ createdAt: row.createdAt }));
	check("S9 the legacy issues tree is byte-for-byte unchanged", JSON.stringify(treeHashes(path.join(dataDir, "issues"))) === JSON.stringify(before));
	const count = fake.issues.filter((item) => item.body.includes(marker(legacyId))).length;
	await server.restart();
	const afterRestart = fake.issues.filter((item) => item.body.includes(marker(legacyId))).length;
	check("S9 a restart does not file the legacy report again", count === 1 && afterRestart === 1, fmt({ count, afterRestart }));
}

async function s10() {
	await sendComposer("S10 글자만 보냅니다");
	await waitChange(`/^GitHub #\\d+에 올렸습니다$/.test(document.getElementById("status")?.textContent ?? "")`, 15_000, "S10 sent status");
	const row = await reportByTitle("S10 글자만 보냅니다");
	const issue = row ? issueFor(marker(row.id)) : null;
	await shot("s10-standalone.png");
	check("S10 the standalone composer files a whole-screen report", Boolean(issue) && issue.body.includes("고른 곳: 화면 전체"), fmt({ number: issue?.number }));
}

async function s11() {
	const token = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8".slice(0, 36)}`;
	await sendComposer(`S11 비밀 ${token}`);
	await waitChange(`/^GitHub #\\d+에 올렸습니다$/.test(document.getElementById("status")?.textContent ?? "")`, 15_000, "S11 sent status");
	const row = (await reportList()).items.find((item) => item.title.startsWith("S11 비밀")) ?? null;
	const issue = row ? issueFor(marker(row.id)) : null;
	check("S11 the issue body does not carry the raw token", Boolean(issue) && !issue.body.includes(token), fmt({ redacted: Boolean(issue) && !issue.body.includes(token) }));
}

async function s12() {
	const legacy = (await reportList()).items.find((row) => row.title === LEGACY_TEXT);
	const res = await fetch(server.base + `/issues/${legacy.id}`, { redirect: "manual" });
	check("S12 /issues/<legacy uuid> redirects to /issues", res.status === 302 && res.headers.get("location") === "/issues", fmt({ status: res.status, location: res.headers.get("location") }));
}

async function s13() {
	await server.stop();
	const home = freshHome("home-warm");
	const env = { INBOX_GITHUB_API: fake.url, INBOX_PUSH_SINK: pushSink, INBOX_REOPEN_SINK: reopenSink, PATH: qaPath() };
	server = await startInboxServer({ app: APP, port: PORT, home, env });
	const warm = await waitHost(async () => {
		const list = await reportList();
		return typeof list.statesAt === "string" && list.items.length === 0 ? list : null;
	}, 10_000, "S13 warm empty state cache");
	await openPage("/issues", `document.getElementById("empty") && !document.getElementById("empty").hidden`, "S13 empty list");
	const sid = "qa-report-warm";
	await postJson(`/api/threads/${sid}/meta`, { title: "S13 대화", product: "omo-inbox", branch: "main", firstRequest: "S13 확인" });
	await postJson(`/api/threads/${sid}/items`, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s13:1", raw: { text: "S13 확인용 항목", request: "S13 확인" } });
	await cdp("Page.addScriptToEvaluateOnNewDocument", {
		source: `window.__rowStates = []; new MutationObserver(() => { queueMicrotask(() => { const node = document.querySelector("#list .row .state"); if (!node) return; const text = node.textContent; if (window.__rowStates[window.__rowStates.length - 1] !== text) window.__rowStates.push(text); }); }).observe(document, { subtree: true, childList: true, characterData: true });`,
	});
	await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
	await openPage(`/s/${sid}`, `location.pathname === "/s/${sid}" && window.__inboxReporter && document.getElementById("title")`, "S13 thread");
	await ev(`window.__inboxReporter.openFor(document.getElementById("title"))`);
	await waitChange(`document.querySelector("dialog[open] #report-description") !== null`, 8000, "S13 composer");
	await fill("dialog[open] #report-description", "S13 따뜻한 상태 캐시");
	await waitChange(`!document.querySelector("dialog[open] [data-action=send]").disabled`, 5000, "S13 send enabled");
	await click("dialog[open] [data-action=send]");
	await waitChange(`/^GitHub #\\d+에 올렸습니다$/.test(document.querySelector("dialog[open] .report__status")?.textContent ?? "")`, 20_000, "S13 composer number");
	const status = await textOf("dialog[open] .report__status");
	const number = Number(/GitHub #(\d+)/.exec(status)?.[1]);
	const row = await reportByTitle("S13 따뜻한 상태 캐시");
	await view.navigate(server.base + "/issues");
	await waitChange(`document.querySelector('.row[data-id="${row.id}"] .state')?.textContent === "#${number} 열림"`, 10_000, "S13 warm row open");
	await shot("s13-warm-cache.png");
	const states = await ev("window.__rowStates");
	const bare = states.filter((text) => text !== null && /^#\d+$/.test(String(text).trim()));
	check("S13 a warm cache renders #n 열림 and never a bare #n", states.includes(`#${number} 열림`) && bare.length === 0, fmt({ states, bare, statesAt: warm.statesAt }));
}

/* ---------- run and teardown ---------- */

let failure = null;
const cleanup = { serverStopped: false, fakeStopped: false, browserClosed: false, portClosed: false, removed: [], scratch: null };
try {
	pushSink = path.join(scratch, "push.jsonl");
	reopenSink = path.join(scratch, "reopen.jsonl");
	server = await startInboxServer({
		app: APP,
		port: PORT,
		home: freshHome("home-main"),
		env: { INBOX_GITHUB_API: fake.url, INBOX_PUSH_SINK: pushSink, INBOX_REOPEN_SINK: reopenSink, PATH: qaPath() },
	});
	view = new Bun.WebView({ width: 1280, height: 800 });
	await subscribePush();
	await s1();
	await s2();
	await s3();
	await s4();
	await s5();
	await s6();
	await s7();
	await s8();
	await s9();
	await s10();
	await s11();
	await s12();
	await s13();
} catch (error) {
	failure = error;
	console.error(error && error.stack ? error.stack : String(error));
	try {
		const logs = server?.logs;
		if (logs) {
			for (const [name, file] of Object.entries(logs)) {
				if (fs.existsSync(file)) fs.copyFileSync(file, path.join(OUT, `server-${name}.log`));
			}
		}
	} catch {
		// evidence is best effort on failure
	}
} finally {
	try {
		if (view) {
			await view.close();
			cleanup.browserClosed = true;
		}
	} catch {
		cleanup.browserClosed = false;
	}
	try {
		if (server) {
			await server.stop();
			cleanup.serverStopped = true;
		}
	} catch (error) {
		cleanup.serverStopError = error && error.message ? error.message : String(error);
	}
	try {
		cleanup.portClosed = await tcpClosed(PORT);
	} catch {
		cleanup.portClosed = false;
	}
	try {
		await fake.stop();
		cleanup.fakeStopped = true;
	} catch (error) {
		cleanup.fakeStopError = error && error.message ? error.message : String(error);
	}
	try {
		fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		cleanup.removed.push(scratch);
		cleanup.scratch = fs.existsSync(scratch) ? "PRESENT" : "ENOENT";
	} catch (error) {
		cleanup.scratch = `ERROR:${error && error.code ? error.code : String(error)}`;
	}
	const passed = checks.filter((item) => item.ok).length;
	fs.writeFileSync(path.join(OUT, "cleanup.json"), JSON.stringify({ ...cleanup, failure: failure ? String(failure.stack ?? failure) : null, checks, passed, total: checks.length }, null, "\t"));
	console.log(`cleanup: server=${cleanup.serverStopped} fake=${cleanup.fakeStopped} browser=${cleanup.browserClosed} portClosed=${cleanup.portClosed} scratch=${cleanup.scratch}`);
	console.log(`${passed}/${checks.length} checks passed`);
	if (passed !== checks.length || failure !== null) process.exitCode = 1;
}
