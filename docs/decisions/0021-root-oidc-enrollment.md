# ADR 0021 — Kích hoạt Root khi đăng nhập bằng OIDC

Ngày: 2026-10-17. **Trạng thái: Proposed** — người dùng yêu cầu nghiên cứu cơ chế 2026-10-17; phương án A dùng ngay (không đổi code), phương án B chờ review trước khi triển khai. Liên quan: [ADR 0012](0012-iam-root-separation.md) (Root), [ADR 0019](0019-web-same-origin-and-oidc-browser-flow.md) (web chỉ có Google), [ADR 0020](0020-oidc-email-provisioning.md) (IAM theo email).

## Bối cảnh — đã kiểm trong source

| Luồng                                      | Hành vi hiện tại                                                                                                                                                   | Nguồn                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `root:bootstrap --method local`            | Account `pending` phải có `email_canonical`; phát token `activation` (15 phút); kích hoạt bằng `POST /api/auth/activate` + mật khẩu                                | `bootstrapProductRoot` trong `authorization/services/product-manifest.service.ts` |
| `root:bootstrap --method oidc`             | Bắt buộc `(issuer, subject)` đã gắn sẵn qua `identity:enroll --subject`; token `oidc-activation`; callback kích hoạt so `invitation.subject === sub`               | cùng file; `ProductOidcService.invitation`/`callback` (`purpose = activation`)    |
| Đăng nhập lần đầu theo email (ADR 0020)    | Chỉ khớp account `kind = 'iam'`, `pending`, có `oidc_email_enrollment`, chưa có credential/external identity                                                       | `ProductOidcService.enrollment`                                                   |
| Liên kết thêm OIDC (`/api/auth/oidc/link`) | Cần session đã fresh-auth; email verified của IdP phải **bằng đúng** `app_user.email_canonical`; account không có email (Root enroll theo subject) không link được | `ProductOidcService.callback` (`purpose = link`)                                  |
| Gỡ liên kết                                | Từ chối nếu không còn phương thức đăng nhập nào khác                                                                                                               | `ProductOidcService.unlink`                                                       |
| Web                                        | Trang đăng nhập chỉ có Google; có trang `/activate` gọi `POST /api/auth/oidc/activate`; không có form mật khẩu/kích hoạt local                                     | `apps/web/src/auth/*.page.tsx`                                                    |

Hệ quả: với `AUTH_METHODS=oidc`, Root chỉ tạo được khi người vận hành biết trước Google `sub`. Root `local` tạo được nhưng không dùng được qua web hiện tại. Một user có thể có nhiều `(issuer, sub)` (`external_identity`), mỗi `(issuer, sub)` thuộc tối đa một user.

## Phương án

**A. Lấy `sub` thủ công rồi dùng luồng có sẵn (dùng ngay, không đổi code).** Người vận hành lấy ID token Google của chính tài khoản Root (ví dụ OAuth 2.0 Playground với scope `openid email`) và đọc claim `sub` trên máy mình; `sub` của Google ổn định theo tài khoản, không phụ thuộc client. Sau đó `identity:enroll --method oidc --issuer --subject`, `root:bootstrap --method oidc` và mở `/activate#token=…` trong 15 phút. Gõ sai `sub` thì kích hoạt fail closed (không gắn nhầm). Không thêm log/debug callback để "bắt" `sub`: `AGENTS.md` cấm ghi định danh/PII vào log.

**B. Root kích hoạt bằng token offline + email verified (đề xuất, chờ review).** `identity:enroll --method oidc --email --issuer` (đã có cho IAM) rồi `root:bootstrap --method oidc --email-enrollment`: promote `iam → root`, phát token `oidc-activation` gắn với `(issuer, email)`. Callback `purpose = activation` chỉ gắn `(issuer, sub)` khi **cả hai** đúng: token còn hạn/chưa dùng và ID token có `email_verified === true` với email bằng email đã enroll; `sub` chưa thuộc ai. Cùng commit: insert `external_identity`, xóa enrollment, `pending → active`, audit `identity.oidc-activation`. Đăng nhập lần đầu theo email (ADR 0020) vẫn chỉ khớp `kind = 'iam'`, nên Root không bao giờ được kích hoạt chỉ bằng email.

- Phải sửa: `bootstrapProductRoot` (nhánh không subject), `ProductOidcService.invitation`/`begin`/`callback` cho invitation chưa có binding, CLI, kiểm lại trigger `guard_root_activation`/`guard_root_not_iam_subject` (migration 012) và integration tests: token sai/hết hạn, email khác/chưa verified, `sub` đã thuộc account khác, hai callback đồng thời → một binding, replay.
- Rủi ro: ai kiểm soát hộp thư của email Root **và** cầm token offline mới kích hoạt được; token chỉ giao qua kênh riêng như hiện tại.

**C. Root `local` + liên kết Google (cho `AUTH_METHODS=local,oidc`).** Root kích hoạt bằng mật khẩu, đăng nhập local, fresh-auth, rồi `link` Google — luồng API đã có và yêu cầu email IdP bằng email Root. Cần web có form đăng nhập mật khẩu và nút liên kết; trái với trang đăng nhập chỉ Google của ADR 0019, nên chỉ chọn khi deployment thật sự bật `local`.

## Đề xuất theo chế độ đăng nhập

| `AUTH_METHODS` | Root                                        | IAM (nhân viên)                                             |
| -------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `local`        | Luồng base: email + mật khẩu (cần UI local) | Base: `identity:enroll --method local` + kích hoạt mật khẩu |
| `oidc`         | A ngay; B sau review                        | ADR 0020: HR thêm email, đăng nhập Google lần đầu           |
| `local,oidc`   | C (mật khẩu + link Google) hoặc như `oidc`  | Như `oidc`; IAM có mật khẩu chỉ khi được enroll local       |

Không tự động gộp account theo email giữa các issuer: link luôn cần session đã xác thực + fresh-auth của chính account đó.

## Hệ quả

- Ngay bây giờ: runbook phương án A ở [vận hành local](../hrm-local-operations.md#root-bằng-google-oidc-phương-án-a).
- B/C là thay đổi identity: chỉ triển khai sau khi ADR này được chấp nhận, có test PostgreSQL ở mục B và cập nhật ADR 0019 nếu chọn C.
