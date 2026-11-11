-- Ask FPX chat history (applied 2026-11-11 as assistant_chat_history).
create table if not exists public.fpx_assistant_chats (id uuid primary key, user_email text not null, title text not null, turns jsonb not null default '[]'::jsonb, history jsonb not null default '[]'::jsonb, turn_count int not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists fpx_assistant_chats_user_idx on public.fpx_assistant_chats (user_email, updated_at desc);
alter table public.fpx_assistant_chats enable row level security;
revoke all on public.fpx_assistant_chats from anon, authenticated;
