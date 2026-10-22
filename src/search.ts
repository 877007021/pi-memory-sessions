/**
 * 三阶段检索。
 *
 *  ① tokenize → chars[] / grams[]
 *  ② 按 df 升序取最稀有的 3 个 chars 作锚点（df=0 的丢弃）
 *  ③ FTS5 chars:("a" "b" "c") ORDER BY rowid DESC LIMIT K   ← 早停，O(K)
 *  ③' 命中 0 → 锚点改 OR 重试一次
 *  ④ grams 覆盖率打分，ts 降序 tiebreak
 *
 * 为什么不用 ORDER BY bm25：它必须给所有命中行打分才能排序，
 * 实时语料上高频词 36ms 且随库线性增长；rowid 倒序能早停到 0.1ms。
 */

import type { DatabaseSync } from "node:sqlite";
import { termsOf } from "./tokenize.ts";

export interface Hit {
	id: number;
	sessionId: string;
	seq: number;
	ts: number;
	role: string;
	text: string;
	score: number;
	matched: number;
}

export interface SearchOptions {
	limit?: number;
	candidates?: number;
	project?: string;
	since?: number;
}

export interface SearchResult {
	hits: Hit[];
	anchors: string[];
	usedOr: boolean;
	grams: string[];
	elapsedMs: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const DEFAULT_CANDIDATES = 200;
const MAX_CANDIDATES = 2000;
const ANCHOR_COUNT = 3;
const DF_DRIFT = 0.02;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

/** 单字/单词都可能含双引号之外的安全字符，这里再兜一层。 */
function quote(term: string): string {
	return `"${term.replace(/"/g, '""')}"`;
}

export function createSearcher(db: DatabaseSync) {
	const dfCache = new Map<string, { df: number; snapshot: number }>();
	let snapshot = -1;
	let snapshotAt = 0;

	function messageCount(): number {
		const now = Date.now();
		if (snapshot >= 0 && now - snapshotAt < 5000) return snapshot;
		const row = db.prepare("select count(*) as c from msg").get() as { c: number };
		snapshot = Number(row.c);
		snapshotAt = now;
		return snapshot;
	}

	function df(term: string): number {
		const current = messageCount();
		const cached = dfCache.get(term);
		if (cached) {
			const drift = Math.abs(current - cached.snapshot) / Math.max(1, cached.snapshot);
			if (drift <= DF_DRIFT) return cached.df;
		}
		const row = db.prepare("select count(*) as c from msg_fts where msg_fts match ?").get(`chars:(${quote(term)})`) as {
			c: number;
		};
		const value = Number(row.c);
		dfCache.set(term, { df: value, snapshot: current });
		return value;
	}

	function runMatch(
		anchors: string[],
		joiner: " AND " | " OR ",
		candidates: number,
		options: SearchOptions,
	): Hit[] {
		const expression = `chars:(${anchors.map(quote).join(joiner)})`;
		const where: string[] = ["msg_fts match ?"];
		const params: Array<string | number> = [expression];

		if (options.project) {
			where.push("m.session_id in (select id from session where project = ?)");
			params.push(options.project);
		}
		if (options.since) {
			where.push("m.ts >= ?");
			params.push(options.since);
		}
		params.push(candidates);

		// 过滤条件会削弱早停效果，所以只在调用方显式给了过滤条件时才加
		return db
			.prepare(
				`select m.id, m.session_id, m.seq, m.ts, m.role, m.text
				 from msg_fts join msg m on m.id = msg_fts.rowid
				 where ${where.join(" and ")}
				 order by msg_fts.rowid desc
				 limit ?`,
			)
			.all(...params)
			.map((row: any) => ({
				id: Number(row.id),
				sessionId: row.session_id,
				seq: Number(row.seq),
				ts: Number(row.ts),
				role: row.role,
				text: row.text,
				score: 0,
				matched: 0,
			}));
	}

	return {
		df,
		messageCount,
		search(query: string, options: SearchOptions = {}): SearchResult {
			const startedAt = process.hrtime.bigint();
			const terms = termsOf(query);
			const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
			const candidates = clampInt(options.candidates, DEFAULT_CANDIDATES, limit, MAX_CANDIDATES);

			const empty: SearchResult = {
				hits: [],
				anchors: [],
				usedOr: false,
				grams: terms.grams,
				elapsedMs: 0,
			};
			if (!terms.chars.length) return empty;

			const ranked = terms.chars
				.map((term) => ({ term, count: df(term) }))
				.filter((entry) => entry.count > 0)
				.sort((a, b) => a.count - b.count);
			if (!ranked.length) return empty;

			const anchors = ranked.slice(0, ANCHOR_COUNT).map((entry) => entry.term);
			let hits = runMatch(anchors, " AND ", candidates, options);
			let usedOr = false;
			if (!hits.length && anchors.length > 1) {
				hits = runMatch(anchors, " OR ", candidates, options);
				usedOr = true;
			}

			const total = terms.grams.length;
			for (const hit of hits) {
				const lower = hit.text.toLowerCase();
				let matched = 0;
				for (const gram of terms.grams) if (lower.includes(gram)) matched++;
				hit.matched = matched;
				hit.score = total ? matched / total : 1;
			}
			hits.sort((a, b) => b.score - a.score || b.ts - a.ts);

			return {
				hits: hits.slice(0, limit),
				anchors,
				usedOr,
				grams: terms.grams,
				elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
			};
		},
	};
}

export type Searcher = ReturnType<typeof createSearcher>;
