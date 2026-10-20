/* Real-browser QA for 듣기 (read aloud) on the omo-inbox proposal page.
 *
 * Usage: bun qa/read-aloud-qa.mjs [app dir, default the repo] [screenshot dir, default a new temp dir]
 * Starts <app>/src/server.mjs on a temp home (port 4393), submits a board, drives one Bun.WebView.
 * Headless Chrome cannot be heard, so most checks swap window.speechSynthesis for a recorder and fire the
 * utterance events by hand; one desktop check clicks 듣기 with the real engine and only requires no page error.
 * Exit 0 only when every check passes. The temp home is deleted at the end.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { framePng } from "./frame.mjs";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "inbox-qa-read-"));
const PORT = 4393;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const TITLE = "읽어주기 QA";
const LONG = `첫 문장은 화면이 어떻게 나뉘는지 설명합니다 ${"가나다라마바사 ".repeat(30)}끝.`;

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (o) => JSON.stringify(o);

const STUB = `(() => {
	window.__spoken = [];
	window.__cancels = 0;
	const fake = { speaking: false, pending: false, paused: false, getVoices: () => [], cancel() { window.__cancels++; }, resume() {}, speak(u) { window.__spoken.push(u); } };
	Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true, writable: true });
	return window.speechSynthesis === fake;
})()`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-qa-read-"));
const home = path.join(tmp, "home");
const src = path.join(tmp, "board");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(src, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));
for (const name of ["a.png", "b.png", "c.png"]) fs.writeFileSync(path.join(src, name), framePng());
fs.writeFileSync(
	path.join(src, "board.json"),
	JSON.stringify({
		title: TITLE,
		lead: "요약 문장입니다. 두 번째 요약 문장입니다.",
		sections: [
			{
				title: "화면",
				desc: "바뀌는 화면",
				cards: [
					{ badge: "1", title: "첫 카드", layout: "one", say: "첫 카드 설명입니다.", frames: [["그림1", "a.png"]] },
					{ badge: "2", title: "둘째 카드", layout: "one", note: "메모만 있는 카드입니다.", frames: [["그림2", "b.png"]] },
					{ badge: "3", title: "긴 설명", layout: "one", say: LONG, frames: [["그림3", "c.png"]] },
				],
			},
		],
		questions: [
			{
				id: "q1",
				text: "어느 쪽으로 할까요?",
				help: "정해지는 것입니다.",
				options: [
					{ value: "a", label: "가", rec: true, why: "가를 고르면 이렇습니다." },
					{ value: "b", label: "나", why: "나를 고르면 저렇습니다." },
				],
			},
		],
	}),
);

const listening = new Promise((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("server.json timeout")), 15000);
	const w = fs.watch(home, (_e, f) => {
		if (f === "server.json") {
			clearTimeout(t);
			w.close();
			resolve();
		}
	});
});
const server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], { cwd: APP, env: { ...process.env, OMO_INBOX_HOME: home }, stdout: "ignore", stderr: "ignore" });
const view = new Bun.WebView({ width: 1440, height: 900 });
const ev = (expr) => view.evaluate(expr);
const cdp = (m, p) => view.cdp(m, p || {});
const waitFor = (cond, ms, what) =>
	ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
const shot = async (name) => {
	const res = await cdp("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(path.join(OUT, name), Buffer.from(res.data, "base64"));
};
const ready = (n) => waitFor(`document.querySelectorAll('.frame canvas').length === ${n} && [...document.querySelectorAll('.frame canvas')].every((c) => c.width > 0) && !document.getElementById('listenBtn').hidden`, 30000, "page ready");
const spokenTexts = () => ev("window.__spoken.map((u) => u.text)");
const btn = () => ev("({ text: document.getElementById('listenBtn').textContent, pressed: document.getElementById('listenBtn').getAttribute('aria-pressed'), reading: [...document.querySelectorAll('.reading')].map((n) => n.id || n.className) })");
const fire = (index, kind, extra = "") => ev(`(() => { const u = window.__spoken[${index}]; if (u && u.${kind}) u.${kind}(${extra || "{}"}); return Boolean(u); })()`);

const expected = [
	"읽어주기 QA.",
	"요약 문장입니다.",
	"두 번째 요약 문장입니다.",
	"화면.",
	"바뀌는 화면.",
	"첫 카드.",
	"첫 카드 설명입니다.",
	"둘째 카드.",
	"메모만 있는 카드입니다.",
	"긴 설명.",
];
const tail = ["질문 1.", "어느 쪽으로 할까요?", "정해지는 것입니다.", "1번, 가, 추천.", "가를 고르면 이렇습니다.", "2번, 나.", "나를 고르면 저렇습니다.", "여기까지입니다."];

try {
	await listening;
	// Safety: every POST below must hit the server this script started on its temp home, never the live one.
	const health = await (await fetch(`${base}/api/health`)).json();
	if (health.port !== PORT || health.pid !== server.pid) throw new Error(`not our server on ${PORT}: ${fmt(health)}, spawned pid ${server.pid}`);
	console.log(`server up: ${fmt(health)} (spawned pid ${server.pid})`);
	const created = await (await fetch(`${base}/api/proposals`, { method: "POST", headers: POST, body: JSON.stringify({ cwd: src, srcDir: src, title: TITLE }) })).json();
	const id = created.summary.id;

	// ===== phone 390 =====
	await view.navigate("about:blank");
	await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
	await view.navigate(`${base}/p/${id}`);
	await ready(3);
	const top = await ev("(() => { const b = document.getElementById('listenBtn').getBoundingClientRect(); const h = document.getElementById('title').getBoundingClientRect(); return { b: { l: b.left, t: b.top, w: b.width, h: b.height, r: b.right }, h1: { t: h.top, r: h.right }, doc: document.documentElement.scrollWidth, inner: innerWidth }; })()");
	check("390: 듣기 sits right of the title, at least 40 px tall, no horizontal overflow", top.b.l >= top.h1.r && top.b.h >= 40 && top.b.r <= 390 && top.doc <= 390, fmt(top));
	await shot("listen-390-top.png");

	check("stub installed", (await ev(STUB)) === true);
	await ev("document.getElementById('listenBtn').click()");
	const texts = await spokenTexts();
	const langs = await ev("[...new Set(window.__spoken.map((u) => u.lang))]");
	const longChunks = texts.slice(expected.length, texts.length - tail.length);
	const orderOk = expected.every((t, i) => texts[i] === t) && tail.every((t, i) => texts[texts.length - tail.length + i] === t);
	const longOk = longChunks.length >= 2 && longChunks.every((t) => t.length <= 160) && longChunks.join(" ").replace(/\s+/g, " ") === LONG.replace(/\s+/g, " ").trim();
	check("click 듣기: title, lead, section, card say (else note), questions with 추천 and why, 여기까지입니다, in order", orderOk, fmt(texts.slice(0, 12)) + " ... " + fmt(texts.slice(-8)));
	check("a long say is cut into pieces of at most 160 chars that add up to the whole", longOk, fmt(longChunks.map((t) => t.length)));
	check("every piece is ko-KR", langs.length === 1 && langs[0] === "ko-KR", fmt(langs));
	const b1 = await btn();
	check("while reading the button says 멈추기 (aria-pressed true)", b1.text === "멈추기" && b1.pressed === "true", fmt(b1));

	// the second card is outlined and brought into view when its piece starts
	const second = texts.indexOf("둘째 카드.");
	await fire(second, "onstart");
	await waitFor("(() => { const c = document.querySelectorAll('#sections .card')[1]; const r = c.getBoundingClientRect(); return c.classList.contains('reading') && r.top < innerHeight / 2 && r.bottom > innerHeight / 2; })()", 3000, "card centered").catch(() => {});
	const r2 = await ev("(() => { const cards = [...document.querySelectorAll('#sections .card')]; const c = cards[1]; const r = c.getBoundingClientRect(); return { outlined: cards.map((x) => x.classList.contains('reading')), center: r.top < innerHeight / 2 && r.bottom > innerHeight / 2, shadow: getComputedStyle(c).boxShadow !== 'none' }; })()");
	check("the card being read is the only one outlined and is scrolled to the middle", fmt(r2.outlined) === "[false,true,false]" && r2.center && r2.shadow, fmt(r2));
	await shot("listen-390-reading.png");
	await fire(texts.indexOf("질문 1."), "onstart");
	const rq = await ev("({ decide: document.getElementById('decideCard').classList.contains('reading'), cards: [...document.querySelectorAll('#sections .card.reading')].length })");
	check("question pieces outline the 정할 것 card", rq.decide && rq.cards === 0, fmt(rq));
	await fire(texts.length - 1, "onend");
	const b2 = await btn();
	check("after the last piece the button is 듣기 again and nothing is outlined", b2.text === "듣기" && b2.pressed === "false" && b2.reading.length === 0, fmt(b2));

	// 멈추기 cancels; a late event from the stopped run changes nothing
	await ev("document.getElementById('listenBtn').click()");
	const runStart = (await spokenTexts()).length - 2 * texts.length;
	const cancelsBefore = await ev("window.__cancels");
	await ev("document.getElementById('listenBtn').click()");
	const stopped = await ev("({ cancels: window.__cancels })");
	await fire(texts.length + 7, "onstart");
	const b3 = await btn();
	check("멈추기 cancels the speech; a late event from the stopped run outlines nothing", runStart === 0 && stopped.cancels === cancelsBefore + 1 && b3.text === "듣기" && b3.reading.length === 0, fmt({ cancelsBefore, stopped, b3 }));

	// an engine error stops the run; interrupted does not
	await ev("document.getElementById('listenBtn').click()");
	const n0 = (await spokenTexts()).length - texts.length;
	await fire(n0 + 1, "onerror", "{ error: 'interrupted' }");
	const b4 = await btn();
	await fire(n0 + 1, "onerror", "{ error: 'synthesis-failed' }");
	const b5 = await btn();
	check("an interrupted piece keeps reading; a failed one stops and resets the button", b4.text === "멈추기" && b5.text === "듣기", fmt({ b4, b5 }));

	// stopped partway, the next 듣기 goes on from the piece it was on; 처음부터 starts over
	const resumeState = () => ev("({ text: document.getElementById('listenBtn').textContent, restart: !document.getElementById('restartBtn').hidden, fab: !document.getElementById('stopFab').hidden })");
	const N = texts.length;
	await ev("window.__spoken.length = 0");
	await ev("document.getElementById('listenBtn').click()");
	await fire(second, "onstart");
	await ev("document.getElementById('listenBtn').click()");
	const s1 = await resumeState();
	check("멈추기 partway: the button says 이어 듣기 and 처음부터 appears", s1.text === "이어 듣기" && s1.restart && !s1.fab, fmt(s1));
	await ev("scrollTo(0, 0)");
	await shot("listen-390-resume.png");
	const top2 = await ev("(() => { const b = document.getElementById('listenBtn').getBoundingClientRect(); const r = document.getElementById('restartBtn').getBoundingClientRect(); const h = document.getElementById('title').getBoundingClientRect(); return { b: { l: b.left, h: b.height, r: b.right }, r: { l: r.left, h: r.height, r: r.right }, h1r: h.right, doc: document.documentElement.scrollWidth }; })()");
	check("390: 이어 듣기 and 처음부터 sit right of the title, at least 40 px tall, no horizontal overflow", top2.b.l >= top2.h1r && top2.r.l >= top2.b.r && top2.b.h >= 40 && top2.r.h >= 40 && top2.r.r <= 390 && top2.doc <= 390, fmt(top2));
	await ev("window.__spoken.length = 0");
	await ev("document.getElementById('listenBtn').click()");
	const t5 = await spokenTexts();
	const s2 = await resumeState();
	check("이어 듣기 starts at the piece that was being read and reads to the end", t5[0] === "둘째 카드." && t5.length === N - second && t5[t5.length - 1] === "여기까지입니다." && s2.text === "멈추기" && !s2.restart, fmt({ head: t5.slice(0, 2), n: t5.length, s2 }));
	// the engine failing partway keeps the place too
	const longAt = t5.indexOf("긴 설명.");
	await fire(longAt, "onstart");
	await fire(longAt, "onerror", "{ error: 'synthesis-failed' }");
	const s3 = await resumeState();
	await ev("window.__spoken.length = 0");
	await ev("document.getElementById('listenBtn').click()");
	const t6 = await spokenTexts();
	check("after an engine error, 이어 듣기 goes on from the failed piece", s3.text === "이어 듣기" && t6[0] === "긴 설명.", fmt({ s3, head: t6.slice(0, 2) }));
	// back on the page after the engine dropped the speech: 이어 듣기, not a dead 멈추기
	await fire(t6.indexOf("질문 1."), "onstart");
	await ev("document.dispatchEvent(new Event('visibilitychange'))");
	const s4 = await resumeState();
	await ev("window.__spoken.length = 0");
	await ev("document.getElementById('listenBtn').click()");
	const t7 = await spokenTexts();
	check("returning to the page after the engine went silent shows 이어 듣기, which goes on from there", s4.text === "이어 듣기" && s4.restart && t7[0] === "질문 1.", fmt({ s4, head: t7.slice(0, 2) }));
	await ev("document.getElementById('listenBtn').click()");
	await ev("window.__spoken.length = 0");
	await ev("document.getElementById('restartBtn').click()");
	const t8 = await spokenTexts();
	check("처음부터 reads the whole proposal from the title", t8[0] === "읽어주기 QA." && t8.length === N, fmt({ head: t8.slice(0, 2), n: t8.length }));
	await fire(N - 1, "onend");
	const s5 = await resumeState();
	check("reading to the end forgets the place: 듣기 again, no 처음부터", s5.text === "듣기" && !s5.restart, fmt(s5));

	// ===== revision note and session reply come first =====
	const rv = await fetch(`${base}/api/p/${id}/revise`, { method: "POST", headers: POST, body: JSON.stringify({ srcDir: src, note: "버튼을 키웠습니다", session: null }) });
	await view.navigate(`${base}/p/${id}`);
	await ready(3);
	await ev(STUB);
	await ev("document.getElementById('listenBtn').click()");
	const t2 = await spokenTexts();
	check("on a revised proposal it starts with 바뀐 점 and the revise note", rv.status === 200 && t2[0] === "바뀐 점." && t2[1] === "버튼을 키웠습니다." && t2[2] === "읽어주기 QA.", fmt(t2.slice(0, 3)));
	const rp = await fetch(`${base}/api/p/${id}/reply`, { method: "POST", headers: POST, body: JSON.stringify({ text: "답 글입니다.", session: null }) });
	await view.navigate(`${base}/p/${id}`);
	await ready(3);
	await ev(STUB);
	await ev("document.getElementById('listenBtn').click()");
	const t3 = await spokenTexts();
	check("when the newest event is a session reply it starts with 세션 답, then 바뀐 점", rp.status === 200 && fmt(t3.slice(0, 5)) === fmt(["세션 답.", "답 글입니다.", "바뀐 점.", "버튼을 키웠습니다.", "읽어주기 QA."]), fmt(t3.slice(0, 5)));

	// switching revision stops; revision 1 has no 바뀐 점
	await fire(5, "onstart");
	const c0 = await ev("window.__cancels");
	await ev("document.querySelectorAll('#tabs button')[0].click()");
	await waitFor("window.__vb.rev === 1", 15000, "rev 1");
	const b6 = { ...(await btn()), restart: await ev("!document.getElementById('restartBtn').hidden") };
	const c1 = await ev("window.__cancels");
	await ready(3);
	await ev("window.__spoken.length = 0");
	await ev("document.getElementById('listenBtn').click()");
	const t4 = await spokenTexts();
	check("switching to 1안 stops reading; 1안 reads the reply but no 바뀐 점", c1 === c0 + 1 && b6.text === "듣기" && !b6.restart && t4[0] === "세션 답." && t4[2] === "읽어주기 QA." && !t4.includes("바뀐 점."), fmt({ c0, c1, b6, head: t4.slice(0, 3) }));

	// ===== desktop 1440, real engine =====
	await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
	await view.navigate(`${base}/p/${id}`);
	await ready(3);
	await ev("(() => { window.__errs = []; addEventListener('error', (e) => window.__errs.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason))); })()");
	await ev("document.getElementById('listenBtn').click()");
	const d1 = await btn();
	await ev("document.getElementById('listenBtn').textContent === '멈추기' && document.getElementById('listenBtn').click()");
	const d2 = await btn();
	const errs = await ev("window.__errs");
	check("1440, real speech engine: 듣기 starts and stops without a page error", errs.length === 0 && d2.text === "듣기", fmt({ d1, d2, errs }));
	await ev("scrollTo(0, 0)");
	await shot("listen-1440-top.png");
} catch (error) {
	check("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	await view.close();
	server.kill();
	await server.exited;
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`cleanup: server stopped, browser closed, temp removed ${!fs.existsSync(tmp)}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
