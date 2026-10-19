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

const log = (...a: unknown[]) => console.warn("[queues]", ...a);

async function removeJobs(name: string, ids: string[]) {
  const q = queue(name);
  for (const id of ids) {
    try {
      await (await q.getJob(id))?.remove();
    } catch {
      log("could not remove job (active or Redis unavailable):", name); // a running job fails on its own once the rows are gone
    }
  }
}

/** Removes queued/delayed sync jobs (`sync-<syncJobId>`) for these accounts so the worker never runs against a deleted row. */
export async function cancelAccountJobs(accountIds: string[]) {
  const rows = await db.syncJob.findMany({ where: { accountId: { in: accountIds }, status: { in: ["queued", "running"] } }, select: { id: true } });
  await removeJobs(QUEUES.sync, rows.map((r) => `sync-${r.id}`));
}

/** Removes queued sync jobs for all of a user's accounts and pending send jobs for all of a user's sequences. */
export async function cancelUserJobs(userId: string) {
  const accounts = await db.mailAccount.findMany({ where: { userId }, select: { id: true } });
  await cancelAccountJobs(accounts.map((a) => a.id));
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.sequenceEnrollment.findMany({
      where: { status: "active", sequence: { userId } }, select: { id: true, currentStep: true },
      orderBy: { id: "asc" }, take: 1000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    await removeJobs(QUEUES.sequences, rows.map((e) => `send-${e.id}-${e.currentStep}`));
  }
}
