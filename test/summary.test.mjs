import test from "node:test";
import assert from "node:assert/strict";
import {
	KNOWN_TERMS,
	SUMMARY_SYSTEM_PROMPT,
	buildLineRequest,
	buildRepairRequest,
	buildSummaryRequest,
	clip,
	detectQuestion,
	detectTodo,
	finalizeLine,
	finalizeSummary,
	heuristicSummary,
	lintSummary,
	parseHandoff,
	recommendedOption,
	stripPaths,
	validateSummary,
} from "../src/summary.mjs";

const THREAD = {
	title: "",
	product: "omo-inbox",
	branch: "main",
	firstRequest: "세션 요약 모듈을 만들어 주세요",
	lastRequest: "테스트까지 함께 붙여 주세요",
};

const HANDOFF = [
	"I read this as: 요약 모듈 작업 - 테스트까지 붙이기.",
	"",
	"Ask: 세션 요약 모듈을 만들어 주세요 - wanted: 테스트 통과. For you: 요약 모듈을 만들었습니다. 다음은 서버 연결입니다. Now: 서버 연결 확인. Next: 전체 검사.",
	"",
	"고친 파일: C:\\dev\\omo\\omo-inbox\\src\\summary.mjs 와 /usr/local/bin/node, `clamp(x, 1, 5)` 함수도 확인했습니다. 이대로 진행할까요?",
].join("\n");

test("buildSummaryRequest carries the thread context and caps long raw text at head 4000 + tail 2000", () => {
	const headFiller = "가나다라마바사아자차 ".repeat(400);
	const tailFiller = "카타파하거너더러머 ".repeat(300);
	const raw = `머리표시 ${headFiller}중간표시 ${tailFiller} 꼬리표시`;
	assert.ok(raw.length > 6000);
	const item = { kind: "turn", raw: { text: raw } };
	const request = buildSummaryRequest(item, THREAD, {});
	assert.deepEqual(Object.keys(request).sort(), ["maxTokens", "purpose", "system", "user"]);
	assert.equal(request.purpose, "summary");
	assert.equal(request.maxTokens, 700);
	assert.equal(typeof request.system, "string");
	assert.match(request.system, /40자/);
	assert.match(request.system, /JSON/);
	assert.ok(request.user.includes(THREAD.firstRequest));
	assert.ok(request.user.includes(THREAD.lastRequest));
	assert.ok(request.user.includes("이번 작업의 제품: omo-inbox"));
	assert.ok(request.user.includes("세션 폴더/브랜치: (없음) / main"));
	assert.ok(request.user.includes("머리표시"));
	assert.ok(request.user.includes("꼬리표시"));
	assert.ok(!request.user.includes(headFiller));
	assert.ok(!request.user.includes(tailFiller));
	assert.ok(request.user.length < 7000);

	const simple = buildSummaryRequest(item, THREAD, { simpler: true });
	assert.notEqual(simple.system, request.system);
	assert.match(simple.system, /일상 단어/);
});

test("buildSummaryRequest lists the terms the user already knows, with the product and the cwd folder", () => {
	const request = buildSummaryRequest({ kind: "turn", raw: { text: "끝났습니다" } }, { ...THREAD, product: "searchad", cwd: "C:\\dev\\omo\\ad-lab" }, {});
	const line = request.user.split("\n").find((l) => l.startsWith("사용자가 이미 아는 말: "));
	assert.ok(line);
	assert.equal(line, `사용자가 이미 아는 말: ${[...KNOWN_TERMS, "searchad", "ad-lab"].join(", ")}`);
	assert.ok(KNOWN_TERMS.includes("mass-ulw") && KNOWN_TERMS.includes("받은함"));
	const bare = buildSummaryRequest({ kind: "turn", raw: { text: "x" } }, {}, {});
	assert.ok(bare.user.includes(`사용자가 이미 아는 말: ${KNOWN_TERMS.join(", ")}\n`));
});

test("buildSummaryRequest carries the question payload and asks for a title when the thread has none", () => {
	const item = {
		kind: "question",
		raw: {
			request: { questions: [{ id: "q1", header: "요약", question: "요약을 켤까요?", options: [{ label: "켜기" }] }] },
		},
	};
	const request = buildSummaryRequest(item, { ...THREAD, title: "" }, {});
	assert.ok(request.user.includes('"q1"'));
	assert.ok(request.user.includes("title"));
	const titled = buildSummaryRequest(item, { ...THREAD, title: "요약 모듈" }, {});
	assert.ok(!titled.user.includes("아직 제목이 없다"));
});

test("validateSummary accepts JSON wrapped in prose and clips every over-long field", () => {
	const body = {
		kind: "approval",
		headline: "가".repeat(60),
		context: "나".repeat(200),
		body: "용어 1 용어 2 용어 3 용어 4 " + "다".repeat(380),
		ask: "라".repeat(150),
		options: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `선택 ${n} (권장)`, why: "마".repeat(90), rec: n === 1 })),
		ifNoAnswer: "바".repeat(100),
		terms: [1, 2, 3, 4].map((n) => ({ term: `용어 ${n}`, meaning: "사".repeat(70) })),
		title: "제목".repeat(20),
	};
	const text = `좋습니다. 아래가 요약입니다:\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\n이상입니다.`;
	const summary = validateSummary(text, { kind: "turn" });
	assert.equal(summary.kind, "approval");
	assert.equal(summary.headline.length, 40);
	assert.ok(summary.headline.endsWith("…"));
	assert.equal(summary.context.length, 120);
	assert.equal(summary.body.length, 300);
	assert.equal(summary.ask.length, 120);
	assert.equal(summary.ifNoAnswer.length, 80);
	assert.equal(summary.options.length, 4);
	assert.equal(summary.options[0].rec, true);
	assert.ok(summary.options[0].label.length <= 20);
	assert.ok(summary.options[0].why.length <= 60);
	assert.equal(summary.terms.length, 3);
	assert.ok(summary.terms[0].term.length <= 20);
	assert.ok(summary.terms[0].meaning.length <= 50);
	assert.equal(summary.title.length, 24);
	assert.ok(summary.title.endsWith("…"));
});

test("validateSummary keeps terms present in summary text and drops absent terms", () => {
	const summary = validateSummary(JSON.stringify({
		kind: "report",
		headline: "작업을 마쳤습니다",
		context: "",
		body: "Review 목록을 고쳤습니다",
		terms: [{ term: "Review", meaning: "검토" }, { term: "없는말", meaning: "설명" }],
	}), { kind: "turn" });
	assert.deepEqual(summary.terms, [{ term: "Review", meaning: "검토" }]);
});

test("validateSummary keeps options out of question and permission items and rejects a bad kind", () => {
	const body = {
		kind: "question",
		headline: "요약을 켤까요?",
		body: "설정에서 켤 수 있습니다.",
		options: [{ label: "켜기 (권장)", why: "빠릅니다", rec: true }],
	};
	const summary = validateSummary(JSON.stringify(body), { kind: "question" });
	assert.equal(summary.kind, "question");
	assert.deepEqual(summary.options, []);
	assert.equal(summary.ask, null);
	assert.equal(summary.ifNoAnswer, null);

	const permission = { ...body, kind: "permission" };
	assert.deepEqual(validateSummary(JSON.stringify(permission), { kind: "permission" }).options, []);

	assert.equal(validateSummary(JSON.stringify({ kind: "loud", headline: "x" }), { kind: "turn" }), null);
	assert.equal(validateSummary(JSON.stringify({ kind: "turn" }), { kind: "turn" }), null);
	assert.equal(validateSummary("{oops}", { kind: "turn" }), null);
});

test("heuristicSummary parses the handoff block, strips paths and code, and keeps the question", () => {
	const item = { kind: "turn", raw: { text: HANDOFF } };
	const summary = heuristicSummary(item, THREAD);
	assert.equal(summary.kind, "report");
	assert.equal(summary.headline, "요약 모듈을 만들었습니다.");
	assert.equal(summary.context, `요청: ${THREAD.firstRequest}`);
	assert.ok(!summary.body.includes("C:\\dev"));
	assert.ok(!summary.body.includes("/usr/local"));
	assert.ok(!summary.body.includes("`"));
	assert.ok(summary.body.includes("고친 파일"));
	assert.equal(summary.ask, "이대로 진행할까요?");
	assert.equal(summary.ifNoAnswer, "답이 없으면 세션은 이 상태로 기다립니다");
	assert.ok(summary.headline.length <= 40);
	assert.ok(summary.body.length <= 300);
});

test("heuristicSummary falls back to the first line and clips to the field limits", () => {
	const long = `긴 첫 줄입니다 ${"가".repeat(80)}`;
	const summary = heuristicSummary({ kind: "progress", raw: { text: long } }, THREAD);
	assert.equal(summary.kind, "progress");
	assert.equal(summary.headline.length, 40);
	assert.ok(summary.headline.endsWith("…"));
	assert.equal(summary.ask, null);
	const report = heuristicSummary({ kind: "turn", raw: { text: "턴이 끝났습니다" } }, THREAD);
	assert.equal(report.kind, "report");
	assert.equal(report.body, "턴이 끝났습니다");
});

test("heuristicSummary detects user to-dos but not completed agent actions", () => {
	const summarize = (text) => heuristicSummary({ kind: "turn", raw: { text } }, THREAD);
	assert.match(summarize("정리했습니다. 폴더 정리는 다른 세션을 닫은 뒤 직접 실행해야 해요.").ask, /직접 실행해야 해요/);
	assert.equal(summarize("순서대로 실행한 두 작업 모두 끝났습니다.").ask, null);
	assert.equal(summarize("제가 직접 실행했습니다.").ask, null);
	assert.equal(detectTodo("직접 실행해야 해요."), true);
});

test("heuristicSummary strips markdown emphasis from headlines", () => {
	const cases = [
		["** 안녕하세요, 준비됐습니다.", "안녕하세요, 준비됐습니다."],
		["__배포를 마쳤습니다", "배포를 마쳤습니다"],
		["## **로그인 오류를 고쳤습니다**", "로그인 오류를 고쳤습니다"],
	];
	for (const [text, expected] of cases) {
		assert.equal(heuristicSummary({ kind: "turn", raw: { text } }, THREAD).headline, expected);
	}
});

test("heuristicSummary sets ifNoAnswer from the item kind and its required flag", () => {
	const question = (raw) => heuristicSummary({ kind: "question", raw }, THREAD);
	assert.equal(
		question({ required: true, request: { timeoutMs: 900_000 } }).ifNoAnswer,
		"답이 없으면 그 작업은 하지 않고 기다립니다",
	);
	const optional = question({ required: false, request: { timeoutMs: 300_000 } });
	assert.equal(optional.ifNoAnswer, "5분 안에 답이 없으면 에이전트가 스스로 판단해 진행합니다");
	assert.equal(question({ required: false }).ifNoAnswer, "30분 안에 답이 없으면 에이전트가 스스로 판단해 진행합니다", "without timeoutMs the senpi default of 30 minutes applies");
	assert.equal(heuristicSummary({ kind: "turn", raw: { text: "끝" } }, THREAD).ifNoAnswer, "답이 없으면 세션은 이 상태로 기다립니다");
	assert.equal(question({ required: true }).kind, "question");
});

test("heuristicSummary progress uses the Now slot and skips a leading routing sentence", () => {
	const now = "I read this as: 요약 작업 - 테스트.\n\nFor you: 끝났습니다. Now: **요약 모듈 테스트를 붙이는 중** Next: 검사.";
	assert.equal(heuristicSummary({ kind: "progress", raw: { text: now } }, THREAD).headline, "요약 모듈 테스트를 붙이는 중");

	const routing = "I read this as: 요약 모듈 작업 - 테스트까지 붙이기.\n\n서버 연결을 확인했습니다.\n다음은 전체 검사입니다.";
	assert.equal(heuristicSummary({ kind: "progress", raw: { text: routing } }, THREAD).headline, "서버 연결을 확인했습니다.");

	const korean = "요청은 요약 모듈을 만들어 달라는 것으로 이해했습니다.\n\n로그인 화면을 고쳤습니다.";
	assert.equal(heuristicSummary({ kind: "progress", raw: { text: korean } }, THREAD).headline, "로그인 화면을 고쳤습니다.");
});

test("heuristicSummary progress reports an English-only message as waiting on its reason", () => {
	const item = { kind: "progress", raw: { text: "Waiting for bash_10 to finish" }, state: { reasons: ["terminal-background-sessions"] } };
	assert.equal(heuristicSummary(item, THREAD).headline, "대기: 백그라운드 작업");
	const episode = { kind: "progress", raw: { text: "Waiting for bash_10 to finish" }, meta: { episode: { wait: ["senpi-task"] } } };
	assert.equal(heuristicSummary(episode, THREAD).headline, "대기: 하위 작업");
	assert.equal(heuristicSummary({ kind: "progress", raw: { text: "Waiting for bash_10" } }, THREAD).headline, "진행 중");
});

test("heuristicSummary progress reads a hold or an open dialog reason in Korean too", () => {
	const hold = { kind: "progress", raw: { text: "Waiting for the child" }, state: { reasons: ["hold:senpi-task"] } };
	assert.equal(heuristicSummary(hold, THREAD).headline, "대기: 하위 작업");
	const dialog = { kind: "progress", raw: { text: "Waiting for approval" }, state: { reasons: ["dialog"] } };
	assert.equal(heuristicSummary(dialog, THREAD).headline, "대기: 권한 답");
});

test("heuristicSummary progress clips its line to 40 characters", () => {
	const summary = heuristicSummary({ kind: "progress", raw: { text: `서버 연결을 확인하고 있습니다 ${"가".repeat(60)}` } }, THREAD);
	assert.equal(summary.headline.length, 40);
	assert.ok(summary.headline.endsWith("…"));
});

test("buildLineRequest asks for one 40-character Korean line and finalizeLine guards the answer", () => {
	const item = { kind: "progress", raw: { text: "서버 연결을 확인했습니다." } };
	const request = buildLineRequest(item, THREAD);
	assert.deepEqual(Object.keys(request).sort(), ["maxTokens", "purpose", "system", "user"]);
	assert.equal(request.purpose, "line");
	assert.equal(request.maxTokens, 80);
	assert.match(request.system, /40자/);
	assert.match(request.system, /한국어/);
	assert.ok(request.user.includes(THREAD.firstRequest));
	assert.ok(request.user.includes("서버 연결을 확인했습니다."));

	assert.equal(finalizeLine("  서버 연결을 확인했습니다.  "), "서버 연결을 확인했습니다.");
	assert.equal(finalizeLine("Waiting for bash_10"), null);
	assert.equal(finalizeLine(""), null);
	assert.equal(finalizeLine(null), null);
	assert.equal(finalizeLine(`서버 연결을 확인했습니다 ${"가".repeat(60)}`).length, 40);
});

test("stripPaths and detectQuestion work on their own", () => {
	assert.equal(stripPaths("`x()` 실행"), "실행");
	assert.equal(stripPaths("C:\\a\\b.mjs 를 봤다"), "를 봤다");
	assert.equal(stripPaths("/usr/local/bin/node 를 봤다"), "를 봤다");
	assert.equal(stripPaths("커밋 3개를 올렸습니다"), "커밋 3개를 올렸습니다");
	assert.equal(detectQuestion("이대로 진행할까요?"), true);
	assert.equal(detectQuestion("문서를 정해 주세요"), true);
	assert.equal(detectQuestion("C:\\dev\\omo\\x.mjs 를 지웠습니다"), false);
	assert.equal(detectQuestion("커밋 3개를 올렸습니다"), false);
});

test("parseHandoff reads the block and clip truncates with an ellipsis", () => {
	const handoff = parseHandoff("Ask: 무언가 물었습니다 - wanted: 통과. For you: 결론입니다. Now: 다음 작업. Next: 검사.");
	assert.equal(handoff.ask, "무언가 물었습니다");
	assert.equal(handoff.wanted, "통과");
	assert.equal(handoff.forYou, "결론입니다");
	assert.equal(handoff.now, "다음 작업");
	assert.equal(handoff.next, "검사");
	assert.equal(parseHandoff("블록이 없습니다"), null);
	assert.equal(clip("가나다", 3), "가나다");
	assert.equal(clip("가나다라", 3), "가나…");
	assert.equal(clip(null, 5), "");
});

test("recommendedOption finds the recommended choice and otherwise returns null", () => {
	const request = { questions: [{ options: [{ label: "그냥 진행" }, { label: "조심히 진행", description: "권장안입니다" }] }] };
	assert.equal(recommendedOption(request), 1);
	assert.equal(recommendedOption({ questions: [{ options: [{ label: "A (권장)" }, { label: "B" }] }] }), 0);
	assert.equal(recommendedOption({ questions: [{ options: [{ label: "A", description: "recommended" }] }] }), 0);
	assert.equal(recommendedOption({ questions: [{ options: [{ label: "A" }, { label: "B" }] }] }), null);
	assert.equal(recommendedOption({}), null);
	assert.equal(recommendedOption(null), null);
});

test("an invalid model answer returns null so the caller falls back to the heuristic", () => {
	const item = { kind: "turn", raw: { text: HANDOFF } };
	for (const bad of ["not json", "", "{}", "[1,2,3]", JSON.stringify({ kind: "loud", headline: "x" })]) {
		assert.equal(validateSummary(bad, item), null);
	}
	const summary = validateSummary("not json", item) ?? heuristicSummary(item, THREAD);
	assert.equal(summary.kind, "report");
	assert.equal(summary.headline, "요약 모듈을 만들었습니다.");
	assert.equal(typeof SUMMARY_SYSTEM_PROMPT, "string");
	assert.match(SUMMARY_SYSTEM_PROMPT, /권장안을 스스로 지어내지 마라/);
});

const draft = (over = {}) =>
	JSON.stringify({ kind: "report", headline: "로그인 화면을 고쳤습니다", context: "요청: 로그인 개선", body: "화면을 손봤습니다", ask: null, options: [], ifNoAnswer: null, terms: [], title: null, ...over });
const TURN = { kind: "turn", raw: { text: "화면을 고쳤습니다." } };

test("lintSummary flags a code-like token in headline, context, body or ask, naming it", () => {
	const issues = lintSummary(draft({ body: "task_send 로 보냈습니다" }), TURN, THREAD);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /task_send/);
	assert.match(lintSummary(draft({ ask: "src/a.mjs 를 지울까요" }), TURN, THREAD).join("\n"), /src\/a\.mjs/);
});

test("lintSummary lets known terms, the product, the cwd folder and listed terms through", () => {
	assert.deepEqual(lintSummary(draft({ body: "omo-inbox 의 desk 보드와 PR 을 봤습니다" }), TURN, THREAD), []);
	assert.deepEqual(lintSummary(draft({ body: "my-app 폴더를 고쳤습니다" }), TURN, { ...THREAD, cwd: "C:\\dev\\my-app" }), []);
	assert.deepEqual(lintSummary(draft({ body: "OCI 서버를 골랐습니다", terms: [{ term: "OCI", meaning: "오라클 클라우드" }] }), TURN, THREAD), []);
	assert.equal(lintSummary(draft({ body: "OCI 서버를 골랐습니다" }), TURN, THREAD).length, 1);
});

test("lintSummary reports a field over its limit with the length, before clipping", () => {
	const issues = lintSummary(draft({ headline: "가".repeat(45), body: "나".repeat(310) }), TURN, THREAD);
	assert.ok(issues.some((issue) => issue.includes("headline") && issue.includes("45")));
	assert.ok(issues.some((issue) => issue.includes("body") && issue.includes("310")));
	assert.deepEqual(lintSummary(draft({ headline: "가".repeat(40), body: "나".repeat(300) }), TURN, THREAD), []);
});

test("lintSummary flags a headline that only names a process step", () => {
	for (const headline of ["검토를 시작합니다.", "로그인 작업 진행 중", "서버 확인 중"]) {
		assert.equal(lintSummary(draft({ headline }), TURN, THREAD).length, 1, headline);
	}
	assert.deepEqual(lintSummary(draft({ headline: "로그인 오류를 고쳤습니다" }), TURN, THREAD), []);
});

test("lintSummary flags a closing question that the summary does not carry", () => {
	const asked = { kind: "turn", raw: { text: "화면을 고쳤습니다. 이대로 배포할까요?" } };
	assert.equal(lintSummary(draft(), asked, THREAD).length, 1);
	assert.equal(lintSummary(draft({ kind: "question", ask: null }), asked, THREAD).length, 1);
	assert.deepEqual(lintSummary(draft({ kind: "question", ask: "이대로 배포할까요?" }), asked, THREAD), []);
	const early = { kind: "turn", raw: { text: `무엇을 할까요? ${"설명 ".repeat(200)}끝났습니다.` } };
	assert.deepEqual(lintSummary(draft(), early, THREAD), []);
	assert.deepEqual(lintSummary("not json", asked, THREAD), []);
});

test("lintSummary flags an uncarried user to-do only when there is no closing question", () => {
	const todo = { kind: "turn", raw: { text: "정리했습니다. 폴더 정리는 직접 실행해야 해요." } };
	assert.match(lintSummary(draft(), todo, THREAD).join("\n"), /사용자가 직접 할 일이 있는데 ask가 비어 있음/);
	const complete = { kind: "turn", raw: { text: "순서대로 실행한 두 작업 모두 끝났습니다." } };
	assert.deepEqual(lintSummary(draft(), complete, THREAD), []);
});

test("buildRepairRequest keeps the system prompt, quotes the draft and lists every issue", () => {
	const text = draft({ body: "task_send 로 보냈습니다" });
	const issues = lintSummary(text, TURN, THREAD);
	const request = buildRepairRequest(TURN, THREAD, text, issues);
	assert.equal(request.system, buildSummaryRequest(TURN, THREAD).system);
	assert.equal(request.maxTokens, 700);
	assert.ok(request.user.includes(text));
	assert.ok(request.user.includes(THREAD.firstRequest));
	for (const issue of issues) assert.ok(request.user.includes(issue));
	assert.match(request.user, /JSON/);
});

test("finalizeSummary overwrites any model ifNoAnswer with the runtime fact per kind", () => {
	const model = { kind: "report", headline: "h", ifNoAnswer: "자동으로 닫힙니다", ask: null };
	const fin = (item) => finalizeSummary(model, item, THREAD).ifNoAnswer;
	assert.equal(fin({ kind: "question", raw: { request: { required: true } } }), "답이 없으면 그 작업은 하지 않고 기다립니다");
	assert.equal(fin({ kind: "question", raw: { request: { required: false, timeoutMs: 600_000 } } }), "10분 안에 답이 없으면 에이전트가 스스로 판단해 진행합니다");
	assert.equal(fin({ kind: "permission", raw: {} }), "답이 없으면 그 도구는 실행되지 않고 기다립니다");
	assert.equal(fin({ kind: "turn", policy: "needs-you", raw: {} }), "답이 없으면 세션은 이 상태로 기다립니다");
	assert.equal(fin({ kind: "turn", policy: "needs-you", meta: { stalled: true }, raw: {} }), "답이 없으면 goal이 멈춘 채로 있습니다");
	assert.equal(fin({ kind: "blocked", raw: {} }), "답이 없으면 멈춘 채로 있습니다");
	for (const kind of ["done", "progress", "notice", "board"]) assert.equal(fin({ kind, raw: {} }), null);
	assert.equal(model.ifNoAnswer, "자동으로 닫힙니다");
});

test("the system prompt tells the model the system fills ifNoAnswer", () => {
	assert.match(SUMMARY_SYSTEM_PROMPT, /ifNoAnswer는 시스템이/);
});

test("lintSummary asks for the recommendation when the source recommends one way and the question summary omits it", () => {
	const turn = { kind: "turn", raw: { text: "검토를 마쳤습니다. 지금 검토하는 게 낫습니다. 지금 볼까요?" } };
	const missing = lintSummary(draft({ kind: "question", headline: "지금 검토할지 정해 주세요", ask: "지금 검토할까요?" }), turn, THREAD).join("\n");
	assert.match(missing, /권장/);
	assert.deepEqual(lintSummary(draft({ kind: "question", headline: "지금 검토할지 정해 주세요", ask: "지금 검토할까요? 권장: 지금, 나중에 하면 더 길어집니다" }), turn, THREAD), []);
});

test("finalizeSummary names the option the question marks as recommended when the summary left it out", () => {
	const request = { questions: [{ id: "q1", header: "커밋", question: "커밋을 어떻게 나눌까요?", options: [{ label: "두 커밋 (권장)", description: "기능과 테스트" }, { label: "한 커밋" }] }] };
	const item = { kind: "question", raw: { request } };
	const fin = finalizeSummary({ kind: "question", headline: "h", ask: "커밋을 어떻게 나눌지 정해 주세요", body: "결제 모듈을 바꿨습니다." }, item, THREAD);
	assert.equal(fin.body, "권장: 두 커밋. 결제 모듈을 바꿨습니다.");
	const named = finalizeSummary({ kind: "question", headline: "h", ask: "두 커밋으로 할까요", body: "b" }, item, THREAD);
	assert.equal(named.body, "b", "no duplicate when the ask already names it");
	assert.equal(finalizeSummary({ kind: "report", headline: "h", body: "b" }, { kind: "turn", policy: "needs-you", raw: {} }, THREAD).body, "b");
});

test("ifNoAnswer follows the ask-user runtime: required only when true, and an async question keeps the agent working", () => {
	const fin = (request) => finalizeSummary({ kind: "question", headline: "h" }, { kind: "question", raw: { request } }, THREAD).ifNoAnswer;
	assert.equal(fin({ timeoutMs: 600_000 }), "10분 안에 답이 없으면 에이전트가 스스로 판단해 진행합니다");
	assert.equal(fin({ waitForAnswer: false, timeoutMs: 600_000 }), "에이전트는 일을 계속하고, 10분 안에 답이 없으면 스스로 판단합니다");
	assert.equal(fin({ required: true, waitForAnswer: true }), "답이 없으면 그 작업은 하지 않고 기다립니다");
	assert.equal(fin({ required: true, waitForAnswer: false }), "에이전트는 다른 일을 계속하고, 답이 없으면 그 작업은 하지 않습니다");
});


const EPISODE_AT = Date.UTC(2026, 9, 18, 9, 5);
const episodeLine = (n, at = EPISODE_AT + n * 60_000) => ({ at, text: `메시지 ${n} 원문`, headline: `메시지 ${n} 한 줄` });

test("episode finals carry the span digest, opener, newest 30 lines and the bounded final text", () => {
	const lines = Array.from({ length: 60 }, (_, n) => episodeLine(n + 1));
	const final = `For you: 마지막 결과를 마쳤습니다. Now: 다음 작업.\n${"가".repeat(20_000)}`;
	const item = {
		kind: "turn",
		raw: { request: "처음 요청입니다", final },
		meta: { episode: { closeReason: "done", openedAt: EPISODE_AT, closedAt: EPISODE_AT + 60 * 60_000, questions: 2, interjections: 1 } },
	};
	const request = buildSummaryRequest(item, { ...THREAD, cwd: "C:\\dev\\omo\\ad-lab", product: "searchad" }, { episodeLines: lines });
	assert.equal(request.purpose, "summary");
	assert.ok(!request.user.includes("요약할 원문:"));
	assert.match(request.user, /이번 작업 구간: 60개 메시지, \d{2}:\d{2}~\d{2}:\d{2}, 끝난 이유: 끝남, 중간 질문 2건, 사용자 개입 1건/);
	assert.ok(request.user.includes("이번 요청: 처음 요청입니다"));
	assert.ok(request.user.includes("(앞선 30건 생략)"));
	assert.ok(request.user.includes("메시지 60 한 줄"));
	assert.ok(!request.user.includes("메시지 30 한 줄"));
	assert.ok(request.user.includes("마지막 결과를 마쳤습니다"));
	assert.ok(request.user.length <= 8000, `${request.user.length} chars`);
	assert.ok(request.user.includes("세션 폴더/브랜치: ad-lab / main"));
	assert.ok(request.user.includes("이번 작업의 제품: searchad"));
});

test("a 60-line digest with long lines and a long final stays at or under 8000 characters", () => {
	const lines = Array.from({ length: 60 }, (_, n) => ({ at: EPISODE_AT + n * 60_000, headline: "긴 한 줄 ".repeat(40), text: "원문 ".repeat(200) }));
	const item = {
		kind: "turn",
		raw: { request: "요청 ".repeat(400), final: "꼬리표시 " + "가".repeat(30_000) + " 머리표시" },
		meta: { episode: { closeReason: "stalled", openedAt: EPISODE_AT, closedAt: EPISODE_AT + 3_600_000, questions: 0, interjections: 3 } },
	};
	const request = buildSummaryRequest(item, THREAD, { episodeLines: lines });
	assert.ok(request.user.length <= 8000, `${request.user.length} chars`);
	assert.ok(request.user.includes("끝난 이유: 멈춤"));
	assert.ok(request.user.includes("...(중략)..."));
	assert.ok(!request.user.includes("가".repeat(4000)));
});

test("episode finals take the headline from raw.final's For you, not the first line or the raw request", () => {
	const final = [
		"I read this as: 요약 작업 - 테스트.",
		"",
		"Ask: 없는 일 - wanted: 통과. For you: 로그인 오류를 고쳤습니다. Now: 전체 검사. Next: 보고.",
	].join("\n");
	const item = {
		kind: "turn",
		raw: { request: "첫 줄 요청입니다", final },
		meta: { stalled: false, episode: { closeReason: "done", openedAt: EPISODE_AT, closedAt: EPISODE_AT + 60_000, questions: 0, interjections: 0 } },
	};
	const summary = heuristicSummary(item, THREAD);
	assert.equal(summary.headline, "로그인 오류를 고쳤습니다");
	const request = buildSummaryRequest(item, THREAD, { episodeLines: [episodeLine(1)] });
	assert.ok(request.user.includes(final.slice(0, 3000)));
	assert.ok(!request.user.includes("요약할 원문:"));
});

test("stalled wording appears only for a real stall, never on a normal final", () => {
	const normal = {
		kind: "turn",
		raw: { request: "요청", final: "For you: 끝났습니다." },
		meta: { stalled: false, episode: { closeReason: "done", openedAt: EPISODE_AT, closedAt: EPISODE_AT + 60_000, questions: 0, interjections: 0 } },
	};
	const request = buildSummaryRequest(normal, THREAD, { episodeLines: [episodeLine(1)] });
	assert.ok(!request.user.includes("진전 신호가 없었다"));
	assert.notEqual(finalizeSummary(heuristicSummary(normal, THREAD), normal, THREAD).ifNoAnswer, "답이 없으면 goal이 멈춘 채로 있습니다");
	const truthyString = { ...normal, meta: { ...normal.meta, stalled: "yes" } };
	assert.ok(!buildSummaryRequest(truthyString, THREAD, { episodeLines: [episodeLine(1)] }).user.includes("진전 신호가 없었다"));
	const stalled = { ...normal, meta: { ...normal.meta, stalled: true } };
	assert.ok(buildSummaryRequest(stalled, THREAD, { episodeLines: [episodeLine(1)] }).user.includes("진전 신호가 없었다"));
});
