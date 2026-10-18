// LinkedIn data export (zip) parsing, entirely in the browser.
// Connection names stay on this device (IndexedDB); only per-company counts go to the server.
import JSZip from "jszip";
import { csvObjects, normCo } from "./text";
import type { Person } from "./match";

export type LinkedInImport = {
  people: Person[];
  counts: Record<string, number>;
  applied: Record<string, number>;
  name: string;
  currentTitle: string;
  currentCompany: string;
  prefTitles: string;
  prefLocations: string;
  skills: string[];
  stats: { connections: number; companies: number; applications: number };
};

export async function readLinkedInZip(file: File): Promise<LinkedInImport> {
  const zip = await JSZip.loadAsync(file);
  const get = async (re: RegExp) => {
    const out: string[] = [];
    for (const f of Object.values(zip.files)) if (!f.dir && re.test(f.name.split("/").pop() || "")) out.push(await f.async("string"));
    return out;
  };
  const conns = (await get(/^Connections\.csv$/i)).flatMap(t => csvObjects(t, ["First Name"]));
  if (!conns.length) throw new Error("Connections.csv wasn't found in this zip. Use the full LinkedIn data export.");
  const people: Person[] = conns.filter(r => r["Company"]).map(r => ({
    name: `${r["First Name"] || ""} ${r["Last Name"] || ""}`.trim(), role: r["Position"] || "", url: r["URL"] || "",
    email: r["Email Address"] || "", company: r["Company"] || "",
  }));
  const counts: Record<string, number> = {};
  for (const p of people) { const k = normCo(p.company); if (k) counts[k] = (counts[k] || 0) + 1; }

  const applied: Record<string, number> = {};
  let nApps = 0;
  for (const t of await get(/^Job Applications.*\.csv$/i))
    for (const r of csvObjects(t, ["Application Date"])) {
      const k = normCo(r["Company Name"] || "");
      if (k) { applied[k] = (applied[k] || 0) + 1; nApps++; }
    }

  const prof = (await get(/^Profile\.csv$/i)).flatMap(t => csvObjects(t, ["First Name"]))[0] || {};
  const pos = (await get(/^Positions\.csv$/i)).flatMap(t => csvObjects(t, ["Company Name"]));
  const current = pos.find(r => !r["Finished On"]) || pos[0] || {};
  const prefs = (await get(/^Job Seeker Preferences\.csv$/i)).flatMap(t => csvObjects(t, ["Locations", "Job Titles", "Preferred"]))[0] || {};
  const skills = (await get(/^Skills\.csv$/i)).flatMap(t => csvObjects(t, ["Name"])).map(r => r["Name"]).filter(Boolean);

  return {
    people, counts, applied,
    name: `${prof["First Name"] || ""} ${prof["Last Name"] || ""}`.trim(),
    currentTitle: current["Title"] || "", currentCompany: current["Company Name"] || "",
    prefTitles: prefs["Job Titles"] || "", prefLocations: prefs["Locations"] || "", skills,
    stats: { connections: people.length, companies: Object.keys(counts).length, applications: nApps },
  };
}
