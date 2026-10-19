import { currentUser } from "@/lib/auth";
import { signToken } from "@/lib/crypto";
import { OAUTH } from "@/lib/mail/transport";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return Response.redirect(new URL("/login", req.url));
  const provider = new URL(req.url).searchParams.get("provider") as keyof typeof OAUTH;
  const cfg = OAUTH[provider];
  if (!cfg || !process.env[cfg.idEnv]) return Response.redirect(`${process.env.APP_URL ?? new URL(req.url).origin}/accounts?oauth=unavailable`);
  const state = signToken({ u: user.id, p: provider, t: String(Date.now()) });
  const redirect = `${process.env.APP_URL}/api/oauth/callback`;
  const url = new URL(cfg.authUrl);
  url.search = new URLSearchParams({
    client_id: process.env[cfg.idEnv]!, redirect_uri: redirect, response_type: "code", scope: cfg.scope, state,
    access_type: "offline", prompt: "consent",
  }).toString();
  return Response.redirect(url.toString());
}
