import { useState } from "react";
import { AISetup, LinkedInImport, PrefsEditor, ResumeManager, TemplatesEditor } from "../components/Setup";
import { clearPeople } from "../lib/localdb";
import type { Profile, Resume } from "../lib/match";
import { deleteAccount } from "../lib/store";

export default function Settings({ uid, email, profile, resumes, patch, reloadResumes, back }: {
  uid: string; email: string; profile: Profile; resumes: Resume[]; patch: (p: Partial<Profile>) => void; reloadResumes: () => void; back: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="wrap">
      <header>
        <div><div className="eyebrow">settings</div><h1>Job Hunter</h1><div className="sub">Signed in as {email}. Changes save automatically.</div></div>
        <div className="spacer" />
        <button className="btn" onClick={back}>← Back to jobs</button>
      </header>
      <div className="panel"><h2>Preferences</h2><PrefsEditor profile={profile} patch={patch} /></div>
      <div className="panel"><h2>Resumes</h2><ResumeManager resumes={resumes} profile={profile} onChanged={reloadResumes} patch={patch} /></div>
      <div className="panel"><h2>LinkedIn network</h2><LinkedInImport uid={uid} profile={profile} patch={patch} /></div>
      <div className="panel"><h2>Message templates</h2><TemplatesEditor profile={profile} patch={patch} /></div>
      <div className="panel"><h2>AI (optional)</h2><AISetup /></div>
      <div className="panel">
        <h2>Your data</h2>
        <p>Stored in our database: your profile and preferences, your resume PDFs and the text read from them, your application statuses, and per-company connection counts. Stored only in this browser: your connections' names, and your Gemini key.</p>
        <div className="row">
          <button className="btn ghost small" onClick={async () => { await clearPeople(uid); patch({ network_counts: {}, applied_before: {} }); alert("LinkedIn data removed."); }}>Remove my LinkedIn data</button>
          <button className="btn small" disabled={busy} onClick={async () => {
            if (!confirm("Delete your account, resumes and all saved data? This can't be undone.")) return;
            setBusy(true);
            try { await clearPeople(uid); await deleteAccount(); } catch (e) { alert((e as Error).message); setBusy(false); }
          }}>{busy ? "Deleting…" : "Delete my account"}</button>
        </div>
      </div>
    </div>
  );
}
