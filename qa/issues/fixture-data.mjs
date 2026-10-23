/* Plain seed data for the issue-reporting QA harness: two threads, four review board
 * revisions, and deterministic UUIDv4 strings. No network or filesystem code lives here.
 *
 * UUID derivation: HMAC-SHA256(UUID_SEED, "uuid:<index>") for index 1..32; the first 16
 * bytes become the UUID after setting the version nibble to 4 and the variant bits to 10.
 * The same seed and index always give the same UUID, on every platform and Node version.
 */
import crypto from "node:crypto";

export const UUID_SEED = "omo-inbox-issues-qa-v1";

export function deriveUuids(seed = UUID_SEED, count = 32) {
	const out = [];
	for (let index = 1; index <= count; index++) {
		const bytes = crypto.createHmac("sha256", seed).update(`uuid:${index}`, "utf8").digest().subarray(0, 16);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = bytes.toString("hex");
		out.push(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
	}
	return out;
}

export const uuids = deriveUuids();

export const threads = {
	a: {
		session: "qa-issue-a",
		title: "결제 화면 문제 제보",
		product: "omo-inbox",
		branch: "feat/issue-reporting",
		firstRequest: "결제 화면의 제보 버튼을 확인해 줘",
		item: {
			kind: "turn",
			policy: "needs-you",
			dedupeKey: "turn:qa-issue-a:1",
			raw: {
				text: "제보 버튼이 결제 화면에서 보이는지 확인해 주세요.",
				request: "결제 화면의 제보 버튼을 확인해 줘",
			},
		},
	},
	b: {
		session: "qa-issue-b",
		title: "제보함 목록 점검",
		product: "omo-inbox",
		branch: "feat/issue-reporting",
		firstRequest: "제보함 목록을 점검해 줘",
		item: {
			kind: "progress",
			policy: "progress",
			dedupeKey: "turn:qa-issue-b:1",
			raw: {
				text: "제보함 목록의 빈 상태를 확인하는 중입니다.",
				request: "제보함 목록을 점검해 줘",
			},
		},
	},
};

const decisionBase = {
	lead: "제보 흐름의 첫 결정입니다.",
	sections: [
		{
			title: "화면",
			cards: [{ title: "제보 버튼", frames: [["제보 버튼", "frame.png"]] }],
		},
	],
};

export const decisionRev1 = {
	title: "제보 흐름 결정",
	...decisionBase,
	questions: [
		{
			id: "q1",
			text: "제보 버튼은 어디에 둘까요?",
			options: [
				{ value: "header", label: "상단 도구 줄", rec: true, why: "모든 화면에서 같은 위치입니다." },
				{ value: "bottom", label: "하단 고정 줄" },
			],
		},
		{
			id: "q2",
			text: "화면 캡처는 어떻게 다룰까요?",
			options: [
				{ value: "optional", label: "선택 사항으로 둡니다", rec: true },
				{ value: "always", label: "항상 함께 보냅니다" },
			],
		},
	],
};

export const decisionRev2 = {
	...decisionBase,
	lead: "두 번째 수정본입니다. 하단 고정 줄을 기본으로 제안합니다.",
	title: "제보 흐름 결정",
	questions: [
		{
			id: "q1",
			text: "제보 버튼은 어디에 둘까요?",
			options: [
				{ value: "header", label: "상단 도구 줄" },
				{ value: "bottom", label: "하단 고정 줄", rec: true, why: "한 손으로 닿기 쉽습니다." },
			],
		},
		{
			id: "q2",
			text: "화면 캡처는 어떻게 다룰까요?",
			options: [
				{ value: "optional", label: "선택 사항으로 둡니다", rec: true },
				{ value: "always", label: "항상 함께 보냅니다" },
			],
		},
	],
};

export const reportRev1 = {
	title: "제보 기능 완료 보고",
	kind: "report",
	lead: "제보 흐름의 첫 보고입니다.",
	sections: [
		{
			title: "결과",
			cards: [{ title: "제보함", frames: [["제보함 목록", "frame.png"]] }],
		},
	],
};

export const reportRev2 = {
	...reportRev1,
	lead: "두 번째 수정본입니다. 목록의 빈 상태 문구를 다듬었습니다.",
};

export const boards = {
	decision: [decisionRev1, decisionRev2],
	report: [reportRev1, reportRev2],
};
