/**
 * MCP ツールの中身（純粋なサービス層）。`ReminderRepo` と時計だけに依存し、
 * MCP の型には依存しない（テストから直接呼べるようにするため）。
 *
 * Claude に計算や整形をさせない値（並び順・残り日数・表示用の 1 行・確認文）は
 * すべてこの層で作る。
 */

import {
	daysUntil,
	formatMonthDay,
	formatMonthDayTime,
	nowJst,
	parseJstDateTime,
	parseJstDue,
} from "../lib/datetime";
import type {
	BoardCheckRecord,
	BoardItem,
	Reminder,
	ReminderKind,
	ReminderRepo,
	UpdateReminderPatch,
} from "../repo/reminders";

export type ErrorCode = "INVALID_DATETIME" | "VALIDATION_ERROR" | "NOT_FOUND" | "DB_ERROR";

export class ServiceError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ServiceError";
	}
}

export type ReminderStatus = "waiting" | "active" | "archived";

/** ツールの入力はそのまま snake_case で受け取る（MCP の入力スキーマと同じ形）。 */
export interface AddReminderInput {
	body: string;
	kind: ReminderKind;
	show_at?: string;
	due_at?: string;
	note?: string;
}

export interface ListRemindersInput {
	status: ReminderStatus;
	limit?: number;
}

/** `due_at` と `note` は `null` で消去、省略（`undefined`）は現状維持。 */
export interface UpdateReminderInput {
	id: string;
	body?: string;
	show_at?: string;
	due_at?: string | null;
	note?: string | null;
}

export interface BoardResponseItem {
	id: string;
	body: string;
	due_at: string | null;
	days_left: number | null;
	show_at: string;
	kind: ReminderKind;
	line: string;
}

export interface CheckBoardResult {
	count: number;
	items: BoardResponseItem[];
}

export interface ReminderPayload {
	id: string;
	body: string;
	show_at: string;
	due_at: string | null;
	note: string | null;
	kind: ReminderKind;
	created_at: string;
}

export interface ListReminderPayload extends ReminderPayload {
	archived_at: string | null;
}

export interface AddReminderResult {
	reminder: ReminderPayload;
	confirmation: string;
}

export interface UpdateReminderResult {
	reminder: ReminderPayload;
	confirmation: string;
}

export interface ListRemindersResult {
	status: ReminderStatus;
	count: number;
	items: ListReminderPayload[];
}

export interface DeleteReminderResult {
	deleted: string;
}

const DEFAULT_ARCHIVED_LIMIT = 20;
const MAX_ARCHIVED_LIMIT = 100;

function reminderPayload(reminder: Reminder): ReminderPayload {
	return {
		id: reminder.id,
		body: reminder.body,
		show_at: reminder.showAt,
		due_at: reminder.dueAt,
		note: reminder.note,
		kind: reminder.kind,
		created_at: reminder.createdAt,
	};
}

function listPayload(reminder: Reminder): ListReminderPayload {
	return { ...reminderPayload(reminder), archived_at: reminder.archivedAt };
}

/** 表示用の完成済み 1 行。会話メモ（note）は入れない。 */
function boardLine(body: string, dueAt: string | null, now: string): string {
	if (dueAt === null) {
		return `・${body}`;
	}
	const monthDay = formatMonthDay(dueAt);
	const daysLeft = daysUntil(dueAt, now);
	if (daysLeft > 0) {
		return `・${body}（期限 ${monthDay}、あと ${daysLeft} 日）`;
	}
	if (daysLeft === 0) {
		return `・${body}（期限 ${monthDay}、今日まで）`;
	}
	return `・${body}（期限 ${monthDay}、${Math.abs(daysLeft)} 日超過）`;
}

function confirmationLine(prefix: string, reminder: Reminder): string {
	const shown = formatMonthDayTime(reminder.showAt);
	if (reminder.dueAt === null) {
		return `${prefix}：${reminder.body}（表示 ${shown}）`;
	}
	return `${prefix}：${reminder.body}（表示 ${shown}、期限 ${formatMonthDay(reminder.dueAt)}）`;
}

function compareText(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

/** 期限の近い順、期限なしは後ろ、同じ期限（や期限なし同士）は表示時刻の昇順。 */
function compareBoardItems(a: BoardItem, b: BoardItem): number {
	if (a.dueAt !== b.dueAt) {
		if (a.dueAt === null) {
			return 1;
		}
		if (b.dueAt === null) {
			return -1;
		}
		return compareText(a.dueAt, b.dueAt);
	}
	return compareText(a.showAt, b.showAt);
}

function requireBody(body: string): string {
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		throw new ServiceError("VALIDATION_ERROR", "body は 1 文字以上にしてください");
	}
	return trimmed;
}

/** 空文字の会話メモは「無し」として扱う。 */
function normalizeNote(note: string | null | undefined): string | null {
	if (note === undefined || note === null) {
		return null;
	}
	const trimmed = note.trim();
	return trimmed.length === 0 ? null : trimmed;
}

export class ReminderService {
	constructor(
		private readonly repo: ReminderRepo,
		private readonly clock: () => number = Date.now,
	) {}

	/**
	 * メインボードの取得。`takeBoard` が取得とアーカイブを不可分に行うので、
	 * 同じリマインダーが 2 回返ることはない。参照記録の失敗は握りつぶす。
	 */
	async checkBoard(): Promise<CheckBoardResult> {
		const startedMs = this.clock();
		const now = nowJst(startedMs);

		let taken: BoardItem[];
		try {
			taken = await this.repo.takeBoard(now);
		} catch (cause) {
			await this.safeRecord({
				checkedAt: now,
				returnedCount: 0,
				ok: false,
				errorCode: "DB_ERROR",
				durationMs: this.elapsedMs(startedMs),
			});
			throw new ServiceError("DB_ERROR", "リマインダーを取得できませんでした");
		}

		const result: CheckBoardResult =
			taken.length === 0
				? { count: 0, items: [] }
				: {
						count: taken.length,
						items: [...taken].sort(compareBoardItems).map((item) => ({
							id: item.id,
							body: item.body,
							due_at: item.dueAt,
							days_left: item.dueAt === null ? null : daysUntil(item.dueAt, now),
							show_at: item.showAt,
							kind: item.kind,
							line: boardLine(item.body, item.dueAt, now),
						})),
					};

		await this.safeRecord({
			checkedAt: now,
			returnedCount: result.count,
			ok: true,
			errorCode: null,
			durationMs: this.elapsedMs(startedMs),
		});

		return result;
	}

	async addReminder(input: AddReminderInput): Promise<AddReminderResult> {
		const body = requireBody(input.body);
		if (input.kind !== "explicit" && input.kind !== "auto") {
			throw new ServiceError("VALIDATION_ERROR", 'kind は "explicit" か "auto" です');
		}

		const now = nowJst(this.clock());
		const reminder = await this.repo.insert(
			{
				body,
				showAt: input.show_at === undefined ? undefined : parseJstDateTime(input.show_at),
				dueAt: input.due_at === undefined ? null : parseJstDue(input.due_at),
				note: normalizeNote(input.note),
				kind: input.kind,
			},
			now,
		);

		return {
			reminder: reminderPayload(reminder),
			confirmation: confirmationLine("登録しました", reminder),
		};
	}

	/** 一覧。どの行の状態も変えない。 */
	async listReminders(input: ListRemindersInput): Promise<ListRemindersResult> {
		const now = nowJst(this.clock());

		let reminders: Reminder[];
		switch (input.status) {
			case "waiting":
				reminders = await this.repo.listWaiting(now);
				break;
			case "active":
				reminders = await this.repo.listActive();
				break;
			case "archived":
				reminders = await this.repo.listArchived(this.archivedLimit(input.limit));
				break;
			default:
				throw new ServiceError(
					"VALIDATION_ERROR",
					'status は "waiting" / "active" / "archived" です',
				);
		}

		return { status: input.status, count: reminders.length, items: reminders.map(listPayload) };
	}

	async updateReminder(input: UpdateReminderInput): Promise<UpdateReminderResult> {
		const patch: UpdateReminderPatch = {};
		if (input.body !== undefined) {
			patch.body = requireBody(input.body);
		}
		if (input.show_at !== undefined) {
			patch.showAt = parseJstDateTime(input.show_at);
		}
		if (input.due_at !== undefined) {
			patch.dueAt = input.due_at === null ? null : parseJstDue(input.due_at);
		}
		if (input.note !== undefined) {
			patch.note = normalizeNote(input.note);
		}

		if (Object.keys(patch).length === 0) {
			throw new ServiceError(
				"VALIDATION_ERROR",
				"body / show_at / due_at / note のうち 1 つ以上を指定してください",
			);
		}

		const now = nowJst(this.clock());
		const reminder = await this.repo.update(input.id, patch, now);
		if (reminder === null) {
			throw new ServiceError("NOT_FOUND", `対象のリマインダーがありません: ${input.id}`);
		}

		return {
			reminder: reminderPayload(reminder),
			confirmation: confirmationLine("更新しました", reminder),
		};
	}

	async deleteReminder(id: string): Promise<DeleteReminderResult> {
		const now = nowJst(this.clock());
		const deleted = await this.repo.softDelete(id, now);
		if (!deleted) {
			throw new ServiceError("NOT_FOUND", `対象のリマインダーがありません: ${id}`);
		}
		return { deleted: id };
	}

	private archivedLimit(limit: number | undefined): number {
		if (limit === undefined) {
			return DEFAULT_ARCHIVED_LIMIT;
		}
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARCHIVED_LIMIT) {
			throw new ServiceError("VALIDATION_ERROR", `limit は 1〜${MAX_ARCHIVED_LIMIT} の整数です`);
		}
		return limit;
	}

	private elapsedMs(startedMs: number): number {
		return Math.max(0, Math.round(this.clock() - startedMs));
	}

	/** 参照記録は取得結果より優先度が低い。失敗しても応答は返す。 */
	private async safeRecord(record: BoardCheckRecord): Promise<void> {
		try {
			await this.repo.recordCheck(record);
		} catch (cause) {
			console.error("board_checks の記録に失敗しました", cause);
		}
	}
}
