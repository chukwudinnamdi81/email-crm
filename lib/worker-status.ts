import { QUEUES, queue } from "./queues";
import { redis } from "./redis";

const withTimeout = <T>(p: Promise<T>, ms = 1500) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/** True when the worker's Redis heartbeat key exists; null when Redis can't be asked. */
export async function workerAlive(): Promise<boolean | null> {
  try { return (await withTimeout(redis().exists("worker:heartbeat"))) === 1; } catch { return null; }
}

export async function syncQueueCounts() {
  try {
    const c = await withTimeout(queue(QUEUES.sync).getJobCounts("waiting", "prioritized", "active", "delayed"));
    return { waiting: (c.waiting ?? 0) + (c.prioritized ?? 0), active: c.active ?? 0, delayed: c.delayed ?? 0 };
  } catch { return null; }
}
