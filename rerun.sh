#!/bin/sh
set -eu

cd "$(dirname "$0")"
docker compose -p og-meta down;
docker compose -p og-meta -f docker-compose.yaml up --build -d --remove-orphans;
