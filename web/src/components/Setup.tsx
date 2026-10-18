import { useRef, useState } from "react";
import { aiParseResume, testKey } from "../lib/gemini";
import { ai, savePeople } from "../lib/localdb";
import { DEFAULT_TEMPLATES, TEMPLATE_LABELS } from "../lib/match";
import type { Profile, Resume, Templates } from "../lib/match";
import { REGIONS, ROLE_PRESETS, SENIORITY, guessRoles } from "../lib/roles";
import { addResume, deleteResume, resumeUrl, updateResume } from "../lib/store";

type Patch = (p: Partial<Profile>) => void;

/* ───────────── resumes ───────────── */
export function ResumeManager({ resumes, profile, onChanged, patch }: { resumes: Resume[]; profile: Profile; onChanged: () => void; patch: Patch }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(""); const [err, setErr] = useState("");

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setErr("");
    const proofs = [...(profile.proofs || [])];
    let p: Partial<Profile> = {};
    for (const f of Array.from(files)) {
      if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { setErr(`${f.name} isn't a PDF.`); continue; }
      try {
        setBusy(`Reading ${f.name}…`);
        const { pdfText, parseResumeText } = await import("../lib/resume");   // loaded only when needed
        const text = await pdfText(f);
        const parsed = parseResumeText(text);
        let skills = parsed.skills, years = parsed.years, newProofs = parsed.proofs;
        if (ai.key()) {
          try {
            setBusy(`Asking Gemini to read ${f.name}…`);
            const g = await aiParseResume(text);
            skills = [...new Set([...(g.skills || []).map(s => s.toLowerCase()), ...skills])];
            years = g.years_experience ?? years;
            if (g.proof_points?.length) newProofs = g.proof_points;
            p = { ...p, display_name: profile.display_name || g.name || "", current_title: profile.current_title || g.current_title || "", current_company: profile.current_company || g.current_company || "" };
          } catch (e) { setErr(`Gemini couldn't read it (${(e as Error).message}); used the built-in reader instead.`); }
        }
        setBusy(`Saving ${f.name}…`);
        const label = parsed.titles[0] || f.name.replace(/\.pdf$/i, "");
        await addResume(f, label, { text, skills, titles: parsed.titles, years });
        for (const pr of newProofs) if (!proofs.includes(pr)) proofs.push(pr);
        p = { ...p, display_name: p.display_name || profile.display_name || parsed.name, years: profile.years || years };
      } catch (e) { setErr(`${f.name}: ${(e as Error).message}`); }
    }
    patch({ ...p, proofs: proofs.slice(0, 16) });
    setBusy(""); onChanged();
    if (input.current) input.current.value = "";
  }

  return (
    <div>
      <div className="dropzone" onClick={() => input.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); onFiles(e.dataTransfer.files); }}>
        <b>Drop resume PDFs here</b> or click to choose. Add one per target role (for example an AI Engineer and an FDE version).
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple hidden onChange={e => onFiles(e.target.files)} />
      </div>
      {busy && <p><span className="spin" />{busy}</p>}
      {err && <p className="err">{err}</p>}
      {resumes.map(r => (
        <div className="card" key={r.id}>
          <div className="row">
            <input className="input" style={{ maxWidth: 360 }} defaultValue={r.label || ""} aria-label="Resume label"
              onBlur={e => e.target.value !== r.label && updateResume(r.id, { label: e.target.value }).then(onChanged)} />
            <span className="hint">{r.years ? `${r.years} yrs` : ""} · {r.skills?.length || 0} skills found</span>
            <button className="linkbtn" onClick={async () => { const u = await resumeUrl(r); if (u) window.open(u, "_blank", "noopener"); }}>Open</button>
            <button className="linkbtn" onClick={() => confirm(`Delete “${r.label}”?`) && deleteResume(r).then(onChanged)}>Delete</button>
          </div>
          <div style={{ marginTop: 8 }}>{(r.skills || []).slice(0, 30).map(s => <span className="tagx" key={s}>{s}</span>)}</div>
        </div>
      ))}
    </div>
  );
}

/* ───────────── LinkedIn ───────────── */
export function LinkedInImport({ uid, profile, patch }: { uid: string; profile: Profile; patch: Patch }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  async function onFile(f?: File | null) {
    if (!f) return;
    setErr(""); setMsg(""); setBusy(true);
    try {
      const { readLinkedInZip } = await import("../lib/linkedin");
      const li = await readLinkedInZip(f);
      await savePeople(uid, li.people);                  // names stay on this device
      const guess = guessRoles(`${li.prefTitles} ${li.currentTitle} ${li.skills.join(" ")}`);
      const india = /india|bengaluru|bangalore|gurugram|gurgaon|hyderabad|mumbai|pune|delhi|noida|chennai/i.test(li.prefLocations);
      patch({
        network_counts: li.counts, applied_before: li.applied,
        display_name: profile.display_name || li.name, current_title: profile.current_title || li.currentTitle,
        current_company: profile.current_company || li.currentCompany,
        roles: profile.roles.length ? profile.roles : guess,
        regions: profile.regions.length ? profile.regions : (india ? ["india", "europe", "singapore", "uae"] : ["europe", "remote"]),
      });
      setMsg(`Imported ${li.stats.connections.toLocaleString()} connections across ${li.stats.companies.toLocaleString()} companies and ${li.stats.applications} past applications. Names stay in this browser only.`);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
    if (input.current) input.current.value = "";
  }
  return (
    <div>
      <div className="dropzone" onClick={() => input.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}>
        <b>Drop your LinkedIn data export (.zip)</b> or click to choose.
        <div className="hint">LinkedIn → Settings → Data privacy → Get a copy of your data → “The works”. It arrives by email within a day.</div>
        <input ref={input} type="file" accept=".zip,application/zip" hidden onChange={e => onFile(e.target.files?.[0])} />
      </div>
      {busy && <p><span className="spin" />Reading the export in your browser…</p>}
      {msg && <p className="okmsg">{msg}</p>}
      {err && <p className="err">{err}</p>}
      {!msg && Object.keys(profile.network_counts || {}).length > 0 && <p className="hint">Already imported: connections at {Object.keys(profile.network_counts).length.toLocaleString()} companies.</p>}
    </div>
  );
}

/* ───────────── preferences ───────────── */
export function PrefsEditor({ profile, patch }: { profile: Profile; patch: Patch }) {
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter(x => x !== k) : [...list, k]);
  const words = (s: string) => s.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
  return (
    <div>
      <div className="row">
        <div className="field" style={{ flex: 1, minWidth: 200 }}><label>Your name</label><input value={profile.display_name || ""} onChange={e => patch({ display_name: e.target.value })} /></div>
        <div className="field" style={{ flex: 1, minWidth: 200 }}><label>Current title</label><input value={profile.current_title || ""} onChange={e => patch({ current_title: e.target.value })} /></div>
        <div className="field" style={{ flex: 1, minWidth: 200 }}><label>Current company</label><input value={profile.current_company || ""} onChange={e => patch({ current_company: e.target.value })} /></div>
      </div>
      <div className="lbl" style={{ margin: "10px 0 6px" }}>Roles to match</div>
      <div className="pick">
        {ROLE_PRESETS.map(r => (
          <label key={r.key}><input type="checkbox" checked={profile.roles.includes(r.key)} onChange={() => patch({ roles: toggle(profile.roles, r.key) })} />
            <span>{r.label}<small>{r.hint}</small></span></label>
        ))}
      </div>
      <div className="row">
        <div className="field" style={{ flex: 1, minWidth: 240 }}><label>Extra title words to include</label>
          <input defaultValue={(profile.title_include || []).join(", ")} onBlur={e => patch({ title_include: words(e.target.value) })} placeholder="e.g. recommendation, search relevance" /></div>
        <div className="field" style={{ flex: 1, minWidth: 240 }}><label>Title words to exclude</label>
          <input defaultValue={(profile.title_exclude || []).join(", ")} onBlur={e => patch({ title_exclude: words(e.target.value) })} placeholder="e.g. security, hardware" /></div>
        <div className="field" style={{ minWidth: 220 }}><label>Seniority</label>
          <select value={profile.seniority} onChange={e => patch({ seniority: e.target.value })}>{SENIORITY.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></div>
      </div>
      <div className="lbl" style={{ margin: "10px 0 6px" }}>Where</div>
      <div className="pick">
        {REGIONS.map(r => (
          <label key={r.key}><input type="checkbox" checked={profile.regions.includes(r.key)} onChange={() => patch({ regions: toggle(profile.regions, r.key) })} />
            <span>{r.icon} {r.label}</span></label>
        ))}
      </div>
      <div className="field"><label>Proof points used in your messages (one per line)</label>
        <textarea defaultValue={(profile.proofs || []).join("\n")} onBlur={e => patch({ proofs: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })} />
        <span className="hint">Short, real achievements with numbers. The drafts pick the one that best fits each job.</span></div>
    </div>
  );
}

/* ───────────── optional AI ───────────── */
export function AISetup() {
  const [key, setKey] = useState(ai.key()); const [model, setModel] = useState(ai.model());
  const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  return (
    <div>
      <p>Optional. Add a free <b>Gemini API key</b> (from Google AI Studio) and the app gets smarter:</p>
      <ul>
        <li>Reads your resume properly: skills, years and your best achievements, instead of simple pattern matching.</li>
        <li>Writes a message tailored to each job and person (“✨ Personalise” in the drafts drawer).</li>
      </ul>
      <p className="hint">Without a key everything still works: rule-based matching plus your own editable message templates. The key is stored only in this browser and sent straight to Google; it never reaches our database. Google's free tier has rate limits and its own data terms.</p>
      <div className="row">
        <div className="field" style={{ flex: 2, minWidth: 260 }}><label>Gemini API key</label><input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" /></div>
        <div className="field" style={{ flex: 1, minWidth: 180 }}><label>Model</label><input value={model} onChange={e => setModel(e.target.value)} /></div>
      </div>
      <div className="row">
        <button className="btn small" disabled={busy} onClick={async () => { ai.set(key.trim(), model.trim()); setBusy(true); setMsg(""); try { await testKey(); setMsg("✅ Key works."); } catch (e) { setMsg("❌ " + (e as Error).message); } setBusy(false); }}>{busy ? "Testing…" : "Save & test"}</button>
        {key && <button className="linkbtn" onClick={() => { ai.set("", model); setKey(""); setMsg("Key removed from this browser."); }}>Remove key</button>}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get a free key ↗</a>
      </div>
      {msg && <p>{msg}</p>}
    </div>
  );
}

/* ───────────── message templates ───────────── */
export function TemplatesEditor({ profile, patch }: { profile: Profile; patch: Patch }) {
  const t = profile.templates || DEFAULT_TEMPLATES;
  const set = (k: keyof Templates, v: string) => patch({ templates: { ...t, [k]: v } });
  return (
    <div>
      <p className="hint">Placeholders: {"{first}"} their first name, {"{intro}"} “I'm Name, a Title at Company”, {"{company}"}, {"{title}"}, {"{location}"}, {"{url}"}, {"{proof}"} your best-fitting proof point, {"{proof_sentence}"}.</p>
      {(Object.keys(TEMPLATE_LABELS) as (keyof Templates)[]).map(k => (
        <div className="field" key={k}><label>{TEMPLATE_LABELS[k]}</label>
          <textarea defaultValue={t[k]} key={t[k]} onBlur={e => set(k, e.target.value)} /></div>
      ))}
      <button className="linkbtn" onClick={() => patch({ templates: null })}>Reset to defaults</button>
    </div>
  );
}
