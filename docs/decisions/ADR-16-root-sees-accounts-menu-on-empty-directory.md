# ADR-16 — Menu `accounts` của Root khi chưa có tài khoản IAM

Trạng thái: **Accepted** (2026-10-31): người dùng chọn phương án A; Q2 chưa được trả lời nên áp mặc định đơn giản nhất (mọi probe menu của Root). Đã triển khai ở `ProductAuthorityReads.reachesAny`. Liên quan [ADR-05](ADR-05-root-iam-boundaries-account-invariants.md) (Root ngoài IAM), [ADR-12](ADR-12-administration-accounts-settings-roles.md) (trang tài khoản) và [ADR-15](ADR-15-identity-operations-by-permission.md).

## Quan sát

- Trên stack mới chỉ có Root, `GET /api/auth/me` của Root trả `["approvals","employees","teams","calendar","settings","roles"]`: thiếu `accounts` và `reports`. `/accounts` hiện "Không tìm thấy trang" vì trang chỉ mở khi `menus` có `accounts` (`account.page.tsx`).
- Nguyên nhân: `EmployeeService.menus` gom các probe vào một `permitsMany`; mỗi probe là `ProductAuthorityReads.reachesAny`, chạy `SELECT EXISTS` trên bảng của resource với plan của người gọi (`product-authority-read.service.ts`). `account` đọc từ `account_directory`, chỉ chứa tài khoản IAM, nên bảng rỗng thì `account.read` không "chạm tới" dòng nào, kể cả với Root (`planUnrestricted`).
- Hệ quả: khi chưa có tài khoản IAM nào, Root không mở được trang có form `account.provision`. Trong `apps/api/package.json` chỉ có các lệnh `root:*` (bootstrap, revoke, reissue, set-email, reset-mfa); chưa thấy lệnh tạo tài khoản IAM. Chưa kiểm hết `tools/`, nên "không có đường khác" là điều cần xác minh.
- `hrm-menu-account.integration-spec.ts` khẳng định Root thấy `accounts` nhưng chỉ sau khi đã tạo người dùng, nên không phát hiện ca này.
- Cùng cơ chế làm Root không thấy `reports` khi chưa có nhân viên; hiệu ứng này nhẹ hơn vì trang báo cáo không là đường duy nhất tạo dữ liệu.

## Phương án

- **A. Probe chỉ theo quyết định cho Root.** Khi `session.kind === 'root'` và `decide` cho `allow`, `reachesAny` trả `true` không cần `EXISTS`. Root vốn bỏ qua mọi kiểm tra; chỉ một chỗ đổi, không đổi số probe. Mọi menu hiện ra cho Root kể cả khi chưa có dữ liệu (trừ ba menu tự phục vụ vốn chỉ hỏi khi có hồ sơ gắn). Trang vẫn tự authorize từng đọc/ghi.
- **B. Probe riêng cho hành động tạo.** Thêm `account.provision` vào menu `accounts`, đánh giá theo quyết định (không `EXISTS`) vì hành động tạo không có dòng để chạm. Áp cho cả người giữ `account.provision` có scope hẹp (không thấy dòng nào). Cần một loại probe mới trong `permit-probe.helper.ts` và nâng `MAX_PERMIT_PROBES` (đang đúng 17 cho tài khoản có hồ sơ gắn); số đo ở `docs/history.md` cho khoảng 4 ms mỗi cặp.
- **C. Không đổi.** Ghi vào `docs/operations.md` rằng tài khoản IAM đầu tiên cần đường khác. Chỉ chọn nếu có đường đó và đã kiểm chứng.

Đề xuất: **A** cho `accounts`, hoặc **A** cho mọi menu của Root nếu người dùng muốn nhất quán. **B** để sau, khi có người dùng IAM giữ riêng `account.provision`. Đây là đề xuất, không phải quyết định.

## Kiểm chứng cần có nếu chọn A

- Test dịch vụ (PostgreSQL thật): Root trên DB không có tài khoản IAM thấy `accounts`; IAM không có grant vẫn không thấy; IAM có `account.read` nhưng directory rỗng vẫn không thấy (A không đổi người khác).
- Mutation: bỏ nhánh `kind === 'root'` thì test Root đỏ; mở nhánh cho `iam` thì test IAM đỏ.
- Cập nhật `hrm-menu-account.integration-spec.ts` và e2e `apps/web/e2e/administration.e2e-spec.ts` (bỏ fixture tạo sẵn tài khoản).
- Người đánh giá độc lập (thay đổi nằm trên đường quyết định phân quyền).

## Quyết định và phạm vi triển khai

- Người dùng chọn **A**. Lối tắt chỉ nằm ở đường menu (`permitsMany`, nơi duy nhất truyền `menu = true`): `session.kind === 'root'` và `decide` cho `allow` thì probe trả `true` không cần `EXISTS`.
- `permits` (một cặp) **không đổi**: `ReportService.export` dùng nó để từ chối xuất khi phạm vi rỗng (`403`, không bao giờ file rỗng), Root cũng chịu quy tắc đó.
- Q2 mặc định: áp cho mọi probe menu của Root, không riêng `accounts`, vì tách riêng cần thêm thuộc tính cho probe. Root vẫn không thấy các menu tự phục vụ khi không có hồ sơ gắn (probe đó không được hỏi). Nếu muốn giới hạn chỉ `accounts`, cần ADR bổ sung.
- Kiểm chứng: `hrm-menu-account.integration-spec.ts` (Root thấy `accounts` và `reports` khi chưa có tài khoản IAM và nhân viên; `permits` một cặp vẫn `false`; không ai khác đổi) và e2e `administration.e2e-spec.ts` (Root thêm tài khoản đầu tiên bằng giao diện). Thử đỏ ngược: mở lối tắt cho mọi người thì `hrm-menu-account` và `hrm-permits-many` đỏ.
