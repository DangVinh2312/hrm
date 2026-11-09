# Báo cáo Task 12 — M4 `work-calendar` + `work-schedule`

Trạng thái: DONE_WITH_CONCERNS — 10 route M4 phục vụ tại Go, mọi check yêu cầu đã chạy (kết quả bên dưới). Review độc lập chưa chạy, chưa commit, không push. Không đổi NestJS, web, schema, ACL, declarations quyền, mã lỗi hay dependency.

## Thay đổi

| File | Nội dung |
| --- | --- |
| `internal/modules/workcalendar/work_calendar_types.go` | `DayInput` (có `IsMakeup` để phân biệt `holiday:null` với `makeup:null`), `HolidaysInput`, `YearView`, `VersionResult` |
| `internal/modules/workcalendar/work_calendar_validator.go` | `parseYear` (`?year=` đúng một key, 4 chữ số ASCII, 1900–2100), `parseDay` (đúng một trong `holiday`/`makeup`, `null` là xóa), `parseHolidays` (from ≤ to, ≤ 31 ngày, tên 1–200 code point); `present[T]` truyền lại `RejectUnknownMembers` cho object lồng; `wholeNumber` đọc `asWeekday` theo grammar số nguyên |
| `internal/modules/workcalendar/work_calendar_repository.go` | SQL chép nguyên văn từ `work-calendar.service.ts`: version lịch công ty trong khoảng, ngày hiện tại, ghi một ngày, ghi khoảng ngày lễ (mỗi ngày một version liên tiếp) |
| `internal/modules/workcalendar/work_calendar_command.go` | `runSetDay`, `runSetHolidays`: kiểm ngày làm bù với lịch công ty (400), `AssertPeriodsOpen` (409 `error.periodClosed`) sau khóa dòng lịch, version lạc hậu và không đổi là 409 `error.conflict`, audit `hr.work-calendar.update` trong cùng transaction |
| `internal/modules/workcalendar/work_calendar_read_repository.go` | `readYear` nhúng scope SQL vào câu đọc, không thấy anchor thì `Found=false` |
| `internal/modules/workcalendar/work_calendar_service.go`, `_http_port.go`, `_controller.go` | `Operations{}.Bind` facade, `HTTPPort`, `Routes.Register` (3 route) |
| `internal/modules/workschedule/work_schedule_types.go`, `_validator.go` | View và input; `minute` (0–1440, grammar số nguyên), `shiftBody`/`frameBody`/`weekBody` từ chối `null` và sai độ dài; `parseCompanySchedule`, `parseEmployeeFrame` (`validTo` bắt buộc có mặt, có thể `null`), `parseFrameKey`, `parseScheduleQuery` (`?from&to`, ≤ 92 ngày) |
| `internal/modules/workschedule/work_schedule_repository.go` | `insertShifts` (hai câu hằng theo bảng, không ghép tên bảng từ tham số), `checkWeek` (theo `hr.workdayMaxMinutes` qua `settingcore.Read`), `checkMakeupDays` (409 khi version mới làm hỏng ngày làm bù về sau) |
| `internal/modules/workschedule/work_schedule_command.go` | Đặt/xóa version lịch công ty (ngày sau hôm nay, không đổi là 409, không có version là 409) |
| `internal/modules/workschedule/employee_frame_command.go` | Thêm khung (không thêm ngày làm, chồng là 409) và kết thúc khung (chưa bắt đầu thì xóa, đang chạy thì kết thúc hôm nay, khung của nhân viên khác cùng 409 với khung đã mất) |
| `internal/modules/workschedule/work_schedule_read_repository.go` | Lịch công ty, khung của nhân viên, giờ từng ngày (`schedulecore.EmployeeSchedule` + `FrameOn`); scope kiểm trước khi đọc lịch nhân viên |
| `internal/modules/workschedule/work_schedule_service.go`, `_http_port.go`, `_controller.go`, `_id_helper.go` | Facade, port, 7 route, UUID v4 |
| `internal/httpapi/page_query.go` | `InputQuery(raw, keys...)`: đúng tập key, mỗi key một lần (sau giải mã %), từ chối key lạ; `InputPageQuery` không đổi |
| `internal/httpapi/inventory.go` | 10 route M4 vào `MigratedRoutes` |
| `internal/app/authority.go`, `app.go` | `newModules(runner)` dựng operations team/employee/workcalendar/workschedule và authority một chỗ; `application.modules` thay ba field cũ; `modules.register` thêm hai `Routes` |
| `internal/app/m4_matrix_integration_test.go` | Ma trận ADR-20 §4 cho 10 route, guard `TestM4RoutesAreMigrated` |
| `internal/app/m1_matrix_integration_test.go` | Guard chung ghép thêm `m4Matrix`; state trước/sau của mọi ô từ chối thêm `m4State` |
| `internal/app/m2_matrix_integration_test.go` | Guard M2 bỏ qua route M4 dưới `/api/hr/employees` |
| Test mới | `work_calendar_validator_test.go`, `work_calendar_integration_test.go`, `work_schedule_validator_test.go`, `work_schedule_integration_test.go`, `internal/httpapi/input_test.go` (`TestInputQueryNeedsExactlyTheNamedKeysOnce`) |
| Tài liệu | `contract/test-port-tracker.md`, `apps/api-go/AGENTS.md` (dòng module M4, thứ tự khóa, `InputQuery`, bẫy JSON v2), plan Task 12 (ghi chú, không tick) |

API M3 không đổi. DAG không thêm cạnh: import thật của hai package nằm trong khối mục 4 đã khai sẵn (`go test ./test` GREEN), nên `package-dag.md` không sửa.

## Route

| Method | Path | Classification | Thành công |
| --- | --- | --- | --- |
| GET | `/api/hr/work-calendar` | `workCalendar.read` | 200 `{version,year,holidays,makeupDays}` |
| PUT | `/api/hr/work-calendar/holidays` | `workCalendar.manage` (fresh@1) | 200 `{version}` |
| PUT | `/api/hr/work-calendar/days/:date` | `workCalendar.manage` (fresh@1) | 200 `{version}` |
| GET | `/api/hr/work-calendar/schedule` | `workCalendar.read` | 200 `{today,maxMinutes,versions}` |
| PUT | `/api/hr/work-calendar/schedule/:effectiveFrom` | `workCalendar.manageSchedule` (fresh@1) | 200 `{effectiveFrom}` |
| DELETE | `/api/hr/work-calendar/schedule/:effectiveFrom` | `workCalendar.manageSchedule` (fresh@1) | 200 `{effectiveFrom}` |
| GET | `/api/hr/employees/:id/schedule-frames` | `employee.readSchedule` | 200 `{today,maxMinutes,frames}` |
| POST | `/api/hr/employees/:id/schedule-frames` | `employee.manageSchedule` (fresh@1) | 201 `{id}` |
| DELETE | `/api/hr/employees/:id/schedule-frames/:frameId` | `employee.manageSchedule` (fresh@1) | 200 `{id}` |
| GET | `/api/hr/employees/:id/schedule` | `employee.readSchedule` | 200 `{employeeId,days}` |

Mutation có body đi qua `httpapi.DecodeCommand` (CSRF trước body); hai DELETE gọi `EnforceCSRF` trước khi đọc path. `TestEveryMigratedWriteRefusesAMissingCSRF` (unit, duyệt `MigratedRoutes`) bao cả 6 route ghi mới.

## Ma trận HTTP (`TestTheM4RoutesAnswerEveryCellOfTheMatrix`)

Mọi route: signed out, expired, suspended → 401; granted (`hr` fresh) và Root fresh → status/shape của contract, write có đúng một audit của actor, read của Root có audit `access.*`. Mọi ô từ chối kiểm state M1+M2+M4 (lịch, change, version công ty, ca, khung, kỳ công, audit) không đổi. Không route nào nhận Idempotency-Key (NA).

| Route | Không grant / deny | Boundary / fresh | CSRF / Origin | Foreign / absent | Invalid / extra |
| --- | --- | --- | --- | --- | --- |
| GET work-calendar | 404 / 404 | NA / NA | NA | NA (anchor đơn) / NA | 400 (5 query) / NA |
| PUT holidays | 403 / 403 | NA / 403 | 403 / 403 | NA / NA | 400 (6) / 400 |
| PUT days/:date | 403 / 403 | NA / 403 | 403 / 403 | NA / NA | 400 (7, gồm makeup trên ngày làm) / 400 |
| GET schedule | 404 / 404 | NA / NA | NA | NA / NA | NA (không đọc tham số) |
| PUT schedule/:effectiveFrom | 403 / 403 | NA / 403 | 403 / 403 | NA / NA | 400 (7, gồm ngày quá khứ, 9 giờ/ngày, tuần rỗng) / 400 |
| DELETE schedule/:effectiveFrom | 403 / 403 | NA / 403 | 403 / 403 | NA / 409 (không có version) | 400 (2) / NA |
| GET schedule-frames | 404 / 404 | NA / NA | NA | 404 / 404 | 400 (2) / NA |
| POST schedule-frames | 404 / 404 | NA / 403 | 403 / 403 | 404 / 404 | 400 (7) / 400 |
| DELETE schedule-frames/:frameId | 404 / 404 | NA / 403 | 403 / 403 | 404 / 404; khung vắng 409 | 400 (2) / NA |
| GET schedule | 404 / 404 | NA / NA | NA | 404 / 404 | 400 (6) / NA |

Route employee có foreign khác NA nên checker còn chạy thêm absent target với actor scoped/none/denied/stale: cùng câu trả lời, không phân biệt tồn tại. Boundary NA vì bốn permission là `boundary: 'optional'`, ngoài gói `hrAdministration`.

## Lệnh và kết quả (từ `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng sau `waitload.sh`, load 1.4–3.8)

| Lệnh | Exit | Thời gian | Kết quả |
| --- | --- | --- | --- |
| `go test -count=1 -run InputQuery ./internal/httpapi` (trước khi viết hàm) | 1 | — | RED: `undefined: httpapi.InputQuery` |
| `go test -count=1 ./internal/modules/workcalendar` (trước khi viết validator) | 1 | — | RED: `undefined: MakeupHours`… |
| `go test -count=1 ./internal/modules/workschedule` (trước khi viết validator) | 1 | — | RED: `undefined: EmployeeFrameInput`… |
| `go build ./...` | 0 | 2 s | |
| `go vet ./...` | 0 | 1 s | |
| `go vet -tags integration ./...` | 0 | <1 s | |
| `go test -race -count=1 ./internal/...` | 0 | 14 s | 30 package ok |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/workcalendar ./internal/modules/workschedule ./internal/app` | 0 | 44 s | workcalendar 7.110s, workschedule 6.321s, app 25.445s |
| `go tool golangci-lint run` | 0 | 2 s | 0 issues (lượt đầu 35 issue, đều ở test mới: contextcheck do `ctx` ngoài subtest, errcheck, De Morgan; đã sửa) |
| `go test -count=1 ./test` | 0 | 6 s | ok 4.425s |
| `gofmt -l .` | — | — | rỗng |
| `git diff --check` (root) | 0 | — | sạch |
| `pnpm test:browser` (root, tự build api-go) | 0 | 179 s | 30 passed (2.9m), 0 failed, 0 skipped; gồm `work-calendar.e2e-spec.ts` (2 test) và `employee.e2e-spec.ts` |

Integration được viết sau implementation, nên bằng chứng độ nhạy của chúng là đột biến bên dưới, không phải RED trước. Lượt chạy đầu của ma trận đỏ do lỗi của chính test (thiếu ô invalid, sai chỉ số segment, UUID hoa không có chữ, khoảng ngày trùng ngày lễ của dòng khác), đã sửa test; code không đổi.

## Đột biến (`go test -overlay`, bản sao ở `/private/tmp/hrm-12-mutants/`)

| # | Đột biến | Lệnh | Kết quả | Thời gian |
| --- | --- | --- | --- | --- |
| M1 | Bỏ `AssertPeriodsOpen` trong `runSetDay` | `go test -tags integration -count=1 -overlay m1_command.json -run TestTheCalendarOnPostgreSQL ./internal/modules/workcalendar` | RED: "the change did not wait for the close" và ca tháng đã chốt | 19:39:26–19:39:38 |
| M2 | Bỏ `EnforceCSRF` ở DELETE lịch công ty | `go test -count=1 -overlay m2_controller.json -run TestEveryMigratedWriteRefusesAMissingCSRF ./internal/app` | RED: 400 thay vì 403 khi không Origin/khác Origin | 19:39:38–19:39:40 |
| M3 | Scope đọc khung thành `(<scope> OR true)` | `-overlay m3_read.json -run TestWorkingHoursOnPostgreSQL ./internal/modules/workschedule`; cùng overlay `-run TestTheM4RoutesAnswerEveryCellOfTheMatrix ./internal/app` | RED cả hai: O đọc được khung; ô no grant/deny/foreign trả 200 | 19:39:49–19:40:04 |
| M4 | Validator phút nhận tới 1445 | `go test -count=1 -overlay m4_validator.json ./internal/modules/workschedule` | RED: "over the day accepted" | 19:39:40–19:39:41 |
| M5 | Bỏ kiểm khung chồng | `-overlay m5_frame.json -run TestWorkingHoursOnPostgreSQL ./internal/modules/workschedule` | RED: overlap nhận, giờ từng ngày sai | 19:40:04–19:40:12 |
| M6 | `present.UnmarshalJSON` bỏ `RejectUnknownMembers` | `go test -count=1 -overlay m6_validator.json ./internal/modules/workcalendar` | RED: "makeup extra member accepted" | 19:42:16–19:42:19 |
| M7 | `decodeList` bỏ từ chối `null` | `go test -count=1 -overlay m7_validator.json ./internal/modules/workschedule` | RED: "null frame accepted" | 19:43:11–19:43:15 |

GREEN sau đột biến: các lượt không overlay trong bảng lệnh ở trên (chạy sau M1–M5) đều exit 0; M6, M7 chỉ đọc overlay, source repo không đổi.

## Khác với TypeScript

- Số trong body (`asWeekday`, phút) đọc theo grammar số nguyên: `540.0`, `5.4e2` là 400; TS nhận vì `Number.isInteger(540.0)`. Cùng cách với setting/employee. Web gửi số nguyên.
- `?year`, `?from&to` qua `httpapi.InputQuery`: key lặp hoặc key lạ (gồm `limit`) là 400 như `inputBody` của TS; `?year` không có `=` là chuỗi rỗng rồi 400 ở validator, như Express.
- `GET /api/hr/work-calendar/schedule` bỏ qua query như TS (không đọc tham số).
- Ngày làm bù sai lịch công ty khi đổi lịch là 409 `error.conflict` (`ProductCommandRejected('makeup_day')` ở TS), không dùng `error.makeupDay` (422, dành cho đơn). Không thêm mã lỗi.
- Test: chốt kỳ dựng bằng SQL (route chốt kỳ ở M6). Ca tháng đã chốt của lịch làm việc chạy mọi ngày (chốt tháng của ngày mai), TS bỏ qua vào ngày cuối tháng; thêm DELETE version và kết thúc khung.

## Rủi ro và câu hỏi mở

- Review độc lập: xem mục "Review độc lập và sửa".
- `hrm-period-concurrency` :249 (submit + đổi lịch + chốt kỳ không deadlock) để M5/M6 theo ruling 82; M4 chỉ ghim nhánh lịch–chốt kỳ.
- `hrm-work-schedule-upgrade` :12 (provision lại database dựng trước migration 7) ghi nhóm C1, trạng thái trống: chưa có test nâng cấp Go từ database trước `1792108800007`. Người dùng có thể chốt `bỏ` vì migration trước release được sửa và dựng lại (ADR-14/ADR-22); tôi không tự chọn.
- Root đổi lịch cần fresh (`fresh@1` của policy), như TS.

## Review độc lập và sửa

Reviewer độc lập (chỉ đọc code) không thấy lỗi chặn. Các finding được giao sửa, theo đúng nội dung agent chính chuyển lại; danh sách nit chi tiết của reviewer không được chuyển cho agent sửa, nên ở đây không liệt kê lại:

1. Ô `foreign` của `POST /api/hr/employees/:id/schedule-frames` và `DELETE …/schedule-frames/:frameId` gửi `scoped`, nhưng `scoped` không có grant `employee.manageSchedule` nào, nên ô này chỉ lặp lại ô no grant. **Đã sửa**: cặp `(employee.manageSchedule, selfEmployee)` hợp lệ (template `selfEmployee` khai trên resource `employee` ở `templates_declarations.go`, action `manageSchedule` cùng resource, policy `fresh@1`, boundary `optional`), nên `newM4World` thêm rule allow `selfEmployee` cho `scoped`. Ô foreign giờ chứng minh grant có scope không ghi được khung của nhân viên khác (404, state và audit không đổi, kiểm bởi `w.check`). Test mới `TestM4ScopedGrantsReachOnlyTheirOwnEmployee`: `scoped` POST khung trên nhân viên của mình 201 kèm một audit `hr.employee-schedule.update`, DELETE khung đó 200 kèm audit. Route đọc: ô foreign không có cùng điểm yếu, vì `scoped` có role `hr.employee`, được grant mặc định `employee.readSchedule` qua `selfEmployee` (`product_declarations.go`); test mới cũng kiểm `scoped` GET `schedule-frames` và `schedule` của chính mình 200, nên 404 ở ô foreign là do scope chứ không do thiếu grant.
2. DELETE khung: chưa có ô `frameId` thuộc nhân viên khác. **Đã sửa**: `TestM4FrameOfAnotherEmployeeIsNoFrame`, khung của nhân viên A gửi qua đường dẫn của nhân viên B (`hr`, quyền toàn bộ) và qua nhân viên của chính `scoped`: cả hai là 409 `error.conflict` như khung vắng mặt, `m4State` (gồm khung, ca, audit) không đổi.
3. `TestM4RoutesAreMigrated` đếm route bằng `strings.Contains(path, "/schedule")`. **Đã sửa**: danh sách tường minh `m4Routes` (10 route); mỗi route phải có trong `MigratedRoutes` và `m4Matrix`, số dòng ma trận bằng độ dài danh sách. Route authorize đã phục vụ mà thiếu ma trận vẫn bị `TestEveryMigratedAuthorizeRouteHasAFullMatrix` bắt.
4. Kiểm `DatesBetween` lần hai trong `readEmployeeDays` (`work_schedule_read_repository.go`). **Giữ nguyên**: không phải code chết. `Service.EmployeeDays` export và nhận `ScheduleQuery` do caller dựng (integration `work_schedule_integration_test.go` gọi thẳng, không qua `parseScheduleQuery`); bỏ kiểm này thì khoảng sai từ caller không qua HTTP thành 200 với `days` rỗng thay vì `ErrInvalidRequest`.

Để sau: test concurrency cho thứ tự khóa của lệnh lịch (khóa `work_calendar`/`employee` rồi `AssertPeriodsOpen` FOR SHARE) chuyển sang M5/M6 cùng `hrm-period-concurrency`, khi có submit và chốt kỳ.

### RED/GREEN

Đột biến ở `/private/tmp/hrm-12r-mutants/` (overlay `overlay.json`): `selectFrameEnd` bỏ lọc `employee_id = $1` (thay bằng `$1::uuid IS NOT NULL`), và `newM4World` đổi grant của `scoped` thành `allEmployees`.

| Lượt | Lệnh (từ `apps/api-go`) | Kết quả | Thời gian |
| --- | --- | --- | --- |
| RED | `go test -tags integration -count=1 -overlay /private/tmp/hrm-12r-mutants/overlay.json -run 'TestM4FrameOfAnotherEmployeeIsNoFrame\|TestTheM4RoutesAnswerEveryCellOfTheMatrix/(POST\|DELETE)_/api/hr/employees' ./internal/app` | FAIL: ô foreign POST 201, DELETE 200 và state đổi; `hr` xóa được khung của nhân viên khác (200, state đổi) | 19:54:33–19:54:43 |
| GREEN | `go test -tags integration -count=1 -v -run 'TestM4\|TestTheM4RoutesAnswerEveryCellOfTheMatrix' ./internal/app` | PASS (9.461s), gồm 10 subtest ma trận và hai test mới | 19:55:03–19:55:13 |

### Check chạy lại (GOCACHE=/private/tmp/hrm-go-cache, tuần tự)

- `go build ./...`, `go vet ./...`, `go vet -tags integration ./...`: exit 0.
- `go test -race -count=1 ./internal/...`: exit 0 (19:55:26–19:55:40).
- `go test -race -tags integration -count=1 -p 1 ./internal/modules/workschedule ./internal/app`: ok 7.850s / 31.453s (19:55:44–19:56:28).
- `go tool golangci-lint run`: 0 issues. `go test -count=1 ./test`: ok 4.764s. `gofmt -l .`: rỗng. `git diff --check` (root): sạch; file test M4 chỉ ASCII.


Nit của reviewer (agent chính ghi bổ sung, không sửa ở M4): `present[T]`/`parseDate` lặp ở hai package và `newUUID` là bản sao thứ ba (team, employee); `BusinessToday` dùng `statement_timestamp()` nên mỗi câu SQL tính lại "hôm nay" (kế thừa TS); lệnh thêm khung đọc ngày làm của công ty không khóa lịch, không ảnh hưởng giờ tính ra vì `FrameOn` bỏ giờ riêng vào ngày công ty nghỉ; Go từ chối `540.0`/`1e0` (web luôn gửi số nguyên). Câu hỏi mở cho người dùng: dòng tracker `hrm-work-schedule-upgrade` :12 có chốt `bỏ` không.
