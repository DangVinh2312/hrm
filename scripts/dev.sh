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
  api      Chỉ chạy API: binary Go giữ PORT của .env.api, NestJS đứng sau ở HRM_UPSTREAM_PORT (mặc định 3001)
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

# ADR-20: NestJS tin đúng một hop là Go; Go giữ TRUST_PROXY của .env.api. Biến đặt ở đây thắng
# --env-file của Node. Node đọc .env.api cho Go vì file có JSON không bọc ngoặc, shell không source được.
api_stack() {
  local upstream_port="${HRM_UPSTREAM_PORT:-3001}"
  pnpm --filter @hrm/api-go run build
  PORT="$upstream_port" TRUST_PROXY=1 pnpm run start:dev &
  go_api "http://127.0.0.1:$upstream_port" &
}

# Không có `wait -n` trên bash 3.2 của macOS, nên Go tự báo cho script chính để trap dừng cả stack.
go_api() {
  local status=0
  API_UPSTREAM_URL="$1" node --env-file=apps/api/.env.api -e \
    "process.exit(require('node:child_process').spawnSync('apps/api-go/dist/api', { stdio: 'inherit' }).status ?? 1)" || status=$?
  echo "Binary Go đã dừng (exit $status); dừng cả stack." >&2
  kill -TERM "$$"
}

start() {
  setup
  trap 'kill 0' EXIT INT TERM
  api_stack
  pnpm --filter @hrm/web run dev &
  wait
}

api() {
  require_env
  trap 'kill 0' EXIT INT TERM
  api_stack
  wait
}

case "${1:-start}" in
  start) start ;;
  api) api ;;
  web) pnpm --filter @hrm/web run dev ;;
  db) db_up ;;
  setup) setup ;;
  stop) require_env; "${COMPOSE[@]}" stop postgres ;;
  reset) require_env; "${COMPOSE[@]}" down -v ;;
  -h | --help | help) usage ;;
  *) usage >&2; exit 1 ;;
esac
