# analytics-frontend-meta

Метатеги и PNG-превью для WotStat. Bun и Chromium работают в Docker.

Перед запуском выполни `bun run build` в `analytics-frontend` — бэкенд использует `../analytics-frontend/dist-meta`.

```sh
./rerun.sh      # запуск / перезапуск в фоне
./rerun-dev.sh  # dev в фоне, с перезапуском при изменении исходников
bun run dev    # dev с логами в терминале
```

Локальный адрес: http://localhost:9110.
После пересборки фронтенда повторно запусти соответствующий `rerun`-скрипт.

Статику из `dist/` раздаёт Nginx, HTML и OG — Bun. Картинки: `og.wotstat.info/analytics/image.png`. Конфиги Nginx — в [server-config](../server-config/etc/nginx/).

CI по push в `main` или вручную копирует проект на сервер и запускает `rerun.sh`. Нужны variable `APP_PATH` = `/app/wotstat/og-meta` и secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY`.

На время миграции метатеги и PNG включены только для `*/debug/*`. Остальные страницы получают исходный HTML без изменений, а запросы их PNG — 404.

## ClickHouse и общий кеш

Production renderer обращается к `/api/db/` на своём локальном сервере Bun.
Bun добавляет авторизацию `internal-public` и отправляет запрос на
`http://host.docker.internal:8124/` — внутренний вход Nginx на основном сервере.
Этот вход использует тот же кеш, что и публичный сайт. Пароль остаётся в Bun;
он не входит в JS, HTML, URL или контекст карточки.

Перед включением запросов:

1. Применить `server-config/clickhouse/migrate-public-reader.sql`, затем
   `create-internal-public.sql` с параметром `internal_public_password`.
2. Обновить кеши основного Nginx, RU и Cloudflare по `server-config/README.md`.
   Включить `etc/nginx/sites-available/internal-db` на основном сервере.
   В firewall хоста разрешить входящий TCP из `172.31.0.0/16` к адресу
   `host.docker.internal` на порту 8124 (правило UFW — в `server-config/README.md`).
   Проверить `SELECT 1` с авторизацией из контейнера: HTTP 200 и `1`.
3. Скопировать `.env.example` в `.env` и записать тот же пароль в
   `CLICKHOUSE_PASSWORD`. `.env` исключён из Git. Адрес Nginx задан в
   `docker-compose.yaml`, адрес для разработки — в `docker-compose.dev.yaml`.
4. Пересобрать frontend и перезапустить контейнер. Его подсеть — `172.31.0.0/16`;
   в ClickHouse добавлять её не нужно: к БД подключается локальный Nginx.

Dev Compose и запуск Bun без переменных ClickHouse используют публичный endpoint
под `public`, поэтому студия и локальный renderer работают без серверного пароля.
В production отсутствие/ошибка пароля позволяет читать публичный HIT, но MISS
завершится ошибкой авторизации ClickHouse. Автоматической подмены на `public` нет.

Пример: `/debug/meta/vehicle?tag=ussr:R45_IS-7`. Карточка получает имя «ИС-7» из
словаря ClickHouse и завершает `useMetaReady` после загрузки. Кеш PNG на этом debug
маршруте выключен; кеш SQL включён до конца UTC-дня.

## Контексты метаданных

`server.mjs` экспортирует `createServerMetaResolver(database)`. Bun создаёт resolver при
старте, используя те же настройки подключения, что и прокси renderer. Серверный
экземпляр общего клиента из `src/db/client.ts` передаёт обычный `query` в контексты;
в браузере контексты используют уже существующий клиент сайта. Все контексты
собираются из `contexts` определений; повторное использование общего объявления
запускает одну загрузку, конфликт одинаковых id останавливает запуск.

Перед формированием HTML resolver ждёт только контексты выбранного определения.
`initialWaitMs` отсчитывается от начала первого прогрева; после этого срока
`meta(url, context)` получает `undefined` для ещё не готовых значений. Обновления
выполняются в фоне, сохраняют последний успешный снимок при ошибке и не пересекаются.
При завершении процесса загрузки отменяются, таймеры останавливаются.

Общий `vehicleNames` объявлен в `analytics-frontend/src/meta/contexts/vehicleNames.ts`:
ожидание до 3 секунд, обновление раз в час. Для debug-карточки он даёт
`<title>`, `og:title` и `twitter:title` «ИС-7 — WotStat Analytics».
Без готового имени используется «Название танка». В Chromium передаются только готовые
метаданные; словарь и серверный пароль туда не попадают. Запрос Vue-карточки остаётся
отдельным от загрузки контекста.

Выкладывать вместе: сначала новый frontend-артефакт, затем обновление и перезапуск
meta-сервиса. SQL, Nginx, Worker и `.env` для этого этапа менять не требуется.
