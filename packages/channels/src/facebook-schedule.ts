// Facebook accepts a scheduled post only between 10 minutes and 75 days ahead (docs/FANPAGE-RESEARCH.md section 2).
// Both providers check it before doing anything, so a bad time fails here with a clear message and never as an opaque
// Graph error (or, for the fake, silently).

import { FacebookScheduleWindowError } from "./facebook-errors.ts";

export const FB_SCHEDULE_MIN_MS = 10 * 60_000;
export const FB_SCHEDULE_MAX_MS = 75 * 24 * 3_600_000;

/** Parse an ISO time and check it lies in [now + 10 minutes, now + 75 days]. Returns the instant; throws FacebookScheduleWindowError. */
export function validateScheduleWindow(scheduledPublishTime: string | null | undefined, now: Date): Date {
  if (!scheduledPublishTime) throw new FacebookScheduleWindowError("a scheduled post needs scheduledPublishTime");
  const at = new Date(scheduledPublishTime);
  if (Number.isNaN(at.getTime())) throw new FacebookScheduleWindowError(`scheduledPublishTime "${scheduledPublishTime}" is not a valid date`);
  const ahead = at.getTime() - now.getTime();
  if (ahead < FB_SCHEDULE_MIN_MS) {
    throw new FacebookScheduleWindowError(
      `scheduledPublishTime ${at.toISOString()} is ${Math.round(ahead / 60_000)} minute(s) from now; Facebook needs at least 10 minutes`,
    );
  }
  if (ahead > FB_SCHEDULE_MAX_MS) {
    throw new FacebookScheduleWindowError(`scheduledPublishTime ${at.toISOString()} is more than 75 days ahead; Facebook accepts at most 75 days`);
  }
  return at;
}
