// Next verdict engine (todo 1): pure detectors, model/provider action shaping and the state
// precedence shared by the server, thread page and list rows. No IO, no spawns.

import { detectQuestion, detectTodo } from "./summary.mjs";

const TAIL = 1500;
const SLUG_RE = /(?:\/skill:ulw-execute|\/ulw-execute|\$ulw-execute)\s+([a-z0-9][a-z0-9-]{0,79})(?![a-z0-9-])/gi;
const NOTHING_LEFT_RE = /(Next|다음)\s*[:：]\s*(없음|남은 (작업|일) 없음|none)|남은 (작업|일)(은|이)? 없(음|습니다)|(더 )?할 (일|것)(은|이)? 없습니다/i;
const SHIP_MARKER_RE = /커밋(은|을)? (하지 않았|안 했)|아직 커밋|커밋하지 않았|(푸시|push)(는|를|은)? (하지 않았|안 했)|푸시하지 않았|설치본에 (들어가지|반영되지) 않|설치(는|를)? (하지 않았|안 했)|재설치가 필요|\/reload(가|를)? (해야|필요)|리로드(를|가)? (해야|필요)/i;
const SHIP_ASK_RE = /(커밋|푸시|push|설치|배포|릴리스|PR|머지|merge|리로드|reload)/i;
const PLAN_ASK_RE = /(계획|ulw-execute|새 세션|execute)/i;
const SLUG_VALID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PRODUCER_RE = /^[a-z0-9-]{1,40}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,40}$/;
const MAX_ACTIONS = 5;

function tail(text, size = TAIL) {
	return String(text ?? "").slice(-size);
}

export function finalText(item) {
	for (const value of [item?.raw?.final, item?.raw?.text]) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

export function planSlugOf(text) {
	const source = tail(text);
	let slug = null;
	let match;
	SLUG_RE.lastIndex = 0;
	while ((match = SLUG_RE.exec(source)) !== null) slug = match[1].toLowerCase();
	SLUG_RE.lastIndex = 0;
	return slug;
}

export function nothingLeft(text) {
	return NOTHING_LEFT_RE.test(tail(text));
}

export function shipMarker(text) {
	return SHIP_MARKER_RE.test(tail(text));
}

export function isShipAsk(text) {
	return SHIP_ASK_RE.test(String(text ?? ""));
}

export function isPlanAsk(text) {
	return planSlugOf(text) !== null || PLAN_ASK_RE.test(String(text ?? ""));
}

function splitSentences(text) {
	return String(text ?? "")
		.split(/(?<=[.!?。！？])\s+|\n+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function lastMatching(text, detect) {
	const parts = splitSentences(text);
	for (let i = parts.length - 1; i >= 0; i -= 1) {
		if (detect(parts[i])) return parts[i];
	}
	return "";
}

export function askOf({ item, summary } = {}) {
	const wrapped = summary && typeof summary.summary === "object" && summary.summary !== null;
	const plain = wrapped ? summary.summary : summary;
	const source = wrapped ? summary.source : undefined;
	const ask = typeof plain?.ask === "string" ? plain.ask.trim() : "";
	if (ask) return ask;
	const text = source === "model"
		? [plain?.headline, plain?.body].filter((value) => typeof value === "string").join(" ")
		: tail(finalText(item), 400);
	if (detectQuestion(text)) {
		const sentence = lastMatching(text, detectQuestion);
		return sentence || text.trim() || null;
	}
	if (detectTodo(text)) {
		const sentence = lastMatching(text, detectTodo);
		return sentence || text.trim() || null;
	}
	return null;
}

function modelActions(summary) {
	if (!summary || typeof summary !== "object" || summary.source !== "model") return [];
	const next = summary.summary?.next;
	const list = Array.isArray(next?.actions) ? next.actions : [];
	const out = [];
	for (const action of list) {
		const label = typeof action?.label === "string" ? action.label.trim() : "";
		const prompt = typeof action?.prompt === "string" ? action.prompt.trim() : "";
		if (!label || label.length > 12 || !prompt || prompt.length > 200) continue;
		out.push({ label, prompt });
		if (out.length === 2) break;
	}
	return out;
}

function modelHint(summary) {
	if (!summary || typeof summary !== "object" || summary.source !== "model") return null;
	const next = summary.summary?.next;
	return next && typeof next === "object" ? next.state ?? null : null;
}

function providerList(providerActions, live, ended) {
	const out = [];
	for (const action of Array.isArray(providerActions) ? providerActions : []) {
		if (!action || typeof action !== "object") continue;
		const { producer, key } = action;
		if (typeof producer !== "string" || typeof key !== "string") continue;
		const label = typeof action.label === "string" ? action.label.trim() : "";
		if (!label) continue;
		const base = { id: `p:${producer}:${key}`, label, producer, key };
		if (action.run === true) {
			if (!live || ended) continue;
			out.push({ ...base, kind: "run" });
			continue;
		}
		const prompt = typeof action.prompt === "string" ? action.prompt.trim() : "";
		if (!prompt) continue;
		out.push({ ...base, kind: "continue", prompt });
	}
	return out;
}

function closeAction() {
	return { id: "close", kind: "close", label: "세션 닫기" };
}

function withPrimary(actions, ids) {
	const chosen = ids.filter(Boolean);
	return actions.map((action) => ({ ...action, primary: chosen.includes(action.id) }));
}

function cap(actions) {
	if (actions.length <= MAX_ACTIONS) return actions;
	const primary = actions.find((action) => action.primary);
	const close = actions.find((action) => action.id === "close");
	const keep = new Set();
	if (primary) keep.add(actions.indexOf(primary));
	if (close) keep.add(actions.indexOf(close));
	for (let i = 0; i < actions.length && keep.size < MAX_ACTIONS; i += 1) keep.add(i);
	return actions.filter((_, index) => keep.has(index));
}

function ensurePrimary(actions) {
	if (!actions.length || actions.some((action) => action.primary)) return actions;
	return actions.map((action, index) => (index === 0 ? { ...action, primary: true } : action));
}

function gitFacts(facts) {
	const git = facts?.git;
	return git && typeof git === "object" ? git : null;
}

export function computeNext({ item, summary, thread, facts, providerActions, live, ended, now } = {}) {
	const source = summary && typeof summary === "object" && summary.source === "model" ? "model" : "heuristic";
	const text = finalText(item);
	const git = gitFacts(facts);
	const dirty = git && git.unknown !== true && Number(git.dirty) > 0 ? Number(git.dirty) : 0;
	const ahead = git && git.unknown !== true && Number(git.ahead) > 0 ? Number(git.ahead) : 0;
	const plan = facts?.plan && typeof facts.plan === "object" ? facts.plan : null;
	const planValid = Boolean(plan && plan.open !== false && thread?.executes !== plan.slug);
	const ask = askOf({ item, summary });
	const hint = modelHint(summary);

	let state;
	if (item?.kind === "blocked") {
		state = "blocked";
	} else if (item?.meta?.stalled === true || item?.meta?.episode?.closeReason === "stalled") {
		state = "stalled";
	} else if (ask && !isShipAsk(ask) && !(planValid && isPlanAsk(ask))) {
		state = "ask";
	} else if (planValid) {
		state = "plan";
	} else if (dirty > 0 || ahead > 0 || shipMarker(text) || (ask && isShipAsk(ask)) || hint === "ship") {
		state = "ship";
	} else {
		state = "done";
	}

	const reasons = {
		done: "남은 일이 없습니다",
		plan: `계획 ${plan?.slug ?? ""} 실행 대기`,
		ship: [dirty > 0 ? `커밋 안 된 변경 ${dirty}개` : "", ahead > 0 ? `푸시 안 된 커밋 ${ahead}개` : ""].filter(Boolean).join(" · ") || "마무리 작업이 남았습니다",
		ask: "답을 기다립니다",
		blocked: "막힌 목표를 풀어야 합니다",
		stalled: "멈춘 작업을 이어가야 합니다",
	};

	const warnings = [];
	if (dirty > 0) warnings.push(`커밋 안 된 변경 ${dirty}개`);
	if (ahead > 0) warnings.push(`푸시 안 된 커밋 ${ahead}개`);
	const watch = Number(facts?.watch);
	if (Number.isFinite(watch) && watch > 0) warnings.push(`상시 감시 ${watch}개가 함께 꺼집니다`);
	if (git?.unknown === true) warnings.push("git 상태를 확인하지 못했습니다");

	const model = modelActions(summary).map((action, index) => ({
		id: `m${index + 1}`,
		kind: "continue",
		label: action.label,
		prompt: action.prompt,
	}));
	const provider = providerList(providerActions, live === true, ended === true);
	const close = closeAction();

	let actions;
	let primaryIds = [];
	if (state === "done") {
		actions = [close, ...model, ...provider];
		primaryIds = ["close"];
	} else if (state === "plan") {
		actions = [
			{ id: "new-session", kind: "new-session", label: "새 세션에서 실행", prompt: `/skill:ulw-execute ${plan.slug}` },
			close,
		];
		primaryIds = ["new-session"];
	} else if (state === "ship") {
		if (dirty > 0) {
			actions = [
				{ id: "commit-push", kind: "continue", label: "커밋·푸시", prompt: "변경을 커밋하고 푸시해" },
				...model,
				...provider,
				close,
			];
			primaryIds = ["commit-push"];
		} else if (ahead > 0) {
			actions = [{ id: "push", kind: "continue", label: "푸시", prompt: "커밋을 푸시해" }, ...model, ...provider, close];
			primaryIds = ["push"];
		} else {
			actions = [...model, ...provider, close];
		}
	} else {
		actions = [...provider, close];
	}

	if (ended === true) {
		actions = actions.filter((action) => action.id !== "close" && action.kind !== "run");
	}
	actions = withPrimary(actions, primaryIds);
	if (state === "ship" && !actions.some((action) => action.primary)) actions = ensurePrimary(actions);
	if (state === "done" && ended === true) actions = actions.filter((action) => action.id !== "close" && action.kind !== "run");
	actions = cap(actions);
	if (ended === true) actions = ensurePrimary(actions);

	return {
		v: 1,
		state,
		reason: reasons[state],
		actions,
		warnings,
		facts: {
			git,
			plan,
			watch: Number.isFinite(watch) && watch > 0 ? watch : 0,
		},
		source,
		at: (now ?? new Date()).toISOString(),
	};
}

export function validateProviderActions(data) {
	const errors = [];
	if (!data || typeof data !== "object") return { ok: false, errors: ["data must be an object"] };
	if (data.v !== 1) errors.push("v must be 1");
	const producer = data.producer;
	if (typeof producer !== "string" || !PRODUCER_RE.test(producer)) errors.push("producer must match ^[a-z0-9-]{1,40}$");
	if (!Array.isArray(data.actions)) {
		errors.push("actions must be an array");
		return { ok: false, errors };
	}
	if (data.actions.length > 4) errors.push("actions must have at most 4 entries");
	const actions = [];
	for (let i = 0; i < data.actions.length; i += 1) {
		const action = data.actions[i];
		if (!action || typeof action !== "object") {
			errors.push(`action ${i + 1}: must be an object`);
			continue;
		}
		const key = action.key;
		const label = typeof action.label === "string" ? action.label.trim() : "";
		const prompt = typeof action.prompt === "string" ? action.prompt.trim() : "";
		const run = action.run === true;
		if (typeof key !== "string" || !KEY_RE.test(key)) errors.push(`action ${i + 1}: key must match ^[A-Za-z0-9._:-]{1,40}$`);
		if (!label || label.length > 12) errors.push(`action ${i + 1}: label must be 1..12 chars`);
		if (run && prompt) errors.push(`action ${i + 1}: use either prompt or run, not both`);
		else if (!run && (!prompt || prompt.length > 300)) errors.push(`action ${i + 1}: prompt must be 1..300 chars`);
		if (typeof key === "string" && KEY_RE.test(key) && label && label.length <= 12 && (run !== Boolean(prompt)) && (run || prompt.length <= 300)) {
			actions.push(run ? { key, label, run: true } : { key, label, prompt });
		}
	}
	if (errors.length) return { ok: false, errors };
	return { ok: true, value: { producer, actions } };
}
