import { z } from "zod";
import { db } from "@/lib/db";
import { authed, body, fail, HttpError, json } from "@/lib/api";
import { checkUserCode, destroySession, verifyPassword } from "@/lib/auth";
import { deleteUserData } from "@/lib/account-data";
import { cancelUserJobs } from "@/lib/queues";
import { rateLimit } from "@/lib/redis";
import { sendSiteEmail } from "@/lib/mail/site-mailer";
import { accountDeleted } from "@/lib/mail/site-templates";

const schema = z.object({
  confirm: z.literal("DELETE"),
  password: z.string().min(1).optional(),
  code: z.string().regex(/^\d{6}$/).optional(),
});

export const DELETE = authed(async (req, user) => {
  if (!(await rateLimit(`account-delete:${user.id}`, 5, 3600))) return fail("Too many attempts. Try again later.", 429);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError('Type DELETE to confirm and enter your password (or the emailed code).', 400);
  const { password, code } = parsed.data;
  const row = await db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true, googleSub: true } });
  if (!row) throw new HttpError("Unauthorized", 401);
  // Google sign-up users get a random password nobody knows, so they confirm with an emailed code instead
  const ok = password ? await verifyPassword(row.passwordHash, password) : code && row.googleSub ? await checkUserCode(user.id, code, "ACCOUNT_DELETE") : false;
  if (!ok) throw new HttpError(password ? "Wrong password" : "Wrong or expired code", 403);

  try {
    await cancelUserJobs(user.id); // best effort: workers also tolerate rows that are already gone
  } catch {
    console.warn("[account] could not cancel queued jobs");
  }
  await deleteUserData(user.id);
  console.log(`[audit] account deleted user=${user.id}`);
  await destroySession(); // rows are already gone; this clears the cookie
  const sent = await sendSiteEmail({ kind: "notice", to: user.email, ...accountDeleted() }).catch(() => null);
  if (!sent?.ok) console.warn("[account] deletion confirmation email not sent");
  return json({ ok: true });
});
