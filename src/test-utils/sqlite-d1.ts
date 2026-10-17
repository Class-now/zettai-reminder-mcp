/**
 * テスト専用の D1 代替。Node 内蔵の `node:sqlite` の上に、`ReminderRepo` が使う
 * 範囲の `D1Database`（`prepare().bind().first()/all()/run()`）だけを実装する。
 *
 * Worker のバンドルには入れない（`src/index.ts` から到達しない）。
 */

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

// workers-types の URL と node の URL が衝突するため、文字列にしてから渡す
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url).href);

/** D1 の `meta` は使っていないので、形だけ揃えた最小の値を返す。 */
function meta(changes = 0, lastRowId = 0) {
	return {
		duration: 0,
		size_after: 0,
		rows_read: 0,
		rows_written: changes,
		last_row_id: lastRowId,
		changed_db: changes > 0,
		changes,
	};
}

function toBindValue(value: unknown): SQLInputValue {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
		return value;
	}
	throw new TypeError(`D1 に渡せない値です: ${String(value)}`);
}

/** null プロトタイプの行を普通のオブジェクトに直す。 */
function plain(row: Record<string, unknown>): Record<string, unknown> {
	return { ...row };
}

class TestPreparedStatement {
	private values: SQLInputValue[] = [];

	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
	) {}

	bind(...values: unknown[]): TestPreparedStatement {
		const next = new TestPreparedStatement(this.db, this.sql);
		next.values = values.map(toBindValue);
		return next;
	}

	async all(): Promise<{ results: unknown[]; success: true; meta: ReturnType<typeof meta> }> {
		const rows = this.db.prepare(this.sql).all(...this.values) as Record<string, unknown>[];
		return { results: rows.map(plain), success: true, meta: meta(rows.length) };
	}

	async first(colName?: string): Promise<unknown> {
		const { results } = await this.all();
		if (results.length === 0) {
			return null;
		}
		const row = results[0] as Record<string, unknown>;
		return colName === undefined ? row : (row[colName] ?? null);
	}

	async run(): Promise<{ results: unknown[]; success: true; meta: ReturnType<typeof meta> }> {
		const result = this.db.prepare(this.sql).run(...this.values);
		return {
			results: [],
			success: true,
			meta: meta(Number(result.changes), Number(result.lastInsertRowid)),
		};
	}
}

class TestD1 {
	constructor(private readonly db: DatabaseSync) {}

	prepare(sql: string): TestPreparedStatement {
		return new TestPreparedStatement(this.db, sql);
	}

	close(): void {
		this.db.close();
	}
}

export type TestD1Database = D1Database & { close(): void };

/** `migrations/` の SQL を番号順にすべて適用した空のインメモリ DB を返す。 */
export function createTestD1(): TestD1Database {
	const db = new DatabaseSync(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		db.exec(readFileSync(MIGRATIONS_DIR + file, "utf8"));
	}
	return new TestD1(db) as unknown as TestD1Database;
}
