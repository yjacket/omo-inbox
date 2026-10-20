const cropJoin = (dir, file) => (!dir ? file : dir.endsWith("/") ? `${dir}${file}` : `${dir}/${file}`);

const answerLine = (board, answers) => {
	const questions = Array.isArray(board?.questions) ? board.questions : [];
	return Object.entries(answers ?? {})
		.map(([qid, value]) => {
			const question = questions.find((q) => q.id === qid);
			const option = question?.options?.find((o) => o.value === value);
			return `${question ? question.text : qid} -> ${option ? option.label : value}`;
		})
		.join("; ");
};

const revLabel = (summary, rev) => (summary?.kind === "report" ? `갱신 ${rev}` : `${rev}안`);

const verdictLabel = (verdict) => (verdict === "approve" ? "승인" : verdict === "ack" ? "확인" : "재요청");

export function feedbackMessage({ summary, board, event, url, cropDir, cli }) {
	const lines = [
		`[omo-inbox] 의견이 왔습니다: ${summary.title} (${summary.id}, ${revLabel(summary, event.rev)}, #${event.seq})`,
		`판단: ${verdictLabel(event.verdict)}`,
	];
	const answers = answerLine(board, event.answers);
	if (answers) lines.push(`답: ${answers}`);
	if (event.comment) lines.push(`전체 의견: ${event.comment}`);
	for (const mark of event.marks ?? []) {
		let line = `표시 ${mark.n} (${mark.frame})`;
		if (mark.comment) line += `: ${mark.comment}`;
		if (mark.crop) line += ` | 그림: ${cropJoin(cropDir, mark.crop)}`;
		lines.push(line);
	}
	if (event.rev < summary.rev) {
		lines.push(`현재 안은 ${revLabel(summary, summary.rev)}입니다 (이 의견은 ${revLabel(summary, event.rev)} 기준)`);
	}
	if (url) lines.push(`보기: ${url}`);
	if (event.verdict === "change") {
		lines.push(`처리: ${cli} show ${summary.id} 로 전체를 읽고 ${cli} revise 로 수정안을 올리세요. 재요청은 승인이 아닙니다: 확정하거나 작업을 시작하지 마세요.`);
	} else {
		lines.push(`처리: ${cli} show ${summary.id} 로 전체를 읽고 ${cli} reply / revise / close 로 답하세요.`);
	}
	return lines.join("\n");
}

export function pendingNotice(items, cli) {
	if (!items || items.length === 0) return null;
	const lines = [`[omo-inbox] 이 워크트리에 답을 기다리는 Review가 ${items.length}건 있습니다.`];
	for (const item of items) {
		lines.push(`- ${item.title} (${item.id}) ${item.url} -> ${cli} show ${item.id}`);
	}
	return lines.join("\n");
}

// IS-16: `🙋 N` counts sessions waiting on the user, `🤖 M` counts this session's boards waiting on the session.
// A zero side is left out; the extension shows `Inbox 서버 꺼짐` itself when the server is down.
export function footerText({ waiting, boards }) {
	return [waiting ? `🙋 ${waiting}` : "", boards ? `🤖 ${boards}` : ""].filter(Boolean).join(" ");
}
