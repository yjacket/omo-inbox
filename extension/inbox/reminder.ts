/**
 * omo-inbox report reminder: per window, its start time, the skip flag, whether it already reminded, and the visual
 * files edit or write tools touched (their repositories get checked too). Pure state; at the turn end capture.ts asks
 * git (visual.ts) and the server (GET /api/reported) with what check() returns.
 */
import { isVisualPath } from "./visual.ts";

export const REVIEW_REMINDER_TEXT = "[omo-inbox] 화면이 바뀐 작업인데 보고 Review가 없습니다. 바뀐 화면을 보고 Review로 올리세요(visual-board 스킬). 화면이 바뀌지 않았거나 사용자가 Review에서 이미 본 화면이면 그 이유를 한 줄로 적고 끝내세요.";

const SKIP = /Review 생략|보드 생략/;

function editPath(toolName: string, args: any): string {
	if (!/(?:^|[_-])(?:edit|write)$/i.test(toolName)) return "";
	const value = args?.path ?? args?.file_path ?? args?.filePath;
	return typeof value === "string" ? value : "";
}

export type ReminderCheck = { since: number, files: string[] };

export function createReminderWindow(startedAt = 0) {
	let since = startedAt;
	let skip = false;
	let reminded = false;
	const files = new Set<string>();

	return {
		/** Session start, an owner request (terminal input, phone delivery, board feedback) or a posted final starts a new window. */
		reset(at: number): void {
			since = at;
			skip = false;
			reminded = false;
			files.clear();
		},

		/** Any input's text can turn the reminder off for the window. */
		onInput(text: string): void {
			if (SKIP.test(text)) skip = true;
		},

		onToolStart(event: any): void {
			const target = editPath(String(event?.toolName ?? ""), event?.args);
			if (target.length > 0 && isVisualPath(target)) files.add(target);
		},

		/** What the turn end must check, or null when this window can't remind. */
		check(): ReminderCheck | null {
			return skip || reminded ? null : { since, files: [...files] };
		},

		markReminded(): void {
			reminded = true;
		},
	};
}
