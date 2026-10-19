# Kế hoạch — Quản lý quyền (gán/thu hồi role và boundary, xem quyền hiệu lực)

Ngày: 2026-10-20. Nguồn thiết kế: [ADR 0030](../../decisions/0030-permission-management.md) (**Proposed — chưa được duyệt; không triển khai trước khi người dùng chuyển sang Accepted**), [ADR 0012](../../decisions/0012-iam-root-separation.md), [ADR 0016](../../decisions/0016-hrm-authorization-and-pii.md), [ADR 0022](../../decisions/0022-root-step-up-and-time-source.md), [ADR 0027](../../decisions/0027-google-only-sign-in.md) §9, [ADR 0029](../../decisions/0029-account-management-ui.md), [permission boundaries](../../permission-boundaries.md), [design system](../../hrm-ui-design-system.md), [vận hành local](../../hrm-local-operations.md). Trạng thái lấy từ checkbox dưới đây; bước chưa đánh dấu là chưa có bằng chứng. Sản phẩm đang phát triển, chưa release production.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Test lỗi trước, rồi implement. Chỉ làm task được yêu cầu.

## Trạng thái đầu vào (đã kiểm 2026-10-20)

- Nhánh `version/single-app`, HEAD `83b8efa`; working tree có thay đổi của người khác (`work-request/`, `app.module.ts`…): không stage/sửa chúng. Chưa chạy test/lint nào cho kế hoạch này.
- Đã có: login `authority` với `INSERT/UPDATE/DELETE` trên `user_role`/`user_boundary` (`database/helpers/product-database.helper.ts`), trigger `protect_product_rows`/`guard_root_not_iam_subject`, mode `admin` (exclusive fence + `revision+1`), `ProductAuthorization.execute`/`query`, `GET /api/administration/accounts` (`account.read`). Chưa có: bất kỳ route/CLI ghi `user_role`/`user_boundary`.
- Giả định cần kiểm ở T1 (sai giả định nào thì dừng và sửa ADR trước): xem ADR 0030 mục Bối cảnh (1)–(4); thêm: `execute` bắt được `ProductCommandAbsent` ném trước mọi ghi mà vẫn để Root absent-audit chạy; khóa `FOR NO KEY UPDATE` trên `app_user` được `authority` cấp (UPDATE cột); số permission trong catalog đủ nhỏ cho một response; `HrMenu`/`GET /api/hr/me` mở rộng được thêm `permissions`.
- Release/migration: ADR 0029 (chưa merge) dự kiến release `8`, migration `021`; lấy số kế tiếp theo thứ tự merge, đừng trùng.

## Cổng

- [ ] **T0** Người dùng duyệt ADR 0030 và trả lời ba câu hỏi mở cuối ADR. Cập nhật header ADR sang Accepted.

## Tasks

### T1 — Kiểm giả định từ source và DB schema (không sửa code)

- [ ] Đọc và ghi vào ledger bằng chứng cho từng giả định: (1) binding tài nguyên `role`/`boundaryDefinition` (compiler `authorization/product-sql.compiler.ts` chấp nhận `keyKind: 'string'`, khóa `bytea` cần view?); (2) `planUser` trả đủ allow/deny theo permission cho principal tùy ý với snapshot dựng trong bộ nhớ (không N+1); (3) trigger còn lại trên `user_role` sau `012` (`protect_system_activation`, `require_root_marker` đã drop?); (4) `audit_outbox` payload nhận field `grant`; (5) `execute` + `ProductCommandAbsent` (thiết kế ở T3); (6) số permission/catalog và role/boundary hiện có; mọi boundary hiện có thỏa quy tắc (f) (mọi entry `required`); (7) không có cache quyền (`rg` cache trong `authorization/`, `auth/`).
- [ ] Chạy trên DB disposable (integration test, không `.env`/DB thật): `authority` INSERT/DELETE `user_role` role `hr.admin` thành công; INSERT cho Root bị `guard_root_not_iam_subject` chặn; UPDATE/DELETE `user_boundary` có `seed_owner` bị chặn; ghi vào `policy_rule` code-owned bị chặn. Kết quả ghi ledger; nếu cần migration/view thì thêm mục T2.

### T2 — View đọc và probe (chỉ khi T1 cho thấy cần)

**Files tạo (nếu cần):** migration forward kế tiếp trong `apps/api/src/database/migrations/` (view `role_directory`, `boundary_directory`, `security_invoker`, `SELECT` cho `authority`/`data`); **Sửa:** `expectedPrivileges`, probe.

- [ ] Test trước (`apps/api/test/product-permission-views.integration-spec.ts`, PostgreSQL thật): view chỉ chứa role `managed_by='code'`/boundary `active`, không lộ cột khác; `data` và `authority` đọc được, `identity`/`bootstrap` không; probe báo drift nếu cấp thừa/thiếu. Nếu T1 chứng minh không cần view, đánh dấu "không áp dụng" kèm lý do.

### T3 — Declarations, release và manifest

**Tạo:** `apps/api/src/administration/permission.declarations.ts` (resource `role`, `boundaryDefinition`, action trên `account`, policy `permissionFresh@1`, template, boundary `roleAdministration@1/@2`, `boundaryAdministration@1`, grant role `access.admin`). **Sửa:** `authorization/product.manifest.ts` (fragment, `roles`, `defaultGrants`, release kế tiếp, comment), fixture release trước trong `apps/api/test/fixtures/`, `hrm-authorization-upgrade.integration-spec.ts`.

- [ ] Test trước: mọi action ghi (`role.assign|revoke`, `boundaryDefinition.assign|revoke`) có `boundary: 'required'` và policy có `fresh@1`; `role.read`/`boundaryDefinition.read`/`account.readPermissions` `optional`, không fresh; `account.readPermissions` có `audit@1`; entry của phong bì chứa đúng tập khóa (`roleAdministration@1` không có `hr.admin`/`access.admin`; `@2` có `hr.admin`, không có `access.admin`); **không phong bì nào chứa `access.admin` hay boundary `*Administration*`** (bất biến (b) phải khớp declarations); `hr.admin`/`hr.coo`/`hr.employee` không có permission nào trong nhóm này; boundary `hrAdministration@1/@2` đều chỉ gồm permission `required` (quy tắc (f)).
- [ ] Upgrade release trước → mới qua sync: không ghi đè `user_boundary` runtime, không downgrade; sync không tạo binding phong bì (không seed); IAM giữ `access.admin` thiếu binding bị từ chối action `required`, Root được.
- [ ] Hash release/OpenAPI/route inventory đổi có chủ đích (xem diff hash, không sửa expected để xanh).

### T4 — Lệnh và query (service), validator, audit

**Tạo:** `administration/services/permission-command.service.ts` (hoặc theo cấu trúc folder hiện có của `administration/`; file đơn lẻ đặt trực tiếp), `administration/permission.validator.ts`, `administration/permission.types.ts`. **Sửa:** `authorization/services/product-authority.service.ts` (`ProductCommandAbsent`: ném trước mọi ghi → `execute` coi như `found:false`, Root absent-audit giữ nguyên), `audit/product-audit.repository.ts` (4 kind typed + `grant`), `infrastructure/product-runtime.service.ts` (đăng ký), `administration/administration.http-port.ts`, `infrastructure/runtime.module.ts`.

Hành vi (mọi lệnh mode `admin`; target authorize = role/boundary đích trước, rồi trong `run`: tra `iam_account` → khóa `app_user` `FOR NO KEY UPDATE` → đọc lại facts actor/target → kiểm bất biến ADR 0030 §4 → ghi → audit; lỗi nghiệp vụ `ProductCommandRejected`; self/(b)/(c) → `ProductAccessDenied`): `assignRole`, `revokeRole`, `assignBoundary` (một dòng `user_boundary` cho mỗi entry, tất cả trong một transaction), `revokeBoundary` (xóa toàn bộ dòng của definition đó), query `readPermissions` (một câu SQL đọc facts của target, `planUser` theo từng permission, không `internalReason`).

- [ ] Unit validator (`apps/api/test/permission.spec.ts`): key thừa/thiếu → 400; role/boundary key sai định dạng/quá dài; version không phải số nguyên dương; uuid sai; path param ngoài catalog bị từ chối trước khi chạm DB.
- [ ] Integration (`apps/api/test/permission-management.integration-spec.ts`, PostgreSQL thật, session thật của fixture, fresh bằng 2FA fixture), **ca thành công**: Root gán `hr.admin` → một dòng `user_role`, đúng một audit `permission.role-assign` (có `grant.key`, không email/`sub`), request kế tiếp của tài khoản đích thấy quyền mới; Root gán/thu hồi `hrAdministration@2` → đủ dòng `user_boundary` theo entry; IAM `access.admin` + binding `roleAdministration@2` + fresh gán `hr.employee` cho người khác thành công.
- [ ] **Ca từ chối (mỗi ca: không ghi gì, không audit thành công):** thiếu `fresh` (403); thiếu 2FA; CSRF sai; IAM không role / role khác; IAM `access.admin` **thiếu binding** phong bì (boundary required, 403); **tự gán/tự thu hồi** (`actor === target`, kể cả khi role nằm trong phong bì) → 403; **leo thang quá phong bì**: delegate `roleAdministration@1` gán `hr.admin` → 404, `@2` gán `hr.admin` được nhưng gán `access.admin` → từ chối (b); delegate **không** gán được `access.admin`/`roleAdministration*`/`boundaryAdministration*` dù phong bì cố ý khai sai (test với fixture release khai phong bì chứa `access.admin` → hằng `nonDelegable` vẫn chặn); delegate sửa target giữ `access.admin` (c) → 403, Root sửa được; **target Root** và **id vắng** cùng `404` (cùng body, so sánh byte); role/boundary không tồn tại và ngoài phong bì cùng `404`; assign lần hai → `409`; revoke role chưa gán → `409`; boundary đã có binding khác cho cùng permission → `409`, không thay thế; boundary có entry `optional` → `409` (f); dòng `seed_owner` không bị đổi (trigger); `deny` rule vẫn thắng sau khi gán role (kiểm bằng `readPermissions` và request thật); role thu hồi không xóa boundary/rule khác.
- [ ] **Atomic + đồng thời (PostgreSQL thật):** writer audit lỗi → rollback `user_role`/`user_boundary` (không còn dòng nào); hai `assignRole` đồng thời cùng cặp → đúng một thành công, còn lại `409` (không 500); `assignRole` xen kẽ `revokeRole` cùng target lặp có giới hạn → trạng thái cuối nhất quán, không deadlock; thu hồi `access.admin` của delegate trong khi delegate đang gán → lệnh của delegate hoặc commit trước (thành công, audit) hoặc bị từ chối ở recheck; **không có trạng thái "đã commit nhưng actor không còn quyền"** (recheck facts actor trong exclusive fence); **thu hồi có hiệu lực ngay cho phiên đang sống**: phiên đích đang mở, thu hồi `hr.admin` xong, request kế tiếp của chính phiên đó bị 403/ẩn dữ liệu (không đợi hết hạn/đăng nhập lại).
- [ ] `readPermissions`: trả đúng roles/boundaries/permission allow/deny của target (so khớp với `planUser` chạy trực tiếp trên cùng snapshot), `needsFresh`/`needsBoundary` đúng khai báo; không có `internalReason`; không dữ liệu principal khác; target Root/vắng → 404; không quyền → 403; mỗi lần gọi có đúng một audit; response không vượt giới hạn catalog (vượt → lỗi, không cắt).
- [ ] Kiểm độ nhạy (hoàn nguyên sau): bỏ điều kiện self, bỏ `nonDelegable`, bỏ recheck facts actor, bỏ kiểm `iam_account`, bỏ quy tắc (f), bỏ audit → test đỏ đúng ca.

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

- [ ] E2E: Root mở "Quản lý quyền" → chọn tài khoản chưa có role → xem hiệu lực (rỗng) → gán `hr.admin` (nhập mã 2FA khi được hỏi) → tab hiệu lực đổi; tài khoản đích (phiên khác) thấy menu mới sau tải lại; Root gắn phong bì `roleAdministration@2` + role `access.admin` cho người ủy quyền; người ủy quyền gán `hr.employee` thành công, gán `access.admin` bị từ chối, tự gán bị từ chối; Root thu hồi `hr.admin` → phiên đích mất menu/dữ liệu ngay; người không có quyền không thấy menu và gọi API trực tiếp bị 403.

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

(Điền sau khi duyệt ADR 0030: ba câu hỏi mở ở cuối ADR.)
