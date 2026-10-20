import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { validateBoard } from "../src/board.mjs";

const PROTOTYPE_BOARD = `{
  "id": "skill-structure",
  "title": "visual-board 스킬 — 구조와 방법 검토",
  "lead": "만들기 전에 저장소 모양, 부품, 작업 흐름, 설치, 판단 규칙을 봅니다. 고칠 곳은 네모로 표시하고 의견을 적어 주세요. 아래 질문 네 개에 답하고 '세션에 보내기'를 누르면 됩니다.",
  "sections": [
    { "title": "저장소 구조", "desc": "C:/dev/repo", "cards": [
      { "badge": "1", "title": "폴더와 파일", "layout": "one", "diagram": true,
        "note": "기존 omo-* 저장소와 같은 모양: README.md가 명세, README.ko.md는 한국어 짝, CLAUDE.md, node --test. skill/ 아래가 그대로 설치된다.",
        "frames": [["저장소", "diagrams/repo.svg"]] } ] },
    { "title": "구성 요소", "desc": "에이전트가 채우는 것과 고정된 부품", "cards": [
      { "badge": "2", "title": "부품 연결", "layout": "one", "diagram": true,
        "note": "에이전트는 내용(시안, 도식, 질문)만 board.json에 채운다. 화면 틀, 네모 표시, 전송, 서버는 고정 부품이라 매번 같다.",
        "frames": [["구성", "diagrams/components.svg"]] } ] },
    { "title": "작업 흐름", "desc": "요청부터 완료 보고까지", "cards": [
      { "badge": "3", "title": "주고받는 순서", "layout": "one", "diagram": true,
        "note": "결정 전에는 plan-reviewer로 넘기지 않는다. 결정은 VISUAL-APPROVED 한 줄로 계획과 이슈에 남는다.",
        "frames": [["흐름", "diagrams/sequence.svg"]] } ] },
    { "title": "설치", "desc": "omo 업데이트와 무관하게", "cards": [
      { "badge": "4", "title": "어디로 들어가나", "layout": "one", "diagram": true,
        "note": "사용자 폴더에만 복사한다. omo-ai 내장 스킬은 건드리지 않는다. 고친 뒤에는 install을 다시 실행.",
        "frames": [["설치", "diagrams/install.svg"]] } ] },
    { "title": "판단 규칙", "desc": "언제 어떤 그림을 띄우나", "cards": [
      { "badge": "5", "title": "세 가지를 따로 판단", "layout": "one", "diagram": true,
        "note": "화면·스키마·흐름은 하나만 고르는 게 아니라 각각 판단하고, 해당하는 것을 모두 한 보드에 싣는다.",
        "frames": [["판단", "diagrams/checks.svg"]] } ] }
  ],
  "questions": [
    { "id": "name", "text": "저장소 이름", "help": "저장소 폴더 이름이자 GitHub 저장소 이름.", "options": [
      { "value": "omo-visual-board", "label": "omo-visual-board", "rec": true, "why": "스킬 이름(visual-board)과 같아서 찾기 쉽다." },
      { "value": "omo-board", "label": "omo-board", "why": "짧다. 대신 무슨 보드인지 이름만으로는 모른다." },
      { "value": "omo-visual-review", "label": "omo-visual-review", "why": "하는 일(그림으로 검토)을 그대로 말한다. 스킬 이름과는 달라진다." } ] },
    { "id": "install", "text": "설치 방식", "help": "저장소에서 고친 내용이 실제로 쓰는 스킬 폴더(~/.agents/skills, ~/.claude/rules 등)에 어떻게 들어가는지의 차이. 결과적으로 '고치는 즉시 모든 세션에 반영되느냐'가 갈린다.", "options": [
      { "value": "copy", "label": "복사", "rec": true, "why": "install을 실행할 때 파일을 복사해 넣는다. 고친 뒤 install을 다시 돌려야 반영되지만, 개발 중에 깨진 상태가 다른 세션에 퍼지지 않는다. 기존 omo-rollover가 이 방식이다." },
      { "value": "link", "label": "링크", "why": "스킬 폴더가 저장소를 바로 가리킨다(Windows 디렉터리 연결). 저장하는 순간 모든 세션에 반영돼 편하지만, 고치다 만 상태도 바로 퍼진다." } ] },
    { "id": "wake", "text": "의견이 오면 세션을 깨우는 방법", "help": "보드에서 '보내기'를 눌렀을 때 작업 중인 세션이 그걸 알아채는 장치. 지금 시험판은 에이전트가 의견 파일에 감시를 걸어 두는 방식이다.", "options": [
      { "value": "monitor", "label": "스킬 절차 (감시 걸기)", "rec": true, "why": "보드를 띄울 때 에이전트가 감시를 건다. 따로 설치할 게 없다. 에이전트가 감시 걸기를 잊으면 의견이 묻힌다." },
      { "value": "extension", "label": "확장 프로그램", "why": "omo 확장(extension)이 보드 서버를 켜고 끄고, 의견이 오면 세션에 직접 알림을 넣는다. 잊을 일이 없지만 관리할 프로그램이 하나 는다." } ] },
    { "id": "flow", "text": "흐름 그림을 띄우는 때", "help": "화면·스키마는 바뀌는 파일로 확실히 알 수 있지만, 흐름(순서·상태)이 바뀌는지는 에이전트가 판단해야 한다. 판단이 들어가면 쓸데없이 그림이 뜨거나 빠질 수 있다.", "options": [
      { "value": "ulw-or-explicit", "label": "ulw 실행 중이거나 말했을 때만", "rec": true, "why": "계획을 세우는 큰 작업이나 '그림으로'라고 했을 때만 뜬다. 잡음이 적다." },
      { "value": "always", "label": "항상 판단", "why": "작은 작업에서도 흐름이 바뀌면 뜬다. 놓치는 건 적지만 자주 뜰 수 있다." } ] }
  ],
  "commentPlaceholder": "전체 의견 (예: profiles는 저장소 밖으로, capture는 나중에)",
  "sideSession": "잘 모르는 것은 오른쪽 아래 'AI에게 묻기'로 ChatGPT·Claude·Aside에서 물어보세요. 결론을 '전체 의견'에 붙여 넣고 보내면 작업 세션에는 그것만 전달됩니다."
}`;

const PROTOTYPE_DIAGRAMS = ["repo", "components", "sequence", "install", "checks"];

const OK_FILES = { "img/a.png": "png" };

function okBoard(overrides = {}) {
	return {
		title: "t",
		sections: [{ title: "s", cards: [{ frames: [["a", "img/a.png"]] }] }],
		...overrides,
	};
}

function goodQuestion(overrides = {}) {
	return {
		id: "q1",
		text: "which?",
		options: [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		],
		...overrides,
	};
}

function runBoard(board, files = OK_FILES, options) {
	const { home, cleanup } = makeTmpHome("inbox-board-");
	try {
		if (board !== undefined) {
			fs.writeFileSync(path.join(home, "board.json"), typeof board === "string" ? board : JSON.stringify(board));
		}
		for (const [rel, content] of Object.entries(files)) {
			const abs = path.join(home, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, content);
		}
		return validateBoard(home, options);
	} finally {
		cleanup();
	}
}

function errors(result) {
	assert.equal(result.ok, false);
	assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
	return result.errors;
}

test("prototype board validates with exactly its 11 files", () => {
	const { home, cleanup } = makeTmpHome("inbox-prototype-");
	try {
		fs.mkdirSync(path.join(home, "diagrams"));
		for (const name of PROTOTYPE_DIAGRAMS) {
			fs.writeFileSync(path.join(home, "diagrams", `${name}.svg`), "<svg/>");
			fs.writeFileSync(path.join(home, "diagrams", `${name}.mmd`), "graph TD");
		}
		fs.writeFileSync(path.join(home, "side-brief.md"), "not referenced by board.json");
		fs.writeFileSync(path.join(home, "board.json"), PROTOTYPE_BOARD);

		const result = validateBoard(home);
		assert.equal(result.ok, true);
		assert.equal(result.board.title, "visual-board 스킬 — 구조와 방법 검토");
		assert.equal(result.files.length, 11);
		assert.deepEqual([...result.files].sort(), [
			"board.json",
			...PROTOTYPE_DIAGRAMS.flatMap((name) => [`diagrams/${name}.mmd`, `diagrams/${name}.svg`]),
		].sort());
		assert.ok(!result.files.includes("side-brief.md"));
		const expected = result.files.reduce((sum, rel) => sum + fs.statSync(path.join(home, rel)).size, 0);
		assert.equal(result.bytes, expected);
	} finally {
		cleanup();
	}
});

test("board.json is required", () => {
	assert.equal(errors(runBoard(undefined, {}))[0], "board.json: not found");
});

test("invalid JSON is reported", () => {
	assert.match(errors(runBoard("{nope", {}))[0], /^board\.json: invalid JSON/);
});

test("schema id and sideSession are accepted", () => {
	const result = runBoard(okBoard({ id: "skill-structure", sideSession: "ask an AI" }));
	assert.equal(result.ok, true);
});

test("sideSession must be a string", () => {
	assert.ok(errors(runBoard(okBoard({ sideSession: 7 })))[0].includes("sideSession: must be a string"));
});

test("lead must be a string", () => {
	assert.equal(errors(runBoard(okBoard({ lead: 7 })))[0], "lead: must be a string");
});

test("unknown top-level key is rejected", () => {
	const list = errors(runBoard(okBoard({ frame: "oops" })));
	assert.ok(list.includes("frame: unknown key"));
});

test("missing title is rejected", () => {
	const board = okBoard();
	delete board.title;
	assert.ok(errors(runBoard(board))[0].includes("title: must be a non-empty string"));
});

test("empty board is rejected", () => {
	assert.ok(errors(runBoard({ title: "t" }, {})).some((e) => e.includes("at least one frame or one question")));
});

test("board with only a question is accepted", () => {
	const result = runBoard({ title: "t", questions: [goodQuestion()] }, {});
	assert.equal(result.ok, true);
	assert.deepEqual(result.files, ["board.json"]);
});

test("report board with a frame and no questions is accepted", () => {
	const result = runBoard(okBoard({ kind: "report" }));
	assert.equal(result.ok, true);
	assert.equal(result.board.kind, "report");
});

test("board without kind stays undefined and may ask questions", () => {
	const result = runBoard({ title: "t", questions: [goodQuestion()] }, {});
	assert.equal(result.ok, true);
	assert.equal(result.board.kind, undefined);
});

test("report board with a question is rejected", () => {
	const list = errors(runBoard({ title: "t", kind: "report", questions: [goodQuestion()] }, {}));
	assert.ok(list.some((e) => e.includes("questions: report boards take no questions")));
});

test("unknown kind is rejected", () => {
	for (const kind of ["memo", "Report", "decision "]) {
		const list = errors(runBoard(okBoard({ kind })));
		assert.equal(list[0], 'kind: must be "decision" or "report"');
	}
});

test("non-string kind is rejected", () => {
	assert.equal(errors(runBoard(okBoard({ kind: 5 })))[0], 'kind: must be "decision" or "report"');
});

const NOT_LOCAL = "must be a local file inside the board dir (download the image into the board dir)";

test("https frame path is rejected", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "https://example.com/a.png"]];
	assert.equal(errors(runBoard(board, {}))[0], `sections[0].cards[0].frames[0][1]: ${NOT_LOCAL}`);
});

test("absolute frame path is rejected", () => {
	for (const abs of ["/outside/a.png", "C:/outside/a.png"]) {
		const board = okBoard();
		board.sections[0].cards[0].frames = [["a", abs]];
		assert.equal(errors(runBoard(board, {}))[0], `sections[0].cards[0].frames[0][1]: ${NOT_LOCAL}`);
	}
});

test("parent segment in frame path is rejected", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "../x.png"]];
	assert.ok(errors(runBoard(board, {}))[0].includes("sections[0].cards[0].frames[0]"));
});

test("backslash in frame path is rejected", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "img\\a.png"]];
	assert.ok(errors(runBoard(board, {}))[0].includes("forward slashes"));
});

test("bad frame extension is rejected", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "img/a.txt"]];
	assert.ok(errors(runBoard(board, {}))[0].includes("extensions"));
});

test("missing frame file is rejected", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "img/missing.png"]];
	const found = errors(runBoard(board, {}));
	assert.equal(found[0], "sections[0].cards[0].frames[0][1]: file not found");
});

test("duplicate frame label across cards is rejected", () => {
	const board = {
		title: "t",
		sections: [
			{ title: "s", cards: [{ frames: [["same", "img/a.png"]] }] },
			{ title: "s2", cards: [{ frames: [["same", "img/a.png"]] }] },
		],
	};
	assert.ok(errors(runBoard(board))[0].includes("sections[1].cards[0].frames[0][0]: duplicate frame label"));
});

test("bad question id is rejected", () => {
	const board = { title: "t", questions: [goodQuestion({ id: "bad id!" })] };
	assert.ok(errors(runBoard(board, {}))[0].includes("questions[0].id"));
});

test("duplicate question id is rejected", () => {
	const board = { title: "t", questions: [goodQuestion(), goodQuestion({ text: "again" })] };
	assert.ok(errors(runBoard(board, {}))[0].includes('questions[1].id: duplicate question id "q1"'));
});

test("question with fewer than two options is rejected", () => {
	const board = { title: "t", questions: [goodQuestion({ options: [{ value: "a", label: "A" }] })] };
	assert.ok(errors(runBoard(board, {}))[0].includes("questions[0].options: must have at least 2 options"));
});

test("duplicate option value within a question is rejected", () => {
	const board = {
		title: "t",
		questions: [goodQuestion({ options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })],
	};
	assert.ok(errors(runBoard(board, {}))[0].includes('questions[0].options[1].value: duplicate value "a"'));
});

test("invalid card layout is rejected", () => {
	const board = okBoard();
	board.sections[0].cards[0].layout = "three";
	assert.ok(errors(runBoard(board))[0].includes('sections[0].cards[0].layout: must be one of "one", "two" or ""'));
});

test("unknown card key is rejected", () => {
	const board = okBoard();
	board.sections[0].cards[0].color = "red";
	assert.ok(errors(runBoard(board))[0].includes("sections[0].cards[0].color: unknown key"));
});

test("card say must be a string", () => {
	const board = okBoard();
	board.sections[0].cards[0].say = "로그인 다음에 수강권을 먼저 확인합니다.";
	assert.equal(runBoard(board).ok, true);
	board.sections[0].cards[0].say = 3;
	assert.ok(errors(runBoard(board)).some((e) => e.startsWith("sections[0].cards[0].say")));
});

test("more than 60 frames is rejected", () => {
	const frames = Array.from({ length: 61 }, (_, i) => [`f${i}`, "img/a.png"]);
	const board = { title: "t", sections: [{ title: "s", cards: [{ frames }] }] };
	assert.ok(errors(runBoard(board)).some((e) => e.includes("at most 60 frames")));
});

test("more than 30 questions is rejected", () => {
	const questions = Array.from({ length: 31 }, (_, i) => goodQuestion({ id: `q${i}` }));
	const board = { title: "t", questions };
	assert.ok(errors(runBoard(board, {})).some((e) => e.includes("at most 30 questions")));
});

test("only an svg's existing sibling mmd is collected", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "img/a.svg"]];
	const withSibling = runBoard(board, { "img/a.svg": "<svg/>", "img/a.mmd": "graph TD" });
	assert.equal(withSibling.ok, true);
	assert.deepEqual(withSibling.files, ["board.json", "img/a.svg", "img/a.mmd"]);
	const withoutSibling = runBoard(board, { "img/a.svg": "<svg/>" });
	assert.equal(withoutSibling.ok, true);
	assert.deepEqual(withoutSibling.files, ["board.json", "img/a.svg"]);
});

test("injected maxFile limits are enforced", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "img/big.png"]];
	const list = errors(runBoard(board, { "img/big.png": "x".repeat(300) }, { limits: { maxFile: 200 } }));
	assert.ok(list[0].startsWith("sections[0].cards[0].frames[0][1]:"));
	assert.ok(list[0].includes("larger than the limit"));
});

test("injected maxTotal limits are enforced", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "img/big.png"]];
	const list = errors(runBoard(board, { "img/big.png": "x".repeat(300) }, { limits: { maxTotal: 200 } }));
	assert.ok(list.some((e) => e.startsWith("board: total size") && e.includes("exceeds the limit")));
});

test("top-level limit options are accepted as well", () => {
	const board = okBoard();
	board.sections[0].cards[0].frames = [["a", "img/big.png"]];
	const list = errors(runBoard(board, { "img/big.png": "x".repeat(300) }, { maxFile: 200 }));
	assert.ok(list.some((e) => e.includes("larger than the limit")));
});
