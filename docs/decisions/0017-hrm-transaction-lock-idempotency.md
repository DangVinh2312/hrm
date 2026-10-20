# ADR 0017 — Giao dịch, thứ tự khóa và idempotency HR

Ngày: 2026-10-17. **Trạng thái: Proposed** — hướng đã được người dùng duyệt 2026-10-17 (TD4); chuyển Accepted sau khi có integration test PostgreSQL ở mục dưới. Thiết kế: [HRM design](../superpowers/specs/2026-10-16-hrm-design.md) §6–§7.

## Bối cảnh

`ProductTransactionRunner` (READ COMMITTED, shared fence cho `read`/`write`, exclusive + revision cho `admin`, deadline 3000 ms (nâng từ 2000 ms ngày 2026-10-19 theo yêu cầu người dùng: `25P04` ở bước dựng stack khi chạy song song; đo `reconcile` release 5/6 trên DB trống trung vị ~332/~347 ms nên đây không phải hồi quy T4), lock 1000 ms, retry ≤ 2 chạy lại `work` khi `40P01`/`40001`/`55P03`). Shared fence không serialize hai writer trên cùng nhân viên; quota WFH/phép cần serialization riêng.

## Quyết định đề xuất

1. **Một transaction cho một command**: decision + ledger + công + counter + audit commit cùng nhau. Không nested transaction, không transaction thứ hai bổ sung effect.
2. **Thứ tự khóa** cho mọi writer HR: fence → session/facts/plan → `employee` (`FOR NO KEY UPDATE`, target của `execute`, id tăng dần) → đọc idempotency → `work_request` (id tăng dần) → bucket (upsert rồi `FOR UPDATE`, theo `(employee_id, kind, period)`) → kỳ công → `work_calendar` `FOR SHARE` (khi đọc lịch) → ghi (claim idempotency INSERT cùng effect). Identity flows giữ protocol riêng. _Sửa 2026-10-20 (T5):_ bản đầu đặt claim trước employee; submit thực tế khóa employee trước (khóa nằm trong `execute`), và vì `employee.account_id` UNIQUE nên khóa này tuần tự hóa mọi submit của một actor — đọc rồi INSERT claim cùng commit là đủ, PK là lớp cuối. Mọi writer sau phải giữ đúng thứ tự này (spec §7.3). _Bổ sung 2026-10-20 (T6 decide):_ target của `execute` là dòng `work_request` (plan của stage khớp và khóa trong một câu lệnh), rồi đọc idempotency, rồi ghi; decide không khóa employee/bucket/lịch (chưa cần trước M3). Hai đơn khác nhau dùng cùng key của một actor không bị khóa request tuần tự hóa: claim `INSERT … ON CONFLICT DO NOTHING` đến sau chờ claim trước rồi không chèn được → 422 `error.idempotencyKeyReused`. Effect duyệt cuối (T7/T8) khóa bucket/kỳ công sau request.
3. **Transition có điều kiện**: `UPDATE … WHERE id AND version = expected AND state = from`; 0 dòng → 409. UNIQUE `(request_id, stage)` là lớp DB cuối.
4. **Idempotency**: bảng `hr_idempotency` PK `(actor_id, operation, key)`, `payload_hash` SHA-256 tính ngoài SQL, `result` chỉ id/state/version. Claim commit cùng effect. Replay recheck quyền trước khi trả. Khác hash → 422 `error.idempotencyKeyReused` (người dùng chốt 2026-10-20, thay ruling T5 409 `error.conflict`; key chỉ nói về không gian key của chính actor). Retention 7 ngày, purge offline.
5. **Không I/O ngoài DB trong `work`** vì runner có thể chạy lại. Render/upload/ký nằm ngoài fence và recheck version khi publish.
6. **Gate duyệt cuối**: map `kind → effect handler` cố định lúc boot; thiếu → 409 `final_approval_unavailable`, rollback. Áp cho mọi quyết định của người đưa đơn sang `approved`, gồm `lead_approve` late/early (chuỗi một bước, spec §6.4.1, người dùng chốt 2026-10-20).
7. Không mutex in-memory, không cache quyền, không tăng deadline runner.

## Kiểm chứng bắt buộc trước Accepted

Hai connection với barrier: approve/approve, approve/reject, approve sau revoke, tranh WFH lần 4/5, tranh số dư cuối, bucket đầu tháng chưa tồn tại, replay sau timeout, lỗi audit rollback; đo lock wait trên workload §11 spec. Deadlock phải fail closed qua retry hữu hạn.

Đã có (T6, 2026-10-20, `apps/api/test/hrm-approval.integration-spec.ts`, barrier giữ dòng `work_request FOR UPDATE` tới khi hai backend `product_data` cùng chờ khóa): approve/approve và approve/reject (một decision, bên kia 409 `stale_version`), cùng key hai lần (replay, một decision), cùng key trên hai đơn (một commit, bên kia 422), approve sau revoke role (404), lỗi audit rollback decision/transition/claim. Chưa có: tranh WFH lần 4/5, số dư cuối, bucket đầu tháng (cần effect T7/T8), đo lock wait trên workload §11. ADR vẫn Proposed.

## Rủi ro

Khóa employee serialize mọi thao tác của một nhân viên — chấp nhận ở quy mô ~50 người; cần đo lại nếu quy mô đổi.
