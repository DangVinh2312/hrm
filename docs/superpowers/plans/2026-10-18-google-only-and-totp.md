# Kế hoạch — Chỉ Google, TOTP 2FA, Root/IAM theo email

Ngày: 2026-10-18. Nguồn thiết kế: [ADR 0026](../../decisions/0026-totp-second-factor.md) (TOTP, Accepted — đang triển khai), [ADR 0027](../../decisions/0027-google-only-sign-in.md) (chỉ Google, Accepted — chưa triển khai), [ADR 0025](../../decisions/0025-step-up-by-local-factors-and-single-google-binding.md) (Accepted, thu hẹp bởi 0027). Trạng thái lấy từ checkbox dưới đây; bước chưa đánh dấu là chưa có bằng chứng. Sản phẩm đang phát triển, chưa release production.

## Trạng thái đầu vào (đã kiểm 2026-10-18)

- Working tree nhánh `version/single-app`, chưa commit. Lần chạy cuối: lint/typecheck/build exit 0; unit 20 + 243 + 59; integration 196/196; e2e 1/1; browser 9/9. `format:check` đỏ đúng 3 file có từ trước (`product-authority.service.ts`, `apps/api/tools/product.ts`, `docs/HR_Web_Requirement_Tieng_Viet.md`) — không format khi chưa hỏi.
- DB local (container `hrm-postgres-1`, cổng 55433): đã áp product migrations tới `015`; Root `b86ec8f8-ae89-4187-8a16-a96152d57149` active, tạo theo `sub`, email đã gắn bằng `root:set-email` và đã xác minh qua đăng nhập Google, một binding, không có mật khẩu local. Chỉ chạm DB local khi người dùng cho phép.
- Thử Google thật: đăng nhập được; xác thực lại bằng Google không chạy (Google không trả `auth_time` cho app chưa publish/verify) — lý do của ADR 0025/0027.

## Review độc lập ADR 0026/0027 (2026-10-18) — phải xử lý ở bước 0

Bằng chứng do subagent đọc source; các điểm 2, 3, 6 đã được kiểm lại trực tiếp.

1. **Đăng ký 2FA bằng phiên bị chiếm** — người dùng **chấp nhận rủi ro** (đã ghi ở ADR 0026). Không thêm giới hạn.
2. **`reset-mfa` cho Root bằng `bootstrap`**: `guard_root_lifecycle` (`015:31-36`) chặn bootstrap tăng `auth_epoch` của Root active; bootstrap không có quyền bảng MFA; login `identity` (runtime) có DELETE trên bảng MFA nên xóa được 2FA của Root. Cần: body guard mới (bootstrap tăng epoch khi state + email giữ nguyên, chỉ cho reset-mfa), GRANT có giới hạn + trigger chỉ cho bootstrap xóa MFA của `kind='root'`, CLI chạy bằng identity từ chối target Root; cập nhật `protectionFunctions`/`expectedPrivileges`; migration 016 áp qua `db:provision`.
3. **Root theo email "tạo pending kind=root"**: `guard_root_kind` cấm INSERT `kind='root'` (`012:64-67`); bootstrap không có INSERT `app_user` hay SELECT `oidc_provider`; `bootstrapProductRoot` đòi target pending có sẵn. Cần: bootstrap INSERT tài khoản pending `iam` (GRANT cột + probe) rồi promote trong cùng transaction READ COMMITTED; giữ `guard_root_kind`; email trùng → `collision`; audit không ghi email.
4. **Kích hoạt Root theo email**: `invitation()` JOIN `external_identity` và so `subject` (`product-oidc.service.ts:~747,~577`); `enrollmentHash` chứa subject/binding_version; reissue đòi `bindings === 1` (`product-manifest.service.ts:~741`). Cần hash mới theo (user, issuer, email, auth_epoch, token), ca `sub` đã thuộc tài khoản khác, hai callback đồng thời → một binding, đặt `email_verified`/`state`/epoch trong **một** UPDATE (`require_email_epoch`).
5. **Brute force TOTP**: rate limit 20/15 phút theo user (~1920 lần/ngày, ±1 bước ≈ 0,6 %/ngày). Thêm bộ đếm sai liên tiếp trong `mfa_totp` (vd. 10 → khóa/đòi đăng nhập lại), reset khi đúng.
6. **Verify kéo dài phiên**: `createSession` đặt `expires_at = now + 12h`, `authenticated_at = now` (`product-identity.service.ts:~383`); `reauthenticate` gán `method: 'local'`. Phiên sau verify phải chép method/issuer/subject/binding_version/provider_version/authenticated_at/expires_at của phiên cũ, chỉ đặt `reauthenticated_at`; chốt `assurance` (`'mfa'` map mức 2 ở `product-authority.service.ts:~319`).
7. **Replay/race**: confirm đặt `last_used_step`; UPDATE có điều kiện khớp đúng secret hiện hành; mã khôi phục khóa `(user_id, code_hash)`, `used_at` chỉ NULL → giá trị (mẫu `protect_token_consumption`, `008:32-40`); setup không tăng epoch — chỉ confirm/gỡ/reset; chốt trigger hay kiểm code.
8. **Khóa mã hóa**: lệnh xoay khóa offline lấy khóa từ đâu (khóa không ở ops env); boot kiểm mọi `key_id` trong DB có trong map (fail closed); AAD gồm `user_id`, `key_id` và nhãn mục đích.
9. **ADR 0026 thân bài còn nhánh mật khẩu** (§6 setup, "mở rộng reauthenticate", ca kiểm "có mật khẩu mà không fresh") — viết lại theo 0027.
10. **Thứ tự 2 → 3**: bỏ link trước khi gỡ local làm tài khoản chỉ có mật khẩu mất đăng nhập vĩnh viễn (Root không tạo lại được). Migration gỡ local phải preflight: fail nếu còn tài khoản active có `local_credential` mà không có binding bật.
11. **Migration bước 2/3 còn thiếu**: CHECK `one_time_token` (`005:12-14`, không login nào DELETE được — xóa dòng cũ trước khi siết); CHECK `oidc_login_attempt.purpose` còn `'link','reauth'` (`001:75`); CHECK method/`credential_version` của `application_session` (`001:56-62`); `resolve_session` LEFT JOIN `local_credential` (`012:21,25`) — thay body cần owner, sửa `sessionOwnerAcl`, quyền bootstrap `local_credential.user_id:SELECT`; `logout`/`invalidate` tham chiếu `oidc_link_proof`; body guard còn nhắc `'activation'` (`012:93,127`).
12. **ADR 0027 §8**: "không route/CLI ghi `policy_rule`/`user_boundary`" sai — `sync` ghi `policy_rule` code-owned và `user_boundary` seed; sửa thành "fact runtime".
13. **Hệ quả còn thiếu**: `GET /api/auth/options` + `localEnabled`; env cũ còn `AUTH_METHODS` → fail boot; `POST /api/auth/oidc/reauthenticate`; `GET /api/auth/account` bỏ `password`/`removable` → schema zod web (`account.client.ts`); nút xác thực lại Google ở `hr/components/mutation-error.component.tsx` và `account/components/refusal-alert.component.tsx`; `pnpm-workspace.yaml` `allowBuilds.argon2`; fixture test chèn phiên local (`hrm-stack.helper.ts`, ~18 file test), `e2e/stack.helper.ts` đặt `AUTH_METHODS`; ADR 0019 (`?link=`) và ADR 0020 §7 bị thay; key lỗi MFA mới theo quy tắc AGENTS; audit kinds mới; audit `mfa-reset` như `root.revoke`.

## Các bước

### Bước 0 — Hoàn thiện ADR

- [x] Sửa ADR 0026 theo review 2, 5–9 (viết lại thân bài không còn nhánh mật khẩu; chốt schema, replay, khóa, phiên sau verify, reset-mfa Root). 2026-10-18, source đối chiếu lại trực tiếp.
- [x] Sửa ADR 0027 theo review 3, 4, 10–13; ghi thêm các ADR bị thay (0019, 0020 §7).
- [x] Trình bày cho người dùng các điểm cần quyết còn lại bằng câu hỏi lựa chọn (2026-10-18, người dùng chọn cả 6 phương án đề xuất): sai 10 lần liên tiếp → đăng xuất hết, bộ đếm chỉ về 0 khi đúng; phiên sau verify giữ nguyên `assurance`; xoay khóa = mã hóa lại khi dùng + boot kiểm `key_id`; Root tự gỡ/thay 2FA trên web như IAM (trigger chỉ giới hạn bootstrap vào Root); trigger DB tự tăng `auth_epoch`; Root ghim `(issuer, email)` bằng `oidc_email_enrollment`.
- [x] Người dùng duyệt nội dung ADR 0026/0027 đã sửa → chuyển sang Accepted (cập nhật dòng "thu hẹp bởi 0027 (Proposed)" ở ADR 0025). 2026-10-18: header hai ADR đã ghi Accepted; ADR 0025 không còn chữ "Proposed"; người dùng xác nhận tick qua câu hỏi lựa chọn.

Đính chính review khi đối chiếu (2026-10-18): (điểm 13) `GET /api/auth/options` trả `{ methods }`, không có `localEnabled`; `localEnabled` là config (`config/app.config.ts`) và option của `ProductOidcService`; web không gọi route này. (điểm 2) Trigger chặn login `identity` xóa 2FA của Root không thêm bảo vệ thật vì `identity` đã INSERT được cả bảng `application_session` (kể cả `reauthenticated_at`); ADR 0026 chỉ giới hạn `bootstrap` vào Root và kiểm "identity không reset Root" bằng code.

### Bước 1 — TOTP 2FA (ADR 0026)

- [x] Unit trước: vector RFC 4226/6238, base32, URI `otpauth`, AES-256-GCM (AAD/khóa/nonce sai bị từ chối). 2026-10-18, `apps/api/test/product-mfa.spec.ts`; ledger Bước 1.
- [x] Migration 016 + probe/ACL + config khóa (boot fail khi thiếu/sai, `apps/api/.env.example`), test PostgreSQL theo mục "Kiểm chứng bắt buộc" của ADR 0026. 2026-10-18, `product-mfa.integration-spec.ts`, `workspace.smoke-spec.ts`; ledger Bước 1.
- [x] Routes `/api/auth/mfa/*`, `fresh` từ verify (phiên giữ nguyên hạn), audit, rate limit + bộ đếm sai, OpenAPI + hash, locale + key lỗi. 2026-10-18 (không thêm key lỗi mới, ADR 0026 §8); ledger Bước 1.
- [x] CLI `reset-mfa` (Root qua bootstrap, IAM qua identity) + guard. 2026-10-18, `product-cli.integration-spec.ts`, `product-mfa.integration-spec.ts`; ledger Bước 1.
- [x] Web: mục 2FA, QR (đề xuất thư viện, hỏi người dùng trước khi cài), mã khôi phục, hộp nhập mã khi thiếu `fresh`; browser E2E; ảnh 390/1366. 2026-10-18 (`qrcode.react` 4.2.0, người dùng xác nhận đã duyệt), `apps/web/e2e/mfa.e2e-spec.ts`; ledger Bước 1.

### Bước 2 — Bỏ xác thực lại bằng Google, bỏ link/gỡ, một binding mỗi user

- [x] Test trước; gỡ routes/purpose/bảng proof; partial unique index binding đang bật; web chỉ hiển thị; nút xác thực lại chuyển sang 2FA. 2026-10-18, migration `017`; ledger Bước 2.

### Bước 3 — Gỡ code local

- [x] Preflight migration (review 10, 11); gỡ routes/CLI/bảng/CHECK/nhánh `resolve_session`; fixture test chuyển sang phiên OIDC. 2026-10-19, migration `018`, `oidc-fixture.helper.ts`; ledger Bước 3.

### Bước 4 — Root và IAM chỉ theo email

- [ ] `root:bootstrap --issuer --email`, kích hoạt theo email verified (review 3, 4); bỏ `--subject` ở bootstrap/reissue/enroll/invite; `docs/hrm-local-operations.md` bỏ hướng dẫn lấy `sub`.

Mỗi bước: test lỗi trước rồi implement; chạy lint, typecheck, test:unit, integration liên quan rồi full integration, e2e, browser khi đụng web; ghi ledger (lệnh, exit code, số test, lỗi môi trường tách riêng).
