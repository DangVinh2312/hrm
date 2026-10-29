# HRM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Chỉ dùng superpowers:subagent-driven-development khi người dùng chọn cách thực thi đó. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây ứng dụng HR web cho khoảng 50 nhân sự từ base đã clone, bao phủ hồ sơ, yêu cầu/phê duyệt, phép, bảng công, báo cáo Excel và hợp đồng.

**Architecture:** Đề xuất giữ một NestJS API tại `apps/api`, thêm React SPA tại `apps/web`, dùng một PostgreSQL database riêng của HRM. Nghiệp vụ HR nằm trong các feature module, dùng chung authorization AST, transaction fence và audit hiện có. Giao diện và API phục vụ cùng origin; API là nơi quyết định quyền và nghiệp vụ.

**Tech Stack:** Backend theo lockfile hiện tại: NestJS, TypeORM, PostgreSQL; Node `>=24.15.0 <25`, pnpm `12.3.4`. React và Mantine do người dùng chọn; đề xuất TypeScript + Vite, React Router Data Mode, TanStack Query, Mantine Form + Zod. Chi tiết ở [architecture](../../architecture.md); phiên bản và thư viện Excel/document/signing được kiểm tra, pin chính xác và cập nhật lockfile tại task sở hữu.

**Spec:** [Requirement tiếng Việt](../../HR_Web_Requirement_Tieng_Viet.md) và [architecture](../../architecture.md). Requirement là nguồn yêu cầu sản phẩm; Mantine đã được người dùng chọn. Các pattern/library/rules bổ sung cần review ở T0, không thay các quyết định nghiệp vụ còn thiếu ở G0.

**Workspace layout:** API tests/tools/env/Compose và config riêng nằm trong `apps/api` theo [ADR 0015](../../decisions/0015-app-owned-tooling.md); root giữ orchestration/tooling chung. Tasks nghiệp vụ bên dưới vẫn chưa thực hiện.

**Status:** T0-T9 đã hoàn tất (checkbox bên dưới); T10-T12 (hợp đồng, ký, UAT/vận hành) chưa làm. Ledger chi tiết của T1-T9 (lệnh, số đo, quyết định) đã gộp vào [history](../../history.md) mục 2-5; checkbox giữ lại là trạng thái, ghi chú đóng ngắn là bằng chứng. Đường dẫn trong kế hoạch này là kế hoạch ban đầu: cấu trúc thực tế ở [architecture](../../architecture.md) (module HR nằm ở `apps/api/src/modules/`, ADR 0031).

## Global Constraints

- Repo đích: `/home/dang_vinh/projects/hrm`; không sửa `base-auth`, không tự commit/push/deploy.
- Một công ty, một database; không thêm tenant, microservice hoặc package/SDK nội bộ.
- Chỉ pnpm; Node `>=24.15.0 <25`, pnpm `12.3.4`; một `pnpm-lock.yaml`; không dùng generator `@latest`.
- Giữ strict TypeScript; API ESM/NodeNext, import tương đối `.js`; cấu hình trình duyệt tách khỏi API.
- Core phân quyền thuần; controller chỉ nhận facade đã bind; mọi quyền recheck trong fenced transaction.
- IAM default deny, deny thắng allow, boundary nằm ngoài grants; Root giữ semantics ADR 0012.
- HR/Admin, Team Lead, COO là vai trò IAM nghiệp vụ; không map tự động thành Root. CEO không có quyền phê duyệt ngầm.
- Root bypass phân quyền, nhưng không bỏ invariant nghiệp vụ: thứ tự duyệt, hạn mức, chống xử lý trùng và tính công.
- Facts quyết định quyền thay đổi dưới exclusive fence và tăng revision; ghi nghiệp vụ giữ shared fence và khóa dữ liệu tương ứng. Quyết định data/identity/privilege phải ghi ADR trước phần implementation phụ thuộc.
- Migrations forward, `synchronize: false`, offline; manifest version/hash và ACL/protection probes cập nhật cùng thay đổi.
- Mutation và audit bắt buộc atomic; audit chỉ chứa actor/action/target/outcome/revision và metadata allowlist, không chứa CCCD, MST, lý do nghỉ, nội dung hợp đồng, chữ ký hay token.
- Test locks/FKs/transactions trên PostgreSQL disposable; không chạy vào database thật của công ty.
- Chỉ thêm dependency, worker, cache hay provider khi task có nhu cầu và owner/cleanup rõ ràng.
- UI dùng Mantine; các đề xuất convention, routing/query/form, state machine/factory, security/performance và race tests ở engineering conventions (nay architecture) được review tại T0 trước phần implementation phụ thuộc.

## Review Focus

1. Team Lead/COO tự gửi đơn hoặc kiêm nhiệm: không tự duyệt, không tự bỏ bước và không fallback sang CEO; task T0/T6 phải có case quyết định rõ.
2. Hai lần duyệt đồng thời, retry sau timeout hoặc replay: một quyết định và một lần tác động phép/công; task T6/T7 kiểm trên PostgreSQL thật.
3. Request qua tháng/năm, qua ngày chuyển chính thức hoặc trùng một phần: dùng ngày nghiệp vụ và chính sách đã chốt, không đếm WFH/phép theo thời điểm click duyệt; task T4/T5/T7 kiểm các biên này.
4. Team/lead/quyền thay đổi khi đơn đang chờ hoặc export đang chạy: không dùng quyền cũ, không trả dữ liệu ngoài scope; task T2/T3/T6/T9 kiểm revoke/concurrency.
5. Dữ liệu nhạy cảm hoặc Excel formula/file upload độc hại: quyền theo field, cell text, giới hạn file và không thực thi template/script; task T3/T9/T10/T11 có negative cases.

## 1. Hiện trạng

Bảng đối chiếu source ngày 2026-10-17 (khi chưa có `apps/web` và feature HR) đã lỗi thời và được bỏ; hiện trạng đọc từ source, [architecture](../../architecture.md) và [history](../../history.md).

## 2. Quyết định cần chốt — G0

Các đề xuất trong cột cuối chưa phải yêu cầu đã duyệt. Có thể tiếp tục phần độc lập; task phụ thuộc phải dừng trước implementation cho tới khi quyết định được ghi vào spec/ADR tương ứng.

| ID  | Câu hỏi cần quyết định                                                                                                              | Task phụ thuộc / hướng đề xuất                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| D01 | Nhân viên thuộc một hay nhiều team? Có nhiều lead/COO không? Ai duyệt khi lead/COO tự gửi, vắng mặt hoặc kiêm nhiệm?                | T2/T3/T6; không tự duyệt hay tự thay CEO; thiếu người hợp lệ thì chưa cho duyệt                    |
| D02 | Đổi team/lead có chuyển đơn đang chờ không? Ai được xem lịch sử sau chuyển team/nghỉ việc?                                          | T2/T3/T6; tách lịch sử quyết định bất biến khỏi quyền xử lý hiện tại                               |
| D03 | 12 ngày/năm cấp một lần hay tích lũy? Vào làm/chuyển chính thức/nghỉ việc giữa năm tính thế nào? Làm tròn, thâm niên và carry-over? | T7; không tự suy ra đủ 12 ngày cho mọi người hoặc cộng bù thử việc                                 |
| D04 | Một lần WFH là một ngày, nửa ngày hay một đơn nhiều ngày? Giới hạn 4 lần là hard block hay cho override?                            | T5/T6; đề xuất mỗi ngày WFH tính một lần, chặn ở lần duyệt cuối nếu vượt, cần xác nhận             |
| D05 | Bảng công thay đổi khi gửi đơn hay sau COO duyệt? Đi muộn/về sớm được duyệt có giảm công hưởng lương không?                         | T6/T8; đề xuất đơn chờ chỉ là dự kiến; số liệu chính thức đổi sau duyệt cuối                       |
| D06 | Được đăng ký hồi tố/tương lai tới đâu? Trùng các loại đơn xử lý thế nào? Được sửa/hủy đơn đã duyệt không?                           | T5/T6/T7/T8; chốt cả hoàn phép và cập nhật công khi đảo quyết định                                 |
| D07 | Chốt công theo tháng, HR điều chỉnh công/định mức phép và thay lịch nghỉ quá khứ theo quy trình nào?                                | T4/T7/T8/T9; cần version và lịch sử điều chỉnh, không âm thầm sửa báo cáo đã chốt                  |
| D08 | Nhân viên xem/sửa field nào của mình? Lead/COO thấy CCCD/MST/ngày sinh/lý do nghỉ không? HR có phạm vi giới hạn không?              | T2/T3/T9; đề xuất lead chỉ thấy dữ liệu phục vụ duyệt; field nhạy cảm có resource/projection riêng |
| D09 | Bảng phép tại ngày báo cáo tính phép tương lai đã duyệt vào mục nào? Số dư để gửi đơn có giữ chỗ cho phép tương lai không?          | T7/T9; đề xuất tách đã dùng tới ngày báo cáo và đã cam kết tương lai                               |
| D10 | Login local hay OIDC? Cấp tài khoản ban đầu qua CLI hay cần UI HR mời nhân viên? Kênh activation/reset và idle session?             | T1/T2/T12; giữ CLI hiện có cho pilot nếu được đồng ý, không cấp HR capability reset/link identity  |
| D11 | Mẫu hợp đồng DOCX hay PDF? Placeholder, trường lương/chức danh/ngày hiệu lực, người quản lý mẫu và cách tạo batch?                  | T10; requirement chưa có đầy đủ schema cho nội dung hợp đồng                                       |
| D12 | Chọn chữ ký hình ảnh hay USB Token/chứng thư số cho công ty? Thiết bị/provider/cầu nối ký nào? Ai xác nhận phương thức ký hợp lệ?   | T11; xác minh pháp lý và tích hợp trước khi triển khai chức năng ký thật                           |
| D13 | Nơi lưu file, mã hóa/key ownership, backup, retention/xóa hồ sơ/hợp đồng/audit? Môi trường hosting?                                 | T10/T11/T12; xác định bằng ADR/runbook, không chọn provider giả                                    |
| D14 | Ngày bắt đầu vận hành và số dư phép/đơn/bảng công cần nhập từ trước? Mẫu Excel báo cáo mong muốn?                                   | T7/T9/T12; dữ liệu nhập phải có mapping và đối soát riêng                                          |

Ngày nghỉ lễ/Tết và hiệu lực pháp lý của cách ký là các việc cần xác minh với nguồn chính thức/chuyên môn ở T0/T4/T11. Tài liệu này chưa kết luận tuân thủ pháp luật hay tự quy định lịch nghỉ thực tế.

## 3. Kiến trúc và cấu trúc đề xuất

Chọn modular monolith + React SPA để tận dụng API hiện có. Hai hướng khác đã cân nhắc: thêm backend thứ hai vào frontend framework làm tăng nơi sở hữu auth/nghiệp vụ; tách microservices làm tăng bài toán transaction cho duyệt/phép/công. Requirement hiện chưa đưa ra nhu cầu cho hai hướng đó.

Vite là đề xuất build tool, chưa cài. Tài liệu chính thức mô tả [React SPA với build tool](https://react.dev/learn/build-a-react-app-from-scratch) và [Vite](https://vite.dev/guide/); lựa chọn này suy ra từ API NestJS riêng và phạm vi ứng dụng nội bộ. Mantine là component library đã chọn; đề xuất React Router Data Mode, TanStack Query, Mantine Form + Zod, Vitest/Testing Library và Playwright theo [architecture](../../architecture.md). Pin versions và kiểm peer compatibility trước T1; không coi Vite tự cung cấp các phần này.

| Đường dẫn mới dự kiến         | Trách nhiệm                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/web/`                   | React/TypeScript, navigation, form, hiển thị theo capability; không sở hữu quyết định quyền |
| `apps/api/src/employee/`      | Hồ sơ, liên kết account, trạng thái làm việc theo ngày hiệu lực, projection nhạy cảm        |
| `apps/api/src/team/`          | Team, membership, lead/approver assignment và lịch sử hiệu lực                              |
| `apps/api/src/work-calendar/` | Lịch chuẩn, ngày lễ/nghỉ, phiên bản lịch                                                    |
| `apps/api/src/work-request/`  | Các loại đơn và state machine hai bước phê duyệt                                            |
| `apps/api/src/leave/`         | Entitlement, ledger và số dư theo ngày hiệu lực                                             |
| `apps/api/src/attendance/`    | Công theo lịch + effect đơn đã duyệt + điều chỉnh có lịch sử                                |
| `apps/api/src/report/`        | Query báo cáo có scope quyền và xuất XLSX                                                   |
| `apps/api/src/contract/`      | Mẫu, generation batch, version tài liệu, lưu trữ và ký                                      |

Module/file dùng số ít và hậu tố vai trò; hai file cùng vai trò nằm trong folder số nhiều. Ví dụ `work-request/services/work-request.service.ts` và `services/request-approval.service.ts`. Mỗi feature có `.module.ts`, `.http-port.ts`, controller, declarations và migration theo nhu cầu; không tạo boilerplate/folder rỗng.

**Dữ liệu dự kiến:** employee, employment period, team, membership/lead assignment, calendar version/day, work request/segment, approval decision, leave entitlement/ledger, attendance adjustment/period, contract template/batch/document/signature metadata. FK/unique/check constraints và lịch sử hiệu lực sẽ được mô tả trong spec từng mốc trước migration.

Employee liên kết account bằng UUID có ràng buộc uniqueness, không đồng nhất mã nhân viên với login identity. Ngày sinh/ngày làm việc là date nghiệp vụ, không parse ngầm theo timezone máy. Đề xuất timezone nghiệp vụ `Asia/Ho_Chi_Minh`; thời điểm sự kiện vẫn UTC với precision của base. Phép/công dùng số phút nguyên trong miền có giới hạn: 120/240/480 phút tương ứng 0,25/0,5/1 ngày, không cộng trừ bằng floating point.

**Quyền:** tài liệu thiết kế phải có ma trận actor × action × scope × fields, gồm self/team/company. Không truyền role/userId/teamId đáng tin từ browser; không dùng `projection` chung hiện tại để trả PII cho mọi role. Resource nhạy cảm riêng hoặc typed operation/projection đã được authorize trước query là quyết định ở T2. Không triển khai resource-to-resource domain binding mà compiler hiện chưa hỗ trợ; chọn binding identity/edgeStore hiện có hoặc thiết kế mở rộng riêng có test parity.

**Giao dịch phê duyệt:** lấy session/facts/plan trong fence → khóa request và quota/ledger cần thiết theo một thứ tự cố định → kiểm version/trạng thái/actor/chính sách theo ngày hiệu lực → ghi decision, effect phép/công và audit → commit → trả kết quả. Retry không được sinh effect trùng. Network/render/hash/upload/signing không nằm trong transaction/fence. T2 phải định nghĩa capability nội bộ đáp ứng flow này vì `ProductAuthorization.access` hiện private và chưa có command HR.

## 4. Mốc bàn giao và phụ thuộc

| Mốc                          | Tasks   | Kết quả có thể nghiệm thu                                                          |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------- |
| M0 — Thiết kế và baseline    | T0–T1   | Spec các quyết định cần thiết, baseline kiểm chứng, React đăng nhập API thật       |
| M1 — Hồ sơ và tổ chức        | T2–T3   | HR quản lý nhân viên/team; từng vai trò chỉ thấy dữ liệu được phép                 |
| M2 — Lịch và workflow nội bộ | T4–T6   | Gửi đơn, state machine/hai bước và race tests; chưa mở duyệt cuối ra vận hành      |
| M3 — Phép và công            | T7–T8   | Duyệt cuối cập nhật ledger/công atomic; nhân viên xem số dư, HR đối soát           |
| M4 — Báo cáo                 | T9      | Đủ sáu nhóm báo cáo và XLSX, đối soát với ledger/công                              |
| M5 — Hợp đồng                | T10–T11 | Tạo batch theo mẫu, lưu version, ký bằng phương thức đã được chốt                  |
| M6 — Pilot và vận hành       | T12     | UAT với tài khoản thật theo role, backup/restore, runbook và số dư đầu kỳ đối soát |

Luồng chính: T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9. T10 bắt đầu sau T3 và các D11/D13; T11 sau T10 và D12. T12 nghiệm thu toàn bộ chỉ sau cả T9 và T11, cùng D10/D13/D14 và các kiểm chứng môi trường còn thiếu.

**Gate duyệt cuối:** T6 kiểm workflow/serialization độc lập; không đưa capability duyệt cuối vào vận hành trước khi T7/T8 đã nối đủ effect và kiểm rollback trong cùng transaction. Thiếu effect handler phải fail closed, không ghi `approved` rồi bổ sung ledger/công ở transaction hoặc task sau. M2 chưa là bản duyệt đơn có thể dùng thực tế; M3 là mốc đầu tiên nghiệm thu flow từ gửi → duyệt cuối → phép/công đầy đủ. Nếu chia nhỏ phát hành, phải chốt scope và có test chứng minh chỉ các loại đơn với effect đầy đủ được mở; không dùng config flag đổi semantics.

Có thể pilot phạm vi M0–M4 nếu người dùng đồng ý và các kiểm chứng vận hành áp dụng tại T12 đã đạt; hợp đồng vẫn là phần phải hoàn thành, không bị loại khỏi requirement.

## 5. Tasks

### T0 — Chốt thiết kế và bộ ví dụ nghiệp vụ

**Files tạo:** `docs/superpowers/specs/2026-10-16-hrm-design.md`, `docs/hrm-acceptance.md`; ADR mới dưới `docs/decisions/` cho identity/quyền/PII, transaction và dữ liệu HR. Kiểm số ADR còn trống trước khi đặt tên; trạng thái Proposed cho tới khi được chấp nhận.

**Input:** requirement, G0, ADR 0012–0015 và source hiện tại. **Output:** spec được review, ma trận quyền/fields, schema/invariants, state transition table, quyết định frontend và test examples có expected result.

- [x] Review engineering conventions (nay gộp vào architecture): Mantine đã chọn; chốt routing/query/form ownership, budgets, lock protocol và các đề xuất khác trong spec/ADR theo phạm vi.
- [x] Ghi rõ điểm nào từ requirement, điểm nào là đề xuất; trả lời D01–D10 đủ cho mốc liên quan, tách D11–D14 theo phụ thuộc.
- [x] Định nghĩa từng transition, permission đích và các điều kiện từ chối; chốt approval chain cho self/kiêm nhiệm/thiếu lead/COO trước T6.
- [x] Lập ví dụ ngày làm việc/nghỉ trưa, 0,25/0,5/1 ngày, probation, WFH tháng, lịch sử và báo cáo tại ngày cắt.
- [x] Review spec và ADR với người dùng; ghi quyết định và phạm vi từng mốc. Chưa thông qua thì chỉ tiếp tục task độc lập, không tự chọn semantics còn thiếu.

### T1 — Baseline HRM và React đăng nhập

**Files sửa:** `package.json`, `apps/api/package.json`, `pnpm-lock.yaml`, `README.md`, `AGENTS.md`, `apps/api/AGENTS.md`, `eslint.config.js`, `eslint.shared.config.js`, `tsconfig.json`, `.github/workflows/ci.yml` theo nhu cầu thật; giữ rules riêng API trong `apps/api/eslint.config.js`. **Files tạo:** `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/eslint.config.js`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/app.tsx`, `apps/web/src/auth/auth-client.ts`, `apps/web/src/auth/login.page.tsx`, `apps/web/src/auth/session.provider.tsx`, `docs/operations.md`.

**Input:** spec frontend và D10. **Output:** React login/logout/session qua API thật; môi trường local riêng, scripts build/typecheck frontend có implementation thật.

- [x] Kế thừa layout đã có theo ADR 0015, không di chuyển tests/tools/env lại. Kiểm Node/pnpm đúng versions, Docker và port/Compose isolation với base; env API ở `apps/api/.env.api`, ops ở `apps/api/.env.ops`, Compose ở `apps/api/compose.yaml`; không đưa ops credential vào frontend/runtime API. Cài bằng `pnpm install --frozen-lockfile`, chạy baseline, xử lý hoặc ghi riêng full-format/Docker blockers mục 1, không báo toàn bộ pass.
- [x] Pin dependencies/frontend test runner đã chọn; cấu hình TS browser/TSX lint riêng, không bật decorator/NodeNext máy móc cho frontend. Setup MantineProvider/theme/styles, React Router, QueryClient với cache theo phiên và Mantine Form + Zod theo conventions được duyệt. Đổi tên package HRM có phạm vi, cập nhật lockfile bằng pnpm.
- [x] Viết và chạy test lỗi trước cho login/CSRF/session expiry/logout và fresh-auth khi base yêu cầu. Nếu D10 chọn local, dùng các routes hiện có `/auth/csrf`, `/auth/login`, `/auth/session`, `/auth/logout`, `/auth/reauthenticate`; nếu chọn OIDC, chốt browser redirect/reauth flow theo controller hiện có trước implementation. Cookie/origin giữ theo base, không đưa session secret vào localStorage.
  - Ghi chú đóng 2026-10-22 (đường dẫn hiện tại; tên file/route trong mục này là của kế hoạch cũ). **Ngoại lệ do người dùng chấp nhận ngày 2026-10-22: test viết sau implementation, không có lần đỏ trước; đã đối chiếu hành vi và chạy xanh trên working tree** (rà soát độc lập, không phải bằng chứng "đỏ trước"). Lý do cũ về reauth OIDC đã hết hiệu lực: D10 chọn Google OIDC (ADR 0019); ADR 0025/0026/0027 bỏ mọi đường `/auth/login`, `/auth/reauthenticate` và reauth bằng Google — callback OIDC không bao giờ đặt `reauthenticated_at` (ADR 0027 §7), `fresh` chỉ đến từ 2FA (`POST /api/auth/mfa/verify`, ADR 0026), và các route `…/reauthenticate` trả 404 có test.
  - Bằng chứng, API: `apps/api/test/product-http.spec.ts:50` (Origin tin cậy + cookie/header CSRF khớp); `apps/api/test/product-sign-in-http.integration-spec.ts:36` (đích callback cố định; danh sách route đã bỏ ở dòng 120–134, gồm `/api/auth/oidc/reauthenticate` dòng 126 và `/api/auth/reauthenticate` dòng 130, đều 404 `error.notFound` — `notFound()` dòng 136, gọi ở 145 và 164); `apps/api/test/product-identity-oidc.integration-spec.ts:40` (code+PKCE ký thật, replay state/trình duyệt) và `:147` (hạn phiên và cửa sổ `fresh` theo đồng hồ DB, đăng nhập không đặt `reauthenticated_at`); `apps/api/test/product-mfa-http.integration-spec.ts:37` (phiên + CSRF ở mọi route 2FA); `apps/api/test/product-mfa-flow.integration-spec.ts:103,147,241` (verify, mã khôi phục, gỡ cần step-up).
  - Bằng chứng, web: `apps/web/test/session.provider.spec.tsx:30,52,64` (đổi người dùng, logout mất mạng không retry, 401 đưa về `/login`); `apps/web/test/http.client.spec.ts:58,82` (lấy CSRF trước mutation, không retry mutation); `apps/web/test/auth.client.spec.ts:25,36,50,57`; Playwright `apps/web/e2e/auth.e2e-spec.ts:59` (đăng nhập, reload, logout, nút back), `:81` (replay callback), `:94` (phiên bị thu hồi → `/login`), `:119` (logout mất mạng), `:142` (mutation thiếu CSRF → 403), `:153` (đoạn 176–195: `…/oidc/{link,reauthenticate,unlink}` → 404 khi có phiên và CSRF), `:214` (bundle không chứa secret).
- [x] Verify frontend build/typecheck và browser flow với API thật, gồm hết hạn session, retry lỗi mạng không lặp mutation, reload route và không lộ secret trong browser bundle.

### T2 — Capability HR, quyền và ranh giới giao dịch

**Files sửa:** `authorization/services/product-authority.service.ts`, `authorization/product.manifest.ts`, `infrastructure/product-runtime.service.ts`, `infrastructure/runtime.module.ts`, `audit/product-audit.repository.ts`, `database/helpers/product-database.helper.ts` nếu ACL base cần đổi, `apps/api/tools/product.ts`, `apps/api/test/module-boundaries.spec.ts` — các đường dẫn source đều dưới `apps/api/src/`. **Files tạo:** declarations và permission tests HR; `apps/api/test/hrm-authorization.integration-spec.ts`.

**Input:** T0/T1, D01/D02/D08/D10. **Output:** roles/grants/boundaries HR, audit event union và capability thực thi HR đã kiểm quyền trong một transaction; không export raw runtime/manager/credentials cho controller. Bổ sung contract bootstrap UI đã authorize (metadata phiên và khả năng hiển thị menu theo phạm vi đã chốt; hồ sơ/self link bổ sung tại T3 khi có employee schema); `/auth/session` hiện chỉ trả `userId`, `method`, `assurance`, chưa có role/HR capabilities. Route/type mới phải được chốt trong spec, không suy từ claims/payload hoặc xem menu guard là quyền thao tác trên record.

- [x] Viết regression permission matrix: self/team/company, deny ngoài allow, required boundary, CEO không có approval mặc định, Root chỉ bypass authorization.
- [x] Thiết kế và triển khai capability HR nội bộ nhỏ nhất sau ADR: authorize trong transaction hiện hữu; hỗ trợ create/approve cần thiết mà không public callback SQL tùy ý, không nested transaction hoặc copy session/Root semantics sang từng service. Chốt lock order HR và idempotency scope theo architecture; domain locks không được thay bằng in-memory mutex.
  - Ghi chú đóng 2026-10-22 (rà soát độc lập, đã chạy xanh; đường dẫn hiện tại ở `apps/api/src/modules/*`). Capability HR nội bộ = `ProductAuthorization.execute`/`query`/`permits` (`apps/api/src/authorization/services/product-authority.service.ts:539`, `:635`, `:348`): command/query là đối tượng đăng ký lúc composition (`execute` từ chối đối tượng khác; không callback SQL tùy ý, không nested transaction), authorize trong cùng transaction với facts, plan và ghi; module nghiệp vụ chỉ nhận facade đã bind (`apps/api/test/module-boundaries.spec.ts`, `apps/api/test/structure.spec.ts`). Idempotency: bảng `hr_idempotency` (`apps/api/src/modules/work-request/migrations/hrm-work-request.migration.ts:40`, PK `(actor_id, operation, key)`, CHECK `operation` mở rộng ở migration 111 và 112) và `replay` ở `apps/api/src/modules/hr/helpers/hr-idempotency.helper.ts`. Lock order: [ADR 0017](../../decisions/0017-hrm-transaction-lock-idempotency.md) §2 cùng các bổ sung T5/T6/T8/T8B/2026-10-22; khóa kỳ chung `assertPeriodsOpen` (`apps/api/src/modules/attendance/repositories/attendance-facts.repository.ts:123`); không mutex trong bộ nhớ.
  - Tests: `apps/api/test/hrm-authorization-matrix.integration-spec.ts:118,180,235` (boundary required, deny thắng allow, audit lỗi rollback command), `apps/api/test/hrm-authorization-workflow.integration-spec.ts:44,140` (command theo stage, parity SQL↔evaluator); đua/khóa: `hrm-attendance-concurrency`, `hrm-period-concurrency.integration-spec.ts:223` (ba bên), `hrm-cancel-concurrency`, `hrm-leave-concurrency` (cùng thư mục test; không có file nào tên `hrm-authorization-concurrency`).
- [x] Sync manifest version mới và audit events allowlist; kiểm bootstrap idempotency, stale manifest/drift fail closed. Xác định credential/ACL cho object registry + business data atomic, không giả định login data có sẵn quyền INSERT object_ref.
- [x] Chạy tests permission, PostgreSQL ACL/parity/revocation và module boundaries; kiểm rollback khi audit writer lỗi. Kiểm UI bootstrap không trả PII/raw security facts ngoài scope, đổi phiên/thu hồi quyền không dùng lại cache cũ; browser không chọn permission hoặc principal thay server.

### T3 — Hồ sơ nhân viên, team và phân công người duyệt

**Files tạo dưới `apps/api/src/`:** `employee/employee.service.ts`, `employee/employee.types.ts`, `employee/employee.controller.ts`, `employee/employee.http-port.ts`, `employee/employee.declarations.ts`, `employee/employee.module.ts`, `employee/migrations/hrm-employee.migration.ts`; bộ tương ứng ở `team/` với `team.service.ts`, `team.types.ts`, `team.controller.ts`, `team.http-port.ts`, `team.declarations.ts`, `team.module.ts`, `migrations/hrm-team.migration.ts`. **Web:** `apps/web/src/employee/pages/employee-list.page.tsx`, `pages/employee-detail.page.tsx`, `apps/web/src/team/team.page.tsx`. **Tests:** `apps/api/test/hrm-employee.integration-spec.ts`, `apps/api/test/hrm-team.integration-spec.ts`.

**Interfaces đề xuất:** `EmployeeService.create(secret: string, input: EmployeeCreateInput): Promise<EmployeeView>`; `TeamService.assign(secret: string, input: TeamAssignmentInput): Promise<void>`. Types nằm trong `.types.ts` sở hữu; DTO không chứa role/revision/security facts có thể generic update.

- [x] Viết failing tests mã nhân viên trùng, account link trùng/sai, ngày không hợp lệ, thử việc → chính thức có hiệu lực, scope và field PII của từng role.
  - Ghi chú đóng 2026-10-22. **Ngoại lệ do người dùng chấp nhận ngày 2026-10-22: test viết sau implementation, không có lần đỏ trước; đã đối chiếu hành vi và chạy xanh trên working tree.** Bằng chứng (đường dẫn hiện tại): `apps/api/test/hrm-employee.integration-spec.ts:165` (mã trùng, trùng document rollback không audit), `:255` (thử việc → chính thức theo ngày, nghỉ việc đóng chuỗi), `:304` (scope F1 list/detail cùng một scope mỗi role; F2/F3 chỉ chủ hồ sơ và HR, D08), `:371` (ghi F2/F3 cần HR fresh), `:474` (liên kết account: Root, đích được kiểm, scope đổi khi commit), `:535` (không ai gắn/gỡ link của chính mình, kể cả Root), `:563` (menu và hồ sơ theo role), `:624` (cập nhật F1, F2 không vào audit); `apps/api/test/hrm-input.spec.ts:45` (ngày lịch hợp lệ không timezone), `:73`, `:181` (định dạng F2 như CHECK); web `apps/web/test/hr-pages.spec.tsx:156,255,275` (form tạo, F1 only cho Lead, F2/F3 chỉ với company scope).
- [x] Thêm migration/FK/unique/check, registered bindings, forward manifest và ACL probes. Team/lead/account-link ảnh hưởng quyền cập nhật dưới exclusive fence, kiểm affected set và revision atomic.
- [x] Implement CRUD allowlist, projection riêng và assignment command theo T0; UI HR tạo/xem/cập nhật mã nhân viên, họ tên, ngày sinh, CCCD/giấy tờ định danh, MST, trạng thái làm việc và định mức phép; schema định mức/projection dùng chung contract T7 đã chốt ở T0, không tạo hai nguồn cấu hình phép. Quản lý team/lead và lịch sử. Bổ sung self-link/projection hồ sơ cho bootstrap UI T2 sau khi schema employee tồn tại, có kiểm scope riêng. Enrollment/activation giữ owner identity theo D10.
- [x] Verify list/detail/count cùng scope; lead không đọc CCCD/MST nếu không được phép; hai assignment đồng thời, revoke ngay sau chuyển team và account không tự nâng quyền qua hồ sơ.

### T4 — Lịch làm việc và lịch nghỉ

**Files tạo:** `apps/api/src/work-calendar/work-calendar.types.ts`, `work-calendar.service.ts`, `working-time.helper.ts`, `work-calendar.controller.ts`, `work-calendar.http-port.ts`, `work-calendar.declarations.ts`, `work-calendar.module.ts`, `migrations/hrm-work-calendar.migration.ts`; `apps/web/src/work-calendar/work-calendar.page.tsx`; `apps/api/test/hrm-working-time.spec.ts`, `apps/api/test/hrm-work-calendar.integration-spec.ts`.

**Interface đề xuất:** `workingMinutes(input: WorkingTimeInput): number` trong helper thuần; input đã validate gồm date/range/calendar version, output integer minutes. Không có implicit clock/timezone.

- [x] Failing cases: Mon–Fri 480 phút, Sat/Sun nghỉ, 13:00–14:00 bằng 0, các slot 120/240/480 phút, ngày không tồn tại và khoảng đảo ngược.
- [x] Implement lịch versioned 09:00–13:00/14:00–18:00 và HR chỉnh ngày nghỉ; ngày lễ cụ thể được nhập từ lịch đã xác minh, không hardcode suy đoán.
- [x] Test quyền đổi lịch, duplicate dates, hiệu lực, audit và tác động kỳ đã chốt theo D07; nối UI với API thật.
  - Ghi chú đóng 2026-10-22 (rà soát độc lập, đã chạy xanh). `apps/api/test/hrm-work-calendar.integration-spec.ts`: quyền `:57,:68` (mọi role đọc; chỉ HR fresh và Root fresh đổi), hiệu lực/lịch sử theo version `:92,:139`, duplicate/no-op/stale `:187`, hai đổi đồng thời `:204`, audit chỉ id và rollback khi audit lỗi `:224`, lịch sử append-only `:253`. Kỳ đã chốt D07: `assertPeriodsOpen` trong `apps/api/src/modules/work-calendar/work-calendar.service.ts:35`, test `apps/api/test/hrm-attendance.integration-spec.ts:350–355` (đổi lịch trong kỳ chốt → 409 `error.periodClosed`, version không đổi), race `apps/api/test/hrm-attendance-concurrency.integration-spec.ts:372` và ba bên `apps/api/test/hrm-period-concurrency.integration-spec.ts:223`. UI nối API thật: Playwright `apps/web/e2e/work-calendar.e2e-spec.ts:85,146` và vitest `apps/web/test/work-calendar.spec.tsx`. **Khoảng trống nhỏ, tùy chọn:** chưa có test web ép `error.periodClosed` trên trang lịch (vitest không có ca đó); API đã đủ bằng chứng.
- [x] Verify helper unit + PostgreSQL migration/ACL + calendar HTTP E2E, timezone không phụ thuộc máy chạy.

### T5 — Gửi và theo dõi yêu cầu

**Files tạo:** `apps/api/src/work-request/work-request.types.ts`, `work-request.validator.ts`, `helpers/request-state.helper.ts`, `helpers/request-interval.helper.ts`, `services/work-request.service.ts`, `controllers/work-request.controller.ts`, `work-request.http-port.ts`, `work-request.declarations.ts`, `work-request.module.ts`, `migrations/hrm-work-request.migration.ts`; `apps/web/src/work-request/pages/request-form.page.tsx`, `pages/request-list.page.tsx`, `pages/request-detail.page.tsx`; `apps/api/test/hrm-request.spec.ts`, `apps/api/test/hrm-request.integration-spec.ts`.

**Interfaces đề xuất:** `RequestKind = 'late-arrival' | 'early-departure' | 'wfh' | 'annual-leave' | 'unpaid-leave'`; `WorkRequestService.submit(secret: string, input: SubmitRequestInput): Promise<RequestView>`; input là discriminated union sau runtime validation, employee/owner xác định từ session. State keys và API routes khóa trong spec T0 trước code.

- [x] Failing cases đủ năm loại đơn, đi muộn/về sớm có ngày + giờ dự kiến + lý do và field HR đã chốt. Annual/unpaid chỉ nhận các slot 0,25/0,5/1 ngày đúng requirement: 09–11, 11–13, 14–16, 16–18; 09–13, 14–18; 09–18 bỏ giờ trưa. Reject 10–12 dù cùng 120 phút, slot lấn giờ trưa, cuối tuần/ngày lễ, trùng đoạn, cross-month/year và quá bounds ngày theo D06.
- [x] Kiểm thử việc chỉ được late-arrival/early-departure/unpaid-leave; annual-leave và WFH bị từ chối. Recheck trạng thái theo ngày hiệu lực đã chốt, không chỉ tin UI.
- [x] Implement tạo đơn/segments, owner/object_ref, state ban đầu, immutable submitted content hoặc versioned edit theo D06, lịch sử và audit atomic; UI gửi và theo dõi đơn của mình.
- [x] Verify gửi trùng/retry, invalid payload, unauthorized, owner spoof, pagination trước/sau scope; chưa trừ phép khi mới submit.

### T6 — Team Lead → COO và quyết định atomic

**Files tạo:** `apps/api/src/work-request/services/request-approval.service.ts`, `controllers/request-approval.controller.ts`, `migrations/hrm-request-approval.migration.ts`; `apps/web/src/work-request/pages/approval-inbox.page.tsx`; `apps/api/test/hrm-approval.spec.ts`, `apps/api/test/hrm-approval.integration-spec.ts`, `apps/api/test/hrm-approval-concurrency.integration-spec.ts`. **Files sửa:** `apps/api/src/work-request/work-request.types.ts` (sở hữu `ApprovalInput`), work-request facade/module/state helper, composition, manifest, audit union.

**Interface đề xuất:** `RequestApprovalService.decide(secret: string, input: ApprovalInput): Promise<RequestView>`; `ApprovalInput` có requestId, expectedVersion, idempotencyKey, decision và reason theo schema; actor/stage lấy từ server.

- [x] Failing tests COO trước lead, lead khác team, reject terminal, self-approval/kiêm nhiệm theo D01, team đổi giữa hai bước, thiếu approver, CEO mặc định và payload giả stage.
- [x] Implement state machine backend/helper thuần với exhaustive event cases, strategy theo RequestKind cố định lúc boot, decision history bất biến, employee/request/quota locks theo ADR, expectedVersion và idempotency ràng buộc actor/request/payload. Cùng key khác payload bị từ chối; quyền actor luôn recheck trước replay response.
- [x] Implement/test helper quota + SQL lock protocol WFH theo ngày WFH và quyết định D04; khóa counter/quota key kể cả khi chưa có dòng, không COUNT rồi INSERT thiếu serialization. Case hai duyệt cuối tranh lần thứ 4/5 được nghiệm thu E2E với effect công đầy đủ tại T8; test protocol riêng ở T6 chưa chứng minh flow duyệt cuối đã hoạt động.
- [x] Chạy PostgreSQL races/replay ở các transition đã đủ dependencies (ví dụ Lead quyết định); không trả thành công trước commit. Duyệt cuối + leave/công effects được nghiệm thu cùng transaction tại T7/T8, không thêm transaction thứ hai. Trước khi có đủ handlers, negative case phải chứng minh quyết định cuối bị từ chối, không có state/effect/audit thành công; chưa mở duyệt cuối vận hành tại M2.

### T7 — Quỹ phép và ledger

**Files tạo:** `apps/api/src/leave/leave.types.ts`, `leave.service.ts`, `leave-balance.helper.ts`, `leave.controller.ts`, `leave.http-port.ts`, `leave.declarations.ts`, `leave.module.ts`, `migrations/hrm-leave.migration.ts`; `apps/web/src/leave/leave-balance.page.tsx`; `apps/api/test/hrm-leave.spec.ts`, `apps/api/test/hrm-leave.integration-spec.ts`, `apps/api/test/hrm-leave-concurrency.integration-spec.ts`.

**Interfaces đề xuất:** `LeaveService.balance(secret: string, input: LeaveBalanceQuery): Promise<LeaveBalanceView>` và internal `applyApprovedLeave(tx: ProductTransaction, input: ApprovedLeaveEffect): Promise<void>` trong service. Internal effect chỉ trusted service gọi sau authorization; không là HTTP capability nhận tx. BalanceView phân biệt số được cấp/đã dùng/tương lai/còn khả dụng theo D09.

- [x] Failing tests định mức chuẩn 12 ngày (=5760 phút), định mức thỏa thuận >12, thiếu quyền điều chỉnh, probation không annual leave và không cộng bù thời gian thử việc.
- [x] Implement grant policy đã chốt D03, effective-date ledger, audit điều chỉnh/hoàn phép và constraint một debit/effect cho mỗi request segment; số dư đầu kỳ D14 có nguồn đối soát.
- [x] Nối duyệt cuối với debit ledger trong transaction T6; reject/pending không debit, approved future không bị lẫn với phép đã dùng tới ngày báo cáo. Khóa balance bucket trước kiểm số dư, kể cả bucket mới.
- [x] Thêm kiểm số dư khả dụng (D09, B-05/E-08/E-13) vào `submitRequest` (T5 hiện chưa kiểm, xem `shortcut:` trong `work-request.service.ts`) trước khi hiển thị số dư/tích lũy; đối soát các đơn annual-leave `pending_*` đã gửi trước đó (danh sách vượt tích lũy theo tháng, quyết định cho HR: giữ, báo, hay người gửi hủy), không tự hủy/sửa đơn.
- [x] Test hai đơn tranh số dư cuối, duyệt trùng, qua năm/chuyển chính thức, hủy/đảo theo D06, lỗi audit rollback cả decision lẫn ledger; chạy unit + PostgreSQL integration.

### T8 — Bảng công và điều chỉnh

**Files tạo:** `apps/api/src/attendance/attendance.types.ts`, `attendance.service.ts`, `attendance-calculation.helper.ts`, `attendance.controller.ts`, `attendance.http-port.ts`, `attendance.declarations.ts`, `attendance.module.ts`, `migrations/hrm-attendance.migration.ts`; `apps/web/src/attendance/attendance.page.tsx`; `apps/api/test/hrm-attendance.spec.ts`, `apps/api/test/hrm-attendance.integration-spec.ts`.

**Interface đề xuất:** `AttendanceService.period(secret: string, input: AttendanceQuery): Promise<AttendancePeriodView>`; `applyApprovedAttendance(tx: ProductTransaction, input: ApprovedAttendanceEffect): Promise<void>` internal, cùng owner/effect rules với T7. View tách scheduled/paid/unpaid/annualLeave/WFH/late/early theo D05; không trừ công nghỉ hưởng lương máy móc.

- [x] Failing tests mặc định đủ công theo lịch và employment period; không tính công trước ngày vào làm/sau nghỉ việc; tách giờ trưa/cuối tuần và ngày lễ/Tết hưởng nguyên lương trong employment period theo lịch đã xác minh; unpaid 120/240/480 phút, annual leave/WFH và late/early theo quyết định D05.
- [x] Implement công dựa trên calendar version + approved effects + audited adjustments; chọn dữ liệu nguồn chuẩn trong spec, không duy trì hai nguồn có thể lệch. Không mở rộng sang payroll/máy chấm công ngoài requirement.
- [x] Nối effect công cùng transaction T6/T7; chỉ mở duyệt cuối sau khi mọi loại đơn được mở đã có effects đầy đủ và pass rollback tests theo gate M3. Implement period close/reopen nếu D07 yêu cầu. HR chỉnh lịch/đơn quá khứ phải cho kết quả xác định và có lịch sử.
- [x] Chạy đủ PostgreSQL races duyệt cuối approve/approve, approve/reject, approve/revoke, hai đơn tranh WFH cap/số dư cuối và replay sau timeout; một decision/effect tương ứng, lỗi ghi công/audit rollback cả decision/leave. Verify đảo quyết định theo D06, overlap không tính trùng, recompute cùng đầu vào cùng kết quả; browser kiểm công cá nhân và HR đối soát. **Hoàn tất (2026-10-22, phần E ở ledger):** PostgreSQL races đã đủ (`hrm-cancel-concurrency` có hai ca hủy/duyệt cuối với thứ tự khóa ép sẵn, 20/20 xanh); browser công cá nhân và HR đối soát có dữ liệu (`attendance.e2e-spec.ts` 6/6, panel một hàng ATT001).

### T9 — Sáu báo cáo và XLSX

**Files tạo (đường dẫn thực: `apps/api/src/modules/report/`):** `report.types.ts`, `services/report.service.ts`, `services/excel-export.service.ts`, `report.controller.ts`, `report.http-port.ts`, `report.declarations.ts`, `report.module.ts`; `apps/web/src/report/report.page.tsx`; `apps/api/test/hrm-report.integration-spec.ts`, `apps/api/test/hrm-excel.spec.ts`. Chỉ thêm port/export adapter nếu có capability thay implementation thực sự.

**Interfaces đề xuất:** `ReportService.query(secret: string, input: ReportQuery): Promise<ReportResult>`; ReportQuery là union attendance/leave/late-early/wfh/seniority/birthday với khoảng ngày và cutoff rõ ràng. Export dùng cùng scope + snapshot/source version; renderer nhận DTO projection, không raw entity. Chốt cơ chế snapshot trước query: runner đang `READ COMMITTED`, nhiều SELECT trong một transaction không tự có snapshot cố định; ưu tiên một statement/CTE hoặc thiết kế snapshot riêng theo architecture. Render ngoài fence và authorize lại trước giao artifact, không tự tăng deadline/isolation của runner.

- [x] Viết datasets có expected totals cho cả sáu báo cáo, gồm ngày cắt phép, WFH khác tháng duyệt, thâm niên từ employment history và sinh nhật 29/2 theo cách hiển thị đã chốt.
- [x] Implement query apply quyền trước aggregate/pagination/export; range/rows/file-size giới hạn trong spec, cancel/cleanup khi client ngắt. Nếu vượt deadline runner (3 s thực tế, 2 s là mục tiêu) thì thiết kế snapshot/batch riêng trước, không tự tăng timeout hoặc xuất thiếu dòng.
- [x] Kiểm/pin ExcelJS candidate sau docs/version/license và fixture read-back; user text bắt đầu `=`, `+`, `-`, `@` ghi đúng cell text không formula. Không xuất CCCD/MST ngoài projection đã duyệt.
- [x] Verify XLSX mở/read-back được, số liệu khớp API/ledger/công trong snapshot, revoke khi export, concurrent write không tạo báo cáo trộn snapshot và server-side download authorization.

### T10 — Mẫu, tạo batch và lưu hợp đồng

**Files tạo:** `apps/api/src/contract/contract.types.ts`, `services/contract-template.service.ts`, `services/contract-generation.service.ts`, `ports/contract-document.port.ts`, `ports/contract-storage.port.ts`, `contract.controller.ts`, `contract.http-port.ts`, `contract.declarations.ts`, `contract.module.ts`, `migrations/hrm-contract.migration.ts`; `apps/web/src/contract/pages/contract-template.page.tsx`, `pages/contract-batch.page.tsx`, `pages/contract-detail.page.tsx`; `apps/api/test/hrm-contract.integration-spec.ts`, `apps/api/test/hrm-contract-renderer.spec.ts`.

**Input:** T3, D11/D13, spec schema hợp đồng. **Output:** mẫu được HR duyệt và version, generation batch cho hợp đồng thử việc/lao động có kết quả từng nhân viên, version + trạng thái hợp đồng/ký liên kết và xem được từ hồ sơ nhân viên, tài liệu download qua quyền; renderer/storage adapter được chọn thật ở composition.

- [ ] Failing tests template chưa duyệt, thiếu placeholder, field ngoài allowlist, filename/path traversal, macro/script/remote URL và payload vượt size/type; dữ liệu giả trong fixtures.
- [ ] Implement template version/hash và employee data snapshot được phép; pin renderer/storage theo spec. Render và network ngoài fence, sau đó recheck quyền/version để commit metadata. Thiếu adapter reject capability, không giả thành công.
- [ ] Batch có item idempotency, bounded concurrency/retry và status bền vững; nếu cần worker, tạo lifecycle/durability spec riêng trước wire. Xử lý partial failure và orphan artifact bằng cleanup/reconciliation có owner.
- [ ] Verify batch retry không tạo hợp đồng đôi; tài liệu bất biến theo version, download không public, metadata/audit không chứa nội dung/PII; kiểm upload/download và UI với storage adapter thật của môi trường thử nghiệm.

### T11 — Ký hợp đồng theo phương thức đã xác minh

**Files tạo:** `apps/api/src/contract/ports/contract-signing.port.ts`, `services/contract-signing.service.ts`, `migrations/hrm-contract-signing.migration.ts`, `apps/web/src/contract/pages/contract-sign.page.tsx`; adapter file đặt theo provider đã chọn, `apps/api/test/hrm-contract-signing.integration-spec.ts`, `docs/hrm-contract-signing.md`.

**Input:** T10 và D12/D13 được quyết định. **Output:** công ty ký bằng phương thức D12 đã chọn; người lao động chèn/tải ảnh chữ ký cho hợp đồng của chính mình, trên đúng hash/version, trạng thái và bằng chứng theo phương thức đã xác minh; không gọi chữ ký hình ảnh là chữ ký số.

- [ ] Ghi xác nhận phương thức/giá trị pháp lý cần thiết từ người phụ trách; thử khả năng tích hợp thiết bị/provider theo docs chính thức. Chưa có thiết bị/provider thì ghi blocked riêng, không đóng requirement bằng mock.
- [ ] Failing tests ký sai actor/document version, session không hợp lệ, replay, webhook giả, upload ảnh sai định dạng/kích thước, document đổi trong khi chờ ký.
- [ ] Implement signing capability chọn lúc boot; upload/verify file và provider I/O ngoài transaction, callback xác thực/idempotent rồi recheck facts/hash trước lưu trạng thái + audit.
- [ ] Verify provider sandbox/thiết bị thật và read-back tài liệu cuối; lưu signer/time/hash/evidence phù hợp, private key/token không xuất hiện trong browser/server log. Phân biệt fixture pass với chứng nhận provider/pháp lý thật.

### T12 — UAT, dữ liệu đầu kỳ và vận hành

**Files tạo:** `docs/hrm-uat.md`, `docs/hrm-production-runbook.md`, `docs/hrm-verification.md`; import tool chỉ tạo sau khi D14 có format/mapping. **Files sửa:** CI/scripts, config/examples, README và smoke/E2E theo implementation thực tế.

- [ ] Chạy toàn bộ unit/integration/API E2E/frontend browser tests đã có; kiểm migrations từ DB rỗng và nâng cấp từ snapshot mốc trước, exact ACL/protection/readiness. Không tự sửa lịch sử migrations để làm xanh.
- [ ] UAT đủ role và các flow: cấp quyền/thu hồi, probation, hai bước duyệt, WFH limit, phép/công, sáu XLSX reports, batch/sign contracts; sign-off theo mốc, không chỉ happy path.
- [ ] Chuẩn bị dữ liệu 50 nhân viên và số dư đầu kỳ bằng nguồn được duyệt; dry-run/idempotency/reconciliation, không đưa PII thật vào tests/logs. Đo workload đại diện và ghi môi trường, latency/lock wait/query count; chưa có SLO thì chốt trước tiêu chí đạt.
- [ ] Diễn tập backup/restore, forward repair/rollback vận hành, key/credential rotation, storage recovery, retention, failed batch/signing và recovery delivery. Audit sink/recovery thật cần provider và durability riêng trước khi coi là vận hành đầy đủ.
- [ ] Ghi checklist readiness và rủi ro còn lại, chuẩn bị gói bàn giao; publish/deploy chỉ khi được người dùng yêu cầu.

## 6. Kiểm chứng và quy tắc cập nhật trạng thái

Các lệnh dưới đây đã tồn tại trong root `package.json`, điều phối scripts thuộc API và shared tests. Đây là checklist chạy lại khi triển khai HRM; kết quả baseline đã chạy được tách ở mục 1/ADR 0015, không suy ra các checks của tính năng HR tương lai đã pass:

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:e2e
```

Ví dụ chọn nhóm test hiện có: `pnpm run test:unit -- apps/api/test/structure.spec.ts`; test mới chỉ chạy sau khi file đã được tạo. Integration/API E2E cần Docker/PostgreSQL disposable. Browser test command và frontend build scripts phải được bổ sung tại T1 cùng runner thật, không dùng placeholder/`--if-present`.

Mỗi task code đi theo test hành vi thất bại → implementation → test liên quan pass → typecheck/build → review diff và cập nhật ledger bằng lệnh/kết quả thực tế. HTTP/module thay đổi phải có inventory/OpenAPI và E2E; SQL/privilege/fence/migration phải có PostgreSQL integration. Fail/timeout/skip/environment error báo riêng; không tick chỉ vì code hoặc tài liệu mô tả đã có.

Lập kế hoạch chỉ kiểm Markdown, local links và diff; không cần chạy runtime suite. Không sửa requirement để hợp thức hóa đề xuất. Không commit/push khi chưa được yêu cầu.

## 7. Đối chiếu requirement và kết luận review — 2026-10-17

| Requirement                                                                       | Tasks sở hữu      | Bằng chứng nghiệm thu phải có                                                                                 |
| --------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| §2 — Mon–Fri, 09–13/14–18, nghỉ trưa/cuối tuần, lễ/Tết hưởng lương, công mặc định | T4/T8             | Helper đúng slot/lịch versioned; công theo employment period và effect theo D05, holiday hưởng lương          |
| §3 — self/team/HR/COO, CEO không duyệt, Lead → COO, lịch sử và người liên quan    | T2/T3/T5/T6       | Permission/field matrix, history scope và state-machine/race/revoke tests; duyệt cuối chỉ mở tại M3           |
| §4.1 — Đi muộn/về sớm: ngày, giờ, lý do, field HR                                 | T5/T6/T8/T9       | Input allowlist, lịch sử duyệt, effect công theo D05 và báo cáo chỉ tính đơn đã duyệt                         |
| §4.2 — WFH tối đa 4 lần/tháng, đếm theo nhân viên/tháng                           | T5/T6/T8/T9       | D04 chốt đơn vị và cách chặn/cảnh báo; kiểm bucket đầu tháng, hai đơn tranh quota, tháng WFH khác tháng duyệt |
| §4.3 — Phép 12 ngày, thỏa thuận >12, đúng slot, cấp/đã dùng/còn, trừ sau duyệt    | T3/T4/T5/T6/T7/T9 | Entitlement một nguồn, exact slots, cutoff D03/D09, ledger atomic, không debit khi pending/rejected           |
| §4.4 — Unpaid đúng slot, đơn đã duyệt vào công                                    | T4/T5/T6/T8       | Exact slot validation, effect công atomic và không tính trùng                                                 |
| §4.5 — Probation chỉ late/early/unpaid, không annual/WFH hay bù phép thử việc     | T3/T5/T7/T8       | Ngày hiệu lực; reject ở server và không tạo grant bù; cross-probation case theo G0                            |
| §6.1 — Tạo/xem/cập nhật đầy đủ field tối thiểu, PII theo vai trò                  | T2/T3/T7          | Field allowlist/projection và tests list/detail/count/identity link; định mức phép thống nhất                 |
| §6.2 — Mẫu HR duyệt, batch tự điền, hợp đồng thử việc/lao động                    | T3/T10            | Template version/field mapping, item idempotency/partial failure, link + trạng thái trong hồ sơ               |
| §6.2 — Công ty ký, nhân viên ký ảnh, xác minh pháp lý, lưu trạng thái             | T11/T12           | D12/D13, exact hash/actor, upload/callback/replay tests và provider/thiết bị thực khi áp dụng                 |
| §6.3 — Chấm công, phép, late/early, WFH, thâm niên, sinh nhật; Excel              | T9/T12            | Đủ sáu report datasets, cutoff/scope/snapshot, XLSX read-back và đối soát số liệu                             |

**Kết luận:** Không thiếu nhóm chức năng cấp requirement sau đối chiếu. Kế hoạch vẫn là draft tổng thể, chưa đủ để triển khai trọn bộ mà không có quyết định bổ sung. Có thể bắt đầu T0 để chốt spec; T1 và các task code chỉ thực hiện khi phần thiết kế liên quan đã được review và có bước kiểm chứng cụ thể. Không tick task HR dựa trên việc layout hoặc unit suite nền đã pass.

Các điểm chặn còn mở: G0 theo task phụ thuộc; Docker/PostgreSQL integration và API E2E; full-format của requirement gốc; versions/peer compatibility frontend chưa pin; storage/renderer/signing/delivery thực chưa chọn hoặc kiểm. Các lựa chọn luật nghỉ lễ/phương thức ký và SLO chưa được tài liệu này xác nhận. Kiểm tài liệu ở lượt review này gồm scoped Prettier, local links, đối chiếu paths/symbols và diff; runtime suites không chạy lại vì không sửa code.

## 8. Điểm bắt đầu và cách thực thi

Bắt đầu T0 rồi T1. Trước phần implementation phụ thuộc, người dùng review spec/ADR tương ứng và chọn phạm vi mốc cần làm; yêu cầu lập kế hoạch hiện tại không là yêu cầu triển khai toàn bộ.

Đề xuất thực thi trực tiếp từng task và review theo mốc vì các interface duyệt/phép/công phụ thuộc chặt. Nếu người dùng muốn chia agent độc lập, chỉ tách sau khi contracts đã được chốt; không cho nhiều task đồng thời sửa state machine/manifest/fence chung.

Chưa đưa lịch giao hàng theo ngày: cần chốt G0, nhân lực, provider ký/storage và phạm vi pilot trước khi ước lượng. M0–M6 là thứ tự và tiêu chí bàn giao, không phải cam kết thời gian.
