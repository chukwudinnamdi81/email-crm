import { z } from "zod";
import { authed, body, fail, json } from "@/lib/api";
import { rateLimit } from "@/lib/redis";
import { discoverMailSettings } from "@/lib/mail/autodiscover";

/** Looks up IMAP/SMTP settings for an email address. Never takes a password. */
export const POST = authed(async (req, user) => {
  const { email } = await body(req, z.object({ email: z.string().email() }));
  if (!(await rateLimit(`discover:${user.id}`, 20, 600))) return fail("Too many lookups. Try again in a few minutes.", 429);
  return json(await discoverMailSettings(email));
});
