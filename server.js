require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const APP_URL = String(process.env.APP_URL || '').replace(/\/+$/, '');
if (!SUPABASE_URL || !SUPABASE_KEY)
  console.warn('ВНИМАНИЕ: задайте SUPABASE_URL и SUPABASE_PUBLISHABLE_KEY в .env');
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const clamp = (v, min, max, def) =>
  Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def;

function encryptionKey() {
  const value = String(process.env.APP_ENCRYPTION_KEY || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('Задайте APP_ENCRYPTION_KEY: 64 hex-символа (32 случайных байта).');
  }
  return Buffer.from(value, 'hex');
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}

function decryptSecret(value) {
  if (!value) return '';
  const [version, ivText, tagText, encryptedText] = String(value).split('.');
  if (version !== 'v1' || !ivText || !tagText || !encryptedText) {
    throw new Error('Неизвестный формат сохранённого API-ключа.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64')), decipher.final()]).toString('utf8');
}
function authHeaders(token) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${token || SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}
async function sbFetch(pathname, { method = 'GET', token, body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}${pathname}`, {
    method,
    headers: { ...authHeaders(token), ...(prefer ? { Prefer: prefer } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await r.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!r.ok) {
    const e = new Error(
      data?.msg ||
        data?.message ||
        data?.error_description ||
        data?.error ||
        `Supabase HTTP ${r.status}`,
    );
    e.status = r.status;
    e.details = data;
    throw e;
  }
  return data;
}
async function requireAuth(req, res, next) {
  try {
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Сначала войдите в аккаунт.' });
    const user = await sbFetch('/auth/v1/user', { token });
    req.accessToken = token;
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
  }
}
function sendDbError(res, e) {
  console.error('Supabase error:', e.details || e.message);
  res
    .status(e.status === 401 ? 401 : e.status === 403 ? 403 : 500)
    .json({ error: e.message || 'Ошибка Supabase.' });
}
async function uploadImage(req, bucket, dataUrl, oldPath) {
  if (!dataUrl) return null;
  const m = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('Неподдерживаемый формат изображения.');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1],
    bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Изображение должно быть меньше 2 МБ.');
  const filePath = `${req.user.id}/${crypto.randomUUID()}.${ext}`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${filePath}`, {
    method: 'POST',
    headers: {
      ...authHeaders(req.accessToken),
      'Content-Type': `image/${m[1]}`,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!r.ok)
    throw new Error(`Не удалось загрузить изображение в Storage: ${r.status} ${await r.text()}`);
  if (oldPath)
    await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${oldPath}`, {
      method: 'DELETE',
      headers: authHeaders(req.accessToken),
    }).catch(() => {});
  return filePath;
}
async function imageUrl(req, bucket, filePath, isPublic = false) {
  if (!filePath) return '';
  if (isPublic) return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${filePath}`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${filePath}`, {
    method: 'POST',
    headers: authHeaders(req.accessToken),
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  if (!r.ok) return '';
  const d = await r.json();
  return `${SUPABASE_URL}/storage/v1${d.signedURL}`;
}
const parseJSON = (v, fallback) => {
  try {
    return typeof v === 'string' ? JSON.parse(v || '') : (v ?? fallback);
  } catch {
    return fallback;
  }
};
const safeUser = (u, avatar = '') => ({
  id: u.id,
  name: u.display_name || u.user_metadata?.name || 'Пользователь',
  email: u.email || '',
  avatar_data: avatar,
});
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', app: 'Narrative AI', version: '3.1.0-supabase' }),
);
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim(),
      email = String(req.body.email || '')
        .trim()
        .toLowerCase(),
      password = String(req.body.password || '');
    if (name.length < 2 || name.length > 40)
      return res.status(400).json({ error: 'Имя должно содержать от 2 до 40 символов.' });
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120)
      return res.status(400).json({ error: 'Укажите корректную электронную почту.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Пароль должен содержать не менее 8 символов.' });
    const redirectUrl = APP_URL || `${req.protocol}://${req.get('host')}`;
    const data = await sbFetch(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectUrl)}`, {
      method: 'POST',
      body: { email, password, data: { name } },
    });
    if (!data.access_token)
      return res.status(202).json({
        confirmationRequired: true,
        message: 'Аккаунт создан. Подтвердите почту по ссылке из письма, затем войдите.',
      });
    const profile = await sbFetch(`/rest/v1/user_profiles?id=eq.${data.user.id}&select=*`, {
      token: data.access_token,
    });
    res.status(201).json({
      user: safeUser(
        { ...data.user, display_name: profile?.[0]?.display_name },
        await imageUrl(
          { accessToken: data.access_token, user: data.user },
          'avatars',
          profile?.[0]?.avatar_path,
          true,
        ),
      ),
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });
  } catch (e) {
    res
      .status(e.status === 422 ? 409 : 500)
      .json({ error: e.message || 'Не удалось создать аккаунт.' });
  }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const data = await sbFetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: {
        email: String(req.body.email || '')
          .trim()
          .toLowerCase(),
        password: String(req.body.password || ''),
      },
    });
    const p = await sbFetch(`/rest/v1/user_profiles?id=eq.${data.user.id}&select=*`, {
      token: data.access_token,
    });
    res.json({
      user: safeUser(
        { ...data.user, display_name: p?.[0]?.display_name },
        await imageUrl(
          { accessToken: data.access_token, user: data.user },
          'avatars',
          p?.[0]?.avatar_path,
          true,
        ),
      ),
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });
  } catch (e) {
    res.status(401).json({ error: 'Неверная почта или пароль.' });
  }
});
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const data = await sbFetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: String(req.body.refresh_token || '') },
    });
    res.json({ access_token: data.access_token, refresh_token: data.refresh_token });
  } catch (e) {
    res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
  }
});
app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const p = await sbFetch(`/rest/v1/user_profiles?id=eq.${req.user.id}&select=*`, {
      token: req.accessToken,
    });
    res.json({
      user: safeUser(
        { ...req.user, display_name: p?.[0]?.display_name },
        await imageUrl(req, 'avatars', p?.[0]?.avatar_path, true),
      ),
    });
  } catch (e) {
    sendDbError(res, e);
  }
});
app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (name.length < 2 || name.length > 40)
      return res.status(400).json({ error: 'Имя должно содержать от 2 до 40 символов.' });
    await sbFetch(`/rest/v1/user_profiles?id=eq.${req.user.id}`, {
      method: 'PATCH',
      token: req.accessToken,
      body: { display_name: name, updated_at: new Date().toISOString() },
    });
    res.json({
      user: safeUser({
        ...req.user,
        user_metadata: { ...req.user.user_metadata, name },
        display_name: name,
      }),
    });
  } catch (e) {
    sendDbError(res, e);
  }
});
app.put('/api/profile/avatar', requireAuth, async (req, res) => {
  try {
    const p = await sbFetch(`/rest/v1/user_profiles?id=eq.${req.user.id}&select=avatar_path`, {
      token: req.accessToken,
    });
    const path = await uploadImage(
      req,
      'avatars',
      String(req.body.image || ''),
      p?.[0]?.avatar_path,
    );
    await sbFetch(`/rest/v1/user_profiles?id=eq.${req.user.id}`, {
      method: 'PATCH',
      token: req.accessToken,
      body: { avatar_path: path, updated_at: new Date().toISOString() },
    });
    res.json({ ok: true, avatar_data: await imageUrl(req, 'avatars', path, true) });
  } catch (e) {
    sendDbError(res, e);
  }
});
async function normalizeStory(row, req) {
  if (!row) return row;
  return {
    ...row,
    cover_image: await imageUrl(req, 'story-assets', row.cover_path),
    chat_background: await imageUrl(req, 'story-assets', row.background_path),
    messages: parseJSON(row.messages, []),
    characters: parseJSON(row.characters, []),
    locations: parseJSON(row.locations, []),
    events: parseJSON(row.events, []),
    ai_settings: parseJSON(row.ai_settings, {}),
  };
}
app.get('/api/stories', requireAuth, async (req, res) => {
  try {
    const rows = await sbFetch(
      `/rest/v1/stories?select=id,title,genre,description,protagonist,cover_path,created_at,updated_at&order=updated_at.desc`,
      { token: req.accessToken },
    );
    const stories = await Promise.all(
      rows.map(async (x) => ({
        ...x,
        cover_image: await imageUrl(req, 'story-assets', x.cover_path),
      })),
    );
    res.json({ stories });
  } catch (e) {
    sendDbError(res, e);
  }
});
app.post('/api/stories', requireAuth, async (req, res) => {
  try {
    const b = req.body,
      title = String(b.title || '').trim();
    if (title.length < 2 || title.length > 100)
      return res.status(400).json({ error: 'Название должно содержать от 2 до 100 символов.' });
    const cover = await uploadImage(req, 'story-assets', b.cover_image),
      background = await uploadImage(req, 'story-assets', b.chat_background);
    const messages = String(b.opening_message || '').trim()
      ? [
          {
            role: 'assistant',
            content: String(b.opening_message).trim(),
            at: new Date().toISOString(),
            kind: 'opening',
          },
        ]
      : [];
    const row = await sbFetch('/rest/v1/stories?select=*', {
      method: 'POST',
      token: req.accessToken,
      prefer: 'return=representation',
      body: {
        user_id: req.user.id,
        title,
        genre: String(b.genre || 'Фэнтези').slice(0, 40),
        description: String(b.description || '').slice(0, 10000),
        protagonist: String(b.protagonist || '').slice(0, 200),
        protagonist_details: String(b.protagonist_details || '').slice(0, 8000),
        characters: b.characters || [],
        locations: b.locations || [],
        events: b.events || [],
        opening_message: String(b.opening_message || '').slice(0, 5000),
        messages,
        ai_settings: b.ai_settings || {},
        cover_path: cover,
        background_path: background,
      },
    });
    res.status(201).json({ story: await normalizeStory(row[0], req) });
  } catch (e) {
    sendDbError(res, e);
  }
});
app.get('/api/stories/:id', requireAuth, async (req, res) => {
  try {
    const rows = await sbFetch(
      `/rest/v1/stories?id=eq.${encodeURIComponent(req.params.id)}&select=*`,
      { token: req.accessToken },
    );
    if (!rows.length) return res.status(404).json({ error: 'История не найдена.' });
    res.json({ story: await normalizeStory(rows[0], req) });
  } catch (e) {
    sendDbError(res, e);
  }
});
app.put('/api/stories/:id', requireAuth, async (req, res) => {
  try {
    const rows = await sbFetch(
      `/rest/v1/stories?id=eq.${encodeURIComponent(req.params.id)}&select=*`,
      { token: req.accessToken },
    );
    if (!rows.length) return res.status(404).json({ error: 'История не найдена.' });
    const old = rows[0],
      b = req.body,
      title = String(b.title ?? old.title).trim();
    if (title.length < 2 || title.length > 100)
      return res.status(400).json({ error: 'Название должно содержать от 2 до 100 символов.' });
    const cover =
      b.cover_image !== undefined
        ? b.cover_image.startsWith('data:')
          ? await uploadImage(req, 'story-assets', b.cover_image, old.cover_path)
          : b.cover_image
            ? old.cover_path
            : null
        : old.cover_path;
    const background =
      b.chat_background !== undefined
        ? b.chat_background.startsWith('data:')
          ? await uploadImage(req, 'story-assets', b.chat_background, old.background_path)
          : b.chat_background
            ? old.background_path
            : null
        : old.background_path;
    const patch = {
      title,
      genre: String(b.genre ?? old.genre).slice(0, 40),
      description: String(b.description ?? old.description).slice(0, 10000),
      protagonist: String(b.protagonist ?? old.protagonist).slice(0, 200),
      protagonist_details: String(b.protagonist_details ?? old.protagonist_details).slice(0, 8000),
      characters: b.characters ?? old.characters,
      locations: b.locations ?? old.locations,
      events: b.events ?? old.events,
      opening_message: String(b.opening_message ?? old.opening_message).slice(0, 5000),
      ai_settings: b.ai_settings ?? old.ai_settings,
      cover_path: cover,
      background_path: background,
      updated_at: new Date().toISOString(),
    };
    const updated = await sbFetch(
      `/rest/v1/stories?id=eq.${encodeURIComponent(req.params.id)}&select=*`,
      { method: 'PATCH', token: req.accessToken, body: patch, prefer: 'return=representation' },
    );
    res.json({ story: await normalizeStory(updated[0], req) });
  } catch (e) {
    sendDbError(res, e);
  }
});
app.delete('/api/stories/:id', requireAuth, async (req, res) => {
  try {
    await sbFetch(`/rest/v1/stories?id=eq.${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
      token: req.accessToken,
    });
    res.json({ ok: true });
  } catch (e) {
    sendDbError(res, e);
  }
});

const DEFAULT_AI = {
  provider: 'ollama',
  base_url: 'http://127.0.0.1:11434/v1',
  model: '',
  director_enabled: 1,
  director_provider: 'ollama',
  director_base_url: 'http://127.0.0.1:11434/v1',
  director_model: 'qwen2.5:3b',
  context_length: 8192,
  max_tokens: 900,
  style: 'balanced',
  creativity: 0.75,
  response_length: 'medium',
  simple_actions: 1,
  adult_content: 0,
  random_events: 0,
  strict_canon: 1,
};
function publicAI(s) {
  const result = {
    ...DEFAULT_AI,
    ...s,
    director_model: s.director_model || 'qwen2.5:3b',
    director_enabled: Boolean(s.director_enabled),
    simple_actions: Boolean(s.simple_actions),
    adult_content: Boolean(s.adult_content),
    random_events: Boolean(s.random_events),
    strict_canon: Boolean(s.strict_canon),
  };
  delete result.api_key_ciphertext;
  delete result.director_api_key_ciphertext;
  return result;
}
app.get('/api/settings/ai', requireAuth, async (req, res) => {
  try {
    const rows = await sbFetch(`/rest/v1/user_settings?user_id=eq.${req.user.id}&select=*`, {
      token: req.accessToken,
    });
    const saved = rows[0] || DEFAULT_AI;
    res.json({
      settings: publicAI(saved),
      apiKeyConfigured: Boolean(saved.api_key_ciphertext || process.env.AI_API_KEY),
      directorApiKeyConfigured: Boolean(saved.director_api_key_ciphertext || saved.api_key_ciphertext || process.env.AI_API_KEY),
    });
  } catch (e) {
    sendDbError(res, e);
  }
});
app.put('/api/settings/ai', requireAuth, async (req, res) => {
  try {
    const b = req.body,
      provider = ['ollama', 'lmstudio', 'api'].includes(b.provider) ? b.provider : null,
      dprovider = ['ollama', 'lmstudio', 'api'].includes(b.director_provider || b.provider)
        ? b.director_provider || b.provider
        : null;
    const baseUrl = String(b.base_url ?? b.baseUrl ?? '')
        .trim()
        .replace(/\/$/, ''),
      dBase = String(b.director_base_url ?? b.directorBaseUrl ?? baseUrl)
        .trim()
        .replace(/\/$/, ''),
      model = String(b.model || '')
        .trim()
        .slice(0, 120),
      dModel = String(b.director_model || model)
        .trim()
        .slice(0, 120);
    const valid = (p, u) => {
      try {
        const x = new URL(u);
        return (
          ['http:', 'https:'].includes(x.protocol) &&
          (p !== 'api' || x.protocol === 'https:') &&
          (p === 'api' || ['localhost', '127.0.0.1', 'host.docker.internal'].includes(x.hostname))
        );
      } catch {
        return false;
      }
    };
    if (!provider || !dprovider || !model || !valid(provider, baseUrl) || !valid(dprovider, dBase))
      return res.status(400).json({ error: 'Проверьте провайдера и адреса серверов.' });
    const values = {
      user_id: req.user.id,
      provider,
      base_url: baseUrl,
      model,
      director_enabled: b.director_enabled !== false,
      director_provider: dprovider,
      director_base_url: dBase,
      director_model: dModel || model,
      context_length: clamp(b.context_length, 2048, 32768, 8192),
      max_tokens: clamp(b.max_tokens, 128, 8192, 900),
      style: ['balanced', 'creative', 'precise'].includes(b.style) ? b.style : 'balanced',
      creativity: clamp(b.creativity, 0, 1, 0.75),
      response_length: ['short', 'medium', 'long'].includes(b.response_length)
        ? b.response_length
        : 'medium',
      simple_actions: b.simple_actions !== false,
      adult_content: Boolean(b.adult_content),
      random_events: Boolean(b.random_events),
      strict_canon: b.strict_canon !== false,
      updated_at: new Date().toISOString(),
    };
    const apiKey = String(b.api_key || '').trim();
    const directorApiKey = String(b.director_api_key || '').trim();
    if (apiKey.length > 4096 || directorApiKey.length > 4096)
      return res.status(400).json({ error: 'API-токен слишком длинный.' });
    if ((apiKey || directorApiKey) && !/^[a-f0-9]{64}$/i.test(String(process.env.APP_ENCRYPTION_KEY || '').trim()))
      return res.status(503).json({ error: 'На сервере не настроен APP_ENCRYPTION_KEY. Обратитесь к администратору приложения.' });
    if (b.api_key_clear) values.api_key_ciphertext = null;
    else if (apiKey) values.api_key_ciphertext = encryptSecret(apiKey);
    if (b.director_api_key_clear) values.director_api_key_ciphertext = null;
    else if (directorApiKey) values.director_api_key_ciphertext = encryptSecret(directorApiKey);
    const rows = await sbFetch('/rest/v1/user_settings?on_conflict=user_id&select=*', {
      method: 'POST',
      token: req.accessToken,
      body: values,
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    res.json({ ok: true, settings: publicAI(rows[0]), apiKeyConfigured: Boolean(rows[0]?.api_key_ciphertext || process.env.AI_API_KEY), directorApiKeyConfigured: Boolean(rows[0]?.director_api_key_ciphertext || rows[0]?.api_key_ciphertext || process.env.AI_API_KEY) });
  } catch (e) {
    sendDbError(res, e);
  }
});

function getEndpoint(base, provider) {
  const clean = String(base).replace(/\/+$/, '');
  if (provider === 'ollama') return clean.replace(/\/v1$/, '') + '/api/chat';
  return clean.replace(/\/$/, '') + '/chat/completions';
}
async function callModel(config, messages, params) {
  const endpoint = getEndpoint(config.base_url, config.provider),
    controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), Number(process.env.AI_TIMEOUT_MS || 240000));
  try {
    const isOllama = config.provider === 'ollama';
    const body = isOllama
      ? {
          model: config.model,
          messages,
          stream: false,
          options: {
            num_ctx: params.context_length,
            num_predict: params.max_tokens,
            temperature: params.temperature,
            top_p: params.top_p,
            repeat_penalty: params.repeat_penalty,
          },
        }
      : {
          model: config.model,
          messages,
          temperature: params.temperature,
          top_p: params.top_p,
          max_tokens: params.max_tokens,
          presence_penalty: params.presence_penalty,
          frequency_penalty: params.frequency_penalty,
        };
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = config.api_key || process.env.AI_API_KEY;
    if (config.provider === 'api' && apiKey)
      headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 700);
      throw new Error(`Модель (${config.model}) вернула HTTP ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    const content = isOllama ? payload.message?.content : payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim())
      throw new Error(
        `Модель ${config.model} вернула пустой текст. Проверьте модель и лимит ответа.`,
      );
    return content.trim();
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/settings/ai/test', requireAuth, aiLimiter, async (req, res) => {
  try {
    const rows = await sbFetch(`/rest/v1/user_settings?user_id=eq.${req.user.id}&select=*`, {
      token: req.accessToken,
    });
    const saved = rows[0] || {};
    const provider = ['ollama', 'lmstudio', 'api'].includes(req.body.provider) ? req.body.provider : null;
    const base_url = String(req.body.base_url || '').trim().replace(/\/+$/, '');
    const model = String(req.body.model || '').trim().slice(0, 120);
    let parsed;
    try { parsed = new URL(base_url); } catch { parsed = null; }
    const validUrl = parsed && ['http:', 'https:'].includes(parsed.protocol) &&
      (provider !== 'api' || parsed.protocol === 'https:') &&
      (provider === 'api' || ['localhost', '127.0.0.1', 'host.docker.internal'].includes(parsed.hostname));
    if (!provider || !model || !validUrl) {
      return res.status(400).json({ error: 'Проверьте провайдера, модель и адрес API.' });
    }
    const apiKey = String(req.body.api_key || '').trim() || decryptSecret(saved.api_key_ciphertext) || process.env.AI_API_KEY || '';
    if (apiKey.length > 4096) return res.status(400).json({ error: 'API-токен слишком длинный.' });
    if (provider === 'api' && !apiKey) {
      return res.status(400).json({ error: 'Добавьте API-токен в настройках ИИ.' });
    }
    const reply = await callModel(
      { provider, base_url, model, api_key: apiKey },
      [{ role: 'user', content: 'Ответь коротко: соединение установлено.' }],
      { context_length: 2048, max_tokens: 48, temperature: 0.1, top_p: 0.9, repeat_penalty: 1.1, presence_penalty: 0, frequency_penalty: 0 },
    );
    res.json({ ok: true, model, reply });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Не удалось проверить соединение с моделью.' });
  }
});

const STYLE_RULES = {
  balanced:
    'Стиль: естественная художественная проза, ясные описания, живые диалоги, умеренная детализация. Не перегружай текст метафорами.',
  creative:
    'Стиль: выразительная, образная, литературная проза. Используй оригинальные детали только если они логично следуют из мира и сцены. Не подменяй оригинальность туманной загадочностью.',
  precise:
    'Стиль: сдержанная, конкретная проза. Короткие точные описания, естественные диалоги, минимум метафор и минимум декоративных отступлений.',
};
function storyFacts(story) {
  return `НАЗВАНИЕ: ${story.title}\nЖАНР: ${story.genre}\nОПИСАНИЕ МИРА И ЗАВЯЗКА:\n${story.description || 'Не заданы.'}\nГЛАВНЫЙ ГЕРОЙ: ${story.protagonist || 'Имя не задано.'}\nХАРАКТЕРИСТИКИ ГЕРОЯ:\n${story.protagonist_details || 'Не заданы.'}\nПЕРСОНАЖИ:\n${JSON.stringify(story.characters, null, 2)}\nЛОКАЦИИ:\n${JSON.stringify(story.locations, null, 2)}\nСОБЫТИЯ И ФАКТЫ КАНОНА:\n${JSON.stringify(story.events, null, 2)}`;
}
function shouldRunDirector(messages, currentText) {
  const userTurns = messages.filter((message) => message.role === 'user').length;
  const riskPattern = /(впервые|внезапно|оказалось|на самом деле|раньше|вчера|завтра|прошл|воспомин|узнал|узнала|тайн|секрет|перемест|телепорт|вернул|появил|исчез|убил|умер|ранен|спустя|до этого|после этого|сменил|новый персонаж|смена сцены|переход в|через (?:час|день|недел|месяц|год)|противореч|несоответ|неправиль|ошиб|ты путаешь|не так|не было|никогда|вместо)/i;
  return userTurns === 0 || userTurns % 6 === 0 || riskPattern.test(currentText);
}

app.post('/api/stories/:id/chat', requireAuth, aiLimiter, async (req, res) => {
  try {
    const storyRows = await sbFetch(
      `/rest/v1/stories?id=eq.${encodeURIComponent(req.params.id)}&select=*`,
      { token: req.accessToken },
    );
    if (!storyRows.length) return res.status(404).json({ error: 'История не найдена.' });
    const story = await normalizeStory(storyRows[0], req);
    const text = String(req.body.message || '').trim();
    if (!text || text.length > 3000)
      return res.status(400).json({ error: 'Сообщение должно содержать от 1 до 3000 символов.' });
    const settingsRows = await sbFetch(
      `/rest/v1/user_settings?user_id=eq.${req.user.id}&select=*`,
      { token: req.accessToken },
    );
    const userSettings = settingsRows[0];
    if (!userSettings?.model)
      return res
        .status(400)
        .json({ error: 'Сначала настройте модель Повествователя в разделе «Настройки ИИ».' });
    const narratorApiKey = decryptSecret(userSettings.api_key_ciphertext) || process.env.AI_API_KEY || '';
    const directorApiKey = decryptSecret(userSettings.director_api_key_ciphertext) || narratorApiKey;
    const settings = { ...publicAI(userSettings), ...(story.ai_settings || {}) };
    if (settings.provider === 'api' && !narratorApiKey)
      return res.status(400).json({ error: 'Добавьте API-токен повествователя в настройках ИИ.' });
    const messages = story.messages || [],
      history = messages.slice(-24).map((m) => ({ role: m.role, content: m.content }));
    const style = STYLE_RULES[settings.style] || STYLE_RULES.balanced;
    const responseTokens =
      settings.response_length === 'short'
        ? 350
        : settings.response_length === 'long'
          ? 1800
          : settings.max_tokens;
    const params = {
      context_length: clamp(settings.context_length, 2048, 32768, 8192),
      max_tokens: clamp(responseTokens, 128, 8192, 900),
      temperature: clamp(settings.creativity, 0, 1, 0.75),
      top_p: 0.9,
      repeat_penalty: 1.12,
      presence_penalty: 0.15,
      frequency_penalty: 0.2,
    };
    let directorBrief = settings.director_enabled
      ? 'Проверка режиссёра в этом ходе пропущена для экономии токенов. Самостоятельно соблюдай канон и непротиворечивость.'
      : 'Режиссёр отключён пользователем. Следуй напрямую заданному канону и фактам.';
    const directorUsed = Boolean(settings.director_enabled && shouldRunDirector(messages, text));
    if (directorUsed) {
      const directorConfig = {
        provider: settings.director_provider || settings.provider,
        base_url: settings.director_base_url || settings.base_url,
        model: settings.director_model || settings.model,
        api_key: directorApiKey,
      };
      if (directorConfig.provider === 'api' && !directorConfig.api_key)
        throw new Error('Добавьте API-токен режиссёра в настройках ИИ.');
      const canonRules = settings.strict_canon
        ? 'Считай описание мира и список фактов единственным источником канона. Не добавляй исторические эпохи, организации, технологии, географию, мистику или лор без основания. Не превращай неизвестное в тайну и не выдумывай загадочные земли, пророчества и силы.'
        : 'Соблюдай уже установленные факты. Допускай новые детали только если они правдоподобно вытекают из сцены и не противоречат описанию мира.';
      const directorPrompt = `Ты — РЕЖИССЁР-КОРРЕКТОР интерактивной истории. Сейчас нужна проверка непрерывности и канона, а не очередная генерация плана. Не переписывай сцену и не придумывай новые события.\n\n${storyFacts(story)}\n\nПРАВИЛА:\n- ${canonRules}\n- Не управляй главным героем и не придумывай его мысли, реплики или решения.\n- Проверяй только факты, которые действительно противоречат заданному миру или предыдущим репликам. Не называй противоречием отсутствие подробностей.\n- Если противоречий нет, верни ровно: ПРОТИВОРЕЧИЙ НЕТ.\n- Если есть несоответствие, укажи его кратко и предложи минимальную правку для следующего ответа, не переписывая прошлые сообщения.\n\nПОСЛЕДНИЕ 6 СООБЩЕНИЙ:\n${history.slice(-6).map((m) => `${m.role}: ${m.content}`).join('\n')}\n\nНОВОЕ ДЕЙСТВИЕ ИГРОКА:\n${text}\n\nОтвет — максимум 120 слов, только проверка и необходимые корректировки.`;
      directorBrief = await callModel(
        directorConfig,
        [
          {
            role: 'system',
            content:
              'Ты аналитический режиссёр интерактивной истории. Возвращай только план, без художественной прозы.',
          },
          { role: 'user', content: directorPrompt },
        ],
        { ...params, max_tokens: 500, temperature: 0.2 },
      );
    }
    const canonNarratorRule = settings.strict_canon
      ? 'Не выдумывай лор ради атмосферы. Не вводи внезапные тайны, древние земли, пророчества, неизвестные силы, загадочные артефакты, организации или исторические события, если их нет в исходных данных или они не вытекают из сцены.'
      : 'Соблюдай установленные факты. Новые детали допустимы, если они естественно следуют из сцены и не противоречат уже заданному миру.';
    const narratorPrompt = `Ты — ПОВЕСТВОВАТЕЛЬ интерактивной ролевой истории. Пиши на русском языке.\n\n${storyFacts(story)}\n\n${style}\n\nПРАВИЛА ПОВЕСТВОВАНИЯ — ОБЯЗАТЕЛЬНЫЕ:\n- ${canonNarratorRule}\n- Запрещён приём искусственной загадочности: многоточия через каждое предложение, «нечто древнее», «что-то не так», «тайна, которую никто не мог объяснить», туманные намёки и пафосные недосказанности. Если персонаж знает факт — пусть говорит прямо. Если не знает — пусть честно скажет, что не знает.\n- Не добавляй в знакомые вселенные несуществующие элементы канона. Не приписывай персонажам предметы одежды, устройства, способности и привычки, которых нет в заданном каноне. При сомнении используй только то, что точно известно из контекста, либо не уточняй деталь.\n- Не повторяй одну и ту же мысль разными словами. Избегай шаблонных фраз, пафосных вступлений и искусственных cliffhanger-ов.\n- Не управляй героем игрока: не описывай его новые действия, реплики, мысли, чувства и решения. Описывай окружающий мир и других персонажей, затем оставляй пространство для ответа игрока.\n- Сохраняй характеры NPC, географию, временную линию и уже установленные факты. Не меняй внезапно имена, возраст, внешность, отношения и обстоятельства.\n- Диалоги должны звучать естественно и соответствовать ситуации. Не заставляй каждого персонажа говорить загадками.\n- Развивай именно текущую сцену. Не перескакивай на новые сюжетные арки без причины.\n- ${settings.simple_actions ? 'Предпочитай естественные и понятные действия персонажей без искусственной драматизации.' : 'Допускай более сложные действия, если они логичны для сцены.'}\n- ${settings.random_events ? 'Допускаются небольшие случайные события, но только правдоподобные и не меняющие канон.' : 'Не вводи случайные события без причины.'}\n- ${settings.adult_content ? 'Допускается взрослый тон в рамках закона и правил платформы.' : 'Избегай откровенного взрослого контента.'}\n\nПЛАН РЕЖИССЁРА (соблюдай, но не показывай пользователю):\n${directorBrief}\n\nПиши продолжение сцены. Обычно 2–5 абзацев, если ситуация не требует другого объёма. Не пересказывай действие игрока в начале ответа.`;
    const answer = await callModel(
      { provider: settings.provider, base_url: settings.base_url, model: settings.model, api_key: narratorApiKey },
      [{ role: 'system', content: narratorPrompt }, ...history, { role: 'user', content: text }],
      params,
    );
    const updated = [
      ...messages,
      { role: 'user', content: text, at: new Date().toISOString() },
      { role: 'assistant', content: answer, at: new Date().toISOString() },
    ].slice(-100);
    await sbFetch(`/rest/v1/stories?id=eq.${encodeURIComponent(story.id)}`, {
      method: 'PATCH',
      token: req.accessToken,
      body: { messages: updated, updated_at: new Date().toISOString() },
      prefer: 'return=minimal',
    });
    res.json({ answer, messages: updated, director_used: directorUsed });
  } catch (error) {
    console.error('AI request failed:', error);
    const msg =
      error.name === 'AbortError'
        ? 'Превышено время ожидания ответа модели. Уменьшите контекст или выберите более лёгкую модель.'
        : error.message || 'Не удалось связаться с ИИ.';
    res.status(502).json({ error: msg });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Narrative AI запущен: http://localhost:${PORT}`));
