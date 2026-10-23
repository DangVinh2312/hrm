# HRM — Hệ thống thiết kế giao diện

Ngày: 2026-10-17. Áp dụng cho `apps/web` (React 19 + Mantine 9). Bổ sung phần trình bày cho [engineering conventions](hrm-engineering-conventions.md) §2.2 (React/Mantine), §3 (routing/server state) và §7.1 (performance); khi mâu thuẫn về bảo mật hoặc dữ liệu, conventions và ADR thắng. Hướng thiết kế lấy từ skill `ui-ux-pro-max` (style Minimalism/Swiss cho công cụ nội bộ, nền trung tính, màu trạng thái), đã bỏ phần không hợp (pattern landing page, font Fira Code, animation GSAP).

## 1. Nguyên tắc

1. **Công cụ làm việc, không phải trang quảng bá.** Ưu tiên đọc nhanh, mật độ vừa phải, ít trang trí; mỗi trang một việc chính.
2. **Trung thực về quyền và dữ liệu.** Chỉ hiện menu/nút server đã cấp; không số liệu giả, không placeholder giả vờ có chức năng. Ẩn/disable chỉ là UX, API luôn kiểm quyền.
3. **Tiếng Việt rõ ràng, nhất quán.** Một thuật ngữ cho một khái niệm (§6).
4. **Truy cập được mặc định.** WCAG 2.2 AA: tương phản, bàn phím, focus, nhãn.

## 2. Token (nguồn duy nhất: `apps/web/src/app/theme.config.ts`)

| Nhóm        | Giá trị                                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Màu chính   | `brand` (indigo, 10 sắc độ `#eef2ff` → `#312e81`); `primaryShade` light 6 (`#4f46e5`, chữ trắng 6,29:1), dark 4                                                  |
| Chữ phụ     | `c="dimmed"` → gray.7 (`#495057`, 8,18:1 trên trắng) qua `cssVariablesResolver`; gray.6 mặc định của Mantine chỉ 3,32:1 nên không dùng cho chữ                   |
| Nền         | Trang trong app: `gray.0`; thẻ/khung: trắng + viền; panel thương hiệu: gradient `brand.7 → brand.9`                                                              |
| Trạng thái  | `green` thành công/đã duyệt, `yellow` chờ xử lý, `red` lỗi/từ chối, `gray` đã hủy/không hoạt động, `brand` thông tin. Luôn kèm chữ hoặc icon, không chỉ dùng màu |
| Font        | Be Vietnam Pro (tự host `@fontsource/be-vietnam-pro@5.3.0`, OFL, đủ bộ ký tự tiếng Việt; 400/500/600/700); fallback system-ui. Không tải font từ CDN bên ngoài   |
| Cỡ chữ      | Body 16px (`md`), phụ 14px (`sm`), tối thiểu 12px (`xs`) chỉ cho chú thích; heading h1 28px, h2 22px, h3 18px, weight 600; line-height body 1.55                 |
| Khoảng cách | Thang Mantine `xs 10 / sm 12 / md 16 / lg 20 / xl 32`; trang: padding `md` mobile, `lg` từ `sm`; giữa các khối trong trang `lg`                                  |
| Bo góc      | Mặc định `md` (8px); Paper/Card `lg` (16px)                                                                                                                      |
| Breakpoint  | Mantine mặc định; shell đổi navbar thành drawer dưới `sm` (48em), trang đăng nhập hiện panel thương hiệu từ `md` (62em)                                          |
| Icon        | `@tabler/icons-react@3.49.0`, stroke 1.75, cỡ 18 (trong nút) / 20 (menu) / 24 (minh họa); import theo tên để tree-shake; không dùng emoji làm icon               |
| Chuyển động | Mặc định của Mantine (≈150–200 ms), `respectReducedMotion: true`; không animation trang trí                                                                      |

Ngoại lệ màu hex ngoài theme: logo Google (`auth/components/google-mark.component.tsx`) giữ màu gốc theo quy định thương hiệu Google.

## 3. Bố cục

- **Trang chưa đăng nhập** (`auth/components/auth-layout.component.tsx`): panel thương hiệu (chỉ desktop, `aria-hidden` vì chỉ trang trí) + một thẻ rộng tối đa 440px; mobile hiện logo nhỏ phía trên thẻ. Nút Google dùng `variant="default"` + logo G (nền trắng, viền) theo chuẩn Sign in with Google.
- **Shell sau đăng nhập** (`app/app-layout.component.tsx`): `AppShell` header 60px (logo, burger dưới `sm`, Đăng xuất), navbar 248px, main nền `gray.0`, nội dung tối đa 1200px giữa màn hình. Menu lấy từ `app/navigation.config.ts` và chỉ hiện mục có trong danh sách menu server cấp (`GET /api/auth/me`, design §10.2, ADR 0037; T3 cấp `employees`/`teams`). Nút quản trị HR chỉ hiện theo gợi ý `companyScope` của server (`GET /api/hr/employees/me`); thao tác ghi bị từ chối 403 hiện lời nhắc xác thực lại với Google (`features/hr/components/mutation-error.component.tsx`).
- **Trang trong shell**: `Title order={1}` + mô tả `dimmed` ở đầu, sau đó các khối `Card`. Danh sách dùng `Table` có cuộn ngang trên mobile; form dài chia nhóm bằng tiêu đề, không quá một cột trên mobile.

## 4. Trạng thái bắt buộc cho mỗi màn hình có dữ liệu

| Trạng thái                   | Cách hiển thị                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Đang tải                     | `Skeleton` giữ chỗ đúng kích thước (tránh nhảy layout) hoặc `Loader` có `aria-label`; không để màn trắng            |
| Rỗng                         | Icon + một câu giải thích + hành động tiếp theo nếu có (vd. "Chưa có đơn nào. Tạo đơn mới")                         |
| Lỗi tải                      | `Alert color="red"` với tiêu đề ngắn + nút "Thử lại"; không hiện mã lỗi kỹ thuật, stack trace hay nội dung response |
| Không có quyền/không tồn tại | Cùng một thông báo "Không tìm thấy" (API trả 404 cho cả hai — không phân biệt)                                      |
| Đang gửi                     | Nút ở trạng thái `loading`, chặn bấm lặp; không optimistic update kết quả duyệt/số dư                               |
| Kết quả chưa rõ (mất mạng)   | Báo "chưa xác định được kết quả", cho thử lại với cùng idempotency key (conventions §3)                             |

## 5. Truy cập (a11y)

- Tương phản chữ ≥ 4,5:1 (chữ lớn ≥ 3:1); kiểm bằng tính toán khi thêm màu mới, không ước lượng bằng mắt.
- Mọi thao tác dùng được bằng bàn phím, thứ tự Tab theo thứ tự hiển thị; giữ focus ring của Mantine (`focusRing: 'auto'`), không `outline: none`.
- Nút chỉ có icon phải có `aria-label`; icon trang trí `aria-hidden`. Mỗi trang đúng một `h1`.
- Form: label hiển thị (không dùng placeholder thay label), lỗi ngay dưới field, `description` cho gợi ý; lỗi tổng hợp bằng `Alert role="alert"`.
- Vùng chạm tối thiểu 44×44px trên mobile (Button `size="md"` cho hành động chính).
- Không truyền thông tin chỉ bằng màu: badge trạng thái luôn có chữ.

## 6. Viết chữ (tiếng Việt)

- Câu ngắn, giọng lịch sự trung tính, xưng "bạn". Nút là động từ: "Gửi đơn", "Duyệt", "Từ chối", "Hủy đơn", "Đăng xuất".
- Thuật ngữ cố định: _đơn_ (request), _duyệt bước 1 / duyệt cuối_, _phép năm_, _nghỉ không lương_, _làm việc từ xa (WFH)_, _đi muộn / về sớm_, _bảng công_, _nhân viên_, _team_, _kỳ công_. Ngày hiển thị `dd/MM/yyyy`, giờ `HH:mm`, thời lượng phép theo ngày (phút/480, tối đa 2 chữ số thập phân).
- Thông báo lỗi nói điều người dùng làm được tiếp ("Vui lòng thử lại hoặc liên hệ HR"), không đổ lỗi, không lộ chi tiết kỹ thuật hay dữ liệu nhạy cảm (CCCD, MST, lý do nghỉ).
- Chuỗi nằm trong `apps/web/src/i18n/locales/vi.json` (nguồn) và `en.json`; bản tiếng Anh giữ cùng nghĩa, giọng lịch sự, xưng "you". Lỗi từ API hiển thị qua key `error.*` (root `AGENTS.md` §Locale và mã lỗi), không hiển thị body lỗi.

## 7. Kiểm trước khi bàn giao một màn hình

- [ ] Chụp màn hình thật ở 390px và 1366px; không tràn ngang (`scrollWidth ≤ innerWidth`).
- [ ] Đi hết luồng bằng bàn phím; focus luôn nhìn thấy.
- [ ] Đủ các trạng thái ở §4; chuỗi tiếng Việt đúng §6.
- [ ] Màu/khoảng cách lấy từ token; không hex mới ngoài `theme.config.ts`.
- [ ] Unit test (Vitest + Testing Library, truy vấn theo role/label) và browser test cho luồng chính.
