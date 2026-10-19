import argon2 from "argon2";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { hmacHex } from "./crypto";

const COOKIE = "session";
const TTL_MS = 1000 * 60 * 60 * 24 * 30;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function hashPassword(pw: string) {
  return argon2.hash(pw, { type: argon2.argon2id });
}
export async function verifyPassword(h: string, pw: string) {
  try {
    return await argon2.verify(h, pw);
  } catch {
    return false;
  }
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  await db.session.create({ data: { tokenHash: hash(token), userId, expiresAt: new Date(Date.now() + TTL_MS) } });
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: TTL_MS / 1000,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const t = jar.get(COOKIE)?.value;
  if (t) await db.session.deleteMany({ where: { tokenHash: hash(t) } });
  jar.delete(COOKIE);
}

export type SessionUser = { id: string; email: string };

export async function currentUser(): Promise<SessionUser | null> {
  const t = (await cookies()).get(COOKIE)?.value;
  if (!t) return null;
  const s = await db.session.findUnique({ where: { tokenHash: hash(t) }, include: { user: true } });
  if (!s || s.expiresAt < new Date() || !s.user.emailVerifiedAt) return null;
  return { id: s.user.id, email: s.user.email };
}

const CODE_TTL_MS = 15 * 60_000;
const RESET_TTL_MS = 60 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
type CodePurpose = "EMAIL_VERIFY" | "ACCOUNT_DELETE";

const codeHash = (userId: string, code: string) => hmacHex(`${userId}:${code}`);

/** Creates a 6-digit email confirmation code (older unused ones are invalidated). The raw code is only for the email. */
export async function createEmailCode(userId: string, purpose: CodePurpose = "EMAIL_VERIFY"): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.$transaction([
    db.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } }),
    db.authToken.create({ data: { userId, purpose, tokenHash: codeHash(userId, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) } }),
  ]);
  return code;
}

/** Consumes a fresh code for a signed-in user (e.g. confirming account deletion). Same attempt limit as sign-up codes. */
export async function checkUserCode(userId: string, code: string, purpose: CodePurpose): Promise<boolean> {
  const token = await db.authToken.findFirst({
    where: { userId, purpose, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!token) return false;
  if (token.attempts >= MAX_CODE_ATTEMPTS) return false;
  const a = Buffer.from(codeHash(userId, code));
  const b = Buffer.from(token.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    await db.authToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
    return false;
  }
  const used = await db.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
  return used.count === 1;
}

/** Returns the user id when the code matches, otherwise null (same result for every failure). */
export async function checkEmailCode(email: string, code: string): Promise<string | null> {
  const user = await db.user.findFirst({ where: { email: email.toLowerCase(), emailVerifiedAt: null } });
  const token = user
    ? await db.authToken.findFirst({
        where: { userId: user.id, purpose: "EMAIL_VERIFY", usedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
      })
    : null;
  if (!user || !token) {
    timingSafeEqual(Buffer.from(codeHash("none", code)), Buffer.from(codeHash("none", "000000")));
    return null;
  }
  if (token.attempts >= MAX_CODE_ATTEMPTS) {
    await db.authToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    return null;
  }
  const ok = timingSafeEqual(Buffer.from(codeHash(user.id, code)), Buffer.from(token.tokenHash));
  if (!ok) {
    const t = await db.authToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } });
    if (t.attempts >= MAX_CODE_ATTEMPTS) await db.authToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    return null;
  }
  const used = await db.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
  return used.count === 1 ? user.id : null;
}

export async function markEmailVerified(userId: string) {
  await db.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
}

/** Random link token for PASSWORD_RESET only (1h). Older unused ones are invalidated. */
export async function createAuthToken(userId: string, purpose: "PASSWORD_RESET"): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.$transaction([
    db.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } }),
    db.authToken.create({ data: { userId, purpose, tokenHash: hash(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } }),
  ]);
  return token;
}

/** Returns the user id and marks the token used, or null when missing/expired/used. */
export async function consumeAuthToken(token: string, purpose: "PASSWORD_RESET"): Promise<string | null> {
  const row = await db.authToken.findUnique({ where: { tokenHash: hash(token) } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt < new Date()) return null;
  const r = await db.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  return r.count === 1 ? row.userId : null;
}
