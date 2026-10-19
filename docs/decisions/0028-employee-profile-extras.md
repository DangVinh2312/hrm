# ADR 0028 — Thông tin hồ sơ nhân viên bổ sung (giới tính, điện thoại, email công việc, chức danh, phân loại)

Ngày: 2026-10-19. **Trạng thái: Proposed** — mặc định do người dùng ủy quyền khi nhập bảng tính nhân viên; chưa được duyệt riêng. Mở rộng [ADR 0016](0016-hrm-authorization-and-pii.md) (field ACL) và [ADR 0018](0018-hrm-data-model-and-time.md) (mô hình dữ liệu). Migration `1792108800105` (`HrmEmployeeProfile`).

## Quyết định

**Phân loại độ nhạy.**

| Field            | Nhóm | Bảng/cột                       | Lý do                                                                           |
| ---------------- | ---- | ------------------------------ | ------------------------------------------------------------------------------- |
| `gender`         | F2   | `employee_identity.gender`     | thông tin cá nhân                                                               |
| `phone`          | F2   | `employee_identity.phone`      | liên lạc cá nhân, định danh được người                                          |
| `workEmail`      | F2   | `employee_identity.work_email` | định danh được người; cùng resource nên dùng chung quyền `employeeIdentity.read | update`, scope `self`, fresh-auth và audit |
| `position`       | F1   | `employee.job_position`        | thông tin tổ chức, hiển thị cho ai đọc được `employee`                          |
| `classification` | F1   | `employee.classification`      | như trên; không phải loại hợp đồng pháp lý                                      |

Không thêm resource, permission, policy hay thay đổi manifest (release giữ nguyên). F2 mới chỉ nằm trong `EmployeeIdentityView`, không vào `EmployeeView`, danh sách, `/api/hr/me`, URL, log hay audit; audit vẫn chỉ id/kind. F1 mới nằm trong `EmployeeView` (chi tiết), không vào danh sách.

**Tập đóng.** `gender` ∈ `male|female|other`; `classification` ∈ `fullTime|contractor`. Giá trị lạ bị từ chối (400). Nhãn hiển thị là key locale (`employee.gender.*`, `employee.classification.*`); bảng tính "Nam/Nữ", "Toàn thời gian/Contractor" ánh xạ ở importer, không ở API.

**Chuẩn hóa (validator và CHECK DB giống nhau).**

- `phone`: bỏ khoảng trắng, `.`, `-`, `(`, `)`; đầu `+84` đổi thành `0`; kết quả phải khớp `^0[1-9][0-9]{8,9}$` (10 hoặc 11 chữ số, dạng quốc gia). Mã nước khác, chữ cái, `84` trần và độ dài khác bị từ chối, không đoán. Lưu và trả dạng chuẩn. Số di động bị Excel mất số `0` đầu là việc của importer, không của API.
- `workEmail`: trim, chuyển chữ thường, tối đa 254 ký tự; phần local gồm `a-z 0-9 _ + -` ngăn bởi dấu chấm đơn, domain kiểu DNS (label ≤ 63, TLD chữ ≥ 2). Không nhận tên hiển thị, dấu nháy, comment, IP literal, ký tự không ASCII.
- `position`: trim, 1..100 code point, không ký tự điều khiển (cùng `hrText`); DB `COLLATE "C"`, `btrim` và `!~ '[[:cntrl:]]'`.
- Mọi field mới nullable; `null` = chưa ghi nhận/xóa. Hàng hiện có giữ `NULL` nên migration không cần ánh xạ và không thất bại trên bảng đã có dữ liệu.

**Không UNIQUE** cho `phone` và `workEmail`: người dùng chung số/email nhóm là thực tế; UNIQUE sẽ trả 409 cho người tạo/sửa, tiết lộ có bản ghi khác (có thể ngoài scope của họ). Nếu sau này cần dedup, làm ở tầng nghiệp vụ trên dữ liệu người gọi được phép xem.

**Không gắn với xác thực trong hệ thống.** `workEmail` là dữ liệu liên hệ; mã không bao giờ dùng nó để đăng nhập, enrollment OIDC, khôi phục, so khớp `app_user.email`/`email_canonical`, liên kết `employee.account_id` hay quyết định quyền, và không sao chép sang bảng định danh. Theo quy ước vận hành (người dùng xác nhận 2026-10-19), operator enroll tài khoản bằng chính địa chỉ này (`identity:enroll --email <workEmail>`); hai giá trị độc lập nhau, đổi một bên không đổi bên kia. Liên kết nhân viên–tài khoản vẫn chỉ qua `employee.linkAccount` (ADR 0016 §5).

**API.** `POST /api/hr/employees` thêm `position`, `classification` (và `gender`, `phone`, `workEmail` trong `identity`); `PATCH /api/hr/employees/{id}` thêm `position`, `classification` (thay thế cả F1, cần `expectedVersion`); `PUT .../identity` thay cả F2 gồm ba field mới. Mọi key bắt buộc có mặt, `null` để xóa; key thừa bị từ chối. Lỗi giữ tập mã đóng, không thêm mã lỗi.

**Quyền DB.** `product_data` được INSERT/UPDATE đúng cột mới (`job_position`, `classification` trên `employee`; `gender`, `phone`, `work_email` trên `employee_identity`); danh sách quyền cột chính xác nằm trong `hrPrivileges` và privilege probe.

## Hệ quả

Client cũ gửi `identity`/PATCH/POST thiếu field mới sẽ bị 400 (hợp đồng đổi có chủ đích, không có người dùng production). Mã hóa F2 vẫn hoãn tới D13 (ADR 0018).
