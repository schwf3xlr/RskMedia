# Upgrade: ускорение мобильных повторных визитов

Одобрены две задачи из более широкого списка:

1. **`Cache-Control: immutable`** на медиа-прокси (P1 — быстро, минимум риска).
2. **Service Worker** для offline-кэша миниатюр (P0 — основной выигрыш).

Основная боль пользователя — «долговатая прогрузка карточек на телефоне». Обе эти правки бьют по **повторным визитам** (открытие страницы после первого раза, F5, возврат в PWA): миниатюры лежат либо в браузерном HTTP-кэше, либо в SW-кэше и не идут в сеть. Первый визит на новые медиа они существенно не ускорят — там нужны LQIP / pre-gen variants, которые пользователь пока НЕ одобрил.

Дальше — стек, точные файлы, готовые куски кода, тестирование и ловушки.

---

## Контекст проекта (для нового чата)

- **Стек:** Node.js 18+, Express 4, PostgreSQL (`pg`), S3-совместимое хранилище (Beget/AWS SDK v3), EJS (SSR, без SPA), ванильный JS с ES-модулями (без бандлера).
- **Ключевые файлы:**
  - `app.js` — bootstrap, middleware chain, CSP + nonce (Helmet), обработка `/sw.js`.
  - `routes/mediaProxy.js` — Range-aware S3-прокси с транcформациями (thumb / display / original / preview), in-memory LRU-кэш 5 MB × 500 записей, TTL 1 час.
  - `config/env.js` — валидированные env-константы. `env.isProd` = production-режим.
  - `helpers/logger.js` — pino-логгер.
  - `helpers/sseBroker.js` — Server-Sent Events (broadcast + per-token).
  - `public/js/main.js` — общий клиент API + events (SSE).
- **CSP** сейчас: `defaultSrc: 'self'`, `scriptSrc: 'self' 'nonce-…'`, `connectSrc: 'self'`, `imgSrc: 'self' data: blob: <S3_ORIGIN>`, `mediaSrc: 'self' <S3_ORIGIN>`. Никаких настроек SW специально не запрещает, но убедиться нужно — см. §2.
- **SSE-эндпоинт:** `GET /api/events` — long-poll `text/event-stream`. **Не должен перехватываться Service Worker'ом** (см. §2 «Ловушки»).
- **Медиа-эндпоинты, которые нужно кэшировать:**
  - `/media/thumb/:id` — миниатюра 400px
  - `/media/display/:id` — display-вариант 1920px
  - `/media/preview/:id` — 5-секундный анимированный WebP для hover на видео
  - `/media/original/:id` — оригинал (стоит кэшировать TOLько если запрашивается без Range, см. §2)

---

## §1. `Cache-Control: immutable` на медиа-прокси

**Файл:** `routes/mediaProxy.js`  
**Оценка работы:** 5 минут.

### Что менять

Найти строку, где ставится `Cache-Control` — сейчас:

```js
res.setHeader('Cache-Control', `public, max-age=${CACHE_TTL_S}`);
```

где `CACHE_TTL_S = 3600`.

Заменить на:

```js
// max-age до 30 дней + immutable. Ключи S3 — UUID: контент по одному key
// никогда не меняется, значит клиенту нет смысла ходить даже за 304.
// immutable говорит браузеру "не проверяй актуальность внутри max-age".
// Экономит сотни RTT'ов при быстрой прокрутке галереи на повторных
// заходах — миниатюры берутся из disk cache без единого запроса.
const IMMUTABLE_MAX_AGE = 30 * 24 * 60 * 60; // 30 дней
res.setHeader('Cache-Control', `public, max-age=${IMMUTABLE_MAX_AGE}, immutable`);
```

Константу `CACHE_TTL_S` можно оставить как есть (она используется в других местах — in-memory LRU в прокси; это разный кэш, речь только про HTTP-заголовок клиенту).

### Почему это безопасно

Ключи S3 в проекте генерируются через `uuid()` при загрузке. Обновление медиа = ЗАМЕНА строки в БД на новый row с новым `s3_key`. Клиент по адресу `/media/thumb/:id` получит новую миниатюру, потому что endpoint читает актуальный `thumbnail_s3_key` из БД. Если админ поменяет thumbnail — старый ключ уходит вместе со старой строкой (см. `mediaController.delete`).

**Кейс, который надо проверить:** есть ли в проекте способ обновить `thumbnail_s3_key` у существующего медиа (не удаляя и не создавая заново). Смотри `models/media.update` — там `phash` автоматически сбрасывается при смене `thumbnail_s3_key`. Если админ через UI меняет миниатюру существующего медиа — новая миниатюра будет в S3 под новым UUID (см. `processFile`). Значит по URL `/media/thumb/:id` клиент получит редирект/новую байтовку.

Но: **клиент к тому времени уже держит СТАРУЮ миниатюру в браузерном кэше на 30 дней** (`Cache-Control: immutable`). Он не перепроверит.

Если это критичный сценарий (админ часто переgeneriert миниатюры) — держи в уме и, возможно, повысь `max-age` только до 1-7 дней. Для типовой галереи 30 дней — безопасно.

### Проверка

1. Открой сайт → DevTools → Network → любая миниатюра. В response headers должен быть `cache-control: public, max-age=2592000, immutable`.
2. F5 страницы: миниатюры отдаются со статусом **`(memory cache)`** или **`(disk cache)`**, без сетевого хода.
3. Ждать 3600 сек не нужно — immutable должно сразу же остановить 304-запросы. Раньше при `max-age=3600` браузер после часа шёл 304-проверять; теперь — не идёт до 30 дней.

---

## §2. Service Worker для offline-кэша миниатюр

**Файлы:**
- Создать: `public/sw.js` (новый).
- Изменить: `app.js` — убрать inline-заглушку `/sw.js`.
- Изменить: `public/js/main.js` — добавить регистрацию SW.

**Оценка работы:** 40-60 минут вместе с тестированием.

### Что сейчас

В `app.js` есть роут `/sw.js`, отдающий inline-скрипт, который **деинсталлирует старые Service Workers**:

```js
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
    self.addEventListener('install', e => { e.waitUntil(self.skipWaiting()); });
    self.addEventListener('activate', e => {
      e.waitUntil(Promise.all([
        self.clients.claim(),
        self.registration.unregister()
      ]));
    });
    self.addEventListener('fetch', e => {
      if (new URL(e.request.url).origin !== self.location.origin) return;
      e.respondWith(fetch(e.request));
    });
  `);
});
```

**Убрать этот роут целиком.** SW теперь будет отдаваться как обычный статик-файл из `public/sw.js` (express.static перехватит запрос до Express-роутов ниже, потому что static-middleware зарегистрирован раньше).

### Файл `public/sw.js`

```javascript
// Service Worker: cache-first для миниатюр/display/preview медиа-прокси,
// stale-while-revalidate для статики (CSS/JS), network-only для API.
//
// Стратегия: миниатюры лежат под UUID-ключами и never-invalidate, поэтому
// смело кэшируем на 30 дней. При смене CACHE_VERSION старые кэши очищаются
// в activate.
//
// НЕ трогаем:
//  - /api/*                — network only, авторизация может протухнуть
//  - /api/events           — SSE stream, MUST bypass (см. ниже)
//  - Range-запросы         — SW не умеет partial content, отправляем в сеть
//  - Cross-origin          — S3, Google Fonts и т.п.

const CACHE_VERSION = 'v1';
const MEDIA_CACHE = `rskmedia-media-${CACHE_VERSION}`;
const STATIC_CACHE = `rskmedia-static-${CACHE_VERSION}`;

// Что кэшируем немедленно при install. Только то, что 100% нужно на
// повторном визите. НЕ включаем страницы (/), потому что они сессионные:
// EJS рендерится с csrfToken/nonce/user-type, кэш быстро протухнет.
const PRECACHE_URLS = [
  '/css/base.css',
  '/css/layout.css',
  '/css/components.css',
  '/css/pages.css',
  '/css/style.css',
  '/js/lucide.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // Precache не критичен для работы
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Удаляем чужие кэши (от старых версий SW).
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k !== MEDIA_CACHE && k !== STATIC_CACHE)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Cross-origin — не трогаем (S3, Google Fonts, аналитика).
  if (url.origin !== self.location.origin) return;

  // 2. Только GET кэшируется. POST/PUT/DELETE — passthrough в сеть.
  if (req.method !== 'GET') return;

  // 3. SSE (/api/events) — MUST bypass, иначе поток обрывается.
  //    Проверяем по Accept: text/event-stream, а не по URL, чтобы не завязываться
  //    на конкретный path — если в проекте появится второй SSE эндпоинт, он
  //    тоже не сломается.
  if (req.headers.get('accept')?.includes('text/event-stream')) return;

  // 4. Range-запросы (видео с перемоткой) — SW не умеет отдавать 206
  //    Partial Content из кэша. Отправляем в сеть напрямую.
  if (req.headers.get('range')) return;

  // 5. API — network only (никогда не кэшируем ответы, авторизация/CSRF).
  if (url.pathname.startsWith('/api/')) return;

  // 6. Медиа-прокси — cache-first.
  //    /media/thumb/*, /media/display/*, /media/preview/*: ключи S3 UUID,
  //    контент never-invalidate — держим 30 дней.
  //    /media/original/* НЕ кэшируем: файлы могут быть большими (десятки MB),
  //    забьют квоту quota. Оригинал открывается редко (только при клике на
  //    "оригинал"), пусть идёт в сеть.
  const isCacheableMedia = url.pathname.startsWith('/media/thumb/')
    || url.pathname.startsWith('/media/display/')
    || url.pathname.startsWith('/media/preview/');

  if (isCacheableMedia) {
    event.respondWith(cacheFirst(req, MEDIA_CACHE));
    return;
  }

  // 7. Статика (CSS/JS) — stale-while-revalidate: отдаём из кэша если есть,
  //    параллельно обновляем в фоне. Так пользователь не ждёт сетевого
  //    round-trip даже на первой загрузке, но и не застревает на старой
  //    версии после деплоя.
  if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // 8. Всё остальное (страницы EJS) — network only, чтобы не отдавать stale
  //    HTML с протухшим csrfToken/nonce/user-type.
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const response = await fetch(req);
    // Не кэшируем ошибки — иначе транзиентный 500 залипнет на 30 дней.
    if (response.ok) {
      // clone() потому что body — one-shot stream.
      cache.put(req, response.clone());
    }
    return response;
  } catch (err) {
    // Оффлайн + нет в кэше = ошибка сети. Отдаём заглушку 504, клиент
    // покажет свой skeleton/error state.
    return new Response('Offline', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);

  // Фоновое обновление — не await'им.
  const networkPromise = fetch(req).then((response) => {
    if (response.ok) cache.put(req, response.clone());
    return response;
  }).catch(() => null);

  return cached || (await networkPromise) || new Response('Offline', { status: 504 });
}
```

### Регистрация SW в `public/js/main.js`

Добавить в самый низ файла (или сразу после экспорта, до навешивания listener'ов):

```javascript
// Регистрируем Service Worker для offline-кэша миниатюр (см. public/sw.js).
// Только когда браузер поддерживает и HTTPS/localhost (SW требует secure
// context). Ошибки не критичны — сайт работает и без SW.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}
```

### Изменения в `app.js`

**1. Удалить inline-`/sw.js` роут** (тот блок с `app.get('/sw.js', ...)`).

Раньше он деинсталлировал старые SW. Теперь заменяем на реальный SW — старые версии переустановятся в новую, потому что браузер увидит изменённый `/sw.js`.

**2. Убедиться, что static-middleware отдаёт `sw.js` без специальных заголовков.** Сейчас в `app.js`:

```js
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: env.isProd ? '1d' : 0,
}));
```

`maxAge: '1d'` в prod — это плохо для sw.js: браузер закэширует старую версию SW на сутки и не подтянет обновление. Добавить `setHeaders`:

```js
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: env.isProd ? '1d' : 0,
  setHeaders: (res, filepath) => {
    // sw.js — must-revalidate, чтобы новые версии SW доходили до клиента
    // максимум через один RTT. Иначе пользователь застрянет на старом
    // SW на сутки после деплоя.
    if (filepath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
```

### Ловушки, которые ЛОМАЛИ похожие фичи в других проектах

1. **SSE перехватывается SW → поток обрывается.** Обязательно skip'нуть по `Accept: text/event-stream` (реализовано в примере выше). Если сломается — увидишь в logs частые reconnect'ы SSE каждые 5 сек.

2. **Range-запросы + cache-first = битые видео.** SW не умеет 206 Partial Content из cached full Response. При попытке перемотать видео — плеер сломается. Обязательно skip'нуть по наличию `Range` header. Плюс `mediaSrc: 'self' <S3_ORIGIN>` в CSP уже правильный.

3. **CSP `worker-src`.** SW file — воркер, но CSP по-умолчанию берёт `worker-src` из `script-src`. У тебя `scriptSrc: 'self' 'nonce-…'`. Nonce на sw.js не выдаётся (это static file). Проверить в консоли: если увидишь `Refused to create a worker … 'nonce-…' is specified via CSP` — добавить `workerSrc: ["'self'"]` в `buildCspDirectives()` в `app.js`.

4. **Старый SW залипает на sutki.** Даже с `Cache-Control: no-cache` на sw.js (как выше) — иногда браузер держит старый. Способ форсировать обновление: bump `CACHE_VERSION` в `public/sw.js` (`v1` → `v2`) при существенных изменениях самого файла SW. Тогда `activate` удалит старые кэши.

5. **Precache упал — SW не установился.** В моей реализации есть `.catch(() => self.skipWaiting())` — precache best-effort. Иначе одна недоступная CSS-файла заблокирует всю установку.

6. **Кэш переполнен на телефоне.** Chrome по-умолчанию даёт ~6% дискового пространства под caches. При 10 000 миниатюр по ~30 KB = 300 MB — влезет. Но если кто-то откроет display-варианты 100+ раз (по 200 KB) — начнётся eviction. Мониторить через DevTools → Application → Cache Storage. Если нужно — добавить хендлер `quotaexceeded` и очистку старых записей (LRU), но пока не критично.

7. **Deployment invalidation.** При релизе новой версии CSS: `stale-while-revalidate` отдаст сначала старую CSS (мгновенно), потом на фоне обновит. Пользователь увидит новую CSS **со следующей** загрузки — задержка на 1 сессию. Для критических правок можно вручную bump `CACHE_VERSION` в sw.js.

### Проверка

**Первый визит (после deploy):**
1. Открыть сайт в чистом браузере (в incognito).
2. DevTools → Application → Service Workers → должно быть «activated and running».
3. DevTools → Application → Cache Storage → должны появиться `rskmedia-static-v1` (с CSS/JS) и `rskmedia-media-v1` (наполнится когда прокрутишь галерею).

**Второй визит:**
4. Обычная вкладка → сайт → пролистай галерею → закрой вкладку → открой заново.
5. DevTools → Network. Все запросы к `/media/thumb/*` должны быть со статусом **`(ServiceWorker)`** и **временем < 5 мс**.
6. Прокрутка галереи должна быть заметно быстрее — карточки появляются мгновенно, без «серых квадратов».

**Offline test:**
7. DevTools → Network → Offline → F5. Страница-шелл не отдастся (мы не кэшировали HTML), но если у тебя открыта модалка с ранее просмотренным медиа — картинка покажется из SW-кэша. Это подтверждает что медиа-кэш работает.

**Реальный мобильник:**
8. Chrome на Android: `chrome://serviceworker-internals` → искать `rskmedia`.
9. Safari на iOS: Settings → Safari → Advanced → Website Data → искать домен. Клик по нему покажет размер кэша (по мере наполнения — растёт).
10. Второй заход на страницу галереи после первого — визуально миниатюры должны появиться значительно быстрее.

---

## Порядок работ (рекомендованный)

1. **Immutable cache** (§1) — одна строка в `mediaProxy.js`. Задеплоить, проверить в DevTools → Network → cache-control правильный. Уже после этого повторные визиты станут быстрее (за счёт браузерного HTTP-кэша).
2. **Service Worker** (§2) — создать `public/sw.js`, регистрация в `main.js`, убрать inline-роут из `app.js`. Задеплоить. Проверить registration, потом полистать галерею, потом F5 → миниатюры из SW. Обязательно потестить на **реальном мобильнике**, а не в DevTools Device Mode.
3. **Bump CACHE_VERSION** при любом изменении sw.js — иначе клиенты застрянут на предыдущей версии.

---

## Что специально НЕ делать (согласовано с пользователем)

- **LQIP** (base64-миниатюры для мгновенного отображения) — отклонено.
- **Pre-generate вариантов ширины** при загрузке — отклонено.
- **Tree-shake Lucide** — отклонено.
- **Никаких новых функциональных фич** (теги, share-links, batch-выделение и т.п.) — отклонено.

Если после этих двух работ пользователь скажет «первый визит на новую страницу всё ещё медленный» — это ожидаемо. Возвращаться к LQIP + pre-gen variants, они как раз ускоряют **первый** визит.

---

## Замечание для будущего (не в scope)

Пользователь сказал: «пока А, но планирую расширять для продажи», «сейчас Б медиа, возможно В в будущем».

Когда будет реально много медиа (10K+) и несколько платных пользователей — стоит вернуться к:

- **`variants JSONB` + pre-generation** — критично для CPU-нагрузки сервера при массе одновременных пользователей (сейчас каждый уникальный `?w=NNN` крутит sharp).
- **Share-link коллекций** — для «показать друзьям без выдачи токена».
- **Активные сессии + revoke** — для «продажной» модели каждый юзер захочет управлять своими девайсами.
- **Audit-log** — как только пользователей несколько, полезно видеть кто что менял.

Это всё **вне текущего апгрейда**, просто памятка чтобы не потерять контекст при возврате.
