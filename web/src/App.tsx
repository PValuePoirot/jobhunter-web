import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { configured, supabase } from "./lib/supabase";
import { loadPeople } from "./lib/localdb";
import { groupPeople } from "./lib/match";
import type { Job, Person, Profile, Resume } from "./lib/match";
import { EMPTY_PROFILE, loadApplications, loadJobs, loadMeta, loadProfile, loadResumes, saveProfile } from "./lib/store";
import Dashboard from "./views/Dashboard";
import Login from "./views/Login";
import Onboarding from "./views/Onboarding";
import Settings from "./views/Settings";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [apps, setApps] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [view, setView] = useState<"main" | "settings">("main");
  const [loading, setLoading] = useState("");
  const [err, setErr] = useState("");
  const saveTimer = useRef<number | undefined>(undefined);
  const uid = session?.user.id || "";

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const reloadResumes = useCallback(() => { loadResumes().then(setResumes).catch(e => setErr(e.message)); }, []);
  const loadAll = useCallback(async () => {
    setErr("");
    try {
      setLoading("Loading your notebook…");
      const [p, r, a] = await Promise.all([loadProfile(), loadResumes(), loadApplications()]);
      setProfile(p); setResumes(r); setApps(a); setProfileLoaded(true);
      setPeople(await loadPeople(uid));
      setLoading("Loading fresh jobs…");
      const [j, m] = await Promise.all([loadJobs(), loadMeta()]);
      setJobs(j); setMeta(m);
    } catch (e) { setErr((e as Error).message); }
    setLoading("");
  }, [uid]);

  useEffect(() => { if (uid) loadAll(); else { setProfileLoaded(false); setJobs([]); } }, [uid, loadAll]);

  // Every edit updates the screen immediately and is saved ~0.6s later.
  const patch = useCallback((p: Partial<Profile>) => {
    setProfile(prev => {
      const next = { ...prev, ...p };
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => saveProfile(next).catch(e => setErr("Couldn't save: " + e.message)), 600);
      return next;
    });
    if ("network_counts" in p) loadPeople(uid).then(setPeople);
  }, [uid]);

  const byCo = useMemo(() => groupPeople(people), [people]);

  if (!configured) return <div className="wrap narrow"><div className="panel"><h2>Almost there</h2><p>This deployment is missing <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>. Add them in Vercel → Project → Settings → Environment Variables, then redeploy.</p></div></div>;
  if (!ready) return <div className="wrap narrow"><p><span className="spin" />Opening…</p></div>;
  if (!session) return <Login />;
  if (!profileLoaded) return <div className="wrap narrow"><p>{err ? <span className="err">{err}</span> : <><span className="spin" />{loading || "Loading…"}</>}</p>{err && <button className="btn" onClick={loadAll}>Try again</button>}</div>;

  const signOut = () => supabase.auth.signOut();
  const email = session.user.email || "";
  return (
    <>
      {err && <div className="wrap narrow" style={{ marginBottom: 0 }}><p className="err">{err} <button className="linkbtn" onClick={() => setErr("")}>dismiss</button></p></div>}
      {!profile.onboarded
        ? <Onboarding uid={uid} profile={profile} resumes={resumes} patch={patch} reloadResumes={reloadResumes} finish={() => patch({ onboarded: true })} />
        : view === "settings"
          ? <Settings uid={uid} email={email} profile={profile} resumes={resumes} patch={patch} reloadResumes={reloadResumes} back={() => { setView("main"); window.scrollTo(0, 0); }} />
          : <Dashboard profile={profile} resumes={resumes} jobs={jobs} apps={apps} setApps={setApps} meta={meta} byCo={byCo} loading={loading}
              reload={loadAll} openSettings={() => { setView("settings"); window.scrollTo(0, 0); }} signOut={signOut} />}
    </>
  );
}
