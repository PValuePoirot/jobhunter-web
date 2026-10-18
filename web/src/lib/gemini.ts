// Optional AI layer using the user's own Gemini API key (Google AI Studio free tier).
// The call goes straight from this browser to Google; the key never touches our database.
import { ai } from "./localdb";
import type { Job, Person, Profile } from "./match";

async function call(prompt: string, json: boolean): Promise<string> {
  const key = ai.key();
  if (!key) throw new Error("Add your Gemini API key in Settings first.");
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(ai.model())}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.5, ...(json ? { responseMimeType: "application/json" } : {}) } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Gemini error ${r.status}`);
  return d?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || "").join("") || "";
}

export async function testKey(): Promise<string> {
  return (await call("Reply with just the word OK.", false)).trim();
}

/** Better resume understanding than the built-in rules. */
export async function aiParseResume(text: string) {
  const out = await call(`Extract facts from this resume. Only use what is written; never invent.
Return JSON: {"name": str, "current_title": str, "current_company": str, "years_experience": number,
"skills": [up to 40 short lowercase skills/tools], "proof_points": [5-10 strongest achievements, each one sentence starting with a past-tense verb, keep the original numbers]}

RESUME:
${text.slice(0, 15000)}`, true);
  return JSON.parse(out) as { name?: string; current_title?: string; current_company?: string; years_experience?: number; skills?: string[]; proof_points?: string[] };
}

/** A tailored LinkedIn message for this job and this person, in the chosen style. */
export async function aiDraft(kind: string, j: Job, who: Person | null, p: Profile): Promise<string> {
  const style = { referral: "a warm, direct referral request", learn: "a curious ask for a short chat to learn about the team (no hard ask for a referral)", growth: "a sincere note about wanting to grow at a stable, well-run company, ending with a gentle referral ask" }[kind] || "a referral request";
  return (await call(`Write ${style} as a LinkedIn message from ${p.display_name || "me"} (${p.current_title || ""}${p.current_company ? " at " + p.current_company : ""}) to ${who ? `${who.name} (${who.role} at ${who.company}), a 1st-degree connection` : "someone at the company"}.
Job: ${j.title} at ${j.company} (${j.location || ""}). Link: ${j.url}
Job text: ${(j.snippet || "").slice(0, 500)}
Sender's real achievements (use at most one, the most relevant, keep its numbers; never invent any): ${(p.proofs || []).slice(0, 8).join(" | ")}
Rules: under 110 words, natural and human, no buzzwords, no emojis, no subject line, no placeholders, start with "Hi ${who ? who.name.split(" ")[0] : "there"},". Output only the message.`, false)).trim();
}
