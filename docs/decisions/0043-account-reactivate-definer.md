# ADR 0043 — Khôi phục tài khoản IAM (`account.reactivate`): hàm SECURITY DEFINER và trigger vòng đời

Ngày: 2026-10-24. **Trạng thái: Accepted**, triển khai đợt 1 của [ADR 0041](0041-administration-settings-roles-accounts.md) (người dùng yêu cầu đợt 1; ADR 0041 Accepted cùng ngày). Release `17`, migration product `021` (qua `db:provision`). Không đổi bất biến nào của ADR 0012/0022; chỉ thêm đường ra khỏi `suspended` mà trước đây không có.

## Bối cảnh (đã kiểm trên PostgreSQL 18 thật, 2026-10-24)

- `suspendUser` (`authorization/services/product-authority.service.ts`) tra đích qua `gateway.detail` (view `account_directory`, chỉ IAM), từ chối tự tác động, rồi `UPDATE app_user` bằng login `authority`. `ProductCommand` (`execute`) không dùng được cho `account`: nó khóa hàng đích `FOR NO KEY UPDATE`, mà đích là view `security_barrier` có `LEFT JOIN`; nên `reactivateUser` là method riêng cùng dạng với `suspendUser`.
- Trigger `protect_account_lifecycle` (migration `004`) cho login `authority` chỉ chuyển `state` sang `suspended`. Nó xét `current_user`. Trong hàm `SECURITY DEFINER`, `current_user` là owner hàm, nên trigger **không** chặn hàm định nghĩa bởi `product_account_owner` và **không cần sửa** (đã kiểm: test `product-account-reactivate.integration-spec.ts` — `UPDATE ... SET state='active'` trực tiếp của `authority` vẫn bị `42501`, còn hàm definer chuyển được). `guard_root_lifecycle` xét `session_user`: với hàng IAM chỉ chặn `bootstrap`, với hàng Root chỉ cho `bootstrap`/`identity` — là lớp phòng thủ thứ hai nếu điều kiện `kind='iam'` của hàm sai.

## Quyết định

1. `public.reactivate_iam_account(p_user uuid) RETURNS void`, `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, `REVOKE ALL FROM PUBLIC`, `EXECUTE` chỉ cho `product_authority`, owner `product_account_owner` (tái dùng owner của `provision_oidc_account`/`account_directory`; không tạo role mới).
2. Thân hàm (hằng `reactivateIamAccountBody`, được probe ghim): khóa hàng `FOR UPDATE`; vắng → `P0002`; `kind <> 'iam'` (Root và mọi loại khác) → `42501`; `state <> 'suspended'` → `55000`; có `external_identity` `enabled` tại `oidc_provider` `enabled` → `active`, ngược lại `pending`; luôn `auth_epoch = auth_epoch + 1` (không phiên cũ nào sống lại). Không đọc email, không tạo secret, token hay enrollment.
3. ACL owner (`accountOwnerAcl`, probe khớp chính xác) thêm: `SELECT(auth_epoch)`, `UPDATE(state, auth_epoch)` trên `app_user`, `SELECT(issuer, user_id, enabled)` trên `external_identity`, `EXECUTE` hàm. `expectedPrivileges.authority` thêm `function:reactivate_iam_account(uuid):EXECUTE`; `protectionFunctions` thêm hàm. Không login nào khác có `EXECUTE`.
4. Service `reactivateUser(secret, target)`: mode `admin` (fence độc quyền, `revision+1`), cùng thứ tự `suspendUser`: id không chuẩn → 403 trước mọi truy vấn; tra `account_directory` (Root/vắng → `false` → 404); `actor === target` → 403 (trước kiểm trạng thái); gọi hàm; `55000` → `ProductCommandRejected` (409 `error.conflict`, không key lỗi mới); audit `account.reactivate` (actor, permission, target `userId`; Root có `rootEvent`) cùng transaction.
5. Action `account.reactivate`: `fresh@1`, `boundary: 'required'`, obligation audit, **không grant mặc định** (như `suspend`); Root làm được ngay, IAM cần grant runtime + binding boundary (đợt 3b mới có đường UI). Route `POST /api/administration/users/:id/reactivate` → 200 `{ status: 'reactivated' }`.
6. Menu `accounts`: probe `account.read` nằm trong cùng lượt `permitsMany` của `EmployeeService.menus` (15/16 cặp khi có hồ sơ liên kết, không nâng `MAX_PERMIT_PROBES`); web đặt `staleTime` 60 giây cho `useMenus()` (Q17).

## Giới hạn đã biết (chấp nhận, không giả lập)

- Khôi phục không tạo lại lời mời đăng nhập lần đầu. Tài khoản `pending` mà `oidc_email_enrollment` đã hết hạn thì **không đăng nhập được** (`liveEnrollment` đòi `expires_at > now`); không thể cấp lại bằng `provision` (email đã tồn tại → 23505 → 409) hay CLI `identity:enroll` (chỉ tạo tài khoản mới). Trang web hiển thị "Đã hết hạn" kèm gợi ý; đường sửa (lời mời mới/đổi binding) là `account.resetGoogleBinding` của đợt 4 (ADR 0041 §6). Tài khoản đã có binding bật thì về `active` và đăng nhập lại bình thường.
- Cột `enabled` của binding chỉ đổi được bởi CLI offline; hàm không bật lại binding bị vô hiệu hóa (khi đó đích về `pending`).
- ~~Bất biến (d) của ADR 0041 §2 chưa áp cho `reactivate` và `suspend`~~ — **đã áp ngày 2026-10-25 theo [ADR 0046](0046-role-matrix-and-grant-set-invariant.md) §3** (trước khi có UI gán role/binding): IAM actor chỉ khóa/khôi phục đích có tập grant ⊆ tập của mình, nếu không `404` (như vắng, trước cả kiểm trạng thái 409); Root bỏ qua. Test `product-account-grant-scope.integration-spec.ts`, kèm mutation. Rule gắn thẳng user hoặc `deny` ở actor/đích làm phép so sánh không chứng minh được nên bị từ chối.
- Hai người cùng quyền khôi phục lẫn nhau (bỏ R6 của ADR 0041): không đổi.

## Kiểm chứng

`apps/api/test/product-account-reactivate.integration-spec.ts` (PostgreSQL thật, mức service/DB): bound → `active`, chưa từng đăng nhập → `pending` (enrollment giữ nguyên), binding tắt → `pending`; `auth_epoch` tăng, phiên cũ không resolve; active/pending → 409 không đổi gì; tự khôi phục → 403; Root/vắng/ID không chuẩn; ma trận actor; hai lệnh đồng thời chỉ một thành công; audit lỗi rollback; hàm: chỉ `authority` có `EXECUTE`, trigger vẫn chặn `UPDATE` trực tiếp, đích Root (suspended) bị từ chối bằng kiểm `kind`. Probe ACL/trigger/hàm: `product-account-provisioning.integration-spec.ts` (drift owner, `search_path`, `SECURITY INVOKER`, grant thừa/thiếu).
