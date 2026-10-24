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

/* Ideal-state coverage map read by qa/issues-qa.mjs into manifest.json.
 *
 * Each IS row names the executable scenarios that prove it plus stable check anchors.
 * `match` is a substring of the check name recorded by that scenario; the aggregate runner
 * resolves every anchor against the checks actually observed in this run and reports a
 * passed/failed/missing status per anchor instead of trusting this table as prose.
 */
export const IS_COVERAGE = {
	"IS-01": {
		property: "One description is the only required field; ordinary pages, embedded threads, closed Reviews and the viewer offer reporting.",
		scenarios: ["Q13", "Q15", "Q16", "Q17", "Q18"],
		checks: [
			{ scenario: "Q13", match: "the description is the only required input" },
			{ scenario: "Q15", match: "the header has 제보함, the report trigger and a server-fed issue badge" },
			{ scenario: "Q16", match: "the thread offers 제보함, the 제보 entry and one message entry per bubble" },
			{ scenario: "Q17", match: "the header has independent 제보/제보함 links" },
			{ scenario: "Q18", match: "the header has 제보함" },
		],
	},
	"IS-02": {
		property: "Reporting and issue handling do not write source proposal/thread/mailbox/liveness records or wake agents.",
		scenarios: ["Q15", "Q16", "Q17", "Q18", "Q20"],
		checks: [
			{ scenario: "Q15", match: "the report lifecycle from before open through send leaves data/proposals, data/threads and mailbox byte-identical" },
			{ scenario: "Q16", match: "the report added no thread event of its own" },
			{ scenario: "Q17", match: "no proposal event is appended" },
			{ scenario: "Q18", match: "the report appended no Review event and wrote no mailbox file" },
			{ scenario: "Q20", match: "source isolation digests" },
		],
	},
	"IS-03": {
		property: "Capture the displayed revision/item, excerpt and viewport before reporter UI changes the page; never replace them with latest data.",
		scenarios: ["Q04", "Q18", "Q20"],
		checks: [
			{ scenario: "Q04", match: "frozen capture keeps revision 1" },
			{ scenario: "Q18", match: "the stored issue names revision 1" },
			{ scenario: "Q20", match: "keeps the revision-1 source" },
		],
	},
	"IS-04": {
		property: "Optional pointer/keyboard target selection identifies, but never activates, the target or reads its form value.",
		scenarios: ["Q13", "Q17", "Q18"],
		checks: [
			{ scenario: "Q13", match: "the keyboard picker selects the record target" },
			{ scenario: "Q17", match: "selecting a target invokes no proposal mutation" },
			{ scenario: "Q18", match: "a touch tap picks the frame and draws no Review mark" },
		],
	},
	"IS-05": {
		property: "User image, display capture, source crop, reproduction and structured context have distinct provenance labels.",
		scenarios: ["Q02", "Q12", "Q14", "Q20"],
		checks: [
			{ scenario: "Q02", match: "reproduction provenance in create rejects" },
			{ scenario: "Q12", match: "denied capture yields visual none/denied" },
			{ scenario: "Q14", match: "the reproduction is labelled as a reproduction" },
			{ scenario: "Q20", match: "visual provenance stays none/denied" },
		],
	},
	"IS-06": {
		property: "Preview/removal of context is possible; only bounded allowlisted metadata and explicitly selected text are retained.",
		scenarios: ["Q08", "Q13"],
		checks: [
			{ scenario: "Q08", match: "snapshot entries carry only permitted tagged fields" },
			{ scenario: "Q13", match: "the saved IndexedDB record holds only the approved context" },
		],
	},
	"IS-07": {
		property: "Optional image paste/file/capability-based screen capture, marking and irreversible pixel masking work; failures keep the text.",
		scenarios: ["Q03", "Q12", "Q14"],
		checks: [
			{ scenario: "Q03", match: "every masked pixel is opaque black" },
			{ scenario: "Q12", match: "retained PNG has the exported dimensions" },
			{ scenario: "Q14", match: "the original capture is labelled as a display capture" },
		],
	},
	"IS-08": {
		property: "Draft/cursor/capture and uncertain receipt survive refresh, polling and breakpoint handoff; storage failure is explicit.",
		scenarios: ["Q05", "Q13", "Q15"],
		checks: [
			{ scenario: "Q05", match: "reload returns identical capture" },
			{ scenario: "Q13", match: "the saved draft comes back with thread A's capture" },
			{ scenario: "Q15", match: "at 719px the typed text, cursor, capture and single dialog survive" },
		],
	},
	"IS-09": {
		property: "Double tap, lost reply, restart and retry produce one durable effect; stale updates cannot silently win.",
		scenarios: ["Q05", "Q07", "Q13", "Q20"],
		checks: [
			{ scenario: "Q05", match: "exactly one of two stale writes succeeds" },
			{ scenario: "Q07", match: "two competing commands commit one effect" },
			{ scenario: "Q13", match: "the online event retries once by GET and yields the exact original receipt" },
			{ scenario: "Q20", match: "concurrent triage commits exactly one" },
		],
	},
	"IS-10": {
		property: "Separate searchable/paginated list and detail retain context even when the source changes or disappears.",
		scenarios: ["Q14"],
		checks: [
			{ scenario: "Q14", match: "search narrows the list" },
			{ scenario: "Q14", match: "seed B carries a missing source reference" },
		],
	},
	"IS-11": {
		property: "Owner comments and local maintainer triage/check requests use issue records and pull CLI.",
		scenarios: ["Q10", "Q11", "Q14"],
		checks: [
			{ scenario: "Q10", match: "existing Review and revision is recorded" },
			{ scenario: "Q11", match: "triage and check advanced the sequence" },
			{ scenario: "Q14", match: "comment advances the sequence" },
		],
	},
	"IS-12": {
		property: "Fix claim, relevant applied artifact/build, reproduction and owner confirmation remain separate; still present preserves history and reopens.",
		scenarios: ["Q11", "Q14", "Q19"],
		checks: [
			{ scenario: "Q11", match: "check moved the issue to needs-check" },
			{ scenario: "Q14", match: "the correction check reads 확인됨 without an install claim" },
			{ scenario: "Q19", match: "a maintainer request_check opens 확인 요청" },
		],
	},
	"IS-13": {
		property: "Keyboard, touch, modal focus, browser Back, mobile keyboard, zoom and contrast remain usable.",
		scenarios: ["Q12", "Q13", "Q16", "Q18", "Q20"],
		checks: [
			{ scenario: "Q12", match: "keyboard (Enter, arrows, Shift+arrow, Enter) adds a second mask" },
			{ scenario: "Q13", match: "Tab past the last control and Shift+Tab" },
			{ scenario: "Q16", match: "the message entry opens the composer with the reply text" },
			{ scenario: "Q18", match: "Back closes only the reporter" },
			{ scenario: "Q20", match: "keyboard-only matrix" },
		],
	},
	"IS-14": {
		property: "Existing access matrix stays intact; issue inputs, origins, paths, pixels and allocations are validated.",
		scenarios: ["Q02", "Q03", "Q10", "Q15", "Q17", "Q20"],
		checks: [
			{ scenario: "Q02", match: "unknown key rejects at its exact path" },
			{ scenario: "Q03", match: "rejects" },
			{ scenario: "Q10", match: "foreign Origin is 403" },
			{ scenario: "Q15", match: "the report lifecycle from before open through send" },
			{ scenario: "Q17", match: "Review counts are unchanged" },
			{ scenario: "Q20", match: "source isolation digests" },
		],
	},
	"IS-15": {
		property: "Failure states preserve input and distinguish saved, pending, unknown and accepted outcomes.",
		scenarios: ["Q05", "Q13", "Q14", "Q20"],
		checks: [
			{ scenario: "Q05", match: "aborted transaction leaves the previous record intact" },
			{ scenario: "Q13", match: "a response dropped after commit shows 접수 확인 중" },
			{ scenario: "Q14", match: "a malformed success" },
			{ scenario: "Q20", match: "the create response is lost" },
		],
	},
	"IS-16": {
		property: "Answers, reopen/hide, marks/ack, speech, split navigation, pushes and polling retain their behavior.",
		scenarios: ["Q06", "Q07", "Q15", "Q16", "Q17", "Q18"],
		checks: [
			{ scenario: "Q06", match: "row data-session=qa-issue-a exists" },
			{ scenario: "Q07", match: "proposal, thread and mailbox files are unchanged" },
			{ scenario: "Q15", match: "the issue badge never changes the Review badge" },
			{ scenario: "Q16", match: "the original answer still runs through its own API" },
			{ scenario: "Q17", match: "the seeded Review rows still render" },
			{ scenario: "Q18", match: "the second Back closes the viewer as before" },
		],
	},
	"IS-17": {
		property: "Existing git-package install includes all assets, both READMEs agree, and data survives the existing data-preserving uninstall.",
		scenarios: ["Q19"],
		checks: [
			{ scenario: "Q19", match: "the isolated copy contains every issue runtime module" },
			{ scenario: "Q19", match: "uninstall removes the app but keeps every issue" },
			{ scenario: "Q19", match: "reinstall restores the package" },
		],
	},
	"IS-18": {
		property: "Every ideal row has behavior tests where appropriate, actual browser/HTTP/CLI proof and independent final verification.",
		scenarios: ["Q02", "Q03", "Q04", "Q05", "Q06", "Q07", "Q08", "Q09", "Q10", "Q11", "Q12", "Q13", "Q14", "Q15", "Q16", "Q17", "Q18", "Q19", "Q20"],
		checks: [
			{ scenario: "Q02", match: "valid envelope passes" },
			{ scenario: "Q10", match: "valid create returns 201" },
			{ scenario: "Q14", match: "detail shows needs-check" },
			{ scenario: "Q19", match: "the installed server reports its manifest build identity" },
			{ scenario: "Q20", match: "aggregate matrix" },
		],
	},
};

