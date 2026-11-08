# ADR-21 — Email đăng nhập chỉ ASCII; từ chối body có surrogate đơn lẻ hoặc UTF-8 sai

Trạng thái: **Accepted** (2026-11-05); NestJS và contract chung đã có code và regression unit/integration/HTTP (2026-11-06), ca e2e chưa chạy; Go chưa làm phần email (§1). Người dùng chọn các phương án đề xuất trong lúc làm F2 (2026-11-05; phần UTF-8 sai chốt 2026-11-06) của [ADR-20](ADR-20-go-gin-backend-migration.md). Đây là sửa lỗi, hợp với Q2 của ADR-20 (đóng băng tính năng, chỉ sửa lỗi ở cả hai runtime).

## Quan sát từ code hiện tại

### Email

- `canonicalLoginEmail` (`apps/api/src/authentication/services/product-identity.service.ts:107-111`) nhận mọi chuỗi khớp `^[^\s@]+@[^\s@]+\.[^\s@]+$`, dài tối đa 254 đơn vị UTF-16, rồi gọi `toLowerCase()`. Không giới hạn ASCII.
- Bên gọi: `verifiedEmail` (claim của IdP, `oidc-claims.helper.ts`), `provisionAccount`, `changeEmail`, Root (`product-root.service.ts`, `product-root-lifecycle.service.ts`).
- Hàm SQL `provision_oidc_account` và `change_iam_account_email` chỉ kiểm `p_email = lower(p_email)` và grammar; cột `oidc_email_enrollment.email_canonical` chỉ kiểm `= lower(...)`.
- Duyệt mọi code point bằng Node 24: chỉ U+212A (KELVIN SIGN) có `toLowerCase` toàn ASCII (`k`). Vì vậy `"Kim@example.com"` chuẩn hóa thành `kim@example.com`.
- `liveEnrollment` khớp email IdP đã chuẩn hóa với enrollment đang chờ. Nếu IdP xác minh một địa chỉ chứa U+212A, người đăng nhập có thể gắn subject của mình vào tài khoản pending của người khác. Google chỉ cho local part ASCII, nên khó xảy ra; chưa kiểm chứng với IdP thật. Đây là rủi ro dự kiến, không phải lỗ hổng đã khai thác.

### Surrogate đơn lẻ

Số đo ở F2 (Node 24.20.0, body parser của NestJS 12.1.2, `pg` 8.23.1):

- `{"reason":"\ud83d"}` được nhận (201). `payloadHash` băm chuỗi JS còn code unit `d83d`. `pg` gửi xuống PostgreSQL `efbfbd` (U+FFFD), tức dữ liệu lưu khác dữ liệu đã băm và khác dữ liệu người gửi.
- Go `encoding/json` cũng ra U+FFFD nhưng không giữ được code unit gốc, nên hash khác. Replay cùng idempotency key giữa hai runtime trả 422.

### UTF-8 sai

Review F2 đo bằng body-parser 2.3.0 (iconv-lite) và `encoding/json`: đoạn UTF-8 cụt `E2 82` cho NestJS `fffd` (một ký tự thay cả đoạn), Go `fffd fffd` (mỗi byte một ký tự). Text lưu và `payloadHash` khác nhau giữa hai runtime; cả hai đều đổi âm thầm dữ liệu người gửi.

## Quyết định

1. **Email đăng nhập chỉ gồm ký tự ASCII in được (`!` đến `~`)**, kiểm trước `toLowerCase`, ở cả hai runtime:
   - `canonicalLoginEmail` từ chối chuỗi có ký tự ngoài khoảng đó. Lỗi theo bên gọi như hiện tại: claim IdP thì `verifiedEmail` trả `undefined` (đăng nhập thất bại chung, `error.authenticationFailed`); input admin thì 400 `error.invalidRequest`.
   - Hàm SQL nhận email và ràng buộc cột `email_canonical` của `app_user`, `oidc_email_enrollment` kiểm thêm ASCII. Thêm bằng migration mới, không sửa migration đã áp dụng (ADR-14). Dữ liệu hiện có vi phạm thì migration fail rõ, không tự sửa.
   - Go: `credential.CanonicalLoginEmail` kiểm ASCII rồi `strings.ToLower` (ADR-22 bỏ `jscompat` và vector).
2. **Chuỗi chứa surrogate đơn lẻ là input sai**: 400 `error.invalidRequest`, ở cả hai runtime, trước mọi validator và trước khi tính `payloadHash`.
   - NestJS: kiểm một lần cho toàn bộ body JSON đã parse (mọi key và mọi giá trị chuỗi, dùng `String.prototype.isWellFormed`), không rải ở từng validator.
   - Go: `httpapi.DecodeCommand` từ chối như hiện tại; bỏ đánh dấu `shortcut:`.
3. **Body không phải UTF-8 hợp lệ là input sai**: 400 `error.invalidRequest` ở cả hai runtime, kiểm trên byte thô trước khi decode. NestJS: `verify` của body parser JSON (lỗi phải đi qua filter thành 400, không thành 503). Go: `utf8.Valid` trong bước parse body chung.
4. Không thêm key lỗi mới, không đổi OpenAPI ngoài mô tả cần thiết.

## Hệ quả

- Mất khả năng dùng email quốc tế (local part hoặc domain Unicode). Hiện chưa có tài khoản nào cần; dữ liệu dev dựng lại ở C2 (ADR-20 Q5).
- Lớp va chạm do `toLowerCase` hạ về ASCII bị đóng ở mọi bên gọi, kể cả khi IdP khác Google.
- Body JSON giải mã như UTF-8 không còn bị đổi âm thầm thành U+FFFD khi lưu, cả với surrogate đơn lẻ lẫn UTF-8 sai. Ở NestJS, charset `utf-*` khác vẫn ra U+FFFD (`utf-7` với `41 FF 42`, `utf-32le` với `FFFFFFFF`, đo qua cả stack thật, 200), và body urlencoded có byte thô `FF` cũng vậy (`a=%FF` thì giữ nguyên `%FF`); Go từ chối các charset này và mọi form có nội dung.

## Chưa làm / điều mở

- [x] NestJS và contract chung: migration `AsciiLoginEmail1792108800008` (CHECK ASCII hai cột `email_canonical`, thân mới của `provision_oidc_account` và `change_iam_account_email`), `canonicalLoginEmail`, middleware `wellFormedBody` (§2), `verify` `utf8Body` của body parser JSON (§3), mô tả OpenAPI, regression test unit/integration/HTTP (U+212A, `İ`, `i` + U+0307, surrogate ở key và giá trị lồng, UTF-8 cụt `E2 82`, `F0 9F 98`, byte `FF`, overlong, surrogate CESU), `contract:export`.
- [ ] E2E NestJS: ca byte `FF` ở `apps/api/test/product.e2e-spec.ts:239-247` (chạy `dist/main.js` thật) chưa chạy vì người dùng cấm e2e; chưa có test nào khác chạm dòng `useJsonBody(app)` của `main.ts`.
- [x] Go: `httpapi.DecodeJSON`, nay là `DecodeCommand` (`encoding/json/v2`, thay `parseBody` theo ADR-22) từ chối surrogate đơn lẻ (§2) và UTF-8 sai (§3), có test `body_test.go`.
- [ ] Go: `credential.CanonicalLoginEmail` theo §1 (plan Task 6).
- Khác biệt còn lại: `utf8Body` chỉ kiểm khi tên charset chuẩn hóa theo iconv-lite là `utf8` (gồm `utf-8-`, `utf-8:1234`); body-parser vẫn nhận charset `utf-*` khác (vd. `utf-16le`) và decode bằng iconv-lite, còn Go từ chối mọi charset khác đúng `utf-8`. Chưa đổi NestJS vì ngoài §3 và NestJS đã đóng băng (ADR-22).
- Q10 của ADR-15 (`email_verified`) không đổi.
