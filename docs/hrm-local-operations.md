# HRM — Vận hành local và kiểm thử

Ngày: 2026-10-17. Phạm vi: máy phát triển và CI. Production (hosting, reverse proxy, phục vụ static) chưa chốt — D13.

## Toolchain

- Node 24 theo `.nvmrc` (`>=24.15.0 <25`), pnpm `12.3.4` theo `package.json#packageManager`. Chỉ dùng pnpm.
- Docker cho PostgreSQL disposable (integration, API E2E, browser E2E).
- Browser E2E cần Chromium của Playwright và thư viện hệ thống. Một lần cho mỗi máy:

```sh
pnpm install --frozen-lockfile
pnpm --filter @hrm/web exec playwright install chromium
# Cần quyền root để cài thư viện hệ thống (libnss3, libnspr4, libasound2…):
sudo pnpm --filter @hrm/web exec playwright install-deps chromium
```

## PostgreSQL local (Compose)

`apps/api/compose.yaml` dùng project `hrm` (volume `hrm_postgres-data`), cổng host mặc định `127.0.0.1:55433` và database `hrm` trong các file mẫu `apps/api/.env.*.example`; base-auth giữ `5432`/`product_authz` nên hai stack chạy song song không trùng cổng, volume hay database. Đổi `POSTGRES_PORT` thì sửa cùng cổng trong mọi URL của `apps/api/.env.ops` và `apps/api/.env.api`.

```sh
docker compose -f apps/api/compose.yaml --env-file apps/api/.env.ops up -d --wait postgres
```

### Nâng cấp database local đã có (HR T2 → T3)

Migration HR (`HrmAuthorization…100`, `HrmEmployee…101`, `HrmTeam…102`) đổi owner/body của hàm `hr_register_object`, nên chạy bằng `pnpm run db:provision` (cần các `PRODUCT_*_PASSWORD` trong `apps/api/.env.ops`; chỉ áp migration còn thiếu), không bằng `db:migrate`. `HrmEmployee…101` thêm `employee.hired_on NOT NULL`: nếu bảng `employee` đã có dòng thì migration dừng và cần mapping dữ liệu được duyệt trước. Sau đó khởi động API (hoặc `pnpm run manifest:sync`): manifest lên release `5` và anchor `hr_company` được tạo trước readiness.

## Checks

```sh
pnpm run format:check   # hiện fail riêng ở docs/HR_Web_Requirement_Tieng_Viet.md (file gốc, giữ nguyên)
pnpm run lint
pnpm run typecheck      # API + web (app và e2e)
pnpm run build          # API tsc + web vite build
pnpm run test:unit      # workspace + API node:test + web Vitest
pnpm run test:integration
pnpm run test:e2e       # API HTTP E2E
pnpm run test:browser   # web Playwright với stack thật (cần build API trước)
```

`test:browser` tự dựng stack dùng một lần: PostgreSQL container, CLI `provision`/`migrate`/`sync`/`invite` của API, process API đã build, IdP OIDC giả qua HTTPS với CA sinh cho từng lần chạy, web build phục vụ HTTPS và proxy `/api`. Harness không đọc `apps/api/.env.*` và chỉ dùng dữ liệu giả.

## Xem giao diện local

```sh
pnpm run build
pnpm --filter @hrm/web run dev:stack
```

Lệnh in URL `https://localhost:<port>` (chứng chỉ tự ký) và đường dẫn tới file `0600` chứa link kích hoạt cho nhân viên giả `demo-employee`. IdP giả tự đăng nhập như nhân viên đó. Ctrl+C dừng và xóa container. Không dùng cho tài khoản hay Google thật.

## Cấu hình với Google Workspace (D10)

OIDC của API bắt buộc HTTPS cho issuer; redirect URI và `APP_ORIGIN` phải HTTPS, trừ phát triển local trên `http://localhost` (host loopback, không production — bổ sung ADR 0019).

- `apps/api/.env.api` (không commit; không đặt `AUTH_METHODS` — biến này làm boot fail, ADR 0027): `APP_ORIGIN=https://<origin>`, `OIDC_PROVIDERS_JSON=[{"issuer":"https://accounts.google.com","clientId":"<client id>","clientSecret":"<secret>","redirectUri":"https://<origin>/api/auth/oidc/callback","version":"1","assuranceMappings":[]}]`. Redirect URI phải khai báo y hệt trong Google Cloud Console.
- `apps/web/.env.local` hoặc biến lúc build: `VITE_OIDC_ISSUER=https://accounts.google.com`. Mọi biến `VITE_*` nằm trong bundle công khai; không đặt secret.
- Dev server (`pnpm --filter @hrm/web run dev`) proxy `/api` tới `HRM_API_TARGET` (mặc định `http://127.0.0.1:3000`). Đăng nhập Google qua dev server trên localhost: trong `apps/api/.env.api` đặt `APP_ORIGIN=http://localhost:6368`, redirect URI `http://localhost:6368/api/auth/oidc/callback` (khai báo y hệt trong Google Cloud Console) và `PORT` khác 6368 (vd. 6369); chạy `pnpm run start:dev` rồi `HRM_API_TARGET=http://127.0.0.1:6369 VITE_OIDC_ISSUER=https://accounts.google.com pnpm --filter @hrm/web exec vite --host localhost --port 6368 --strictPort` và mở `http://localhost:6368` (không dùng `127.0.0.1`: origin phải khớp).

## Root bằng Google OIDC (phương án A)

Theo [ADR 0021](decisions/0021-root-oidc-enrollment.md): web chỉ có Google nên Root cần `sub` Google của chính tài khoản đó. Chỉ làm một lần cho mỗi database (marker Root dùng một lần; tạo lại cần database mới).

1. Lấy `sub`: mở [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), chọn scope `openid email`, đăng nhập đúng tài khoản Root, đổi code lấy token rồi giải mã phần payload của `id_token` trên máy mình (base64url) và đọc `sub` (chuỗi số). Không dán token vào công cụ trực tuyến, không lưu token; chỉ giữ `sub`.
2. Database đã `provision` + `manifest:sync` đúng build hiện tại (`root:bootstrap` từ chối khi manifest lệch). Sinh hai UUID (`node -e "console.log(crypto.randomUUID())"`): `<user>` cho account, `<operation>` cho lần bootstrap.
3. Tạo account pending gắn sẵn `sub`, rồi promote Root và ghi token kích hoạt ra file `0600` ngoài repo:

```sh
pnpm run identity:enroll -- --user <user> --method oidc \
  --issuer https://accounts.google.com --subject <sub>
pnpm run root:bootstrap -- --user <user> --operation <operation> --method oidc \
  --issuer https://accounts.google.com --subject <sub> --activation-file <đường dẫn ngoài repo>
```

4. Trong 15 phút, mở `<APP_ORIGIN>/activate#token=<nội dung file>` (vd. `http://localhost:6368/activate#token=…`), bấm kích hoạt và đăng nhập Google đúng tài khoản. Xóa file token sau đó. Hết hạn thì `pnpm run root:reissue -- --user <user> --method oidc --issuer https://accounts.google.com --subject <sub> --activation-file <file mới>`.

5. (Tùy chọn, [ADR 0023](decisions/0023-sign-in-methods-and-account-linking.md) §4) Gắn email cho Root (nhãn TOTP `HRM:<email>`; "Liên kết thêm" đã gỡ theo ADR 0027): cần migration `015` (`pnpm run db:provision`), rồi `pnpm run root:set-email -- --user <user> --operation <uuid mới> --email <email của tài khoản Google đó>`. Mọi phiên Root bị đăng xuất; đăng nhập lại bằng Google, email thành đã xác minh nếu Google trả đúng email đó đã xác minh.

Sai `sub` hoặc đăng nhập tài khoản Google khác thì kích hoạt bị từ chối, không gắn nhầm. Root bypass phân quyền nhưng mọi thao tác ghi cần xác thực lại (≤ 300 giây) và đều được audit.

## Mời nhân viên

```sh
pnpm run identity:invite -- --user <uuid> --method oidc \
  --issuer https://accounts.google.com --subject <Google sub> --activation-file <đường dẫn ngoài repo>
```

Gửi cho nhân viên link `https://<origin>/activate#token=<nội dung file>` qua kênh riêng. Mã dùng một lần; phần sau `#` không lên server/log, trang xóa nó khỏi thanh địa chỉ. Xóa file sau khi gửi.
