-- Humanizer usage tracking
-- Paste this whole file into Supabase: SQL Editor -> New query -> Run

create table if not exists humanizer_runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table humanizer_runs enable row level security;

create policy "users insert own runs"
  on humanizer_runs for insert
  with check (auth.uid() = user_id);

create policy "users read own runs"
  on humanizer_runs for select
  using (auth.uid() = user_id);

create policy "users delete own runs"
  on humanizer_runs for delete
  using (auth.uid() = user_id);

create index if not exists humanizer_runs_user_idx on humanizer_runs (user_id);
