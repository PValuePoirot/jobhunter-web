// All reads/writes to Supabase. Row-level security means each call only ever sees the signed-in user's rows.
import { supabase } from "./supabase";
import type { Job, Profile, Resume } from "./match";

export const EMPTY_PROFILE: Profile = {
  display_name: "", current_title: "", current_company: "", years: null, roles: [], title_include: [], title_exclude: [],
  seniority: "mid-senior", regions: ["india", "europe", "singapore", "uae"], hidden_companies: [], templates: null, proofs: [],
  network_counts: {}, applied_before: {}, onboarded: false,
};

const JOB_COLS = "id,company,title,location,url,source,kind,tier,posted,first_seen,region,country,visa_route,visa,snippet";

export async function loadJobs(): Promise<Job[]> {
  const since = new Date(Date.now() - 15 * 86400e3).toISOString();
  const out: Job[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("jobs").select(JOB_COLS)
      .or(`posted.gte.${since},and(posted.is.null,first_seen.gte.${since})`)
      .order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...(data as Job[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadMeta(): Promise<Record<string, unknown> | null> {
  const { data } = await supabase.from("meta").select("value").eq("key", "pool").maybeSingle();
  return (data?.value as Record<string, unknown>) || null;
}

export async function loadProfile(): Promise<Profile> {
  const { data, error } = await supabase.from("profiles").select("*").maybeSingle();
  if (error) throw error;
  return data ? { ...EMPTY_PROFILE, ...(data as Partial<Profile>) } : { ...EMPTY_PROFILE };
}

export async function saveProfile(p: Partial<Profile>) {
  const { data: u } = await supabase.auth.getUser();
  const { user_id: _ignored, ...rest } = p;
  void _ignored;
  const { error } = await supabase.from("profiles").upsert({ ...rest, user_id: u.user!.id, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function loadResumes(): Promise<Resume[]> {
  const { data, error } = await supabase.from("resumes").select("id,label,file_path,skills,titles,years").order("created_at");
  if (error) throw error;
  return (data as Resume[]) || [];
}

export async function addResume(file: File, label: string, parsed: { text: string; skills: string[]; titles: string[]; years: number | null }) {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user!.id;
  const path = `${uid}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
  const up = await supabase.storage.from("resumes").upload(path, file, { contentType: file.type || "application/pdf" });
  if (up.error) throw up.error;
  const { error } = await supabase.from("resumes").insert({ label, file_path: path, text: parsed.text.slice(0, 40000), skills: parsed.skills, titles: parsed.titles, years: parsed.years });
  if (error) throw error;
}

export async function updateResume(id: string, patch: Partial<Resume>) {
  const { error } = await supabase.from("resumes").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteResume(r: Resume) {
  if (r.file_path) await supabase.storage.from("resumes").remove([r.file_path]);
  const { error } = await supabase.from("resumes").delete().eq("id", r.id);
  if (error) throw error;
}

export async function resumeUrl(r: Resume): Promise<string | null> {
  if (!r.file_path) return null;
  const { data } = await supabase.storage.from("resumes").createSignedUrl(r.file_path, 300);
  return data?.signedUrl || null;
}

export async function loadApplications(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from("applications").select("job_id,status");
  if (error) throw error;
  return Object.fromEntries((data || []).map(r => [r.job_id, r.status || ""]));
}

export async function setApplication(job_id: string, status: string) {
  const { data: u } = await supabase.auth.getUser();
  const { error } = status
    ? await supabase.from("applications").upsert({ user_id: u.user!.id, job_id, status, updated_at: new Date().toISOString() })
    : await supabase.from("applications").delete().eq("job_id", job_id);
  if (error) throw error;
}

/** Deletes resume files, then the account (profile, resumes, applications cascade). */
export async function deleteAccount() {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user!.id;
  const { data: files } = await supabase.storage.from("resumes").list(uid, { limit: 1000 });
  if (files?.length) await supabase.storage.from("resumes").remove(files.map(f => `${uid}/${f.name}`));
  const { error } = await supabase.rpc("delete_my_account");
  if (error) throw error;
  await supabase.auth.signOut();
}
