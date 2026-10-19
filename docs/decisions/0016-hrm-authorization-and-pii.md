# ADR 0016 — Quyền HR, field nhạy cảm và tạo bản ghi

Ngày: 2026-10-17. **Trạng thái: Accepted** — người dùng duyệt 2026-10-17 (TD1–TD3, TD5, TD6). Chưa triển khai; bằng chứng sẽ ghi ở task T2/T3. Thiết kế: [HRM design](../superpowers/specs/2026-10-16-hrm-design.md) §4–§5, §7.2. Không thay ADR 0012 (Root), 0013–0015.

## Bối cảnh

Đã kiểm trong source: `ProductAuthorization` chỉ có list/detail/count/update/suspendUser, `access` private; projection cố định theo resource binding; domain relation chỉ resource → identity; AST người dùng không có `not`; login `data` không có INSERT `object_ref`. HRM cần tạo đơn/hồ sơ, giới hạn field nhạy cảm theo vai trò và scope "lead của team".

## Quyết định

1. **Capability HR nằm trong authority service owner.** Thêm command có tên nghiệp vụ (`submitRequest`, `decideRequest`, `createEmployee`…) gọi `access` nội bộ; không public `access`, không nhận callback SQL hay plan từ caller. Controller nhận facade đã bind qua `RuntimeModule`.
2. **Field ACL = resource riêng.** CCCD/MST/ngày sinh ở `employee-identity` (bảng 1:1), định mức ở `leave-rate`. Không ẩn cột ở controller.
3. **Scope bằng domain relation trên view `security_invoker`.** `employee_owner`, `request_owner`, `request_lead`, `request_decider` (resource → identity). Có parity test SQL ↔ evaluator. Không mở rộng compiler sang resource → resource.
4. **Tạo bản ghi.** Authorize trên bản ghi cha (`employee.submit-request` scope self; `hr-company` singleton cho tạo team/nhân viên). `object_id` cấp qua hàm `public.hr_register_object(type_key, key_bytes)` `SECURITY DEFINER`, `search_path` cố định, owner không phải login runtime, chỉ nhận danh sách type HR cố định trong function body; EXECUTE cho `product_data`. Probe kiểm owner/body/ACL như các hàm bảo vệ hiện có.
   - Phương án loại: GRANT INSERT `object_ref` cho `product_data` (mở cho mọi type, kể cả type authority); tạo trong mode `admin` (tăng revision và khóa exclusive cho mỗi đơn).
5. **Facts HR đi `admin`.** Membership, lead assignment, account link, role HR thay đổi dưới exclusive fence, kiểm affected set, tăng revision. Cấp cho `product_authority` đúng các quyền INSERT/UPDATE cột cần thiết trên các bảng đó; `product_data` chỉ SELECT.
6. **Guards code-owned** áp cho mọi principal kể cả Root: không tự bấm duyệt đơn của mình, không bỏ bước ngoài quy tắc hệ thống đã chốt (lead gửi đơn của team mình → bỏ bước lead; COO gửi → tự duyệt, spec §6.4). Lead kiêm COO được quyết hai bước bằng hai thao tác. Deny rule có thể thêm nhưng không thay guard.
7. **Fresh-auth IAM** (`fresh@1`) cho facts change, sửa F2, điều chỉnh phép/công, sửa lịch. **Boundary `required`** cho `team.assign`, `employee.link-account`; các action khác `optional`.
8. Account provisioning giữ CLI mời + OIDC Google Workspace activation có sẵn của base (D10 đã chốt 2026-10-17); HR không có capability reset/link identity đăng nhập. `employee.link-account` chỉ gắn hồ sơ với `app_user` IAM đã tồn tại, account chưa gắn hồ sơ khác, không phải Root.

## Hệ quả

- Manifest release `3`, migration mới cho bảng/view/hàm và cập nhật `expectedPrivileges` + probes.
- Root vẫn đọc mọi resource qua bypass; không hứa field ACL với Root (ADR 0012).
- Lead quyền theo assignment hiện hành: thu hồi có hiệu lực ở transaction kế tiếp sau commit.

## Triển khai T2 — 2026-10-17

Khung quyền HR (người dùng chọn phạm vi này 2026-10-17): migration `apps/api/src/hr/migrations/hrm-authorization.migration.ts` chỉ tạo cột mang quyền của `employee`, `team`, `team_membership`, `team_lead_assignment`, `work_request`, `request_decision` + 6 view `security_invoker`; T3/T5/T6 thêm cột nghiệp vụ, F2/F3, segments, idempotency bằng forward migration. Chi tiết khi implement:

- §1: `ProductAuthorization.execute(secret, command, input)`; `ProductCommand` cố định lúc composition (constructor từ chối action chưa khai báo, `execute` từ chối object không đăng ký). Target khớp plan và bị khóa `FOR NO KEY UPDATE` trong cùng statement; command bắt buộc ghi audit typed (`hr.request.*`) nếu không transaction rollback. Root dùng cùng `access`; target vắng mặt ghi `access.<resource>.<action>` outcome `absent`. Chưa có command nghiệp vụ nào được wire vào runtime (T3/T5/T6).
- §4: `public.hr_register_object(p_type text, p_key uuid) RETURNS uuid`, danh sách `employee`/`team`/`workRequest` trong body, owner là role NOLOGIN mới `product_object_owner` (chỉ USAGE schema + INSERT `object_ref`), tạo trong `db:provision` như hai owner hiện có. Vì cần owner membership tạm, migration HR chạy qua `db:provision` (CLI provision giờ áp cả migration ứng dụng); chỉ `db:migrate` trên DB chưa có nó bị từ chối. Probe `verifyHrProtection` kiểm owner/definer/volatility/body/search_path, ACL chính xác của owner và text `pg_get_viewdef` + `security_invoker` của các view.
- §5: `product_authority` có SELECT các bảng facts, INSERT membership/lead, UPDATE `ends_at` và `employee.account_id`; `product_data` SELECT bảng/view HR, INSERT `work_request`/`request_decision`, UPDATE `work_request(state, version)` và `employee.version` (PostgreSQL cần quyền UPDATE một cột để khóa dòng employee theo ADR 0017).
- Key đã lưu theo spec §5.3 (camelCase; `cancel` tách `cancelApproved`).
- Bằng chứng: `apps/api/test/hrm-authorization.integration-spec.ts` (ledger T2 trong kế hoạch).

## Mở

D01, D02, D08, D10 đã chốt 2026-10-17 (spec §12.0); cần thêm views `hr_request_lead`/`hr_employee_lead` cho đa team và decision hệ thống (`actor_kind = system`) cho bỏ bước lead/COO tự duyệt. Các G0 còn lại không đổi cơ chế trên.

## Triển khai T3 — 2026-10-18

Hồ sơ nhân viên, team và phân công (release `5`, migrations `apps/api/src/employee/migrations/hrm-employee.migration.ts`, `apps/api/src/team/migrations/hrm-team.migration.ts`). Chi tiết khi implement:

- §1 đọc: thêm `ProductQuery` + `ProductAuthorization.query(secret, query, input)` đối xứng `ProductCommand` — code-owned, đăng ký lúc composition, `run` nhận predicate của plan (alias `r`) và phải AND vào WHERE trước aggregate/pagination; Root mỗi lần đọc ghi một `access.*` (detail vắng mặt → `absent`). Cần vì projection cố định của gateway không trả được ngày nghiệp vụ dạng text, lịch sử và aggregate theo bản ghi.
- §2: F2 = resource `employeeIdentity` (bảng `employee_identity`, 1:1, key = employee id); F3 = `leaveRate` (bảng `leave_rate`, mỗi dòng một object, chỉ thêm). Scope `self` qua view `hr_employee_owner`/`hr_leave_rate_owner` (`security_invoker`, probe text như T2).
- §4: create authorize trên singleton `hrCompany` (bảng `hr_company`, id cố định `HR_COMPANY_ID`). `object_ref` của nó cần `resource_type` do manifest sync tạo, nên anchor được tạo idempotent bởi login sync ngay sau reconcile (API boot và CLI `sync`), không trong migration; readiness kiểm bảng. `hr_register_object` thay body (thêm `employeeIdentity`, `leaveRate`; không nhận `hrCompany`) bằng `SET LOCAL ROLE product_object_owner` trong migration, vẫn qua `db:provision`.
- §5: login `data` INSERT cột `employee(id,object_id,code,full_name,hired_on)` (không có `account_id`), UPDATE `code/full_name/terminated_on`, F2/F3/status period; `authority` thêm UPDATE `employee.version`, `team.version` (khóa dòng); `sync` SELECT/INSERT `hr_company`. Danh sách chính xác ở `hr/hr-database.helper.ts#hrPrivileges`.
- §6: guards áp cho mọi principal: không liên kết account của chính mình hoặc gỡ liên kết khỏi hồ sơ của mình; không tự thêm mình vào team, đổi team chính của mình hay tự làm lead; account đích phải là IAM chưa bị suspend và chưa gắn hồ sơ khác (UNIQUE).
- §7: `team.assign`, `employee.linkAccount` là `boundary: 'required'` + `hrFresh`. (Trạng thái đến 2026-10-18:) chưa có boundary definition/binding nào cho HR nên IAM `hr.admin` có grant bị từ chối (403) và chỉ Root làm được — người dùng chọn giữ như vậy 2026-10-17. Cơ chế gán boundary cho HR là quyết định riêng. Release 7 (2026-10-19) khai báo definition `hrAdministration@1`, xem [Release 7 — boundary HR](#release-7--boundary-hr-2026-10-19).
- Ngữ nghĩa đã kiểm khi chạy: không có grant → plan `allow` với predicate false (bản ghi trả 404/rỗng); thiếu fresh-auth hoặc boundary → `deny` (403). `ProductAuthorization.permits` vì vậy được sửa (2026-10-18) thành "plan chạm được ít nhất một bản ghi" (một `EXISTS` trên bảng bind); trước đó nó trả `true` cho mọi account khi policy qua, kể cả menu `accounts`. Menu HR và `companyScope` dùng `permits`.
- Bằng chứng: `apps/api/test/hrm-employee.integration-spec.ts`, `hrm-team.integration-spec.ts`, `hrm-input.spec.ts`, smoke HTTP trong `product.e2e-spec.ts` (ledger T3 trong kế hoạch).

## Release 7 — boundary HR (2026-10-19)

Người dùng chọn khai báo boundary HR trong manifest (thay lựa chọn "chỉ Root" của §7 ngày 2026-10-17) và kiểm ca dương tính cho IAM. Quyết định khi implement:

- **Definition** `hrAdministration@1` (`hr/hr.declarations.ts`, release `7`, predecessor `6`) có đúng hai entry `team.assign` và `employee.linkAccount`; `contextRequirements: []` (fresh-auth đã nằm ở policy `hrFresh`), `requiredScope` là `constant true` = phạm vi `A` (toàn công ty) của HR/Admin trong ma trận spec §5.2. Các resource `team`/`employee` không có field nào để giới hạn hẹp hơn mà spec yêu cầu; guard nghiệp vụ (§6 Triển khai T3: không tự gắn/gỡ account, không tự thêm vào team/làm lead, account IAM chưa suspend/chưa gắn) vẫn là code-owned.
- **Binding theo user + permission**, không kế thừa từ role (`docs/permission-boundaries.md`: một binding cho mỗi `(user, permission)`, không suy boundary từ role). Release không seed binding nào vì user là dữ liệu runtime; hiện chưa có route/CLI ghi `user_boundary` runtime (ADR 0027 §9), nên trên môi trường thật IAM `hr.admin` vẫn bị 403 cho tới khi có lệnh quản lý binding (quyết định riêng: permission riêng, delegation, không tự gỡ/mở rộng boundary của chính mình). Tests ghi binding trực tiếp bằng login `authority` trong transaction `admin`.
- **Boundary không cấp quyền**: có binding mà không có grant `hr.admin` thì plan `allow` với predicate false (không tìm thấy); binding chỉ cho `team.assign` không mở `employee.linkAccount` (403); deny rule thắng grant + boundary; thu hồi binding có hiệu lực ở transaction kế tiếp trên cùng phiên. Root không đổi (bypass, không có binding).
- **Phạm vi còn mở**: vì `requiredScope` là `constant true`, boundary hiện chỉ là công tắc bật/tắt theo user cho grant `hr.admin`, không thu hẹp thêm. Một `hr.admin` đã bind có thể đổi liên kết hồ sơ/lead/thành viên của hr.admin hay COO khác; account đích của `linkAccount` chỉ qua guard code-owned (§6), không được authorize như đối tượng. Bảo vệ giữa các IAM principal muốn có phải thêm field/relation trên target hoặc deny rule (quyết định riêng). Trên môi trường thật `user_role` cũng chưa có đường ghi runtime (ADR 0027 §9), nên hiện chưa có IAM `hr.admin` nào; thiếu cả hai đường ghi role và binding.
- Không cần migration: bảng `permission_boundary*`/`user_boundary` có từ migration `001`; manifest sync ghi definition bất biến theo hash, sync lặp không đổi gì, release 6 bị từ chối `downgrade` sau khi lên 7.
- Bằng chứng: `apps/api/test/hrm-authorization-matrix.integration-spec.ts` (2 test mới), `hrm-authorization-upgrade.integration-spec.ts` (bước 6 → 7), fixture `apps/api/test/fixtures/release-six.ts` (hash release 6 ghim), ledger T2 trong kế hoạch.
