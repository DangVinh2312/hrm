# @hrm/api

Ứng dụng NestJS duy nhất: config, health, authentication/session, authorization, administration, audit, database và domain demo D1 (review). Đọc root `AGENTS.md` trước; file này chỉ bổ sung phần riêng của app. ADR 0013 ghi việc gom bốn package vào app; không đổi hành vi quyền/dữ liệu.

## Ranh giới

- Logic phân quyền nằm trong `authorization/`; core thuần ở `authorization/core`, compiler/gateway và services ở cùng module. Không viết lại planner/compiler khi thêm feature; dùng implementation hiện có.
- Resource `document` (`document/document.declarations.ts`, `document/migrations/product-document.migration.ts`) chỉ là fixture của lõi phân quyền, không có route HTTP (ADR 0032); không xây domain demo lớn hoặc UI.
- Handler không nhận DataSource/QueryRunner/credential thô; truy cập dữ liệu chỉ qua gateway/command của adapter.
- Import boundary (developer, không phải process isolation): HTTP feature handlers không import driver, gateway/compiler, authority/identity services, raw runtime hoặc offline commands ở runtime; được import types, facade tokens và HTTP helpers. `auth/services/` và migrations được dùng TypeORM trực tiếp. `infrastructure/` ghép services; provision/migrate/bootstrap chỉ tools dùng. `apps/api/test/module-boundaries.spec.ts` kiểm bằng ESLint thật, gồm negative cases và Root bypass.
- Không route HTTP cho provisioning, manifest upload hay superadmin bypass; các việc đó là CLI trong `apps/api/tools/`.

## Hiện trạng

- Chọn value codecs duy nhất ở `authorization/product.manifest.ts#createProductAuthorizationCore` (Day.js timestamp + standard codecs); `ProductRuntime.create` và `apps/api/tools/product.ts` cùng gọi nó, release là `createProductRelease(core)` (không prepare lúc import).
- `ProductRuntime` wire bốn DB logins, privilege probe, application fence và manifest sync vào AppModule thật trước listen/readiness. API env `apps/api/.env.api` riêng; không migration/bootstrap/admin secret.
- Handler nhận port token của capability (`AUTH_HTTP_PORT`, `ADMINISTRATION_HTTP_PORT`, `METRICS_SNAPSHOT`, `ReadinessGate`) chỉ gồm operations và HTTP config; không DataSource/manager/DB credentials, runner hay offline command. `ProductRuntime` là provider private của `RuntimeModule`; `apps/api/test/structure.spec.ts` kiểm DI thật và inventory route/OpenAPI.
- OIDC/session/2FA ở `auth/services/` (chỉ Google, ADR 0027: không đăng nhập/mật khẩu/khôi phục local; env `AUTH_METHODS` làm boot fail); route thiếu classification làm boot fail. Guard ở `authorization/enforcement/` kiểm session sớm, service vẫn recheck trong fenced transaction.
- Mọi route khai báo dưới `/api` ngay trong `@Controller` (ADR 0019); callback OIDC trả 303 tới đích cố định: `/` hoặc `/login?error=oidc`. Binding được gọi bằng `binding_ref`, không trả subject. ADR 0027 §6–7 (migration `017`): mỗi tài khoản tối đa một binding đang bật (partial unique index), không link/unlink, không xác thực lại bằng Google (purpose attempt chỉ `login`/`activation`); callback OIDC không bao giờ đặt `reauthenticated_at`, `fresh` chỉ từ 2FA. Identity không UPDATE binding nào; đổi Google của một người là lệnh operator riêng (chưa có), không route HTTP.
- API có suspend IAM user (Root, hoặc grant + boundary; resource `account` bind `iam_account`); OpenAPI examples/status ở `/api/openapi.json`, metrics labels hữu hạn ở `/api/health/metrics`.
- Release `3` thêm fragment HR (`modules/hr/hr.declarations.ts`, ADR 0016): roles `hr.*`, resources `employee`/`team`/`workRequest`, scope qua view `security_invoker`. Command HR chạy qua `ProductAuthorization.execute` với `ProductCommand` đăng ký lúc composition; tạo bản ghi dùng `modules/hr/hr-database.helper.ts#registerHrObject`. Release `5` (T3) thêm `hrCompany`/`employeeIdentity`/`leaveRate` và write actions; đọc nghiệp vụ dùng `ProductQuery` qua `ProductAuthorization.query` (predicate plan alias `r`, AND trước aggregate/pagination). Command/query employee và team: class và mảng đăng ký ở `modules/employee/employee.service.ts`, `modules/team/team.service.ts`, định nghĩa ở `*-command.repository.ts`/`*-read.repository.ts` cùng module (ADR 0033); đăng ký ở `infrastructure/product-runtime.service.ts`; `modules/hr/` giữ phần dùng chung (declarations, DB helper, input validation, `GET /api/hr/me`).
- 2FA TOTP (ADR 0026, migration `016`): `auth/services/product-mfa.service.ts` (setup/confirm/verify/tạo lại mã/gỡ của chính phiên, và `resetProductMfa` chỉ cho CLI), `auth/helpers/totp.helper.ts` (RFC 6238, bước từ đồng hồ DB), `auth/helpers/mfa-encryption.helper.ts` (AES-256-GCM, khóa từ `MFA_ENCRYPTION_KEYS`/`MFA_ENCRYPTION_KEY_ID`), routes `/api/auth/mfa/*` ở `auth/controllers/mfa.controller.ts`, `mfa` trong `GET /api/auth/account`. Boot kiểm mọi `key_id` trong `mfa_totp` có trong key ring trước readiness (`ProductRuntime`). CLI `identity:reset-mfa` (IAM, login identity) và `root:reset-mfa` (Root, login bootstrap).
- Root và IAM chỉ theo email (ADR 0027 §3–5, migration `019`): `authorization/services/product-root.service.ts` (`bootstrapProductRoot` sinh id, INSERT tài khoản pending rồi promote qua `guard_root_kind` trong một transaction `bootstrap`, ghim `(issuer, email)` bằng `oidc_email_enrollment`, token `oidc-activation` 15 phút; `reissueRootActivation` chỉ Root pending chưa có binding) và `product-root-lifecycle.service.ts` (`revokeProductRoot`, `setRootEmail`). Kích hoạt Root ở `auth/services/product-oidc-enrollment.service.ts` (`rootInvitation`/`rootEnrollmentHash`/`activateRoot`): ID token phải `email_verified === true` đúng email đã ghim, một commit gồm binding + một UPDATE `state/email_verified/auth_epoch`. Không còn `--subject`, `--method`, `identity:invite`, `issueActivation`; CLI chỉ nhận đúng flag khai báo cho từng lệnh (`tools/product.ts`, lệnh ở `tools/{root,identity}-commands.ts`). Login `identity` không có INSERT trên `one_time_token` (migration `020`); chỉ `bootstrap` phát token, test cần token dùng login `bootstrap` hoặc `bootstrapProductRoot`.
- Phép năm (T7, release `10`, migration `109`): `modules/leave/` — tích lũy là hàm thuần (`leave-balance.helper.ts`, không lưu), ledger append-only `leave_ledger` + điểm khóa `leave_bucket`, quyền đọc `employee.readLeaveBalance` (trên hàng `employee`), `GET /api/hr/employees/:id/leave-balance` và `GET /api/hr/leave/reconciliation`. Submit annual-leave kiểm số dư (`error.insufficientLeave`); effect `applyApprovedLeave` chạy trong transaction decide qua `approvedEffects` (theo phần `leave`/`attendance`/`wfh`).
- Bảng công (T8, release `11`, migration `110`): `modules/attendance/` — bảng công là hàm thuần (`attendance-calculation.helper.ts`, không lưu; effect công của một đơn là chính đơn `approved`), bảng `wfh_month_counter` (khóa D04), `attendance_period` + `attendance_period_event` (đóng/mở kỳ D07), `employee.readAttendance`, `GET /api/hr/employees/:id/attendance`, `POST /api/hr/attendance/periods/:month/{close,reopen}` (`hrCompany.managePeriod`, fresh). Production đăng ký đủ `approvedEffects` = `leave`, `wfh`, `attendance` nên mọi loại đơn mở duyệt cuối (thiếu phần nào thì loại cần nó vẫn đóng, fail closed); thứ tự khóa decide: request → bucket phép / counter WFH → kỳ công `FOR SHARE` (ADR 0017 bổ sung T8). Submit và `setCalendarDay` khóa kỳ `FOR SHARE` qua `assertPeriodsOpen` (`error.periodClosed`); duyệt WFH vượt 4 ngày/tháng cần `acknowledgeWfhLimit` (`error.wfhLimitAckRequired`). Chưa làm: điều chỉnh công của HR (`attendance.adjust`, spec chưa chốt mô hình).
- T8 phần B (release `12`, migration `111`): hủy đơn (`modules/work-request/services/request-cancel.service.ts`, `POST /api/hr/requests/:id/cancel`; chủ đơn hủy đơn chờ, HR fresh hủy đơn đã duyệt có lý do: `reversal` ledger mỗi debit, trừ counter WFH, kỳ `FOR SHARE`; chủ đơn hủy đơn đã duyệt → 409), điều chỉnh phép (`employee.adjustLeaveBalance`, `POST /api/hr/employees/:id/leave-adjustments`, `reference` bắt buộc, kỳ mở, idempotent), `GET /api/hr/attendance/periods/:month` (`hrCompany.read`), COO tự duyệt lúc submit (`createSubmitRequest(effects)` chạy effect của loại đơn sau INSERT, decision `coo_self_approved`), và `createEmployee`/`terminateEmployee` bị từ chối `error.periodClosed` khi có kỳ đã chốt từ ngày đó trở đi (khóa hàng `hr_company`, ADR 0017 bổ sung T8 phần B). `replay` idempotency dùng chung ở `modules/hr/hr-idempotency.helper.ts`.
- Generic administration/file/export/jobs chưa mở. Product effects append audit trong transaction; `audit/product-outbox.service.ts` (login `outbox`, ADR0011) chưa wire vì chưa có sink thật — không tạo sink giả, không inject vào controller.

## Quy tắc khi sửa

- File dưới `src/` tối đa 300 dòng không tính dòng trống/comment (ADR 0033, ESLint `max-lines`); miễn `*.declarations.ts`, `*.schema.ts`, `*.migration.ts`, `*.manifest.ts`. Ngoại lệ tạm (nền tảng: `product-mfa.service.ts`, `policy.validator.ts`, `product-authority.service.ts`, `product-database.helper.ts`) nằm trong `eslint.config.js`; xóa dòng tương ứng khi tách file, không thêm file mới vào danh sách. Service nghiệp vụ tách thành `*-read.repository.ts` (query), `*-command.repository.ts`/`*-effect.helper.ts` (ghi/effect), `*-database.helper.ts`/`*-facts.repository.ts` (SQL dùng chung); `*.service.ts` giữ class và mảng command/query đăng ký ở `product-runtime.service.ts`.
- Biến môi trường mới: thêm vào `config/app.config.ts` có validation và vào `apps/api/.env.example` (không giá trị thật).
- DTO có validation và Swagger examples; route khai báo success shape và mọi status thực tế. Không trả field ngoài projection, không phân biệt foreign/absent.
- Không log secret, token, cookie, authorization header hay PII.
- User admin không có capability reset/link/impersonate global identity.
- 2FA (ADR 0026): tài khoản có 2FA đã xác nhận chỉ nhận `fresh` từ `POST /api/auth/mfa/verify`; đường mới đặt `reauthenticated_at` phải gọi `hasConfirmedSecondFactor` và từ chối như lỗi xác thực. Phiên sau confirm/verify/gỡ là bản chép dòng phiên cũ (method, binding, assurance, `authenticated_at`, `expires_at`), chỉ đổi `reauthenticated_at` và `auth_epoch`; không dùng `createSession` (sẽ kéo dài hạn). `auth_epoch` do 2FA đổi chỉ qua trigger `mfa_epoch` (xác nhận, gỡ, reset, sai từ lần thứ 10); không tăng tay thêm. Mọi thao tác 2FA (kể cả reset offline) khóa dòng `app_user` (`FOR NO KEY UPDATE`) trước khi đọc/ghi bảng 2FA, nên tuần tự với nhau; confirm/verify khóa thêm `mfa_totp FOR UPDATE`. Secret chỉ ở response setup, mã khôi phục chỉ ở confirm/tạo lại; không log/audit mã, secret, `key_id` hay khóa. Khóa mã hóa chỉ ở env API, không ở ops env/DB/test artifact (fixture dùng khóa ngẫu nhiên mỗi lần chạy). Lỗi giải mã là lỗi server (503), không tính là sai mã. Reset 2FA chỉ là CLI offline có approval, không route HTTP.
- Đổi `app_user.email_canonical` hoặc `email_verified` phải tăng `auth_epoch` trong cùng UPDATE (phiên dựa vào epoch, không so lại email; ADR 0023 §4.2). Trigger `require_email_epoch` (migration 015) từ chối mọi login vi phạm; đường mới đổi email cần ADR. Gắn email Root là CLI offline `set-root-email`, không route HTTP.

## Cấu trúc và composition

```text
src/modules/                      # nghiệp vụ HR (ADR 0031): hr, employee, team, work-request, leave, attendance, work-calendar;
                                  # chỉ import nền tảng và modules/hr, không import lẫn nhau trừ qua port/token
src/main.ts, app.module.ts        # load config/listen; compose modules (không DB)
src/config/app.config.ts          # env parsing, secret-safe errors
src/infrastructure/               # runtime.module.ts (ProductRuntime private, export facades),
                                  # product-runtime.service.ts (pools, bootstrap, cleanup), http-security.helper.ts,
                                  # product-error.filter.ts
src/auth/                         # controllers/{auth,oidc,mfa}.controller.ts, auth.module.ts, auth.http-port.ts,
                                  # helpers/{totp,mfa-encryption}.helper.ts
src/document/                     # fixture lõi (ADR 0032, không HTTP): document.declarations.ts,
                                  # migrations/product-document.migration.ts
src/administration/               # user.controller.ts, administration.http-port.ts, account.declarations.ts
src/health/                       # live/ready/metrics, product-metrics.service.ts
src/authorization/product.manifest.ts  # codecs + compose fragments + createProductRelease(core)
src/authorization/core/          # pure validation/planner/evaluator, không I/O/framework
src/authorization/values/        # strict value codecs
src/authorization/enforcement/   # Nest route classification/inventory/guard
src/authorization/services/      # authority, manifest sync, product-root*.service.ts (Root offline)
src/authorization/helpers/       # shared release validation, obligations, drift hashes
src/auth/services/               # identity/session, OIDC và 2FA (product-mfa.service.ts)
src/database/                    # fixed-purpose transactions, DB probes/config, migrations
src/audit/                       # atomic audit writer và outbox delivery
src/openapi/                      # openapi.controller.ts, product-openapi.schema.ts
src/modules/hr/                           # hr.declarations.ts, hr-database.helper.ts (grants/probe/object registry,
                                  # company anchor), hr-input.helper.ts, hr.controller.ts (/api/hr/me),
                                  # migrations/hrm-authorization.migration.ts
src/modules/employee/, team/    # T3: service (commands/queries), controller, validator, types, http-port,
                                  # module, migrations/
src/modules/leave/                        # T7: leave.service.ts (balance, reconciliation, applyApprovedLeave),
                                  # leave-balance.helper.ts (accrual thuần), validator, controller, http-port,
                                  # module, migrations/hrm-leave.migration.ts
src/modules/attendance/                   # T8: attendance.service.ts (bảng công, kỳ, applyApprovedAttendance/Wfh, reverseApprovedWfh),
                                  # attendance-calculation.helper.ts (hàm thuần), validator, controller, http-port,
                                  # module, migrations/hrm-attendance.migration.ts
```

- Feature module chỉ khai báo controllers; `AppModule` import `RuntimeModule.register(runtime)` vào từng feature module. Capability mới: thêm port token + bound operations trong `runtime.module.ts`, declaration fragment vào `authorization/product.manifest.ts`; không `@Global()`, không export `ProductRuntime`.
- Controller chỉ xử lý HTTP input/output và gọi operation đã định nghĩa; không đặt SQL, parsing scalar, policy algebra hoặc orchestration DB trong controller/filter. Không tạo service chỉ chuyển tiếp nếu không có trách nhiệm riêng.
- Chọn adapter và bind DI ở composition root. Module runtime giữ pool/config nhạy cảm private; feature chỉ inject facade/token có operations cần thiết. Không cast facade về runtime để lấy capability bị ẩn.
- Services import implementation trực tiếp; không thêm interface/repository abstraction chỉ để theo Clean Architecture. Core vẫn thuần và không biết tên domain hoặc Root.
- SQL chỉ parameterized, identifiers từ binding đã đăng ký; transaction chỉ dùng manager được truyền vào. Giữ DB clock/microseconds/collation, fence trước facts, audit/revision cùng commit; không network/hash mật khẩu trong fence.
- Migrations không đổi tên/timestamp/SQL đã áp dụng; thêm forward migration nếu cần semantics mới. Privilege/protection probes và negative tests phải khớp login/ACL/function/trigger thật; không gộp credentials.
- `ProductAuditOutbox` gửi ngoài transaction/fence, ack theo lease token và retry hữu hạn; chưa có sink thì không tự wire worker.
- Di chuyển file phải giữ route paths/status, cookie, CSRF, trusted proxy, projection, route classification và bootstrap ordering. Cập nhật imports/exports/tests/OpenAPI cùng task, không bỏ validation/error handling khi tách controller.
- Error filter dùng mapping lỗi có chủ đích; lỗi không biết trả lỗi server an toàn, không biến thành 200/allow hoặc lộ DB detail. Body lỗi là `{ statusCode, code }` với `code` từ `infrastructure/api-error.helper.ts#apiErrorCode` (theo status) hoặc, duy nhất, từ `ApiRejection` (tập đóng key→status, service ném sau khi authorize); `code` là key locale của web, quy tắc ở root `AGENTS.md` §Locale và mã lỗi. Giới hạn body/query/page size và validate trước khi gọi operation.
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
