alter table public.conversations
  drop constraint if exists conversations_provider_check;

alter table public.conversations
  add constraint conversations_provider_check
  check (provider in ('openrouter', 'edenai'));
