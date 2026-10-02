import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../../api/client.ts";
import { eventHub } from "../../../api/sse.ts";
import { setupWizardApi, type GenerateSetupRequest, type SetupJob } from "../../../api/setupWizard.ts";

const POLL_MS = 5000;
const MAX_LINES = 200;

export interface SetupJobState {
  /** Newest first. */
  jobs: SetupJob[];
  loading: boolean;
  error: string | null;
  /** The running job if any, else the newest job. */
  current: SetupJob | null;
  running: SetupJob | null;
  /** Newest finished job that produced a result. */
  latestDone: SetupJob | null;
  /** Epoch ms, ticking every second while a job is running (drives the elapsed timer). */
  now: number;
  start: (req: GenerateSetupRequest) => Promise<SetupJob>;
  cancel: (id: string) => Promise<void>;
  reload: () => Promise<void>;
}

function upsert(list: SetupJob[], job: SetupJob): SetupJob[] {
  const idx = list.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    const copy = list.slice();
    copy[idx] = job;
    return copy;
  }
  return [job, ...list].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/**
 * Tracks setup-generation jobs: restores the running/latest job on load, follows SSE
 * ("setup.job.updated" / "setup.job.progress") and polls as a fallback while running.
 */
export function useSetupJob(): SetupJobState {
  const [jobs, setJobs] = useState<SetupJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const reload = useCallback(async () => {
    try {
      const { jobs: list } = await setupWizardApi.listJobs();
      setJobs(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const refetchOne = useCallback(async (id: string) => {
    try {
      const { job } = await setupWizardApi.getJob(id);
      setJobs((prev) => upsert(prev, job));
    } catch {
      // keep what we have; the next event or poll retries
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const offProgress = eventHub.subscribe("setup.job.progress", (e) => {
      const jobId = typeof e.jobId === "string" ? e.jobId : null;
      const line = typeof e.line === "string" ? e.line : null;
      if (!jobId || line === null) return;
      if (!jobsRef.current.some((j) => j.id === jobId)) {
        void refetchOne(jobId);
        return;
      }
      setJobs((prev) =>
        prev.map((j) =>
          j.id === jobId ? { ...j, progress: [...j.progress, { at: new Date().toISOString(), line }].slice(-MAX_LINES) } : j,
        ),
      );
    });
    const offUpdated = eventHub.subscribe("setup.job.updated", (e) => {
      const jobId = typeof e.jobId === "string" ? e.jobId : null;
      if (jobId) void refetchOne(jobId);
      else void reload();
    });
    return () => {
      offProgress();
      offUpdated();
    };
  }, [refetchOne, reload]);

  const running = useMemo(() => jobs.find((j) => j.status === "running") ?? null, [jobs]);
  const runningId = running?.id ?? null;

  useEffect(() => {
    if (!runningId) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void refetchOne(runningId), POLL_MS);
    setNow(Date.now());
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [runningId, refetchOne]);

  const start = useCallback(async (req: GenerateSetupRequest) => {
    const { job } = await setupWizardApi.generate(req);
    setJobs((prev) => upsert(prev, job));
    return job;
  }, []);

  const cancel = useCallback(async (id: string) => {
    const { job } = await setupWizardApi.cancelJob(id);
    setJobs((prev) => upsert(prev, job));
  }, []);

  const current = running ?? jobs[0] ?? null;
  const latestDone = useMemo(() => jobs.find((j) => j.status === "done" && j.result) ?? null, [jobs]);

  return { jobs, loading, error, current, running, latestDone, now, start, cancel, reload };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
