import test from "node:test";
import assert from "node:assert/strict";

import { feedbackMessage, footerText, pendingNotice } from "../src/message.mjs";

const CLI = 'node "C:/x/app/bin/inbox.mjs"';
const URL = "https://box.tail.ts.net:4388/p/240101-abcd";
const CROPS = "C:/home/data/proposals/240101-abcd";

const board = {
	questions: [
		{
			id: "q1",
			text: "레이아웃은?",
			options: [
				{ value: "left", label: "좌측 메뉴" },
				{ value: "top", label: "상단 메뉴" },
			],
		},
		{
			id: "q2",
			text: "테마는?",
			options: [
				{ value: "dark", label: "다크" },
				{ value: "light", label: "라이트" },
			],
		},
	],
};

const summary = { id: "240101-abcd", title: "로그인 개편", rev: 3 };

test("approve verdict renders header, 판단, 보기 and 처리 with the current rev as-is", () => {
	const text = feedbackMessage({
		summary,
		board,
		event: { seq: 4, rev: 3, verdict: "approve", answers: {}, comment: "", marks: [] },
		url: URL,
		cropDir: CROPS,
		cli: CLI,
	});
	assert.equal(
		text,
		[
			"[omo-inbox] 의견이 왔습니다: 로그인 개편 (240101-abcd, 3안, #4)",
			"판단: 승인",
			`보기: ${URL}`,
			`처리: ${CLI} show 240101-abcd 로 전체를 읽고 ${CLI} reply / revise / close 로 답하세요.`,
		].join("\n"),
	);
});

test("change verdict maps answers to question text and option labels, marks carry crop paths", () => {
	const text = feedbackMessage({
		summary,
		board,
		event: {
			seq: 9,
			rev: 2,
			verdict: "change",
			answers: { q1: "top", q2: "dark" },
			comment: "상단 메뉴로 바꿔주세요",
			marks: [
				{ n: 1, frame: "메인", comment: "버튼이 작아요", crop: "crops/000009-1.png" },
				{ n: 2, frame: "상세", comment: "여백이 좁아요", crop: "crops/000009-2.png" },
			],
		},
		url: URL,
		cropDir: CROPS,
		cli: CLI,
	});
	assert.equal(
		text,
		[
			"[omo-inbox] 의견이 왔습니다: 로그인 개편 (240101-abcd, 2안, #9)",
			"판단: 재요청",
			"답: 레이아웃은? -> 상단 메뉴; 테마는? -> 다크",
			"전체 의견: 상단 메뉴로 바꿔주세요",
			`표시 1 (메인): 버튼이 작아요 | 그림: ${CROPS}/crops/000009-1.png`,
			`표시 2 (상세): 여백이 좁아요 | 그림: ${CROPS}/crops/000009-2.png`,
			"현재 안은 3안입니다 (이 의견은 2안 기준)",
			`보기: ${URL}`,
			`처리: ${CLI} show 240101-abcd 로 전체를 읽고 ${CLI} revise 로 수정안을 올리세요. 재요청은 승인이 아닙니다: 확정하거나 작업을 시작하지 마세요.`,
		].join("\n"),
	);
});

test("unknown answer ids and unknown option values print raw", () => {
	const text = feedbackMessage({
		summary,
		board,
		event: {
			seq: 5,
			rev: 3,
			verdict: "change",
			answers: { q9: "zzz", q1: "nope" },
			comment: "",
			marks: [],
		},
		url: URL,
		cropDir: CROPS,
		cli: CLI,
	});
	assert.ok(text.includes("답: q9 -> zzz; 레이아웃은? -> nope"), text);
});

test("empty answer, comment and url lines are omitted", () => {
	const text = feedbackMessage({
		summary,
		board,
		event: { seq: 6, rev: 3, verdict: "change", answers: {}, comment: "", marks: [] },
		url: "",
		cropDir: CROPS,
		cli: CLI,
	});
	assert.equal(text.includes("답:"), false);
	assert.equal(text.includes("전체 의견:"), false);
	assert.equal(text.includes("보기:"), false);
	assert.equal(text.includes("현재 안은"), false);
});

test("the 현재 안은 line appears only when event.rev is older than summary.rev", () => {
	const base = { seq: 7, rev: 3, verdict: "approve", answers: {}, comment: "", marks: [] };
	const current = feedbackMessage({ summary, board, event: base, url: URL, cropDir: CROPS, cli: CLI });
	const newer = feedbackMessage({
		summary,
		board,
		event: { ...base, rev: 4 },
		url: URL,
		cropDir: CROPS,
		cli: CLI,
	});
	assert.equal(current.includes("현재 안은"), false);
	assert.equal(newer.includes("현재 안은"), false);
});

test("a mark without a crop omits the picture segment", () => {
	const text = feedbackMessage({
		summary,
		board,
		event: {
			seq: 8,
			rev: 3,
			verdict: "change",
			answers: {},
			comment: "",
			marks: [{ n: 1, frame: "메인", comment: "여기를 봐주세요", crop: null }],
		},
		url: URL,
		cropDir: CROPS,
		cli: CLI,
	});
	assert.ok(text.includes("표시 1 (메인): 여기를 봐주세요"), text);
	assert.equal(text.includes("그림:"), false);
});

test("the 처리 line embeds the given cli prefix verbatim", () => {
	const other = "/usr/bin/node /opt/inbox/bin/inbox.mjs";
	const text = feedbackMessage({
		summary,
		board,
		event: { seq: 10, rev: 3, verdict: "approve", answers: {}, comment: "", marks: [] },
		url: URL,
		cropDir: CROPS,
		cli: other,
	});
	assert.ok(text.endsWith(`${other} show 240101-abcd 로 전체를 읽고 ${other} reply / revise / close 로 답하세요.`));
});

test("only a change verdict narrows the 처리 line to revise", () => {
	const last = (verdict) =>
		feedbackMessage({ summary, board, event: { seq: 11, rev: 3, verdict, answers: {}, comment: "x", marks: [] }, url: URL, cropDir: CROPS, cli: CLI }).split("\n").at(-1);
	assert.ok(last("change").includes(`${CLI} revise `), last("change"));
	assert.equal(last("change").includes("reply"), false);
	assert.ok(last("approve").includes("reply / revise / close"), last("approve"));
	assert.ok(last("ack").includes("reply / revise / close"), last("ack"));
});

test("an ack on a report board reads 확인 and labels the revision as an update", () => {
	const text = feedbackMessage({
		summary: { ...summary, kind: "report", rev: 1 },
		board: { questions: [] },
		event: { seq: 2, rev: 1, verdict: "ack", comment: "QA 확인 의견", answers: {}, marks: [] },
		url: URL,
		cropDir: CROPS,
		cli: CLI,
	});
	assert.ok(text.includes("판단: 확인"), text);
	assert.ok(text.includes("갱신 1"), text);
	assert.equal(text.includes("1안"), false);
	assert.equal(text.includes("재요청"), false);
});

test("pendingNotice returns null for an empty list", () => {
	assert.equal(pendingNotice([], CLI), null);
});

test("pendingNotice lists one line per item with the cli prefix", () => {
	const items = [
		{ id: "240101-abcd", title: "로그인 개편", url: "https://x/p/240101-abcd" },
		{ id: "240102-efgh", title: "결제 화면", url: "https://x/p/240102-efgh" },
	];
	assert.equal(
		pendingNotice(items, CLI),
		[
			"[omo-inbox] 이 워크트리에 답을 기다리는 Review가 2건 있습니다.",
			`- 로그인 개편 (240101-abcd) https://x/p/240101-abcd -> ${CLI} show 240101-abcd`,
			`- 결제 화면 (240102-efgh) https://x/p/240102-efgh -> ${CLI} show 240102-efgh`,
		].join("\n"),
	);
});

test("footerText is empty when both counts are zero", () => {
	assert.equal(footerText({ waiting: 0, boards: 0 }), "");
});

test("footerText reports waiting sessions and this session's boards", () => {
	assert.equal(footerText({ waiting: 2, boards: 1 }), "🙋 2 🤖 1");
});

test("footerText leaves out a zero count", () => {
	assert.equal(footerText({ waiting: 2, boards: 0 }), "🙋 2");
	assert.equal(footerText({ waiting: 0, boards: 1 }), "🤖 1");
});
