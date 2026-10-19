import { authed, fail } from "@/lib/api";
import { rateLimit } from "@/lib/redis";
import { exportJson, exportMessages, toStream } from "@/lib/export";

/** Data export. `?messages=1` downloads synced mail as NDJSON instead (can be huge, so it is its own streamed file). */
export const POST = authed(async (req, user) => {
  if (!(await rateLimit(`account-export:${user.id}`, 3, 3600))) return fail("Too many exports. Try again later.", 429);
  const messages = new URL(req.url).searchParams.get("messages") === "1";
  console.log(`[audit] data export user=${user.id} messages=${messages}`);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(toStream(messages ? exportMessages(user.id) : exportJson(user.id)), {
    headers: messages
      ? { "content-type": "application/x-ndjson", "content-disposition": `attachment; filename="mail-crm-messages-${date}.ndjson"`, "cache-control": "no-store" }
      : { "content-type": "application/json", "content-disposition": `attachment; filename="mail-crm-export-${date}.json"`, "cache-control": "no-store" },
  });
});
