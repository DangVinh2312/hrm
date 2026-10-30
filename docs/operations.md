# Vận hành local, kiểm thử và runbook

Phạm vi: máy phát triển và CI. Production (hosting, reverse proxy, phục vụ static, secret store) chưa chốt (D13 trong kế hoạch HRM). Các lệnh `pnpm` chạy từ root và forward tới API với cwd `apps/api`; env nằm trong `apps/api/`, dùng đường dẫn tuyệt đối cho file kích hoạt. Chỉ dùng database disposable hoặc local; không dùng credential staging/production để kiểm chứng. Kiến trúc: [architecture](architecture.md).

## 1. Toolchain

- Node 24 theo `.nvmrc` (`>=24.15.0 <25`), pnpm theo `package.json#packageManager`. Chỉ dùng pnpm.
- Docker cho PostgreSQL disposable (integration, API E2E, browser E2E).
- Browser E2E cần Chromium của Playwright và thư viện hệ thống (một lần mỗi máy):

```sh
pnpm install --frozen-lockfile
pnpm --filter @hrm/web exec playwright install chromium
sudo pnpm --filter @hrm/web exec playwright install-deps chromium
```

## 2. Dựng môi trường local

Ba cách chạy, chọn một:

- `apps/api/compose.yaml` (project `hrm`, volume `hrm_postgres-data`, cổng host `127.0.0.1:${POSTGRES_PORT:-55433}`, database `hrm`) chỉ chạy PostgreSQL; API và web chạy bằng pnpm. Đổi `POSTGRES_PORT` thì sửa cùng cổng trong mọi URL của `apps/api/.env.ops` và `apps/api/.env.api`.
- `scripts/dev.sh` (`start` mặc định, `api`, `web`, `db`, `setup`, `stop`, `reset`): bật Postgres từ `apps/api/compose.yaml`, chạy `db:provision` và `db:migrate`, rồi API và web. `reset` xóa container và volume (mất dữ liệu local).
- `docker/compose.yaml` (project `hrm-local`, cổng host `127.0.0.1:5432` phải trống, dữ liệu ở `docker/volumes/`, đọc `docker/.env.ops` và `docker/.env.api`): Postgres, bước `setup` (`provision` idempotent), API và web hot reload (web ở `127.0.0.1:6368`). `docker/root-activation.sh <email Google>` tạo Root (hoặc `--reissue`) và ghi token vào `docker/volumes/secrets/` mode 0600.

Chuẩn bị env cho hai cách đầu:

```sh
cp apps/api/.env.ops.example apps/api/.env.ops
cp apps/api/.env.example apps/api/.env.api
```

Tạo password ngẫu nhiên riêng cho bảy login (`data`, `identity`, `authority`, `sync`, `migration`, `bootstrap`, `outbox`); không đưa vào CLI argument, source hay chat. `apps/api/.env.api` chỉ chứa bốn login `data/identity/authority/sync`; API từ chối migration/bootstrap/admin URL, và không `source` `.env.ops` vào shell chạy API. Compose đọc thêm `POSTGRES_ADMIN_USER`, `POSTGRES_ADMIN_PASSWORD`, `POSTGRES_PORT` từ `.env.ops`; `DATABASE_ADMIN_URL` phải trỏ cùng PostgreSQL.

```sh
docker compose -f apps/api/compose.yaml --env-file apps/api/.env.ops up -d --wait postgres
pnpm run db:provision
pnpm run db:migrate
pnpm run manifest:sync
pnpm run start:dev
```

- `db:provision` (idempotent): thu hồi TEMP của PUBLIC, tạo database `PRODUCT_DATABASE_NAME`, bảy login và các function owner NOLOGIN, cấp tạm membership owner cho login migration, áp hai baseline migration rồi thu hồi. Password của role đã tồn tại không bị xoay. Chạy lần đầu và mỗi khi có migration mới cần đổi owner hàm bảo vệ.
- `db:migrate` chỉ áp migration còn thiếu bằng login migration; không áp được baseline trên database rỗng vì thiếu membership owner, nên database mới luôn đi qua `db:provision`.
- Schema do hai baseline `001-product-baseline` và `002-application-baseline` dựng (ADR-14); không có đường nâng cấp từ chuỗi migration cũ. Database dựng bằng chuỗi cũ phải bỏ và dựng lại (`scripts/dev.sh reset` rồi `setup`); chạy baseline lên schema cũ thất bại vì `CREATE TABLE` trùng (fail closed). Database dev đã được dựng lại theo ADR-14 phase 3 (2026-10-29): `setup` và `sync` thành công, Root cần bootstrap lại.
- `manifest:sync` và boot dùng cùng release (hiện `sequence 1`, genesis). Boot không chạy migration; privilege, capability hoặc manifest lỗi thì API không mở listener. `/api/health/ready` chỉ trả 200 sau sync; `/api/openapi.json` mô tả DTO, ví dụ và status; `/api/health/metrics` chỉ có nhãn hữu hạn.

CLI offline (`apps/api/tools/product.ts`, scripts trong `apps/api/package.json`): `db:provision`, `db:migrate`, `manifest:sync`, `root:bootstrap`, `root:reissue`, `root:revoke`, `root:set-email`, `root:reset-mfa`, `identity:enroll`, `identity:reset-mfa`, `identity:purge-sessions`.

Dữ liệu nhân viên mẫu: `seed/` (`import-employees.mjs`, `enroll.sh`, `enroll-accounts.mjs`) dùng cho môi trường dev; không chứa credential.

## 3. Kiểm tra

```sh
pnpm run format:check   # hiện fail riêng ở docs/HR_Web_Requirement_Tieng_Viet.md (file gốc, giữ nguyên)
pnpm run lint
pnpm run typecheck      # API + web (app và e2e)
pnpm run build          # API tsc + web vite build
pnpm run test:unit      # workspace + API node:test + web Vitest
pnpm run test:workspace # tooling dùng chung (function-spacing, locale-keys, ...)
pnpm run test:integration
pnpm run test:e2e       # API HTTP E2E
pnpm run test:browser   # web Playwright với stack thật (cần build API trước)
```

- Test nhận path filter sau `--` (vd. `pnpm run test:unit -- apps/api/test/structure.spec.ts`). Integration, E2E và browser cần Docker; PostgreSQL 18.6 disposable.
- Integration (ADR-01): `tools/test.ts` khởi một container PostgreSQL cho cả lần chạy và tạo database riêng từ template cho mỗi file dùng `startModuleStack(`; file cần cluster riêng (role, kill session, CLI offline, đo thời gian) dùng `isolated`. Role `product_*` ở cấp cluster nên mọi database của cluster chung dùng chung bộ password test.
- `test:browser` tự dựng stack dùng một lần: PostgreSQL container, CLI `provision/migrate/sync/bootstrap/enroll`, API đã build, IdP OIDC giả qua HTTPS với CA sinh cho mỗi lần chạy, web phục vụ HTTPS và proxy `/api`. Không đọc `apps/api/.env.*`, chỉ dữ liệu giả. Mỗi file `e2e/*.e2e-spec.ts` có stack riêng; limiter OIDC (20 lượt/15 phút mỗi client) tính chung cho cả file, nên luồng đăng nhập nhiều lần đặt trong file riêng; không nới limiter hay giả `X-Forwarded-For`.
- OIDC fixture dùng chữ ký RSA, token/JWKS HTTP server và thư viện thật; định tuyến mạng tới fixture chỉ ở test, không kiểm TLS/discovery production. `55P03` có contention thật; `40P01`/`40001` fault-inject vào runner với PostgreSQL thật.

## 4. Xem giao diện local

```sh
pnpm run build
pnpm --filter @hrm/web run dev:stack
```

In URL `https://localhost:<port>` (chứng chỉ tự ký) và đường dẫn file `0600` chứa link kích hoạt cho nhân viên giả `demo-employee`; IdP giả tự đăng nhập như nhân viên đó. Ctrl+C dừng và xóa container. Không dùng cho tài khoản hay Google thật. Thay đổi giao diện cần ảnh chụp thật ở 390px và 1366px (checklist ở [design system](hrm-ui-design-system.md)).

## 5. Cấu hình Google OIDC

OIDC bắt buộc HTTPS cho issuer; redirect URI và `APP_ORIGIN` phải HTTPS, trừ phát triển local trên `http://localhost` (loopback, không dùng production; ADR-11).

- `apps/api/.env.api` (không commit; không đặt `AUTH_METHODS`, biến này làm boot fail): `APP_ORIGIN=https://<origin>` và `OIDC_PROVIDERS_JSON=[{"issuer":"https://accounts.google.com","clientId":"<id>","clientSecret":"<secret>","redirectUri":"https://<origin>/api/auth/oidc/callback","version":"1","assuranceMappings":[]}]`. Redirect URI khai báo y hệt trong Google Cloud Console. Thiếu hoặc sai cấu hình thì boot fail, không mở listener.
- Web: `VITE_OIDC_ISSUER=https://accounts.google.com` ở `apps/web/.env.local` hoặc lúc build. Mọi biến `VITE_*` nằm trong bundle công khai, không đặt secret.
- Đăng nhập Google qua Vite dev server trên localhost: `APP_ORIGIN=http://localhost:6368`, redirect URI `http://localhost:6368/api/auth/oidc/callback`, `PORT` API khác 6368 (vd. 6369); chạy `pnpm run start:dev`, rồi `HRM_API_TARGET=http://127.0.0.1:6369 VITE_OIDC_ISSUER=https://accounts.google.com pnpm --filter @hrm/web exec vite --host localhost --port 6368 --strictPort` và mở `http://localhost:6368` (không dùng `127.0.0.1`: origin phải khớp).
- Sau reverse proxy đặt `TRUST_PROXY` đúng số hop ingress (mặc định 0 = kết nối trực tiếp); sai số hop khiến mọi người dùng chung một bucket IP hoặc cho client tự khai `X-Forwarded-For`. API giả định same-site, không bật CORS; cookie `authz_*` (HTTP local) hoặc `__Host-authz_*` (HTTPS), cookie của API bị lặp tên thì trả 400.

## 6. Root

Root tạo một lần mỗi database (marker Root dùng một lần; tạo lại cần database mới). Cần database đã `provision` và `manifest:sync` đúng build hiện tại (`root:bootstrap` từ chối khi manifest lệch) và provider Google đang bật.

```sh
pnpm run root:bootstrap -- --operation <uuid> --issuer https://accounts.google.com --email <email Google của Root> --activation-file <đường dẫn ngoài repo>
```

- Sinh UUID bằng `node -e "console.log(crypto.randomUUID())"`. Lệnh sinh id Root (in ra, không bí mật; dùng cho `root:revoke`/`root:reset-mfa`), tạo tài khoản pending `iam` rồi promote `kind = 'root'` trong cùng transaction `bootstrap` READ COMMITTED, ghim `(issuer, email)` 15 phút và token `oidc-activation` 15 phút. Token chỉ ghi vào file mới mode 0600 sau commit, không stdout hay audit; file tồn tại thì lệnh từ chối trước khi ghi. Chuyển proof bằng kênh đã xác minh và xóa file sau khi dùng.
- Trong 15 phút mở `<APP_ORIGIN>/activate#token=<nội dung file>` và đăng nhập đúng tài khoản Google; Google phải trả email đã xác minh trùng email đã ghim (email khác bị từ chối, không gắn nhầm). Một commit: tiêu thụ token, xóa dòng ghim, thêm binding, đặt `state='active'`, `email_verified=true`, `auth_epoch+1`, audit `identity.oidc-activation`, cấp phiên (không `fresh`).
- Cùng `--operation` và cùng email đã commit là no-op; operation hoặc email khác, hay email trùng tài khoản khác, trả `collision` và không ghi gì. Audit `root.bootstrap` có actor offline, target, operation, không có email.
- Hết hạn hoặc thất lạc proof khi Root còn pending và chưa có binding: `pnpm run root:reissue -- --issuer https://accounts.google.com --activation-file <file mới>` (chỉ Root của marker; vô hiệu proof cũ vĩnh viễn; audit `root.reissue`). Không chạy bootstrap lần hai hay reset marker.
- Root nằm ngoài IAM (không role, grant, boundary, rule), bypass phân quyền trên mọi resource/action đã khai báo; projection và allowlist ghi vẫn áp; mỗi `access` commit ghi audit `principalKind: 'root'`. Action có `fresh@1` cần 2FA trong 300 giây (`POST /api/auth/mfa/verify`); tài khoản chưa có 2FA phải thiết lập trước. Suspend nhắm Root (kể cả chính mình) hoặc id vắng mặt trả 404.
- Thu hồi Root (credential bootstrap, exclusive fence, audit `root.revoke`): `pnpm run root:revoke -- --user <uuid> --operation <uuid> --approval <approval-reference> --reason <text>` chuyển Root sang `suspended` và tăng `auth_epoch`; marker giữ nguyên nên không bootstrap Root mới; chạy lại là no-op. Chỉ có tối đa một Root và không lệnh runtime nào gỡ suspend; chỉ repair offline có duyệt (mục 10) khôi phục. Chưa có CLI thêm Root.
- `pnpm run root:set-email -- --user <root-uuid> --operation <uuid> --email <address>` chỉ để gắn email cho Root tạo theo `sub` từ trước ADR-06 (Root mới không cần): chỉ Root `active`, email thành chưa xác minh và mọi phiên hết hiệu lực cho tới khi đăng nhập lại bằng Google với email trùng; audit `root.set-email` không ghi email.
- `--approval` là tham chiếu bản ghi phê duyệt độc lập, không phải secret. Runbook bắt buộc cho thao tác Root: mở sự cố có operation ID, reason, target; xác minh danh tính qua kênh độc lập (không dựa vào email match); người có thẩm quyền khác operator phê duyệt (operator không tự phê duyệt); dùng capability offline ngắn hạn, exclusive fence, manifest đúng hash, audit và revision cùng transaction (actor audit là `PRODUCT_OFFLINE_ACTOR`; danh tính operator và approver nằm ở hồ sơ approval); kiểm quyền thực tế sau commit rồi thu hồi capability. Các bước này là gate vận hành chưa diễn tập production; chưa có approval authority hay audit sink thật.

## 7. Tài khoản IAM

`pnpm run identity:enroll -- --user <uuid> --issuer https://accounts.google.com --email <email>` tạo tài khoản pending và dòng ghim 7 ngày, không phát session hay token; nhân viên mở `<APP_ORIGIN>/login` và đăng nhập Google đúng email (đã xác minh) là kích hoạt. Không còn lời mời theo `sub`, `--method`, `--subject`. Quản trị tài khoản, setting và role qua HTTP bằng permission thường theo các đợt của ADR-12, ADR-13 (xem [kế hoạch administration](superpowers/plans/2026-10-23-administration.md)); mọi việc nhắm Root vẫn chỉ CLI. Role runtime cần hai forward migration (`RoleRuntimeConstraint`, `RoleAnchorLock`) và thao tác danh tính cần `IdentityOperations1792108800005` (ba owner NOLOGIN mới): chạy `pnpm run db:provision` lại trên database đã dựng trước đó (`db:migrate` đơn lẻ lỗi `must be able to SET ROLE` vì thiếu membership owner).

Danh tính IAM (ADR-15): đổi email, reset 2FA và đổi binding Google của tài khoản IAM làm qua UI/HTTP bằng permission `account.changeEmail`, `account.resetMfa`, `account.resetGoogleBinding` (`PUT /api/administration/accounts/:id/email`, `POST .../mfa/reset`, `POST .../google/reset`). Mỗi lệnh cần `fresh@1` (2FA trong 300 giây), grant, binding gói `identityAdministration@1` do Root bật cho từng người (người đã giữ cùng gói ủy quyền được như `accountAdministration@1`), đích là IAM nằm trong tập grant của người gọi, và tự động đăng xuất mọi phiên của đích; audit `identity.email-change`, `identity.mfa-reset-by-permission`, `identity.binding-reset` (không email, `sub` hay secret). Không có thông báo tới chủ tài khoản (chưa có SMTP): chỉ audit và phiên bị đăng xuất. Mọi việc nhắm Root vẫn chỉ CLI offline có approval (`root:*`), không route. Chưa có cờ email chưa xác minh trên API/web; không cấp ba permission này đồng thời cho một người hoặc một role (chuỗi đổi email + reset binding chiếm được tài khoản).

Người quản trị đầu tiên: từ release 4 các lệnh `account.provision|suspend|reactivate|assignRole|revokeRole|bindBoundary|unbindBoundary` và `role.update|delete` đòi grant và binding gói `accountAdministration@1` (không role nào tự mang binding, gán role không bật binding). Chỉ Root gắn được binding đầu tiên: tạo role chứa các permission cần cho người đó (`role.create`, chỉ Root tạo được role đủ rộng), `account.assignRole`, rồi `POST /api/administration/accounts/:id/boundaries` body `{ "key": "accountAdministration", "version": 1 }` bằng phiên Root có 2FA mới (`fresh@1`). Từ đó người đó gắn được gói cho người khác chỉ khi chính họ giữ gói và tập grant của đích nằm trong tập của họ; gỡ bằng `DELETE /api/administration/accounts/:id/boundaries/accountAdministration/1` (không cần tự giữ gói) và chỉ xóa binding do runtime ghi, không đụng binding do release seed. Cả hai lệnh đều audit (`permission.boundary-assign|boundary-revoke`) và có hiệu lực ở request kế tiếp.

## 8. Phiên, 2FA và rate limit

- Session lưu digest, tuyệt đối 12 giờ, idle 30 phút. Request chỉ đọc dữ liệu không touch idle; `/api/auth/session` và thao tác identity có touch. Logout/revoke của ứng dụng khác IdP: chưa có tích hợp sự kiện IdP, nên revoke ở IdP có thể còn session ứng dụng tới hạn tuyệt đối. Provider/binding/user bị revoke ở DB dùng exclusive fence và `auth_epoch` nên quyết định sau commit bị chặn. Dọn session hết hạn: `pnpm run identity:purge-sessions -- --retention-days <0-3650>` (login identity, batch ≤ 500 dòng, tối đa 200 batch mỗi lần, audit `identity.session-purge`); retention do deployment quyết, chưa có lịch chạy. `one_time_token` đã dùng/hết hạn được giữ làm bằng chứng, dọn là thao tác offline có duyệt.
- Rate limit PostgreSQL dùng chung giữa replica: 20 lượt/15 phút mỗi client (IPv4 hoặc IPv6 /64) và mỗi định danh theo purpose, cộng 200 lượt/15 phút mỗi IPv6 /48 mọi purpose; bảng đầy (10 000 dòng) thì loại bucket ít lần thử nhất. Mọi lần thử đều đếm kể cả thành công, nên người dùng thứ 21 sau cùng một NAT IPv4 trong 15 phút bị từ chối. Ngưỡng chưa hiệu chỉnh theo deployment, cần số liệu tải đăng nhập/NAT thật. Limiter lấy advisory lock trước fence (ADR-03).
- Khóa mã hóa 2FA (ADR-06): `MFA_ENCRYPTION_KEYS` (`<keyId>:<base64 đúng 32 byte>` phân tách dấu phẩy, `keyId` theo `[a-z0-9-]{1,32}`) và `MFA_ENCRYPTION_KEY_ID` (khóa cho secret mới, phải có trong danh sách) ở `apps/api/.env.api`; sinh bằng nguồn ngẫu nhiên an toàn (`openssl rand -base64 32`), không qua chat, CLI argument hay log, không đặt ở `.env.ops`/DB/audit. Thiếu hoặc sai định dạng thì boot fail; trước readiness, mọi `key_id` trong `mfa_totp` phải có trong danh sách.
- Sao lưu khóa tách khỏi sao lưu DB. Mất khóa đang dùng thì API không boot; xử lý bằng `reset-mfa` có approval cho từng tài khoản (`SELECT user_id FROM mfa_totp WHERE key_id='<id>'`) rồi mới gỡ khóa khỏi danh sách (chưa có lệnh hàng loạt).
- Xoay khóa (mã hóa lại khi dùng): (1) thêm khóa mới vào `MFA_ENCRYPTION_KEYS` trên mọi replica, giữ `MFA_ENCRYPTION_KEY_ID` cũ, khởi động lại; (2) đổi `MFA_ENCRYPTION_KEY_ID` sang khóa mới và khởi động lại. Làm ngược thứ tự thì replica thiếu khóa mới trả `error.unavailable`. Chỉ gỡ khóa cũ khi `SELECT count(*) FROM mfa_totp WHERE key_id='<cũ>'` bằng 0. Tài khoản không verify lại giữ khóa cũ mãi.
- Sai mã 2FA: từ lần sai thứ 10 liên tiếp, mỗi lần sai đăng xuất mọi phiên (audit `identity.mfa-lockout`); bộ đếm chỉ về 0 khi đúng, không cần mở khóa offline.
- Mất cả thiết bị lẫn mã khôi phục: người giữ `account.resetMfa` reset qua UI (mục 7); hoặc CLI `pnpm run identity:reset-mfa -- --user <iam-uuid> --operation <uuid> --approval <ref> --reason <text>` (chỉ IAM, login identity) hoặc `pnpm run root:reset-mfa -- ...` (chỉ Root, login bootstrap); theo runbook mục 6. Một transaction có fence, xóa secret và mã khôi phục, tăng `auth_epoch`, audit `identity.mfa-reset`. Không có 2FA thì in `No second factor; nothing changed.` và exit 0. Giới hạn: "identity không reset Root" chỉ do code kiểm, vì login identity vốn tạo được phiên bất kỳ (ADR-06).

## 9. Manifest, privilege, audit và metrics

- Startup so khớp chính xác ACL bảng/cột/hàm của từng login runtime (kể cả grant cho PUBLIC hay `WITH GRANT OPTION`) với ma trận trong code, kiểm body/owner/search_path của hàm bảo vệ và binding trigger; dư hoặc thiếu thì boot fail. Migration ứng dụng không được thêm trigger hay `CREATE OR REPLACE` các hàm này.
- Release: monotonic sequence/hash với predecessor; thay nội dung cần `previousHash`, xóa cần `expectedHash`, omission không revoke; `defaultGrants` chỉ cho permission mới. Cùng release thì kiểm toàn bộ code facts; drift chặn cả release mới và phải sửa bằng repair offline có duyệt rồi release sửa chữa tường minh. Không rollback bằng binary hay manifest cũ; giữ credential và revoke state, đi tới bằng forward release hoặc migration. Tiền tố role `system.` và `custom.` dự trữ (release từ chối); Root không phải role.
- Suspend là một chiều với authority; mở lại bằng `account.reactivate` (ADR-12) cho IAM. Gỡ suspend Root chỉ bằng repair mục 10.
- Audit (ADR-02, ADR-07): effect và audit cùng transaction. `ProductAuditOutbox` (login `outbox`) claim theo lease với `SKIP LOCKED`, gửi sink ngoài mọi transaction và fence, ack theo `lease_token`, retry backoff hữu hạn rồi park (`dead_at`); at-least-once, sink dedupe theo `eventId`. Chưa có sink hay nơi chạy worker nên event tích lũy trong outbox. Xem event bị park: `SELECT event_id,event_kind,delivery_attempts,dead_at FROM audit_outbox WHERE dead_at IS NOT NULL` bằng credential vận hành phù hợp; chưa có lệnh re-queue.
- Đồng hồ PostgreSQL là nguồn duy nhất cho `fresh`, `auth_time` và hạn phiên/token (ADR-05). Máy DB đồng bộ NTP chỉ slew sau boot (không step lúc chạy) và giám sát độ lệch; đồng hồ bị step lùi làm phiên mất `fresh` (fail closed), xử lý như sự cố vận hành.
- `/api/health/metrics`: histogram hữu hạn theo metric/mode (pool wait, lock wait/hold, transaction, revoke commit, retry/timeout/deadlock); không user/record ID hay SQL bind. Lỗi input của caller trả 400; lỗi lập trình/hạ tầng trả 503 và log tên lỗi, SQLSTATE, stack frame, không log message/query/parameter. Số đo ở [history](history.md) là fixture nhỏ, không phải SLO.

## 10. Repair gỡ suspend Root

Không đường runtime nào gỡ suspend Root. Repair offline có duyệt do owner bảng (`product_migration`), một transaction, chỉ disable đúng trigger `guard_root_lifecycle`:

```sql
BEGIN;
ALTER TABLE public.app_user DISABLE TRIGGER guard_root_lifecycle;
UPDATE public.app_user SET state='active' WHERE id='<root-uuid>' AND kind='root' AND state='suspended';
ALTER TABLE public.app_user ENABLE TRIGGER guard_root_lifecycle;
COMMIT;
```

Repair không ghi `audit_outbox`; bằng chứng là hồ sơ approval (reference, người duyệt, thời điểm, câu SQL). Sau đó chạy lại startup probe (trigger phải enabled); phiên cũ vẫn hết hiệu lực vì `auth_epoch` đã tăng khi revoke. Backup/restore, failover và durability chưa diễn tập; không promote primary thiếu watermark revoke đã acknowledge.

## 11. Chưa có

Sink và worker audit thật, IdP backchannel logout, approval authority/audit sink cho runbook Root, CLI thêm Root, file/export job nền, public signup, cache quyết định allow; GitHub workflow đã cập nhật nhưng chưa chạy thực. Capability chưa có không được quảng cáo; không commit, push hay deploy từ các lệnh ở đây.
