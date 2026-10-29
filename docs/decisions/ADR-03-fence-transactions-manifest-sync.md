# ADR-03 — Application fence, giao dịch, thứ tự khóa và đồng bộ manifest

Thay thế các ADR cũ: 0004, 0007, 0008, 0010, 0017 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Code: `database/product-transaction.runner.ts` (`ProductTransactionRunner`), `authorization/services/product-manifest.service.ts` (`ProductManifestReconciler`), `authorization/repositories/product-manifest-*.repository.ts`, `protected-state.repository.ts`.

## Quyết định

### Application fence và runner

- Một fence `authz_state` cho cả ứng dụng, READ COMMITTED, fence là statement đầu tiên rồi mới đọc session và facts ở statement sau. Mode `read`, `write`, `identity` lấy shared fence qua hàm `SECURITY DEFINER` (không nâng shared thành exclusive); `revoke`, `admin`, `sync`, `bootstrap` lấy `FOR UPDATE` và tăng `revision` cùng transaction (reconciler tự tăng khi `sync` có thay đổi). Mỗi mode ứng với đúng một login ([ADR-04](ADR-04-database-logins-acl-probes.md)): `read`/`write` = `data`; `identity` và `revoke` = `identity` (`revoke` lấy fence độc quyền); `admin` = `authority`; `sync` = `sync`; `bootstrap` = `bootstrap`.
- Facts bảo mật đổi (role, grant, boundary, suspend, revoke, bootstrap) phải lấy exclusive fence, kiểm affected set rồi tăng revision; không báo revoke thành công trước commit. Đọc/ghi dữ liệu giữ shared fence.
- Timeout đặt bằng `set_config(..., true)` trong transaction: `statement_timeout`/`transaction_timeout` 3000 ms (trần hard của runner, không tăng cấu hình vượt), `lock_timeout` 1000 ms (cũng là trần cứng, `Math.min`). Retry toàn transaction tối đa 2 lần (trần cứng) cho `40P01`/`40001`/`55P03` có jitter, rồi `TransactionConflictError` (409). Timeout, mất kết nối, thiếu fence: `AuthorityUnavailableError` (503), không retry. Tổng thời gian request bị chặn 5 giây.
- Thời lượng (deadline, metrics) đo bằng `performance.now()`; không dùng để quyết định hiệu lực ([ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)).
- Mọi mode so `min_runtime_capability` của fence với `RUNTIME_CAPABILITY` của runtime; vượt thì không retry (mode shared: hàm fence ném `AZ001`; mode exclusive: runner ném `runtime_incompatible`, cả hai là `AuthorityUnavailableError`).
- Thứ tự khóa toàn hệ thống: advisory key (chỉ limiter đăng nhập, `options.serialize`, lấy trước fence nên người chờ không giữ share fence) → fence → facts → khóa nghiệp vụ ([ADR-09](ADR-09-requests-leave-attendance-idempotency.md)). Revoke/admin/sync/bootstrap không lấy advisory lock nên không có chu trình. Người chờ advisory vẫn giữ một connection của pool `identity`, nên đợt đăng nhập lớn hơn pool làm revoke chờ ở bước lấy connection; metric `lock_wait` tính cả thời gian chờ advisory lẫn fence.
- Không giữ fence hay transaction qua network, delivery hoặc hash CPU nặng; làm ngoài lock rồi recheck version. Không mutex trong memory, không cache quyền, không chia fence theo module khi chưa có số đo chứng minh cần; không tăng deadline để che contention.
- Side effect cần durability đi qua outbox trong transaction ([ADR-07](ADR-07-audit-and-outbox.md)); attempt bị rollback không để lại dấu. `fulfillObligations` chạy trong transaction trước khi trả payload; thiếu/lỗi handler thì rollback.
- Metrics hữu hạn theo metric/mode (`pool_wait`, `lock_wait`, `lock_hold`, `transaction`, `revoke_commit`, `retry`, `timeout`, `deadlock`); không user/record ID làm nhãn.

### Manifest sync

- `createProductRelease(core)` ghép declarations của các module ([ADR-01](ADR-01-workspace-modules-conventions.md)); `prepareProductRelease` kiểm chứng và đóng băng trước khi lấy khóa (giới hạn kích thước, tham chiếu, kiểu), hash SHA-256 nội dung canonical. `reconcile` chỉ nhận object từ `prepareProductRelease`; capability (validator/handler) thiếu thì từ chối trước transaction. Hash release không gồm `sequence`/`predecessor`.
- Protocol (kết quả `reject`): cùng sequence + cùng hash thì kiểm readiness và no-op (`not_ready` nếu code-owned facts lệch); cùng sequence khác hash: `conflicting_release`; sequence cũ hơn: `downgrade` (không ghi); predecessor sai: `predecessor_mismatch`. Genesis: nhận release bất kỳ khi `release_sequence = 0` và catalog code-owned rỗng (cùng bảng/predicate với `protectedStateHash`); mọi trường hợp khác giữ predecessor nghiêm ngặt. Release hiện tại: `sequence '1'`, `predecessor '0'`.
- Release mới áp trong một transaction exclusive: resource types, policies (version bất biến), templates, relation definitions, catalog (permission mới, chuyển binding; permission biến mất thành `deprecated`), code roles, default grants (chỉ cho permission vừa tạo, id xác định), boundary definitions và seed, seeds, removal tường minh, rồi fence (revision+1, hash, sequence) và audit. Thay nội dung cần `previousHash`, xóa cần `expectedHash`; omission không revoke. Role runtime trùng key role của release: `collision`, rollback.
- Sync không ghi đè fact runtime (assignment, tuple, binding, role/rule `runtime`) và không takeover; `sync` không có quyền trên các bảng đó. `materialized_hash` bao phủ toàn bộ code-owned facts (`ProtectedStateRepository`, chỉ dòng `managed_by = 'code'`); role/grant runtime không đổi hash. Drift chặn cả release cùng sequence lẫn release mới; sửa bằng repair offline có approval/audit rồi release sửa chữa, không nhận drift làm baseline mới.
- Boot ([architecture](../architecture.md) §7): `ProductRuntime.create` → route inventory → probe privilege/protection → sync manifest → sync provider OIDC → kiểm bảng domain → `markReady()` → `listen`. Bước nào lỗi thì not ready, không mở listener; lỗi sync/config/privilege không fallback allow. Migration schema không chạy ngầm; boot chỉ sync DML có version/hash, idempotent, hoàn tất trước readiness và worker.
- CLI `manifest:sync` dùng cùng release và login `sync`. Không rollback bằng binary hay manifest cũ; đi tới bằng release tiến.
- Anchor singleton của resource không có bản ghi tự nhiên (`hrCompany`, `workCalendar`, `setting`, `role`) do login `sync` tạo idempotent ngay sau reconcile (boot và CLI `sync`), không trong migration.

## Quyết định của người dùng

- Giữ MỘT application fence cho tới khi có số đo cho thấy cần chia; sync dùng credential `sync` riêng.
- Contention trên shared fence do đọc chồng nhau liên tục có thể làm revoke chờ; chấp nhận, chưa có tải thật.

## Chưa làm / điều mở

- Chữ ký release: "verified" hiện nghĩa là mã do deploy cung cấp qua `prepareProductRelease`.
- Chưa chứng minh hình thức không-chu-trình của thứ tự khóa HR; chưa đo lock wait trên workload thật.
- Giảm số câu lệnh `permitsMany` bằng cách gộp facts ([ADR-11](ADR-11-http-api-errors-openapi-web.md)) hoãn: đổi cách lập snapshot nên đổi ngữ nghĩa quyết định.
