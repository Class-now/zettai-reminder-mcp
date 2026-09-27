import { afterEach, describe, expect, it } from "vitest";
import {
	DateTimeError,
	daysUntil,
	formatMonthDay,
	formatMonthDayTime,
	nowJst,
	parseJstDateTime,
	parseJstDue,
} from "./datetime";

const originalTz = process.env.TZ;

afterEach(() => {
	if (originalTz === undefined) {
		delete process.env.TZ;
	} else {
		process.env.TZ = originalTz;
	}
});

describe("nowJst", () => {
	it("epoch を日本時間の保存形式で返す", () => {
		expect(nowJst(0)).toBe("1970-01-01T09:00:00+09:00");
	});

	it("ミリ秒を切り捨てる", () => {
		// 2026-10-03T08:00:00+09:00 = 2026-10-02T23:00:00Z
		const ms = Date.UTC(2026, 9, 2, 23, 0, 0) + 999;
		expect(nowJst(ms)).toBe("2026-10-03T08:00:00+09:00");
	});

	it("引数を省略すると現在時刻を保存形式で返す", () => {
		expect(nowJst()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
	});

	it("ローカルタイムゾーンが変わっても同じ結果になる", () => {
		const ms = Date.UTC(2026, 9, 2, 23, 0, 0);

		process.env.TZ = "America/New_York";
		const newYork = nowJst(ms);
		process.env.TZ = "UTC";
		const utc = nowJst(ms);
		process.env.TZ = "Asia/Tokyo";
		const tokyo = nowJst(ms);

		expect(newYork).toBe("2026-10-03T08:00:00+09:00");
		expect(utc).toBe(newYork);
		expect(tokyo).toBe(newYork);
	});

	it("UTC 日付をまたぐ時刻でも日本時間の暦日になる", () => {
		// 2026-10-03T15:00:00Z = 2026-10-04T00:00:00+09:00
		expect(nowJst(Date.UTC(2026, 9, 3, 15, 0, 0))).toBe("2026-10-04T00:00:00+09:00");
	});
});

describe("parseJstDateTime", () => {
	it("秒が無ければ :00 を補う", () => {
		expect(parseJstDateTime("2026-10-03T08:00+09:00")).toBe("2026-10-03T08:00:00+09:00");
	});

	it("秒付きはそのまま保存形式になる", () => {
		expect(parseJstDateTime("2026-10-03T08:00:30+09:00")).toBe("2026-10-03T08:00:30+09:00");
	});

	it("前後の空白を許す", () => {
		expect(parseJstDateTime("  2026-10-03T08:00+09:00  ")).toBe("2026-10-03T08:00:00+09:00");
	});

	it.each([
		["オフセット無し", "2026-10-03T08:00"],
		["秒付きオフセット無し", "2026-10-03T08:00:00"],
		["Z", "2026-10-03T08:00:00Z"],
		["+00:00", "2026-10-03T08:00:00+00:00"],
		["+0900（コロン無し）", "2026-10-03T08:00:00+0900"],
		["実在しない日付", "2026-02-30T10:00+09:00"],
		["実在しない時刻", "2026-10-03T25:00+09:00"],
		["日付のみ", "2026-10-03"],
		["空文字", ""],
	])("%s は INVALID_DATETIME で拒否する", (_label, input) => {
		expect(() => parseJstDateTime(input)).toThrow(DateTimeError);
		try {
			parseJstDateTime(input);
			expect.unreachable();
		} catch (error) {
			expect((error as DateTimeError).code).toBe("INVALID_DATETIME");
		}
	});

	it("うるう年の 2 月 29 日は受け付ける", () => {
		expect(parseJstDateTime("2028-02-29T10:00+09:00")).toBe("2028-02-29T10:00:00+09:00");
	});
});

describe("parseJstDue", () => {
	it("日付のみはその日の 23:59:00 になる", () => {
		expect(parseJstDue("2026-10-05")).toBe("2026-10-05T23:59:00+09:00");
	});

	it("日時が来たら parseJstDateTime と同じ結果になる", () => {
		expect(parseJstDue("2026-10-05T08:00+09:00")).toBe("2026-10-05T08:00:00+09:00");
	});

	it("実在しない日付は INVALID_DATETIME で拒否する", () => {
		expect(() => parseJstDue("2026-02-30")).toThrow(DateTimeError);
		expect(() => parseJstDue("2026-13-01")).toThrow(DateTimeError);
	});
});

describe("daysUntil", () => {
	const now = "2026-10-03T23:00:00+09:00";

	it("当日は 0", () => {
		expect(daysUntil("2026-10-03T00:00:00+09:00", now)).toBe(0);
		expect(daysUntil("2026-10-03T23:59:00+09:00", now)).toBe(0);
	});

	it("翌々日は 2", () => {
		expect(daysUntil("2026-10-05T08:00:00+09:00", now)).toBe(2);
	});

	it("前日は −1", () => {
		expect(daysUntil("2026-10-02T23:59:00+09:00", now)).toBe(-1);
	});

	it("日付境界（23:59 と 00:00）をまたぐと 1 日差になる", () => {
		expect(daysUntil("2026-10-04T00:00:00+09:00", "2026-10-03T23:59:00+09:00")).toBe(1);
		expect(daysUntil("2026-10-03T23:59:00+09:00", "2026-10-04T00:00:00+09:00")).toBe(-1);
		expect(daysUntil("2026-10-03T00:00:00+09:00", "2026-10-03T23:59:00+09:00")).toBe(0);
	});

	it("月・年をまたいでも暦日差になる", () => {
		expect(daysUntil("2026-11-01T00:00:00+09:00", "2026-10-31T23:59:00+09:00")).toBe(1);
		expect(daysUntil("2027-01-01T00:00:00+09:00", "2026-12-31T00:00:00+09:00")).toBe(1);
	});

	it("ローカルタイムゾーンが変わっても同じ結果になる", () => {
		process.env.TZ = "America/New_York";
		const newYork = daysUntil("2026-10-05T08:00:00+09:00", now);
		process.env.TZ = "UTC";
		expect(daysUntil("2026-10-05T08:00:00+09:00", now)).toBe(newYork);
		expect(newYork).toBe(2);
	});
});

describe("formatMonthDay", () => {
	it("先頭ゼロなしの 月/日 にする", () => {
		expect(formatMonthDay("2026-10-03T08:00:00+09:00")).toBe("10/3");
		expect(formatMonthDay("2026-01-09T08:00:00+09:00")).toBe("1/9");
	});

	it("形式が不正なら INVALID_DATETIME", () => {
		expect(() => formatMonthDay("2026/10/03")).toThrow(DateTimeError);
	});
});

describe("formatMonthDayTime", () => {
	it("月/日 と 2 桁の時:分にする", () => {
		expect(formatMonthDayTime("2026-10-03T08:00:00+09:00")).toBe("10/3 08:00");
		expect(formatMonthDayTime("2026-01-09T23:05:00+09:00")).toBe("1/9 23:05");
	});

	it("形式が不正なら INVALID_DATETIME", () => {
		expect(() => formatMonthDayTime("2026-10-03")).toThrow(DateTimeError);
	});
});
