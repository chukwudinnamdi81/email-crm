import { lookup } from "dns/promises";
import net from "net";

export const SMTP_PORTS = [25, 465, 587, 2465, 2525, 2587, 8025];
export const IMAP_PORTS = [143, 993];

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const l = ip.toLowerCase();
  if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80");
}

/** SSRF guard: rejects private/loopback hosts and unexpected ports. Throws with a user-safe message. */
export async function assertSafeTarget(host: string, port: number, kind: "smtp" | "imap") {
  const allowed = kind === "smtp" ? SMTP_PORTS : IMAP_PORTS;
  if (!allowed.includes(port)) throw new Error(`Port ${port} is not allowed for ${kind.toUpperCase()} (allowed: ${allowed.join(", ")})`);
  if (process.env.ALLOW_PRIVATE_HOSTS === "true") return;
  if (!host || host === "localhost") throw new Error("Private or loopback hosts are not allowed");
  const ips = net.isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (ips.length === 0) throw new Error(`Could not resolve host ${host}`);
  if (ips.some(isPrivateIp)) throw new Error("Private or loopback hosts are not allowed");
}

const isGoogleHost = (h?: string | null) => /(^|\.)(gmail|googlemail)\.com$/i.test((h ?? "").trim());

/** Google shows app passwords with spaces; strip whitespace only for Gmail hosts. */
export function normalizePassword(password: string, imapHost?: string | null, smtpHost?: string | null): string {
  return isGoogleHost(imapHost) || isGoogleHost(smtpHost) ? password.replace(/\s+/g, "") : password;
}

/** Server error text without secrets. */
export function errText(e: unknown): string {
  if (e instanceof Error) {
    const x = e as Error & { response?: string; responseText?: string };
    return (x.responseText || x.response || e.message).toString().slice(0, 500);
  }
  return "Unknown error";
}
