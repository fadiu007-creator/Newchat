-- Register user-verified free Eden AI routes for autonomous execution.
-- These models were verified through the Newchat UI as FREE and successfully returned chat responses.
insert into public.model_registry
  (provider, model_id, display_name, capabilities, is_free, enabled, priority, metadata)
values
  ('edenai','google/gemma-4-31b-it','Gemma 4 31B',array['general','analysis','coding','writing'],true,true,1,'{"verified_in_newchat_chat":true}'::jsonb),
  ('edenai','google/gemma-4-26b-a4b-it','Gemma 4 26B A4B',array['general','analysis','coding','writing'],true,true,2,'{"verified_in_newchat_chat":true}'::jsonb),
  ('edenai','together_ai/Prism-ML/Ternary-Bonsai-27B','Ternary Bonsai 27B',array['general','analysis','coding','writing'],true,true,3,'{"verified_in_newchat_chat":true}'::jsonb),
  ('edenai','cloudflare/@cf/mistral/mistral-7b-instruct-v0.2-lora','Mistral 7B Instruct',array['general','writing'],true,true,10,'{"verified_in_newchat_chat":true}'::jsonb),
  ('edenai','cloudflare/@cf/google/gemma-7b-it-lora','Gemma 7B IT',array['general','writing'],true,true,11,'{"verified_in_newchat_chat":true}'::jsonb),
  ('edenai','cloudflare/@cf/google/gemma-2b-it-lora','Gemma 2B IT',array['general','writing'],true,true,12,'{"verified_in_newchat_chat":true}'::jsonb)
on conflict (provider, model_id) do update
set display_name=excluded.display_name,
    capabilities=excluded.capabilities,
    is_free=true,
    enabled=true,
    priority=excluded.priority,
    metadata=public.model_registry.metadata || excluded.metadata,
    updated_at=now();
