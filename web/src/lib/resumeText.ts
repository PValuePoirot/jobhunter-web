import { findSkills } from "./text";

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** Sum non-overlapping work date ranges like "Apr 2025 - Present" or "Jul 2022 – Jul 2024". Internships under 6 months are ignored. */
export function yearsOfExperience(text: string): number | null {
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{4})\s*[-–—to]+\s*(present|current|now|(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{4}))/gi;
  const spans: [number, number][] = [];
  const now = new Date(), nowM = now.getFullYear() * 12 + now.getMonth();
  for (const m of text.matchAll(re)) {
    const a = +m[2] * 12 + MONTHS[m[1].toLowerCase().slice(0, 3) === "sep" ? "sep" : m[1].toLowerCase().slice(0, 3)];
    const b = /present|current|now/i.test(m[3]) ? nowM : +m[5] * 12 + MONTHS[m[4].toLowerCase().slice(0, 3)];
    if (b > a && b - a >= 6) spans.push([a, b]);
  }
  if (!spans.length) return null;
  spans.sort((x, y) => x[0] - y[0]);
  let total = 0, [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) { if (s <= ce) ce = Math.max(ce, e); else { total += ce - cs; [cs, ce] = [s, e]; } }
  total += ce - cs;
  return Math.round((total / 12) * 10) / 10;
}

const ROLE_WORDS = /(engineer|scientist|developer|analyst|manager|architect|consultant|researcher|lead|intern|designer|strategist)/i;

export function parseResumeText(text: string) {
  const lines = text.split("\n");
  const name = (lines.find(l => /^[A-Za-z][A-Za-z .'-]{2,40}$/.test(l) && l.split(" ").length <= 4) || "").trim();
  const titles = [...new Set(lines.filter(l => ROLE_WORDS.test(l) && l.length < 70 && !/[•▪]/.test(l))
    .map(l => l.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}.*$/i, "").replace(/[|,–(\[-]+\s*$/, "").trim())
    .filter(l => l.length > 3))].slice(0, 6);
  // Proof points: bullet lines with a number in them (%, K+, crore, $, x), which make the best one-line evidence in messages.
  const bullets: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (/^[•▪\-–*·]/.test(l)) { if (cur) bullets.push(cur); cur = l.replace(/^[•▪\-–*·]\s*/, ""); }
    else if (cur && !ROLE_WORDS.test(l) && l.length > 25 && /^[a-z(]/.test(l)) cur += " " + l;
    else { if (cur) bullets.push(cur); cur = ""; }
  }
  if (cur) bullets.push(cur);
  const proofs = bullets.filter(b => /\d/.test(b) && b.length > 40).map(b => b.replace(/\s+/g, " ").trim()).slice(0, 12);
  return { name, titles, skills: findSkills(text), years: yearsOfExperience(text), proofs };
}
