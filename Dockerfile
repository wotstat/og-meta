FROM oven/bun:1.4.3

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-dejavu-core fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src ./src

ENV HOST=0.0.0.0 \
    PORT=3000 \
    META_ARTIFACT_DIR=/meta \
    BUN_CHROME_PATH=/usr/bin/chromium

USER bun
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
