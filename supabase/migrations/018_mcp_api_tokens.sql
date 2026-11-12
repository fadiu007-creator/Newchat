create table if not exists public.mcp_api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique check (length(token_hash) = 64),
  label text not null default 'Personal MCP connection',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists mcp_api_tokens_user_active_idx
  on public.mcp_api_tokens(user_id, created_at desc) where revoked_at is null;
alter table public.mcp_api_tokens enable row level security;
revoke all on public.mcp_api_tokens from anon, authenticated;
grant all on public.mcp_api_tokens to service_role;
