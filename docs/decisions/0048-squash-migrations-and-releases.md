# ADR 0048 — Gộp migration và release thành baseline

Ngày: 2026-10-29. **Trạng thái: Accepted** (người dùng duyệt ngày 2026-10-29: chỉ có database dev, được xóa và dựng lại).

Quy ước: **[Quan sát]** = đã đọc hoặc chạy trong working tree ngày 2026-10-29 (HEAD `2ff7c62` cộng thay đổi phase 1); **[Quyết định]** = chọn trong ADR này; **[Chưa làm]** = thuộc phase sau.

## 1. Bối cảnh

- **[Quan sát]** Schema được dựng bằng 36 migration: 21 migration sản phẩm (`001`–`021`, trong đó có các bước tạo rồi sửa như `authority_level` thêm ở `001` và bỏ ở `012`, `local_credential` tạo ở `001` và bỏ ở `018`), fixture `ProductDocument` và 15 migration HR (`100`–`114`). Nhiều hàm bảo vệ được tạo rồi thay thân tới 3 lần (`guard_root_lifecycle`: `012` → `015` → `016`).
- **[Quan sát]** Chỉ có database dev; không có dữ liệu cần giữ. Các nhánh chuyển dữ liệu cũ (`012` kiểm `state.sequence !== '0'`, preflight `017`/`018`, guard tenant cũ của `001`, `003`) chỉ phục vụ dữ liệu không còn tồn tại.
- **[Quan sát]** Release manifest hiện ở sequence `19`; các fixture và test upgrade (`hrm-authorization-upgrade`, `product-sign-in-migrations`) tồn tại để chứng minh đường nâng cấp qua chuỗi migration cũ.

## 2. Quyết định

1. **Hai baseline migration thay toàn bộ 36 migration cũ [Quyết định]:**
   - `apps/api/src/database/migrations/001-product-baseline.migration.ts`, `ProductBaseline1792108800001`: schema identity/authority ở dạng cuối, gồm bảng, ràng buộc, chỉ mục, view, hàm, trigger, ACL và owner.
   - `apps/api/src/database/migrations/002-application-baseline.migration.ts`, `ApplicationBaseline1792108800002`: fixture `document` và toàn bộ schema HR ở dạng cuối.
   - Id/timestamp theo mẫu hiện có (`1792108800001`, `1792108800002`). Cả hai chạy trên database rỗng và qua `db:provision`, vì đổi owner hàm sang role NOLOGIN cần membership tạm của login migration; cơ chế provisioning không đổi.
2. **Danh sách migration ở một nơi [Quyết định]:** `productMigrations` (baseline sản phẩm) và `allMigrations` (cả hai baseline) trong `helpers/product-database.helper.ts`; `tools/product.ts` và các test helper dùng `allMigrations`. Các export cần cho probe và test (`sharedFenceBody`, `resolveSessionOidcBody`, `guardRoot*Body`, `registerObjectBody`, `authorizationScopeViews`, `documentFixtureSql`, …) chuyển sang hai file baseline, giữ nguyên tên và nội dung.
3. **Luật "không sửa migration đã áp dụng" áp dụng lại từ baseline [Quyết định]:** tên class, timestamp và SQL của hai baseline không đổi; thay semantics bằng forward migration mới. Lịch sử `001`–`021`/`100`–`114` chỉ còn trong Git và trong các ADR/plan cũ (giữ nguyên làm lịch sử).
4. **Không đổi hành vi [Quyết định]:** quyền, hàm, trigger, ACL, owner, tên ràng buộc, thứ tự cột, OpenAPI và release (`sequence 19`, mọi hash) giữ nguyên trong phase 1.

## 3. Phạm vi theo phase

- **Phase 1 (đã làm, ADR này):** chỉ migration. Xóa 36 file cũ, thêm hai baseline, gom danh sách, sửa import test/probe, cập nhật `apps/api/src/database/AGENTS.md`. Release vẫn `19`.
- **Phase 2 [Đã làm 2026-10-29]:** đưa release sequence về `1`, xóa 16 fixture release cũ và các test upgrade (`hrm-authorization-upgrade`, `product-sign-in-migrations` và mọi test chỉ phục vụ đường nâng cấp), cập nhật hash/OpenAPI re-pin tương ứng. Kết quả: `product.manifest.ts` có `sequence '1'`/`predecessor '0'`, nội dung release không đổi; **hash release `d5b3cd60…da6030`, hash canonical declarations `d19084b3…c6a`, hash bindings `56561151…a837` và hash OpenAPI đều KHÔNG đổi**, vì `releaseContentHash` không gồm sequence/predecessor (kiểm bằng chạy lại, không re-pin). Đã xóa 16 fixture `test/fixtures/release-*.ts`, `hrm-authorization-upgrade.integration-spec.ts` (giữ test fact-change tách ra `hrm-authorization-facts.integration-spec.ts`; bỏ các test nâng cấp từng release và migration forward-only) và `product-sign-in-migrations.integration-spec.ts` (giữ bất biến schema cuối ở `product-sign-in-schema.integration-spec.ts`, bỏ preflight migration 017). Độ phủ reconcile: genesis, predecessor mismatch (`product-genesis`), cùng hash idempotent, `conflicting_release`, `downgrade` (thêm ở `product-genesis`). Chưa thêm dòng nào về "database dev đã có sequence 19": nó phải dựng lại ở phase 3.
- **Phase 3 [Chưa làm]:** xóa database dev hiện có và dựng lại bằng `db:provision` với hai baseline, rồi `manifest:sync`. Thao tác trên môi trường của người dùng, làm khi người dùng yêu cầu.

## 4. Những gì mất

- Đường nâng cấp từ bất kỳ database nào dựng bằng chuỗi cũ: database đó phải bỏ và dựng lại; baseline áp lên schema cũ thất bại (`CREATE TABLE` trùng) thay vì gộp ngầm, tức fail closed.
- Guard "legacy tenant schema requires explicit reviewed mapping" của `001` cũ (baseline giả định database rỗng) và các preflight dữ liệu của `003`, `012`, `017`, `018`.
- Các test chỉ chạy đường nâng cấp từng bước. Trong `product-database.integration-spec.ts` đã xóa bốn test: legacy fixture từ chối merge tenant, forward protection migration giữ hàng cũ, migration `018` preflight, version migration từ chối tuple chưa version. `hrm-authorization-upgrade.integration-spec.ts` và `product-sign-in-migrations.integration-spec.ts` import module đã xóa, nên không biên dịch được cho tới phase 2 (xóa).
- Lịch sử từng bước trong code (đọc bằng Git).

## 5. Những gì bắt buộc giữ

- Tên hàm/trigger/ràng buộc/chỉ mục mà probe `product-privilege.declarations.ts` và `permission-protection-verify.service.ts` so khớp; thân hàm trùng byte (probe so khớp bằng nội dung).
- Owner và ACL cuối của mọi hàm, view, bảng và cột; `SECURITY DEFINER` + `search_path=pg_catalog,pg_temp`; default privileges `REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`; trigger bật; `kind`, unique root, trigger bảo vệ Root/IAM.
- Thứ tự cột vật lý của từng bảng (cột thêm sau nằm cuối), để `INSERT` không liệt kê cột và `SELECT *` hành xử như cũ.
- Seed: một hàng `authz_state` (revision 1, sequence 0) và một hàng `security_bootstrap_state`.
- Quy trình provisioning (`provisionProductDatabase`) không đổi.

## 6. Cách xác minh tương đương

**[Quan sát]** Ngày 2026-10-29, trên hai cụm PostgreSQL 18.6 tạm (container riêng, đã xóa sau khi xong): database A dựng bằng 36 migration cũ qua `provisionProductDatabase`, database B bằng hai baseline qua cùng hàm. Hai bản xuất độc lập, so sánh sau khi sắp xếp:

1. Script xuất catalog (role và membership, schema/owner/ACL, default ACL, bảng, cột theo thứ tự vật lý kèm kiểu/default/generated/collation/ACL cột, ràng buộc kèm `pg_get_constraintdef`, chỉ mục, hàm kèm owner/secdef/config/ACL/thân và hash định nghĩa, trigger kèm trạng thái bật, view và tùy chọn, số hàng, dữ liệu seed): 1347 dòng mỗi bên, **diff rỗng**. Script được kiểm độ nhạy: thêm một GRANT cột và một DEFAULT vào B làm diff xuất hiện đúng hai dòng, hoàn tác thì diff về rỗng.
2. `pg_dump --schema-only` (có owner và ACL): sau khi bỏ dòng `\restrict` ngẫu nhiên và sắp xếp (thứ tự câu `GRANT` trong dump phụ thuộc thứ tự mảng ACL), **diff rỗng**.
3. Test hành vi mức repository/DB trên database dựng bằng baseline (xem báo cáo bàn giao: product-database, genesis, root-guards, mfa-guards, cli, probe HR, role-matrix, reactivate, audit, outbox, …).

Chỉ khác ở bảng lịch sử TypeORM `migrations` (tên/timestamp migration), được loại khỏi so sánh.

## 7. Rủi ro

- Hai baseline là một khối lớn khó review từng dòng; độ tin cậy dựa vào so sánh catalog và pg_dump ở §6, không dựa vào đọc lại. Thay đổi baseline sau này phải chạy lại cùng so sánh nếu mục tiêu là "không đổi hành vi".
- Phạm vi so sánh là catalog PostgreSQL; hành vi runtime khác catalog (nếu có) chỉ được bao phủ bởi test đã chạy, không bởi so sánh.
- Test dùng danh sách migration (`module-template.helper`, `hrm-authorization-stack.helper`, `product.e2e-spec`) giờ có thêm bảng `document` trong template HR vì baseline ứng dụng gồm fixture; test probe HR đã thêm grant `document` mà runtime vốn kỳ vọng.
- `dist/` cũ còn file biên dịch của migration đã xóa nếu không dọn: `tsc -b` không xóa output của source đã bị xóa, nên test có thể import nhầm file cũ. Phase 1 đã xóa thủ công các file đó khỏi `apps/api/dist`.
- Database dev hiện có (phase 3) không chạy được code mới cho tới khi dựng lại.
