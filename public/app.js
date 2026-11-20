const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  authMode: 'login',
  page: 'home',
  stories: [],
  currentStory: null,
  ai: null,
  apiKeyConfigured: false,
  directorApiKeyConfigured: false,
  editingStory: null,
  editorTab: 'basic',
};
const pageNames = {
  home: 'Главная',
  catalog: 'Каталог историй',
  stories: 'Мои истории',
  profile: 'Профиль пользователя',
  settings: 'Настройки ИИ',
  create: 'Редактор истории',
  play: 'Интерактивная история',
  storyProfile: 'Профиль истории',
};
async function api(url, options = {}, retry = true) {
  const token = localStorage.getItem('narrative_access_token');
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (
    response.status === 401 &&
    retry &&
    !['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/logout'].includes(
      url,
    )
  ) {
    const refresh = localStorage.getItem('narrative_refresh_token');
    if (refresh) {
      const rr = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (rr.ok) {
        const session = await rr.json();
        localStorage.setItem('narrative_access_token', session.access_token);
        localStorage.setItem('narrative_refresh_token', session.refresh_token);
        return api(url, options, false);
      }
    }
    localStorage.removeItem('narrative_access_token');
    localStorage.removeItem('narrative_refresh_token');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка запроса (${response.status})`);
  return data;
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  setTimeout(() => $('toast').classList.add('hidden'), 3500);
}
function esc(value = '') {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
function avatarMarkup(user, size = 42) {
  return user?.avatar_data
    ? `<img class="avatar-img" style="width:${size}px;height:${size}px" src="${user.avatar_data}" alt="Аватар">`
    : `<div class="avatar" style="width:${size}px;height:${size}px">${esc((user?.name || 'N')[0].toUpperCase())}</div>`;
}
function setAuthMode(mode) {
  state.authMode = mode;
  const reg = mode === 'register';
  $('login-tab').classList.toggle('active', !reg);
  $('register-tab').classList.toggle('active', reg);
  $('name-wrap').classList.toggle('hidden', !reg);
  $('name').required = reg;
  $('auth-title').textContent = reg ? 'Создание аккаунта' : 'Добро пожаловать';
  $('auth-submit').textContent = reg ? 'Зарегистрироваться' : 'Войти';
  $('password').autocomplete = reg ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
}
$('login-tab').onclick = () => setAuthMode('login');
$('register-tab').onclick = () => setAuthMode('register');
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const payload = { email: $('email').value.trim(), password: $('password').value };
    if (state.authMode === 'register') payload.name = $('name').value.trim();
    const r = await api(`/api/auth/${state.authMode === 'register' ? 'register' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (r.confirmationRequired) {
      $('auth-error').textContent = r.message;
      return;
    }
    if (r.access_token) localStorage.setItem('narrative_access_token', r.access_token);
    if (r.refresh_token) localStorage.setItem('narrative_refresh_token', r.refresh_token);
    enterApp(r.user);
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    $('auth-submit').disabled = false;
  }
});
function enterApp(user) {
  state.user = user;
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  $('side-name').textContent = user.name;
  $('side-email').textContent = user.email;
  $('side-avatar-wrap').innerHTML = avatarMarkup(user, 36);
  $('top-avatar-wrap').innerHTML = avatarMarkup(user, 38);
  navigate('home');
}
async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch {}
  localStorage.removeItem('narrative_access_token');
  localStorage.removeItem('narrative_refresh_token');
  state.user = null;
  $('app-screen').classList.add('hidden');
  $('auth-screen').classList.remove('hidden');
  $('password').value = '';
  setAuthMode('login');
}
$('logout-btn').onclick = logout;
$('chat-back').onclick = () => navigate('stories');
document
  .querySelectorAll('[data-page]')
  .forEach((b) => b.addEventListener('click', () => navigate(b.dataset.page)));
$('create-nav').onclick = () => openEditor(null);
async function loadStories() {
  const r = await api('/api/stories');
  state.stories = r.stories;
  return state.stories;
}
async function navigate(page) {
  state.page = page;
  $('app-screen').classList.toggle('chat-mode', page === 'play');
  state.currentStory = null;
  $('top-title').textContent = pageNames[page] || 'Narrative AI';
  document
    .querySelectorAll('[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  try {
    if (['home', 'catalog', 'stories'].includes(page)) await loadStories();
    if (page === 'settings') {
      const r = await api('/api/settings/ai');
      state.ai = r.settings;
      state.apiKeyConfigured = Boolean(r.apiKeyConfigured);
      state.directorApiKeyConfigured = Boolean(r.directorApiKeyConfigured);
    }
    renderPage();
  } catch (e) {
    toast(e.message);
  }
}
function storyCard(s) {
  return `<article class="story-card" data-open-story="${s.id}">${s.cover_image ? `<img class="story-cover-thumb" src="${s.cover_image}" alt="">` : '<div class="story-cover-placeholder"><i class="fa-solid fa-book-open"></i></div>'}<span class="pill">${esc(s.genre)}</span><h4>${esc(s.title)}</h4><p>${esc(s.description || 'У этой истории пока нет описания.')}</p><div class="muted" style="font-size:10px;margin-top:14px">Открыть историю →</div></article>`;
}
function renderPage() {
  const root = $('page-content');
  if (state.page === 'home')
    root.innerHTML = `<section class="hero"><span class="eyebrow">Погружайтесь в приключения</span><h1>Проживайте истории, которые сочиняет ИИ вместе с вами</h1><p>Создавайте собственные миры, задавайте характеры персонажей и управляйте повествованием с помощью двух ИИ.</p><div class="actions"><button class="btn btn-primary" id="hero-create"><i class="fa-solid fa-plus"></i> Создать историю</button><button class="btn btn-secondary" id="hero-catalog">Каталог историй</button></div></section><div class="section-head"><h3>Ваши последние истории</h3><button class="btn btn-secondary" id="all-stories">Все истории</button></div><div class="grid">${state.stories.slice(0, 3).map(storyCard).join('') || '<div class="empty" style="grid-column:1/-1">Здесь пока пусто. Создайте первую историю.</div>'}</div><div class="section-head"><h3>Особенности Narrative AI</h3></div><div class="grid"><article class="feature"><i class="fa-solid fa-compass"></i><h4>ИИ-режиссёр</h4><p>Следит за каноном, логикой, хронологией и непротиворечивостью сюжета.</p></article><article class="feature"><i class="fa-solid fa-feather-pointed"></i><h4>ИИ-повествователь</h4><p>Пишет сцены и диалоги, следуя плану режиссёра и вашим правилам.</p></article><article class="feature"><i class="fa-solid fa-images"></i><h4>Ваш визуальный стиль</h4><p>Аватары историй, профилей и собственные фоны чатов.</p></article></div>`;
  if (state.page === 'catalog' || state.page === 'stories')
    root.innerHTML = `<h1 class="page-title">${pageNames[state.page]}</h1><p class="page-sub">Ваши истории и миры. Откройте существующую или создайте новую.</p><div class="actions" style="margin:0 0 18px"><button class="btn btn-primary" id="list-create"><i class="fa-solid fa-plus"></i> Новая история</button></div><div class="grid">${state.stories.map(storyCard).join('') || '<div class="empty" style="grid-column:1/-1">Историй пока нет.</div>'}</div>`;
  if (state.page === 'create') renderEditor(root);
  if (state.page === 'profile') renderUserProfile(root);
  if (state.page === 'settings') renderAISettings(root);
  if (state.page === 'play' && state.currentStory) renderPlay(root, state.currentStory);
  if (state.page === 'storyProfile' && state.currentStory)
    renderStoryProfile(root, state.currentStory);
  bindPageActions();
}
function renderEditor(root) {
  const s = state.editingStory || {};
  const chars = (s.characters || [])
    .map((x) => (typeof x === 'string' ? x : `${x.name || ''} — ${x.description || ''}`))
    .join('\n');
  const locs = (s.locations || [])
    .map((x) => (typeof x === 'string' ? x : `${x.name || ''} — ${x.description || ''}`))
    .join('\n');
  const events = (s.events || [])
    .map((x) => (typeof x === 'string' ? x : `${x.name || ''} — ${x.description || ''}`))
    .join('\n');
  root.innerHTML = `<div class="editor-top"><div><h1 class="page-title">${s.id ? 'Редактор истории' : 'Создание истории'}</h1><p class="page-sub">Заполняйте только то, что важно. Все дополнительные сведения необязательны.</p></div><button class="btn btn-primary" id="save-story"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button></div><nav class="editor-tabs"><button data-editor-tab="basic" class="active">Основные сведения</button><button data-editor-tab="characters">Персонажи</button><button data-editor-tab="world">Локации и события</button><button data-editor-tab="opening">Первое сообщение</button><button data-editor-tab="visual">Оформление</button><button data-editor-tab="ai">Настройки ИИ-модели</button></nav>
 <form id="story-editor-form"><section class="panel editor-section" data-editor-section="basic"><div class="form-grid"><div class="wide"><label>Название истории *</label><input class="field" id="ed-title" required maxlength="100" value="${esc(s.title || '')}" placeholder="Например, Новый пилот Евангелиона"></div><div><label>Жанр</label><select class="field" id="ed-genre">${['Фэнтези', 'Фантастика', 'Киберпанк', 'Детектив', 'Романтика', 'Ужасы', 'Повседневность', 'Приключения', 'Другое'].map((g) => `<option ${s.genre === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div><div><label>Имя главного героя</label><input class="field" id="ed-hero" maxlength="200" value="${esc(s.protagonist || '')}" placeholder="Имя персонажа"></div><div class="wide"><label>Мир и завязка</label><textarea class="field textarea" id="ed-description" maxlength="10000" placeholder="Опишите сеттинг, время, канон, исходную ситуацию и важные правила мира...">${esc(s.description || '')}</textarea><small class="hint">Лучше конкретно указывать, что существует в мире, а чего в нём нет. Это поможет ИИ не додумывать лишнее.</small></div><div class="wide"><label>Главный герой — дополнительные характеристики</label><textarea class="field textarea" id="ed-hero-details" maxlength="8000" placeholder="Внешность, возраст, характер, привычки, навыки, страхи, манера речи, отношения. Все поля необязательны.">${esc(s.protagonist_details || '')}</textarea></div></div></section>
 <section class="panel editor-section hidden" data-editor-section="characters"><h3>Персонажи истории</h3><p class="hint">Каждая строка — отдельный персонаж. Формат: Имя — роль, внешность, характер, привычки, отношения. Можно оставить пустым.</p><label>Дополнительные персонажи</label><textarea class="field textarea large-textarea" id="ed-characters" placeholder="Аска Лэнгли — пилот Евы-02, вспыльчивая, гордая, скрывает неуверенность...&#10;Мисато Кацураги — командир, ответственная, любит пиво...">${esc(chars)}</textarea><div class="hint">Главный герой описывается на вкладке «Основные сведения».</div></section>
 <section class="panel editor-section hidden" data-editor-section="world"><h3>Локации</h3><p class="hint">Перечислите места и их конкретные особенности. Необязательно.</p><textarea class="field textarea" id="ed-locations" placeholder="Токио-3 — укреплённый город, штаб-квартира NERV...">${esc(locs)}</textarea><h3 style="margin-top:24px">События и факты канона</h3><p class="hint">Важные события, даты, правила, запреты, известные факты. Это особенно важно для ИИ-режиссёра.</p><textarea class="field textarea large-textarea" id="ed-events" placeholder="2015 год — события происходят во время...&#10;У пилотов нет шлемов в конструкции костюмов...&#10;Не вводить несуществующие технологии и элементы канона...">${esc(events)}</textarea></section>
 <section class="panel editor-section hidden" data-editor-section="opening"><h3>Первое сообщение повествователя</h3><p class="hint">Если заполнить поле, это сообщение появится первым при открытии истории. ИИ не будет генерировать вступление автоматически. Если оставить пустым — начнёте вы.</p><textarea class="field textarea large-textarea" id="ed-opening" maxlength="5000" placeholder="*Мисато встречает нового пилота у выхода из аэропорта...*">${esc(s.opening_message || '')}</textarea></section>
 <section class="panel editor-section hidden" data-editor-section="visual"><div class="form-grid"><div><h3>Обложка истории</h3><p class="hint">Аватар/обложка для каталога и профиля истории.</p><div class="image-preview" id="cover-preview">${s.cover_image ? `<img src="${s.cover_image}">` : 'Нет изображения'}</div><input class="field" type="file" id="ed-cover" accept="image/png,image/jpeg,image/webp"><button class="btn btn-secondary" type="button" id="remove-cover">Убрать обложку</button></div><div><h3>Фон чата</h3><p class="hint">Собственное изображение для фона переписки.</p><div class="image-preview" id="background-preview">${s.chat_background ? `<img src="${s.chat_background}">` : 'Фон по умолчанию'}</div><input class="field" type="file" id="ed-background" accept="image/png,image/jpeg,image/webp"><button class="btn btn-secondary" type="button" id="remove-background">Сбросить фон</button></div></div><p class="hint">Файлы PNG, JPG или WebP, до 2 МБ каждый.</p></section>
 <section class="panel editor-section hidden" data-editor-section="ai"><h3>Параметры ИИ для этой истории</h3><p class="hint">Если оставить значения по умолчанию, будут применяться общие настройки из раздела «Настройки ИИ». Здесь можно переопределить стиль и поведение именно для этой истории.</p><div class="form-grid"><div><label>Стиль повествования</label><select class="field" id="ed-ai-style"><option value="">По умолчанию</option><option value="balanced">Сбалансированный</option><option value="creative">Творческий</option><option value="precise">Точный</option></select></div><div><label>Длина ответа</label><select class="field" id="ed-ai-length"><option value="">По умолчанию</option><option value="short">Короткая</option><option value="medium">Средняя</option><option value="long">Длинная</option></select></div><div><label>Контекст</label><select class="field" id="ed-ai-context"><option value="0">По умолчанию</option><option value="2048">2 048</option><option value="4096">4 096</option><option value="8192">8 192</option><option value="16384">16 384</option><option value="32768">32 768</option></select></div><div><label>Креативность</label><input class="field" id="ed-ai-creativity" type="number" min="0" max="1" step="0.05" placeholder="По умолчанию"></div></div><div class="toggle-row"><label for="ed-ai-director">Использовать ИИ-режиссёра</label><label class="switch"><input type="checkbox" id="ed-ai-director" ${(s.ai_settings?.director_enabled ?? state.ai?.director_enabled ?? true) ? 'checked' : ''}><span></span></label></div><div class="toggle-row"><label for="ed-ai-canon">Строго соблюдать канон</label><label class="switch"><input type="checkbox" id="ed-ai-canon" ${(s.ai_settings?.strict_canon ?? state.ai?.strict_canon ?? true) ? 'checked' : ''}><span></span></label></div></section>
 <div class="editor-footer"><button class="btn btn-primary" type="button" id="save-story-bottom">Сохранить историю</button><button class="btn btn-secondary" type="button" id="cancel-editor">Отмена</button></div></form>`;
  const storyAI = s.ai_settings || {};
  $('ed-ai-style').value = storyAI.style || '';
  $('ed-ai-length').value = storyAI.response_length || '';
  $('ed-ai-context').value = String(storyAI.context_length || 0);
  $('ed-ai-creativity').value = storyAI.creativity ?? '';
  root.querySelectorAll('[data-editor-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        state.editorTab = b.dataset.editorTab;
        root
          .querySelectorAll('[data-editor-tab]')
          .forEach((x) => x.classList.toggle('active', x === b));
        root
          .querySelectorAll('[data-editor-section]')
          .forEach((x) =>
            x.classList.toggle('hidden', x.dataset.editorSection !== state.editorTab),
          );
      }),
  );
  $('ed-cover').onchange = (e) => previewFile(e.target.files[0], 'cover-preview', 'cover_image');
  $('ed-background').onchange = (e) =>
    previewFile(e.target.files[0], 'background-preview', 'chat_background');
  $('remove-cover').onclick = () => {
    s.cover_image = '';
    $('cover-preview').textContent = 'Нет изображения';
  };
  $('remove-background').onclick = () => {
    s.chat_background = '';
    $('background-preview').textContent = 'Фон по умолчанию';
  };
  $('story-editor-form').onsubmit = (e) => {
    e.preventDefault();
    saveStory();
  };
  $('save-story').onclick = saveStory;
  $('save-story-bottom').onclick = saveStory;
  $('cancel-editor').onclick = () => {
    if (s.id) {
      state.currentStory = s;
      state.editingStory = null;
      state.page = 'storyProfile';
      $('top-title').textContent = pageNames.storyProfile;
      renderPage();
    } else navigate('stories');
  };
}
function previewFile(file, target, key) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    toast('Файл больше 2 МБ. Выберите изображение поменьше.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.editingStory = state.editingStory || {};
    state.editingStory[key] = reader.result;
    $(target).innerHTML = `<img src="${reader.result}" alt="Предпросмотр">`;
  };
  reader.readAsDataURL(file);
}
function linesToList(value) {
  return value
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}
async function saveStory() {
  const s = state.editingStory || {};
  const payload = {
    title: $('ed-title').value.trim(),
    genre: $('ed-genre').value,
    protagonist: $('ed-hero').value.trim(),
    description: $('ed-description').value.trim(),
    protagonist_details: $('ed-hero-details').value.trim(),
    characters: linesToList($('ed-characters').value),
    locations: linesToList($('ed-locations').value),
    events: linesToList($('ed-events').value),
    opening_message: $('ed-opening').value.trim(),
    cover_image: s.cover_image || '',
    chat_background: s.chat_background || '',
    ai_settings: {
      style: $('ed-ai-style').value || undefined,
      response_length: $('ed-ai-length').value || undefined,
      context_length: Number($('ed-ai-context').value) || undefined,
      creativity:
        $('ed-ai-creativity').value === ''
          ? undefined
          : Math.max(0, Math.min(1, Number($('ed-ai-creativity').value))),
      director_enabled: $('ed-ai-director').checked,
      strict_canon: $('ed-ai-canon').checked,
    },
  };
  try {
    const r = await api(s.id ? `/api/stories/${s.id}` : '/api/stories', {
      method: s.id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    state.currentStory = r.story;
    state.editingStory = null;
    toast('История сохранена');
    if (s.id) {
      state.currentStory = r.story;
      state.page = 'storyProfile';
      $('top-title').textContent = pageNames.storyProfile;
      renderPage();
    } else await openStory(r.story.id);
  } catch (e) {
    toast(e.message);
  }
}
async function openEditor(id) {
  try {
    if (!state.ai) {
      const a = await api('/api/settings/ai');
      state.ai = a.settings;
    }
    if (id) {
      const r = await api(`/api/stories/${id}`);
      state.editingStory = r.story;
    } else state.editingStory = {};
  } catch (e) {
    toast(e.message);
    return;
  }
  state.editorTab = 'basic';
  state.page = 'create';
  $('top-title').textContent = 'Редактор истории';
  renderPage();
}
function renderUserProfile(root) {
  root.innerHTML = `<h1 class="page-title">Профиль пользователя</h1><p class="page-sub">Настройте имя и изображение профиля.</p><section class="panel settings-card"><div class="profile-edit-head">${avatarMarkup(state.user, 76)}<div><h3>${esc(state.user.name)}</h3><p class="muted">${esc(state.user.email)}</p></div></div><label>Аватар профиля</label><input class="field" type="file" id="profile-avatar-file" accept="image/png,image/jpeg,image/webp"><button class="btn btn-secondary" id="save-avatar">Загрузить аватар</button><hr class="soft-hr"><label>Отображаемое имя</label><input class="field" id="profile-name" maxlength="40" value="${esc(state.user.name)}"><button class="btn btn-primary" id="save-profile">Сохранить профиль</button><button class="btn btn-secondary" id="profile-logout" style="margin-left:8px">Выйти</button></section>`;
}
function renderAISettings(root) {
  const a = state.ai || {};
  const providerOpts = (v) =>
    `<option value="ollama" ${v === 'ollama' ? 'selected' : ''}>Ollama — локально</option><option value="lmstudio" ${v === 'lmstudio' ? 'selected' : ''}>LM Studio — локально</option><option value="api" ${v === 'api' ? 'selected' : ''}>Внешний API</option>`;
  root.innerHTML = `<h1 class="page-title">Настройки ИИ-моделей</h1><p class="page-sub">Ключи принадлежат вашему аккаунту, шифруются на сервере и не возвращаются в браузер после сохранения.</p><form id="ai-form" class="settings-stack">
 <section class="panel"><div class="setting-title"><div><h3>ИИ-режиссёр</h3><p class="hint">Проверяет непрерывность по необходимости: на первом ходе, примерно раз в четыре хода и при потенциально рискованных событиях.</p></div><label class="switch"><input id="ai-director-enabled" type="checkbox" ${a.director_enabled ? 'checked' : ''}><span></span></label></div><div class="form-grid" id="director-fields"><div><label>Провайдер режиссёра</label><select class="field" id="ai-director-provider">${providerOpts(a.director_provider)}</select></div><div><label>Модель режиссёра</label><input class="field" id="ai-director-model" value="${esc(a.director_model || '')}" placeholder="qwen2.5:3b"></div><div class="wide"><label>Адрес сервера режиссёра</label><input class="field" id="ai-director-url" value="${esc(a.director_base_url || 'http://127.0.0.1:11434/v1')}"></div><div class="wide api-key-field" id="director-api-key-wrap"><label for="ai-director-api-key">API-токен режиссёра</label><input class="field" type="password" id="ai-director-api-key" autocomplete="new-password" placeholder="${state.directorApiKeyConfigured ? 'Токен сохранён — оставьте пустым, чтобы не менять' : 'Вставьте API-токен'}"><small class="hint">${state.directorApiKeyConfigured ? 'Токен уже сохранён. Новое значение заменит его.' : 'Токен будет зашифрован перед сохранением.'}</small><label class="clear-key"><input type="checkbox" id="ai-director-api-key-clear"> Удалить сохранённый токен режиссёра</label></div></div></section>
 <section class="panel"><h3>ИИ-повествователь</h3><p class="hint">Генерирует художественный текст и диалоги.</p><div class="form-grid"><div><label>Провайдер</label><select class="field" id="ai-provider">${providerOpts(a.provider)}</select></div><div><label>Название модели</label><input class="field" id="ai-model" required value="${esc(a.model || '')}" placeholder="gemini-3.1-flash"></div><div class="wide"><label>Адрес API</label><input class="field" id="ai-url" required value="${esc(a.base_url || 'http://127.0.0.1:11434/v1')}"></div><div class="wide api-key-field" id="narrator-api-key-wrap"><label for="ai-api-key">API-токен повествователя</label><input class="field" type="password" id="ai-api-key" autocomplete="new-password" placeholder="${state.apiKeyConfigured ? 'Токен сохранён — оставьте пустым, чтобы не менять' : 'Вставьте API-токен'}"><small class="hint">${state.apiKeyConfigured ? 'Токен уже сохранён. Новое значение заменит его.' : 'Токен будет зашифрован на сервере. Он не попадёт в JavaScript или Git.'}</small><label class="clear-key"><input type="checkbox" id="ai-api-key-clear"> Удалить сохранённый токен повествователя</label></div></div><p class="hint">Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1. Внешний API должен поддерживать OpenAI-совместимый /chat/completions.</p></section>
 <section class="panel"><h3>Параметры генерации</h3><div class="setting-row"><label for="ai-context">Размер контекста</label><select class="field" id="ai-context"><option value="2048">2 048 токенов</option><option value="4096">4 096 токенов</option><option value="8192">8 192 токена</option><option value="16384">16 384 токенов</option><option value="32768">32 768 токенов</option></select></div><div class="setting-row"><label for="ai-style">Стиль повествования</label><select class="field" id="ai-style"><option value="balanced">Сбалансированный</option><option value="creative">Творческий</option><option value="precise">Точный</option></select></div><div class="setting-row"><label for="ai-creativity">Креативность: <strong id="creativity-value">${Math.round((a.creativity ?? 0.75) * 100)}%</strong></label><input class="range" type="range" min="0" max="1" step="0.05" id="ai-creativity" value="${a.creativity ?? 0.75}"></div><div class="setting-row"><label for="ai-length">Длина ответа</label><select class="field" id="ai-length"><option value="short">Короткая</option><option value="medium">Средняя</option><option value="long">Длинная</option></select></div><div class="setting-row"><label for="ai-max-tokens">Максимум токенов ответа</label><input class="field" type="number" min="128" max="8192" step="128" id="ai-max-tokens" value="${a.max_tokens || 900}"></div></section>
 <section class="panel"><h3>Поведение повествования</h3>${toggleRow('ai-simple-actions', 'Предпочитать простые решения игрока', a.simple_actions)}${toggleRow('ai-adult', 'Разрешить взрослый контент (18+)', a.adult_content)}${toggleRow('ai-random', 'Случайные сюжетные события', a.random_events)}${toggleRow('ai-canon', 'Строго соблюдать канон и факты', a.strict_canon !== false)}</section><div class="actions"><button class="btn btn-primary" type="submit">Сохранить настройки</button><button class="btn btn-secondary" type="button" id="test-ai-connection">Проверить соединение</button><span class="status" id="ai-status"></span></div></form>`;
  $('ai-context').value = String(a.context_length || 8192);
  $('ai-style').value = a.style || 'balanced';
  $('ai-length').value = a.response_length || 'medium';
  $('ai-creativity').oninput = () => {
    $('creativity-value').textContent = Math.round($('ai-creativity').value * 100) + '%';
  };
  const updateKeyVisibility = () => {
    $('narrator-api-key-wrap').classList.toggle('hidden', $('ai-provider').value !== 'api');
    $('director-api-key-wrap').classList.toggle('hidden', $('ai-director-provider').value !== 'api');
  };
  $('ai-provider').onchange = updateKeyVisibility;
  $('ai-director-provider').onchange = updateKeyVisibility;
  updateKeyVisibility();
  $('director-fields').classList.toggle('disabled-fields', !$('ai-director-enabled').checked);
  $('ai-director-enabled').onchange = () => {
    $('director-fields').classList.toggle('disabled-fields', !$('ai-director-enabled').checked);
  };
}
function toggleRow(id, label, checked) {
  return `<div class="toggle-row"><label for="${id}">${label}</label><label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></label></div>`;
}
function bindPageActions() {
  const on = (id, fn) => {
    const el = $(id);
    if (el) el.onclick = fn;
  };
  on('hero-create', () => openEditor(null));
  on('hero-catalog', () => navigate('catalog'));
  on('all-stories', () => navigate('stories'));
  on('list-create', () => openEditor(null));
  on('profile-logout', logout);
  document
    .querySelectorAll('[data-open-story]')
    .forEach((el) => (el.onclick = () => openStory(el.dataset.openStory)));
  const aiForm = $('ai-form');
  if (aiForm) {
    aiForm.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        provider: $('ai-provider').value,
        base_url: $('ai-url').value,
        model: $('ai-model').value,
        api_key: $('ai-api-key').value,
        api_key_clear: $('ai-api-key-clear').checked,
        director_enabled: $('ai-director-enabled').checked,
        director_provider: $('ai-director-provider').value,
        director_base_url: $('ai-director-url').value,
        director_model: $('ai-director-model').value,
        director_api_key: $('ai-director-api-key').value,
        director_api_key_clear: $('ai-director-api-key-clear').checked,
        context_length: Number($('ai-context').value),
        style: $('ai-style').value,
        creativity: Number($('ai-creativity').value),
        response_length: $('ai-length').value,
        max_tokens: Number($('ai-max-tokens').value),
        simple_actions: $('ai-simple-actions').checked,
        adult_content: $('ai-adult').checked,
        random_events: $('ai-random').checked,
        strict_canon: $('ai-canon').checked,
      };
      try {
        const r = await api('/api/settings/ai', { method: 'PUT', body: JSON.stringify(body) });
        state.ai = r.settings;
        state.apiKeyConfigured = Boolean(r.apiKeyConfigured);
        state.directorApiKeyConfigured = Boolean(r.directorApiKeyConfigured);
        $('ai-api-key').value = '';
        $('ai-director-api-key').value = '';
        $('ai-status').textContent = 'Настройки сохранены. API-токены хранятся в зашифрованном виде.';
        $('ai-status').classList.remove('danger');
        toast('Настройки ИИ сохранены');
        renderAISettings(root);
      } catch (err) {
        $('ai-status').textContent = err.message;
        $('ai-status').classList.add('danger');
      }
    };
    $('test-ai-connection').onclick = async () => {
      const button = $('test-ai-connection');
      const status = $('ai-status');
      button.disabled = true;
      status.textContent = 'Проверяем соединение…';
      status.classList.remove('danger');
      try {
        const result = await api('/api/settings/ai/test', {
          method: 'POST',
          body: JSON.stringify({
            provider: $('ai-provider').value,
            base_url: $('ai-url').value,
            model: $('ai-model').value,
            api_key: $('ai-api-key').value,
          }),
        });
        status.textContent = `Соединение успешно: ${result.model}. Ответ: ${result.reply}`;
      } catch (err) {
        status.textContent = err.message;
        status.classList.add('danger');
      } finally {
        button.disabled = false;
      }
    };
  }
  on('save-profile', async () => {
    try {
      const r = await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: $('profile-name').value }),
      });
      state.user = { ...state.user, ...r.user };
      $('side-name').textContent = state.user.name;
      $('side-avatar-wrap').innerHTML = avatarMarkup(state.user, 36);
      toast('Профиль обновлён');
    } catch (e) {
      toast(e.message);
    }
  });
  on('save-avatar', async () => {
    const f = $('profile-avatar-file').files[0];
    if (!f) return toast('Сначала выберите изображение.');
    try {
      const image = await fileAsData(f);
      const r = await api('/api/profile/avatar', {
        method: 'PUT',
        body: JSON.stringify({ image }),
      });
      state.user.avatar_data = r.avatar_data;
      $('side-avatar-wrap').innerHTML = avatarMarkup(state.user, 36);
      $('top-avatar-wrap').innerHTML = avatarMarkup(state.user, 38);
      toast('Аватар обновлён');
    } catch (e) {
      toast(e.message);
    }
  });
}
function fileAsData(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 2 * 1024 * 1024)
      return reject(new Error('Изображение должно быть меньше 2 МБ.'));
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Не удалось прочитать изображение.'));
    r.readAsDataURL(file);
  });
}
async function openStory(id) {
  try {
    const r = await api(`/api/stories/${id}`);
    state.currentStory = r.story;
    state.page = 'play';
    $('app-screen').classList.add('chat-mode');
    $('top-title').textContent = pageNames.play;
    document.querySelectorAll('[data-page]').forEach((b) => b.classList.remove('active'));
    renderPage();
  } catch (e) {
    toast(e.message);
  }
}
function renderStoryProfile(root, s) {
  root.innerHTML = `<div class="actions" style="margin:0 0 18px"><button class="btn btn-secondary" id="profile-back">← К историям</button><button class="btn btn-primary" id="edit-story">Редактировать историю</button></div><section class="panel story-profile-head">${s.cover_image ? `<img src="${s.cover_image}" alt="Обложка">` : '<div class="story-cover-placeholder big"><i class="fa-solid fa-book-open"></i></div>'}<div><span class="pill">${esc(s.genre)}</span><h1>${esc(s.title)}</h1><p class="muted">${esc(s.description || 'Описание не добавлено.')}</p></div></section><div class="profile-info-grid"><section class="panel"><h3>Главный герой</h3><strong>${esc(s.protagonist || 'Не указан')}</strong><p class="muted">${esc(s.protagonist_details || 'Дополнительные характеристики не заданы.')}</p></section><section class="panel"><h3>Персонажи</h3>${listDisplay(s.characters)}</section><section class="panel"><h3>Локации</h3>${listDisplay(s.locations)}</section><section class="panel"><h3>События и канон</h3>${listDisplay(s.events)}</section><section class="panel wide-panel"><h3>Первое сообщение</h3><p class="muted">${esc(s.opening_message || 'Не задано. Игрок начинает историю самостоятельно.')}</p></section></div>`;
  $('profile-back').onclick = () => navigate('stories');
  $('edit-story').onclick = () => openEditor(s.id);
}
function listDisplay(items) {
  return items?.length
    ? `<ul class="plain-list">${items.map((x) => `<li>${esc(typeof x === 'string' ? x : x.name || x.description || '')}</li>`).join('')}</ul>`
    : '<p class="muted">Не добавлено.</p>';
}
function renderPlay(root, s) {
  root.innerHTML = `<div class="actions" style="margin:0 0 16px"><button class="btn btn-secondary" id="back-stories">← К историям</button><button class="btn btn-secondary" id="story-profile">Профиль истории</button><button class="btn btn-secondary" id="edit-story-chat">Редактировать</button><button class="btn btn-secondary danger" id="delete-story">Удалить</button></div><section class="panel chat-panel" ${s.chat_background ? `style="--chat-bg-image:url('${s.chat_background}')"` : ''}><div class="chat-head"><div class="chat-title-line">${s.cover_image ? `<img class="chat-story-avatar" src="${s.cover_image}" alt="">` : ''}<div><h3>${esc(s.title)}</h3><span class="pill">${esc(s.genre)}</span></div></div></div><div class="chat-body" id="chat-body">${(s.messages || []).map((m) => `<div class="bubble ${m.role === 'user' ? 'user' : 'assistant'}">${esc(m.content)}</div>`).join('') || '<div class="bubble assistant">История начинается здесь. Опишите своё первое действие — и повествователь продолжит сцену.</div>'}</div><form class="chat-compose" id="chat-form"><textarea id="chat-message" placeholder="Что вы делаете дальше?" maxlength="3000" required></textarea><button class="btn btn-primary" type="submit" title="Отправить"><i class="fa-solid fa-paper-plane"></i></button></form></section>`;
  $('back-stories').onclick = () => navigate('stories');
  $('story-profile').onclick = () => {
    state.page = 'storyProfile';
    $('top-title').textContent = pageNames.storyProfile;
    renderPage();
  };
  $('edit-story-chat').onclick = () => openEditor(s.id);
  $('delete-story').onclick = async () => {
    if (!confirm('Удалить историю без возможности восстановления?')) return;
    try {
      await api(`/api/stories/${s.id}`, { method: 'DELETE' });
      toast('История удалена');
      navigate('stories');
    } catch (e) {
      toast(e.message);
    }
  };
  $('chat-form').onsubmit = async (e) => {
    e.preventDefault();
    const input = $('chat-message'),
      message = input.value.trim();
    if (!message) return;
    input.value = '';
    appendBubble('user', message);
    const send = $('chat-form').querySelector('button');
    send.disabled = true;
    const wait = appendBubble('assistant', 'Повествователь готовит ответ…');
    try {
      const r = await api(`/api/stories/${s.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      wait.textContent = r.answer;
      state.currentStory.messages = r.messages;
    } catch (err) {
      wait.textContent = `Ошибка: ${err.message}`;
      wait.classList.add('danger');
    } finally {
      send.disabled = false;
      $('chat-body').scrollTop = $('chat-body').scrollHeight;
      input.focus();
    }
  };
  $('chat-body').scrollTop = $('chat-body').scrollHeight;
}
function appendBubble(role, content) {
  const el = document.createElement('div');
  el.className = `bubble ${role}`;
  el.textContent = content;
  $('chat-body').appendChild(el);
  $('chat-body').scrollTop = $('chat-body').scrollHeight;
  return el;
}
function consumeAuthRedirect() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) {
    localStorage.setItem('narrative_access_token', accessToken);
    localStorage.setItem('narrative_refresh_token', refreshToken);
    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
  }
}
consumeAuthRedirect();

(async () => {
  try {
    const r = await api('/api/auth/me');
    if (r.user) enterApp(r.user);
    else {
      localStorage.removeItem('narrative_access_token');
      localStorage.removeItem('narrative_refresh_token');
    }
  } catch {
    localStorage.removeItem('narrative_access_token');
    localStorage.removeItem('narrative_refresh_token');
  }
})();
