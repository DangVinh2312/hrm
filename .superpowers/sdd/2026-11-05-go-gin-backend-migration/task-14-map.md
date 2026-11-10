# Bản đồ chuẩn bị Task 14 — M6 attendance

Ngày 2026-11-10; chỉ đọc source, không sửa repository và không chạy build/test/database. Repo đã xác nhận `/Users/vinhdq2312/Documents/personal/hrm`, branch `version/single-app`, HEAD `1402120`. Lúc bắt đầu có hai file sổ tiến độ đang sửa; các thay đổi đó được giữ nguyên. Tracker đọc một lần để định vị, trạng thái có thể tiếp tục đổi bởi implementer13d.

## Phạm vi và contract đã xác minh

Task 14 trong `docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md:340` còn hai checkbox: chuyển attendance/test còn lại, và snapshot format 1/2 trên stack trộn khi report còn NestJS. Nguồn source chưa có package `internal/modules/attendance`; package dùng chung `attendancecore` đã tồn tại. Đây là chuyển sáu route, không phải chuyển report M7 hoặc thiết kế schema mới.

| Route                                               | Permission / target                              | Kết quả và input                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| GET `/api/hr/employees/:id/attendance`              | `employee.readAttendance`, employee id           | Sheet 200 hoặc absent/foreign 404; `month` tùy chọn, mặc định tháng theo DB business clock                                 |
| GET `/api/hr/attendance/periods/:month`             | `hrCompany.read`, `permission.CompanyID`         | State/version/events 200 hoặc 404; chưa có period là open/version `1`/events `[]`                                          |
| POST `/api/hr/attendance/periods/:month/close`      | `hrCompany.managePeriod`, CompanyID              | 200 `{month,state,version}`, body `{}`; fresh và CSRF/Origin; state phải open, không đóng tháng tương lai                  |
| POST `/api/hr/attendance/periods/:month/reopen`     | `hrCompany.managePeriod`, CompanyID              | 200 cùng shape, body `{reason}`, 1..1000 code point sau trim; state phải closed                                            |
| GET `/api/hr/employees/:id/attendance-adjustments`  | `employee.readAttendanceAdjustment`, employee id | 200 list; `month` bắt buộc, limit/offset theo budget chung; absent/foreign 404                                             |
| POST `/api/hr/employees/:id/attendance-adjustments` | `employee.adjustAttendance`, employee id         | 201 `{id}`; workDate/minutes/reason, reference tùy chọn, Idempotency-Key UUID v4; fresh và CSRF/Origin; absent/foreign 404 |

**Close/reopen không có expectedVersion.** Đã đối chiếu `apps/api/src/modules/attendance/attendance.validator.ts` (`parsePeriodClose`, `parsePeriodReopen`), `attendance.types.ts`, `apps/web/src/features/attendance/attendance.client.ts` và requestBody của `apps/api-go/contract/openapi.json`. Parent đã xác nhận/sửa lỗi diễn đạt trong brief14; kiểm state dưới khóa và tăng version, không thêm optimistic concurrency field. Không có câu hỏi semantics còn mở tại điểm này.

Không thêm error code: command rejection/state/future/outside-employment/negative total là 409 `error.conflict`; period guard 409 `error.periodClosed`; key khác payload 422 `error.idempotencyKeyReused`; self adjustment 403 `error.accessDenied`; input sai 400. Lỗi nội bộ không lộ raw driver error.

## Source nghiệp vụ và API Go sẵn có

### Operations / façade / HTTP

- TS `attendance.service.ts`: `attendanceCommands`, `attendanceQueries`, `AttendanceService.period/periodState/closePeriod/reopenPeriod/adjust/adjustments`. Service ánh xạ command không tìm thấy company thành 403; query company không tìm thấy thành 404; adjustment target không thấy thành 404. `adjustmentHash` là SHA-256 của JSON array `[employeeId,workDate,minutes,reason,reference]`, không hash key.
- TS `attendance.controller.ts`: sáu route ở bảng, tất cả classification Authorize; không giống decision/cancel route Authenticated động. Go có thể theo `internal/modules/leave/leave_controller.go`: `Routes{HTTPPort,Origin}`, `httpapi.Register`, `enforcement.Authorize`, decoder CSRF trước body/session; handler chỉ giữ façade đã bind.
- Mẫu đăng ký đúng pointer: `internal/modules/leave/leave_service.go` `Operations/NewOperations/All/Bind/Service`; `authority.NewQuery`, `authority.NewCommand`, `authority.Read`, `authority.Execute`. Command dùng `database.ModeWrite`, query dùng scope từ `authority.QueryContext`. Không chạy database trực tiếp trong controller/http_port.
- `authority.Scope.Args` (`authorization/authority/scope_args.go`) ghép parameter từ plan trước input; SQL cần AND scope trên employee/company trước count/page. `authority.Execute` khóa target `FOR NO KEY UPDATE OF r` (`sql_gateway.go:72`) và làm plan/fresh/audit transaction; không tự tạo runner mới.
- `httpapi.InputUUID`, `InputText`, `InputPageQuery`, `InputQuery`; `hrbase.ParseIdempotencyKey`; `attendancecore.ParseMonth` có grammar YYYY-MM, năm 1900..2100. `InputQuery` nhận tập key bắt buộc; month tùy chọn cần nhánh empty query như `leave.parseBalanceQuery`, vẫn từ chối syntax/key lặp/key lạ.
- `leave.wholeNumber` là mẫu số JSON nguyên signed theo grammar, không nhận số dạng `1.0`, `1e0`, string/null; không import module leave, giữ validator nhỏ trong attendance như DAG hiện tại. `httpapi.InputText` giữ trim JS/code point/NUL semantics. Reference không trim: regex Unicode letter/number đầu, sau đó letter/number/space/`._/#:-`, tối đa 64; reason 1..300. Explicit reference null phải bị từ chối như TS, omitted thành null trong hash: `*string` đơn lẻ không phân biệt được hai trạng thái, dùng presence wrapper hiện có pattern hoặc raw typed value.

### Core facts và snapshot đã có, không cần port lại

`internal/modules/attendancecore/attendance_facts_repository.go`:

- `LoadFacts(tx, month, ids)` đọc **đúng ids**, nil/rỗng đọc không ai; một SQL snapshot cho lịch/khung giờ/approved effect/adjustment/employment/period state. Không được dùng nil để close.
- `LoadAllFacts(tx, month)` mới là đọc mọi employee có employment overlap tháng, order employee id, set-based. Đây là đường close.
- `AssertPeriodsOpen(tx, dates)` dedupe/sort month, upsert missing period rồi FOR SHARE và từ chối closed. Upsert cần thiết để khóa cả tháng chưa có row. Caller chịu thứ tự khóa trước nó.
- `FactsRow` (`attendance_facts_helper.go`) có `ID/HiredOn/TerminatedOn/CalendarVersion/PeriodState/Holidays/MakeupDays/Frames/Effects/AdjustmentMinutes/Versions`; `TotalsOf(month,row) (Totals,error)` dùng đúng `MonthTotals`, không viết công thức khác. State nil ánh xạ open cho sheet.
- `AdjustmentMinutesSQL` export sẵn, dùng query list; helper `date` private nên format date SQL tại module như source, không cần export thêm wrapper.

`attendance_snapshot_helper.go`:

- `BuildSnapshot(month, calendarVersion, []SnapshotEmployee)` luôn format 2.
- `CanonicalSnapshot(s) ([]byte,error)` ghi đúng field order; `SnapshotHash(s)` hash canonical; `VerifiedSnapshot(month,storedBytes,hash)` parse + check month + hash, fail closed. Format 1 không có `formatVersion` trên wire, adjustment đọc bằng 0; format 2 có field đầu `formatVersion:2` và adjustment cuối mỗi employee.
- **Không marshal trực tiếp struct `Snapshot` để ghi jsonb:** exported field của nó không có JSON tags phục vụ persisted shape; lấy bytes từ `CanonicalSnapshot`, truyền `string(bytes)` vào SQL jsonb. Không truyền `[]byte` vì runner coi đó là bytea. SnapshotHash/canonical cùng API chứ không tự hash jsonb text.
- Test source `attendance_snapshot_helper_test.go` đã có vector canonical/hash TS format 1/2, jsonb reorder/480.0, negative signed, corruption/wrong month/format/missing totals; đây là bằng chứng source có test, chưa chạy trong nhiệm vụ chuẩn bị này.
- `attendance_facts_integration_test.go` và tracker M3 đã phủ oracle per-row/set-based/nil/empty/300 employees. Chưa thay thế route sheet thật hoặc close thật.

## Query và mutation còn phải viết

Nguồn `apps/api/src/modules/attendance/repositories/attendance-period.repository.ts`:

1. `attendancePeriod`: scope lookup employee + COALESCE month với `hrbase.BusinessToday`; không có row trả not found. Gọi `LoadFacts(tx,resolvedMonth,[]string{id})`, lấy `TotalsOf` và periodState. Sheet hiện hành vẫn là live facts kể cả period closed; **không tự đổi sheet sang snapshot**. Snapshot là contract của report.
2. `attendancePeriodState`: scope lookup `hr_company` với CompanyID; LEFT JOIN attendance_period, default open/version1; subquery event tối đa 50, version DESC, reason nullable, `occurredAt` UTC sáu chữ số microsecond. Không trả actor/snapshot/hash.
3. `lockPeriodForUpdate`: INSERT ON CONFLICT DO NOTHING `${month}-01`, SELECT state/version::text FOR UPDATE. Không thay FOR SHARE, không bỏ upsert.
4. `closePeriod`: sau khóa, state open; DB kiểm future theo BusinessToday; `LoadAllFacts` rồi TotalsOf từng employee; đọc calendar version riêng không khóa; canonical snapshot + hash; update state closed/version+1/snapshot/hash RETURNING version::text; append period_event(close,version,hash,actor); `c.Audit(audit.KindHRAttendancePeriodClose,companyTarget,nil)`; trả result. Toàn bộ atomic qua authority.
5. `reopenPeriod`: sau khóa, state closed; update open/version+1, snapshot/hash NULL; append event(reopen,version,reason,actor); audit KindHRAttendancePeriodReopen; giữ lịch sử, không sửa event cũ.

Nguồn `attendance-adjust.repository.ts`:

6. `adjustAttendance`: target employee đã khóa, query `account_id = c.Actor.ID` trước claim; tự điều chỉnh từ chối 403, không đốt key. Đọc claim `(actor,attendance.adjust,key)`, hash trùng replay/khác 422; recheck workDate trong hired..terminated inclusive; period guard; calendar FOR SHARE; LoadFacts đúng employee; TotalsOf.PaidMinutes + delta phải >=0; insert immutable attendance_adjustment; claim ON CONFLICT DO NOTHING RETURNING 1; không claim được thì 422 và rollback entry; audit KindHRAttendanceAdjust chỉ ids/kind, không date/minutes/reason/reference.
7. `attendanceAdjustments`: scope lookup employee trước count/page; query trả employeeId/month/periodState default open/signed month sum/total::text/items; thứ tự work_date DESC, created_at DESC, id DESC; limit/offset trước JSON aggregate, reason/reference chỉ ở response của permission riêng; không trả actor.

Hash dùng `encoding/json/v2` để tiếng Việt/emoji/dấu tổ hợp/`<>&`/U+2028/U+2029 hợp cùng claim NestJS còn lưu. Mẫu `leave_adjust_command.go` đã có canonical array bằng typed values, `hrbase.Claim` và `hrbase.Replay`. Attendance phải thêm null ở phần tử thứ năm nếu omitted reference. Sau `hrbase.Replay` thành công trả `authority.Replay(result)`; không bắt lỗi replay riêng như TS. `authority_operations.go:115` rollback savepoint và append Root access target; IAM rollback toàn tx/không audit thêm; audit lỗi thì không trả replay thành công. Kiểm quyền và self guard vẫn diễn ra trước replay.

Các audit kind và declaration/action/policy đã có: `internal/audit/event_kinds.go`, `event_validation.go`, `authorization/keys`, `declarations/resources_declarations.go` (`managePeriod` và `adjustAttendance` fresh, boundary optional). Không cần đổi release/schema/ACL để thêm route này theo source đã đọc.

## Thứ tự khóa phải giữ

Mọi hàng dưới bắt đầu bằng application fence do authority/runner quản lý. Không ghép thành một thứ tự toàn cục mới; ruling 89 chốt thứ tự riêng từng workflow.

| Lệnh                          | Thứ tự sau fence                                                                                   | Vì sao ảnh hưởng M6                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Close/reopen                  | company target NO KEY UPDATE → period upsert/FOR UPDATE → đọc facts/calendar không khóa            | Không lấy calendar hay employee sau period; khóa company chặn hire/termination thay employment giữa snapshot    |
| Attendance adjustment         | employee target → self/claim read → period FOR SHARE → calendar FOR SHARE → entry/claim/audit      | Cùng một employee serialize điều chỉnh âm; close chờ period và đọc đúng entry đã commit                         |
| Submit                        | employee target → claim read → periods FOR SHARE theo tháng → calendar FOR SHARE → inserts/effects | `work_request_submit_command.go:74`; không đảo calendar trước period                                            |
| Calendar/day/company schedule | calendar target → period FOR SHARE → changes                                                       | `work_calendar_command.go`, `work_schedule_command.go`; close không được khóa calendar để tránh vòng với submit |
| Employee frame                | employee target → period FOR SHARE → writes                                                        | `workschedule`; không đổi sang period trước employee                                                            |
| Decision                      | request target → claim read → leave bucket → WFH counter → period FOR SHARE → state/audit          | `workrequest`, ApprovedEffects theo thứ tự; không thêm employee/calendar lock                                   |
| Approved cancel               | request target → claim read → bucket hoặc counter tháng tăng → period FOR SHARE → state/audit      | `work_request_cancel_command.go`; đảo effect vẫn rollback khi period closed                                     |
| Hire                          | company target → đọc mọi closed month từ hired_on → insert employee                                | `employee_write_repository.go:61`; company anchor chung với close                                               |
| Termination                   | employee target → company FOR SHARE → đọc closed month từ terminated_on → write                    | Close không được quay lại lấy employee sau company                                                              |

`hrm-period-concurrency.integration-spec.ts:249` quan trọng hơn SQL giả đóng kỳ: tạo period row committed trước race; blocker giữ calendar FOR UPDATE; bắt đầu Go submit thật đến lúc chờ calendar; bắt đầu close thật đến lúc chờ period; bắt đầu calendar setDay thật (expectedVersion của calendar); nhả blocker; submit và close phải thành công, calendar có thể thành công hoặc 409 periodClosed; snapshot.calendarVersion phải bằng calendar.version cuối. Theo dõi wait graph/lock waits có deadline, không dựa vào Sleep. Không đổi thứ tự để làm test khác xanh. F-31 trong adjust suite `:646` cần cùng hình với adjustment thay submit.

## Snapshot và consumer report NestJS

`apps/api/src/modules/report/repositories/report-sheet.repository.ts` `loadSheetRows`:

- SQL `pairs` chọn employee theo scope trước count/page. Closed month lấy membership từ `snapshot.employees`, open month lấy employment overlap; thứ tự code,id,month. Snapshot toàn tháng được gửi sang service chỉ để verify; response không gửi toàn snapshot.
- `stored.closed` được map qua TS `verifiedSnapshot(month,snapshot,hash)` (`attendance-snapshot.helper.ts`) rồi employeeId lookup. Closed totals chỉ từ snapshot, không tính lại; thiếu employee trong snapshot fail closed. V1 được normalize adjustment 0, V2 giữ adjustment.
- Report HTTP và export vẫn M7/proxy. Test Go helper có vector TS không chứng minh được Go close → NestJS reader thực tế. Cần disposable mixed fixture: đóng kỳ bằng façade/HTTP Go thật, report NestJS trên cùng disposable DB qua route/proxy thật, kiểm rows/totals/phạm vi/count; có adjustment, employee ngoài scope, đổi trạng thái employment sau các kỳ khác, snapshot V1 lịch sử và V2 vừa đóng. Corrupt hash/month/totals phải fail closed; không log snapshot chứa tên hoặc reason.
- Existing `internal/app/run_integration_test.go` chỉ dựng HTTP upstream giả để readiness/boot; **không** là fixture report NestJS. Cần xây tối thiểu fixture mở actual NestJS upstream hoặc gọi reader NestJS thật với transaction trên disposable DB rồi thêm proxy HTTP kiểm route. Để hoàn thành chính xác checkbox “stack trộn”, nên có request qua stack Go+Nest thật, không ghi “mixed stack pass” chỉ từ helper import/node subprocess serialize.
- Không sửa nghiệp vụ NestJS; nếu schema/boot không tương thích phải báo trước. Không chuyển report sang Go trong M6 chỉ để tránh fixture.

## Phụ thuộc wiring / DAG / tests

- `internal/app/authority.go`: thêm attendance Operations trong modules/NewOperations, concat All vào authority.New, Bind và Register. `migrated_routes.go` chỉ gọi `mods.register` nên không cần thêm route riêng tại đó.
- `internal/httpapi/inventory.go`: thêm đủ sáu vào MigratedRoutes. Route contract/ownership M6 đã có trong `contract/routes.json` và `route-ownership.md`; chỉ đổi khi contract thật cần đổi, không “export” lại từ TS.
- `contract/package-dag.md:72` đã có attendance → apperror/audit/authority/enforcement/keys/config/database/httpapi/attendancecore/hrbase/permission; block mục 4 có cùng cạnh. Attendance không import workrequest/calendar/leave/report/schedulecore. Cross-module race dựng trong app integration hoặc external test package/composition đúng DAG; không chèn dependency nghiệp vụ vào attendance để test.
- Phần date validator có thể theo mẫu Go `time.Parse` + YYYY-MM-DD grammar nội bộ; không thêm schedulecore import chỉ để lấy ParseDate nếu không cần. Nếu có cạnh thật mới, sửa cả bảng và block máy đọc.
- `internal/app/m1_matrix_integration_test.go`: checker dùng chung và guard đủ ô; thêm `m6_matrix_integration_test.go` sáu route, snapshot state checker gồm period/event/adjustment/claim/audit; missing CSRF/fresh/Origin và rollback cần không có write.
- `internal/app/app_test.go`: proxy inventory derives migrated membership; đọc test cụ thể trước sửa expected. `auth_routes_integration_test.go` validBodies/validKeys chỉ bắt route Authenticated; M6 classification Authorize vẫn phải cập nhật fixture CSRF/body phù hợp chỗ checker yêu cầu, không đổi thành Authenticated để né guard.
- `test/imports_test.go`, conventions, golangci giữ controller không driver/authority; không tạo wrapper/port cho repository, không đưa business fields vào audit.

## Tracker còn thiếu (ảnh chụp lúc đọc)

Tracker `apps/api-go/contract/test-port-tracker.md`:

- :38 `hrm-attendance-adjust.integration-spec.ts` trống: gồm single/list/fresh/self/replay/closed/employment/negative/snapshot/report/audit rollback/append-only/one-key race/last-minutes/close race/3-way race.
- :40 concurrency `:301/:344` close đua final approval/calendar còn M6; :42 effects-equivalence `:235` sheet qua facts oracle còn M6; :43 `:310/:333/:388` report/XLSX/close/quy mô gắn M6,M7, cần chia đúng ca, không tick whole row khi chỉ close xong.
- :46 helper attendance, :47 attendance integration, :49 parser tháng/query/reopen/adjustment còn M6. Core calculations ở :48 và facts oracle :41 đã ghi M3, không port lại.
- :62 cancel-concurrency `:144` cancel-close, :64 cancel `:213/:232` sheet và `:253` reopen, :66 COO `:55` sheet/`:153` reopen rồi approve có thể hoàn tất sau M6. Implementer13d đang rà tracker M5 nên cần phối hợp ownership tránh ghi đè.
- :84 period-concurrency toàn file và :85 ca :249 còn M6; phải gồm hire-close, termination-close, submit-close, kỳ closed/reopened. Chỉ lock-order M4 và SQL giả closed trước đây chưa đủ.
- Cần thêm cạnh tranh close/close và reopen/reopen/close-reopen thật; version/event/hash đúng một transition, history immutable. Brief còn yêu cầu WFH **và annual leave** approval-close/cancel-close để kiểm counter/debit/bucket reversal không lọt snapshot; TS ca close approval chủ yếu WFH không nên suy ra đã kiểm leave.

## Đề xuất các lát tuần tự để review/commit

Đây là đề xuất chia việc; không tự commit, không giảm yêu cầu cuối Task14 và chưa có implementation/test evidence.

1. **14a – contract types, validators, hash:** thêm attendance package typed inputs/views, validator cho month/query/close/reopen/adjustment và canonical adjustment hash; RED/GREEN table cho unknown/duplicate/null/type/date/±1440/zero/reference/reason/page; vector thứ năm hash Việt/emoji/composed/`<>&`/null. Chưa route cutover; package không gây behavioral change. Reviewer có thể duyệt riêng shape/grammar.
2. **14b – six bound operations + module integration:** query sheet/state/list và close/reopen/adjust command, dùng core hiện có; tests PostgreSQL cho authorization scope, immutable history/version/snapshot/hash, self guard, employment/negative bound, claim race/replay/Root audit/audit rollback. Module Operations được review độc lập, route vẫn proxy tới khi nhóm sáu sẵn sàng.
3. **14c – atomic route cutover + HTTP matrix:** controller/http_port, app composition, six MigratedRoutes và inventory fixtures/DAG nếu cần, ma trận sáu route + browser. Chuyển cả nhóm sáu, không để close Go mà sheet/reopen chưa có mà thiếu matrix. So contract web; không sửa UI nếu không cần.
4. **14d – cross-module concurrency + snapshot mixed reader:** đầy đủ period :249 và adjustment :646, cancel/approval (WFH+leave)-close, employee hire/termination-close, same-transition race, reopened retry, mixed Go close/Nest report; overlay mutants thực sự RED hành vi cho guard/effect/hash/scope/CSRF/fresh/hash replay/lock-order. Hoàn tất tracker M6/CROSS từng ca đã kiểm.
5. **14e – review and evidence gate:** full checks theo brief tuần tự sau waitload, báo mọi fail/timeout/skip riêng, viết task-14-report và sửa plan bằng evidence nhưng không tự tick; rà diff/DAG/files/PII. Nếu 14c cần tránh đưa cutover trước 14d chứng minh lock/mixed reader, giữ chúng trên cùng nhánh chưa merge, review theo commit riêng rồi tích hợp khi 14d/e xong.

Các lát 14a/b/c có thể review riêng, nhưng **không gọi M6 hoàn tất trước 14d/e**. Chưa đủ bằng chứng để cho phép release/cutover chỉ nhờ unit/helper pass.

## Kiểm tra của nhiệm vụ chuẩn bị này

Đã chạy `pwd`, `git status --short`, `git branch --show-current`, `git rev-parse --short HEAD`, cùng rg/cat/sed và Python chỉ đọc JSON contract để trích requestBody. Không chạy test/build/vet/browser/Docker/database; không đọc seed/env/secret/data thật; không sửa/stage/commit file repo. File duy nhất được tạo là bản đồ này dưới `/private/tmp` bằng apply_patch.

Rủi ro chưa kiểm chứng: trạng thái runtime/schema privilege với operations M6, PostgreSQL wait graph thật, reader report NestJS trên snapshot Go vừa ghi, và final tracker sau sửa của implementer13d. Đây là phần triển khai/verification tiếp theo, không phải lỗi đã tái hiện.
