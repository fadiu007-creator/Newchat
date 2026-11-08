create extension if not exists pgcrypto;

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation',
  model text not null,
  provider text not null check (provider in ('openrouter', 'openai')),
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversations_messages_array check (jsonb_typeof(messages) = 'array')
);

create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

alter table public.conversations enable row level security;

drop policy if exists "Users can read their conversations" on public.conversations;
create policy "Users can read their conversations"
  on public.conversations for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their conversations" on public.conversations;
create policy "Users can create their conversations"
  on public.conversations for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their conversations" on public.conversations;
create policy "Users can update their conversations"
  on public.conversations for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their conversations" on public.conversations;
create policy "Users can delete their conversations"
  on public.conversations for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.conversations to authenticated;
