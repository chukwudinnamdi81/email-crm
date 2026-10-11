import nodemailer from "nodemailer";
import { createHash } from "crypto";
import { rateLimit, redis } from "../redis";

// Sitewide transactional mailer (confirmation codes, password reset, notices).
// Relay/provider only, never direct-to-MX. Must NOT be used for sequences/outreach.

export type SiteMailKind = "verify" | "reset" | "notice";
export type SiteMailResult = { ok: true; provider: string } | { ok: false; reason: "not_configured" | "rate_limited" | "send_failed" };
type Msg = { to: string; subject: string; text: string; html: string };
type Outcome = "sent" | "retry" | "failed";

const env = (k: string) => process.env[k]?.trim() || "";
const num = (k: string, d: number) => {
  const n = Number(env(k));
  return Number.isFinite(n) && n > 0 ? n : d;
};
const log = (...a: unknown[]) => console.log("[site-mail]", ...a);
const LOG_BODY_MAX = 300;
let warnedNotConfigured = false;

const configured: Record<string, () => boolean> = {
  resend: () => !!env("SITE_RESEND_API_KEY"),
  postmark: () => !!env("SITE_POSTMARK_TOKEN"),
  smtp: () => !!env("SITE_SMTP_HOST"),
};

function providers(): string[] {
  const list = (env("SITE_MAIL_PROVIDERS") || "resend,postmark,smtp").split(",").map((s) => s.trim().toLowerCase());
  return list.filter((p) => configured[p]?.());
}

async function sendHttp(name: string, url: string, headers: Record<string, string>, payload: unknown): Promise<Outcome> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return "sent";
    const body = await r.text().catch(() => "");
    log(name, "status", r.status, body.replace(/\s+/g, " ").slice(0, LOG_BODY_MAX));
    return "retry";
  } catch {
    log(name, "network error");
    return "retry";
  }
}

const sendResend = (m: Msg) =>
  sendHttp("resend", "https://api.resend.com/emails", { Authorization: `Bearer ${env("SITE_RESEND_API_KEY")}` },
    { from: env("SITE_MAIL_FROM"), to: m.to, subject: m.subject, text: m.text, html: m.html });

const sendPostmark = (m: Msg) =>
  sendHttp("postmark", "https://api.postmarkapp.com/email", { "X-Postmark-Server-Token": env("SITE_POSTMARK_TOKEN") },
    { From: env("SITE_MAIL_FROM"), To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, MessageStream: "outbound" });

const CONN_CODES = new Set(["ETIMEDOUT", "ECONNREFUSED", "ESOCKET", "ECONNECTION", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"]);
const PORT_KEY = "sitemail:smtp:port";

async function sendSmtp(m: Msg): Promise<Outcome> {
  const ports = (env("SITE_SMTP_PORTS") || env("SITE_SMTP_PORT") || "587,465,2525")
    .split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0);
  try {
    const last = Number(await redis().get(PORT_KEY));
    if (last && ports.includes(last)) ports.splice(0, ports.length, last, ...ports.filter((p) => p !== last));
  } catch { /* port memory is best-effort */ }
  for (const port of ports) {
    const t = nodemailer.createTransport({
      host: env("SITE_SMTP_HOST"), port,
      secure: port === 465, requireTLS: port !== 465,
      auth: env("SITE_SMTP_USER") ? { user: env("SITE_SMTP_USER"), pass: env("SITE_SMTP_PASS") } : undefined,
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 20_000,
    });
    try {
      await t.sendMail({ from: env("SITE_MAIL_FROM"), to: m.to, subject: m.subject, text: m.text, html: m.html });
      redis().set(PORT_KEY, String(port), "EX", 6 * 3600).catch(() => {});
      return "sent";
    } catch (e) {
      const err = e as { code?: string; responseCode?: number };
      log("smtp port", port, "error", err.code ?? err.responseCode ?? "unknown");
      const conn = (err.code && CONN_CODES.has(err.code)) || (err.code === "ETIMEOUT");
      if (!conn) return err.responseCode && err.responseCode >= 400 && err.responseCode < 500 ? "retry" : "failed";
    } finally {
      t.close();
    }
  }
  return "retry";
}

const senders: Record<string, (m: Msg) => Promise<Outcome>> = { resend: sendResend, postmark: sendPostmark, smtp: sendSmtp };

/** Budget per provider; Redis errors propagate so the caller fails closed. */
async function providerBudget(p: string): Promise<boolean> {
  return (
    (await rateLimit(`sitemail:${p}:sec`, num("SITE_MAIL_MAX_PER_SECOND", 2), 1)) &&
    (await rateLimit(`sitemail:${p}:hour`, num("SITE_MAIL_MAX_PER_HOUR", 50), 3600)) &&
    (await rateLimit(`sitemail:${p}:day`, num("SITE_MAIL_MAX_PER_DAY", 100), 86400))
  );
}

export async function sendSiteEmail(input: Msg & { kind: SiteMailKind }): Promise<SiteMailResult> {
  try {
    const list = providers();
    if (!list.length || !env("SITE_MAIL_FROM")) {
      if (process.env.NODE_ENV === "production") {
        if (!warnedNotConfigured) {
          warnedNotConfigured = true;
          log("not configured: set SITE_MAIL_FROM and one of SITE_RESEND_API_KEY / SITE_POSTMARK_TOKEN / SITE_SMTP_HOST");
        }
        return { ok: false, reason: "not_configured" };
      }
      // DEV-ONLY fallback: prints the body (contains the code / link)
      console.log(`[site-mail:dev] to=${input.to} subject=${input.subject}\n${input.text}`);
      return { ok: true, provider: "console" };
    }
    const to = createHash("sha256").update(input.to.toLowerCase()).digest("hex");
    if (!(await rateLimit(`sitemail:to:${to}`, 5, 3600))) return { ok: false, reason: "rate_limited" };

    let skipped = 0;
    for (const p of list) {
      if (!(await providerBudget(p))) { skipped++; continue; }
      const out = await senders[p]({ to: input.to, subject: input.subject, text: input.text, html: input.html });
      if (out === "sent") return { ok: true, provider: p };
    }
    return { ok: false, reason: skipped === list.length ? "rate_limited" : "send_failed" };
  } catch {
    log("error (redis or provider unavailable)");
    return { ok: false, reason: "send_failed" };
  }
}
