import test from "node:test";
import assert from "node:assert/strict";
import type { AddressObject } from "mailparser";
import { addrs, aggregateContacts, messageContacts, skipContactsForFolder, isSystemAddress, cleanName } from "../lib/contact-extract";
import { planFolder } from "../lib/sync-cursor";
import { windowSince, widenBackfillBelow, isWidening } from "../lib/sync-window";
import { computeProgress, emaRate, formatEta, overallProgress } from "../lib/sync-progress";
import { syncPriority, shouldYield, roundRobin } from "../lib/sync-limits";
import { applyLease, acquireLease } from "../lib/sync-lease";
import { parseAutoconfigXml, mapMxToProvider, discoverMailSettings } from "../lib/mail/autodiscover";

const ao = (value: AddressObject["value"]): AddressObject => ({ value, html: "", text: "" });

test("addrs: groups, casing, invalid, names", () => {
  const r = addrs(ao([
    { name: "Team", address: undefined, group: [{ name: "A", address: "A@X.com" }, { name: "", address: "b@x.com" }] } as never,
    { name: "bad", address: "not-an-email" },
    { name: '"Jane Doe (via Google Docs)"', address: "jane@x.com" },
    { name: "c@x.com", address: "c@x.com" },
    { name: "x", address: "MAILER-DAEMON@x.com" },
    { name: "Sales", address: "sales@x.com" },
    { name: "v", address: "bounce+abc@x.com" },
    { name: "n", address: "user+noreply@x.com" },
  ]));
  assert.deepEqual(r.map((a) => a.address), ["a@x.com", "b@x.com", "jane@x.com", "c@x.com", "sales@x.com"]);
  assert.equal(r[0].name, "A");
  assert.equal(r[2].name, "Jane Doe");
  assert.equal(r[3].name, undefined);
  assert.equal(addrs(ao([{ name: "", address: `${"a".repeat(250)}@x.com` }])).length, 0);
  assert.equal(addrs(undefined).length, 0);
});

test("filtering rules", () => {
  assert.ok(isSystemAddress("postmaster@x.com"));
  assert.ok(!isSystemAddress("info@x.com"));
  assert.equal(cleanName("'Bob'", "b@x.com"), "Bob");
  for (const u of ["\\Junk", "\\Trash", "\\Drafts"]) assert.ok(skipContactsForFolder(u, false));
  assert.ok(skipContactsForFolder("\\All", true));
  assert.ok(!skipContactsForFolder("\\All", false));
  assert.ok(!skipContactsForFolder("\\Inbox", true));
  const c = messageContacts([[{ address: "me@x.com" }, { address: "a@x.com" }], [{ address: "a@x.com" }]], new Set(["me@x.com"]));
  assert.deepEqual(c.map((a) => a.address), ["a@x.com"]);
});

test("contact aggregation is order independent", () => {
  const msgs = [1, 2, 3].map((d) => ({ date: new Date(2024, 0, d), contacts: [{ address: "a@x.com", name: `N${d}` }, { address: "b@x.com" }] }));
  const asc = aggregateContacts(msgs), desc = aggregateContacts([...msgs].reverse());
  assert.deepEqual([...asc.entries()], [...desc.entries()]);
  assert.equal(asc.get("a@x.com")?.count, 3);
  assert.equal(asc.get("a@x.com")?.name, "N3");
});

test("planFolder: first sync is newest first with cursors set up front", () => {
  const p = planFolder({ uids: [1, 2, 3, 4, 5], lastUid: 0, backfillBelow: null, backfilled: false, batch: 2 });
  assert.equal(p.mode, "first");
  assert.deepEqual(p.initial, { lastUid: 5, backfillBelow: 6 });
  assert.deepEqual(p.chunks.map((c) => c.uids), [[5, 4], [3, 2], [1]]);
  assert.deepEqual(p.chunks.map((c) => c.cursor.backfillBelow), [4, 2, null]);
});
test("planFolder: windowed first sync keeps true top uid; empty window", () => {
  const p = planFolder({ uids: [90, 95], lastUid: 0, backfillBelow: null, backfilled: false, batch: 50, topUid: 500 });
  assert.deepEqual(p.initial, { lastUid: 500, backfillBelow: 96 });
  const e = planFolder({ uids: [], lastUid: 0, backfillBelow: null, backfilled: false, batch: 50, topUid: 500 });
  assert.deepEqual(e.initial, { lastUid: 500, backfillBelow: null });
  assert.equal(e.chunks.length, 0);
});
test("planFolder: resume fetches new mail first then continues below the cursor; legacy is ascending", () => {
  const r = planFolder({ uids: [1, 2, 3, 4, 5, 6, 7], lastUid: 6, backfillBelow: 4, backfilled: false, batch: 2 });
  assert.equal(r.mode, "resume");
  assert.deepEqual(r.chunks.map((c) => [c.dir, c.uids]), [["asc", [7]], ["desc", [3, 2]], ["desc", [1]]]);
  assert.equal(r.chunks[2].cursor.backfillBelow, null);
  const l = planFolder({ uids: [1, 2, 3, 4], lastUid: 2, backfillBelow: null, backfilled: false, batch: 1 });
  assert.equal(l.mode, "legacy");
  assert.deepEqual(l.chunks.map((c) => c.cursor.lastUid), [3, 4]);
});

test("windowSince / widening", () => {
  assert.equal(windowSince(null), null);
  assert.equal(windowSince(30, new Date("2025-03-31T15:00:00Z"))?.toISOString(), "2025-02-28T00:00:00.000Z");
  assert.ok(isWidening(30, 90) && isWidening(30, null) && !isWidening(90, 30) && !isWidening(null, 30));
  assert.equal(widenBackfillBelow({ existingBelow: null, minStoredUid: 120, lastUid: 500 }), 120);
  assert.equal(widenBackfillBelow({ existingBelow: 80, minStoredUid: 120, lastUid: 500 }), 80);
  assert.equal(widenBackfillBelow({ existingBelow: null, minStoredUid: null, lastUid: 500 }), 501);
  assert.equal(widenBackfillBelow({ existingBelow: null, minStoredUid: null, lastUid: 0 }), null);
});

test("computeProgress", () => {
  const t0 = new Date("2025-01-01T00:00:00Z");
  const base = { status: "running", foldersTotal: 0, messagesTotal: 0, messagesProcessed: 0, scanDoneAt: null, startedAt: t0, yieldedAt: null, sliceStartedAt: t0, activeMs: 0 };
  const at = (s: number) => t0.getTime() + s * 1000;
  assert.equal(computeProgress({ ...base, status: "queued" }, at(1)).phase, "queued");
  assert.equal(computeProgress(base, at(1)).phase, "connecting");
  assert.equal(computeProgress({ ...base, foldersTotal: 3 }, at(1)).phase, "scanning");
  const d = { ...base, foldersTotal: 3, messagesTotal: 1000, scanDoneAt: new Date(at(5)), messagesProcessed: 10 };
  const early = computeProgress(d, at(10));
  assert.equal(early.phase, "downloading");
  assert.equal(early.ratePerMin, null);
  assert.equal(early.etaSec, null);
  const later = computeProgress({ ...d, messagesProcessed: 250 }, at(35));
  assert.equal(later.percent, 25);
  assert.equal(later.ratePerMin, 500);
  assert.equal(later.etaSec, 90);
  assert.equal(computeProgress({ ...d, messagesProcessed: 5000 }, at(35)).percent, 99);
  assert.equal(computeProgress({ ...d, status: "done" }, at(35)).percent, 100);
  const w = computeProgress({ ...d, messagesProcessed: 250, yieldedAt: new Date(at(40)), activeMs: 30_000 }, at(600));
  assert.equal(w.phase, "waiting");
  assert.equal(w.ratePerMin, 500); // waiting time does not hurt the rate
  assert.equal(computeProgress({ ...base, foldersTotal: 1, messagesTotal: 12, messagesProcessed: 0 }, at(1)).messagesTotal, 12);
});

test("syncPriority / shouldYield / roundRobin", () => {
  assert.equal(syncPriority("manual", 50), 1);
  assert.equal(syncPriority("idle", 0), 2);
  assert.equal(syncPriority("scheduled", 0), 10);
  assert.equal(syncPriority("scheduled", 99), 30);
  assert.ok(shouldYield({ elapsedMs: 241_000, sliceSeconds: 240, waitingCount: 1 }));
  assert.ok(!shouldYield({ elapsedMs: 241_000, sliceSeconds: 240, waitingCount: 0 }));
  assert.ok(!shouldYield({ elapsedMs: 10_000, sliceSeconds: 240, waitingCount: 5 }));
  const rr = roundRobin([{ userId: "a", id: 1 }, { userId: "a", id: 2 }, { userId: "b", id: 3 }, { userId: "a", id: 4 }]);
  assert.deepEqual(rr.map((x) => x.id), [1, 3, 2, 4]);
});

test("lease: cap, refresh, expiry", async () => {
  const z = new Map<string, number>();
  assert.ok(applyLease(z, 0, 2, "j1", 100));
  assert.ok(applyLease(z, 0, 2, "j2", 100));
  assert.ok(!applyLease(z, 50, 2, "j3", 150));
  assert.ok(applyLease(z, 50, 2, "j1", 150)); // refresh keeps the slot
  assert.ok(applyLease(z, 120, 2, "j3", 220)); // j2 expired (crashed worker) so the slot frees
  assert.ok(!z.has("j2"));
  const fake = { eval: async () => { throw new Error("down"); }, zrem: async () => 0 } as never;
  assert.equal(await acquireLease("u", "j", 1, fake), true); // fail open
});

test("autodiscover: xml parser and MX mapping", () => {
  const xml = `<clientConfig><emailProvider id="x"><incomingServer type="imap"><hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer><incomingServer type="pop3"><hostname>pop.x</hostname><port>995</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.example.org</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer></emailProvider></clientConfig>`;
  const r = parseAutoconfigXml(xml, "bob@example.org");
  assert.deepEqual(r, { imap: { host: "imap.example.org", port: 993, security: "SSL" }, smtp: { host: "smtp.example.org", port: 587, security: "STARTTLS" }, usernameStyle: "localpart" });
  assert.equal(parseAutoconfigXml("<clientConfig/>", "a@b.co"), null);
  assert.equal(parseAutoconfigXml(xml.replace("SSL</socketType><username>", "PLAIN</socketType><username>"), "bob@example.org"), null);
  assert.equal(mapMxToProvider(["aspmx.l.google.com.", "alt1.aspmx.l.google.com"]), "GOOGLE");
  assert.equal(mapMxToProvider(["x-com.mail.protection.outlook.com"]), "MICROSOFT");
  assert.equal(mapMxToProvider(["mx.other.net"]), null);
  assert.equal(mapMxToProvider(["evilgoogle.com"]), null);
});

test("autodiscover: resolution order and SSRF guard", async () => {
  const noDns = { resolveMx: async () => { throw new Error("x"); }, resolveSrv: async () => { throw new Error("x"); }, probe: async () => false, fetchText: async () => null, assertSafe: async () => {} };
  assert.equal((await discoverMailSettings("a@gmail.com", noDns)).recommended, "GOOGLE");
  const y = await discoverMailSettings("a@yahoo.com", noDns);
  assert.deepEqual(y.imap, { host: "imap.mail.yahoo.com", port: 993, security: "SSL" });
  assert.equal((await discoverMailSettings("a@corp.io", { ...noDns, resolveMx: async () => [{ exchange: "aspmx.l.google.com" }] })).recommended, "GOOGLE");
  const xml = `<c><incomingServer type="imap"><hostname>imap.isp.net</hostname><port>993</port><socketType>SSL</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.isp.net</hostname><port>465</port><socketType>SSL</socketType></outgoingServer></c>`;
  const isp = await discoverMailSettings("a@isp.net", { ...noDns, fetchText: async (u) => (u.includes("thunderbird") ? xml : null) });
  assert.equal(isp.imap?.host, "imap.isp.net");
  assert.match(isp.source, /thunderbird/);
  const evil = await discoverMailSettings("a@evil.test", {
    ...noDns, fetchText: async () => xml.replace(/imap\.isp\.net/, "127.0.0.1"),
    assertSafe: async (h) => { if (h === "127.0.0.1") throw new Error("Private or loopback hosts are not allowed"); },
  });
  assert.equal(evil.recommended, "MANUAL");
  assert.equal(evil.imap, undefined);
});

test("eta formatting, smoothing and overall", () => {
  assert.equal(formatEta(30), "under a minute");
  assert.equal(formatEta(12 * 60 + 10), "about 12 min");
  assert.equal(formatEta(2 * 3600 + 8 * 60), "about 2 h 10 min");
  assert.equal(formatEta(3 * 3600), "about 3 h");
  assert.equal(emaRate(null, 100, 4000), 100);
  const e = emaRate(100, 200, 4000);
  assert.ok(e > 100 && e < 110); // one noisy poll barely moves it
  const p = (messagesTotal: number, messagesProcessed: number, ratePerMin: number | null) => ({ phase: "downloading" as const, percent: 0, messagesTotal, messagesProcessed, remaining: messagesTotal - messagesProcessed, elapsedSec: 0, ratePerMin, etaSec: null });
  const o = overallProgress([p(100, 50, 10), p(100, 0, null)]);
  assert.equal(o.messagesTotal, 200);
  assert.equal(o.percent, 25);
  assert.equal(o.etaSec, 900);
  assert.equal(overallProgress([]).phase, null);
});
