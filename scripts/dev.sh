#!/usr/bin/env bash
# Chạy HRM local: PostgreSQL (Docker) + API + web. Dùng: scripts/dev.sh [lệnh]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Node theo .nvmrc (shell không tương tác có thể mặc định phiên bản khác).
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use >/dev/null
fi

COMPOSE=(docker compose -f apps/api/compose.yaml --env-file apps/api/.env.ops)

usage() {
  cat <<USAGE
Dùng: scripts/dev.sh <lệnh>

  start    Bật Postgres, provision + migrate (idempotent), rồi chạy API và web (mặc định)
  api      Chỉ chạy API (build + node dist/main.js)
  web      Chỉ chạy web (vite)
  db       Bật Postgres, chờ healthy
  setup    Bật Postgres + db:provision + db:migrate
  stop     Tắt Postgres
  reset    Xóa container + volume Postgres (mất dữ liệu local)
USAGE
}

require_env() {
  for f in apps/api/.env.api apps/api/.env.ops; do
    if [[ ! -f "$f" ]]; then
      echo "Thiếu $f — copy từ $f.example rồi điền giá trị." >&2
      exit 1
    fi
  done
}

db_up() {
  require_env
  "${COMPOSE[@]}" up -d --wait postgres
}

setup() {
  db_up
  pnpm run db:provision
  pnpm run db:migrate
}

start() {
  setup
  trap 'kill 0' EXIT INT TERM
  pnpm run start:dev &
  pnpm --filter @hrm/web run dev &
  wait
}

case "${1:-start}" in
  start) start ;;
  api) require_env; pnpm run start:dev ;;
  web) pnpm --filter @hrm/web run dev ;;
  db) db_up ;;
  setup) setup ;;
  stop) require_env; "${COMPOSE[@]}" stop postgres ;;
  reset) require_env; "${COMPOSE[@]}" down -v ;;
  -h | --help | help) usage ;;
  *) usage >&2; exit 1 ;;
esac
