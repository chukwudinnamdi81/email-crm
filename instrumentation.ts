export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  try {
    const e = process.env;
    if (e.SERVICE && e.SERVICE !== "web") return;
    const issues: string[] = [];
    if (!e.REDIS_URL) issues.push("REDIS_URL is unset (falls back to localhost)");
    if (!e.DATABASE_URL) issues.push("DATABASE_URL is unset");
    if (!e.APP_URL || !e.APP_URL.startsWith("https://")) issues.push("APP_URL is unset or not https");
    if (!e.SITE_MAIL_FROM?.trim()) issues.push("SITE_MAIL_FROM is empty");
    if (!e.SITE_RESEND_API_KEY && !e.SITE_POSTMARK_TOKEN && !e.SITE_SMTP_HOST) issues.push("no site email provider (set SITE_RESEND_API_KEY / SITE_POSTMARK_TOKEN / SITE_SMTP_HOST)");
    if (e.SIGNUPS_ENABLED && !["true", "false"].includes(e.SIGNUPS_ENABLED.trim())) issues.push("SIGNUPS_ENABLED should be 'true' or 'false'");
    if (e.GOOGLE_CLIENT_ID && !e.GOOGLE_CLIENT_SECRET) issues.push("GOOGLE_CLIENT_SECRET is missing while GOOGLE_CLIENT_ID is set");
    if (!e.SITE_MAIL_MAX_PER_DAY) issues.push("SITE_MAIL_MAX_PER_DAY is at the default (100)");
    if (issues.length) console.warn(`[config] ${issues.join("; ")}`);
  } catch {
    /* never stop the server */
  }
}
