import { authed, json } from "@/lib/api";

/** Which mailbox OAuth providers are configured on this deployment. */
export const GET = authed(async () => json({ google: !!process.env.GOOGLE_CLIENT_ID, microsoft: !!process.env.MICROSOFT_CLIENT_ID }));
