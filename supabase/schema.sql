-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- The Node backend uses the service-role key (bypasses RLS). RLS is on so the public
-- anon key can never read anyone's data directly.

create table if not exists public.demo_accounts (
  id          uuid primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  balance     double precision not null,
  initial     double precision not null,
  realized    double precision not null default 0,
  fees        double precision not null default 0,
  funding     double precision not null default 0,
  lev         jsonb not null default '{}'::jsonb,
  positions   jsonb not null default '{}'::jsonb,
  orders      jsonb not null default '[]'::jsonb,   -- open + untriggered orders
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists demo_accounts_user_idx on public.demo_accounts(user_id);

create table if not exists public.demo_fills (
  id          uuid primary key,
  account_id  uuid not null references public.demo_accounts(id) on delete cascade,
  order_id    bigint,
  symbol      text not null,
  side        text not null,
  size        double precision not null,
  price       double precision not null,
  role        text not null,        -- maker | taker | liquidation
  fee         double precision not null,
  realized    double precision not null default 0,
  ts          timestamptz not null
);
create index if not exists demo_fills_acct_idx on public.demo_fills(account_id, ts desc);

create table if not exists public.demo_order_history (
  id          bigint not null,
  account_id  uuid not null references public.demo_accounts(id) on delete cascade,
  data        jsonb not null,       -- full terminal order object
  ts          timestamptz not null,
  primary key (account_id, id)
);
create index if not exists demo_hist_acct_idx on public.demo_order_history(account_id, ts desc);

create table if not exists public.demo_meta (
  key   text primary key,
  value text not null
);

alter table public.demo_accounts      enable row level security;
alter table public.demo_fills         enable row level security;
alter table public.demo_order_history enable row level security;
alter table public.demo_meta          enable row level security;

-- Optional read-only policies (only needed if you ever query these tables from the browser)
drop policy if exists "own accounts" on public.demo_accounts;
create policy "own accounts" on public.demo_accounts for select using (user_id = auth.uid());
drop policy if exists "own fills" on public.demo_fills;
create policy "own fills" on public.demo_fills for select using (account_id in (select id from public.demo_accounts where user_id = auth.uid()));
drop policy if exists "own history" on public.demo_order_history;
create policy "own history" on public.demo_order_history for select using (account_id in (select id from public.demo_accounts where user_id = auth.uid()));
