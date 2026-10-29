# Kiến trúc HRM

Thiết kế hiện hành của hệ thống: một NestJS API, một React SPA, một PostgreSQL database, một tổ chức (không tenant). Quy tắc làm việc nằm ở `AGENTS.md` gốc và `AGENTS.md` của từng app; quyết định chi tiết ở [ADR](decisions/); lý do và bằng chứng lịch sử ở [history](history.md). Tài liệu này không ghi trạng thái từng task (xem checkbox trong [kế hoạch](superpowers/plans/)).

## 1. Hệ thống

- Stack: Node 24, pnpm workspace (`apps/api`, `apps/web`, một `pnpm-lock.yaml`), NestJS + TypeORM + PostgreSQL 18 ở API; React 19, Vite, Mantine 9, React Router, TanStack Query, Mantine Form + Zod ở web.
- Web và API cùng origin; mọi route API dưới `/api` (ADR 0019). Web chỉ gọi API qua HTTP, không import source của API và không chia sẻ DTO hay entity.
- Không có package nội bộ hay SDK dùng chung; module import tương đối trực tiếp tới file sở hữu (đuôi `.js` ở API). Muốn thêm contract chung phải có ADR (ADR 0013, 0015).
- Mỗi app sở hữu `package.json`, test, env (`.env.example`) và config; root chỉ giữ orchestration và tooling dùng chung (ADR 0015). Không dựa vào hoisting.

```text
hrm/
  apps/api/      # @hrm/api: src/, test/, tools/ (CLI offline), compose.yaml, .env.example, .env.ops.example
  apps/web/      # @hrm/web: src/, test/ (Vitest), e2e/ (Playwright)
  docs/          # tài liệu và ADR
  docker/        # stack dev đầy đủ trong container (compose.yaml, Dockerfile, root-activation.sh)
  scripts/       # dev.sh (Postgres + API + web local)
  seed/          # dữ liệu nhân viên và script enroll tài khoản
  test/          # test tooling chung (function-spacing, locale-keys, ...)
```

## 2. Xác thực và phiên

- Chỉ đăng nhập Google OIDC (ADR 0027): Authorization Code + PKCE S256, state/nonce một lần, issuer/audience/azp/chữ ký/hạn kiểm bằng `openid-client`. Không mật khẩu local, link/unlink hay xác thực lại bằng Google. Mỗi tài khoản đúng một binding Google đang bật, ánh xạ bằng `(issuer, subject)`; tài khoản IAM được tạo theo email và kích hoạt ở lần đăng nhập đầu có email đã xác minh trùng (ADR 0020).
- Phiên là opaque session lưu digest trong DB; tuyệt đối 12 giờ, idle 30 phút; cookie HttpOnly `SameSite=Lax` (`__Host-` khi HTTPS) cùng CSRF token và kiểm Origin cho mọi mutation. Claim IdP (group, role) không cấp quyền.
- `fresh` (bước xác thực gần đây, 300 giây) chỉ đến từ 2FA TOTP (ADR 0026); đăng nhập Google không bao giờ cho `fresh`. Action chỉ đòi `fresh` khi policy của nó có `fresh@1` (ADR 0022), kể cả với Root.
- Root là tài khoản `kind = 'root'` ngoài IAM (ADR 0012, 0021): tối đa một, tạo bằng CLI offline, mọi hành động tác động lên Root cũng chỉ qua CLI.
- Đồng hồ có thẩm quyền là đồng hồ PostgreSQL (hạn phiên, `fresh`, `auth_time`); Day.js chỉ là adapter parse timestamp UTC ở biên.

## 3. Mô hình phân quyền

```text
Allow = ValidUserAndSession AND PermissionPolicy AND UserPermissionBoundary
        AND (RoleAllow OR DirectAllow OR RecordAllow) AND NOT AnyDeny
```

- IAM principal: default deny, deny thắng allow. Permission policy và boundary nằm ngoài phép OR của grant, record exception không vượt được chúng. Không rank; bảo vệ giữa các IAM principal bằng boundary và deny. Action tác động lên principal khác phải là `boundary: 'required'`. Hợp đồng boundary: [permission-boundaries](permission-boundaries.md).
- Root bypass phân quyền qua `planUnrestricted`, chỉ khi `kind` đến từ phiên đã kiểm chứng trong giao dịch; mỗi `access` commit của Root được audit.
- List, detail, count, export và write dùng chung một AST và áp trước phân trang. Gateway giới hạn trang mặc định 20, tối đa 100, offset tối đa 10 000, tối đa 32 node filter (`authorization/product-data.gateway.ts`).
- Role, policy, template, boundary và relation do mã khai báo (`managed_by = 'code'`) và đồng bộ qua manifest; role/grant do UI tạo là `runtime`, chỉ chọn từ `(permission, template)` đã đăng ký. Không sửa code-owned qua UI.
- Hidden và absent record không phân biệt (cùng `error.notFound`). API lỗi luôn `{ statusCode, code }` với `code` thuộc `API_ERROR_CODES` và là key `error.*` của web.

## 4. Backend (`apps/api/src`)

| Khu vực                                | Trách nhiệm                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorization/core`                   | AST, validation, planner, evaluator thuần; không NestJS/TypeORM/SQL/network/tên domain                                                         |
| `authorization/values`                 | Codec giá trị (Day.js timestamp strict) qua port của core                                                                                      |
| `authorization/enforcement`            | Decorator, guard, route inventory; không truy cập DB                                                                                           |
| `authorization/services/…`             | Authority (`ProductAuthorization`), manifest sync, tài khoản, Root offline, obligations                                                        |
| `authorization/{repositories,helpers}` | DML manifest, protected state, facts; helper chỉ hàm đồng bộ                                                                                   |
| `authorization/product-*`              | Compiler SQL, gateway dữ liệu, `product.manifest.ts` (codec duy nhất + ghép declarations + release)                                            |
| `authentication/`                      | Controller (`auth`, OIDC, 2FA, `GET /api/auth/me`), identity/session/OIDC/2FA services, helper TOTP/mã hóa                                     |
| `administration/`                      | Quản trị tài khoản, declarations tài khoản                                                                                                     |
| `audit/`                               | Writer atomic và outbox delivery                                                                                                               |
| `database/`                            | Transaction runner, cấu hình/probe privilege, provisioning, hai baseline migration                                                             |
| `infrastructure/`                      | `RuntimeModule`, `ProductRuntime` (private), `product-modules.factory.ts`, bộ lọc lỗi, helper HTTP/idempotency/thời gian nghiệp vụ             |
| `health/`, `openapi/`, `config/`       | Readiness/metrics, schema OpenAPI, parse env có validation                                                                                     |
| `document/`                            | Fixture của lõi phân quyền, không HTTP (ADR 0032)                                                                                              |
| `modules/`                             | Nghiệp vụ HR (ADR 0031): `permission`, `employee`, `team`, `work-request`, `leave`, `attendance`, `work-calendar`, `report`, `setting`, `role` |

- Feature module chỉ khai báo controller và nhận facade đã bind (`*.http-port.ts`); handler không nhận DataSource, `ProductRuntime` hay credential. Controller chỉ xử lý HTTP; SQL, policy và điều phối DB nằm ở service/repository. Ranh giới import do ESLint và `apps/api/test/module-boundaries.spec.ts` kiểm; đây là ranh giới developer, không phải process isolation.
- Module HR điển hình: `<module>.module.ts`, `.controller.ts`, `.http-port.ts`, `.service.ts` (tạo mảng `ProductCommand`/`ProductQuery`), `repositories/*-read|command|effect.repository.ts`, `helpers/` (hàm thuần), `.validator.ts`, `.types.ts`, `<module>.declarations.ts`, `<module>-authorization.types.ts`. Declarations nằm ở module sở hữu (ADR 0035); repository là class tạo ở composition root (ADR 0033).
- Mỗi file nghiệp vụ tối đa 300 dòng không tính dòng trống/comment (ADR 0033). SQL chọn cột tường minh (ADR 0038). `*.helper.ts` không `async`.
- Không có route HTTP cho provisioning, upload manifest hay bypass Root; các việc đó là CLI trong `apps/api/tools/` (`product.ts`, `root-commands.ts`, `identity-commands.ts`).

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
- Mọi giao dịch qua `ProductTransactionRunner`: READ COMMITTED, lấy application fence trước rồi đọc facts ở statement kế tiếp; shared fence cho đọc/ghi dữ liệu, exclusive cho đổi facts bảo mật (role, grant, boundary, suspend, revoke) và tăng revision cùng transaction. Deadline 3000 ms, lock timeout 1000 ms, tối đa 2 retry. Không mutex trong memory, không hash mật khẩu hay gọi network trong fence.
- Thứ tự khóa HR (ADR 0017): fence, idempotency, employee theo ID tăng dần, request, bucket phép/WFH, kỳ công `FOR SHARE`. Mọi writer phép/công/đơn theo cùng thứ tự. Idempotency theo `(actor, action, key)` gắn target và hash payload.
- Phép và công: số phút nguyên (120/240/480 phút = 0,25/0,5/1 ngày), ledger append-only cho phép (hoàn bằng `reversal`), bảng công là hàm thuần của lịch versioned + hiệu ứng đơn đã duyệt + điều chỉnh có audit, kỳ công đóng/mở. Timezone nghiệp vụ `Asia/Ho_Chi_Minh`; ngày sinh/ngày làm việc là date, không parse theo timezone máy (ADR 0018).
- Duyệt đơn là state machine hai bước Team Lead rồi COO; thiếu effect handler thì loại đơn đó đóng (fail closed). Mutation và audit bắt buộc cùng transaction; audit chỉ có actor/action/target/outcome/revision và metadata allowlist, không PII.
- Migration: hai baseline `001-product-baseline` và `002-application-baseline` (ADR 0048); từ baseline không sửa migration đã áp dụng, thêm forward migration và đăng ký trong `allMigrations` (`database/helpers/product-database.helper.ts`). `synchronize: false`, không migrate khi boot.

## 7. Manifest, release và khởi động

- Declarations của các module ghép thành một release (`product.manifest.ts`): hash nội dung, sequence tăng đơn điệu với predecessor; hiện `sequence '1'` (genesis). Đồng bộ idempotent dưới exclusive fence, không downgrade, không ghi đè fact runtime (assignment, tuple, binding). Cùng release nhưng lệch trạng thái code-owned thì không sẵn sàng; sửa bằng release mới hoặc repair offline có duyệt.
- Thứ tự khởi động (`main.ts`): `ProductRuntime.create` (codec, bốn pool) → kiểm route inventory → probe privilege/protection → sync manifest → sync provider OIDC → kiểm bảng domain → `ReadinessGate.markReady()` → `listen`. Bước nào lỗi thì không mở listener.
- Thêm quyền mới: thêm hằng có kiểu ở `<module>-authorization.types.ts`, khai báo action/policy và grant trong `<module>.declarations.ts`, dùng cùng hằng ở decorator hoặc command, tạo release mới; `test/authorization-keys.spec.ts` ghim chuỗi đã lưu.

## 8. Adapter giá trị

Core sở hữu contract `ScalarCodec` (`normalize(input: unknown): string | undefined`, `compare`); adapter sở hữu thư viện và được chọn một lần ở `createProductAuthorizationCore()`. Timestamp: UTC `YYYY-MM-DDTHH:mm:ss[.f{1..6}]Z`, năm 0001-9999, đầu ra luôn sáu chữ số lẻ, từ chối ngày không tồn tại, giờ 24, giây 60, offset, thiếu `Z` hoặc quá sáu chữ số lẻ. Adapter mới phải qua bộ conformance trong `apps/api/test/values/value-codecs.spec.ts` (chưa là export dùng lại: cần copy hoặc promote các case) và kiểm parity PostgreSQL ở `product-values.integration-spec.ts`. Hash manifest không đổi khi đổi adapter. Hiện chỉ có Day.js.

## 9. Nơi đặt khi thêm mới

| Khi thêm                             | Nơi đặt / việc cần làm                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint                             | Controller, validator, service, http-port trong module; OpenAPI (`openapi/`), status thực tế, test unauthenticated/unauthorized/invalid |
| Quy tắc nghiệp vụ                    | Service hoặc helper thuần của module sở hữu; test cả trường hợp từ chối và biên                                                         |
| Quyền, resource, action              | Declarations và release của module; cần boundary thì theo [permission-boundaries](permission-boundaries.md)                             |
| Schema                               | Forward migration kèm test PostgreSQL thật; xét fence, lock order và ACL từng login                                                     |
| Mã lỗi mới                           | `API_ERROR_CODES`, hai locale, OpenAPI, test; nêu lý do key không lộ facts ngoài quyền người gọi                                        |
| Biến môi trường                      | `config/app.config.ts` (API) hoặc `app/app.config.ts` (web, `VITE_*`) có validation, thêm vào `.env.example`                            |
| Màn hình                             | `*.page.tsx` trong `features/<feature>`, route ở `app.tsx`, menu ở `app/navigation.config.ts`, key `vi` và `en`                         |
| Lệnh vận hành offline                | `apps/api/tools/` và script trong `apps/api/package.json`; không route HTTP                                                             |
| Quyết định về quyền/identity/dữ liệu | ADR mới trong `docs/decisions/` trước khi code                                                                                          |

Đổi contract chạm cả hai app thì làm trong cùng thay đổi (API, OpenAPI, `*.client.ts`, locale, test); thứ tự triển khai tương thích là API trước, web sau.

## 10. Kiểm thử

Backend dùng `node:test` và PostgreSQL thật qua Testcontainers (không SQLite); web dùng Vitest + Testing Library và Playwright với stack thật (`pnpm run test:browser`). Logic phân quyền, tiền/phút, parser và đồng thời có test hành vi gồm trường hợp từ chối. Lệnh và cách chạy: [operations](operations.md).

## 11. Ngoài phạm vi hiện tại

Tenant, MySQL/ORM thứ hai, role inheritance, public signup, API key, SAML, cache quyết định allow, chia fence theo module (chưa có số đo cần thiết), worker audit (chưa có sink), hợp đồng/ký (T10-T11). Có nhu cầu mới thì thêm đúng chức năng kèm test, không chuẩn bị abstraction trước.
