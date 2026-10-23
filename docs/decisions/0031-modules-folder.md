# ADR 0031 — Gom module nghiệp vụ vào `modules/` (API) và `features/` (web)

Ngày: 2026-10-21. **Trạng thái: Accepted** (2026-10-21, người dùng đã duyệt; đã di chuyển file). Tinh chỉnh bố cục thư mục của [ADR 0013](0013-single-app-modules.md) (một NestJS app chia module); không đổi topology một app, route, tên bảng, migration identifier, manifest/hash, quyền hay dữ liệu.

## Bối cảnh

Trong `apps/api/src` và `apps/web/src`, module nghiệp vụ (`employee`, `leave`…) nằm ngang hàng với module nền tảng (`authorization`, `auth`, `database`…). Khi số module tăng, khó thấy đâu là nghiệp vụ HR cần thêm hằng ngày, đâu là nền tảng ít đổi và có ranh giới bảo mật chặt. Tham khảo cách Yenso tách `modules/` (api) và `features/` (web); chỉ mượn bố cục thư mục, không mượn tách repo (xem [project-structure](../project-structure.md)).

## Quyết định

1. **API:** tạo `apps/api/src/modules/` chứa `employee`, `team`, `leave`, `attendance`, `work-request`, `work-calendar` và `hr` (declarations, DB helper, input helper, `GET /api/hr/me` dùng chung cho nghiệp vụ). Giữ ở `src/`: `authorization`, `auth`, `audit`, `database`, `infrastructure`, `health`, `openapi`, `config`, `administration`, `document`.
2. **Web:** tạo `apps/web/src/features/` chứa `employee`, `team`, `work-request`, `leave`, `attendance`, `work-calendar`, `hr`, `auth`, `account`, `home`. Giữ ở `src/`: `app/`, `infrastructure/`, `i18n/`, `main.tsx`, `app.tsx`. Không tạo `shared/` khi chưa có nhu cầu; `infrastructure/` đã giữ HTTP client, `features/hr/` giữ phần dùng chung giữa các feature HR.
3. **Quy ước không đổi:** tên số ít, `<tên>.<vai-trò>.ts`, folder số nhiều từ hai file cùng vai trò, import tương đối trực tiếp đuôi `.js`, không barrel. Module trong `modules/` chỉ import module nền tảng và `modules/hr`; module nghiệp vụ không import lẫn nhau trừ qua port/token đã có.
4. **Ranh giới:** `authorization/core`, ranh giới HTTP handler (không DataSource/credential/runtime thô) và các quy tắc ESLint hiện có giữ nguyên, chỉ đổi đường dẫn glob. Nền tảng không import `modules/` ngoại trừ nơi composition đã import module nghiệp vụ (`app.module.ts`, `infrastructure/product-runtime.service.ts`, `infrastructure/runtime.module.ts`, `authorization/product.manifest.ts`, `tools/product.ts`).

## Triển khai và bằng chứng (2026-10-21)

Đã `git mv` API `hr, employee, team, work-request, leave, attendance, work-calendar` vào `apps/api/src/modules/` và web `hr, auth, account, home, employee, team, work-request, leave, attendance, work-calendar` vào `apps/web/src/features/`; sửa import tương đối, `apps/api/tools/product.ts` (`../dist/modules/<module>/migrations/...`, giữ tên class/timestamp), `test/time-source.spec.ts`. Glob ESLint và `module-boundaries.spec.ts` không tham chiếu module đã chuyển nên không đổi. Ranh giới mục 3–4 (nền tảng không import `modules/`, module nghiệp vụ không import lẫn nhau) chưa được ESLint hiện có diễn đạt; chưa enforce, cần rule mới kèm negative test.

Đã chạy (sau khi dời dist cũ khỏi `apps/api/dist`): `pnpm run typecheck`, `pnpm run build` pass; ESLint từng app (`pnpm --filter <app> exec eslint .`) exit 0; `@hrm/api test:unit` 316/316 (gồm `structure.spec.ts`, `module-boundaries.spec.ts`, không sửa expected route/OpenAPI); `test:workspace` 20/20; web vitest 17 file/137 test pass (`--testTimeout=60000 --no-file-parallelism`); `test:integration` với `hrm-leave`, `hrm-approval`, `hrm-authorization-upgrade` 36/36; `test:e2e` API 1/1. Chưa chạy: full integration, Playwright web.

## Hệ quả

Dễ tìm và thêm module nghiệp vụ; nền tảng tách rõ. Đổi lại là một thay đổi lớn về đường dẫn: nhiễu `git blame` (dùng `git mv` và không sửa nội dung cùng lúc), và mọi nhánh/PR đang mở sẽ xung đột import. Không giảm rủi ro bảo mật hay hiệu năng; chỉ là tổ chức.

Ghi chú hiện trạng (review độc lập 2026-10-21): quy ước "module nghiệp vụ không import lẫn nhau" chưa đúng với code có sẵn từ trước khi dời — `work-request`, `leave`, `work-calendar` import trực tiếp `attendance.service`/`leave.service`/`working-time.helper`; `hr/hr-database.helper` import migration của `employee` và `work-request`; web `features/hr/hr.client.ts` import type từ `app/navigation.config`. Chưa dọn; dọn cùng lúc thêm rule ESLint kèm negative test.

Cập nhật (ADR 0035, 2026-10-23): khai báo quyền của `modules/hr` đã chuyển về module sở hữu và `modules/permission`; mục 3 đọc là "nền tảng, `modules/hr` và `modules/permission`".

Cập nhật (2026-10-23): folder API `apps/api/src/auth/` đổi thành `apps/api/src/authentication/` vì module này chỉ làm xác thực (identity/session/OIDC/2FA), còn phân quyền nằm ở `authorization/`; tên folder, file và class theo cùng một tên module số ít. Không đổi hành vi: route `/api/auth/*`, cookie/CSRF header, env `AUTH_METHODS`, bảng/migration, policy key, key locale web `auth.*` và OpenAPI giữ nguyên. Web (`features/auth`) chưa đổi trong lần này.

| Cũ                                                                   | Mới                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/auth/`                                                          | `src/authentication/`                                                               |
| `auth.module.ts`, `AuthModule`                                       | `authentication.module.ts`, `AuthenticationModule`                                  |
| `auth.http-port.ts`, `AUTH_HTTP_PORT`, `AuthHttpPort`                | `authentication.http-port.ts`, `AUTHENTICATION_HTTP_PORT`, `AuthenticationHttpPort` |
| `controllers/auth.controller.ts`, `AuthController`                   | `controllers/authentication.controller.ts`, `AuthenticationController`              |
| `oidc.controller.ts`, `mfa.controller.ts`, `services/*`, `helpers/*` | giữ tên file, đổi đường dẫn                                                         |
