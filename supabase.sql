-- Shiro Synthesis Two / Bolita Cubana
-- Ejecuta este archivo completo en Supabase -> SQL Editor -> New query.
-- El bot utiliza SUPABASE_SERVICE_ROLE_KEY exclusivamente desde el servidor.
-- NO pongas la service role key en HTML, aplicaciones cliente ni repositorios públicos.

create table if not exists public.bot_messages (
  id bigserial primary key,
  chat_jid text not null,
  message_id text not null,
  participant_jid text,
  sender_name text,
  body text not null default '',
  is_from_bot boolean not null default false,
  source_message_id text,
  created_at timestamptz not null default now(),
  constraint bot_messages_chat_message_unique unique (chat_jid, message_id)
);

create index if not exists bot_messages_chat_created_idx
  on public.bot_messages (chat_jid, created_at desc);

create index if not exists bot_messages_chat_participant_created_idx
  on public.bot_messages (chat_jid, participant_jid, created_at desc)
  where is_from_bot = false;

create table if not exists public.bot_replies (
  id bigserial primary key,
  chat_jid text not null,
  source_message_id text not null,
  reply_message_id text,
  reply_text text not null default '',
  created_at timestamptz not null default now(),
  constraint bot_replies_chat_source_unique unique (chat_jid, source_message_id)
);

create index if not exists bot_replies_chat_created_idx
  on public.bot_replies (chat_jid, created_at desc);

create table if not exists public.chat_summaries (
  chat_jid text primary key,
  summary text not null default '',
  last_summarized_message_id text,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_profiles (
  user_jid text primary key,
  display_name text,
  tone_preference text,
  notes text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.user_sessions (
  id bigserial primary key,
  chat_jid text not null,
  user_jid text not null,
  pending_suggestion boolean not null default false,
  pending_suggestion_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint user_sessions_chat_user_unique unique (chat_jid, user_jid)
);

create table if not exists public.suggestions (
  id bigserial primary key,
  chat_jid text not null,
  user_jid text not null,
  user_name text,
  suggestion_text text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists suggestions_status_created_idx
  on public.suggestions (status, created_at asc);

create index if not exists suggestions_user_created_idx
  on public.suggestions (user_jid, created_at desc);

create table if not exists public.user_warnings (
  id bigserial primary key,
  group_jid text not null,
  user_jid text not null,
  warning_count integer not null default 0 check (warning_count >= 0),
  last_warning_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint user_warnings_group_user_unique unique (group_jid, user_jid)
);

create index if not exists user_warnings_group_count_idx
  on public.user_warnings (group_jid, warning_count desc);

create table if not exists public.bot_kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Incremento atómico: evita que dos mensajes simultáneos pierdan advertencias.
create or replace function public.increment_user_warning(
  p_group_jid text,
  p_user_jid text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  result_count integer;
begin
  insert into public.user_warnings (group_jid, user_jid, warning_count, last_warning_at)
  values (p_group_jid, p_user_jid, 1, now())
  on conflict (group_jid, user_jid)
  do update set
    warning_count = public.user_warnings.warning_count + 1,
    last_warning_at = now()
  returning warning_count into result_count;

  return result_count;
end;
$$;

-- El bot llama a esta función mediante la service role key desde el servidor.
revoke all on function public.increment_user_warning(text, text) from public;
grant execute on function public.increment_user_warning(text, text) to service_role;

-- Seguridad: las tablas no deben ser accesibles directamente desde clientes públicos.
-- La service role key del servidor puede operar pese a RLS.
alter table public.bot_messages enable row level security;
alter table public.bot_replies enable row level security;
alter table public.chat_summaries enable row level security;
alter table public.user_profiles enable row level security;
alter table public.user_sessions enable row level security;
alter table public.suggestions enable row level security;
alter table public.user_warnings enable row level security;
alter table public.bot_kv enable row level security;

-- No se crean políticas anon/authenticated intencionalmente.
-- El bot opera desde Node.js con SUPABASE_SERVICE_ROLE_KEY y nunca desde el navegador.
