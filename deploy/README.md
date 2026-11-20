# NarrativeAI 3.1 — документация по запуску

Этот каталог содержит только документацию и скриншоты для основного репозитория приложения.

## Репозитории

- **Приложение:** https://github.com/MoroxArhont/NarrativeAI
- **Конфигурация публичного развёртывания:** https://github.com/MoroxArhont/NarrativeAI-deploy

Dockerfile приложения находится в корне основного репозитория. Nginx, Docker Compose и серверная TLS-конфигурация находятся в отдельном deploy-репозитории.

## Локальный запуск

Требуются Node.js 20+ (рекомендуется Node.js 22) и один Supabase-проект владельца приложения.

Из корня основного репозитория:

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Заполните `.env` значениями `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `APP_URL` и постоянным `APP_ENCRYPTION_KEY`.

Сгенерировать ключ шифрования (32 случайных байта в hex):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Не меняйте и не теряйте этот ключ после сохранения пользовательских API-токенов.

## Supabase и почта

Пользователям не требуется создавать собственный Supabase. Приложение использует единый проект владельца, а RLS изолирует пользовательские данные.

Для подтверждения почты настройте Supabase Dashboard → Authentication → URL Configuration: Site URL и Redirect URLs должны включать значение `APP_URL`.

## Пользовательские AI-токены

В настройках ИИ пользователь может указать собственный OpenAI-совместимый API token, Base URL и модель, а затем проверить соединение. Ключ шифруется AES-256-GCM на сервере и хранится отдельно для каждого аккаунта.

## Проверки

```bash
node --check server.js
node --check public/app.js
npm run format:check
npm run css:build
```

Публичное HTTPS-развёртывание, Nginx и TLS описаны в отдельном репозитории NarrativeAI-deploy.
