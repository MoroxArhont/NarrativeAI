require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const SessionStore = session.Store;
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'narrative.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expire INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    avatar_data TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, genre TEXT NOT NULL DEFAULT 'Фэнтези', description TEXT NOT NULL DEFAULT '',
    protagonist TEXT NOT NULL DEFAULT '', protagonist_details TEXT NOT NULL DEFAULT '',
    characters TEXT NOT NULL DEFAULT '[]', locations TEXT NOT NULL DEFAULT '[]', events TEXT NOT NULL DEFAULT '[]',
    opening_message TEXT NOT NULL DEFAULT '', messages TEXT NOT NULL DEFAULT '[]',
    ai_settings TEXT NOT NULL DEFAULT '{}', cover_image TEXT NOT NULL DEFAULT '', chat_background TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'ollama', base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434/v1', model TEXT NOT NULL DEFAULT '',
    director_enabled INTEGER NOT NULL DEFAULT 1, director_provider TEXT NOT NULL DEFAULT 'ollama',
    director_base_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434/v1', director_model TEXT NOT NULL DEFAULT '',
    context_length INTEGER NOT NULL DEFAULT 8192, max_tokens INTEGER NOT NULL DEFAULT 900,
    style TEXT NOT NULL DEFAULT 'balanced', creativity REAL NOT NULL DEFAULT 0.75,
    response_length TEXT NOT NULL DEFAULT 'medium', simple_actions INTEGER NOT NULL DEFAULT 1,
    adult_content INTEGER NOT NULL DEFAULT 0, random_events INTEGER NOT NULL DEFAULT 0,
    strict_canon INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Мягкие миграции: обновление не ломает уже созданную базу пользователя.
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
[
  ['users','avatar_data',"TEXT NOT NULL DEFAULT ''"],
  ['stories','protagonist_details',"TEXT NOT NULL DEFAULT ''"], ['stories','characters',"TEXT NOT NULL DEFAULT '[]'"],
  ['stories','locations',"TEXT NOT NULL DEFAULT '[]'"], ['stories','events',"TEXT NOT NULL DEFAULT '[]'"],
  ['stories','opening_message',"TEXT NOT NULL DEFAULT ''"], ['stories','ai_settings',"TEXT NOT NULL DEFAULT '{}'"],
  ['stories','cover_image',"TEXT NOT NULL DEFAULT ''"], ['stories','chat_background',"TEXT NOT NULL DEFAULT ''"],
  ['user_settings','director_enabled','INTEGER NOT NULL DEFAULT 1'], ['user_settings','director_provider',"TEXT NOT NULL DEFAULT 'ollama'"],
  ['user_settings','director_base_url',"TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434/v1'"], ['user_settings','director_model',"TEXT NOT NULL DEFAULT ''"],
  ['user_settings','context_length','INTEGER NOT NULL DEFAULT 8192'], ['user_settings','max_tokens','INTEGER NOT NULL DEFAULT 900'],
  ['user_settings','style',"TEXT NOT NULL DEFAULT 'balanced'"], ['user_settings','creativity','REAL NOT NULL DEFAULT 0.75'],
  ['user_settings','response_length',"TEXT NOT NULL DEFAULT 'medium'"], ['user_settings','simple_actions','INTEGER NOT NULL DEFAULT 1'],
  ['user_settings','adult_content','INTEGER NOT NULL DEFAULT 0'], ['user_settings','random_events','INTEGER NOT NULL DEFAULT 0'],
  ['user_settings','strict_canon','INTEGER NOT NULL DEFAULT 1']
].forEach(([t,c,d]) => ensureColumn(t,c,d));

db.prepare('DELETE FROM sessions WHERE expire < ?').run(Date.now());
class SQLiteSessionStore extends SessionStore {
  get(sid, cb) { try { const r=db.prepare('SELECT sess,expire FROM sessions WHERE sid=?').get(sid); if(!r||r.expire<Date.now()) return cb(null,null); cb(null,JSON.parse(r.sess)); } catch(e){cb(e);} }
  set(sid,sess,cb=()=>{}) { try { const exp=sess.cookie?.expires?new Date(sess.cookie.expires).getTime():Date.now()+7*86400000; db.prepare('INSERT INTO sessions(sid,sess,expire) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expire=excluded.expire').run(sid,JSON.stringify(sess),exp); cb(null); }catch(e){cb(e);} }
  destroy(sid,cb=()=>{}) { try{db.prepare('DELETE FROM sessions WHERE sid=?').run(sid);cb(null);}catch(e){cb(e);} }
  touch(sid,sess,cb=()=>{}) { this.set(sid,sess,cb); }
}
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'8mb'}));
app.use(session({name:'narrative.sid',secret:process.env.SESSION_SECRET||'change-this-session-secret-before-deployment-please',store:new SQLiteSessionStore(),resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',maxAge:7*86400000}}));
app.use(express.static(path.join(__dirname,'public')));
const authLimiter=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false});
const aiLimiter=rateLimit({windowMs:60*1000,limit:20,standardHeaders:'draft-7',legacyHeaders:false});
const requireAuth=(req,res,next)=>req.session.userId?next():res.status(401).json({error:'Сначала войдите в аккаунт.'});
const safeUser=u=>({id:u.id,name:u.name,email:u.email,avatar_data:u.avatar_data||''});
const parseJSON=(v,fallback)=>{try{return JSON.parse(v||'');}catch{return fallback;}};
const clamp=(v,min,max,def)=>Number.isFinite(Number(v))?Math.min(max,Math.max(min,Number(v))):def;

app.get('/api/health',(req,res)=>res.json({status:'ok',app:'Narrative AI',version:'2.0'}));
app.post('/api/auth/register',authLimiter,async(req,res)=>{
  try{
    const name=String(req.body.name||'').trim(),email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');
    if(name.length<2||name.length>40)return res.status(400).json({error:'Имя должно содержать от 2 до 40 символов.'});
    if(!/^\S+@\S+\.\S+$/.test(email)||email.length>120)return res.status(400).json({error:'Укажите корректную электронную почту.'});
    if(password.length<8||Buffer.byteLength(password,'utf8')>72)return res.status(400).json({error:'Пароль должен содержать от 8 до 72 символов.'});
    const hash=await bcrypt.hash(password,12),result=db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name,email,hash);
    const user=db.prepare('SELECT id,name,email,avatar_data FROM users WHERE id=?').get(result.lastInsertRowid); db.prepare('INSERT INTO user_settings(user_id) VALUES(?)').run(user.id);
    req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Не удалось создать сессию.'});req.session.userId=user.id;res.status(201).json({user:safeUser(user)});});
  }catch(e){if(String(e.code).includes('SQLITE_CONSTRAINT'))return res.status(409).json({error:'Аккаунт с такой почтой уже существует.'});console.error(e);res.status(500).json({error:'Не удалось создать аккаунт.'});}
});
app.post('/api/auth/login',authLimiter,async(req,res)=>{const email=String(req.body.email||'').trim().toLowerCase(),password=String(req.body.password||'');const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:'Неверная почта или пароль.'});req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Не удалось создать сессию.'});req.session.userId=u.id;res.json({user:safeUser(u)});});});
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('narrative.sid');res.json({ok:true});}));
app.get('/api/auth/me',(req,res)=>{if(!req.session.userId)return res.json({user:null});const u=db.prepare('SELECT id,name,email,avatar_data FROM users WHERE id=?').get(req.session.userId);res.json({user:u?safeUser(u):null});});
app.put('/api/profile',(req,res)=>{if(!req.session.userId)return res.status(401).json({error:'Сначала войдите.'});const name=String(req.body.name||'').trim();if(name.length<2||name.length>40)return res.status(400).json({error:'Имя должно содержать от 2 до 40 символов.'});db.prepare('UPDATE users SET name=? WHERE id=?').run(name,req.session.userId);const u=db.prepare('SELECT id,name,email,avatar_data FROM users WHERE id=?').get(req.session.userId);res.json({user:safeUser(u)});});
app.put('/api/profile/avatar',requireAuth,(req,res)=>{const image=String(req.body.image||'');if(image&&!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image))return res.status(400).json({error:'Поддерживаются PNG, JPG и WebP.'});if(image.length>3_000_000)return res.status(413).json({error:'Изображение слишком большое. Максимум около 2 МБ.'});db.prepare('UPDATE users SET avatar_data=? WHERE id=?').run(image,req.session.userId);res.json({ok:true,avatar_data:image});});

function normalizeStory(row){if(!row)return row;return {...row,messages:parseJSON(row.messages,[]),characters:parseJSON(row.characters,[]),locations:parseJSON(row.locations,[]),events:parseJSON(row.events,[]),ai_settings:parseJSON(row.ai_settings,{})};}
const storySelect='SELECT * FROM stories WHERE id=? AND user_id=?';
app.get('/api/stories',requireAuth,(req,res)=>{const rows=db.prepare('SELECT id,title,genre,description,protagonist,cover_image,created_at,updated_at FROM stories WHERE user_id=? ORDER BY updated_at DESC').all(req.session.userId);res.json({stories:rows});});
app.post('/api/stories',requireAuth,(req,res)=>{
  const b=req.body,title=String(b.title||'').trim(),genre=String(b.genre||'Фэнтези').trim().slice(0,40);
  if(title.length<2||title.length>100)return res.status(400).json({error:'Название должно содержать от 2 до 100 символов.'});
  const result=db.prepare(`INSERT INTO stories(user_id,title,genre,description,protagonist,protagonist_details,characters,locations,events,opening_message,ai_settings,cover_image,chat_background)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.session.userId,title,genre,String(b.description||'').slice(0,10000),String(b.protagonist||'').slice(0,200),String(b.protagonist_details||'').slice(0,8000),JSON.stringify(Array.isArray(b.characters)?b.characters:[]),JSON.stringify(Array.isArray(b.locations)?b.locations:[]),JSON.stringify(Array.isArray(b.events)?b.events:[]),String(b.opening_message||'').slice(0,5000),JSON.stringify(b.ai_settings||{}),String(b.cover_image||''),String(b.chat_background||''));
  const story=db.prepare('SELECT * FROM stories WHERE id=?').get(result.lastInsertRowid);
  if(story.opening_message.trim()){const messages=[{role:'assistant',content:story.opening_message,at:new Date().toISOString(),kind:'opening'}];db.prepare('UPDATE stories SET messages=? WHERE id=?').run(JSON.stringify(messages),story.id);story.messages=JSON.stringify(messages);}
  res.status(201).json({story:normalizeStory(story)});
});
app.get('/api/stories/:id',requireAuth,(req,res)=>{const s=db.prepare(storySelect).get(Number(req.params.id),req.session.userId);if(!s)return res.status(404).json({error:'История не найдена.'});res.json({story:normalizeStory(s)});});
app.put('/api/stories/:id',requireAuth,(req,res)=>{
  const id=Number(req.params.id),old=db.prepare(storySelect).get(id,req.session.userId);if(!old)return res.status(404).json({error:'История не найдена.'});const b=req.body;
  const title=String(b.title??old.title).trim();if(title.length<2||title.length>100)return res.status(400).json({error:'Название должно содержать от 2 до 100 символов.'});
  const imageOk=v=>!v||(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v)&&v.length<=3_000_000);
  const cover=b.cover_image??old.cover_image,background=b.chat_background??old.chat_background;if(!imageOk(cover)||!imageOk(background))return res.status(400).json({error:'Изображения должны быть PNG, JPG или WebP размером до 2 МБ.'});
  db.prepare(`UPDATE stories SET title=?,genre=?,description=?,protagonist=?,protagonist_details=?,characters=?,locations=?,events=?,opening_message=?,ai_settings=?,cover_image=?,chat_background=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(title,String(b.genre??old.genre).slice(0,40),String(b.description??old.description).slice(0,10000),String(b.protagonist??old.protagonist).slice(0,200),String(b.protagonist_details??old.protagonist_details).slice(0,8000),JSON.stringify(b.characters??parseJSON(old.characters,[])),JSON.stringify(b.locations??parseJSON(old.locations,[])),JSON.stringify(b.events??parseJSON(old.events,[])),String(b.opening_message??old.opening_message).slice(0,5000),JSON.stringify(b.ai_settings??parseJSON(old.ai_settings,{})),cover,background,id);
  res.json({story:normalizeStory(db.prepare('SELECT * FROM stories WHERE id=?').get(id))});
});
app.delete('/api/stories/:id',requireAuth,(req,res)=>{const r=db.prepare('DELETE FROM stories WHERE id=? AND user_id=?').run(Number(req.params.id),req.session.userId);if(!r.changes)return res.status(404).json({error:'История не найдена.'});res.json({ok:true});});

const DEFAULT_AI={provider:'ollama',base_url:'http://127.0.0.1:11434/v1',model:'',director_enabled:1,director_provider:'ollama',director_base_url:'http://127.0.0.1:11434/v1',director_model:'qwen2.5:3b',context_length:8192,max_tokens:900,style:'balanced',creativity:0.75,response_length:'medium',simple_actions:1,adult_content:0,random_events:0,strict_canon:1};
function publicAI(s){return {...DEFAULT_AI,...s,director_model:s.director_model||'qwen2.5:3b',director_enabled:Boolean(s.director_enabled),simple_actions:Boolean(s.simple_actions),adult_content:Boolean(s.adult_content),random_events:Boolean(s.random_events),strict_canon:Boolean(s.strict_canon)};}
app.get('/api/settings/ai',requireAuth,(req,res)=>{const s=db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(req.session.userId)||DEFAULT_AI;res.json({settings:publicAI(s),apiKeyConfigured:Boolean(process.env.AI_API_KEY)});});
app.put('/api/settings/ai',requireAuth,(req,res)=>{
  const b=req.body,provider=['ollama','lmstudio','api'].includes(b.provider)?b.provider:null,dprovider=['ollama','lmstudio','api'].includes(b.director_provider||b.provider)?(b.director_provider||b.provider):null;
  const baseUrl=String(b.base_url??b.baseUrl??'').trim().replace(/\/$/,''),dBase=String(b.director_base_url??b.directorBaseUrl??baseUrl).trim().replace(/\/$/,''),model=String(b.model||'').trim().slice(0,120),dModel=String(b.director_model||model).trim().slice(0,120);
  const valid=(p,u)=>{try{const x=new URL(u);return ['http:','https:'].includes(x.protocol)&&(p!=='api'||x.protocol==='https:')&&(p==='api'||['localhost','127.0.0.1','host.docker.internal'].includes(x.hostname));}catch{return false;}};
  if(!provider||!dprovider||!model||!valid(provider,baseUrl)||!valid(dprovider,dBase))return res.status(400).json({error:'Проверьте провайдера и адреса серверов.'});
  const values={provider,base_url:baseUrl,model,director_enabled:b.director_enabled===false?0:1,director_provider:dprovider,director_base_url:dBase,director_model:dModel||model,context_length:clamp(b.context_length,2048,32768,8192),max_tokens:clamp(b.max_tokens,128,8192,900),style:['balanced','creative','precise'].includes(b.style)?b.style:'balanced',creativity:clamp(b.creativity,0,1,0.75),response_length:['short','medium','long'].includes(b.response_length)?b.response_length:'medium',simple_actions:b.simple_actions===false?0:1,adult_content:b.adult_content?1:0,random_events:b.random_events?1:0,strict_canon:b.strict_canon===false?0:1};
  db.prepare(`INSERT INTO user_settings(user_id,provider,base_url,model,director_enabled,director_provider,director_base_url,director_model,context_length,max_tokens,style,creativity,response_length,simple_actions,adult_content,random_events,strict_canon)
  VALUES(@user_id,@provider,@base_url,@model,@director_enabled,@director_provider,@director_base_url,@director_model,@context_length,@max_tokens,@style,@creativity,@response_length,@simple_actions,@adult_content,@random_events,@strict_canon)
  ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,model=excluded.model,director_enabled=excluded.director_enabled,director_provider=excluded.director_provider,director_base_url=excluded.director_base_url,director_model=excluded.director_model,context_length=excluded.context_length,max_tokens=excluded.max_tokens,style=excluded.style,creativity=excluded.creativity,response_length=excluded.response_length,simple_actions=excluded.simple_actions,adult_content=excluded.adult_content,random_events=excluded.random_events,strict_canon=excluded.strict_canon,updated_at=CURRENT_TIMESTAMP`).run({...values,user_id:req.session.userId});res.json({ok:true,settings:values});
});

function getEndpoint(base,provider){const clean=String(base).replace(/\/+$/,'');if(provider==='ollama')return clean.replace(/\/v1$/,'')+'/api/chat';return clean.replace(/\/$/,'')+'/chat/completions';}
async function callModel(config,messages,params){
  const endpoint=getEndpoint(config.base_url,config.provider),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Number(process.env.AI_TIMEOUT_MS||240000));
  try{
    const isOllama=config.provider==='ollama';
    const body=isOllama?{model:config.model,messages,stream:false,options:{num_ctx:params.context_length,num_predict:params.max_tokens,temperature:params.temperature,top_p:params.top_p,repeat_penalty:params.repeat_penalty}}:{model:config.model,messages,temperature:params.temperature,top_p:params.top_p,max_tokens:params.max_tokens,presence_penalty:params.presence_penalty,frequency_penalty:params.frequency_penalty};
    const headers={'Content-Type':'application/json'};if(config.provider==='api'&&process.env.AI_API_KEY)headers.Authorization=`Bearer ${process.env.AI_API_KEY}`;
    const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});
    if(!response.ok){const detail=(await response.text()).slice(0,700);throw new Error(`Модель (${config.model}) вернула HTTP ${response.status}: ${detail}`);}
    const payload=await response.json();const content=isOllama?payload.message?.content:payload.choices?.[0]?.message?.content;
    if(typeof content!=='string'||!content.trim())throw new Error(`Модель ${config.model} вернула пустой текст. Проверьте модель и лимит ответа.`);
    return content.trim();
  }finally{clearTimeout(timer);}
}
const STYLE_RULES={
 balanced:'Стиль: естественная художественная проза, ясные описания, живые диалоги, умеренная детализация. Не перегружай текст метафорами.',
 creative:'Стиль: выразительная, образная, литературная проза. Используй оригинальные детали только если они логично следуют из мира и сцены. Не подменяй оригинальность туманной загадочностью.',
 precise:'Стиль: сдержанная, конкретная проза. Короткие точные описания, естественные диалоги, минимум метафор и минимум декоративных отступлений.'
};
function storyFacts(story){return `НАЗВАНИЕ: ${story.title}\nЖАНР: ${story.genre}\nОПИСАНИЕ МИРА И ЗАВЯЗКА:\n${story.description||'Не заданы.'}\nГЛАВНЫЙ ГЕРОЙ: ${story.protagonist||'Имя не задано.'}\nХАРАКТЕРИСТИКИ ГЕРОЯ:\n${story.protagonist_details||'Не заданы.'}\nПЕРСОНАЖИ:\n${JSON.stringify(story.characters,null,2)}\nЛОКАЦИИ:\n${JSON.stringify(story.locations,null,2)}\nСОБЫТИЯ И ФАКТЫ КАНОНА:\n${JSON.stringify(story.events,null,2)}`;}
app.post('/api/stories/:id/chat',requireAuth,aiLimiter,async(req,res)=>{
  try{
    const raw=db.prepare(storySelect).get(Number(req.params.id),req.session.userId);if(!raw)return res.status(404).json({error:'История не найдена.'});const story=normalizeStory(raw);
    const text=String(req.body.message||'').trim();if(!text||text.length>3000)return res.status(400).json({error:'Сообщение должно содержать от 1 до 3000 символов.'});
    const userSettings=db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(req.session.userId);if(!userSettings?.model)return res.status(400).json({error:'Сначала настройте модель Повествователя в разделе «Настройки ИИ».'});
    if(userSettings.provider==='api'&&!process.env.AI_API_KEY)return res.status(400).json({error:'Для внешнего API добавьте AI_API_KEY в .env на сервере.'});
    const settings={...publicAI(userSettings),...(story.ai_settings||{})};
    const messages=story.messages||[],history=messages.slice(-24).map(m=>({role:m.role,content:m.content}));
    const style=STYLE_RULES[settings.style]||STYLE_RULES.balanced;
    const responseTokens=settings.response_length==='short'?350:settings.response_length==='long'?1800:settings.max_tokens;
    const params={context_length:clamp(settings.context_length,2048,32768,8192),max_tokens:clamp(responseTokens,128,8192,900),temperature:clamp(settings.creativity,0,1,0.75),top_p:0.9,repeat_penalty:1.12,presence_penalty:0.15,frequency_penalty:0.2};
    let directorBrief='Режиссёр отключён пользователем. Следуй напрямую заданному канону и фактам.';
    if(settings.director_enabled){
      const directorConfig={provider:settings.director_provider||settings.provider,base_url:settings.director_base_url||settings.base_url,model:settings.director_model||settings.model};
      const canonRules=settings.strict_canon?'Считай описание мира и список фактов единственным источником канона. Не добавляй исторические эпохи, организации, технологии, географию, мистику или лор без основания. Не превращай неизвестное в тайну и не выдумывай загадочные земли, пророчества и силы.':'Соблюдай уже установленные факты. Допускай новые детали только если они правдоподобно вытекают из сцены и не противоречат описанию мира.';
      const directorPrompt=`Ты — РЕЖИССЁР интерактивной истории и редактор непрерывности. Ты НЕ пишешь художественный текст и НЕ отвечаешь игроку. Твоя задача — составить компактное рабочее ТЗ для Повествователя.\n\n${storyFacts(story)}\n\nЖЁСТКИЕ ПРАВИЛА:\n1. ${canonRules}\n3. Не переноси элементы из других произведений и реального мира в канон без основания. Соблюдай конкретный сеттинг.\n4. Не управляй главным героем: не придумывай его реплики, мысли, решения и действия.\n5. Персонажи должны говорить и действовать согласно указанным характерам и уже известным событиям.\n6. Отмечай противоречия и запрещённые домыслы.\n\nПоследние реплики:\n${history.slice(-10).map(m=>`${m.role}: ${m.content}`).join('\n')}\n\nДействие игрока сейчас: ${text}\n\nВерни краткий структурированный план на русском: ТЕКУЩАЯ СЦЕНА; ЧТО ДОЛЖНО ПРОИЗОЙТИ; РЕАКЦИИ NPC; ФАКТЫ, КОТОРЫЕ НЕЛЬЗЯ НАРУШАТЬ; ЧЕГО НЕ ДОБАВЛЯТЬ. Максимум 250 слов. Не пиши саму сцену.`;
      directorBrief=await callModel(directorConfig,[{role:'system',content:'Ты аналитический режиссёр интерактивной истории. Возвращай только план, без художественной прозы.'},{role:'user',content:directorPrompt}],{...params,max_tokens:500,temperature:0.2});
    }
    const canonNarratorRule=settings.strict_canon?'Не выдумывай лор ради атмосферы. Не вводи внезапные тайны, древние земли, пророчества, неизвестные силы, загадочные артефакты, организации или исторические события, если их нет в исходных данных или они не вытекают из сцены.':'Соблюдай установленные факты. Новые детали допустимы, если они естественно следуют из сцены и не противоречат уже заданному миру.';
    const narratorPrompt=`Ты — ПОВЕСТВОВАТЕЛЬ интерактивной ролевой истории. Пиши на русском языке.\n\n${storyFacts(story)}\n\n${style}\n\nПРАВИЛА ПОВЕСТВОВАНИЯ — ОБЯЗАТЕЛЬНЫЕ:\n- ${canonNarratorRule}\n- Запрещён приём искусственной загадочности: многоточия через каждое предложение, «нечто древнее», «что-то не так», «тайна, которую никто не мог объяснить», туманные намёки и пафосные недосказанности. Если персонаж знает факт — пусть говорит прямо. Если не знает — пусть честно скажет, что не знает.\n- Не добавляй в знакомые вселенные несуществующие элементы канона. Не приписывай персонажам предметы одежды, устройства, способности и привычки, которых нет в заданном каноне. При сомнении используй только то, что точно известно из контекста, либо не уточняй деталь.\n- Не повторяй одну и ту же мысль разными словами. Избегай шаблонных фраз, пафосных вступлений и искусственных cliffhanger-ов.\n- Не управляй героем игрока: не описывай его новые действия, реплики, мысли, чувства и решения. Описывай окружающий мир и других персонажей, затем оставляй пространство для ответа игрока.\n- Сохраняй характеры NPC, географию, временную линию и уже установленные факты. Не меняй внезапно имена, возраст, внешность, отношения и обстоятельства.\n- Диалоги должны звучать естественно и соответствовать ситуации. Не заставляй каждого персонажа говорить загадками.\n- Развивай именно текущую сцену. Не перескакивай на новые сюжетные арки без причины.\n- ${settings.simple_actions?'Предпочитай естественные и понятные действия персонажей без искусственной драматизации.':'Допускай более сложные действия, если они логичны для сцены.'}\n- ${settings.random_events?'Допускаются небольшие случайные события, но только правдоподобные и не меняющие канон.':'Не вводи случайные события без причины.'}\n- ${settings.adult_content?'Допускается взрослый тон в рамках закона и правил платформы.':'Избегай откровенного взрослого контента.'}\n\nПЛАН РЕЖИССЁРА (соблюдай, но не показывай пользователю):\n${directorBrief}\n\nПиши продолжение сцены. Обычно 2–5 абзацев, если ситуация не требует другого объёма. Не пересказывай действие игрока в начале ответа.`;
    const answer=await callModel({provider:settings.provider,base_url:settings.base_url,model:settings.model},[{role:'system',content:narratorPrompt},...history,{role:'user',content:text}],params);
    const updated=[...messages,{role:'user',content:text,at:new Date().toISOString()},{role:'assistant',content:answer,at:new Date().toISOString()}].slice(-100);
    db.prepare('UPDATE stories SET messages=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(updated),story.id);
    res.json({answer,messages:updated,director_used:Boolean(settings.director_enabled)});
  }catch(error){console.error('AI request failed:',error);const msg=error.name==='AbortError'?'Превышено время ожидания ответа модели. Уменьшите контекст или выберите более лёгкую модель.':error.message||'Не удалось связаться с ИИ.';res.status(502).json({error:msg});}
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log(`Narrative AI запущен: http://localhost:${PORT}`));
