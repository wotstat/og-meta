#!/bin/sh
set -eu

cd "$(dirname "$0")"
docker compose -p og-meta-dev -f docker-compose.dev.yaml up --build -d
