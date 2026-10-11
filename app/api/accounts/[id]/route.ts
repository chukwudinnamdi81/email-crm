import { z } from "zod";
import { db } from "@/lib/db";
import { authed, body, HttpError, json } from "@/lib/api";
import { encrypt } from "@/lib/crypto";
import { assertSafeTarget, normalizePassword } from "@/lib/net-guard";
import { testAccount } from "@/lib/mail/test-connection";
import { publicAccount } from "@/lib/serialize";

const patch = z.object({
  label: z.string().min(1).max(80).optional(),
  email: z.string().email().optional(),
  imapHost: z.string().optional(), imapPort: z.number().int().optional(), imapSecurity: z.enum(["SSL", "STARTTLS"]).optional(),
  smtpHost: z.string().optional(), smtpPort: z.number().int().optional(), smtpSecurity: z.enum(["SSL", "STARTTLS"]).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  autoDraft: z.boolean().optional(),
  defaultSmtpSenderId: z.string().nullable().optional(),
  disconnect: z.boolean().optional(),
  retest: z.boolean().optional(),
});

async function own(userId: string, id: string) {
  const a = await db.mailAccount.findFirst({ where: { id, userId } });
  if (!a) throw new HttpError("Not found", 404);
  return a;
}

export const PATCH = authed<{ id: string }>(async (req, user, { id }) => {
  const existing = await own(user.id, id);
  const { password, disconnect, retest, defaultSmtpSenderId, ...d } = await body(req, patch);
  if (defaultSmtpSenderId) {
    const s = await db.smtpSender.findFirst({ where: { id: defaultSmtpSenderId, userId: user.id } });
    if (!s) throw new HttpError("SMTP sender not found", 404);
  }
  if (d.imapHost && d.imapPort) await assertSafeTarget(d.imapHost, d.imapPort, "imap");
  if (d.smtpHost && d.smtpPort) await assertSafeTarget(d.smtpHost, d.smtpPort, "smtp");
  let acc = await db.mailAccount.update({
    where: { id },
    data: {
      ...d,
      ...(defaultSmtpSenderId !== undefined ? { defaultSmtpSenderId } : {}),
      ...(password ? { passwordEnc: encrypt(normalizePassword(password, d.imapHost ?? existing.imapHost, d.smtpHost ?? existing.smtpHost)) } : {}),
      ...(disconnect ? { status: "disconnected" } : {}),
    },
  });
  const connChanged = Boolean(password || d.imapHost || d.smtpHost || d.username || d.imapPort || d.smtpPort);
  if ((retest || connChanged) && !disconnect && existing.method) {
    const t = await testAccount(acc);
    acc = await db.mailAccount.update({
      where: { id },
      data: { status: t.ok ? "connected" : "error", lastError: t.ok ? null : [t.imap, t.smtp].filter((x) => x !== "OK").join(" | "), lastTestedAt: new Date() },
    });
  }
  return json(publicAccount(acc));
});

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  await own(user.id, id);
  await db.mailAccount.delete({ where: { id } }); // secrets live on the row
  return json({ ok: true });
});
