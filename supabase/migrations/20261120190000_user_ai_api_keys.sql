-- NarrativeAI v3.1: encrypted per-user model credentials.
-- API keys are encrypted by the application with APP_ENCRYPTION_KEY before storage.
alter table public.user_settings
  add column if not exists api_key_ciphertext text,
  add column if not exists director_api_key_ciphertext text;

comment on column public.user_settings.api_key_ciphertext is
  'AES-256-GCM encrypted API token for the user narration model. Never expose to clients.';
comment on column public.user_settings.director_api_key_ciphertext is
  'AES-256-GCM encrypted API token for the user director model. Never expose to clients.';
