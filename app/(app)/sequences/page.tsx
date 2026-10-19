"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { HINT_COPY } from "@/lib/deliverability";

type S = { id: string; name: string; status: string; steps: number; enrolled: number; active: number; replied: number; bounced: number; unsubscribed: number };

export default function Sequences() {
  const [list, setList] = useState<S[]>([]);
  const [name, setName] = useState("");
  const load = async () => setList((await api<S[]>("/api/sequences")).data as unknown as S[]);
  useEffect(() => { load(); }, []);
  return (
    <>
      <h1>Sequences</h1>
      <div className="info">{HINT_COPY.coldEmailLaw}</div>
      <div className="row"><input placeholder="New sequence name" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={async () => { const r = await api<{ id: string }>("/api/sequences", "POST", { name: name || "Untitled sequence", steps: [{ subject: "Hello {{firstName|there}}", bodyHtml: "<p>Hi {{firstName|there}},</p><p></p>", delayDays: 0, delayHours: 0, sameThread: false }] }); if (r.ok) window.location.href = `/sequences/${r.data.id}`; }}>New sequence</button></div>
      {list.length === 0 && <p className="callout-info">No sequences yet. Make sure you have <a href="/contacts">contacts to email</a> (connect and sync a <a href="/accounts">mail account</a> first), then create your first sequence above.</p>}
      <table style={{ marginTop: 10 }}>
        <thead><tr><th>Name</th><th>Status</th><th>Steps</th><th>Enrolled</th><th>Active</th><th>Replied</th><th>Bounced</th><th>Unsub</th><th></th></tr></thead>
        <tbody>{list.map((s) => (
          <tr key={s.id}><td><a href={`/sequences/${s.id}`}>{s.name}</a></td><td>{s.status}</td><td>{s.steps}</td><td>{s.enrolled}</td><td>{s.active}</td><td>{s.replied}</td><td>{s.bounced}</td><td>{s.unsubscribed}</td>
            <td>{(s.status === "active" || s.status === "paused") && <button className="sec" onClick={async () => { const r = await api(`/api/sequences/${s.id}`, "PATCH", { status: s.status === "active" ? "paused" : "active" }); if (!r.ok) alert(r.data.error); load(); }}>{s.status === "active" ? "Pause" : "Resume"}</button>}</td></tr>
        ))}</tbody>
      </table>
    </>
  );
}
