import { z } from "zod";
import { db } from "@/lib/db";
import { createEmailCode, createSession, verifyPassword } from "@/lib/auth";
import { fail, json } from "@/lib/api";
import { rateLimit } from "@/lib/redis";
import { sendSiteEmail } from "@/lib/mail/site-mailer";
import { verifyEmailCode } from "@/lib/mail/site-templates";

const schema = z.object({ email: z.string().email().toLowerCase(), password: z.string().min(1) });

export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local";
  if (!(await rateLimit(`login:${ip}`, 20, 900, { failOpen: true }))) return fail("Too many attempts", 429);
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Invalid credentials", 401);
  const user = await db.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !(await verifyPassword(user.passwordHash, parsed.data.password))) return fail("Invalid credentials", 401);
  if (!user.emailVerifiedAt) {
    const newest = await db.authToken.findFirst({ where: { userId: user.id, purpose: "EMAIL_VERIFY" }, orderBy: { createdAt: "desc" } });
    if (!newest || Date.now() - newest.createdAt.getTime() > 60_000) {
      void createEmailCode(user.id)
        .then((code) => sendSiteEmail({ kind: "verify", to: user.email, ...verifyEmailCode(code) }))
        .catch(() => console.error("login: could not send confirmation code"));
    }
    return json({ error: "Please confirm your email first", code: "EMAIL_NOT_VERIFIED", email: user.email }, 403);
  }
  await createSession(user.id);
  return json({ ok: true });
}
