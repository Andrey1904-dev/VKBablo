# GitHub Pages: production-сборка и белый экран

## Единственный источник публикации

В **Settings → Pages → Build and deployment → Source** должно быть **GitHub Actions**.
Единственный издатель — `.github/workflows/pages.yml`: Vite → `dist` →
`upload-pages-artifact` → `deploy-pages`. Не включайте **Deploy from a branch**
(`main /`, `docs`, `gh-pages`): исходный `index.html` с `/src/*.tsx` не является
production-сборкой. GitHub Pages не компилирует TypeScript/React через Jekyll.

Настройка Source выполняется один раз администратором, а не во время каждого
деплоя. Workflow теперь только читает её и останавливается с явной ошибкой,
если `build_type != workflow`. У build-job только `pages: read`; права публикации
и OIDC есть только у единственного deploy-job. `configure-pages` используется
без `enablement: true` и не должен менять источник.

`pages-build-deployment` — системный dynamic workflow, не второй YAML-файл
репозитория. Его старая запись/старые runs могут оставаться видимыми в Actions.
Критерий отсутствия конфликта — **нет новых Jekyll build/deploy для новых
push в main**, а не исчезновение исторической записи из интерфейса Actions.
Если такой run всё ещё появляется, администратор должен проверить Source,
отключить веточную публикацию и убедиться, что нет других издателей Pages.
Не запускайте/не перезапускайте старые Jekyll runs.

## Что было проверено 2026-10-14

- REST Pages показывает `build_type: workflow`, URL
  `https://andrey1904-dev.github.io/VKBablo/`. Поле `source: main /` остаётся в
  ответе как веточная конфигурация; само по себе оно не означает, что сейчас
  выбран веточный режим.
- Для коммита `b7f137082314b2bc78228e6749af20d74378e3a3` были два успешных деплоя
  в одно окружение `github-pages`:
  - Vite: run `38616364809`, deployment `7073975891`;
  - Jekyll: run `38616363843`, deployment `7073976033`.
  REST jobs подтверждает шаг `Build with Jekyll` у второго процесса.
  Последовательность публикации/CDN нельзя признать безопасной, даже когда оба
  процесса зелёные. Из workflow удалён безусловный PUT настройки Source,
  выполнявшийся на каждом push.
- Попытки изменить Pages через REST и отключить dynamic workflow из этой
  сессии получили **403 Resource not accessible by integration**. Настройки
  удалённого репозитория этим PR не считаются изменёнными. Source уже workflow;
  после merge необходимо проверить отсутствие новых dynamic/Jekyll деплоев.
- Production-сборка до исправления реально рендерила login/dashboard при
  доступном хранилище, но после входа оставляла пустой React root при
  `SecurityError` чтения localStorage или `QuotaExceededError` записи sidebar.
  Воспроизведено в Chromium через Playwright. Предпочтения теперь необязательны:
  ошибки чтения/записи не мешают React, состояние продолжает жить в памяти.
- Pages base остаётся `/VKBablo/`, маршруты — hash. JS/CSS/favicon/avatars
  сохраняют префикс. Preview Pages запускается с тем же `GITHUB_PAGES=true`,
  иначе сам Vite preview с корневым base может давать ложные 404 для assets.
- Добавлены статический загрузочный экран, обработка ошибки загрузки React
  chunk и React error boundary с кнопкой обновления. Они не очищают данные,
  не выводят секреты и не переключают production Supabase в demo.
- Supabase, `getBackend()`, backend selection и новый дизайн сохранены.
  Только отдельный `build:pages` фиксирует demo, как и предыдущий Pages workflow.

## Проверки

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run build:pages
npx playwright install --with-deps chromium webkit
npm run test:browser
```

Playwright запускает **production artifact**, не dev server:

- desktop Chromium, mobile Chromium и iPhone 13 / WebKit;
- видимые login и dashboard, CSS-стили и stats grid;
- доступное, запрещённое и переполненное localStorage;
- сохранённая сессия, hash navigation и reload вложенного маршрута;
- JS/CSS: статус, MIME и `/VKBablo/assets/`, console errors, page errors,
  failed requests — одного HTTP 200 недостаточно;
- локальное fault injection: ошибка загрузки React chunk и исключение render.

После публикации `verify-live` выполняет те же успешные сценарии с
`PAGES_URL` и проверяет meta `vkbablo-build` на SHA текущего коммита.
До 2 минут ждёт распространения новой ревизии через CDN; старая рабочая
страница не считается успешной проверкой нового деплоя. Отчёты, screenshots
и traces сохраняются как artifacts Actions (7 дней).

Тесты используют изолированный браузерный demo-owner и read-only навигацию.
Внешние/API запросы блокируются; генерация, worker и публикация не запускаются.
Google Fonts заменяются пустым CSS: отсутствие внешних шрифтов не должно
мешать отображению системными шрифтами.

### Граница локальной проверки

В sandbox разрешён доступ лишь к ограниченному списку хостов. Прямой запрос
к `github.io` и установка WebKit с CDN Playwright заблокированы. Поэтому локально
проверен настоящий Chromium (включая мобильный viewport), **не Safari и не
физический iPhone**. WebKit выполняется на GitHub-hosted runner в CI/Pages.
Проверка живой новой ревизии выполняется только после её merge/deploy; до этого
нельзя утверждать, что опубликованный сайт уже исправлен.
