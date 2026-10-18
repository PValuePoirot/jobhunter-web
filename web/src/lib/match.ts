// Matching: turns the shared job pool into one person's matches, scores, resume choice and drafts.
import { BASE_EXCLUDE, ROLE_PRESETS, SENIORITY, regionKey } from "./roles";
import { firstName, lowerFirst, normCo, phraseRegex, sameCompany } from "./text";

export type Job = {
  id: string; company: string; title: string; location: string | null; url: string; source: string | null; kind: string | null;
  tier: number | null; posted: string | null; first_seen: string | null; region: string | null; country: string | null;
  visa_route: string | null; visa: string | null; snippet: string | null;
};
export type Resume = { id: string; label: string | null; file_path: string | null; skills: string[]; titles: string[]; years: number | null };
export type Profile = {
  user_id?: string; display_name: string | null; current_title: string | null; current_company: string | null; years: number | null;
  roles: string[]; title_include: string[]; title_exclude: string[]; seniority: string; regions: string[]; hidden_companies: string[];
  templates: Templates | null; proofs: string[]; network_counts: Record<string, number>; applied_before: Record<string, number>; onboarded: boolean;
};
export type Templates = { referral: string; learn: string; growth: string };
export type Person = { name: string; role: string; url: string; email: string; company: string };

export const DEFAULT_TEMPLATES: Templates = {
  referral: "Hi {first}, hope you're doing well! {intro}. I noticed {company} is hiring for {title} ({location}) and it lines up closely with my work: {proof}. Would you be open to referring me, or pointing me to the right person on the team? Happy to send my resume. Job link: {url}. Thanks a lot either way!",
  learn: "Hi {first}, {intro}. I've been following the work at {company} and saw the {title} opening. I'd really value 10-15 minutes to learn how your team works, what the role looks like day to day, and what has helped you grow there. No pressure at all, and thank you for considering it!",
  growth: "Hi {first}, I'm looking to join a stable, well-run company where I can keep growing, and {company} is high on my list. I saw the {title} role ({url}). {proof_sentence} If you think it could be a fit, could you refer me or share how the team looks at candidates? Your guidance would mean a lot.",
};
export const TEMPLATE_LABELS: Record<keyof Templates, string> = { referral: "Ask for referral", learn: "Learn first", growth: "Growth & stability" };

export function buildRules(p: Profile) {
  const include = [...ROLE_PRESETS.filter(r => p.roles.includes(r.key)).flatMap(r => r.include), ...p.title_include];
  const sen = SENIORITY.find(s => s.key === p.seniority);
  const exclude = [...BASE_EXCLUDE, ...(sen ? sen.exclude : []), ...p.title_exclude]
    .filter(w => !include.includes(w));               // a word you explicitly want is never excluded
  const inc = phraseRegex(include), exc = phraseRegex(exclude);
  return {
    titleOk: (t: string) => (inc ? inc.test(t) : true) && !(exc && exc.test(t.replace(/technical staff/i, ""))),
    regionOk: (j: Job) => {
      const k = regionKey(j.region);
      if (!k || !p.regions.includes(k)) return false;
      return k !== "us" || j.visa === "yes";             // US only when sponsorship/relocation is stated
    },
  };
}

function hits(skills: string[], title: string, body: string) {
  const matched: string[] = [];
  let s = 0;
  for (const k of skills) {
    const re = phraseRegex([k]);
    if (!re) continue;
    const inT = re.test(title), inB = re.test(body);
    if (inT || inB) { s += inT ? 3 : 1; matched.push(k); }
  }
  return { s, matched };
}

/** Score 0-10 against the best-fitting resume; also says which resume and why. */
export function scoreJob(j: Job, resumes: Resume[], p: Profile) {
  const title = j.title.toLowerCase(), body = (j.snippet || "").toLowerCase();
  let best = { idx: -1, s: 0, matched: [] as string[] };
  resumes.forEach((r, idx) => {
    const h = hits(r.skills || [], title, body);
    if (h.s > best.s) best = { idx, ...h };
  });
  if (best.idx < 0) {   // no resume skills: fall back to role signals
    const sig = ROLE_PRESETS.filter(r => p.roles.includes(r.key)).flatMap(r => r.signals);
    best = { idx: resumes.length ? 0 : -1, ...hits(sig, title, body) };
  }
  return { score: Math.min(10, Math.round(best.s * 10 / 12)), resume: best.idx >= 0 ? resumes[best.idx] : null, why: best.matched.slice(0, 5) };
}

export const networkCount = (company: string, counts: Record<string, number>) =>
  Object.entries(counts || {}).reduce((a, [k, n]) => a + (sameCompany(k, company) ? n : 0), 0);

export function peopleAt(company: string, byCo: Map<string, Person[]>): Person[] {
  const out: Person[] = [];
  for (const [k, ppl] of byCo) if (sameCompany(k, company)) out.push(...ppl);
  const rank = (role: string) => {
    const r = (role || "").toLowerCase();
    if (/intern|student|summer school|trainee|aspiring|seeking|looking for|fresher|freelanc|former/.test(r)) return 4;
    if (/recruit|talent|hiring|sourc|acquisition|\bhr\b|people/.test(r)) return 0;
    if (/engineer|ml\b|\bai\b|data|scien|research|developer|architect|machine/.test(r)) return 1;
    if (/manager|lead|director|head|vp|principal|staff/.test(r)) return 2;
    return 3;
  };
  return out.sort((a, b) => rank(a.role) - rank(b.role)).slice(0, 15);
}

export function groupPeople(list: Person[]): Map<string, Person[]> {
  const m = new Map<string, Person[]>();
  for (const p of list) { const k = normCo(p.company); if (!k) continue; (m.get(k) ?? m.set(k, []).get(k)!).push(p); }
  return m;
}

/** Choose the proof point that best fits this job. */
export function pickProof(j: Job, proofs: string[]): string {
  if (!proofs.length) return "";
  const words = new Set(`${j.title} ${j.snippet || ""}`.toLowerCase().match(/[a-z][a-z+#./-]{2,}/g) || []);
  let best = proofs[0], bs = -1;
  for (const pr of proofs) {
    const s = (pr.toLowerCase().match(/[a-z][a-z+#./-]{2,}/g) || []).filter(w => words.has(w)).length;
    if (s > bs) { bs = s; best = pr; }
  }
  return best;
}

function proofPhrase(proof: string) {
  let p = proof.replace(/^[•\-–*▪·\s]+/, "").replace(/[.;\s]+$/, "");
  if (p.length > 190) p = p.slice(0, 190).replace(/[,;]?\s+\S*$/, "").replace(/[,;:]$/, "");
  return /^(i|we)\b/i.test(p) ? p : "I " + lowerFirst(p);
}

/** "Data Scientist- Agentic AI,RAG,MCP, … (10-15y)" -> "Data Scientist- Agentic AI" for use inside a message. */
export function shortTitle(t: string): string {
  const first = t.split(/\s*[(|,]\s*|\s[-–]\s/)[0].trim();
  const s = first.length >= 12 ? first : t;
  return s.length > 80 ? s.slice(0, 80).replace(/\s+\S*$/, "") : s;
}

/** Hide roles whose title or text asks for far more experience than you have (e.g. "10-15y" when you have 4). */
export function tooSenior(j: Job, years: number | null): boolean {
  if (!years) return false;
  const text = `${j.title} ${j.snippet || ""}`;
  const m = [...text.matchAll(/(\d{1,2})\s*\+?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?|y)\b/gi)].map(x => +x[1]).filter(n => n > 0 && n < 30);
  return m.length > 0 && Math.min(...m) > years + 3;
}

export function draft(kind: keyof Templates, j: Job, who: Person | null, p: Profile): string {
  const t = (p.templates || DEFAULT_TEMPLATES)[kind] || DEFAULT_TEMPLATES[kind];
  const me = firstName(p.display_name || "") || "";
  const role = p.current_title ? `${/^[aeiou]/i.test(p.current_title) ? "an" : "a"} ${p.current_title}` : "";
  const intro = me ? `I'm ${me}${role ? `, ${role}` : ""}${p.current_company ? ` at ${p.current_company}` : ""}` : "I came across your profile";
  const proof = pickProof(j, p.proofs || []);
  const sub: Record<string, string> = {
    "{first}": who ? firstName(who.name) : "there", "{me}": me, "{intro}": intro, "{company}": j.company, "{title}": shortTitle(j.title),
    "{location}": (j.location || "").split("|")[0].trim().slice(0, 40), "{url}": j.url,
    "{proof}": proof ? proofPhrase(proof) : "I've been building in this exact area",
    "{proof_sentence}": proof ? proofPhrase(proof) + "." : "",
    "{current_title}": p.current_title || "", "{current_company}": p.current_company || "",
  };
  return Object.entries(sub).reduce((a, [k, v]) => a.split(k).join(v), t).replace(/\s{2,}/g, " ").trim();
}
