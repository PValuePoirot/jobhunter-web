import { useMemo, useState } from "react";
import Quotes from "../components/Quotes";
import { aiDraft } from "../lib/gemini";
import { ai } from "../lib/localdb";
import { TEMPLATE_LABELS, buildRules, draft, networkCount, peopleAt, scoreJob, tooSenior } from "../lib/match";
import type { Job, Person, Profile, Resume, Templates } from "../lib/match";
import { REGIONS, regionKey } from "../lib/roles";
import { setApplication } from "../lib/store";
import { ago, normCo, sameCompany } from "../lib/text";

const STATUSES = ["", "Saved", "Referral asked", "Applied", "Interview", "Offer", "Rejected", "Ignored"];
const PAGE = 100;
type Row = Job & { score: number; resume: Resume | null; why: string[]; refs: Person[]; refCount: number; appliedBefore: number; isNew: boolean; when: number };

export default function Dashboard(props: {
  profile: Profile; resumes: Resume[]; jobs: Job[]; apps: Record<string, string>; setApps: (a: Record<string, string>) => void;
  meta: Record<string, unknown> | null; byCo: Map<string, Person[]>; loading: string; reload: () => void; openSettings: () => void; signOut: () => void;
}) {
  const { profile, resumes, jobs, apps, setApps, meta, byCo } = props;
  const [tab, setTab] = useState<"jobs" | "pool">("jobs");
  const [q, setQ] = useState(""); const [track, setTrack] = useState("all"); const [stat, setStat] = useState<string | null>(null);
  const [onlyRef, setOnlyRef] = useState(false); const [showIgnored, setShowIgnored] = useState(false);
  const [tier, setTier] = useState(""); const [visa, setVisa] = useState(""); const [within, setWithin] = useState(""); const [sort, setSort] = useState("recent");
  const [shown, setShown] = useState(PAGE);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [ui, setUi] = useState<Record<string, { p: number; t: keyof Templates }>>({});
  const [aiText, setAiText] = useState<Record<string, string>>({}); const [aiBusy, setAiBusy] = useState("");

  const rows: Row[] = useMemo(() => {
    const rules = buildRules(profile);
    const hidden = new Set((profile.hidden_companies || []).map(normCo));
    const appliedKeys = Object.entries(profile.applied_before || {});
    const years = profile.years || Math.max(0, ...resumes.map(r => r.years || 0)) || null;
    return jobs.filter(j => rules.titleOk(j.title) && rules.regionOk(j) && !hidden.has(normCo(j.company)) && !tooSenior(j, years)).map(j => {
      const s = scoreJob(j, resumes, profile);
      const refs = peopleAt(j.company, byCo);
      const when = new Date(j.posted || j.first_seen || 0).getTime();
      return { ...j, ...s, refs, refCount: Math.max(refs.length, networkCount(j.company, profile.network_counts)),
        appliedBefore: appliedKeys.reduce((a, [k, n]) => a + (sameCompany(k, j.company) ? n : 0), 0),
        isNew: Date.now() - new Date(j.first_seen || 0).getTime() < 48 * 3600e3, when };
    });
  }, [jobs, profile, resumes, byCo]);

  const st = (id: string) => apps[id] || "";
  const base = rows.filter(r => {
    if (!showIgnored && st(r.id) === "Ignored") return false;
    if (track !== "all" && regionKey(r.region) !== track) return false;
    if (tier && (tier === "3" ? (r.kind !== "ats" || (r.tier ?? 3) >= 3) : r.kind !== "ats" || String(r.tier) !== tier)) return false;
    if (visa === "yes" && r.visa !== "yes") return false;
    if (visa === "notno" && r.visa === "no") return false;
    if (within && Date.now() - r.when > +within * 86400e3) return false;
    if (q && !`${r.title} ${r.company} ${r.location}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const list = base.filter(r => (!onlyRef || r.refCount > 0) && (!stat || (stat === "new" ? r.isNew : st(r.id) === stat)))
    .sort((a, b) => sort === "score" ? b.score - a.score || b.when - a.when : sort === "tier" ? ((a.kind === "ats" ? a.tier ?? 3 : 3) - (b.kind === "ats" ? b.tier ?? 3 : 3)) || b.when - a.when : b.when - a.when);
  const by = (s: string) => base.filter(r => st(r.id) === s).length;
  const tiles: [string, string, number][] = [["open", "Matches", base.length], ["new", "New (48h)", base.filter(r => r.isNew).length], ["ref", "With connections", base.filter(r => r.refCount > 0).length],
    ["Saved", "Saved", by("Saved")], ["Referral asked", "Referral asked", by("Referral asked")], ["Applied", "Applied", by("Applied")], ["Interview", "Interviews", by("Interview")]];
  const active = track !== "all" || stat || onlyRef || q || tier || visa || within || showIgnored;
  const myRegions = REGIONS.filter(r => profile.regions.includes(r.key));

  async function setStatus(id: string, s: string) {
    setApps({ ...apps, [id]: s });
    try { await setApplication(id, s); } catch (e) { alert("Couldn't save: " + (e as Error).message); }
  }
  const clickTile = (k: string) => { if (k === "ref") setOnlyRef(v => !v); else if (k === "open") { setStat(null); setOnlyRef(false); } else setStat(s => (s === k ? null : k)); setShown(PAGE); };
  const clearAll = () => { setTrack("all"); setStat(null); setOnlyRef(false); setShowIgnored(false); setQ(""); setTier(""); setVisa(""); setWithin(""); setShown(PAGE); };

  async function personalise(r: Row) {
    const u = ui[r.id] || { p: 0, t: "referral" as keyof Templates };
    setAiBusy(r.id);
    try { const t = await aiDraft(u.t, r, r.refs[u.p] || null, profile); setAiText(x => ({ ...x, [`${r.id}:${u.t}:${u.p}`]: t })); }
    catch (e) { alert((e as Error).message); }
    setAiBusy("");
  }

  const poolRun = meta?.last_run as string | undefined;
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="eyebrow">the job-hunt notebook</div>
          <h1>Job Hunter</h1>
          <div className="sub">{props.loading ? <><span className="spin" />{props.loading}</> :
            <>Jobs refreshed {ago(poolRun)} · {rows.length} matches for you (last 14 days) from {(meta?.jobs as number | undefined)?.toLocaleString() ?? "–"} open roles · {resumes.length} resume{resumes.length === 1 ? "" : "s"}{ai.key() ? " · AI on" : ""}</>}</div>
        </div>
        <div className="spacer" />
        <span className="hanko" aria-hidden="true">GO<br />GO!</span>
        <div className="topnav">
          <button className="btn ghost small" onClick={props.reload}>Refresh</button>
          <button className="btn ghost small" onClick={props.openSettings}>Settings</button>
          <button className="linkbtn" onClick={props.signOut}>Sign out</button>
        </div>
      </header>

      <Quotes />

      <div className="stats">{tiles.map(([k, l, n]) => (
        <button key={k} className={`stat ${(k === "ref" ? onlyRef : k === "open" ? !stat && !onlyRef : stat === k) ? "on" : ""}`} onClick={() => clickTile(k)}><b>{n}</b><span>{l}</span></button>
      ))}</div>

      <div className="tabs">
        <button className={`tab ${tab === "jobs" ? "on" : ""}`} onClick={() => setTab("jobs")}>Jobs</button>
        <button className={`tab ${tab === "pool" ? "on" : ""}`} onClick={() => setTab("pool")}>Sources</button>
      </div>

      {tab === "jobs" && <section>
        <div className="filters">
          <input type="search" placeholder="Search title, company, location…" value={q} onChange={e => { setQ(e.target.value); setShown(PAGE); }} />
          <span className={`chip ${track === "all" ? "on" : ""}`} onClick={() => setTrack("all")}>All</span>
          {myRegions.map(r => <span key={r.key} className={`chip ${track === r.key ? "on" : ""}`} onClick={() => { setTrack(r.key); setShown(PAGE); }}>{r.icon} {r.label}</span>)}
          <select value={tier} onChange={e => setTier(e.target.value)}><option value="">Any company</option><option value="1">Tier 1 companies</option><option value="2">Tier 2 companies</option><option value="3">Tier 3 + job boards</option></select>
          <select value={visa} onChange={e => setVisa(e.target.value)}><option value="">Visa: any</option><option value="yes">Visa/relocation mentioned</option><option value="notno">Not "no sponsorship"</option></select>
          <select value={within} onChange={e => setWithin(e.target.value)}><option value="">Posted: last 14 days</option><option value="1">Last 24 hours</option><option value="3">Last 3 days</option><option value="7">Last 7 days</option></select>
          <select value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Sort: newest first</option><option value="score">Best match first</option><option value="tier">Top companies first</option></select>
          <label className="sub"><input type="checkbox" checked={onlyRef} onChange={e => setOnlyRef(e.target.checked)} /> 🤝 has connections</label>
          <label className="sub"><input type="checkbox" checked={showIgnored} onChange={e => setShowIgnored(e.target.checked)} /> show ignored</label>
        </div>
        <div id="count" style={{ margin: "0 0 10px" }}>Showing <b>{Math.min(shown, list.length)}</b> of <b>{list.length}</b> matching jobs{active && <> · <button className="linkbtn" onClick={clearAll}>Clear all filters</button></>}</div>
        <div id="list">
          {!list.length && <div className="empty">{props.loading ? "Loading jobs…" : "Nothing matches these filters."}</div>}
          {list.slice(0, shown).map(r => {
            const open = opened.has(r.id), u = ui[r.id] || { p: 0, t: "referral" as keyof Templates }, who = r.refs[u.p] || null;
            const key = `${r.id}:${u.t}:${u.p}`, text = aiText[key] ?? draft(u.t, r, who, profile), alt = resumes.find(x => x.id !== r.resume?.id);
            return (
              <div key={r.id} className={`job ${r.isNew ? "is-new" : ""}`}>
                <div>
                  <div className="co"><b>{r.company}</b>{r.kind === "ats" && r.tier ? <span className="badge">Tier {r.tier}</span> : null}<span>via {r.source}</span>{r.isNew && <span className="badge new">NEW</span>}</div>
                  <a className="title" href={r.url} target="_blank" rel="noopener">{r.title.slice(0, 140)}</a>
                  <div className="meta">
                    <span className="badge">📍 {(r.location || "").slice(0, 60)}</span>
                    {r.country && !(r.location || "").toLowerCase().includes(r.country.toLowerCase()) && <span className="badge">{r.country}</span>}
                    {r.visa_route && regionKey(r.region) !== "india" && <span className="badge" title={r.visa_route}>ℹ visa route</span>}
                    {r.visa === "yes" ? <span className="badge yes">🛂 visa/relocation mentioned</span> : r.visa === "no" ? <span className="badge no">🚫 no sponsorship</span> : null}
                    {r.refCount > 0 && <span className="badge ref" title={r.refs.map(p => `${p.name} – ${p.role}`).join("\n")}>🤝 {r.refCount} connection{r.refCount > 1 ? "s" : ""}</span>}
                    {r.appliedBefore > 0 && <span className="badge no" title="From your LinkedIn application history">↩ applied here {r.appliedBefore}x before</span>}
                    <span className="badge">{r.posted ? `posted ${ago(r.posted)}` : `seen ${ago(r.first_seen)}`}</span>
                  </div>
                  {r.refs.length > 0 && <div className="people">{r.refs.slice(0, 3).map(p => (
                    <a key={p.url || p.name} className="person" href={p.url} target="_blank" rel="noopener" title="Open on LinkedIn">👤 {p.name} <small>{p.role.slice(0, 34)}</small> ↗</a>))}
                    {r.refs.length > 3 && <button className="linkbtn" onClick={() => setOpened(s => new Set(s).add(r.id))}>+{r.refs.length - 3} more</button>}</div>}
                  {r.snippet && <div className="snip">{r.snippet}</div>}
                </div>
                <div className="side">
                  <div style={{ width: "100%", fontSize: 12, color: "var(--muted)" }}>Match {r.score}/10<div className="score"><i style={{ width: `${r.score * 10}%` }} /></div></div>
                  {r.why.length > 0 && <div className="why">matched: {r.why.join(", ")}</div>}
                  <select value={st(r.id)} onChange={e => setStatus(r.id, e.target.value)} aria-label="Application status">{STATUSES.map(s => <option key={s} value={s}>{s || "Not started"}</option>)}</select>
                  <button className="linkbtn" style={{ width: "100%" }} onClick={() => setOpened(s => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}>{open ? "Hide drafts" : "✉ Message drafts"}</button>
                </div>
                {open && <div className="drawer">
                  {r.visa_route && regionKey(r.region) !== "india" && <div className="sub">🛂 {r.country}: {r.visa_route}</div>}
                  {r.resume && <div className="row"><span className="resume">📄 Use <b>{r.resume.label}</b></span><span className="sub">{r.why.length ? `best overlap: ${r.why.join(", ")}` : "closest fit"}{alt ? `. Alternative: ${alt.label}` : ""}</span></div>}
                  {r.refs.length > 0 ? <div className="row"><label>Message to</label>
                    <select value={u.p} onChange={e => setUi(x => ({ ...x, [r.id]: { ...u, p: +e.target.value } }))}>{r.refs.map((p, i) => <option key={i} value={i}>{p.name}{p.role ? ` – ${p.role.slice(0, 50)}` : ""}</option>)}</select>
                    {who?.url && <a className="linkbtn" href={who.url} target="_blank" rel="noopener" style={{ textDecoration: "none" }}>Open on LinkedIn ↗</a>}
                    {who?.email && <span className="sub">✉ <a href={`mailto:${who.email}`}>{who.email}</a></span>}</div>
                    : <div className="sub">{r.refCount ? "Import your LinkedIn export on this device (Settings) to see names." : "No connections here yet. Find a recruiter or hiring manager on LinkedIn and personalise the greeting."}</div>}
                  <div className="row">{(Object.keys(TEMPLATE_LABELS) as (keyof Templates)[]).map(k => (
                    <button key={k} className={`dtab ${u.t === k ? "on" : ""}`} onClick={() => setUi(x => ({ ...x, [r.id]: { ...u, t: k } }))}>{TEMPLATE_LABELS[k]}</button>))}
                    {ai.key() && <button className="dtab" disabled={aiBusy === r.id} onClick={() => personalise(r)}>{aiBusy === r.id ? "Writing…" : "✨ Personalise"}</button>}</div>
                  <textarea id={`ta-${r.id}`} key={key + (aiText[key] ? "-ai" : "")} defaultValue={text} />
                  <div className="row"><button className="btn" onClick={e => { const ta = document.getElementById(`ta-${r.id}`) as HTMLTextAreaElement; const b = e.currentTarget; navigator.clipboard.writeText(ta.value).then(() => { b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = "Copy message"), 1500); }); }}>Copy message</button>
                    <span className="sub">Edit freely, then paste into LinkedIn. Change the wording for good in Settings → Message templates.</span></div>
                </div>}
              </div>
            );
          })}
          {list.length > shown && <div className="center" style={{ margin: 12 }}><button className="btn" onClick={() => setShown(s => s + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more ({list.length - shown} remaining)</button></div>}
        </div>
      </section>}

      {tab === "pool" && <section>
        <div className="card"><h3>Where jobs come from</h3>
          <p>A shared pool refreshed about every 30 minutes from company career pages (Greenhouse, Ashby, Lever, Workday, Amazon, Netflix, Atlassian, Workable) and job boards. Your filters and resumes are applied in your browser.</p>
          <div className="kv"><span>Last refresh</span><b>{poolRun ? `${ago(poolRun)} (${new Date(poolRun).toLocaleString()})` : "never"}</b>
            <span>Open roles in pool</span><b>{(meta?.jobs as number | undefined)?.toLocaleString() ?? "–"}</b>
            <span>Matching you</span><b>{rows.length}</b></div></div>
        <table><thead><tr><th>Source</th><th>Type</th><th>Status</th><th>Fetched</th><th>Last fetch</th></tr></thead><tbody>
          {Object.entries((meta?.sources as Record<string, { ok?: boolean; kind?: string; fetched?: number; error?: string; last_fetch?: string }>) || {})
            .sort((a, b) => (b[1].fetched || 0) - (a[1].fetched || 0)).map(([n, v]) => (
              <tr key={n}><td>{n}</td><td>{v.kind === "ats" ? "Company careers feed" : "Job board"}</td>
                <td className={v.ok ? "ok" : String(v.error || "").startsWith("skipped") ? "warn" : "bad"}>{v.ok ? "OK" : String(v.error || "").startsWith("skipped") ? "Needs setup" : "Failed"}</td>
                <td>{v.fetched ?? "–"}</td><td>{v.last_fetch ? ago(v.last_fetch) : "–"}</td></tr>))}
        </tbody></table>
      </section>}

      <footer className="foot"><div className="fine">— the last page. Close the notebook, send one message, come back tomorrow. —</div></footer>
    </div>
  );
}
