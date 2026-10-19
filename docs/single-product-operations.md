# Vận hành local và các gate triển khai

Các lệnh pnpm chạy từ workspace root, forward tới API với cwd `apps/api`. Env nằm trong `apps/api/`; dùng absolute path cho activation artifacts. [ADR 0015](decisions/0015-app-owned-tooling.md) mô tả ownership tooling.

Runtime mới: [architecture](authz-single-product-architecture.md), [ADR0008](decisions/0008-single-product-runtime-transition.md). Chỉ dùng disposable/local database cho các lệnh thử. Không dùng credentials staging/production để kiểm chứng.

## 1. Setup local

Node theo `.nvmrc`, pnpm theo `package.json#packageManager`. Cài đúng lockfile:

```sh
pnpm install --frozen-lockfile
cp apps/api/.env.ops.example apps/api/.env.ops
cp apps/api/.env.example apps/api/.env.api
```

Tạo password ngẫu nhiên riêng cho bảy mục đích (thêm `outbox` từ ADR0011); không đưa vào CLI arguments, source hoặc chat. Điền `apps/api/.env.ops` và URLs tương ứng trong `apps/api/.env.api`. API chỉ nhận data/identity/authority/sync; không source `apps/api/.env.ops` vào shell chạy API. Config chủ động từ chối migration/bootstrap/admin URLs trong process API. File mẫu không chứa credentials thật.

Thêm `POSTGRES_ADMIN_USER`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_PORT` vào `apps/api/.env.ops` để Compose local đọc; `DATABASE_ADMIN_URL` phải trỏ cùng PostgreSQL. Chạy:

```sh
docker compose -f apps/api/compose.yaml --env-file apps/api/.env.ops up -d postgres
pnpm run db:provision
pnpm run db:migrate
pnpm run manifest:sync
```

`db:provision` thu hồi TEMP của PUBLIC trên database (runtime không cần temp object) và tạo một database theo `PRODUCT_DATABASE_NAME`, các login `product_data/identity/authority/sync/migration/bootstrap/outbox` và NOLOGIN function owners. Nâng cấp lên migration 009–011: thêm `PRODUCT_OUTBOX_PASSWORD` vào `apps/api/.env.ops` rồi chạy lại `db:provision`. Runtime không owner/superuser/CREATE ROLE/SET ROLE lên owner. `db:migrate` dùng migration login riêng và áp cả migration ứng dụng (document fixture, HR). `db:provision` cũng áp chúng sau product migrations: migration HR (ADR 0016) đổi owner hàm `hr_register_object` sang role NOLOGIN `product_object_owner` nên chỉ chạy được khi provisioning cấp membership tạm. Boot không chạy migrations. Nâng cấp lên bản có product migration mới (vd. 008 đổi owner function sang `product_session_owner`) phải chạy lại `db:provision` (idempotent: cấp tạm membership owner roles cho migration login, áp product migrations rồi thu hồi) rồi mới `db:migrate` cho migration của ứng dụng; chỉ chạy `db:migrate` thì migration cần owner role bị từ chối. Provision/migrate/sync lặp trên fixture đã được kiểm; passwords của role đã tồn tại không bị tự xoay bằng provision.

Database đã có `tenant_anchor` hoặc `identity_record` bị từ chối thay vì gộp dữ liệu. Dừng phần chuyển dữ liệu thật cho tới khi có mapping user/identity/authority, collision review, backup/restore và authorization cụ thể. Không xóa bảng tenant để vượt gate. Product migration nâng version identity edges cũng từ chối tuple cũ chưa có version thay vì đoán.

## 2. Root bootstrap và activation

Boot chỉ đồng bộ definitions/grants code-owned; không tự tạo Root. `root:bootstrap` chuyển đúng một account pending `kind = 'iam'` (đã enroll) thành `kind = 'root'` cùng marker, đúng một lần (ADR 0012); không nhận hoặc gắn boundary/role nào. Cần một pending target rõ ràng. Đăng nhập chỉ bằng Google OIDC (ADR 0027 §1–2; `--method local` bị từ chối, không ghi gì):

```sh
pnpm run identity:enroll -- --user <uuid> --method oidc --issuer <exact-issuer> --subject <exact-subject>
pnpm run root:bootstrap -- --user <same-uuid> --operation <uuid> --method oidc --issuer <exact-issuer> --subject <exact-subject> --activation-file /private/tmp/root-activation-proof
```

Token kích hoạt chỉ ghi vào file mới mode0600 sau commit, không stdout/audit; file tồn tại khiến command từ chối trước mutation. Operator phải chuyển proof bằng kênh đã xác minh, không gửi vào log/chat. Sau khi dùng, xóa artifact proof theo quy trình secret handling. Nếu crash sau DB commit trước khi artifact được ghi, hoặc proof hết hạn/thất lạc khi Root còn pending, dùng `pnpm run root:reissue -- --user <same-uuid> --method oidc --issuer <exact-issuer> --subject <exact-subject> --activation-file <new-path>` (credential bootstrap; chỉ cho đúng target của marker, còn pending; vô hiệu proof cũ vĩnh viễn — DB chỉ cho token đi từ chưa dùng sang đã dùng, không runtime login nào hồi sinh/xóa/đổi đích được — và attempt OIDC đang dở bằng proof cũ cũng hết hiệu lực; ghi audit `root.reissue`). Không reset marker hoặc chạy bootstrap với operation khác để reseed. Bước 4 của ADR 0027 (chưa triển khai) thay `--user/--subject` bằng `--email`.

Lấy CSRF cookie/token bằng `GET /api/auth/csrf`. Mọi POST/PATCH có `Origin` đúng `APP_ORIGIN` và header `x-csrf-token` bằng cookie. Local HTTP dùng cookie `authz_*`; HTTPS dùng `__Host-authz_*`, Secure, Path=/, session/browser/csrf đều HttpOnly (token CSRF trả trong body của `GET /api/auth/csrf`), SameSite=Lax. API chỉ đọc đúng ba cookie của mình; cookie lạ/malformed của ứng dụng khác bị bỏ qua, cookie của API bị lặp tên thì trả400. API giả định same-site, không bật CORS. Sau reverse proxy đặt `TRUST_PROXY` đúng số hop ingress (mặc định0 = kết nối trực tiếp); sai số hop khiến mọi người dùng chung một bucket IP hoặc cho client tự khai `X-Forwarded-For`. Limiter coi một IPv6 /64 là một client; dạng IPv6 mang IPv4 (mapped/compatible/NAT64) được quy về IPv4, port bị bỏ. Chi tiết giới hạn và eviction ở mục rate-limit bên dưới.

Provider phải nằm trong cấu hình deploy tin cậy và enabled ở DB. Proof OIDC (purpose `oidc-activation`, 15phút, một lần) cũng chỉ ghi vào file mới mode0600 sau commit. Gọi `POST /api/auth/oidc/activate` với `{ issuer, token }`, theo authorization URL và callback. Chỉ pending account có invitation còn hạn và IdP proof đúng exact issuer/subject duy nhất đã prebind mới được activate; email/groups không link/grant. Không seed client secret trong manifest. Marker giữ nguyên sau token hết hạn, suspend hoặc `root:revoke`. Repeated bootstrap cùng operation trả trạng thái cũ, không promotion hay proof mới.

Root nằm ngoài IAM (không role, grant, boundary, rule hay record exception) và bypass phân quyền qua `planUnrestricted` trên mọi resource/action đã khai báo, kể cả đọc documents; projection/writable allowlist vẫn áp dụng và mỗi `access` commit của Root ghi một event audit (`principalKind: 'root'`). Ghi `write`/`admin` (document update, `account.suspend`) cần bước xác thực trong 300 giây: `POST /api/auth/mfa/verify` (xác thực 2 lớp, mục 9); tài khoản chưa có 2FA phải thiết lập trước. Đăng nhập Google không bao giờ cho `fresh` (ADR 0027 §7; flow OIDC reauth đã gỡ). Suspend nhắm Root (kể cả chính mình) hoặc id vắng mặt đều trả 404.

## 3. OIDC và session

- Chỉ Google OIDC (ADR 0027): `OIDC_PROVIDERS_JSON` bắt buộc, issuer và callback HTTPS cố định; fail discovery/config không mở listener. Env còn `AUTH_METHODS` (bất kỳ giá trị nào) → boot fail: xóa biến này khỏi `apps/api/.env.api` khi nâng cấp. Không có đăng nhập, kích hoạt, đổi hay khôi phục mật khẩu local; các route cũ trả 404. Nâng cấp lên migration `018` qua `db:provision`: preflight từ chối nếu còn tài khoản active chỉ có mật khẩu local hoặc Root pending không có Google — gắn Google bằng thay đổi thủ công có duyệt trước (dữ liệu dev); token/phiên local bị xóa, bảng `local_credential` bị drop.
- OIDC Code+PKCE S256, state/nonce một lần và signature/issuer/audience/azp/expiry được kiểm bằng openid-client. Assurance mapping theo issuer; baseline OIDC không tự là MFA. Mỗi tài khoản đúng một Google đang bật (migration `017`, ADR 0027 §6): không còn link, unlink hay xác thực lại bằng Google; các route cũ trả 404. Đổi Google của một người cần lệnh operator riêng (chưa có). Nâng cấp lên `017`: migration từ chối nếu còn tài khoản có hơn một binding đang bật — tắt binding thừa bằng thay đổi thủ công có duyệt trước (dữ liệu dev).
- Rate-limit PostgreSQL dùng chung giữa replicas: 20 lần/15 phút cho mỗi client (IPv4 hoặc IPv6 /64) và mỗi định danh theo từng purpose, cộng 200 lần/15 phút cho mỗi IPv6 /48 trên mọi purpose. Nguồn đã vượt bị dừng trước khi ghi bucket kế tiếp; bảng đầy (10000 dòng) thì loại bucket ít lần thử nhất thay vì chặn mọi client. Reset sớm một bucket đang có n lần thử cần khoảng 10000 bucket ≥ n, tức cỡ 500 IPv6 /48 hoặc 1000 host IPv4; cần quota ở ingress nếu threat model yêu cầu. Đánh đổi: một /64 xấu (hoặc lưu lượng thật của một site lớn) dùng hết 200 lần/15 phút sẽ chặn đăng nhập của cả /48 đó, tương tự giới hạn 20 lần của một IPv4 NAT/CGNAT. Mọi lần thử đều đếm, kể cả đăng nhập thành công: người dùng hợp lệ thứ 21 sau cùng một IPv4 NAT trong 15 phút bị từ chối, và một tài khoản đăng nhập thành công 20 lần (từ bất kỳ địa chỉ nào) cũng bị khóa tới hết window; chưa có bộ đếm riêng cho lần thất bại (test `valid users behind one NAT address…`). Ngưỡng/window chưa được hiệu chỉnh theo deployment — cần số liệu tải đăng nhập/NAT thật trước khi đổi (ADR0010, đang bị chặn). Limiter lấy advisory key trước application fence (ADR0010) nên hàng đợi đăng nhập không giữ fence chặn revoke; limiter vẫn tuần tự toàn cục giữa mọi replica.
- Session DB chỉ lưu digest, absolute12giờ/idle30phút. Data-only requests không touch activity; `/api/auth/session` và identity operations touch idle. Đây là giới hạn sớm bảo thủ, không kéo dài absolute expiry. Test `data-only access does not touch idle activity…` ghim hợp đồng này; đổi sang throttled touch là quyết định sản phẩm riêng (ADR0010).
- Logout/revoke của ứng dụng khác IdP logout/revoke. Chưa có IdP event integration; revoke tại IdP có thể còn session ứng dụng tới absolute expiry. Provider/binding/user revoke ở DB dùng exclusive fence và version/epoch nên quyết định sau commit bị chặn.
- CLI enroll tạo pending account, không phát session. Invitation offline: `pnpm run identity:invite -- --user <uuid> --method oidc --issuer <exact-issuer> --subject <exact-subject> --activation-file /private/tmp/invitation-proof`; proof mới mode0600 sau commit; user thường activate cùng luồng `POST /api/auth/oidc/activate` như Root. `identity:enroll` không phát proof; để phát (hoặc cấp lại khi proof15phút hết hạn/thất lạc) cho account pending đã có, chạy `identity:invite -- --user <uuid> --method oidc --activation-file <path>` không kèm `--email/--issuer/--subject`; lệnh kiểm lại account còn pending và khớp phương thức, vô hiệu mọi invitation cũ chưa dùng của account và ghi audit `identity.invite`. Root (`kind = 'root'`) không nhận invitation từ credential identity (dùng `root:reissue`): DB chỉ cho credential bootstrap phát proof kích hoạt cho nó (`guard_root_activation`), và promotion từ chối target đang có invitation còn hạn (`guard_root_kind`, migration 012). HTTP invitation chưa có; không dùng fixture credential để vận hành sản phẩm thật.

- Session hết hạn: `pnpm run identity:purge-sessions -- --retention-days <0-3650>` (credential identity trong `apps/api/.env.ops`, chạy định kỳ bởi operator/cron của deployment) xóa session có `expires_at` cũ hơn retention, mỗi batch ≤500 dòng trong transaction ngắn, tối đa 200 batch mỗi lần chạy (chạy lại để tiếp tục); bỏ qua dòng đang bị transaction identity khác khóa, chờ revoke/reset đang giữ exclusive fence rồi mới chạy (quá lock timeout thì lỗi `TransactionConflictError`, chạy lại). Retention là quyết định của deployment, không có mặc định; mỗi batch ghi audit `identity.session-purge` (actor `PRODUCT_OFFLINE_ACTOR`, chỉ số lượng). Migration 009 thêm index `expires_at` bằng `CREATE INDEX CONCURRENTLY` (không khóa ghi session).
- `one_time_token` không có job dọn: hàng đã dùng/hết hạn giữ lại làm bằng chứng, tăng trưởng bị chặn bởi rate limit và phát hành offline. Trigger chặn cả UPDATE bảo trì (vd. `expires_at`); dọn dữ liệu, nếu cần, là thao tác offline bằng migration/owner login có duyệt.
- Lỗi input của caller (key/filter sai) trả400 qua `ProductInvalidRequest`; lỗi lập trình/hạ tầng trả503 và log tên lỗi, SQLSTATE và stack frames, không log message/query/parameters.

## 4. Root recovery/elevation ngoài API

Thu hồi Root có lệnh offline dùng credential bootstrap, exclusive fence và audit `root.revoke`: Root chuyển sang `suspended` và tăng `auth_epoch` (mọi session cũ hết hiệu lực); marker giữ nguyên nên không bootstrap Root mới; chạy lại là no-op:

```sh
pnpm run root:revoke -- --user <uuid> --operation <uuid> --approval <approval-reference> --reason <text>
```

Gắn email cho Root tạo theo `sub` (ADR 0023 §4, migration `015` — nâng cấp DB cũ bằng `db:provision` vì migration thay body guard thuộc `product_session_owner`):

```sh
pnpm run root:set-email -- --user <root-uuid> --operation <operation-uuid> --email <address>
```

Credential bootstrap, exclusive fence, audit `root.set-email` (không ghi email). Chỉ cho Root `active`; email chưa xác minh (`email_verified = false`) và mọi phiên của Root hết hiệu lực ngay. Đăng nhập lại bằng Google: nếu Google trả email đã xác minh trùng địa chỉ này thì email thành đã xác minh (thêm một lần tăng `auth_epoch`, audit `identity.email-verify`). Chạy lại cùng email là no-op. Lệnh không in email; lỗi chỉ in class và lý do (`collision`/`invalid_release`).

`--approval` là tham chiếu bản ghi phê duyệt độc lập, không phải secret. **Cảnh báo:** chỉ có tối đa một Root; revoke không đảo ngược bằng lệnh runtime nào — marker đã initialized nên DB từ chối mọi Root mới và không login runtime nào gỡ suspend Root; chỉ repair offline có duyệt (mục 9) khôi phục. Chưa có CLI elevation/thêm Root: DB chỉ cho bootstrap credential promotion Root đầu tiên khi marker chưa initialized. Không dùng `root:bootstrap` lần hai hoặc reset marker. Runbook bắt buộc:

1. Mở sự cố có operation ID, reason, target UUID/method. Kiểm identity target qua kênh độc lập; không dựa vào email match hoặc password do admin tự đặt.
2. Một người có thẩm quyền khác operator phê duyệt bằng hệ thống approval độc lập; lưu approval ID/hash và thời hạn. Operator không được tự phê duyệt. Production phải chốt hệ thống approval/key pinning trước khi tạo command tự động.
3. Dừng mọi thao tác identity nhạy cảm liên quan target; dùng capability offline ngắn hạn, không inject vào API. Người phụ trách identity xử lý activation bằng proof thật; không tạo session impersonation.
4. Offline authorization operation lấy exclusive application fence; đọc manifest còn đúng hash (không drift), kiểm target exact. Chỉ thực hiện thay đổi đã được duyệt; ghi approver reference/hash, reason, target, revision và audit event cùng transaction (audit DB của `root:*`, `identity:enroll`/`identity:invite` ghi `actor_id` là sentinel operator offline `PRODUCT_OFFLINE_ACTOR`, target account ở `safe_metadata.targetUserId`, và lưu operation/approval reference; danh tính operator và approver nằm trong bản ghi sự cố/approval được tham chiếu, không trong DB sản phẩm); tăng revision rồi commit. Không đổi marker hoặc definitions để vượt checks. Nếu cần sửa drift/ownership, đó là migration/repair riêng được duyệt, không disable trigger bằng runtime.
5. Kiểm quyền target thực tế và các deny/boundary sau commit, thu hồi capability offline và xác nhận audit ra sink độc lập. Revoke Root cũ cũng cần approval rõ ràng; không coi count(root)=0 là lý do tự cấp mới.

Các bước này là gate vận hành, không là bằng chứng đã diễn tập production. Chưa cung cấp approval authority/audit sink thật; không chạy sửa dữ liệu thật trong phiên này.

## 5. Manifest, privileges, rollback và metrics

Audit (ADR 0009): `policy_revision` là revision dùng để đánh giá quyền; event mutation ghi revision sau commit ở `safe_metadata.resultingRevision` (event cũ trước mốc này không có field này và `policy_revision` của một số writer là revision sau commit — không rewrite). `access.*` là event quyết định của obligation `audit@1`, khác với event effect (`data.update`, `account.suspend`, ...). Effect và audit cùng transaction. Delivery (ADR0011): adapter `ProductAuditOutbox` dùng login `product_outbox` (SELECT outbox, UPDATE chỉ cột delivery) claim theo lease + `SKIP LOCKED`, gửi sink ngoài mọi transaction/fence, ack ở transaction riêng theo `lease_token`, retry backoff hữu hạn rồi park (`dead_at`); at-least-once, sink phải dedupe theo `eventId`. **Chưa có sink/provider thật nên worker chưa chạy ở đâu**: event tiếp tục tích lũy trong outbox; chọn sink, nơi chạy worker, retention event đã giao và runbook event bị park là gate riêng. Event bị park xem bằng `SELECT event_id,event_kind,delivery_attempts,dead_at FROM audit_outbox WHERE dead_at IS NOT NULL` với credential vận hành phù hợp; chưa có lệnh re-queue.

Startup so khớp chính xác ACL bảng/cột/hàm của từng login runtime (kể cả grant cho PUBLIC hoặc WITH GRANT OPTION) với ma trận code; mọi grant dư hoặc thiếu làm boot fail. Body/owner/search_path của function bảo vệ và binding của mọi trigger trên bảng được bảo vệ cũng phải khớp chính xác; migration ứng dụng không được thêm trigger hay `CREATE OR REPLACE` các function này. Suspend là một chiều với authority: gỡ suspend là repair offline có duyệt. Gán/thu hồi role code-owned thường (vd. `reviewer`) là authority fact; tiền tố `system.` là dự trữ (release product từ chối) và Root không phải role (ADR 0012). Default grant chỉ gỡ bằng `removeDefaultGrants` của release sau, khớp chính xác permission/role/template/parameters.

`manifest:sync`/boot dùng cùng release đã validate/freeze, monotonic sequence/hash và expected predecessor. `defaultGrants` chỉ cho permission mới; release product v2 không còn `systemGrants` (ADR 0012). Thay content cần `previousHash`, removal cần `expectedHash`; omission không revoke. Sync không ghi runtime grants/tuples/bindings/assignments.

Same release kiểm toàn bộ materialized code facts. Drift chặn cả release mới; khôi phục về trạng thái được duyệt bằng repair offline có audit/approval, rồi publish release sửa chữa tường minh. Không phục hồi user assignment khi boot. Không rollback bằng binary cũ/manifest thấp sequence hoặc snapshot quyền cũ; giữ credential/revoke state, dùng forward release/migration. Backup restore/durability/failover chưa diễn tập; không promote primary thiếu acknowledged revoke watermark.

Đồng hồ máy PostgreSQL là nguồn duy nhất cho fresh, `auth_time` và hạn token/phiên (ADR 0022). Máy DB phải đồng bộ NTP chỉ slew sau khi boot (không step trong lúc chạy) và giám sát độ lệch; đồng hồ bị step lùi làm phiên mất fresh (fail closed, người dùng phải xác thực lại), xử lý như sự cố vận hành.

`/api/health/metrics` chứa histograms hữu hạn theo metric/mode: pool wait, lock wait/hold, transaction, revoke commit, retry/timeout/deadlock. Không user/record IDs hoặc SQL binds. [Load results](single-product-load-results.md) là fixture nhỏ, không production SLO; không phân vùng fence từ số đo này. Data role không có row scope tự động ở DB: mọi truy vấn nghiệp vụ vẫn qua authorization service/gateway. DB roles không chống toàn bộ process compromise.

## 6. Tests và capabilities chưa mở

```sh
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
```

Docker local chạy PostgreSQL18.4 disposable. OIDC fixture có RSA signatures, token/JWKS HTTP server và actual protocol library checks; routing network tới fixture là test-only, không kiểm production TLS/discovery. SQL/evaluator parity, bigint/collation, boundaries, deny, privilege, migrations, bootstrap/revoke concurrency được kiểm trong suites. 55P03 có contention thật; 40P01/40001 được fault-inject trực tiếp vào product runner với rollback/effects PostgreSQL thật; không gọi chúng là deadlock/serialization do DB tự phát sinh.

Chưa mở generic role/grant/boundary/relation administration, file/export/job, public signup, UI, IdP backchannel logout hoặc cache allow. Route không khai báo bị startup/CI tests từ chối; capability chưa có không được quảng cáo đã hoạt động. Workflow có các lệnh thực, chưa chạy trên GitHub trong phiên này. Không commit/push/deploy.

## 7. Thứ tự bootstrap và phần chưa triển khai (giai đoạn A)

Thứ tự khởi động API (`main.ts` → `ProductRuntime.create` → `NestFactory` → `listen`); bước nào lỗi thì listener không mở và readiness giữ `false`:

1. `ProductRuntime.create`: chọn codecs (`createProductAuthorizationCore()`), mở bốn pool runtime; thiếu/sai codec hoặc pool lỗi thì dừng, cleanup không leak pool.
2. `ProductRouteInventory.onModuleInit`: mọi route phải có đúng một classification (chạy ở `onModuleInit` nên luôn trước mọi `onApplicationBootstrap`, dù `RuntimeModule` nằm sâu).
3. `ProductRuntime.onApplicationBootstrap`: privilege/protection probe (`verifyProductPrivileges`: ACL, owner/search_path/body function, trigger Root/activation, CREATE/TEMP/grant option).
4. Manifest sync (`ProductManifestReconciler`, cùng release/core với CLI, obligations registry thật).
5. OIDC provider sync (không tự disable/đổi version provider).
6. Domain checks (bảng resource khai báo phải tồn tại).
7. `ReadinessGate.markReady()` rồi mới `listen`. `onApplicationShutdown` idempotent (memoized).

Source đã gom vào một app ([ADR 0013](decisions/0013-single-app-modules.md)); scripts/HTTP/credential matrix không đổi. Product migrations ở `apps/api/src/database/migrations`, application document migration ở feature `document/migrations`; CLI import built output của cùng app.

Tenant runtime, compatibility API và CLI cũ đã bỏ theo [ADR 0014](decisions/0014-remove-legacy-runtime.md). Provision/migrate hiện chỉ dùng `apps/api/tools/product.ts` và product migration chain; không có công cụ nhập/gộp dữ liệu tenant cũ.

Chưa triển khai (không được quảng cáo là đã có): delegation; generic administration (role/grant/boundary/relation API); resource-to-resource domain binding; sink audit thật và vòng chạy worker (adapter outbox đã có, ADR0011); khôi phục tài khoản (ADR 0027: làm dần; route khôi phục mật khẩu local đã gỡ); adapter thời gian thứ hai (Moment); platform publishing. Phase B: T8 xong (giảm I/O trong fence, `docs/single-product-load-results.md`); T9 xong phần độc lập (thứ tự lock limiter, purge session theo batch) nhưng ngưỡng limiter, throttled touch và dọn `one_time_token` bị chặn bởi policy deployment; T10: adapter delivery audit xong và có test crash/lease/2 worker/poison, nhưng chưa wire vì thiếu sink. Tài liệu này không nâng trạng thái production-ready.

## 8. Repair gỡ suspend Root

Không đường runtime nào gỡ suspend Root. Repair offline có duyệt do owner bảng (`product_migration`) chạy trong một transaction, chỉ disable đúng trigger `guard_root_lifecycle`:

```sql
BEGIN;
ALTER TABLE public.app_user DISABLE TRIGGER guard_root_lifecycle;
UPDATE public.app_user SET state='active' WHERE id='<root-uuid>' AND kind='root' AND state='suspended';
ALTER TABLE public.app_user ENABLE TRIGGER guard_root_lifecycle;
COMMIT;
```

Repair không ghi `audit_outbox`; bằng chứng là hồ sơ approval: approval reference, người duyệt, thời điểm và câu SQL đã chạy. Sau đó chạy lại startup probe (trigger phải enabled); session cũ vẫn hết hiệu lực vì `auth_epoch` đã tăng khi revoke.

## 9. Xác thực 2 lớp: khóa mã hóa, sao lưu, xoay khóa và reset-mfa

[ADR 0026](decisions/0026-totp-second-factor.md). Migration `016` thay body `guard_root_lifecycle` (owner `product_session_owner`): DB cũ nâng cấp bằng `pnpm run db:provision`, chỉ `db:migrate` sẽ bị từ chối.

- **Khóa**: API cần `MFA_ENCRYPTION_KEYS` (`<keyId>:<base64 đúng 32 byte>` phân tách dấu phẩy, `keyId` theo `[a-z0-9-]{1,32}`, không trùng) và `MFA_ENCRYPTION_KEY_ID` (khóa mã hóa secret mới, phải có trong danh sách) trong `apps/api/.env.api`; mẫu ở `apps/api/.env.example`. Sinh khóa bằng nguồn ngẫu nhiên an toàn (vd. `openssl rand -base64 32`), ghi thẳng vào file env của deployment/secret manager, không qua chat, CLI argument hay log. Khóa chỉ thuộc env API: không đặt vào `.env.ops`, DB, audit hay artifact test. Thiếu/sai định dạng → boot fail, thông báo không in giá trị. Trước readiness API đọc `SELECT DISTINCT key_id FROM mfa_totp`; có `key_id` không nằm trong danh sách → boot fail (fail closed).
- **Sao lưu**: sao lưu khóa tách khỏi sao lưu DB (nơi lưu, quyền truy cập và người giữ khác nhau); bản sao DB một mình không mở được secret TOTP, bản sao khóa một mình không có ciphertext. Restore DB cần đúng bộ khóa của các `key_id` còn trong bản sao. **Mất khóa đang được dùng thì API không boot** (kiểm `key_id` ở trên), nên mã khôi phục của người dùng cũng không dùng được cho tới khi xử lý: operator liệt kê `SELECT user_id FROM mfa_totp WHERE key_id='<id>'` (credential identity) và chạy `reset-mfa` có approval cho từng tài khoản (dưới đây), rồi mới gỡ khóa đó khỏi danh sách. Chưa có lệnh xử lý hàng loạt (shortcut ở ADR 0026 §3).
- **Xoay khóa** (mã hóa lại khi dùng, không có lệnh offline): (1) thêm khóa mới vào `MFA_ENCRYPTION_KEYS` trên **mọi** replica, giữ `MFA_ENCRYPTION_KEY_ID` cũ, khởi động lại; (2) khi mọi replica đã có khóa mới, đổi `MFA_ENCRYPTION_KEY_ID` sang khóa mới và khởi động lại. Làm ngược thứ tự thì replica chưa có khóa mới trả lỗi server (`error.unavailable`) cho tài khoản đã được mã hóa lại. Từ bước (2), mỗi lần xác nhận đăng ký hoặc verify mã TOTP đúng, secret được mã hóa lại bằng khóa hiện hành trong cùng UPDATE. Chỉ gỡ khóa cũ khi `SELECT count(*) FROM mfa_totp WHERE key_id='<cũ>'` bằng 0; còn dòng thì boot fail. Tài khoản không verify lại giữ khóa cũ mãi; khóa bị lộ cần reset-mfa các tài khoản đó.
- **Khóa do sai mã**: mỗi lần sai ở verify được đếm và audit `identity.mfa-verify-failed`; từ lần sai thứ 10 liên tiếp, mỗi lần sai đăng xuất mọi phiên của tài khoản (audit `identity.mfa-lockout`). Bộ đếm chỉ về 0 khi nhập đúng; không có khóa 2FA và không cần mở khóa offline.
- **reset-mfa** (mất cả thiết bị lẫn mã khôi phục): theo runbook mục 4 (sự cố, approval độc lập, xác minh danh tính qua kênh khác).

```sh
pnpm run identity:reset-mfa -- --user <iam-uuid> --operation <operation-uuid> --approval <approval-reference> --reason <text>
pnpm run root:reset-mfa -- --user <root-uuid> --operation <operation-uuid> --approval <approval-reference> --reason <text>
```

`identity:reset-mfa` dùng credential identity và chỉ nhận tài khoản IAM; `root:reset-mfa` dùng credential bootstrap và chỉ nhận Root (target khác loại bị từ chối, exit khác 0, không ghi gì). Một transaction có fence: xóa secret và mã khôi phục, trigger `mfa_epoch` tăng `auth_epoch` nên mọi phiên của tài khoản hết hiệu lực; audit `identity.mfa-reset` (actor `PRODUCT_OFFLINE_ACTOR`, target, operation, approval, reason; không email). Không có 2FA thì in `No second factor; nothing changed.`, exit 0, không audit. Giới hạn đã biết: "identity không reset Root" chỉ do code kiểm, vì credential identity vốn đã tạo được phiên bất kỳ (ADR 0026 §10); DB chỉ giới hạn bootstrap vào Root (`protect_mfa_totp`, `protect_mfa_recovery_code`). Hệ quả phụ có chủ ý của nhánh guard cho reset: bootstrap được tăng `auth_epoch` (đăng xuất) của Root đang không có 2FA, kể cả Root chưa từng đăng ký; việc đó không cấp quyền gì.
