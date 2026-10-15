#!/usr/bin/env bash
# Local development: rebuild the frontend on every save and run Django.
# Refresh the browser after a frontend change. Usage: ./dev.sh [port]
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-../.venv/bin/python}"
# Local secrets (TMDB key) live in web/.env, which git ignores.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
npm run build >/dev/null
npm run watch >/dev/null &
trap 'kill $!' EXIT
"$PY" manage.py runserver "${1:-8000}"
