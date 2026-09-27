/**
 * 日本時間（+09:00、夏時間なし）固定の日時ユーティリティ。
 *
 * 保存形式は `YYYY-MM-DDTHH:MM:SS+09:00`。全行のオフセットが同じなので文字列の
 * まま大小比較できる。実行環境のローカルタイムゾーンには依存しない（`Date` の
 * ローカル系メソッドは使わず、UTC 系と手組みの整形だけを使う）。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const JST_SUFFIX = "+09:00";

export class DateTimeError extends Error {
	readonly code = "INVALID_DATETIME";

	constructor(message: string) {
		super(message);
		this.name = "DateTimeError";
	}
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?\+09:00$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** 年は必ず 4 桁にする（`Date.UTC` は 0〜99 年を 1900 年代に読み替えるので使わない）。 */
function pad4(value: number): string {
	return String(value).padStart(4, "0");
}

/** 月日だけの UTC 時刻。`Date.UTC` の 2 桁年の読み替えを避けるため `setUTCFullYear` を使う。 */
function utcOf(year: number, month: number, day: number): Date {
	const utc = new Date(0);
	utc.setUTCFullYear(year, month - 1, day);
	utc.setUTCHours(0, 0, 0, 0);
	return utc;
}

/** 実在する暦日かどうか（2026-02-30 のような繰り上がりを弾く）。 */
function isRealDate(year: number, month: number, day: number): boolean {
	const utc = utcOf(year, month, day);
	return (
		utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
	);
}

function build(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
): string {
	return `${pad4(year)}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${JST_SUFFIX}`;
}

/** 現在時刻（省略時 `Date.now()`）を保存形式で返す。ミリ秒は切り捨て。 */
export function nowJst(nowMs: number = Date.now()): string {
	const shifted = new Date(nowMs + JST_OFFSET_MS);
	return build(
		shifted.getUTCFullYear(),
		shifted.getUTCMonth() + 1,
		shifted.getUTCDate(),
		shifted.getUTCHours(),
		shifted.getUTCMinutes(),
		shifted.getUTCSeconds(),
	);
}

/**
 * `YYYY-MM-DDTHH:MM+09:00` または `YYYY-MM-DDTHH:MM:SS+09:00` だけを受け付け、
 * 保存形式に正規化する。それ以外（オフセット無し・`Z`・他のオフセット・実在しない
 * 日付や時刻）は `DateTimeError` を投げる。
 */
export function parseJstDateTime(input: string): string {
	const match = DATE_TIME_PATTERN.exec(input.trim());
	if (!match) {
		throw new DateTimeError(
			`日時は YYYY-MM-DDTHH:MM+09:00 の形式で指定してください: ${input}`,
		);
	}

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = match[6] === undefined ? 0 : Number(match[6]);

	if (!isRealDate(year, month, day)) {
		throw new DateTimeError(`存在しない日付です: ${input}`);
	}
	if (hour > 23 || minute > 59 || second > 59) {
		throw new DateTimeError(`存在しない時刻です: ${input}`);
	}

	return build(year, month, day, hour, minute, second);
}

/**
 * 期限用のパース。`parseJstDateTime` が受け付ける形式に加えて、日付のみの
 * `YYYY-MM-DD` をその日の 23:59:00 として受け付ける。
 */
export function parseJstDue(input: string): string {
	const trimmed = input.trim();
	const match = DATE_PATTERN.exec(trimmed);
	if (!match) {
		return parseJstDateTime(trimmed);
	}

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!isRealDate(year, month, day)) {
		throw new DateTimeError(`存在しない日付です: ${input}`);
	}

	return build(year, month, day, 23, 59, 0);
}

/** 保存形式の先頭 10 文字（`YYYY-MM-DD`）を UTC 午前 0 時基準の epoch 日数に直す。 */
function calendarDayIndex(dt: string): number {
	const match = DATE_PATTERN.exec(dt.slice(0, 10));
	if (!match) {
		throw new DateTimeError(`日時の形式が不正です: ${dt}`);
	}
	const utc = utcOf(Number(match[1]), Number(match[2]), Number(match[3])).getTime();
	return Math.round(utc / 86_400_000);
}

/** 日本時間の暦日の差（due の日付 − now の日付）。時刻は無視する。 */
export function daysUntil(dueAt: string, now: string): number {
	return calendarDayIndex(dueAt) - calendarDayIndex(now);
}

/** `10/3`（先頭ゼロなし）。 */
export function formatMonthDay(dt: string): string {
	const match = DATE_PATTERN.exec(dt.slice(0, 10));
	if (!match) {
		throw new DateTimeError(`日時の形式が不正です: ${dt}`);
	}
	return `${Number(match[2])}/${Number(match[3])}`;
}

/** `10/3 08:00`（時・分は 2 桁）。 */
export function formatMonthDayTime(dt: string): string {
	const match = DATE_TIME_PATTERN.exec(dt);
	if (!match) {
		throw new DateTimeError(`日時の形式が不正です: ${dt}`);
	}
	return `${Number(match[2])}/${Number(match[3])} ${match[4]}:${match[5]}`;
}
