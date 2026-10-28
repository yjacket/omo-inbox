import test, { describe } from "node:test";
import assert from "node:assert/strict";
import {
	LIMITS,
	validateCreate,
	deriveTitle,
	fingerprint,
	redactReport,
	pngInfo,
	rowState,
	FAILURE_TEXT,
} from "../src/reports-contract.mjs";
import { redact } from "../src/redact.mjs";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HIDDEN = "…";

function pngBuffer(width, height, pad = 0) {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(13, 0);
	head.write("IHDR", 4, "ascii");
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const crc = Buffer.alloc(4);
	return Buffer.concat([SIGNATURE, head, ihdr, crc, Buffer.alloc(pad)]);
}

function imageFor(width, height, pad = 0) {
	const bytes = pngBuffer(width, height, pad);
	return { provenance: "snapshot", png: bytes.toString("base64"), width, height };
}

function baseBody() {
	return {
		v: 2,
		reportId: UUID,
		description: "버튼이 눌리지 않습니다",
		page: {
			kind: "thread",
			route: "/s/:sid",
			url: "/s/demo-sid",
			title: "대화",
			frames: [],
		},
		element: null,
		view: {
			layout: { w: 1280, h: 720 },
			visual: { x: 0, y: 0, w: 1280, h: 720, scale: 1 },
			scroll: { x: 0, y: 0 },
			dpr: 1,
			colorScheme: "light",
			pointer: "fine",
		},
		source: null,
		image: null,
	};
}

function fullBody() {
	const body = baseBody();
	body.page = {
		kind: "inbox",
		route: "/",
		url: "/?s=demo",
		title: "받은 편지함",
		frames: [{ selector: "iframe#preview", url: "/preview" }],
	};
	body.element = {
		selector: "#send",
		selectorStability: "id",
		domPath: "body > form#compose > button#send",
		domPathTruncated: false,
		tag: "button",
		role: "button",
		label: "보내기",
		textExcerpt: "보내기",
		excerptTruncated: false,
		rect: { x: 10, y: 20, w: 80, h: 30 },
	};
	body.source = {
		kind: "proposal",
		proposalId: "pv_123",
		revision: 3,
		frame: "preview",
	};
	body.image = imageFor(4, 3);
	return body;
}

function withBody(mutator) {
	const body = structuredClone(fullBody());
	mutator(body);
	return body;
}

function assertField(body, path) {
	const result = validateCreate(body);
	assert.equal(result.ok, false, `expected rejection for ${path}`);
	assert.ok(result.fields.includes(path), `fields ${JSON.stringify(result.fields)} include ${path}`);
	return result;
}

describe("validateCreate", () => {
	test("accepts a valid minimal body", () => {
		const result = validateCreate(baseBody());
		assert.equal(result.ok, true);
		assert.equal(result.png, null);
		assert.equal(result.value.element, null);
		assert.equal(result.value.image, null);
		assert.deepEqual(result.value.page.frames, []);
	});

	test("accepts a valid full body and returns the decoded PNG", () => {
		const body = fullBody();
		const decoded = Buffer.from(body.image.png, "base64");
		const result = validateCreate(body);
		assert.equal(result.ok, true);
		assert.ok(Buffer.isBuffer(result.png));
		assert.equal(result.png.length, decoded.length);
		assert.ok(result.png.equals(decoded));
		assert.equal(result.value.image.width, 4);
		assert.equal(result.value.image.height, 3);
		assert.equal(result.value.image.png, undefined);
	});

	test("rejects a top-level unknown key with its path", () => {
		assertField(withBody((body) => { body.extra = 1; }), "extra");
	});

	test("rejects a client-supplied source.product", () => {
		assertField(withBody((body) => { body.source.product = "p"; }), "source.product");
	});

	test("rejects a client-supplied source.product on a thread source", () => {
		assertField(withBody((body) => {
			body.source = { kind: "thread", threadId: "t1", itemId: null, product: "p" };
		}), "source.product");
	});

	test("rejects element.extra (QA failure scenario)", () => {
		assertField(withBody((body) => { body.element.extra = true; }), "element.extra");
	});

	test("rejects unknown nested keys with full JSON paths", () => {
		assertField(withBody((body) => { body.page.extra = 1; }), "page.extra");
		assertField(withBody((body) => { body.view.layout.extra = 1; }), "view.layout.extra");
		assertField(withBody((body) => { body.image.extra = 1; }), "image.extra");
		assertField(withBody((body) => { body.page.frames[0].extra = 1; }), "page.frames[0].extra");
	});

	test("rejects a non-uuid reportId and non-v4 variants", () => {
		assertField(withBody((body) => { body.reportId = "nope"; }), "reportId");
		assertField(withBody((body) => { body.reportId = "123e4567-e89b-12d3-a456-426614174000"; }), "reportId");
		assertField(withBody((body) => { body.reportId = "123e4567-e89b-42d3-7456-426614174000"; }), "reportId");
		assertField(withBody((body) => { body.reportId = UUID.toUpperCase(); }), "reportId");
	});

	test("requires v = 2", () => {
		assertField(withBody((body) => { body.v = 1; }), "v");
		assertField(withBody((body) => { body.v = "2"; }), "v");
	});

	test("description: 8192 UTF-8 bytes accepted, 8193 rejected", () => {
		const max = withBody((body) => { body.description = "a".repeat(LIMITS.DESCRIPTION_BYTES); });
		assert.equal(validateCreate(max).ok, true);
		assertField(withBody((body) => { body.description = "a".repeat(LIMITS.DESCRIPTION_BYTES + 1); }), "description");
		assertField(withBody((body) => { body.description = ""; }), "description");
	});

	test("description size is measured in UTF-8 bytes, not code points", () => {
		// 2730 Hangul syllables are 8190 bytes but only 2730 code points.
		assert.equal(validateCreate(withBody((body) => { body.description = "가".repeat(2730); })).ok, true);
		assertField(withBody((body) => { body.description = "가".repeat(2731); }), "description");
	});

	test("page.url: 2048 bytes accepted, 2049 rejected", () => {
		assert.equal(validateCreate(withBody((body) => { body.page.url = "/" + "a".repeat(LIMITS.PAGE_URL_BYTES - 1); })).ok, true);
		assertField(withBody((body) => { body.page.url = "/" + "a".repeat(LIMITS.PAGE_URL_BYTES); }), "page.url");
	});

	test("page.url allows ?s= only on / and rejects other queries", () => {
		assert.equal(validateCreate(withBody((body) => { body.page.url = "/?s=demo"; })).ok, true);
		assertField(withBody((body) => { body.page.url = "/boards?x=1"; }), "page.url");
		assertField(withBody((body) => { body.page.url = "/?x=1"; }), "page.url");
		assertField(withBody((body) => { body.page.url = "https://example.test/"; }), "page.url");
	});

	test("page.title: 160 bytes accepted, 161 rejected", () => {
		assert.equal(validateCreate(withBody((body) => { body.page.title = "a".repeat(LIMITS.PAGE_TITLE_BYTES); })).ok, true);
		assertField(withBody((body) => { body.page.title = "a".repeat(LIMITS.PAGE_TITLE_BYTES + 1); }), "page.title");
	});

	test("frames: one accepted, two rejected; frame selector boundary enforced", () => {
		assert.equal(validateCreate(withBody((body) => {
			body.page.frames = [{ selector: "a".repeat(LIMITS.SELECTOR_BYTES), url: "/preview" }];
		})).ok, true);
		assertField(withBody((body) => {
			body.page.frames = [{ selector: "a", url: "/one" }, { selector: "b", url: "/two" }];
		}), "page.frames");
		assertField(withBody((body) => {
			body.page.frames = [{ selector: "a".repeat(LIMITS.SELECTOR_BYTES + 1), url: "/preview" }];
		}), "page.frames[0].selector");
	});

	test("frame url is a pathname without a query", () => {
		assertField(withBody((body) => { body.page.frames[0].url = "/preview?x=1"; }), "page.frames[0].url");
	});

	test("page.kind and page.route enums are strict", () => {
		assertField(withBody((body) => { body.page.kind = "other"; }), "page.kind");
		assertField(withBody((body) => { body.page.route = "/unknown"; }), "page.route");
	});

	test("selector and domPath: max accepted, max+1 rejected", () => {
		assert.equal(validateCreate(withBody((body) => {
			body.element.selector = "a".repeat(LIMITS.SELECTOR_BYTES);
			body.element.domPath = "b".repeat(LIMITS.DOM_PATH_BYTES);
		})).ok, true);
		assertField(withBody((body) => { body.element.selector = "a".repeat(LIMITS.SELECTOR_BYTES + 1); }), "element.selector");
		assertField(withBody((body) => { body.element.domPath = "b".repeat(LIMITS.DOM_PATH_BYTES + 1); }), "element.domPath");
		assert.equal(validateCreate(withBody((body) => { body.element.selector = null; })).ok, true);
	});

	test("tag and role: max accepted, max+1 rejected", () => {
		assert.equal(validateCreate(withBody((body) => {
			body.element.tag = "a".repeat(LIMITS.TAG_BYTES);
			body.element.role = "a".repeat(LIMITS.ROLE_BYTES);
		})).ok, true);
		assertField(withBody((body) => { body.element.tag = "a".repeat(LIMITS.TAG_BYTES + 1); }), "element.tag");
		assertField(withBody((body) => { body.element.role = "a".repeat(LIMITS.ROLE_BYTES + 1); }), "element.role");
		assertField(withBody((body) => { body.element.tag = "BUTTON"; }), "element.tag");
	});

	test("label and textExcerpt: max accepted, max+1 rejected", () => {
		assert.equal(validateCreate(withBody((body) => {
			body.element.label = "a".repeat(LIMITS.LABEL_BYTES);
			body.element.textExcerpt = "b".repeat(LIMITS.EXCERPT_BYTES);
		})).ok, true);
		assertField(withBody((body) => { body.element.label = "a".repeat(LIMITS.LABEL_BYTES + 1); }), "element.label");
		assertField(withBody((body) => { body.element.textExcerpt = "b".repeat(LIMITS.EXCERPT_BYTES + 1); }), "element.textExcerpt");
	});

	test("selectorStability enum is strict", () => {
		assertField(withBody((body) => { body.element.selectorStability = "xpath"; }), "element.selectorStability");
	});

	test("source ids and frame text boundaries", () => {
		const thread = (id) => withBody((body) => {
			body.source = { kind: "thread", threadId: id, itemId: null };
		});
		assert.equal(validateCreate(thread("t".repeat(LIMITS.SOURCE_ID_BYTES))).ok, true);
		assertField(thread("t".repeat(LIMITS.SOURCE_ID_BYTES + 1)), "source.threadId");
		assertField(thread(""), "source.threadId");

		const proposal = (id, frame) => withBody((body) => {
			body.source = { kind: "proposal", proposalId: id, revision: 1, frame };
		});
		assert.equal(validateCreate(proposal("p".repeat(LIMITS.SOURCE_ID_BYTES), "f".repeat(LIMITS.FRAME_TEXT_BYTES))).ok, true);
		assertField(proposal("p".repeat(LIMITS.SOURCE_ID_BYTES + 1), null), "source.proposalId");
		assertField(proposal("pv_1", "f".repeat(LIMITS.FRAME_TEXT_BYTES + 1)), "source.frame");
	});

	test("proposal revision must be a positive integer or null", () => {
		assertField(withBody((body) => { body.source.revision = 0; }), "source.revision");
		assertField(withBody((body) => { body.source.revision = 1.5; }), "source.revision");
		assert.equal(validateCreate(withBody((body) => { body.source.revision = null; })).ok, true);
	});

	test("all numbers must be finite and in range", () => {
		assertField(withBody((body) => { body.view.dpr = NaN; }), "view.dpr");
		assertField(withBody((body) => { body.view.dpr = Infinity; }), "view.dpr");
		assertField(withBody((body) => { body.view.dpr = 0.4; }), "view.dpr");
		assertField(withBody((body) => { body.view.dpr = 8.1; }), "view.dpr");
		assertField(withBody((body) => { body.view.visual.scale = 0.09; }), "view.visual.scale");
		assertField(withBody((body) => { body.view.visual.scale = 10.1; }), "view.visual.scale");
		assertField(withBody((body) => { body.element.rect.x = 100001; }), "element.rect.x");
		assertField(withBody((body) => { body.view.scroll.y = -100001; }), "view.scroll.y");
	});

	test("enums for colorScheme and pointer are strict", () => {
		assertField(withBody((body) => { body.view.colorScheme = "auto"; }), "view.colorScheme");
		assertField(withBody((body) => { body.view.pointer = "mouse"; }), "view.pointer");
	});

	test("rejects a bad PNG signature", () => {
		assertField(withBody((body) => {
			const bytes = Buffer.from(body.image.png, "base64");
			bytes[0] = 0;
			body.image.png = bytes.toString("base64");
		}), "image.png");
	});

	test("rejects IHDR dimensions that differ from the stated dimensions", () => {
		assertField(withBody((body) => {
			body.image.png = imageFor(5, 3).png;
		}), "image.png");
	});

	test("rejects oversize pixel counts and sides", () => {
		assertField(withBody((body) => {
			body.image = imageFor(2048, 1025);
		}), "image.png");
		assertField(withBody((body) => {
			body.image = imageFor(4097, 1);
		}), "image.width");
		assert.equal(validateCreate(withBody((body) => {
			body.image = imageFor(2048, 1024);
		})).ok, true);
		assert.equal(validateCreate(withBody((body) => {
			body.image = imageFor(4096, 1);
		})).ok, true);
	});

	test("rejects a decoded PNG of 8 MiB + 1 byte", () => {
		const result = assertField(withBody((body) => {
			body.image = imageFor(1, 1, LIMITS.PNG_MAX_BYTES + 1 - 33);
		}), "image.png");
		assert.ok(result.fields.includes("image.png"));
	});

	test("accepts a decoded PNG of exactly 8 MiB", () => {
		const result = validateCreate(withBody((body) => {
			body.image = imageFor(1, 1, LIMITS.PNG_MAX_BYTES - 33);
		}));
		assert.equal(result.ok, true);
		assert.equal(result.png.length, LIMITS.PNG_MAX_BYTES);
	});

	test("rejects base64 that does not round-trip exactly", () => {
		assertField(withBody((body) => { body.image.png = `${body.image.png}\n`; }), "image.png");
		assertField(withBody((body) => { body.image.png = `data:image/png;base64,${body.image.png}`; }), "image.png");
	});

	test("image provenance enum is strict", () => {
		assertField(withBody((body) => { body.image.provenance = "display_capture"; }), "image.provenance");
	});
});

describe("deriveTitle", () => {
	test("uses the first non-blank line, trimmed", () => {
		assert.equal(deriveTitle("\n\n  첫 줄  \n둘째 줄"), "첫 줄");
		assert.equal(deriveTitle("hello"), "hello");
		assert.equal(deriveTitle("\n \t\n"), "");
		assert.equal(deriveTitle(null), "");
	});

	test("cuts Korean text at 80 code points and appends an ellipsis", () => {
		const text = "가".repeat(100);
		const title = deriveTitle(text);
		assert.equal(Array.from(title).length, LIMITS.TITLE_CODE_POINTS);
		assert.ok(title.endsWith("…"));
		assert.equal(title.slice(0, -1), "가".repeat(LIMITS.TITLE_CODE_POINTS - 1));
		assert.equal(deriveTitle("가".repeat(LIMITS.TITLE_CODE_POINTS)), "가".repeat(LIMITS.TITLE_CODE_POINTS));
	});

	test("does not split surrogate pairs", () => {
		const emoji = "😀".repeat(81);
		const title = deriveTitle(emoji);
		assert.equal(Array.from(title).length, LIMITS.TITLE_CODE_POINTS);
		assert.ok(title.endsWith("…"));
	});
});

describe("fingerprint", () => {
	test("is stable under recursive key order", () => {
		const a = { b: { d: 1, c: [1, { f: 2, e: 3 }] }, a: "x" };
		const b = { a: "x", b: { c: [1, { e: 3, f: 2 }], d: 1 } };
		assert.equal(fingerprint(a, null), fingerprint(b, null));
		assert.match(fingerprint(a, null), /^[0-9a-f]{64}$/);
	});

	test("ignores image.png bytes but includes the PNG hash", () => {
		const value = { image: { png: "one", width: 1 }, description: "x" };
		const other = { image: { png: "two", width: 1 }, description: "x" };
		assert.equal(fingerprint(value, null), fingerprint(other, null));
		assert.notEqual(fingerprint(value, "a"), fingerprint(value, "b"));
		assert.notEqual(fingerprint(value, null), fingerprint(value, "a"));
	});
});

describe("redactReport", () => {
	test("redacts description, page.title, element.label and element.textExcerpt", () => {
		const token = "ghp_" + "a".repeat(36);
		const value = fullBody();
		value.description = `token ${token}`;
		value.page.title = `제목 ${token}`;
		value.element.label = `라벨 ${token}`;
		value.element.textExcerpt = `본문 ${token}`;
		value.element.selector = token;
		const out = redactReport(value, redact);
		assert.ok(out.description.includes(HIDDEN));
		assert.ok(!out.description.includes(token));
		assert.ok(out.page.title.includes(HIDDEN));
		assert.ok(out.element.label.includes(HIDDEN));
		assert.ok(out.element.textExcerpt.includes(HIDDEN));
		// Designated fields only: identifiers pass through byte-for-byte.
		assert.equal(out.element.selector, token);
	});

	test("turns a 32+ character dictated run (an all-hyphen uuid) into the redacted form", () => {
		const value = baseBody();
		value.description = "재현 순서 123e4567-e89b-42d3-a456-426614174000";
		const out = redactReport(value, redact);
		assert.equal(out.description, `재현 순서 ${HIDDEN}`);
	});

	test("does not mutate its input and handles null element", () => {
		const value = baseBody();
		value.description = "ghp_" + "b".repeat(36);
		const out = redactReport(value, redact);
		assert.notEqual(out.description, value.description);
		assert.equal(value.description, "ghp_" + "b".repeat(36));
		const minimal = baseBody();
		const cloned = redactReport(minimal, redact);
		assert.equal(cloned.element, null);
		assert.equal(cloned.description, minimal.description);
	});
});

describe("pngInfo", () => {
	test("reads IHDR width and height", () => {
		assert.deepEqual(pngInfo(pngBuffer(7, 9)), { width: 7, height: 9 });
	});

	test("returns null for a short buffer, bad signature, or non-IHDR", () => {
		assert.equal(pngInfo(Buffer.alloc(4)), null);
		const bad = pngBuffer(1, 1);
		bad[1] = 0;
		assert.equal(pngInfo(bad), null);
		const notIhdr = pngBuffer(1, 1);
		notIhdr.write("IDAT", 12, "ascii");
		assert.equal(pngInfo(notIhdr), null);
	});
});

describe("rowState and FAILURE_TEXT", () => {
	test("maps delivery states to row states", () => {
		for (const state of ["queued", "uploading", "creating", "reconciling", "retry_wait"]) {
			assert.equal(rowState(state), "pending");
		}
		assert.equal(rowState("failed"), "failed");
		assert.equal(rowState("sent"), "sent");
	});

	test("carries the fixed Korean failure texts", () => {
		assert.deepEqual(FAILURE_TEXT, {
			auth: "GitHub 인증을 확인해야 합니다",
			no_token: "GitHub 토큰이 없습니다",
			permission: "저장소에 쓸 권한이 없습니다",
			not_found: "저장소를 찾을 수 없습니다",
			issues_disabled: "저장소의 Issues가 꺼져 있습니다",
			public_repo: "공개 저장소에는 올리지 않습니다",
			validation: "GitHub가 내용을 받지 않았습니다",
			attachment_conflict: "그림 파일이 이미 다르게 올라가 있습니다",
			transient: "GitHub에 연결하지 못했습니다",
		});
	});
});
