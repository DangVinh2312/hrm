# @hrm/web

React SPA (Vite, React 19, Mantine 9, React Router 8, TanStack Query 5, Mantine Form + Zod). Đọc root `AGENTS.md` trước; file này chỉ bổ sung phần riêng của web. Kiến trúc state/HTTP theo [engineering conventions](../../docs/hrm-engineering-conventions.md) §2.2, §3, §7.1; giao diện theo [hệ thống thiết kế](../../docs/hrm-ui-design-system.md). Web không quyết định quyền: API kiểm mọi request, menu/nút ẩn chỉ là UX.

## Cấu trúc

```text
src/main.tsx                    # styles Mantine + font, render App
src/app.tsx                     # composition root: providers, routes (một lần mỗi app instance)
src/app/                        # theme.config.ts (token duy nhất), navigation.config.ts, app-layout.component.tsx,
                                # query-client.factory.ts, app.config.ts (biến VITE_* đã validate)
src/infrastructure/             # http.client.ts (chỉ path /api/*, CSRF in-memory, không retry mutation)
src/i18n/                       # locales/{vi,en}.json, i18n.helper.ts (key, đọc/ghi preference),
                                # i18n.provider.tsx (useI18n), locale-switch.component.tsx
src/features/                   # ADR 0031: hr, auth, account, home, employee, team, work-request, leave, attendance,
                                # work-calendar, report (số ít); features/ không import app/, infrastructure/ không import features/
src/features/auth/              # auth.client.ts, session.provider.tsx, components/ (require-session, auth-layout,
                                # google-mark), pages/ (login, activate, ...)
src/features/report/            # T9: report.page (menu `reports`), report.client (Zod sáu báo cáo, tải XLSX), report.helper
                                # (validate khoảng ≤ 12 tháng, saveFile), components/{report-table,report-export}
src/features/<feature>/         # employee/, work-request/, leave/… (số ít); pages/ khi ≥2 page
test/                           # Vitest + Testing Library (jsdom); e2e/ Playwright với stack thật
```

- Tên file `<kebab-case>.<vai-trò>.ts(x)`: `.page.tsx` (route), `.component.tsx`, `.provider.tsx`, `.client.ts`, `.config.ts`, `.factory.ts`, `.helper.ts`, `.schema.ts`, `.module.css`. Hai file cùng vai trò trong một feature → folder số nhiều (`pages/`, `components/`). Không barrel `index.ts`, không `utils/` chung.
- Import tương đối không đuôi `.js` (bundler resolution); `import type` cho type-only.

## Quy tắc

- **Kích thước file (ADR 0033):** file `.ts`/`.tsx` dưới `src/` tối đa 300 dòng không tính dòng trống/comment (ESLint `max-lines`, `fileSizeLimit` trong `eslint.shared.config.js`). Vượt hạn thì tách component/helper có trách nhiệm rõ (form, bảng, dialog) trong cùng feature, giữ DOM/aria/key i18n; không có ngoại lệ web hiện tại.
- **Giao diện:** chỉ dùng component Mantine + token trong `app/theme.config.ts`; style riêng của feature bằng CSS Module dùng biến `--mantine-*`. Không hex/px tùy tiện trong component, không override class nội bộ Mantine, không thêm thư viện UI/CSS thứ hai. Icon từ `@tabler/icons-react` (import theo tên, `aria-hidden` khi trang trí).
- **Quyền và menu:** menu lấy từ server (design §10.2), lọc qua `visibleNavigation`; không suy quyền từ role/claim ở client. Trang không tìm thấy và không có quyền hiển thị như nhau.
- **Báo cáo (T9):** trang `/reports` chỉ hiện khi `GET /api/auth/me` có menu `reports` (server suy từ các action `employee.report*`, không theo vai trò); thiếu menu thì "không tìm thấy" và không gọi API. Khoảng tháng ≤ 12 kiểm ở client chỉ để báo lỗi sớm, API vẫn kiểm. Tải XLSX qua `HttpClient.download` (kiểm content-type, tên tệp do client dựng từ loại + khoảng, không lấy từ header), huỷ bằng `AbortController` khi rời trang. 403 của export gộp "không có quyền" và "phạm vi rỗng" (API không phân biệt) nên dùng key riêng của trang `report.export.denied`; 422 dùng `error.exportTooLarge`. Sinh nhật chỉ hiển thị ngày/tháng.
- **Điều chỉnh công (T8 `attendance.adjust`):** mục ở trang chi tiết nhân viên, chỉ hiện với `companyScope` (gợi ý của server; API vẫn authorize và đòi fresh). Danh sách theo tháng kèm lý do (chỉ HR đọc), nút thêm bị tắt khi kỳ `closed` nhưng 409 `error.periodClosed` của API mới là quyết định; 409 khác nghĩa là ngày ngoài thời gian làm việc hoặc công tháng sẽ < 0 (key riêng của trang `attendance.adjust.conflict`, không key `error.*` mới). Một idempotency key cho mỗi nội dung; lý do không vào URL, log hay storage. Nút thêm cũng tắt (kèm `attendance.adjust.selfHint`) khi hồ sơ đang xem là của chính người dùng (`GET /api/hr/employees/me`.employee.id); chỉ là gợi ý, API chặn bằng `403 error.accessDenied`.
- **Server state:** TanStack Query, key bắt đầu bằng `namespace` của `useSession()`; không copy DTO sang Context/global store; không persist dữ liệu HR (localStorage chỉ cho preference không nhạy cảm).
- **Mutation:** không retry tự động, không optimistic update cho duyệt/số dư/ký; nút `loading` chặn bấm lặp; giữ idempotency key khi người dùng thử lại.
- **HTTP:** mọi gọi API qua `createHttpClient` (path `/api/*`, `credentials: 'same-origin'`, CSRF header cho mutation); parse response bằng Zod, sai shape là lỗi, không hiển thị body lỗi thô. Lỗi API hiển thị bằng `t(apiErrorKey(error))`; `ApiError.code` chỉ là key `error.*` có trong locale.
- **Bí mật:** biến `VITE_*` nằm trong bundle công khai — không đặt secret; không đưa token/CCCD/MST/lý do nghỉ vào URL, log, analytics hay storage. Fragment `#token` đọc một lần rồi xóa khỏi thanh địa chỉ.
- **Chữ:** không viết chuỗi hiển thị trong component; dùng `t(key)` từ `useI18n()` với key trong `src/i18n/locales/vi.json` và `en.json` (quy tắc ở root `AGENTS.md` §Locale và mã lỗi). Tiếng Việt theo thuật ngữ ở design system §6, tiếng Anh giữ cùng nghĩa và giọng; một `h1` mỗi trang. Schema Zod của form trả key locale làm message, render qua `isMessageKey` + `t`. Test mặc định chạy `vi`; luồng đổi ngôn ngữ có test riêng.
- **Dependency:** thêm bằng `pnpm --filter @hrm/web add --save-exact <pkg>@<version>`, kiểm license/peer với React 19 và Mantine 9 trước; không dùng CDN cho font/script.

## Chạy và kiểm

```sh
pnpm --filter @hrm/web run typecheck   # app + e2e
pnpm --filter @hrm/web run test:unit   # Vitest
pnpm run test:browser                  # Playwright, stack dùng một lần (cần build API + Chromium)
pnpm --filter @hrm/web run dev:stack   # xem giao diện với IdP giả, dữ liệu giả
```

Dev với API local và Google: xem `docs/hrm-local-operations.md`. Thay đổi giao diện phải chụp màn hình thật ở 390px và 1366px và qua checklist ở design system §7; test truy vấn theo role/label/text người dùng thấy, không theo class CSS.

Browser E2E: mỗi file `e2e/*.e2e-spec.ts` có stack dùng một lần riêng (`startStack()` trong `beforeAll`). Mọi trình duyệt test là một client sau proxy 127.0.0.1, nên limiter OIDC (20 lần `begin`/15 phút mỗi client, mọi purpose `oidc`) tính chung cho cả file; đếm lượt đăng nhập/kích hoạt của file trước khi thêm test. Luồng lớn mới (đăng nhập/kích hoạt nhiều lần) đặt trong file riêng như `mfa.e2e-spec.ts` (người dùng chọn 2026-10-18); không nới limiter, không bật `TRUST_PROXY` hay giả `X-Forwarded-For` để test qua.
