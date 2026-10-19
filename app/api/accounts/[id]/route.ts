import { z } from "zod";
import { db } from "@/lib/db";
import { authed, body, HttpError, json } from "@/lib/api";
import { encrypt } from "@/lib/crypto";
import { assertSafeTarget, normalizePassword } from "@/lib/net-guard";
import { testAccount, testOutcome } from "@/lib/mail/test-connection";
import { publicAccount } from "@/lib/serialize";
import { startSync } from "@/lib/queues";
import { isWidening, widenBackfillBelow, windowSchema } from "@/lib/sync-window";

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
  syncWindowDays: windowSchema.optional(),
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
      data: testOutcome(t),
    });
  }
  const kick = () => startSync(id, { source: "manual" }).catch((e) => console.error("[accounts] could not start sync:", e instanceof Error ? e.message : "unknown"));
  if (d.syncWindowDays !== undefined && isWidening(existing.syncWindowDays, d.syncWindowDays) && !disconnect) {
    // resume backfilling below what is already stored, using the wider window
    const mins = await db.message.groupBy({ by: ["folderId"], where: { accountId: id }, _min: { uid: true } });
    const minBy = new Map(mins.map((m) => [m.folderId, m._min.uid]));
    for (const f of await db.folder.findMany({ where: { accountId: id } })) {
      const below = widenBackfillBelow({ existingBelow: f.backfillBelow, minStoredUid: minBy.get(f.id) ?? null, lastUid: f.lastUid });
      if (below != null) await db.folder.update({ where: { id: f.id }, data: { backfillBelow: below } });
    }
    await kick();
  } else if (connChanged && !disconnect && acc.status === "connected") await kick();
  return json(publicAccount(acc));
});

export const DELETE = authed<{ id: string }>(async (_req, user, { id }) => {
  await own(user.id, id);
  await db.mailAccount.delete({ where: { id } }); // secrets live on the row
  return json({ ok: true });
});
