# ADR-11 — HTTP API, mã lỗi, OpenAPI và web

Thay thế các ADR cũ: 0017, 0019, 0037 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Code: `apps/api/src/infrastructure/helpers/api-error.helper.ts` (`API_ERROR_CODES`, `ApiRejection`), `authentication/controllers/{authentication,oidc}.controller.ts`, `modules/employee/employee.controller.ts`, `openapi/`, `apps/api/test/structure.spec.ts`, `apps/web/src/{infrastructure/http.client.ts,i18n,features}`, root `test/locale-keys.spec.ts`.

## Quyết định

### Route và OIDC trên trình duyệt

- Web và API cùng origin. Mọi route API có tiền tố `/api`, khai trong `@Controller(...)` để inventory, OpenAPI và guard đọc cùng metadata; đường dẫn trang web không bắt đầu bằng `/api`. Cookie giữ `Path=/`; CSRF/Origin, trusted proxy giữ nguyên. Không alias route cũ (client gọi đường dẫn gốc nhận 404). Redirect URI OIDC là `<APP_ORIGIN>/api/auth/oidc/callback`; cấu hình khác bị từ chối khi boot.
- Callback OIDC trả `303` tới đích cố định cùng origin: đăng nhập thành công `/`, `ProductAuthenticationError` `/login?error=oidc` không kèm chi tiết. Đích là hằng số trong code (`callbackTarget`), không lấy từ request (không open redirect). Lỗi không phải xác thực (DB, cấu hình) đi qua error filter. State/nonce/PKCE/issuer, one-time và browser binding: ADR-06.
- Kích hoạt bằng link có mã sau `#`: `https://<origin>/activate#token=<secret>`. Fragment không tới server hay log truy cập; trang đọc mã, xóa fragment bằng `history.replaceState`, rồi gọi `POST /api/auth/oidc/activate`; có ô dán mã khi chỉ có mã. Link là bí mật cho tới khi dùng hoặc hết hạn.
- Trang đăng nhập web chỉ có Google. Vite dev server proxy `/api` tới API. Cách phục vụ production (reverse proxy hay API phục vụ static) chưa chốt (`docs/operations.md`).
- HTTP trên loopback cho phát triển: `trustedRedirectUrl` nhận `redirectUri` HTTP chỉ khi host là `localhost`, `127.0.0.1` hoặc `[::1]` và không có userinfo/query/fragment (RFC 8252 §7.3); host khác bắt buộc HTTPS, issuer luôn HTTPS. Production không đi được nhánh này vì cấu hình từ chối `APP_ORIGIN` HTTP khi `NODE_ENV=production` và callback phải cùng origin `APP_ORIGIN`. Trên HTTP cookie không có tiền tố `__Host-`/`Secure`; state, nonce, PKCE và CSRF giữ nguyên.

### Bootstrap của web: `/api/auth/me` tách `/api/hr/employees/me`

- `GET /api/auth/me` (`AuthenticationController.me`, `@ProductAuthenticated()`): `{ userId, menus }`. `menus` là key `requests | approvals | employees | teams | calendar | leave | attendance | reports | accounts | settings | roles` do server suy từ permission, không theo tên role; mọi tài khoản đăng nhập đều gọi được, kể cả Root và tài khoản chưa gắn nhân viên (`menus` có thể rỗng). Tất cả probe của menu nằm trong MỘT lượt `permitsMany`, tối đa `MAX_PERMIT_PROBES` (17, xem [ADR-12](ADR-12-administration-accounts-settings-roles.md)); `staleTime` 60 giây cho `useMenus()`, không cache menu theo revision.
- `AuthenticationHttpPort.me` do composition root cài; `authentication` chỉ có kiểu `MeView`/`MeMenu` và port, không import `modules/*`. Chưa có cơ chế khai báo menu theo module (`shortcut:` làm khi module thứ hai cần cấp menu).
- `GET /api/hr/employees/me` (`EmployeeController.profile`, khai báo trước `:id`): `{ employee: { id, code, fullName } | null, companyScope }`. `employee` là `null` với Root, tài khoản chưa gắn nhân viên hoặc không có `employee.read`. `companyScope` = `permits(hrCompany, read)`, chỉ là gợi ý hiển thị; API authorize từng thao tác. Chỉ ba field hồ sơ được select; không `accountId`, F2, role key hay revision. `GET /api/hr/me` bị xóa, không alias.
- Web có hai query độc lập, mỗi query ở feature sở hữu: `useMenus()` (`features/auth/me.provider.tsx`, key `[ns,'auth','me']`) và `useOwnEmployee()` (`features/employee`, key `[ns,'employee','me']`). Lỗi một request không làm hỏng request kia. `GET /api/auth/session` vẫn trả `menus: ['accounts']`.

### Mã lỗi

- Mọi lỗi đúng một shape `{ statusCode, code }` (`ApiErrorBody`); không `message`, exception message, SQLSTATE, stack hay dữ liệu request. `code` thuộc tập đóng `API_ERROR_CODES` và cũng là key `error.*` của locale web; `test/locale-keys.spec.ts` kiểm `vi`/`en` cùng tập key và tập `error.*` bằng đúng `API_ERROR_CODES`.
- Key đặt tên cho loại phản hồi, không mã hóa facts người gọi không được biết. Mặc định filter chọn key chỉ từ status (`apiErrorCode`):

  | Status                      | Key                          |
  | --------------------------- | ---------------------------- |
  | 400 (và 4xx khác không map) | `error.invalidRequest`       |
  | 401                         | `error.authenticationFailed` |
  | 403                         | `error.accessDenied`         |
  | 404                         | `error.notFound`             |
  | 409                         | `error.conflict`             |
  | 5xx                         | `error.unavailable`          |

  Absent và foreign record cùng `error.notFound`; mọi lỗi xác thực (sai/thiếu thông tin, bị khóa, hết hạn) cùng `error.authenticationFailed`; CSRF, permission, boundary cùng `error.accessDenied`.

- Ngoại lệ duy nhất là `ApiRejection(code)`: service ném sau khi đã authorize người gọi trên resource đích; handler không tự đặt key. Bảng `rejectionStatus` đóng ghi key → status cố định; key lạ là lỗi lập trình (`TypeError`, 503), không bao giờ gửi. Mười hai key, mỗi key chỉ nói về facts người gọi đã được phép biết:

  | Key                               | Status | Vì sao không lộ facts ngoài phạm vi                                                                                   |
  | --------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------- |
  | `error.dateOutOfRange`            | 422    | cửa sổ ngày nộp đơn là quy tắc công khai (setting)                                                                    |
  | `error.crossesYear`               | 422    | đơn không kéo sang năm sau, về chính đơn đang nộp                                                                     |
  | `error.kindNotAllowedInProbation` | 422    | tình trạng thử việc của chính người nộp                                                                               |
  | `error.teamNotMember`             | 422    | team của chính người nộp                                                                                              |
  | `error.nonWorkingDay`             | 422    | lịch làm việc công khai                                                                                               |
  | `error.makeupDay`                 | 422    | lịch làm bù công khai                                                                                                 |
  | `error.idempotencyKeyReused`      | 422    | không gian key của chính actor                                                                                        |
  | `error.overlappingRequest`        | 409    | đơn khác của chính người gửi                                                                                          |
  | `error.insufficientLeave`         | 422    | phép của chính người gửi, chỉ sau khi plan `employee.submitRequest` khớp hồ sơ của họ                                 |
  | `error.periodClosed`              | 409    | tháng đã chốt là trạng thái công ty mọi nhân viên thấy trên bảng công; chỉ phát sau khi plan khớp đích                |
  | `error.wfhLimitAckRequired`       | 409    | chỉ trong `decideFinal` đơn WFH sau khi plan khớp: số ngày WFH đã duyệt của nhân viên mà người duyệt cuối đã được đọc |
  | `error.exportTooLarge`            | 422    | số dòng/kích thước của báo cáo thuộc phạm vi của chính người gọi, vốn thấy qua `total` JSON (ADR-10)                  |

  Cộng sáu key theo status (`invalidRequest`, `authenticationFailed`, `accessDenied`, `notFound`, `conflict`, `unavailable`), `API_ERROR_CODES` có 18 key. Mã trạng thái nghiệp vụ khác (`stale_version`, `invalid_transition`, `insufficient_leave` khi duyệt, `final_approval_unavailable`, đạt trần, đang được giữ) trả `409 error.conflict`, không có key riêng; web phân biệt bằng GET.

- Thêm key lỗi mới phải nêu được vì sao key không lộ tồn tại/quyền/facts ngoài phạm vi người gọi (chỉ trả sau khi authorize trên resource đích), rồi cập nhật cùng lúc `API_ERROR_CODES`, hai locale, OpenAPI và test hành vi. Key là hằng số, không ghép từ input, ID, tên resource/role/policy, bảng/cột hay lỗi driver.
- Báo cáo JSON ngoài phạm vi trả trang rỗng `{ total: '0', rows: [] }`, không 403/404, nên không cần key mới; sai query là `400 error.invalidRequest`. Tệp xuất ngoài quyền là `403 error.accessDenied`.

### OpenAPI

- `/api/openapi.json` sinh từ `openapi/schemas/product-openapi.schema.ts`: mỗi route có success shape, ví dụ và các status thực tế có thể trả. `apps/api/test/structure.spec.ts` ghim route inventory, DI và SHA-256 của tài liệu (`openApiSha256`, `JSON.stringify(document)`).
- Đổi route, ví dụ, mô tả hoặc schema làm đổi hash: re-pin có chủ ý cùng thay đổi và cùng lý do trong `structure.spec.ts`, không sửa expected để xanh. Thêm route phải cập nhật `expectedOperations` và phân loại route (`authenticated`, `ProductAuthorize`, …); mọi POST/PUT/DELETE gọi `enforceCsrf`.

### Web

- `apps/web`: React SPA; `features/` số ít theo [ADR-01](ADR-01-workspace-modules-conventions.md). API quyết định quyền; menu và nút ẩn chỉ là UX (`canUpdate`, `companyScope` là gợi ý). Hai locale `vi` (mặc định, nguồn key) và `en`; API không dịch và không đọc `Accept-Language`.
- `http.client.ts` chỉ giữ `code` khi là key `error.*` có trong locale (`isErrorMessageKey`); key lạ, body không phải JSON hoặc lỗi mạng dùng `error.unavailable`. Không render body lỗi thô; không dùng key để suy quyền hay quyết định luồng bảo mật. Trang có ngữ cảnh riêng (mã kích hoạt bị từ chối, xung đột setting) dùng key riêng của trang, không thêm `error.*`.
- Mỗi feature sở hữu một client và context riêng: `FeatureServices` (`app/feature-services.provider.tsx`) giữ các client do composition root tạo một lần (test thay bằng bản giả); `<Feature>ServicesProvider` đặt client vào context của feature sở hữu, hook `use<Feature>Client()` đọc lại, không feature nào đọc context của feature khác. Kiểu `NavigationMenu` định nghĩa ở `features/auth/me.client.ts` và được `app/navigation.config.ts` dùng. `src/components/` chỉ UI thuần dùng chung từ hai feature ([ADR-01](ADR-01-workspace-modules-conventions.md)).
- Ngôn ngữ người dùng chọn là preference không nhạy cảm (`localStorage` `hrm.locale`, đọc/ghi trong try/catch, giá trị lạ về `vi`), không dùng trong quyết định quyền, audit hay query key dữ liệu.

## Quyết định của người dùng

- `/me` thuộc authentication với `GET /api/auth/me`; phần cần `userId` và permission ở authentication, thông tin cá nhân ở module `employee` với endpoint riêng và chỉ select field web dùng.
- Web không còn thư mục, định danh hay bảng tên `hr`; hai endpoint thành hai query độc lập.
- Chạy local qua `http://localhost` không TLS được chấp nhận (chỉ loopback).

## Chưa làm / điều mở

- Cách phục vụ production của web và API chưa chốt.
- Số giao dịch của bootstrap hai request chưa đo: `auth/me` = `currentSession` + `ownEmployee` + `permitsMany`; `employees/me` = `ownEmployee` + `permits(hrCompany, read)`; Root ghi hai dòng audit `access` mỗi lượt bootstrap (`ownEmployee` có audit).
- Gộp `checkSession`, `currentSession` và `ownEmployee` vào lượt `permitsMany` đổi pool hoặc cách audit, hoãn.
- Menu theo khai báo của từng module, cache menu theo revision: chưa làm.
