/* Real-browser QA for the omo-inbox pages (plan todo 26): the threads list at /, the thread chat at /s/<sid>, the old
 * proposal list at /boards, the proposal page's ‹ 대화 link, and the service worker's handleClick run in Node.
 *
 * Usage: bun qa/inbox-qa.mjs [app dir, default the repo] [output dir, default a new temp dir]
 * Starts <app>/src/server.mjs on a temp OMO_INBOX_HOME (port 4394, INBOX_NO_TAILSCALE=1, would-be pushes go to the
 * INBOX_PUSH_SINK file), seeds three session threads, a notice and a board through the session API, then drives one
 * Bun.WebView through CDP: phone 390x844 with touch, then desktop 1280x800. Todo 17 adds an episode thread (8 progress
 * lines, the newest waiting on a desk board, then the final): the gray lines, the 과정 보기 toggle, the board link, the
 * final's 원문 with a 500 then a retry, the lite thread payload and a 200-item thread GET timed once. Screenshots
 * (task-26-*.png; task-17-*.png light and dark) and the service worker check output (task-26-sw.txt) land in the output
 * dir; the temp home is deleted at the end. Todo 19 adds the owner's request bubble above an episode's lines: one above
 * the first line, one where a line's request changes, none when a phone message already says it, long text clipped to
 * 6 lines until a tap (task-19-*.png).
 * Exit 0 only when every check passes; the last line is `N/N checks passed`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PORT = 4394;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "inbox-qa-out-"));
const PREFIX = "task-26-";
const PREFIX17 = "task-17-";
const PREFIX19 = "task-19-";
const A = "qa-sess-a";
const B = "qa-sess-b";
const C = "qa-sess-c";
// todo 17: an episode of 8 long Markdown messages (one gray line each; the 8th is also the final) and a 200-item thread.
const D = "qa-sess-d";
const P = "qa-sess-p";
const EP_REQUEST = "결제 화면을 고치고 보드를 올려 줘";
// todo 19: the request changes at line 5 of the episode, so a second owner bubble sits above that line.
const EP_REQUEST_2 = "보드는 올리지 말고 결제 화면만 고쳐 줘";
// todo 19: thread R, where the request arrives from the phone first (already a bubble), then changes to an 8-line one.
const R = "qa-sess-r";
const R_REQUEST = "환불 화면도 같이 봐 줘";
const R_REQUEST_LONG = ["여기부터는 순서대로 해 줘:", "1. 결제 화면의 버튼 색을 맞춰", "2. 영수증 화면의 글자 크기를 키워", "3. 환불 화면의 날짜 형식을 고쳐", "4. 쿠폰 화면의 정렬을 바꿔", "5. 알림 화면의 문구를 줄여", "6. 설정 화면의 토글을 정리해", "7. 마지막으로 전체 스크린샷을 올려 줘"].join("\n");
const R_OPENER = 1760000200000;
const R_KEY = `e:${R}:${R_OPENER}`;
const EP_OPENER = 1760000000000;
const EP_KEY = `e:${D}:${EP_OPENER}`;
const EP_OPENED_AT = new Date(EP_OPENER).toISOString();
const EP_BOARD = { id: "b-qa-17", title: "결제 화면 초안", url: "https://desk.example-tailnet.ts.net/p/b-qa-17" };
const EP_STAMP = (n) => EP_OPENER + n * 1000;
// One newline-free 3000+ char paragraph per message, carrying its marker; the thread payload must never hold it.
const EP_FILLER = (n) => `episode-msg-0${n} 결제 화면 ${n}단계 작업 기록 payload-guard-${n} `.repeat(70).trim();
const EP_CHUNK = (n) => EP_FILLER(n).slice(1000, 2000);
const EP_TEXT = (n) => [`${n}번째 메시지: 결제 화면 ${n}단계를 고쳤습니다.`, "", `## ${n}단계에서 바꾼 것`, "", `**중요**: \`pay-step-${n}\` 파일을 바꿨습니다.`, "", `- 항목 하나 episode-msg-0${n}-a`, `- 항목 둘 episode-msg-0${n}-b`, "", EP_FILLER(n)].join("\n");
const EP_TEXTS = Array.from({ length: 8 }, (_, i) => EP_TEXT(i + 1));
const WAITING_SUFFIX = " · 기다리는 중: Review 답";
const XSS = "<img src=x onerror=alert(1)> 이 문장은 그대로 보여야 합니다. <b>굵게</b>";
const EMPTY_LIST_TEXT = "기다리는 세션이 없습니다";
const NOT_LIVE_TEXT = "세션이 꺼져 있어 지금은 만들 수 없습니다";
const EXPLAINING_TEXT = "더 쉬운 설명을 만드는 중";
const SENDING_TEXT = "보내는 중";
const COMMENT = "테스트는 나중에 추가해 줘";
const FREE_MESSAGE = "고마워, 이어서 해 줘";
const SIMPLER = {
	kind: "question",
	headline: "커밋을 두 개로 나눌까요?",
	context: "결제 모듈 변경을 커밋하려는 중",
	body: "바꾼 내용을 기능과 테스트로 나눠 두 번 저장하는 방법을 권합니다. 예를 들어 첫 커밋은 결제 화면, 둘째 커밋은 그 테스트입니다.",
	ask: "어떻게 나눌지 골라 주세요",
	options: [],
	ifNoAnswer: "10분 뒤 에이전트가 두 커밋으로 진행합니다",
	terms: [{ term: "커밋", meaning: "바꾼 내용을 한 덩어리로 저장하는 것" }],
};

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (o) => JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));

// ---------- the service worker checks, run by node with a stubbed self (todo 23) ----------

const SW_CHECK = `import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const swUrl = pathToFileURL(process.argv[2]).href;
const out = [];
let failed = 0;
function check(name, fn) {
	try {
		fn();
		out.push("ok   " + name);
	} catch (error) {
		failed++;
		out.push("FAIL " + name + ": " + error.message);
	}
}
const clientsOf = (opened, windows) => ({ matchAll: async () => windows || [], openWindow: async (u) => { opened.push(u); }, scope: "https://inbox.test/" });

delete globalThis.self;
const { handleClick } = await import(swUrl + "?plain");
check("handleClick is a named export and importing registers nothing", () => assert.equal(typeof handleClick, "function"));
{
	const calls = [];
	const opened = [];
	const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
	const res = await handleClick({ itemId: "i-260101-abc123", url: "/s/sess-1#i-260101-abc123", rec: { questionId: "q1", label: "두 커밋" } }, "rec", fetchImpl, clientsOf(opened));
	check("rec posts exactly once to the item answer route", () => { assert.equal(calls.length, 1); assert.equal(calls[0].url, "/api/items/i-260101-abc123/answer"); });
	check("rec sends POST, x-inbox: 1, keepalive and the C8 answer body", () => { assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.headers["x-inbox"], "1"); assert.equal(calls[0].init.keepalive, true); assert.deepEqual(JSON.parse(calls[0].init.body), { answers: { q1: { selected: ["두 커밋"] } } }); });
	check("rec opens no window and reports answered", () => { assert.deepEqual(opened, []); assert.deepEqual(res, { answered: true, opened: false, url: "https://inbox.test/s/sess-1#i-260101-abc123" }); });
}
{
	const opened = [];
	const res = await handleClick({ itemId: "i-1", url: "/s/sess-1#i-1", rec: { questionId: "q1", label: "A" } }, "rec", async () => ({ ok: false, status: 409 }), clientsOf(opened));
	check("a 409 from answer opens the thread instead", () => { assert.deepEqual(opened, ["https://inbox.test/s/sess-1#i-1"]); assert.equal(res.answered, false); assert.equal(res.opened, true); });
}
{
	const opened = [];
	await handleClick({ itemId: "i-1", url: "/s/sess-1#i-1", rec: { questionId: "q1", label: "A" } }, "rec", async () => { throw new Error("offline"); }, clientsOf(opened));
	check("an offline answer opens the thread instead", () => assert.deepEqual(opened, ["https://inbox.test/s/sess-1#i-1"]));
}
{
	const focused = [];
	const opened = [];
	const windows = [
		{ url: "https://inbox.test/boards", focus: async () => focused.push("boards") },
		{ url: "https://inbox.test/s/sess-1?x=1#i-1", focus: async () => focused.push("thread") },
	];
	const res = await handleClick({ url: "/s/sess-1?x=1#i-1" }, "open", null, clientsOf(opened, windows));
	check("open focuses the window already showing the thread and opens none", () => { assert.deepEqual(focused, ["thread"]); assert.deepEqual(opened, []); assert.equal(res.focused, true); });
}
{
	const opened = [];
	await handleClick({ url: "/s/sess-1#i-1" }, "open", null, clientsOf(opened, [{ url: "https://inbox.test/", focus: async () => {} }]));
	check("open opens the thread when no window shows it", () => assert.deepEqual(opened, ["https://inbox.test/s/sess-1#i-1"]));
}
{
	const opened = [];
	const calls = [];
	await handleClick({ itemId: "i-1", url: "/s/sess-1#i-1", rec: { questionId: "q1", label: "A" } }, "", async (...a) => { calls.push(a); return { ok: true }; }, clientsOf(opened));
	check("a body tap opens the thread and never answers", () => { assert.deepEqual(opened, ["https://inbox.test/s/sess-1#i-1"]); assert.equal(calls.length, 0); });
}
{
	const opened = [];
	await handleClick({ itemId: "i-1", url: "/s/sess-1#i-1", rec: { questionId: "q1" } }, "rec", async () => ({ ok: true }), clientsOf(opened));
	check("a rec without a label falls back to open", () => assert.deepEqual(opened, ["https://inbox.test/s/sess-1#i-1"]));
}
{
	const listeners = {};
	const notifications = [];
	const badges = [];
	const opened = [];
	const focused = [];
	const fetchCalls = [];
	let closed = false;
	globalThis.self = {
		addEventListener: (type, handler) => { listeners[type] = handler; },
		registration: {
			scope: "https://inbox.test/",
			showNotification: async (title, options) => { notifications.push({ title, options }); },
			setAppBadge: (n) => { badges.push(n); },
		},
		clients: { claim: async () => {}, matchAll: async () => [{ url: "https://inbox.test/s/sess-1#i-1", focus: async () => focused.push(1) }], openWindow: async (u) => { opened.push(u); } },
		skipWaiting: () => {},
	};
	globalThis.fetch = async (url, init) => { fetchCalls.push({ url, init }); return { ok: true, status: 200 }; };
	await import(swUrl + "?stub");
	check("a worker context registers install, activate, push and notificationclick", () => assert.deepEqual(Object.keys(listeners).sort(), ["activate", "install", "notificationclick", "push"]));
	const payload = { title: "🙋 결제 모듈 커밋 방식", body: "커밋을 어떻게 나눌지 정해 주세요", tag: "s-sess-1", renotify: true, url: "/s/sess-1#i-1", itemId: "i-1", actions: [{ action: "rec", title: "권장: 두 커밋" }, { action: "open", title: "열기" }], rec: { questionId: "q1", label: "두 커밋" }, badge: 3 };
	let waits = [];
	listeners.push({ data: { json: () => payload }, waitUntil: (p) => waits.push(p) });
	await Promise.all(waits);
	check("push shows the payload title, tag, renotify, both actions and the click data", () => { const n = notifications[0]; assert.equal(n.title, payload.title); assert.equal(n.options.body, payload.body); assert.equal(n.options.tag, "s-sess-1"); assert.equal(n.options.renotify, true); assert.deepEqual(n.options.actions.map((a) => a.action), ["rec", "open"]); assert.deepEqual(n.options.data, { url: "/s/sess-1#i-1", itemId: "i-1", rec: { questionId: "q1", label: "두 커밋" } }); });
	check("push sets the app badge from the payload", () => assert.deepEqual(badges, [3]));
	waits = [];
	listeners.notificationclick({ notification: { close: () => { closed = true; }, data: notifications[0].options.data }, action: "rec", waitUntil: (p) => waits.push(p) });
	await Promise.all(waits);
	check("notificationclick rec closes the notification, posts the answer through the worker fetch and opens no window", () => { assert.equal(closed, true); assert.equal(fetchCalls.length, 1); assert.equal(fetchCalls[0].url, "/api/items/i-1/answer"); assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { answers: { q1: { selected: ["두 커밋"] } } }); assert.deepEqual(opened, []); });
	waits = [];
	listeners.notificationclick({ notification: { close: () => {}, data: { url: "/s/sess-1#i-1", itemId: "i-1", rec: null } }, action: "open", waitUntil: (p) => waits.push(p) });
	await Promise.all(waits);
	check("notificationclick open focuses the thread window and sends no answer", () => { assert.deepEqual(focused, [1]); assert.equal(fetchCalls.length, 1); });
	waits = [];
	listeners.notificationclick({ notification: { close: () => {}, data: { url: "/s/other#i-9", itemId: "i-9", rec: null } }, action: "", waitUntil: (p) => waits.push(p) });
	await Promise.all(waits);
	check("a body tap for another thread opens it", () => assert.deepEqual(opened, ["https://inbox.test/s/other#i-9"]));
}
out.push(failed === 0 ? "ALL SW CHECKS PASSED" : failed + " SW CHECK(S) FAILED");
console.log(out.join("\\n"));
process.exit(failed === 0 ? 0 : 1);
`;

// ---------- temp home, server, seeding ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-qa-"));
const home = path.join(tmp, "home");
const boardDir = path.join(tmp, "board");
const cwd = path.join(tmp, "work");
const sink = path.join(tmp, "push.jsonl");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.cpSync(path.join(APP, "skill", "example"), boardDir, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));

async function api(method, route, body) {
	const res = await fetch(base + route, { method, headers: method === "POST" ? POST : { accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	let json = null;
	try {
		json = await res.json();
	} catch {
		json = null;
	}
	return { status: res.status, json };
}
async function must(method, route, body) {
	const res = await api(method, route, body);
	if (res.status !== 200) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(res.json)}`);
	return res.json;
}
// /api/here marks the session live for 90 s, which makes its thread 진행 중 and lets 더 쉽게 go through.
const prime = (sid) => must("GET", `/api/here?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sid)}`);
// A send to a thread whose session is off opens the reopen sheet; answer it with 나중에 전달 (store now, deliver on reopen).
const laterOnSheet = async () => {
	await waitFor("document.querySelector('.sheet [data-sheet=\"later\"]')", 5000, "reopen sheet");
	const later = await rectOf('.sheet [data-sheet="later"]');
	await tap(later.cx, later.cy);
};
const eventsOf = async (sid) => (await must("GET", `/api/threads/${encodeURIComponent(sid)}`)).events;
const answersOf = async (sid, itemId) => (await eventsOf(sid)).filter((event) => event.type === "answer" && event.itemId === itemId).map((event) => ({ seq: event.seq, payload: event.payload }));
const itemsOf = async (sid) => (await must("GET", `/api/threads/${encodeURIComponent(sid)}`)).items;
function mailbox(sid, itemId) {
	const dir = path.join(home, "mailbox", sid);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((file) => file.startsWith(`${itemId}-`))
		.sort()
		.map((file) => ({ file, ...JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) }));
}

const question = (requestId, header, text, options, required) => ({
	requestId,
	questions: [{ id: "q1", header, question: text, options, multiSelect: false }],
	waitForAnswer: true,
	required,
	timeoutMs: required ? 0 : 600000,
	askedAt: new Date().toISOString(),
});

async function seed() {
	await must("POST", `/api/threads/${A}/meta`, { title: "결제 모듈 커밋 방식", product: "omo-inbox", branch: "feat/pay", firstRequest: "결제 모듈을 기능과 테스트로 나눠서 커밋해 줘" });
	// the board first, so the questions stay the newest open needs-you items of thread A
	const board = await must("POST", "/api/proposals", {
		cwd,
		identity: { product: { key: "omo-inbox", name: "omo-inbox", remote: null }, feature: { key: "omo-inbox#feat/pay", branch: "feat/pay", worktree: cwd }, session: { id: A, file: null } },
		title: "수강권 확인 흐름",
		srcDir: boardDir,
	});
	const q1 = await must("POST", `/api/threads/${A}/items`, {
		kind: "question",
		policy: "needs-you",
		dedupeKey: "q:req-a1",
		raw: {
			text: "결제 모듈 변경이 끝났습니다. 커밋을 어떻게 나눌지 정해 주세요.",
			request: question("req-a1", "커밋 방식", "커밋을 어떻게 나눌까요?", [
				{ label: "두 커밋", description: "기능과 테스트로 나눕니다 (권장)" },
				{ label: "한 커밋", description: "모두 한 번에 넣습니다" },
				{ label: "세 커밋", description: "기능, 테스트, 문서로 나눕니다" },
			], false),
		},
	});
	const q2 = await must("POST", `/api/threads/${A}/items`, {
		kind: "question",
		policy: "needs-you",
		dedupeKey: "q:req-a2",
		raw: {
			text: "커밋 뒤에 테스트를 돌릴지 정해 주세요.",
			request: question("req-a2", "테스트", "커밋 뒤에 테스트를 돌릴까요?", [{ label: "돌린다", description: "3분쯤 걸립니다" }, { label: "건너뛴다", description: "나중에 돌립니다" }], true),
		},
	});
	await must("POST", `/api/threads/${A}/cache`, { warmUntil: Date.now() + 12 * 60_000, ttlSec: 3600 });

	await must("POST", `/api/threads/${B}/meta`, { title: "README 정리", product: "omo-inbox", branch: "docs", firstRequest: "README를 읽기 쉽게 정리해 줘" });
	const xss = await must("POST", `/api/threads/${B}/items`, { kind: "turn", policy: "needs-you", dedupeKey: "turn:b:1", raw: { text: XSS, request: "xss 확인" } });
	await must("POST", `/api/items/${xss.item.id}/close`, { reason: "answered-terminal", resolvedBy: "terminal" });
	const report = await must("POST", `/api/threads/${B}/items`, {
		kind: "turn",
		policy: "needs-you",
		dedupeKey: "turn:b:2",
		raw: { text: "README 1장과 2장을 다시 썼습니다. 설치 절차는 표로 바꿨고 예제는 세 개로 줄였습니다.\n\n## 바꾼 것\n- **설치 절차**는 표로 바꿨습니다\n- 예제는 `npm test` 하나로 줄였습니다\n\n| 장 | 상태 |\n|---|---|\n| 1장 | 끝 |\n| 2장 | 끝 |\n\n3장도 같은 식으로 정리할까요?", request: "README를 읽기 쉽게 정리해 줘" },
	});

	await must("POST", `/api/threads/${C}/meta`, { title: "테스트 정리", product: "omo-inbox", branch: "main", firstRequest: "테스트 파일을 폴더별로 정리해 줘" });
	const progress = await must("POST", `/api/threads/${C}/items`, { kind: "progress", policy: "progress", dedupeKey: "turn:c:1", raw: { text: "테스트 파일 3개를 옮겼고 나머지를 보는 중입니다.", request: "테스트 파일을 폴더별로 정리해 줘" } });

	const notice = await must("POST", "/api/notices", { v: 1, producer: "keepwarm", dedupeKey: "cache:qa-sess-a", title: "캐시가 5분 뒤 식습니다", body: "지금 한 턴을 보내면 캐시를 유지합니다.", urgency: "soon", url: `/s/${A}` });
	return { boardId: board.summary.id, owner: board.summary.owner, q1: q1.item.id, q2: q2.item.id, xss: xss.item.id, report: report.item.id, progress: progress.item.id, notice: notice.item.id };
}

// todo 17: the episode thread D (8 progress lines with the real line keys and episode meta; the newest waits on a desk board).
// todo 19: lines 1-4 carry the opener request, lines 5-8 the changed one.
async function seedEpisode() {
	await must("POST", `/api/threads/${D}/meta`, { title: "결제 화면 수정", product: "omo-inbox", branch: "feat/pay-ui", firstRequest: EP_REQUEST });
	const lineItems = [];
	for (let n = 1; n <= 8; n++) {
		const out = await must("POST", `/api/threads/${D}/items`, {
			kind: "progress",
			policy: "progress",
			dedupeKey: `line:${D}:m${EP_STAMP(n)}`,
			raw: { text: EP_TEXTS[n - 1], request: n <= 4 ? EP_REQUEST : EP_REQUEST_2 },
			meta: { episode: { key: EP_KEY, opener: EP_OPENER, openedAt: EP_OPENED_AT, seq: n } },
		});
		lineItems.push(out.item);
	}
	const newest = lineItems[7].id;
	await must("POST", `/api/items/${newest}/state`, { state: "waiting", reasons: ["omo-desk"], boards: [EP_BOARD] });
	return { lines: lineItems.map((item) => item.id), lineItems, newest, final: null };
}

// The episode final: the 8th message again, with the 8th line's stamp, so the episode route lists 7 lines and this final.
async function postFinal() {
	const out = await must("POST", `/api/threads/${D}/items`, {
		kind: "turn",
		policy: "needs-you",
		dedupeKey: `episode:${D}:${EP_OPENER}:needs-you:m${EP_STAMP(8)}`,
		raw: { final: EP_TEXTS[7], request: EP_REQUEST, lastRequest: EP_REQUEST_2 },
		meta: { episode: { key: EP_KEY, opener: EP_OPENER, openedAt: EP_OPENED_AT, closedAt: Date.now(), closeReason: "needs-you", lines: 8, turns: 1, interjections: 0, questions: 0 } },
	});
	return out.item;
}

// A 200-line thread for the GET timing: short lines of one open episode.
async function seedBig() {
	const opener = EP_OPENER + 100_000;
	const request = "테스트 200개를 하나씩 고쳐 줘";
	await must("POST", `/api/threads/${P}/meta`, { title: "테스트 200개 수정", product: "omo-inbox", branch: "main", firstRequest: request });
	for (let n = 1; n <= 200; n++) {
		await must("POST", `/api/threads/${P}/items`, {
			kind: "progress",
			policy: "progress",
			dedupeKey: `line:${P}:m${opener + n * 1000}`,
			raw: { text: `${n}번째 테스트 파일을 고쳤습니다. 다음 파일을 봅니다.`, request },
			meta: { episode: { key: `e:${P}:${opener}`, opener, openedAt: new Date(opener).toISOString(), seq: n } },
		});
	}
}

// todo 19: thread R. The owner's request comes from the phone (a synthetic turn item carrying his bubble), two lines
// repeat that request, then a third line carries the long changed one.
async function seedR() {
	await must("POST", `/api/threads/${R}/meta`, { title: "환불 화면 수정", product: "omo-inbox", branch: "feat/refund", firstRequest: R_REQUEST });
	const message = await must("POST", `/api/threads/${R}/message`, { text: R_REQUEST });
	const lines = [];
	for (let n = 1; n <= 3; n++) {
		const out = await must("POST", `/api/threads/${R}/items`, {
			kind: "progress",
			policy: "progress",
			dedupeKey: `line:${R}:m${R_OPENER + n * 1000}`,
			raw: { text: `${n}번째 환불 화면 파일을 고쳤습니다.`, request: n <= 2 ? R_REQUEST : R_REQUEST_LONG },
			meta: { episode: { key: R_KEY, opener: R_OPENER, openedAt: new Date(R_OPENER).toISOString(), seq: n } },
		});
		lines.push(out.item.id);
	}
	return { message: message.itemId, lines };
}

// ---------- browser ----------

const listening = new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("server.json timeout")), 15000);
	const w = fs.watch(home, (_e, f) => {
		if (f === "server.json" && fs.existsSync(path.join(home, "server.json"))) {
			clearTimeout(t);
			w.close();
			resolve();
		}
	});
});
const server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], { cwd: APP, env: { ...process.env, OMO_INBOX_HOME: home, INBOX_NO_TAILSCALE: "1", INBOX_PUSH_SINK: sink }, stdout: "ignore", stderr: "ignore" });
const view = new Bun.WebView({ width: 1280, height: 800 });
// At >= 720 px a thread lives in iframe.thread (same origin), so once one is open there `ev` runs inside that frame's
// window: document, location, innerWidth, scrollY and localStorage are the thread's. evTop always runs in the top window.
let wide = false;
let inFrame = false;
const evTop = (expr) => view.evaluate(expr);
// The page CSP has no unsafe-eval, so the expression runs as an inline <script> (allowed) added to the frame's document.
const ev = (expr) => (inFrame ? view.evaluate(`(() => { const w = document.querySelector("iframe.thread").contentWindow; const s = w.document.createElement("script"); s.textContent = ${JSON.stringify(`window.__qaResult = (async () => (${expr}\n))();`)}; w.document.head.append(s); s.remove(); return w.__qaResult; })()`) : view.evaluate(expr));
const cdp = (m, p) => view.cdp(m, p || {});
const waitFor = (cond, ms, what) =>
	ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
// A tap that navigates ends the document, and an evaluate can't be awaited across that, so the arrival is polled from here.
const waitPath = async (want, ms) => {
	const t0 = performance.now();
	while (performance.now() - t0 < ms) {
		try {
			if ((await ev("location.pathname")) === want) return true;
		} catch {
			// the old document went away mid-navigation: ask again
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
};
const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 60))))");
const stable = () => ev("new Promise((resolve) => { let last = -1; let n = 0; const f = () => { if (scrollY === last) { if (++n >= 12) return resolve(true); } else { n = 0; last = scrollY; } requestAnimationFrame(f); }; f(); })");
const touch = (type, points) => cdp("Input.dispatchTouchEvent", { type, touchPoints: points });
const tap = async (x, y) => {
	await touch("touchStart", [{ x, y, id: 0 }]);
	await touch("touchEnd", []);
	await settle();
};
// two taps with nothing between them: the second lands on whatever the first handler left in place
const tapTwice = async (x, y) => {
	await touch("touchStart", [{ x, y, id: 0 }]);
	await touch("touchEnd", []);
	await touch("touchStart", [{ x, y, id: 0 }]);
	await touch("touchEnd", []);
	await settle();
};
const click = async (x, y) => {
	await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
	await settle();
};
const shot = async (name, prefix = PREFIX) => {
	const res = await cdp("Page.captureScreenshot", { format: "png" });
	const file = path.join(OUT, `${prefix}${name}`);
	fs.writeFileSync(file, Buffer.from(res.data, "base64"));
	console.log(`saved ${file}`);
};
// In the split view the rect is shifted by the iframe's own offset, so CDP pointer events land in top-window coordinates.
const rectOf = async (selector) => {
	const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, inView: r.top >= 0 && r.bottom <= innerHeight }; })()`);
	if (!inFrame) return r;
	const o = await evTop(`(() => { const b = document.querySelector("iframe.thread").getBoundingClientRect(); return { x: b.left, y: b.top }; })()`);
	return { ...r, l: r.l + o.x, t: r.t + o.y, cx: r.cx + o.x, cy: r.cy + o.y };
};
// A touch lands only inside the viewport, so a target below the fold is scrolled to the middle first.
const bringIn = async (selector) => {
	await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "center" })`);
	await stable();
};
// prefers-color-scheme for the dark screenshots; the emulation is cleared once the todo 17 shots are taken.
const dark = async () => {
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await settle();
};
const light = async () => {
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
	await settle();
};
const bringTop = async (selector) => {
	await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: "start" })`);
	await stable();
};
// Both resize helpers leave the page first: a thread or split page open across the 720 px breakpoint redirects itself.
const phone = async () => {
	await view.navigate("about:blank");
	await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	wide = false;
	inFrame = false;
};
const desktop = async () => {
	await view.navigate("about:blank");
	await cdp("Emulation.setTouchEmulationEnabled", { enabled: false });
	await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	wide = true;
	inFrame = false;
};
const section = (itemId) => `section[data-item="${itemId}"]`;
const openList = async () => {
	inFrame = false;
	await view.navigate(`${base}/`);
	await waitFor("document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') === 'false'", 15000, "list ready");
	await settle();
};
const openThread = async (sid, count, hash) => {
	inFrame = false;
	if (wide) {
		// >= 720 px: the thread opens in the split view at /?s=<sid>, inside iframe.thread; the same checks then run in that frame.
		await view.navigate(`${base}/?s=${encodeURIComponent(sid)}${hash ? `#${hash}` : ""}`);
		await waitFor(`(() => { const f = document.querySelector("iframe.thread"); try { return Boolean(f && f.contentDocument && f.contentWindow.location.pathname === ${JSON.stringify(`/s/${encodeURIComponent(sid)}`)} && f.contentDocument.readyState !== "loading"); } catch { return false; } })()`, 15000, `split iframe for ${sid} loaded`);
		inFrame = true;
	} else {
		await view.navigate(`${base}/s/${encodeURIComponent(sid)}${hash ? `#${hash}` : ""}`);
	}
	await waitFor(`document.getElementById('chat') && document.getElementById('chat').getAttribute('aria-busy') === 'false' && document.querySelectorAll('section[data-item]').length >= ${count}`, 15000, `thread ${sid} ready`);
	await settle();
};
const openBoards = async () => {
	inFrame = false;
	await waitFor("location.pathname === '/boards' && document.getElementById('list') && document.getElementById('list').getAttribute('aria-busy') === 'false' && document.querySelectorAll('#list .row').length > 0", 15000, "boards ready");
	await settle();
};

// A fresh load of a thread: about:blank first, so a same-URL navigate is a real reload.
const reopen = async (sid, count) => {
	await view.navigate("about:blank");
	await openThread(sid, count);
};

const LIST_STATE = `(() => {
	const rows = [...document.querySelectorAll("#list .row[data-session]")].map((row) => ({
		session: row.getAttribute("data-session"),
		href: row.getAttribute("href"),
		title: (row.querySelector(".title") || {}).textContent || "",
		chip: (row.querySelector(".chip") || {}).textContent || "",
		where: (row.querySelector(".where") || {}).textContent || "",
		line: (row.querySelector(".line") || {}).textContent || "",
		fire: (row.querySelector(".fire") || {}).textContent || "",
		time: (row.querySelector(".time") || {}).textContent || "",
		unread: Boolean(row.querySelector(".dot")),
	}));
	const sections = [...document.querySelectorAll("#list section.group")].map((s) => ({ status: s.getAttribute("data-status"), label: (s.querySelector("h2") || {}).textContent || "", count: (s.querySelector(".sum") || {}).textContent || "" }));
	const needs = document.getElementById("needsYou");
	const bell = document.getElementById("bell");
	const boards = document.querySelector('header a[href="/boards"]');
	return {
		path: location.pathname,
		h1: (document.querySelector("h1") || {}).textContent || "",
		title: document.title,
		needsYou: needs.hidden ? null : needs.textContent,
		bell: bell.hidden ? null : bell.textContent,
		boards: boards ? boards.firstChild.textContent.trim() : null,
		empty: (document.querySelector("#list .empty") || {}).textContent || null,
		overflow: document.documentElement.scrollWidth > window.innerWidth,
		sections,
		rows,
	};
})()`;

const HEADER = `(() => {
	const back = document.querySelector(".back");
	const where = document.querySelector("#chips .where");
	const chip = document.getElementById("statusChip");
	const fire = document.querySelector("#chips .fire");
	const measure = document.querySelector("main.chat").parentElement.getBoundingClientRect();
	const bubbles = [...document.querySelectorAll(".msg.agent .bubble")].map((b) => b.getBoundingClientRect().width);
	return {
		path: location.pathname,
		back: back ? { text: back.textContent, href: back.getAttribute("href") } : null,
		title: document.getElementById("title").textContent,
		docTitle: document.title,
		where: where ? where.textContent : "",
		chip: chip ? chip.textContent : "",
		fire: fire ? fire.textContent : "",
		quickHidden: document.getElementById("quick").hidden,
		quick: [...document.querySelectorAll("#quick button")].map((b) => b.textContent),
		sections: [...document.querySelectorAll("section[data-item]")].map((s) => s.getAttribute("data-item")),
		composeStatus: document.getElementById("composeStatus").textContent,
		reply: document.getElementById("reply").value,
		sendOn: !document.getElementById("send").disabled,
		overflow: document.documentElement.scrollWidth > window.innerWidth,
		measureW: measure.width,
		maxBubbleW: Math.max(0, ...bubbles),
	};
})()`;

// What one item's section shows: the agent bubble parts, option buttons, user bubbles, system lines and links.
const itemState = (itemId) =>
	ev(`(() => {
	const sec = document.querySelector(${JSON.stringify(section(itemId))});
	if (!sec) return null;
	const bubble = sec.querySelector(".msg.agent .bubble");
	const text = (el) => (el ? el.textContent : null);
	const pre = sec.querySelector(".raw");
	const count = (selector) => (pre ? pre.querySelectorAll(selector).length : null);
	const status = sec.querySelector(".msg.agent .status");
	const hl = sec.querySelector(".headline");
	const hlRect = hl ? hl.getBoundingClientRect() : null;
	return {
		agent: Boolean(bubble),
		kind: text(sec.querySelector(".kind")),
		headline: text(hl),
		headlineInView: hlRect ? hlRect.top >= 0 && hlRect.bottom <= innerHeight : null,
		context: text(sec.querySelector(".context")),
		body: text(sec.querySelector(".body")),
		ask: text(sec.querySelector(".ask")),
		terms: [...sec.querySelectorAll(".term")].map((s) => s.textContent),
		termsLine: Boolean(sec.querySelector(".terms")),
		noanswer: text(sec.querySelector(".noanswer")),
		status: status ? status.textContent : null,
		statusError: Boolean(status && status.classList.contains("error")),
		foot: [...sec.querySelectorAll(".foot button")].map((b) => ({ text: b.textContent, disabled: b.disabled })),
		time: text(sec.querySelector(".foot time")),
		rawHidden: pre ? pre.hidden : null,
		rawText: pre ? pre.textContent : null,
		rawChildren: pre ? pre.querySelectorAll("*").length : null,
		rawTags: pre ? [...pre.children].map((el) => el.tagName.toLowerCase()) : null,
		rawDanger: count("img, script, iframe, object, svg, b"),
		rawMd: { heading: count(".md-h"), li: count("li"), strong: count("strong"), code: count("code"), th: count("th"), td: count("td") },
		write: Boolean(sec.querySelector(".write textarea")),
		opts: [...sec.querySelectorAll(".opt")].map((o) => ({ label: text(o.querySelector(".label")), rec: o.classList.contains("rec"), star: text(o.querySelector(".star")), why: text(o.querySelector(".why")), disabled: o.disabled === true, pressed: o.getAttribute("aria-pressed") })),
		markup: bubble ? bubble.querySelectorAll("img, script").length : null,
		bold: bubble ? bubble.querySelectorAll("b").length : null,
		users: [...sec.querySelectorAll(".msg.user")].map((u) => ({ text: text(u.querySelector(".bubble")), state: text(u.querySelector(".state span")) })),
		sys: [...sec.querySelectorAll(".msg.sys .line")].map((l) => l.textContent),
		links: [...sec.querySelectorAll(".msg.sys .line a")].map((a) => a.getAttribute("href")),
		hit: Boolean(sec.querySelector(".msg.hit")),
	};
})()`);

// The 알림 받기 flow with permission granted up front: records how the page registers /sw.js and whether Chrome accepted it.
const BELL_FLOW = `(async () => {
	const calls = [];
	const original = navigator.serviceWorker.register.bind(navigator.serviceWorker);
	navigator.serviceWorker.register = (url, options) => {
		const entry = { url: String(url), options: options || null, result: null };
		calls.push(entry);
		const p = original(url, options);
		p.then(() => { entry.result = "ok"; }, (e) => { entry.result = "err: " + e.message; });
		return p;
	};
	Notification.requestPermission = () => Promise.resolve("granted");
	Object.defineProperty(Notification, "permission", { get: () => "granted", configurable: true });
	document.getElementById("bell").click();
	const t0 = performance.now();
	while (!(calls.length && calls[0].result) && performance.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
	const reg = await navigator.serviceWorker.getRegistration("/sw.js");
	const worker = reg ? reg.active || reg.waiting || reg.installing : null;
	return { calls, registered: Boolean(reg), scriptURL: worker ? worker.scriptURL : null };
})()`;
const UNREGISTER = "navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))).then((rs) => rs.length)";

// todo 17: the progress lines of the open thread, their visibility, the board links and the 과정 보기 state.
const LINES_STATE = `(() => {
	const shown = (el) => el.getClientRects().length > 0;
	const groups = [...document.querySelectorAll('section[data-kind="progress"]')].map((sec) => {
		const line = sec.querySelector(".sys.progress .line");
		return {
			item: sec.getAttribute("data-item"),
			boards: sec.hasAttribute("data-boards"),
			gray: Boolean(sec.querySelector("article.msg.sys.progress")),
			text: line ? line.textContent : null,
			lineVisible: line ? shown(line) : null,
			groupVisible: shown(sec),
			links: [...sec.querySelectorAll(".msg.sys .line a")].map((a) => ({ line: a.parentElement.textContent, href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), visible: shown(a) })),
			// todo 19: the owner's request bubble above this line, if any: where it sits, whether it is clipped to 6 lines and opened
			request: (() => {
				const bubble = sec.querySelector(".msg.user.request .bubble");
				if (!bubble) return null;
				const text = bubble.querySelector(".text");
				const lineHeight = text ? parseFloat(getComputedStyle(text).lineHeight) : 0;
				return { text: bubble.textContent, first: sec.firstElementChild === bubble.parentElement, visible: shown(bubble), right: Math.round(bubble.getBoundingClientRect().right), expanded: bubble.getAttribute("aria-expanded"), more: bubble.classList.contains("more"), lines: text && lineHeight ? Math.round(text.clientHeight / lineHeight) : null, clipped: text ? text.scrollHeight > text.clientHeight + 1 : null };
			})(),
			users: sec.querySelectorAll(".msg.user").length,
		};
	});
	const toggle = document.getElementById("progressToggle");
	return {
		groups,
		bubbles: [...document.querySelectorAll(".msg.user")].map((u) => ({ text: (u.querySelector(".bubble") || {}).textContent || "", request: u.classList.contains("request") })),
		width: window.innerWidth,
		measureRight: Math.round(document.querySelector("main.chat").parentElement.getBoundingClientRect().right),
		kinds: [...document.querySelectorAll("section[data-item]")].map((s) => s.getAttribute("data-kind")),
		toggle: toggle ? { text: toggle.textContent, pressed: toggle.getAttribute("aria-pressed") } : null,
		progress: document.getElementById("chat").getAttribute("data-progress"),
		stored: localStorage.getItem("inbox.progressLines"),
		chip: (document.getElementById("statusChip") || {}).textContent || "",
		overflow: document.documentElement.scrollWidth > window.innerWidth,
	};
})()`;

// todo 17: what the final's 원문 shows: loading / failure (+ 다시 시도) / the episode messages with their times and Markdown.
const episodeState = (itemId) =>
	ev(`(() => {
	const sec = document.querySelector(${JSON.stringify(section(itemId))});
	if (!sec) return null;
	const raw = sec.querySelector(".raw");
	const state = raw ? raw.querySelector(".ep-state") : null;
	const button = sec.querySelector('[data-action="raw"]');
	const msgs = raw ? [...raw.querySelectorAll(".ep-msg")].map((m) => {
		const at = m.querySelector(".ep-at");
		const body = m.querySelector(".ep-body");
		const text = body ? body.textContent : "";
		return { at: at ? at.textContent : null, datetime: at ? at.getAttribute("datetime") : null, text, heads: body ? body.querySelectorAll(".md-h").length : 0, strong: body ? body.querySelectorAll("strong").length : 0, code: body ? body.querySelectorAll("code").length : 0, li: body ? body.querySelectorAll("li").length : 0, literal: /##|\\*\\*/.test(text) };
	}) : [];
	return {
		kind: (sec.querySelector(".kind") || {}).textContent || null,
		rawHidden: raw ? raw.hidden : null,
		button: button ? button.textContent : null,
		state: state ? { text: state.textContent, error: state.classList.contains("error"), retry: (state.querySelector('button[data-action="episode"]') || {}).textContent || null } : null,
		msgs,
	};
})()`);

// todo 17: the first episode GET of this page answers 500 from here; later ones go through. Every call is recorded.
const EPISODE_FAIL_ONCE = `(() => {
	const original = window.fetch;
	window.__episodeCalls = [];
	window.fetch = function (input, init) {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("/episodes/") && window.__episodeCalls.push(url) === 1) return Promise.resolve(new Response("boom", { status: 500 }));
		return original.call(window, input, init);
	};
	return true;
})()`;

const typeInto = async (selector, text) => {
	const r = await rectOf(selector);
	await tap(r.cx, r.cy);
	await cdp("Input.insertText", { text });
	await settle();
};

async function runSwChecks() {
	const file = path.join(tmp, "sw-check.mjs");
	const swPath = path.join(APP, "web", "sw.js");
	fs.writeFileSync(file, SW_CHECK);
	const proc = Bun.spawn(["node", file, swPath], { cwd: tmp, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	const lines = stdout.split(/\r?\n/).filter(Boolean);
	const report = path.join(OUT, `${PREFIX}sw.txt`);
	fs.writeFileSync(report, `node sw-check.mjs ${swPath}\nexit ${code}\n\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
	console.log(`saved ${report}`);
	for (const line of lines) {
		if (line.startsWith("ok   ")) check(`sw: ${line.slice(5)}`, true);
		else if (line.startsWith("FAIL ")) check(`sw: ${line.slice(5)}`, false);
	}
	check("sw: the Node run exits 0 with its pass line", code === 0 && lines[lines.length - 1] === "ALL SW CHECKS PASSED", `exit ${code}${stderr ? ` stderr: ${stderr.trim().slice(0, 300)}` : ""}`);
}

try {
	await listening;
	// Safety: every request below must hit the server this script started on its temp home, never the live one.
	const health = await (await fetch(`${base}/api/health`)).json();
	if (health.port !== PORT || health.pid !== server.pid) throw new Error(`not our server on ${PORT}: ${fmt(health)}, spawned pid ${server.pid}`);
	console.log(`server up: ${fmt(health)} (spawned pid ${server.pid}), home ${home}`);

	// ===== phone 390, the list with nothing in it =====
	await view.navigate("about:blank");
	await phone();
	await openList();
	const empty = await ev(LIST_STATE);
	check("(L0) with zero threads the list shows the single line 기다리는 세션이 없습니다 and no 🙋 count", empty.empty === EMPTY_LIST_TEXT && empty.rows.length === 0 && empty.needsYou === null, fmt({ empty: empty.empty, rows: empty.rows.length, needsYou: empty.needsYou }));
	await shot("list-empty-390.png");

	const ids = await seed();
	const boardItem = (await itemsOf(A)).find((item) => item.kind === "board");
	ids.boardItem = boardItem ? boardItem.id : null;
	console.log(`seeded ${fmt(ids)}`);
	check("(S) the Review from skill/example is owned by thread A and became a Review item there", ids.owner === A && Boolean(ids.boardItem) && boardItem.dedupeKey === `board:${ids.boardId}`, fmt({ boardId: ids.boardId, owner: ids.owner, boardItem: ids.boardItem }));

	// ===== phone 390, the list =====
	await prime(C);
	await openList();
	const list = await ev(LIST_STATE);
	const rowsById = Object.fromEntries(list.rows.map((row) => [row.session, row]));
	check("(L1) header: Inbox, 🙋 3, document title (3) Inbox, the Review link and the 알림 받기 button", list.h1 === "Inbox" && list.needsYou === "🙋 3" && list.title === "(3) Inbox" && list.boards === "Review" && list.bell === "알림 받기", fmt({ h1: list.h1, needsYou: list.needsYou, title: list.title, boards: list.boards, bell: list.bell }));
	check(
		"(L2) sections 내 차례 (3) then 진행 중 (1); needs-you rows oldest-waiting first, then the working one",
		fmt(list.sections.map((s) => [s.label, s.count])) === fmt([["내 차례", "3"], ["진행 중", "1"]]) && fmt(list.rows.map((r) => r.session)) === fmt([A, B, "_notices", C]),
		fmt({ sections: list.sections, order: list.rows.map((r) => r.session) }),
	);
	check(
		"(L3) chips and lines: A/B 🙋 내 차례, 알림 🔔 알림, C 🤖 진행 중; A shows omo-inbox · feat/pay and 질문 ·, C shows its headline with no 진행 · label",
		rowsById[A] && rowsById[B] && rowsById._notices && rowsById[C] && rowsById[A].chip === "🙋 내 차례" && rowsById[B].chip === "🙋 내 차례" && rowsById._notices.chip === "🔔 알림" && rowsById[C].chip === "🤖 진행 중" && rowsById[A].where === "omo-inbox · feat/pay" && rowsById[A].line.startsWith("질문 · ") && rowsById[C].line.startsWith("테스트 파일 3개를 옮겼고") && rowsById._notices.title === "알림",
		fmt(list.rows.map((r) => ({ s: r.session, chip: r.chip, where: r.where, line: r.line, title: r.title }))),
	);
	check("(L4) row A shows the 🔥 countdown from its epoch-ms cacheUntil (12 minutes ahead)", /^🔥 1[12]m$/.test(rowsById[A] ? rowsById[A].fire : ""), fmt({ fire: rowsById[A] ? rowsById[A].fire : null }));
	check("(L5) unread dot and relative time 방금 on row A; row hrefs are /s/<sid>", rowsById[A] && rowsById[A].unread === true && rowsById[A].time === "방금" && rowsById[A].href === `/s/${A}` && rowsById._notices.href === "/s/_notices", fmt({ unread: rowsById[A] && rowsById[A].unread, time: rowsById[A] && rowsById[A].time, hrefs: list.rows.map((r) => r.href) }));
	check("(L6) 390: no horizontal overflow", list.overflow === false, fmt({ overflow: list.overflow }));
	await shot("list-390.png");
	const bell = await ev(BELL_FLOW);
	check(
		"(L7) 알림 받기 registers /sw.js as a module worker and Chrome accepts the script",
		bell.calls.length === 1 && bell.calls[0].url === "/sw.js" && bell.calls[0].options && bell.calls[0].options.type === "module" && bell.calls[0].result === "ok" && bell.registered && /\/sw\.js$/.test(bell.scriptURL || ""),
		fmt(bell),
	);
	await ev(UNREGISTER);

	// tap into thread A
	const rowA = await rectOf(`#list .row[data-session="${A}"]`);
	await tap(rowA.cx, rowA.cy);
	const atA = await waitPath(`/s/${A}`, 5000);
	check("(L8) tapping row A opens /s/<sid>", atA, fmt({ atA }));

	// ===== phone 390, thread A =====
	await waitFor("document.getElementById('chat') && document.getElementById('chat').getAttribute('aria-busy') === 'false' && document.querySelectorAll('section[data-item]').length >= 3", 15000, "thread A ready");
	await settle();
	let head = await ev(HEADER);
	check(
		"(T1) top bar: ‹ Inbox to /, the title, omo-inbox · feat/pay, 🙋 내 차례 and 🔥; quick chips hidden while a question is newest",
		head.back && head.back.text === "‹ Inbox" && head.back.href === "/" && head.title === "결제 모듈 커밋 방식" && head.docTitle === "결제 모듈 커밋 방식 · Inbox" && head.where === "omo-inbox · feat/pay" && head.chip === "🙋 내 차례" && /^🔥 1[0-2]m$/.test(head.fire) && head.quickHidden === true && fmt(head.sections) === fmt([ids.boardItem, ids.q1, ids.q2]),
		fmt(head),
	);
	const boardState = await itemState(ids.boardItem);
	check("(T2) the board item shows the Review chip and a Review · 열기 line linking to its proposal page", boardState && boardState.kind === "Review" && boardState.sys.includes("Review · 열기") && boardState.links.includes(`/p/${ids.boardId}`), fmt(boardState && { kind: boardState.kind, sys: boardState.sys, links: boardState.links }));
	const q1a = await itemState(ids.q1);
	check(
		"(T3) question bubble: 질문 chip, headline, 하던 일 context, three full-width options with ★권장 두 커밋 first and its why line, 직접 쓰기, 답이 없으면 line, 듣기 / 원문 보기 / 더 쉽게 and the time",
		q1a && q1a.kind === "질문" && q1a.headline.length > 0 && String(q1a.context).startsWith("하던 일 · ") && q1a.opts.length === 3 && q1a.opts[0].label === "두 커밋" && q1a.opts[0].rec === true && q1a.opts[0].star === "★권장" && String(q1a.opts[0].why).includes("권장") && q1a.opts.every((o) => !o.disabled) && q1a.write === true && String(q1a.noanswer).includes("답이 없으면") && fmt(q1a.foot.map((b) => b.text)) === fmt(["듣기", "원문 보기", "더 쉽게"]) && q1a.time === "방금" && q1a.markup === 0,
		fmt(q1a && { kind: q1a.kind, headline: q1a.headline, context: q1a.context, opts: q1a.opts, write: q1a.write, noanswer: q1a.noanswer, foot: q1a.foot, time: q1a.time }),
	);
	await ev("window.scrollTo(0, 0)");
	await stable();
	await shot("thread-a-390.png");

	// 원문 보기 toggle
	const rawSel = `${section(ids.q1)} [data-action="raw"]`;
	await bringIn(rawSel);
	let r = await rectOf(rawSel);
	await tap(r.cx, r.cy);
	const rawOpen = await itemState(ids.q1);
	await bringIn(rawSel);
	r = await rectOf(rawSel);
	await tap(r.cx, r.cy);
	const rawClosed = await itemState(ids.q1);
	check(
		"(T4) 원문 보기 opens the question as a paragraph and its options as a list, the button reads 원문 닫기, and a second tap hides it again",
		rawOpen.rawHidden === false && String(rawOpen.rawText).includes("커밋 방식: 커밋을 어떻게 나눌까요?") && String(rawOpen.rawText).includes("두 커밋: 기능과 테스트로 나눕니다 (권장)") && fmt(rawOpen.rawTags) === fmt(["p", "p", "ul"]) && rawOpen.rawMd.li === 3 && rawOpen.foot[1].text === "원문 닫기" && rawClosed.rawHidden === true && rawClosed.foot[1].text === "원문 보기",
		fmt({ open: { hidden: rawOpen.rawHidden, children: rawOpen.rawChildren, button: rawOpen.foot[1].text, text: String(rawOpen.rawText).slice(0, 80) }, closed: { hidden: rawClosed.rawHidden, button: rawClosed.foot[1].text } }),
	);

	// 더 쉽게 without a live session
	const explainSel = `${section(ids.q1)} [data-action="explain"]`;
	await bringIn(explainSel);
	r = await rectOf(explainSel);
	await tap(r.cx, r.cy);
	await waitFor(`(document.querySelector(${JSON.stringify(`${section(ids.q1)} .msg.agent .status`)}) || {}).textContent === ${JSON.stringify(NOT_LIVE_TEXT)}`, 5000, "not-live reason").catch(() => {});
	const notLive = await itemState(ids.q1);
	check("(T5) 더 쉽게 while the session is not live: a 409 keeps the reason in the bubble and unlocks the button", notLive.status === NOT_LIVE_TEXT && notLive.statusError === true && notLive.foot[2].disabled === false && mailbox(A, ids.q1).length === 0, fmt({ status: notLive.status, error: notLive.statusError, button: notLive.foot[2], mailbox: mailbox(A, ids.q1).length }));

	// 더 쉽게 with the session live: explain mailbox file, 만드는 중 until the posted simpler summary shows
	await prime(A);
	await bringIn(explainSel);
	r = await rectOf(explainSel);
	await tap(r.cx, r.cy);
	await waitFor(`(document.querySelector(${JSON.stringify(`${section(ids.q1)} .msg.agent .status`)}) || {}).textContent === ${JSON.stringify(EXPLAINING_TEXT)}`, 5000, "explaining").catch(() => {});
	const explaining = await itemState(ids.q1);
	const explainFiles = mailbox(A, ids.q1).filter((entry) => entry.type === "explain");
	check("(T6a) 더 쉽게 with the session live: 더 쉬운 설명을 만드는 중, the button locked, one explain mailbox file for the item", explaining.status === EXPLAINING_TEXT && explaining.statusError === false && explaining.foot[2].disabled === true && explainFiles.length === 1 && explainFiles[0].itemId === ids.q1, fmt({ status: explaining.status, button: explaining.foot[2], files: explainFiles.map((f) => ({ file: f.file, type: f.type, itemId: f.itemId })) }));
	await must("POST", `/api/items/${ids.q1}/summary`, { text: JSON.stringify(SIMPLER), model: "qa/stub", simpler: true });
	await waitFor(`!document.querySelector(${JSON.stringify(`${section(ids.q1)} .msg.agent .status`)}) && document.querySelectorAll(${JSON.stringify(`${section(ids.q1)} .term`)}).length === 1`, 8000, "simpler summary rendered").catch(() => {});
	const simpler = await itemState(ids.q1);
	check(
		"(T6b) the next poll shows the simpler summary: headline, 하던 일, body, term button, no 용어 line, 답이 없으면 line, the status gone and 더 쉽게 unlocked",
		simpler.status === null && simpler.headline === SIMPLER.headline && simpler.context === `하던 일 · ${SIMPLER.context}` && simpler.body === `권장: 두 커밋. ${SIMPLER.body}` /* the server names the option marked (권장) when the summary does not */ && fmt(simpler.terms) === fmt(["커밋"]) && simpler.termsLine === false && simpler.noanswer === "10분 안에 답이 없으면 에이전트가 스스로 판단해 진행합니다" /* the server replaces the model's line with the runtime fact (todo 48) */ && simpler.foot[2].disabled === false,
		fmt({ status: simpler.status, headline: simpler.headline, context: simpler.context, body: simpler.body, terms: simpler.terms, termsLine: simpler.termsLine, noanswer: simpler.noanswer, button: simpler.foot[2] }),
	);

	// option tap, twice in a row, then once more on the locked option
	const optSel = `${section(ids.q1)} .opt[data-label="두 커밋"]`;
	await prime(A);
	await bringIn(optSel);
	r = await rectOf(optSel);
	await tapTwice(r.cx, r.cy);
	await waitFor(`document.querySelectorAll(${JSON.stringify(`${section(ids.q1)} .msg.user`)}).length === 1 && !document.querySelector(${JSON.stringify(`${section(ids.q1)} .opt:not(:disabled)`)})`, 8000, "answer bubble").catch(() => {});
	const answered = await itemState(ids.q1);
	const answers1 = await answersOf(A, ids.q1);
	const files1 = mailbox(A, ids.q1).filter((entry) => entry.type === "item-answer");
	check(
		"(T7) ★권장 tap: one yellow user bubble 두 커밋 marked 보내는 중, the options locked with 두 커밋 pressed, exactly one answer event and one mailbox item-answer file carrying requestId and the label",
		answered.users.length === 1 && answered.users[0].text === "두 커밋" && answered.users[0].state === SENDING_TEXT && answered.opts.length === 3 && answered.opts.every((o) => o.disabled) && answered.opts[0].pressed === "true" && answers1.length === 1 && fmt(answers1[0].payload) === fmt({ answers: { q1: { selected: ["두 커밋"] } } }) && files1.length === 1 && files1[0].type === "item-answer" && files1[0].kind === "question" && files1[0].requestId === "req-a1" && fmt(files1[0].payload) === fmt({ answers: { q1: { selected: ["두 커밋"] } } }) && typeof files1[0].deliveryId === "string" && files1[0].text === "커밋 방식: 두 커밋",
		fmt({ users: answered.users, opts: answered.opts.map((o) => [o.label, o.disabled, o.pressed]), answers: answers1, files: files1.map((f) => ({ file: f.file, requestId: f.requestId, payload: f.payload, text: f.text })) }),
	);
	await bringIn(optSel);
	r = await rectOf(optSel);
	await tap(r.cx, r.cy);
	await settle();
	const answers1b = await answersOf(A, ids.q1);
	const files1b = mailbox(A, ids.q1).filter((entry) => entry.type === "item-answer");
	check("(T8) a second tap on the locked option sends nothing: still exactly one answer event and one mailbox item-answer file", answers1b.length === 1 && files1b.length === 1, fmt({ answers: answers1b.length, answerFiles: files1b.length }));

	// the composer comments on the newest open question (Q2)
	await typeInto("#reply", COMMENT);
	const typed = await ev("document.getElementById('reply').value");
	await prime(A);
	r = await rectOf("#send");
	await tap(r.cx, r.cy);
	await waitFor(`document.querySelectorAll(${JSON.stringify(`${section(ids.q2)} .msg.user`)}).length === 1`, 8000, "comment bubble").catch(() => {});
	const q2 = await itemState(ids.q2);
	const answers2 = await answersOf(A, ids.q2);
	head = await ev(HEADER);
	check(
		"(T9) composer text while a question is the newest open needs-you item: sent as that question's comment, shown as a user bubble, the composer cleared",
		typed === COMMENT && q2.users.length === 1 && q2.users[0].text === COMMENT && answers2.length === 1 && fmt(answers2[0].payload) === fmt({ answers: {}, comment: COMMENT }) && head.reply === "" && head.composeStatus === "" && head.sendOn === true,
		fmt({ typed, users: q2.users, answers: answers2, reply: head.reply, status: head.composeStatus }),
	);
	await shot("thread-a-answered-390.png");

	// deep link
	await view.navigate("about:blank");
	await openThread(A, 3, ids.q1);
	await stable();
	const deep = await itemState(ids.q1);
	const others = await itemState(ids.q2);
	check("(T10) the #<itemId> deep link highlights that item and scrolls it into view", deep.hit === true && deep.headlineInView === true && others.hit === false, fmt({ hit: deep.hit, inView: deep.headlineInView, otherHit: others.hit }));
	await shot("deeplink-390.png");

	// ===== phone 390, thread B =====
	await openThread(B, 2);
	const xss = await itemState(ids.xss);
	check(
		"(B1) the XSS item renders its text literally: no img/b/script inside the bubble, the markup visible as text, closed line 터미널에서 답함, no options",
		xss.agent === true && xss.markup === 0 && xss.bold === 0 && String(xss.headline).includes("<img src=x onerror=alert(1)>") && xss.sys.includes("터미널에서 답함") && xss.opts.length === 0,
		fmt({ markup: xss.markup, bold: xss.bold, headline: xss.headline, sys: xss.sys }),
	);
	const xssRaw = `${section(ids.xss)} [data-action="raw"]`;
	await bringIn(xssRaw);
	r = await rectOf(xssRaw);
	await tap(r.cx, r.cy);
	const xssOpen = await itemState(ids.xss);
	check("(B2) 원문 보기 on the XSS item shows the markup as literal text: paragraphs only, no img/script/b element from it", xssOpen.rawHidden === false && String(xssOpen.rawText).includes(XSS) && xssOpen.rawDanger === 0 && xssOpen.rawTags.every((tag) => tag === "p"), fmt({ hidden: xssOpen.rawHidden, tags: xssOpen.rawTags, danger: xssOpen.rawDanger, text: String(xssOpen.rawText).slice(0, 90) }));
	const mdRaw = `${section(ids.report)} [data-action="raw"]`;
	await bringIn(mdRaw);
	r = await rectOf(mdRaw);
	await tap(r.cx, r.cy);
	const md = await itemState(ids.report);
	check(
		"(B2b) 원문 보기 renders Markdown: a heading, a two-item list with bold and code, a 2x2 table, no ** or table rule left as text",
		md.rawHidden === false && md.rawMd.heading === 1 && md.rawMd.li === 2 && md.rawMd.strong === 1 && md.rawMd.code === 1 && md.rawMd.th === 2 && md.rawMd.td === 4 && !/\*\*|\|---/.test(String(md.rawText)),
		fmt({ tags: md.rawTags, md: md.rawMd }),
	);
	await bringIn(`${section(ids.report)} .raw`);
	await shot("raw-md-390.png");
	head = await ev(HEADER);
	const report = await itemState(ids.report);
	check("(B3) the report bubble has the 보고 chip and a headline; quick replies 계속해 / 승인 / 진행 / 멈춰 show while a report is the newest open item", report.kind === "보고" && report.headline.length > 0 && head.quickHidden === false && fmt(head.quick) === fmt(["계속해", "승인", "진행", "멈춰"]) && head.chip === "🙋 내 차례", fmt({ kind: report.kind, headline: report.headline, quickHidden: head.quickHidden, quick: head.quick, chip: head.chip }));
	r = await rectOf('#quick [data-quick="계속해"]');
	await tap(r.cx, r.cy);
	// B's session is off (never primed), so the reopen sheet asks first; 나중에 전달 keeps today's queue-for-later send.
	await laterOnSheet();
	await waitFor(`document.querySelectorAll(${JSON.stringify(`${section(ids.report)} .msg.user`)}).length === 1`, 8000, "quick reply bubble").catch(() => {});
	const replied = await itemState(ids.report);
	const answers3 = await answersOf(B, ids.report);
	head = await ev(HEADER);
	check("(B4) 계속해 answers the open report with that text: a user bubble 계속해 marked 보내는 중, one answer event {text: 계속해}, the quick chips gone once nothing is open", replied.users.length === 1 && replied.users[0].text === "계속해" && replied.users[0].state === SENDING_TEXT && answers3.length === 1 && fmt(answers3[0].payload) === fmt({ text: "계속해" }) && head.quickHidden === true, fmt({ users: replied.users, answers: answers3, quickHidden: head.quickHidden }));
	await typeInto("#reply", FREE_MESSAGE);
	r = await rectOf("#send");
	await tap(r.cx, r.cy);
	await laterOnSheet();
	await waitFor("document.querySelectorAll('section[data-item]').length === 3", 8000, "free message item").catch(() => {});
	head = await ev(HEADER);
	const itemsB = await itemsOf(B);
	const synthetic = itemsB.find((item) => item.raw && item.raw.synthetic === true);
	const synState = synthetic ? await itemState(synthetic.id) : null;
	check(
		"(B5) composer text with nothing open becomes a free message: a synthetic turn item with the user bubble and no agent bubble",
		Boolean(synthetic) && synthetic.kind === "turn" && synthetic.answers.length === 1 && fmt(synthetic.answers[0].payload) === fmt({ text: FREE_MESSAGE }) && synState && synState.agent === false && synState.users.length === 1 && synState.users[0].text === FREE_MESSAGE && head.reply === "",
		fmt({ synthetic: synthetic && { id: synthetic.id, kind: synthetic.kind, answers: synthetic.answers.map((a) => a.payload) }, state: synState && { agent: synState.agent, users: synState.users }, reply: head.reply }),
	);
	await shot("thread-b-390.png");

	// ===== phone 390, /boards and the proposal page =====
	await openList();
	r = await rectOf('header a[href="/boards"]');
	await tap(r.cx, r.cy);
	const atBoards = await waitPath("/boards", 5000);
	await openBoards();
	const boards = await ev("({ path: location.pathname, h1: (document.querySelector('h1') || {}).textContent, back: { text: (document.querySelector('.back') || {}).textContent, href: (document.querySelector('.back') || {}).getAttribute('href') }, rows: document.querySelectorAll('#list .row').length, text: document.getElementById('list').textContent, overflow: document.documentElement.scrollWidth > window.innerWidth })");
	check("(P1) the Review link opens /boards: title Review, ‹ Inbox back to /, the seeded proposal listed, no overflow", atBoards && boards.path === "/boards" && boards.h1 === "Review" && boards.back.text === "‹ Inbox" && boards.back.href === "/" && boards.rows >= 1 && String(boards.text).includes("수강권 확인 흐름") && boards.overflow === false, fmt({ atBoards, path: boards.path, h1: boards.h1, back: boards.back, rows: boards.rows }));
	await shot("boards-390.png");
	await view.navigate(`${base}/p/${encodeURIComponent(ids.boardId)}`);
	await waitFor("document.getElementById('threadLink') && !document.getElementById('threadLink').hidden && document.getElementById('title').textContent.length > 0", 15000, "proposal page ready");
	await settle();
	const link = await ev("(() => { const a = document.getElementById('threadLink'); const r = a.getBoundingClientRect(); return { text: a.textContent, href: a.getAttribute('href'), visible: r.width > 0 && r.height > 0, title: document.getElementById('title').textContent }; })()");
	await shot("proposal-390.png");
	r = await rectOf("#threadLink");
	await tap(r.cx, r.cy);
	const backToA = await waitPath(`/s/${A}`, 5000);
	check("(P2) the proposal page shows ‹ 대화 linking to its owner thread and tapping it opens that thread", link.text === "‹ 대화" && link.href === `/s/${A}` && link.visible === true && link.title === "수강권 확인 흐름" && backToA, fmt({ link, backToA }));

	// ===== desktop 1280 =====
	await desktop();
	await prime(C);
	await openList();
	const listD = await ev(LIST_STATE);
	check(
		"(D1) 1280: sections 내 차례 (2) / 진행 중 (1) / 끝남 (1) after the answers, 🙋 2, no horizontal overflow",
		fmt(listD.sections.map((s) => [s.label, s.count])) === fmt([["내 차례", "2"], ["진행 중", "1"], ["끝남", "1"]]) && listD.needsYou === "🙋 2" && listD.rows.length === 4 && listD.overflow === false && listD.rows.find((row) => row.session === B).chip === "✅ 끝남",
		fmt({ sections: listD.sections, needsYou: listD.needsYou, chips: listD.rows.map((r2) => [r2.session, r2.chip]), overflow: listD.overflow }),
	);
	await shot("list-1280.png");
	await openThread(A, 3);
	const headD = await ev(HEADER);
	// split view: the ‹ Inbox link is hidden by <html data-embed> and the top URL is /?s=<sid> instead of /s/<sid>
	const embedD = await ev("({ embed: document.documentElement.hasAttribute('data-embed'), backShown: getComputedStyle(document.querySelector('.back')).display !== 'none' })");
	const topD = await evTop("location.pathname + location.search");
	check("(D2) 1280 split: the thread in iframe.thread (top URL /?s=<sid>) keeps a 920px measure with bubbles capped at 640px, ‹ Inbox hidden via data-embed instead of shown, the top bar and composer intact, no overflow", topD === `/?s=${A}` && embedD.embed === true && embedD.backShown === false && headD.measureW <= 920 && headD.maxBubbleW <= 640 && headD.maxBubbleW > 0 && headD.back && headD.chip === "🙋 내 차례" && headD.sendOn === true && headD.overflow === false, fmt({ top: topD, embed: embedD, measureW: headD.measureW, maxBubbleW: headD.maxBubbleW, chip: headD.chip, overflow: headD.overflow }));
	await shot("thread-a-1280.png");
	await view.navigate(`${base}/boards`);
	await openBoards();
	const boardsD = await ev("({ rows: document.querySelectorAll('#list .row').length, overflow: document.documentElement.scrollWidth > window.innerWidth })");
	check("(D3) 1280: /boards lists the proposal without overflow", boardsD.rows >= 1 && boardsD.overflow === false, fmt(boardsD));
	await shot("boards-1280.png");

	// ===== todo 17: progress lines, 과정 보기, the desk board link, the episode 원문 and the lite payload =====
	// Seeded only now, so the list checks above keep their row and section counts.
	const ep = await seedEpisode();
	console.log(`seeded episode ${fmt({ lines: ep.lines, newest: ep.newest })}`);
	await prime(D);
	await phone();
	await openThread(D, 8);
	const linesOn = await ev(LINES_STATE);
	check(
		"(E1) 390: the 8 assistant messages are 8 gray 진행 lines in order under a 🤖 진행 중 chip, one per progress item, no overflow",
		linesOn.groups.length === 8 && fmt(linesOn.kinds) === fmt(Array(8).fill("progress")) && linesOn.groups.every((g, i) => g.gray === true && g.item === ep.lines[i] && String(g.text).startsWith(`${i + 1}번째 메시지`)) && linesOn.chip === "🤖 진행 중" && linesOn.overflow === false,
		fmt({ kinds: linesOn.kinds, lines: linesOn.groups.map((g) => g.text), chip: linesOn.chip, overflow: linesOn.overflow }),
	);
	const newest = linesOn.groups[7] || { text: null, boards: null, links: [] };
	const older = linesOn.groups.slice(0, 7);
	check(
		"(E2) only the newest line ends with · 기다리는 중: Review 답 and is followed by 결제 화면 초안 · 열기 to the desk board (new tab, noopener); the seven older lines have neither",
		String(newest.text).endsWith(WAITING_SUFFIX) && newest.boards === true && newest.links.length === 1 && newest.links[0].line === `${EP_BOARD.title} · 열기` && newest.links[0].href === EP_BOARD.url && newest.links[0].target === "_blank" && newest.links[0].rel === "noopener noreferrer" && older.length === 7 && older.every((g) => !String(g.text).includes("기다리는 중") && g.boards === false && g.links.length === 0),
		fmt({ newest: { text: newest.text, boards: newest.boards, links: newest.links }, olderWithWait: older.filter((g) => String(g.text).includes("기다리는 중") || g.boards || g.links.length).length }),
	);
	// todo 19: his request sits above the lines as a right-aligned owner bubble, and again where the request changes at line 5.
	const requestAt = (s, i) => {
		const g = s.groups[i];
		return Boolean(g && g.request) && g.request.visible === true && g.request.first === true && g.request.right > s.width / 2 && s.measureRight - g.request.right <= 24;
	};
	check(
		"(R1) 390: one owner bubble with the request sits right-aligned above the first line, a second with the changed request above line 5, no other line carries one, and those are the thread's only 2 owner bubbles",
		linesOn.groups.length === 8 && requestAt(linesOn, 0) && linesOn.groups[0].request.text === EP_REQUEST && requestAt(linesOn, 4) && linesOn.groups[4].request.text === EP_REQUEST_2 && [1, 2, 3, 5, 6, 7].every((i) => linesOn.groups[i].request === null && linesOn.groups[i].users === 0) && linesOn.bubbles.length === 2 && linesOn.bubbles.every((b) => b.request === true) && linesOn.groups[0].request.expanded === "false" && linesOn.groups[0].request.more === false,
		fmt({ bubbles: linesOn.bubbles, first: linesOn.groups[0].request, fifth: linesOn.groups[4].request, width: linesOn.width, measureRight: linesOn.measureRight }),
	);
	const dItems = await itemsOf(D);
	const dRequests = dItems.filter((item) => item.kind === "progress").map((item) => (item.raw ? item.raw.request : undefined));
	check(
		"(R2) the thread GET carries a line's request on line 1 and on line 5 only (repeats dropped, the change kept) while every line keeps its episode key",
		fmt(dRequests) === fmt([EP_REQUEST, undefined, undefined, undefined, EP_REQUEST_2, undefined, undefined, undefined]) && dItems.filter((item) => item.kind === "progress").every((item) => item.meta && item.meta.episode && item.meta.episode.key === EP_KEY),
		fmt({ requests: dRequests }),
	);
	await ev("window.scrollTo(0, 0)");
	await stable();
	await shot("request-390-light.png", PREFIX19);
	await shot("lines-390-light.png", PREFIX17);
	await dark();
	await shot("lines-390-dark.png", PREFIX17);
	await light();
	// 과정 보기 off: the seven plain lines hide whole, the newest keeps its board link; off survives a reload, and so does on.
	await bringIn("#progressToggle");
	r = await rectOf("#progressToggle");
	await tap(r.cx, r.cy);
	const linesOff = await ev(LINES_STATE);
	await shot("lines-off-390-light.png", PREFIX17);
	await reopen(D, 8);
	const linesOffReload = await ev(LINES_STATE);
	await bringIn("#progressToggle");
	r = await rectOf("#progressToggle");
	await tap(r.cx, r.cy);
	const linesBack = await ev(LINES_STATE);
	await reopen(D, 8);
	const linesBackReload = await ev(LINES_STATE);
	// todo 19: off hides every line; the two groups carrying his request bubble stay for the bubble, the other five plain groups fold whole
	const requestsShown = (s) => [0, 4].every((i) => Boolean(s.groups[i].request) && s.groups[i].request.visible === true);
	const hiddenLines = (s) => Boolean(s.toggle) && s.toggle.pressed === "false" && s.progress === "off" && s.stored === "off" && s.groups.length === 8 && s.groups.every((g) => g.lineVisible === false) && [1, 2, 3, 5, 6].every((i) => s.groups[i].groupVisible === false) && [0, 4].every((i) => s.groups[i].groupVisible === true) && requestsShown(s) && s.groups[7].links.length === 1 && s.groups[7].links[0].visible === true;
	const shownLines = (s) => Boolean(s.toggle) && s.toggle.pressed === "true" && s.progress === "on" && s.groups.length === 8 && s.groups.every((g) => g.groupVisible === true && g.lineVisible === true) && requestsShown(s);
	check(
		"(E3) 과정 보기 is on by default; a tap hides all 8 lines (the five plain groups fold whole) and keeps the newest line's board link and the two request bubbles; off survives a reload; a second tap shows the lines again and on survives a reload (localStorage inbox.progressLines)",
		Boolean(linesOn.toggle) && linesOn.toggle.text === "과정 보기" && shownLines(linesOn) && hiddenLines(linesOff) && hiddenLines(linesOffReload) && shownLines(linesBack) && linesBack.stored === "on" && shownLines(linesBackReload) && linesBackReload.stored === "on",
		fmt({
			start: { toggle: linesOn.toggle, stored: linesOn.stored },
			off: { toggle: linesOff.toggle, progress: linesOff.progress, stored: linesOff.stored, groupsVisible: linesOff.groups.map((g) => g.groupVisible), linesVisible: linesOff.groups.map((g) => g.lineVisible), requestsVisible: linesOff.groups.map((g) => g.request && g.request.visible), newestLine: linesOff.groups[7] && linesOff.groups[7].lineVisible, link: linesOff.groups[7] && linesOff.groups[7].links },
			offReload: { toggle: linesOffReload.toggle, groupsVisible: linesOffReload.groups.map((g) => g.groupVisible) },
			back: { toggle: linesBack.toggle, stored: linesBack.stored, linesVisible: linesBack.groups.map((g) => g.lineVisible) },
			backReload: { toggle: linesBackReload.toggle, stored: linesBackReload.stored, linesVisible: linesBackReload.groups.map((g) => g.lineVisible) },
		}),
	);
	await desktop();
	await prime(D);
	await reopen(D, 8);
	const linesD = await ev(LINES_STATE);
	const newestD = linesD.groups[7] || { text: null, links: [] };
	check("(E1d) 1280: the same 8 lines, the suffix and the board link on the newest only, no overflow", linesD.groups.length === 8 && String(newestD.text).endsWith(WAITING_SUFFIX) && newestD.links.length === 1 && linesD.groups.slice(0, 7).every((g) => g.links.length === 0) && linesD.overflow === false, fmt({ groups: linesD.groups.length, newest: newestD.text, overflow: linesD.overflow }));
	check("(R1d) 1280: the two request bubbles sit right-aligned inside the 920px measure above lines 1 and 5 and nowhere else", requestAt(linesD, 0) && linesD.groups[0].request.text === EP_REQUEST && requestAt(linesD, 4) && linesD.groups[4].request.text === EP_REQUEST_2 && linesD.bubbles.length === 2 && linesD.measureRight <= 1100, fmt({ first: linesD.groups[0].request, fifth: linesD.groups[4].request, measureRight: linesD.measureRight, bubbles: linesD.bubbles.length }));
	await ev("window.scrollTo(0, 0)");
	await stable();
	await shot("request-1280-light.png", PREFIX19);
	await shot("lines-1280-light.png", PREFIX17);
	await dark();
	await shot("lines-1280-dark.png", PREFIX17);
	await light();
	// F4 shortfall: a hold (hold:<source>) or an open permission dialog reads in Korean like every other wait reason.
	const waitText = async (reasons) => {
		await must("POST", `/api/items/${ep.newest}/state`, { state: "waiting", reasons, boards: [] });
		await reopen(D, 8);
		const s = await ev(LINES_STATE);
		return String((s.groups[7] || {}).text);
	};
	const holdText = await waitText(["hold:omo-dag"]);
	const dialogText = await waitText(["dialog"]);
	await must("POST", `/api/items/${ep.newest}/state`, { state: "waiting", reasons: ["omo-desk"], boards: [EP_BOARD] });
	await reopen(D, 8);
	check("(E2h) a hold or a permission dialog reads in Korean: · 기다리는 중: 작업 흐름 for hold:omo-dag, · 기다리는 중: 권한 답 for dialog", holdText.endsWith(" · 기다리는 중: 작업 흐름") && dialogText.endsWith(" · 기다리는 중: 권한 답"), fmt({ holdText, dialogText }));

	// the final closes the episode: the lines stay above it; its 원문 is the whole episode from the episode route
	const finalItem = await postFinal();
	ep.final = finalItem.id;
	await phone();
	await reopen(D, 9);
	const afterFinal = await ev(LINES_STATE);
	const closedRaw = await episodeState(ep.final);
	check(
		"(E4) after the episode final lands, the 8 lines stay above it in order and the final is a 보고 bubble with its 원문 closed",
		afterFinal.groups.length === 8 && fmt(afterFinal.kinds) === fmt([...Array(8).fill("progress"), "turn"]) && afterFinal.groups.every((g, i) => g.item === ep.lines[i]) && Boolean(closedRaw) && closedRaw.kind === "보고" && closedRaw.rawHidden === true && closedRaw.button === "원문 보기",
		fmt({ kinds: afterFinal.kinds, final: closedRaw && { kind: closedRaw.kind, rawHidden: closedRaw.rawHidden, button: closedRaw.button } }),
	);
	await ev(EPISODE_FAIL_ONCE);
	const finalRaw = `${section(ep.final)} [data-action="raw"]`;
	const retrySel = `${section(ep.final)} .raw .ep-state.error button[data-action="episode"]`;
	const msgSel = `${section(ep.final)} .raw .ep-msg`;
	await bringIn(finalRaw);
	r = await rectOf(finalRaw);
	await tap(r.cx, r.cy);
	await waitFor(`document.querySelector(${JSON.stringify(retrySel)})`, 8000, "episode load failure").catch(() => {});
	const failed = await episodeState(ep.final);
	const calls1 = await ev("window.__episodeCalls.slice()");
	check(
		"(E5) 원문 보기 on the final GETs the episode route once; its 500 answer shows 불러오지 못했습니다 with a 다시 시도 button and no messages",
		calls1.length === 1 && calls1[0].includes(`/api/threads/${D}/episodes/${encodeURIComponent(EP_KEY)}`) && Boolean(failed) && failed.rawHidden === false && failed.button === "원문 닫기" && Boolean(failed.state) && failed.state.error === true && String(failed.state.text).startsWith("불러오지 못했습니다") && failed.state.retry === "다시 시도" && failed.msgs.length === 0,
		fmt({ calls: calls1, state: failed && failed.state, msgs: failed && failed.msgs.length }),
	);
	await bringIn(`${section(ep.final)} .raw`);
	await shot("episode-error-390-light.png", PREFIX17);
	await bringIn(retrySel);
	r = await rectOf(retrySel);
	await tap(r.cx, r.cy);
	await waitFor(`document.querySelectorAll(${JSON.stringify(msgSel)}).length === 8`, 8000, "episode messages").catch(() => {});
	const loaded = await episodeState(ep.final);
	const calls2 = await ev("window.__episodeCalls.slice()");
	const expectedAts = [...ep.lineItems.slice(0, 7).map((item) => item.createdAt), finalItem.createdAt];
	const clocks = await ev(`${JSON.stringify(expectedAts)}.map((iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); })`);
	const msgs = loaded ? loaded.msgs : [];
	const perMessage = EP_TEXTS.map((_text, i) => msgs.filter((m) => m.text.includes(`episode-msg-0${i + 1} `)).length);
	check(
		"(E6) 다시 시도 GETs again and the 원문 lists all 8 messages in order (7 lines then the final, none twice), each with its HH:MM time and its Markdown rendered: heading, bold, code, a 2-item list, no literal ## or **",
		calls2.length === 2 && msgs.length === 8 && msgs.every((m, i) => m.text.includes(`${i + 1}번째 메시지`) && m.datetime === expectedAts[i] && m.at === clocks[i] && m.heads === 1 && m.strong === 1 && m.code === 1 && m.li === 2 && m.literal === false) && perMessage.every((n) => n === 1) && Boolean(loaded) && loaded.state === null,
		fmt({ calls: calls2.length, msgs: msgs.map((m, i) => ({ at: m.at, want: clocks[i], head: m.text.slice(0, 20), md: [m.heads, m.strong, m.code, m.li], literal: m.literal })), perMessage }),
	);
	await bringTop(`${section(ep.final)} .foot`);
	await shot("episode-390-light.png", PREFIX17);
	await dark();
	await shot("episode-390-dark.png", PREFIX17);
	await light();
	await desktop();
	await reopen(D, 9);
	await bringIn(finalRaw);
	r = await rectOf(finalRaw);
	await click(r.cx, r.cy);
	await waitFor(`document.querySelectorAll(${JSON.stringify(msgSel)}).length === 8`, 8000, "episode messages 1280").catch(() => {});
	const loadedD = await episodeState(ep.final);
	const overflowD = await ev("document.documentElement.scrollWidth > window.innerWidth");
	check("(E6d) 1280: 원문 보기 on the final lists the 8 messages in order, no overflow", Boolean(loadedD) && loadedD.msgs.length === 8 && loadedD.msgs.every((m, i) => m.text.includes(`${i + 1}번째 메시지`)) && overflowD === false, fmt({ msgs: loadedD && loadedD.msgs.length, overflow: overflowD }));
	await bringTop(`${section(ep.final)} .foot`);
	await shot("episode-1280-light.png", PREFIX17);
	await dark();
	await shot("episode-1280-dark.png", PREFIX17);
	await light();
	await cdp("Emulation.setEmulatedMedia", { features: [] });

	// the thread payload (items and events) never carries the long texts, and the whole GET stays within the final's size + 2 KB per line
	const payloadRes = await fetch(`${base}/api/threads/${encodeURIComponent(D)}`, { headers: { accept: "application/json" } });
	const payload = await payloadRes.text();
	const parsed = JSON.parse(payload);
	const strings = [];
	(function walk(value) {
		if (typeof value === "string") strings.push(value);
		else if (Array.isArray(value)) value.forEach(walk);
		else if (value && typeof value === "object") Object.values(value).forEach(walk);
	})(parsed);
	const leaks = EP_TEXTS.map((_text, i) => (payload.includes(EP_CHUNK(i + 1)) ? i + 1 : null)).filter((n) => n !== null);
	const wholeLeaks = EP_TEXTS.map((text, i) => (strings.some((s) => s.includes(text)) ? i + 1 : null)).filter((n) => n !== null);
	const payloadBytes = Buffer.byteLength(payload, "utf8");
	const finalBytes = Buffer.byteLength(EP_TEXTS[7], "utf8");
	const budget = finalBytes + 2048 * 8;
	const eventTypes = {};
	for (const event of parsed.events) eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
	check(
		"(E7a) the thread GET (items and events) holds none of the 8 seeded texts: 3000+ chars each, a 1000-char substring search on the body and a whole-string search over every JSON string",
		payloadRes.status === 200 && parsed.items.length === 9 && EP_TEXTS.every((text) => text.length >= 3000) && leaks.length === 0 && wholeLeaks.length === 0,
		fmt({ status: payloadRes.status, items: parsed.items.length, events: parsed.events.length, textChars: EP_TEXTS.map((text) => text.length), leaks, wholeLeaks }),
	);
	check(
		"(E7b) the thread GET weighs at most the final's size + 2 KB per line (UTF-8 bytes)",
		payloadRes.status === 200 && payloadBytes <= budget,
		fmt({ bytes: payloadBytes, budget, finalBytes, lines: 8, perLine: Math.round(payloadBytes / 8), chars: payload.length, budgetChars: EP_TEXTS[7].length + 2048 * 8, itemsBytes: Buffer.byteLength(JSON.stringify(parsed.items), "utf8"), eventsBytes: Buffer.byteLength(JSON.stringify(parsed.events), "utf8"), eventTypes }),
	);

	// a 200-item thread GET, timed once
	await seedBig();
	const t0 = performance.now();
	const bigRes = await fetch(`${base}/api/threads/${encodeURIComponent(P)}`, { headers: { accept: "application/json" } });
	const bigBody = await bigRes.text();
	const bigMs = performance.now() - t0;
	const bigItems = JSON.parse(bigBody).items.length;
	check("(E8) a seeded 200-item thread GET answers in under 200 ms locally (measured once)", bigRes.status === 200 && bigItems === 200 && bigMs < 200, fmt({ ms: bigMs, items: bigItems, bytes: Buffer.byteLength(bigBody, "utf8") }));

	// ===== todo 19: a request sent from the phone is a bubble already; a changed 8-line request gets a clipped one =====
	const rr = await seedR();
	console.log(`seeded R ${fmt(rr)}`);
	await prime(R);
	await phone();
	await openThread(R, 4);
	const rState = await ev(LINES_STATE);
	check(
		"(R3) a phone message with the same text precedes the lines: his bubble is that message and the two lines under it draw no second bubble",
		fmt(rState.kinds) === fmt(["turn", "progress", "progress", "progress"]) && rState.bubbles.length === 2 && rState.bubbles[0].request === false && rState.bubbles[0].text === R_REQUEST && rState.groups[0].request === null && rState.groups[1].request === null && rState.groups[0].users === 0 && rState.groups[1].users === 0,
		fmt({ kinds: rState.kinds, bubbles: rState.bubbles.map((b) => ({ request: b.request, text: b.text.slice(0, 20) })), groups: rState.groups.map((g) => ({ item: g.item, request: g.request ? g.request.text.slice(0, 16) : null, users: g.users })) }),
	);
	const long = rState.groups[2].request;
	check(
		"(R4) the third line's changed 8-line request draws a bubble above it clipped to 6 lines that reads as tappable",
		Boolean(long) && long.text === R_REQUEST_LONG && long.first === true && long.visible === true && long.lines === 6 && long.clipped === true && long.more === true && long.expanded === "false" && rState.bubbles[1].request === true,
		fmt({ long }),
	);
	const longSel = `${section(rr.lines[2])} .msg.user.request .bubble`;
	await bringIn(longSel);
	await shot("request-long-390-light.png", PREFIX19);
	r = await rectOf(longSel);
	await tap(r.cx, r.cy);
	const opened = (await ev(LINES_STATE)).groups[2].request;
	r = await rectOf(longSel);
	await tap(r.cx, r.cy);
	const clippedAgain = (await ev(LINES_STATE)).groups[2].request;
	check(
		"(R5) a tap opens the clipped request to all 8 lines; a second tap clips it to 6 again",
		Boolean(opened) && opened.expanded === "true" && opened.lines === 8 && opened.clipped === false && Boolean(clippedAgain) && clippedAgain.expanded === "false" && clippedAgain.lines === 6 && clippedAgain.clipped === true,
		fmt({ opened, clippedAgain }),
	);
	// Must NOT: a progress item without meta.episode (thread C) keeps its request in the payload and draws no bubble.
	const cProgress = (await itemsOf(C)).find((item) => item.id === ids.progress);
	await openThread(C, 1);
	const cState = await ev(LINES_STATE);
	check(
		"(R6) a progress item without meta.episode keeps its request in the thread GET and draws no request bubble",
		Boolean(cProgress) && Boolean(cProgress.raw) && cProgress.raw.request === "테스트 파일을 폴더별로 정리해 줘" && cState.groups.length === 1 && cState.groups[0].request === null && cState.bubbles.length === 0,
		fmt({ request: cProgress && cProgress.raw && cProgress.raw.request, groups: cState.groups.length, bubbles: cState.bubbles }),
	);

	// ===== the service worker in Node =====
	await runSwChecks();
	const sunk = fs.existsSync(sink) ? fs.readFileSync(sink, "utf8").split("\n").filter(Boolean) : [];
	const sunkOk = sunk.every((line) => {
		try {
			const entry = JSON.parse(line);
			return typeof entry.endpoint === "string" && entry.payload && typeof entry.payload === "object";
		} catch {
			return false;
		}
	});
	check("(X) would-send pushes went to the INBOX_PUSH_SINK file as JSON lines, never to a push service", sunkOk, sunk.length ? `${sunk.length} line(s)` : "no subscription was made, so no push was due");
} catch (error) {
	check("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	try {
		await view.close();
	} catch {
		// already gone
	}
	server.kill();
	await server.exited;
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`cleanup: server stopped, browser closed, temp removed ${!fs.existsSync(tmp)}; output in ${OUT}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
