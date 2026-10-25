# ADR 0044 — COO tự duyệt lúc submit theo permission, không theo tên role

Ngày: 2026-10-25. **Trạng thái: Accepted**, triển khai đợt 3a của [ADR 0041](0041-administration-settings-roles-accounts.md) §8 (mục Q9). Không đổi release, migration hay hash.

## Bối cảnh (đã đọc trong mã, 2026-10-25)

`createSubmitRequest` (`modules/work-request/services/work-request.service.ts`) xác định "người gửi là COO" bằng truy vấn `user_role` theo `role_key = 'hr.coo'`. Khi có UI gán/tạo role, role runtime mang đủ grant của COO không được coi là COO, còn gán `hr.coo` đổi hành vi nghiệp vụ mà không thấy qua permission. Grep `'hr\.` trong `apps/api/src` ngoài declarations/migration/seed: đây là nơi duy nhất kiểm hành vi theo tên role (`PermissionRole.Coo` chỉ xuất hiện trong declarations).

## Quyết định

1. "COO" lúc submit = `ctx.reaches(hrCompany, approvals, COMPANY_ID)`: kế hoạch của phiên có permission `hrCompany.approvals` (grant mặc định của `hr.coo`, mọi role mang grant tương đương, deny/boundary đều tính; đánh giá tại thời điểm submit nên thu hồi có hiệu lực ở lần submit sau). Không đọc `user_role`, không nêu tên role nào.
2. Quyền duyệt chính đơn vừa tạo giữ nguyên: sau khi ghi đơn `pending_final`, `ctx.reaches(workRequest, decideFinal, id)` vẫn là cổng; thiếu thì 409 `final_approval_unavailable` và không ghi gì (test M1 `hrm-coo-submit` giữ nguyên). Vì vậy role chỉ có `approvals` mà không có `decideFinal` bị từ chối như `hr.coo` bị deny `decideFinal`; role chỉ có `decideFinal` mà thiếu `approvals` không tự duyệt (đi theo luồng lead, bảo thủ).
3. Phương án đã loại: dùng riêng `decideFinal` làm điều kiện COO. Nó cần một hàng `work_request` để `reaches` đánh giá, nên phải ghi `pending_final` rồi sửa lại state cho mọi đơn, và đổi hành vi đã có test (deny `decideFinal` của COO từ 409 sang `pending_lead`). `hrCompany.approvals` đã là "người giữ bước duyệt cuối của công ty" (ghi chú ở `EmployeeService.menus`) và được `reaches` đánh giá trên hàng công ty cố định, không cần release mới.
4. Hệ quả (đã chấp nhận, ghi rõ):
   - `hrCompany.approvals` đổi nghĩa từ "display capability" (release 8, chỉ cho menu) thành điều kiện nghiệp vụ của việc tự duyệt.
   - Hồi quy so với trước: role runtime chỉ có `approvals` (thiếu `decideFinal`), trước chỉ hiện menu, nay bị 409 `final_approval_unavailable` ở MỌI lần submit của người giữ nó, vì được coi là COO mà không có quyền duyệt. Role chỉ có `decideFinal` thì không tự duyệt (đơn đi theo luồng lead). Giữ 409 (test M1 `hrm-coo-submit` không đổi).
   - Sau đợt 3b, role mang cả hai grant có năng lực mới là tự duyệt đơn của chính mình: cặp này là một năng lực, không phải hai quyền độc lập (xem mục bắt buộc ở đợt 3b của kế hoạch). Chưa có ràng buộc cưỡng bức hai grant đi cùng.

## Kiểm chứng

`hrm-request.integration-spec.ts`: role runtime `approver.runtime-t3a` không grant → `pending_lead`; thêm hai grant tương đương `hr.coo` → `approved` + decision `coo_self_approved`; thu hồi `approvals` (còn `decideFinal`) → `pending_lead` ở lần submit sau; chỉ `approvals` → 409 `final_approval_unavailable`, không ghi gì; `hr.coo` mặc định vẫn `approved`. Đột biến: bỏ kiểm `decideFinal` và ép `approvals` luôn đúng đều làm test đỏ (đã hoàn nguyên).
