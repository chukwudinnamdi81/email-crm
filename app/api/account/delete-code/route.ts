import { authed, fail, json } from "@/lib/api";
import { createEmailCode } from "@/lib/auth";
import { rateLimit } from "@/lib/redis";
import { sendSiteEmail } from "@/lib/mail/site-mailer";
import { deleteAccountCode } from "@/lib/mail/site-templates";

/** Emails a fresh code that confirms account deletion (for users who sign in with Google and have no usable password). */
export const POST = authed(async (_req, user) => {
  if (!(await rateLimit(`account-delete-code:${user.id}`, 3, 3600))) return fail("Too many requests. Try again later.", 429);
  const code = await createEmailCode(user.id, "ACCOUNT_DELETE");
  const r = await sendSiteEmail({ kind: "verify", to: user.email, ...deleteAccountCode(code) });
  if (!r.ok) return fail("Could not send the code. Try again later.", 503);
  return json({ ok: true });
});
