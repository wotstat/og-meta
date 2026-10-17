# analytics-frontend-meta

Метатеги и PNG/JPEG-превью для WotStat. Bun + Chromium в Docker.
Метатеги формируются для всех страниц, превью — для страниц с поддержкой изображений.

Оба endpoint доступны всегда: `/analytics/image.png` возвращает PNG,
`/analytics/image.jpg` — JPEG. Метатеги HTML выбирают ссылку по `IMAGE_FORMAT`
(`png` или `jpeg`, по умолчанию `jpeg`). `IMAGE_QUALITY` задаёт качество JPEG
от 0 до 100, по умолчанию 98; для PNG игнорируется.
В обоих Docker Compose сейчас заданы `IMAGE_FORMAT: jpeg` и `IMAGE_QUALITY: '98'`.

## Разработка

Сначала выполни `bun run build` в соседнем `analytics-frontend`, затем:

```sh
./rerun-dev.sh  # запуск в фоне
bun run dev    # запуск с логами
```

Адрес: http://localhost:9110. После пересборки frontend перезапусти контейнер:

```sh
docker compose -p og-meta-dev -f docker-compose.dev.yaml restart og-meta
```

## Деплой

На сервере нужны Linux, Bun 1.4.3, Docker Compose и `flock`.
Пароль `CLICKHOUSE_PASSWORD` задаётся в `.env` в корне установки (см. `.env.example`).
Для разработки пароль не нужен.

Первый запуск — вручную на сервере. Загрузи `dist/` и `dist-meta/` в один каталог
и из каталога исходников meta выполни:

```sh
./rerun.sh meta --app-dir /app/wotstat/og-meta --incoming /path/to/upload
```

Последующие деплои — через CI. Ручные команды и параметры: `./rerun.sh --help`.
После ребута контейнеры запускает Docker. После ручной остановки или удаления
контейнеров: `./rerun.sh start --app-dir /app/wotstat/og-meta` — запуск сохранённого
релиза без сборки и обновления.

Конфигурация Nginx и настройка ClickHouse — в [server-config](../server-config/README.md).
При деплоях перезагружается только внутренний Nginx.
Для перехода на JPEG нужно один раз применить обновлённый внешний конфиг
`sites-available/og.wotstat.info`, пропускающий `/analytics/image.jpg`.
