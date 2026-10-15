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
