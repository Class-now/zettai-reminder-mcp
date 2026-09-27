/**
 * `scripts/latency-report.sql` の集計が正しいかを、テスト用 D1 に入れた
 * `board_checks` の行で確かめる。SQL 自体をファイルから読んで実行するので、
 * SQL を直せばここが追随する。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestD1, type TestD1Database } from "../src/test-utils/sqlite-d1";

const REPORT_SQL = readFileSync(
	fileURLToPath(new URL("./latency-report.sql", import.meta.url).href),
	"utf8",
);

interface ReportRow {
	bucket: string;
	checks: number;
	avg_ms: number | null;
	max_ms: number | null;
	budget_ms: number;
	over_budget: number;
}

let db: TestD1Database;

async function insertCheck(returnedCount: number, ok: 0 | 1, durationMs: number): Promise<void> {
	await db
		.prepare(
			"INSERT INTO board_checks (checked_at, returned_count, ok, error_code, duration_ms) VALUES (?, ?, ?, ?, ?)",
		)
		.bind("2026-10-03T10:00:00+09:00", returnedCount, ok, ok === 1 ? null : "DB_ERROR", durationMs)
		.run();
}

async function report(): Promise<Record<string, ReportRow>> {
	const { results } = await db.prepare(REPORT_SQL).all<ReportRow>();
	return Object.fromEntries(results.map((row) => [row.bucket, row]));
}

beforeEach(() => {
	db = createTestD1();
});

afterEach(() => {
	db.close();
});

describe("latency-report.sql", () => {
	it("行が 1 つも無いときは 0 件・NULL・超過 0 を返す", async () => {
		const rows = await report();

		expect(Object.keys(rows)).toEqual(["empty", "non_empty"]);
		expect(rows.empty).toEqual({
			bucket: "empty",
			checks: 0,
			avg_ms: null,
			max_ms: null,
			budget_ms: 100,
			over_budget: 0,
		});
		expect(rows.non_empty).toEqual({
			bucket: "non_empty",
			checks: 0,
			avg_ms: null,
			max_ms: null,
			budget_ms: 500,
			over_budget: 0,
		});
	});

	it("空ボードと非空を分けて件数・平均・最大を集計する", async () => {
		// 空ボード: 40, 60, 140 → 3 件、平均 80、最大 140、100ms 超過 1 件
		await insertCheck(0, 1, 40);
		await insertCheck(0, 1, 60);
		await insertCheck(0, 1, 140);
		// 非空: 200, 600, 900 → 3 件、平均 566.7、最大 900、500ms 超過 2 件
		await insertCheck(1, 1, 200);
		await insertCheck(3, 1, 600);
		await insertCheck(2, 1, 900);

		const rows = await report();

		expect(rows.empty).toEqual({
			bucket: "empty",
			checks: 3,
			avg_ms: 80,
			max_ms: 140,
			budget_ms: 100,
			over_budget: 1,
		});
		expect(rows.non_empty).toEqual({
			bucket: "non_empty",
			checks: 3,
			avg_ms: 566.7,
			max_ms: 900,
			budget_ms: 500,
			over_budget: 2,
		});
	});

	it("失敗した呼び出し（ok = 0）はどちらの集計にも入らない", async () => {
		await insertCheck(0, 1, 50);
		await insertCheck(0, 0, 3000);
		await insertCheck(2, 0, 4000);

		const rows = await report();

		expect(rows.empty.checks).toBe(1);
		expect(rows.empty.max_ms).toBe(50);
		expect(rows.empty.over_budget).toBe(0);
		expect(rows.non_empty.checks).toBe(0);
		expect(rows.non_empty.max_ms).toBeNull();
	});

	it("budget ちょうどは超過に数えず、1ms 超えたら数える", async () => {
		await insertCheck(0, 1, 100);
		await insertCheck(0, 1, 101);
		await insertCheck(1, 1, 500);
		await insertCheck(1, 1, 501);

		const rows = await report();

		expect(rows.empty.over_budget).toBe(1);
		expect(rows.non_empty.over_budget).toBe(1);
	});
});
