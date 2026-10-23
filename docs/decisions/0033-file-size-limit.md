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

## Bổ sung 2026-10-23: helper không async, commit B (nhóm database)

Chỉ `apps/api/src/database/helpers/product-database.helper.ts` (690 dòng, ngoại lệ `max-lines` tạm) được tách; `transaction-errors.helper.ts` đã đồng bộ. Các file khác trong `src/database` còn `async` là `product-transaction.runner.ts` (runner) và `migrations/*` (miễn theo ADR), không phải helper. Không đổi SQL, thứ tự câu lệnh, thông điệp lỗi, ma trận quyền, hash migration hay hành vi.

- Phần đồng bộ ở lại `helpers/product-database.helper.ts` (còn ~83 dòng logic): `ProductDatabasePurpose`, `productFunctionOwners` (nay `export`), `productMigrations`, `productDataSourceOptions`, và `grantsOf` (hàm dựng chuỗi SQL ACL, trước đây không export).
- Dữ liệu khai báo -> `database/product-privilege.declarations.ts`: `RuntimePurpose`, `expectedPrivileges` (credential matrix), `protectionFunctions`, `protectionTriggers`, `protectedTables`, `sessionOwnerAcl`, `accountOwnerAcl`, định nghĩa view `iamAccountDefinition`/`accountDirectoryDefinition`. Không có hàm async nên là `.declarations.ts` (miễn `max-lines` theo ADR).
- `provisionProductDatabase` -> `database/services/product-database-provision.service.ts`. Vai trò `service`, không phải `repository`: đây là điều phối offline tạo role/cấp quyền/chạy migration bằng credential admin, không truy cập dữ liệu nghiệp vụ và không nằm trong `ProductCommand`/`ProductQuery`. Không có dependency thật nên giữ là hàm (như `product-obligation.service.ts`), chữ ký không đổi.
- `verifyProductPrivileges` và `functionOwnerGrants` -> `database/services/product-privilege-verify.service.ts`. Cùng lý do: probe fail-closed đọc catalog `pg_*` của các pool đã cấp, điều phối kiểm tra drift chứ không đọc/ghi dữ liệu nghiệp vụ. Chữ ký không đổi.
- Import: `provisionProductDatabase` đổi sang `.../database/services/product-database-provision.service.js`; `verifyProductPrivileges`/`functionOwnerGrants` sang `.../database/services/product-privilege-verify.service.js`; `ProductDatabasePurpose`, `productDataSourceOptions`, `productMigrations` giữ ở helper. Cập nhật 36 file caller (src: `product-runtime.service.ts`, `hr-database.helper.ts`; `tools/product.ts`; test và test helper).
- ESLint: `offlineImports` vẫn chặn `productDataSourceOptions`/`productMigrations` từ `**/product-database.helper*` và thêm mục chặn `provisionProductDatabase` từ `**/product-database-provision.service*` (không nới; `verifyProductPrivileges` vẫn được runtime dùng như trước). `test/module-boundaries.spec.ts` dùng đường dẫn mới cho ca "provisioning". Ngoại lệ `max-lines` của `product-database.helper.ts` đã xóa vì mọi file mới <= 300 dòng logic.

## Bổ sung 2026-10-23: helper không async, commit C (nhóm hr + employee)

Chỉ `modules/hr/helpers/` và `modules/employee/employee-database.helper.ts`; `hr-idempotency.helper.ts` và `hr-input.helper.ts` đã đồng bộ. Helper async của module khác (`leave`, `attendance`, `work-request`...) chưa đổi. Chưa đổi tên/di chuyển `modules/hr` và chưa tách `hr.declarations.ts`. Không đổi SQL, thứ tự câu lệnh, hash, manifest hay hành vi.

- `hr/helpers/hr-database.helper.ts` ở lại phần đồng bộ (`hrPrivileges`, `HR_TODAY`, `hrCurrent`, `hrScoped`, `isUniqueViolation`, `HR_COMPANY_ID`, `WORK_CALENDAR_ID`; `hrViews` và `registerObject` nay `export`).
- `ensureHrCompany`/`ensureWorkCalendar` (và `ensureAnchor` nay `#ensureAnchor`) và `registerHrObject` -> `hr/repositories/hr-object.repository.ts` (`HrObjectRepository.ensureHrCompany`/`.ensureWorkCalendar`/`.register`, không trạng thái). Tạo ở `createProductHrRepositories` (`product-hr.factory.ts`, field `hrObject`), `tools/product.ts` và test helper; truyền vào `EmployeeCommandRepository`, `createTeam(objects)` (kéo theo `teamCommands(create)` và tham số thứ ba của `TeamService`) và `createSubmitRequest(objects, ...)`.
- `verifyHrProtection`, `verifyWorkCalendarSchema` (cùng `objectOwnerAcl`, `hrScopeViewDefinitions`) -> `hr/services/hr-protection-verify.service.ts`: probe catalog fail-closed, cùng lý do với `product-privilege-verify.service.ts` (commit B); hàm, chữ ký không đổi.
- `hr/helpers/hr-access.helper.ts` (`visibleOrNothing`, một caller) bị xóa; logic `.catch` bắt `ProductAccessDenied` nằm trực tiếp trong `EmployeeService.me`.
- `employee/employee-database.helper.ts` ở lại SQL/mapping đồng bộ (`date`, `instant`, `stateSql`, `employmentState`, `employeeTarget`); `unique`, `bumpEmployee`, `assertSheetsOpenFrom` -> `employee/repositories/employee-write.repository.ts` (`EmployeeWriteRepository`, không trạng thái), tạo ở factory và truyền vào `EmployeeCommandRepository(objects, writes)`.
- Kiểm: typecheck, ESLint file đổi, unit liên quan; integration xem báo cáo bàn giao.

## Bổ sung 2026-10-23: helper không async, commit D (attendance + leave effect)

Hai helper async cuối cùng trong `apps/api/src` được chuyển; sau commit này `grep -rnE 'async|await|Promise' apps/api/src --include='*.helper.ts' -l` trả về 0 file (đã chạy). Không đổi SQL, thứ tự khóa decide (request -> bucket phép / counter WFH -> kỳ công `FOR SHARE`), idempotency, audit, mã lỗi hay hành vi.

- `attendance/helpers/attendance-effect.helper.ts` -> `attendance/repositories/attendance-effect.repository.ts` (`AttendanceEffectRepository(facts)`: `applyApprovedAttendance`, `applyApprovedWfh`, `reverseApprovedWfh`, `wfhLimitExceeded`; `approvedRequest` thành `#approvedRequest`). Nhận `AttendanceFactsRepository` qua constructor cho `assertPeriodsOpen`.
- `leave/helpers/leave-effect.helper.ts` -> `leave/repositories/leave-effect.repository.ts` (`LeaveEffectRepository(facts)`: `assertLeaveAvailable`, `applyApprovedLeave`, `reverseApprovedLeave`). Nhận `LeaveFactsRepository` qua constructor.
- Chữ ký: `createApprovedEffects(attendanceEffects, leaveEffects)`, `createCancelCommands(attendanceEffects, leaveEffects)`, `createSubmitRequest(objects, effects, attendanceFacts, attendanceEffects, leaveEffects)`. Hai repository mới là field `attendanceEffect`/`leaveEffect` của `ProductHrRepositories`; mọi command vẫn tạo đúng một lần ở `createProductHr` (định danh đối tượng cho `ProductAuthorization`).
- Kiểm: typecheck, ESLint file đổi, unit liên quan; integration `hrm-leave`+`hrm-attendance` 29/29, `hrm-approval` 15/15, `hrm-cancel`+`hrm-coo-submit` 20/20 (mỗi lệnh khi load dưới 40); chưa chạy `hrm-leave-concurrency`, `hrm-request`, concurrency khác.
