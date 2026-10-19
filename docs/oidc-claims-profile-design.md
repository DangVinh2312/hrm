# OIDC scopes và đồng bộ profile từ claims

Ngày: 2026-10-17 (thiết kế gốc từ base-auth), áp dụng cho HRM 2026-10-18. Chưa có runtime thay đổi hoặc feature tests pass.

> **Áp dụng cho HRM (2026-10-18): hoãn.** ADR 0015 (profile sync) và plan mà bản gốc tham chiếu không có trong HRM (ADR 0015 của HRM là app-owned tooling). Người dùng chọn hoãn đồng bộ profile; [ADR 0023](decisions/0023-sign-in-methods-and-account-linking.md) ghi nó ngoài phạm vi. Ràng buộc riêng của HRM nếu làm sau: họ tên nhân viên là dữ liệu F1 do HR quản lý (`employee.full_name`, ADR 0016); claims IdP **không bao giờ** ghi vào hồ sơ nhân viên, quyền, team hay `employee.account_id`. Cần ADR mới với số còn trống (≥ 0024) và migration số mới.

## Yêu cầu scopes

Authorization request cho login, activation, link và reauthentication đều gửi đúng tập cơ sở `openid email profile`. Provider/client cần được đăng ký để cho phép cả ba scope. Không thêm env cho phép giảm xuống `openid`; không bỏ scope khi gặp lỗi consent/provider. Nếu provider thông báo từ chối cấp scope bắt buộc thì flow không được báo thành công như đã đáp ứng yêu cầu.

Token response có `scope` phải là string gồm các token phân cách ASCII space và chứa đủ ba scope; explicit subset hoặc sai kiểu bị từ chối. Token response không có trường `scope` được hiểu là tập đã yêu cầu, không có nghĩa là phải kiểm email/name tồn tại. Provider có thể trả thêm scope nhưng không map thêm claims ngoài allowlist.

Ba scope là yêu cầu truy cập thông tin, không phải cam kết mọi claim đều có giá trị. Theo [OIDC Core §5.4](https://openid.net/specs/openid-connect-core-1_0.html#ScopeClaims), các claims được yêu cầu bằng `email` và `profile` là voluntary. Vì vậy, các trường profile có thể thiếu; thiếu `name` không được suy ra tên từ email, thiếu `email_verified` không được coi là true. Bắt buộc mỗi user phải cung cấp email là một chính sách enrollment riêng, chưa được suy ra từ việc yêu cầu scope.

Hiện tại HRM `apps/api/src/auth/services/product-oidc.service.ts#begin` gửi `scope: 'openid email profile'` (ADR 0020). `callback` đọc ID Token, chỉ dùng `email`/`email_verified` cho enrollment lần đầu và kiểm link, chưa gọi UserInfo và chưa lưu profile. `app_user.email_canonical/email_verified` phục vụ local login/activation/reset và so khớp enrollment/link; không dùng làm nơi đồng bộ email từ nhiều IdP.

## Snapshot có kiểu và validation

Lưu snapshot trong `external_identity_profile` theo từng binding `(issuer, subject)`, tách metadata khỏi binding/version xác thực. Lưu profile chung trong `user_profile`; ownership FK theo tuple gồm user_id như ADR. Không lưu toàn bộ raw claims JSON làm contract. Migration forward (số mới — `013` của HRM đã dùng cho `oidc_email_enrollment`), source hiện hữu không bị backfill thành snapshot giả.

| Claim OIDC           | Trường hệ thống đề xuất              | Quy tắc                                                                                                 |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `iss`, `sub`         | Khóa binding hiện có                 | Định danh duy nhất; không đổi bằng email hoặc username                                                  |
| `email`              | `email` của profile binding          | String email hợp lệ, nullable; không unique giữa các bindings; không tự ghi vào email login/reset local |
| `email_verified`     | `email_verified` của profile binding | Boolean hoặc null khi không được cung cấp; chỉ có nghĩa với đúng email trong snapshot đó                |
| `name`               | `display_name`                       | String dạng plain text, nullable                                                                        |
| `given_name`         | `given_name`                         | Nullable; không tự tách từ `name`                                                                       |
| `family_name`        | `family_name`                        | Nullable; không giả định thứ tự họ/tên                                                                  |
| `preferred_username` | `preferred_username`                 | Nhãn hiển thị, không phải username đăng nhập hoặc khóa unique                                           |
| `picture`            | `avatar_url`                         | URL HTTPS đã validate, nullable; backend không tự fetch URL này                                         |
| `locale`             | `locale`                             | Language tag hợp lệ, nullable; không tự thay ngôn ngữ user đã chọn thủ công                             |
| `zoneinfo`           | `time_zone`                          | IANA time zone hợp lệ, nullable; không tự đổi timezone user đã chọn thủ công                            |
| `updated_at`         | `provider_updated_at`                | Timestamp claim hợp lệ nếu có; không dùng làm bằng chứng fresh authentication                           |
| Không lấy từ claims  | `synced_at`, nguồn binding           | DB timestamp và provenance cho lần đồng bộ thành công                                                   |

Không tự thêm `gender`, `birthdate`, địa chỉ, điện thoại hoặc mọi custom claim chỉ vì provider trả về. Không tự tạo schema động từ tên claim. Unknown claims bị bỏ qua; claim được nhận phải validate kiểu, giới hạn độ dài và kích thước response trước khi lưu. `role`, `groups`, `kind`, `state`, `auth_epoch` và quyền nội bộ không được map từ profile.

Missing/null supported optional claim được coi là không cung cấp; present non-null malformed làm flow thất bại. Validate riêng cả hai nguồn trước merge, kể cả giá trị sẽ bị nguồn khác thay thế. Không coercion/trim âm thầm. String phải well-formed Unicode, không control U+0000–001F/U+007F–009F, không rỗng/chỉ whitespace; độ dài đếm Unicode code points. DB CHECK có cùng giới hạn text/control và email pair; semantics chuyên biệt kiểm ở parser.

| Trường                                                        | Giới hạn / normalization cố định                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `email`                                                       | Tối đa 254 code points, pattern `^[^\s@]+@[^\s@]+\.[^\s@]+$`; giữ spelling/case từ provider, không gọi canonicalLoginEmail hoặc unique.          |
| `displayName`, `givenName`, `familyName`, `preferredUsername` | Mỗi field tối đa 200 code points; giữ plain text, không HTML rendering hoặc suy field khác.                                                      |
| `avatarUrl`                                                   | Tối đa 2,048 code points trước/sau URL serialization, HTTPS, không credentials/fragment; lưu URL serialization, không fetch.                     |
| `locale`                                                      | Tối đa 64 code points; `Intl.getCanonicalLocales` phải chấp nhận đúng một tag, lưu tag canonical.                                                |
| `timeZone`                                                    | Tối đa 100 code points; IANA name/link hoặc UTC, reject numeric offset; validate bằng `Intl.DateTimeFormat` và lưu `resolvedOptions().timeZone`. |
| `providerUpdatedAt`                                           | Claim `updated_at` là finite safe integer seconds 0..253402300799; chuyển ISO/timestamptz, không dùng để xếp thứ tự hoặc freshness.              |
| `emailVerified`                                               | Boolean hoặc null; khi email null phải null. Không giữ true cũ khi email thay đổi.                                                               |

## Profile chung của user khi có nhiều OIDC

User cần một profile hiển thị chung với tên/avatar và nguồn dữ liệu rõ ràng, bên cạnh snapshot của từng binding:

1. Nguồn có ba trạng thái bền vững `never/selected/detached`. Row chưa có được đọc như never, bảy field null. Lần sync applied thành công đầu tiên khi never elect binding bằng CAS dưới user/profile row lock; sao chép mọi field chưa manual, kể cả null. Không tạo user hoặc bỏ enrollment/invitation/proof.
2. Các lần sau chỉ binding đã chọn mới cập nhật profile chung. Đăng nhập bằng account OIDC khác chỉ cập nhật snapshot account đó; tránh “account đăng nhập cuối cùng thắng”.
3. Bảy field chung là displayName/givenName/familyName/preferredUsername/avatarUrl/locale/timeZone; mỗi field có manual flag, gồm manual null. Selected binding chỉ cập nhật field chưa manual, claim thiếu sau merge sẽ ghi null. Manual edit trước OIDC chuyển never thành detached. Reset override theo field lấy latest selected snapshot hoặc null nếu never/detached.
4. Đổi nguồn là thao tác rõ ràng, chỉ chọn enabled binding thuộc user với trusted/enabled/current-version provider và snapshot đã sync; giữ manual fields, thay các field khác bằng snapshot. Explicit detach hoặc unlink selected source giữ values/manual flags, xóa tuple và đặt detached atomically. Login/link/relink sau detach không tự elect; chỉ explicit selection chọn lại nguồn. Nguồn selected bị provider disable ngừng sync, không tự đổi nguồn.
5. Email trên từng binding phục vụ hiển thị thông tin account đã liên kết. Nếu cần một email liên hệ chung thì thêm luồng chọn/xác minh riêng; không biến nó thành email recovery bằng side effect của đăng nhập.

Root áp dụng cùng quy tắc profile như user khác. Đồng bộ profile không đổi `kind=root`, tạo Root khác hoặc tăng quyền. OIDC-only vẫn không cần local password. Email IdP đã verified không tự trở thành kênh email step-up/recovery đã đăng ký tại base-auth; việc dùng kênh đó cần enrollment và chính sách xác minh riêng.

## Nguồn claims và transaction

ID Token phải được xác minh trước như hiện tại. Khi provider công bố UserInfo endpoint, lấy profile bằng access token ngoài transaction/fence. Endpoint HTTPS cố định lấy từ trusted metadata, không credentials/fragment; không follow redirect. UserInfo `sub` phải trùng ID Token `sub` trước khi dùng dữ liệu; đây là yêu cầu của [OIDC Core §5.3.2](https://openid.net/specs/openid-connect-core-1_0.html#UserInfoResponse).

Dependency hiện có `openid-client@6.8.8` cung cấp `fetchUserInfo(configuration, accessToken, expectedSubject)`; đã kiểm declaration tại `apps/api/node_modules/openid-client/build/index.d.ts`. Không dùng `skipSubjectCheck`. Nếu không có UserInfo endpoint, chỉ dùng claims có trong ID Token đã xác minh, không dựng URL từ input người dùng. Endpoint được công bố nhưng fetch/validation thất bại thì flow thất bại; không commit nửa profile hay coi lỗi network là response rỗng.

Wrapper `configuration[oidc.customFetch]` được cài một lần lúc composition, giữ existing transport, signature checks, abort signal và timeout 5 giây. Với UserInfo, đọc stream body giải nén tối đa **65,536 bytes**, cancel khi vượt trước library parse; Content-Length chỉ là early check. Giữ status/headers khi dựng Response bounded. Không global mutable state hoặc đổi customFetch giữa request.

Ưu tiên field non-null trong UserInfo đã xác minh, rồi field non-null ID Token, còn lại null. Identity và assurance lấy từ đúng bằng chứng auth hiện hành; UserInfo không override `iss/sub/acr/amr/auth_time`. Chọn nguồn có email non-null theo cùng thứ tự rồi chỉ lấy email_verified từ chính nguồn đó, thiếu/null thành null; không có email thì cả cặp null. Email_verified present malformed vẫn reject dù nguồn đó không có email hoặc không thắng merge.

Mỗi lần đồng bộ thay snapshot bằng dữ liệu đã merge/validate, field vắng ở cả hai nguồn thành null. Cấp `sync_order` bigint từ sequence ở UPDATE consume attempt, RETURNING trước network; ordering là thứ tự cấp lúc consume, không theo browser begin/provider clock. Conditional UPSERT chỉ nhận order lớn hơn; callback stale có thể authenticate nếu auth checks hợp lệ nhưng không đổi snapshot/profile hoặc elect nguồn. Bigint qua TypeScript là string, không Number. Khóa user row rồi ensure/khóa profile row để serialize election/manual/source/sync.

Sau network, trong fenced transaction recheck user active/pending đúng purpose, provider version, binding ownership/version và session/attempt proof cần thiết. Commit snapshot, các thay đổi profile được phép, session/link/activation và audit tương ứng atomically. Profile metadata đổi không tự tăng auth epoch hoặc logout mọi session; nếu là link/unlink thì giữ revocation của identity mutation. Không log raw claims, token, email hay avatar URL.

Chụp binding owner/version baseline sau verified token trước UserInfo fetch, kiểm lại lúc commit để revoke/re-enable trong fetch không qua mặt check. Purpose đã có binding/proof trước đó giữ kiểm version/epoch từ proof đó. New account-linking confirmation: callback chỉ stage typed validated profile + syncOrder + baseline trong proof; final confirm mới persist snapshot/profile cùng binding. Preview/cancel/expiry không sync. Audit lỗi rollback mutation/profile/session; attempt consume đã commit trước network vẫn consumed.

## HTTP và provenance của profile riêng

`GET /auth/profile` trả `{values,provenance,source,updatedAt}` cho actor hiện tại; bảy values nullable, provenance mỗi field là `manual` nếu manual flag, nếu không là `oidc/detached/empty` theo selected/detached/never. Source `{state:'never'|'detached'}` hoặc `{state:'selected',issuer,subject}`, updatedAt ISO/null. Không input userId, raw claims, sync sequence, tokens hoặc local recovery email; `/auth/session` giữ projection hiện tại.

`PATCH /auth/profile` nhận `{values?: Partial<ProductProfileValues>,resetFields?: ProductProfileField[]}` không unknown key, reset duplicate hoặc overlap; phải có ít nhất một field trong values/resetFields. Null là manual clear. `POST /auth/profile/source` nhận strict union selected+issuer+subject hoặc detached. Cả hai authenticated+CSRF, trả projection 200. Input sai/source foreign/absent/disabled/unsynced/untrusted đều safe 400; session 401, CSRF 403, contention 409, unavailable 503. Source tuple chỉ từ bindings owned trong account-linking inventory; không API đọc profile user khác. Manual/source mutations audit không ghi field values; không step-up chỉ để sửa metadata, không đổi epoch/session/quyền Root. Không thêm UI app.

Chỉ identity login có profile table SELECT/INSERT/UPDATE và sequence USAGE; các login còn lại bị từ chối. Exact startup ACL/protection probes phải pass cùng fresh install, upgrade từ 012, repeat migration no-op và FK ownership tests như ADR/plan; không sửa applied migration hoặc widen session-owner privileges.

## Kiểm chứng khi triển khai

- Cả bốn purpose luôn yêu cầu đủ ba scope; provider từ chối không âm thầm giảm scope.
- Claims ở ID Token, UserInfo và trường thiếu; subject mismatch, sai kiểu, quá dài, URL không hợp lệ, network lỗi.
- Email đổi cùng trạng thái verified, claim verified thiếu/false/string, không auto-link hai user trùng email và không đổi email reset local.
- Nhiều issuer và nhiều account cùng issuer không ghi đè profile chung; trường sửa thủ công giữ nguyên; unlink nguồn ngừng sync; callback về ngược thứ tự.
- Provider/binding/user bị revoke/suspend trong lúc fetch; lỗi audit rollback toàn bộ thay đổi; Root profile sync không đổi kind/quyền.
- Forward migration, privilege/protection probes và tests PostgreSQL thật. Local fixtures không chứng nhận interoperability với provider thật.

Ở base-auth, ADR 0015 và plan cụ thể hóa quyết định; ở HRM phần này hoãn và chưa có ADR. Toàn bộ implementation/checks vẫn pending; không đánh dấu các field/flow là đã tồn tại trong database/runtime.
