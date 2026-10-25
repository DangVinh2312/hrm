# ADR 0046 — Đợt 3b phần 1: so sánh tập grant, bất biến (d) cho khóa/khôi phục, ma trận role (chỉ đọc) và trần probe menu

Ngày: 2026-10-25. **Trạng thái: Accepted** theo [ADR 0041](0041-administration-settings-roles-accounts.md) (đã duyệt 2026-10-24); văn bản này ghi quyết định triển khai **phần 1** của đợt 3b. Release `19`, migration module `114`. **Chưa có** tạo/sửa role runtime, gán/thu hồi role, binding boundary qua UI (phần 2, T3b.3–T3b.6). Giữ [ADR 0012](0012-iam-root-separation.md), [ADR 0017](0017-hrm-transaction-lock-idempotency.md), [ADR 0022](0022-root-step-up-and-time-source.md), [ADR 0043](0043-account-reactivate-definer.md) (giới hạn đã biết (d) được xử lý ở đây), [permission boundaries](../permission-boundaries.md).

Mục "Quyết định tự chọn" liệt kê những chỗ ADR 0041 không quy định đủ; người dùng có thể đổi.

## 1. Kiểm giả định (T3b.1) — đã chạy trên PostgreSQL 18.6 thật

Test: `apps/api/test/hrm-role-runtime-assumptions.integration-spec.ts` (3 test, pass ở lần chạy đầu — là kiểm chứng, không có "đỏ trước").

- **Dữ liệu hiện có thỏa CHECK `custom.` ⇔ `managed_by='runtime'`**: sau provision + sync release, mọi `role_definition` đều `code`, không key nào bắt đầu `custom.`, không `policy_rule` runtime nào. Điều kiện của CHECK tương lai (`substring(role_key FROM 1 FOR 7) = convert_to('custom.','UTF8')` ⇔ `runtime`) cho 0 vi phạm. **Lưu ý cho phần 2:** test cũ `product-database.integration-spec.ts` (nâng cấp "forward protection migration preserves preexisting product fixture rows") chèn một role `runtime` tên `retained` không có tiền tố `custom.` trước khi nâng cấp; một CHECK mới phải tôn trọng dữ liệu kiểu đó (ví dụ `NOT VALID` kèm kiểm tay, hoặc đổi fixture có chủ ý) — quyết định ở migration của phần 2.
- **`authority_level` đã bỏ** (migration `012`): `role_definition` chỉ còn `role_key`, `managed_by`, `label`; login `authority` chèn được role runtime không cần cột đó; `sync` bị từ chối (`42501`) khi chèn role runtime.
- **Sync/drift không đổi `materialized_hash` khi có role runtime** (khả thi, test đầy đủ ở phần 2): tạo role runtime kèm rule và người giữ → `ProtectedStateRepository.hash` và `authz_state.materialized_hash` giữ nguyên, `reconcile` cùng release trả `changed=false` (không `not_ready`/drift); rule runtime gắn vào role `code` bị `protect_product_rows` từ chối.
- **Nơi đọc role/rule vào hash**: chỉ `ProtectedStateRepository` (`codeOwned`: `role_definition`/`policy_rule` với `managed_by='code'`). Các chỗ khác đọc hai bảng không băm: `readAuthority` (facts mỗi request), `ProductManifestVerifyRepository` (`SELECT 1 … managed_by='code'`), `ProductManifestSeedRepository` (INSERT/UPDATE code), migration `012`. (Đã `rg` toàn `src/` và `tools/`.)

## 2. Helper thuần `authorization/helpers/grant-set.helper.ts`

Đồng bộ, không SQL (kiểm bởi `helper-sync.spec.ts`). Grant = bộ `(permission, template.key, template.version, parameters)`; hai grant bằng nhau chỉ khi cả bộ bằng nhau (`canonicalJson`, nên thứ tự khóa không đổi kết quả; `"true"` ≠ `true`).

- `compareGrantSets(target, actor)` → `within` | `larger` (đích có permission actor không có) | `incomparable` (cùng permission, khác template/version/parameters) | `unprovable` (có `deny` hoặc rule gắn thẳng user ở **một trong hai** phía).
- `targetAccess(actor, target)`: Root → `proceed` luôn (không cần facts, kể cả đích có deny); IAM → `proceed` chỉ khi `within`, ngược lại `not_found`.
- Test `apps/api/test/grant-set.spec.ts` (8): tập con/bằng/rỗng, thứ tự và trùng lặp, mỗi loại không so sánh được, deny/rule user hai phía, Root, và một property-style (400 vòng, seed cố định) chứng minh `within` ⇔ bao hàm tập trên miền 18 grant.

## 3. Bất biến (d) cho `account.suspend` và `account.reactivate` (ADR 0043 buộc làm trước UI gán role)

- `GrantFactsRepository.read(manager, userIds)` (`authorization/repositories/grant-facts.repository.ts`): **một** câu `SELECT` trả rule của mọi role người dùng giữ (join `user_role`/`policy_rule`) hợp với rule gắn thẳng user, cho actor và đích cùng lúc. Không N+1 (test đếm câu lệnh = 1), không cache.
- `ProductAuthorization.targetWithinActor` gọi nó **trong giao dịch `admin`** (fence độc quyền: mọi thay đổi facts quyền cũng cần fence độc quyền nên không thể đổi giữa lúc đọc và ghi), không network. Thứ tự: tra đích qua `account_directory` (Root/vắng → `false`) → tự tác động `403` → **(d)**: không `within` ⇒ `false` (controller trả `404`, cùng câu trả lời với tài khoản vắng) → mới tới trạng thái/ghi. Với `reactivate`, (d) đứng **trước** kiểm trạng thái (409) nên tài khoản lớn hơn không lộ trạng thái khóa.
- Root actor bỏ qua (không đọc facts). Cùng tập thì cho phép.
- Test: `apps/api/test/product-account-grant-scope.integration-spec.ts` (14; PostgreSQL thật, mức service). Đỏ trước: chạy lần đầu với repository nhưng **chưa nối** (d) → 7/14 đỏ đúng ca từ chối (đích có grant ngoài tập, khác template/parameters, deny/rule user ở đích/actor, và 409-so-với-404 của reactivate), các ca cho phép và Root xanh. Mutation (hoàn nguyên): bỏ kiểm (d) của `suspendUser` → 3 test suspend đỏ; bỏ của `reactivateUser` → 4 test reactivate đỏ, đúng ca.
- **Hệ quả cho fixture cũ:** actor IAM có rule **gắn thẳng user** nay bị coi là không chứng minh được ⇒ mọi đích `404`. Ba test cũ cấp quyền bằng rule user (`product-root-suspend`, `product-account-reactivate`, `product-audit`) chuyển sang cấp qua một role runtime (`grantViaRole` trong `product-root-stack.helper.ts`); không đổi nội dung kiểm.
- Giới hạn (giữ nguyên ý ADR 0041 §2): so sánh chỉ theo grant `allow` của role, **không** tính `record_exception` hay binding boundary; (d) là mã trong giao dịch, không phải ràng buộc DB.

## 4. Ma trận role chỉ đọc

- **Resource `role`** (singleton, giống `setting`): bảng `role_anchor` (migration module `114`, `HrmRole1792108800114`; `product_data` SELECT, `product_sync` SELECT/INSERT; `ensureRole` ở boot và ở `tools/product.ts sync`, `ROLE_ID` = `…0c04`). Action `role.read` (`hrRead`, `boundary: 'optional'`), một template `role`, một grant mặc định cho role quản trị (`PermissionRole.Admin`, dữ liệu khai báo, không tên role trong mã kiểm quyền). Action `account.readPermissions` trên resource `account` (policy `auditedRead@1`, `boundary: 'optional'`, **không** grant mặc định như `account.read`); binding `account_directory` nên Root/vắng/không thấy đều `404`.
- **Route** (`modules/role/`): `GET /api/administration/roles` (`role.read`) và `GET /api/administration/accounts/:id/permissions` (`account.readPermissions`; id không chuẩn → 400 trước mọi giao dịch). Không có route ghi. Không key `error.*` mới.
- **Response chỉ field cần:** mỗi role `{ key, label, source: 'code'|'runtime', holders, grants[{ permission, effect, template, version, parameters }] }` (không id/email tài khoản nào); chi tiết tài khoản `{ roles[{ key, label, source }], grants[… , source: 'role'|'user'] }` (rule gắn thẳng user hiện nguyên văn để giải thích vì sao phép so sánh từ chối). Giới hạn cứng: 200 role, 500 rule mỗi role, 200 role mỗi tài khoản (shortcut ghi trong mã, trên xa giới hạn 100/300 của ADR 0041 §3).
- **Nguồn dữ liệu (quyết định tự chọn):** role `code` và `runtime` cùng đọc từ DB một câu `SELECT`, thay vì role `code` từ `createProductRelease`. Lý do: hàng `code` trong DB được boot xác nhận khớp release (`verifyApplied` + drift hash) và đọc một nguồn tránh lệch giữa hai snapshot; `source` lấy từ `managed_by`.
- **Audit:** `role.read` dùng `hrRead` (không obligation) nên IAM không có sự kiện `access.*` (như các đọc HR khác); Root luôn có `access.role.read`. `account.readPermissions`: IAM có `access.readPermissions` (obligation `audit@1`), Root có `access.account.readPermissions` kèm khóa đích.
- **Release 19:** hash `d5ebcd88…` → `d5b3cd60fac120749dbe66b7130325b6504e28a9cab4846efa98af998dda6030` (resource `role`, template, action, một grant; canonical declarations `449512c1…` → `d19084b3…`), bindings `c9de15a5…` → `565611517e3d…a7a837` (một binding mới, cuối danh sách), OpenAPI `1af9934e…` → `2fdf1d7054b19c70b4631cfe0d60b3469514d28363b8bc6f77391e3e254ff5b3` (hai route mới + `roles` trong ví dụ `/api/auth/me`). Fixture `test/fixtures/release-eighteen.ts` dựng lại đúng hash release 18 `d5ebcd88…` (test `system-release.spec.ts`); `release-seventeen.ts` nay chain từ eighteen. Nâng cấp 18 → 19 ở `hrm-authorization-upgrade.integration-spec.ts`: catalog +2 permission, +1 grant, grant cũ và role runtime tạo trước đó không đổi, `materialized_hash` đổi (code-owned mới), sync lặp không đổi, bản 18 không hạ cấp được.
- **Migration 114 vs CHECK (quyết định tự chọn):** ADR 0041 §3 dành số `114` cho ràng buộc role runtime. Resource mới cần một bảng neo nên `114` dùng cho `role_anchor`; CHECK (`custom.` ⇔ `runtime`, `effect='allow'`, rule không gắn user cho runtime) chuyển sang migration `115` ở phần 2.
- Test: `apps/api/test/hrm-role-matrix.integration-spec.ts` (5; PostgreSQL thật, mức service): Admin thấy đủ role/holders/source/grant, field allowlist, COO/nhân viên/không vai trò `undefined` (404); thu quyền có hiệu lực ở lần gọi sau; Root + sự kiện Root; chi tiết tài khoản (role + rule user, Root/vắng/không quyền → 404, id lạ 400); audit IAM và Root. Mutation (hoàn nguyên): bỏ kiểm quyền (`#reaches`) của `role.read` → 2 đỏ; bỏ lọc `account_directory` → 2 đỏ. **Các test ma trận được viết sau khi mã đã có** (ngoài cặp pin hash/route/keys của `structure`/`system-release`/`authorization-keys` đã đỏ trước khi cập nhật); độ nhạy được kiểm bằng mutation ở trên.

## 5. Menu `roles` và trần `MAX_PERMIT_PROBES` (Q17: đo trước khi nâng)

Probe `role.read` nằm trong **cùng lượt `permitsMany`** của `EmployeeService.menus`. Tài khoản có hồ sơ liên kết nay hỏi **17 cặp** (11 menu HR tính phẳng, `account.read`, `setting.read`, `role.read`, 3 cặp của hồ sơ riêng) > 16, nên phải nâng trần.

**Phép đo** (`apps/api/test/hrm-permits-many-measure.integration-spec.ts`, tắt trừ khi `HRM_PERMITS_MEASURE=1`, không assert thời gian). Môi trường: macOS Darwin 25.6, 8 CPU, 16 GB, Node v24.20.0, PostgreSQL 18.6 (Debian) trong container testcontainers riêng cùng máy với client; load trung bình 4–7 trong lúc đo (máy không nhàn rỗi). Cùng workload: một IAM có role quản trị gọi `permitsMany` với N cặp lặp lại các cặp menu thật, mỗi cỡ chạy xen kẽ (xoay thứ tự mỗi vòng) sau 3 vòng làm nóng, 30 lần mỗi cỡ (lần ghi cuối 50 lần cho 16 vs 17). Hai bộ dữ liệu: _release_ (2 tài khoản, 4 role, 71 rule, 49 permission) và _lớn_ (5002 tài khoản, 104 role, 4971 rule, mỗi tài khoản một role; tài khoản đo giữ nguyên role release). Số câu lệnh = lời gọi `tx.manager.query` trong giao dịch (BEGIN/fence/COMMIT của runner là hằng).

| N cặp | câu lệnh | trung vị ms (release) | p95 ms (release) | trung vị ms (lớn) | p95 ms (lớn) |
| ----- | -------- | --------------------- | ---------------- | ----------------- | ------------ |
| 8     | 17       | 36,5                  | 44,2             | 41,4              | 49,5         |
| 16    | 33       | 66,8                  | 82,4             | 70,9              | 88,2         |
| 17    | 35       | 72,1                  | 81,5             | 74,1              | 95,5         |
| 18    | 37       | 74,6                  | 90,3             | 80,1              | 98,9         |
| 24    | 49       | 96,6                  | 138,2            | 103,3             | 121,4        |

Lần đo 50 vòng riêng cho 16 vs 17 (trần đã nâng): trung vị 68,0 vs 70,3 ms (release) và 71,4 vs 75,8 ms (lớn); p95 85,4 vs 85,3 và 86,3 vs 99,3 ms.

Kết luận (chỉ mô tả, **không phải SLO**): chi phí tuyến tính, đúng 2 câu lệnh mỗi cặp (+1 cho session), khoảng 3,8–3,9 ms mỗi cặp ở máy này; không bất thường, không phụ thuộc kích thước dữ liệu ở cỡ đo (mọi tra cứu theo user). 17 cặp ≈ 72–76 ms, tức vài phần trăm của hạn 3 s của runner; chênh 16→17 nằm trong nhiễu đo (±5 ms). Một lần đo đầu bị bỏ vì lỗi fixture của chính phép đo (tài khoản đo nhận role hàng loạt có template sai resource nên planner từ chối và bỏ `EXISTS`); đã sửa và đo lại.

**Quyết định:** nâng `MAX_PERMIT_PROBES` 16 → **17** (mức tối thiểu cần; không 18/24 dù đã đo). Ghim: `hrm-permits-many.integration-spec.ts` (17 cho phép, 18 từ chối trước mọi giao dịch, nhóm any-of tính phẳng 2+7+8 = 17), `hrm-menu-role.integration-spec.ts` (tài khoản liên kết đủ menu: đúng một lượt `permitsMany`, 2 giao dịch gồm đọc hồ sơ; `MAX_PERMIT_PROBES === 17`), `hrm-menu-setting` đổi 16 → 17. Mutation: trần 16 làm test menu đỏ; trần 18 làm hai test cận trên đỏ.

**Hoãn (option A "gộp facts"):** đọc facts một lần cho nhiều permission rồi plan từng cặp trong bộ nhớ sẽ giảm ~nửa số câu lệnh, nhưng đổi cách `readAuthority` lập snapshot (một permission mỗi câu, `boundaries`/`rules` lọc theo permission) và `renew` của cửa sổ 2 s mỗi cặp, tức là đổi ngữ nghĩa quyết định; không nhỏ và không chứng minh an toàn trong phần này. Làm khi cần quá ~24 cặp hoặc p95 đo được chạm một phần đáng kể của hạn runner.

## 6. Web (chỉ xem)

`features/administration/`: trang `/roles` (`role.page.tsx`; menu `roles`; mỗi role một `section` có tên, nguồn, "Người giữ: n", quyền nhóm theo resource bằng nhãn `action · template`, "từ chối" và "gắn trực tiếp" bằng chữ), nút "Xem quyền" ở mỗi hàng `/accounts` mở hộp thoại đọc `GET …/permissions` **theo yêu cầu** (không N+1 cho cả danh sách). **Không thêm cột vai trò** vào bảng tài khoản: nó cần một lời gọi mỗi hàng hoặc đổi view `account_directory` (đang bị probe ghim); chi tiết theo nhu cầu thay thế. `menuSchema` thêm `roles` (`.max(11)`), i18n `vi`/`en` đồng bộ, một `h1`, không có ô nhập/nút ghi ở trang `/roles`. Không đổi quyền ở client: API quyết định.

## 7. Chưa làm (phần 2) và rủi ro

- **Nút "Xem quyền"** hiện cho mọi người thấy `/accounts` nhưng trả 404 nếu thiếu `account.readPermissions` (chấp nhận; ẩn theo menu ở phần sau).
- **Giới hạn đọc:** `GrantFactsRepository.read` có trần 20000 dòng và báo `truncated`; (d) coi bị cắt là không chứng minh được (404), test với 20001 rule dùng chung. Route chi tiết tài khoản cắt ở 5000 rule, ma trận ở 200 role/500 rule mỗi role, hiện chưa báo cắt.
- Phần 2 bắt buộc: `role.read`/`account.readPermissions` phải báo `truncated` hoặc từ chối khi vượt 200/500 (không cắt âm thầm); `accountPermissions` đọc roles và grants trong cùng một câu/snapshot.

- Chưa làm: T3b.3 (tạo/sửa/xóa role runtime, gán/thu hồi, giới hạn 100/300, 409 khi còn người giữ, collision release/`custom.`, hash không đổi dưới sync), T3b.4 (binding), T3b.5 (mutation (a)(b)(c)(e) ngoài (d) đã làm cho khóa/khôi phục), T3b.6 phần ghi, migration `115`, `prepareProductRelease` từ chối tiền tố `custom.`, cảnh báo cặp `hrCompany.approvals` + `workRequest.decideFinal` (ADR 0044).
- (d) bảo thủ: nhiều từ chối giả (khác template/parameters, mọi rule gắn user). Một người ngang quyền vẫn tác động lẫn nhau (bỏ R6, đã chấp nhận ở ADR 0041).
- `authority` về mặt DB vẫn ghi được `deny`/rule theo user (không có route); (d) coi chúng là không chứng minh được thay vì chặn.
- Ma trận lộ cấu trúc quyền cho người có `role.read`/`account.readPermissions` (cấu hình, không PII); mặc định chỉ role quản trị có `role.read`, không ai có `account.readPermissions` ngoài Root và grant runtime.
- Các test integration chạy từng file trên PostgreSQL thật qua service; chưa chạy HTTP/e2e/Playwright/`test:workspace`/toàn bộ `test:unit`/`test:integration`.
