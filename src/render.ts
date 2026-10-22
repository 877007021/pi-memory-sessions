/**
 * 消息 → 可读 markdown。
 *
 * 存储形态是渲染后的文本，不是原始 JSON：
 * session_read 拼起来就是一份能直接读的对话，零重组逻辑。
 *
 * 不做任何脱敏：这是本地私有库，打码会让内容不可搜（想搜 token 变量名就搜不到）。
 */

export type MemRole = "user" | "assistant" | "tool_error" | "summary";

export interface Rendered {
	role: MemRole;
	text: string;
	meta?: Record<string, unknown>;
}

const TOOL_ARG_MAX = 300;
const TOOL_ERROR_MAX = 500;
const TEXT_MAX = 20000;

function finish(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > TEXT_MAX ? `${trimmed.slice(0, TEXT_MAX)}…` : trimmed;
}

function blocksToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: unknown };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "image") parts.push("[图片]");
	}
	return parts.join("\n");
}

function renderToolCall(call: { name?: unknown; arguments?: unknown }): string {
	const name = typeof call.name === "string" ? call.name : "tool";
	let args = "";
	try {
		args = JSON.stringify(call.arguments ?? {});
	} catch {
		args = "{}";
	}
	if (args.length > TOOL_ARG_MAX) args = `${args.slice(0, TOOL_ARG_MAX)}…`;
	return `→ ${name}(${args})`;
}

/** 返回 null 表示这条消息不进入记忆库。 */
export function renderMessage(message: unknown): Rendered | null {
	if (!message || typeof message !== "object") return null;
	const msg = message as Record<string, any>;

	switch (msg.role) {
		case "user": {
			const text = finish(blocksToText(msg.content));
			return text ? { role: "user", text } : null;
		}

		case "assistant": {
			const texts: string[] = [];
			const calls: string[] = [];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!block || typeof block !== "object") continue;
					if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
						texts.push(block.text.trim());
					} else if (block.type === "toolCall") {
						calls.push(renderToolCall(block));
					}
					// thinking 块刻意跳过：不进检索，也不占体积
				}
			}
			const text = finish([...texts, ...calls].join("\n"));
			if (!text) return null;
			const meta: Record<string, unknown> = {};
			if (typeof msg.model === "string") meta.model = msg.model;
			if (calls.length) meta.toolCalls = calls.length;
			return {
				role: "assistant",
				text,
				meta: Object.keys(meta).length ? meta : undefined,
			};
		}

		case "toolResult": {
			// 成功的工具输出不存：占原始体积 90%，信息密度最低
			if (!msg.isError) return null;
			const body = blocksToText(msg.content).slice(0, TOOL_ERROR_MAX);
			const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
			return {
				role: "tool_error",
				text: finish(`✗ ${name}: ${body}`),
				meta: { tool: name, isError: true },
			};
		}

		default:
			// system / custom / bashExecution / branchSummary 不进入 v1 记忆库
			return null;
	}
}

/** compaction 摘要单独走这条路（它不是 message）。 */
export function renderSummary(summary: string): Rendered | null {
	const text = finish(summary ?? "");
	return text ? { role: "summary", text } : null;
}
