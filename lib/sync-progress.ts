export type Phase = "queued" | "connecting" | "scanning" | "downloading" | "waiting" | "done" | "error";

export type ProgressJob = {
  status: string; foldersTotal: number; messagesTotal: number; messagesProcessed: number;
  scanDoneAt: Date | null; startedAt: Date | null; yieldedAt: Date | null; sliceStartedAt: Date | null; activeMs: number;
};

export type Progress = {
  phase: Phase; percent: number; messagesTotal: number; messagesProcessed: number; remaining: number;
  elapsedSec: number; ratePerMin: number | null; etaSec: number | null;
};

const BATCH = 50;

/** Download time of the current slice (since the later of slice start / scan end). */
export function sliceDownloadMs(j: Pick<ProgressJob, "scanDoneAt" | "sliceStartedAt">, now: number): number {
  const start = Math.max(j.sliceStartedAt?.getTime() ?? 0, j.scanDoneAt?.getTime() ?? 0);
  return start ? Math.max(0, now - start) : 0;
}

export function computeProgress(j: ProgressJob, now = Date.now()): Progress {
  let phase: Phase;
  if (j.status === "done") phase = "done";
  else if (j.status === "error") phase = "error";
  else if (j.yieldedAt) phase = "waiting"; // paused for fairness (lease denied or time slice used up); the job is alive
  else if (j.status === "queued") phase = "queued";
  else if (j.foldersTotal === 0) phase = "connecting";
  else if (!j.scanDoneAt) phase = "scanning";
  else phase = "downloading";

  const total = Math.max(0, j.messagesTotal);
  const processed = Math.max(0, j.messagesProcessed);
  const remaining = Math.max(0, total - processed);
  let percent = total > 0 ? Math.floor((Math.min(processed, total) / total) * 100) : 0;
  if (phase === "done") percent = 100;
  else percent = Math.min(99, Math.max(0, percent));

  const activeMs = j.activeMs + (j.yieldedAt ? 0 : sliceDownloadMs(j, now));
  const enough = activeMs >= 20_000 || processed >= 2 * BATCH;
  const ratePerMin = phase !== "done" && j.scanDoneAt && enough && activeMs > 0 && processed > 0 ? processed / (activeMs / 60_000) : null;
  const etaSec = ratePerMin && remaining > 0 ? Math.round((remaining / ratePerMin) * 60) : null;
  const elapsedSec = j.startedAt ? Math.max(0, Math.round((now - j.startedAt.getTime()) / 1000)) : 0;
  return { phase, percent, messagesTotal: total, messagesProcessed: processed, remaining, elapsedSec, ratePerMin: ratePerMin ? Math.round(ratePerMin * 10) / 10 : null, etaSec };
}

export type Overall = { active: number; phase: Phase | null; messagesTotal: number; messagesProcessed: number; remaining: number; percent: number; ratePerMin: number | null; etaSec: number | null };

/** One summary across all active (queued/running) jobs of a user. */
export function overallProgress(active: Progress[]): Overall {
  const total = active.reduce((n, p) => n + p.messagesTotal, 0);
  const processed = active.reduce((n, p) => n + p.messagesProcessed, 0);
  const remaining = active.reduce((n, p) => n + p.remaining, 0);
  const rates = active.map((p) => p.ratePerMin).filter((r): r is number => r != null);
  const rate = rates.length ? rates.reduce((a, b) => a + b, 0) : null;
  const phase = !active.length ? null : active.every((p) => p.phase === "waiting") ? "waiting" : active.find((p) => p.phase === "downloading")?.phase ?? active[0].phase;
  return {
    active: active.length, phase, messagesTotal: total, messagesProcessed: processed, remaining,
    percent: total > 0 ? Math.min(99, Math.floor((Math.min(processed, total) / total) * 100)) : 0,
    ratePerMin: rate, etaSec: rate && remaining > 0 ? Math.round((remaining / rate) * 60) : null,
  };
}

/** Exponential moving average with a time constant (default 60s), so a 3-4s poll doesn't make the ETA jump around. */
export function emaRate(prev: number | null, sample: number, dtMs: number, tauMs = 60_000): number {
  if (prev == null) return sample;
  const a = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return prev + a * (sample - prev);
}

/** "under a minute", "about 12 min", "about 2 h 10 min" (rounded to avoid jitter). */
export function formatEta(sec: number): string {
  if (sec < 60) return "under a minute";
  const mins = Math.round(sec / 60);
  if (mins < 60) return `about ${mins} min`;
  const total = Math.round(mins / 5) * 5;
  const h = Math.floor(total / 60), m = total % 60;
  return m ? `about ${h} h ${m} min` : `about ${h} h`;
}
