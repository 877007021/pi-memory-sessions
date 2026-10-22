/**
 * 一次性导入：把已有 session jsonl 灌进自己的库。
 *
 * 只在这里读 jsonl。导入完成后运行路径完全不依赖它。
 * 分批提交 + 批间让出事件循环：node:sqlite 是同步 API，
 * 一次性灌十万条会把 pi 的事件循环卡住十几秒并长期持锁。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, maxSeq, messageHash, projectOf, upsertSession } from "./db.ts";
import { renderMessage, renderSummary } from "./render.ts";

const BATCH = 200;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

export interface ImportResult {
	files: number;
	inserted: number;
	skipped: number;
	failed: number;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export function findSessionFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

export async function importSessions(
	db: DatabaseSync,
	root: string,
	onProgress?: (info: { file: string; inserted: number }) => void,
): Promise<ImportResult> {
	const result: ImportResult = { files: 0, inserted: 0, skipped: 0, failed: 0 };
	const files = findSessionFiles(root);

	for (const file of files) {
		result.files++;
		let raw: string;
		try {
			if (fs.statSync(file).size > MAX_FILE_BYTES) {
				result.failed++;
				continue;
			}
			raw = fs.readFileSync(file, "utf8");
		} catch {
			result.failed++;
			continue;
		}

		let sessionId = "";
		let cwd = "";
		let startedAt = 0;
		let lastAt = 0;
		let pending = 0;
		let seq = 0;

		db.exec("begin immediate");
		try {
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				let entry: any;
				try {
					entry = JSON.parse(line);
				} catch {
					continue; // 半行 / 坏行：跳过，不中断整文件
				}

				if (entry.type === "session") {
					sessionId = String(entry.id ?? "");
					cwd = String(entry.cwd ?? "");
					startedAt = Date.parse(entry.timestamp ?? "") || Date.now();
					lastAt = startedAt;
					if (sessionId) {
						upsertSession(db, {
							id: sessionId,
							cwd,
							project: projectOf(cwd || "."),
							startedAt,
							lastAt,
							name: null,
						});
						seq = maxSeq(db, sessionId);
					}
					continue;
				}
				if (!sessionId) continue;

				let rendered: { role: any; text: string; meta?: Record<string, unknown> } | null = null;
				let ts = Date.parse(entry.timestamp ?? "") || startedAt;

				if (entry.type === "message" && entry.message) {
					rendered = renderMessage(entry.message);
					if (typeof entry.message.timestamp === "number") ts = entry.message.timestamp;
				} else if (entry.type === "compaction" && typeof entry.summary === "string") {
					rendered = renderSummary(entry.summary);
				}
				if (!rendered) continue;

				seq++;
				const hash = messageHash(sessionId, rendered.role, ts, rendered.text);
				if (insertMessage(db, { sessionId, seq, ts, role: rendered.role, text: rendered.text, hash, meta: rendered.meta })) {
					result.inserted++;
					lastAt = Math.max(lastAt, ts);
				} else {
					result.skipped++;
				}

				if (++pending >= BATCH) {
					pending = 0;
					db.exec("commit");
					await yieldToLoop();
					db.exec("begin immediate");
				}
			}

			if (sessionId) {
				upsertSession(db, { id: sessionId, cwd, project: projectOf(cwd || "."), startedAt, lastAt, name: null });
			}
			db.exec("commit");
		} catch (error) {
			try {
				db.exec("rollback");
			} catch {
				// 已经回滚/未开启
			}
			result.failed++;
		}

		onProgress?.({ file, inserted: result.inserted });
		await yieldToLoop();
	}

	return result;
}
