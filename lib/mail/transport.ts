import { ImapFlow } from "imapflow";
import nodemailer, { Transporter } from "nodemailer";
import type { MailAccount, SmtpSender } from "@prisma/client";
import { db } from "../db";
import { decrypt, encrypt } from "../crypto";

export const OAUTH = {
  GOOGLE: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://mail.google.com/ openid email",
    idEnv: "GOOGLE_CLIENT_ID", secretEnv: "GOOGLE_CLIENT_SECRET",
    imap: { host: "imap.gmail.com", port: 993, security: "SSL" }, smtp: { host: "smtp.gmail.com", port: 465, security: "SSL" },
  },
  MICROSOFT: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
    idEnv: "MICROSOFT_CLIENT_ID", secretEnv: "MICROSOFT_CLIENT_SECRET",
    imap: { host: "outlook.office365.com", port: 993, security: "SSL" }, smtp: { host: "smtp.office365.com", port: 587, security: "STARTTLS" },
  },
} as const;

async function accessToken(a: MailAccount): Promise<string> {
  if (a.accessTokenEnc && a.accessTokenExp && a.accessTokenExp.getTime() > Date.now() + 60_000) return decrypt(a.accessTokenEnc);
  const cfg = OAUTH[a.method as keyof typeof OAUTH];
  if (!cfg || !a.refreshTokenEnc) throw new Error("OAuth account has no refresh token; reconnect it");
  const r = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env[cfg.idEnv] ?? "", client_secret: process.env[cfg.secretEnv] ?? "",
      grant_type: "refresh_token", refresh_token: decrypt(a.refreshTokenEnc),
    }),
  });
  const j = (await r.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`OAuth refresh failed: ${j.error_description ?? r.status}`);
  const exp = new Date(Date.now() + (j.expires_in ?? 3000) * 1000);
  await db.mailAccount.update({ where: { id: a.id }, data: { accessTokenEnc: encrypt(j.access_token), accessTokenExp: exp } });
  return j.access_token;
}

async function auth(a: MailAccount): Promise<{ user: string; pass?: string; accessToken?: string }> {
  if (a.method === "MANUAL") return { user: a.username ?? a.email, pass: a.passwordEnc ? decrypt(a.passwordEnc) : "" };
  return { user: a.email, accessToken: await accessToken(a) };
}

export async function imapFor(a: MailAccount): Promise<ImapFlow> {
  const o = a.method === "MANUAL" ? null : OAUTH[a.method as keyof typeof OAUTH];
  const host = a.imapHost ?? o?.imap.host ?? "";
  const port = a.imapPort ?? o?.imap.port ?? 993;
  const security = a.imapSecurity ?? o?.imap.security ?? "SSL";
  return new ImapFlow({
    host, port, secure: security === "SSL", doSTARTTLS: security === "STARTTLS" ? true : undefined,
    auth: await auth(a), logger: false, connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 120_000,
  });
}

export async function smtpFor(a: MailAccount): Promise<Transporter> {
  const o = a.method === "MANUAL" ? null : OAUTH[a.method as keyof typeof OAUTH];
  const host = a.smtpHost ?? o?.smtp.host ?? "";
  const port = a.smtpPort ?? o?.smtp.port ?? 465;
  const security = a.smtpSecurity ?? o?.smtp.security ?? "SSL";
  const au = await auth(a);
  return nodemailer.createTransport({
    host, port, secure: security === "SSL", requireTLS: security === "STARTTLS",
    auth: au.accessToken ? { type: "OAuth2", user: au.user, accessToken: au.accessToken } : { user: au.user, pass: au.pass ?? "" },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
}

export function smtpSenderTransport(s: SmtpSender): Transporter {
  return nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.security === "SSL",
    requireTLS: s.security === "STARTTLS", ignoreTLS: s.security === "NONE",
    auth: s.username ? { user: s.username, pass: s.passwordEnc ? decrypt(s.passwordEnc) : "" } : undefined,
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
}
