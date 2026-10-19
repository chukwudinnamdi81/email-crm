import type { MailAccount, SmtpSender } from "@prisma/client";

export function publicAccount(a: MailAccount) {
  return {
    id: a.id, label: a.label, email: a.email, method: a.method,
    imapHost: a.imapHost, imapPort: a.imapPort, imapSecurity: a.imapSecurity,
    smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpSecurity: a.smtpSecurity,
    username: a.username, hasPassword: !!a.passwordEnc, passwordMasked: a.passwordEnc ? "••••••••" : null,
    status: a.status, lastError: a.lastError, lastTestedAt: a.lastTestedAt, lastSyncAt: a.lastSyncAt,
    defaultSmtpSenderId: a.defaultSmtpSenderId, autoDraft: a.autoDraft, syncWindowDays: a.syncWindowDays,
  };
}

export function publicSender(s: SmtpSender) {
  return {
    id: s.id, label: s.label, host: s.host, port: s.port, security: s.security, username: s.username,
    passwordMasked: s.passwordEnc ? "••••••••" : null, fromName: s.fromName, fromEmail: s.fromEmail,
    replyTo: s.replyTo, isDefault: s.isDefault, status: s.status, lastTestedAt: s.lastTestedAt,
    lastError: s.lastError, hintDismissed: s.hintDismissed, dailyLimit: s.dailyLimit,
  };
}
