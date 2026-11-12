# HRM workspace

Dự án HRM được khởi tạo từ Base Authorization. Backend Go/Gin + PostgreSQL nằm ở `apps/api`; frontend React + Mantine (Vite) ở `apps/web`, đăng nhập Google OIDC. API và web cùng origin, mọi route API dưới `/api` ([ADR-11](docs/decisions/ADR-11-http-api-errors-openapi-web.md)). Chạy local và browser E2E: [operations](docs/operations.md).

## Ownership

```text
apps/
  api/
    cmd/                  # api (HTTP) và hrmctl (CLI offline)
    contract/             # route, OpenAPI, mã lỗi, privilege (Go sở hữu)
    internal/             # API, module nghiệp vụ, database và migration goose
    test/                 # kiểm quy ước, import và fixtures dùng chung
    tools/                # runner integration test
    .env.example          # mẫu runtime, copy thành .env.api
    .env.ops.example      # mẫu ops/Compose, copy thành .env.ops
    compose.yaml          # PostgreSQL local của API
    go.mod                # dependencies Go của API
    package.json          # scripts gọi go/hrmctl
  web/                    # React SPA, Vitest, Playwright E2E
test/                     # chỉ tests của tooling workspace dùng chung
docs/                     # requirement, thiết kế và ADR
```

Root giữ pnpm workspace/lockfile, strict defaults, ESLint/Prettier dùng chung và CI orchestration. Test dependencies riêng nằm trong app; không dựa vào hoisting. Xem [ADR-01](docs/decisions/ADR-01-workspace-modules-conventions.md).

## Commands từ root

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:integration
pnpm run test:browser
```

Build/typecheck/test gọi scripts do từng app sở hữu; build, lint và `test:unit` cần Go. `test:unit` chạy thêm `test:workspace` cho formatting rule chung. Lọc integration API theo package: `pnpm --filter @hrm/api run test:integration ./internal/<package>`.

DB/identity/start scripts ở root forward tới API với cwd `apps/api`; env không còn đọc từ root. Xem [quy tắc API](apps/api/AGENTS.md) và [runbook local](docs/operations.md) trước khi provision/migrate. Không dùng credentials thật để kiểm thử.

## Tài liệu sản phẩm

- [Requirement](docs/HR_Web_Requirement_Tieng_Viet.md)
- [Kế hoạch HRM](docs/superpowers/plans/2026-10-16-hrm-implementation.md)
- [Kiến trúc](docs/architecture.md), [vận hành](docs/operations.md), [lịch sử](docs/history.md)
- [Chỉ mục tài liệu](docs/README.md)
- [Hướng dẫn làm việc](AGENTS.md)

Các báo cáo test/benchmark lịch sử không chứng minh working tree hiện tại đã pass hoặc production-ready.
