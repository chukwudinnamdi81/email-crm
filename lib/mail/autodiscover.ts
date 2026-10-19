import dns from "dns/promises";
import net from "net";
import tls from "tls";
import { assertSafeTarget } from "../net-guard";

type Security = "SSL" | "STARTTLS";
type Endpoint = { host: string; port: number; security: Security };
export type Discovery = {
  recommended: "GOOGLE" | "MICROSOFT" | "MANUAL";
  imap?: Endpoint;
  smtp?: Endpoint;
  usernameStyle: "email" | "localpart";
  source: string;
};

const ssl = (host: string, port: number): Endpoint => ({ host, port, security: "SSL" });
const starttls = (host: string, port: number): Endpoint => ({ host, port, security: "STARTTLS" });
const entry = (imap: Endpoint, smtp: Endpoint, usernameStyle: "email" | "localpart" = "email"): Partial<Discovery> => ({ imap, smtp, usernameStyle });

const TABLE: Record<string, Partial<Discovery>> = {
  "gmail.com": { recommended: "GOOGLE" }, "googlemail.com": { recommended: "GOOGLE" },
  "outlook.com": { recommended: "MICROSOFT" }, "hotmail.com": { recommended: "MICROSOFT" },
  "live.com": { recommended: "MICROSOFT" }, "msn.com": { recommended: "MICROSOFT" },
  "yahoo.com": entry(ssl("imap.mail.yahoo.com", 993), ssl("smtp.mail.yahoo.com", 465)),
  "ymail.com": entry(ssl("imap.mail.yahoo.com", 993), ssl("smtp.mail.yahoo.com", 465)),
  "icloud.com": entry(ssl("imap.mail.me.com", 993), starttls("smtp.mail.me.com", 587), "localpart"),
  "me.com": entry(ssl("imap.mail.me.com", 993), starttls("smtp.mail.me.com", 587), "localpart"),
  "aol.com": entry(ssl("imap.aol.com", 993), ssl("smtp.aol.com", 465)),
  "zoho.com": entry(ssl("imap.zoho.com", 993), ssl("smtp.zoho.com", 465)),
  "fastmail.com": entry(ssl("imap.fastmail.com", 993), ssl("smtp.fastmail.com", 465)),
  "gmx.com": entry(ssl("imap.gmx.com", 993), ssl("mail.gmx.com", 465)),
  "gmx.net": entry(ssl("imap.gmx.net", 993), ssl("mail.gmx.net", 465)),
  "mail.com": entry(ssl("imap.mail.com", 993), ssl("smtp.mail.com", 465)),
  "yandex.com": entry(ssl("imap.yandex.com", 993), ssl("smtp.yandex.com", 465)),
  "yandex.ru": entry(ssl("imap.yandex.com", 993), ssl("smtp.yandex.com", 465)),
};
const TABLE_ALIASES: [RegExp, string][] = [[/^yahoo\.[a-z.]+$/, "yahoo.com"], [/^gmx\.[a-z.]+$/, "gmx.com"], [/^zoho\.[a-z.]+$/, "zoho.com"]];

function tableFor(domain: string): Partial<Discovery> | undefined {
  if (TABLE[domain]) return TABLE[domain];
  const alias = TABLE_ALIASES.find(([re]) => re.test(domain));
  return alias ? TABLE[alias[1]] : undefined;
}

/** MX hostnames -> hosted provider (Google Workspace / Microsoft 365 custom domains). */
export function mapMxToProvider(hosts: string[]): "GOOGLE" | "MICROSOFT" | null {
  const h = hosts.map((x) => x.toLowerCase().replace(/\.$/, ""));
  if (h.some((x) => /(^|\.)(google|googlemail)\.com$/.test(x))) return "GOOGLE";
  if (h.some((x) => /\.mail\.protection\.outlook\.com$/.test(x))) return "MICROSOFT";
  return null;
}

const sec = (v: string | undefined): Security | null => {
  const s = (v ?? "").trim().toUpperCase();
  return s === "SSL" ? "SSL" : s === "STARTTLS" ? "STARTTLS" : null;
};
const tag = (block: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i").exec(block)?.[1];

/** Parses Mozilla autoconfig config-v1.1 XML (first imap incomingServer, first smtp outgoingServer). */
export function parseAutoconfigXml(xml: string, email: string): Pick<Discovery, "imap" | "smtp" | "usernameStyle"> | null {
  const [local, domain] = email.toLowerCase().split("@");
  const sub = (s: string) => s.replace(/%EMAILADDRESS%/gi, email).replace(/%EMAILLOCALPART%/gi, local ?? "").replace(/%EMAILDOMAIN%/gi, domain ?? "");
  const block = (el: string, type: string) =>
    new RegExp(`<${el}\\s+[^>]*type\\s*=\\s*["']${type}["'][^>]*>([\\s\\S]*?)</${el}>`, "i").exec(xml)?.[1];
  const endpoint = (b: string | undefined): Endpoint | undefined => {
    if (!b) return undefined;
    const host = tag(b, "hostname"), port = Number(tag(b, "port")), security = sec(tag(b, "socketType"));
    if (!host || !Number.isInteger(port) || port <= 0 || !security) return undefined;
    return { host: sub(host).toLowerCase(), port, security };
  };
  const inB = block("incomingServer", "imap");
  const imap = endpoint(inB), smtp = endpoint(block("outgoingServer", "smtp"));
  if (!imap || !smtp) return null;
  const uname = (tag(inB ?? "", "username") ?? "").toUpperCase();
  return { imap, smtp, usernameStyle: uname.includes("%EMAILLOCALPART%") ? "localpart" : "email" };
}

const TIMEOUT_MS = 5000, MAX_BYTES = 100_000;

async function fetchText(url: string): Promise<string | null> {
  if (!url.startsWith("https://")) return null;
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/xml,application/xml" } });
    if (res.status !== 200 || !res.body) return null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

/** Short TCP/TLS connect check; sends no credentials. */
function probe(e: Endpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const s = e.security === "SSL"
      ? tls.connect({ host: e.host, port: e.port, servername: e.host, timeout: 4000 })
      : net.connect({ host: e.host, port: e.port, timeout: 4000 });
    const end = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once(e.security === "SSL" ? "secureConnect" : "connect", () => end(true));
    s.once("error", () => end(false));
    s.once("timeout", () => end(false));
  });
}

export type DiscoverDeps = {
  resolveMx: (d: string) => Promise<{ exchange: string }[]>;
  resolveSrv: (n: string) => Promise<{ name: string; port: number }[]>;
  fetchText: (url: string) => Promise<string | null>;
  probe: (e: Endpoint) => Promise<boolean>;
  assertSafe: (host: string, port: number, kind: "imap" | "smtp") => Promise<void>;
};
const defaults: DiscoverDeps = { resolveMx: (d) => dns.resolveMx(d), resolveSrv: (n) => dns.resolveSrv(n), fetchText, probe, assertSafe: assertSafeTarget };

export async function discoverMailSettings(email: string, deps: Partial<DiscoverDeps> = {}): Promise<Discovery> {
  const d = { ...defaults, ...deps };
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  const none: Discovery = { recommended: "MANUAL", usernameStyle: "email", source: "none" };
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return none;

  // Every endpoint coming from a user-controlled domain must pass the SSRF guard (private IPs are dropped).
  const safe = async (e: Endpoint | undefined, kind: "imap" | "smtp"): Promise<Endpoint | undefined> => {
    if (!e) return undefined;
    try { await d.assertSafe(e.host, e.port, kind); return e; } catch { return undefined; }
  };
  const both = async (imap: Endpoint | undefined, smtp: Endpoint | undefined, usernameStyle: Discovery["usernameStyle"], source: string): Promise<Discovery | null> => {
    const [i, s] = [await safe(imap, "imap"), await safe(smtp, "smtp")];
    return i && s ? { recommended: "MANUAL", imap: i, smtp: s, usernameStyle, source } : null;
  };

  // 1. built-in table
  const t = tableFor(domain);
  if (t) return { recommended: t.recommended ?? "MANUAL", imap: t.imap, smtp: t.smtp, usernameStyle: t.usernameStyle ?? "email", source: "builtin" };

  // 2. MX
  try {
    const p = mapMxToProvider((await d.resolveMx(domain)).map((m) => m.exchange));
    if (p) return { recommended: p, usernameStyle: "email", source: "mx" };
  } catch { /* no MX */ }

  // 3. autoconfig XML (https only, no redirects, size-capped)
  const urls = [`https://autoconfig.${domain}/mail/config-v1.1.xml`, `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`, `https://autoconfig.thunderbird.net/v1.1/${domain}`];
  for (const url of urls) {
    const host = new URL(url).hostname;
    if (host !== "autoconfig.thunderbird.net") {
      try { await d.assertSafe(host, 993, "imap"); } catch { continue; } // never fetch from private addresses
    }
    const xml = await d.fetchText(url);
    const parsed = xml ? parseAutoconfigXml(xml, email.trim()) : null;
    const hit = parsed && (await both(parsed.imap, parsed.smtp, parsed.usernameStyle, `autoconfig:${host}`));
    if (hit) return hit;
  }

  // 4. SRV
  try {
    const [imapSrv, subSrv] = await Promise.all([d.resolveSrv(`_imaps._tcp.${domain}`).catch(() => []), d.resolveSrv(`_submission._tcp.${domain}`).catch(() => [])]);
    const i = imapSrv.find((r) => r.name && r.name !== ".");
    const s = subSrv.find((r) => r.name && r.name !== ".");
    const hit = i && s && (await both(ssl(i.name, i.port), s.port === 465 ? ssl(s.name, s.port) : starttls(s.name, s.port), "email", "srv"));
    if (hit) return hit;
  } catch { /* none */ }

  // 5. guessed hosts: connect check only
  const firstUp = async (c: Endpoint[], kind: "imap" | "smtp") => {
    const ok = await Promise.all(c.map(async (e) => ((await safe(e, kind)) ? d.probe(e) : false)));
    return c.find((_, n) => ok[n]);
  };
  const [imap, smtp] = await Promise.all([
    firstUp(["imap", "mail"].flatMap((p) => [ssl(`${p}.${domain}`, 993), starttls(`${p}.${domain}`, 143)]), "imap"),
    firstUp(["smtp", "mail"].flatMap((p) => [ssl(`${p}.${domain}`, 465), starttls(`${p}.${domain}`, 587)]), "smtp"),
  ]);
  if (imap && smtp) return { recommended: "MANUAL", imap, smtp, usernameStyle: "email", source: "guess" };
  return none;
}
