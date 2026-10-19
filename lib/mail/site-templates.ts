const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

type Mail = { subject: string; text: string; html: string };

const wrap = (inner: string) =>
  `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#111;line-height:1.5">${inner}<p style="color:#666;font-size:12px;margin-top:24px">Mail CRM</p></div>`;

export function verifyEmailCode(code: string): Mail {
  return {
    subject: `Your Mail CRM confirmation code: ${code}`,
    text: `Your Mail CRM confirmation code is ${code}\n\nIt expires in 15 minutes.\nNever share this code with anyone.\n\nIf you didn't request this, you can ignore this email.`,
    html: wrap(
      `<p>Your confirmation code:</p><p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;letter-spacing:6px;font-weight:700;margin:12px 0">${esc(code)}</p>` +
        `<p>It expires in 15 minutes. Never share this code with anyone.</p><p>If you didn't request this, you can ignore this email.</p>`,
    ),
  };
}

export function resetPassword(link: string): Mail {
  return {
    subject: "Reset your Mail CRM password",
    text: `Use this link to choose a new password (it expires in 1 hour):\n\n${link}\n\nIf you didn't request this, you can ignore this email.`,
    html: wrap(
      `<p>Use this button to choose a new password. The link expires in 1 hour.</p><p><a href="${esc(link)}" style="display:inline-block;background:#2557d6;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reset password</a></p>` +
        `<p style="font-size:13px;color:#555">Or paste this address into your browser:<br>${esc(link)}</p><p>If you didn't request this, you can ignore this email.</p>`,
    ),
  };
}

export function passwordChanged(): Mail {
  return {
    subject: "Your Mail CRM password was changed",
    text: "The password for your Mail CRM account was just changed and you were signed out everywhere.\n\nIf this wasn't you, reset your password again right away.",
    html: wrap(`<p>The password for your Mail CRM account was just changed and you were signed out everywhere.</p><p>If this wasn't you, reset your password again right away.</p>`),
  };
}

export function accountExists({ loginUrl, resetUrl }: { loginUrl: string; resetUrl: string }): Mail {
  return {
    subject: "You already have a Mail CRM account",
    text: `Someone (hopefully you) tried to create an account with this address. You already have one.\n\nLog in: ${loginUrl}\nReset your password: ${resetUrl}\n\nIf this wasn't you, ignore this email.`,
    html: wrap(
      `<p>Someone (hopefully you) tried to create an account with this address. You already have one.</p>` +
        `<p><a href="${esc(loginUrl)}">Log in</a> &middot; <a href="${esc(resetUrl)}">Reset your password</a></p><p>If this wasn't you, ignore this email.</p>`,
    ),
  };
}

export function deleteAccountCode(code: string): Mail {
  return {
    subject: `Your Mail CRM account deletion code: ${code}`,
    text: `Use this code to confirm deleting your Mail CRM account and all its data: ${code}\n\nIt expires in 15 minutes.\nNever share this code with anyone.\n\nIf you didn't request this, you can ignore this email and your account stays as it is.`,
    html: wrap(
      `<p>Use this code to confirm deleting your Mail CRM account and all its data:</p><p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;letter-spacing:6px;font-weight:700;margin:12px 0">${esc(code)}</p>` +
        `<p>It expires in 15 minutes. Never share this code with anyone.</p><p>If you didn't request this, you can ignore this email and your account stays as it is.</p>`,
    ),
  };
}

export function accountDeleted(): Mail {
  return {
    subject: "Your Mail CRM account was deleted",
    text: "Your Mail CRM account and all the data in it (synced mail, contacts, sequences and connected mailbox credentials) were deleted. Mail on your own mail servers was not touched.\n\nBackups age out per our backup policy. If this wasn't you, contact us right away.",
    html: wrap(
      `<p>Your Mail CRM account and all the data in it (synced mail, contacts, sequences and connected mailbox credentials) were deleted. Mail on your own mail servers was not touched.</p>` +
        `<p>Backups age out per our backup policy. If this wasn't you, contact us right away.</p>`,
    ),
  };
}
