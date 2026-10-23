# ADR 0033 — Giới hạn 300 dòng cho file business logic

Ngày: 2026-10-21. **Trạng thái: Accepted** (2026-10-21, người dùng chọn rule `max-lines` và tách ngay các service nghiệp vụ lớn). Không đổi hành vi, route, SQL, thứ tự khóa, tên bảng, mã lỗi, quyền, manifest/hash hay locale.

## Bối cảnh

Các service nghiệp vụ (`employee.service.ts` 658 dòng, `leave.service.ts` 537, `attendance.service.ts` 461, `work-request.service.ts`, `request-approval.service.ts`, `team.service.ts`) và vài trang web (`approval-inbox.page.tsx`, `work-calendar.page.tsx`, `team-detail.component.tsx`, `employee-profile.component.tsx`) gộp command, query, SQL và mapping trong một file, khó review thứ tự khóa và quyền.

## Quyết định

1. ESLint `max-lines` mức `error`: 300 dòng, `skipBlankLines: true`, `skipComments: true`, cho `apps/api/src` và `apps/web/src` (`fileSizeLimit` trong `eslint.shared.config.js`, gọi từ `eslint.config.js` của từng app).
2. Miễn `*.declarations.ts`, `*.schema.ts`, `*.migration.ts`, `*.manifest.ts` (dữ liệu khai báo) và test (nằm ngoài `src`).
3. Đã tách các file trên theo trách nhiệm (SQL đọc, SQL ghi/effect, helper SQL dùng chung, component con); tên class, method, DI token, `ProductCommand`/`ProductQuery` đăng ký ở `product-runtime.service.ts` (từ 2026-10-22 qua `product-hr.factory.ts`) và thứ tự khóa giữ nguyên.
4. Ngoại lệ tạm (nền tảng lớn, chưa tách): `auth/services/product-mfa.service.ts`, `authorization/core/policy.validator.ts`, `authorization/services/product-authority.service.ts`, `database/helpers/product-database.helper.ts`. Chúng nằm trong danh sách `fileSizeLimit([...])` ở `apps/api/eslint.config.js` với comment `shortcut`: tách khi chạm tới file để sửa logic, vì tách các file khóa/ủy quyền/provisioning cần review riêng về thứ tự khóa và bảo mật.
5. Kiểm: `apps/api/test/file-size-limit.spec.ts` chạy ESLint thật lên file mẫu (301 dòng bị bắt, 300 qua, dòng trống/comment không tính, `*.declarations.ts`/`*.schema.ts`/`*.migration.ts`/`*.manifest.ts` được miễn, file ngoại lệ được miễn còn file khác cùng thư mục thì không).

## Cách gỡ ngoại lệ

Khi tách một file ngoại lệ xuống còn <= 300 dòng, xóa đường dẫn khỏi danh sách trong `apps/api/eslint.config.js`; test `keeps the temporary exception list explicit` dùng một file trong danh sách, cập nhật nó sang file còn lại (hoặc xóa test khi danh sách rỗng). Không thêm file mới vào danh sách để qua lint.

## Hệ quả

Nhiều file nhỏ hơn, review dễ hơn; đổi lại thêm import nội bộ. Không giảm rủi ro bảo mật hay hiệu năng. Rule chỉ đo số dòng, không đo độ phức tạp.

## Bổ sung 2026-10-22: mọi repository là class

Người dùng quyết định (ghi đè quy ước "hybrid: class chỉ khi có dependency thật", chỉ cho repository): **mọi file `*.repository.ts` trong `apps/api/src` export một class** (`XxxRepository`), gồm 15 file: `audit/product-audit.repository.ts` (`ProductAuditRepository.appendProductAudit`), `attendance/repositories/*` (`AttendanceFactsRepository`, `AttendancePeriodRepository`, `AttendanceAdjustRepository`), `employee/repositories/*`, `leave/repositories/*`, `report/repositories/*` (`ReportSheetRepository`, `ReportLeaveRepository`, `ReportSeniorityRepository`, `ReportBirthdayRepository`), `team/team-read.repository.ts`, `work-request/repositories/*`.

- Lý do: một dạng duy nhất cho truy cập dữ liệu, dependency (repository facts, audit) đi qua constructor và thấy được ở composition root thay vì import hàm; không đổi SQL, hành vi, tên method công khai, thứ tự tham số hay kết quả.
- `ProductCommand`/`ProductQuery` là field `readonly` của instance (định danh ổn định, vì `ProductAuthorization` so sánh theo đối tượng). `#private` giữ dependency (`#facts`); `EntityManager` của transaction vẫn truyền vào method, không giữ trong field. Method không state vẫn là method instance, không `static`.
- Composition: `infrastructure/product-hr.factory.ts` (`createProductHr`) tạo repository, các command cần chúng và service; `ProductRuntime` và `test/hrm-stack.helper.ts` dùng chung. Không Nest DI mới, không service locator, không singleton. Audit: `ProductAuditRepository` tạo ở `ProductRuntime.create`/`tools/product.ts` và truyền vào `ProductAuthorization`, `ProductIdentityService`, `ProductManifestReconciler`, `bootstrapProductRoot`, `reissueRootActivation`, `revokeProductRoot`, `setRootEmail`, `resetProductMfa`, `purgeExpiredSessions`; obligation `audit@1` là `createProductObligations(audit)`.
- Phần thuần/đồng bộ dùng chung được tách sang helper: `attendance/helpers/attendance-facts.helper.ts` (`approvedEffectsSql`/`approvedEffectsBySql`, `adjustmentMinutesSql`, `calendarDaysSql`, `totalsOf`, `monthsOf`, `WFH_MONTH_LIMIT`, ...) và `leave/helpers/leave-facts.helper.ts` (`leaveFactsColumns`, `leaveFactsOf`, `entitlement`). Hàm async của helper hiện có (`applyApprovedLeave`, `applyApprovedAttendance`, `assertLeaveAvailable`, ...) chưa chuyển vào repository/service; chúng nhận repository facts làm tham số đầu.
- Hệ quả cho đăng ký: `employeeCommands(repo)`, `leaveQueries(repo)`, `attendanceCommands(...)`, `createApprovedEffects(...)`, `createSubmitRequest(effects, ...)`, `createSetCalendarDay(...)`, `createAdjustLeaveBalance(...)`, `createCancelCommands(...)` là hàm nhận instance; `productCommands`/`productQueries` thành `createProductHr().commands/.queries`.
- Chưa chạy: toàn bộ integration/E2E; chỉ có typecheck, ESLint, unit liên quan và vài integration mức repository.

## Bổ sung 2026-10-23: helper không async, commit A (nhóm authorization)

Người dùng quyết định: helper không dùng `async`/`await`/`Promise`; phần có effect vào service hoặc repository (rule ESLint cho `*.helper.ts` sẽ thêm ở commit riêng, chưa có). Commit A chỉ xử lý `apps/api/src/authorization/helpers/`; nhóm khác (auth, database, hr, modules, infrastructure) chưa đổi. Không đổi SQL, hash manifest/release, thứ tự câu lệnh hay hành vi.

- `helpers/product-manifest-definitions.helper.ts` -> `repositories/product-manifest-definition.repository.ts` (`ProductManifestDefinitionRepository.apply`).
- `helpers/product-manifest-boundaries.helper.ts` -> `repositories/product-manifest-boundary.repository.ts` (`ProductManifestBoundaryRepository.apply`).
- `helpers/product-manifest-seeds.helper.ts` -> `repositories/product-manifest-seed.repository.ts` (`ProductManifestSeedRepository.apply`, cùng `objectId` tách từ `product-manifest.helper.ts`).
- `helpers/product-manifest-verify.helper.ts` -> `repositories/product-manifest-verify.repository.ts` (`ProductManifestVerifyRepository.verifyApplied`; nhận `ProductManifestSeedRepository` qua constructor để dùng `objectId`).
- `helpers/protected-state.helper.ts` -> `repositories/protected-state.repository.ts` (`ProtectedStateRepository.hash` = `protectedStateHash`, `.catalogIsEmpty` = `codeOwnedCatalogIsEmpty`; danh sách `codeOwned` giữ nguyên). Migration 012 và `ProductRoot` dùng instance module-level; migration vẫn chỉ import file này, không đụng helper/service khác.
- `helpers/product-obligations.helper.ts` -> `services/product-obligation.service.ts` (giữ tên `createProductObligations`, `fulfillProductObligations`, kiểu handler/registry); các import trong test/tools đổi đường dẫn tương ứng.
- `helpers/product-manifest.helper.ts` ở lại, chỉ còn hàm đồng bộ (`sha256`, `utf8`, `reject`, `definitionHash`, `grantId`).
- `ProductManifestReconciler` tự tạo các repository không trạng thái bằng field `#private`; chữ ký constructor không đổi. ESLint chặn thêm `**/authorization/repositories/**` khỏi HTTP handler (siết, không nới).
- Kiểm: typecheck, ESLint file đổi, unit (structure, module-boundaries, file-size-limit, system-release, single-app, authorization-keys) và `product-system.integration-spec.ts`; chưa chạy phần còn lại của integration/E2E.
