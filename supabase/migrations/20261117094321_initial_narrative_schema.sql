-- NarrativeAI initial Supabase schema
-- Applied to project zmtwidszfjzwuqjbeurr on 2026-11-17.
create schema if not exists private;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Пользователь' check (char_length(display_name) between 1 and 40),
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 100),
  genre text not null default 'Фэнтези',
  description text not null default '',
  protagonist text not null default '',
  protagonist_details text not null default '',
  characters jsonb not null default '[]'::jsonb,
  locations jsonb not null default '[]'::jsonb,
  events jsonb not null default '[]'::jsonb,
  opening_message text not null default '',
  messages jsonb not null default '[]'::jsonb,
  ai_settings jsonb not null default '{}'::jsonb,
  cover_path text,
  background_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stories_user_updated_idx on public.stories (user_id, updated_at desc);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null default 'ollama' check (provider in ('ollama','lmstudio','api')),
  base_url text not null default 'http://127.0.0.1:11434/v1',
  model text not null default '',
  director_enabled boolean not null default true,
  director_provider text not null default 'ollama' check (director_provider in ('ollama','lmstudio','api')),
  director_base_url text not null default 'http://127.0.0.1:11434/v1',
  director_model text not null default 'qwen2.5:3b',
  context_length integer not null default 8192 check (context_length between 2048 and 32768),
  max_tokens integer not null default 900 check (max_tokens between 128 and 8192),
  style text not null default 'balanced' check (style in ('balanced','creative','precise')),
  creativity numeric(3,2) not null default 0.75 check (creativity between 0 and 1),
  response_length text not null default 'medium' check (response_length in ('short','medium','long')),
  simple_actions boolean not null default true,
  adult_content boolean not null default false,
  random_events boolean not null default false,
  strict_canon boolean not null default true,
  updated_at timestamptz not null default now()
);

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_profiles (id, display_name)
  values (new.id, coalesce(nullif(left(trim(new.raw_user_meta_data ->> 'name'), 40), ''), 'Пользователь'))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created_narrative on auth.users;
create trigger on_auth_user_created_narrative after insert on auth.users for each row execute procedure private.handle_new_user();

alter table public.user_profiles enable row level security;
alter table public.stories enable row level security;
alter table public.user_settings enable row level security;
grant select, insert, update on public.user_profiles to authenticated;
grant select, insert, update, delete on public.stories to authenticated;
grant select, insert, update on public.user_settings to authenticated;

create policy "Users can read own profile" on public.user_profiles for select to authenticated using ((select auth.uid()) = id);
create policy "Users can create own profile" on public.user_profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy "Users can update own profile" on public.user_profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "Users can read own stories" on public.stories for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create own stories" on public.stories for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own stories" on public.stories for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete own stories" on public.stories for delete to authenticated using ((select auth.uid()) = user_id);
create policy "Users can read own settings" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create own settings" on public.user_settings for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own settings" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars','avatars',true,2097152,array['image/png','image/jpeg','image/webp']),
       ('story-assets','story-assets',false,5242880,array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public=excluded.public,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create policy "Users can upload own avatar files" on storage.objects for insert to authenticated with check (bucket_id='avatars' and (storage.foldername(name))[1]=(select auth.uid()::text));
create policy "Users can update own avatar files" on storage.objects for update to authenticated using (bucket_id='avatars' and (storage.foldername(name))[1]=(select auth.uid()::text)) with check (bucket_id='avatars' and (storage.foldername(name))[1]=(select auth.uid()::text));
create policy "Users can delete own avatar files" on storage.objects for delete to authenticated using (bucket_id='avatars' and (storage.foldername(name))[1]=(select auth.uid()::text));
create policy "Users can upload own story assets" on storage.objects for insert to authenticated with check (bucket_id='story-assets' and (storage.foldername(name))[1]=(select auth.uid()::text));
create policy "Users can read own story assets" on storage.objects for select to authenticated using (bucket_id='story-assets' and (storage.foldername(name))[1]=(select auth.uid()::text));
create policy "Users can update own story assets" on storage.objects for update to authenticated using (bucket_id='story-assets' and (storage.foldername(name))[1]=(select auth.uid()::text)) with check (bucket_id='story-assets' and (storage.foldername(name))[1]=(select auth.uid()::text));
create policy "Users can delete own story assets" on storage.objects for delete to authenticated using (bucket_id='story-assets' and (storage.foldername(name))[1]=(select auth.uid()::text));
