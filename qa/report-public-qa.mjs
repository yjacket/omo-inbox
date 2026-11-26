/* Live QA for reports to a public repo: the masked picture, the rewrite job, the leak hold and the public issue.
 *
 * Usage: bun qa/report-public-qa.mjs [app dir, default the repo] [output dir, default a new temp dir]
 * Starts the fake GitHub (public repo) and <app>/src/server.mjs from qa/report-fixture.mjs on a temp home and a free
 * port, seeds one thread whose title and question carry private text, then drives one Bun.WebView at 390x844 touch:
 * opens /s/<sid>, presses the bubble's 제보, waits for the redrawn picture, writes a description and sends. The
 * script then plays the extension over HTTP (no model is called): /api/here hands it the rewrite job, it reads
 * GET /api/reports/<id>/rewrite, posts a rewrite that copies the question (held), retries, and posts a clean one
 * (sent). A second report gets `unavailable: no_model` (held). Screens: composer-390.png, held-390.png,
 * issues-390.png, issues-1280.png; pictures: original.png (what the model saw) and masked.png (what GitHub got).
 *
 * Checks (one PASS/FAIL line each; exit 0 only when every check passes; the last line is `N/N checks passed`):
 * P1 the stored masked.png differs from the original and the record lists the bubble's user texts.
 * P2 /api/here hands the report to the extension; the rewrite request carries the original picture.
 * P3 a rewrite that copies the question is held with the leak reason, GitHub gets no issue, /issues shows `보류 · ...`.
 * P4 after 다시 시도 a clean rewrite posts one issue whose title and body hold none of the private texts or the sid,
 *    and the uploaded picture is the masked one.
 * P5 no image-capable model holds the second report with `그림을 읽을 수 있는 모델이 없습니다`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedThread, startFakeGitHub, startInboxServer, submit } from "./report-fixture.mjs";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : fs.mkdtempSync(path.join(os.tmpdir(), "report-public-qa-out-"));
const SID = "qa-public-a";
const TITLE = "vlay 결제 화면 정리";
const QUESTION = "결제 모듈 커밋을 두 개로 나눌지 정해 주세요";
const DESCRIPTION = "선택지 버튼이 말풍선 밖으로 넘쳐요";
const CLEAN = "질문 말풍선의 글자가 잘립니다\n\n### 문제\n말풍선 안 글자가 오른쪽에서 잘립니다.\n\n### 위치\n대화 화면의 질문 말풍선\n\n### 재현 순서\n1. 질문이 온 대화를 폰 너비로 엽니다.\n2. 말풍선 오른쪽을 봅니다.";
const HELD_LEAK = "공개 글에 화면 속 글자가 그대로 있어 올리지 않았습니다";
const HELD_MODEL = "그림을 읽을 수 있는 모델이 없습니다";
const POST = { "content-type": "application/json", "x-inbox": "1" };

const checks = [];
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const fmt = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "report-public-qa-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const fake = startFakeGitHub({ private: false, hasIssues: true });
let server = null;
let view = null;
let exitError = null;

const ev = (expr) => view.evaluate(expr);
const cdp = (m, p) => view.cdp(m, p || {});
const waitFor = (cond, ms, what) =>
	ev(`new Promise((resolve, reject) => { const t0 = performance.now(); const tick = () => { let ok = false; try { ok = Boolean(${cond}); } catch {} if (ok) resolve(true); else if (performance.now() - t0 > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${what}`)})); else setTimeout(tick, 25); }; tick(); })`);
const settle = () => ev("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))))");
const tap = async (x, y) => {
	await cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 0 }] });
	await cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const shot = async (name) => {
	const res = await cdp("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(path.join(OUT, name), Buffer.from(res.data, "base64"));
	console.log(`saved ${path.join(OUT, name)}`);
};
const metrics = async (width, height, touch) => {
	await cdp("Emulation.setTouchEmulationEnabled", touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
	await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: touch ? 2 : 1, mobile: touch });
};
const open = async (route) => {
	await view.navigate("about:blank");
	await view.navigate(`${server.base}${route}`);
};
const centerOf = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const DIALOG = `document.querySelector("dialog[data-report-composer][open]")`;

async function api(method, route, body) {
	const res = await fetch(server.base + route, { method, headers: body === undefined ? { accept: "application/json" } : POST, body: body === undefined ? undefined : JSON.stringify(body) });
	return { status: res.status, json: await res.json().catch(() => null) };
}
async function until(fn, ms, what) {
	const t0 = Date.now();
	let last = null;
	while (Date.now() - t0 < ms) {
		last = await fn();
		if (last) return last;
		await sleep(100);
	}
	throw new Error(`deadline: ${what}`);
}
// The extension's poll: /api/here answers reportRewrite while a report waits (a bounded poll; the script has no event).
const job = () => until(async () => (await api("GET", `/api/here?cwd=${encodeURIComponent(path.join(home, "checkout"))}&session=qa-ext`)).json?.reportRewrite?.id ?? null, 15000, "rewrite job on /api/here");
const row = (id) => api("GET", `/api/reports/${id}`).then((r) => r.json);
const rowIs = (id, pred, what) => until(async () => { const r = await row(id); return r && pred(r) ? r : null; }, 15000, what);

try {
	server = await startInboxServer({ app: APP, port: 0, home, env: { INBOX_GITHUB_API: fake.url } });
	await seedThread(server.base, {
		id: SID, title: TITLE, product: "vlay", branch: "feat/pay", firstRequest: "결제 화면을 정리해 줘",
		items: [{ kind: "turn", policy: "needs-you", dedupeKey: "turn:qa-public:1", raw: { text: QUESTION, request: "결제 화면을 정리해 줘" } }],
	});
	view = new Bun.WebView({ width: 390, height: 844 });
	await view.navigate("about:blank");
	await metrics(390, 844, true);

	// ===== the composer on the bubble, with the redrawn picture =====
	await open(`/s/${SID}`);
	await waitFor(`document.getElementById("chat")?.getAttribute("aria-busy") === "false" && Boolean(window.__inboxReporter) && Boolean(document.querySelector(".foot [data-action='report']"))`, 15000, "thread ready");
	await settle();
	const foot = await centerOf(".foot [data-action='report']");
	await settle();
	await tap(foot.x, foot.y);
	await waitFor(`${DIALOG} !== null`, 10000, "composer open");
	await waitFor(`(() => { const t = ${DIALOG}.querySelector(".report__thumb"); return t && !t.hidden && t.complete && t.naturalWidth > 0; })()`, 20000, "picture drawn");
	await ev(`(() => { const ta = ${DIALOG}.querySelector("textarea"); ta.value = ${JSON.stringify(DESCRIPTION)}; ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
	await settle();
	await shot("composer-390.png");
	const send = await ev(`(() => { const b = [...${DIALOG}.querySelectorAll("button")].find((x) => x.textContent.trim() === "보내기"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	await tap(send.x, send.y);
	const list = await until(async () => { const r = await api("GET", "/api/reports?limit=10"); return r.json?.items?.length ? r.json : null; }, 15000, "report stored");
	const id = list.items[0].id;

	// P1: masked twin stored beside the original, user texts on the record
	const dir = path.join(home, "data", "reports", id);
	const original = fs.readFileSync(path.join(dir, "image.png"));
	const masked = fs.existsSync(path.join(dir, "masked.png")) ? fs.readFileSync(path.join(dir, "masked.png")) : null;
	fs.writeFileSync(path.join(OUT, "original.png"), original);
	if (masked) fs.writeFileSync(path.join(OUT, "masked.png"), masked);
	const record = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
	const texts = record.report.mask?.texts ?? [];
	check("P1 masked.png is stored, differs from the original, and the record lists the bubble's user texts",
		masked !== null && !masked.equals(original) && texts.some((text) => text.includes(QUESTION)),
		fmt({ masked: masked?.length ?? null, original: original.length, texts }));

	// P2: the extension's job and request
	const first = await job();
	const request = await api("GET", `/api/reports/${id}/rewrite`);
	check("P2 /api/here hands the report to the extension and the request carries the original picture",
		first === id && request.status === 200 && request.json.image?.data === original.toString("base64") && request.json.user.includes(DESCRIPTION),
		fmt({ first, id, status: request.status, image: Boolean(request.json?.image) }));

	// P3: a rewrite that copies the question is held
	const leaked = await api("POST", `/api/reports/${id}/rewrite`, { text: `버튼이 넘칩니다\n\n"${QUESTION}" 말풍선`, model: "qa/fake-vision" });
	const held = await rowIs(id, (r) => r.state === "held", "held row");
	await open("/issues");
	await waitFor(`[...document.querySelectorAll(".state")].some((n) => n.textContent.startsWith("보류 · "))`, 10000, "held row on /issues");
	const heldText = await ev(`[...document.querySelectorAll(".state")].map((n) => n.textContent)`);
	await settle();
	await shot("held-390.png");
	check("P3 a rewrite copying the question is held with the leak reason, no issue is created, /issues shows 보류",
		leaked.json?.state === "held" && held.detail === HELD_LEAK && fake.issues.length === 0 && heldText.includes(`보류 · ${HELD_LEAK}`),
		fmt({ leaked: leaked.json, detail: held.detail, issues: fake.issues.length, heldText }));

	// P4: 다시 시도, then a clean rewrite goes out with the masked picture
	const retry = await ev(`(() => { const b = [...document.querySelectorAll("button[data-action='retry']")][0]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
	await tap(retry.x, retry.y);
	const again = await job();
	const clean = await api("POST", `/api/reports/${again}/rewrite`, { text: CLEAN, model: "qa/fake-vision" });
	const sent = await rowIs(id, (r) => r.state === "sent" && r.github, "sent row");
	const issue = fake.issues[0] ?? {};
	const issueText = `${issue.title ?? ""}\n${issue.body ?? ""}`;
	const uploaded = Object.entries(fake.files).map(([key, value]) => ({ key, bytes: Buffer.isBuffer(value) ? value : Buffer.from(value?.content ?? value?.bytes ?? "", value?.content ? "base64" : undefined) }));
	const leaks = [TITLE, QUESTION, DESCRIPTION, SID, "vlay"].filter((secret) => issueText.includes(secret));
	fs.writeFileSync(path.join(OUT, "issue.md"), issueText);
	check("P4 after 다시 시도 a clean rewrite posts one issue without the private texts or the sid, with the masked picture",
		again === id && clean.json?.state === "pending" && Boolean(sent.github) && fake.issues.length === 1 && leaks.length === 0 &&
			issueText.includes("질문 말풍선의 글자가 잘립니다") && uploaded.some((file) => file.bytes.equals(masked)) && !uploaded.some((file) => file.bytes.equals(original)),
		fmt({ again, clean: clean.json, github: sent.github, issues: fake.issues.length, leaks, files: uploaded.map((file) => [file.key, file.bytes.length]) }));

	// P5: no image-capable model
	const second = await submit(server.base, {
		v: 2, reportId: crypto.randomUUID(), description: "목록 줄 간격이 좁아요",
		page: { kind: "issues", route: "/issues/new", url: "/issues/new", title: "제보함", frames: [] },
		element: null,
		view: { layout: { w: 390, h: 844 }, visual: { x: 0, y: 0, w: 390, h: 844, scale: 1 }, scroll: { x: 0, y: 0 }, dpr: 2, colorScheme: "light", pointer: "coarse" },
		source: null, image: null,
	});
	const secondJob = await job();
	await api("POST", `/api/reports/${secondJob}/rewrite`, { unavailable: "no_model" });
	const noModel = await rowIs(second.id, (r) => r.state === "held", "no-model row");
	await open("/issues");
	await waitFor(`[...document.querySelectorAll(".state")].some((n) => n.textContent === ${JSON.stringify(`보류 · ${HELD_MODEL}`)})`, 10000, "no-model row on /issues");
	await settle();
	await shot("issues-390.png");
	await metrics(1280, 800, false);
	await open("/issues");
	await waitFor(`document.querySelectorAll(".state").length >= 2`, 10000, "rows at 1280");
	await settle();
	await shot("issues-1280.png");
	check("P5 no image-capable model holds the report with its reason", secondJob === second.id && noModel.detail === HELD_MODEL, fmt({ secondJob, detail: noModel.detail }));
} catch (error) {
	exitError = error;
	check("run completed", false, error && error.stack ? error.stack : String(error));
} finally {
	try {
		if (view) await view.close();
	} catch {
		// already gone
	}
	try {
		if (server) await server.stop();
	} catch (error) {
		console.log(`cleanup: server stop failed: ${error && error.message ? error.message : error}`);
	}
	await fake.stop();
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`cleanup: server stopped, fake GitHub stopped, browser closed, temp removed ${!fs.existsSync(tmp)}; output in ${OUT}`);
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed || exitError ? 1 : 0);
