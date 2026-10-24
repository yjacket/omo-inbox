import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createDelivery, lateAnswerText } from "../extension/inbox/delivery.ts";
import { safeSegment } from "../extension/inbox/util.ts";

const SID = "s1";
const ITEM = "i-1";
const QUESTION_RAW = {
	request: {
		requestId: "r1",
		questions: [{ id: "q1", header: "Permissions", question: "무엇을 할까요?", options: [{ label: "Allow once", description: "" }], multiSelect: false }],
		required: true,
	},
};

function questionItem(overrides = {}) {
	return { itemId: ITEM, session: SID, kind: "question", status: "open", closedReason: null, raw: QUESTION_RAW, ...overrides };
}

function mailboxFile(home, name, payload, sid = SID) {
	const dir = path.join(home, "mailbox", safeSegment(sid));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, JSON.stringify(payload));
	return file;
}

function answerFile(home, { itemId = ITEM, deliveryId = "d1", payload = { answers: { q1: { selected: ["Allow once"] } } }, kind = "question", ...rest } = {}) {
	return mailboxFile(home, `${itemId}-000001.json`, { v: 1, type: "item-answer", itemId, kind, deliveryId, requestId: "r1", payload, text: null, ...rest });
}

function ledgerFile(home, sid = SID) {
	return path.join(home, "ledger", `${safeSegment(sid)}.json`);
}

function controlFile(home, { deliveryId = "c1", itemId = ITEM, action = "close", sid = SID, ...rest } = {}) {
	const dir = path.join(home, "control", safeSegment(sid));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${deliveryId}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({ v: 1, type: "session-control", action, itemId, deliveryId, issuedAt: new Date().toISOString(), ...rest }),
	);
	return file;
}

function setup(options = {}) {
	const { home, cleanup } = makeTmpHome("inbox-delivery-");
	const trace = [];
	const calls = [];
	const posts = [];
	const logs = [];
	const owners = [];
	const controls = [];
	const items = options.items ?? {};
	const fsSpy = {
		...fsp,
		writeFile: async (file, ...rest) => {
			trace.push(`write:${path.basename(String(file))}`);
			return fsp.writeFile(file, ...rest);
		},
		rename: async (from, to) => fsp.rename(from, to),
		rm: async (file, ...rest) => fsp.rm(file, ...rest),
	};
	const bridge =
		options.bridge ??
		({
			resolveQuestion: async (requestId, payload) => {
				trace.push("bridge:question");
				calls.push({ what: "question", requestId, payload });
				return options.verdict ?? "resolved";
			},
			resolvePermission: async (dialogId, choice, feedbackText) => {
				calls.push({ what: "permission", dialogId, choice, feedbackText });
				return options.permissionResolved ?? true;
			},
		});
	const pi =
		options.pi ??
		({
			session: {
				admitExternalMessage: (request) => {
					trace.push("admit");
					calls.push({ what: "admit", request });
					return { kind: options.admitKind ?? "started" };
				},
			},
		});
	const delivery = createDelivery({
		home,
		fs: fsSpy,
		sessionId: options.sessionId === undefined ? SID : options.sessionId,
		getItem: async (itemId) => items[itemId] ?? null,
		post: async (url, body) => {
			posts.push({ url, body });
			const fails = typeof options.postFails === "function" ? options.postFails(posts) : options.postFails;
			if (fails) throw new Error("server down");
			return { ok: true };
		},
		bridge,
		pi,
		getCtx: () => options.ctx ?? null,
		explain: async (itemId) => {
			calls.push({ what: "explain", itemId });
			if (options.explainFails) throw new Error("no session");
		},
		boardDeliver: async (payload) => {
			calls.push({ what: "board", payload });
		},
		capture: options.capture ?? {
			markOwner: (cause) => {
				trace.push(`owner:${cause}`);
				owners.push(cause);
			},
		},
		log: async (text) => {
			logs.push(text);
		},
		onControl: async (control) => {
			controls.push(control);
			if (typeof options.onControl === "function") return options.onControl(control);
			trace.push(`control:${control.action}`);
		},
		now: options.now,
	});
	return {
		home,
		cleanup,
		delivery,
		calls,
		posts,
		trace,
		logs,
		owners,
		controls,
		exists: (file) => fs.existsSync(file),
		ids: () => (fs.existsSync(ledgerFile(home)) ? JSON.parse(fs.readFileSync(ledgerFile(home), "utf8")).ids : []),
	};
}

test("a live question resolved through the bridge is acked as bridge", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem() } });
	t.after(s.cleanup);
	const file = answerFile(s.home);

	const result = await s.delivery.drain();

	assert.equal(result.handled, 1);
	assert.deepEqual(s.calls[0], { what: "question", requestId: "r1", payload: { answers: { q1: { selected: ["Allow once"] } } } });
	assert.deepEqual(s.posts, [{ url: `/api/items/${ITEM}/delivered`, body: { deliveryId: "d1", how: "bridge", detail: null } }]);
	assert.equal(s.exists(file), false);
});

test("an answer to an already closed question becomes one labeled late message", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem({ status: "closed", closedReason: "timed-out" }) }, verdict: "no-wait" });
	t.after(s.cleanup);
	answerFile(s.home);

	await s.delivery.drain();

	const admit = s.calls.find((call) => call.what === "admit");
	assert.equal(admit.request.text, `[omo-inbox] 폰에서 늦게 온 답 (질문 "Permissions"은 이미 닫힘): Allow once`);
	assert.equal(admit.request.deliverAs, "followUp");
	assert.equal(s.calls.filter((call) => call.what === "admit").length, 1);
	assert.deepEqual(s.posts[0].body, { deliveryId: "d1", how: "late-message", detail: "timed-out" });
});

test("a question whose wait is merely gone gets the plain late text", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem({ status: "open" }) }, verdict: "no-wait" });
	t.after(s.cleanup);
	answerFile(s.home);

	await s.delivery.drain();

	const admit = s.calls.find((call) => call.what === "admit");
	assert.equal(admit.request.text, `${lateAnswerText("Permissions", "Allow once")}`);
	assert.deepEqual(s.posts[0].body, { deliveryId: "d1", how: "late-message", detail: "no-wait" });
});

test("a late question answer never steers, even while the session is busy", async (t) => {
	const s = setup({
		items: { [ITEM]: questionItem({ status: "open" }) },
		ctx: { isIdle: () => false },
		verdict: "no-wait",
	});
	t.after(s.cleanup);
	answerFile(s.home);

	await s.delivery.drain();

	const admit = s.calls.find((call) => call.what === "admit");
	assert.equal(admit.request.deliverAs, "followUp");
	assert.equal("expected_turn_id" in admit.request, false);
});

test("an answer settled on the terminal is dropped without a message", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem({ status: "closed", closedReason: "answered" }) }, verdict: "already-settled" });
	t.after(s.cleanup);
	const file = answerFile(s.home);

	await s.delivery.drain();

	assert.deepEqual(s.calls.filter((call) => call.what === "admit"), []);
	assert.deepEqual(s.posts, [{ url: `/api/items/${ITEM}/delivered`, body: { deliveryId: "d1", how: "dropped", detail: "answered on another surface" } }]);
	assert.equal(s.exists(file), false);
});

test("a phone reply marks the owner cause once, before it is admitted", async (t) => {
	const s = setup({ items: { [ITEM]: { itemId: ITEM, kind: "turn", status: "open", raw: null } } });
	t.after(s.cleanup);
	answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();

	assert.deepEqual(s.owners, ["phone"]);
	assert.ok(s.trace.indexOf("owner:phone") < s.trace.indexOf("admit"), `owner before admit: ${JSON.stringify(s.trace)}`);
});

test("a free message marks the owner cause once", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	answerFile(s.home, { deliveryId: "d2", kind: "notice", payload: { text: "한 가지 더" } });

	await s.delivery.drain();

	assert.deepEqual(s.owners, ["phone"]);
	assert.equal(s.calls.filter((call) => call.what === "admit").length, 1);
});

test("a late question answer marks the phone owner cause", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem({ status: "open" }) }, verdict: "no-wait" });
	t.after(s.cleanup);
	answerFile(s.home);

	await s.delivery.drain();

	assert.deepEqual(s.owners, ["phone"]);
});

test("a question answered through ask-user does not mark the phone cause", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem() } });
	t.after(s.cleanup);
	answerFile(s.home);

	await s.delivery.drain();

	assert.deepEqual(s.owners, []);
	assert.deepEqual(s.posts[0].body, { deliveryId: "d1", how: "bridge", detail: null });
});

test("a busy session gets a turn reply as a steer with the admission epoch", async (t) => {
	const s = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "turn", status: "open", raw: null } },
		ctx: { isIdle: () => false },
		pi: {
			session: {
				admissionGate: () => ({ can_admit: true, editor_revision: 2, turn_epoch: 7 }),
				admitExternalMessage: (request) => (s.calls.push({ what: "admit", request }), { kind: "steered" }),
			},
		},
	});
	t.after(s.cleanup);
	answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();

	assert.deepEqual(s.calls[0], {
		what: "admit",
		request: { delivery_id: "d1", text: "계속해", deliverAs: "steer", expected_turn_id: 7, sender: { kind: "external", platform: "omo-inbox" } },
	});
	assert.deepEqual(s.posts[0].body, { deliveryId: "d1", how: "message", detail: null });
});

test("an idle session gets a turn reply as a follow-up even with a gate", async (t) => {
	const s = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "turn", status: "open", raw: null } },
		ctx: { isIdle: () => true },
		pi: {
			session: {
				admissionGate: () => ({ turn_epoch: 7 }),
				admitExternalMessage: (request) => (s.calls.push({ what: "admit", request }), { kind: "started" }),
			},
		},
	});
	t.after(s.cleanup);
	answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();

	assert.equal(s.calls[0].request.deliverAs, "followUp");
	assert.equal("expected_turn_id" in s.calls[0].request, false);
});

test("a turn conflict keeps the file and retries as a follow-up once idle", async (t) => {
	let busy = true;
	const s = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "turn" } },
		ctx: { isIdle: () => !busy },
		pi: {
			session: {
				admissionGate: () => ({ turn_epoch: 9 }),
				admitExternalMessage: (request) => {
					s.calls.push({ what: "admit", request });
					return busy ? { kind: "turn_conflict" } : { kind: "started" };
				},
			},
		},
	});
	t.after(s.cleanup);
	const file = answerFile(s.home, { kind: "turn", payload: { text: "진행" } });

	assert.equal((await s.delivery.drain()).handled, 0);
	assert.equal(s.exists(file), true);
	assert.deepEqual(s.ids(), []);
	assert.deepEqual(s.posts, []);

	busy = false;
	assert.equal((await s.delivery.drain()).handled, 1);
	assert.equal(s.exists(file), false);
	assert.equal(s.calls[1].request.deliverAs, "followUp");
	assert.equal("expected_turn_id" in s.calls[1].request, false);
	assert.deepEqual(s.posts.map((post) => post.body.how), ["message"]);
});

test("turn replies are admitted as follow-ups and acked as message", async (t) => {
	const s = setup({ items: { [ITEM]: { itemId: ITEM, kind: "turn", status: "open", raw: null } } });
	t.after(s.cleanup);
	answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();

	assert.deepEqual(s.calls[0], {
		what: "admit",
		request: { delivery_id: "d1", text: "계속해", deliverAs: "followUp", sender: { kind: "external", platform: "omo-inbox" } },
	});
	assert.deepEqual(s.posts[0].body, { deliveryId: "d1", how: "message", detail: null });
});

test("queued and already admitted replies are acked too", async (t) => {
	for (const kind of ["queued", "already_admitted"]) {
		const s = setup({ admitKind: kind, items: { [ITEM]: { itemId: ITEM, kind: "turn" } } });
		t.after(s.cleanup);
		answerFile(s.home, { kind: "turn", payload: { text: "진행" } });

		await s.delivery.drain();

		assert.equal(s.posts[0].body.how, "message", kind);
	}
});

test("without admitExternalMessage the reply falls back to sendUserMessage with followUp", async (t) => {
	const sent = [];
	const s = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "turn" } },
		pi: { sendUserMessage: async (text, options) => sent.push({ text, options }) },
	});
	t.after(s.cleanup);
	const file = answerFile(s.home, { kind: "turn", payload: { text: "승인" } });

	await s.delivery.drain();

	assert.deepEqual(sent, [{ text: "승인", options: { deliverAs: "followUp" } }]);
	assert.equal(s.posts[0].body.how, "message");
	assert.equal(s.exists(file), false);
});

test("without an admission gate a busy fallback uses steer", async (t) => {
	const sent = [];
	const s = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "turn" } },
		ctx: { isIdle: () => false },
		pi: { sendUserMessage: async (text, options) => sent.push({ text, options }) },
	});
	t.after(s.cleanup);
	answerFile(s.home, { kind: "turn", payload: { text: "승인" } });

	await s.delivery.drain();

	assert.deepEqual(sent, [{ text: "승인", options: { deliverAs: "steer" } }]);
	assert.equal(s.posts[0].body.how, "message");
});

test("held_draft keeps the file, rolls the ledger back and retries next tick", async (t) => {
	let kind = "held_draft";
	const s = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "turn" } },
		pi: { session: { admitExternalMessage: (request) => (s.calls.push({ what: "admit", request }), { kind }) } },
	});
	t.after(s.cleanup);
	const file = answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	assert.equal((await s.delivery.drain()).handled, 0);
	assert.equal(s.exists(file), true);
	assert.deepEqual(s.ids(), []);
	assert.deepEqual(s.posts, []);

	kind = "queued";
	assert.equal((await s.delivery.drain()).handled, 1);
	assert.equal(s.exists(file), false);
	assert.deepEqual(s.posts.map((post) => post.body.how), ["message"]);
	assert.equal(s.calls.filter((call) => call.what === "admit").length, 2);
});

test("a file whose deliveryId is already in the ledger is re-acked with the recorded how", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem() } });
	t.after(s.cleanup);
	fs.mkdirSync(path.join(s.home, "ledger"), { recursive: true });
	fs.writeFileSync(ledgerFile(s.home), JSON.stringify({ v: 1, ids: ["d1"], how: { d1: "bridge" } }));
	const file = answerFile(s.home);

	await s.delivery.drain();

	assert.deepEqual(s.calls, []);
	assert.deepEqual(s.posts, [{ url: `/api/items/${ITEM}/delivered`, body: { deliveryId: "d1", how: "bridge", detail: null } }]);
	assert.equal(s.exists(file), false);
});

test("a ledger hit without a recorded how falls back to message", async (t) => {
	const s = setup({ items: { [ITEM]: { itemId: ITEM, kind: "turn" } } });
	t.after(s.cleanup);
	fs.mkdirSync(path.join(s.home, "ledger"), { recursive: true });
	fs.writeFileSync(ledgerFile(s.home), JSON.stringify({ v: 1, ids: ["d1"] }));
	const file = answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();

	assert.deepEqual(s.calls, []);
	assert.deepEqual(s.posts[0].body, { deliveryId: "d1", how: "message", detail: null });
	assert.equal(s.exists(file), false);
});

test("reload rebuilds the delivered set from the ledger and listAdmittedDeliveries", async (t) => {
	const s = setup({
		items: { [ITEM]: questionItem() },
		pi: { session: { listAdmittedDeliveries: () => ({ pending: [], emitted: [{ delivery_id: "d2" }] }) } },
	});
	t.after(s.cleanup);
	fs.mkdirSync(path.join(s.home, "ledger"), { recursive: true });
	fs.writeFileSync(ledgerFile(s.home), JSON.stringify({ v: 1, ids: ["d1"] }));
	const f1 = answerFile(s.home, { deliveryId: "d1" });
	const f2 = mailboxFile(s.home, `i-2-000002.json`, { v: 1, type: "item-answer", itemId: "i-2", kind: "turn", deliveryId: "d2", payload: { text: "x" } });

	await s.delivery.reload();
	await s.delivery.drain();

	assert.ok(s.delivery.deliveredIds().includes("d1"));
	assert.ok(s.delivery.deliveredIds().includes("d2"));
	assert.deepEqual(s.calls, []);
	assert.equal(s.exists(f1), false);
	assert.equal(s.exists(f2), false);
});

test("the ledger records the deliveryId before the bridge call runs", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem() } });
	t.after(s.cleanup);
	answerFile(s.home);

	await s.delivery.drain();

	const writeAt = s.trace.findIndex((entry) => entry.startsWith("write:"));
	const bridgeAt = s.trace.indexOf("bridge:question");
	assert.match(s.trace[writeAt], /^write:s1\.json\.tmp-/);
	assert.ok(writeAt >= 0, "the ledger was written");
	assert.ok(bridgeAt > writeAt, `ledger before bridge: ${JSON.stringify(s.trace)}`);
	assert.deepEqual(s.ids(), ["d1"]);
});

test("the ledger records the deliveryId before admit runs", async (t) => {
	const s = setup({ items: { [ITEM]: { itemId: ITEM, kind: "turn" } } });
	t.after(s.cleanup);
	answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();

	const writeAt = s.trace.findIndex((entry) => entry.startsWith("write:s1.json.tmp-"));
	const admitAt = s.trace.indexOf("admit");
	assert.ok(writeAt >= 0, `ledger written: ${JSON.stringify(s.trace)}`);
	assert.ok(admitAt > writeAt, `ledger before admit: ${JSON.stringify(s.trace)}`);
});

test("a failed delivered ack keeps the file and the next tick re-acks without applying twice", async (t) => {
	const s = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "turn" } },
		postFails: (posts) => posts.length === 1,
	});
	t.after(s.cleanup);
	const file = answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();

	assert.equal(s.exists(file), true);
	assert.equal(s.calls.filter((call) => call.what === "admit").length, 1);
	assert.ok(s.logs.some((line) => line.includes("ack failed")));

	await s.delivery.drain();

	assert.equal(s.calls.filter((call) => call.what === "admit").length, 1);
	assert.deepEqual(s.posts[1].body, { deliveryId: "d1", how: "message", detail: null });
	assert.equal(s.exists(file), false);
});

test("a re-ack that keeps failing keeps the file", async (t) => {
	const s = setup({ items: { [ITEM]: { itemId: ITEM, kind: "turn" } }, postFails: true });
	t.after(s.cleanup);
	const file = answerFile(s.home, { kind: "turn", payload: { text: "계속해" } });

	await s.delivery.drain();
	await s.delivery.drain();

	assert.equal(s.calls.filter((call) => call.what === "admit").length, 1);
	assert.equal(s.exists(file), true);
	assert.ok(s.logs.some((line) => line.includes("re-ack failed")));
});

test("explain runs the summarizer instead of a message", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	const file = mailboxFile(s.home, `${ITEM}-000003.json`, { v: 1, type: "explain", itemId: ITEM });

	await s.delivery.drain();

	assert.deepEqual(s.calls, [{ what: "explain", itemId: ITEM }]);
	assert.deepEqual(s.posts, []);
	assert.equal(s.exists(file), false);
});

test("board feedback is delegated to boardDeliver and deduped by proposal/seq", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	const payload = { v: 1, type: "board-feedback", proposalId: "p-1", seq: 4, title: "검토", url: "/p/p-1", approved: false, text: "여기를 고쳐 주세요" };
	const file = mailboxFile(s.home, "p-1-000004.json", payload);

	await s.delivery.drain();

	assert.equal(s.calls.length, 1);
	assert.equal(s.calls[0].what, "board");
	assert.equal(s.calls[0].payload.text, "여기를 고쳐 주세요");
	assert.equal(s.exists(file), false);

	mailboxFile(s.home, "p-1-000004.json", payload);
	await s.delivery.drain();
	assert.equal(s.calls.length, 1);
});

test("a missing type is read as board feedback", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	mailboxFile(s.home, "desk-000001.json", { v: 1, proposalId: "p-2", seq: 1, text: "보드 답" });

	await s.delivery.drain();

	assert.equal(s.calls[0].what, "board");
	assert.equal(s.calls[0].payload.proposalId, "p-2");
});

test("permission answers resolve the dialog, or are refused when it is gone", async (t) => {
	const resolved = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "permission", raw: { dialog: { id: "dg-1", title: "Permission required: shell", options: ["Allow once", "Deny"] } } } },
	});
	t.after(resolved.cleanup);
	const allow = mailboxFile(resolved.home, `${ITEM}-000001.json`, { v: 1, type: "item-answer", itemId: ITEM, kind: "permission", deliveryId: "d1", dialogId: "dg-1", payload: { choice: "Allow once" } });
	await resolved.delivery.drain();
	assert.deepEqual(resolved.calls[0], { what: "permission", dialogId: "dg-1", choice: "Allow once", feedbackText: null });
	assert.deepEqual(resolved.posts[0].body, { deliveryId: "d1", how: "bridge", detail: null });
	assert.equal(resolved.exists(allow), false);

	const refused = setup({
		items: { [ITEM]: { itemId: ITEM, kind: "permission", raw: { dialog: { id: "dg-1" } } } },
		permissionResolved: false,
	});
	t.after(refused.cleanup);
	mailboxFile(refused.home, `${ITEM}-000001.json`, { v: 1, type: "item-answer", itemId: ITEM, kind: "permission", deliveryId: "d1", dialogId: "dg-1", payload: { choice: "Deny" } });
	await refused.delivery.drain();
	assert.deepEqual(refused.posts[0].body, { deliveryId: "d1", how: "refused", detail: "dialog closed" });
	assert.deepEqual(refused.calls.filter((call) => call.what === "admit"), []);
});

test("an unparsable file is removed and logged", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	const dir = path.join(s.home, "mailbox", safeSegment(SID));
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "broken-000001.json");
	fs.writeFileSync(file, "{not json");

	await s.delivery.drain();

	assert.equal(s.exists(file), false);
	assert.ok(s.logs.some((line) => line.includes("unparsable")));
});

test("drain is single-flight", async (t) => {
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const s = setup({
		items: { [ITEM]: questionItem() },
		bridge: {
			resolveQuestion: async () => {
				s.calls.push({ what: "question" });
				await gate;
				return "resolved";
			},
		},
	});
	t.after(s.cleanup);
	answerFile(s.home);

	const first = s.delivery.drain();
	const second = s.delivery.drain();
	release();
	await Promise.all([first, second]);

	assert.equal(s.calls.filter((call) => call.what === "question").length, 1);
	assert.equal(s.posts.length, 1);
});

test("the session id can come from the context instead of deps", async (t) => {
	const s = setup({ sessionId: null, items: { [ITEM]: questionItem() }, ctx: { sessionManager: { getSessionId: () => SID } } });
	t.after(s.cleanup);
	answerFile(s.home);

	await s.delivery.drain();

	assert.equal(s.calls[0].what, "question");
	assert.deepEqual(s.posts[0].body.how, "bridge");
});

test("a close control is acked as control, applied once and removed", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	const file = controlFile(s.home);

	const result = await s.delivery.drain();

	assert.equal(result.handled, 1);
	assert.deepEqual(s.posts, [{ url: `/api/items/${ITEM}/delivered`, body: { deliveryId: "c1", how: "control", detail: "close" } }]);
	assert.deepEqual(s.controls, [{ action: "close", itemId: ITEM, deliveryId: "c1", producer: undefined, key: undefined }]);
	assert.equal(s.exists(file), false);
	assert.deepEqual(s.ids(), ["c1"]);
});

test("a ledgered control is re-acked with its recorded how and never applied again", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	fs.mkdirSync(path.join(s.home, "ledger"), { recursive: true });
	fs.writeFileSync(ledgerFile(s.home), JSON.stringify({ v: 1, ids: ["c1"], how: { c1: "control" } }));
	const file = controlFile(s.home);

	await s.delivery.drain();

	assert.deepEqual(s.controls, []);
	assert.deepEqual(s.posts, [{ url: `/api/items/${ITEM}/delivered`, body: { deliveryId: "c1", how: "control", detail: null } }]);
	assert.equal(s.exists(file), false);
});

test("a failed control ack keeps the file without a ledger entry, then applies exactly once", async (t) => {
	const s = setup({ postFails: (posts) => posts.length === 1 });
	t.after(s.cleanup);
	const file = controlFile(s.home);

	assert.equal((await s.delivery.drain()).handled, 0);
	assert.equal(s.exists(file), true);
	assert.deepEqual(s.ids(), []);
	assert.deepEqual(s.controls, []);
	assert.ok(s.logs.some((line) => line.includes("ack failed")));

	assert.equal((await s.delivery.drain()).handled, 1);
	assert.equal(s.exists(file), false);
	assert.deepEqual(s.ids(), ["c1"]);
	assert.equal(s.controls.length, 1);
	assert.deepEqual(s.posts.map((post) => post.body), [
		{ deliveryId: "c1", how: "control", detail: "close" },
		{ deliveryId: "c1", how: "control", detail: "close" },
	]);
});

test("a stale control is dropped without applying it", async (t) => {
	const now = Date.parse("2026-10-24T12:00:00.000Z");
	const s = setup({ now: () => now });
	t.after(s.cleanup);
	const file = controlFile(s.home, { issuedAt: new Date(now - 11 * 60_000).toISOString() });

	await s.delivery.drain();

	assert.deepEqual(s.controls, []);
	assert.deepEqual(s.posts, [{ url: `/api/items/${ITEM}/delivered`, body: { deliveryId: "c1", how: "dropped", detail: "stale" } }]);
	assert.equal(s.exists(file), false);
	assert.deepEqual(s.ids(), []);
});

test("a control for a closed item is dropped as item closed", async (t) => {
	const s = setup({ items: { [ITEM]: { itemId: ITEM, kind: "turn", status: "closed" } } });
	t.after(s.cleanup);
	const file = controlFile(s.home, { action: "run" });

	await s.delivery.drain();

	assert.deepEqual(s.controls, []);
	assert.deepEqual(s.posts, [{ url: `/api/items/${ITEM}/delivered`, body: { deliveryId: "c1", how: "dropped", detail: "item closed" } }]);
	assert.equal(s.exists(file), false);
});

test("a control with a bad action is removed with a note", async (t) => {
	const s = setup({});
	t.after(s.cleanup);
	const file = controlFile(s.home, { action: "explode" });

	await s.delivery.drain();

	assert.equal(s.exists(file), false);
	assert.deepEqual(s.controls, []);
	assert.deepEqual(s.posts, []);
	assert.ok(s.logs.some((line) => line.includes("bad session-control")));
});

test("a run control passes producer/key and marks the owner before applying", async (t) => {
	const s = setup({ items: { [ITEM]: { itemId: ITEM, kind: "turn", status: "open" } } });
	t.after(s.cleanup);
	const file = controlFile(s.home, { action: "run", producer: "p1", key: "k1" });

	await s.delivery.drain();

	assert.deepEqual(s.controls, [{ action: "run", itemId: ITEM, deliveryId: "c1", producer: "p1", key: "k1" }]);
	assert.deepEqual(s.owners, ["phone"]);
	assert.ok(s.trace.indexOf("owner:phone") < s.trace.indexOf("control:run"), `owner before control: ${JSON.stringify(s.trace)}`);
	assert.equal(s.exists(file), false);
});

test("mailbox answers are still delivered alongside controls", async (t) => {
	const s = setup({ items: { [ITEM]: questionItem() } });
	t.after(s.cleanup);
	const answer = answerFile(s.home);
	const control = controlFile(s.home);

	const result = await s.delivery.drain();

	assert.equal(result.handled, 2);
	assert.equal(s.exists(answer), false);
	assert.equal(s.exists(control), false);
	assert.deepEqual(s.posts.map((post) => post.body.how), ["bridge", "control"]);
	assert.equal(s.controls.length, 1);
});
