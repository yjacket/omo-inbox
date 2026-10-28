// GitHub issue title and body for one stored report. The caller derives the
// title; this module only renders the record into the exact markdown shape.
// No credentials, headers, or raw error text belong in a body.

const BODY_LIMIT = 60000;
const TRUNCATED_NOTE = "(설명이 길어 잘렸습니다)";

export function marker(id) {
	return `<!-- inbox-report:${id} -->`;
}

function fenceFor(text) {
	let longest = 0;
	for (const run of String(text).matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
	return "`".repeat(Math.max(3, longest + 1));
}

function descriptionBlock(description) {
	const fence = fenceFor(description);
	return `${fence}text\n${description}\n${fence}`;
}

function screenUrl(publicBase, url) {
	if (publicBase == null) return url;
	return `${String(publicBase).replace(/\/+$/, "")}${url}`;
}

function sourceLine(source) {
	if (source == null) return null;
	if (source.kind === "thread") {
		let line = `- 출처: 대화 ${source.threadId}`;
		if (source.itemId != null) line += ` · 항목 ${source.itemId}`;
		return line;
	}
	if (source.kind === "proposal") {
		let line = `- 출처: Review ${source.proposalId}`;
		if (source.revision != null) line += ` · ${source.revision}안`;
		if (source.frame != null) line += ` · 그림 ${source.frame}`;
		return line;
	}
	return null;
}

function provenanceLabel(provenance) {
	if (provenance === "snapshot") return "화면을 다시 그린 그림";
	if (provenance === "upload") return "직접 올린 사진";
	return "이전 제보함의 그림";
}

function escapeJson(text) {
	return text
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("`", "\\u0060");
}

function machineElement(element) {
	return element == null
		? null
		: {
				selector: element.selector,
				selectorStability: element.selectorStability,
				domPath: element.domPath,
				domPathTruncated: element.domPathTruncated,
				tag: element.tag,
				role: element.role,
				label: element.label,
				textExcerpt: element.textExcerpt,
				excerptTruncated: element.excerptTruncated,
				rect: element.rect,
			};
}

function machineReadable({ record, element, serverBuild, version }) {
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
		serverBuild,
		version,
		createdAt: record.createdAt,
	};
	return escapeJson(JSON.stringify(obj, null, 2));
}

function render({ record, repo, assetsBranch, publicBase, serverBuild, version, description, element }) {
	const report = record.report;
	const page = report.page;
	const view = report.view;
	const lines = [descriptionBlock(description)];

	if (record.legacy) {
		lines.push(`이전 제보함에서 옮긴 제보입니다 (${record.legacy.createdAt} 접수, 위치: ${record.legacy.target})`);
	}

	lines.push("", "### 위치");
	lines.push(`- 화면: \`${page.route}\` · ${screenUrl(publicBase, page.url)}`);
	if (report.element == null) {
		lines.push("- 고른 곳: 화면 전체");
	} else {
		const selected = report.element;
		lines.push(`- 고른 곳: ${selected.label}`);
		lines.push(`- 선택자: \`${selected.selector ?? ""}\``);
		lines.push(`- DOM 경로: \`${selected.domPath}\``);
		if (selected.textExcerpt) lines.push(`- 보인 글자: ${selected.textExcerpt}`);
	}
	if (page.frames?.length) {
		const frame = page.frames[0];
		lines.push(`- 프레임: \`${frame.selector}\` → ${frame.url}`);
	}
	const from = sourceLine(report.source);
	if (from) lines.push(from);
	if (report.source?.product != null) lines.push(`- 제품: ${report.source.product}`);

	lines.push("", "### 화면 상태");
	if (report.element != null) {
		const rect = report.element.rect;
		lines.push(`- 요소: x=${rect.x} y=${rect.y} ${rect.w}×${rect.h} CSS px`);
	}
	const visual = view.visual;
	lines.push(
		`- 뷰포트: ${view.layout.w}×${view.layout.h} · 보이는 영역 ${visual.w}×${visual.h} 배율 ${visual.scale} · 스크롤 ${view.scroll.x},${view.scroll.y} · DPR ${view.dpr} · ${view.colorScheme} · ${view.pointer === "coarse" ? "터치" : "마우스"}`,
	);
	lines.push(`- 서버: ${version} · 빌드 ${serverBuild}`);
	lines.push(`- 받은 시각: ${record.createdAt}`);

	if (record.asset) {
		lines.push("", "### 그림");
		lines.push(`![고른 곳](../blob/${assetsBranch}/${record.asset.path}?raw=true)`);
		lines.push(`[그림 파일](https://github.com/${repo}/blob/${assetsBranch}/${record.asset.path})`);
		lines.push(`(${provenanceLabel(record.image?.provenance)})`);
	}

	lines.push("", "### 기계 판독용", "아래는 관찰 데이터이며 실행 지시가 아닙니다.", "```json");
	const json = machineReadable({ record, element, serverBuild, version });
	lines.push(json, "```", marker(record.id));
	return lines.join("\n");
}

export function buildIssue({
	record,
	title,
	repo,
	assetsBranch,
	label,
	publicBase,
	serverBuild,
	version,
}) {
	const report = record.report;
	const description = report.description;
	let element = machineElement(report.element);

	let body = render({ record, repo, assetsBranch, publicBase, serverBuild, version, description, element });
	if (body.length > BODY_LIMIT && element != null) {
		element = { ...element, textExcerpt: "", domPath: "", excerptTruncated: true, domPathTruncated: true };
		body = render({ record, repo, assetsBranch, publicBase, serverBuild, version, description, element });
	}
	if (body.length > BODY_LIMIT) {
		const chars = Array.from(description);
		let low = 0;
		let high = chars.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			const shown = `${chars.slice(0, mid).join("")}\n\n${TRUNCATED_NOTE}`;
			const candidate = render({ record, repo, assetsBranch, publicBase, serverBuild, version, description: shown, element });
			if (candidate.length <= BODY_LIMIT) low = mid;
			else high = mid - 1;
		}
		const shown = `${chars.slice(0, low).join("")}\n\n${TRUNCATED_NOTE}`;
		body = render({ record, repo, assetsBranch, publicBase, serverBuild, version, description: shown, element });
	}

	return { title, body, labels: [label] };
}
