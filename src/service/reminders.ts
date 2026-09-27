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

/**
 * ツールの入力はそのまま snake_case で受け取る（MCP の入力スキーマと同じ形）。
 * `show_at` / `due_at` / `note` は `null` も省略（`undefined`）と同じに扱う
 * （`update_reminder` が `null` を消去の意味で受けるので、同じ値が来ても弾かない）。
 */
export interface AddReminderInput {
	body: string;
	kind: ReminderKind;
	show_at?: string | null;
	due_at?: string | null;
	note?: string | null;
}

export interface ListRemindersInput {
	status: ReminderStatus;
	/** `null` は省略と同じ（ステータスごとの既定値を使う）。 */
	limit?: number | null;
}

/**
 * `due_at` と `note` は `null` で消去、省略（`undefined`）は現状維持。
 * `body` と `show_at` は消せない列なので `null` は省略と同じに扱う。
 */
export interface UpdateReminderInput {
	id: string;
	body?: string | null;
	show_at?: string | null;
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
	/** 上限に達して取り切れなかったときだけ `true` が付く（0 件の応答の形は変えない）。 */
	has_more?: true;
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
	/** `limit` で切り捨てた分があるときだけ `true` が付く。 */
	has_more?: true;
	items: ListReminderPayload[];
}

export interface DeleteReminderResult {
	deleted: string;
}

/**
 * 1 回の `check_board` で取る上限。Claude の文脈に無制限に流し込まないための
 * 上限であり、超えた分は残って次の `check_board` で返る（失われない）。
 */
const BOARD_TAKE_LIMIT = 50;
/**
 * 本文と会話メモの長さの上限。件数の上限（`BOARD_TAKE_LIMIT`）だけでは 1 行あたりの
 * 大きさが青天井で、D1 の応答上限（1MB）を 50 行で超えると `takeBoard` が失敗し続けて
 * 恒久的に詰まる。Claude の文脈を圧迫しないための上限でもある。
 */
const MAX_BODY_LENGTH = 200;
const MAX_NOTE_LENGTH = 1000;
const DEFAULT_ARCHIVED_LIMIT = 20;
/** waiting / active は「重複確認」用なので既定でも上限まで返す。 */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;

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
function boardLine(body: string, dueAt: string | null, daysLeft: number | null): string {
	if (dueAt === null || daysLeft === null) {
		return `・${body}`;
	}
	const monthDay = formatMonthDay(dueAt);
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

/**
 * 期限の近い順、期限なしは後ろ、同じ期限（や期限なし同士）は表示時刻の昇順。
 * `UPDATE … RETURNING` の行順は保証されないので、期限も表示時刻も同じときは
 * `id` まで見て順序を一意にする（同じ入力なら必ず同じ並びになる）。
 */
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
	if (a.showAt !== b.showAt) {
		return compareText(a.showAt, b.showAt);
	}
	return compareText(a.id, b.id);
}

/**
 * 上限は「文字数」で数える。`String.prototype.length` は UTF-16 のコード単位なので
 * 絵文字などサロゲートペアの文字を 2 と数えてしまい、実効上限が半分になり、
 * エラーメッセージの件数も実際と合わなくなる（SQLite の `length()` も文字数で数える）。
 */
function charLength(text: string): number {
	return [...text].length;
}

/**
 * 本文は表示用の 1 行（`line`）と確認文（`confirmation`）にそのまま埋め込まれるので、
 * 改行を含む連続した空白は半角スペース 1 個に畳んで必ず 1 行にする。
 * 単独の全角スペース（U+3000）は「連続する空白」ではないので書き換えない
 * （日本語の本文をそのまま保存する）。
 */
function requireBody(body: string): string {
	const collapsed = body
		.replace(/\s{2,}/g, " ")
		.replace(/[^\S\u3000]/g, " ")
		.trim();
	if (collapsed.length === 0) {
		throw new ServiceError("VALIDATION_ERROR", "body は 1 文字以上にしてください");
	}
	const bodyLength = charLength(collapsed);
	if (bodyLength > MAX_BODY_LENGTH) {
		throw new ServiceError(
			"VALIDATION_ERROR",
			`body は ${MAX_BODY_LENGTH} 文字以内にしてください（${bodyLength} 文字）`,
		);
	}
	return collapsed;
}

/** 空文字の会話メモは「無し」として扱う。 */
function normalizeNote(note: string | null | undefined): string | null {
	if (note === undefined || note === null) {
		return null;
	}
	const trimmed = note.trim();
	const noteLength = charLength(trimmed);
	if (noteLength > MAX_NOTE_LENGTH) {
		throw new ServiceError(
			"VALIDATION_ERROR",
			`note は ${MAX_NOTE_LENGTH} 文字以内にしてください（${noteLength} 文字）`,
		);
	}
	return trimmed.length === 0 ? null : trimmed;
}

export class ReminderService {
	constructor(
		private readonly repo: ReminderRepo,
		private readonly clock: () => number = Date.now,
	) {}

	/**
	 * メインボードの取得。`takeBoard` が取得とアーカイブを不可分に行うので、
	 * 同じリマインダーが 2 回返ることはない。1 回で返すのは `BOARD_TAKE_LIMIT`
	 * 件までで、超えた分は次の `check_board` に回る。取り切れなかった可能性があるときは
	 * `has_more: true` を付けて黙って隠さない（ちょうど上限で尽きた場合も `true` になるが、
	 * 残りを見落とすより過剰に知らせる方を採る）。参照記録の失敗は握りつぶす。
	 */
	async checkBoard(): Promise<CheckBoardResult> {
		const startedMs = this.clock();
		const now = nowJst(startedMs);

		let taken: BoardItem[];
		try {
			taken = await this.repo.takeBoard(now, BOARD_TAKE_LIMIT);
		} catch (cause) {
			console.error("takeBoard に失敗しました", cause);
			await this.safeRecord({
				checkedAt: now,
				returnedCount: 0,
				ok: false,
				errorCode: "DB_ERROR",
				durationMs: this.elapsedMs(startedMs),
			});
			throw new ServiceError("DB_ERROR", "リマインダーを取得できませんでした");
		}

		const items = taken.sort(compareBoardItems).map((item) => {
			const daysLeft = item.dueAt === null ? null : daysUntil(item.dueAt, now);
			return {
				id: item.id,
				body: item.body,
				due_at: item.dueAt,
				days_left: daysLeft,
				show_at: item.showAt,
				kind: item.kind,
				line: boardLine(item.body, item.dueAt, daysLeft),
			};
		});
		const result: CheckBoardResult =
			taken.length === BOARD_TAKE_LIMIT
				? { count: items.length, has_more: true, items }
				: { count: items.length, items };

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
				showAt: input.show_at == null ? undefined : parseJstDateTime(input.show_at),
				dueAt: input.due_at == null ? null : parseJstDue(input.due_at),
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

	/**
	 * 一覧。どの行の状態も変えない。`limit` より 1 件多く取って切り捨てることで、
	 * 打ち切りがあったかを追加の問い合わせなしに判定し `has_more: true` で知らせる
	 * （重複確認の一覧が黙って欠けると、重複登録に気づけない）。
	 */
	async listReminders(input: ListRemindersInput): Promise<ListRemindersResult> {
		const now = nowJst(this.clock());

		let limit: number;
		let fetched: Reminder[];
		switch (input.status) {
			case "waiting":
				limit = this.listLimit(input.limit, DEFAULT_LIST_LIMIT);
				fetched = await this.repo.listWaiting(now, limit + 1);
				break;
			case "active":
				limit = this.listLimit(input.limit, DEFAULT_LIST_LIMIT);
				fetched = await this.repo.listActive(limit + 1);
				break;
			case "archived":
				limit = this.listLimit(input.limit, DEFAULT_ARCHIVED_LIMIT);
				fetched = await this.repo.listArchived(limit + 1);
				break;
			default:
				throw new ServiceError(
					"VALIDATION_ERROR",
					'status は "waiting" / "active" / "archived" です',
				);
		}

		const reminders = fetched.slice(0, limit);
		const items = reminders.map(listPayload);
		return fetched.length > limit
			? { status: input.status, count: items.length, has_more: true, items }
			: { status: input.status, count: items.length, items };
	}

	async updateReminder(input: UpdateReminderInput): Promise<UpdateReminderResult> {
		const patch: UpdateReminderPatch = {};
		// body / show_at は消せない列なので、`null` は `add_reminder` と同じく「指定なし」として扱う
		// （`due_at` / `note` の消去に使う `null` をそのまま渡されても封筒外で落ちないようにする）。
		if (input.body != null) {
			patch.body = requireBody(input.body);
		}
		if (input.show_at != null) {
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

	private listLimit(limit: number | null | undefined, fallback: number): number {
		if (limit == null) {
			return fallback;
		}
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
			throw new ServiceError("VALIDATION_ERROR", `limit は 1〜${MAX_LIST_LIMIT} の整数です`);
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
