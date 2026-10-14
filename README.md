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
