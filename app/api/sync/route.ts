import { z } from "zod";
import { db } from "@/lib/db";
import { authed, body, HttpError, json } from "@/lib/api";
import { startSync } from "@/lib/queues";
import { computeProgress, overallProgress } from "@/lib/sync-progress";
import { workerAlive } from "@/lib/worker-status";

/** True state comes from the DB, so it is correct after the browser was closed. */
export const GET = authed(async (_req, user) => {
  const accounts = await db.mailAccount.findMany({
    where: { userId: user.id },
    include: { folders: { orderBy: { path: "asc" } }, syncJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const now = Date.now();
  const rows = accounts.map((a) => {
    const job = a.syncJobs[0] ?? null;
    return {
      accountId: a.id, label: a.label, email: a.email, status: a.status, lastSyncAt: a.lastSyncAt, lastError: a.lastError,
      syncWindowDays: a.syncWindowDays,
      job: job && { ...job, queuedSince: job.status === "queued" ? job.createdAt : null, progress: computeProgress(job, now) },
      folders: a.folders.map((f) => ({
        id: f.id, path: f.path, specialUse: f.specialUse, total: f.totalMessages, fetched: f.fetched, done: f.done,
        // what this run has to do (so a 20k folder with 12 new mails doesn't show 20k), when a run is known
        pending: f.runTotal > 0 ? f.runTotal : null, processed: f.runDone,
      })),
    };
  });
  const active = rows.filter((r) => r.job && (r.job.status === "queued" || r.job.status === "running")).map((r) => r.job!.progress);
  return json({ accounts: rows, overall: overallProgress(active), workerAlive: await workerAlive() });
});

export const POST = authed(async (req, user) => {
  const d = await body(req, z.object({ accountId: z.string().optional() }));
  const accs = await db.mailAccount.findMany({
    where: { userId: user.id, status: { not: "disconnected" }, ...(d.accountId ? { id: d.accountId } : {}) }, select: { id: true },
  });
  if (d.accountId && !accs.length) throw new HttpError("Account not found", 404);
  for (const a of accs) await startSync(a.id, { source: "manual" }); // one job per account; worker runs them in parallel up to SYNC_CONCURRENCY
  return json({ queued: accs.length });
});
