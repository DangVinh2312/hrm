# Base Authorization — single product

NestJS + TypeORM + PostgreSQL, Node24 và pnpm12.3.4. Một app tại `apps/api`, chia module chức năng và import implementation trực tiếp; không có SDK/package nội bộ hoặc yêu cầu Clean Architecture. API dùng một database, đăng nhập Google OIDC (ADR-06) và opaque sessions; IAM dùng chung policy/boundary/grant/deny AST. Root nằm ngoài IAM theo ADR-05.

Chuyển cấu trúc một app: [ADR-01](../../docs/decisions/ADR-01-workspace-modules-conventions.md), [lịch sử và bằng chứng](../../docs/history.md). Quyết định adapter/API/audit: [ADR-02](../../docs/decisions/ADR-02-authorization-core-and-value-codecs.md); IAM/Root: [ADR-05](../../docs/decisions/ADR-05-root-iam-boundaries-account-invariants.md). Xem [kiến trúc](../../docs/architecture.md), [lịch sử và bằng chứng](../../docs/history.md), [quyết định runtime](../../docs/decisions/ADR-03-fence-transactions-manifest-sync.md) và [vận hành local](../../docs/operations.md).

Các lệnh ví dụ dưới đây chạy từ workspace root.

## Local

```sh
pnpm install --frozen-lockfile
# Chuẩn bị apps/api/.env.ops và apps/api/.env.api theo runbook; dùng credentials local riêng.
docker compose -f apps/api/compose.yaml --env-file apps/api/.env.ops up -d postgres
pnpm run db:provision
pnpm run db:migrate
pnpm run manifest:sync
pnpm run start:dev
```

API không chạy DDL khi boot. Privilege/capability/manifest lỗi khiến startup thất bại trước business listener. `/api/health/ready` chỉ200 sau sync; `/api/openapi.json` mô tả DTO/examples/status, `/api/health/metrics` chỉ chứa labels hữu hạn. Không public signup, file/job nền hay endpoint bypass; quản trị tài khoản/setting/role qua permission thường theo các đợt của ADR-08, ADR-09, ADR-12, ADR-13.

## Quy ước tên file

File source dùng `<tên>.<vai-trò>.ts` để thấy trách nhiệm ngay trong cây thư mục: `product-authority.service.ts` điều phối phân quyền, `helpers/http-security.helper.ts` chứa hàm tiện ích, `product-audit.repository.ts` ghi audit trong transaction. Gateway, compiler, codec, migration và các vai trò khác cũng có hậu tố tương ứng, như `product-data.gateway.ts`, `product-sql.compiler.ts`, `dayjs-timestamp.codec.ts`, `012-iam-root.migration.ts`.

Tên module dùng số ít: `document/`, `document.module.ts`, `DocumentModule`. Trong một module/package, từ hai file cùng vai trò trở lên được gom vào folder số nhiều như `services/`, `helpers/`, `repositories/`, `controllers/`, `codecs/`; file vẫn giữ hậu tố (`services/product-authority.service.ts`). Một file thì đặt trực tiếp trong module; giữ các nhóm đã có sẵn.

Giữ `main.ts`, CLI và fixtures lịch sử; module và tests import trực tiếp file sở hữu, không cần entrypoint tổng hợp của package cũ. Quy chuẩn đầy đủ ở `../../AGENTS.md`; cấu trúc code không đổi HTTP routes hoặc định danh migration trong database.

## Format code

Prettier dùng cấu hình chung tại `.prettierrc.json`: thụt lề 2 spaces, nháy đơn, dấu chấm phẩy, trailing comma, độ rộng mục tiêu 100 cột và xuống dòng LF. ESLint tại `eslint.format.config.js` thêm dòng trống sau nhóm import, giữa các khai báo export (kể cả const/interface/type/class) và giữa các function, arrow function độc lập, class method và chữ ký method trong interface/type. Rule không tự thêm dòng trống giữa các property trong object, kể cả callback/method. Comment và decorator của class/method được giữ cùng khai báo. Chạy từ thư mục root:

```sh
# Format các file TypeScript/JavaScript, gồm cả tests và tools.
pnpm run format:code
# Chỉ kiểm tra, không sửa file.
pnpm run format:code:check
# Format một file cụ thể.
pnpm exec eslint --config eslint.format.config.js --fix apps/api/src/authentication/controllers/authentication.controller.ts
pnpm exec prettier --write apps/api/src/authentication/controllers/authentication.controller.ts
```

Bước ESLint chỉ chạy rule cách dòng, không cần build hoặc typecheck; `lint` cũng kiểm tra rule này. ESLint bỏ qua `node_modules`, `dist`, coverage và thư mục công cụ tạm được khai báo trong config. Bước Prettier bỏ qua file theo `.gitignore` và `.prettierignore`. `pnpm run format` / `pnpm run format:check` vẫn áp dụng cho toàn bộ file được Prettier hỗ trợ, gồm cả tài liệu và cấu hình; CI dùng `format:check`.

## Kiểm chứng

```sh
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
```

Integration/E2E dùng PostgreSQL 18.6 disposable qua Docker và IdP fixture có chữ ký thật. Tests nhận path filter sau `--`. GitHub workflow được cập nhật nhưng chưa thực chạy từ đây; local pass không là CI pass. Số đo fixture nhỏ ở [history](../../docs/history.md) không là SLA production.

## Layout và compatibility

- `apps/api/src/authorization/core`: pure types, AST, validation/planner/evaluator; không framework/DB hoặc default engine toàn cục.
- `authorization/values`, `authorization/enforcement`: strict codecs và Nest route inventory/decorators/guard. Core không import codecs/framework; services vẫn recheck quyền trong fence.
- `authorization/services`, `authorization/helpers`: authority, manifest, shared release validation và obligations; compiler/gateway trong `authorization/` dùng cùng AST.
- `authentication/services`, `database`, `audit`: identity/OIDC, fixed-purpose transactions/probes/migrations và atomic audit/outbox. Services dùng TypeORM trực tiếp khi cần; handler nhận bound facade operations.
- `auth`, `administration`, `health`, `openapi`, `config`, `infrastructure`: HTTP/config/runtime hiện có; `document/` là fixture lõi phân quyền, không HTTP (ADR-01).
- `apps/api/test/core`, `apps/api/test/values`, `apps/api/test/enforcement` cùng các tests product/SQL/HTTP kiểm behavior; `apps/api/test/module-boundaries.spec.ts` kiểm ESLint module boundaries, không phải process isolation.
- `apps/api/tools/product.ts`: provision/migrate/sync/enroll/bootstrap/reissue-root/revoke-root offline.

Tenant implementation, compatibility API và CLI cũ đã bỏ theo [ADR-01](../../docs/decisions/ADR-01-workspace-modules-conventions.md). Schema do hai baseline migration dựng (ADR-14); provisioning lên schema cũ thất bại thay vì tự gộp dữ liệu.

## Ownership trong workspace HRM

Theo [ADR-01](../../docs/decisions/ADR-01-workspace-modules-conventions.md), API sở hữu tests, tools, env/Compose, scripts/dependencies và config riêng trong thư mục này. Copy `apps/api/.env.example` thành `apps/api/.env.api`, `apps/api/.env.ops.example` thành `apps/api/.env.ops`. Root DB/identity/start commands forward tới API với cwd `apps/api`; dùng absolute path cho activation artifacts. Compose giữ project name `hrm`, không tự provision/migrate database khi đổi layout.
