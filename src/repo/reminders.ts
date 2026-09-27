/**
 * D1 への SQL はこのファイル（`src/repo/`）にだけ書く。
 *
 * このクラスは時計を読まない。現在時刻は必ず呼び出し側が `now`（保存形式の
 * 日本時間文字列）として渡す。
 */

export type ReminderKind = "explicit" | "auto";

export interface Reminder {
	id: string;
	body: string;
	showAt: string;
	dueAt: string | null;
	note: string | null;
	kind: ReminderKind;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}

/** `takeBoard` が返す、表示に必要な列だけの行。 */
export type BoardItem = Pick<Reminder, "id" | "body" | "showAt" | "dueAt" | "kind">;

export interface InsertReminderInput {
	body: string;
	showAt?: string;
	dueAt?: string | null;
	note?: string | null;
	kind: ReminderKind;
}

/** キーがあれば更新、無ければ現状維持。`dueAt` と `note` は `null` で消去。 */
export interface UpdateReminderPatch {
	body?: string;
	showAt?: string;
	dueAt?: string | null;
	note?: string | null;
}

export interface BoardCheckRecord {
	checkedAt: string;
	returnedCount: number;
	ok: boolean;
	errorCode?: string | null;
	durationMs: number;
}

interface ReminderRow {
	id: string;
	body: string;
	show_at: string;
	due_at: string | null;
	note: string | null;
	kind: string;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}

function toReminder(row: ReminderRow): Reminder {
	return {
		id: row.id,
		body: row.body,
		showAt: row.show_at,
		dueAt: row.due_at,
		note: row.note,
		kind: row.kind as ReminderKind,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		archivedAt: row.archived_at,
	};
}

function toBoardItem(row: Pick<ReminderRow, "id" | "body" | "show_at" | "due_at" | "kind">): BoardItem {
	return {
		id: row.id,
		body: row.body,
		showAt: row.show_at,
		dueAt: row.due_at,
		kind: row.kind as ReminderKind,
	};
}

/** アクティブ（未取得・未削除）を選ぶ条件。 */
const ACTIVE = "archived_at IS NULL AND deleted_at IS NULL";

export class ReminderRepo {
	constructor(private readonly db: D1Database) {}

	/**
	 * 表示時刻を過ぎたアクティブなリマインダーを取得し、同じ 1 文でアーカイブする。
	 * 事前の SELECT は発行しない（二重表示を構造的に防ぐため）。並べ替えはしない。
	 */
	async takeBoard(now: string): Promise<BoardItem[]> {
		const { results } = await this.db
			.prepare(
				`UPDATE reminders SET archived_at = ?1
				 WHERE archived_at IS NULL AND deleted_at IS NULL AND show_at <= ?1
				 RETURNING id, body, show_at, due_at, kind`,
			)
			.bind(now)
			.all<Pick<ReminderRow, "id" | "body" | "show_at" | "due_at" | "kind">>();
		return results.map(toBoardItem);
	}

	/**
	 * 参照記録。`takeBoard` と `db.batch()` でまとめない（記録に失敗しても
	 * 取得結果を失わないため）。
	 */
	async recordCheck(record: BoardCheckRecord): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO board_checks (checked_at, returned_count, ok, error_code, duration_ms)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(
				record.checkedAt,
				record.returnedCount,
				record.ok ? 1 : 0,
				record.errorCode ?? null,
				record.durationMs,
			)
			.run();
	}

	/** 登録。`showAt` が省略または `now` より前なら `now` にする（過去指定は即時表示）。 */
	async insert(input: InsertReminderInput, now: string): Promise<Reminder> {
		const showAt = input.showAt === undefined || input.showAt < now ? now : input.showAt;
		const id = crypto.randomUUID();
		const { results } = await this.db
			.prepare(
				`INSERT INTO reminders (id, body, show_at, due_at, note, kind, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 RETURNING id, body, show_at, due_at, note, kind, created_at, updated_at, archived_at`,
			)
			.bind(id, input.body, showAt, input.dueAt ?? null, input.note ?? null, input.kind, now, now)
			.all<ReminderRow>();
		return toReminder(results[0]);
	}

	/** 待機中（表示時刻がまだ来ていない）を表示時刻順。 */
	async listWaiting(now: string): Promise<Reminder[]> {
		const { results } = await this.db
			.prepare(
				`SELECT id, body, show_at, due_at, note, kind, created_at, updated_at, archived_at
				 FROM reminders WHERE ${ACTIVE} AND show_at > ? ORDER BY show_at`,
			)
			.bind(now)
			.all<ReminderRow>();
		return results.map(toReminder);
	}

	/** アクティブ全件を表示時刻順（重複登録の確認用）。 */
	async listActive(): Promise<Reminder[]> {
		const { results } = await this.db
			.prepare(
				`SELECT id, body, show_at, due_at, note, kind, created_at, updated_at, archived_at
				 FROM reminders WHERE ${ACTIVE} ORDER BY show_at`,
			)
			.all<ReminderRow>();
		return results.map(toReminder);
	}

	/** アーカイブ済みを取得日時の新しい順。 */
	async listArchived(limit: number): Promise<Reminder[]> {
		const { results } = await this.db
			.prepare(
				`SELECT id, body, show_at, due_at, note, kind, created_at, updated_at, archived_at
				 FROM reminders WHERE archived_at IS NOT NULL AND deleted_at IS NULL
				 ORDER BY archived_at DESC LIMIT ?`,
			)
			.bind(limit)
			.all<ReminderRow>();
		return results.map(toReminder);
	}

	/**
	 * アクティブな行の更新。`showAt` が `now` より前なら `now` に置き換える。
	 * 対象が無ければ（存在しない・アーカイブ済み・削除済み）`null`。
	 */
	async update(id: string, patch: UpdateReminderPatch, now: string): Promise<Reminder | null> {
		const columns: string[] = [];
		const values: unknown[] = [];

		if (patch.body !== undefined) {
			columns.push("body = ?");
			values.push(patch.body);
		}
		if (patch.showAt !== undefined) {
			columns.push("show_at = ?");
			values.push(patch.showAt < now ? now : patch.showAt);
		}
		if ("dueAt" in patch) {
			columns.push("due_at = ?");
			values.push(patch.dueAt ?? null);
		}
		if ("note" in patch) {
			columns.push("note = ?");
			values.push(patch.note ?? null);
		}

		columns.push("updated_at = ?");
		values.push(now);

		const { results } = await this.db
			.prepare(
				`UPDATE reminders SET ${columns.join(", ")} WHERE id = ? AND ${ACTIVE}
				 RETURNING id, body, show_at, due_at, note, kind, created_at, updated_at, archived_at`,
			)
			.bind(...values, id)
			.all<ReminderRow>();
		return results.length === 0 ? null : toReminder(results[0]);
	}

	/** 論理削除。対象が無ければ `false`。 */
	async softDelete(id: string, now: string): Promise<boolean> {
		const { results } = await this.db
			.prepare(`UPDATE reminders SET deleted_at = ? WHERE id = ? AND ${ACTIVE} RETURNING id`)
			.bind(now, id)
			.all<{ id: string }>();
		return results.length > 0;
	}
}
