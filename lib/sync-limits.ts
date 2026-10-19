const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);

/** Single place for env-tunable sync limits (read lazily so tests/ops can change env). */
export const syncLimits = {
  get perUserConcurrency() { return Math.max(1, num(process.env.SYNC_PER_USER_CONCURRENCY, 2)); },
  get sliceSeconds() { return Math.max(1, num(process.env.SYNC_SLICE_SECONDS, 240)); },
  get maxFullSyncMessages() { return Math.max(0, num(process.env.SYNC_MAX_FULL_SYNC_MESSAGES, 0)); },
};

export type SyncSource = "manual" | "idle" | "scheduled";

/** BullMQ priority: lower runs first. Scheduled syncs queue behind interactive ones and behind users with big backlogs. */
export function syncPriority(source: SyncSource, userBacklog: number): number {
  if (source === "manual") return 1;
  if (source === "idle") return 2;
  return 10 + Math.min(20, Math.max(0, userBacklog));
}

/** Yield only when the slice is used up AND someone else is waiting (zero overhead when idle). */
export function shouldYield(i: { elapsedMs: number; sliceSeconds: number; waitingCount: number }): boolean {
  return i.elapsedMs > i.sliceSeconds * 1000 && i.waitingCount > 0;
}

/** Round-robin by user: one account per user per pass. */
export function roundRobin<T extends { userId: string }>(items: T[]): T[] {
  const byUser = new Map<string, T[]>();
  for (const it of items) byUser.set(it.userId, [...(byUser.get(it.userId) ?? []), it]);
  const out: T[] = [];
  for (let more = true; more; ) {
    more = false;
    for (const list of byUser.values()) {
      const n = list.shift();
      if (n) { out.push(n); more = true; }
    }
  }
  return out;
}
