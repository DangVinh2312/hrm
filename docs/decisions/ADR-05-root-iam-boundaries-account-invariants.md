# ADR-05 — Root ngoài IAM, IAM không rank, boundary và bất biến tác động tài khoản

Thay thế các ADR cũ: 0007, 0012, 0022, 0027, 0041, 0046 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Code: `authorization/core/authorization.planner.ts` (`planUnrestricted`), `authorization/services/product-authority.service.ts`, `product-account.service.ts`, `product-root.service.ts`, `product-root-lifecycle.service.ts`, `authorization/helpers/grant-set.helper.ts` (`compareGrantSets`, `targetAccess`), `authorization/repositories/grant-facts.repository.ts`, guard Root ở `database/migrations/001-product-baseline.migration.ts`. Hợp đồng boundary: [permission-boundaries](../permission-boundaries.md), lõi ở [ADR-02](ADR-02-authorization-core-and-value-codecs.md).

## Quyết định

### Root ngoài IAM

- `app_user.kind ∈ {root, iam}`; tối đa một Root (partial unique index). Root không có role, grant, boundary, record exception hay direct rule (`guard_root_not_iam_subject`). Đây là auth cho một tổ chức cố định, không phải SaaS: Root là super admin của chính tổ chức, như AWS root so với IAM user.
- Root bypass mọi kiểm tra phân quyền qua `planUnrestricted` trên mọi resource/action đã khai báo, kể cả action thêm sau. `kind` chỉ lấy từ `resolve_session` trong fenced transaction ([ADR-04](ADR-04-database-logins-acl-probes.md)); tên role không bao giờ tạo bypass. Nơi gọi `planUnrestricted` bị ESLint `no-restricted-syntax` giới hạn (ranh giới developer, không phải sandbox); provenance chỉ evaluator kiểm.
- Root vẫn phải qua: session hợp lệ, `auth_epoch`, không suspended, CSRF/Origin; action phải đã khai báo; projection và writable allowlist.
- Root cần fresh khi và chỉ khi policy của action có `fresh@1`, mọi mode kể cả read. `planUnrestricted` tra policy như `planUser` (binding khớp action, policy tồn tại, chưa `retired`) rồi chạy `contextRequirements` của policy; thiếu hay sai thì deny. Root bỏ qua grant, boundary (kể cả requirement của boundary entry) và `requiredScope`; vì vậy yêu cầu fresh của action nhạy cảm phải nằm ở policy, không ở boundary. Đổi action sang nhạy cảm là đổi policy trong release, không thêm nhánh Root.
- Guard trạng thái nghiệp vụ nằm trong command, không trong scope: Root bỏ qua `requiredScope` nên Root quyết/hủy đơn ở giai đoạn sai phải nhận 409 và không đổi dữ liệu.
- Máy kiểm: test manifest/composition buộc mọi action `boundary: 'required'` và mọi `ProductCommand` mode `admin` có policy chứa `fresh@1`; thêm action facts mới thiếu fresh thì test fail.
- Mọi `access` của Root commit đều audit: một event cho mỗi `access` (`principalKind: 'root'`, `outcome` `ok`/`absent`), ghi trực tiếp, không qua obligation registry; denied không audit. Event obligation `audit@1` của IAM giữ dạng riêng ([ADR-07](ADR-07-audit-and-outbox.md)). Tên event của Root là `access.<resource>.<action>` (ví dụ `access.employee.reportAttendance`, `access.account.readPermissions`) và là hợp đồng mà test đọc. Rủi ro chấp nhận: mọi resource/action thêm sau tự động mở cho Root.

### Nguồn thời gian

- Đồng hồ DB là nguồn duy nhất cho mọi quyết định hiệu lực: `timestamptz`, `statement_timestamp()`, UTC, độ chính xác µs. Gồm fresh của phiên (`PRODUCT_FRESH_AUTH_SQL`, 300 giây), hết hạn token/attempt/phiên, `authenticated_at` thiếu claim (lấy `statement_timestamp()`), `auth_time` nếu có. Không `Date.now()`/`new Date()` trong quyết định auth (test cấu trúc cho `authentication/**` và `authorization/services/**`).
- Phía API dùng Day.js UTC (plugin `utc` + `customParseFormat` strict) cho parse/format thời điểm; output API luôn ISO-8601 UTC có `Z`. `Max-Age` cookie phiên là số giây còn lại do DB tính cùng statement tạo phiên.
- Thời lượng (deadline, lock, metrics của runner) đo bằng `performance.now()`, không dùng để quyết định hiệu lực. Web chỉ hiển thị, `Intl` với `timeZone` tường minh.
- `openid-client` kiểm `exp`/`iat`/`nbf` bằng giờ máy API cộng tolerance của thư viện: lọc sơ bộ trước khi vào DB, không phải quyết định cuối.
- Đồng hồ DB bị chỉnh lùi: `reauthenticated_at`/`authenticated_at` có thể nằm sau `statement_timestamp()`, fresh trả "không đạt" (fail closed, không dung sai). Yêu cầu vận hành: máy DB đồng bộ NTP chỉ slew sau khi boot (không `makestep` ngoài lúc khởi động) và giám sát step của đồng hồ; step lùi là sự cố vận hành. Khoảng thực tế từ lúc đăng nhập tới hết fresh có thể tới hai cửa sổ 300 giây liên tiếp; chấp nhận.

### Vòng đời Root (chỉ CLI offline)

- Root-only là mọi hành động tác động lên chính tài khoản Root: bootstrap/reissue/revoke, đổi email, reset MFA, đổi binding, gán quyền (không tồn tại), khôi phục. Chỉ CLI offline có approval (`root:bootstrap|reissue|revoke|set-email|reset-mfa`, cờ `--approval`/`--reason` khi ghi hủy); không permission, không route HTTP; đích Root bị từ chối với mọi login runtime. Luồng tạo/kích hoạt Root theo email ở [ADR-06](ADR-06-google-auth-sessions-2fa.md).
- Bảo đảm bằng nhiều lớp, không chỉ ẩn nút: hàm `SECURITY DEFINER` có điều kiện cứng `kind = 'iam'`; `guard_root_lifecycle` chỉ cho `bootstrap`/`identity`; `protect_mfa_*` chỉ cho `bootstrap` xóa 2FA của Root; `guard_root_not_iam_subject` chặn gắn role/boundary/rule cho Root; đích luôn tra qua view chỉ-IAM (`iam_account`/`account_directory`) nên Root và id vắng cùng `404`; declarations không khai báo action nào nhắm Root (test ghim); API không giữ login `bootstrap`.
- `bootstrap` chuyển một account `pending` từ `iam` sang `root` đúng một lần cùng marker bền vững (`guard_root_kind`: READ COMMITTED, chưa marker, chưa có Root, đích không giữ fact IAM hay token kích hoạt còn sống, `require_root_marker_kind` deferred). Promotion khóa `FOR NO KEY UPDATE` dòng đích trước khi kiểm; guard gắn fact/token đọc `kind` bằng `FOR SHARE`. Lock ordering chỉ cam kết cho cặp promotion và gắn fact/token; xung đột với SQL ngoài runner thì fail closed và runner retry `40P01` hữu hạn.
- `revoke-root` = suspend + tăng `auth_epoch`, marker giữ nguyên nên không bao giờ có Root mới. `set-root-email` (Root `active` tạo trước, dữ liệu cũ) gán email mới chưa xác minh và tăng `auth_epoch` cùng UPDATE. `reset-mfa` của Root chỉ bootstrap, và guard Root cho tăng epoch khi Root không còn factor.
- Repair gỡ suspend Root chỉ offline do owner bảng: một transaction `DISABLE TRIGGER guard_root_lifecycle` → `UPDATE` đúng dòng Root → `ENABLE`; không ghi `audit_outbox`, bằng chứng là hồ sơ approval (reference, người duyệt, thời điểm, câu SQL). DB không chặn owner.

### IAM không rank, boundary

- IAM không có rank ngầm (`authority_level`, `account_rank` đã bỏ). Bảo vệ giữa các IAM principal chỉ bằng grant, deny và permission boundary; default deny, deny thắng allow, permission policy nằm ngoài mọi grant. Hai IAM ngang quyền tác động được lẫn nhau (đúng mô hình IAM).
- Action tác động principal khác phải khai báo `boundary: 'required'`. `account.provision|suspend|reactivate` là `required`, fresh, không grant mặc định; hiện chưa có boundary code-owned nào phủ `account.*`, nên chỉ Root dùng được chúng qua HTTP cho tới khi release thêm boundary và có đường ghi binding.
- Action khai báo `boundary: 'required'` (thiếu binding là deny) hoặc `'optional'` ([ADR-02](ADR-02-authorization-core-and-value-codecs.md)); boot chỉ cập nhật seed code-owned, không ghi đè binding runtime.
- Boundary không phải grant: không cấp quyền, AND ngoài mọi allow kể cả record exception, một binding cho mỗi `(user, permission)`, không kế thừa từ role (gán role không tự bật binding), definition version bất biến, thiếu facts hoặc không chứng minh được subset thì deny. `ApplicationRoleBoundary` chỉ là ví dụ cấu hình, không hardcode vào lõi. Assignment boundary chỉ hạn chế các lần gán sau, không thu hồi quyền đã cấp. Chi tiết và bảng test ở [permission-boundaries](../permission-boundaries.md).
- Không tên role nào xuất hiện trong guard, boundary, điều kiện hay thông điệp: "Admin" chỉ là role tạo trong hệ thống, mọi thứ là permission; quyền tuyệt đối vẫn là Root.

### Bất biến mọi lệnh tác động lên tài khoản khác

Áp cho khóa, khôi phục và (khi có) gán/thu hồi role, đổi email, reset MFA, đổi binding, bind boundary. Là mã kiểm trong exclusive fence (mode `admin`), mỗi bất biến có test riêng kèm mutation; không phải ràng buộc AST hay DB.

- (a) Không tự tác động: `actor === target` thì `403 error.accessDenied` (kiểm sau khi tra đích, nên Root/vắng vẫn `404`; trước kiểm trạng thái).
- (b) Đích phải IAM qua `iam_account`/`account_directory`; Root và vắng cùng `404`; id không chuẩn `403` trước mọi truy vấn.
- (c) Gán/tạo role: actor IAM chỉ gán hay tạo role mà mọi grant nằm trong tập grant hiệu lực của mình.
- (d) Đích không lớn hơn actor: tập grant hiệu lực của đích ⊆ tập của actor, ngược lại `404` (như vắng, không lộ); với `reactivate` đứng trước kiểm trạng thái 409. Cùng tập thì cho phép.
- (e) Boundary: chỉ gán boundary mà mọi entry là permission `required`; một binding mỗi `(user, permission)`; dòng `seed_owner` không bao giờ sửa (trigger).
- Root là actor chỉ chịu (a) và (b) (Root ngoài IAM nên không chịu (c)(d)); Root làm được role chứa mọi permission trong catalog.
- Tập grant hiệu lực = tập `(permission, template.key, template.version, parameters chuẩn hóa)` của grant `allow` mọi role đang giữ, code lẫn runtime; so sánh bằng `canonicalJson` nên thứ tự khóa không đổi kết quả. `compareGrantSets(target, actor)` trả `within` | `larger` | `incomparable` (cùng permission khác template/version/parameters) | `unprovable` (có `deny` hoặc rule gắn thẳng user ở một trong hai phía). `targetAccess`: Root `proceed` luôn; IAM `proceed` chỉ khi `within`, còn lại `not_found`. Bất kỳ trường hợp không chứng minh được (deny, rule user, khác template/tham số, facts bị cắt) là từ chối, không giải containment của biểu thức tùy ý.
- `GrantFactsRepository.read` đọc facts của actor và đích trong MỘT câu `SELECT` (không N+1, không cache), trần 20000 dòng; bị cắt thì coi là không chứng minh được (`404`). (d) hiện áp cho `account.suspend` và `account.reactivate`; chỉ tính grant `allow` của role, không tính `record_exception` hay binding boundary.

### Thao tác danh tính toàn cục (đổi ngày hiệu lực theo đợt)

Bất biến thay thế câu cấm cũ "lấy quyền user admin để reset/link/impersonate global identity": thay đổi danh tính toàn cục của tài khoản IAM (email, 2FA, binding Google) chỉ qua permission riêng `account.*` (không theo tên role), luôn `boundary: 'required'` + `fresh@1` + audit, tăng `auth_epoch` của đích (mọi phiên chết), không trả secret hay mã khôi phục cho người gọi, không impersonate; thực hiện bằng hàm `SECURITY DEFINER` hẹp `kind = 'iam'` trong lệnh `admin` cùng transaction với quyết định quyền, không bằng pool `identity` từ HTTP.

- Đã triển khai: `account.reactivate` ([ADR-04](ADR-04-database-logins-acl-probes.md)), bất biến (d) cho khóa/khôi phục, role runtime, gán/thu hồi role và bind/unbind boundary ([ADR-13](ADR-13-runtime-roles-assignment-boundary-binding.md)). Chưa triển khai và chưa có route hay permission: `account.changeEmail`, `account.resetMfa`, `account.resetGoogleBinding`; bao giờ chưa có, vẫn cấm lấy quyền user admin làm việc đó. Hiện chỉ reset 2FA của IAM có CLI offline có approval (`identity:reset-mfa`, [ADR-06](ADR-06-google-auth-sessions-2fa.md)); đổi email và đổi binding Google của IAM chưa có đường nào, kể cả CLI. Chi tiết đường đổi binding (vô hiệu binding, `pending`, enrollment mới 7 ngày) cần ADR riêng khi làm.
- Role/grant do UI tạo là `managed_by = 'runtime'`, chỉ chọn từ `(permission, template)` đã đăng ký; role code-owned bất biến qua UI ([ADR-13](ADR-13-runtime-roles-assignment-boundary-binding.md)). Boundary `accountAdministration@1` (scope hằng `true`, Root bật theo gói cho từng người, IAM chỉ ủy quyền binding cùng `(key, version)` mình đang giữ) đã triển khai (ADR-13 D5).

## Quyết định của người dùng

- Root ngoài IAM, không rank; Root chỉ cần fresh theo `fresh@1` của policy (2026-10-18); mất Google của Root thì khôi phục ở Google, chặn truy cập bằng `root:revoke`.
- Root-only chỉ gồm tác động lên chính tài khoản Root, dùng CLI offline (không HTTP). Không có R6: không Root-only che chắn cho IAM giữ quyền quản trị.
- Thao tác danh tính IAM sau này là permission thường, một bước, fresh + audit, không bắt buộc hai người; đồng hồ DB lệch lùi giữ semantics fail closed kèm yêu cầu vận hành NTP.
- Root tạo được role gần như Root và gán nếu actor có permission gán; IAM bị chặn bởi (c)(d).

## Chưa làm / điều mở

- Rủi ro chấp nhận: lộ session Root cho phép đọc mọi dữ liệu và ghi các action không có `fresh@1`; credential `identity` bị lộ tạo được session Root active. Giảm thiểu bằng audit mọi access Root, hạn session và 2FA.
- Hai người ngang quyền khôi phục/khóa/tước role lẫn nhau; chỉ Root khôi phục được nếu cả hai bị khóa. Người giữ cả `account.changeEmail` (hoặc `resetGoogleBinding`) lẫn `account.resetMfa` có thể chiếm người ngang quyền; khuyến nghị vận hành không cấp đồng thời hai nhóm cho một role, rate limit/cooldown/banner là biện pháp chưa bắt buộc.
- (d) bảo thủ, nhiều từ chối giả (khác template/tham số, mọi rule gắn user); `authority` về mặt DB vẫn ghi được `deny`/rule theo user nhưng không có route.
- Chưa đo timing giữa Root và id vắng ở `suspend`. Mất Root đã revoke cần repair offline có duyệt.
- Boundary kế thừa từ role hoặc nhiều binding chưa chọn; chỉ mở khi có use case và semantics phép giao được kiểm chứng.
- Không có thông báo cho chủ tài khoản khi danh tính bị đổi (không SMTP).
