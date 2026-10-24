import test from "node:test";
import assert from "node:assert/strict";
import {
	askOf,
	computeNext,
	finalText,
	isPlanAsk,
	isShipAsk,
	nothingLeft,
	planSlugOf,
	shipMarker,
	validateProviderActions,
} from "../src/next.mjs";

const NOW = new Date("2026-10-24T03:04:05.000Z");
const PLAN_SLUG = "comprehensive-tool-grouping";
const CLEAN_GIT = { branch: "main", dirty: 0, ahead: 0, upstream: true };

const EXAMPLE_A = [
	"wanted: 남은 일이 없는지 확인",
	"For you: 작업은 모두 끝났습니다.",
	"Now: 남은 작업 없음. Next: 없음.",
].join("\n");

const EXAMPLE_B = [
	"wanted: 계획 실행",
	"For you: 계획 파일이 준비됐고 아직 남은 항목이 있습니다.",
	"Now: 미완료 항목 4개가 남았습니다.",
	"Next: `/ulw-execute comprehensive-tool-grouping` 로 새 세션에서 이어가세요.",
].join("\n");

function item(text, extra = {}) {
	return { kind: "turn", raw: { final: text }, meta: {}, ...extra };
}

function plan(open = true) {
	return { slug: PLAN_SLUG, path: `/tmp/root/.omo/plans/${PLAN_SLUG}.md`, root: "/tmp/root", open };
}

function next(args = {}) {
	return computeNext({ item: item(EXAMPLE_A), facts: { git: CLEAN_GIT, plan: null, watch: 0 }, now: NOW, ...args });
}

function modelSummary(summary) {
	return { summary, source: "model" };
}

test("detectors read the end of the final and ignore blanks", () => {
	assert.equal(finalText({ raw: { final: "", text: "fallback" } }), "fallback");
	assert.equal(finalText({ raw: {} }), "");
	assert.equal(planSlugOf(EXAMPLE_B), PLAN_SLUG);
	assert.equal(planSlugOf("x /skill:ulw-execute first then " + "$ulw-execute SECond"), "second");
	assert.equal(planSlugOf("no kickoff"), null);
	assert.equal(nothingLeft("Now: 남은 작업 없음. Next: 없음."), true);
	assert.equal(nothingLeft("아직 할 일이 남았습니다"), false);
	assert.equal(shipMarker("아직 커밋하지 않았습니다"), true);
	assert.equal(shipMarker("다 끝났습니다"), false);
	assert.equal(isShipAsk("커밋하고 푸시할까요?"), true);
	assert.equal(isShipAsk("로그 파일을 지울까요?"), false);
	assert.equal(isPlanAsk("새 세션에서 계획을 실행해 주세요"), true);
	assert.equal(isPlanAsk("로그 파일을 지울까요?"), false);
});

test("askOf prefers the stored ask and falls back by summary source", () => {
	assert.equal(askOf({ item: item(EXAMPLE_A), summary: { ask: "  답해 주세요  " } }), "답해 주세요");
	assert.equal(
		askOf({ item: item(EXAMPLE_A), summary: modelSummary({ headline: "진행", body: "로그 파일을 지울까요?" }) }),
		"진행 로그 파일을 지울까요?",
	);
	assert.equal(
		askOf({ item: item("정리하면 됩니다. 지울지는 진규님이 정해 주세요."), summary: { summary: {}, source: "heuristic" } }),
		"지울지는 진규님이 정해 주세요.",
	);
	assert.equal(askOf({ item: item("다 끝났습니다.") }), null);
});

test("example A is done with a single primary close action", () => {
	const result = next();
	assert.equal(result.state, "done");
	assert.equal(result.reason, "남은 일이 없습니다");
	assert.deepEqual(result.actions, [{ id: "close", kind: "close", label: "세션 닫기", primary: true }]);
	assert.equal(result.source, "heuristic");
	assert.equal(result.at, NOW.toISOString());
	assert.deepEqual(result.facts, { git: CLEAN_GIT, plan: null, watch: 0 });
});

test("example B with an open plan is a plan offer", () => {
	const result = next({ item: item(EXAMPLE_B), facts: { git: CLEAN_GIT, plan: plan(true), watch: 0 } });
	assert.equal(result.state, "plan");
	assert.equal(result.reason, `계획 ${PLAN_SLUG} 실행 대기`);
	assert.deepEqual(result.actions, [
		{ id: "new-session", kind: "new-session", label: "새 세션에서 실행", prompt: `/skill:ulw-execute ${PLAN_SLUG}`, primary: true },
		{ id: "close", kind: "close", label: "세션 닫기", primary: false },
	]);
});

test("a closed plan or an executor session is done", () => {
	const closed = next({ item: item(EXAMPLE_B), facts: { git: CLEAN_GIT, plan: plan(false), watch: 0 } });
	assert.equal(closed.state, "done");
	const executor = next({
		item: item(EXAMPLE_B),
		thread: { executes: PLAN_SLUG },
		facts: { git: CLEAN_GIT, plan: plan(true), watch: 0 },
	});
	assert.equal(executor.state, "done");
});

test("a model ask about running the plan stays a plan offer", () => {
	const facts = { git: CLEAN_GIT, plan: plan(true), watch: 0 };
	const before = next({ item: item(EXAMPLE_B), summary: { headline: "계획 대기", body: "", ask: null }, facts });
	const after = next({
		item: item(EXAMPLE_B),
		summary: modelSummary({ headline: "계획 대기", body: "", ask: "새 세션에서 계획을 실행해 주세요" }),
		facts,
	});
	assert.equal(before.state, "plan");
	assert.equal(after.state, "plan");
});

test("a model ask about something else is ask", () => {
	const result = next({
		item: item(EXAMPLE_B),
		summary: modelSummary({ headline: "계획 대기", body: "", ask: "로그 파일을 지울까요?" }),
		facts: { git: CLEAN_GIT, plan: plan(true), watch: 0 },
	});
	assert.equal(result.state, "ask");
	assert.equal(result.reason, "답을 기다립니다");
});

test("nothing-left text asks only when the owner is asked something", () => {
	const withAsk = next({ item: item(`${EXAMPLE_A}\n지울지는 진규님이 정해 주세요.`) });
	assert.equal(withAsk.state, "ask");
	const withoutAsk = next({ item: item(EXAMPLE_A) });
	assert.equal(withoutAsk.state, "done");
});

test("a ship question is a ship verdict", () => {
	assert.equal(next({ item: item("커밋하고 푸시할까요?") }).state, "ship");
});

test("dirty git makes commit-push primary with a warning", () => {
	const result = next({ facts: { git: { ...CLEAN_GIT, dirty: 3 }, plan: null, watch: 0 } });
	assert.equal(result.state, "ship");
	assert.equal(result.reason, "커밋 안 된 변경 3개");
	assert.equal(result.actions[0].id, "commit-push");
	assert.equal(result.actions[0].primary, true);
	assert.ok(result.warnings.includes("커밋 안 된 변경 3개"));
});

test("ahead-only git makes push primary", () => {
	const result = next({ facts: { git: { ...CLEAN_GIT, ahead: 1 }, plan: null, watch: 0 } });
	assert.equal(result.state, "ship");
	assert.equal(result.reason, "푸시 안 된 커밋 1개");
	assert.equal(result.actions[0].id, "push");
	assert.equal(result.actions[0].primary, true);
});

test("unknown git warns and offers no git action", () => {
	const result = next({ facts: { git: { unknown: true }, plan: null, watch: 0 } });
	assert.ok(result.warnings.includes("git 상태를 확인하지 못했습니다"));
	assert.equal(result.actions.some((action) => action.id === "commit-push" || action.id === "push"), false);
});

test("clean git and a plain report is done", () => {
	assert.equal(next({ item: item("테스트 884개가 통과했습니다.") }).state, "done");
});

test("blocked and stalled verdicts keep close non-primary", () => {
	const blocked = next({ item: item("막혔습니다.", { kind: "blocked" }) });
	assert.equal(blocked.state, "blocked");
	assert.equal(blocked.actions.find((action) => action.id === "close").primary, false);
	const stalled = next({ item: item("진전이 없습니다.", { meta: { stalled: true } }) });
	assert.equal(stalled.state, "stalled");
	const episode = next({ item: item("진전이 없습니다.", { meta: { episode: { closeReason: "stalled" } } }) });
	assert.equal(episode.state, "stalled");
});

test("standing monitors add the close warning", () => {
	const result = next({ facts: { git: CLEAN_GIT, plan: null, watch: 2 } });
	assert.ok(result.warnings.includes("상시 감시 2개가 함께 꺼집니다"));
});

test("a model ship hint adds m1 and m2 continue actions", () => {
	const result = next({
		item: item("테스트가 끝났습니다."),
		summary: modelSummary({
			headline: "마무리",
			body: "설치가 남았습니다.",
			next: {
				state: "ship",
				actions: [
					{ label: "설치", prompt: "설치해" },
					{ label: "리로드", prompt: "리로드해" },
				],
			},
		}),
	});
	assert.equal(result.state, "ship");
	assert.equal(result.source, "model");
	assert.deepEqual(result.actions.filter((action) => action.id.startsWith("m")).map((action) => action.id), ["m1", "m2"]);
	assert.equal(result.actions[0].id, "m1");
	assert.equal(result.actions[0].primary, true);
});

test("a heuristic summary never carries the model hint", () => {
	const result = next({
		item: item("테스트가 끝났습니다."),
		summary: { summary: { headline: "끝", body: "", next: { state: "ship", actions: [{ label: "설치", prompt: "설치해" }] } }, source: "heuristic" },
	});
	assert.equal(result.state, "done");
	assert.equal(result.actions.some((action) => action.id.startsWith("m")), false);
});

test("run provider actions need a live session and survive on live ones", () => {
	const providerActions = [{ producer: "omo-preview", key: "serve", label: "테스트 서버", run: true }];
	const off = next({ providerActions, live: false, item: item("테스트가 끝났습니다.") });
	assert.equal(off.actions.some((action) => action.kind === "run"), false);
	const on = next({ providerActions, live: true, item: item("테스트가 끝났습니다.") });
	const run = on.actions.find((action) => action.kind === "run");
	assert.deepEqual(run, {
		id: "p:omo-preview:serve",
		label: "테스트 서버",
		producer: "omo-preview",
		key: "serve",
		kind: "run",
		primary: false,
	});
});

test("ended omits close and run and promotes the remaining action", () => {
	const planEnded = next({ item: item(EXAMPLE_B), facts: { git: CLEAN_GIT, plan: plan(true), watch: 0 }, ended: true });
	assert.deepEqual(planEnded.actions, [
		{ id: "new-session", kind: "new-session", label: "새 세션에서 실행", prompt: `/skill:ulw-execute ${PLAN_SLUG}`, primary: true },
	]);
	const doneEnded = next({ ended: true });
	assert.deepEqual(doneEnded.actions, []);
	const runEnded = next({
		item: item(EXAMPLE_B),
		facts: { git: CLEAN_GIT, plan: plan(true), watch: 0 },
		providerActions: [{ producer: "omo-preview", key: "serve", label: "테스트 서버", run: true }],
		live: true,
		ended: true,
	});
	assert.equal(runEnded.actions.some((action) => action.kind === "run"), false);
});

test("provider prompt actions become p: ids and the cap keeps primary and close", () => {
	const providerActions = Array.from({ length: 6 }, (_, index) => ({
		producer: "omo-preview",
		key: `k${index}`,
		label: `액션${index}`,
		prompt: `실행 ${index}`,
	}));
	const result = next({ providerActions, item: item("테스트가 끝났습니다.") });
	assert.equal(result.actions.length, 5);
	assert.equal(result.actions[0].id, "close");
	assert.equal(result.actions.at(-1).id, "p:omo-preview:k3");
	assert.equal(result.actions.filter((action) => action.id === "close").length, 1);
});

test("validateProviderActions accepts valid payloads and rejects bad ones", () => {
	const ok = validateProviderActions({
		v: 1,
		producer: "omo-preview",
		actions: [
			{ key: "serve", label: "테스트 서버", run: true },
			{ key: "ping", label: "확인", prompt: "  상태를 확인해  " },
		],
	});
	assert.deepEqual(ok, {
		ok: true,
		value: {
			producer: "omo-preview",
			actions: [
				{ key: "serve", label: "테스트 서버", run: true },
				{ key: "ping", label: "확인", prompt: "상태를 확인해" },
			],
		},
	});
	assert.equal(validateProviderActions({ v: 1, producer: "Bad Producer", actions: [] }).ok, false);
	assert.equal(validateProviderActions({ v: 1, producer: "p", actions: [{ key: "a", label: "1234567890123", run: true }] }).ok, false);
	assert.equal(validateProviderActions({ v: 1, producer: "p", actions: [{ key: "a", label: "ok", prompt: "x", run: true }] }).ok, false);
	assert.equal(
		validateProviderActions({
			v: 1,
			producer: "p",
			actions: Array.from({ length: 5 }, (_, index) => ({ key: `k${index}`, label: "ok", run: true })),
		}).ok,
		false,
	);
});
