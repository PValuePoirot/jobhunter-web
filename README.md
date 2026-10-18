# Job Hunter (web)

A job-hunt notebook for a small invite-only group: sign in with an emailed code, upload your resume(s) and your LinkedIn
data export, and get fresh matching roles from ~170 company career pages and job boards, with referral paths and
ready-to-edit LinkedIn messages.

| Part | Where | Cost |
|---|---|---|
| Website (`web/`, Vite + React) | Vercel | free (Hobby, non-commercial) |
| Login, database, resume storage | Supabase (`supabase/schema.sql`) | free tier |
| Job pool (`ingest/pool.py`) | GitHub Actions, every 30 min | free (public repo) |
| Optional AI | each user's own Gemini key, in their browser | free tier |

**Privacy**: resumes are parsed in the browser and stored in a private, per-user bucket. LinkedIn connection names never
leave the user's browser; only per-company counts are stored. Every per-user table is protected by row-level security.
This repo contains only code; no personal data.

## Setup
1. Supabase: create a project, run `supabase/schema.sql` in the SQL editor, configure email OTP + custom SMTP, invite users.
2. GitHub: add repo secrets `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`, then run the `job-pool` workflow once.
3. Vercel: import this repo with Root Directory `web`, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

Local dev: `cd web && cp .env.example .env.local && npm install && npm run dev`.
