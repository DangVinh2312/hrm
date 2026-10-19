# ADR 0020 — Cấp tài khoản Google theo email do HR thêm

Ngày: 2026-10-17. **Trạng thái: Proposed** — hành vi do người dùng chọn ngày 2026-10-17; chờ review cơ chế trước khi triển khai. Sửa D10 và một phần [ADR 0019](0019-web-same-origin-and-oidc-browser-flow.md) (mục 3, link kích hoạt cho nhân viên).

## Bối cảnh

Base gắn tài khoản OIDC bằng `(issuer, sub)` cố định từ lúc enroll: CLI cần `--subject`, kích hoạt so `invitation.subject` với `sub` trong ID token (`auth/services/product-oidc.service.ts`). HR không biết `sub` Google của nhân viên.

Người dùng chọn:

1. Nhân viên phải có tài khoản Google trước.
2. HR thêm email nhân viên vào HRM **trên giao diện**.
3. Lần đầu bấm "Đăng nhập bằng Google" là vào được, **không cần link kích hoạt**.
4. **Không giới hạn domain**: email nào đã được HR thêm đều đăng nhập được, kể cả Gmail cá nhân.

Đã kiểm trong source: login `product_identity` được INSERT `app_user(id,email_canonical,email_verified,state,auth_epoch)`, INSERT `external_identity`, và trigger `protect_account_lifecycle` chỉ cho nó chuyển `pending → active`. Login `product_data` đọc được bảng authority nhưng không ghi bảng identity. Không login runtime nào vừa kiểm quyền HR vừa ghi identity trong cùng transaction.

## Quyết định đề xuất

1. **Email đăng ký trước.** Bảng mới `oidc_email_enrollment(user_id PK → app_user, issuer, created_at, created_by)`: tài khoản `pending`, có `email_canonical`, chưa có `external_identity`. Chỉ tài khoản có dòng này mới được gắn theo email; tài khoản pending kiểu local/CLI cũ không bị ảnh hưởng.
2. **Gắn `sub` ở lần đăng nhập đầu**, trong callback `purpose = login`, transaction `identity`:
   - chưa có `external_identity(issuer, sub)`;
   - ID token có `email_verified === true` và `email`; chuẩn hóa bằng `canonicalLoginEmail` của base;
   - khớp đúng một tài khoản `pending` có dòng enrollment cho đúng `issuer`, khóa `FOR UPDATE`.

   Base hiện chỉ xin scope `openid` nên ID token không có `email`; phải thêm scope `email` cho request đăng nhập (chỉ dùng claim ở bước gắn lần đầu, không lưu thêm dữ liệu từ Google).

   Khi khớp: INSERT `external_identity`, `pending → active`, xóa dòng enrollment, audit `identity.oidc-activation`, tạo session — tất cả cùng commit. Từ đó đăng nhập chỉ theo `(issuer, sub)`; đổi email ở Google không đổi tài khoản. Không khớp → `ProductAuthenticationError` như hiện tại.

3. **HR thêm email qua API** `POST /api/administration/accounts` `{ email }`. Quyền: action mới `account.provision`, policy `fresh@1` + audit, `boundary: 'required'` (tạo principal mới). Transaction `write` (pool `data`) kiểm quyền bằng `ProductAuthorization`, rồi gọi hàm `public.provision_oidc_account(p_user uuid, p_email text, p_issuer text, p_actor uuid)` — `SECURITY DEFINER`, `search_path` cố định, owner không phải login runtime, EXECUTE chỉ cho `product_data`. Hàm chỉ tạo `app_user` pending (`kind = iam`) + dòng enrollment; không đổi tài khoản đã có, không gắn `sub`, không cấp role. Email trùng → `409`. Issuer phải thuộc provider đang bật.
4. **HR xem và gỡ** — danh sách tài khoản (email, trạng thái) qua view projection riêng cho `account.read`; gỡ = `account.suspend` hiện có (Root, hoặc grant + boundary). Tài khoản `pending` chưa đăng nhập có thể hủy bằng cùng action.
5. **Ai được thêm email trước T2**: Root (bypass, fresh-auth, audit). Role `hr.admin` được grant `account.provision`/`account.read`/`account.suspend` cùng boundary ở T2 khi có cơ chế gán role.
6. **Không cấp quyền nghiệp vụ**: tài khoản mới chỉ đăng nhập được; role/team/hồ sơ gán riêng ở T2/T3. Không cho HR đổi email của tài khoản đã active (đó là link lại identity — vẫn cấm theo `AGENTS.md`). Đổi người dùng thì gỡ tài khoản cũ và thêm email mới.
7. **Web**: bỏ trang `/activate` cho nhân viên. API activation bằng link (`/api/auth/oidc/activate`) và CLI `invite` giữ nguyên cho Root/vận hành.

## Rủi ro chấp nhận (do không giới hạn domain)

- Ai kiểm soát hộp thư của email đã được thêm (kể cả Gmail cá nhân) là đăng nhập được lần đầu. HR gõ sai email → người khác có thể vào. Giảm thiểu: HR xác nhận email, danh sách hiển thị trạng thái "chờ đăng nhập lần đầu", audit ai thêm.
- Email bị thu hồi rồi cấp lại cho người khác **trước** lần đăng nhập đầu → người mới vào được. Sau khi đã gắn `sub` thì không.
- Phụ thuộc vào việc Google trả `email_verified` đúng; tin claim của IdP đã cấu hình (issuer cố định, chữ ký RS256 kiểm như hiện tại).

## Kiểm chứng bắt buộc

PostgreSQL integration: gắn thành công một lần; email chưa thêm, `email_verified` false/thiếu, sai issuer, tài khoản đã active, hai lần đăng nhập đầu đồng thời → một binding; replay callback; Root/IAM không quyền/thiếu boundary/không fresh khi thêm email; email trùng; hàm definer từ chối input sai; probe owner/ACL/search_path của hàm và bảng mới. Browser E2E: HR (Root) thêm email → nhân viên đăng nhập Google lần đầu → vào được; email chưa thêm → `/login?error=oidc`.

## Hệ quả

Migration `013` (bảng + hàm + view + grants), cập nhật `expectedPrivileges`/probes, manifest release mới cho `account.provision`/`account.read`, OpenAPI/inventory, CLI `enroll --method oidc --email` (không `--subject`) cho vận hành.
