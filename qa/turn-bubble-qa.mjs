/* Real-browser QA for thread summary terms and per-message speech (plan todo 20).
 *
 * Usage: bun qa/turn-bubble-qa.mjs [app dir, default the repo] [evidence dir]
 * Starts a temp-home server on port 4397, seeds two live turn items, and drives a Bun.WebView.
 * Screenshots cover the popover in 390 px light/dark and 1280 px light, plus listening at 390 px.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const OUT = path.resolve(process.argv[3] || path.join(APP, ".omo", "evidence", "inbox-turn-review"));
const PORT = 4397;
const base = `http://127.0.0.1:${PORT}`;
const POST = { "content-type": "application/json", "x-inbox": "1" };
const SID = "qa-bubble-live-0001";
const checks = [];

function check(name, ok, detail = "") {
	checks.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

const fmt = (value) => JSON.stringify(value);
const STUB = `(() => {
	if (localStorage.getItem("qa.speechOff") === "1") {
		delete window.speechSynthesis;
		return "off";
	}
	window.__spoken = [];
	window.__cancels = 0;
	const fake = {
		speaking: false,
		pending: false,
		paused: false,
		getVoices: () => [],
		cancel() { window.__cancels++; },
		resume() {},
		speak(utterance) { window.__spoken.push(utterance); },
	};
	Object.defineProperty(window, "speechSynthesis", { value: fake, configurable: true, writable: true });
	window.SpeechSynthesisUtterance = function (text) { this.text = text; };
	return "stubbed";
})()`;
const FETCH_HOOK = `(() => {
	const original = window.fetch.bind(window);
	window.__threadPollSeen = 0;
	window.fetch = async (...args) => {
		const response = await original(...args);
		if (String(args[0]).includes("/api/threads/") && String(args[0]).includes("?since=")) {
			window.__threadPollSeen++;
		}
		return response;
	};
})()`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-turn-bubble-"));
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ v: 1, port: PORT, publicBase: null, pcTailnetIps: [], owner: null }));

async function api(method, route, body) {
	const response = await fetch(base + route, {
		method,
		headers: method === "POST" ? POST : { accept: "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	let json = null;
	try {
		json = await response.json();
	} catch {}
	return { status: response.status, json };
}

async function must(method, route, body) {
	const response = await api(method, route, body);
	if (response.status !== 200) throw new Error(`${method} ${route} -> ${response.status} ${fmt(response.json)}`);
	return response.json;
}

async function seed() {
	const cwd = tmp.replaceAll("\\", "/");
	await must("GET", `/api/here?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(SID)}`);
	await must("POST", `/api/threads/${SID}/meta`, { title: "추가조사 표시 QA" });
	const first = await must("POST", `/api/threads/${SID}/items`, {
		kind: "turn",
		policy: "needs-you",
		dedupeKey: "turn:bubble:first",
		raw: { text: "감시 항목별 추가조사 표시를 고쳤어요.", request: "멈춰 주세요" },
	});
	await must("POST", `/api/items/${first.item.id}/summary`, { text: JSON.stringify({
		kind: "report",
		headline: "추가조사 표시를 넣었어요",
		context: "감시 항목을 고치는 중",
		body: "감시 항목별 추가조사 표시와 급증 보류를 고쳤어요.",
		ask: null,
		options: [],
		terms: [
			{ term: "추가조사 표시", meaning: "AI가 더 살펴봐야 하는지 알려주는 표시" },
			{ term: "없는말", meaning: "본문에 없는 말" },
		],
	}), model: "qa/stub" });
	const second = await must("POST", `/api/threads/${SID}/items`, {
		kind: "turn",
		policy: "needs-you",
		dedupeKey: "turn:bubble:second",
		raw: { text: "두 번째 작업도 마쳤습니다.", request: "계속해 주세요" },
	});
	await must("POST", `/api/items/${second.item.id}/summary`, { text: JSON.stringify({
		kind: "report",
		headline: "두 번째 작업을 마쳤어요",
		context: "확인 항목을 정리하는 중",
		body: "두 번째 확인 항목을 정리했어요.",
		ask: null,
		options: [],
		terms: [],
	}), model: "qa/stub" });
	const question = await must("POST", `/api/threads/${SID}/items`, {
		kind: "question",
		policy: "needs-you",
		dedupeKey: "q:bubble:third",
		raw: {
			text: "작업 방식을 정해 주세요.",
			request: { requestId: "bubble-q", questions: [{ id: "q1", header: "방식", question: "어떻게 나눌까요?", options: [{ label: "나눠서", description: "두 번에 나눕니다 (권장)" }, { label: "한 번에", description: "한 번에 합니다" }], multiSelect: false }], waitForAnswer: true, required: false, timeoutMs: 600000, askedAt: new Date().toISOString() },
		},
	});
	return { first: first.item.id, second: second.item.id, question: question.item.id };
}

const readyOnDisk = new Promise((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("server.json timeout")), 15000);
	const watcher = fs.watch(home, (_event, filename) => {
		if (filename === "server.json" && fs.existsSync(path.join(home, "server.json"))) {
			clearTimeout(timeout);
			watcher.close();
			resolve();
		}
	});
});
const server = Bun.spawn(["node", path.join(APP, "src", "server.mjs")], {
	cwd: APP,
	env: { ...process.env, OMO_INBOX_HOME: home, INBOX_NO_TAILSCALE: "1" },
	stdout: "ignore",
	stderr: "ignore",
});
const view = new Bun.WebView({ width: 1280, height: 800 });
const ev = (expression) => view.evaluate(expression);
const cdp = (method, params = {}) => view.cdp(method, params);
const waitFor = (condition, ms, label) =>
	ev(`new Promise((resolve, reject) => {
		const start = performance.now();
		const test = () => {
			let ok = false;
			try { ok = Boolean(${condition}); } catch {}
			if (ok) resolve(true);
			else if (performance.now() - start > ${ms}) reject(new Error(${JSON.stringify(`timeout: ${label}`)}));
			else setTimeout(test, 25);
		};
		test();
	})`);
const screenshot = async (name) => {
	const result = await cdp("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data, "base64"));
	console.log(`saved ${path.join(OUT, name)}`);
};
const openThread = async (sid, width, height, mobile) => {
	await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
	await view.navigate("about:blank");
	await view.navigate(`${base}/s/${sid}`);
	await waitFor("document.getElementById('chat')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('section[data-item]').length >= 1", 15000, `thread ${sid}`);
};

let ids;
try {
	await readyOnDisk;
	const health = await (await fetch(`${base}/api/health`)).json();
	if (health.port !== PORT || health.pid !== server.pid) throw new Error(`unexpected server: ${fmt(health)}, spawned pid ${server.pid}`);
	ids = await seed();
	await view.navigate("about:blank");
	await cdp("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
	await cdp("Page.addScriptToEvaluateOnNewDocument", { source: FETCH_HOOK });

	await openThread(SID, 390, 844, true);
	const itemUrl = `/api/items/${ids.first}`;
	const itemResponse = await api("GET", itemUrl);
	const item = itemResponse.json;
	const initial = await ev(`(() => {
		const section = document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"]`)});
		return { terms: [...section.querySelectorAll(".term")].map((node) => node.textContent), legacy: Boolean(section.querySelector(".terms")), foot: [...section.querySelectorAll(".foot button")].map((node) => node.textContent) };
	})()`);
	check("(1) only the headline term button appears, no legacy terms line, and API validation drops the absent term",
		initial.terms.length === 1 && initial.terms[0] === "추가조사 표시" && !initial.legacy && itemResponse.status === 200 && item.summary.summary.terms.length === 1,
		fmt({ initial, terms: item.summary.summary.terms }));

	await ev(`document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term`)}).click()`);
	await waitFor("document.querySelector('.term-pop')?.textContent.includes('AI가 더 살펴봐야 하는지 알려주는 표시')", 3000, "popover open");
	const popOpen = await ev(`(() => {
		const term = document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term`)});
		const pop = document.querySelector(".term-pop");
		return { meaning: pop?.textContent || "", expanded: term?.getAttribute("aria-expanded"), visible: Boolean(pop && pop.getBoundingClientRect().height > 0) };
	})()`);
	check("(2) tapping the term shows its meaning and aria-expanded=true",
		popOpen.visible && popOpen.expanded === "true" && popOpen.meaning.includes("AI가 더 살펴봐야 하는지 알려주는 표시"), fmt(popOpen));
	await screenshot("task-20-popover-390.png");
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await screenshot("task-20-popover-390-dark.png");
	await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

	const pollBefore = await ev("window.__threadPollSeen");
	const pollSignal = ev(`new Promise((resolve, reject) => {
		const initial = window.__threadPollSeen;
		const timer = setTimeout(() => reject(new Error("thread poll timeout")), 10000);
		const checkPoll = () => {
			if (window.__threadPollSeen > initial) { clearTimeout(timer); resolve(true); }
			else requestAnimationFrame(checkPoll);
		};
		checkPoll();
	})`);
	await pollSignal;
	const persists = await ev(`Boolean(document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term-pop`)}))`);
	check("(3) popover remains open through the next thread poll", persists, `polls ${pollBefore} -> ${await ev("window.__threadPollSeen")}`);

	await ev(`document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .body`)}).click()`);
	const outsideClosed = await ev(`(() => {
		const term = document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term`)});
		return { pop: Boolean(document.querySelector(".term-pop")), expanded: term?.getAttribute("aria-expanded") };
	})()`);
	check("(4) clicking outside the term closes its popover", !outsideClosed.pop && outsideClosed.expanded === "false", fmt(outsideClosed));

	await ev(`document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term`)}).click()`);
	await waitFor("document.querySelector('.term-pop')", 3000, "popover reopened");
	await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
	const escapeClosed = await ev(`(() => {
		const term = document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term`)});
		return { pop: Boolean(document.querySelector(".term-pop")), focused: document.activeElement === term };
	})()`);
	check("(5) Escape closes the popover and returns focus to its term", !escapeClosed.pop && escapeClosed.focused, fmt(escapeClosed));

	const speechInitial = await ev("({ available: 'speechSynthesis' in window, spoken: window.__spoken.length })");
	check("(6) page load does not speak automatically", speechInitial.available && speechInitial.spoken === 0, fmt(speechInitial));
	await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
	await ev(`document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term`)}).click()`);
	await waitFor("document.querySelector('.term-pop')", 3000, "desktop popover");
	await screenshot("task-20-popover-1280.png");
	await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
	await ev(`document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .term`)}).click()`);

	const listenSelector = `section[data-item="${ids.first}"] .foot button`;
	const firstFoot = await ev(`document.querySelector(${JSON.stringify(listenSelector)})?.textContent`);
	await ev(`document.querySelector(${JSON.stringify(listenSelector)}).click()`);
	const speech = await ev(`(() => ({
		spoken: window.__spoken.map((utterance) => String(utterance.text)),
		langs: window.__spoken.map((utterance) => String(utterance.lang)),
		button: document.querySelector(${JSON.stringify(listenSelector)})?.textContent,
	}))()`);
	check("(7) first footer button is 듣기; clicking reads the headline and context in ko-KR, then says 멈추기",
		firstFoot === "듣기" && speech.spoken[0] === "추가조사 표시를 넣었어요." &&
			speech.spoken.includes("하던 일.") && speech.spoken.includes("감시 항목을 고치는 중.") && speech.langs.length > 0 &&
			speech.langs.every((lang) => lang === "ko-KR") && speech.button === "멈추기",
		fmt({ firstFoot, ...speech }));
	await screenshot("task-20-listening-390.png");

	await ev(`document.querySelector(${JSON.stringify(`section[data-item="${ids.second}"] .foot button`)}).click()`);
	const switched = await ev(`(() => ({
		cancels: window.__cancels,
		first: document.querySelector(${JSON.stringify(`section[data-item="${ids.first}"] .foot button`)})?.textContent,
		second: document.querySelector(${JSON.stringify(`section[data-item="${ids.second}"] .foot button`)})?.textContent,
	}))()`);
	check("(8) starting T2 cancels T1 and transfers the listening button", switched.cancels >= 1 && switched.first === "듣기" && switched.second === "멈추기", fmt(switched));
	const ended = await ev(`(() => {
		const utterances = window.__spoken;
		const last = utterances[utterances.length - 1];
		last?.onend?.();
		return document.querySelector(${JSON.stringify(`section[data-item="${ids.second}"] .foot button`)})?.textContent;
	})()`);
	check("(9) last utterance onend restores T2's button to 듣기", ended === "듣기", ended);

	{
		const heard = await ev(`(() => {
			window.__spoken.length = 0;
			const button = document.querySelector(${JSON.stringify(`section[data-item="${ids.question}"] [data-action="listen"]`)});
			if (!button) return { missing: true };
			button.click();
			return { text: window.__spoken.map((u) => u.text).join(" ") };
		})()`);
		check("(11) 듣기 on a question reads the options the bubble shows, the recommended one first and marked 추천", !heard.missing && /방식\. 어떻게 나눌까요/.test(heard.text) && /1번\.?\s*나눠서, 추천/.test(heard.text) && /2번\.?\s*한 번에/.test(heard.text), fmt(heard));
	}
	await ev(`localStorage.setItem("qa.speechOff", "1")`);
	await openThread(SID, 390, 844, true);
	const noSpeech = await ev(`({ available: "speechSynthesis" in window, buttons: document.querySelectorAll('[data-action="listen"]').length })`);
	check("(10) no listen control is rendered when speech synthesis is unavailable", !noSpeech.available && noSpeech.buttons === 0, fmt(noSpeech));
} catch (error) {
	check("run completed", false, error?.stack ? error.stack : String(error));
} finally {
	try {
		await view.close();
	} catch {}
	server.kill();
	await server.exited;
	fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	console.log(`cleanup: server PID ${server.pid} exited ${server.exitCode}; browser closed; temp removed ${!fs.existsSync(tmp)}`);
}

const failed = checks.filter((entry) => !entry.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
