import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/redact.mjs";

const HIDDEN = "…";

// Positive cases: [input, expected]. Each contains one credential-shaped secret.
export const SECRET_CASES = [
	["키는 sk-abcdefghijklmnopqrstuvwxyz012345 입니다", `키는 ${HIDDEN} 입니다`],
	["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", `token ${HIDDEN}`],
	["github_pat_11ABCDEFG0abcdefghijklmnop_0123456789abcdef", HIDDEN],
	["xoxb-123456789012-abcdefghijklmnop", HIDDEN],
	["xoxp-123456789012-abcdefghijklmnop", HIDDEN],
	["xoxa-123456789012-abcdefghijklmnop", HIDDEN],
	["AKIAIOSFODNN7EXAMPLE", HIDDEN],
	[
		"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
		HIDDEN,
	],
	["sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", `sha ${HIDDEN}`],
	["blob aGVsbG8gd29ybGQgdGhpcyBpcyBhIGxvbmcgYmFzZTY0IHJ1bg==", `blob ${HIDDEN}`],
	["Authorization: Bearer abc123def456ghi789", `Authorization: ${HIDDEN}`],
	["password=hunter2", HIDDEN],
	["DB password: s3cret-value!", `DB ${HIDDEN}`],
	["cat ~/.ssh/id_rsa", `cat ${HIDDEN}`],
	["C:\\Users\\me\\.ssh\\id_rsa", HIDDEN],
	["읽은 파일 /home/u/.ssh/config", `읽은 파일 ${HIDDEN}`],
	["source ~/.mcp-secrets.env", `source ${HIDDEN}`],
	["yjack@example.com", HIDDEN],
	["문의: yjack@example.com 으로", `문의: ${HIDDEN} 으로`],
	["aaaabbbbccccddddeeeeffffgggghhhh", HIDDEN],
];

// Negative cases: text that must survive unchanged.
export const SAFE_CASES = [
	"커밋 3개를 올렸습니다",
	"오늘 12시에 회의가 있습니다",
	"버전 1.2.3 배포 완료",
	"2026-10-17 기준입니다",
	"a".repeat(31),
	"deadbeef",
	"password 정책을 물어봤습니다",
	"Bear 도구를 씁니다",
	"src/redact.mjs 파일을 열었습니다",
	"1234567890123456789",
];

describe("redact", () => {
	test("hides every credential shape behind an ellipsis", () => {
		assert.ok(SECRET_CASES.length >= 12, `expected at least 12 positive cases, got ${SECRET_CASES.length}`);
		for (const [input, expected] of SECRET_CASES) {
			assert.equal(redact(input), expected, `redact(${JSON.stringify(input)})`);
		}
	});

	test("leaves Korean text and short numbers intact", () => {
		assert.ok(SAFE_CASES.length >= 6, `expected at least 6 negative cases, got ${SAFE_CASES.length}`);
		for (const input of SAFE_CASES) {
			assert.equal(redact(input), input, `redact(${JSON.stringify(input)})`);
		}
	});

	test("is idempotent", () => {
		for (const [input] of SECRET_CASES) {
			const once = redact(input);
			assert.equal(redact(once), once, `redact(redact(${JSON.stringify(input)}))`);
		}
		for (const input of SAFE_CASES) {
			assert.equal(redact(redact(input)), input);
		}
	});

	test("keeps surrounding context and hides only the secret", () => {
		const line = "푸시 본문: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 (만료)";
		assert.equal(redact(line), `푸시 본문: token ${HIDDEN} (만료)`);
	});

	test("returns non-string and empty input unchanged", () => {
		assert.equal(redact(""), "");
		assert.equal(redact(null), null);
		assert.equal(redact(undefined), undefined);
	});

	test("hides several secrets in one sentence", () => {
		const text = "sk-abcdefghijklmnopqrstuvwxyz012345 와 yjack@example.com";
		assert.equal(redact(text), `${HIDDEN} 와 ${HIDDEN}`);
	});
});
