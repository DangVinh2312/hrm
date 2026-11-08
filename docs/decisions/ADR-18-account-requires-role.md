# ADR-18 — Tài khoản IAM luôn có ít nhất một role

Trạng thái: **Accepted** (2026-11-04). Người dùng chọn: "Chọn role khi cấp", "Chặn, trả 409" cho role cuối, "Migration gán role cho TK cũ" với role `hr.employee`. Bổ sung [ADR-12](ADR-12-administration-accounts-settings-roles.md) (cấp tài khoản) và [ADR-13](ADR-13-runtime-roles-assignment-boundary-binding.md) (gán/thu hồi role); không đổi mô hình quyền ([ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)), fence ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)) hay phiên.

## Quan sát

- `account.provision` tạo tài khoản `pending` không role. Người được cấp đăng nhập xong không thấy gì cho tới khi có người gán role riêng; người dùng kỳ vọng "khi thêm tài khoản thì phải có role".
- `account.revokeRole` thu hồi được role cuối cùng. CLI `identity:enroll` cũng tạo tài khoản không role.
- Login `data` có EXECUTE `provision_oidc_account` nhưng không ghi `user_role`; login `authority` ghi `user_role` nhưng không có hàm. Không có login nào tạo được tài khoản kèm role trong một giao dịch.

## Quyết định

**Bất biến.** Mọi tài khoản `kind = 'iam'` có ít nhất một dòng `user_role`. Root nằm ngoài IAM, không áp dụng. Bất biến giữ bằng ba đường ghi duy nhất (cấp, CLI enroll, thu hồi) và migration cho dữ liệu cũ, không bằng constraint DB.

**Cấp kèm role.** `POST /api/administration/accounts` nhận `{ email, roleKey }`, cả hai bắt buộc; thiếu hoặc sai dạng là `400 error.invalidRequest` trước giao dịch.

- Người gọi cần cả `account.provision` và `account.assignRole`. Trước khi lấy exclusive fence, một giao dịch `read` lập quyết định cho hai cặp; thiếu cặp nào là `403 error.accessDenied` mà không xếp hàng chờ exclusive fence (cùng nguyên tắc `reachesTarget` và logout ở ADR-17). Bước exclusive quyết định lại.
- Lệnh chạy ở mode `admin` (exclusive fence, tăng revision) trên login `authority`, theo thứ tự:
  1. quyết định `account.provision` (`access`);
  2. role: IAM cần role tồn tại, đọc đủ (không `truncated`) và mọi rule của role nằm trong tập grant của người gọi (điều kiện (c) của `assignRole`); Root chỉ cần role tồn tại. Không đạt thì trả `404 error.notFound`, không tạo gì (Root vẫn để lại audit `outcome: 'absent'`);
  3. `provision_oidc_account`; email đã có là `409 error.conflict` như trước;
  4. tài khoản mới phải thấy được qua plan `account.provision` và plan `account.assignRole` của người gọi (scope); không thì `403`, rollback toàn bộ;
  5. ghi `user_role`, audit `account.provision` và `permission.role-assign`, thực hiện obligation của cả hai plan (`access.provision`, `access.assignRole`) trong cùng giao dịch.
- Migration chuyển EXECUTE `provision_oidc_account` từ `product_data` sang `product_authority`: login `data` không còn tạo được tài khoản (không role) nữa.

**Role cuối.** `account.revokeRole` khi tài khoản chỉ còn đúng role đó trả `409 error.conflict` (`ProductCommandRejected('last_role')`), thứ tự sau mọi kiểm tra hiện có (không giữ role vẫn là 409 `role_not_held`). Muốn bỏ mọi quyền thì `account.suspend`. Không thêm key lỗi mới: `error.conflict` đã là mã chung của mọi 409 trạng thái; web biết role cuối từ danh sách role đang hiển thị và khóa nút thu hồi kèm gợi ý, nên key riêng không thêm thông tin cho người gọi hợp lệ.

**CLI `identity:enroll`** bắt buộc `--role <roleKey>`. Lệnh chạy trên login `authority` ở mode `admin`: `provision_oidc_account` (actor `PRODUCT_OFFLINE_ACTOR`), `user_role`, audit `identity.enroll` và `permission.role-assign` trong một giao dịch. Role không tồn tại thì lỗi, không tạo gì. CLI là thao tác offline có thẩm quyền nên không có so sánh tập grant. `.env.ops` cần thêm `PRODUCT_AUTHORITY_DATABASE_URL` (mật khẩu `authority` vốn đã ở đó cho provisioning).

**Dữ liệu cũ.** Migration `AccountRoleRequired1792108800006` (forward, `administration/migrations`): khóa `authz_state` (`FOR UPDATE`) bằng một câu riêng, để câu gán sau đó thấy mọi tài khoản đã commit bởi giao dịch giữ fence trước; rồi gán `hr.employee` cho mọi tài khoản `kind = 'iam'` chưa có role (mọi trạng thái `pending`, `active`, `suspended`), mỗi tài khoản một sự kiện `permission.role-assign` (actor `PRODUCT_OFFLINE_ACTOR`, permission `account.assignRole`, metadata như lệnh gán), và tăng revision một lần khi có dòng. Role `hr.employee` do sync manifest tạo; nếu có tài khoản cần gán mà role chưa có thì FK làm migration lỗi (fail closed), chạy `sync` trước rồi migrate lại. Database mới chưa có tài khoản nên migration không ghi gì.

## Hệ quả

- Web: form cấp tài khoản có ô chọn role bắt buộc (danh sách từ `role.read`; không đọc được thì không gửi được form). Nút thu hồi khóa khi tài khoản còn một role.
- Người chỉ có `account.provision` (không `account.assignRole`) không còn cấp được tài khoản: chấp nhận, vì tài khoản không role là thứ người dùng không muốn.
- Fixture test tạo tài khoản bằng `provision_oidc_account` chuyển sang pool `authority`.

## Còn mở

- Không có constraint DB cho bất biến: một login có quyền ghi `user_role` (authority) vẫn xóa được role cuối bằng SQL trực tiếp. Chỉ code của lệnh thu hồi chặn. Nâng lên trigger deferred khi có đường ghi `user_role` thứ tư.
- Login `identity` vẫn có `INSERT` trên `app_user` (baseline; đường dùng duy nhất trong `src`/`tools` là CLI enroll cũ, nay chuyển sang `authority`). Fixture integration còn dùng quyền này để tạo user, nên thu hồi cần sửa các fixture đó; làm cùng trigger nói trên.
- Form web liệt kê mọi role `role.read` trả về; chọn role vượt tập grant của người gọi nhận `404 error.notFound` chung.
