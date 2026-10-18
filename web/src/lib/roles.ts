// Role presets: title words that count as a match. Built from the researched list used by the personal tracker.
export type RolePreset = { key: string; label: string; hint: string; include: string[]; signals: string[] };

export const ROLE_PRESETS: RolePreset[] = [
  {
    key: "ai", label: "AI / GenAI / LLM Engineer", hint: "AI engineer, applied AI, LLM, agents, RAG, voice AI",
    include: ["ai engineer", "applied ai", "genai", "gen ai", "generative ai", "llm", "llms", "llmops", "ai agent", "ai agents", "agentic",
      "agent engineer", "agents engineer", "agent platform", "agents platform", "agent infrastructure", "engineer, agents", "engineer - agents",
      "prompt engineer", "conversational ai", "voice ai", "voice agent", "voice agents", "rag", "ai developer", "ai platform", "ai solutions",
      "ai architect", "ai engineering", "ai systems", "ai", "member of technical staff", "speech", "natural language", "model serving"],
    signals: ["llm", "genai", "generative", "agent", "rag", "langchain", "prompt", "openai", "voice ai", "chatbot"],
  },
  {
    key: "fde", label: "Forward Deployed / AI Solutions", hint: "FDE, deployed engineer, deployment strategist, solutions",
    include: ["forward deployed", "forward-deployed", "fde", "deployed engineer", "deployed architect", "deployment strategist", "strategic deployments",
      "resident solutions architect", "solutions engineer", "solutions architect", "technical solutions", "customer engineer", "deployed ai"],
    signals: ["forward deployed", "customer", "stakeholder", "deployment", "solutions", "client", "integration"],
  },
  {
    key: "ml", label: "Machine Learning Engineer", hint: "ML engineer, MLOps, deep learning, CV, NLP",
    include: ["machine learning", "ml engineer", "ml", "mlops", "ml ops", "applied ml", "deep learning", "computer vision", "nlp",
      "research engineer", "algorithms engineer", "ai/ml", "ml/ai", "ai ml", "ai-ml", "ai & ml", "ai and ml", "ml scientist"],
    signals: ["pytorch", "tensorflow", "machine learning", "model training", "mlops", "deep learning", "computer vision", "nlp"],
  },
  {
    key: "ds", label: "Data Scientist / Applied Scientist", hint: "data science, applied scientist, decision science",
    include: ["data scientist", "data scientists", "data science", "applied scientist", "applied science", "machine learning scientist",
      "decision scientist", "decision science", "applied data scientist", "ai scientist", "statistician"],
    signals: ["data scientist", "statistics", "experimentation", "a/b test", "forecasting", "causal", "regression"],
  },
  {
    key: "de", label: "Data Engineering / Analytics", hint: "data engineer, analytics engineer, data platform, BI",
    include: ["data engineer", "analytics engineer", "data platform", "data infrastructure", "data analyst", "bi engineer", "business intelligence", "analytics"],
    signals: ["spark", "airflow", "dbt", "etl", "data pipeline", "snowflake", "bigquery", "data warehouse"],
  },
  {
    key: "swe", label: "Software Engineering", hint: "backend, full stack, platform, SDE",
    include: ["software engineer", "software developer", "backend engineer", "back end engineer", "backend developer", "full stack",
      "fullstack", "full-stack", "platform engineer", "sde", "software development engineer", "frontend engineer", "front end engineer", "mobile engineer"],
    signals: ["backend", "microservices", "api", "distributed systems", "react", "node", "java", "golang"],
  },
  {
    key: "pm", label: "Product Management (tech / AI)", hint: "product manager, technical PM, AI PM",
    include: ["product manager", "technical product manager", "ai product manager", "product lead", "group product manager"],
    signals: ["product manager", "roadmap", "product strategy", "prd"],
  },
];

// Noise that is never wanted, whatever the role.
export const BASE_EXCLUDE = ["intern", "internship", "interns", "apprentice", "co-op", "coop", "werkstudent", "working student", "student", "new grad",
  "new graduate", "early career", "early-career", "graduate", "trainee", "fellowship", "director", "vp", "vice president", "head of", "chief",
  "sales", "account executive", "account manager", "sdr", "bdr", "recruiter", "recruiting", "sourcer", "talent", "marketing", "seo", "counsel",
  "legal", "paralegal", "finance", "accountant", "controller", "procurement", "payroll", "hr", "people partner", "executive assistant",
  "administrative assistant", "office manager", "trainer", "tutor", "annotator", "labeler", "rater", "content writer", "translator", "linguist",
  "banker", "banking", "policy development", "governance", "public policy", "customer success", "support specialist", "technician",
  "video creator", "graphic design", "expression of interest", "talent pool"];

export const SENIORITY: { key: string; label: string; exclude: string[] }[] = [
  { key: "junior", label: "Early career (0-2 yrs)", exclude: ["senior", "sr.", "sr", "staff", "principal", "lead", "manager", "distinguished", "architect"] },
  { key: "mid-senior", label: "Mid to senior (2-8 yrs)", exclude: ["staff", "principal", "distinguished", "fellow", "junior", "jr", "manager"] },
  { key: "staff", label: "Staff and above (8+ yrs)", exclude: ["junior", "jr", "associate"] },
];

export const REGIONS: { key: string; label: string; icon: string }[] = [
  { key: "india", label: "India", icon: "🇮🇳" },
  { key: "europe", label: "Europe & UK", icon: "🇪🇺" },
  { key: "singapore", label: "Singapore", icon: "🇸🇬" },
  { key: "uae", label: "UAE / Gulf", icon: "🇦🇪" },
  { key: "other", label: "Other safe countries", icon: "🌍" },
  { key: "remote", label: "Remote (worldwide)", icon: "🌐" },
  { key: "us", label: "US, only if visa is stated", icon: "🇺🇸" },
];

export function regionKey(jobRegion: string | null | undefined): string | null {
  switch (jobRegion) {
    case "india": return "india";
    case "europe": return "europe";
    case "singapore": return "singapore";
    case "uae": return "uae";
    case "other_ok": return "other";
    case "remote_global": case "regional": return "remote";
    case "us_optional": return "us";
    default: return null;
  }
}

// Guess presets from free text (resume, LinkedIn job-title preferences).
export function guessRoles(text: string): string[] {
  const t = text.toLowerCase();
  const scored = ROLE_PRESETS.map(p => ({ k: p.key, s: p.signals.reduce((a, w) => a + (t.includes(w) ? 1 : 0), 0) }));
  const picked = scored.filter(x => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.k);
  return picked.length ? picked : ["ai", "ml"];
}
