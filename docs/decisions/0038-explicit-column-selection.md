# ADR 0038 — SQL chọn cột tường minh

Ngày: 2026-10-23. **Trạng thái: Accepted** (người dùng yêu cầu: "chỉ select những field nào cần dùng", rà toàn bộ repository và service).

## Bối cảnh

AGENTS.md ("Hiệu năng và giới hạn tài nguyên") cấm lấy cột không dùng và yêu cầu projection chỉ trả field được phép. Rà `apps/api/src` (không tính `migrations/`) cho thấy API đã dựng response bằng danh sách cột/`json_build_object` tường minh; không có entity TypeORM, không có `find`/`getMany`/`getRepository`, và không có `{ ...row }` nào trải hàng thô ra response (mọi spread đứng trên hàng do SQL liệt kê cột).

## Quyết định

1. Mọi câu SQL trong `src/` liệt kê cột cần dùng. Không `SELECT *`, `SELECT alias.*`, `RETURNING *`, `row_to_json`, `to_jsonb(hàng)`.
2. Đã sửa bốn chỗ đọc dư:
   - `attendance-adjust.repository.ts` (`attendanceAdjustments`): bảng con `attendance_adjustment` chỉ lấy `id, work_date, minutes, reason, reference, created_at` (trước đó `SELECT *`, kéo thêm `employee_id` và `actor_account_id`, bên ngoài không dùng).
   - `attendance-period.repository.ts` (`attendancePeriodState`): bảng con `attendance_period_event` chỉ lấy `event, version, reason, occurred_at` (trước đó `SELECT *`, kéo thêm `id`, `month`, `snapshot_hash`, `actor_account_id`, bên ngoài không dùng).
   - `product-authority.service.ts` (`session`): `resolve_session` chỉ lấy `user_id, kind, state, assurance, authenticated_at, reauthenticated_at, expires_at` (các cột `SessionProjection`).
   - `product-identity.service.ts` (`authenticate`): chỉ lấy `user_id, auth_epoch, method, assurance, authenticated_at` (các cột `SessionRow`). `fresh` vẫn tính từ `reauthenticated_at` của alias `s` trong cùng câu lệnh.
     Kết quả API, thứ tự, phân trang, scope SQL và hash không đổi.
3. Giữ nguyên, có lý do:
   - `SELECT * FROM <cte>` sau `WITH x AS (UPDATE/DELETE ... RETURNING cột)`: CTE đã liệt kê cột; câu ngoài chỉ chuyển tiếp để biết số hàng bị ảnh hưởng.
   - `SELECT * FROM (SELECT <projection>, count(*) OVER (), row_number() ...) p` trong `product-data.gateway.ts` và `SELECT * FROM scoped/pairs/page` trong các trang đọc: bọc ngoài một CTE/subquery đã chọn cột; không đọc thêm từ bảng.
   - `to_jsonb(t)` trong `protected-state.repository.ts`: định nghĩa của `authz_state.materialized_hash` là băm cả hàng sự kiện do code sở hữu; đổi sẽ đổi hash đã công bố.
   - Câu `SELECT ... LIMIT 0` trong `product-runtime.service.ts` kiểm cột tồn tại lúc boot, không đọc dữ liệu.
   - `ms.snapshot`, `ms.snapshot_hash` trong `report-sheet.repository.ts`: join đọc cho mọi tháng trong cửa sổ, dùng cho tháng đã đóng. Tách ra sẽ đổi kế hoạch truy vấn đã đo (ADR 0018); chưa có bằng chứng, nên giữ.
4. `apps/api/test/explicit-columns.spec.ts` quét mã nguồn `src/**/*.ts` (trừ `migrations/` và `*.migration.ts`, sau khi bỏ comment) và fail khi có các dạng ở mục 1; `SELECT * FROM x` chỉ hợp lệ khi `x` là CTE do chính file định nghĩa hoặc subquery; whole-row JSON chỉ cho `protected-state.repository.ts`. Giới hạn: đây là quét văn bản, không phân tích SQL; không thấy SQL ghép từ mảnh nhiều file, `//` trong chuỗi che phần còn lại của dòng, và không biết cột nào trong danh sách thật sự được caller dùng.

## Hệ quả

- Thêm cột vào response phải thêm vào danh sách SELECT tương ứng; thêm bảng/cột nhạy cảm không tự chảy ra API.
- Kiểm chứng: `explicit-columns.spec.ts`; các integration của các repository đã đổi (xem báo cáo bàn giao).
