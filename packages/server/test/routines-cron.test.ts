import { describe, expect, it } from "vitest";
import { CronError, describeSchedule, nextRun, nextRuns, parseCron, validateSchedule } from "../src/routines/cron.ts";

const iso = (d: Date) => d.toISOString();
const HCM = "Asia/Ho_Chi_Minh"; // UTC+7, no DST

describe("cron parsing & validation", () => {
  it("parses numbers, lists, ranges, steps and names", () => {
    const c = parseCron("*/15 9-11,14 1,15 jan-mar mon-fri");
    expect(c.minutes).toEqual([0, 15, 30, 45]);
    expect(c.hours).toEqual([9, 10, 11, 14]);
    expect(c.doms).toEqual([1, 15]);
    expect(c.months).toEqual([1, 2, 3]);
    expect(c.dows).toEqual([1, 2, 3, 4, 5]);
    expect(c.domRestricted && c.dowRestricted).toBe(true);
    expect(parseCron("0 0 * * 7").dows).toEqual([0]);
    expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
    expect(parseCron("10-40/10 * * * *").minutes).toEqual([10, 20, 30, 40]);
  });

  it.each([
    ["", /5 fields/],
    ["* * * *", /exactly 5 fields.*got 4/],
    ["* * * * * *", /exactly 5 fields.*got 6/],
    ["60 * * * *", /minute: value 60 is out of range 0-59/],
    ["* 24 * * *", /hour: value 24 is out of range 0-23/],
    ["* * 0 * *", /day-of-month: value 0/],
    ["* * * 13 *", /month: value 13/],
    ["* * * * 8", /day-of-week: value 8/],
    ["abc * * * *", /minute: "abc" is not a number/],
    ["*/0 * * * *", /step "0"/],
    ["5-1 * * * *", /backwards/],
    ["1,,2 * * * *", /empty list item/],
    ["1-2-3 * * * *", /bad range/],
  ])("rejects %j with a clear message", (expr, message) => {
    expect(() => parseCron(expr)).toThrow(CronError);
    expect(() => parseCron(expr)).toThrow(message);
  });

  it("validateSchedule checks both the expression and the timezone", () => {
    expect(validateSchedule("0 9 * * 1-5", HCM)).toEqual({ ok: true });
    expect(validateSchedule("0 9 * * 1-5", "Mars/Olympus")).toMatchObject({ ok: false, error: expect.stringContaining("unknown timezone") });
    expect(validateSchedule("nope", "UTC")).toMatchObject({ ok: false });
  });
});

describe("nextRun", () => {
  it("weekdays 09:00 Asia/Ho_Chi_Minh", () => {
    // Thu 2026-10-01 08:00 +07 = 01:00Z -> same day 09:00 +07 = 02:00Z
    expect(iso(nextRun("0 9 * * 1-5", HCM, new Date("2026-10-01T01:00:00Z")))).toBe("2026-10-01T02:00:00.000Z");
    // exactly at the run time -> strictly after => next weekday (Fri)
    expect(iso(nextRun("0 9 * * 1-5", HCM, new Date("2026-10-01T02:00:00Z")))).toBe("2026-10-02T02:00:00.000Z");
    // Fri after 09:00 -> skips the weekend to Mon 2026-10-05
    expect(iso(nextRun("0 9 * * 1-5", HCM, new Date("2026-10-02T03:00:00Z")))).toBe("2026-10-05T02:00:00.000Z");
  });

  it("uses the schedule's timezone for the date (UTC date differs from local date)", () => {
    // 2026-10-01 20:00Z is already Fri 2026-10-02 03:00 in HCM -> next is Fri 09:00 local = 02:00Z that day
    expect(iso(nextRun("0 9 * * 1-5", HCM, new Date("2026-10-01T20:00:00Z")))).toBe("2026-10-02T02:00:00.000Z");
  });

  it("*/15 steps through quarter hours", () => {
    const runs = nextRuns("*/15 * * * *", "UTC", new Date("2026-10-01T10:07:30Z"), 4).map(iso);
    expect(runs).toEqual([
      "2026-10-01T10:15:00.000Z",
      "2026-10-01T10:30:00.000Z",
      "2026-10-01T10:45:00.000Z",
      "2026-10-01T11:00:00.000Z",
    ]);
  });

  it("lists and ranges: 08:30 and 17:00 on Mon,Wed,Fri", () => {
    const runs = nextRuns("30 8,17 * * 1,3,5", "UTC", new Date("2026-10-01T00:00:00Z"), 4).map(iso); // Thu
    expect(runs).toEqual([
      "2026-10-02T08:30:00.000Z", // Fri
      "2026-10-02T17:30:00.000Z",
      "2026-10-05T08:30:00.000Z", // Mon
      "2026-10-05T17:30:00.000Z",
    ]);
  });

  it("day-of-month AND day-of-week both restricted => OR (Vixie semantics)", () => {
    // 1st of the month OR any Monday
    const runs = nextRuns("0 0 1 * 1", "UTC", new Date("2026-10-01T00:00:00Z"), 3).map(iso);
    expect(runs).toEqual(["2026-10-05T00:00:00.000Z", "2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z"]);
  });

  it("month rollover and year rollover", () => {
    expect(iso(nextRun("0 0 1 1 *", "UTC", new Date("2026-10-01T00:00:00Z")))).toBe("2027-01-01T00:00:00.000Z");
  });

  it("Feb 29 schedules find the next leap year; impossible schedules throw", () => {
    expect(iso(nextRun("0 0 29 2 *", "UTC", new Date("2026-10-01T00:00:00Z")))).toBe("2028-02-29T00:00:00.000Z");
    expect(() => nextRun("0 0 31 2 *", "UTC", new Date("2026-10-01T00:00:00Z"))).toThrow(/never fires/);
  });

  it("throws on invalid input", () => {
    expect(() => nextRun("bad", "UTC", new Date())).toThrow(CronError);
    expect(() => nextRun("0 9 * * *", "Nope/Zone", new Date())).toThrow(/unknown timezone/);
    expect(nextRuns("bad", "UTC", new Date(), 3)).toEqual([]);
  });

  describe("DST (America/New_York)", () => {
    const NY = "America/New_York";
    it("keeps wall-clock time across spring forward (2026-03-08)", () => {
      // 09:00 EST (UTC-5) on Sat Mar 7 = 14:00Z; 09:00 EDT (UTC-4) on Sun Mar 8 = 13:00Z
      const runs = nextRuns("0 9 * * *", NY, new Date("2026-03-07T00:00:00Z"), 3).map(iso);
      expect(runs).toEqual(["2026-03-07T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
    });

    it("a time inside the spring-forward gap (02:30) still runs once, right after the gap", () => {
      const runs = nextRuns("30 2 * * *", NY, new Date("2026-03-07T12:00:00Z"), 3).map(iso);
      // Mar 7 02:30 EST = 07:30Z already passed at 12:00Z -> Mar 8 gap -> 03:30 EDT = 07:30Z, then Mar 9 02:30 EDT = 06:30Z
      expect(runs).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
    });

    it("fall back (2026-11-01): 01:30 runs once, at its first occurrence", () => {
      const runs = nextRuns("30 1 * * *", NY, new Date("2026-10-31T12:00:00Z"), 3).map(iso);
      // Nov 1 01:30 EDT = 05:30Z (first occurrence); the repeated 01:30 EST (06:30Z) is skipped; Nov 2 01:30 EST = 06:30Z
      expect(runs).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z", "2026-11-03T06:30:00.000Z"]);
      // and no double run: asking after the first occurrence yields the next day
      expect(iso(nextRun("30 1 * * *", NY, new Date("2026-11-01T05:30:00Z")))).toBe("2026-11-02T06:30:00.000Z");
    });
  });
});

describe("describeSchedule", () => {
  it.each([
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["30 8 * * *", "Daily at 08:30"],
    ["0 9 * * 1", "Mondays at 09:00"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["15 * * * *", "Hourly at :15"],
    ["0 9 1 * *", "0 9 1 * *"],
    ["not cron", "not cron"],
  ])("%s -> %s", (expr, text) => {
    expect(describeSchedule(expr)).toBe(text);
  });
});
