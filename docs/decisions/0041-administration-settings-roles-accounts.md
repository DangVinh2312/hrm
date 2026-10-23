# ADR 0041 — Quản trị hệ thống: setting, role/permission và tài khoản (kể cả thao tác danh tính)

Ngày: 2026-10-23. **Trạng thái: Accepted (2026-10-24)** — người dùng (chủ dự án) duyệt văn bản ngày 2026-10-24 và chốt các quyết định ở mục "Quyết định của người dùng"; **chưa triển khai** (từng đợt chỉ có hiệu lực khi được triển khai; kế hoạch: [2026-10-23-administration](../superpowers/plans/2026-10-23-administration.md), mọi checkbox chưa tick). **Kế thừa và thay thế một phần** [ADR 0029](0029-account-management-ui.md) (tài khoản) và [ADR 0030](0030-permission-management.md) (quản lý quyền): hai ADR đó chưa triển khai, giữ nội dung làm lịch sử; chỗ mâu thuẫn thì ADR này thắng. **Đảo ngược có chủ đích** một phần bất biến ở root `AGENTS.md` ("lấy quyền user admin để reset/link/impersonate global identity"), [ADR 0026](0026-totp-second-factor.md) §10 và [ADR 0027](0027-google-only-sign-in.md) §6/§9 (xem mục "Bất biến mới"). Giữ [ADR 0012](0012-iam-root-separation.md) (Root ngoài IAM), [ADR 0022](0022-root-step-up-and-time-source.md) (fresh), [ADR 0017](0017-hrm-transaction-lock-idempotency.md), [permission boundaries](../permission-boundaries.md). Không thay quyết định nào khác đã Accepted.

## Đầu vào do người dùng chốt (2026-10-23)

- Nguyên tắc chung: **quyền tuyệt đối vẫn là Root; "Admin" chỉ là một role được tạo và phân quyền trong hệ thống, không có gì đặc biệt; mọi thứ tập trung vào permission.** Không tên role nào xuất hiện trong guard, boundary, điều kiện hay thông điệp.
- Hai loại hành động: (1) hành động thường = permission gắn vào role bằng grant; (2) **Root-only = chỉ những hành động tác động lên chính tài khoản Root** (không có permission nào cấp được cho IAM).
- Setting: nhân sự và thông tin công ty chỉnh qua UI bằng quyền thường, **không fresh**, có version + lịch sử append-only + audit; bảo mật/phiên **chỉ xem**.
- Role: xem ma trận role↔permission; **tạo role mới và gán permission cho role qua UI** (Q0 = b); gán/thu hồi role cho tài khoản. Role do code/release sở hữu vẫn bất biến.
- Tài khoản: danh sách, cấp theo email, suspend, khôi phục, xem role/nhân viên liên kết; **đổi email, reset MFA, đổi Google binding của tài khoản IAM bằng permission thường, một bước, fresh + audit** (Q5: không bắt buộc hai người).
- Q1: Root tạo được role "gần sát Root nhất có thể" và cho phép gán nếu actor có permission gán.

## Bối cảnh — đã kiểm trong source (2026-10-23, HEAD `08e41b9`)

Những điều dưới đây đã đọc trực tiếp; chưa chạy test hay DB nào cho ADR này.

- Administration hiện có `POST/GET /api/administration/accounts` và `POST /api/administration/users/:id/suspend` (`administration/controllers/`); `account.provision/suspend` là `fresh@1` + `boundary: 'required'`, `account.read` là `auditedRead@1`; **không grant mặc định nào cho `account.*`** (`administration/account.declarations.ts`). Chưa có un-suspend, đổi email IAM, reset MFA qua HTTP, đổi Google binding, đọc ma trận, ghi role.
- Login `authority` (mode `admin`, exclusive fence + `revision+1`) **đã có** `INSERT/UPDATE/DELETE` trên `role_definition`, `user_role`, `policy_rule`, `user_boundary`, `record_exception` (`database/product-privilege.declarations.ts`). Bảng đã có `managed_by IN ('code','runtime')` (CHECK `ck_managed_by`, migration `001`).
- `protect_product_rows` (migration `012`, `productRowsIamBody`): login khác `sync` bị từ chối khi đụng dòng `role_definition`/`policy_rule` có `managed_by='code'` (cũ hoặc mới) và khi `policy_rule`/`record_exception` tham chiếu role `managed_by='code'`; dòng `managed_by='runtime'` không bị chặn. `sync` không được đụng dòng runtime.
- `ProtectedStateRepository.hash` (`authorization/repositories/protected-state.repository.ts`) chỉ băm `role_definition`/`policy_rule` có `managed_by='code'`: **role/grant runtime không đổi `materialized_hash`**. Release hash chỉ sinh từ `ProductReleaseSource` (`prepareProductRelease`). `ProductManifestSeedRepository.apply` từ chối (`collision`) khi role của release trùng key role runtime.
- Mỗi request đọc authority từ DB trong transaction (`readAuthority`), không cache; rule của role người dùng đang giữ được nạp qua `policy_rule.role_key IN (user_role...)`, nên grant của role runtime có hiệu lực ngay sau commit.
- Reset MFA hiện: `resetProductMfa` (`authentication/services/product-mfa.service.ts`) chạy mode `revoke` (login `identity`) cho IAM và `bootstrap` cho Root; chỉ CLI gọi (`tools/root-commands.ts`). Login `authority` **không** có quyền trên `mfa_*`. API không giữ login `bootstrap`.
- Đổi email: chỉ `setRootEmail` (Root, CLI). Đổi Google: chưa có; `liveEnrollment` chỉ khớp tài khoản `pending` **chưa có** `external_identity` (`authentication/services/product-oidc-enrollment.service.ts`). `protect_account_lifecycle` (`004`) cấm `authority` đưa tài khoản ra khỏi `suspended`.
- `menus` của `GET /api/auth/me` dùng `permitsMany`, tối đa `MAX_PERMIT_PROBES = 16` cặp, nhóm any-of **tính phẳng** (ADR 0017 bổ sung); hiện dùng tới 14 cặp.
- Hằng cố định liệt kê ở mục Setting; `hr.coo` bị hardcode trong `modules/work-request/services/work-request.service.ts` (truy `user_role` theo `'hr.coo'` để xác định COO tự duyệt).
- `attendance-snapshot.helper.ts`: snapshot kỳ đã chốt lưu mười (mười một ở format 2) tổng, **không lưu `overLimit`**. `report-sheet.repository.ts` (`wfhReport`) tính `overLimit: row.wfhDays > WFH_MONTH_LIMIT` lúc đọc.

## Quyết định

### 1. Hai loại hành động

**Loại 1 — permission thường.** Mọi khả năng quản trị là action khai báo trong declarations (code-owned) và gắn vào role bằng grant (grant mặc định của release và grant của role runtime). Role nào được grant thì làm được. Không có tên role trong code kiểm quyền.

**Loại 2 — Root-only = tác động lên chính tài khoản Root:** bootstrap/reissue/revoke Root; đổi email, reset MFA, đổi Google binding của Root; gán/thu hồi quyền cho Root (không tồn tại: Root không có role/grant/boundary); khôi phục Root bị suspend (repair offline). Không có permission tương ứng và không có route HTTP nhắm Root. Root dùng **CLI offline có approval hiện có** (`root:*`; Q12 = chỉ CLI, giữ ADR 0012/0026/0027). Cơ chế bảo đảm IAM không bao giờ làm được (không phải chỉ ẩn nút):

1. DB: mọi hàm SECURITY DEFINER mới có điều kiện cứng `kind='iam'` và từ chối đích Root bằng exception; `guard_root_lifecycle` chỉ cho `bootstrap`/`identity`; `protect_mfa_*` chỉ cho `bootstrap` xóa 2FA Root; `guard_root_not_iam_subject` chặn gắn role/boundary/rule cho Root.
2. Đích luôn tra qua view chỉ-IAM (`iam_account`/`account_directory`): Root và id vắng cùng `404`.
3. Declarations không khai báo action nào nhắm Root; test declarations (mục Kiểm chứng) ghim điều này.
4. API không giữ login `bootstrap`.

**Không có R6:** người dùng không muốn Root-only cho đích IAM giữ permission quản trị. Hệ quả chấp nhận ở mục Rủi ro.

### 2. Bất biến cứng của mọi lệnh tác động lên tài khoản (code, trong exclusive fence, mỗi cái có test riêng)

Áp cho assign/revoke role, suspend, reactivate, đổi email, reset MFA, đổi binding, bind boundary. Root là actor thì chỉ áp (a) và (b) (Root ngoài IAM nên không áp (c)(d)).

- (a) **Không tự tác động:** `actor === target` → `403 error.accessDenied` (kiểm sau tra đích để Root/vắng vẫn `404`).
- (b) **Đích phải IAM** qua `iam_account` (Root và vắng cùng `404`).
- (c) **Quy tắc tập con khi gán role:** actor IAM chỉ gán được role mà **mọi grant của role** nằm trong tập grant hiệu lực của actor (xem §3).
- (d) **Đích không lớn hơn actor:** tập grant hiệu lực của đích phải ⊆ tập của actor; ngược lại `404` (như vắng, không lộ). Cùng tập thì cho phép.
- (e) Boundary: chỉ gán boundary mà mọi entry là permission `required`; một binding mỗi (user, permission); dòng `seed_owner` không bao giờ sửa (trigger).

Tập grant hiệu lực của một principal = tập các bộ `(permission, template.key, template.version, parameters chuẩn hóa)` từ grant `allow` của mọi role đang giữ (cả code lẫn runtime). **Fail closed:** có bất kỳ `deny` hay rule gắn thẳng user (không có đường UI tạo) trong tập đọc được thì phép so sánh coi là không chứng minh được → từ chối. Hai grant cùng permission nhưng khác template hay parameters là **không so sánh được** → từ chối (không giải containment của biểu thức tùy ý, đúng `permission-boundaries.md`).

Hạn chế đã biết: AST scope không có phủ định hay so sánh với principal đích; (a)(c)(d) là mã kiểm trong transaction (ranh giới developer), không phải boundary AST hay ràng buộc DB.

### 3. Role runtime (Q0 = b)

Người dùng tạo role và chọn grant qua UI. Không vi phạm bất biến "không sửa code-owned definitions qua UI": role/grant do release sở hữu (`managed_by='code'`) vẫn bất biến (trigger `protect_product_rows` từ chối mọi login runtime, kể cả `authority`); role do UI tạo là `managed_by='runtime'`.

- **Lưu:** `role_definition(managed_by='runtime')` + `policy_rule(role_key, effect='allow', managed_by='runtime')`. Không bảng mới. FK của `policy_rule` buộc `(permission, template)` phải có trong catalog; không ghi `deny`, không ghi rule gắn user, không `system_owner`.
- **Chỉ chọn từ catalog:** grant của role runtime là bộ `(permission, template.key, template.version)` đã đăng ký trong release; `parameters` phải đúng `{}` hoặc đúng bộ tham số template khai báo (validate bằng core như `validateReleaseContent`); template phải thuộc resource của permission (DB FK không kiểm điều này, nên lệnh kiểm và planner fail closed). Không biểu thức tùy ý, không SQL, không JSON AST do người dùng cấp. Nhờ vậy phép so sánh tập con (§2) tính chính xác bằng so sánh bộ.
- **Ai tạo/sửa:** Root không bị ràng buộc tập con (ngoài IAM): tạo được role chứa mọi permission trong catalog, kể cả permission quản trị. Actor IAM chỉ tạo/sửa role mà grant ⊆ tập hiệu lực của mình; sửa role chỉ khi tập hiện tại của role cũng ⊆ tập của mình (không động vào role lớn hơn mình). Role runtime có thể được sửa/xóa bởi bất kỳ ai có permission `role.update`/`role.delete` và thỏa các điều kiện đó (không có "chủ role").
- **Key:** `custom.<tên>` với `<tên>` khớp `^[a-z][a-z0-9_]{1,40}$` (tổng ≤ 96 byte như cột `bytea`). Tiền tố `custom.` **dành riêng** cho runtime: `prepareProductRelease` từ chối role release có tiền tố này (như `system.`), migration thêm CHECK `managed_by='runtime' ⇔ key bắt đầu bằng 'custom.'` (kiểm dữ liệu hiện có ở T1 trước khi thêm), nên sync không bao giờ đụng chỗ.
- **Giới hạn:** tối đa 100 role runtime, 300 grant mỗi role, nhãn ≤ 120 ký tự không ký tự điều khiển (đếm và kiểm trong cùng transaction `admin`).
- **Xóa/sửa khi có người giữ:** **chặn xóa khi còn tài khoản giữ** (`409 error.conflict`); không có thu hồi hàng loạt trong UI (thu từng tài khoản qua `account.revokeRole`, mỗi lần qua bất biến §2). Sửa grant của role đang có người giữ được phép (thêm chỉ ⊆ tập actor; bớt luôn được) và có hiệu lực ngay ở request kế tiếp của người giữ. Đổi key không có (key bất biến); chỉ đổi nhãn và tập grant.
- **Đọc ma trận:** role code từ release (`createProductRelease(core)`, bất biến, không DB) và role runtime từ DB; response gắn `source: 'code' | 'runtime'`.
- **Sync và hash:** `sync` không đè/xóa/đổi role runtime (trigger `protect_product_rows` từ chối `sync` đụng dòng không `code`; seed từ chối `collision`). **Release hash, `releaseContentHash` và `materialized_hash` không đổi** vì role runtime nằm ngoài `ProtectedStateRepository.codeOwned` (đã kiểm `protected-state.repository.ts`; chưa kiểm mọi nơi khác ngoài file đó, T1 xác nhận bằng test: tạo role runtime rồi chạy sync/drift check, hash giữ nguyên). `authz_state.revision` tăng như mọi lệnh `admin`.
- **Trigger đủ chưa:** đủ để bảo vệ dòng code-owned; **chưa đủ** để ràng buộc dòng runtime (không kiểm key prefix, `effect='allow'`, `parameters`, template-resource, số lượng). Phần đó là CHECK mới (key, effect, rule không gắn user cho runtime) + mã lệnh kiểm trong fence exclusive (số lượng, template hợp lệ). Cần migration `114` (mục Kế hoạch).
- **ACL login `authority`:** không thêm gì (đã có INSERT/UPDATE/DELETE hai bảng); probe `expectedPrivileges` giữ nguyên. Cân nhắc thu hẹp (ví dụ chỉ `policy_rule` cho dòng runtime) là việc probe không biểu diễn được theo dòng; ghi là rủi ro (login `authority` về mặt DB vẫn tạo được `deny`/rule theo user).
- **Audit:** `permission.role-create|role-update|role-delete|role-assign|role-revoke`; chỉ key role, số grant, hash chuẩn của tập grant, `actor`, `permission`, target `userId` (cho assign/revoke); không ghi email, `sub`.
- **Fence:** mọi lệnh ghi role là mode `admin` (exclusive fence, `revision+1`); thứ tự khóa: fence → authorize permission + khóa role (nếu có) → khóa `app_user` đích `FOR NO KEY UPDATE` (assign/revoke) → đọc lại facts actor/target trong cùng transaction → ghi → audit. Thu hồi có hiệu lực ở request kế tiếp, không cache.

### 4. Boundary `required` và đường ghi binding (Q1)

Giữ nguyên `boundary: 'required'` cho mọi action tác động principal khác (root `AGENTS.md`). Đề xuất nhỏ nhất, **chờ người dùng xác nhận (câu hỏi Q1 ở cuối)**:

- Release thêm boundary code-owned **`accountAdministration@1`** (scope hằng `true`, như `hrAdministration`) chứa các action `required` mới. Binding chỉ là "công tắc bật rõ ràng cho từng người", không thu hẹp phạm vi; phạm vi do grant và bất biến §2 quyết.
- Action `boundary.bind`/`boundary.unbind` (permission thường, `required` + `fresh@1`): ghi **cả gói** binding của một boundary cho một tài khoản (một dòng mỗi permission trong boundary, một transaction). Root gắn không bị ràng buộc; actor IAM chỉ gắn được boundary **cùng `(key, version)` với binding chính mình đang giữ** cho từng permission trong gói (không cho phép so sánh scope khác nhau), thêm (a)(b)(d).
- Không có binding ngầm theo role (đúng `permission-boundaries.md`: boundary không kế thừa từ role); gán role **không** tự bật binding. UI gán role hiển thị trạng thái thiếu binding.
- Binding lần đầu của người giữ quyền quản trị đầu tiên chỉ Root làm được (chưa ai có binding để ủy quyền).

Phương án thay thế đã cân nhắc: bỏ `required` cho action account (trái AGENTS root, không có phương án thay an toàn → không chọn); binding kèm role (boundary kế thừa từ role → loại).

### 5. Setting (không fresh)

- Bảng `system_setting` (current: `key`, `value jsonb`, `version`, `updated_at`, `updated_by`) và `system_setting_history` (append-only: `key`, `version`, `old_value`, `new_value`, `changed_by`, `changed_at`), migration `113`; `product_data` có SELECT hai bảng, INSERT history, INSERT và UPDATE (`value`, `version`, `updated_at`, `updated_by`) current, **không DELETE**. Registry key do code sở hữu (`setting.registry.ts`: kiểu, min, max, default). **Giá trị hiệu lực = dòng DB nếu có, ngược lại default trong code**; không seed dòng nào. `expectedVersion` bắt buộc (`409` khi lệch); key lạ, sai kiểu, ngoài min/max → `400`.
- Đọc qua `SettingRepository` với `EntityManager` của transaction nghiệp vụ (cùng transaction, không cache, không TTL); đọc không khóa, một quyết định dùng giá trị tại lúc đọc.
- Ghi: `ProductCommand` mode `write` (shared fence), audit `setting.update` (key, version; giá trị nằm trong history). Hai permission (Q3): **`setting.updateRule`** (nhóm nhân sự) và **`setting.updateProfile`** (thông tin công ty), policy thường (`hrWrite`), `boundary: 'optional'`; đọc: `setting.read`; riêng thông tin hiển thị cho mọi người đăng nhập (tên công ty, ngôn ngữ mặc định trong app) qua `setting.readProfile`. Grant mặc định do release cấp như mọi permission HR (không hardcode role trong code). Q8: thông tin công ty chỉ dùng **trong app** (không endpoint công khai); không có "múi giờ hiển thị".
- **Không hồi tố:** định mức mặc định chỉ dùng khi `createEmployee(official)`/`confirmOfficial` ghi dòng `leave_rate` (đã ghi thì không đổi); giới hạn WFH và cửa sổ nộp đơn chỉ ảnh hưởng đơn nộp/duyệt **sau** thay đổi; snapshot kỳ đã chốt không đổi.
- **WFH limit (Q4):** đã kiểm: snapshot **không** lưu `overLimit` (`attendance-snapshot.helper.ts`), và `report-sheet.repository.ts` tính nó sống từ `wfhDays` và hằng. Chọn **(a)**: báo cáo dùng giá trị hiện hành; hệ quả chấp nhận: đổi ngưỡng đổi nhãn `overLimit` của tháng cũ (cả tháng đã chốt) trong báo cáo, không đổi `wfhDays`; lịch sử đổi nằm ở `system_setting_history`. Khuyến nghị (không bắt buộc): báo cáo WFH trả kèm giá trị ngưỡng đã dùng.

Danh sách setting ban đầu (key, kiểu, mặc định, min..max, nơi dùng); các hằng không liệt kê ở đây **không** chỉnh được:

| Key                            | Kiểu           | Mặc định                    | min..max                                 | Nơi dùng (file hiện tại)                                                                                          |
| ------------------------------ | -------------- | --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `hr.annualLeaveDefaultMinutes` | int phút       | 5760                        | 5760..175680 (CHECK DB của `leave_rate`) | `employee.validator.ts` (`DEFAULT_ANNUAL_LEAVE_MINUTES`), `employee-command.repository.ts`                        |
| `hr.wfhMonthLimit`             | int ngày       | 4                           | 0..31                                    | `attendance-facts.helper.ts` (`WFH_MONTH_LIMIT`), `attendance-effect.repository.ts`, `report-sheet.repository.ts` |
| `hr.requestWindowPastDays`     | int ngày       | 7                           | 0..31                                    | `work-request.service.ts` (SQL `BUSINESS_TODAY - 7`)                                                              |
| `hr.requestWindowFutureDays`   | int ngày       | 90                          | 0..365                                   | `work-request.service.ts` (`BUSINESS_TODAY + 90`)                                                                 |
| `hr.requestMaxDays`            | int ngày       | 31                          | 1..31 (chỉ hạ)                           | `work-request.validator.ts` (`MAX_DAYS`)                                                                          |
| `report.maxMonths`             | int tháng      | 12                          | 1..12 (chỉ hạ)                           | `report.validator.ts` (`REPORT_MAX_MONTHS`)                                                                       |
| `export.maxRows`               | int            | 5000                        | 1..5000 (chỉ hạ)                         | `excel-export.service.ts` (`EXPORT_MAX_ROWS`)                                                                     |
| `export.maxBytes`              | int byte       | 5242880                     | 1048576..5242880 (chỉ hạ)                | `excel-export.service.ts` (`EXPORT_MAX_BYTES`)                                                                    |
| `company.name`                 | text 1..120    | rỗng (UI dùng tên sản phẩm) | không ký tự điều khiển                   | web (`setting.readProfile`)                                                                                       |
| `company.defaultLocale`        | enum `vi`/`en` | `vi`                        |                                          | web, khi người dùng chưa có preference `hrm.locale`                                                               |

**Không chỉnh được** (lý do): `DAY_MINUTES = 480` và ca 09:00–13:00/14:00–18:00 (`attendance-calculation.helper.ts`; bảng công, snapshot kỳ chốt format 1/2 và ledger tính bằng phút, web hardcode cùng giá trị); quy tắc tích lũy phép (ngày 15, `floor(R*k/12)`, không chuyển năm; số dư không lưu nên đổi quy tắc là đổi hồi tố mọi số dư); `BUSINESS_TODAY` múi `Asia/Ho_Chi_Minh`; `MIN/MAX_ANNUAL_MINUTES`, `MAX_ADJUSTMENT_MINUTES` (CHECK DB); phân trang (mặc định 20, tối đa 100, offset ≤ 10000); anchor id. Không có hằng "ngưỡng đi muộn": đi muộn/về sớm là loại đơn cộng phút từ segment đã duyệt; một ngưỡng như vậy là nghiệp vụ mới, ngoài ADR này.

**Bảo mật/phiên chỉ xem:** API trả DTO allowlist các giá trị đang hiệu lực: fresh 300 s (`product-identity.service.ts`), phiên 12 giờ (SQL `createSession`), cửa sổ rate limit 15 phút, và config không nhạy cảm; **không** trả khóa MFA, key ring, connection string, `APP_ORIGIN` kèm secret. Hiện các hằng này nằm rải rác; gom vào một file config làm nguồn duy nhất cho cả mã chạy lẫn trang xem (nếu không, giá trị hiển thị có thể lệch giá trị thật). Idle 30 phút ghi theo ADR 0026, **chưa kiểm vị trí trong code**; T1 phải tìm trước khi hiển thị.

### 6. Thao tác danh tính trên tài khoản IAM (permission thường, một bước)

Q5: một bước, `fresh@1` + `boundary: 'required'` + audit, không bắt buộc hai người. Action trên resource `account`: `reactivate`, `changeEmail`, `resetMfa`, `resetGoogleBinding` (cùng `suspend`, `provision`, `read` có sẵn), cùng bất biến §2.

- **Cơ chế DB (API không giữ credential bootstrap):** hàm SECURITY DEFINER hẹp, owner NOLOGIN riêng, `search_path` cố định, `REVOKE ALL FROM PUBLIC`, `EXECUTE` chỉ cho `product_authority` (mẫu `provision_oidc_account`, migration `013`), điều kiện cứng `kind='iam'`, chạy trong lệnh mode `admin` cùng transaction với quyết định quyền: `reactivate_iam_account` (đích `active` nếu có binding đang bật, ngược lại `pending`; `auth_epoch+1`), `change_iam_account_email` (`email_verified=false`, `auth_epoch+1` cùng UPDATE để thỏa `require_email_epoch`; trùng email kể cả Root → `409`), `reset_iam_mfa` (xóa `mfa_recovery_code` rồi `mfa_totp`; trigger `mfa_epoch` tăng `auth_epoch`), `reset_iam_google_binding`. **Không** dùng pool `identity` từ HTTP (tách quyết định quyền khỏi transaction và đưa cho handler login rộng).
- **Đổi binding (Q6 = a): đổi luồng OIDC.** Hàm vô hiệu hóa (không xóa) binding hiện tại, đưa tài khoản về `pending`, tạo `oidc_email_enrollment` mới 7 ngày và `auth_epoch+1`; `liveEnrollment`/`bindEnrollment` phải chấp nhận tài khoản `pending` mà mọi binding đã `enabled=false` (hiện chỉ `NOT EXISTS external_identity`). Giữ nguyên xác thực issuer/`email_verified === true`/state/nonce/PKCE, một lần, chống replay. Cần ADR chi tiết trong đợt 4 và test đăng nhập; trường hợp `(issuer, sub)` cũ đăng nhập lại tài khoản này sau khi đã bị vô hiệu hóa phải bị từ chối. `protect_account_lifecycle` cấm `authority` đổi trạng thái: hàm definer chạy dưới owner nên phải kiểm lại trigger xét `current_user` (**giả định, T1 kiểm trên PostgreSQL thật**).
- **Phiên và secret:** mọi thao tác tăng `auth_epoch` (phiên cũ chết); không trả/log/audit email, `sub`, secret, mã khôi phục; reset MFA không tạo secret cho actor (đích tự đăng ký lại). Audit `account.reactivate`, `identity.email-change`, `identity.mfa-reset-by-permission`, `identity.binding-reset` (actor, permission, target `userId`, kết quả), atomic cùng mutation.
- **Un-suspend:** đảo `suspendUser`: tra qua `iam_account`, `actor === target` → `403`, hàm `reactivate_iam_account`; không khôi phục phiên (epoch mới).
- Biện pháp giảm thiểu **không bắt buộc**: rate limit số thao tác danh tính mỗi actor, cooldown sau khi đổi, banner "danh tính của bạn vừa bị đổi" ở lần đăng nhập kế (không có SMTP: ADR 0024 Deferred, không giả lập thông báo mail).

### 7. Menu và web

Menu `settings`, `roles`, `accounts` do server cấp theo permission (không theo role). Nhóm any-of vẫn tính phẳng vào `MAX_PERMIT_PROBES = 16` cặp (ADR 0017 bổ sung) và `me` đã dùng tới 14. **Quyết định Q17 (2026-10-24): gộp probe + `staleTime`.** Đưa probe của ba menu vào **cùng lượt `permitsMany` hiện có** của `menus` (không thêm lượt thứ hai, không thêm transaction read); khi tổng số cặp vượt 16 thì **nâng `MAX_PERMIT_PROBES` sau khi ĐO độ trễ** (đo trước, ghi chứng cứ vào ledger của đợt; không nâng theo suy đoán; any-of vẫn tính phẳng). Web thêm `staleTime` cho `useMenus()` để không tải lại menu mỗi lần focus cửa sổ. Cache menu theo revision **hoãn, không làm** (cần thiết kế invalidation, AGENTS.md cấm cache quyền khi chưa có bằng chứng). (Q10 ban đầu giả định any-of giảm số cặp; không đúng theo ADR 0017, ghi lại ở đây.) Web: `features/administration/` (số ít, `features/account` giữ cho tài khoản của chính mình), `menuSchema` ở `me.client.ts` nới thêm ba key, i18n `vi`/`en`, Mantine + token, không thêm key `error.*` mới (dùng `error.conflict`/`notFound`/`accessDenied`; web phân biệt trạng thái bằng GET).

### 8. `hr.coo` hardcode (Q9)

`work-request.service.ts` truy `user_role` theo `'hr.coo'`. Khi chưa có UI gán/tạo role, đây là nợ vô hại; **khi có UI gán/tạo role, nó trở thành sai ngữ nghĩa**: role runtime có đủ grant `decideFinal` vẫn không được coi là COO tự duyệt, và gán `hr.coo` đổi hành vi nghiệp vụ không thể thấy qua permission. **Đề xuất: sửa thành điều kiện theo permission (dùng `ctx.reaches('workRequest','decideFinal',…)` đã có, hoặc một permission khai báo riêng) làm task riêng, TRƯỚC đợt gán/tạo role** (đợt 3a trong kế hoạch). Không sửa trong ADR này; chưa đọc đủ `work-request.service.ts` để chốt thiết kế sửa (T1 của đợt 3a).

## Bất biến mới (thay cho câu cấm cũ)

Thay cụm "lấy quyền user admin để reset/link/impersonate global identity" (root `AGENTS.md`, mục Bất biến bảo mật) và các dòng tương ứng ở `apps/api/AGENTS.md` bằng:

1. Thay đổi danh tính toàn cục của tài khoản IAM (email, 2FA, binding Google) chỉ qua permission riêng `account.*`, luôn `boundary: 'required'` + `fresh@1` + audit, thu hồi mọi phiên của đích (`auth_epoch`) và không trả secret/mã khôi phục cho người gọi; **không có impersonate** (không đặt phiên hộ người khác).
2. **Root-only** = mọi hành động tác động lên tài khoản Root (bootstrap/reissue/revoke, đổi email, reset MFA, đổi binding, gán quyền, khôi phục): chỉ CLI offline có approval; không permission, không route HTTP; đích Root bị từ chối với mọi login runtime.
3. Mọi lệnh tác động lên tài khoản khác phải giữ bất biến cứng §2: không tự tác động, đích IAM, gán role/tạo role chỉ trong tập grant của mình, đích không lớn hơn mình.
4. Role/grant do UI tạo là `managed_by='runtime'`, chỉ chọn từ `(permission, template)` đã đăng ký; không sửa/xóa dòng `managed_by='code'` qua UI.

Những chỗ phải sửa khi triển khai (đánh dấu, không âm thầm): root `AGENTS.md` mục Bất biến bảo mật và Ranh giới (route provisioning); `apps/api/AGENTS.md` ("Không route HTTP cho provisioning…", "Identity không UPDATE binding nào…", "User admin không có capability…", "Reset 2FA chỉ là CLI offline…", "đường mới đổi email cần ADR"); ADR 0026 §10 (reset IAM thêm đường HTTP; reset Root vẫn CLI), ADR 0027 §6 và §9, ADR 0029 §6 (đổi email chỉ `pending`) và mục "Quyết định của người dùng" 1–2.

## Hệ quả

- Release mới theo từng đợt (dự kiến `17`…`20`, lấy theo thứ tự merge), hash release/bindings/canonical/OpenAPI đổi có chủ đích; mỗi release cần fixture `release-sixteen.ts` kiểu `release-fifteen.ts` (dựng lại từ nguồn hôm nay bỏ delta mới) và test nâng cấp. Migration `113` (setting), `114` (ràng buộc role runtime), product `021`/`022` (hàm definer, luồng binding, qua `db:provision`); xem kế hoạch.
- Nới có chủ đích: login `authority` thêm EXECUTE các hàm definer hẹp; không thêm quyền bảng nào (role/binding dùng quyền sẵn có).
- Cập nhật `docs/hrm-local-operations.md`, `apps/api/AGENTS.md`, OpenAPI, locale `vi`/`en`.

## Rủi ro đã chấp nhận (người dùng chốt hoặc hệ quả của quyết định)

- **Chiếm tài khoản bằng chuỗi đổi email + reset MFA (Q5):** người giữ cả `account.changeEmail` (hoặc `resetGoogleBinding`) và `account.resetMfa` có thể đổi email đích sang địa chỉ họ kiểm soát, reset 2FA, đăng nhập Google bằng email đó, đăng ký 2FA (ADR 0026 chấp nhận đăng ký 2FA lần đầu chỉ cần phiên) và có `fresh` với danh tính của đích. Bất biến (d) giới hạn đích không lớn hơn actor nhưng **không** ngăn chiếm người ngang quyền. Chủ dự án chấp nhận. Khuyến nghị vận hành: không cấp đồng thời hai nhóm permission này cho cùng một role nếu không cần; bật các biện pháp giảm thiểu không bắt buộc (rate limit, cooldown, banner).
- **Bỏ R6:** hai người cùng tập grant (kể cả quản trị) tác động được lẫn nhau, kể cả tước role/khóa/chiếm nhau; không có Root-only che chắn. Chỉ Root khôi phục được nếu cả hai bị khóa.
- Root tạo role gần như Root và gán cho IAM: người giữ role đó (và binding) làm được mọi thứ role cho phép, trừ Root-only; hạn chế duy nhất là (c)(d) với người gán IAM.
- Mất vòng "approval offline độc lập" cho reset MFA IAM (đổi lấy fresh + audit); reset MFA Root vẫn offline.
- `authority` về mặt DB vẫn ghi được `deny`/rule theo user/`record_exception`; bề mặt này không có route và phải giữ không có (test inventory), nhưng không bị DB chặn.
- Các bất biến §2 là mã (ranh giới developer), cần mutation test.
- Đổi ngưỡng WFH làm đổi nhãn `overLimit` của báo cáo tháng cũ (Q4 = a).
- Chưa có thông báo cho chủ tài khoản (không SMTP).
- `hr.coo` hardcode trong nghiệp vụ tới khi đợt 3a xong; **không mở UI gán role trước đợt đó**.

## Không đọc/chưa kiểm (giả định, T1 mỗi đợt xác minh)

`execute` có khóa được hàng qua view `account_directory` hay không (rất có thể không; tiền lệ `suspendUser`); hàm definer dưới `product_authority` có qua `guard_root_lifecycle`/`protect_mfa_*`/`protect_account_lifecycle`/`mfa_epoch` hay không; dữ liệu hiện có thỏa CHECK key `custom.` (role code hiện có, ví dụ role document); `authority_level` đã bị `012` xóa nên insert role không cần cột đó (đã đọc seed repository, chưa chạy); nơi đặt idle 30 phút; cột tên công ty không có trong `hr_company` (chưa thấy, grep migration không ra); CHECK DB cho `MAX_DAYS`; có nơi nào khác ngoài `ProtectedStateRepository` đọc `role_definition`/`policy_rule` vào hash. Chưa chạy test, lint hay DB cho ADR này.

## Kiểm chứng bắt buộc (khi triển khai)

- Test declarations: không action nào nhắm Root; mọi action ghi tác động principal khác `required` + `fresh@1`; role code không bị sửa (trigger); `custom.` bị release từ chối.
- Mỗi hàm definer: từ chối `kind='root'`, đích vắng; `auth_epoch` tăng; PostgreSQL thật.
- Bất biến §2 (a)–(e) có test riêng + mutation (bỏ từng cái làm test đỏ); matrix actor (Root; IAM đủ binding; thiếu binding; thiếu fresh; đích Root; tự tác động; đích lớn hơn; role vượt tập; template khác nhau).
- Sync và drift sau khi có role runtime: hash không đổi, role runtime không bị đè; release trùng key runtime bị `collision`.
- Đồng thời: hai gán cùng cặp một thành công; tạo role vượt giới hạn; xóa role khi có người giữ; audit lỗi rollback.

## Quyết định của người dùng (2026-10-23)

1. Q0 = (b): tạo role mới và gán permission cho role qua UI; role code vẫn bất biến (§3).
2. Q1: Root tạo role gần như Root; gán được nếu actor có permission gán; binding `required` cần một đường ghi — đề xuất §4 chờ xác nhận.
3. Q5: thao tác danh tính một bước, permission thường, fresh + audit; rủi ro được chấp nhận (mục Rủi ro).
4. Root-only chỉ gồm tác động lên chính tài khoản Root; không R6; Root dùng CLI offline (Q12 = a).
5. Setting: nhân sự + thông tin công ty chỉnh bằng quyền thường (không fresh), bảo mật chỉ xem; Q3 = hai permission; Q4: (a) theo kiểm snapshot; Q8 = chỉ trong app; Q6 = (a); Q7 = (a); Q9 = ghi nợ nhưng sửa trước đợt gán role; Q10: nhóm any-of không giảm số cặp.
6. Duyệt ADR 0041 (2026-10-24). Q1 = chấp nhận §4 (boundary `accountAdministration@1` scope hằng `true`, Root bật theo gói cho từng người, IAM chỉ ủy quyền cùng binding mình giữ); Q15 = `company.name` lưu ở `system_setting`, không cột mới; Q16 = cho role runtime chứa permission quản trị role, bị chặn bởi (c)(d) với IAM.
7. Q17 = gộp probe + `staleTime`: probe menu settings/roles/accounts vào cùng lượt `permitsMany` hiện có (không lượt thứ hai); nâng `MAX_PERMIT_PROBES` khi cần sau khi đo độ trễ và ghi chứng cứ (any-of vẫn tính phẳng); web thêm `staleTime` cho `useMenus()`; cache theo revision hoãn.

## Câu hỏi còn mở

Không còn. Q1, Q15, Q16, Q17 đã đóng khi duyệt ngày 2026-10-24 (xem "Quyết định của người dùng" mục 6–7).
