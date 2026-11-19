# NarrativeAI 3.0 — запуск и развёртывание

## Требования

- Node.js 20 или новее (рекомендуется Node.js 22 LTS)
- npm
- Проект Supabase с применённой миграцией
- Для генерации: Ollama/LM Studio или OpenAI-совместимый API

## Локальный запуск

Из корня проекта:

```powershell
Copy-Item .env.example .env
npm install
```

Откройте `.env` и укажите `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` и, если выбран внешний API, `AI_API_KEY`. Не публикуйте `.env` и не помещайте секретный ключ модели в клиентский JavaScript.

```powershell
npm start
```

Откройте http://localhost:3000.

## Supabase

- Dashboard: https://supabase.com/dashboard/project/zmtwidszfjzwuqjbeurr
- Project URL: `https://zmtwidszfjzwuqjbeurr.supabase.co`
- Миграция: `supabase/migrations/20261117094321_initial_narrative_schema.sql`
- Используются Supabase Auth, PostgreSQL, RLS и Storage buckets `avatars` и `story-assets`.
- Для регистрации включите Email/Password в Authentication → Providers → Email.
- Если включено подтверждение почты, пользователь должен подтвердить адрес по письму перед первым входом.
- Приложению нужен только publishable key. `sb_secret_...`, `service_role` и пароль БД не нужны.

## Docker

Из корня проекта:

```bash
docker compose -f deploy/docker-compose.yml up --build -d
```

Остановка:

```bash
docker compose -f deploy/docker-compose.yml down
```

Перед запуском убедитесь, что `.env` находится в корне проекта.

## API внешней модели

В разделе «Настройки ИИ» выберите «Внешний API», укажите OpenAI-совместимый Base URL и модель. Сервер добавляет `/chat/completions`. Токен хранится только в `.env`:

```env
AI_API_KEY=ваш_токен
```

После изменения `.env` перезапустите сервер.

## Проверка

- `GET /api/health` — сервер отвечает.
- Зарегистрируйте тестовый аккаунт и войдите.
- Создайте историю, обновите её, откройте чат и отправьте сообщение.
- Загрузите аватар, обложку и фон — проверьте, что они отображаются после повторного входа.
- Создайте второй тестовый аккаунт и убедитесь, что его истории не видны первому аккаунту (проверка RLS).

## Перенос старых данных

Новая версия больше не использует SQLite. Существующие локальные записи из `data/narrative.sqlite` автоматически не импортируются. Сохраните резервную копию старой базы, если в ней есть нужные аккаунты или истории; перенос данных нужно выполнять отдельно, потому что локальные пароли SQLite несовместимы с паролями Supabase Auth.
