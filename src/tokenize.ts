/**
 * 双通道分词。
 *
 * chars（召回通道）= 中文单字 + 拉丁词
 * grams（精度通道）= 中文双字 + 拉丁词
 *
 * 不用词典：索引里的 token 必须能被 count(*) 当作锚点，单字天然稀疏；
 * 跨词双字（"的缓"）虽然稀有，但只在 grams 通道里参与打分、永不作为锚点。
 */

export interface Terms {
	chars: string[];
	grams: string[];
}

// 含 CJK 扩展 A/B 与兼容区：扩展区在 BMP 之外，必须用 u 标志才能按码点匹配
const RUN = /[a-z0-9_]{2,}|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{3134f}]+/gu;

export function termsOf(input: string): Terms {
	const chars = new Set<string>();
	const grams = new Set<string>();
	if (!input) return { chars: [], grams: [] };

	for (const m of input.toLowerCase().matchAll(RUN)) {
		const token = m[0];
		if (token.charCodeAt(0) < 0x80) {
			chars.add(token);
			grams.add(token);
			continue;
		}
		// 按码点切，避免把代理对拆开（CJK 扩展区在 BMP 之外）
		const cps = [...token];
		for (const ch of cps) chars.add(ch);
		for (let i = 0; i < cps.length - 1; i++) grams.add(cps[i] + cps[i + 1]);
	}

	return { chars: [...chars], grams: [...grams] };
}

/** 写进 FTS 的两列。 */
export function indexTokens(t: Terms): { chars: string; grams: string } {
	return { chars: t.chars.join(" "), grams: t.grams.join(" ") };
}
