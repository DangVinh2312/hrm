# ADR-07 — Audit atomic và outbox delivery at-least-once

Thay thế các ADR cũ: 0009, 0011 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Code: `audit/product-audit.repository.ts` (`ProductAuditRepository.appendProductAudit`, `PRODUCT_OFFLINE_ACTOR`), `audit/product-outbox.service.ts` (`ProductAuditOutbox`), `authorization/services/product-obligation.service.ts` (`audit@1`), bảng `audit_outbox` trong baseline `001`.

## Quyết định

### Ghi audit

- Mọi writer sản phẩm ghi `audit_outbox` qua `appendProductAudit(tx, event)` trong transaction của effect. Mutation thành công và audit bắt buộc commit hoặc rollback cùng nhau; lỗi ghi audit làm rollback cả effect. Event có kiểu (union theo `kind`), helper không nhận metadata tùy ý từ HTTP.
- `policy_revision` là revision dùng để đánh giá quyền (`tx.revision`, lấy dưới fence). Event không phải `access.*` có thêm `safe_metadata.resultingRevision` (chuỗi) là revision sau commit: `write` và `identity` = `tx.revision`, `revoke`/`admin`/`bootstrap` = `tx.revision + 1`, `manifest.sync` = revision reconciler công bố. Event `access.*` (obligation `audit@1`) không có `resultingRevision`. Event cũ hơn không bị ghi lại.
- Actor là người thực hiện. Đích tài khoản nằm ở `safe_metadata.targetUserId`. Đích dữ liệu ghi `object_id` (từ `objectIdColumn` của binding) cùng `resource`, `keyKind`, và `key` chỉ khi key kind là `uuid`/`integer` (key `string` có thể là PII nên không vào metadata).
- Lệnh offline (`manifest.sync`, `root.bootstrap`/`root.reissue`/`root.revoke`, `root.set-email` (không ghi email), `identity.enroll`, `identity.mfa-reset`, `identity.session-purge`) ghi `actor_id = PRODUCT_OFFLINE_ACTOR` (hằng duy nhất `00000000-0000-4000-8000-000000000001`); danh tính operator/approver nằm trong bản ghi approval được tham chiếu (`operationId`, `approval`). Cột `reason` chỉ do input offline đã validate của `root.revoke` và `identity.mfa-reset`.
- Event của Root có marker `principalKind = 'root'` và `outcome` (`ok`/`absent`) từ `kind` của session đã kiểm chứng, không từ payload ([ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)).
- Metadata chỉ gồm field typed của từng kind. Không đưa vào audit: token, mật khẩu, email, tiêu đề, lý do tự do, PII; event HR chỉ có id và kind (không phút, ngày, lý do, `reference`, giá trị F2). Lịch sử đổi setting nằm ở `system_setting_history` cùng transaction, không ở audit ([ADR-12](ADR-12-administration-accounts-settings-roles.md)).
- Obligation: `ProductAuthorization` nhận registry typed `Readonly<Record<string, ProductObligationHandler>>` lúc composition (bản sao đóng băng), danh sách handler cho lõi suy ra từ đúng key của registry. Thiếu handler thì planner deny; handler throw thì rollback transaction, không trả payload hay effect. `audit@1` ghi event `access.*`; API runtime và CLI sync dùng cùng registry.

### Outbox delivery

- Login `outbox` (`product_outbox`, mật khẩu `PRODUCT_OUTBOX_PASSWORD` bắt buộc khi `db:provision`) chỉ có `SELECT` trên `audit_outbox` và `UPDATE` các cột `delivered_at`, `delivery_attempts`, `lease_token`, `lease_until`, `dead_at`. Không `INSERT`/`DELETE`, không sửa nội dung event, không đọc bảng khác, không EXECUTE fence hay `resolve_session`; `verifyProductPrivileges` kiểm login này như mọi login runtime ([ADR-04](ADR-04-database-logins-acl-probes.md)). Cấp quyền đọc/ghi delivery cho login khác bị loại vì sẽ cho login đó đọc audit của mọi người.
- Partial index `(occurred_at, event_id) WHERE delivered_at IS NULL AND dead_at IS NULL` phục vụ claim.
- `claim` là một transaction ngắn (`statement_timeout` 2000 ms, `lock_timeout` 1000 ms): chọn tối đa `batchSize` event chưa giao, chưa park, không có lease còn hạn, theo `occurred_at, event_id`, `FOR UPDATE SKIP LOCKED`; gán `lease_token` mới, `lease_until`, tăng `delivery_attempts`. Mặc định/biên: `batchSize` 20 (1–100), `leaseMs` 300 000 (1000–3 600 000), `maxAttempts` 8 (1–20), `backoffMs` 1000 (1–3 600 000), `maxBackoffMs` 300 000 (từ `backoffMs` tới 86 400 000), `deliveryTimeoutMs` 10 000 (1–600 000). Tạo `ProductAuditOutbox` kiểm `leaseMs >= batchSize × deliveryTimeoutMs`.
- `ProductAuditSink.deliver` được gọi tuần tự, mỗi lần có timeout, không mở transaction và không lấy fence. `acknowledge` là transaction riêng, chỉ có hiệu lực khi `lease_token` còn khớp (ack của worker đã mất lease bị bỏ qua): thành công đặt `delivered_at`; thất bại đặt backoff `min(maxBackoffMs, backoffMs × 2^(attempts−1))` qua `lease_until`, hoặc `dead_at` khi đạt `maxAttempts` (park, không tự xóa, chờ operator).
- Attempt đếm lúc claim. Event đã dùng hết `maxAttempts` mà lease hết hạn không có ack (worker crash) bị park ở lần claim kế tiếp, nên crash lặp cũng dừng ở trạng thái park. Dòng có `safe_metadata` không phải map chuỗi phẳng không được gửi, tính là một lần thất bại (rồi park), không chặn event khác trong batch.
- Delivery là at-least-once: crash sau khi gửi và trước ack gửi lại sau khi lease hết hạn. Sink phải idempotent theo `eventId` và chỉ resolve khi đã lưu bền; không hứa exactly-once qua mạng. Thứ tự giao theo `occurred_at, event_id` chỉ trong một batch, không bảo đảm giữa các worker hay khi retry. Lỗi sink có thể chứa dữ liệu event nên không log nội dung; worker chỉ giữ kết quả retry/park.
- Không có hàng đợi recovery trong outbox: token (kích hoạt, khôi phục) không bao giờ vào `audit_outbox` dưới dạng plaintext hay digest.

## Quyết định của người dùng

- Chưa có sink thật (không provider, endpoint hay key management) và không tạo sink giả trả success; do đó worker chưa được wire vào API hay CLI và event tích lũy trong outbox. Chấp nhận, không gọi production-ready.

## Chưa làm / điều mở

- Chọn sink; khi chọn phải quyết định nơi chạy worker (process riêng hay trong API), cấu hình `PRODUCT_OUTBOX_DATABASE_URL` cho đúng process đó, vòng lặp/khoảng nghỉ, metrics hữu hạn và runbook xử lý event bị park (chưa có lệnh re-queue; xem [operations](../operations.md)).
- Retention và xóa event đã giao chưa quyết định (login `outbox` không có `DELETE`).
- `identity.invite` còn là kind di sản trong union (đã bỏ ở 0027, không còn writer). Event của các flow đã bỏ (`identity.login`, `identity.password-reset`, `identity.oidc-link`…) có thể còn trong outbox; delivery đọc `event_kind` như text nên vẫn giao, không còn writer tạo chúng.
