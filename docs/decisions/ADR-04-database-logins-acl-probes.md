# ADR-04 — Database: login theo mục đích, ACL, hàm definer, probe và trigger bảo vệ

Thay thế các ADR cũ: 0001, 0007, 0008, 0011, 0043 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Code: `database/product-privilege.declarations.ts` (ma trận, ACL owner, hàm/trigger kỳ vọng), `database/services/product-privilege-verify.service.ts` (`verifyProductPrivileges`), `database/services/product-database-provision.service.ts`, `database/helpers/product-database.helper.ts`, `database/migrations/001-product-baseline.migration.ts` (thân hàm bảo vệ). Quy ước thao tác: `apps/api/src/database/AGENTS.md`.

## Quyết định

### Một database, login theo mục đích

- Một PostgreSQL database cho cả sản phẩm; không tenant, không database-per-tenant. `synchronize: false` ở mọi môi trường; migration độc lập với `AppModule`, không DDL khi boot.
- Bảy purpose (`ProductDatabasePurpose`): `data`, `identity`, `authority`, `sync`, `outbox` là login runtime/vận hành (`product_<purpose>`); `migration` và `bootstrap` chỉ dùng offline. API chỉ giữ bốn login `data`/`identity`/`authority`/`sync`; không giữ credential `migration`/`bootstrap` và config từ chối chúng. CLI vận hành dùng file env riêng (`.env.ops`). `outbox` chỉ cho worker giao audit ([ADR-07](ADR-07-audit-and-outbox.md)); worker chưa wire vào API hay CLI.
- Mỗi login là `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, không là thành viên role khác, không sở hữu object hay schema, không `CREATE`/`TEMP` trên database, không `CREATE` hay `USAGE WITH GRANT OPTION` trên schema, không `SET session_replication_role` (replica mode bỏ qua mọi trigger bảo vệ) và `session_replication_role = origin`. Mật khẩu login không vào log hay báo cáo.
- Ma trận ACL là hằng số `expectedPrivileges` (bảng, cột, hàm cho từng login), không viết lại ở đây. Nguyên tắc cố định:
  - `data`: chỉ SELECT bảng authority và cột `app_user(id, state, auth_epoch)`; ghi dữ liệu nghiệp vụ qua grant của module (`permissionPrivileges`), `INSERT audit_outbox`, đọc `account_directory`, EXECUTE shared fence, `resolve_session`, `provision_oidc_account`, `hr_register_object`. Không đọc email trực tiếp từ `app_user`, không ghi bảng identity, không quyền nào trên bảng `authz_state` ngoài EXECUTE hàm fence (không `UPDATE(revision)`).
  - `identity`: session, attempt OIDC, rate limit, enrollment, factor 2FA ([ADR-06](ADR-06-google-auth-sessions-2fa.md)); chỉ `INSERT` ba cột `external_identity(issuer, subject, user_id)` và không UPDATE/DELETE binding; chỉ `UPDATE(consumed_at)` của `one_time_token` (không INSERT token); `UPDATE` `app_user` chỉ `email_verified`, `state`, `auth_epoch`; `UPDATE(revision)` trên `authz_state` chỉ để mode `revoke` tăng revision.
  - `authority`: ghi (INSERT/UPDATE/DELETE) `role_definition`, `user_role`, `policy_rule`, `record_exception`, `relation_edge`, `user_relation`, `user_boundary`, `object_ref`; `UPDATE(state, auth_epoch)` của `app_user`; `UPDATE(revision)` trên `authz_state` (mode `admin` tăng revision); EXECUTE `reactivate_iam_account`, `change_iam_account_email`, `reset_iam_mfa`, `reset_iam_google_binding`. Không quyền trên bảng 2FA hay token.
  - `sync`: ghi catalog và fact code-owned, `UPDATE authz_state` (revision/hash/sequence); không quyền trên fact runtime ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)).
  - `bootstrap`: lifecycle Root, marker, phát token kích hoạt Root, xóa 2FA của Root, `UPDATE(revision)` trên `authz_state`; bị chặn bởi trigger (bên dưới).
  - `outbox`: `SELECT audit_outbox` và `UPDATE` đúng năm cột `delivered_at`, `delivery_attempts`, `lease_token`, `lease_until`, `dead_at`; không INSERT/DELETE, không sửa nội dung event, không đọc bảng khác, không EXECUTE fence/`resolve_session`.
  - Mọi login runtime chỉ có `INSERT` trên `audit_outbox`, trừ `outbox`. Thêm SELECT/UPDATE cho login khác sẽ cho nó đọc audit của mọi người dùng và sửa trạng thái delivery.
- Append-only ép bằng grant và trigger, không bằng quy ước: ledger nghiệp vụ, lịch sử lịch/kỳ chấm công và `system_setting_history` (trigger `forbid_setting_history_change`; không UPDATE/DELETE/TRUNCATE) chỉ có INSERT cho login `data`; bản ghi neo `setting_anchor`/`role_anchor` do `sync` tạo.
- Credential `identity` bị lộ vẫn tạo được session của mọi account (kể cả Root active); giữ credential `identity` là ranh giới tin cậy của toàn bộ đăng nhập. Ngăn cách login không chống code tùy ý đã nắm mọi secret của process.

### Owner NOLOGIN và hàm `SECURITY DEFINER`

- Bảy owner NOLOGIN, không là thành viên role nào, không `CREATE` trên schema: `product_fence_owner`, `product_session_owner`, `product_object_owner`, `product_account_owner` và ba owner của hàm danh tính IAM `product_email_owner`, `product_mfa_owner`, `product_binding_owner`. Hàm nhận owner tối thiểu theo trách nhiệm, `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, `REVOKE ALL FROM PUBLIC`, `EXECUTE` chỉ cho login cần dùng; default privileges `REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`.
- `authz_acquire_shared_fence(integer)` (owner fence): `FOR SHARE` trên `authz_state` nên login `data`/`identity` không cần quyền UPDATE trên fence; từ chối khi `min_runtime_capability` vượt capability của runtime (`AZ001`).
- `resolve_session(bytea)` (owner session): chỉ session OIDC còn hạn tuyệt đối, idle 30 phút, `auth_epoch` khớp, binding và provider đang bật đúng version; trả `kind` — nguồn duy nhất của `kind` cho phiên ([ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)).
- `hr_register_object(text, uuid)` (owner object): đăng ký bản ghi tự nhiên vào `object_ref`, EXECUTE cho `data`; login `data` không INSERT `object_ref` trực tiếp.
- `provision_oidc_account(uuid, text, text, uuid)` và view `account_directory` (owner account, view `security_barrier`, chỉ `kind = 'iam'`): tạo `app_user` pending và enrollment 7 ngày tại provider đang bật; không đổi tài khoản có sẵn, không gắn `sub`, không cấp quyền; email trùng là `23505` (409). Không login nào đọc email trực tiếp từ `app_user`.
- `reactivate_iam_account(uuid)` (owner account, EXECUTE chỉ `authority`): khóa hàng `FOR UPDATE`; vắng `P0002`; `kind <> 'iam'` `42501`; `state <> 'suspended'` `55000`; có binding bật tại provider bật thì `active`, ngược lại `pending`; luôn `auth_epoch + 1`; không đọc email, không tạo secret/token/enrollment. `protect_account_lifecycle` xét `current_user` nên không chặn hàm definer; `UPDATE state = 'active'` trực tiếp của `authority` vẫn `42501`. Service gọi hàm là `reactivateUser` (mode `admin`); luồng nghiệp vụ ở [ADR-12](ADR-12-administration-accounts-settings-roles.md).
- `change_iam_account_email`, `reset_iam_mfa`, `reset_iam_google_binding` ([ADR-15](ADR-15-identity-operations-by-permission.md); forward migration `IdentityOperations1792108800005`): mỗi hàm một owner riêng (ACL nhỏ nhất từng hàm: `emailOwnerAcl`, `mfaOwnerAcl`, `bindingOwnerAcl`), `kind = 'iam'` cứng, `EXECUTE` chỉ `authority`, thân ghim trong `protectionFunctions`; không tạo secret, không đọc ngoài cột cần. Đổi owner cần `db:provision` chạy lại.
- ACL của owner account là hằng `accountOwnerAcl`, của owner session là `sessionOwnerAcl`: mở rộng ACL owner phải đổi hằng và probe cùng lúc, vì mọi hàm cùng owner thừa hưởng.

### Trigger bảo vệ

- Code-owned (`managed_by = 'code'`, hoặc `seed_owner` ở `relation_edge`/`user_boundary`) được bảo vệ cả ở lệnh lẫn DB writer: `protect_product_rows` từ chối login khác `sync` đụng dòng code-owned và rule/exception tham chiếu role code-owned; `sync` bị từ chối đụng dòng không phải code-owned (không takeover). Cờ `managed_by` đơn lẻ không là enforcement.
- `protect_product_state` (marker bootstrap vĩnh viễn; `authz_state` không downgrade `revision`/`release_sequence`/`min_runtime_capability`), `protect_account_lifecycle` (identity chỉ `pending → active`; authority chỉ chuyển sang `suspended`; gỡ suspend chỉ qua `reactivate_iam_account` hoặc repair offline có duyệt), `protect_token_consumption` (token chỉ chuyển chưa dùng → đã dùng tại `statement_timestamp()`), `protect_binding_ref`, `require_email_epoch`, `protect_mfa_totp`, `mfa_epoch`, `protect_mfa_recovery_code`, và các guard Root (`guard_root_kind`, `require_root_marker_kind`, `guard_root_not_iam_subject`, `guard_root_activation`, `guard_root_lifecycle`; ngữ nghĩa ở [ADR-05](ADR-05-root-iam-boundaries-account-invariants.md), [ADR-06](ADR-06-google-auth-sessions-2fa.md)).
- Guard Root xét `session_user` (login thật), `protect_account_lifecycle` xét `current_user`; hàm definer vì thế không mượn quyền của caller. Tài khoản `iam` không bao giờ bị `bootstrap` đổi lifecycle.

### Probe khởi động và ranh giới tin cậy

- Boot gọi `verifyProductPrivileges` cho từng login có pool; mọi sai lệch là `Product privilege drift` hoặc `Product protection drift` và boot dừng, không mở listener. Probe kiểm:
  - Thuộc tính login ở trên, tên đúng `product_<purpose>`.
  - ACL bảng/cột/hàm của login trong mọi schema không hệ thống (gồm cấp qua PUBLIC) so khớp CHÍNH XÁC với `expectedPrivileges` cộng grant bảng ứng dụng khai báo thêm; thừa hay thiếu đều lỗi. Extension cấp quyền PUBLIC trong schema được quét chặn boot cho tới khi được phân loại.
  - ACL chính xác của owner session, owner account và ba owner hàm danh tính (email, mfa, binding); owner không login được, không superuser, không thành viên role khác.
  - Owner, `SECURITY DEFINER`, volatility `VOLATILE`, `search_path` và thân (`prosrc`) của mọi hàm bảo vệ so với hằng export từ baseline; thân bị thay bằng no-op hay hàm khác đều chặn boot.
  - Mọi trigger không nội bộ trên bảng được bảo vệ: function, sự kiện, cột `UPDATE OF`, không `WHEN`/argument, enabled, deferrable; trigger lạ chạy sau cũng chặn boot.
  - Định nghĩa chính xác của view `iam_account` (`security_invoker`) và `account_directory`.
- Module ứng dụng bổ sung probe của riêng nó (trigger append-only của setting history, ACL `product_object_owner`, view scope) cùng grant bảng nghiệp vụ; probe không nằm ngoài boot.
- Test privilege/protection dùng login thật trên PostgreSQL disposable, kèm ca âm tính: thiếu grant, grant thừa, thân hàm đổi, trigger tắt, `search_path` đổi, owner đổi.

### Schema và migration

- Schema dựng bởi đúng hai baseline `ProductBaseline1792108800001` (identity/authority, hàm, trigger, ACL, owner) và `ApplicationBaseline1792108800002` (fixture `document` và HR), đăng ký trong `allMigrations` (`helpers/product-database.helper.ts`) — danh sách duy nhất cho CLI và test, cùng các forward migration sau chúng (trong đó `IdentityOperations1792108800005` của ADR-15) ([ADR-14](ADR-14-baseline-migration-and-release.md)). Chạy trên database rỗng qua `db:provision`, vì đổi owner hàm sang role NOLOGIN cần membership tạm của login migration.
- Hàm/trigger/ràng buộc/chỉ mục mà probe so khớp phải giữ tên, owner, ACL và thân trùng byte với hằng export. Thay semantics chỉ bằng forward migration mới; không tự thay hàm/trigger bảo vệ để probe pass.
- Danh sách provision tạo role, bật thuộc tính và kiểm lại thuộc tính sau mỗi lần tạo/sửa; bảng chưa phân loại làm provisioning thất bại. `USAGE` schema `public` cho login do provisioning cấp.

## Quyết định của người dùng

- Role `sync` riêng cho boot/CLI sync; shared fence qua hàm `SECURITY DEFINER` thay vì cấp UPDATE cho `data`/`identity`.
- Login `outbox` riêng với ma trận hẹp thay vì mở rộng login hiện có; worker chưa wire cho tới khi chọn sink.
- Giữ credential `identity` là ranh giới tin cậy của đăng nhập; không giả vờ DB chặn được nó.

## Chưa làm / điều mở

- `pg_database`/`pg_roles` là catalog cluster; chưa đặt `CONNECTION LIMIT` theo role, chưa bật RLS. Secret source production và xoay vòng mật khẩu login thuộc vận hành.
- Role tenant/login vẫn có thể `CONNECT` database `postgres` và template nếu operator chưa `REVOKE`; provisioner chỉ sửa database của sản phẩm (`REVOKE TEMP`/`CREATE`), không sửa database dùng chung.
- Login `authority` về mặt DB vẫn ghi được `deny`, rule gắn user và `record_exception`; bề mặt này không có route và phải giữ không có (test inventory), nhưng DB không chặn. Probe không biểu diễn được grant theo dòng.
- Owner bảng vẫn có DDL; repair offline (vd. gỡ suspend Root bằng `DISABLE TRIGGER`) dựa vào hồ sơ approval, DB không chặn owner.
- Chưa có retention hay DELETE cho `audit_outbox` đã giao và `one_time_token` đã dùng/hết hạn.
- Probe chỉ phủ catalog PostgreSQL; hành vi runtime khác catalog chỉ được test đã chạy bao phủ. Chưa chạy trên cluster production.
