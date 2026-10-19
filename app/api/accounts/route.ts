import { z } from "zod";
import { db } from "@/lib/db";
import { authed, body, json } from "@/lib/api";
import { encrypt } from "@/lib/crypto";
import { assertSafeTarget, normalizePassword } from "@/lib/net-guard";
import { testAccount, testOutcome } from "@/lib/mail/test-connection";
import { publicAccount } from "@/lib/serialize";
import { startSync } from "@/lib/queues";
import { DEFAULT_WINDOW_DAYS, windowSchema } from "@/lib/sync-window";

const accountSchema = z.object({
  label: z.string().min(1).max(80),
  email: z.string().email(),
  imapHost: z.string().min(1), imapPort: z.number().int(), imapSecurity: z.enum(["SSL", "STARTTLS"]),
  smtpHost: z.string().min(1), smtpPort: z.number().int(), smtpSecurity: z.enum(["SSL", "STARTTLS"]),
  username: z.string().min(1),
  password: z.string().min(1),
  syncWindowDays: windowSchema.optional(),
});

export const GET = authed(async (_req, user) => {
  const rows = await db.mailAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  return json(rows.map(publicAccount));
});

export const POST = authed(async (req, user) => {
  const d = await body(req, accountSchema);
  await assertSafeTarget(d.imapHost, d.imapPort, "imap").catch((e) => { throw new Error(`IMAP: ${e.message}`); });
  await assertSafeTarget(d.smtpHost, d.smtpPort, "smtp").catch((e) => { throw new Error(`SMTP: ${e.message}`); });
  const { password, syncWindowDays, ...rest } = d;
  const acc = await db.mailAccount.create({ data: { ...rest, userId: user.id, method: "MANUAL", syncWindowDays: syncWindowDays === undefined ? DEFAULT_WINDOW_DAYS : syncWindowDays, passwordEnc: encrypt(normalizePassword(password, d.imapHost, d.smtpHost)) } });
  const t = await testAccount(acc);
  const updated = await db.mailAccount.update({ where: { id: acc.id }, data: testOutcome(t) });
  // first sync starts right away; a Redis outage must not fail account creation
  if (t.imapOk) await startSync(acc.id, { source: "manual" }).catch((e) => console.error("[accounts] could not start sync:", e instanceof Error ? e.message : "unknown"));
  return json({ account: publicAccount(updated), test: t }, 201);
});
