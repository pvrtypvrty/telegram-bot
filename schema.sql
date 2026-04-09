-- ============================================================
-- SUPABASE DATABASE SCHEMA
-- Run this in your Supabase SQL Editor (supabase.com → SQL Editor)
-- ============================================================

-- USERS TABLE
create table if not exists users (
  id uuid default gen_random_uuid() primary key,
  telegram_id text unique not null,
  username text,
  credits integer default 10,
  subscription_active boolean default false,
  subscription_expires_at timestamptz,
  stripe_subscription_id text,
  created_at timestamptz default now()
);

-- GENERATIONS TABLE (log every image made)
create table if not exists generations (
  id uuid default gen_random_uuid() primary key,
  telegram_id text references users(telegram_id),
  prompt text not null,
  image_url text,
  created_at timestamptz default now()
);

-- TRANSACTIONS TABLE (log every payment)
create table if not exists transactions (
  id uuid default gen_random_uuid() primary key,
  telegram_id text references users(telegram_id),
  type text not null, -- 'credit_purchase' or 'subscription'
  credits integer default 0,
  amount_paid integer, -- in cents (Stripe format)
  stripe_session_id text,
  created_at timestamptz default now()
);

-- INDEXES for fast lookups
create index if not exists idx_users_telegram_id on users(telegram_id);
create index if not exists idx_generations_telegram_id on generations(telegram_id);
create index if not exists idx_transactions_telegram_id on transactions(telegram_id);

-- Row Level Security (keep data safe)
alter table users enable row level security;
alter table generations enable row level security;
alter table transactions enable row level security;

-- Allow service role full access (your backend uses this)
create policy "Service role full access - users" on users
  for all using (true);

create policy "Service role full access - generations" on generations
  for all using (true);

create policy "Service role full access - transactions" on transactions
  for all using (true);
