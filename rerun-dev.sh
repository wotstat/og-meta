#!/bin/sh
set -eu

cd "$(dirname "$0")"
docker compose -p analytics-frontend-meta down;
docker compose -p analytics-frontend-meta -f docker-compose.yaml -f docker-compose.dev.yaml up --build -d --remove-orphans;
