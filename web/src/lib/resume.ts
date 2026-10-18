// Resume parsing in the browser: PDF -> text. The text heuristics live in resumeText.ts (pure, testable).
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
export { parseResumeText, yearsOfExperience } from "./resumeText";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function pdfText(file: File): Promise<string> {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let lastY: number | null = null, line = "";
    for (const it of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ""; }
      line += (line && !line.endsWith(" ") && !it.str.startsWith(" ") ? " " : "") + it.str;
      lastY = y;
      if (it.hasEOL) { lines.push(line); line = ""; lastY = null; }
    }
    if (line) lines.push(line);
  }
  return lines.map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

