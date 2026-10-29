# Kế hoạch — Quản lý quyền (gán/thu hồi role và boundary, xem quyền hiệu lực)

> **ĐÃ ĐÓNG 2026-10-29 — superseded by [ADR 0041](../../decisions/0041-administration-settings-roles-accounts.md) và [kế hoạch administration](2026-10-23-administration.md).** ADR 0030 chưa từng Accepted; thiết kế neo vào `employee` (`protectedGroup`, `roleAdministration@1/2`) không được triển khai và các symbol đó không có trong `apps/`. Checkbox bên dưới giữ nguyên làm lịch sử, **không tick và không dùng làm bằng chứng hoàn thành**. Mục không còn trong ADR 0041 (vd. reissue lời mời) chỉ làm khi có quyết định mới.

Ngày: 2026-10-20. Nguồn thiết kế: [ADR 0030](../../decisions/0030-permission-management.md) (**Proposed — chưa được duyệt; không triển khai trước khi người dùng chuyển sang Accepted**), [ADR 0012](../../decisions/0012-iam-root-separation.md), [ADR 0016](../../decisions/0016-hrm-authorization-and-pii.md), [ADR 0022](../../decisions/0022-root-step-up-and-time-source.md), [ADR 0027](../../decisions/0027-google-only-sign-in.md) §9, [ADR 0029](../../decisions/0029-account-management-ui.md), [permission boundaries](../../permission-boundaries.md), [design system](../../hrm-ui-design-system.md), [vận hành local](../../hrm-local-operations.md). Trạng thái lấy từ checkbox dưới đây; bước chưa đánh dấu là chưa có bằng chứng. Sản phẩm đang phát triển, chưa release production.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Test lỗi trước, rồi implement. Chỉ làm task được yêu cầu.

## Trạng thái đầu vào (đã kiểm 2026-10-20)

- Nhánh `version/single-app`, HEAD `83b8efa`; working tree có thay đổi của người khác (`work-request/`, `app.module.ts`…): không stage/sửa chúng. Chưa chạy test/lint nào cho kế hoạch này.
- Đã có: login `authority` với `INSERT/UPDATE/DELETE` trên `user_role`/`user_boundary` (`database/helpers/product-database.helper.ts`), trigger `protect_product_rows`/`guard_root_not_iam_subject`, mode `admin` (exclusive fence + `revision+1`), `ProductAuthorization.execute`/`query`, `GET /api/administration/accounts` (`account.read`). Chưa có: bất kỳ route/CLI ghi `user_role`/`user_boundary`.
- Giả định cần kiểm ở T1 (sai giả định nào thì dừng và sửa ADR trước): xem ADR 0030 mục Bối cảnh (1)–(4); thêm: `execute` bắt được `ProductCommandAbsent` ném trước mọi ghi mà vẫn để Root absent-audit chạy; khóa `FOR NO KEY UPDATE` trên `app_user` được `authority` cấp (UPDATE cột); số permission trong catalog đủ nhỏ cho một response; `HrMenu`/`GET /api/hr/me` mở rộng được thêm `permissions`.
- Release/migration: ADR 0029 (chưa merge) dự kiến release `8`, migration `021`; lấy số kế tiếp theo thứ tự merge, đừng trùng.

## Cổng

- [ ] **T0** Người dùng duyệt ADR 0030 (mọi câu hỏi mở đã chốt, ghi ở mục Quyết định của người dùng của ADR). Cập nhật header ADR sang Accepted.

## Tasks

### T1 — Kiểm giả định từ source và DB schema (không sửa code)

- [ ] Đọc và ghi vào ledger bằng chứng cho từng giả định: (0) `context.authorizeTarget` khả thi trên planner/compiler hiện có (đối tượng thứ hai `account` với trường `protectedGroup`), `FOR NO KEY UPDATE` trên view tài khoản hoặc trên `app_user`; (1) binding tài nguyên `role`/`boundaryDefinition` (compiler `authorization/product-sql.compiler.ts` chấp nhận `keyKind: 'string'`, khóa `bytea` cần view?); (2) `planUser` trả đủ allow/deny theo permission cho principal tùy ý với snapshot dựng trong bộ nhớ (không N+1); (3) trigger còn lại trên `user_role` sau `012` (`protect_system_activation`, `require_root_marker` đã drop?); (4) `audit_outbox` payload nhận field `grant`; (5) `execute` + `ProductCommandAbsent` (thiết kế ở T3); (6) số permission/catalog và role/boundary hiện có; mọi boundary hiện có thỏa quy tắc (f) (mọi entry `required`); (7) không có cache quyền (`rg` cache trong `authorization/`, `auth/`).
- [ ] Chạy trên DB disposable (integration test, không `.env`/DB thật): `authority` INSERT/DELETE `user_role` role `hr.admin` thành công; INSERT cho Root bị `guard_root_not_iam_subject` chặn; UPDATE/DELETE `user_boundary` có `seed_owner` bị chặn; ghi vào `policy_rule` code-owned bị chặn. Kết quả ghi ledger; nếu cần migration/view thì thêm mục T2.

### T2 — View đọc, probe (bắt buộc)

**Files tạo:** migration forward kế tiếp trong `apps/api/src/database/migrations/` (view `role_directory`, `boundary_directory`, và cột `protected_group` trong view tài khoản mới `account_permission_directory`, `security_invoker` hoặc owner-rights như `account_directory` tùy T1; tập role bảo vệ lấy từ hằng, không hardcode ngoài migration + test khớp); **Sửa:** `expectedPrivileges`, probe, `account.declarations.ts` (trường `protectedGroup`, binding mới).

- [ ] Test trước (`apps/api/test/product-permission-views.integration-spec.ts`, PostgreSQL thật): view chỉ chứa role `managed_by='code'`/boundary `active`, không lộ cột khác; `protected_group` true đúng khi tài khoản giữ `access.admin` hoặc `hr.admin`, false với role khác/không role, Root không xuất hiện; **tập role bảo vệ trong SQL khớp hằng `protectedRoles` ở declarations** (test đỏ nếu lệch); `data`/`authority` đọc được, `identity`/`bootstrap` không; probe báo drift khi cấp thừa/thiếu.

### T3 — Declarations, catalog boundary mặc định, release và matrix

**Tạo:** `administration/permission.declarations.ts` (resource `role`, `boundaryDefinition`, action trên `account`, policy `permissionFresh@1`, template, **catalog boundary theo ADR 0030 quyết định 5**, role `access.admin` + grant), `apps/api/test/fixtures/permission-matrix.ts` (bảng dữ liệu: actor × thao tác → kết quả mong đợi, dùng chung cho test declarations/integration/E2E). **Sửa:** `authorization/product.manifest.ts` (fragment, `roles`, `defaultGrants`, `boundaryBindings` giữ `[]`, release kế tiếp), fixture release trước, `hrm-authorization-upgrade.integration-spec.ts`, `hr/hr.declarations.ts` (`hrAdministration@2` nếu ADR 0029 chưa thêm; không trùng với task 0029).

Catalog (tên@version → permission, scope, người gắn): `hrAdministration@1` (có sẵn) và `@2`; `roleAdministration@1` (`hr.employee`, `hr.coo`) và `@2` (+`hr.admin`); `boundaryAdministration@1` (`hrAdministration@1|@2`); `adminGroupProtection@1` (`account.targetRole|targetBoundary`, `protectedGroup = false`). Mọi entry `required`. `sync` seed: định nghĩa, role, grant. Mọi binding là runtime.

- [ ] Test declarations trước: mọi action ghi và `account.target*` có `boundary: 'required'`; policy của action ghi có `fresh@1`; `role.read`/`boundaryDefinition.read`/`account.readPermissions` `optional`; `account.readPermissions` có `audit@1`; definitions bất biến (đổi entry mà không đổi version → hash đổi, test sync từ chối); **không phong bì nào chứa `access.admin`, và không scope của `boundaryAdministration` chứa boundary `*Administration`/`adminGroupProtection` ngoài `hrAdministration`** (thay cho hằng `nonDelegable`; mutation: thêm `access.admin` vào `roleAdministration@2` → test đỏ); `roleAdministration@1` không có `hr.admin`; không permission nào của catalog trùng giữa hai boundary cần cùng gắn (một binding mỗi `(user, permission)`); mọi entry của mọi boundary gán được qua UI là `required`; `hr.admin`/`hr.coo`/`hr.employee` không có permission nhóm này; `sync` không tạo `user_boundary` nào.
- [ ] **Matrix (`permission-matrix.ts`, chạy ở T4 trên PostgreSQL thật)** cho các actor: Root; D1 = `access.admin` + `roleAdministration@1` + `boundaryAdministration@1` + `adminGroupProtection@1`; D2 = như D1 nhưng `roleAdministration@2`; D3 = `access.admin` thiếu `adminGroupProtection`; D4 = `access.admin` thiếu `roleAdministration`; D5 = `hr.admin` + `hrAdministration@2` (không `access.admin`); U = `hr.employee`; N = không role. Thao tác (target thường T trừ khi ghi khác): assign `hr.employee`, `hr.coo`, `hr.admin`, `access.admin` cho T; assign cho target giữ `hr.admin` (PH), giữ `access.admin` (PA), cho Root, cho chính mình, cho id vắng; revoke `hr.employee` của T/PH/PA; assign boundary `hrAdministration@2`, `roleAdministration@1`, `adminGroupProtection@1`, boundary có entry `optional` (fixture); revoke tương ứng; assign khi đã có binding khác; `readPermissions`. Kết quả mong đợi (status): Root: mọi thao tác trên IAM T/PH/PA thành công (trừ Root/vắng 404, self n/a, optional-entry 409, đã có binding 409, đã gán 409); D1: `hr.employee`/`hr.coo` cho T 200, `hr.admin` 404 (ngoài phong bì), `access.admin` 404, PH/PA 404 (`protectedGroup`), `hrAdministration@*` 200, `roleAdministration@1`/`adminGroupProtection@1` 404, self 403, Root/vắng 404; D2: như D1 nhưng `hr.admin` cho T 200 (và sau đó T thành PH, D2 không sửa được: 404); D3/D4: mọi ghi 403 (thiếu binding `required`); D5/U/N: mọi ghi 403, `readPermissions` 403 nếu không có grant; thiếu `fresh`: 403 ở mọi ô ghi. Bảng này là nguồn duy nhất; ô nào không có trong bảng là chưa test.
- [ ] Upgrade release trước → mới qua sync: không ghi đè `user_boundary` runtime, không downgrade; sync idempotent nhiều instance; thiếu binding → IAM `access.admin` bị từ chối, Root được.
- [ ] Hash release/OpenAPI/route inventory đổi có chủ đích (xem diff hash, không sửa expected để xanh).

### T4 — Lệnh và query (service), validator, audit

**Tạo:** `administration/services/permission-command.service.ts` (hoặc theo cấu trúc folder hiện có), `administration/permission.validator.ts`, `administration/permission.types.ts`. **Sửa:** `authorization/services/product-authority.service.ts` (hai bổ sung nhỏ: (1) `ProductCommandAbsent` ném trước mọi ghi → `execute` coi như `found:false`, Root absent-audit giữ nguyên; (2) `ProductCommandContext.authorizeTarget(resource, action, key)`: cùng `readProductAuthority` + `planUser`/`planUnrestricted` + `compilePlan` cho đối tượng thứ hai trong cùng transaction và fence, trả `objectId` đã khóa hoặc ném `ProductCommandAbsent`; không nhận plan/callback từ caller), `audit/product-audit.repository.ts` (4 kind typed + `grant`), `infrastructure/product-runtime.service.ts`, `administration/administration.http-port.ts`, `infrastructure/runtime.module.ts`.

Hành vi (mọi lệnh mode `admin`): `execute` authorize permission thứ nhất (khóa role/boundary) → `run`: tra tài khoản qua `iam_account` → `authorizeTarget('account', 'targetRole'|'targetBoundary', id)` → khóa `app_user` `FOR NO KEY UPDATE` → so `actor === target` (403) → đọc lại facts → bất biến (c)(d)(e) ADR 0030 → ghi → audit. `assignBoundary` ghi một dòng `user_boundary` cho mỗi entry trong một transaction; `revokeBoundary` xóa toàn bộ dòng của definition; query `readPermissions` đọc facts của target một lần, chạy `planUser` theo từng permission, không `internalReason`.

- [ ] Unit validator (`apps/api/test/permission.spec.ts`): key thừa/thiếu → 400; role/boundary key sai định dạng/quá dài; version không phải số nguyên dương; uuid sai; path param ngoài catalog bị từ chối trước khi chạm DB. Unit `authorizeTarget` không nhận plan từ caller (kiểu) và từ chối resource/action chưa khai báo.
- [ ] Integration (`apps/api/test/permission-management.integration-spec.ts`, PostgreSQL thật, session thật, fresh bằng 2FA fixture): **chạy toàn bộ matrix T3**; ngoài matrix: ca thành công kiểm một dòng `user_role`/đủ dòng `user_boundary`, đúng một audit `permission.*` (có `grant`, không email/`sub`), request kế tiếp của đích thấy quyền mới; ca từ chối kiểm không ghi gì và không có audit thành công; target Root và id vắng trả cùng body byte-for-byte; role không tồn tại, ngoài phong bì và target `protectedGroup` cùng 404; gán boundary khi đã có binding khác → 409 không thay thế; dòng `seed_owner` không đổi; `deny` rule vẫn thắng sau khi gán role (kiểm bằng `readPermissions` và request thật); revoke role không xóa boundary/rule khác.
- [ ] **Atomic + đồng thời (PostgreSQL thật):** writer audit lỗi → rollback `user_role`/`user_boundary`; hai `assignRole` đồng thời cùng cặp → đúng một thành công, còn lại 409 (không 500); `assignRole` xen kẽ `revokeRole` cùng target lặp có giới hạn → trạng thái cuối nhất quán, không deadlock; thu hồi `access.admin` hoặc binding của delegate trong khi delegate đang gán → lệnh commit trước hoặc bị từ chối ở recheck, **không có trạng thái "commit nhưng actor không còn quyền"**; delegate gán `hr.admin` (D2) đồng thời với revoke của Root → hai kết quả hợp lệ duy nhất (gán rồi bị thu, hoặc bị thu trước rồi gán 404/409) và `protectedGroup` của đích khớp trạng thái cuối; **thu hồi có hiệu lực ngay cho phiên đang sống**: sau thu hồi `hr.admin`, request kế tiếp của chính phiên đích bị 403/ẩn dữ liệu.
- [ ] `readPermissions`: khớp `planUser` chạy trực tiếp trên cùng snapshot; `needsFresh`/`needsBoundary` đúng khai báo; không `internalReason`, không dữ liệu principal khác; Root/vắng → 404; không quyền → 403; mỗi lần gọi đúng một audit; vượt giới hạn catalog → lỗi, không cắt.
- [ ] Kiểm độ nhạy (hoàn nguyên sau): bỏ điều kiện self; bỏ `authorizeTarget`; bỏ recheck facts actor; bỏ kiểm `iam_account`; bỏ quy tắc (d); thêm `access.admin` vào phong bì; bỏ `protected_group = false` khỏi `adminGroupProtection@1`; bỏ audit → matrix/test đỏ đúng ca.

### T5 — HTTP, OpenAPI, wiring

**Sửa/tạo:** `administration/controllers/permission.controller.ts` (hoặc theo layout controllers hiện có), `administration/administration.module.ts`, `openapi/` (examples, success shape, status 200/400/401/403/404/409/503), `apps/api/test/structure.spec.ts` (inventory), `hr/` + `employee/employee.service.ts#me` (menu `permissions` server cấp, display-only, không nới quyền).

- [ ] Test trước: inventory đủ 8 route có `@ProductAuthorize` (thiếu → boot fail); body key thừa → 400; chỉ dùng `API_ERROR_CODES` hiện có (không key mới); OpenAPI hash/examples khớp; controller không import service/driver (`module-boundaries.spec.ts`); menu `permissions` chỉ khi caller có `role.read` hoặc Root.
- [ ] Smoke HTTP: Root và delegate có phong bì đi qua cookie + CSRF; thiếu CSRF → 403 `error.accessDenied`; DELETE route kiểm CSRF như POST.

### T6 — Web

**Tạo/sửa:** `apps/web/src/permission/` (client zod chặt cho 8 route, `permission.page.tsx`, `components/permission-account-list.component.tsx`, `permission-account-detail.component.tsx`, `permission-assign.modal.tsx`, `permission-effective.component.tsx`), `app/navigation.config.ts`, route trong `app/`, mock services cho test, `i18n/locales/vi.json` + `en.json` (nhóm `permission.*`, phẳng lowerCamelCase, cả hai file cùng lúc).

Trạng thái: tải/lỗi/rỗng theo design system §4; danh sách tài khoản (không hiển thị email nếu `account.read` không cấp field đó — theo projection hiện có); chi tiết: role + boundary hiện tại, nút gán/thu hồi có modal xác nhận hiển thị danh sách quyền của role (từ danh mục), thiếu `fresh` dùng `MutationError`; tab "Quyền hiệu lực" chỉ đọc kèm ghi chú giả định fresh; `409`/`404`/`403` dùng key `error.*` sẵn có; nút loading chặn bấm lặp; a11y theo §5.

- [ ] Vitest trước (`apps/web/test/permission.spec.tsx`): mỗi trạng thái hiện đúng nút; không có menu `permissions` → route vào bị chặn/ẩn; modal gửi đúng `{ role }`/`{ boundary }`; 403 thiếu fresh hiện hộp 2FA; 409/404 hiện key đúng, không render body thô; không hiển thị dữ liệu ngoài target; nút loading không gửi hai lần; tab hiệu lực không có nút ghi.
- [ ] `test/locale-keys.spec.ts` (root `test:workspace`) xanh: `vi`/`en` cùng tập key, `error.*` bằng `API_ERROR_CODES`.
- [ ] Kiểm thủ công 390 và 1366 px (design system §7); ghi vào ledger, không tick nếu chưa chụp.

### T7 — Browser E2E

**Tạo:** `apps/web/e2e/permission.e2e-spec.ts` (IdP giả `fake-oidc.helper.ts`, stack `stack.helper.ts`, TOTP `totp.helper.ts`).

- [ ] E2E: Root mở "Quản lý quyền" → chọn tài khoản chưa có role → xem hiệu lực (rỗng) → gán `hr.admin` (nhập mã 2FA khi được hỏi) → tab hiệu lực đổi; tài khoản đích (phiên khác) thấy menu mới sau tải lại; Root gắn gói ủy quyền D1 (role `access.admin` + `roleAdministration@1` + `boundaryAdministration@1` + `adminGroupProtection@1`) cho người ủy quyền; người ủy quyền gán `hr.employee` thành công, gán `hr.admin`/`access.admin` bị từ chối, sửa tài khoản giữ `hr.admin` bị từ chối (hiển thị như không tìm thấy), tự gán bị từ chối; Root đổi sang `roleAdministration@2` thì gán `hr.admin` được; Root thu hồi `hr.admin` → phiên đích mất menu/dữ liệu ngay; người không có quyền không thấy menu và gọi API trực tiếp bị 403.

### T8 — Tài liệu vận hành

- [ ] Cập nhật `apps/api/AGENTS.md` (Hiện trạng: đường ghi facts quyền), `docs/hrm-local-operations.md` (không GRANT/credential mới; cách Root gắn phong bì đầu tiên), ghi chú "thay bởi 0030" tại ADR 0027 §9; link tương đối resolve; `prettier --check` đúng file đã sửa.

### T9 — Đồng bộ ADR 0029 (sau khi 0030 Accepted và T4–T5 xong)

- [ ] Thêm đúng một dòng vào [ADR 0029](../../decisions/0029-account-management-ui.md) mục "Quyết định của người dùng" (không đổi quyết định đã chốt): "Sau ADR 0030, binding `hrAdministration@2` được gán qua trang Quản lý quyền; câu hỏi mở 1 đã giải quyết." Cập nhật câu "chưa có đường ghi" trong plan [account-management](2026-10-20-account-management.md) T0 nếu còn. Chỉ làm khi người dùng đồng ý.

### T10 — Kiểm chứng tổng

- [ ] `pnpm run lint`, `pnpm run typecheck`, `pnpm run test:unit`, `pnpm run test:integration` (Docker), `pnpm run test:e2e`, `pnpm run test:browser`; ghi lệnh, exit code, số test; lỗi môi trường/timeout/skip tách riêng. `format:check` chỉ trên file đã sửa (repo có file đỏ từ trước).
- [ ] Xem diff cuối: không secret/`.env`, không file ngoài task, không email/`sub` trong audit/log/test artifact; không stage file của người khác.

## Ledger bằng chứng (để trống tới khi chạy)

| Task | Lệnh đã chạy | Exit code / số test | Ghi chú (lỗi môi trường, skip, chưa chạy) |
| ---- | ------------ | ------------------- | ----------------------------------------- |
| T1   |              |                     |                                           |
| T2   |              |                     |                                           |
| T3   |              |                     |                                           |
| T4   |              |                     |                                           |
| T5   |              |                     |                                           |
| T6   |              |                     |                                           |
| T7   |              |                     |                                           |
| T8   |              |                     |                                           |
| T9   |              |                     |                                           |
| T10  |              |                     |                                           |

## Quyết định của người dùng

Ngày 2026-10-20, cho các câu hỏi mở của ADR 0030:

1. Chấp nhận phong bì ủy quyền do Root gắn, không tự động so subset quyền.
2. Ủy quyền gán được `hr.admin` hay không do boundary quyết: `roleAdministration@1` mặc định không có `hr.admin`; Root gắn `roleAdministration@2` mới cho phép. Không hằng riêng cho `hr.admin` trong lệnh.
3. Sửa người ngang quyền (giữ `access.admin`/`hr.admin`) do boundary `adminGroupProtection@1` quyết, không bất biến cứng trong lệnh.
4. Thiết kế catalog boundary mặc định (T3) và matrix test; hai câu còn mở ở cuối ADR 0030 (boundary cho người dùng thường, thành phần `protectedGroup`) chờ người dùng ở T0.
