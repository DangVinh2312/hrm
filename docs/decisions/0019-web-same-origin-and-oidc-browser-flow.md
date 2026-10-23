# ADR 0019 — Web cùng origin: tiền tố `/api` và luồng OIDC trên trình duyệt

Ngày: 2026-10-17. **Trạng thái: Accepted** — người dùng chọn ngày 2026-10-17 (T1, D10). **Thu hẹp bởi [ADR 0027](0027-google-only-sign-in.md) §6** (triển khai 2026-10-18): hai đích `/account/sign-in-methods?link=confirm|failed` của ADR 0023 đã gỡ; callback chỉ còn `/` và `/login?error=oidc`. Thiết kế: [HRM design](../superpowers/specs/2026-10-16-hrm-design.md) §10.

## Bối cảnh

React SPA (`apps/web`) và API phục vụ cùng origin. Trước quyết định này, API đặt route ở gốc (`/auth`, `/documents`, `/health`, `/openapi.json`…), dễ trùng với route trang. `GET /auth/oidc/callback` trả JSON `{status}`, nên khi Google redirect về, trình duyệt dừng ở trang JSON. Base phát activation secret qua CLI ra file; HRM không có mail provider (D10: mời từng người).

## Quyết định

1. **Mọi route API có tiền tố `/api`**, khai báo ngay trong `@Controller(...)` để inventory, OpenAPI và guard đọc cùng metadata. Đường dẫn trang web không bắt đầu bằng `/api`. Cookie giữ `Path=/` và tên cũ; CSRF/Origin, trusted proxy, status và projection không đổi. Redirect URI OIDC phải là `<APP_ORIGIN>/api/auth/oidc/callback`; config cũ dùng `/auth/oidc/callback` bị từ chối khi boot.
2. **Callback OIDC trả `303`** tới đường dẫn cố định cùng origin: thành công (login, activation, link, reauth) → `/` (purpose `link`: thay bằng hai đích ở mục bổ sung theo ADR 0023 bên dưới); lỗi xác thực (`ProductAuthenticationError`) → `/login?error=oidc`, không kèm chi tiết. Không nhận URL đích từ request (không open redirect). Kiểm tra state/nonce/PKCE/issuer, one-time và browser binding giữ nguyên. Lỗi khác (DB, cấu hình) vẫn qua error filter như trước để được ghi log và trả lỗi an toàn.
3. **Kích hoạt bằng link có mã sau `#`**: HR gửi `https://<origin>/activate#token=<secret>`. Fragment không gửi lên server hay log truy cập; trang đọc mã, xóa fragment khỏi lịch sử bằng `history.replaceState`, rồi gọi `POST /api/auth/oidc/activate`. Trang có ô dán mã để dùng khi chỉ có mã.
4. **Trang đăng nhập chỉ có Google.** Route mật khẩu local của base vẫn tồn tại ở API (Root/vận hành dùng ngoài web); web không hiển thị form mật khẩu.
5. **Dev**: Vite dev server proxy `/api` tới API. Cách phục vụ production (reverse proxy hay API phục vụ static) chốt ở D13.

## Hệ quả

- Thay HTTP contract: client/script cũ gọi đường dẫn gốc sẽ nhận 404. Chưa có triển khai thật (ADR 0014), nên không giữ alias.
- OpenAPI hash và route inventory trong `apps/api/test/structure.spec.ts` đổi có chủ ý.
- Activation secret vẫn phải được giao qua kênh riêng; link trong chat/email là bí mật cho tới khi dùng hoặc hết hạn.
- Không thay semantics identity, session, Root, audit, SQL hay credential matrix.

## Bổ sung — 2026-10-17: redirect HTTP trên loopback cho phát triển local

Người dùng chấp nhận chạy local qua `http://localhost` không TLS. `trustedRedirectUrl` (`apps/api/src/auth/services/product-oidc.service.ts`) nhận `redirectUri` HTTP chỉ khi host là `localhost`, `127.0.0.1` hoặc `[::1]` và không có userinfo/query/fragment (RFC 8252 §7.3); mọi host khác vẫn bắt buộc HTTPS, issuer luôn HTTPS. Production không đi được nhánh này vì config từ chối `APP_ORIGIN` HTTP khi `NODE_ENV=production` và callback phải cùng origin `APP_ORIGIN`. Trên origin HTTP cookie không có tiền tố `__Host-`/`Secure` (đã có từ trước); state, nonce, PKCE, one-time state và kiểm Origin/CSRF giữ nguyên. Test: `apps/api/test/product-identity.spec.ts`.

## Bổ sung — 2026-10-18 theo [ADR 0023](0023-sign-in-methods-and-account-linking.md): hai đích cố định cho purpose `link`

Callback của attempt `purpose = link` không còn ghi binding, chỉ lưu proof chờ xác nhận. Tập đích redirect cố định thêm hai giá trị, chỉ dùng cho attempt đã xác định là `link`: proof đã lưu → `/account/sign-in-methods?link=confirm`; lỗi xác thực sau khi đã biết `purpose = link` (đổi code/ID token, `auth_time`, email, phiên không còn fresh, tuple thuộc user khác…) → `/account/sign-in-methods?link=failed` (phiên vẫn còn nên không về `/login`). Lỗi trước khi xác định được attempt (state không tìm thấy/hết hạn, browser không khớp) và lỗi của mọi purpose khác vẫn về `/login?error=oidc`. Cả bốn đích là hằng số trong code (`auth/controllers/oidc.controller.ts`, outcome `OidcCallbackOutcome` ở `auth/auth.http-port.ts`), không lấy từ request; lỗi không phải xác thực vẫn qua error filter. Test: `apps/api/test/product-sign-in-methods.integration-spec.ts` (HTTP qua AppModule thật với IdP giả), `apps/api/test/structure.spec.ts`.

## Bổ sung — 2026-10-23 theo [ADR 0037](0037-auth-me-and-employee-me.md): route bootstrap

`GET /api/hr/me` bị xóa, không alias. Tài khoản và menu server cấp: `GET /api/auth/me` (`@Controller('api/auth')`, authentication). Hồ sơ nhân viên của chính người dùng: `GET /api/hr/employees/me` (`@Controller('api/hr/employees')`, khai báo trước `:id`). Cả hai khai route ngay trong `@Controller` như mục 1.
