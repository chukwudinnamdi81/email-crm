import { z } from "zod";
import { db } from "@/lib/db";
import { createEmailCode, hashPassword } from "@/lib/auth";
import { fail, json } from "@/lib/api";
import { rateLimit } from "@/lib/redis";
import { isDisposableEmail } from "@/lib/disposable-domains";
import { sendSiteEmail, SiteMailResult } from "@/lib/mail/site-mailer";
import { accountExists, verifyEmailCode } from "@/lib/mail/site-templates";
import { appUrl, newAccountAllowed, signupsEnabled } from "@/lib/signup-guard";

const schema = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(8).max(200) });

function mailFailure(r: SiteMailResult) {
  if (r.ok) return null;
  if (r.reason === "not_configured") return fail("Email confirmation isn't configured", 503);
  if (r.reason === "rate_limited") return fail("Too many emails right now, try again in a few minutes", 429);
  return fail("We couldn't send the email, please try Resend in a minute", 502);
}

export async function POST(req: Request) {
  if (!signupsEnabled()) return fail("Sign-ups are currently closed", 403);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  if (!(await rateLimit(`signup:${ip}`, 10, 3600, { failOpen: true }))) return fail("Too many attempts", 429);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Valid email and a password of 8+ characters are required");
  const { email, password } = parsed.data;
  if (isDisposableEmail(email)) return fail("Please use a permanent email address", 400);

  const passwordHash = await hashPassword(password); // same hashing work for new and existing addresses
  const existing = await db.user.findUnique({ where: { email } });

  if (existing?.emailVerifiedAt) {
    const r = await sendSiteEmail({
      kind: "notice", to: email,
      ...accountExists({ loginUrl: `${appUrl()}/login`, resetUrl: `${appUrl()}/forgot-password` }),
    });
    const bad = mailFailure(r);
    if (bad) return bad;
    return json({ ok: true, verify: true, email });
  }

  if (!existing && !(await newAccountAllowed())) return fail("We're getting a lot of sign-ups right now, please try again later", 429);

  let userId: string;
  if (existing) {
    // pending sign-up: take over with the new password so nobody can squat on someone else's address
    await db.$transaction([
      db.user.update({ where: { id: existing.id }, data: { passwordHash } }),
      db.session.deleteMany({ where: { userId: existing.id } }),
    ]);
    userId = existing.id;
  } else {
    userId = (await db.user.create({ data: { email, passwordHash } })).id;
  }
  const code = await createEmailCode(userId);
  const bad = mailFailure(await sendSiteEmail({ kind: "verify", to: email, ...verifyEmailCode(code) }));
  if (bad) return bad;
  return json({ ok: true, verify: true, email });
}
