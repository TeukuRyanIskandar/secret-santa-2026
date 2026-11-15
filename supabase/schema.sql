-- Secret Santa 2026 schema. Paste into Supabase: SQL Editor -> New query -> Run.
-- The browser never talks to Supabase directly; only the Vercel function does, with the
-- service-role key. Row level security is on with no policies, so the public anon key can't read anything.

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  token text not null unique,
  is_admin boolean not null default false,
  hints jsonb not null default '[]'::jsonb,
  hints_updated_at timestamptz,
  approved boolean not null default false, -- unused since the ornaments were dropped; kept for old installs
  found_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists draw (
  santa uuid primary key references people(id) on delete cascade,
  receiver uuid not null references people(id) on delete cascade,
  number int not null check (number > 0), -- the RECEIVER's gift number, 1..N, shuffled at each draw
  drawn_at timestamptz not null default now()
);

create table if not exists hides (
  santa uuid primary key references people(id) on delete cascade,
  receiver uuid not null references people(id) on delete cascade,
  clues text,          -- for the receiver; the app only shows them from hunt start
  spot text not null,  -- exact location; organizers only
  at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb
);

create unique index if not exists draw_number_key on draw (number);

alter table people enable row level security;
alter table draw enable row level security;
alter table hides enable row level security;
alter table settings enable row level security;

-- Replace the whole draw in one transaction.
create or replace function replace_draw(rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from draw where true;
  insert into draw (santa, receiver, number, drawn_at)
  select (r->>'santa')::uuid, (r->>'receiver')::uuid, (r->>'number')::int, coalesce((r->>'drawn_at')::timestamptz, now())
  from jsonb_array_elements(rows) as r;
end;
$$;

revoke execute on function replace_draw(jsonb) from public, anon, authenticated;
grant execute on function replace_draw(jsonb) to service_role;
