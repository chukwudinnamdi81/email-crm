import IORedis from "ioredis";

const g = globalThis as unknown as { redis?: IORedis };

export function redis(): IORedis {
  if (!g.redis) {
    if (!process.env.REDIS_URL && process.env.NODE_ENV === "production") {
      console.warn("[redis] REDIS_URL is not set in production; falling back to redis://localhost:6379");
    }
    // maxRetriesPerRequest: null is required by BullMQ; callers that must not hang use timeouts (see rateLimit)
    g.redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    let lastLog = 0;
    g.redis.on("error", (e: NodeJS.ErrnoException) => {
      const now = Date.now();
      if (now - lastLog < 30_000) return;
      lastLog = now;
      console.error("[redis] connection error:", e.code ?? e.name ?? "unknown");
    });
  }
  return g.redis;
}

/**
 * Fixed-window rate limiter. Returns true if allowed.
 * Redis errors/timeouts throw (fail closed) unless opts.failOpen, in which case it returns true.
 */
export async function rateLimit(key: string, limit: number, windowSec: number, opts?: { failOpen?: boolean }): Promise<boolean> {
  const timeoutMs = Number(process.env.REDIS_TIMEOUT_MS) > 0 ? Number(process.env.REDIS_TIMEOUT_MS) : 1500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = async () => {
      const r = redis();
      const k = `rl:${key}`;
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, windowSec);
      return n <= limit;
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("redis timeout")), timeoutMs);
    });
    return await Promise.race([run(), timeout]);
  } catch (e) {
    if (opts?.failOpen) {
      console.warn("[redis] unavailable, rate limit skipped for", key.split(":")[0]);
      return true;
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
