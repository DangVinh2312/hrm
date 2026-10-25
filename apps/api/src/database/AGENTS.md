# Database

Đọc root và `apps/api/AGENTS.md`. Module này giữ fixed-purpose transactions, DB configuration/probes và product migrations; không phải package adapter hoặc generic repository framework.

- `product-transaction.runner.ts`: READ COMMITTED, fence trước facts, retry/deadline hữu hạn, shared cho read/write/identity; exclusive cho facts mutation/sync. Không nâng shared thành exclusive.
- `helpers/transaction-errors.helper.ts`: class lỗi và runtime capability của product runner; giữ một class identity để filter/retry nhận đúng lỗi.
- `helpers/product-database.helper.ts`: phần đồng bộ (purposes, function owners, `productMigrations`, `productDataSourceOptions`, `grantsOf`). `product-privilege.declarations.ts`: credential matrix, ACL/view/trigger/function kỳ vọng. `services/product-database-provision.service.ts`: provisioning offline. `services/product-privilege-verify.service.ts`: exact privilege/protection probes. HTTP runtime chỉ dùng verify; provisioning/options/migration registry chỉ apps/api/tools/tests dùng. Helper không dùng async/await/Promise (ADR 0033, 2026-10-23; ESLint `no-restricted-syntax` trong `apps/api/eslint.config.js`, kiểm bởi `apps/api/test/helper-sync.spec.ts`).
- `migrations/`: migration class names/timestamps/SQL đã áp dụng không được đổi. Chỉ forward migration khi thay semantics; không chạy DDL trong boot, `synchronize: false`.
- Migration `021` (ADR 0043): hàm `reactivate_iam_account` (owner `product_account_owner`, EXECUTE chỉ `authority`); `protect_account_lifecycle` không đổi vì xét `current_user`. Mở rộng ACL owner phải đổi `accountOwnerAcl` và probe cùng lúc.
- Migration module `113` (ADR 0045): `setting_anchor`, `system_setting`, `system_setting_history`; `product_data` không có DELETE trên setting và chỉ SELECT/INSERT trên history, trigger `forbid_setting_history_change` chặn UPDATE/DELETE/TRUNCATE; grant nằm ở `permissionPrivileges` (`permission-database.helper.ts`), probe `verifySettingSchema` đòi trigger bật.
- Một database, credentials data/identity/authority/sync/migration/bootstrap riêng. API không giữ migration/bootstrap credentials; không fallback pool khi thiếu capability.
- Chỉ dùng transaction manager truyền vào; identifiers từ registered binding, giá trị parameterized. Không dump SQL binds, URLs hoặc raw DB errors.
- Privilege/protection tests dùng credential thật và PostgreSQL disposable: kiểm owner/ACL, SECURITY DEFINER/search_path/body, trigger enabled/binding, CREATE/TEMP/grant option; không hardcode tổng trigger thay kiểm từng bảo vệ.
- Migrations ứng dụng ở feature tương ứng, đăng ký riêng trong `apps/api/tools/product.ts`; không tự thay protected functions/triggers để làm probe pass.
- ADR 0014 đã bỏ tenant/identity schema cũ; product migrations ở đây vẫn là đường dựng schema hiện tại.

Tests: `apps/api/test/product-database.integration-spec.ts`, `apps/api/test/product-genesis.integration-spec.ts`, `apps/api/test/product-root-guards.integration-spec.ts`, cùng các suite locks/fence/privileges thực tế. Cần Docker; không SQLite hoặc database thật của người dùng.
