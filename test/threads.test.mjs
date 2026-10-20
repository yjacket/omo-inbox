import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTmpHome } from "./helpers/tmp-home.mjs";
import { createThreads, statusOfItem } from "../src/threads.mjs";
import { safeSegment } from "../src/paths.mjs";

const SID = "s1";
const SID2 = "s2";
const SUPERSEDED = ["turn", "blocked", "done", "progress", "board"];
const KEPT = ["question", "permission", "notice"];

function clock(startMs = Date.parse("2026-10-04T12:00:00.000Z")) {
	let step = 0;
	return () => new Date(startMs + step++ * 60_000);
}

function counter() {
	let n = 0;
	return (len) => {
		n++;
		return n.toString(36).padStart(len, "0").slice(-len);
	};
}

function setup({ now = clock(), ...options } = {}) {
	const { home, cleanup } = makeTmpHome();
	const live = new Set();
	const recent = new Set();
	const threads = createThreads({
		home,
		now,
		randomId: counter(),
		isLive: (sid) => live.has(sid),
		isRecent: (sid) => recent.has(sid),
		...options,
	});
	return {
		home,
		cleanup,
		threads,
		restart: (extra = {}) => createThreads({ home, now, isLive: (sid) => live.has(sid), isRecent: (sid) => recent.has(sid), ...options, ...extra }),
		setLive: (sid, value) => (value ? live.add(sid) : live.delete(sid)),
		setRecent: (sid, value) => (value ? recent.add(sid) : recent.delete(sid)),
	};
}

function codeOf(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return null;
}

function mailboxDir(home, sid) {
	return path.join(home, "mailbox", safeSegment(sid));
}

function eventFiles(home, sid) {
	return fs.readdirSync(path.join(home, "data", "threads", safeSegment(sid), "events")).sort();
}

test("dedupe returns created:false for an open item with the same key", () => {
	const { home, cleanup, threads } = setup();
	try {
		const first = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:0" });
		assert.equal(first.created, true);
		const again = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:0" });
		assert.equal(again.created, false);
		assert.equal(again.item.itemId, first.item.itemId);
		assert.equal(threads.getThread(SID).items.length, 1);
		assert.equal(eventFiles(home, SID).filter((name) => name.endsWith("-item.json")).length, 1);
		assert.equal(codeOf(() => threads.createItem(SID, { policy: "needs-you" })).code, "bad_input");
	} finally {
		cleanup();
	}
});

test("activity supersedes turn/blocked/done/progress/board but never question, permission or notice", () => {
	const { cleanup, threads } = setup();
	try {
		const kinds = [...SUPERSEDED, ...KEPT];
		const ids = kinds.map((kind) => threads.createItem(SID, { kind, policy: "needs-you" }).item.itemId);
		const result = threads.activity(SID, "agent-start");
		assert.equal(result.superseded, SUPERSEDED.length);
		kinds.forEach((kind, index) => {
			const item = threads.getItem(ids[index]);
			if (SUPERSEDED.includes(kind)) {
				assert.equal(item.status, "closed", `${kind} should be superseded`);
				assert.equal(item.closedReason, "superseded");
			} else {
				assert.equal(item.status, "open", `${kind} should stay open`);
			}
		});
		assert.equal(threads.activity(SID, "terminal-input").superseded, 0);
		assert.equal(threads.activity(SID, "agent-start").superseded, 0);
	} finally {
		cleanup();
	}
});

test("answer on a closed item throws code closed with its reason", () => {
	const { cleanup, threads } = setup();
	try {
		const id = threads.createItem(SID, { kind: "turn", policy: "needs-you" }).item.itemId;
		threads.close(id, "superseded", null);
		const error = codeOf(() => threads.answer(id, { text: "hello" }));
		assert.ok(error);
		assert.equal(error.code, "closed");
		assert.equal(error.reason, "superseded");
		assert.equal(codeOf(() => threads.answer("i-000000-zzzzzz", {})).code, "not_found");
		assert.equal(codeOf(() => threads.getItem("i-000000-zzzzzz")).code, "not_found");
	} finally {
		cleanup();
	}
});

test("item status walks open -> answered -> delivered, and derived statusOfItem agrees", () => {
	const { cleanup, threads } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "turn", policy: "needs-you" });
		assert.equal(item.status, "open");
		const sent = threads.answer(item.itemId, { text: "go" });
		assert.equal(threads.getItem(item.itemId).status, "answered");
		assert.deepEqual(threads.getItem(item.itemId).deliveredIds, []);
		threads.delivered(item.itemId, sent.deliveryId, "message");
		assert.equal(threads.getItem(item.itemId).status, "delivered");
		assert.deepEqual(threads.getItem(item.itemId).deliveredIds, [sent.deliveryId]);

		const itemEvents = threads.getThread(SID).events.filter((event) => event.type === "item" || event.itemId === item.itemId);
		assert.equal(statusOfItem(itemEvents), "delivered");

		const stale = [{ type: "item", itemId: "x", kind: "question", createdAt: "2026-10-04T12:00:00.000Z" }];
		assert.equal(statusOfItem(stale, new Date("2026-10-05T11:00:00.000Z")), "open");
		assert.equal(statusOfItem(stale, new Date("2026-10-05T12:00:00.000Z")), "closed");
		assert.equal(statusOfItem([...stale, { type: "closed", itemId: "x", reason: "cancelled" }]), "closed");
	} finally {
		cleanup();
	}
});

test("question items older than 24 h are reported closed with reason expired", () => {
	const { cleanup, threads, restart } = setup();
	try {
		const question = threads.createItem(SID, { kind: "question", policy: "needs-you" }).item;
		assert.equal(threads.getItem(question.itemId).status, "open");
		const later = restart({ now: () => new Date(Date.parse(question.createdAt) + 25 * 60 * 60 * 1000) });
		const aged = later.getItem(question.itemId);
		assert.equal(aged.status, "closed");
		assert.equal(aged.closedReason, "expired");
		assert.equal(later.list()[0].status, "ended");
		assert.equal(codeOf(() => later.answer(question.itemId, { text: "late" })).code, "closed");
	} finally {
		cleanup();
	}
});

test("list sorts needs-you first (oldest waiting first), then working, then ended, with counts", () => {
	const { cleanup, threads, setLive } = setup();
	try {
		threads.setMeta("old", { firstRequest: "old request" });
		const old = threads.createItem("old", { kind: "question", policy: "needs-you" }).item;
		threads.addSummary(old.itemId, { headline: "질문", context: "", body: "기다립니다", ask: null });

		threads.setMeta("new", { firstRequest: "new request" });
		threads.createItem("new", { kind: "question", policy: "needs-you" });

		threads.setMeta("busy", { firstRequest: "busy request" });
		setLive("busy", true);
		threads.createItem("busy", { kind: "progress", policy: "progress" });

		threads.setMeta("gone", { firstRequest: "gone request" });
		threads.createItem("gone", { kind: "turn", policy: "quiet" });

		const rows = threads.list();
		assert.deepEqual(rows.map((row) => row.session), ["old", "new", "busy", "gone"]);
		assert.deepEqual(rows.map((row) => row.status), ["needs-you", "needs-you", "working", "ended"]);
		assert.equal(rows[0].title, "요청: old request");
		assert.equal(rows[0].newest.kind, "question");
		assert.equal(rows[0].newest.itemId, threads.getThread("old").items[0].itemId);
		assert.ok(rows[0].waitingSince < rows[1].waitingSince);
		assert.deepEqual(threads.counts(), { needsYou: 2, working: 1, ended: 1, hidden: 0 });
		assert.equal(threads.list({ status: "needs-you" }).length, 2);
		assert.equal(threads.list({ status: "working" })[0].session, "busy");
		assert.equal(threads.list({ status: "ended" }).length, 1);
		assert.equal(codeOf(() => threads.list({ status: "bogus" })).code, "bad_input");

		threads.setMeta("busy", { title: "바쁜 세션", titleSource: "summary" });
		assert.equal(threads.list({ status: "working" })[0].title, "바쁜 세션");
	} finally {
		cleanup();
	}
});

test("thread status uses liveness and whether open items still ask", () => {
	const { cleanup, threads, setLive, setRecent } = setup();
	try {
		const liveFyi = threads.createItem("live-fyi", { kind: "turn", policy: "needs-you" }).item;
		setLive("live-fyi", true);
		threads.addSummary(liveFyi.itemId, { headline: "보고", context: "", body: "끝", ask: null });
		assert.equal(threads.list().find((row) => row.session === "live-fyi").status, "needs-you");
		assert.equal(threads.list().find((row) => row.session === "live-fyi").off, false);
		setLive("live-fyi", false);
		assert.equal(threads.list().find((row) => row.session === "live-fyi").status, "ended");
		assert.equal(threads.counts().needsYou, 0);

		const asked = threads.createItem("asked", { kind: "turn", policy: "needs-you" }).item;
		threads.addSummary(asked.itemId, { headline: "작업", context: "", body: "완료", ask: "폴더를 직접 지워 주세요" });
		assert.equal(threads.list().find((row) => row.session === "asked").status, "needs-you");
		assert.equal(threads.list().find((row) => row.session === "asked").off, true);

		threads.createItem("question", { kind: "question", policy: "needs-you" });
		assert.equal(threads.list().find((row) => row.session === "question").status, "needs-you");
		assert.equal(threads.list().find((row) => row.session === "question").off, true);

		threads.createItem("_notices", { kind: "notice", policy: "needs-you" });
		assert.equal(threads.getThread("_notices").thread.status, "needs-you");
		assert.equal(threads.getThread("_notices").thread.off, false);

		const recentFyi = threads.createItem("recent-fyi", { kind: "turn", policy: "needs-you" }).item;
		setRecent("recent-fyi", true);
		const recentRow = threads.list().find((row) => row.session === "recent-fyi");
		assert.equal(recentRow.status, "needs-you");
		assert.equal(recentRow.live, true);
		assert.equal(recentRow.off, false);
		threads.close(recentFyi.itemId, "superseded");
		assert.equal(threads.list().find((row) => row.session === "recent-fyi").status, "working");
	} finally {
		cleanup();
	}
});

test("stalled finals and legacy final text remain needs-you when the session is off", () => {
	const { cleanup, threads } = setup();
	try {
		const stalled = threads.createItem("stalled", {
			kind: "turn",
			policy: "needs-you",
			raw: { final: "완료" },
			meta: { stalled: true },
		}).item;
		threads.addSummary(stalled.itemId, { headline: "완료", context: "", body: "완료", ask: null });
		assert.equal(threads.list().find((row) => row.session === "stalled").status, "needs-you");
		assert.equal(threads.list().find((row) => row.session === "stalled").off, true);

		const stalledEpisode = threads.createItem("stalled-episode", {
			kind: "turn",
			policy: "needs-you",
			raw: { final: "완료" },
			meta: { episode: { closeReason: "stalled" } },
		}).item;
		threads.addSummary(stalledEpisode.itemId, { headline: "완료", context: "", body: "완료", ask: null });
		assert.equal(threads.list().find((row) => row.session === "stalled-episode").status, "needs-you");
		assert.equal(threads.list().find((row) => row.session === "stalled-episode").off, true);

		const todo = threads.createItem("legacy-todo", {
			kind: "turn",
			policy: "needs-you",
			raw: { final: "…남은 폴더 정리는 다른 세션을 닫은 뒤 직접 실행해야 해요." },
		}).item;
		// a model summary from before ask carried to-dos: the to-do sits in its headline, ask is null
		threads.addSummary(todo.itemId, { headline: "폴더 정리는 다른 세션 닫은 뒤 직접 실행해야 해요", context: "", body: "이름 바꾸기는 세션을 닫은 뒤 실행하면 됩니다.", ask: null });
		assert.equal(threads.list().find((row) => row.session === "legacy-todo").status, "needs-you");
		assert.equal(threads.list().find((row) => row.session === "legacy-todo").off, true);

		// a model summary that says the work is done wins over a stray "?" or advice at the end of the raw text
		const doneReport = threads.createItem("model-done", {
			kind: "done",
			policy: "needs-you",
			raw: { final: "릴리스 초안을 썼습니다. 거기서 `git add -A`는 피하셔야 합니다. 링크: https://example.test/a?b=1" },
		}).item;
		threads.addSummary(doneReport.itemId, { headline: "릴리스 초안과 개발 사이트 준비 완료", context: "", body: "릴리스 노트 두 벌을 쓰고 개발 사이트를 띄웠습니다.", ask: null });
		assert.equal(threads.list().find((row) => row.session === "model-done").status, "ended");

		// without a model summary, the end of the final text decides
		const heuristicTodo = threads.createItem("heuristic-todo", {
			kind: "turn",
			policy: "needs-you",
			raw: { final: "정리했습니다. 남은 폴더는 직접 지워 주세요." },
		}).item;
		threads.addSummary(heuristicTodo.itemId, { headline: "정리했습니다", context: "", body: "", ask: null }, "heuristic");
		assert.equal(threads.list().find((row) => row.session === "heuristic-todo").status, "needs-you");

		const fyi = threads.createItem("legacy-fyi", { kind: "turn", policy: "needs-you", raw: { text: "두 작업 모두 끝났습니다." } }).item;
		threads.addSummary(fyi.itemId, { headline: "완료", context: "", body: "완료", ask: null });
		assert.equal(threads.list().find((row) => row.session === "legacy-fyi").status, "ended");
	} finally {
		cleanup();
	}
});

test("hidden and sessionFile metadata persist across a rebuild", () => {
	const { cleanup, threads, restart } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "question", policy: "needs-you" });
		threads.setMeta(SID, { hidden: true, sessionFile: "C:/x/s.jsonl" });
		const row = threads.list().find((entry) => entry.session === SID);
		assert.equal(row.hidden, true);
		assert.equal(threads.counts().hidden, 1);
		assert.equal(threads.counts().needsYou, 0);
		assert.equal(restart().list().find((entry) => entry.session === SID).hidden, true);
		assert.equal(restart().getThread(SID).thread.sessionFile, "C:/x/s.jsonl");
		assert.ok(item.itemId);
	} finally {
		cleanup();
	}
});

test("ended rows sort newest first", () => {
	const { cleanup, threads } = setup();
	try {
		threads.createItem(SID, { kind: "turn", policy: "quiet" });
		threads.createItem(SID2, { kind: "turn", policy: "quiet" });
		assert.deepEqual(threads.list().map((row) => row.session), [SID2, SID]);
	} finally {
		cleanup();
	}
});

test("unread counts only new non-progress items and clears after markRead", () => {
	const { cleanup, threads, restart } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "turn", policy: "needs-you" });
		assert.equal(threads.list()[0].unread, 1);
		threads.markRead(SID, 1);
		assert.equal(threads.list()[0].unread, 0);

		// Machine events never make a read thread unread again.
		threads.answer(item.itemId, { text: "ok" });
		threads.addSummary(item.itemId, { headline: "요약", context: "맥락", body: "본문" });
		threads.activity(SID, "agent-start");
		threads.cache(SID, 1770000000000, 300);
		assert.equal(threads.list()[0].unread, 0);
		assert.equal(restart().list()[0].unread, 0);

		// A progress item is not a messenger message either.
		threads.createItem(SID, { kind: "progress", policy: "progress" });
		assert.equal(threads.list()[0].unread, 0);

		// A new item is unread until the next read marker.
		threads.createItem(SID, { kind: "blocked", policy: "needs-you" });
		assert.equal(threads.list()[0].unread, 1);
		threads.markRead(SID, 99);
		assert.equal(threads.list()[0].unread, 0);
	} finally {
		cleanup();
	}
});

test("answer writes the mailbox file at the C5 path with its content", () => {
	const { home, cleanup, threads } = setup();
	try {
		const { item } = threads.createItem(SID, {
			kind: "question",
			policy: "needs-you",
			raw: { request: { requestId: "r-1", questions: [] } },
		});
		const sent = threads.answer(item.itemId, { answers: { q1: { selected: ["A"] } } }, { via: "phone", client: "127.0.0.1", ua: "ua", deliveryId: "d-1" });
		const expected = path.join(mailboxDir(home, SID), `${item.itemId}-${String(sent.seq).padStart(6, "0")}.json`);
		assert.equal(sent.mailbox, expected);
		const payload = JSON.parse(fs.readFileSync(expected, "utf8"));
		assert.equal(payload.v, 1);
		assert.equal(payload.type, "item-answer");
		assert.equal(payload.itemId, item.itemId);
		assert.equal(payload.kind, "question");
		assert.equal(payload.deliveryId, "d-1");
		assert.equal(payload.requestId, "r-1");
		assert.deepEqual(payload.payload, { answers: { q1: { selected: ["A"] } } });
		assert.equal(payload.text, null);
		assert.equal(threads.getItem(item.itemId).answers[0].via, "phone");
		assert.equal(threads.getItem(item.itemId).answers[0].ua, "ua");

		const explain = threads.writeAnswerMailbox(item.itemId, null, { type: "explain" });
		assert.deepEqual(JSON.parse(fs.readFileSync(explain, "utf8")), { v: 1, type: "explain", itemId: item.itemId });
		const again = threads.writeAnswerMailbox(item.itemId, null, { type: "explain" });
		assert.notEqual(again, explain, "two explains get distinct mailbox files");
		assert.deepEqual(JSON.parse(fs.readFileSync(again, "utf8")), { v: 1, type: "explain", itemId: item.itemId });
	} finally {
		cleanup();
	}
});

test("an identical resend reuses the undelivered answer's deliveryId; a different payload does not", () => {
	const { home, cleanup, threads } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "turn", policy: "needs-you" });
		const first = threads.answer(item.itemId, { text: "계속해" });
		const again = threads.answer(item.itemId, { text: "계속해" });
		assert.equal(again.deliveryId, first.deliveryId);
		assert.equal(again.seq, first.seq);
		assert.equal(again.mailbox, first.mailbox);
		assert.equal(again.reused, true);
		assert.equal(threads.getItem(item.itemId).answers.length, 1, "no duplicate answer event");
		assert.equal(fs.readdirSync(mailboxDir(home, SID)).filter((name) => name.endsWith(".json")).length, 1);

		const different = threads.answer(item.itemId, { text: "멈춰" });
		assert.notEqual(different.deliveryId, first.deliveryId);
		assert.equal(threads.getItem(item.itemId).answers.length, 2);

		// Once the session acked it, an identical payload is a genuinely new answer.
		threads.delivered(item.itemId, first.deliveryId, "message");
		threads.delivered(item.itemId, different.deliveryId, "message");
		const afterAck = threads.answer(item.itemId, { text: "계속해" });
		assert.notEqual(afterAck.deliveryId, first.deliveryId);
	} finally {
		cleanup();
	}
});

test("permission answers carry the dialog id and the comment becomes the text", () => {
	const { home, cleanup, threads } = setup();
	try {
		const permission = threads.createItem(SID, { kind: "permission", policy: "needs-you", raw: { dialog: { id: "dg-1", title: "t", options: [] } } }).item;
		const sent = threads.answer(permission.itemId, { choice: "Allow once" }, { deliveryId: "d-2" });
		const file = path.join(mailboxDir(home, SID), `${permission.itemId}-${String(sent.seq).padStart(6, "0")}.json`);
		const payload = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(payload.dialogId, "dg-1");
		assert.equal(payload.kind, "permission");
		assert.deepEqual(payload.payload, { choice: "Allow once" });

		const question = threads.createItem(SID2, { kind: "question", policy: "needs-you" }).item;
		const withText = threads.answer(question.itemId, { comment: "다시 해 주세요" });
		const text = JSON.parse(fs.readFileSync(path.join(mailboxDir(home, SID2), `${question.itemId}-${String(withText.seq).padStart(6, "0")}.json`), "utf8"));
		assert.equal(text.text, "다시 해 주세요");
		assert.equal(text.requestId, undefined);
	} finally {
		cleanup();
	}
});

test("a new store instance rebuilds items, summaries, answers, cache and read state from disk", () => {
	const { cleanup, threads, restart, setLive } = setup();
	try {
		threads.setMeta(SID, { cwd: "C:/dev/x", firstRequest: "do the thing", product: "omo-inbox", branch: "main" });
		const { item } = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:0" });
		threads.addSummary(item.itemId, { headline: "요약", context: "맥락", body: "본문", title: "제목" }, "model", "cheap-model", false);
		const sent = threads.answer(item.itemId, { text: "go" });
		threads.delivered(item.itemId, sent.deliveryId, "message", null);
		threads.bridge(item.itemId, "live");
		threads.cache(SID, 1770000000000, 300);
		threads.markRead(SID, threads.getThread(SID).events.at(-1).seq);
		setLive(SID, true);

		const restarted = restart();
		const thread = restarted.getThread(SID);
		assert.equal(thread.thread.title, "제목");
		assert.equal(thread.thread.titleSource, "summary");
		assert.equal(thread.thread.cwd, "C:/dev/x");
		assert.equal(thread.thread.product, "omo-inbox");
		assert.equal(thread.thread.status, "working");
		assert.equal(thread.thread.cacheUntil, 1770000000000);
		assert.equal(thread.items.length, 1);
		assert.equal(thread.items[0].status, "delivered");
		assert.equal(thread.items[0].bridge, "live");
		assert.equal(thread.items[0].summary.summary.headline, "요약");
		assert.equal(thread.items[0].summary.model, "cheap-model");
		assert.equal(thread.items[0].answers.length, 1);
		assert.equal(restarted.list()[0].unread, 0);
		assert.equal(restarted.list()[0].title, "제목");
		assert.equal(restarted.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:0" }).created, false);
		assert.equal(restarted.getThread(SID, 1e9).events.length, 0);
		assert.ok(restarted.getThread(SID, 0).events.length > 0);
		assert.equal(restarted.counts().working, 1);
	} finally {
		cleanup();
	}
});

test("a corrupt event file is skipped by the rebuild with no throw", () => {
	const { home, cleanup, threads, restart } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "turn", policy: "needs-you" });
		const dir = path.join(home, "data", "threads", safeSegment(SID), "events");
		fs.writeFileSync(path.join(dir, "999999-broken.json"), "{ this is not json");
		fs.writeFileSync(path.join(dir, "999998-half.json.tmp-1-abcd"), "{}");
		let restarted;
		assert.doesNotThrow(() => {
			restarted = restart();
		});
		assert.equal(restarted.getItem(item.itemId).status, "open");
		assert.equal(restarted.activity(SID, "agent-start").superseded, 1);
		assert.equal(threads.activity(SID, "agent-start").superseded, 1);
	} finally {
		cleanup();
	}
});

test("notice dedupe supersedes the previous open notice and keeps the new one open", () => {
	const { cleanup, threads } = setup();
	try {
		const first = threads.createItem("_notices", { kind: "notice", policy: "fyi", dedupeKey: "health:x" });
		assert.equal(first.created, true);
		assert.equal(threads.getThread("_notices").thread.title, "알림");
		assert.equal(threads.createItem("_notices", { kind: "notice", policy: "fyi", dedupeKey: "health:y" }).created, true);
		const second = threads.createItem("_notices", { kind: "notice", policy: "fyi", dedupeKey: "health:x" });
		assert.equal(second.created, true);
		assert.notEqual(second.item.itemId, first.item.itemId);
		assert.equal(threads.getItem(first.item.itemId).status, "closed");
		assert.equal(threads.getItem(first.item.itemId).closedReason, "superseded");
		assert.equal(threads.getItem(second.item.itemId).status, "open");
		assert.equal(threads.getThread("_notices").items.length, 3);
	} finally {
		cleanup();
	}
});

test("bridge state and dropped deliveries are reported on the item", () => {
	const { cleanup, threads } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "question", policy: "needs-you" });
		assert.equal(item.bridge, null);
		threads.bridge(item.itemId, "live");
		assert.equal(threads.getItem(item.itemId).bridge, "live");
		threads.bridge(item.itemId, "detached");
		assert.equal(threads.getItem(item.itemId).bridge, "detached");
		const sent = threads.answer(item.itemId, { comment: "ok" });
		const updated = threads.delivered(item.itemId, sent.deliveryId, "dropped", "terminal won");
		assert.equal(updated.status, "delivered");
		assert.deepEqual(updated.deliveredIds, [sent.deliveryId]);
	} finally {
		cleanup();
	}
});

test("a closed turn:/line:/episode: key re-post returns the same item, created:false", () => {
	const { home, cleanup, threads } = setup();
	try {
		const turn = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:0" });
		threads.close(turn.item.itemId, "superseded");
		const turnAgain = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:0" });
		assert.equal(turnAgain.created, false);
		assert.equal(turnAgain.item.itemId, turn.item.itemId);
		assert.equal(turnAgain.item.status, "closed");

		const line = threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1" });
		threads.close(line.item.itemId, "session-closed");
		const lineAgain = threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1" });
		assert.equal(lineAgain.created, false);
		assert.equal(lineAgain.item.itemId, line.item.itemId);

		const final = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "episode:s1:e1:done:m1", meta: { episode: { key: "e:s1:1" } } });
		threads.close(final.item.itemId, "superseded");
		const finalAgain = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "episode:s1:e1:done:m1" });
		assert.equal(finalAgain.created, false);
		assert.equal(finalAgain.item.itemId, final.item.itemId);

		assert.equal(threads.getThread(SID).items.length, 3);
		assert.equal(eventFiles(home, SID).filter((name) => name.endsWith("-item.json")).length, 3);
	} finally {
		cleanup();
	}
});

test("a notice re-posted after its item closed still creates a new item", () => {
	const { cleanup, threads } = setup();
	try {
		const first = threads.createItem("_notices", { kind: "notice", policy: "fyi", dedupeKey: "health:x" });
		threads.close(first.item.itemId, "expired");
		const second = threads.createItem("_notices", { kind: "notice", policy: "fyi", dedupeKey: "health:x" });
		assert.equal(second.created, true);
		assert.notEqual(second.item.itemId, first.item.itemId);
		assert.equal(threads.getItem(first.item.itemId).status, "closed");
		assert.equal(threads.getItem(second.item.itemId).status, "open");
		assert.equal(threads.getThread("_notices").items.length, 2);
	} finally {
		cleanup();
	}
});

test("agent-start supersedes lines and finals, keeps questions, and the closed keys stay deduped", () => {
	const { cleanup, threads } = setup();
	try {
		const line = threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1", meta: { episode: { key: "e:s1:1" } } });
		const final = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "episode:s1:e1:done:m1", meta: { episode: { key: "e:s1:1" } } });
		const question = threads.createItem(SID, { kind: "question", policy: "needs-you" });
		assert.equal(threads.activity(SID, "agent-start").superseded, 2);
		assert.equal(threads.getItem(line.item.itemId).closedReason, "superseded");
		assert.equal(threads.getItem(final.item.itemId).closedReason, "superseded");
		assert.equal(threads.getItem(question.item.itemId).status, "open");
		assert.equal(threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1" }).created, false);
		assert.equal(threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "episode:s1:e1:done:m1" }).created, false);
	} finally {
		cleanup();
	}
});

test("closeSession closes an open line as session-closed", () => {
	const { cleanup, threads } = setup();
	try {
		const line = threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1" });
		const question = threads.createItem(SID, { kind: "question", policy: "needs-you" });
		assert.equal(threads.closeSession(SID), 2);
		assert.equal(threads.getItem(line.item.itemId).status, "closed");
		assert.equal(threads.getItem(line.item.itemId).closedReason, "session-closed");
		assert.equal(threads.getItem(question.item.itemId).closedReason, "session-closed");
		assert.equal(threads.closeSession(SID), 0);
	} finally {
		cleanup();
	}
});

test("unread counts ignore progress lines, including before any read marker", () => {
	const { cleanup, threads } = setup();
	try {
		threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1" });
		threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m2" });
		assert.equal(threads.list()[0].unread, 0);
		threads.createItem(SID, { kind: "turn", policy: "needs-you" });
		assert.equal(threads.list()[0].unread, 1);
	} finally {
		cleanup();
	}
});

test("episodeItems returns every status in createdAt order", () => {
	const { cleanup, threads } = setup();
	try {
		const first = threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1", meta: { episode: { key: "e:s1:1", seq: 1 } } });
		threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m9", meta: { episode: { key: "e:s1:2" } } });
		const closed = threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m2", meta: { episode: { key: "e:s1:1", seq: 2 } } });
		threads.close(closed.item.itemId, "superseded");
		const final = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "episode:s1:e1:done:m3", meta: { episode: { key: "e:s1:1", closeReason: "done" } } });
		const items = threads.episodeItems(SID, "e:s1:1");
		assert.deepEqual(items.map((item) => item.itemId), [first.item.itemId, closed.item.itemId, final.item.itemId]);
		assert.deepEqual(items.map((item) => item.status), ["open", "closed", "open"]);
		assert.deepEqual(threads.episodeItems(SID, "missing"), []);
	} finally {
		cleanup();
	}
});

test("state events surface on the item, latest wins, and survive a restart", () => {
	const { cleanup, threads, restart } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "progress", policy: "progress", dedupeKey: "line:s1:m1" });
		assert.equal(item.state, null);
		threads.setItemState(item.itemId, { state: "waiting", reasons: ["terminal-monitors"], boards: [{ id: "b1", title: "보드", url: "https://example.test/b" }] });
		const waiting = threads.getItem(item.itemId);
		assert.deepEqual(waiting.state, { state: "waiting", reasons: ["terminal-monitors"], boards: [{ id: "b1", title: "보드", url: "https://example.test/b" }] });
		threads.setItemState(item.itemId, { state: "resumed" });
		assert.deepEqual(threads.getItem(item.itemId).state, { state: "resumed", reasons: [], boards: [] });
		assert.deepEqual(restart().getItem(item.itemId).state, { state: "resumed", reasons: [], boards: [] });
		assert.ok(threads.getThread(SID).events.some((event) => event.type === "state" && event.itemId === item.itemId));
	} finally {
		cleanup();
	}
});

test("activity stores its cause (default owner) and the cause survives a restart", () => {
	const { cleanup, threads, restart } = setup();
	try {
		threads.activity(SID, "agent-start");
		threads.activity(SID, "agent-start", "system");
		const activities = threads.getThread(SID).events.filter((event) => event.type === "activity");
		assert.deepEqual(activities.map((event) => event.cause), ["owner", "system"]);
		const restarted = restart().getThread(SID).events.filter((event) => event.type === "activity");
		assert.deepEqual(restarted.map((event) => event.cause), ["owner", "system"]);
	} finally {
		cleanup();
	}
});

test("markPushed records pushedAt and survives a restart", () => {
	const { cleanup, threads, restart } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:0" });
		assert.equal(item.pushedAt, null);
		threads.markPushed(item.itemId, "2026-10-04T12:00:00.000Z");
		assert.equal(threads.getItem(item.itemId).pushedAt, "2026-10-04T12:00:00.000Z");
		threads.markPushed(item.itemId, Date.parse("2026-10-04T12:01:00.000Z"));
		assert.equal(threads.getItem(item.itemId).pushedAt, "2026-10-04T12:01:00.000Z");
		assert.equal(restart().getItem(item.itemId).pushedAt, "2026-10-04T12:01:00.000Z");
		assert.ok(threads.getThread(SID).events.some((event) => event.type === "pushed" && event.itemId === item.itemId));
	} finally {
		cleanup();
	}
});

test("markPushed with suppressed sets pushSuppressed on the item and keeps pushedAt", () => {
	const { cleanup, threads } = setup();
	try {
		const { item } = threads.createItem(SID, { kind: "turn", policy: "needs-you", dedupeKey: "turn:s1:1:7" });
		assert.equal(threads.getItem(item.itemId).pushSuppressed, undefined);
		threads.markPushed(item.itemId, undefined, { suppressed: true });
		const view = threads.getItem(item.itemId);
		assert.equal(view.pushSuppressed, true);
		assert.ok(view.pushedAt);
	} finally {
		cleanup();
	}
});

test("every write is atomic: only parsable json files remain, with no tmp suffix", () => {
	const { home, cleanup, threads } = setup();
	try {
		threads.createItem(SID, { kind: "turn", policy: "needs-you" });
		threads.setMeta(SID, { title: "T", ended: null });
		threads.cache(SID, 1, 2);
		const dir = path.join(home, "data", "threads", safeSegment(SID));
		const files = [...eventFiles(home, SID).map((name) => path.join(dir, "events", name)), path.join(dir, "thread.json")];
		for (const file of files) {
			assert.ok(!file.includes(".tmp-"), `tmp left behind: ${file}`);
			assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
		}
		assert.ok(eventFiles(home, SID).every((name) => /^\d{6}-[a-z]+\.json$/.test(name)));
	} finally {
		cleanup();
	}
});
