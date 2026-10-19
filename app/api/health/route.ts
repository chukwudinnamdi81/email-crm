import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { syncQueueCounts, workerAlive } from "@/lib/worker-status";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks = { db: false, redis: false };
  try {
    await db.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {}
  try {
    checks.redis = (await redis().ping()) === "PONG";
  } catch {}
  const ok = checks.db && checks.redis;
  // worker + queue info is informational only: it never fails the health check
  const extra = checks.redis ? { worker: await workerAlive(), syncQueue: await syncQueueCounts() } : { worker: null, syncQueue: null };
  return Response.json({ ok, ...checks, ...extra }, { status: ok ? 200 : 503 });
}
