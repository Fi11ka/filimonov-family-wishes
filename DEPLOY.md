# Бесплатная публикация: GitHub Pages + Cloudflare Workers + D1

Подготовлено для `anastasiacopodevinho/filimonov-family-wishes` и уже существующего бота `@FilimonovFamilyWishes_bot`. Если выберете другой репозиторий или аккаунт, измените URL в шаге 3. Секрет бота не передавайте в чат, GitHub, исходники или Vite-переменные.

## 0. Что уже подготовлено и где остановлена публикация

Локально есть код интерфейса и Worker, схема D1, миграция, тесты и workflow GitHub Pages. Реальная удалённая D1 ещё не создана, в конфиге стоит нулевой `database_id`. Удалённый репозиторий, Pages, Worker и подключение к боту требуют действий владельца аккаунтов. Не считайте приложение опубликованным до выполнения приёмки в конце.

## 1. Инструменты и бесплатные аккаунты

1. Используйте свой GitHub и бесплатный аккаунт [Cloudflare](https://dash.cloudflare.com/). Не включайте Workers Paid, не добавляйте платёжные реквизиты и платные дополнения. Не покупайте домен: будут `github.io` и `workers.dev`.
2. Установите Node.js 24 LTS с [nodejs.org](https://nodejs.org/), затем `npm install --global pnpm@11.25.0`.
3. В терминале перейдите в папку проекта:

```sh
cd '/Users/admin/Documents/Вишлисты'
pnpm install --frozen-lockfile
pnpm test
pnpm build
```

## 2. Создать постоянную D1

Выполните:

```sh
pnpm exec wrangler login
pnpm exec wrangler d1 create family-wishes
```

Первой командой откроется авторизация Cloudflare: войдите самостоятельно и разрешите Wrangler работать с вашим аккаунтом. Если предлагается платный тариф — остановитесь: он не нужен. Если имя базы занято, используйте существующую базу только если она предназначена для этого приложения; не применяйте миграции к чужой базе.

Сохраните `database_id` из результата создания. Это публичный идентификатор, не секрет. Если Cloudflare просит создать `workers.dev` subdomain, выберите бесплатный поддомен в Workers & Pages. Планируемый API URL: `https://filimonov-family-wishes-api.<ваш-поддомен>.workers.dev`.

## 3. Заполнить конфигурацию

```sh
pnpm run setup
```

Введите три **несекретных** значения:

- D1 `database_id` из предыдущего шага;
- `https://anastasiacopodevinho.github.io/filimonov-family-wishes/`;
- полный Worker URL на `workers.dev`.

Скрипт обновит `wrangler.jsonc` и локальную игнорируемую `.env.local`. В конфиге `APP_ORIGIN` будет `https://anastasiacopodevinho.github.io` без пути; `APP_URL` — полный URL с именем репозитория. Не добавляйте `BOT_TOKEN` в эти файлы. При другом аккаунте GitHub введите соответствующий Pages URL.

## 4. Миграция и первая публикация API

```sh
pnpm db:remote
pnpm deploy:api
pnpm exec wrangler secret put BOT_TOKEN
```

Третья команда попросит секрет со скрытым вводом. Вставьте токен **существующего** бота из BotFather в этот запрос терминала. Альтернатива без терминала: Cloudflare → Workers & Pages → `filimonov-family-wishes-api` → Settings → Variables and Secrets → Add → тип **Secret**, имя `BOT_TOKEN`, значение токена → Deploy. Это runtime secret, не Build variable.

Не меняйте webhook и не удаляйте существующие настройки бота: Mini App работает через WebApp SDK без нового webhook. На `/start` уже существующая логика бота продолжит работать.

Проверьте в браузере `https://filimonov-family-wishes-api.<ваш-поддомен>.workers.dev/api/health`: ответ должен содержать `"ok":true`. Затем проверьте, что запрос `/api/me` без входа возвращает 401, а не 500/503. Это подтверждает, что секрет настроен и случайный посетитель не получает профиль.

## 5. Публичный GitHub-репозиторий

Бесплатный GitHub Pages для такого проекта требует **public** репозиторий. Опубликуется исходный код; личные списки, реальные фото и брони хранятся в закрытой D1 и в Git не попадают.

Откройте [создание репозитория](https://github.com/new), выберите владельца `anastasiacopodevinho`, имя `filimonov-family-wishes`, видимость **Public**. Не добавляйте README, .gitignore и license: файлы уже подготовлены локально. Нажмите Create repository.

В локальной папке уже подготовлен Git-репозиторий. Проверьте его и отправьте:

```sh
git status
git add .
git commit -m "Configure production Cloudflare D1 and URLs"
git remote add origin https://github.com/anastasiacopodevinho/filimonov-family-wishes.git
git push -u origin main
```

Если коммитить нечего, пропустите `git commit`. Если remote уже есть, не добавляйте второй: проверьте `git remote -v`. При запросе авторизации GitHub войдите привычным способом через credential manager или GitHub CLI. Токен бота здесь никогда не нужен. Не используйте пароль аккаунта как Git-пароль. Альтернатива: GitHub Desktop → Add existing repository → Publish repository с public видимостью.

## 6. Автодеплой Worker с секретами только в Cloudflare

Чтобы не хранить Cloudflare API token в GitHub Secrets, используйте [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/):

1. Cloudflare → Workers & Pages → `filimonov-family-wishes-api` → Settings → Builds → Connect Git repository.
2. Подключите только репозиторий этого приложения. Если Cloudflare просит новое разрешение GitHub, предоставьте доступ к выбранному репозиторию, не ко всем.
3. Production branch: `main`; Root directory: `/`.
4. Build command: `pnpm install --frozen-lockfile && pnpm test && pnpm build`.
5. Deploy command: `pnpm run deploy`.
6. Node version: `24`. Если окружение требует явного выбора, задайте Build variable `NODE_VERSION=24`. `WORKERS_CI` Cloudflare задаёт автоматически.
7. Автоматически создаваемому Cloudflare Builds API token дополнительно нужны права **Account → D1 → Edit** на ваш аккаунт для миграций. Откройте Cloudflare → My Profile → API Tokens → найдите token Workers Builds → Edit → добавьте это право. Если редактирование недоступно, создайте токен в Cloudflare с Workers Scripts Edit, D1 Edit, Account Settings Read и используйте его в настройке Builds API token. Значение не переносите в GitHub или исходники.
8. Выключите автоматический production-деплой сторонних веток. Не применяйте миграции к production базе из preview-сборок. При необходимости preview-команды используйте `pnpm exec wrangler versions upload`, без миграций и продвижения в production; пользователям выдавайте только production URL.
9. Запустите первый build и проверьте успешную миграцию и deploy. `pnpm run deploy` проверяет реальные параметры D1, применяет только новые миграции и публикует Worker.

Cloudflare Free даёт ограниченный бюджет минут сборки, которого обычно достаточно для редких семейных обновлений. При исчерпании дождитесь сброса или запускайте `pnpm db:remote` и `pnpm deploy:api` со своего компьютера. Не включайте платный тариф. Runtime secret `BOT_TOKEN` сохраняется при обновлении кода.

## 7. GitHub Pages и автопубликация интерфейса

1. Репозиторий → Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Settings → Secrets and variables → Actions → вкладка **Variables**, не Secrets.
3. Добавьте `VITE_API_URL` = ваш полный Worker URL, без `/api`, например `https://filimonov-family-wishes-api.family.workers.dev`.
4. Добавьте `PUBLISH_READY` = `true` **после** настройки D1, Worker и `BOT_TOKEN`.
5. Actions → **GitHub Pages** → Run workflow → `main`.
6. Проверьте, что тесты, preflight и deploy прошли. Откройте URL из deploy job, ожидаемый адрес: `https://anastasiacopodevinho.github.io/filimonov-family-wishes/`.

`PUBLISH_READY` предотвращает случайную публикацию неподключённого интерфейса. `preflight` проверяет настоящий ID базы и health API. Это не заменяет ручную проверку Telegram-входа. Следующий push в main автоматически проверит код и обновит Pages; Cloudflare Builds независимо обновит API. Для несовместимых изменений API сначала сохраняйте обратную совместимость, затем меняйте клиент: деплои двух провайдеров не атомарны.

Не задавайте переменные `VITE_BOT_TOKEN`, `VITE_SECRET` и подобные: любые `VITE_*` попадают в публичный JavaScript.

## 8. Подключить существующего бота в BotFather

1. Откройте проверенного [@BotFather](https://t.me/BotFather) в Telegram.
2. Отправьте `/mybots`, выберите `@FilimonovFamilyWishes_bot`.
3. Bot Settings → **Configure Mini App** / **Main Mini App** (названия пунктов могут отличаться в клиенте) → Enable / Edit URL. Укажите полный GitHub Pages URL из шага 7.
4. Включите Main Mini App. Именно эта настройка обеспечивает ссылки вида `https://t.me/FilimonovFamilyWishes_bot?startapp` и гостевые `?startapp=g_...`. Если в меню нет пункта, используйте `/newapp` для named Mini App только после адаптации генерируемых ссылок в `src/api.ts` и `worker/index.ts` к `/appname?startapp=...`; предпочтителен Main Mini App без appname.
5. Настройте меню: `/setmenubutton` → выберите того же бота → укажите URL Pages → текст кнопки `Наши желания`. В некоторых версиях BotFather это Bot Settings → Menu Button → Configure menu button.
6. При желании задайте название `Filimonov Family Wishes`, описание и аватар бота. Новый бот не нужен. `/setdomain` для данного WebApp-входа не требуется: это другая настройка для Telegram Login Widget.
7. Откройте профиль бота и нажмите **Open App / Открыть приложение** или кнопку меню **Наши желания**. Открытие обычной веб-ссылки в браузере покажет приглашение войти через Telegram, а не поддельную авторизацию.

Пример официального формата ссылки: [Telegram Mini Apps](https://core.telegram.org/bots/webapps#direct-link-mini-apps). Передача `initData` и проверка подписи реализованы по [официальному алгоритму Telegram](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).

## 9. Приёмка перед семейным использованием

С двумя Telegram-аккаунтами и браузером:

1. Первый аккаунт открывает бота, создаёт семью, добавляет подарок с фото, ценой, ссылкой и приоритетом. Закрывает Mini App и снова открывает: данные сохраняются.
2. Второй аккаунт вступает по коду, видит подарок первого, бронирует его. У второго появляется «Отменить бронь», первый после обновления не видит никаких изменений статуса.
3. Второй отменяет бронь: подарок снова можно выбрать. Первый редактирует и удаляет свои желания; второй не может их изменять.
4. Первый создаёт гостевую ссылку. В обычном браузере виден только этот список без статусов. Во втором/третьем Telegram-аккаунте вне семьи можно забронировать, не вступая в семью.
5. Отзовите гостевую ссылку. Повторное открытие и новые брони по ней недоступны; ранее сделанную бронь даритель может отменить в «Мои брони».
6. Два разных читателя одновременно нажимают «Подарю!» на одном подарке: выигрывает только один, другой видит сообщение о недоступности и обновлённый статус.
7. Проверьте iOS и Android: фото, клавиатуру формы, выбор картинки, прокрутку модального окна, ссылки магазинов и копирование гостевой ссылки.

## Бесплатные ограничения и резервные копии

На 24 октября 2026 официально указаны:

| Сервис | Free |
| --- | --- |
| GitHub Pages | Публичный репозиторий на GitHub Free |
| Workers | 100 000 запросов в день, 10 мс CPU/запрос |
| D1 | 5 млн прочитанных строк и 100 тыс. записанных строк в день |
| D1 размер | 500 МБ на одну БД, до 5 ГБ на аккаунт |
| D1 Time Travel | 7 дней |

Источники: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). Лимиты провайдеров могут меняться. Фотографии занимают большую часть размера базы: приложение сжимает их и не хранит оригиналы. 500 МБ достаточно примерно для нескольких тысяч небольших фотографий, точное число зависит от размера и служебных данных.

Workers не требует постоянно работающего процесса и не имеет периода искусственного «сна», который нужно предотвращать пингами. Это serverless: запуск на запрос, возможны обычные сетевые задержки и cold start. Нельзя обещать абсолютное отсутствие задержек или SLA на бесплатных тарифах.

Бесплатный ручной экспорт:

```sh
mkdir -p backups
pnpm exec wrangler d1 export family-wishes --remote --output=backups/family-wishes.sql
```

Папка backups игнорируется Git. Скопируйте файл в своё защищённое хранилище. Для восстановления сначала создайте отдельную D1 и проверьте импорт, затем переключите binding; не затирайте действующую базу без резервной копии. Старую миграцию после публикации не изменяйте: добавляйте `0002_...sql`.

## Если что-то не работает

- «Не удалось подтвердить вход»: неверный `BOT_TOKEN` или запуск из другого бота. Проверьте secret; не отправляйте токен в GitHub issues.
- «Время входа истекло»: закройте и заново откройте Mini App. Срок initData — час.
- CORS: `APP_ORIGIN` без пути должен совпадать с origin Pages. После изменения домена обновите Worker и пересоберите клиент с новым API URL.
- `NOT_CONFIGURED`: runtime secret не добавлен или не развёрнут. Build secret не заменяет runtime secret.
- `INTERNAL` сразу после настройки: проверьте ID D1, binding `DB` и применение миграций.
- Pages 404: Pages source должен быть GitHub Actions, URL включает имя репозитория и завершающий `/`.
- В браузере нет имени Telegram: это ожидаемо; войдите через бота.
- Гостевая ссылка открывает чат, а не приложение: включите **Main Mini App** в BotFather.
- Невозможно прочитать HEIC: экспортируйте фото как JPEG/PNG.
- Бронь не отменяется после удаления самого подарка: владелец удалил желание вместе с бронью, обновите «Мои брони».
