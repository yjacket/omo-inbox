/**
 * omo-inbox report reminder: per input window, notes whether the work changed something visible and whether a
 * board was submitted, so the capture's turn end can remind the agent once to post a report Review.
 * Pure state; capture.ts feeds it events and asks it at the close.
 */

export const REVIEW_REMINDER_TEXT = "[omo-inbox] 화면이 바뀐 작업인데 보고 Review가 없습니다. 바뀐 화면을 보고 Review로 올리세요(visual-board 스킬). 화면이 바뀌지 않았거나 사용자가 Review에서 이미 본 화면이면 그 이유를 한 줄로 적고 끝내세요.";

const SCAN_LIMIT = 64 * 1024;
const VISUAL_PATH = /\.(?:html?|css|scss|sass|less|vue|svelte|jsx|tsx)$/i;
const TEMPLATES_SEGMENT = /(?:^|[\\/])templates[\\/]/i;
const BOARD_COMMAND = /inbox(?:\.mjs)?["']?\s+(?:submit|revise)\b/;
const SKIP = /Review 생략|보드 생략/;

/** Every string value inside `value`, joined by newlines, up to SCAN_LIMIT characters. */
function flatText(value: unknown): string {
	const parts: string[] = [];
	let size = 0;
	const walk = (node: unknown, depth: number): void => {
		if (size >= SCAN_LIMIT || depth > 8) return;
		if (typeof node === "string") {
			parts.push(node);
			size += node.length + 1;
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child, depth + 1);
	};
	walk(value, 0);
	return parts.join("\n").slice(0, SCAN_LIMIT);
}

function hasImage(result: any): boolean {
	const content = result?.content;
	return Array.isArray(content) && content.some((part: any) => part?.type === "image");
}

function editPath(toolName: string, args: any): string {
	if (!/(?:^|[_-])(?:edit|write)$/i.test(toolName)) return "";
	const value = args?.path ?? args?.file_path ?? args?.filePath;
	return typeof value === "string" ? value : "";
}

export function createReminderWindow() {
	let visual = false;
	let board = false;
	let skip = false;
	let reminded = false;

	return {
		/** An owner request (terminal input, phone delivery, board feedback) starts a new window. */
		reset(): void {
			visual = false;
			board = false;
			reminded = false;
			skip = false;
		},

		/** Any input's text can turn the reminder off for the window. */
		onInput(text: string): void {
			if (SKIP.test(text)) skip = true;
		},

		onToolStart(event: any): void {
			const toolName = String(event?.toolName ?? "");
			const args = flatText(event?.args);
			if (BOARD_COMMAND.test(args)) board = true;
			const target = editPath(toolName, event?.args);
			if (target.length > 0 && (VISUAL_PATH.test(target) || TEMPLATES_SEGMENT.test(target))) visual = true;
		},

		onToolEnd(event: any): void {
			// A word in a message is not a changed screen: only an image the session looked at counts.
			if (hasImage(event?.result)) visual = true;
		},

		/** True once per window when the work looked visual and no board was posted; the caller then reminds. */
		take(): boolean {
			if (!visual || board || skip || reminded) return false;
			reminded = true;
			return true;
		},
	};
}
