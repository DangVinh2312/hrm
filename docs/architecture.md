# Kiến trúc HRM

Thiết kế hiện hành của hệ thống: một API Go/Gin (ADR-20; Go sở hữu contract theo ADR-22), một React SPA, một PostgreSQL database, một tổ chức (không tenant). Quy tắc làm việc nằm ở `AGENTS.md` gốc và `AGENTS.md` của từng app; quyết định chi tiết ở [ADR](decisions/); lý do và bằng chứng lịch sử ở [history](history.md). Tài liệu này không ghi trạng thái từng task (xem checkbox trong [kế hoạch](superpowers/plans/)).

## 1. Hệ thống

- Stack: Node 24, pnpm workspace (`apps/api`, `apps/web`, một `pnpm-lock.yaml`), Go + Gin + pgx + PostgreSQL 18 ở API (dependency trong `apps/api/go.mod`); React 19, Vite, Mantine 9, React Router, TanStack Query, Mantine Form + Zod ở web.
- Web và API cùng origin; mọi route API dưới `/api` (ADR-11). Web chỉ gọi API qua HTTP, không import source của API và không chia sẻ DTO hay entity.
- Không có package nội bộ hay SDK dùng chung giữa hai app; web import tương đối trực tiếp tới file sở hữu, API import package theo [package-dag.md](../apps/api/contract/package-dag.md). Muốn thêm contract chung phải có ADR (ADR-01).
- Mỗi app sở hữu `package.json`, test, env (`.env.example`) và config; root chỉ giữ orchestration và tooling dùng chung (ADR-01). Không dựa vào hoisting.

```text
hrm/
  apps/api/      # @hrm/api (Go/Gin, xem mục 4): cmd/, contract/, internal/, test/, tools/ (runner integration), compose.yaml, .env.example, .env.ops.example
  apps/web/      # @hrm/web: src/, test/ (Vitest), e2e/ (Playwright)
  docs/          # tài liệu và ADR
  docker/        # stack dev đầy đủ trong container (compose.yaml, Dockerfile, root-activation.sh)
  scripts/       # dev.sh (Postgres + API + web local)
  seed/          # dữ liệu nhân viên và script enroll tài khoản
  test/          # test tooling chung (function-spacing, locale-keys, ...)
```

## 2. Xác thực và phiên

- Chỉ đăng nhập Google OIDC (ADR-06): Authorization Code + PKCE S256, state/nonce một lần, issuer/audience/azp/chữ ký/hạn kiểm bằng `go-oidc` cộng `checkIDTokenClaims` (`internal/authentication`). Không mật khẩu local, link/unlink hay xác thực lại bằng Google. Mỗi tài khoản đúng một binding Google đang bật, ánh xạ bằng `(issuer, subject)`; tài khoản IAM được tạo theo email và kích hoạt ở lần đăng nhập đầu có email đã xác minh trùng (ADR-06).
- Phiên là opaque session lưu digest trong DB; tuyệt đối 12 giờ, idle 30 phút; cookie HttpOnly `SameSite=Lax` (`__Host-` khi HTTPS) cùng CSRF token và kiểm Origin cho mọi mutation. Claim IdP (group, role) không cấp quyền.
- `fresh` (bước xác thực gần đây, 300 giây) chỉ đến từ 2FA TOTP (ADR-06); đăng nhập Google không bao giờ cho `fresh`. Action chỉ đòi `fresh` khi policy của nó có `fresh@1` (ADR-05), kể cả với Root.
- Root là tài khoản `kind = 'root'` ngoài IAM (ADR-05, ADR-06): tối đa một, tạo bằng CLI offline, mọi hành động tác động lên Root cũng chỉ qua CLI.
- Đồng hồ có thẩm quyền là đồng hồ PostgreSQL (hạn phiên, `fresh`, `auth_time`); codec timestamp của `authorization/values` chỉ parse timestamp UTC ở biên.

## 3. Mô hình phân quyền

```text
Allow = ValidUserAndSession AND PermissionPolicy AND UserPermissionBoundary
        AND (RoleAllow OR DirectAllow OR RecordAllow) AND NOT AnyDeny
```

- IAM principal: default deny, deny thắng allow. Permission policy và boundary nằm ngoài phép OR của grant, record exception không vượt được chúng. Không rank; bảo vệ giữa các IAM principal bằng boundary và deny. Action tác động lên principal khác phải là `boundary: 'required'`. Hợp đồng boundary: [permission-boundaries](permission-boundaries.md).
- Root bypass phân quyền qua `PlanUnrestricted`, chỉ khi `kind` đến từ phiên đã kiểm chứng trong giao dịch; mỗi `access` commit của Root được audit.
- List, detail, count, export và write dùng chung một AST và áp trước phân trang. Gateway giới hạn trang mặc định 20, tối đa 100, offset tối đa 10 000, tối đa 32 node filter (`internal/authorization/gateway/gateway_types.go`).
- Role, policy, template, boundary và relation do mã khai báo (`managed_by = 'code'`) và đồng bộ qua manifest; role/grant do UI tạo là `runtime`, chỉ chọn từ `(permission, template)` đã đăng ký. Không sửa code-owned qua UI.
- Hidden và absent record không phân biệt (cùng `error.notFound`). API lỗi luôn `{ statusCode, code }` với `code` thuộc `apps/api/contract/api-errors.json` và là key `error.*` của web.

## 4. Backend (`apps/api`)

Route nằm ở `httpapi.MigratedRoutes`, đủ 100/100 route của contract; route ngoài contract là 404 của Go; `config.Load` từ chối `API_UPSTREAM_URL`. Quy tắc và bẫy của Go/Gin: [apps/api/AGENTS.md](../apps/api/AGENTS.md). Package đích và các cạnh import được phép: [package-dag.md](../apps/api/contract/package-dag.md) (mục 3, mục 4); bảng dưới chỉ liệt kê package đang có.

| Package                                                   | Trách nhiệm                                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmd/api`, `cmd/hrmctl`                                   | Entrypoint HTTP; CLI offline (`provision`, `migrate`, `sync`, lệnh Root và identity)                                                                 |
| `contract`                                                | Route, OpenAPI, privilege nhúng vào binary; mã lỗi kiểm bằng test; sửa tay (ADR-22)                                                                  |
| `internal/app`                                            | Composition root: thứ tự boot, ghép dependency, shutdown; chỉ `cmd/api` import                                                                       |
| `internal/config`                                         | Đọc env có validation                                                                                                                                |
| `internal/database`                                       | `database.Run` (đường duy nhất tới transaction ở runtime; offline dùng kết nối riêng), pool theo login, migration goose, `privilege_declarations.go` |
| `internal/offline`                                        | Provision, migrate, dọn session hết hạn, Root, enroll, reset 2FA; chỉ `cmd/hrmctl` import                                                            |
| `internal/apperror`                                       | Tập mã lỗi đóng, khớp `contract/api-errors.json`                                                                                                     |
| `internal/httpapi`                                        | Gin engine, `Register`, cookie/CSRF, `DecodeCommand`, ghi lỗi, route inventory                                                                       |
| `internal/authentication`                                 | Session, OIDC, 2FA, limiter và route `auth/*`; `credential/` là hàm thuần (digest phiên, TOTP, mã hóa MFA)                                           |
| `internal/authorization/core`, `values`                   | Lõi quyết định thuần, codec giá trị; không I/O                                                                                                       |
| `internal/authorization/compiler`, `gateway`              | Plan thành predicate SQL; đọc dữ liệu theo plan                                                                                                      |
| `internal/authorization/authority`                        | Ghép session, facts, plan và effect trong fenced transaction; handler chỉ nhận facade đã bind                                                        |
| `internal/authorization/declarations`, `keys`, `manifest` | Declarations của mọi module, hằng permission/resource, prepare và reconcile release                                                                  |
| `internal/authorization/enforcement`                      | Phân loại route và interface `RequestAuth` của guard sớm (cài ở composition root, chỉ kiểm shape cookie); không DB                                   |
| `internal/audit`, `internal/health`, `internal/openapi`   | Audit atomic và outbox; readiness; phục vụ `contract/openapi.json`                                                                                   |
| `internal/administration`                                 | Quản trị tài khoản: cấp, khóa/khôi phục, gán/thu hồi role, bind/unbind boundary, lệnh danh tính ADR-15                                               |
| `internal/modules/<module>`                               | Mỗi module nghiệp vụ một package (`employee`, `team`, `workrequest`, `leave`, `attendance`, `report`, `role`, …) và các package lõi HR dùng chung    |

- Module không import lẫn nhau; phần dùng chung đặt ở package lõi theo package-dag (`hrbase`, `schedulecore`, `attendancecore`, `leavecore`, `settingcore`, `permission`). Đổi cạnh import thì sửa khối mục 4 của package-dag.
- File `<snake>_<vai_trò>.go`, không folder vai trò. Handler (`*_controller.go`, `*_http_port.go`) không import driver, `database`, `audit`, `authority` hay gateway. Repository là hàm tự do nhận `tx`, không giữ `tx`. `*_helper.go` không nhận `context.Context`, không I/O. Tối đa 300 dòng code mỗi file, SQL chọn cột tường minh.
- Không có route HTTP cho provisioning, upload manifest hay bypass Root; các việc đó là CLI offline `hrmctl` (`cmd/hrmctl`, `internal/offline`).
- Kiểm bằng trình biên dịch, `test/imports_test.go`, `test/conventions_test.go` và `golangci-lint` (`forbidigo`, `depguard`); phần nào chỉ do review thì AGENTS.md của app ghi rõ.

## 5. Frontend (`apps/web/src`)

```text
main.tsx, app.tsx   # render; composition root (providers, routes)
app/                # theme.config (token duy nhất), navigation.config, layout, query-client.factory, app.config (VITE_*)
components/         # UI thuần dùng chung >= 2 feature, không import features/ hay app/
infrastructure/     # http.client.ts (chỉ /api/*, CSRF in-memory, không retry mutation)
i18n/               # locales/{vi,en}.json, provider, helper
features/<feature>/ # auth, account, administration, setting, home, employee, team, work-request, leave, attendance, work-calendar, report
```

- Mỗi feature sở hữu `*.client.ts` và context của nó; hai file cùng vai trò trở lên thì vào folder số nhiều (`pages/`, `components/`). `features/` không import `app/`, `infrastructure/` không import `features/`.
- Web không quyết định quyền: menu lấy từ `GET /api/auth/me`, hồ sơ và `companyScope` từ `GET /api/hr/employees/me`; ẩn nút chỉ là UX. Chữ hiển thị qua `t(key)` ở cả `vi` và `en`; lỗi hiển thị bằng `t(apiErrorKey(error))`.
- Server state là TanStack Query, query key bắt đầu bằng `namespace` của phiên, chỉ in-memory; không persist dữ liệu HR vào storage, không đưa CCCD/MST/lý do nghỉ/token vào URL hay log. Logout hủy query và xóa cache. Mutation không retry tự động, không optimistic update cho duyệt/số dư; giữ idempotency key khi người dùng thử lại.
- Giao diện: [hrm-ui-design-system](hrm-ui-design-system.md); quy tắc riêng app: `apps/web/AGENTS.md`.

## 6. Dữ liệu, giao dịch và đồng thời

- Một database, bảy login theo mục đích: `data`, `identity`, `authority`, `sync` cho API, và `migration`, `bootstrap`, `outbox` chỉ cho công cụ offline hoặc worker. API không giữ credential migration/bootstrap. ACL bảng/cột/hàm và body hàm bảo vệ được probe lúc boot, lệch thì không mở listener. Hàm `SECURITY DEFINER` hẹp (search_path cố định, owner NOLOGIN riêng). DB role bảo vệ ranh giới module, không thay predicate phân quyền cho record nghiệp vụ.
- Mọi giao dịch qua `database.Run`: READ COMMITTED, lấy application fence trước rồi đọc facts ở statement kế tiếp; shared fence cho đọc/ghi dữ liệu, exclusive cho đổi facts bảo mật (role, grant, boundary, suspend, revoke) và tăng revision cùng transaction. Deadline 3000 ms, lock timeout 1000 ms, tối đa 2 retry. Không mutex trong memory, không hash mật khẩu hay gọi network trong fence.
- Thứ tự khóa HR (ADR-09): fence, idempotency, employee theo ID tăng dần, request, bucket phép/WFH, kỳ công `FOR SHARE`. Mọi writer phép/công/đơn theo cùng thứ tự. Idempotency theo `(actor, action, key)` gắn target và hash payload.
- Phép và công: số phút nguyên (120/240/480 phút = 0,25/0,5/1 ngày), ledger append-only cho phép (hoàn bằng `reversal`), bảng công là hàm thuần của lịch versioned + hiệu ứng đơn đã duyệt + điều chỉnh có audit, kỳ công đóng/mở. Timezone nghiệp vụ `Asia/Ho_Chi_Minh`; ngày sinh/ngày làm việc là date, không parse theo timezone máy (ADR-08).
- Duyệt đơn là state machine hai bước Team Lead rồi COO; thiếu effect handler thì loại đơn đó đóng (fail closed). Mutation và audit bắt buộc cùng transaction; audit chỉ có actor/action/target/outcome/revision và metadata allowlist, không PII.
- Migration: file goose ở `apps/api/internal/database/migrations/`, bắt đầu bằng hai baseline `1792108800001_product_baseline.sql` và `1792108800002_application_baseline.sql` (ADR-14); không sửa migration đã áp dụng, thêm forward migration mới và ghim SHA-256 của nó trong `pinnedMigrations` (`internal/database/migrations_test.go`). Chỉ `hrmctl provision|migrate` áp migration; không migrate khi boot.

## 7. Manifest, release và khởi động

- Declarations ghép thành một release (`declarations.Source()`, `manifest.Prepare`): hash nội dung, sequence tăng đơn điệu với predecessor; hiện `Sequence: "6"` (`internal/authorization/declarations/product_declarations.go`). Đồng bộ idempotent dưới exclusive fence, không downgrade, không ghi đè fact runtime (assignment, tuple, binding). Cùng release nhưng lệch trạng thái code-owned thì không sẵn sàng; sửa bằng release mới hoặc repair offline có duyệt.
- Thứ tự khởi động (`internal/app`, `boot`): đọc route contract và privilege → mở bốn pool → dựng authority và provider OIDC → kiểm route inventory → probe privilege, protection → kiểm khóa 2FA → sync manifest → sync provider OIDC → bốn anchor → kiểm schema domain → `Gate.MarkReady()` → `listen`. Bước nào lỗi thì không mở listener.
- Thêm quyền mới: thêm hằng có kiểu ở `internal/authorization/keys`, khai báo action/policy và grant ở `internal/authorization/declarations`, dùng cùng hằng ở route hoặc command, tạo release mới; `declarations/product_test.go` ghim nội dung và hash release.

## 8. Adapter giá trị

Core sở hữu contract `ScalarCodec` (`Normalize`, `Compare`, `core/value_codecs_port.go`); adapter được chọn một lần ở `declarations.NewCore()` (`values.Codecs()`). Timestamp: UTC `YYYY-MM-DDTHH:mm:ss[.f{1..6}]Z`, năm 0001-9999, đầu ra luôn sáu chữ số lẻ, từ chối ngày không tồn tại, giờ 24, giây 60, offset, thiếu `Z` hoặc quá sáu chữ số lẻ. Adapter mới phải qua bộ conformance trong `internal/authorization/values/value_codecs_test.go` và kiểm parity PostgreSQL ở `internal/authorization/gateway/values_integration_test.go`. Hash manifest không đổi khi đổi adapter. Hiện chỉ có codec chuẩn của `values`.

## 9. Nơi đặt khi thêm mới

| Khi thêm                             | Nơi đặt / việc cần làm                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                             | Controller, validator, service, http-port trong module; OpenAPI (`contract/openapi.json`), status thực tế, test unauthenticated/unauthorized/invalid |
| Quy tắc nghiệp vụ                    | Service hoặc helper thuần của module sở hữu; test cả trường hợp từ chối và biên                                                                      |
| Quyền, resource, action              | Keys, declarations và release; cần boundary thì theo [permission-boundaries](permission-boundaries.md)                                               |
| Schema                               | Forward migration kèm test PostgreSQL thật; xét fence, lock order và ACL từng login                                                                  |
| Mã lỗi mới                           | `contract/api-errors.json`, `internal/apperror`, hai locale, OpenAPI, test; nêu lý do key không lộ facts ngoài quyền người gọi                       |
| Biến môi trường                      | `internal/config` (API) hoặc `app/app.config.ts` (web, `VITE_*`) có validation, thêm vào `.env.example`                                              |
| Màn hình                             | `*.page.tsx` trong `features/<feature>`, route ở `app.tsx`, menu ở `app/navigation.config.ts`, key `vi` và `en`                                      |
| Lệnh vận hành offline                | `cmd/hrmctl`, `internal/offline` và script trong `apps/api/package.json`; không route HTTP                                                           |
| Quyết định về quyền/identity/dữ liệu | ADR mới trong `docs/decisions/` trước khi code                                                                                                       |

Ở `apps/api`: endpoint là handler trong `internal/modules/<module>` đăng ký bằng `httpapi.Register`, body qua `httpapi.DecodeCommand`, kèm `contract/routes.json`, `contract/openapi.json`, `contract/route-ownership.md` và `httpapi.MigratedRoutes`; quyền ở `authorization/keys` và `authorization/declarations`; schema là migration goose trong `internal/database/migrations/` (đổi ACL, hàm, trigger thì sửa `privilege_declarations.go`); mã lỗi ở `internal/apperror` và `contract/api-errors.json`; env ở `internal/config`; lệnh offline ở `cmd/hrmctl` và `internal/offline`.

Đổi contract chạm cả hai app thì làm trong cùng thay đổi (API, OpenAPI, `*.client.ts`, locale, test); thứ tự triển khai tương thích là API trước, web sau.

## 10. Kiểm thử

Backend dùng `go test` (unit có `-race`; integration sau build tag `integration`) và PostgreSQL thật trong container (không SQLite); web dùng Vitest + Testing Library và Playwright với stack thật (`pnpm run test:browser`). Logic phân quyền, tiền/phút, parser và đồng thời có test hành vi gồm trường hợp từ chối. Lệnh và cách chạy: [operations](operations.md).

## 11. Ngoài phạm vi hiện tại

Tenant, MySQL/ORM thứ hai, role inheritance, public signup, API key, SAML, cache quyết định allow, chia fence theo module (chưa có số đo cần thiết), worker audit (chưa có sink), hợp đồng/ký (T10-T11). Có nhu cầu mới thì thêm đúng chức năng kèm test, không chuẩn bị abstraction trước.
