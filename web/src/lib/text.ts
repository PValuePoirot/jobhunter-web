// Text helpers shared by resume parsing, LinkedIn import and matching.

/** RFC-4180-ish CSV parser (quoted fields, commas and newlines inside quotes). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV -> objects, starting at the first line that begins with one of `headerStarts` (LinkedIn puts notes above headers). */
export function csvObjects(text: string, headerStarts: string[]): Record<string, string>[] {
  const rows = parseCSV(text.replace(/^﻿/, ""));
  const h = rows.findIndex(r => headerStarts.some(s => (r[0] || "").trim().startsWith(s)));
  if (h < 0) return [];
  const head = rows[h].map(x => x.trim());
  return rows.slice(h + 1).filter(r => r.some(x => x.trim())).map(r => Object.fromEntries(head.map((k, i) => [k, (r[i] || "").trim()])));
}

const DROP = new Set(["inc", "ltd", "limited", "llc", "llp", "pvt", "private", "corp", "corporation", "co", "company", "technologies", "technology",
  "india", "global", "tech", "services", "solutions", "systems", "software", "labs", "group", "plc", "gmbh", "ag", "pte", "the", "and"]);
const ALIAS: Record<string, string> = { alphabet: "google", facebook: "meta", "meta platforms": "meta", "amazon web": "amazon", aws: "amazon",
  citigroup: "citi", citibank: "citi", "citi bank": "citi", "jpmorgan chase": "jpmorgan", jpmorganchase: "jpmorgan", "jp morgan": "jpmorgan", amex: "american express" };

/** Normalise a company name so "Walmart Global Tech India" and "Walmart" meet. */
export function normCo(name: string): string {
  const n = (name || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/).filter(w => w && !DROP.has(w)).join(" ");
  return ALIAS[n] ?? n;
}

/** Does a normalised connection-company key belong to this job's company? */
export function sameCompany(key: string, company: string): boolean {
  const n = normCo(company);
  if (!n) return false;
  if (key === n) return true;
  const short = key.length < n.length ? key : n;
  return short.length >= 4 && (key.startsWith(n + " ") || n.startsWith(key + " "));
}

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-boundary regex for a list of phrases (works with c++, node.js, ci/cd). */
export function phraseRegex(words: string[]): RegExp | null {
  const ws = [...new Set(words.map(w => w.trim().toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!ws.length) return null;
  return new RegExp(`(?<![a-z0-9])(?:${ws.map(esc).join("|")})(?![a-z0-9])`, "i");
}

/** Skills we look for in resumes and job text. Lowercase; matched with word boundaries. */
export const SKILLS = [
  "python", "java", "javascript", "typescript", "golang", "rust", "c++", "c#", "scala", "kotlin", "sql", "r", "bash",
  "pytorch", "tensorflow", "keras", "jax", "scikit-learn", "sklearn", "xgboost", "lightgbm", "hugging face", "transformers", "pandas", "numpy",
  "langchain", "langgraph", "llamaindex", "openai", "anthropic", "gemini", "llm", "llms", "rag", "retrieval", "vector database", "qdrant",
  "pinecone", "weaviate", "faiss", "embeddings", "mcp", "tool calling", "function calling", "prompt engineering", "fine-tuning", "lora", "peft",
  "rlhf", "agents", "agentic", "multi-agent", "evals", "evaluation", "langfuse", "guardrails", "nlp", "ner", "computer vision", "opencv", "ocr",
  "speech", "whisper", "asr", "tts", "voice ai", "chatbot", "conversational ai", "recommendation", "ranking", "search", "personalization",
  "forecasting", "time series", "causal inference", "a/b testing", "experimentation", "statistics", "deep learning", "machine learning",
  "data science", "mlops", "llmops", "mlflow", "kubeflow", "airflow", "dbt", "spark", "pyspark", "kafka", "pub/sub", "flink", "snowflake",
  "databricks", "bigquery", "redshift", "postgres", "postgresql", "mysql", "mongodb", "redis", "elasticsearch", "docker", "kubernetes", "kserve",
  "terraform", "aws", "gcp", "azure", "sagemaker", "vertex ai", "fastapi", "flask", "django", "node.js", "react", "next.js", "graphql", "grpc",
  "rest", "microservices", "distributed systems", "ci/cd", "git", "linux", "datadog", "grafana", "prometheus", "tableau", "power bi", "looker",
  "excel", "etl", "data pipelines", "data warehouse", "product analytics", "stakeholder management", "customer-facing", "solution design",
];

export function findSkills(text: string, extra: string[] = []): string[] {
  const low = (text || "").toLowerCase();
  const out: string[] = [];
  for (const s of [...SKILLS, ...extra]) {
    const re = new RegExp(`(?<![a-z0-9])${esc(s.toLowerCase())}(?![a-z0-9])`);
    if (re.test(low) && !out.includes(s)) out.push(s);
  }
  return out;
}

export const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
export const firstName = (n: string) => { const f = (n || "").trim().split(/\s+/)[0] || ""; return f ? f[0].toUpperCase() + f.slice(1).toLowerCase() : ""; };
export function ago(iso?: string | null): string {
  if (!iso) return "";
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 1) return "just now"; if (m < 60) return `${Math.round(m)}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`; return `${Math.round(m / 1440)}d ago`;
}
