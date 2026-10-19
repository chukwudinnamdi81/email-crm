import { authed, fail, json } from "@/lib/api";
import { rateLimit } from "@/lib/redis";
import { rebuildContacts } from "@/lib/contacts-rebuild";

export const POST = authed(async (_req, user) => {
  if (!(await rateLimit(`contacts-rebuild:${user.id}`, 3, 3600))) return fail("Too many rebuilds. Try again later.", 429);
  return json(await rebuildContacts(user.id));
});
