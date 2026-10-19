# @hrm/api

Ứng dụng NestJS duy nhất: config, health, authentication/session, authorization, administration, audit, database và domain demo D1 (review). Đọc root `AGENTS.md` trước; file này chỉ bổ sung phần riêng của app. ADR 0013 ghi việc gom bốn package vào app; không đổi hành vi quyền/dữ liệu.

## Ranh giới

- Logic phân quyền nằm trong `authorization/`; core thuần ở `authorization/core`, compiler/gateway và services ở cùng module. Không viết lại planner/compiler khi thêm feature; dùng implementation hiện có.
- Runtime mới có document fixture nhỏ (`document/document.declarations.ts`, `document/migrations/product-document.migration.ts`); không xây domain demo lớn hoặc UI.
- Handler không nhận DataSource/QueryRunner/credential thô; truy cập dữ liệu chỉ qua gateway/command của adapter.
- Import boundary (developer, không phải process isolation): HTTP feature handlers không import driver, gateway/compiler, authority/identity services, raw runtime hoặc offline commands ở runtime; được import types, facade tokens và HTTP helpers. `auth/services/` và migrations được dùng TypeORM trực tiếp. `infrastructure/` ghép services; provision/migrate/bootstrap chỉ tools dùng. `apps/api/test/module-boundaries.spec.ts` kiểm bằng ESLint thật, gồm negative cases và Root bypass.
- Không route HTTP cho provisioning, manifest upload hay superadmin bypass; các việc đó là CLI trong `apps/api/tools/`.

## Hiện trạng

- Chọn value codecs duy nhất ở `authorization/product.manifest.ts#createProductAuthorizationCore` (Day.js timestamp + standard codecs); `ProductRuntime.create` và `apps/api/tools/product.ts` cùng gọi nó, release là `createProductRelease(core)` (không prepare lúc import).
- `ProductRuntime` wire bốn DB logins, privilege probe, application fence và manifest sync vào AppModule thật trước listen/readiness. API env `apps/api/.env.api` riêng; không migration/bootstrap/admin secret.
- Handler nhận port token của capability (`AUTH_HTTP_PORT`, `DOCUMENT_HTTP_PORT` đã bind `document.read/update`, `ADMINISTRATION_HTTP_PORT`, `METRICS_SNAPSHOT`, `ReadinessGate`) chỉ gồm operations và HTTP config; không DataSource/manager/DB credentials, runner hay offline command. `ProductRuntime` là provider private của `RuntimeModule`; `apps/api/test/structure.spec.ts` kiểm DI thật và inventory route/OpenAPI.
- OIDC/session/2FA ở `auth/services/` (chỉ Google, ADR 0027: không đăng nhập/mật khẩu/khôi phục local; env `AUTH_METHODS` làm boot fail); route thiếu classification làm boot fail. Guard ở `authorization/enforcement/` kiểm session sớm, service vẫn recheck trong fenced transaction.
- Mọi route khai báo dưới `/api` ngay trong `@Controller` (ADR 0019); callback OIDC trả 303 tới đích cố định: `/` hoặc `/login?error=oidc`. Binding được gọi bằng `binding_ref`, không trả subject. ADR 0027 §6–7 (migration `017`): mỗi tài khoản tối đa một binding đang bật (partial unique index), không link/unlink, không xác thực lại bằng Google (purpose attempt chỉ `login`/`activation`); callback OIDC không bao giờ đặt `reauthenticated_at`, `fresh` chỉ từ 2FA. Identity không UPDATE binding nào; đổi Google của một người là lệnh operator riêng (chưa có), không route HTTP.
- API có document list/detail/update title và suspend IAM user (Root, hoặc grant + boundary; resource `account` bind `iam_account`); OpenAPI examples/status ở `/api/openapi.json`, metrics labels hữu hạn ở `/api/health/metrics`.
- Release `3` thêm fragment HR (`hr/hr.declarations.ts`, ADR 0016): roles `hr.*`, resources `employee`/`team`/`workRequest`, scope qua view `security_invoker`. Command HR chạy qua `ProductAuthorization.execute` với `ProductCommand` đăng ký lúc composition; tạo bản ghi dùng `hr/hr-database.helper.ts#registerHrObject`. Release `5` (T3) thêm `hrCompany`/`employeeIdentity`/`leaveRate` và write actions; đọc nghiệp vụ dùng `ProductQuery` qua `ProductAuthorization.query` (predicate plan alias `r`, AND trước aggregate/pagination). Command/query employee và team nằm trong `employee/employee.service.ts`, `team/team.service.ts`, đăng ký ở `infrastructure/product-runtime.service.ts`; `hr/` giữ phần dùng chung (declarations, DB helper, input validation, `GET /api/hr/me`).
- 2FA TOTP (ADR 0026, migration `016`): `auth/services/product-mfa.service.ts` (setup/confirm/verify/tạo lại mã/gỡ của chính phiên, và `resetProductMfa` chỉ cho CLI), `auth/helpers/totp.helper.ts` (RFC 6238, bước từ đồng hồ DB), `auth/helpers/mfa-encryption.helper.ts` (AES-256-GCM, khóa từ `MFA_ENCRYPTION_KEYS`/`MFA_ENCRYPTION_KEY_ID`), routes `/api/auth/mfa/*` ở `auth/controllers/mfa.controller.ts`, `mfa` trong `GET /api/auth/account`. Boot kiểm mọi `key_id` trong `mfa_totp` có trong key ring trước readiness (`ProductRuntime`). CLI `identity:reset-mfa` (IAM, login identity) và `root:reset-mfa` (Root, login bootstrap).
- Generic administration/file/export/jobs chưa mở. Product effects append audit trong transaction; `audit/product-outbox.service.ts` (login `outbox`, ADR0011) chưa wire vì chưa có sink thật — không tạo sink giả, không inject vào controller.

## Quy tắc khi sửa

- Biến môi trường mới: thêm vào `config/app.config.ts` có validation và vào `apps/api/.env.example` (không giá trị thật).
- DTO có validation và Swagger examples; route khai báo success shape và mọi status thực tế. Không trả field ngoài projection, không phân biệt foreign/absent.
- Không log secret, token, cookie, authorization header hay PII.
- User admin không có capability reset/link/impersonate global identity.
- 2FA (ADR 0026): tài khoản có 2FA đã xác nhận chỉ nhận `fresh` từ `POST /api/auth/mfa/verify`; đường mới đặt `reauthenticated_at` phải gọi `hasConfirmedSecondFactor` và từ chối như lỗi xác thực. Phiên sau confirm/verify/gỡ là bản chép dòng phiên cũ (method, binding, assurance, `authenticated_at`, `expires_at`), chỉ đổi `reauthenticated_at` và `auth_epoch`; không dùng `createSession` (sẽ kéo dài hạn). `auth_epoch` do 2FA đổi chỉ qua trigger `mfa_epoch` (xác nhận, gỡ, reset, sai từ lần thứ 10); không tăng tay thêm. Mọi thao tác 2FA (kể cả reset offline) khóa dòng `app_user` (`FOR NO KEY UPDATE`) trước khi đọc/ghi bảng 2FA, nên tuần tự với nhau; confirm/verify khóa thêm `mfa_totp FOR UPDATE`. Secret chỉ ở response setup, mã khôi phục chỉ ở confirm/tạo lại; không log/audit mã, secret, `key_id` hay khóa. Khóa mã hóa chỉ ở env API, không ở ops env/DB/test artifact (fixture dùng khóa ngẫu nhiên mỗi lần chạy). Lỗi giải mã là lỗi server (503), không tính là sai mã. Reset 2FA chỉ là CLI offline có approval, không route HTTP.
- Đổi `app_user.email_canonical` hoặc `email_verified` phải tăng `auth_epoch` trong cùng UPDATE (phiên dựa vào epoch, không so lại email; ADR 0023 §4.2). Trigger `require_email_epoch` (migration 015) từ chối mọi login vi phạm; đường mới đổi email cần ADR. Gắn email Root là CLI offline `set-root-email`, không route HTTP.

## Cấu trúc và composition

```text
src/main.ts, app.module.ts        # load config/listen; compose modules (không DB)
src/config/app.config.ts          # env parsing, secret-safe errors
src/infrastructure/               # runtime.module.ts (ProductRuntime private, export facades),
                                  # product-runtime.service.ts (pools, bootstrap, cleanup), http-security.helper.ts,
                                  # product-error.filter.ts
src/auth/                         # controllers/{auth,oidc,mfa}.controller.ts, auth.module.ts, auth.http-port.ts,
                                  # helpers/{totp,mfa-encryption}.helper.ts
src/document/                     # controller, document.http-port.ts, document.declarations.ts,
                                  # migrations/product-document.migration.ts
src/administration/               # user.controller.ts, administration.http-port.ts, account.declarations.ts
src/health/                       # live/ready/metrics, product-metrics.service.ts
src/authorization/product.manifest.ts  # codecs + compose fragments + createProductRelease(core)
src/authorization/core/          # pure validation/planner/evaluator, không I/O/framework
src/authorization/values/        # strict value codecs
src/authorization/enforcement/   # Nest route classification/inventory/guard
src/authorization/services/      # authority và manifest sync
src/authorization/helpers/       # shared release validation, obligations, drift hashes
src/auth/services/               # identity/session/password, OIDC và 2FA (product-mfa.service.ts)
src/database/                    # fixed-purpose transactions, DB probes/config, migrations
src/audit/                       # atomic audit writer và outbox delivery
src/openapi/                      # openapi.controller.ts, product-openapi.schema.ts
src/hr/                           # hr.declarations.ts, hr-database.helper.ts (grants/probe/object registry,
                                  # company anchor), hr-input.helper.ts, hr.controller.ts (/api/hr/me),
                                  # migrations/hrm-authorization.migration.ts
src/employee/, src/team/          # T3: service (commands/queries), controller, validator, types, http-port,
                                  # module, migrations/
```

- Feature module chỉ khai báo controllers; `AppModule` import `RuntimeModule.register(runtime)` vào từng feature module. Capability mới: thêm port token + bound operations trong `runtime.module.ts`, declaration fragment vào `authorization/product.manifest.ts`; không `@Global()`, không export `ProductRuntime`.
- Controller chỉ xử lý HTTP input/output và gọi operation đã định nghĩa; không đặt SQL, parsing scalar, policy algebra hoặc orchestration DB trong controller/filter. Không tạo service chỉ chuyển tiếp nếu không có trách nhiệm riêng.
- Chọn adapter và bind DI ở composition root. Module runtime giữ pool/config nhạy cảm private; feature chỉ inject facade/token có operations cần thiết. Không cast facade về runtime để lấy capability bị ẩn.
- Services import implementation trực tiếp; không thêm interface/repository abstraction chỉ để theo Clean Architecture. Core vẫn thuần và không biết tên domain hoặc Root.
- SQL chỉ parameterized, identifiers từ binding đã đăng ký; transaction chỉ dùng manager được truyền vào. Giữ DB clock/microseconds/collation, fence trước facts, audit/revision cùng commit; không network/hash mật khẩu trong fence.
- Migrations không đổi tên/timestamp/SQL đã áp dụng; thêm forward migration nếu cần semantics mới. Privilege/protection probes và negative tests phải khớp login/ACL/function/trigger thật; không gộp credentials.
- `ProductAuditOutbox` gửi ngoài transaction/fence, ack theo lease token và retry hữu hạn; chưa có sink thì không tự wire worker.
- Di chuyển file phải giữ route paths/status, cookie, CSRF, trusted proxy, projection, route classification và bootstrap ordering. Cập nhật imports/exports/tests/OpenAPI cùng task, không bỏ validation/error handling khi tách controller.
- Error filter dùng mapping lỗi có chủ đích; lỗi không biết trả lỗi server an toàn, không biến thành 200/allow hoặc lộ DB detail. Body lỗi là `{ statusCode, code }` với `code` từ `infrastructure/api-error.helper.ts#apiErrorCode` (key locale của web, quy tắc ở root `AGENTS.md` §Locale và mã lỗi). Giới hạn body/query/page size và validate trước khi gọi operation.
- Config mới phải fail boot nếu thiếu/sai và ảnh hưởng bảo mật; không default credential, permissive CORS/proxy hoặc fallback provider để app khởi động được. Không bật tính năng qua env khi semantics chưa được chốt.
- Mail/audit delivery không được coi là durable khi chỉ chạy promise nền; capability unavailable phải phản ánh đúng contract. Không thêm endpoint admin/debug để vượt provider hoặc xem secrets.

## Chạy

- `pnpm run start:dev` (build rồi chạy `apps/api/dist/main.js`, đọc `apps/api/.env.api` nếu có (root forwarding chạy với cwd API)).
- Smoke test: `pnpm run test:unit -- apps/api/test/workspace.smoke-spec.ts`.
- Route/OpenAPI inventory, DI boundary, bootstrap failure (không Docker): `pnpm run test:unit -- apps/api/test/structure.spec.ts`. Đổi route/facade có chủ ý thì sửa literal trong test cùng lý do.
- HTTP E2E: `pnpm run test:e2e -- apps/api/test/product.e2e-spec.ts` (cần Docker). Khi đổi routes/DI/auth, kiểm cả trường hợp unauthenticated, unauthorized, invalid input và response projection liên quan; không chỉ happy path.

## Tooling thuộc app

- API sở hữu `apps/api/test/`, `apps/api/tools/`, env/Compose và scripts/dependencies riêng trong `apps/api/package.json`. Root giữ orchestration và tooling/tests chung.
- Build chỉ emit source qua `tsconfig.build.json`; tests/tools kiểm thêm `tsconfig.test.json`. `tsconfig.json` bao phủ source/test/tools cho editor và ESLint project service.
- `apps/api/eslint.config.js` import baseline `eslint.shared.config.js` ở root và áp rules với path tương đối từ app; ESLint tìm config gần từng file.
- Env `.env.api`/`.env.ops` chỉ đọc trong app, không fallback về root hoặc trộn credentials runtime/ops.
- CLI activation artifacts tương đối resolve từ cwd API; ưu tiên absolute path tới vị trí riêng an toàn.
