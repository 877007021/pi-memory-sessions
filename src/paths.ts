/**
 * 库文件与会话源的位置。
 *
 * 会话源必须跟随 pi 自己的配置：硬编码 `~/.pi/agent/sessions`
 * 在容器里（$HOME 不是 pi 的 agent 目录）永远扫不到东西，表现为
 * “/recall import 导入了 0 个文件”，而不是报错。
 */

import * as os from "node:os";
import * as path from "node:path";

export function dbFile(): string {
	return process.env.PI_MEMORY_DB || path.join(os.homedir(), ".pi", "memory", "sessions.db");
}

export function sessionsRoot(): string {
	if (process.env.PI_MEMORY_SESSIONS_DIR) return process.env.PI_MEMORY_SESSIONS_DIR;
	if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
	return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions");
}
