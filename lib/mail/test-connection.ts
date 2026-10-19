import net from "net";
import type { MailAccount } from "@prisma/client";
import { db } from "../db";
import { assertSafeTarget, errText } from "../net-guard";
import { imapFor, OAUTH, smtpFor } from "./transport";

type Kind = "IMAP" | "SMTP";
type Security = "SSL" | "STARTTLS";
type Endpoint = { host: string; port: number; security: Security };
export type Part = { ok: boolean; message: string };
export type TestResult = {
  ok: boolean;
  /** "OK" or the problem text (kept for existing callers). */
  imap: string;
  smtp: string;
  imapOk: boolean;
  smtpOk: boolean;
  imapDetail: Part;
  smtpDetail: Part;
};

const CONNECT_TIMEOUT_MS = 6000;

function hint(kind: Kind, msg: string): string {
  if (/535|AUTHENTICATIONFAILED|auth|invalid credentials|username and password/i.test(msg)) return "Wrong app password, or IMAP is not enabled for this account.";
  if (kind === "IMAP" && /unexpected close|ECONNRESET/i.test(msg)) return "Check the port/security pairing (993=SSL, 143=STARTTLS) or that the outbound port isn't blocked.";
  if (kind === "SMTP" && /timeout|ETIMEDOUT/i.test(msg)) return "Outbound SMTP port may be blocked by the host; try 587 + STARTTLS.";
  return "";
}

function endpointOf(kind: Kind, a: MailAccount): Endpoint {
  const o = a.method === "MANUAL" ? null : OAUTH[a.method as keyof typeof OAUTH];
  return kind === "IMAP"
    ? { host: a.imapHost ?? o?.imap.host ?? "", port: a.imapPort ?? o?.imap.port ?? 993, security: (a.imapSecurity ?? o?.imap.security ?? "SSL") as Security }
    : { host: a.smtpHost ?? o?.smtp.host ?? "", port: a.smtpPort ?? o?.smtp.port ?? 465, security: (a.smtpSecurity ?? o?.smtp.security ?? "SSL") as Security };
}

const label = (e: Endpoint) => `${e.host}:${e.port} (${e.security})`;

function describe(kind: Kind, e: Endpoint, err: unknown): string {
  const msg = errText(err);
  const h = hint(kind, msg);
  return `${kind} ${label(e)}: ${msg}${h ? ` — ${h}` : ""}`;
}

/** Plain TCP reachability check (no login). Resolves with a reason on failure. */
function tcpReach(host: string, port: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (r: { ok: true } | { ok: false; reason: string }) => { s.destroy(); resolve(r); };
    s.setTimeout(CONNECT_TIMEOUT_MS, () => end({ ok: false, reason: "connection timed out" }));
    s.once("connect", () => end({ ok: true }));
    s.once("error", (e: NodeJS.ErrnoException) => end({ ok: false, reason: e.code === "ECONNREFUSED" ? "connection refused" : e.code === "ENOTFOUND" ? "host not found" : (e.message || "connection failed") }));
  });
}

function unreachable(kind: Kind, e: Endpoint, reason: string): string {
  const base = `${kind} ${label(e)} unreachable from this server (${reason}).`;
  return kind === "SMTP" && /timed out/.test(reason) ? `${base} Your hosting provider is probably blocking outbound SMTP.` : base;
}

const isHostedBig = (host: string) => /(^|\.)(gmail|googlemail|google|outlook|office365|microsoft|hotmail|live)\.com$/i.test(host);

async function testImap(a: MailAccount): Promise<Part> {
  const e = endpointOf("IMAP", a);
  if (!e.host) return { ok: false, message: "IMAP host not set" };
  const r = await tcpReach(e.host, e.port);
  if (!r.ok) return { ok: false, message: unreachable("IMAP", e, r.reason) };
  try {
    const c = await imapFor(a);
    c.on("error", () => {});
    await c.connect();
    await c.logout();
    return { ok: true, message: "OK" };
  } catch (err) {
    return { ok: false, message: describe("IMAP", e, err) };
  }
}

async function testSmtp(a: MailAccount): Promise<Part> {
  const e = endpointOf("SMTP", a);
  if (!e.host) return { ok: false, message: "SMTP host not set" };
  let failure: string;
  let connectFailed = false;
  const r = await tcpReach(e.host, e.port);
  if (r.ok) {
    try {
      await (await smtpFor(a)).verify();
      return { ok: true, message: "OK" };
    } catch (err) {
      failure = describe("SMTP", e, err);
      connectFailed = /timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|unexpected close/i.test(errText(err));
    }
  } else {
    failure = unreachable("SMTP", e, r.reason);
    connectFailed = true;
  }
  if (a.method === "MANUAL" && connectFailed) {
    const alts: Endpoint[] = [465, 587, ...(isHostedBig(e.host) ? [] : [2525])]
      .filter((p) => p !== e.port)
      .map((port) => ({ host: e.host, port, security: port === 465 ? "SSL" : "STARTTLS" }));
    for (const alt of alts) {
      try {
        await assertSafeTarget(alt.host, alt.port, "smtp");
        if (!(await tcpReach(alt.host, alt.port)).ok) continue;
        await (await smtpFor({ ...a, smtpPort: alt.port, smtpSecurity: alt.security })).verify();
        await db.mailAccount.update({ where: { id: a.id }, data: { smtpPort: alt.port, smtpSecurity: alt.security } });
        return { ok: true, message: "OK" };
      } catch {
        // try the next alternative; keep the original error
      }
    }
  }
  return { ok: false, message: failure };
}

export async function testAccount(a: MailAccount): Promise<TestResult> {
  const [imap, smtp] = await Promise.all([testImap(a), testSmtp(a)]);
  return { ok: imap.ok && smtp.ok, imap: imap.message, smtp: smtp.message, imapOk: imap.ok, smtpOk: smtp.ok, imapDetail: imap, smtpDetail: smtp };
}

/** Account columns for a finished test: reading works when IMAP works; an SMTP problem is a non-fatal note. */
export function testOutcome(t: Pick<TestResult, "imapOk" | "smtpOk" | "imap" | "smtp">) {
  const lastError = !t.imapOk ? [t.imap, t.smtpOk ? null : t.smtp].filter(Boolean).join(" | ") : t.smtpOk ? null : `Sending unavailable: ${t.smtp}`;
  return { status: t.imapOk ? "connected" : "error", lastError, lastTestedAt: new Date() };
}
