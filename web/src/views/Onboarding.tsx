import { useState } from "react";
import { AISetup, LinkedInImport, PrefsEditor, ResumeManager } from "../components/Setup";
import type { Profile, Resume } from "../lib/match";

const STEPS = ["Resumes", "LinkedIn", "Preferences", "AI (optional)"];

export default function Onboarding({ uid, profile, resumes, patch, reloadResumes, finish }: {
  uid: string; profile: Profile; resumes: Resume[]; patch: (p: Partial<Profile>) => void; reloadResumes: () => void; finish: () => void;
}) {
  const [step, setStep] = useState(0);
  const next = () => setStep(s => Math.min(STEPS.length - 1, s + 1));
  const canNext = step !== 0 || resumes.length > 0;
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="eyebrow">set up your notebook</div>
          <h1>Job Hunter</h1>
          <div className="sub">Four quick steps. You can change everything later in Settings.</div>
        </div>
      </header>
      <div className="steps">{STEPS.map((s, i) => <span key={s} className={`step ${i === step ? "on" : i < step ? "done" : ""}`}>{i + 1}. {s}</span>)}</div>

      <div className="panel">
        {step === 0 && <>
          <h2>Your resume(s)</h2>
          <p>We read each PDF in your browser to find your skills, experience and strongest achievements. Each job then gets matched against your best-fitting resume.</p>
          <ResumeManager resumes={resumes} profile={profile} onChanged={reloadResumes} patch={patch} />
        </>}
        {step === 1 && <>
          <h2>Your LinkedIn network</h2>
          <p>This powers referrals: who you know at each company, one-click LinkedIn links, and a warning when you've applied somewhere before. Connection names never leave this browser; we only store how many people you know at each company.</p>
          <LinkedInImport uid={uid} profile={profile} patch={patch} />
        </>}
        {step === 2 && <>
          <h2>What you're looking for</h2>
          <PrefsEditor profile={profile} patch={patch} />
        </>}
        {step === 3 && <>
          <h2>Smarter with AI (optional)</h2>
          <AISetup />
        </>}
      </div>

      <div className="row">
        {step > 0 && <button className="btn ghost" onClick={() => setStep(s => s - 1)}>← Back</button>}
        <div className="spacer" />
        {step === 1 && <button className="linkbtn" onClick={next}>Skip for now</button>}
        {step < STEPS.length - 1
          ? <button className="btn" disabled={!canNext} onClick={next}>{canNext ? "Next →" : "Add a resume to continue"}</button>
          : <button className="btn" disabled={!profile.roles.length || !profile.regions.length} onClick={finish}>Open my dashboard →</button>}
      </div>
    </div>
  );
}
