// Summary module (contract C6): builds the model request, validates what the model returns and
// falls back to a rule-based Korean summary. Pure functions only - this module never calls a model
// and never touches another src module except src/redact.mjs (todo 8) for output cleaning.

const KIND_ENUM = ["question", "approval", "permission", "blocked", "done", "report", "progress"];
const LIMITS = {
	headline: 40,
	context: 120,
	body: 300,
	ask: 120,
	ifNoAnswer: 80,
	optionLabel: 20,
	optionWhy: 60,
	term: 20,
	meaning: 50,
	title: 24,
};
const MAX_OPTIONS = 4;
const MAX_TERMS = 3;
const MAX_TOKENS = 700;
const RAW_CAP = 6000;
const RAW_HEAD = 4000;
const RAW_TAIL = 2000;
const DEFAULT_TIMEOUT_MINUTES = 30; // senpi askUser.timeoutMinutes default (ask-user tool.js)

const QUESTION_RE = /(\?|？|할까요|주세요|정해|어떻게\s*할)/;
const TODO_RE = /(직접\s*\S*\s*(해야|하셔야|해\s*주셔야|하세요|해\s*주세요|필요)|해야\s*(해요|합니다|돼요|됩니다|함|한다)|하셔야|해\s*주셔야)/;
const REC_MARKERS = ["권장", "추천", "(Recommended)", "recommended"];
/** Wording in the source that recommends one way; the summary must then carry the recommendation. */
const REC_PHRASE_RE = /권장|추천|권합니다|낫습니다|낫다|게 낫|좋겠습니다|recommend/i;
const ELLIPSIS = "…";

export const KNOWN_TERMS = [
	"omo",
	"OmO",
	"Orca",
	"desk",
	"omo-desk",
	"inbox",
	"omo-inbox",
	"받은함",
	"Inbox",
	"보드",
	"Review",
	"goal",
	"ulw",
	"mass-ulw",
	"세션",
	"확장",
	"스킬",
	"커밋",
	"푸시",
	"PR",
	"브랜치",
	"테스트",
	"에이전트",
	"서브에이전트",
	"워크트리",
	"모니터",
	"워크플로",
	"QA",
	"검증",
	"배포",
	"롤백",
	"인스턴스",
	"데몬",
	"체크포인트",
	"회귀",
	"매니페스트",
	"파워링크",
	"확장소재",
	"광고그룹",
	"서브링크",
	"플레이스",
	"머지",
	"스키마",
	"스크립트",
	"템플릿",
	"토큰",
	"스트림",
	"오리진",
	"카나리",
	"콘솔",
	"배치",
	"게이트웨이",
	"오모냥",
	"도리",
	"빌드",
	"깃",
	"git",
	"깃허브",
	"GitHub",
	"저장소",
	"프롬프트",
	"오모",
	"캐시",
	"마크다운",
	"디스코드",
	"Discord",
	"로그",
	"온보딩",
	"도구 호출",
];

const HANDOFF_LABELS = { Ask: "ask", wanted: "wanted", "For you": "forYou", Now: "now", Next: "next" };

// src/redact.mjs is todo 8 and may not exist yet in this wave; the identity fallback keeps
// summaries working until it lands, and once it does every request text is redacted.
let redact = (text) => String(text ?? "");
try {
	const mod = await import("./redact.mjs");
	if (typeof mod.redact === "function") redact = (text) => String(mod.redact(text) ?? "");
} catch {
	// no redact module yet: identity
}

export const SUMMARY_SYSTEM_PROMPT = [
	"너는 omo 세션의 'Inbox' 메시지를 쓰는 한국어 요약기다.",
	"읽는 사람은 세션을 지켜보지 않았고, 세션 안의 코드, 파일, 도구, 내부 이름을 전혀 모른다. 처음 보는 비개발자에게 문자 메시지로 알려 준다고 생각하고 쓴다.",
	"규칙:",
	"1. headline: 결론이나 사용자에게 하는 물음/요청을 완결된 한 문장으로 쓴다. 35자 안팎, 말줄임표 금지. 아직 일이 끝나지 않았어도 지금 알아야 할 결과(정해진 것, 막힌 것, 사용자가 할 일)를 쓴다. '검토 시작', '개발 시작', '검증 중', '진행 중', '준비 중'처럼 과정을 나타내는 말만으로 된 headline은 금지: headline에는 결과나 사용자가 할 일이 반드시 들어간다. 질문에 답하는 글이면 그 답(예/아니오와 이유)을 쓴다.",
	"2. context: 120자 이하. 이 세션이 원래 무슨 일을 하던 중인지 사용자의 첫 요청과 마지막 요청에서 따와 쓴다. 사용자가 둘 이상을 요청했으면 모두 반영하고, 원문에 없는 사실을 보태거나 원문과 반대로 쓰지 않는다. 마지막 질문을 그대로 되풀이하지 않는다.",
	"3. body: 300자 이하(270자 안쪽으로). 결과와 상태를 일상어로 쓴다.",
	"4. 파일 경로, 파일명, 명령어, 코드, 해시, 버전 번호, 작업/세션 식별자(T12, G5, F1~F4, bash_29 등)는 어디에도 쓰지 않는다. '설정 파일', '그 작업'처럼 바꾼다.",
	"5. 용어 규칙: 사용자 메시지의 '사용자가 이미 아는 말' 목록에 있는 말은 설명 없이 써도 된다. 그 밖의 모든 기술 용어와 내부 용어는 처음 쓸 때 괄호나 terms로 풀어 쓴다. 도구 이름(task_send, eval, todo), 검토 단계(F1~F4), 내부 역할(오케스트레이터, 자식 작업), 업계 용어(확장소재, 파워링크), 약어(OAuth, CI, QA, TTL, OCI, NCP), 영문 식별자, 라이브러리/서비스/프로젝트/봇 이름, 계획 단계명(Wave, stage)이 모두 해당한다. 되도록 일상어로 바꿔 쓰고(예: 'QA'는 '동작 점검', 'OAuth'는 '로그인 연동'), 꼭 필요한 말만 남기되 바로 뒤에 괄호로 뜻을 붙이거나(예: 'OCI(오라클 클라우드)') terms에 넣는다. terms의 term은 headline, context, body, ask 중 한 곳에 그대로 나오는 낱말만 고른다. 그 글에 없는 말은 terms에 넣지 않는다.",
	"6. 원문에 번호나 기호로 나열된 항목이 있으면 그 항목의 제목을 살려서 전한다.",
	"7. 원문 마지막이 사용자에게 하는 물음('~할까요?', '승인', '어떻게 할까요')이면 kind는 반드시 question 또는 approval이고 ask에 그 물음을 그대로 살려 쓴다. 이때 반드시: (a) ask에 무엇을 정해야 하는지와 선택지 이름을 짧게 풀어 쓴다(선택지는 화면에 버튼으로 따로 나오므로 options는 비워도 되지만 ask에 안 쓰면 안 된다). (b) 원문이나 선택지에 권장/추천 표시나 그럴 만한 근거가 있으면 ask에 '권장: 그 안, 이유'를 쓴다. 권장 표시가 없으면 권장안을 스스로 지어내지 마라. (c) ifNoAnswer는 시스템이 실제 설정을 보고 채우므로 항상 null로 둔다. 물음도 사용자가 직접 할 일도 없는 보고에는 ask를 null로 둔다.",
	"8. 글자 수 제한은 한국어 글자 수 기준으로 절대 넘기지 않는다: headline 40, context 120, body 300, ask 120, ifNoAnswer 80, title 24, option label 20, why 60, term 20, meaning 50. 쓰고 나서 세어 보고 넘으면 줄인다. 안전하게 headline 35, ask 100, body 270, title 20 안쪽으로 쓴다.",
	"9. 출력 전 점검: headline이 결과/물음인가? 낯선 말이 남아 있나? 경로/식별자가 남아 있나? 권장/답 없을 때의 영향이 빠지지 않았나? 글자 수를 넘지 않았나?",
	"9-1. headline 금지 형태: '~중', '~시작', '~대기', '~진행', '~확인 중'으로 끝나는 말, 두 단계를 화살표나 쉼표로 나열한 말. 대신 '그래서 지금 어떻게 됐는가'(끝났다/막혔다/N건 중 M건 통과/사용자가 정할 것)를 쓴다. 원문 끝이 사용자에게 하는 물음이면 headline은 그 물음 자체(무엇을 정할지)다. 사용자의 질문에 답하는 글이면 headline은 그 답이다. 원문에 없는 사실은 headline에도 쓰지 않는다. 원문이 정말 진행 보고뿐이면 '지금까지 된 것 한 가지 + 남은 것 한 가지'를 한 문장으로 쓴다.",
	"9-2. context: '그 세션', '해당 작업', '설정 진행' 같은 지시어/추상어만으로 쓰지 않는다. 어떤 제품/기능/대상을 무엇 하려는 중인지 구체 명사로 쓴다(예: '네이버 광고 확장소재 등록 자동화 작업 중'). 원문에 없는 내용은 쓰지 않는다.",
	"9-2-1. context에는 반드시 (1) 어떤 제품/프로젝트인지 (2) 사용자가 시킨 일이 무엇인지 두 가지를 모두 구체 명사로 담는다. 주제어만 나열하지 않고 한 문장으로 쓴다. 세션 폴더 이름은 실제로 손댄 제품과 다를 수 있으니, 폴더 이름이 아니라 이번 작업이 실제로 다룬 제품을 쓴다.",
	"9-3. 풀이가 필요한 말은 '사용자가 이미 아는 말' 밖의 것 전부다. 판단이 애매하면 일상어로 바꾸거나 괄호로 풀어 쓴다. 고유한 별명/프로젝트/인물/봇 이름, 'S1~S9' 같은 단계 기호, 영문 약어, 내부 도구 명령 이름은 처음 쓸 때 반드시 뜻을 붙이거나 빼고 쓴다. title에도 같은 규칙을 적용한다.",
	"9-4. 권장안(options의 rec, ask의 '권장')은 원문이나 선택지에 권장/추천 표시나 명시된 이유가 있을 때만 쓴다. 단순히 '진행할까요?'만 있으면 권장 없이 '진행/보류' 중 정하라고만 쓴다. 원문이 어느 쪽을 기본 행동으로 제시하면(예: '닫아 달라, 보류하려면 선택') 그 기본 행동을 ask에 쓴다. ifNoAnswer는 시스템이 채우므로 항상 null이다. 원문에 없는 약속이나 결과를 지어내지 않는다. 권장안은 원문에 그 안을 권하는 문장이 없으면 어떤 필드에도 쓰지 않는다. ask는 에이전트가 스스로 조사할 사실이 아니라 사용자가 정할 일이나 사용자가 직접 해야 할 일을 쓴다. 원문에 '(a)+(b)로 이어가겠다', '~를 권장한다'처럼 에이전트의 제안이 있으면 ask에 '권장: ...'으로 옮긴다.",
	"9-5. 질문 항목의 '질문/대화 원문(JSON)'을 끝까지 읽는다: 선택지의 label이나 description에 '권장', '추천', '(권장)', 'Recommended'가 있으면 ask에 반드시 '권장: <그 선택지 이름>, <이유>'를 쓴다. 원문이 'Please close it', '닫아 달라'처럼 특정 행동을 지시하면 그 행동을 '권장'으로 쓴다.",
	"9-6. 이런 말은 '사용자가 이미 아는 말'에 없으면 쓰지 않고 일상어로 바꾼다: 온보딩(처음 가입 안내), 캡차(사람 확인 퍼즐), 업스트림(원본 쪽), 임계값(기준 수치), 히트맵(색으로 보는 분포도), 지도 키(지도 서비스 이용 열쇠), 반응형 소재·추가제목 같은 광고 용어, 랜딩 페이지(클릭 후 처음 보이는 페이지), 로그(기록), 로컬 자격증명(이 컴퓨터에 저장된 로그인 정보), 단위 테스트(작은 단위 점검), 헤더(표의 맨 위 제목 줄), 패치(고침 수정), 모든 영문 약어·기술 용어. 이 목록은 예시일 뿐이다: '이미 아는 말' 목록에 없는 전문어는 전부 같은 규칙이다. 특히 headline, ask, terms에도 적용한다. 쓰기 전에 문장의 모든 명사를 한 번씩 훑어 평범한 직장인이 모를만한 말이 있으면 일상어로 바꾼다. 사진·영상 편집 용어(크롭 등)도 포함이다. context는 원문의 프로젝트/주제를 그대로 쓰고 파일 이름만 보고 작업 종류를 추측하지 않는다. 바꾸기 어려우면 바로 뒤 괄호로 뜻을 붙인다.",
	"9-8. 질문 항목의 ask는 원문 질문이 정하라는 것을 같은 종류로 묻는다(어느 것을 고를지면 '어느 쪽', 할지 말지면 '할지'). 원문 선택지('보류', '하지 않음' 같은 선택지 포함)를 빠짐없이 아우르고, 선택지 개수를 숫자로 쓰지 않는다(선택지는 아래 버튼으로 그대로 보인다). 원문의 경로, 식별자, 내부 작업 번호는 내용을 뜻하는 말로 바꿔 쓴다.",
	"9-9. ask에는 사용자에게 하는 물음뿐 아니라, 원문이 사용자가 직접 해야 한다고 말한 일(예: 직접 실행, 설치, 확인, 창 닫기, 새 세션 시작)을 한 문장으로 쓴다. 물음도 할 일도 없으면 ask는 null이다.",
	"9-10. 작업 구간 요약에서 '구간의 메시지별 한 줄'은 맥락일 뿐이다. 결론은 '마지막 메시지 원문'에 적힌 결과다. 기다리는 줄은 결과가 아니다.",
	"9-7. ifNoAnswer는 시스템이 실제 설정으로 채운다: 항상 null로 쓰고, body와 ask에도 답이 없을 때 무슨 일이 일어나는지(멈춤, 자동 진행, 보류)를 지어내 쓰지 않는다. 원문이 어느 쪽으로 진행하는지 말하면 그 방향을 쓴다. 이미 구현이 시작된 세션이면 '전체가 멈춘다' 대신 '이 결정이 필요한 부분만 대기합니다'로 쓴다. 원문이 사용자가 직접 해야 할 행동(창 닫기, 새 세션 시작 등)을 말하면 그 행동의 주체를 에이전트가 알아서 하는 것처럼 바꿔 쓰지 않는다. headline에 '~할 차례', '~확인해야 한다' 같은 과정어 대신 실제로 무엇을 해 달라는 것인지 쓴다.",
	"10. 출력은 아래 스키마의 JSON 객체 하나만. 설명, 인사, 코드 펜스 금지.",
	"스키마:",
	'{"kind": "question|approval|permission|blocked|done|report|progress", "headline": "<=40자",',
	' "context": "<=120자", "body": "<=300자", "ask": "<=120자 또는 null",',
	' "options": [{"label": "<=20자", "why": "<=60자", "rec": true|false}], "ifNoAnswer": null,',
	' "terms": [{"term": "<=20자", "meaning": "<=50자"}], "title": "<=24자, 제목을 요청받았을 때만"}',
	"kind 선택: 물음이면 question, 승인 요청이면 approval, 권한 대화상자면 permission, 막힘이면 blocked,",
	"끝났으면 done, 진행 보고면 report, 아직 일하는 중이면 progress.",
	"options는 4개 이하이고, 진행/보고 항목에는 넣지 않는다. 질문과 권한 항목은 화면이 원문 선택지를 그대로 쓰므로 options를 비운다. terms는 3개 이하이고, 요약 글에 그대로 나오는 낱말만 쓴다.",
].join("\n");

export const SUMMARY_SIMPLER_PROMPT = [
	"다시 쓴다: 방금 요약을 더 쉽게 만들어라.",
	"문장을 더 짧게 끊고, 전문용어 대신 일상 단어를 쓰고, 예를 하나 들어 설명하라.",
	"같은 JSON 스키마를 그대로 지켜라.",
].join("\n");

const LINE_SYSTEM_PROMPT = [
	"너는 omo 세션의 Inbox 진행 한 줄을 쓰는 한국어 요약기다.",
	"규칙:",
	"1. 한국어 한 줄로, 40자 이하로 쓴다.",
	"2. 이 메시지가 에이전트가 지금 하는 일이나 방금 찾은 것을 일상어로 쓴다. 원문에 없는 사실은 쓰지 않는다.",
	"3. 고유 이름 말고는 영문을 쓰지 않는다.",
	"4. 인사, 따옴표, 설명 없이 한 줄만 출력한다.",
].join("\n");

const WAIT_LABELS = {
	"terminal-background-sessions": "백그라운드 작업",
	"terminal-monitors": "모니터",
	"senpi-codemode": "분리 실행 작업",
	"senpi-task": "하위 작업",
	"omo-dag": "작업 흐름",
	"omo-inbox": "Review 답",
	"omo-desk": "Review 답",
	"ask-user": "질문 답",
	scheduled: "목표 이어가기",
	"reload-grace": "다시 불러온 뒤 확인",
	dialog: "권한 답",
};

const HANGUL_RE = /[가-힣]/;
const ROUTING_RE = /^(I read this as|요청은 .{0,200}?이해했습니다)/;

export function clip(text, limit) {
	const value = String(text ?? "");
	if (!Number.isFinite(limit) || limit <= 0) return "";
	if (value.length <= limit) return value;
	return value.slice(0, Math.max(0, limit - 1)) + ELLIPSIS;
}

function firstJsonObject(text) {
	const source = String(text ?? "").replace(/```[a-zA-Z]*\n?/g, "");
	const start = source.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return source.slice(start, i + 1);
		}
	}
	return null;
}

function usesRawOptions(kind) {
	return kind === "question" || kind === "permission";
}

function normalizeOptions(options) {
	if (!Array.isArray(options)) return [];
	const out = [];
	for (const option of options) {
		if (!option || typeof option !== "object") continue;
		const label = clip(option.label, LIMITS.optionLabel);
		if (!label) continue;
		out.push({ label, why: clip(option.why, LIMITS.optionWhy), rec: Boolean(option.rec) });
		if (out.length >= MAX_OPTIONS) break;
	}
	return out;
}

function normalizeTerms(terms) {
	if (!Array.isArray(terms)) return [];
	const out = [];
	for (const term of terms) {
		if (!term || typeof term !== "object") continue;
		const name = clip(term.term, LIMITS.term);
		if (!name) continue;
		out.push({ term: name, meaning: clip(term.meaning, LIMITS.meaning) });
		if (out.length >= MAX_TERMS) break;
	}
	return out;
}

function textOrNull(value, limit) {
	const clipped = clip(value, limit);
	return clipped ? clipped : null;
}

export function validateSummary(text, item = {}) {
	const chunk = firstJsonObject(text);
	if (!chunk) return null;
	let parsed;
	try {
		parsed = JSON.parse(chunk);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	if (!KIND_ENUM.includes(parsed.kind)) return null;
	const headline = clip(parsed.headline, LIMITS.headline);
	if (!headline) return null;
	const context = clip(parsed.context, LIMITS.context);
	const body = clip(parsed.body, LIMITS.body);
	const ask = textOrNull(parsed.ask, LIMITS.ask);
	const title = clip(parsed.title, LIMITS.title);
	return {
		kind: parsed.kind,
		headline,
		context,
		body,
		ask,
		options: usesRawOptions(item?.kind) || usesRawOptions(parsed.kind) ? [] : normalizeOptions(parsed.options),
		ifNoAnswer: textOrNull(parsed.ifNoAnswer, LIMITS.ifNoAnswer),
		terms: normalizeTerms(parsed.terms).filter(({ term }) => [headline, context, body, ask].some((field) => field?.includes(term))),
		title: title ? title : null,
	};
}

const CODE_TOKEN_RE = /[A-Za-z][A-Za-z0-9_./-]{2,}/g;
const PROCESS_ONLY_RE = /(시작|진행 중|검토 중|확인 중|작업 중|진행합니다|시작합니다)[.!]?$/;
const TAIL_CHECK = 400;

function parseDraft(text) {
	const chunk = firstJsonObject(text);
	if (!chunk) return null;
	try {
		const parsed = JSON.parse(chunk);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Quality issues of a raw model answer, found before clipping: code-like tokens the reader does not
 * know, fields over their C6 limit, a headline that only names a process step, and a closing
 * question to the user that the summary does not carry. Returns [] for an unparsable answer.
 */
export function lintSummary(text, item = {}, thread = {}) {
	const draft = parseDraft(text);
	if (!draft) return [];
	const issues = [];
	const cwdName = String(thread?.cwd ?? "")
		.split(/[\\/]+/)
		.filter(Boolean)
		.pop();
	const listed = Array.isArray(draft.terms) ? draft.terms.map((entry) => String(entry?.term ?? "")) : [];
	const allowed = new Set([...KNOWN_TERMS, thread?.product, cwdName, ...listed].filter(Boolean).map((term) => String(term).toLowerCase()));
	const seen = new Set();
	for (const field of ["headline", "context", "body", "ask"]) {
		for (const match of String(draft[field] ?? "").matchAll(CODE_TOKEN_RE)) {
			const token = match[0].replace(/[./-]+$/, "");
			const key = token.toLowerCase();
			if (token.length < 3 || allowed.has(key) || seen.has(key)) continue;
			seen.add(key);
			issues.push(`${field}에 영문/코드 같은 말 "${token}"이(가) 있음: 일상어로 바꾸거나 terms에 뜻을 적을 것`);
		}
	}
	const limited = [
		["headline", draft.headline, LIMITS.headline],
		["context", draft.context, LIMITS.context],
		["body", draft.body, LIMITS.body],
		["ask", draft.ask, LIMITS.ask],
		["ifNoAnswer", draft.ifNoAnswer, LIMITS.ifNoAnswer],
		["title", draft.title, LIMITS.title],
	];
	for (const option of Array.isArray(draft.options) ? draft.options : []) {
		limited.push(["option label", option?.label, LIMITS.optionLabel], ["option why", option?.why, LIMITS.optionWhy]);
	}
	for (const term of Array.isArray(draft.terms) ? draft.terms : []) {
		limited.push(["term", term?.term, LIMITS.term], ["term meaning", term?.meaning, LIMITS.meaning]);
	}
	for (const [name, value, limit] of limited) {
		const length = String(value ?? "").length;
		if (length > limit) issues.push(`${name}이(가) ${length}자로 ${limit}자를 넘음: 줄일 것`);
	}
	if (PROCESS_ONLY_RE.test(String(draft.headline ?? "").trim())) {
		issues.push("headline이 과정만 말함(시작/진행 중 등): 결과나 사용자가 할 일을 쓸 것");
	}
	const tail = rawText(item, thread).slice(-TAIL_CHECK);
	if (detectQuestion(tail) && ((draft.kind !== "question" && draft.kind !== "approval") || !draft.ask)) {
		issues.push("원문 끝에 사용자에게 하는 물음이 있는데 kind가 question/approval이 아니거나 ask가 비어 있음");
	} else if (!draft.ask && detectTodo(tail)) issues.push("원문 끝에 사용자가 직접 할 일이 있는데 ask가 비어 있음: ask에 그 일을 한 문장으로 쓸 것");
	if ((draft.kind === "question" || draft.kind === "approval") && REC_PHRASE_RE.test(tail) && !/권장/.test(`${draft.ask ?? ""} ${draft.body ?? ""}`)) {
		issues.push("원문에 권하는 판단이 있는데 ask나 body에 '권장: <안>, <이유>'가 없음");
	}
	return issues;
}

/** The same system prompt plus the draft and the issues to fix; the answer is JSON only. */
export function buildRepairRequest(item, thread = {}, draftText = "", issues = [], options = {}) {
	const base = buildSummaryRequest(item, thread, options);
	const user = [
		base.user,
		"",
		"앞서 쓴 초안:",
		redact(draftText),
		"",
		"초안에서 고칠 문제:",
		...issues.map((issue) => `- ${redact(issue)}`),
		"",
		"위 문제를 모두 고쳐 스키마의 JSON 객체 하나만 다시 출력하라. 설명 금지.",
	].join("\n");
	return { system: base.system, user, maxTokens: MAX_TOKENS };
}

function rawText(item, thread) {
	const raw = item?.raw ?? {};
	if (typeof raw.final === "string" && raw.final.trim()) return raw.final;
	if (typeof raw.text === "string" && raw.text.trim()) return raw.text;
	const questions = raw.request?.questions;
	if (Array.isArray(questions) && questions.length) {
		return questions
			.map((q) => [q?.header, q?.question].filter(Boolean).join(": "))
			.filter(Boolean)
			.join("\n");
	}
	if (raw.dialog) return [raw.dialog.title, ...(raw.dialog.options ?? [])].filter(Boolean).join("\n");
	if (raw.goal) return [raw.goal.objective, raw.goal.reason].filter(Boolean).join("\n");
	if (raw.notice) return [raw.notice.title, raw.notice.body].filter(Boolean).join("\n");
	return typeof thread?.lastRequest === "string" ? thread.lastRequest : "";
}

function itemPayload(item) {
	const raw = item?.raw ?? {};
	if (raw.request) return raw.request;
	if (raw.dialog) return raw.dialog;
	return null;
}

function capRaw(text) {
	const value = String(text ?? "");
	if (value.length <= RAW_CAP) return value;
	return `${value.slice(0, RAW_HEAD)}\n...(중략)...\n${value.slice(value.length - RAW_TAIL)}`;
}

/** A thread needs a model title unless it already has a Korean one (the phone list is read in Korean). */
function needsTitle(thread) {
	const hangul = /[가-힣]/;
	if (thread?.title && (hangul.test(thread.title) || thread.titleSource !== "session-name")) return false;
	return !hangul.test(String(thread?.sessionName ?? ""));
}

const EPISODE_MAX = 8000;
const EPISODE_FINAL_HEAD = 3000;
const EPISODE_FINAL_TAIL = 1500;
const EPISODE_OPENER = 600;
const EPISODE_LINES = 30;
const CLOSE_LABELS = { aborted: "중단", blocked: "막힘", done: "끝남", stalled: "멈춤", "needs-you": "내 차례" };

function threadFolder(thread) {
	return String(thread?.cwd ?? "")
		.split(/[\\/]+/)
		.filter(Boolean)
		.pop() ?? "";
}

/** HH:MM in the machine's timezone; --:-- when the stamp cannot be read. */
function clockTime(at) {
	const date = new Date(at);
	if (!Number.isFinite(date.getTime())) return "--:--";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function episodeFinalText(text) {
	const value = String(text ?? "");
	if (value.length <= EPISODE_FINAL_HEAD + EPISODE_FINAL_TAIL) return value;
	return `${value.slice(0, EPISODE_FINAL_HEAD)}\n...(중략)...\n${value.slice(value.length - EPISODE_FINAL_TAIL)}`;
}

/** The bounded digest that replaces the raw section for an episode final; null for ordinary items. */
function episodeDigest(item, episodeLines, budget = EPISODE_MAX) {
	const episode = item?.meta?.episode;
	if (!episode?.closeReason || !Array.isArray(episodeLines) || episodeLines.length === 0) return null;
	const oldest = episodeLines[0];
	const newest = episodeLines[episodeLines.length - 1];
	const stampAt = (line, fallback) => (Number.isFinite(line?.at) || typeof line?.at === "string" ? line.at : fallback);
	const questions = Number.isFinite(episode.questions) ? Math.max(0, Math.floor(episode.questions)) : 0;
	const interjections = Number.isFinite(episode.interjections) ? Math.max(0, Math.floor(episode.interjections)) : 0;
	const reason = CLOSE_LABELS[String(episode.closeReason)] ?? String(episode.closeReason);
	const shown = episodeLines.slice(-EPISODE_LINES);
	const hidden = episodeLines.length - shown.length;
	const out = [
		`이번 작업 구간: ${episodeLines.length}개 메시지, ${clockTime(stampAt(oldest, episode.openedAt))}~${clockTime(stampAt(newest, episode.closedAt))}, 끝난 이유: ${reason}, 중간 질문 ${questions}건, 사용자 개입 ${interjections}건`,
		`이번 요청: ${clip(String(item?.raw?.request ?? ""), EPISODE_OPENER)}`,
		"구간의 메시지별 한 줄:",
	];
	if (hidden > 0) out.push(`(앞선 ${hidden}건 생략)`);
	for (const line of shown) {
		const headline = clip(String(line?.headline ?? "").trim() || firstLine(line?.text), LIMITS.headline);
		out.push(`- ${clockTime(line?.at)} ${headline}`);
	}
	out.push("마지막 메시지 원문:", episodeFinalText(item?.raw?.final));
	return clip(out.join("\n"), budget);
}

export function buildSummaryRequest(item, thread = {}, options = {}) {
	const simpler = Boolean(options?.simpler);
	const goal = item?.raw?.goal;
	const lines = [
		`세션 제목: ${thread?.title || "(없음)"}`,
		`세션 폴더/브랜치: ${[threadFolder(thread) || "(없음)", thread?.branch].filter(Boolean).join(" / ") || "(없음)"}`,
		`이번 작업의 제품: ${thread?.product || "(없음)"}`,
		`사용자의 첫 요청: ${thread?.firstRequest || "(없음)"}`,
		`사용자의 마지막 요청: ${thread?.lastRequest || "(없음)"}`,
		`항목 종류: ${item?.kind ?? "turn"}`,
	];
	if (goal) lines.push(`진행 중 목표: ${goal.objective ?? goal.reason ?? ""}`);
	if (item?.meta?.stalled === true) lines.push("상태: 목표는 살아 있지만 이번 턴에 진전 신호가 없었다");
	const cwdName = threadFolder(thread);
	lines.push(`사용자가 이미 아는 말: ${[...KNOWN_TERMS, thread?.product, cwdName].filter(Boolean).join(", ")}`);
	const digest = episodeDigest(item, options.episodeLines, Math.max(1000, EPISODE_MAX - lines.join("\n").length - 200));
	if (digest) lines.push("", digest);
	else lines.push("", "요약할 원문:", capRaw(rawText(item, thread)));
	const payload = digest ? null : itemPayload(item);
	if (payload) lines.push("", "질문/대화 원문(JSON):", JSON.stringify(payload));
	if (needsTitle(thread)) {
		lines.push("", "이 스레드에는 아직 제목이 없다. title에 사용자 요청을 나타내는 24자 이하 한국어 명사구를 넣어라.");
	}
	const system = redact(simpler ? `${SUMMARY_SYSTEM_PROMPT}\n${SUMMARY_SIMPLER_PROMPT}` : SUMMARY_SYSTEM_PROMPT);
	const user = lines.join("\n");
	return { purpose: "summary", system, user: redact(digest ? clip(user, EPISODE_MAX) : user), maxTokens: MAX_TOKENS };
}

const SENTENCE_SPLIT = /(?<=[.!?。！？])\s+|\n+/;

function sentences(text) {
	return String(text ?? "")
		.split(SENTENCE_SPLIT)
		.map((part) => part.trim())
		.filter(Boolean);
}

function firstSentence(text) {
	const parts = sentences(text);
	return parts.length ? parts[0].replace(/[-–—]\s*$/, "").trim() : "";
}

function firstLine(text) {
	for (const line of String(text ?? "").split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

/** Heuristic headlines are plain text: drop **bold**, __bold__ and a leading heading mark. */
function stripMarkdownEmphasis(text) {
	return String(text ?? "")
		.replace(/\*\*/g, "")
		.replace(/__/g, "")
		.replace(/^\s*#{1,6}\s*/, "")
		.trim();
}

export function detectQuestion(text) {
	return QUESTION_RE.test(String(text ?? ""));
}

export function detectTodo(text) {
	return TODO_RE.test(String(text ?? ""));
}

function lastQuestionSentence(text) {
	const hits = sentences(text).filter((part) => QUESTION_RE.test(part));
	return hits.length ? hits[hits.length - 1] : "";
}

function lastTodoSentence(text) {
	const hits = sentences(text).filter((part) => TODO_RE.test(part));
	return hits.length ? hits[hits.length - 1] : "";
}

const CODE_FENCE = /```[\s\S]*?```/g;
const CODE_SPAN = /`[^`\n]*`/g;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"'`()[\],;]+/g;
const POSIX_PATH = /(?<![\w.-])\/(?:[\w.@+-]+\/)+[\w.@+-]*|(?<![\w.-])\/[\w.@+-]*\.[A-Za-z0-9]{1,8}/g;

export function stripPaths(text) {
	return String(text ?? "")
		.replace(CODE_FENCE, " ")
		.replace(CODE_SPAN, " ")
		.replace(WINDOWS_PATH, " ")
		.replace(POSIX_PATH, " ")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.join("\n")
		.trim();
}

export function parseHandoff(text) {
	const source = String(text ?? "");
	const re = /(?:^|[\s>*>])(Ask|wanted|For you|Now|Next)\s*:\s?/g;
	const hits = [];
	let match;
	while ((match = re.exec(source)) !== null) {
		hits.push({ key: HANDOFF_LABELS[match[1]], contentStart: re.lastIndex, index: match.index });
	}
	if (!hits.length) return null;
	const out = { ask: "", wanted: "", forYou: "", now: "", next: "" };
	hits.forEach((hit, i) => {
		const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
		out[hit.key] = source
			.slice(hit.contentStart, end)
			.replace(/[\s\-–—.。!?！？]+$/, "")
			.replace(/^[\s\-–—>]+/, "")
			.trim();
	});
	return out;
}

function summaryKindFor(itemKind) {
	if (KIND_ENUM.includes(itemKind)) return itemKind;
	if (itemKind === "turn") return "report";
	if (itemKind === "board" || itemKind === "notice") return "report";
	return "report";
}

// The no-answer line is a runtime fact (what the server does when nobody answers), never model prose.
function ifNoAnswerFor(item) {
	const raw = item?.raw ?? {};
	switch (item?.kind) {
		case "question": {
			// Runtime facts (ask-user tool.js): required only when true; waitForAnswer false keeps the agent working.
			const required = (raw.required ?? raw.request?.required) === true;
			const waits = (raw.waitForAnswer ?? raw.request?.waitForAnswer) !== false;
			if (required) return waits ? "답이 없으면 그 작업은 하지 않고 기다립니다" : "에이전트는 다른 일을 계속하고, 답이 없으면 그 작업은 하지 않습니다";
			const timeoutMs = Number(raw.request?.timeoutMs);
			const minutes = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.round(timeoutMs / 60_000)) : DEFAULT_TIMEOUT_MINUTES;
			return waits ? `${minutes}분 안에 답이 없으면 에이전트가 스스로 판단해 진행합니다` : `에이전트는 일을 계속하고, ${minutes}분 안에 답이 없으면 스스로 판단합니다`;
		}
		case "permission":
			return "답이 없으면 그 도구는 실행되지 않고 기다립니다";
		case "turn":
			if (item.policy && item.policy !== "needs-you") return null;
			return item.meta?.stalled === true ? "답이 없으면 goal이 멈춘 채로 있습니다" : "답이 없으면 세션은 이 상태로 기다립니다";
		case "blocked":
			return "답이 없으면 멈춘 채로 있습니다";
		default:
			return null;
	}
}

/** The option the question itself marks as recommended, when the summary does not name it yet. */
function missingRecommendation(summary, item) {
	if (item?.kind !== "question") return null;
	const request = item.raw?.request;
	const index = recommendedOption(request);
	if (index === null) return null;
	const options = (Array.isArray(request?.questions) ? request.questions : []).flatMap((question) => (Array.isArray(question?.options) ? question.options : []));
	const label = String(options[index]?.label ?? "").replace(/\s*\((권장|추천|Recommended)\)\s*/gi, "").trim();
	if (!label || String(summary.ask ?? "").includes(label) || String(summary.body ?? "").includes(label)) return null;
	return label;
}

export function finalizeSummary(summary, item, _thread = {}) {
	if (!summary || typeof summary !== "object") return summary;
	const label = missingRecommendation(summary, item);
	const body = label ? clip(`권장: ${label}. ${summary.body ?? ""}`.trim(), LIMITS.body) : summary.body;
	return { ...summary, body, ifNoAnswer: ifNoAnswerFor(item) };
}

function progressHeadline(item, text, handoff) {
	let candidate = handoff?.now ?? "";
	if (!candidate) {
		const parts = sentences(text);
		const skipped = parts.length > 1 && ROUTING_RE.test(parts[0]) ? parts.slice(1) : parts;
		candidate = skipped[0] || firstLine(text);
	}
	const cleaned = stripMarkdownEmphasis(candidate);
	if (HANGUL_RE.test(cleaned)) return clip(cleaned, LIMITS.headline);
	const reason = item?.state?.reasons?.[0] ?? item?.meta?.episode?.wait?.[0];
	// A hold reason is `hold:<source>`: it waits on the same thing as its source.
	const label = WAIT_LABELS[String(reason ?? "").replace(/^hold:/, "")];
	return label ? `대기: ${label}` : "진행 중";
}

export function heuristicSummary(item, thread = {}) {
	const text = rawText(item, thread);
	const handoff = parseHandoff(text);
	const headline =
		item?.kind === "progress"
			? progressHeadline(item, text, handoff)
			: clip(stripMarkdownEmphasis(firstSentence(handoff?.forYou ?? "") || firstLine(text) || thread?.title || ""), LIMITS.headline);
	const context = clip(`요청: ${thread?.firstRequest ?? ""}`, LIMITS.context);
	const body = clip(stripPaths(text), LIMITS.body);
	const ask = detectQuestion(text) ? textOrNull(lastQuestionSentence(text), LIMITS.ask) : detectTodo(text) ? textOrNull(lastTodoSentence(text), LIMITS.ask) : null;
	return {
		kind: summaryKindFor(item?.kind),
		headline,
		context,
		body,
		ask,
		options: [],
		ifNoAnswer: ifNoAnswerFor(item),
		terms: [],
		title: null,
	};
}

/** One Korean progress line for the Inbox list; the model request mirrors buildSummaryRequest's shape. */
export function buildLineRequest(item, thread = {}) {
	const lines = [
		`세션 제목: ${thread?.title || "(없음)"}`,
		`세션 폴더/브랜치: ${[threadFolder(thread), thread?.branch].filter(Boolean).join(" / ") || "(없음)"}`,
		`이번 작업의 제품: ${thread?.product || "(없음)"}`,
		`사용자의 첫 요청: ${thread?.firstRequest || "(없음)"}`,
		`사용자의 마지막 요청: ${thread?.lastRequest || "(없음)"}`,
		`항목 종류: ${item?.kind ?? "turn"}`,
	];
	const goal = item?.raw?.goal;
	if (goal) lines.push(`진행 중 목표: ${goal.objective ?? goal.reason ?? ""}`);
	if (item?.meta?.stalled === true) lines.push("상태: 목표는 살아 있지만 이번 턴에 진전 신호가 없었다");
	lines.push("", "이 메시지의 원문:", capRaw(rawText(item, thread)));
	return { purpose: "line", system: redact(LINE_SYSTEM_PROMPT), user: redact(lines.join("\n")), maxTokens: 80 };
}

/** Trim and clip a model line; null when it is empty or carries no Hangul. */
export function finalizeLine(text) {
	const value = stripMarkdownEmphasis(String(text ?? "").trim());
	if (!value || !HANGUL_RE.test(value)) return null;
	return clip(value, LIMITS.headline);
}

export function recommendedOption(request) {
	const questions = Array.isArray(request?.questions) ? request.questions : [];
	for (const question of questions) {
		const options = Array.isArray(question?.options) ? question.options : [];
		for (let i = 0; i < options.length; i++) {
			const label = String(options[i]?.label ?? "");
			const description = String(options[i]?.description ?? "");
			if (REC_MARKERS.some((marker) => label.includes(marker) || description.includes(marker))) return i;
		}
	}
	return null;
}
