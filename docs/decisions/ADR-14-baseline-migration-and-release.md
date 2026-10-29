# ADR-14 — Hai baseline migration và release genesis sequence 1

Thay thế các ADR cũ: 0048 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành; ba phase gộp đã xong (2026-10-29). Code: `apps/api/src/database/migrations/{001-product-baseline,002-application-baseline}.migration.ts`, `database/helpers/product-database.helper.ts` (`productMigrations`, `allMigrations`), `authorization/product.manifest.ts`, `apps/api/src/database/AGENTS.md`.

## Quyết định

- Schema do đúng hai baseline dựng, thay 36 migration cũ (21 migration sản phẩm, fixture `ProductDocument`, 15 migration HR):
  - `001-product-baseline.migration.ts`, `ProductBaseline1792108800001`: schema identity/authority ở dạng cuối (bảng, ràng buộc, chỉ mục, view, hàm, trigger, ACL, owner).
  - `002-application-baseline.migration.ts`, `ApplicationBaseline1792108800002`: fixture `document` và toàn bộ schema HR ở dạng cuối.
  - Cả hai chạy trên database rỗng và qua `db:provision`, vì đổi owner hàm sang role NOLOGIN cần membership tạm của login migration; `db:migrate` đơn lẻ không áp dụng được baseline. Baseline không có nhánh chuyển dữ liệu cũ; baseline áp lên schema cũ thất bại (`CREATE TABLE` trùng), tức fail closed.
- Danh sách migration ở một nơi: `productMigrations` (baseline sản phẩm) và `allMigrations` (cả hai) trong `helpers/product-database.helper.ts`; CLI `tools/product.ts` và test helper dùng `allMigrations`. Các export probe và test cần (`sharedFenceBody`, `resolveSessionOidcBody`, `guardRoot*Body`, `registerObjectBody`, `authorizationScopeViews`, `documentFixtureSql`, …) nằm trong hai file baseline.
- Luật từ nay: tên class, timestamp và SQL của hai baseline và của mọi migration sau chúng không đổi; thay semantics bằng forward migration mới (timestamp lớn hơn, đặt cạnh baseline hoặc ở feature, đăng ký trong `allMigrations`). Không DDL khi boot, `synchronize: false`. Sửa baseline chỉ hợp lệ khi chưa có database nào ngoài máy dev áp dụng nó, và phải ghi ADR (quy tắc ở `apps/api/src/database/AGENTS.md`; văn bản ADR gốc chỉ nêu luật forward migration). Tới khi có database ngoài máy dev, quy tắc forward migration là mặc định.
- Release: manifest ở genesis `sequence '1'`, `predecessor '0'`. Nội dung release không đổi khi đổi sequence: hash release, hash canonical declarations, hash bindings và hash OpenAPI không đổi, vì `releaseContentHash` không gồm sequence/predecessor ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)). Không còn fixture release cũ hay test nâng cấp từng release: test nâng cấp dựng release cũ ngay trong test từ `productReleaseSource` rồi sync release mới (mẫu `product-genesis.integration-spec.ts`). Độ phủ reconcile: genesis, predecessor mismatch, cùng hash idempotent, `conflicting_release`, `downgrade`.
- Phải giữ trong baseline: tên hàm/trigger/ràng buộc/chỉ mục mà probe `product-privilege.declarations.ts` và `permission-protection-verify.service.ts` so khớp, thân hàm trùng byte (probe so khớp bằng nội dung); owner và ACL cuối của mọi hàm, view, bảng, cột; `SECURITY DEFINER` + `search_path = pg_catalog, pg_temp`; default privileges `REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`; trigger bật; `kind`, unique Root, trigger bảo vệ Root/IAM; thứ tự cột vật lý của từng bảng (cột thêm sau nằm cuối, để `INSERT` không liệt kê cột và `SELECT *` hành xử như cũ); seed một hàng `authz_state` (revision 1, sequence 0) và một hàng `security_bootstrap_state`; quy trình `provisionProductDatabase`.
- Database dev đã được xóa và dựng lại bằng `db:provision` với hai baseline rồi `manifest:sync` (phase 3); Root và dữ liệu HR phải tạo lại.

## Cách xác minh tương đương đã dùng

Trên hai cụm PostgreSQL 18.6 tạm (container riêng, đã xóa): database A dựng bằng 36 migration cũ qua `provisionProductDatabase`, database B bằng hai baseline qua cùng hàm; xuất độc lập, so sánh sau khi sắp xếp.

1. Script xuất catalog (role và membership, schema/owner/ACL, default ACL, bảng, cột theo thứ tự vật lý kèm kiểu/default/generated/collation/ACL cột, ràng buộc kèm `pg_get_constraintdef`, chỉ mục, hàm kèm owner/secdef/config/ACL/thân và hash định nghĩa, trigger kèm trạng thái bật, view và tùy chọn, số hàng, dữ liệu seed): 1347 dòng mỗi bên, diff rỗng. Độ nhạy đã kiểm: thêm một GRANT cột và một DEFAULT vào B làm diff đúng hai dòng, hoàn tác về rỗng.
2. `pg_dump --schema-only` (có owner và ACL), bỏ dòng `\restrict` ngẫu nhiên và sắp xếp (thứ tự `GRANT` phụ thuộc thứ tự mảng ACL): diff rỗng.
3. Test hành vi mức repository/DB trên database dựng bằng baseline.

Chỉ khác ở bảng lịch sử TypeORM `migrations`, được loại khỏi so sánh. Thay đổi baseline sau này mà mục tiêu là "không đổi hành vi" phải chạy lại cùng so sánh.

## Quyết định của người dùng

- Chỉ có database dev, được xóa và dựng lại (2026-10-29); không có dữ liệu cần giữ.

## Chưa làm / điều mở

- Mất đường nâng cấp từ database dựng bằng chuỗi cũ (bỏ và dựng lại), guard tenant cũ và các preflight dữ liệu cũ, các test chỉ chạy đường nâng cấp từng bước; lịch sử từng bước chỉ còn trong Git.
- Hai baseline là khối lớn khó review từng dòng; độ tin cậy dựa vào so sánh catalog và `pg_dump`, không dựa vào đọc lại. So sánh chỉ bao phủ catalog PostgreSQL; hành vi runtime khác catalog chỉ được test đã chạy bao phủ.
- Template HR của test có thêm bảng `document` vì baseline ứng dụng gồm fixture; test probe HR thêm grant `document`.
- `dist/` còn file biên dịch của migration đã xóa nếu không dọn (`tsc -b` không xóa output của source đã xóa), test có thể import nhầm: dọn `apps/api/dist` khi đổi tập migration.
