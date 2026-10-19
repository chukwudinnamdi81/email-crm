import { Queue } from "bullmq";
import { redis } from "./redis";

export const QUEUES = {
  sync: "sync",
  verify: "verify",
  sequences: "sequences",
  ai: "ai",
} as const;

const cache = new Map<string, Queue>();
export function queue(name: string): Queue {
  let q = cache.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis() });
    cache.set(name, q);
  }
  return q;
}

import { db } from "./db";
import { syncPriority, type SyncSource } from "./sync-limits";

const STALE_QUEUED_MS = 2 * 60_000;

/** Creates a SyncJob row (unless one is already queued/running) and enqueues it. */
export async function startSync(accountId: string, opts: { source?: SyncSource } = {}) {
  const existing = await db.syncJob.findFirst({ where: { accountId, status: { in: ["queued", "running"] } } });
  if (existing) {
    // A queued row whose BullMQ job is gone (any state counts as alive, incl. delayed) would block every later click.
    const stale = existing.status === "queued" && Date.now() - existing.createdAt.getTime() > STALE_QUEUED_MS && !(await queue(QUEUES.sync).getJob(`sync-${existing.id}`));
    if (!stale) return existing;
    await db.syncJob.update({ where: { id: existing.id }, data: { status: "error", error: "Sync job was lost; restarted", finishedAt: new Date() } });
  }
  const acc = await db.mailAccount.findUnique({ where: { id: accountId }, select: { userId: true } });
  const backlog = acc ? await db.syncJob.count({ where: { account: { userId: acc.userId }, status: { in: ["queued", "running"] } } }) : 0;
  const row = await db.syncJob.create({ data: { accountId } });
  await queue(QUEUES.sync).add(
    "sync-account",
    { accountId, syncJobId: row.id },
    { jobId: `sync-${row.id}`, priority: syncPriority(opts.source ?? "manual", backlog), attempts: 5, backoff: { type: "exponential", delay: 15000 }, removeOnComplete: 100, removeOnFail: 200 },
  );
  return row;
}
