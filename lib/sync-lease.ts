import type IORedis from "ioredis";
import { redis } from "./redis";

export const LEASE_TTL_MS = 120_000;
const key = (userId: string) => `sync:lease:${userId}`;

/** Reference semantics of the Lua script below (also used by tests): drop expired, refresh if held, else take a slot if under the cap. */
export function applyLease(z: Map<string, number>, now: number, cap: number, member: string, expiry: number): boolean {
  for (const [m, s] of z) if (s <= now) z.delete(m);
  if (z.has(member) || z.size < cap) { z.set(member, expiry); return true; }
  return false;
}

const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) or redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ${LEASE_TTL_MS * 2})
  return 1
end
return 0`;

type Evalable = Pick<IORedis, "eval" | "zrem">;

/** Atomically takes (or refreshes) a per-user slot. Fails OPEN when Redis is unavailable. */
export async function acquireLease(userId: string, jobId: string, cap: number, r: Evalable = redis(), now = Date.now()): Promise<boolean> {
  try {
    return (await r.eval(ACQUIRE, 1, key(userId), now, cap, jobId, now + LEASE_TTL_MS)) === 1;
  } catch (e) {
    console.warn("[sync] lease unavailable, running without a per-user cap:", e instanceof Error ? e.message : "unknown");
    return true;
  }
}

export const refreshLease = (userId: string, jobId: string, cap: number, r?: Evalable, now?: number) => acquireLease(userId, jobId, cap, r, now);

export async function releaseLease(userId: string, jobId: string, r: Evalable = redis()): Promise<void> {
  await r.zrem(key(userId), jobId).catch(() => 0);
}
