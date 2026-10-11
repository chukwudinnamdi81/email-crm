import type { MailAccount } from "@prisma/client";
import { db } from "../db";
import { assertSafeTarget, errText } from "../net-guard";
import { imapFor, smtpFor } from "./transport";

function hint(kind: "IMAP" | "SMTP", msg: string): string {
  if (/535|AUTHENTICATIONFAILED|auth|invalid credentials|username and password/i.test(msg)) return "Wrong app password, or IMAP is not enabled for this account.";
  if (kind === "IMAP" && /unexpected close|ECONNRESET/i.test(msg)) return "Check the port/security pairing (993=SSL, 143=STARTTLS) or that the outbound port isn't blocked.";
  if (kind === "SMTP" && /timeout|ETIMEDOUT/i.test(msg)) return "Outbound SMTP port may be blocked by the host; try 587 + STARTTLS.";
  return "";
}

function describe(kind: "IMAP" | "SMTP", a: MailAccount, e: unknown): string {
  const msg = errText(e);
  const host = kind === "IMAP" ? a.imapHost : a.smtpHost;
  const port = kind === "IMAP" ? a.imapPort : a.smtpPort;
  const sec = kind === "IMAP" ? a.imapSecurity : a.smtpSecurity;
  const where = host ? ` ${host}:${port ?? ""} (${sec ?? "SSL"})` : "";
  const h = hint(kind, msg);
  return `${kind}${where}: ${msg}${h ? ` — ${h}` : ""}`;
}

const isConnectFail = (e: unknown) => /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|unexpected close/i.test(errText(e));

export async function testAccount(a: MailAccount): Promise<{ ok: boolean; imap: string; smtp: string }> {
  let imap = "OK";
  let smtp = "OK";
  try {
    const c = await imapFor(a);
    c.on("error", () => {});
    await c.connect();
    await c.logout();
  } catch (e) {
    imap = describe("IMAP", a, e);
  }
  try {
    await (await smtpFor(a)).verify();
  } catch (e) {
    smtp = describe("SMTP", a, e);
    if (a.method === "MANUAL" && a.smtpHost && isConnectFail(e)) {
      const alt = a.smtpPort === 587 ? { smtpPort: 465, smtpSecurity: "SSL" } : { smtpPort: 587, smtpSecurity: "STARTTLS" };
      try {
        await assertSafeTarget(a.smtpHost, alt.smtpPort, "smtp");
        await (await smtpFor({ ...a, ...alt })).verify();
        await db.mailAccount.update({ where: { id: a.id }, data: alt });
        smtp = "OK";
      } catch {
        // keep the original error
      }
    }
  }
  return { ok: imap === "OK" && smtp === "OK", imap, smtp };
}
