# ADR 0024 — Email dự phòng để khôi phục mật khẩu local và gửi mail qua SMTP

Ngày: 2026-10-18. **Trạng thái: Deferred** (2026-10-18, người dùng quyết theo review độc lập; xem mục "Hoãn — lý do và điều kiện mở lại"). Nội dung quyết định dưới đây giữ làm lịch sử, chưa được triển khai. Liên quan: [ADR 0019](0019-web-same-origin-and-oidc-browser-flow.md), [ADR 0022](0022-root-step-up-and-time-source.md) (thời gian), [ADR 0023](0023-sign-in-methods-and-account-linking.md) (email trùng chỉ cho link Google). **Mất mục đích theo [ADR 0027](0027-google-only-sign-in.md) (Accepted; đăng nhập/khôi phục local đã gỡ ở bước 3, 2026-10-19, migration `018`): sản phẩm chỉ Google; giữ làm lịch sử.**

## Bối cảnh — đã kiểm trong source

- `ProductIdentityService.requestPasswordReset(email)` (`auth/services/product-identity.service.ts`): chỉ account `active`, có `local_credential`, `email_canonical` khớp và `email_verified`; hủy token reset cũ, tạo token `reset` hạn 15 phút gắn `credential_version`, trả `{ userId, token }`. `resetPassword` (mode `revoke`): đổi hash nếu version khớp, `auth_epoch + 1`, `invalidate` (thu hồi mọi phiên + token), audit `identity.password-reset`.
- `POST /api/auth/recovery/request` trả 503 khi local tắt hoặc không có `recoveryDelivery`; luôn trả `{ status: 'accepted' }` và gọi delivery tách rời (`void Promise…catch`) để không lộ account tồn tại. `ProductRuntime.create(config)` trong `main.ts` không truyền delivery → hiện luôn 503.
- Không có trường email dự phòng, không có adapter gửi mail, không có dependency SMTP. Web chỉ có đăng nhập Google (ADR 0019): không có form mật khẩu, trang quên/đặt lại mật khẩu.
- Root hiện có chỉ Google (ADR 0023 §4) → không thuộc phạm vi ADR này.

## Quyết định

1. **Email dự phòng là trường riêng, chỉ để khôi phục mật khẩu local.** Bảng `account_recovery_email(user_id PK → app_user, email_canonical, verified_at NULL, updated_at)`; không unique giữa user; phải khác `email_canonical` đăng nhập; không dùng để đăng nhập, link OIDC (ADR 0023), enrollment (ADR 0020) hay liên hệ nghiệp vụ. Chỉ áp cho account có `local_credential`; account OIDC-only (gồm Root hiện có) không đặt được.
2. **Đặt/đổi email dự phòng** do chính người dùng, phiên local fresh (DB clock, ADR 0022): lưu `verified_at = NULL`, gửi link xác minh (token purpose mới `recovery-verify`, một lần, hạn 30 phút, gắn email đã hash) tới địa chỉ mới; mở link → `verified_at = statement_timestamp()`. Đổi sang địa chỉ khác gửi thông báo tới địa chỉ cũ đã xác minh (nếu có). Admin/HR không đặt được email dự phòng cho người khác.
3. **Quên mật khẩu**: người dùng nhập email **đăng nhập**. `requestPasswordReset` đổi điều kiện gửi: account `active`, có `local_credential`, có email dự phòng **đã xác minh**; link `APP_ORIGIN/reset-password#token=…` (fragment như activation, không vào log/URL server) gửi tới **email dự phòng**, không gửi tới email đăng nhập. Token giữ 15 phút, một lần, gắn `credential_version`. Link chỉ cho đặt mật khẩu mới (`resetPassword` hiện có): xong thì `auth_epoch + 1`, thu hồi mọi phiên/token, audit; không đổi email, phương thức, role hay dữ liệu nào khác. Mọi khôi phục khác (mất cả mật khẩu lẫn email dự phòng, bị chiếm email dự phòng, đổi email đăng nhập) chỉ qua CLI offline đã duyệt.
4. **Hiển thị che email** [chốt 2026-10-18]: `POST /api/auth/recovery/request` luôn trả cùng `{ status: 'accepted' }`, không bao giờ trả địa chỉ dự phòng. Địa chỉ đã che (giữ ký tự đầu của phần tên và phần domain, vd. `v***@g***.com`) chỉ xuất hiện trong mail và trong projection tài khoản của chính người dùng (`GET /api/auth/account` thêm `recoveryEmail: { masked, verified } | null` cho account có `local_credential`).
5. **Gửi mail qua SMTP** cấu hình trong `apps/api/.env.api` (không commit): `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS=implicit|starttls`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`. TLS bắt buộc (không plaintext), kiểm chứng chỉ, timeout kết nối/gửi ≤ 10 s, cấu hình sai → boot fail; thiếu toàn bộ → capability tắt (503 như hiện tại). Adapter là trusted code chọn lúc composition (port `RecoveryMailer`), thư viện SMTP pin exact version + kiểm license/changelog khi triển khai (ứng viên `nodemailer`, chưa kiểm version trong phiên này). Không log địa chỉ, token, nội dung mail hay credential SMTP; lỗi chỉ log loại + mã SMTP.
6. **Nội dung mail** là template cố định do code sở hữu, song ngữ vi + en trong cùng mail (API không đọc `Accept-Language`, không dịch theo request); plain text + HTML tối giản không ảnh/remote resource; chỉ chứa link, thời hạn, địa chỉ email đăng nhập đã che và lời nhắc bỏ qua nếu không yêu cầu.
7. **Độ bền gửi**: giữ cách hiện tại — gửi sau commit, tách khỏi response, không retry. `shortcut: mất mail khi SMTP lỗi; người dùng gửi lại yêu cầu sau rate limit; nâng cấp lên outbox + worker khi cần đảm bảo giao nhận`. Concurrency gửi giới hạn (≤ 4 đồng thời, hàng đợi ≤ 100, vượt thì bỏ và log), dọn khi shutdown.
8. **Giao diện** [chốt 2026-10-18]: **không** thêm form đăng nhập mật khẩu hay trang quên/đặt lại mật khẩu trên web; ADR 0019 giữ nguyên "trang đăng nhập chỉ Google". Account local là ngoại lệ, operator tạo bằng CLI (`identity:enroll --method local` + `identity:invite`). Hệ quả chấp nhận: đặt email dự phòng và khôi phục mật khẩu chỉ dùng qua API; link trong mail trỏ tới một URL do cấu hình chỉ định (`RECOVERY_RESET_URL`, mặc định `APP_ORIGIN/reset-password`) mà web hiện chưa có trang — triển khai trang là quyết định sau. Account local không đăng nhập được trên web hiện tại.

## Đã chốt với người dùng — 2026-10-18

- Địa chỉ che chỉ trong mail + projection tài khoản của chính người dùng; trang/endpoint quên mật khẩu không tiết lộ gì.
- Không thêm form mật khẩu/trang khôi phục trên web.
- Account local là ngoại lệ, tạo qua CLI.

## Kiểm chứng bắt buộc

PostgreSQL integration: đặt email dự phòng cần phiên local fresh; trùng email đăng nhập bị từ chối; token xác minh một lần/hết hạn/sai purpose; reset chỉ gửi tới email dự phòng đã xác minh, account không có/không xác minh/OIDC-only/suspended trả cùng `accepted`; reset thu hồi phiên và không đổi gì khác; rate limit. Adapter: mailer giả ghi nhận đúng địa chỉ/nội dung, không log PII; cấu hình SMTP thiếu/sai → 503/boot fail; TLS bắt buộc. Thử SMTP thật của công ty trước khi coi là vận hành; fixture không chứng nhận provider.

## Hoãn — lý do và điều kiện mở lại

**Lý do hoãn** (2026-10-18):

- Deployment đích dùng `AUTH_METHODS=oidc` (`apps/api/.env.example:8`) nên endpoint khôi phục trả 503; tài khoản local là ngoại lệ tạo bằng CLI, không đăng nhập được trên web.
- M1: §3 gửi link `APP_ORIGIN/reset-password#token` mâu thuẫn §8 "không trang khôi phục". Web không có route `reset-password` (route `*` → `NotFoundPage`, `apps/web/src/app.tsx:57`), nên token nằm lại thanh địa chỉ/lịch sử. Khi mở lại phải chọn: thêm trang tối thiểu reset/verify, hoặc mail chứa mã để dán (bỏ `RECOVERY_RESET_URL`).

**Quyết định người dùng 2026-10-18 (S7)**: khi mở lại, Root local (`bootstrap --method local`, có mật khẩu và email) được đặt email dự phòng và reset mật khẩu qua mail như IAM; người dùng chấp nhận độ đảm bảo của Root bằng độ an toàn của hộp thư dự phòng. Root OIDC (không email, không `local_credential`) vẫn ngoài phạm vi. §1 ("gồm Root hiện có không đặt được") và "Bối cảnh" dòng cuối chỉ đúng cho Root OIDC. Định nghĩa `local fresh` ở [ADR 0022](0022-root-step-up-and-time-source.md).

**Rủi ro trong lúc hoãn (S8)**: tài khoản local không có đường khôi phục mật khẩu nào. Đã kiểm: chưa có CLI reset mật khẩu offline cho tài khoản local `active`; `invite`/`issueActivation` đòi account `pending`.

**Điều kiện mở lại — phải giải quyết trước khi chuyển sang Accepted:**

- B1: xác minh email dự phòng phải là `POST` có CSRF, token gắn `user_id` + hash địa chỉ + version dòng email dự phòng; không bao giờ `GET` đổi trạng thái (bộ quét link trong mail có thể tự xác minh).
- B2: token reset hiện chỉ gắn `credential_version` và `resetPassword` không kiểm lại state (`auth/services/product-identity.service.ts` `requestPasswordReset`/`resetPassword`). Đặt/đổi/xóa email dự phòng phải tiêu thụ mọi token reset và `recovery-verify` trong transaction `revoke`; token reset gắn thêm version email dự phòng; `resetPassword` kiểm lại account active, email dự phòng còn verified và version khớp.
- S1: nhánh có tài khoản chạy thêm UPDATE + INSERT so với nhánh không → side-channel thời gian; gộp thành một câu SQL CTE; cooldown theo tài khoản lưu trong DB. Rate limit hiện có 20/15 phút theo IP và theo email, 200 theo /48, có thể bị đẩy bucket.
- S2: báo (không kèm link) tới email đăng nhập và địa chỉ cũ khi đặt/đổi/xóa và sau reset; giữ địa chỉ cũ đã xác minh tới khi địa chỉ mới xác minh; mode `revoke` + audit.
- S3: `canonicalLoginEmail` hiện nhận cả `,;<>"()` → dùng grammar ASCII dot-atom/LDH ≤ 254; `to` là object một địa chỉ, subject hằng, HTML-escape.
- S4: bỏ `RECOVERY_RESET_URL`, dùng đường dẫn cố định trên `APP_ORIGIN` theo ADR 0019.
- S5: delivery hiện là `void Promise…catch` trong `auth/controllers/auth.controller.ts`, không có owner. Mailer do `ProductRuntime` sở hữu, enqueue đồng bộ, job chụp địa chỉ trong cùng transaction, shutdown dừng nhận/hủy sau ≤ 10 s và đóng transport; `ProductRuntime.onApplicationShutdown` hiện chỉ đóng pool.
- S6: CHECK `purpose` hiện là `('activation','reset','oidc-activation')` (migration `005`) → forward migration DROP/ADD; chỗ lưu hash email; `protect_token_consumption` bị probe so khớp chính xác; grants + `expectedPrivileges`; audit kinds mới trong `ProductIdentityAuditKind`; mode `revoke`; số migration kế tiếp sau `014`.
- N5: giữ điều kiện `email_verified`. N6: STARTTLS bắt buộc, TLS ≥ 1.2; quyết định có `verify()` lúc boot hay không. N7: liệt kê endpoint mới + phân loại route/CSRF/OpenAPI; cập nhật dòng "Recovery delivery default unavailable" ở `apps/api/AGENTS.md` khi mở lại.
