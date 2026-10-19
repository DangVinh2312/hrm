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

`test:browser` tự dựng stack dùng một lần: PostgreSQL container, CLI `provision`/`migrate`/`sync`/`bootstrap`/`enroll` của API, process API đã build, IdP OIDC giả qua HTTPS với CA sinh cho từng lần chạy, web build phục vụ HTTPS và proxy `/api`. Harness không đọc `apps/api/.env.*` và chỉ dùng dữ liệu giả.

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

## Root bằng Google OIDC (theo email)

Theo [ADR 0027](decisions/0027-google-only-sign-in.md) §3–4: Root tạo bằng một lệnh từ email của chính tài khoản Google đó; không cần `sub`. Chỉ làm một lần cho mỗi database (marker Root dùng một lần; tạo lại cần database mới).

1. Database đã `provision` + `manifest:sync` đúng build hiện tại (`root:bootstrap` từ chối khi manifest lệch) và `OIDC_PROVIDERS_JSON`/DB có provider Google đang bật. Sinh một UUID cho lần bootstrap (`node -e "console.log(crypto.randomUUID())"`).
2. Tạo Root và ghi token kích hoạt ra file `0600` ngoài repo (lệnh in id Root, giữ lại cho `root:revoke`/`root:reset-mfa`):

```sh
pnpm run root:bootstrap -- --operation <operation> \
  --issuer https://accounts.google.com --email <email Google của Root> \
  --activation-file <đường dẫn ngoài repo>
```

3. Trong 15 phút, mở `<APP_ORIGIN>/activate#token=<nội dung file>` (vd. `http://localhost:6368/activate#token=…`), bấm kích hoạt và đăng nhập Google đúng tài khoản. Google phải trả email đó đã xác minh; email khác thì bị từ chối, không gắn nhầm. Xóa file token sau đó. Hết hạn hoặc thất lạc (và chưa kích hoạt) thì `pnpm run root:reissue -- --issuer https://accounts.google.com --activation-file <file mới>`.
4. Root tạo theo `sub` từ trước ADR 0027 (không có email) chỉ dùng `root:set-email` để chuyển dữ liệu cũ; Root mới không cần bước này.

Root bypass phân quyền nhưng mọi thao tác ghi cần mã 2FA (≤ 300 giây) và đều được audit.

## Nhân viên (IAM)

Chỉ theo email, không còn lời mời theo `sub`: `pnpm run identity:enroll -- --user <uuid> --issuer https://accounts.google.com --email <email nhân viên>` tạo tài khoản chờ 7 ngày; nhân viên mở `<APP_ORIGIN>/login` và đăng nhập Google đúng email đó (đã xác minh) là tài khoản được kích hoạt. Cấp role/grant/boundary cho IAM chưa có route hay CLI (ADR 0027 §9).
