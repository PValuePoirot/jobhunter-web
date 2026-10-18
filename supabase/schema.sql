-- Job Hunter web: Supabase schema. Paste into Supabase → SQL Editor → Run (safe to re-run).
-- Shared tables (jobs, companies, meta) are written by the GitHub Actions poller with the service key
-- and are read-only for signed-in users. Per-user tables are locked to their owner with row-level security.

-- ───────────────────────── shared job pool ─────────────────────────
create table if not exists public.jobs (
  id          text primary key,
  company     text not null,
  title       text not null,
  location    text,
  url         text not null,
  source      text,
  kind        text,                 -- 'ats' (company careers feed) | 'agg' (job board)
  tier        int,
  posted      timestamptz,
  first_seen  timestamptz default now(),
  last_seen   timestamptz default now(),
  region      text,                 -- india | europe | singapore | uae | other_ok | us_optional | remote_global | regional | placeholder | ...
  country     text,
  visa_route  text,
  visa        text,                 -- yes | no | unknown (from the posting text)
  snippet     text
);
create index if not exists jobs_posted_idx on public.jobs (posted desc);
create index if not exists jobs_region_idx on public.jobs (region);

create table if not exists public.companies (
  name text primary key,
  tier int,
  ats  text,
  url  text
);

create table if not exists public.meta (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);

alter table public.jobs      enable row level security;
alter table public.companies enable row level security;
alter table public.meta      enable row level security;
drop policy if exists "read jobs" on public.jobs;
drop policy if exists "read companies" on public.companies;
drop policy if exists "read meta" on public.meta;
create policy "read jobs"      on public.jobs      for select to authenticated using (true);
create policy "read companies" on public.companies for select to authenticated using (true);
create policy "read meta"      on public.meta      for select to authenticated using (true);

-- ───────────────────────── per-user data ─────────────────────────
create table if not exists public.profiles (
  user_id         uuid primary key references auth.users on delete cascade default auth.uid(),
  display_name    text,
  current_title   text,
  current_company text,
  years           numeric,
  roles           jsonb default '[]',      -- selected role presets
  title_include   jsonb default '[]',      -- extra title words
  title_exclude   jsonb default '[]',
  seniority       text default 'mid-senior',
  regions         jsonb default '["india","europe","singapore","uae"]',
  hidden_companies jsonb default '[]',
  templates       jsonb,                   -- the user's own message drafts
  proofs          jsonb default '[]',      -- proof points used in drafts
  network_counts  jsonb default '{}',      -- company -> number of connections (no names)
  applied_before  jsonb default '{}',      -- company -> past application count
  onboarded       boolean default false,
  updated_at      timestamptz default now()
);

create table if not exists public.resumes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users on delete cascade default auth.uid(),
  label      text,
  file_path  text,
  text       text,
  skills     jsonb default '[]',
  titles     jsonb default '[]',
  years      numeric,
  created_at timestamptz default now()
);

create table if not exists public.applications (
  user_id    uuid not null references auth.users on delete cascade default auth.uid(),
  job_id     text not null,
  status     text,
  note       text,
  updated_at timestamptz default now(),
  primary key (user_id, job_id)
);

alter table public.profiles     enable row level security;
alter table public.resumes      enable row level security;
alter table public.applications enable row level security;

drop policy if exists "own profile" on public.profiles;
drop policy if exists "own resumes" on public.resumes;
drop policy if exists "own applications" on public.applications;
create policy "own profile"      on public.profiles     for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own resumes"      on public.resumes      for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own applications" on public.applications for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ───────────────────────── resume files (private bucket, one folder per user) ─────────────────────────
insert into storage.buckets (id, name, public) values ('resumes', 'resumes', false) on conflict (id) do nothing;
drop policy if exists "own resume files" on storage.objects;
create policy "own resume files" on storage.objects for all to authenticated
  using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);

-- ───────────────────────── delete my account ─────────────────────────
-- The app deletes the user's resume files first, then calls this; everything else cascades.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from auth.users where id = auth.uid();
end; $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
