# HRM workspace

Dự án HRM được khởi tạo từ Base Authorization. Backend NestJS + TypeORM + PostgreSQL nằm ở `apps/api`; frontend React + Mantine (Vite) ở `apps/web`, đăng nhập Google OIDC. API và web cùng origin, mọi route API dưới `/api` ([ADR-11](docs/decisions/ADR-11-http-api-errors-openapi-web.md)). Chạy local và browser E2E: [operations](docs/operations.md).

## Ownership

```text
apps/
  api/
    src/                  # API và các module nghiệp vụ
    test/                 # unit, integration, E2E và fixtures API
    tools/                # test runner, offline CLI và env parser
    .env.example          # mẫu runtime, copy thành .env.api
    .env.ops.example      # mẫu ops/Compose, copy thành .env.ops
    compose.yaml          # PostgreSQL local của API
    package.json          # scripts và dependencies của API
    tsconfig*.json        # API source/build/test projects
    eslint.config.js      # import và authorization rules của API
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
pnpm run test:e2e
```

Build/typecheck/test gọi scripts do từng app sở hữu. `test:unit` chạy thêm `test:workspace` cho formatting rule chung. Lọc API tests bằng `pnpm run test:unit -- apps/api/test/core` hoặc `pnpm --filter @hrm/api run test:unit -- test/core`.

DB/identity/start scripts ở root forward tới API với cwd `apps/api`; env không còn đọc từ root. Xem [API README](apps/api/README.md) và [runbook local](docs/operations.md) trước khi provision/migrate. Không dùng credentials thật để kiểm thử.

## Tài liệu sản phẩm

- [Requirement](docs/HR_Web_Requirement_Tieng_Viet.md)
- [Kế hoạch HRM](docs/superpowers/plans/2026-10-16-hrm-implementation.md)
- [Kiến trúc](docs/architecture.md), [vận hành](docs/operations.md), [lịch sử](docs/history.md)
- [Chỉ mục tài liệu](docs/README.md)
- [Hướng dẫn làm việc](AGENTS.md)

Các báo cáo test/benchmark lịch sử không chứng minh working tree hiện tại đã pass hoặc production-ready.
