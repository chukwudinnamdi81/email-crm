import { currentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt, verifyToken } from "@/lib/crypto";
import { OAUTH } from "@/lib/mail/transport";
import { startSync } from "@/lib/queues";
import { DEFAULT_WINDOW_DAYS } from "@/lib/sync-window";
import { testAccount, testOutcome } from "@/lib/mail/test-connection";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const user = await currentUser();
  const st = verifyToken(u.searchParams.get("state") ?? "");
  const code = u.searchParams.get("code");
  const back = (q: string) => Response.redirect(`${process.env.APP_URL}/accounts?${q}`);
  if (!user || !st || st.u !== user.id || Date.now() - Number(st.t) > 600_000 || !code) return back("oauth=failed");
  const cfg = OAUTH[st.p as keyof typeof OAUTH];
  if (!cfg) return back("oauth=failed");
  const r = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env[cfg.idEnv] ?? "", client_secret: process.env[cfg.secretEnv] ?? "", code,
      grant_type: "authorization_code", redirect_uri: `${process.env.APP_URL}/api/oauth/callback`,
    }),
  });
  const j = (await r.json()) as { access_token?: string; refresh_token?: string; id_token?: string; expires_in?: number };
  if (!r.ok || !j.access_token || !j.refresh_token || !j.id_token) return back("oauth=failed");
  const claims = JSON.parse(Buffer.from(j.id_token.split(".")[1], "base64url").toString()) as { email?: string; preferred_username?: string };
  const email = claims.email ?? claims.preferred_username;
  if (!email) return back("oauth=failed");
  const tokens = {
    refreshTokenEnc: encrypt(j.refresh_token), accessTokenEnc: encrypt(j.access_token),
    accessTokenExp: new Date(Date.now() + (j.expires_in ?? 3000) * 1000),
  };
  // reconnecting the same address refreshes its tokens instead of adding a duplicate row (no DB unique key exists for this)
  const existing = await db.mailAccount.findFirst({ where: { userId: user.id, email, method: st.p } });
  const acc = existing
    ? await db.mailAccount.update({ where: { id: existing.id }, data: tokens })
    : await db.mailAccount.create({
        data: { userId: user.id, label: `${st.p === "GOOGLE" ? "Gmail" : "Outlook"} ${email}`, email, method: st.p, syncWindowDays: DEFAULT_WINDOW_DAYS, ...tokens },
      });
  const t = await testAccount(acc);
  await db.mailAccount.update({ where: { id: acc.id }, data: testOutcome(t) });
  if (t.imapOk) await startSync(acc.id, { source: "manual" }).catch((e) => console.error("[oauth] could not start sync:", e instanceof Error ? e.message : "unknown"));
  return back("oauth=ok");
}
