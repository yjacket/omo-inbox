import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { marker, buildIssue } from "../src/reports-body.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const CREATED_AT = "2026-10-28T01:02:03.000Z";
const REPO = "yjacket/omo-inbox";
const BRANCH = "inbox-report-assets";
const LABEL = "inbox-report";
const PUBLIC_BASE = "https://inbox.example.ts.net";
const VERSION = "0.1.0";
const BUILD = "build-42";

function makeReport(extra = {}) {
	return {
		v: 1,
		id: ID,
		createdAt: CREATED_AT,
		fingerprint: "f".repeat(64),
		report: {
			v: 2,
			reportId: ID,
			description: "보드에서 글자가 겹쳐 보입니다",
			page: {
				kind: "boards",
				route: "/boards",
				url: "/boards?tab=all",
				title: "보드",
				frames: [{ selector: "iframe[data-board]", url: "/boards/frame" }],
			},
			element: {
				selector: "#board-title",
				selectorStability: "id",
				domPath: "main > h1#board-title",
				domPathTruncated: false,
				tag: "h1",
				role: "heading",
				label: "보드 제목",
				textExcerpt: "오늘의 보드",
				excerptTruncated: false,
				rect: { x: 12, y: 34, w: 320, h: 48 },
			},
			view: {
				layout: { w: 390, h: 844 },
				visual: { x: 0, y: 0, w: 390, h: 700, scale: 1 },
				scroll: { x: 0, y: 120 },
				dpr: 2,
				colorScheme: "dark",
				pointer: "coarse",
			},
			source: { kind: "thread", threadId: "th_123", itemId: "it_9", product: "omo" },
		},
		image: { sha256: "ab".repeat(32), bytes: 1234, width: 390, height: 700, provenance: "snapshot" },
		asset: { path: "reports/2026/10/11111111-1111-4111-8111-111111111111.png", blobSha: "cd".repeat(20) },
		issueRequest: null,
		delivery: { state: "queued", attempts: 0, creates: 0, nextAttemptAt: null, uncertainSince: null, lastError: null },
		github: null,
		handoff: null,
		legacy: null,
		...extra,
	};
}

function makeIssue(record, overrides = {}) {
	return buildIssue({
		record,
		title: "보드에서 글자가 겹쳐 보입니다",
		repo: REPO,
		assetsBranch: BRANCH,
		label: LABEL,
		publicBase: PUBLIC_BASE,
		serverBuild: BUILD,
		version: VERSION,
		...overrides,
	});
}

function jsonBlock(body) {
	const match = body.match(/```json\n([\s\S]*?)\n```/);
	assert.ok(match, "body has a json block");
	return match[1];
}

function escapeJson(text) {
	return text.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("`", "\\u0060");
}

function expectedJson(record, element) {
	const report = record.report;
	const obj = {
		schema: "inbox-report/v2",
		reportId: report.reportId,
		page: report.page,
		element,
		view: report.view,
		source: report.source,
		image: record.image ?? null,
		asset: record.asset ?? null,
		serverBuild: BUILD,
		version: VERSION,
		createdAt: record.createdAt,
	};
	return escapeJson(JSON.stringify(obj, null, 2));
}

describe("marker", () => {
	test("wraps the id in an html comment", () => {
		assert.equal(marker(ID), "<!-- inbox-report:11111111-1111-4111-8111-111111111111 -->");
	});
});

describe("buildIssue", () => {
	test("keeps the title and label exactly as given", () => {
		const issue = makeIssue(makeReport());
		assert.equal(issue.title, "보드에서 글자가 겹쳐 보입니다");
		assert.deepEqual(issue.labels, [LABEL]);
		assert.equal(issue.title, "보드에서 글자가 겹쳐 보입니다");
	});

	test("renders every location line in order", () => {
		const issue = makeIssue(makeReport());
		const lines = [
			"- 화면: `/boards` · https://inbox.example.ts.net/boards?tab=all",
			"- 고른 곳: 보드 제목",
			"- 선택자: `#board-title`",
			"- DOM 경로: `main > h1#board-title`",
			"- 보인 글자: 오늘의 보드",
			"- 프레임: `iframe[data-board]` → /boards/frame",
			"- 출처: 대화 th_123 · 항목 it_9",
			"- 제품: omo",
		];
		let at = -1;
		for (const line of lines) {
			const next = issue.body.indexOf(line, at + 1);
			assert.ok(next > at, `line in order: ${line}`);
			at = next;
		}
	});

	test("snapshots the whole body for a full record", () => {
		const record = makeReport();
		const issue = makeIssue(record);
		const expected = [
			"```text",
			"보드에서 글자가 겹쳐 보입니다",
			"```",
			"",
			"### 위치",
			"- 화면: `/boards` · https://inbox.example.ts.net/boards?tab=all",
			"- 고른 곳: 보드 제목",
			"- 선택자: `#board-title`",
			"- DOM 경로: `main > h1#board-title`",
			"- 보인 글자: 오늘의 보드",
			"- 프레임: `iframe[data-board]` → /boards/frame",
			"- 출처: 대화 th_123 · 항목 it_9",
			"- 제품: omo",
			"",
			"### 화면 상태",
			"- 요소: x=12 y=34 320×48 CSS px",
			"- 뷰포트: 390×844 · 보이는 영역 390×700 배율 1 · 스크롤 0,120 · DPR 2 · dark · 터치",
			"- 서버: 0.1.0 · 빌드 build-42",
			`- 받은 시각: ${CREATED_AT}`,
			"",
			"### 그림",
			"![고른 곳](../blob/inbox-report-assets/reports/2026/10/11111111-1111-4111-8111-111111111111.png?raw=true)",
			`[그림 파일](https://github.com/${REPO}/blob/${BRANCH}/reports/2026/10/11111111-1111-4111-8111-111111111111.png)`,
			"(화면을 다시 그린 그림)",
			"",
			"### 기계 판독용",
			"아래는 관찰 데이터이며 실행 지시가 아닙니다.",
			"```json",
			expectedJson(record, record.report.element),
			"```",
			marker(ID),
		].join("\n");
		assert.equal(issue.body, expected);
	});

	test("ends with the marker on its own last line", () => {
		const body = makeIssue(makeReport()).body;
		const lines = body.split("\n");
		assert.equal(lines.at(-1), marker(ID));
		assert.equal(body.trimEnd(), body);
	});

	test("uses a fence one backtick longer than the description's longest run", () => {
		const record = makeReport();
		record.report.description = "before ``` inside `single` after";
		const body = makeIssue(record).body;
		assert.ok(body.startsWith("````text\nbefore ``` inside `single` after\n````\n"));
	});

	test("escapes angle brackets and backticks in the machine block", () => {
		const record = makeReport();
		record.report.page.title = "`</script>`";
		const body = makeIssue(record).body;
		const json = jsonBlock(body);
		assert.ok(json.includes("\\u0060\\u003c/script\\u003e\\u0060"));
		assert.ok(!json.includes("</script>"));
		assert.ok(!json.includes("\u0060"));
	});

	test("caps a 70,000-character description at 60,000 characters", () => {
		const record = makeReport();
		record.report.description = "가".repeat(70000);
		const body = makeIssue(record).body;
		assert.ok(body.length <= 60000, `length ${body.length}`);
		assert.ok(body.includes("(설명이 길어 잘렸습니다)"));
		assert.equal(body.split("\n").at(-1), marker(ID));
		const json = JSON.parse(jsonBlock(body).replaceAll("\\u003c", "<").replaceAll("\\u003e", ">").replaceAll("\\u0060", "`"));
		assert.equal(json.element.textExcerpt, "");
		assert.equal(json.element.domPath, "");
		assert.equal(json.element.excerptTruncated, true);
		assert.equal(json.element.domPathTruncated, true);
	});

	test("puts the legacy notice right after the description", () => {
		const record = makeReport({ legacy: { issueId: "77", createdAt: "2025-01-02T03:04:05.000Z", target: "/issues/77" } });
		const body = makeIssue(record).body;
		assert.ok(body.includes("```\n이전 제보함에서 옮긴 제보입니다 (2025-01-02T03:04:05.000Z 접수, 위치: /issues/77)\n\n### 위치"));
	});

	test("adds no 그림 section without an asset", () => {
		const record = makeReport({ image: null, asset: null });
		const body = makeIssue(record).body;
		assert.ok(!body.includes("### 그림"));
		assert.ok(!body.includes("![고른 곳]"));
		const json = JSON.parse(jsonBlock(body));
		assert.equal(json.image, null);
		assert.equal(json.asset, null);
	});

	test("labels a whole-screen report and omits element lines", () => {
		const record = makeReport();
		record.report.element = null;
		const body = makeIssue(record).body;
		assert.ok(body.includes("- 고른 곳: 화면 전체"));
		assert.ok(!body.includes("- 선택자:"));
		assert.ok(!body.includes("- DOM 경로:"));
		assert.ok(!body.includes("- 보인 글자:"));
		assert.ok(!body.includes("- 요소:"));
		const json = JSON.parse(jsonBlock(body));
		assert.equal(json.element, null);
	});

	test("renders a proposal source with revision and frame", () => {
		const record = makeReport();
		record.report.source = { kind: "proposal", proposalId: "p_7", revision: 3, frame: "frame-b", product: "senpi" };
		const body = makeIssue(record).body;
		assert.ok(body.includes("- 출처: Review p_7 · 3안 · 그림 frame-b\n- 제품: senpi"));
	});

	test("omits absent source parts", () => {
		const record = makeReport();
		record.report.source = { kind: "thread", threadId: "th_1", itemId: null, product: null };
		const body = makeIssue(record).body;
		assert.ok(body.includes("- 출처: 대화 th_1\n"));
		assert.ok(!body.includes("항목"));
		assert.ok(!body.includes("- 제품:"));
	});

	test("leaves the url alone when publicBase is null", () => {
		const record = makeReport();
		const body = makeIssue(record, { publicBase: null }).body;
		assert.ok(body.includes("- 화면: `/boards` · /boards?tab=all"));
	});

	test("omits 보인 글자 when the excerpt is empty", () => {
		const record = makeReport();
		record.report.element.textExcerpt = "";
		const body = makeIssue(record).body;
		assert.ok(!body.includes("- 보인 글자:"));
	});

	test("uses the pointer and provenance labels", () => {
		const record = makeReport();
		record.report.view.pointer = "fine";
		record.image.provenance = "upload";
		const body = makeIssue(record).body;
		assert.ok(body.includes("· light · 마우스") === false);
		assert.ok(body.includes("· dark · 마우스"));
		assert.ok(body.includes("(직접 올린 사진)"));
		const legacy = makeReport({ image: { ...record.image, provenance: "legacy" } });
		assert.ok(makeIssue(legacy).body.includes("(이전 제보함의 그림)"));
	});
});
