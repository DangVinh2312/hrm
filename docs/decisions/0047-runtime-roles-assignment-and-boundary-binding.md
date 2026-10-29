# ADR 0047 — Đợt 3b phần 2: role runtime (tạo/sửa/xóa), gán/thu hồi role, binding gói boundary

Ngày: 2026-10-29. **Trạng thái: Accepted (4 quyết định do người dùng chốt; 10 mặc định có thể đổi trước khi đợt tương ứng được triển khai)** — xem §13 (quyết định của người dùng 2026-10-29: Q1, Q3, Q7+Q8, Q9) và §13b (mặc định áp dụng, chờ phản đối: Q2, Q4–Q6, Q10–Q15). Văn bản này chỉ là thiết kế; chưa có code, release, migration nào của phần 2, và chưa sửa `AGENTS.md`/ADR 0041 (việc đó thuộc đợt D7/D0). Triển khai **phần 2** của đợt 3b trong [ADR 0041](0041-administration-settings-roles-accounts.md) §2–§4 (đã Accepted) và đóng các mục "Chưa làm" của [ADR 0046](0046-role-matrix-and-grant-set-invariant.md) §7 (phần 1 đã xong). Giữ [ADR 0012](0012-iam-root-separation.md), [ADR 0017](0017-hrm-transaction-lock-idempotency.md), [ADR 0022](0022-root-step-up-and-time-source.md), [ADR 0043](0043-account-reactivate-definer.md), [ADR 0044](0044-coo-self-approval-by-permission.md), [permission boundaries](../permission-boundaries.md). Không thay quyết định nào đã Accepted; chỗ nào đề xuất lệch chữ của ADR 0041 thì ghi rõ là "lệch" và đưa vào câu hỏi mở.

Quy ước: **[Quan sát]** = đã đọc trong working tree ngày 2026-10-29 (HEAD `ee7c012`) bằng `rg`/đọc file; **[Đề xuất]** = thiết kế chưa có trong code; **[Chưa kiểm]** = giả định. Chưa chạy test, lint, typecheck hay DB nào cho ADR này.

## 1. Hiện trạng đã quan sát

- **Chỉ đọc.** `modules/role/` chỉ có `role.read` và `account.readPermissions`; `role.declarations.ts` khai báo đúng một action; không có route ghi (`role.controller.ts`: hai `@Get`). Bảng `role_anchor` (migration module `114`) là bản ghi neo của `role.*`.
- **Quyền DB đã đủ cho ghi.** Login `authority` có `INSERT/UPDATE/DELETE` trên `role_definition`, `user_role`, `policy_rule`, `user_boundary` (`database/product-privilege.declarations.ts`). FK của `policy_rule` (`fk_rule_permission`, `fk_rule_template`) buộc `(permission, template)` có trong catalog nhưng **không** kiểm template cùng resource với permission; FK `fk_member_boundary_entry` buộc binding trỏ đúng `(boundary, version, permission)` có entry (`001-initial.migration.ts`). `protect_product_rows` (`productRowsIamBody`, migration `012`) từ chối login khác `sync` đụng dòng `managed_by='code'` và rule tham chiếu role `code`. `role_definition` chỉ có `role_key`, `managed_by`, `label` (không cột version). `record_exception` cũng có `role_key`.
- **Hash không đổi dưới ghi runtime** (ADR 0046 §1, `hrm-role-runtime-assumptions.integration-spec.ts`): `ProtectedStateRepository` chỉ băm dòng `code`.
- **Không boundary nào hiện phủ `account.*`.** `account.provision/suspend/reactivate` là `boundary: 'required'` nhưng `accountDeclarations.boundaries` là `[]`; `hrAdministration@1` chỉ có `team.assign` và `employee.linkAccount` (`modules/permission/permission.declarations.ts`). Hệ quả quan sát được: hiện chỉ Root dùng được ba action đó qua HTTP; test stack tự khai `accountAll`.
- **Catalog hiện tại** (đọc từ `dist/`, có thể lệch `src/` nếu chưa build lại — **[Chưa kiểm]**): release `sequence: '19'` (`authorization/product.manifest.ts`), 49 permission, 22 template, **không template nào có tham số**, 71 grant mặc định (57 cặp `(permission, template)` khác nhau), 127 cặp cùng resource có thể ghép, **không rule `deny` nào trong release**, 6 permission không có grant mặc định (`account.provision|reactivate|read|readPermissions|suspend`, `document.update`), resource `document` (fixture ADR 0032) vẫn nằm trong catalog.
- **Mẫu lệnh trên tài khoản.** `execute` không khóa được hàng qua view `account_directory` (ADR 0043), nên `suspendUser`/`reactivateUser` là method riêng dùng `access()` (private) trong `authorization/services/product-authority.service.ts` (920 dòng, thuộc danh sách ngoại lệ `max-lines` tạm; ADR 0033 yêu cầu tách khi chạm tới). Role chạy được bằng `execute` + `ProductCommand` trên neo `role_anchor` như `setting`.
- **Audit chưa chứa được dữ liệu ADR 0041 §3 yêu cầu.** `ProductAuditRepository.appendProductAudit` chỉ ghi allowlist metadata; `ProductCommandContext.audit(kind, target)` chỉ mang `resource/key/objectId`; chưa có kind `permission.*`.
- **Đã có sẵn dùng lại:** `compareGrantSets/targetAccess` (`authorization/helpers/grant-set.helper.ts`), `GrantFactsRepository.read` (một câu, trần 20000 dòng, `truncated`), `targetWithinActor` (private, cùng file service), `grantViaRole`/`bindAccountBoundary` ở `test/product-root-stack.helper.ts`, `MAX_PERMIT_PROBES = 17` (đã hết chỗ cho probe menu mới).
- **Fixture test:** `rg 'INSERT INTO role_definition' test` thấy 12 file chèn role `runtime`; `grantViaRole` đã dùng khóa `custom.`, nhưng chưa phân loại từng ca của 11 file còn lại. Ít nhất `product-account-grant-scope` và `hrm-authorization-matrix` chèn rule `runtime` gắn user hoặc `deny` (các ca "không chứng minh được" và thứ tự deny của planner).

## 2. Role runtime: `role.create` / `role.update` / `role.delete`

**Quyết định đề xuất.** Ba action trên resource `role` (neo hiện có), chạy bằng `ProductCommand` mode `admin` qua `execute`; handler không đổi `managed_by`.

- **Route** [Đề xuất]: `POST /api/administration/roles` (201), `PUT /api/administration/roles/:key` (200), `DELETE /api/administration/roles/:key` (200 `{ status: 'deleted' }`). Body allowlist, `unknown` rồi validate: `key` khớp `^custom\.[a-z][a-z0-9_]{1,40}$`, `label` 1..120 điểm mã không ký tự điều khiển, `grants` ≤ 300 phần tử `{ permission, template: { key, version } }`, không trùng, không `parameters` (Q2). Mọi giới hạn kiểm trước giao dịch.
- **Ghi** [Đề xuất]: `role_definition(managed_by='runtime')` + `policy_rule(role_key, effect='allow', managed_by='runtime')` với `rule_id` mới; không bảng mới, không `deny`, không rule gắn user, không `system_owner`.
- **Chỉ chọn từ catalog:** mỗi grant phải là permission đã khai báo, template đã đăng ký **cùng resource** (FK không kiểm điều này nên mã phải kiểm; planner đã fail closed nếu lọt), và là một cặp **cùng resource** trừ resource `document` (Q1 = (a), §13): mọi `(permission, template)` cùng resource đều chọn được, kể cả cặp không có trong grant mặc định; `document.*` không gán được qua UI. Danh sách cặp có rủi ro cao và hệ quả: §13.
- **Sửa** = thay toàn bộ nhãn + tập grant (PUT) kèm `expectedDigest` (SHA-256 của `canonicalJson([label, grants đã sắp])`, không cần cột version); lệch → `409`. Thực hiện bằng diff: xóa rule bị bớt, thêm rule mới, giữ `rule_id` của rule không đổi. Khóa không đổi.
- **Xóa:** `409` khi còn bất kỳ `user_role` nào giữ role (mọi trạng thái tài khoản) hoặc còn `record_exception` tham chiếu; không thu hồi hàng loạt (ADR 0041 §3, đã chốt).
- **Giới hạn** (ADR 0041 §3, đã chốt): ≤ 100 role runtime (đếm trong giao dịch `admin`; vượt → `409`), ≤ 300 grant mỗi role (`400`).
- **Ai được làm:** Root không bị ràng buộc tập con. Actor IAM: (c') mọi grant mới ⊆ tập hiệu lực của mình (ngược lại `403`); khi sửa/xóa, tập **hiện tại** của role cũng ⊆ tập của mình (ngược lại `404` như (d), không lộ role lớn hơn mình). Không có "chủ role".
- **Bất biến phải giữ:** không tự nâng quyền (chỉ so sánh bằng `compareGrantSets`; `deny`/rule user/`truncated`/khác template-tham số ⇒ không chứng minh được ⇒ từ chối); chỉ dòng `runtime` bị đụng (role `code` ⇒ `404`, trigger là lớp hai); Root không là đích (không liên quan đến role); `fresh@1` (Q5); audit và mutation cùng giao dịch, lỗi audit rollback.
- **Thứ tự khóa** (ADR 0041 §3 + ADR 0017, mọi bước trong một giao dịch `admin`): fence độc quyền → session/facts/plan → khóa `role_anchor` `FOR NO KEY UPDATE` (do `execute`; tuần tự hóa mọi ghi role, mẫu `setting_anchor`) → khóa `role_definition` `FOR UPDATE` (sửa/xóa) → đọc facts actor (`GrantFactsRepository.read`) → kiểm → ghi → audit → runner tăng `revision`. Không I/O ngoài DB, không hash mật khẩu trong fence.
- **Boundary:** `role.create` `optional`; `role.update`/`role.delete` `required` vì đổi quyền hiệu lực của người đang giữ (Q3 người dùng chốt; Q4 mặc định).
- **Rủi ro mới tìm thấy ở đây (chưa có trong ADR 0041):** `role.update` bớt grant của role mà một tài khoản **lớn hơn actor** đang giữ sẽ hạ quyền tài khoản đó, trong khi thu hồi trực tiếp tài khoản đó bị (d) chặn. Không leo thang đặc quyền, nhưng là đường tác động lên principal lớn hơn. ADR 0041 chỉ kiểm tập của role, không kiểm người giữ. **Rủi ro đã được người dùng chấp nhận (Q3, 2026-10-29)**: giữ ADR 0041, thêm `boundary: required` cho update/delete, không kiểm người giữ.

## 3. Gán / thu hồi role cho tài khoản

**Quyết định đề xuất.** `account.assignRole`, `account.revokeRole` trên resource `account` (cùng binding `account_directory`, nên Root/vắng cùng `404`), `boundary: 'required'`, `fresh@1`, không grant mặc định.

- **Route** [Đề xuất]: `POST /api/administration/accounts/:id/roles` (body `{ roleKey }`), `DELETE /api/administration/accounts/:id/roles/:roleKey`. Id không chuẩn → `403` trước mọi truy vấn (như `suspendUser`); `roleKey` quá dài hoặc không phải chuỗi → `400`. Role code (ví dụ `hr.admin`) **gán được** (khóa không bắt đầu `custom.`), nên ngữ pháp `custom.` chỉ áp cho tạo/sửa/xóa, không áp cho gán; role không tồn tại → `404`.
- **Cần một seam trong `ProductAuthorization`.** Vì `execute` không dùng được cho `account`, cần method dạng `suspendUser`. Thêm tiếp vào file 920 dòng vi phạm tinh thần ADR 0033; đề xuất đợt tiền đề **tách** `provisionAccount/suspendUser/reactivateUser/targetWithinActor` sang service riêng dùng chung `access()` (cách chia **[Chưa kiểm]**: `access` hiện private) rồi thêm lệnh mới (đợt D2).
- **Thứ tự kiểm** (đối xứng `suspendUser`): id chuẩn → session/policy/boundary/fresh → tra đích qua `account_directory` (Root/vắng ⇒ `false`/`404`) **(b)** → `actor === target` ⇒ `403` **(a)** → khóa `app_user` đích `FOR NO KEY UPDATE` → đọc facts actor+đích bằng một câu → **(d)** đích ⊆ actor (ngược lại `404`) → với assign: **(c)** mọi rule của role ⊆ tập actor (vượt ⇒ Q13) → trạng thái (đã giữ/chưa giữ ⇒ `409`; vượt trần role mỗi tài khoản ⇒ `409`, Q11) → ghi `user_role` → audit.
- **(d) áp cả cho thu hồi:** thu hồi từ tài khoản lớn hơn mình ⇒ `404`; thu hồi không cần (c).
- **Đồng thời:** fence độc quyền đã tuần tự hóa mọi lệnh `admin`; PK `(user_id, role_key)` và khóa `app_user` là lớp phòng thủ. Hai assign cùng cặp: một thành công, một `409`. Hiệu lực ngay ở request kế tiếp (không cache quyền; `readAuthority` đọc DB mỗi request).
- **Tài khoản đích** ở trạng thái `pending`/`suspended`: Q12.
- **Danh sách role gán được** (permission-boundaries.md, "Đánh giá và điểm tích hợp"): web có thể nhận cờ `assignable` do cùng hàm (c) tính, nhưng POST luôn kiểm lại; không bắt buộc ở đợt đầu.

## 4. Binding gói boundary

**Quyết định (người dùng chốt Q7+Q8, 2026-10-29).** Release thêm boundary code-owned `accountAdministration@1` (scope hằng `true`, như `hrAdministration`; chỉ là công tắc bật rõ ràng theo ADR 0041 §4) và hai action **`account.bindBoundary`, `account.unbindBoundary`** trên resource `account`. Tên này **lệch chữ ADR 0041 §4** (`boundary.bind|unbind`): lý do là dùng sẵn `account_directory` (Root/vắng cùng `404`), không thêm resource `boundary`, bảng neo hay migration. Cần ghi chú sửa ở ADR 0041 §4 khi đợt D5 triển khai (đợt D0/D7). Không binding ngầm theo role.

- **Nội dung gói** (Q8 chốt): `account.provision|suspend|reactivate|assignRole|revokeRole|bindBoundary|unbindBoundary` (+ `role.update|delete` theo Q4: mặc định `required`, nằm trong cùng gói để IAM qua được `required`; chưa chốt có tách boundary riêng không, mặc định không tách). Việc gom `provision/suspend/reactivate` vào gói **đổi hành vi hiện có**: ba action này hiện chỉ Root dùng được qua HTTP (không boundary nào phủ), sau release 20 IAM có grant + binding dùng được; cần test nâng cấp 19 → 20 ghi rõ. Version bất biến: thêm permission vào gói sau này là `@2` + gắn lại.
- **Bind** (gói đủ, một giao dịch, một câu `INSERT`): (a) không tự gắn; (b) đích IAM; (d) đích ⊆ actor; (e) boundary `(key, version)` phải active, mọi entry là permission `required` (`400` nếu không), đích chưa có binding cho **bất kỳ** permission trong gói (một binding mỗi `(user, permission)`; có rồi ⇒ `409`, không ghi đè); Root không bị ràng buộc thêm; actor IAM chỉ gắn được khi **chính mình** đang giữ đúng cùng `(key, version)` cho **từng** permission trong gói (ngược lại `403`). Dòng ghi có `seed_owner NULL`.
- **Unbind:** chỉ xóa dòng `seed_owner IS NULL` của gói; không có gì để xóa ⇒ `409`; (a)(b)(d) áp; **không** đòi actor tự giữ binding (hạ quyền không cần ủy quyền) và dòng `seed_owner` không bao giờ đổi (trigger là lớp hai). Q5 về `fresh`.
- **Lần đầu:** người giữ quyền quản trị đầu tiên chỉ Root gắn được (chưa ai có binding để ủy quyền). Quy trình vận hành cần cập nhật `docs/hrm-local-operations.md` (**[Chưa kiểm]** nội dung hiện tại).
- **Thứ tự khóa:** fence → authorize → `app_user` đích → đọc binding của actor/đích → ghi → audit.
- **Đọc trạng thái binding:** thêm `boundaries[{ permission, key, version, seeded }]` vào `account.readPermissions` để UI báo "thiếu binding" (quan sát: ADR 0041 §4 yêu cầu UI hiển thị trạng thái thiếu binding nhưng response hiện không có).

## 5. Migration `115` (CHECK cho role runtime)

[Quan sát] ADR 0041 §3 dành `115` cho: `managed_by='runtime' ⇔ khóa bắt đầu 'custom.'`, `effect='allow'`, rule runtime không gắn user. [Đề xuất] module `modules/role/migrations/hrm-role-runtime.migration.ts`, tên `HrmRoleRuntime1792108800115`, đăng ký ở `tools/product.ts` cạnh `HrmRole1792108800114`; `down` từ chối như các migration khác; không đổi ACL nên probe `expectedPrivileges` giữ nguyên. Cập nhật số migration trong `product-database.integration-spec.ts` (đang so `20`).

- CHECK khóa trên `role_definition`: `(managed_by = 'runtime') = (substring(role_key FROM 1 FOR 7) = convert_to('custom.', 'UTF8'))` (dạng đã được ADR 0046 §1 kiểm cho dữ liệu hiện có: 0 vi phạm). Thêm **validated** để migration thất bại ồn ào nếu có dòng sai.
- **Quyết định (người dùng chốt Q9 = (b), 2026-10-29): không dùng CHECK cho `effect`/`user_id`.** [Quan sát] CHECK `runtime ⇒ allow ∧ không gắn user` cũng áp cho owner/superuser, làm các test seed rule runtime `deny` hoặc gắn user (ví dụ `product-account-grant-scope`, `hrm-authorization-matrix`) không seed được; thay bằng `managed_by='code'` cũng không được vì `protect_product_rows` từ chối mọi login trừ `sync`. Vì vậy phần này thực thi bằng **trigger** chỉ chặn login `product_authority`: INSERT/UPDATE `policy_rule` mà `effect <> 'allow'` hoặc `user_id IS NOT NULL` (hoặc `role_key` không phải `custom.`) bị từ chối `42501`. Login khác (owner dùng cho fixture test) không bị ảnh hưởng, nên **không phải sửa 12 file fixture** vì lý do này (chỉ cần fixture role runtime dùng khóa `custom.` để thỏa CHECK khóa; các file chưa dùng thì sửa khóa, việc đó vẫn thuộc D1, chưa phân loại). Đóng luôn rủi ro "`authority` ghi được `deny`/rule theo user" của ADR 0041 §3/ADR 0046 ở mức DB cho login API.
- **Hệ quả kỹ thuật của (b)** [Chưa kiểm]: thêm trigger mới trên `policy_rule` (hàm riêng, không sửa thân `protect_product_rows` đang bị probe ghim chính xác) và thêm nó vào `protectionTriggers` của probe cùng test drift; `user_role`/`user_boundary` không đổi. Có tên trigger/hàm mới trong `protectionFunctions`. Cần test: `authority` INSERT rule `deny`, rule gắn user, rule `allow` cho role `code` ⇒ `42501`; `authority` INSERT rule `allow` cho role `custom.` ⇒ được; owner seed `deny` ⇒ được (fixture).
- `prepareProductRelease` từ chối role release có tiền tố `custom.` (như `system.`), kèm test; đợt D1 độc lập với phần còn lại.

## 6. Hai mục "Bắt buộc phần 2" (ADR 0046 §7)

1. **`truncated`.** `role.read` và `account.readPermissions` trả thêm `truncated: boolean`. Cách làm [Đề xuất]: lấy `LIMIT n+1` ở mỗi nơi đang cắt (200 role, 500 rule mỗi role, 200 role/tài khoản, 5000 rule/tài khoản), cắt về n, đặt cờ. Sau khi có giới hạn ghi (100 role × 300 grant) trần đọc không thể bị vượt bằng đường hợp lệ, nên cờ chỉ là lớp phòng thủ cho dữ liệu ghi trực tiếp vào DB. Web hiển thị cảnh báo thay vì ngầm hiểu là đủ. Đổi shape response ⇒ đổi OpenAPI hash và `menuSchema`/zod ở `features/administration/administration.client.ts`.
2. **Cùng snapshot.** Hiện `accountPermissions` chạy ba câu (EXISTS đích, roles, `GrantFactsRepository.read`). [Quan sát] `read` giữ shared fence còn mọi ghi role/binding cần fence độc quyền (`product-transaction.runner.ts`: `shared = read|write|identity`), nên facts quyền **không thể đổi giữa các câu** trong một giao dịch đọc; yêu cầu "cùng snapshot" đã được fence bảo đảm. Vẫn [đề xuất] gộp roles + grants + boundaries vào **một câu** (CTE) để bất biến không phụ thuộc lập luận fence và để test khóa được bằng đếm câu lệnh (như `grant-facts` test), kèm một test đồng thời: ghi `admin` xen giữa không thể làm roles và grants lệch nhau.

## 7. Cặp `hrCompany.approvals` + `workRequest.decideFinal` (ADR 0044 §4)

[Quan sát] ADR 0044: role chỉ có `approvals` bị `409 final_approval_unavailable` ở mọi lần submit; role có cả hai tự duyệt đơn của chính mình. [Đề xuất] (Q10):

- Registry code-owned, đóng, nhỏ: danh sách "năng lực nhạy cảm" gồm cặp trên; mã sở hữu là module `role` (không tên role). Không permission mới, không đổi release 19 về ngữ nghĩa duyệt.
- `role.read` trả `capabilities: ['selfApproval']` trên role chứa đủ cặp (tính ở server từ registry, web chỉ hiển thị); audit `role-create/update` ghi cờ boolean `selfApproval`; mọi ghi role đã `fresh@1` + audit nên thỏa yêu cầu "nhóm fresh + audit".
- Chặn cứng (khuyến nghị kèm, Q10): `role.create/update` từ chối (`400`) role chứa `hrCompany.approvals` mà thiếu `workRequest.decideFinal` cùng role, vì tạo ra tài khoản bị khóa nộp đơn. Kiểm ở mức role, không ở mức tập hiệu lực của tài khoản (assign không kiểm cặp).

## 8. Audit

[Đề xuất] Kind mới: `permission.role-create|role-update|role-delete|role-assign|role-revoke|boundary-assign|boundary-revoke` (ADR 0041 §3 nêu năm kind đầu; hai kind boundary lấy từ kế hoạch 2026-10-23). Mở rộng `ProductAuditEvent` và allowlist trong `appendProductAudit` (đợt D1b, kèm unit test): `roleKey`, `grantCount`, `grantsDigest` (SHA-256 chuẩn của tập grant, không nội dung), `boundaryKey`/`boundaryVersion`, `targetUserId` cho assign/revoke/bind/unbind; **không** email, `sub`, nhãn role, token. `ProductCommandContext.audit` nhận thêm tham số `detail` tùy chọn có kiểu (chạm vào `product-authority.service.ts`, thuộc đợt tách D2). Root có `principalKind: 'root'`, `outcome` theo mẫu hiện có. Mutation và audit atomic: lỗi audit rollback toàn bộ (test cho từng lệnh).

## 9. Release, OpenAPI, route inventory, mã lỗi

- **Release:** `sequence` `20` (hiện `19`). Khai báo mới: `role.create|update|delete`, `account.assignRole|revokeRole|bindBoundary|unbindBoundary`, boundary `accountAdministration@1`. Hash release/canonical declarations/bindings (bindings có thể không đổi vì không resource mới) và OpenAPI đổi có chủ đích; cần fixture `test/fixtures/release-nineteen.ts` dựng lại đúng hash release 19 và test nâng cấp 19 → 20 trong `hrm-authorization-upgrade.integration-spec.ts`; re-pin `structure.spec.ts`, `system-release.spec.ts`, `authorization-keys`. Q15 về việc gom một số release cho cả phần 2.
- **Route inventory:** thêm sáu route ghi (§2–§4) vào `structure.spec.ts`; mọi POST/PUT/DELETE gọi `enforceCsrf` và `ProductAuthorize`.
- **Grant mặc định:** không (Q6); release không cấp action ghi cho role nào.
- **Menu / probe:** không thêm menu mới, không thêm cặp vào `me` (đang 17/17). Web cần biết nút nào bật: dùng một lượt `permitsMany` riêng ở endpoint đọc role (trần 17 áp riêng từng lượt) hoặc phản hồi 404/403 [Chưa kiểm cách web hiện làm].
- **Mã lỗi: không thêm key `error.*`.** Dùng `invalidRequest` (400), `accessDenied` (403), `notFound` (404), `conflict` (409). Mỗi lỗi chỉ lộ điều caller đã được phép biết: giới hạn/trùng/đang được giữ chỉ trả sau khi đã authorize trên neo/đích; tài khoản Root/vắng/lớn hơn cùng `404`; web phân biệt "đạt trần" hay "đang được giữ" bằng GET như ADR 0041 §7. Nếu về sau cần key riêng cho từng loại 409, phải theo thủ tục `ApiRejection` của AGENTS.md (không đề xuất ở đây).

## 10. Kiểm chứng bắt buộc

Mức repository/service trên PostgreSQL thật, từng file, theo ghi chú người dùng (không chạy full luồng/e2e/benchmark). Mỗi bất biến có test riêng và mutation hoàn nguyên ghi vào ledger.

- **Hàm thuần** (unit, không DB): ngữ pháp khóa, nhãn, kiểm catalog (permission lạ, template lạ, template khác resource, trùng, > 300), digest ổn định theo thứ tự, registry cặp ADR 0044.
- **Declarations:** không action nào nhắm Root; mọi action ghi mới `required`/`fresh@1` theo Q4–Q5 và không grant mặc định; `custom.` bị `prepareProductRelease` từ chối.
- **Bất biến (a)–(e), mỗi cái một test + mutation (bỏ kiểm ⇒ đúng các ca từ chối đỏ):**
  - (a) tự assign/revoke/bind/unbind ⇒ `403`, không đổi gì, không audit;
  - (b) đích Root/vắng/id lạ ⇒ `404`/`403` đúng quy ước, Root và vắng không phân biệt;
  - (c) role chứa grant ngoài tập actor, khác template/tham số, actor có `deny` hoặc rule user, đọc `truncated` ⇒ từ chối; role code gán được khi nằm trong tập;
  - (d) đích lớn hơn ⇒ `404` cho assign, revoke, bind, unbind (mở rộng `product-account-grant-scope`);
  - (e) boundary chỉ gán được entry `required`; một binding mỗi `(user, permission)`; bind trùng `409`; actor không giữ cùng `(key, version)` ⇒ `403`; gói gắn nguyên tử (một entry lỗi ⇒ không dòng nào); dòng `seed_owner` không sửa/xóa được (kể cả trực tiếp qua `authority`, trigger `42501`).
- **Ma trận actor:** Root; IAM đủ grant + binding + fresh; thiếu binding; thiếu fresh; đích Root; tự tác động; đích lớn hơn; role vượt tập; template khác.
- **Role:** tạo role ⊆ tập; Root tạo role chứa mọi permission được phép; vượt 100 role / 300 grant; khóa trùng `409`; `expectedDigest` lệch `409`; sửa có hiệu lực ngay ở request kế tiếp của người giữ; xóa khi còn người giữ (kể cả `pending`/`suspended`) ⇒ `409`; thu hồi có hiệu lực ngay; role `code` không sửa/xóa được (`404` + trigger); sửa role lớn hơn mình ⇒ `404`.
- **Hash/sync:** sau khi có role runtime, `ProtectedStateRepository.hash`/`materialized_hash` giữ nguyên, `reconcile` cùng release `changed=false`, release có khóa trùng runtime bị `collision`, release có `custom.` bị từ chối.
- **Đồng thời:** hai assign cùng cặp một thành công; assign xen revoke; update xen delete; lỗi audit rollback cho từng lệnh; `truncated` và cùng snapshot (§6).
- **DB:** insert trực tiếp role runtime thiếu `custom.` hoặc role code có `custom.` ⇒ `23514`; trigger của Q9 (b) như §5.
- **Phủ cặp ngoài grant mặc định (hệ quả Q1 = (a)):** bất biến (c)/(c') và các mutation của chúng phải chạy **trên cặp ngoài grant mặc định**, không chỉ trên cặp của release. Tối thiểu: (1) mỗi cặp trong danh sách rủi ro cao của §13 được tạo bởi Root, và actor IAM không giữ đúng cặp đó bị từ chối khi tạo/sửa role và khi gán (cặp ngoài tập ⇒ "khác template" ⇒ không so sánh được); (2) test thuộc tính: với toàn bộ 125 cặp cùng resource trừ `document`, một actor chỉ giữ cặp P không bao giờ tạo/gán được role chứa cặp P' ≠ P; (3) mutation: bỏ kiểm template cùng resource, bỏ so sánh template (chỉ so permission) ⇒ test (2) đỏ; (4) hành vi: với mỗi cặp rủi ro cao, holder thực sự bị planner/guard nghiệp vụ giới hạn như mong đợi (xem "[Chưa kiểm]" ở §13), hoặc ghi rõ giới hạn.
- **Web (Vitest):** form role (chọn cặp từ catalog, cảnh báo `selfApproval`, `truncated`), hộp gán role, trạng thái thiếu binding; locale `vi`/`en` cùng tập key.

## 11. Chia đợt đề xuất (mỗi đợt một commit nhỏ, review độc lập; chưa commit gì)

| Đợt | Nội dung                                                                                                                                                                                                                          | Đổi release / migration / OpenAPI  | Phụ thuộc                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| D0  | ADR đã Accepted (4 quyết định + 10 mặc định); chỉnh ghi chú ADR 0041 §3/§4 (tên `account.bindBoundary`, phạm vi cặp, trigger thay CHECK)                                                                                          | chỉ docs                           | —                            |
| D1  | Helper thuần (khóa, nhãn, catalog trừ `document`, digest, registry ADR 0044), `prepareProductRelease` từ chối `custom.`, migration `115` (CHECK khóa + trigger `authority`), sửa khóa role fixture nếu cần, test hash/sync        | migration `115`; release không đổi | D0                           |
| D1b | Mở rộng audit (kind + metadata allowlist)                                                                                                                                                                                         | không                              | D0                           |
| D1c | **Xong 2026-10-29 (§14)** `truncated` + một-câu-cùng-snapshot cho hai route đọc, web hiển thị cảnh báo                                                                                                                            | OpenAPI                            | độc lập, có thể làm sớm nhất |
| D2  | **Xong 2026-10-29** Tách account commands khỏi `product-authority.service.ts` sang `product-account.service.ts` (`ProductAccountService`, seam là `ProductAuthorization.access` public); không đổi hành vi, test hiện có giữ xanh | không                              | D1b                          |
| D3  | `role.create/update/delete` + route + test + mutation                                                                                                                                                                             | release `20`, OpenAPI              | D1, D1b                      |
| D4  | `account.assignRole/revokeRole` + (a)–(d) + route + test + mutation                                                                                                                                                               | release `20`, OpenAPI              | D2, D3                       |
| D5  | Boundary `accountAdministration@1`, bind/unbind, `boundaries` trong `readPermissions`, (e) + test + mutation                                                                                                                      | release `20`, OpenAPI              | D2, D4                       |
| D6  | Web: trang sửa role, gán role ở chi tiết tài khoản, trạng thái binding, i18n                                                                                                                                                      | không                              | D3–D5                        |
| D7  | Đồng bộ `AGENTS.md`/`apps/api/AGENTS.md`/ADR 0041/0046, `hrm-local-operations.md`, kế hoạch (tick T3b.3–T3b.6 có bằng chứng), ledger, kiểm tổng                                                                                   | docs                               | D1–D6                        |

Không đợt nào mở route ghi cho tới khi D3/D4 tương ứng có test đỏ→xanh. Không mở UI gán role trước khi D1–D5 xong (ADR 0041 §8).

## 12. Phần đã có và còn thiếu

| Hạng mục                                         | Đã có (quan sát)                                           | Còn thiếu                                  |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------ |
| Ma trận role đọc, neo `role_anchor`, `role.read` | có (ADR 0046)                                              | xong D1c (2026-10-29, xem §14)             |
| So sánh tập grant, (d) cho suspend/reactivate    | có, kèm test + mutation                                    | áp cho assign/revoke/bind/unbind; (c)      |
| Quyền DB `authority` trên 4 bảng                 | có                                                         | CHECK/trigger runtime (migration `115`)    |
| Hash không đổi dưới ghi runtime                  | có (test giả định ADR 0046)                                | test đầy đủ với ghi qua service, collision |
| `custom.` bị release từ chối                     | chưa (4 file dở của người dùng có một phần, không dựa vào) | helper + test + commit                     |
| Ghi role / gán / binding / route / audit kind    | không                                                      | toàn bộ §2–§4, §8                          |
| Boundary phủ `account.*`                         | không (`boundaries: []`)                                   | `accountAdministration@1`                  |
| Trần `MAX_PERMIT_PROBES`                         | 17/17                                                      | không cần nếu không thêm menu              |
| Web ghi                                          | chỉ đọc (`role.page.tsx`, `account.page.tsx`)              | §10 mục Web                                |

## 13. Quyết định của người dùng (2026-10-29)

Bốn quyết định do người dùng chốt trong phiên làm việc, có hiệu lực khi đợt tương ứng được triển khai:

1. **Q1 = (a): mọi cặp `(permission, template)` cùng resource đều chọn được cho role runtime, trừ resource `document`** (125 cặp; 56 cặp là grant mặc định của release, **69 cặp ngoài grant mặc định**; `dist/`, **[Chưa kiểm]** với `src/`). Đây **không** theo khuyến nghị ban đầu của ADR này (chỉ cặp có trong grant mặc định). `document.*` không gán được qua UI.
2. **Q3: giữ ADR 0041 §3** (sửa/xóa role chỉ kiểm tập hiện tại của role ⊆ actor, không kiểm người giữ), cộng `boundary: 'required'` cho `role.update`/`role.delete`. **Rủi ro đã chấp nhận:** actor IAM có thể hạ quyền một tài khoản lớn hơn mình (tài khoản đó giữ role bị bớt grant), điều mà thu hồi trực tiếp bị (d) chặn.
3. **Q7 + Q8:** action `account.bindBoundary|unbindBoundary` (resource `account`, **lệch chữ ADR 0041 §4**, ghi chú sửa ở đó khi D5 triển khai); gói `accountAdministration@1` gồm cả `provision/suspend/reactivate` hiện có cùng action mới (§4).
4. **Q9 = (b):** migration `115` thêm CHECK khóa/tiền tố và **trigger** chặn login `authority` ghi `deny`/rule gắn user thay cho CHECK `effect`/`user_id` (§5). Không phải sửa 12 file fixture vì lý do này.

### Hệ quả của Q1 = (a) (bề mặt tự nâng quyền rộng hơn)

- Tập cặp mà người tạo role chọn được tăng từ 56 lên 125 (trừ `document`). Mọi cặp ngoài grant mặc định chưa từng được người thiết kế release xem xét về ngữ nghĩa kết hợp. Hai lớp bảo vệ còn nguyên: policy của action vẫn AND với scope của template (ví dụ `finalStage`), và (c)/(c')/(d) so sánh bằng bộ `(permission, template, version, parameters)` nên actor IAM chỉ cấp được đúng cặp mình giữ. Cặp ngoài grant mặc định thì chỉ **Root** (không bị ràng buộc tập con) hoặc người đã được Root cấp đúng cặp đó mới tạo/gán được; vì vậy rủi ro tập trung ở **quyết định của Root** và ở việc tập hiệu lực của người nhận cặp lạ được tính đúng.
- **Mâu thuẫn/điểm cần chú ý mới:** (i) cặp ngoài grant mặc định làm phép so sánh "khác template ⇒ không so sánh được" xảy ra thường hơn (nhiều từ chối giả khi actor giữ `employee.update + allEmployees` còn role đích dùng `ledEmployees`: không so sánh được dù thực tế nhỏ hơn); đây là hệ quả bảo thủ của quyết định "không giải containment biểu thức", không phải lỗi. (ii) Test mutation cho (c)/(d) phải phủ cặp ngoài grant mặc định (§10), không chỉ cặp của release. (iii) Web cần cho Root thấy cặp nào là "ngoài mặc định" (đề xuất cờ `default: boolean` trong catalog trả về) để cảnh báo.
- **Cặp có rủi ro cao thấy trong catalog** (liệt kê từ catalog, ngoài grant mặc định; nghĩa là ghép template rộng hơn/khác ý thiết kế với action nhạy cảm; hành vi thực tế **[Chưa kiểm]**, phụ thuộc guard nghiệp vụ trong `run` mà tôi chưa đọc từng cái):
  - `workRequest.decideFinal` + `ownRequests` / `ledRequests` / `decidedRequests` / `leadRejectedLeadRequests` (duyệt cuối đơn của chính mình hoặc đơn ngoài hàng đợi `finalQueue`); `workRequest.decideLead` + `ownRequests` / `allRequests` / `finalQueue` / `decidedRequests`; `workRequest.cancelApproved` + `ownRequests` / `ledRequests` / `finalQueue` / `decidedRequests`; `workRequest.cancel` + `allRequests` / `finalQueue` / `decidedRequests` / `ledRequests`. Policy `finalStage`/`leadStage`/`approvedFresh`/`pendingStage` giới hạn theo trạng thái nhưng không theo người; "không tự duyệt" nếu có nằm ở `run` (ADR 0017: guard nghiệp vụ áp cả Root).
  - `employee.adjustLeaveBalance` / `adjustLeaveRate` / `adjustAttendance` + `selfEmployee` / `ledEmployees` (tự điều chỉnh phép/công của chính mình hoặc của người mình dẫn dắt).
  - `employee.update` + `selfEmployee` / `ledEmployees`; `employee.submitRequest` + `allEmployees` / `ledEmployees` (nộp đơn thay người khác); `employee.linkAccount` + `selfEmployee` / `ledEmployees` và `team.assign` + `ledTeams` / `memberTeams` (cả hai là `required`, tác động lên principal khác).
  - `account.provision|suspend|reactivate|read|readPermissions` + `allAccounts` (template duy nhất của resource; chỉ không có grant mặc định).
  - Danh sách trên lấy từ lần liệt kê catalog có lọc; có thể thiếu cặp khác (ví dụ `leaveRate.read`, `team.read` với template khác). Khi triển khai D1, sinh danh sách đầy đủ bằng mã và ghim vào test.
- **Đề xuất giảm thiểu, không bắt buộc** (người dùng quyết nếu muốn): cờ `default` trong catalog trả về; audit `role-create/update` ghi số cặp ngoài mặc định; cảnh báo ở web. Không đổi quyết định Q1.

## 13b. Mặc định áp dụng, chờ phản đối

Người dùng chưa trả lời riêng 10 câu dưới đây. Điều phối viên đã báo sẽ áp **khuyến nghị**; mỗi mặc định có thể đổi trước khi đợt tương ứng được triển khai (đổi thì sửa ADR trong cùng thay đổi). Các phần khác của ADR đã viết theo các mặc định này.

- **Q2. Tham số template:** chỉ `{}` (release không có template tham số). Hỗ trợ tham số khai báo (ADR 0041 §3 cho phép) làm sau, khi có template tham số đầu tiên.
- **Q4. `boundary` của action ghi role:** `role.create` `optional`, `role.update/delete` `required` (khớp Q3), cả hai nằm trong gói `accountAdministration@1` (§4).
- **Q5. `fresh@1`:** mọi hành động ghi mới, kể cả thu hồi/unbind/xóa.
- **Q6. Grant mặc định cho action ghi mới:** không cấp cho role nào; chỉ Root cho tới khi cấp grant runtime (như `account.*`).
- **Q10. Cặp ADR 0044:** cảnh báo + cờ audit `selfApproval` + chặn (`400`) role có `hrCompany.approvals` mà thiếu `workRequest.decideFinal` (§7). Không permission riêng.
- **Q11. Trần số role mỗi tài khoản:** 20 (`409` khi vượt).
- **Q12. Gán role cho tài khoản `pending`/`suspended`:** cho phép mọi trạng thái.
- **Q13. Gán role vượt tập actor (c):** `404` như role vắng.
- **Q14. Khóa role:** người dùng nhập `custom.<tên>`.
- **Q15. Số release:** một release `20` cho cả phần 2.

## 14. Khác biệt với bản nháp dở của người dùng (chỉ đọc, ADR này thiết kế độc lập)

[Quan sát] `authorization/helpers/role-grant.helper.ts`, `test/role-grant.spec.ts`, và các diff ở `product-manifest.service.ts`/`system-release.spec.ts` (chưa commit) hiện có: ngữ pháp `custom.` giống ADR 0041, hằng 100/300, nhãn ≤ 120 điểm mã, kiểm catalog cùng resource, digest SHA-256, và từ chối `custom.` ở `prepareProductRelease`. Khác/chưa phủ so với đề xuất ở đây: helper từ chối mọi template có tham số (trùng Q2 khuyến nghị, nhưng ADR 0041 cho phép tham số); digest chỉ băm `(permission, template, version)` và không bao gồm nhãn (đề xuất của ADR này cho `expectedDigest` bao gồm nhãn); chưa có tập cặp được phép (Q1 = (a): không cần tập cặp riêng, chỉ loại `document`), chưa có registry ADR 0044, chưa có `truncated`. Không sửa các file đó. Q1 = (a) và Q3 đã chốt; cần đối chiếu lại với bản dở của người dùng để tránh làm hai lần.

## 15. Không xác minh được

- `dist/` có thể không khớp `src/` (đọc catalog từ `dist/`); chưa build lại.
- `access()` private: cách tách service account command (D2) chưa thử; có thể cần mở một điểm nối nhỏ hơn dự kiến.
- Probe `product-privilege`/test ACL có liệt kê CHECK hay không (ảnh hưởng migration `115`), và cách thêm trigger mới trên `policy_rule` vào `protectionTriggers`/`protectionFunctions` (Q9 (b)) mà không đổi thân `protect_product_rows`.
- `docs/hrm-local-operations.md`, cách web hiện quyết định hiện/ẩn nút, và `administration.client.ts` zod có `strict` hay không: chưa đọc.
- Hành vi `DELETE` role với FK `user_role`/`policy_rule`/`record_exception` (thứ tự xóa) mới suy từ schema, chưa chạy.
- Phân loại từng fixture test bị ảnh hưởng bởi CHECK; ước lượng 12 file chỉ từ `rg`.
- Không có đo hiệu năng cho các lệnh mới; chi phí dự kiến thấp (một đến vài câu trong giao dịch `admin`) nhưng giữ fence độc quyền nên cần đo thời gian giữ fence nếu số rule thật lớn.

## 14. Sổ đợt D1c (2026-10-29, người dùng duyệt re-pin OpenAPI)

[Quan sát, đã chạy] `role.read` và `account.readPermissions` trả thêm `truncated: boolean`; mỗi nơi cắt đọc `LIMIT n+1` (200 role; 500 rule mỗi role; 200 role mỗi tài khoản; 5000 rule mỗi tài khoản, đúng trần cũ), cắt về n, `truncated` đặt khi có dòng n+1. `accountPermissions` chạy MỘT câu (CTE: kiểm đích theo scope + roles + rules), thay ba câu cũ; `GrantFactsRepository` không còn được `RoleReadRepository` dùng (vẫn dùng bởi so sánh tập grant). Kết quả khác `truncated` giữ nguyên (cùng sắp xếp, cùng dedup). Ghi chú: ADR nói "roles + grants + boundaries" nhưng hai route này không đọc boundary; không thêm. Web: `administration.client.ts` bắt buộc `truncated` (zod), cảnh báo `Alert` ở trang `/roles` và hộp quyền tài khoản, key `administration.roles.truncated`, `administration.accounts.permissions.truncated` ở `vi`/`en`. Không đổi permission, release, migration, route, key lỗi.

Re-pin OpenAPI trong `apps/api/test/structure.spec.ts`: `2fdf1d70…`→`c28bcd92…` (bản `d16ae2fe…` có nhầm một câu `truncated` trong mô tả `setting.read`, reviewer phát hiện, đã xóa và ghim lại; ví dụ `truncated: false` và mô tả hai route). Test: `hrm-role-truncation.integration-spec.ts` (5: đúng n/n+1 cho role, rule mỗi role, role và rule mỗi tài khoản, không rò dữ liệu tài khoản khác, đếm một câu; đỏ trước khi có field: `truncated` là `undefined`/thiếu), `hrm-role-matrix` 5, `hrm-menu-role` 2, `hrm-authorization-upgrade` 5 xanh; unit `structure`, `explicit-columns`, `module-boundaries`, `authorization-keys` xanh (lần đầu đỏ 2 test vì `row_to_json`/`SELECT *`, sửa sang cột có tên); web Vitest `role`, `administration.client`, `administration` 26 xanh; `test:workspace` 20 xanh.
