# Kế hoạch — Cấp và quản lý tài khoản từ hồ sơ nhân viên

> **ĐÃ ĐÓNG 2026-10-29 — superseded by [ADR 0041](../../decisions/0041-administration-settings-roles-accounts.md) và [kế hoạch administration](2026-10-23-administration.md).** ADR 0029 chưa từng Accepted; thiết kế neo vào `employee` (`issueAccount`, `reissueAccountInvitation`, `syncAccountEmail`) không được triển khai và các symbol đó không có trong `apps/`. Checkbox bên dưới giữ nguyên làm lịch sử, **không tick và không dùng làm bằng chứng hoàn thành**. Mục không còn trong ADR 0041 (vd. reissue lời mời) chỉ làm khi có quyết định mới.

Ngày: 2026-10-20. Nguồn thiết kế: [ADR 0029](../../decisions/0029-account-management-ui.md) (**Proposed — chưa được duyệt; không triển khai trước khi người dùng chuyển sang Accepted**), [ADR 0016](../../decisions/0016-hrm-authorization-and-pii.md) §7, [ADR 0020](../../decisions/0020-oidc-email-provisioning.md), [ADR 0027](../../decisions/0027-google-only-sign-in.md), [ADR 0028](../../decisions/0028-employee-profile-extras.md), [permission boundaries](../../permission-boundaries.md), [design system](../../hrm-ui-design-system.md), [vận hành local](../../hrm-local-operations.md). Trạng thái lấy từ checkbox dưới đây; bước chưa đánh dấu là chưa có bằng chứng. Sản phẩm đang phát triển, chưa release production.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Test lỗi trước, rồi implement. Chỉ làm task được yêu cầu.

## Trạng thái đầu vào (đã kiểm 2026-10-20)

- Nhánh `version/single-app`, HEAD `29fabaa`, working tree sạch khi viết kế hoạch; chưa chạy test/lint nào cho kế hoạch này.
- Release hiện tại `7` (`authorization/product.manifest.ts`); migration product mới nhất `020`, HR mới nhất `HrmEmployeeProfile1792108800105`.
- Đã có: `POST /api/administration/accounts` (`account.provision`, chỉ Root), `account.suspend`, `employee.linkAccount` + `PUT /api/hr/employees/{id}/account`, `provision_oidc_account`, view `account_directory`. Chưa có: mở lại tài khoản, cấp lại lời mời, đổi email tài khoản, đường ghi `user_boundary`/`user_role` (ADR 0027 §9).
- Giả định cần kiểm khi làm T1: Root luôn có `app_user.email_canonical` (nên email Root trùng → 23505); `guard_root_lifecycle` không chặn `product_account_owner` đổi `state` của `kind='iam'`; `require_email_epoch` chỉ đòi `auth_epoch` tăng. Sai giả định nào thì dừng và sửa ADR trước.

## Cổng

- [ ] **T0** Người dùng duyệt ADR 0029 và trả lời hai câu hỏi mở ở cuối (nếu chọn lệnh cấp binding/role thì thêm task riêng, ngoài kế hoạch này). Cập nhật header ADR sang Accepted + ghi chú tại ADR 0020 §5–6.

## Tasks

### T1 — Migration, quyền DB và probe

**Files tạo:** `apps/api/src/database/migrations/021-account-lifecycle.migration.ts` (tên class theo mẫu `020`; timestamp kế tiếp); `apps/api/src/employee/migrations/hrm-account-issuance.migration.ts` (`HrmAccountIssuance1792108800106`). **Sửa:** `database/helpers/product-database.helper.ts` (`expectedPrivileges.authority`, `protectionFunctions`, GRANT cột cho `product_account_owner`), `hr/hr-database.helper.ts` (`hrPrivileges.authority`), danh sách migration của `database/` và employee, `docs/hrm-local-operations.md`.

Nội dung: hàm `reissue_oidc_enrollment`, `change_pending_account_email`, `reactivate_iam_account` (SECURITY DEFINER, owner `product_account_owner`, `search_path=pg_catalog,pg_temp`, `REVOKE ALL FROM PUBLIC`, EXECUTE chỉ `product_authority`); `GRANT EXECUTE ON provision_oidc_account TO product_authority`; cột cho owner: `UPDATE(state, auth_epoch, email_canonical)` trên `app_user`, `UPDATE(expires_at, email_canonical)` + `SELECT` trên `oidc_email_enrollment`, `SELECT(user_id, enabled)` trên `external_identity`; HR: `GRANT SELECT(employee_id, work_email) ON employee_identity TO product_authority`. Không sửa migration đã áp; `down` reject.

- [ ] Test trước (`apps/api/test/product-account-lifecycle.integration-spec.ts`, PostgreSQL thật, fixture dùng một lần): mỗi hàm gọi bằng login `authority` thành công đúng ca; gọi bằng `data`, `identity`, `bootstrap` bị `42501`; `search_path`/owner/SECURITY DEFINER/body khớp probe; `authority` không UPDATE được `app_user.state → active` trực tiếp (trigger `protect_account_lifecycle` vẫn chặn); `authority` không SELECT được cột khác của `employee_identity` (vd. `document_number`) và không SELECT được `app_user.email_canonical`.
- [ ] Hàm: `reissue` từ chối `active`/`suspended`/không enrollment/Root; `change_pending_account_email` tăng `auth_epoch` trong cùng UPDATE, thay enrollment (email cũ không còn đăng nhập first-login được), từ chối `active`, có `external_identity`, Root, email trùng `app_user` hoặc enrollment (23505); `reactivate` về `active` khi có binding bật, về `pending` khi không có, từ chối `pending`/`active`/Root, tăng `auth_epoch`.
- [ ] Probe ACL báo drift nếu cấp thừa/thiếu một quyền mới; migration trên DB có sẵn dữ liệu (tài khoản pending/active/suspended, Root) chạy không đổi dòng nào.
- [ ] Áp `pnpm run db:provision` trên DB disposable của test; DB local chỉ khi người dùng cho phép.

### T2 — Declarations, release 8 và manifest

**Sửa:** `hr/hr.declarations.ts` (6 action trên `employee`, boundary `hrAdministration@2`, grant `hr.admin` template `allEmployees`), `authorization/product.manifest.ts` (`sequence: '8'`, `predecessor: '7'`, comment release), fixture release trong `apps/api/test/` (thêm `test/fixtures/release-seven.ts` theo mẫu `test/fixtures/release-six.ts`; hash release/bindings), `hrm-authorization-upgrade.integration-spec.ts`.

- [ ] Test trước: `issueAccount|reissueAccountInvitation|syncAccountEmail|reactivateAccount|suspendAccount` có `boundary: 'required'` và policy `hrFresh` (có `fresh@1`); `readAccount` `optional`, không fresh; `hrAdministration@2` có đủ 7 entry; `@1` không đổi; grant mặc định của `hr.admin` đúng sáu permission mới; `hr.employee`/`hr.coo` không có permission nào trong sáu.
- [ ] Upgrade 7 → 8 qua sync: không ghi đè `user_boundary` runtime, không downgrade; thiếu binding → IAM `hr.admin` bị từ chối action `required`, Root được (fresh theo `fresh@1`).
- [ ] Hash release/OpenAPI/route inventory cập nhật có chủ đích (kiểm diff hash, không sửa expected để xanh).

### T3 — Lệnh (service), validator, audit

**Sửa:** `employee/employee.service.ts` (5 `ProductCommand` + `readAccount` query, đăng ký trong `infrastructure/product-runtime.service.ts`), `employee/employee.validator.ts` (input), `employee/employee.types.ts`, `audit/product-audit.repository.ts` (5 kind typed), `employee/employee.http-port.ts`. Dùng lại chuẩn hóa `workEmail` ADR 0028 và `canonicalLoginEmail`; không helper mới nếu đã có.

Hành vi: tất cả mode `admin`; mọi từ chối nghiệp vụ là `ProductCommandRejected` (→ 409); `actor === account` → từ chối; `issueAccount` sinh `userId` trước `execute`, đọc `work_email`, so với `workEmail` đã chuẩn hóa, gọi `provision_oidc_account` với issuer provider duy nhất (không đúng một → 503 như `provisionAccount`), `UPDATE employee.account_id`, `bumpEmployee`, audit; không trả email/userId.

- [ ] Unit test validator (`apps/api/test/hrm-account-issuance.spec.ts`): key thừa/thiếu → 400; `workEmail` sai dạng; `expectedVersion` không phải số nguyên chuỗi; uuid sai.
- [ ] Integration (`apps/api/test/hrm-account-issuance.integration-spec.ts`), mỗi ca dùng session thật của fixture: Root cấp thành công → một `app_user` pending + enrollment 7 ngày + `account_id` + version +1 + đúng một audit `hr.employee.issue-account` không chứa email/`sub`; IAM `hr.admin` có binding + fresh → thành công; **từ chối**: IAM không role, role khác (`hr.employee`, `hr.coo`), thiếu binding (boundary), thiếu `fresh`, thiếu 2FA, CSRF sai; employee vắng và employee ngoài scope cùng `404`; chưa có `work_email`, `workEmail` lệch giá trị lưu, đã có tài khoản, `stale_version` → 409 và **không ghi gì** (không `app_user` mồ côi); email trùng tài khoản khác → 409 rollback; **email của Root** (fixture giống ART025) → 409 cùng response với trùng thường, không tạo gì; không provider/đa provider → 503, không ghi.
- [ ] Atomic + đồng thời: writer audit lỗi → rollback cả `app_user`/enrollment/`account_id`; hai `issueAccount` đồng thời cùng employee → đúng một thành công (`UNIQUE`/fence), hai employee cùng email → một thành công; `issue` rồi lặp lại → 409; thứ tự khóa không deadlock (chạy xen kẽ `issue` và `suspend` cùng employee, lặp có giới hạn).
- [ ] `reissueAccountInvitation`: `pending` hết hạn và còn hạn → `expires_at` mới theo đồng hồ DB; `active`/`suspended`/không tài khoản → 409; tài khoản của chính mình → 409; sau reissue first-login với email đúng vẫn kích hoạt một lần, lần hai bị từ chối (enrollment đã xóa).
- [ ] `syncAccountEmail`: chỉ `pending`; email mới = `work_email` lưu (lệch body → 409); `auth_epoch` tăng, email cũ không còn first-login được; trùng (kể cả Root) → 409; `active` → 409, không đổi `app_user`.
- [ ] `suspendAccount`/`reactivateAccount`: suspend bump epoch và phiên cũ mất hiệu lực (`resolve_session`); không tự khóa; reactivate tài khoản đã có binding → `active` (đăng nhập Google lại được, phiên cũ vẫn chết), tài khoản chưa từng đăng nhập → `pending` (enrollment còn/hết hạn giữ nguyên), Root và employee không có tài khoản → 409.
- [ ] `readAccount`: trả đúng `{ state, enrollment }`, không email/userId; employee ngoài scope → 404; không tài khoản → `{ account: null }`.
- [ ] Kiểm độ nhạy: bỏ điều kiện boundary/`expectedVersion`/so khớp email → test đỏ đúng ca; hoàn nguyên.

### T4 — HTTP, OpenAPI, wiring

**Sửa:** `employee/employee.controller.ts` (6 route ở ADR §11, `@ProductAuthorize('employee', <action>)`, `enforceCsrf`, `bodyFields` allowlist), `employee/employee.http-port.ts`, `infrastructure/runtime.module.ts` (bind operations), `openapi/hr-openapi.schema.ts` (examples, success shape, status 200/201/400/401/403/404/409/503), `apps/api/test/structure.spec.ts` (inventory), module-boundaries nếu cần.

- [ ] Test trước: route inventory đủ 6 route có classification (thiếu → boot fail); body có key thừa → 400; response chỉ chứa field của ADR; mã lỗi chỉ trong `API_ERROR_CODES` (không key mới); OpenAPI hash/examples khớp; controller không import service/driver (`module-boundaries.spec.ts`).
- [ ] Smoke HTTP: Root và IAM có binding đi qua cookie + CSRF; thiếu CSRF → 403 `error.accessDenied`.

### T5 — Web

**Sửa:** `apps/web/src/employee/employee.client.ts` (schema zod chặt cho 6 route), `employee/components/employee-account.component.tsx` (giữ phần liên kết có sẵn khi `account.read` đọc được), `i18n/locales/vi.json` + `en.json` (key `employee.account.*`, phẳng, lowerCamelCase; thêm/sửa cả hai file cùng lúc), mock services của test web.

Trạng thái và hành động: chưa có tài khoản (nút "Cấp tài khoản" → modal hiển thị email công việc; vô hiệu + gợi ý khi chưa có email công việc hoặc không có quyền đọc identity); `pending` (badge chờ đăng nhập lần đầu / hết hạn; "Cấp lại lời mời" chỉ khi `expired`; "Đồng bộ email đăng nhập"; "Khóa"); `active` ("Khóa" kèm xác nhận); `suspended` ("Mở lại"). Nút loading chặn bấm lặp; thiếu `fresh` dùng `MutationError`; không render body lỗi thô; trạng thái tải/lỗi/rỗng theo design system §4; a11y theo §5.

- [ ] Vitest trước (`apps/web/test/employee-account.spec.tsx`): mỗi trạng thái hiện đúng nút và chỉ nút đó; chưa có email công việc → nút disabled + hint; modal gửi `workEmail` đúng giá trị đang hiển thị; 409 hiện `error.conflict`; 403 thiếu fresh hiện hộp 2FA; không có quyền → không hiện nút; không render email của tài khoản; nút loading không gửi hai lần.
- [ ] `test/locale-keys.spec.ts` (root `test:workspace`) xanh: `vi`/`en` cùng tập key, tập `error.*` bằng `API_ERROR_CODES`.
- [ ] Ảnh/kiểm thủ công 390 và 1366 px (design system §7) — ghi vào ledger, không tick nếu chưa chụp.

### T6 — Browser E2E, tài liệu

**Tạo:** `apps/web/e2e/account-issuance.e2e-spec.ts` (IdP giả `fake-oidc.helper.ts`, stack `stack.helper.ts`). **Sửa:** `docs/hrm-local-operations.md` (migration `021`/`db:provision`, giới hạn "chưa có gán binding/role"), `apps/api/AGENTS.md` (mục Hiện trạng), `docs/single-product-verification.md` nếu có mục liên quan.

- [ ] E2E: Root mở nhân viên có email công việc → "Cấp tài khoản" (nhập mã 2FA khi được hỏi) → nhân viên đăng nhập Google giả bằng đúng email → vào được; đổi email công việc + đồng bộ khi còn `pending` → email cũ bị `/login?error=oidc`, email mới vào được; hết hạn (rút `expires_at` bằng login test của fixture) → "Cấp lại lời mời" → vào được; khóa → phiên bị đẩy ra; mở lại → đăng nhập lại được; nhân viên có email trùng Root → báo `error.conflict`, không có tài khoản mới.
- [ ] Tài liệu cập nhật, link tương đối resolve, `prettier --check` đúng file đã sửa.

### T7 — Kiểm chứng tổng

- [ ] `pnpm run lint`, `pnpm run typecheck`, `pnpm run test:unit`, `pnpm run test:integration` (Docker), `pnpm run test:e2e`, `pnpm run test:browser`; ghi lệnh, exit code, số test; lỗi môi trường/timeout/skip tách riêng. `format:check` chỉ trên file đã sửa (repo có file đỏ từ trước).
- [ ] Xem diff cuối: không secret/`.env`, không file ngoài task, không email trong audit/log/test artifact.

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

## Quyết định của người dùng (2026-10-20)

1. Root-only trước; đường ghi binding cho IAM `hr.admin` là task riêng sau.
2. Giữ gán role thủ công.
