# Project structure — HRM

Bản đồ cấu trúc repo HRM và nơi đặt code mới. Chi tiết từng app nằm ở `apps/api/AGENTS.md` và `apps/web/AGENTS.md`; quy tắc chung ở `AGENTS.md` gốc; quy ước code ở [hrm-engineering-conventions.md](hrm-engineering-conventions.md); giao diện ở [hrm-ui-design-system.md](hrm-ui-design-system.md). File này không lặp lại các tài liệu đó và không ghi trạng thái từng task (xem checkbox trong plan và ADR). Module nghiệp vụ HR nằm trong `apps/api/src/modules/` và `apps/web/src/features/` (ADR 0031, mục 7).

## 1. Một repo, pnpm workspace

```text
hrm/
├── apps/
│   ├── api/                # NestJS + TypeORM + PostgreSQL (@hrm/api)
│   └── web/                # React + Vite + Mantine (@hrm/web)
├── docs/                   # Kiến trúc, ADR (decisions/), plan (superpowers/plans/), UI, vận hành
├── docker/                 # Dockerfile, compose, script kích hoạt Root
├── scripts/                # Script dev dùng chung
├── seed/                   # Dữ liệu import nhân viên và script enroll tài khoản
├── test/                   # Test tooling chung toàn workspace (function-spacing, locale-keys)
├── package.json            # Orchestration: scripts gọi `pnpm -r` hoặc `--filter`
├── pnpm-workspace.yaml     # packages: apps/*; settings pnpm
├── pnpm-lock.yaml          # Một lockfile duy nhất
├── tsconfig.base.json      # Defaults chung
└── eslint*.config.js       # Baseline chung; mỗi app import và bổ sung
```

- Chỉ dùng pnpm theo `package.json#packageManager`, Node theo `.nvmrc`. Thêm dependency tại app sở hữu: `pnpm --filter @hrm/api add …`; tooling dùng chung: `pnpm add -Dw …`.
- Mỗi app sở hữu `package.json`, test, env (`.env.example`) và config riêng (ADR 0015). Root chỉ giữ orchestration và tooling/test dùng chung. Không dựa vào hoisting.
- Web và API chỉ giao tiếp qua HTTP `/api/*` (ADR 0019); không import source giữa hai app, không chia sẻ entity hay DTO có decorator. Dev dùng Vite proxy `/api` để cùng origin cho cookie.
- Không có package nội bộ hay SDK dùng chung. Nếu cần contract chung, phải có ADR trước.

## 2. Quy ước đặt tên

Chi tiết ở `AGENTS.md` gốc mục Coding convention; áp dụng cho cả hai app.

- Tên module/feature số ít, nhất quán giữa folder, file và class: `leave/`, `leave.module.ts`, `LeaveModule`; web `leave/`, `leave.client.ts`.
- File dạng `<kebab-case>.<vai-trò>.ts`. API: `.service`, `.controller`, `.module`, `.validator`, `.types`, `.helper`, `.declarations`, `.http-port`, `.migration`, `.entity`… Web thêm `.page.tsx`, `.component.tsx`, `.provider.tsx`, `.client.ts`, `.schema.ts`, `.config.ts`.
- Test: `.spec.ts`, `.integration-spec.ts`, `.e2e-spec.ts` (api); `.spec.tsx` (web unit); `.e2e-spec.ts` (web Playwright).
- Từ hai file cùng vai trò trở lên thì gom vào folder số nhiều (`controllers/`, `services/`, `helpers/`, `pages/`, `components/`, `migrations/`); file bên trong giữ hậu tố số ít. Một file thì đặt thẳng trong module. Không tạo folder rỗng.
- Import tương đối trực tiếp tới file sở hữu, TypeScript dùng đuôi `.js`. Không barrel `index.ts`, không `utils/` chung.
- Quy tắc đặt tên không đổi HTTP route, tên bảng, policy key hay dữ liệu đã lưu.

## 3. Frontend (`apps/web`)

Feature là folder số ít dưới `src/features/` (ADR 0031); không có `shared/`.

```text
apps/web/
├── src/
│   ├── main.tsx, app.tsx           # Render; composition root (providers, routes)
│   ├── app/                        # theme.config, navigation.config, app-layout, query-client.factory, app.config
│   ├── infrastructure/             # http.client.ts (chỉ /api/*, CSRF in-memory), helper hạ tầng
│   ├── i18n/                       # locales/{vi,en}.json, i18n.helper, i18n.provider
│   └── features/
│       ├── auth/, account/         # Đăng nhập OIDC, 2FA, phiên, quản lý tài khoản
│       ├── hr/                     # Phần dùng chung giữa các feature HR: hr.client, provider, components
│       ├── employee/, team/        # Hồ sơ nhân viên, nhóm
│       ├── work-request/           # Đơn từ, hộp duyệt (pages/, components/)
│       ├── leave/, attendance/     # Phép năm, bảng công
│       ├── report/                 # Báo cáo (T9 web): report.page, report.client, report.helper, components/{report-table,report-export}
│       ├── work-calendar/          # Lịch làm việc
│       └── home/                   # Trang chủ, not-found
├── test/                           # Vitest + Testing Library (jsdom), render.helper.tsx, setup.ts
├── e2e/                            # Playwright chạy với stack thật
├── index.html, vite.config.ts, tsconfig.json, eslint.config.js
```

- Feature nhỏ để file cạnh nhau (`features/leave/`); thêm `pages/`, `components/` khi có từ hai file cùng vai trò (`work-request/`, `employee/`).
- `app.tsx` chọn route và layout; page ghép component và query của feature; `*.client.ts` gọi endpoint của feature qua `infrastructure/http.client.ts`.
- `infrastructure/` không import feature. Feature không import `app/` hay page của feature khác. Dùng chung giữa các feature đặt ở `hr/` (chỉ phần HR) hoặc một file có trách nhiệm rõ, và chỉ chuyển khi có từ hai feature dùng thật.
- Mọi chữ hiển thị qua `t(key)`, thêm key ở cả `vi.json` và `en.json`. Web không quyết định quyền: ẩn menu/nút chỉ là UX.
- Màn có quyền hoặc DTO khác nhau giữa các nhóm người dùng (nhân viên tự xem, HR, quản lý) dùng page/client riêng; chỉ dùng chung component trình bày khi cùng nghĩa.

## 4. Backend (`apps/api`)

Module nghiệp vụ HR nằm dưới `src/modules/` (ADR 0031), nền tảng ngang cấp dưới `src/`; không có `common/`.

```text
apps/api/
├── src/
│   ├── main.ts, app.module.ts      # Listen; ghép module (không chạm DB)
│   ├── config/                     # app.config.ts: env có validation
│   ├── infrastructure/             # RuntimeModule, ProductRuntime (private), error filter, helpers/ (api-error, http-security, input-validation, idempotency, business-time, database-error), product-modules.factory
│   ├── authorization/              # core/ (thuần), values/, enforcement/, services/, helpers/, compiler, gateway, manifest
│   ├── authentication/             # controllers/ (kể cả me: GET /api/auth/me, ADR 0037), services/ (identity, session, OIDC, 2FA), helpers/
│   ├── audit/                      # Audit writer, outbox
│   ├── database/                   # Transaction runner, probes/config, migrations/
│   ├── health/                     # live/ready/metrics
│   ├── openapi/                    # Schema và controller OpenAPI
│   ├── administration/, document/  # Quản trị tài khoản; document: fixture lõi, không HTTP (ADR 0032)
│   └── modules/                    # Nghiệp vụ HR
│       ├── permission/             # Role, policy dùng chung, hrCompany, boundary, SQL phạm vi/grant, object registry, migration và probe phân quyền (ADR 0035/0036)
│       ├── employee/, team/        # Hồ sơ, nhóm
│       ├── work-request/           # Đơn từ và duyệt (services/)
│       ├── leave/, attendance/     # Phép năm, bảng công
│       ├── report/                 # Báo cáo (T9: sáu báo cáo + XLSX; services/{report,excel-export}.service.ts)
│       └── work-calendar/          # Lịch làm việc, giờ làm
├── test/                           # unit, integration (PostgreSQL thật), e2e; module-boundaries.spec.ts
├── tools/                          # CLI offline: provision, migrate, bootstrap Root, reset MFA
├── compose.yaml                    # PostgreSQL local
└── tsconfig.json, tsconfig.build.json, tsconfig.test.json, eslint.config.js
```

Một module HR điển hình:

```text
modules/leave/
├── leave.module.ts
├── leave.controller.ts
├── leave.http-port.ts              # Port token: chỉ operations đã bind, không DataSource/credential
├── leave.service.ts                # Điều phối nghiệp vụ, dùng TypeORM trực tiếp
├── helpers/leave-balance.helper.ts # Hàm thuần
├── leave.validator.ts, leave.types.ts
└── migrations/hrm-leave.migration.ts
```

- Feature module chỉ khai báo controllers và import `RuntimeModule`; handler nhận facade/port đã bind, không nhận `ProductRuntime`, DataSource hay credential thô. Capability mới: thêm port token trong `runtime.module.ts`, declaration fragment vào `authorization/product.manifest.ts`.
- Controller chỉ xử lý HTTP input/output; SQL, policy và orchestration DB nằm ở service. Không tạo service hoặc repository chỉ chuyển tiếp.
- Entity và migration cùng một thay đổi; không sửa migration đã áp dụng, thêm forward migration. Migration nằm trong `migrations/` của module sở hữu dữ liệu.
- `authorization/core` thuần: không NestJS, TypeORM, network hay tên domain. Ranh giới import được kiểm bởi ESLint và `test/module-boundaries.spec.ts`.
- Không có route HTTP cho provisioning, manifest upload hay Root bypass; các việc đó là CLI trong `tools/`.
- Mọi route khai báo dưới `/api` trong `@Controller`; lỗi trả `{ statusCode, code }` theo `API_ERROR_CODES`.

## 5. Nơi đặt khi thêm mới

| Khi thêm                                      | Nơi đặt / việc cần làm                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Màn hình                                      | `*.page.tsx` trong `features/<feature>` web, route ở `app.tsx`, menu ở `app/navigation.config.ts`; kiểm loading/empty/error, key `vi` + `en`                  |
| Gọi API từ web                                | `<feature>.client.ts` dùng `infrastructure/http.client.ts`; chỉ path `/api/*`                                                                                 |
| Endpoint                                      | Controller + validator + service + http-port trong module; cập nhật OpenAPI (`openapi/`), status thực tế và test unauthenticated/unauthorized/invalid input   |
| Quy tắc nghiệp vụ                             | Service hoặc helper thuần của module sở hữu; test hành vi, gồm trường hợp từ chối và biên                                                                     |
| Quyền, resource, action                       | Declaration của module (`*.declarations.ts`) và release manifest; không hardcode vào `authorization/core`; cần boundary thì theo `permission-boundaries.md`   |
| Schema                                        | Migration trong `migrations/` của module (`modules/<module>/migrations/`), test PostgreSQL thật; xét fence, lock order (ADR 0017) và privilege của từng login |
| Mã lỗi mới                                    | `API_ERROR_CODES`, cả hai locale, OpenAPI, test; nêu lý do key không lộ facts ngoài quyền người gọi                                                           |
| Biến môi trường                               | `config/app.config.ts` (api) hoặc `app/app.config.ts` (web, `VITE_*`) có validation, thêm vào `.env.example`                                                  |
| Component dùng lại                            | Giữ trong feature; chuyển `features/hr/components` khi nhiều feature HR dùng                                                                                  |
| Lệnh vận hành offline                         | `apps/api/tools/` và script trong `apps/api/package.json`; không route HTTP                                                                                   |
| Test E2E                                      | `apps/web/e2e/` (Playwright, stack thật) hoặc `apps/api/test/*.e2e-spec.ts`                                                                                   |
| Quyết định ảnh hưởng quyền, identity, dữ liệu | ADR mới trong `docs/decisions/` trước khi code                                                                                                                |

## 6. Thay đổi liên quan cả web và API

Hai app nằm trong một repo nên đổi contract làm trong cùng một thay đổi: API, OpenAPI, `*.client.ts`, locale và test. Thứ tự deploy tương thích là API trước, web sau; một contract không tương thích ngược phải được tách thành hai bước. Không tạo thư mục hay file chỉ để đủ sơ đồ; thêm khi task cần.

## 7. `modules/` và `features/` (ADR 0031, Accepted)

Module nghiệp vụ HR gom vào một folder để tách khỏi nền tảng. Chỉ đổi đường dẫn, không đổi route, bảng, migration identifier hay quyền.

- Nền tảng (`authorization`, `authentication`, `audit`, `database`, `infrastructure`, `health`, `openapi`, `config`, `administration`, `document`) không import `modules/`, trừ các điểm ghép đã import module nghiệp vụ (`app.module.ts`, `infrastructure/product-runtime.service.ts`, `infrastructure/runtime.module.ts`, `authorization/product.manifest.ts`, `tools/product.ts`). Module nghiệp vụ import nền tảng và `modules/permission`; không import lẫn nhau trừ qua port/token đã có. Hiện trạng: còn các import chéo có sẵn (work-request/leave/work-calendar ↔ attendance, permission → migration của employee/work-request; web `features/hr/hr.client.ts` import type từ `app/`), chưa dọn, ESLint chưa enforce.
- Web: `features/` không import `app/`; `infrastructure/` không import `features/`. Chưa tạo `shared/` khi chưa có nhu cầu.
- Các ràng buộc trên là quy ước; ESLint/`module-boundaries.spec.ts` hiện chưa kiểm riêng chúng (cần rule mới kèm negative test nếu muốn enforce).
- `apps/api/tools/product.ts` import migration qua `../dist/modules/<module>/migrations/...`.
