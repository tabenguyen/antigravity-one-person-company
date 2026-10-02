// Small 5-field cron implementation (minute hour day-of-month month day-of-week)
// evaluated in an IANA timezone via Intl — no dependencies, no Node-only APIs, so
// agy-ui imports this exact file for its "next 3 runs" preview.
//
// Supported per field: `*`, numbers, lists (`1,15`), ranges (`1-5`), steps
// (`*/15`, `10-40/10`, `5/20` = 5,25,45...), and month/weekday names (jan..dec,
// sun..sat). Day-of-week accepts 0-7 (0 and 7 = Sunday). As in Vixie cron, when
// BOTH day-of-month and day-of-week are restricted a day matches if EITHER does.
//
// DST: a wall-clock time skipped by a spring-forward gap runs right after the gap
// (at the equivalent instant under the pre-transition offset); a wall-clock time
// repeated by a fall-back overlap runs once, at its first occurrence.

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  /** Days of month 1-31. */
  doms: number[];
  /** Months 1-12. */
  months: number[];
  /** Days of week 0-6 (0 = Sunday). */
  dows: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day-of-week", min: 0, max: 7, names: DOW_NAMES },
];

function parseValue(raw: string, spec: FieldSpec): number {
  const lower = raw.toLowerCase();
  if (spec.names && lower in spec.names) return spec.names[lower]!;
  if (!/^\d+$/.test(raw)) {
    throw new CronError(`${spec.name}: "${raw}" is not a number${spec.names ? " or name" : ""}`);
  }
  const n = Number(raw);
  if (n < spec.min || n > spec.max) {
    throw new CronError(`${spec.name}: value ${n} is out of range ${spec.min}-${spec.max}`);
  }
  return n;
}

function parseField(text: string, spec: FieldSpec): { values: number[]; restricted: boolean } {
  if (text === "") throw new CronError(`${spec.name}: empty field`);
  const out = new Set<number>();
  let restricted = false;
  for (const part of text.split(",")) {
    if (part === "") throw new CronError(`${spec.name}: empty list item in "${text}"`);
    const [rangePart, stepPart, ...extra] = part.split("/");
    if (extra.length > 0) throw new CronError(`${spec.name}: too many "/" in "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new CronError(`${spec.name}: step "${stepPart}" must be a positive integer`);
      }
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.name === "day-of-week" ? 6 : spec.max;
      if (stepPart === undefined) {
        for (let v = lo; v <= hi; v++) out.add(v);
        continue; // plain "*" is unrestricted
      }
    } else if (rangePart!.includes("-")) {
      const bounds = rangePart!.split("-");
      if (bounds.length !== 2) throw new CronError(`${spec.name}: bad range "${rangePart}"`);
      lo = parseValue(bounds[0]!, spec);
      hi = parseValue(bounds[1]!, spec);
      if (lo > hi) throw new CronError(`${spec.name}: range ${lo}-${hi} is backwards`);
    } else {
      lo = parseValue(rangePart!, spec);
      // "5/20" means "from 5 to the end, every 20"; a bare number is just that value.
      hi = stepPart !== undefined ? (spec.name === "day-of-week" ? 6 : spec.max) : lo;
    }
    restricted = true;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  let values = [...out];
  if (spec.name === "day-of-week") values = [...new Set(values.map((v) => (v === 7 ? 0 : v)))];
  values.sort((a, b) => a - b);
  // "*/1" and "0-59" style full coverage count as unrestricted for the dom/dow OR rule.
  if (restricted && values.length === (spec.name === "day-of-week" ? 7 : spec.max - spec.min + 1)) restricted = false;
  return { values, restricted };
}

/** Parse a 5-field cron expression; throws CronError with a field-specific message. */
export function parseCron(schedule: string): ParsedCron {
  if (typeof schedule !== "string") throw new CronError("schedule must be a string");
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0] === "") {
    throw new CronError(
      `schedule must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${parts[0] === "" ? 0 : parts.length}: "${schedule}"`,
    );
  }
  const parsed = parts.map((p, i) => parseField(p, FIELDS[i]!));
  return {
    minutes: parsed[0]!.values,
    hours: parsed[1]!.values,
    doms: parsed[2]!.values,
    months: parsed[3]!.values,
    dows: parsed[4]!.values,
    domRestricted: parsed[2]!.restricted,
    dowRestricted: parsed[4]!.restricted,
  };
}

/** Throws CronError when `tz` is not a valid IANA timezone. */
export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new CronError(`unknown timezone "${tz}" (use an IANA name such as "Asia/Ho_Chi_Minh" or "UTC")`);
  }
}

export function validateSchedule(schedule: string, timezone: string): { ok: true } | { ok: false; error: string } {
  try {
    parseCron(schedule);
    assertTimezone(timezone);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Timezone arithmetic

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at `utcMs`, expressed as the UTC-ms of the same Y/M/D h:m:s fields. */
function wallMsAt(utcMs: number, tz: string): number {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
}

/** Offset (ms) of `tz` from UTC at the instant `utcMs` (positive east of UTC). */
function offsetAt(utcMs: number, tz: string): number {
  return wallMsAt(utcMs, tz) - Math.floor(utcMs / 1000) * 1000;
}

/** Resolve a local wall time (as UTC-ms of its fields) to an instant; see the DST notes at the top. */
function wallToUtc(wallMs: number, tz: string): number {
  const offBefore = offsetAt(wallMs - 86_400_000, tz);
  const offAfter = offsetAt(wallMs + 86_400_000, tz);
  const candidates = [...new Set([wallMs - offBefore, wallMs - offAfter])].filter((c) => wallMsAt(c, tz) === wallMs);
  if (candidates.length > 0) return Math.min(...candidates);
  return wallMs - offBefore; // spring-forward gap: run just after it
}

const MS_DAY = 86_400_000;

function dayMatches(cron: ParsedCron, y: number, m: number, d: number): boolean {
  if (!cron.months.includes(m)) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = cron.doms.includes(d);
  const dowOk = cron.dows.includes(dow);
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

/**
 * The first instant strictly after `after` that matches `schedule` in `timezone`
 * (always on a whole minute). Throws CronError for an invalid schedule/timezone or
 * a schedule that can never fire (e.g. "0 0 31 2 *").
 */
export function nextRun(schedule: string, timezone: string, after: Date): Date {
  const cron = parseCron(schedule);
  assertTimezone(timezone);
  const afterMs = after.getTime();
  if (Number.isNaN(afterMs)) throw new CronError("invalid 'after' date");

  const startWall = wallMsAt(afterMs, timezone);
  const startDay = Math.floor(startWall / MS_DAY) * MS_DAY;
  // 8 years covers a Feb-29 schedule from any starting point.
  for (let i = 0; i < 366 * 8; i++) {
    const dayMs = startDay + i * MS_DAY;
    const day = new Date(dayMs);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!dayMatches(cron, y, m, d)) continue;
    for (const h of cron.hours) {
      for (const min of cron.minutes) {
        const instant = wallToUtc(dayMs + (h * 60 + min) * 60_000, timezone);
        if (instant > afterMs) return new Date(instant);
      }
    }
  }
  throw new CronError(`schedule "${schedule}" never fires`);
}

/** The next `count` run instants after `after` (empty array if the schedule is invalid). */
export function nextRuns(schedule: string, timezone: string, after: Date, count: number): Date[] {
  const out: Date[] = [];
  try {
    let cursor = after;
    for (let i = 0; i < count; i++) {
      cursor = nextRun(schedule, timezone, cursor);
      out.push(cursor);
    }
  } catch {
    return out;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Human description

const DOW_LABELS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "Weekdays at 09:00", "Every 15 minutes", ... — falls back to the raw expression for exotic schedules. */
export function describeSchedule(schedule: string): string {
  let cron: ParsedCron;
  try {
    cron = parseCron(schedule);
  } catch {
    return schedule;
  }
  const [minF, hourF, domF, monF, dowF] = schedule.trim().split(/\s+/) as [string, string, string, string, string];
  const everyDay = domF === "*" && monF === "*";
  const single = cron.minutes.length === 1 && cron.hours.length === 1;
  const time = single ? `${pad2(cron.hours[0]!)}:${pad2(cron.minutes[0]!)}` : null;

  if (everyDay && dowF === "*" && hourF === "*") {
    const step = /^\*\/(\d+)$/.exec(minF);
    if (minF === "*") return "Every minute";
    if (step) return `Every ${step[1]} minutes`;
    if (cron.minutes.length === 1) return `Hourly at :${pad2(cron.minutes[0]!)}`;
  }
  if (everyDay && time) {
    if (dowF === "*") return `Daily at ${time}`;
    if (cron.dows.length === 5 && [1, 2, 3, 4, 5].every((d) => cron.dows.includes(d))) return `Weekdays at ${time}`;
    if (cron.dows.length === 2 && cron.dows.includes(0) && cron.dows.includes(6)) return `Weekends at ${time}`;
    if (cron.dows.length === 1) return `${DOW_LABELS[cron.dows[0]!]} at ${time}`;
    if (cron.dows.length < 7) return `${cron.dows.map((d) => DOW_LABELS[d]!.slice(0, 3)).join(", ")} at ${time}`;
  }
  return schedule;
}
