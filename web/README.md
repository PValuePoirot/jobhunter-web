# Job Hunter (web)

Multi-user version of the job-hunt notebook: sign in with an emailed code, upload resume(s) and your LinkedIn export,
and get matched roles, referral paths and message drafts. Private beta (invite-only).

- **Frontend**: Vite + React (this folder), hosted on Vercel (free).
- **Backend**: Supabase (free): email OTP auth, Postgres with row-level security, private storage for resumes.
  Schema: `../supabase/schema.sql`.
- **Job pool**: `../pool.py`, run by GitHub Actions, fetches ~170 sources into the shared `jobs` table.
- **Privacy**: resumes are parsed in the browser; LinkedIn connection *names* stay in the browser (IndexedDB);
  the server only stores per-company counts. An optional Gemini key lives in the browser only.

Local dev: copy `.env.example` to `.env.local`, fill in the Supabase URL + anon key, then `npm install && npm run dev`.
