# ADR 0033 — Giới hạn 300 dòng cho file business logic

Ngày: 2026-10-21. **Trạng thái: Accepted** (2026-10-21, người dùng chọn rule `max-lines` và tách ngay các service nghiệp vụ lớn). Không đổi hành vi, route, SQL, thứ tự khóa, tên bảng, mã lỗi, quyền, manifest/hash hay locale.

## Bối cảnh

Các service nghiệp vụ (`employee.service.ts` 658 dòng, `leave.service.ts` 537, `attendance.service.ts` 461, `work-request.service.ts`, `request-approval.service.ts`, `team.service.ts`) và vài trang web (`approval-inbox.page.tsx`, `work-calendar.page.tsx`, `team-detail.component.tsx`, `employee-profile.component.tsx`) gộp command, query, SQL và mapping trong một file, khó review thứ tự khóa và quyền.

## Quyết định

1. ESLint `max-lines` mức `error`: 300 dòng, `skipBlankLines: true`, `skipComments: true`, cho `apps/api/src` và `apps/web/src` (`fileSizeLimit` trong `eslint.shared.config.js`, gọi từ `eslint.config.js` của từng app).
2. Miễn `*.declarations.ts`, `*.schema.ts`, `*.migration.ts`, `*.manifest.ts` (dữ liệu khai báo) và test (nằm ngoài `src`).
3. Đã tách các file trên theo trách nhiệm (SQL đọc, SQL ghi/effect, helper SQL dùng chung, component con); tên class, method, DI token, `ProductCommand`/`ProductQuery` đăng ký ở `product-runtime.service.ts` và thứ tự khóa giữ nguyên.
4. Ngoại lệ tạm (nền tảng lớn, chưa tách): `auth/services/product-mfa.service.ts`, `authorization/core/policy.validator.ts`, `authorization/services/product-authority.service.ts`, `database/helpers/product-database.helper.ts`. Chúng nằm trong danh sách `fileSizeLimit([...])` ở `apps/api/eslint.config.js` với comment `shortcut`: tách khi chạm tới file để sửa logic, vì tách các file khóa/ủy quyền/provisioning cần review riêng về thứ tự khóa và bảo mật.
5. Kiểm: `apps/api/test/file-size-limit.spec.ts` chạy ESLint thật lên file mẫu (301 dòng bị bắt, 300 qua, dòng trống/comment không tính, `*.declarations.ts`/`*.schema.ts`/`*.migration.ts`/`*.manifest.ts` được miễn, file ngoại lệ được miễn còn file khác cùng thư mục thì không).

## Cách gỡ ngoại lệ

Khi tách một file ngoại lệ xuống còn <= 300 dòng, xóa đường dẫn khỏi danh sách trong `apps/api/eslint.config.js`; test `keeps the temporary exception list explicit` dùng một file trong danh sách, cập nhật nó sang file còn lại (hoặc xóa test khi danh sách rỗng). Không thêm file mới vào danh sách để qua lint.

## Hệ quả

Nhiều file nhỏ hơn, review dễ hơn; đổi lại thêm import nội bộ. Không giảm rủi ro bảo mật hay hiệu năng. Rule chỉ đo số dòng, không đo độ phức tạp.
