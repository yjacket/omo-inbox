// Summary evaluation on the real session corpus (plan todo 27).
// Usage:
//   node qa/summary-eval.mjs sample                  build summary-cases.json (seed 42)
//   node qa/summary-eval.mjs run [--round N] [--broken]   generate, validate, judge, write results
// Corpus text and results live only under .omo/evidence/omo-inbox/ (gitignored).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const EVIDENCE = path.join(root, ".omo", "evidence", "omo-inbox");
const REPORT_EVIDENCE = path.join(root, ".omo", "evidence", "inbox-report-flow");
const CASES = path.join(EVIDENCE, "summary-cases.json");
const NAMED_CASE_SETS = ["episodes", "lines"];
const NAMED_CASES = path.join(REPORT_EVIDENCE, "task-15-cases.json");
const SESSIONS = path.join(os.homedir(), ".omo", "agent", "sessions");
const summary = await import(pathToFileURL(path.join(root, "src", "summary.mjs")).href);

// Shipped default list: read from the DEFAULT_SUMMARY constant in src/server.mjs so the eval measures what ships.
let GEN_MODELS = JSON.parse(
	/const DEFAULT_SUMMARY = \{[^}]*?models: (\[[^\]]*\])/.exec(fs.readFileSync(path.join(root, "src", "server.mjs"), "utf8"))[1],
);
let JUDGE_MODEL = "chatgpt-subscription/gpt-6-sol"; // must differ from every generator model; override with --judge
const NO_FLAGS = ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"];
const CALL_TIMEOUT_MS = 240_000;
const POOL = 5;
const LIMITS = { headline: 40, context: 120, body: 300, ask: 120, ifNoAnswer: 80, title: 24 };
const KINDS = ["question", "approval", "permission", "blocked", "done", "report", "progress"];

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffle(list, rand) {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (entry.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

const textOf = (content) =>
	Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join("") : typeof content === "string" ? content : "";

function isRealUser(text) {
	const t = text.trim();
	return t && !t.startsWith("[Answer to question") && !t.startsWith("<system-reminder") && !t.startsWith("<environment_context");
}

function extractSession(file) {
	const entries = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// skip broken line
		}
	}
	const header = entries[0];
	const cwd = header?.cwd ?? "";
	if (header?.type !== "session" || header.parentSession) return null;
	const msgs = entries.filter((e) => e.type === "message" && e.message);
	const turns = [];
	const asks = [];
	let first = "";
	let last = "";
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i].message;
		if (m.role === "user") {
			const text = textOf(m.content);
			if (isRealUser(text)) {
				if (!first) first = text;
				last = text;
			}
			continue;
		}
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const ask = m.content.find((p) => p?.type === "toolCall" && p.name === "ask_user_question");
		if (ask?.arguments?.questions?.length) asks.push({ args: ask.arguments, first, last });
		const hasCall = m.content.some((p) => p?.type === "toolCall");
		const next = msgs[i + 1]?.message;
		const text = textOf(m.content);
		if (!hasCall && text.trim() && (!next || next.role === "user")) turns.push({ text, first, last });
	}
	return { session: path.basename(file), cwd, turns, asks };
}

function pickCapped(shuffled, count, cap = 2) {
	const used = {};
	const out = [];
	for (const c of shuffled) {
		if ((used[c.session] ?? 0) >= cap) continue;
		used[c.session] = (used[c.session] ?? 0) + 1;
		out.push(c);
		if (out.length >= count) break;
	}
	return out;
}

// --- curated episode and line cases (plan todo 15) -------------------------
// The episode cases feed buildSummaryRequest {episodeLines}; the line cases feed
// buildLineRequest and finalizeLine. The real span is a reconstruction of the
// 2026-10-18 session transcript 2026-10-16T20-12-35-777Z_01a14658... (19:34-19:46).
const at = (h, m) => `2026-10-18T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const stamp = (h, m) => Date.parse(at(h, m));

function episode(spec) {
	return { type: "episode", bucket: "episode", ...spec };
}

function line(spec) {
	return { type: "line", bucket: "line", ...spec };
}

function episodeItem(request, final, closeReason, extra = {}) {
	const openedAt = extra.openedAt ?? stamp(19, 34);
	const closedAt = extra.closedAt ?? stamp(19, 46);
	return {
		kind: extra.kind ?? "turn",
		raw: { request, final, ...(extra.goal ? { goal: { objective: extra.goal } } : {}) },
		...(extra.stalled ? { meta: { stalled: true } } : {}),
		meta: {
			...(extra.stalled ? { stalled: true } : {}),
			episode: {
				key: extra.key ?? `e:case:${openedAt}`,
				opener: extra.opener ?? openedAt,
				openedAt,
				closedAt,
				closeReason,
				lines: extra.lines ?? 0,
				turns: extra.turns ?? 1,
				interjections: extra.interjections ?? 0,
				questions: extra.questions ?? 0,
			},
		},
	};
}

const EPISODE_CASES = [
	episode({
		id: "episode-real-1859-1946",
		session: "2026-10-16T20-12-35-777Z_01a14658-5241-79c1-a5c6-fc15b8380a83",
		cwd: "C:/dev/omo/omo-desk",
		title: "Inbox 보고 방식 재설계",
		product: "omo-inbox",
		firstRequest: "받은함 이름을 Inbox로 바꾸고 keepwarm 세션의 진행 중 상태를 고쳐 줘. 원문 보기도 마크다운으로 보여 줘.",
		lastRequest: "잠시 작업을 멈춰라. keepwarm 을 왜 건드리냐",
		item: episodeItem(
			"답변을 쓰다 말았다 이어서 다시 보내준다. Inbox 보고 3건이 왜 뜬금없고 과하게 들리는지 조사해 줘.",
			"작업을 멈췄습니다. 지금 이 세션에서 돌고 있는 작업은 없습니다. keepwarm은 고치거나 실행하거나 리로드하지 않았습니다. 한 일은 읽기뿐입니다. 원인 조사와 수정 뒤 확인 내역만 보고합니다.",
			"done",
			{ openedAt: stamp(19, 34), closedAt: stamp(19, 46), lines: 7, turns: 2, interjections: 1 },
		),
		episodeLines: [
			{ at: at(19, 34), headline: "요청을 원인 조사로 이해했습니다. 첫 입력 시각과 보고 3건의 출처를 확인합니다" },
			{ at: at(19, 34), headline: "18시 59분 이후 Inbox 보고 3건의 원문과 요약을 찾았습니다" },
			{ at: at(19, 35), headline: "원인은 짧은 상태 메모와 대기 오판, 그리고 맥락 누락입니다" },
			{ at: at(19, 36), headline: "README 명세와 요약 입력 코드 수정을 시작했습니다" },
			{ at: at(19, 38), headline: "테스트와 브라우저, 실제 세션 점검을 다시 돌리는 중입니다" },
			{ at: at(19, 44), headline: "동작 점검 50건과 실제 세션 점검 11건이 모두 통과했습니다" },
			{ at: at(19, 45), text: "잠시 작업을 멈춰라. keepwarm 을 왜 건드리냐" },
		],
	}),
	episode({
		id: "episode-background-wait",
		session: "s-background-wait",
		cwd: "C:/dev/omo/omo-inbox",
		title: "전체 점검 백그라운드 실행",
		product: "omo-inbox",
		firstRequest: "전체 테스트와 브라우저 점검을 실행해 줘.",
		lastRequest: "전체 테스트와 브라우저 점검을 실행해 줘.",
		item: episodeItem(
			"전체 테스트와 브라우저 점검을 실행해 줘.",
			"전체 테스트 617건과 브라우저 점검 50건이 모두 통과했습니다. 남은 작업은 없습니다.",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 8), lines: 4, goal: "전체 점검을 통과시킨다" },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "전체 테스트를 백그라운드로 돌렸습니다" },
			{ at: at(19, 3), headline: "브라우저 점검도 백그라운드로 시작했습니다" },
			{ at: at(19, 5), headline: "테스트 400건이 지금까지 통과했습니다" },
			{ at: at(19, 7), headline: "백그라운드 점검이 끝나면 결과를 정리합니다" },
		],
	}),
	episode({
		id: "episode-board-wait",
		session: "s-board-wait",
		cwd: "C:/dev/omo/omo-inbox",
		title: "닫은 세션 표시 결정",
		product: "omo-inbox",
		firstRequest: "닫은 세션을 목록에서 어떻게 보여 줄지 정해 줘.",
		lastRequest: "닫은 세션을 목록에서 어떻게 보여 줄지 정해 줘.",
		item: episodeItem(
			"닫은 세션을 목록에서 어떻게 보여 줄지 정해 줘.",
			"보드 답이 없어 권장안대로 진행했습니다. 세션을 닫으면 대화를 끝남으로 옮기고 푸시와 캐시 알림에서 뺍니다.",
			"done",
			{ openedAt: stamp(19, 4), closedAt: stamp(19, 20), lines: 4, questions: 1, goal: "닫은 세션 표시를 정한다" },
		),
		episodeLines: [
			{ at: at(19, 5), headline: "세 가지 표시 방식을 비교했습니다" },
			{ at: at(19, 7), headline: "결정 보드에 권장안과 선택지를 올렸습니다" },
			{ at: at(19, 12), headline: "보드 답을 기다리는 중입니다" },
			{ at: at(19, 18), headline: "답이 없어 권장안으로 구현을 진행합니다" },
		],
	}),
	episode({
		id: "episode-stalled",
		session: "s-stalled",
		cwd: "C:/dev/omo/omo-inbox",
		title: "모니터 대기 중 멈춤",
		product: "omo-inbox",
		firstRequest: "파일이 생기면 이어서 처리해 줘.",
		lastRequest: "파일이 생기면 이어서 처리해 줘.",
		item: episodeItem(
			"파일이 생기면 이어서 처리해 줘.",
			"기다리던 파일이 나타나지 않아 작업을 멈춤으로 표시했습니다. 파일이 생기면 이어서 처리할 수 있습니다.",
			"stalled",
			{ openedAt: stamp(19, 10), closedAt: stamp(19, 21), lines: 3, stalled: true, goal: "파일이 생기면 처리를 이어간다" },
		),
		episodeLines: [
			{ at: at(19, 11), headline: "파일 감시를 걸었습니다" },
			{ at: at(19, 15), headline: "아직 파일이 생기지 않았습니다" },
			{ at: at(19, 20), headline: "진전 신호가 없어 기다리는 상태입니다" },
		],
	}),
	episode({
		id: "episode-owner-midway",
		session: "s-owner-midway",
		cwd: "C:/dev/omo/omo-inbox",
		title: "보고 문구 다듬기",
		product: "omo-inbox",
		firstRequest: "보고 문구를 더 짧게 다듬어 줘.",
		lastRequest: "제목도 한국어로 바꿔 줘.",
		item: episodeItem(
			"보고 문구를 더 짧게 다듬어 줘.",
			"문구를 짧게 다듬고 제목도 한국어로 바꿨습니다. 테스트는 모두 통과했습니다.",
			"done",
			{ openedAt: stamp(19, 2), closedAt: stamp(19, 14), lines: 5, turns: 2, interjections: 1 },
		),
		episodeLines: [
			{ at: at(19, 3), headline: "긴 보고 문장을 짧은 문장으로 나눴습니다" },
			{ at: at(19, 5), text: "제목도 한국어로 바꿔 줘." },
			{ at: at(19, 7), headline: "제목 생성에 한국어 규칙을 넣었습니다" },
			{ at: at(19, 10), headline: "바뀐 문구로 테스트를 다시 돌렸습니다" },
			{ at: at(19, 13), headline: "남은 문구 검토를 마쳤습니다" },
		],
	}),
	episode({
		id: "episode-different-product",
		session: "s-different-product",
		cwd: "C:/dev/omo/omo-inbox",
		title: "광고 소재 등록 자동화",
		product: "네이버 광고 등록 도구",
		expectProduct: "네이버 광고",
		differentProduct: true,
		firstRequest: "네이버 광고 확장소재와 파워링크 등록을 자동화해 줘.",
		lastRequest: "네이버 광고 확장소재와 파워링크 등록을 자동화해 줘.",
		item: episodeItem(
			"네이버 광고 확장소재와 파워링크 등록을 자동화해 줘.",
			"확장소재와 파워링크 등록 흐름을 자동화했습니다. 미리보기와 검증까지 통과했습니다.",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 9), lines: 4 },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "광고 소재 등록 화면의 입력 항목을 확인했습니다" },
			{ at: at(19, 3), headline: "확장소재와 파워링크 등록 순서를 정리했습니다" },
			{ at: at(19, 6), headline: "등록 자동화를 구현하고 미리보기로 확인했습니다" },
			{ at: at(19, 8), headline: "잘못된 입력을 걸러 내는 검증을 추가했습니다" },
		],
	}),
	episode({
		id: "episode-english-final",
		session: "s-english-final",
		cwd: "C:/dev/omo/omo-inbox",
		title: "Settle timer fix",
		product: "omo-inbox",
		firstRequest: "Fix the lost turn item after a reload.",
		lastRequest: "Fix the lost turn item after a reload.",
		item: episodeItem(
			"Fix the lost turn item after a reload.",
			"The turn item now survives a reload: the extension re-reads the session and posts the final once. All tests pass (529/529).",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 7), lines: 4 },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "재현 테스트를 먼저 추가했습니다" },
			{ at: at(19, 3), headline: "리로드 뒤 세션 기록을 다시 읽도록 고쳤습니다" },
			{ at: at(19, 5), headline: "중복 항목이 생기지 않는지 확인했습니다" },
			{ at: at(19, 6), headline: "전체 테스트 529건이 통과했습니다" },
		],
	}),
	episode({
		id: "episode-blocked",
		session: "s-blocked",
		cwd: "C:/dev/omo/omo-inbox",
		title: "자격 증명 만료",
		product: "omo-inbox",
		firstRequest: "실제 세션 점검을 다시 실행해 줘.",
		lastRequest: "실제 세션 점검을 다시 실행해 줘.",
		item: episodeItem(
			"실제 세션 점검을 다시 실행해 줘.",
			"로그인 자격 증명이 만료되어 실제 세션 점검을 실행할 수 없습니다. 새 자격 증명이 필요합니다.",
			"blocked",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 3), lines: 3 },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "점검 환경을 준비했습니다" },
			{ at: at(19, 2), headline: "로그인 단계에서 자격 증명 만료를 확인했습니다" },
			{ at: at(19, 3), headline: "새 자격 증명 없이는 진행할 수 없습니다" },
		],
	}),
	episode({
		id: "episode-needs-you",
		session: "s-needs-you",
		cwd: "C:/dev/omo/omo-inbox",
		title: "두 안 중 선택",
		product: "omo-inbox",
		firstRequest: "목록과 대화 화면 중 어디에 진행 표시를 둘까?",
		lastRequest: "목록과 대화 화면 중 어디에 진행 표시를 둘까?",
		item: episodeItem(
			"목록과 대화 화면 중 어디에 진행 표시를 둘까?",
			"두 안을 비교했습니다. 목록에 두는 안을 권장합니다. 어느 쪽으로 할까요?",
			"needs-you",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 5), lines: 4, questions: 1 },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "목록과 대화 화면의 표시 위치를 비교했습니다" },
			{ at: at(19, 2), headline: "목록에 두면 한눈에 보인다는 점을 확인했습니다" },
			{ at: at(19, 3), headline: "대화 화면에 두면 맥락이 남는다는 점을 확인했습니다" },
			{ at: at(19, 4), headline: "목록에 두는 안을 권장안으로 정리했습니다" },
		],
	}),
	episode({
		id: "episode-terminal-wait",
		session: "s-terminal-wait",
		cwd: "C:/dev/omo/omo-inbox",
		title: "긴 테스트 백그라운드 대기",
		product: "omo-inbox",
		firstRequest: "전체 테스트를 돌리고 결과를 알려 줘.",
		lastRequest: "전체 테스트를 돌리고 결과를 알려 줘.",
		item: episodeItem(
			"전체 테스트를 돌리고 결과를 알려 줘.",
			"전체 테스트가 끝났고 617건 모두 통과했습니다. 실패는 없습니다.",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 10), lines: 5, goal: "테스트를 통과시킨다" },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "전체 테스트를 백그라운드로 시작했습니다" },
			{ at: at(19, 3), headline: "테스트가 아직 돌고 있습니다" },
			{ at: at(19, 5), headline: "중간 결과 300건이 통과했습니다" },
			{ at: at(19, 7), headline: "백그라운드 작업이 끝나기를 기다립니다" },
			{ at: at(19, 9), headline: "마지막 테스트 묶음이 끝났습니다" },
		],
	}),
	episode({
		id: "episode-board-answered",
		session: "s-board-answered",
		cwd: "C:/dev/omo/omo-inbox",
		title: "보드 답 반영",
		product: "omo-inbox",
		firstRequest: "닫은 세션을 어디로 옮길지 보드로 물어봐 줘.",
		lastRequest: "닫은 세션을 어디로 옮길지 보드로 물어봐 줘.",
		item: episodeItem(
			"닫은 세션을 어디로 옮길지 보드로 물어봐 줘.",
			"보드에서 끝남으로 옮기라는 답을 받아 그대로 구현했습니다. 테스트도 통과했습니다.",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 12), lines: 4, questions: 1 },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "닫은 세션 표시 선택지를 보드에 올렸습니다" },
			{ at: at(19, 4), headline: "보드 답을 기다리는 중입니다" },
			{ at: at(19, 6), headline: "끝남으로 옮기라는 답을 받았습니다" },
			{ at: at(19, 9), headline: "답대로 구현하고 테스트를 다시 돌렸습니다" },
		],
	}),
	episode({
		id: "episode-done-no-goal",
		session: "s-done-no-goal",
		cwd: "C:/dev/omo/omo-inbox",
		title: "README 문구 수정",
		product: "omo-inbox",
		firstRequest: "README에서 받은함이라는 이름을 Inbox로 바꿔 줘.",
		lastRequest: "README에서 받은함이라는 이름을 Inbox로 바꿔 줘.",
		item: episodeItem(
			"README에서 받은함이라는 이름을 Inbox로 바꿔 줘.",
			"README 두 판에서 받은함을 Inbox로 바꿨습니다. 남은 참조도 없습니다.",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 3), lines: 3 },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "README 두 판에서 바꿀 이름을 찾았습니다" },
			{ at: at(19, 2), headline: "모든 표기를 Inbox로 바꿨습니다" },
			{ at: at(19, 3), headline: "남은 표기가 없는지 다시 확인했습니다" },
		],
	}),
	episode({
		id: "episode-long-span",
		session: "s-long-span",
		cwd: "C:/dev/omo/omo-inbox",
		title: "긴 작업 구간",
		product: "omo-inbox",
		firstRequest: "보고 흐름을 처음부터 끝까지 고쳐 줘.",
		lastRequest: "보고 흐름을 처음부터 끝까지 고쳐 줘.",
		item: episodeItem(
			"보고 흐름을 처음부터 끝까지 고쳐 줘.",
			"보고 흐름을 끝까지 고쳤습니다. 진행 줄은 한 줄로 남고 마지막에 정리된 보고 한 통이 갑니다. 전체 점검이 통과했습니다.",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 16), lines: 8, goal: "보고 흐름을 고친다" },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "현재 보고 흐름과 문제 지점을 확인했습니다" },
			{ at: at(19, 3), headline: "요청 한 건당 보고 한 통 규칙을 정리했습니다" },
			{ at: at(19, 5), headline: "진행 줄을 만드는 코드를 분리했습니다" },
			{ at: at(19, 7), headline: "작업 구간의 메시지를 모으도록 고쳤습니다" },
			{ at: at(19, 9), headline: "마지막 보고 요약에 구간 전체를 넣었습니다" },
			{ at: at(19, 11), headline: "화면에서 진행 줄과 마지막 보고를 구분했습니다" },
			{ at: at(19, 13), headline: "작은 단위 점검이 모두 통과했습니다" },
			{ at: at(19, 15), headline: "브라우저와 실제 세션 점검도 통과했습니다" },
		],
	}),
	episode({
		id: "episode-different-product-2",
		session: "s-different-product-2",
		cwd: "C:/dev/omo/omo-desk",
		title: "건강 점검 알림 빈도",
		product: "건강 점검 도구",
		expectProduct: "건강 점검",
		differentProduct: true,
		firstRequest: "건강 점검 알림이 너무 자주 오지 않게 조정해 줘.",
		lastRequest: "건강 점검 알림이 너무 자주 오지 않게 조정해 줘.",
		item: episodeItem(
			"건강 점검 알림이 너무 자주 오지 않게 조정해 줘.",
			"건강 점검 알림을 하루 한 번으로 줄이고, 같은 문제는 다시 보내지 않게 했습니다. 점검이 통과했습니다.",
			"done",
			{ openedAt: stamp(19, 0), closedAt: stamp(19, 8), lines: 4 },
		),
		episodeLines: [
			{ at: at(19, 1), headline: "건강 점검 알림이 나가는 조건을 확인했습니다" },
			{ at: at(19, 3), headline: "같은 문제를 반복해 보내는 지점을 찾았습니다" },
			{ at: at(19, 5), headline: "하루 한 번만 보내도록 빈도를 조정했습니다" },
			{ at: at(19, 7), headline: "조정한 뒤 점검이 통과했습니다" },
		],
	}),
];

const LINE_CASES = [
	line({ id: "line-en-tests", session: "l1", cwd: "C:/dev/omo/omo-inbox", title: "전체 점검", product: "omo-inbox", firstRequest: "Run the full test suite.", lastRequest: "Run the full test suite.", item: { kind: "progress", raw: { text: "All 617 tests pass; no failures." } } }),
	line({ id: "line-en-cause", session: "l2", cwd: "C:/dev/omo/omo-inbox", title: "원인 확인", product: "omo-inbox", firstRequest: "Why does the turn item disappear after a reload?", lastRequest: "Why does the turn item disappear after a reload?", item: { kind: "progress", raw: { text: "I found the cause: the settle timer is cleared on reload before the turn item is posted." } } }),
	line({ id: "line-en-install", session: "l3", cwd: "C:/dev/omo/omo-inbox", title: "설치 갱신", product: "omo-inbox", firstRequest: "Update the live install.", lastRequest: "Update the live install.", item: { kind: "progress", raw: { text: "The live install is updated. Doctor reports ok for every check, and port 443 is unchanged." } } }),
	line({ id: "line-en-wait", session: "l4", cwd: "C:/dev/omo/omo-inbox", title: "백그라운드 대기", product: "omo-inbox", firstRequest: "Run the browser checks.", lastRequest: "Run the browser checks.", item: { kind: "progress", raw: { text: "The browser check is running in the background; its completion will wake this session." } } }),
	line({ id: "line-en-board", session: "l5", cwd: "C:/dev/omo/omo-inbox", title: "보드 대기", product: "omo-inbox", firstRequest: "Ask me on the board how to close sessions.", lastRequest: "Ask me on the board how to close sessions.", item: { kind: "progress", raw: { text: "The board answer did not arrive in time, so I applied the recommended option: move the thread to ended." } } }),
	line({ id: "line-en-code", session: "l6", cwd: "C:/dev/omo/omo-inbox", title: "요약 입력 수정", product: "omo-inbox", firstRequest: "Include the whole episode in the final summary.", lastRequest: "Include the whole episode in the final summary.", item: { kind: "progress", raw: { text: "I read src/server.mjs and src/summary.mjs, then changed the summary request to include every episode line." } } }),
	line({ id: "line-en-pass", session: "l7", cwd: "C:/dev/omo/omo-inbox", title: "점검 통과", product: "omo-inbox", firstRequest: "Run all checks.", lastRequest: "Run all checks.", item: { kind: "progress", raw: { text: "All checks passed: 50 browser checks and 11 real-session scenarios." } } }),
	line({ id: "line-en-blocked", session: "l8", cwd: "C:/dev/omo/omo-inbox", title: "자격 증명", product: "omo-inbox", firstRequest: "Run the real-session checks.", lastRequest: "Run the real-session checks.", item: { kind: "blocked", raw: { text: "I cannot run the real-session checks: the login credentials have expired and need to be refreshed." } } }),
	line({ id: "line-ko-tests", session: "l9", cwd: "C:/dev/omo/omo-inbox", title: "단위 점검", product: "omo-inbox", firstRequest: "전체 테스트를 돌려 줘.", lastRequest: "전체 테스트를 돌려 줘.", item: { kind: "progress", raw: { text: "작은 단위 점검 527건이 모두 통과했습니다." } } }),
	line({ id: "line-ko-qa", session: "l10", cwd: "C:/dev/omo/omo-inbox", title: "브라우저 점검", product: "omo-inbox", firstRequest: "브라우저 점검을 돌려 줘.", lastRequest: "브라우저 점검을 돌려 줘.", item: { kind: "progress", raw: { text: "브라우저 점검 50건과 실제 세션 점검 11건이 모두 통과했습니다." } } }),
	line({ id: "line-ko-cause", session: "l11", cwd: "C:/dev/omo/omo-inbox", title: "원인 조사", product: "omo-inbox", firstRequest: "왜 보고가 이상하게 보이는지 찾아 줘.", lastRequest: "왜 보고가 이상하게 보이는지 찾아 줘.", item: { kind: "progress", raw: { text: "원인을 찾았습니다. 요약 입력에 그 턴의 마지막 메시지만 들어가고 있었습니다." } } }),
	line({ id: "line-ko-wait", session: "l12", cwd: "C:/dev/omo/omo-inbox", title: "대기", product: "omo-inbox", firstRequest: "전체 점검을 백그라운드로 돌려 줘.", lastRequest: "전체 점검을 백그라운드로 돌려 줘.", item: { kind: "progress", raw: { text: "백그라운드 점검이 끝나기를 기다리고 있습니다. 끝나면 이 세션이 다시 깨어납니다." } } }),
	line({ id: "line-ko-board", session: "l13", cwd: "C:/dev/omo/omo-inbox", title: "보드 답", product: "omo-inbox", firstRequest: "닫은 세션 처리를 보드로 물어봐 줘.", lastRequest: "닫은 세션 처리를 보드로 물어봐 줘.", item: { kind: "progress", raw: { text: "결정 보드에 선택지를 올리고 답을 기다리는 중입니다." } } }),
	line({ id: "line-ko-fix", session: "l14", cwd: "C:/dev/omo/omo-inbox", title: "수정", product: "omo-inbox", firstRequest: "리로드 뒤 항목이 사라지는 문제를 고쳐 줘.", lastRequest: "리로드 뒤 항목이 사라지는 문제를 고쳐 줘.", item: { kind: "progress", raw: { text: "리로드 뒤 세션 기록을 다시 읽도록 고쳤고, 중복 항목도 생기지 않습니다." } } }),
	line({ id: "line-ko-readme", session: "l15", cwd: "C:/dev/omo/omo-inbox", title: "문서", product: "omo-inbox", firstRequest: "README 이름을 Inbox로 바꿔 줘.", lastRequest: "README 이름을 Inbox로 바꿔 줘.", item: { kind: "progress", raw: { text: "README 두 판에서 받은함 표기를 모두 Inbox로 바꿨습니다." } } }),
	line({ id: "line-ko-blocked", session: "l16", cwd: "C:/dev/omo/omo-inbox", title: "막힘", product: "omo-inbox", firstRequest: "실제 세션 점검을 돌려 줘.", lastRequest: "실제 세션 점검을 돌려 줘.", item: { kind: "blocked", raw: { text: "로그인 자격 증명이 만료되어 실제 세션 점검을 진행할 수 없습니다. 새 자격 증명이 필요합니다." } } }),
	line({ id: "line-ko-merge", session: "l17", cwd: "C:/dev/omo/omo-inbox", title: "병합", product: "omo-inbox", firstRequest: "변경 사항을 합쳐 줘.", lastRequest: "변경 사항을 합쳐 줘.", item: { kind: "progress", raw: { text: "변경 사항을 한 갈래로 합쳤고 충돌은 없었습니다. 테스트도 통과했습니다." } } }),
	line({ id: "line-ko-board-answer", session: "l18", cwd: "C:/dev/omo/omo-inbox", title: "보드 답 반영", product: "omo-inbox", firstRequest: "보드 답이 오면 반영해 줘.", lastRequest: "보드 답이 오면 반영해 줘.", item: { kind: "progress", raw: { text: "보드에서 끝남으로 옮기라는 답을 받아 그대로 구현했습니다." } } }),
	line({ id: "line-ko-stall", session: "l19", cwd: "C:/dev/omo/omo-inbox", title: "멈춤", product: "omo-inbox", firstRequest: "파일이 생기면 이어서 처리해 줘.", lastRequest: "파일이 생기면 이어서 처리해 줘.", item: { kind: "progress", raw: { text: "기다리던 파일이 아직 생기지 않아 진전이 없습니다. 파일이 생기면 이어서 처리합니다." } } }),
	line({ id: "line-ko-scope", session: "l20", cwd: "C:/dev/omo/omo-inbox", title: "범위 확인", product: "omo-inbox", firstRequest: "계획의 15번 항목을 구현해 줘.", lastRequest: "계획의 15번 항목을 구현해 줘.", item: { kind: "progress", raw: { text: "요약 평가에 작업 구간 사례 14건과 한 줄 사례 24건을 추가했습니다." } } }),
	line({ id: "line-en-screens", session: "l21", cwd: "C:/dev/omo/omo-inbox", title: "화면 점검", product: "omo-inbox", firstRequest: "Take phone and desktop screenshots.", lastRequest: "Take phone and desktop screenshots.", item: { kind: "progress", raw: { text: "The phone and desktop screenshots are captured in both light and dark themes." } } }),
	line({ id: "line-en-slow", session: "l22", cwd: "C:/dev/omo/omo-inbox", title: "성능", product: "omo-inbox", firstRequest: "Check the list load time.", lastRequest: "Check the list load time.", item: { kind: "progress", raw: { text: "A thread with 200 items now loads in under 200 milliseconds locally." } } }),
	line({ id: "line-ko-cleanup", session: "l23", cwd: "C:/dev/omo/omo-inbox", title: "정리", product: "omo-inbox", firstRequest: "임시 파일을 정리해 줘.", lastRequest: "임시 파일을 정리해 줘.", item: { kind: "progress", raw: { text: "임시로 만든 점검 파일을 모두 지웠습니다. 남은 파일은 없습니다." } } }),
	line({ id: "line-ko-version", session: "l24", cwd: "C:/dev/omo/omo-inbox", title: "버전 확인", product: "omo-inbox", firstRequest: "설치된 버전을 확인해 줘.", lastRequest: "설치된 버전을 확인해 줘.", item: { kind: "progress", raw: { text: "설치된 버전은 0.1.0이고, 실행 중인 서버도 같은 버전입니다." } } }),
];

function namedCasesFrom(argv = []) {
	const flag = argv.indexOf("--cases");
	if (flag < 0 || flag + 1 >= argv.length) return null;
	const names = argv[flag + 1].split(",").map((name) => name.trim()).filter(Boolean);
	if (!names.length || !names.every((name) => NAMED_CASE_SETS.includes(name))) return null;
	return { names, file: NAMED_CASES };
}

function buildCuratedCases(names) {
	const cases = [];
	if (names.includes("episodes")) cases.push(...EPISODE_CASES);
	if (names.includes("lines")) cases.push(...LINE_CASES);
	for (const c of cases) {
		const { item, thread, episodeLines } = toItem(c);
		if (c.type === "episode") {
			if (episodeLines.length < 3 || episodeLines.length > 8) throw new Error(`${c.id}: episode span must be 3-8 messages`);
			const request = summary.buildSummaryRequest(item, thread, { episodeLines });
			if (!request.user.includes("이번 작업 구간")) throw new Error(`${c.id}: buildSummaryRequest did not include the episode digest`);
		} else {
			const request = summary.buildLineRequest(item, thread);
			if (request.purpose !== "line" || !request.user.includes("이 메시지의 원문")) throw new Error(`${c.id}: buildLineRequest is malformed`);
		}
	}
	if (names.includes("episodes") && EPISODE_CASES.length < 12) throw new Error("need at least 12 episode cases");
	if (names.includes("lines") && LINE_CASES.length < 20) throw new Error("need at least 20 line cases");
	return cases;
}

function sample(argv = []) {
	const named = namedCasesFrom(argv);
	if (named) {
		const cases = buildCuratedCases(named.names);
		fs.mkdirSync(REPORT_EVIDENCE, { recursive: true });
		fs.writeFileSync(named.file, JSON.stringify({ seed: null, sets: named.names, cases }, null, "\t"));
		const counts = {};
		for (const c of cases) counts[c.type] = (counts[c.type] ?? 0) + 1;
		const products = cases.filter((c) => c.differentProduct).map((c) => c.expectProduct);
		console.log(`sampled ${cases.length} curated cases`, counts, "different-product-context", products);
		return;
	}
	const seedFlag = argv.indexOf("--seed");
	const seed = seedFlag >= 0 ? Number(argv[seedFlag + 1]) : 42;
	const outFlag = argv.indexOf("--out");
	const out = outFlag >= 0 ? path.resolve(argv[outFlag + 1]) : CASES;
	// A holdout sample (--out elsewhere) skips every case of the tuning sample, so it is untouched by tuning.
	const seen = new Set();
	if (out !== CASES && fs.existsSync(CASES)) {
		for (const c of JSON.parse(fs.readFileSync(CASES, "utf8")).cases) seen.add(`${c.session}|${c.type === "question" ? JSON.stringify(c.request.questions) : c.text}`);
	}
	const rand = mulberry32(seed);
	const files = walk(SESSIONS).sort();
	const turns = [];
	const asks = [];
	for (const file of files) {
		const s = extractSession(file);
		if (!s) continue;
		for (const t of s.turns) if (t.first && t.text.trim().length >= 40 && !seen.has(`${s.session}|${t.text}`)) turns.push({ ...t, session: s.session, cwd: s.cwd });
		for (const a of s.asks) if (a.first && !seen.has(`${s.session}|${JSON.stringify(a.args.questions)}`)) asks.push({ ...a, session: s.session, cwd: s.cwd });
	}
	const buckets = {
		short: turns.filter((t) => t.text.length < 400),
		medium: turns.filter((t) => t.text.length >= 400 && t.text.length <= 1500),
		long: turns.filter((t) => t.text.length > 1500),
	};
	const cases = [];
	for (const [bucket, list] of Object.entries(buckets)) {
		for (const t of pickCapped(shuffle(list, rand), 10)) {
			cases.push({
				id: `turn-${bucket}-${cases.length}`,
				type: "turn",
				bucket,
				session: t.session,
				cwd: t.cwd,
				firstRequest: t.first.slice(0, 600),
				lastRequest: t.last.slice(0, 600),
				text: t.text,
			});
		}
	}
	for (const a of pickCapped(shuffle(asks, rand), 10)) {
		cases.push({
			id: `ask-${cases.length}`,
			type: "question",
			bucket: "ask",
			session: a.session,
			cwd: a.cwd,
			firstRequest: a.first.slice(0, 600),
			lastRequest: a.last.slice(0, 600),
			request: {
				questions: a.args.questions,
				waitForAnswer: (a.args.waitForAnswer ?? a.args.wait_for_answer) !== false,
				required: a.args.required === true,
				timeoutMs: a.args.timeoutMs ?? 1_800_000, // the call carries no timeout; senpi applied askUser.timeoutMinutes (default 30)
			},
		});
	}
	fs.mkdirSync(EVIDENCE, { recursive: true });
	fs.writeFileSync(out, JSON.stringify({ seed, excluded: seen.size, pool: { turns: turns.length, asks: asks.length }, cases }, null, "\t"));
	const counts = {};
	for (const c of cases) counts[c.bucket] = (counts[c.bucket] ?? 0) + 1;
	console.log(`sampled ${cases.length} cases`, counts, "pool", { turns: turns.length, asks: asks.length });
}

function omo(model, system, user) {
	return new Promise((resolve) => {
		const args = [...NO_FLAGS, "--model", model, "--system-prompt", system, user];
		const child = spawn("omo", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let out = "";
		let err = "";
		const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS);
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, text: "", error: String(e) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ ok: code === 0 && out.trim().length > 0, text: out, error: code === 0 ? "" : `exit ${code}: ${err.slice(-300)}` });
		});
	});
}

async function pool(items, worker) {
	const results = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: POOL }, async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await worker(items[i], i);
			}
		}),
	);
	return results;
}

function toItem(c) {
	const thread = { cwd: c.cwd, firstRequest: c.firstRequest, lastRequest: c.lastRequest, title: c.title ?? "", product: c.product ?? null, branch: c.branch ?? null };
	const item =
		c.item ??
		(c.type === "question" ? { kind: "question", raw: { request: c.request, required: c.request.required } } : { kind: "turn", raw: { text: c.text } });
	return { item, thread, episodeLines: c.episodeLines ?? [] };
}

function rawJson(text) {
	const m = String(text).replace(/```[a-zA-Z]*\n?/g, "");
	const s = m.indexOf("{");
	const e = m.lastIndexOf("}");
	if (s < 0 || e < s) return null;
	try {
		return JSON.parse(m.slice(s, e + 1));
	} catch {
		return null;
	}
}

// R6: lengths checked on the model's raw JSON, before validateSummary clips anything.
function lengthViolations(raw, item) {
	if (!raw) return ["no-json"];
	const bad = [];
	for (const [k, lim] of Object.entries(LIMITS)) if (typeof raw[k] === "string" && [...raw[k]].length > lim) bad.push(`${k}:${[...raw[k]].length}>${lim}`);
	if (item.kind !== "question" && item.kind !== "permission" && raw.kind !== "question" && raw.kind !== "permission") {
		if (Array.isArray(raw.options)) {
			if (raw.options.length > 4) bad.push(`options:${raw.options.length}>4`);
			for (const o of raw.options) {
				if ([...String(o?.label ?? "")].length > 20) bad.push("option.label>20");
				if ([...String(o?.why ?? "")].length > 60) bad.push("option.why>60");
			}
		}
	}
	if (Array.isArray(raw.terms)) {
		if (raw.terms.length > 3) bad.push(`terms:${raw.terms.length}>3`);
		for (const t of raw.terms) {
			if ([...String(t?.term ?? "")].length > 20) bad.push("term>20");
			if ([...String(t?.meaning ?? "")].length > 50) bad.push("meaning>50");
		}
	}
	if (!KINDS.includes(raw.kind)) bad.push("kind-enum");
	return bad;
}

async function generate(c, systemOverride) {
	const { item, thread, episodeLines } = toItem(c);
	const req = summary.buildSummaryRequest(item, thread, { episodeLines });
	const system = systemOverride ?? req.system;
	const repairOn = !systemOverride;
	const knownLine = req.user.split("\n").find((l) => l.startsWith("사용자가 이미 아는 말:")) ?? "";
	const attempts = [];
	for (const model of GEN_MODELS) {
		const r = await omo(model, system, req.user);
		let valid = r.ok ? summary.validateSummary(r.text, item) : null;
		let finalText = r.text;
		let issues = [];
		let repaired = false;
		if (valid && repairOn) {
			issues = summary.lintSummary(r.text, item, thread);
			if (issues.length) {
				const rq = summary.buildRepairRequest(item, thread, r.text, issues, { episodeLines });
				const rr = await omo(model, rq.system, rq.user);
				const fixed = rr.ok ? summary.validateSummary(rr.text, item) : null;
				if (fixed) {
					valid = fixed;
					finalText = rr.text;
					repaired = true;
				}
			}
		}
		attempts.push({ model, ok: r.ok, valid: Boolean(valid), error: r.error, lintIssues: issues.length, repaired });
		if (valid) return { model, attempts, raw: rawJson(finalText), summary: summary.finalizeSummary(valid, item, thread), text: finalText, fallback: false, knownLine, lintIssues: issues, repaired };
	}
	const last = attempts.length ? attempts[attempts.length - 1] : null;
	return { model: last?.model ?? null, attempts, raw: null, summary: summary.finalizeSummary(summary.heuristicSummary(item, thread), item, thread), text: "", fallback: true, failure: true, knownLine };
}

const JUDGE_SYSTEM = [
	"너는 요약 품질 심사관이다. 원문과 요약을 보고 아래 기준을 각각 엄격하게 판정하라.",
	"R1: headline이 과정이 아니라 결론이나 사용자에게 하는 물음/요청을 말한다.",
	"R2: context가 읽는 사람이 세션 배경을 모른다는 전제에서, 이 세션이 무엇을 하던 중인지 이해시킨다.",
	"R3: 사용자 메시지의 '사용자가 이미 아는 말' 목록에 없는 용어 중에서, 처음 읽는 사람이 모를 전문용어/약어/내부 이름/도구 이름이 설명 없이 쓰였을 때만 실패다. 여기서 '처음 읽는 사람'은 이 제품의 실제 사용자, 즉 이 세션을 지켜보지 않은 한국인 시니어 개발자다. 일반 개발 용어(라이브러리, 로컬, 핑, 임계값, 저장소, 패치, 서버, 파일 등)는 통과이고, 이 세션·프로젝트의 내부 이름과 약어, 다른 세션이나 작업 단계의 이름, 도구 이름, 개발 밖 업계·디자인 전용 말, 고유 별명이 설명 없이 쓰였을 때만 실패다. 목록에 있는 말은 설명이 없어도 통과이고, 괄호 설명이나 terms로 풀었어도 통과이다.",
	"R4: 꼭 필요한 경우가 아니면 파일 경로, 코드, 해시, 명령어가 없다(headline, context, body, ask, options, terms 전체 기준).",
	"R5: 질문/승인 요청에만 적용. 무엇을 정해야 하는지 + 권장안(원문에 근거가 있을 때만, 없으면 권장 없이 통과) + 답이 없을 때의 영향(ifNoAnswer 또는 본문)이 드러난다. 질문/승인이 아니면 applicable=false. 단, 질문 항목은 원문 선택지가 요약 아래에 버튼으로 그대로 함께 표시되므로 options가 비어 있는 것 자체는 감점 사유가 아니다. 대신 ask가 실제로 정해야 할 것을 묻고, 원문에 권장 표시가 있으면 ask나 body에 드러나야 한다. 답이 없을 때의 영향(ifNoAnswer)은 모델이 아니라 시스템이 질문 도구의 실행 규칙으로 넣는다: required가 true가 아니면 timeoutMs가 지나 에이전트가 스스로 판단해 진행하고, required면 그 작업을 하지 않으며, waitForAnswer가 false면 에이전트는 그동안 일을 계속한다. ifNoAnswer가 이 규칙과 질문 원문(JSON)의 required·waitForAnswer·timeoutMs에 맞으면 무응답 조건은 통과다(원문 본문에 없다는 이유로 감점하지 말 것). 에이전트 답변 원문(턴 끝)은 질문 도구가 아니다: 그 세션은 턴을 마친 채 사용자의 다음 메시지를 기다리므로 '답이 없으면 세션은 이 상태로 기다립니다'가 실제 동작이다(다른 세션이나 백그라운드 작업이 따로 도는 것과 별개).",
	'출력은 JSON 하나만: {"R1":{"pass":bool,"why":"한 줄"},"R2":{...},"R3":{...},"R4":{...},"R5":{"applicable":bool,"pass":bool,"why":"한 줄"}}',
].join("\n");

async function judge(c, gen) {
	const knownLine = gen.knownLine ?? "";
	const { item } = toItem(c);
	const sourceText = String(item?.raw?.final ?? item?.raw?.text ?? c.text ?? "");
	const src = c.type === "question" ? `질문 원문(JSON): ${JSON.stringify(c.request)}` : `에이전트 답변 원문:\n${sourceText.slice(0, 6000)}`;
	const user = [
		`사용자의 첫 요청: ${c.firstRequest}`,
		`사용자의 마지막 요청: ${c.lastRequest}`,
		knownLine,
		`항목 종류: ${c.type === "question" ? "질문" : "턴 종료 보고"}`,
		src,
		"",
		`평가할 요약(JSON): ${JSON.stringify(gen.summary)}`,
	].join("\n");
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await omo(JUDGE_MODEL, JUDGE_SYSTEM, user);
		const v = r.ok ? rawJson(r.text) : null;
		if (v?.R1 && v.R2 && v.R3 && v.R4 && v.R5) return v;
	}
	return null;
}

const LINE_JUDGE_SYSTEM = [
	"You are a strict judge of Inbox progress one-liners.",
	"The one-liner is a Korean summary shown to the owner under a single agent message. Judge L3: it faithfully states what that message says or does.",
	"Pass when the line reflects the source, even if generic. Fail when it invents a fact, contradicts the source, names a different step, or states an outcome the message does not contain.",
	'Output one JSON object only: {"L3":{"pass":true,"why":"one line"}}',
].join("\n");

async function generateLine(c, systemOverride) {
	const { item, thread } = toItem(c);
	const req = summary.buildLineRequest(item, thread);
	const system = systemOverride ?? req.system;
	const attempts = [];
	for (const model of GEN_MODELS) {
		const r = await omo(model, system, req.user);
		const rawLine = String(r.text ?? "").split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
		const out = r.ok ? summary.finalizeLine(r.text) : null;
		const l1 = Boolean(out);
		const l2 = r.ok && [...rawLine].length <= LIMITS.headline;
		attempts.push({ model, ok: r.ok, valid: l1, error: r.error, rawLength: [...rawLine].length });
		if (l1) return { model, attempts, line: out, rawLine, l1, l2, l2Length: [...rawLine].length, failure: false };
	}
	return { model: attempts.length ? attempts[attempts.length - 1].model : null, attempts, line: null, rawLine: "", l1: false, l2: false, l2Length: 0, failure: true };
}

async function judgeLine(c, lineText) {
	const source = String(c.item?.raw?.text ?? c.text ?? "");
	const user = [
		`Owner's first request: ${c.firstRequest ?? ""}`,
		`Owner's last request: ${c.lastRequest ?? ""}`,
		`Thread product: ${c.product ?? "(none)"}`,
		`Agent message source:\n${source.slice(0, 4000)}`,
		"",
		`One-liner shown to the owner: ${lineText}`,
	].join("\n");
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await omo(JUDGE_MODEL, LINE_JUDGE_SYSTEM, user);
		const verdict = r.ok ? rawJson(r.text) : null;
		if (verdict?.L3) return verdict;
	}
	return null;
}

async function runLineCase(c, systemOverride) {
	const gen = await generateLine(c, systemOverride);
	const verdict = gen.line ? await judgeLine(c, gen.line) : null;
	process.stderr.write(`${c.id} model=${gen.model} fallback=${gen.failure} l1=${gen.l1} l2=${gen.l2} judged=${Boolean(verdict)}\n`);
	return {
		id: c.id,
		type: "line",
		bucket: "line",
		model: gen.model,
		attempts: gen.attempts,
		generationFailed: Boolean(gen.failure),
		rawLine: gen.rawLine,
		line: gen.line,
		l1: gen.l1,
		l2: gen.l2,
		l2Length: gen.l2Length,
		verdict,
	};
}

async function run(argv) {
	const genFlag = argv.indexOf("--gen");
	if (genFlag >= 0) GEN_MODELS = argv[genFlag + 1].split(",").filter(Boolean); // candidate evaluation: generator override, judge unchanged
	const judgeFlag = argv.indexOf("--judge");
	if (judgeFlag >= 0) JUDGE_MODEL = argv[judgeFlag + 1];
	if (GEN_MODELS.includes(JUDGE_MODEL)) {
		console.error(`refusing to run: judge ${JUDGE_MODEL} is also a generator model (${GEN_MODELS.join(", ")})`);
		process.exit(3);
	}
	const round = Number(argv[argv.indexOf("--round") + 1]) || 1;
	const broken = argv.includes("--broken");
	const smoke = argv.includes("--smoke");
	const named = namedCasesFrom(argv);
	const casesFlag = argv.indexOf("--cases");
	const casesFile = named ? named.file : casesFlag >= 0 ? path.resolve(argv[casesFlag + 1]) : CASES;
	const tagFlag = argv.indexOf("--tag");
	const customTag = tagFlag >= 0 ? argv[tagFlag + 1] : null;
	let { cases } = named && !fs.existsSync(casesFile) ? { cases: buildCuratedCases(named.names) } : JSON.parse(fs.readFileSync(casesFile, "utf8"));
	if (named && smoke) {
		const kept = [];
		const seen = { episode: 0, line: 0 };
		for (const c of cases) {
			if (c.type === "episode" && seen.episode < 3) { kept.push(c); seen.episode += 1; }
			else if (c.type === "line" && seen.line < 3) { kept.push(c); seen.line += 1; }
		}
		cases = kept;
	}
	const systemOverride = broken ? "너는 한국어 요약기다. 주어진 원문을 짧게 요약해 줘." : undefined;
	const rows = await pool(cases, async (c) => {
		if (c.type === "line") return runLineCase(c, systemOverride);
		const gen = await generate(c, systemOverride);
		const verdict = await judge(c, gen);
		const item = toItem(c).item;
		const preclip = gen.failure ? ["generation-failed"] : lengthViolations(gen.raw, item);
		const violations = lengthViolations(gen.summary, item);
		const contextHasProduct = c.expectProduct ? String(gen.summary?.context ?? "").includes(c.expectProduct) : null;
		process.stderr.write(`${c.id} model=${gen.model} fallback=${gen.fallback} r6=${violations.length ? violations.join(",") : "ok"} preclip=${preclip.length ? preclip.join(",") : "ok"} repaired=${Boolean(gen.repaired)} judged=${Boolean(verdict)}\n`);
		return {
			id: c.id,
			type: c.type,
			bucket: c.bucket,
			differentProduct: Boolean(c.differentProduct),
			expectProduct: c.expectProduct ?? null,
			contextHasProduct,
			model: gen.model,
			attempts: gen.attempts,
			generationFailed: Boolean(gen.failure),
			summary: gen.summary,
			r6Violations: violations,
			preclipOverflows: preclip,
			lintIssues: gen.lintIssues ?? [],
			repaired: Boolean(gen.repaired),
			verdict,
		};
	});
	const episodes = rows.filter((r) => r.type !== "line");
	const lineRows = rows.filter((r) => r.type === "line");
	const checks = ["R1", "R2", "R3", "R4", "R5"];
	const rates = {};
	for (const k of checks) {
		const scored = episodes.filter((r) => r.verdict && (k !== "R5" || r.verdict.R5.applicable !== false));
		const pass = scored.filter((r) => r.verdict[k].pass === true).length;
		rates[k] = { pass, total: scored.length, rate: scored.length ? pass / scored.length : 1 };
	}
	const r6pass = episodes.filter((r) => r.r6Violations.length === 0).length;
	rates.R6 = { pass: r6pass, total: episodes.length, rate: episodes.length ? r6pass / episodes.length : 0 };
	const productRows = episodes.filter((r) => r.differentProduct);
	const productPass = productRows.filter((r) => r.contextHasProduct === true).length;
	rates.P1 = { pass: productPass, total: productRows.length, rate: productRows.length ? productPass / productRows.length : 1 };
	rates.L1 = { pass: lineRows.filter((r) => r.l1).length, total: lineRows.length, rate: lineRows.length ? lineRows.filter((r) => r.l1).length / lineRows.length : 0 };
	rates.L2 = { pass: lineRows.filter((r) => r.l2).length, total: lineRows.length, rate: lineRows.length ? lineRows.filter((r) => r.l2).length / lineRows.length : 0 };
	rates.L3 = { pass: lineRows.filter((r) => r.verdict?.L3?.pass === true).length, total: lineRows.length, rate: lineRows.length ? lineRows.filter((r) => r.verdict?.L3?.pass === true).length / lineRows.length : 0 };
	const repairedCount = rows.filter((r) => r.repaired).length;
	const preclipCount = rows.filter((r) => r.preclipOverflows?.length).length;
	const genFailures = rows.filter((r) => r.generationFailed).length;
	const unjudged = rows.filter((r) => (r.type === "line" ? Boolean(r.line) && !r.verdict : !r.verdict)).length;
	const episodeAccepted = episodes.length ? checks.every((k) => rates[k].rate >= 0.9) && rates.R6.rate === 1 && rates.P1.rate === 1 : true;
	const lineAccepted = lineRows.length ? rates.L1.rate >= 0.9 && rates.L2.rate >= 0.9 && rates.L3.rate >= 0.9 : true;
	const accepted = episodeAccepted && lineAccepted && genFailures / rows.length < 0.05;
	const result = {
		round,
		broken,
		smoke,
		generatedAt: new Date().toISOString(),
		genModels: GEN_MODELS,
		judgeModel: JUDGE_MODEL,
		sets: named?.names ?? null,
		cases: rows.length,
		counts: { episodes: episodes.length, lines: lineRows.length },
		repairedCount,
		preclipCount,
		genFailures,
		unjudged,
		rates,
		accepted,
		rows,
	};
	const lines = [
		`round ${round}${broken ? " (BROKEN PROMPT, checker self-test)" : ""}${smoke ? " (SMOKE)" : ""}  cases=${rows.length} (episodes ${episodes.length}, lines ${lineRows.length})  generation failures=${genFailures}  unjudged=${unjudged}`,
		`generator: ${GEN_MODELS.join(" -> ")}  judge: ${JUDGE_MODEL}`,
		...[...checks, "R6", "P1"].map((k) => `${k}: ${rates[k].pass}/${rates[k].total} = ${(rates[k].rate * 100).toFixed(1)}%${k === "R6" || k === "P1" ? "  (need 100%)" : "  (need >= 90%)"}`),
		...["L1", "L2", "L3"].map((k) => `${k}: ${rates[k].pass}/${rates[k].total} = ${(rates[k].rate * 100).toFixed(1)}%  (need >= 90%)`),
		`repaired=${repairedCount}/${rows.length}  pre-clip overflows (informational)=${preclipCount}/${rows.length}`,
		`ACCEPTED: ${accepted}`,
		"",
		"failures:",
		...rows.flatMap((r) => {
			const out = [];
			if (r.generationFailed) out.push(`${r.id}: generation failed ${JSON.stringify(r.attempts)}`);
			if (r.type === "line") {
				if (!r.l1) out.push(`${r.id}: L1 not Korean or empty (${JSON.stringify(r.rawLine)})`);
				if (!r.l2) out.push(`${r.id}: L2 ${r.l2Length} chars > 40`);
				if (r.verdict?.L3?.pass === false) out.push(`${r.id}: L3 ${r.verdict.L3.why}`);
				if (!r.verdict) out.push(`${r.id}: L3 not judged`);
				return out;
			}
			if (r.r6Violations.length) out.push(`${r.id}: R6 ${r.r6Violations.join(",")}`);
			if (r.contextHasProduct === false) out.push(`${r.id}: context does not name ${r.expectProduct}`);
			if (r.verdict) for (const k of checks) if (r.verdict[k].pass === false && r.verdict[k].applicable !== false) out.push(`${r.id}: ${k} ${r.verdict[k].why}`);
			return out;
		}),
	];
	if (named) {
		const base = broken ? "task-15-eval-neg" : smoke ? "task-15-eval-smoke" : "task-15-eval";
		fs.mkdirSync(REPORT_EVIDENCE, { recursive: true });
		fs.writeFileSync(path.join(REPORT_EVIDENCE, `${base}.json`), JSON.stringify(result, null, "\t"));
		fs.writeFileSync(path.join(REPORT_EVIDENCE, `${base}.txt`), lines.join("\n") + "\n");
	} else {
		const tag = customTag ?? (broken ? "broken" : `j2-r${round}`);
		fs.writeFileSync(path.join(EVIDENCE, `summary-eval-${tag}.json`), JSON.stringify(result, null, "\t"));
		fs.writeFileSync(path.join(EVIDENCE, `summary-eval-${tag}.txt`), lines.join("\n") + "\n");
		if (!broken && !customTag) {
			fs.writeFileSync(path.join(EVIDENCE, "summary-eval.json"), JSON.stringify(result, null, "\t"));
			fs.writeFileSync(path.join(EVIDENCE, "summary-eval.txt"), lines.join("\n") + "\n");
		}
		fs.appendFileSync(path.join(EVIDENCE, "task-41-rounds.txt"), `${lines.slice(0, 10).join("\n")}\n\n`);
	}
	console.log(lines.join("\n"));
	if (named && !accepted) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "sample") sample(rest);
else if (cmd === "run") await run(rest);
else {
	console.error("usage: node qa/summary-eval.mjs sample | run [--round N] [--broken] [--gen model[,model]] [--judge model]");
	process.exit(2);
}
