# Báo cáo Task 14c — sáu route M6 attendance, ghép app, ma trận HTTP và browser

Trạng thái: XONG, review độc lập Approved (0 Critical/Important, xem mục Review cuối báo cáo). Base `c970488`, commit chứa báo cáo này; không push. Phạm vi đúng lát 14c: không làm concurrency chéo module, không làm mixed stack Go close → NestJS report (14d).

## Thay đổi

- `apps/api-go/internal/modules/attendance/attendance_http_port.go` (mới): `HTTPPort` gồm sáu method của façade `Service` đã bind (14b); handler chỉ nhận interface này.
- `apps/api-go/internal/modules/attendance/attendance_controller.go` (mới): `Routes{Attendance, Origin}.Register`, sáu route `authorize` đúng `routes.json`/`route-ownership.md`:
  - GET `employees/:id/attendance` (`employee.readAttendance`), GET `attendance/periods/:month` (`hrCompany.read`), GET `employees/:id/attendance-adjustments` (`employee.readAttendanceAdjustment`): session, parse, façade; found=false là 404.
  - POST `periods/:month/close`: `httpapi.DecodeEmptyCommand` (CSRF/Origin trước, rồi không body hoặc `{}`), parse tháng, session, `ClosePeriod`; 200.
  - POST `periods/:month/reopen`: `httpapi.DecodeCommand[reopenBody]` (đúng `{reason}`), `parseReopen`; 200.
  - POST `employees/:id/attendance-adjustments`: `DecodeCommand[adjustmentBody]`, `parseAdjustment` với `Idempotency-Key`; 201 `{id}`.
  - Không thêm mã lỗi; lỗi đi qua `httpapi.WriteError` (`{statusCode,code}`).
- `apps/api-go/internal/app/authority.go`: thêm `attendance *attendance.Operations` vào `modules`, `NewOperations`, `All()` vào `authority.New`, `Routes{...Bind(...)}.Register`.
- `apps/api-go/internal/httpapi/inventory.go`: thêm sáu route vào `MigratedRoutes`.
- `apps/api-go/internal/app/m6_matrix_integration_test.go` (mới): ma trận sáu route, guard danh sách tường minh, scoped, chuyển trạng thái qua HTTP (gồm Root close/reopen audit target, Minor M3 của 14b) và audit rollback.
- `apps/api-go/internal/app/m1_matrix_integration_test.go`: `w.state` thêm `m6State` (kỳ count:sum(version):closed, event, adjustment, `hr_idempotency`); guard tổng `TestEveryMigratedAuthorizeRouteHasAFullMatrix` thêm `m6Matrix`. Không đổi checker.
- `apps/api-go/internal/app/m2_matrix_integration_test.go`: guard đếm route `/api/hr/employees*` của M2 bỏ qua route có `m6Matrix` (như đã bỏ M4/M5a); thiếu sửa này `TestM2RoutesAreMigrated` đỏ "17 M2 routes, want 14".
- `apps/api-go/internal/modules/attendance/attendance_integration_test.go`: Minor M2 của 14b, `waitBlocked` chờ tới 3 s (deadline transaction cứng `maxDeadline` của runner) thay 900 ms.
- `apps/api-go/contract/test-port-tracker.md`: bốn dòng M6 đã port (`hrm-attendance-adjust` F-xx, `hrm-attendance.integration-spec` :104/:113/:408/:511, :280 close/reopen, `hrm-attendance.spec` parser) nay trỏ thêm ma trận HTTP; không đổi trạng thái dòng trống.
- `apps/api-go/AGENTS.md`: thêm `internal/modules/attendance` (M6) vào danh sách package; đoạn M6 mô tả route/ghép/ma trận, và bẫy: ô `extra` của route body rỗng phải dùng ``m1Body(`{"extra":1}`)`` vì `m1Extra` trên `{}` cho JSON hỏng.

Không đổi: schema, ACL, identity, declarations, mã lỗi, `routes.json`, OpenAPI (đã có sáu path đúng status, `Idempotency-Key` ở POST adjustments, đối chiếu bằng đọc JSON), DAG (`app → m/attendance` và cạnh của `attendance` tới `httpapi`, `enforcement`, `keys`, `apperror` đã có trong bảng và khối máy đọc), NestJS, web, progress/handoff/plan.

## Ma trận (ADR-20 §4)

Tái dùng `m1Row`/`m1Cells`/`checkMatrixRow`/`w.check`/`checkIdempotency`; không viết checker mới.

| Route           | Ô chính                                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET sheet       | `m4EmployeeRead`: no grant/deny/foreign/absent 404; invalid 400 (id, tháng 13, 1899, `2031-3`, lặp, `limit`, key lạ); Root `access.employee.readAttendance`                                                                                                                                                     |
| GET period      | no grant/deny 404; foreign/absent N/A (neo công ty; tháng không phải record); invalid 400; Root `access.hrCompany.read`                                                                                                                                                                                         |
| POST close      | no grant/deny/fresh 403; CSRF/Origin 403; invalid 400 (`[]`, `{`, `null`, `{"expectedVersion":"1"}`, member lặp, tháng sai); extra `{"extra":1}` 400; audit `hr.attendance-period.close` (HR và Root)                                                                                                           |
| POST reopen     | như close; invalid gồm thiếu/space/null/số/1001 ký tự/lặp reason; audit `hr.attendance-period.reopen`                                                                                                                                                                                                           |
| GET adjustments | `m4EmployeeRead`; invalid gồm thiếu `month`, `limit=101`, lặp, key lạ; Root `access.employee.readAttendanceAdjustment`                                                                                                                                                                                          |
| POST adjust     | `m4EmployeeWrite`: no grant/deny/foreign/absent 404, fresh 403, CSRF/Origin 403; invalid 400 (0, 1441, `60.0`, `"60"`, ngày 2031-02-30, reason trắng, reference null hoặc có space đầu, thiếu reason); extra 400; idempotency: replay cùng body, reuse 422 `error.idempotencyKeyReused`, thiếu/sai/lặp khóa 400 |

Mọi ô từ chối so state (gồm `m6State`) trước/sau. `denied` có deny trên toàn scope của cả năm permission M6; `scoped` (hr.employee) có allow `selfEmployee` cho `readAttendanceAdjustment`, `adjustAttendance`.

Test bổ sung:

- `TestEveryM6RouteIsMigratedWithAFullMatrix`: `m6Routes` tường minh (6), mỗi route phải trong `MigratedRoutes` và có hàng; không ghim tổng `MigratedRoutes`.
- `TestM6ScopedGrantsReachOnlyTheirOwnEmployee`: scoped đọc bảng công/danh sách của mình 200, tự điều chỉnh 403 không ghi, đọc nhân viên khác 404.
- `TestM6PeriodTransitionsOverHTTP`: POST close không body 200 v2; close lại (HR, Root) 409 không ghi; điều chỉnh tháng đã chốt 409 `error.periodClosed` không ghi; reopen 200 v3, reopen lại 409; lịch sử qua GET (reopen có reason, close reason null); tháng tương lai 409; Root close/reopen mỗi lệnh đúng một audit `resource=hrCompany`, `key=permission.CompanyID`, `object_id` có, `reason` NULL, metadata không chứa lý do; trigger làm audit lỗi → close và điều chỉnh 503 `error.unavailable`, state không đổi.

## RED/GREEN

- RED (trước khi ghép, controller chưa đăng ký): `go test -tags integration -count=1 -p 1 ./internal/app -run 'M6|TestEveryMigratedAuthorizeRouteHasAFullMatrix'` exit 1, 9.787s; năm test FAIL: guard tổng "a matrix for a route not served as authorize" ×6, guard M6 "M6 route is not migrated" ×6, ma trận/scoped/transition (route còn proxy tới upstream giả). Log `/private/tmp/hrm-14c-red.log`. Đây là RED hành vi, không phải lỗi biên dịch (`go vet -tags integration` exit 0 trước đó).
- GREEN: cùng lệnh exit 0, 10.015s (`hrm-14c-green-r1.log`); `-v` liệt kê 6 subtest ma trận và 4 test PASS (`hrm-14c-green-v.log`).

## Mutant (overlay ngoài repo, `/private/tmp/hrm-14c-mutants/`)

Lệnh: `go test -tags integration -count=1 -overlay /private/tmp/hrm-14c-mutants/<tên>.json ./internal/app -run '^<test>$'` sau `waitload.sh`. Log `/private/tmp/hrm-14c-mutant-<tên>.log`. Không đột biến source thật.

| Mutant                                            | Thay đổi                                                                   | Kết quả                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| guard-route                                       | bỏ POST close khỏi `MigratedRoutes`                                        | exit 1, `TestEveryM6RouteIsMigratedWithAFullMatrix`: "POST …/close: M6 route is not migrated"                   |
| close-no-csrf                                     | close bỏ `DecodeEmptyCommand`                                              | exit 1, ô csrf 200 và đổi state; origin/invalid/extra lệch                                                      |
| reopen-no-csrf                                    | reopen đọc body bằng `json.UnmarshalRead`, bỏ `DecodeCommand`              | exit 1, ô csrf 200 và đổi state, invalid 503                                                                    |
| period-not-fresh2                                 | `authority.go`: `freshAuthentication` luôn true cho action `managePeriod`  | exit 1, ô fresh của close và reopen 200, đổi state                                                              |
| adjust-no-key                                     | `ParseIdempotencyKey` lỗi bị bỏ qua khi không có header                    | exit 1, ô "no key" 503 thay 400                                                                                 |
| close-ignores-extra                               | close bỏ qua `ErrInvalidRequest` của `DecodeEmptyCommand` (giữ CSRF)       | exit 1, invalid `{"expectedVersion":"1"}` 200 và đổi state                                                      |
| root-audit-target                                 | `companyTarget` ghi key là actor thay công ty                              | exit 1, `TestM6PeriodTransitionsOverHTTP`: 0 audit trên công ty, want 1 (close và reopen)                       |
| 14b m1-period-no-for-update với `waitBlocked` mới | overlay 14b, test `TestTheCloseReadsTheStateAndTheFactsUnderThePeriodLock` | exit 1 (5.35s): entry của writer không có trong snapshot, close sau close không bị từ chối; hạn 3 s vẫn đỏ thật |

Lượt bị loại, không tính:

- period-not-fresh (đổi policy `managePeriod` thành `write@1` trong declarations): exit 1 ở bootstrap (`*exec.ExitError`), lỗi môi trường/manifest chứ không phải ô fresh; thay bằng period-not-fresh2.
- adjust-ignores-extra (handler adjust bỏ qua `ErrInvalidRequest` của `DecodeCommand`): **sống** (exit 0). Nguyên nhân: `httpapi.decodeJSON` trả giá trị zero khi lỗi, nên body rỗng bị `parseAdjustment` từ chối 400; với route có field bắt buộc, bỏ qua lỗi decode vẫn fail closed (mutant tương đương). Biến thể có hiệu lực là close-ignores-extra ở trên (route không field).

## Lệnh và kết quả

Trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng riêng sau `waitload.sh`. Load quan sát 3.5–6.2 (dưới ngưỡng 40).

| Lệnh                                                                                | Kết quả / log                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `go vet -tags integration ./internal/app ./internal/modules/attendance` (trước RED) | 0; `hrm-14c-red-vet.log`                                                                                                                                                                                                                        |
| `go build ./...`                                                                    | 0; `hrm-14c-build.log`                                                                                                                                                                                                                          |
| `go vet ./...`                                                                      | 0; `hrm-14c-vet.log`                                                                                                                                                                                                                            |
| `go vet -tags integration ./...`                                                    | 0; `hrm-14c-vet-integration.log` (chạy trước sửa guard M2; sau sửa chạy lại `go vet -tags integration ./internal/app` exit 0)                                                                                                                   |
| `go test -race -count=1 ./internal/...`                                             | 0, 33 package ok, 17s; `hrm-14c-unit.log`                                                                                                                                                                                                       |
| `go test -race -tags integration -count=1 -p 1 ./internal/app` lượt 1               | **1**, 70.887s: `TestM2RoutesAreMigrated` "POST …/attendance-adjustments served with no M2 matrix", "17 M2 routes, want 14"; `hrm-14c-app.log`. Sửa guard M2                                                                                    |
| cùng lệnh, lượt 2                                                                   | 0, 66.058s; `hrm-14c-app-r2.log`                                                                                                                                                                                                                |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/attendance`       | 0, 34.184s; `hrm-14c-attendance.log`                                                                                                                                                                                                            |
| `go tool golangci-lint run`                                                         | 0, 0 issues; `hrm-14c-lint.log`                                                                                                                                                                                                                 |
| `go test -count=1 ./test`                                                           | 0, 4.609s; `hrm-14c-test.log`                                                                                                                                                                                                                   |
| `gofmt -l .`                                                                        | rỗng (lượt đầu `gofmt -d` báo căn cột struct `modules` và một hàng ma trận, đã sửa bằng Edit)                                                                                                                                                   |
| root `pnpm test:browser`                                                            | 0, 30 passed (2.8m), không skip/retry; sáu test `attendance.e2e-spec.ts` (gồm "HR session: adjust, report, self-adjust refusal, cancel, close/reopen, reconciliation") pass trên stack trộn với attendance phục vụ từ Go; `hrm-14c-browser.log` |
| root `pnpm exec prettier --check apps/api-go/AGENTS.md`                             | 0                                                                                                                                                                                                                                               |
| root `git diff --check`                                                             | 0                                                                                                                                                                                                                                               |

Tracker và thư mục sổ nằm trong `.prettierignore`; báo cáo này được định dạng trên bản sao `/private/tmp/hrm-14c-fmt` rồi ghi lại, kiểm bằng `prettier --ignore-path /dev/null --check` exit 0.

## Quyết định tự đưa ra

1. Close nhận cả không body lẫn `{}` qua `DecodeEmptyCommand` (TS `inputBody(body ?? {}, [])`; web gửi `{}`), không nhận field nào khác.
2. GET period không đọc query string (TS cũng không), nên ma trận không có ca query lạ cho route này.
3. Ô foreign/absent của ba route theo công ty là N/A có lý do (một neo công ty; tháng không phải record, tháng chưa chạm là open v1).
4. `waitBlocked` lấy 3 s = `maxDeadline` của runner (hằng không export); nếu runner đổi hạn, comment và số cần đổi theo.

## Điều chưa kiểm chứng và lo ngại

- Mixed stack: browser pass cho thấy web dùng được attendance từ Go và report NestJS vẫn chạy, nhưng không chứng minh report NestJS đọc snapshot Go vừa đóng có adjustment/phạm vi/hash hỏng; đó là 14d.
- Cuộc đua chéo module (period :249, F-31, approval/cancel-close, hire/termination-close) chưa làm (14d). Tracker `hrm-cancel` :213/:232/:253 và các dòng CROSS M6 còn trống.
- Ma trận dùng tháng 2000-xx cho close/reopen, đóng với snapshot gồm mọi employee của fixture; không kiểm nội dung snapshot qua HTTP (đã kiểm ở module 14b).
- Mutant adjust-ignores-extra sống vì thiết kế `decodeJSON`; không phải lỗ hổng nhưng ghi để reviewer biết giới hạn của ca "handler bỏ qua lỗi decode".
- `go vet -tags integration ./...` toàn repo không chạy lại sau sửa guard M2 (chỉ chạy cho `./internal/app`); build/unit/lint/`./test` chạy sau mọi sửa runtime, sửa M2 chỉ ở file test integration.

## Review

Reviewer độc lập (opus, chỉ đọc `review-t14c.diff` cùng nguồn TS/web/OpenAPI): Approved. Xác nhận classification sáu route khớp NestJS, decoder theo ruling 93, CSRF trước body/session, fresh@1 theo declarations, guard M6/M2 đỏ được, nới `waitBlocked` không làm mất khả năng đỏ (hướng đỏ nằm ở probe `55P03`). Xác nhận claim mutant "adjust bỏ qua lỗi decode" là tương đương: mọi nhánh lỗi của `decodeJSON` trả zero (`body_test.go:100`) và `parseAdjustment` trả cùng 400; biến thể `close-ignores-extra` là mutant có hiệu lực.

Minor:

- M1 (đã sửa bởi điều phối viên, chỉ comment): comment `waitBlocked` nói sai cơ chế ("whole 3 s transaction deadline … never will"); `lock_timeout` 1 s có retry, request tới 5 s. Viết lại thành "3 s là biên độ cho máy tải cao". Sau sửa: `gofmt -l` rỗng, `go vet -tags integration ./internal/modules/attendance` exit 0, `git diff --check` exit 0; không chạy lại integration vì chỉ đổi comment.
- M2: GET `attendance/periods/:month` bỏ qua query string (TS cũng vậy, vô hại); có thể thêm `InputQuery` không key cho nhất quán. Giữ, ghi nhận.
- M3: Root replay adjust chưa có ô ở mức HTTP (module 14b đã kiểm). Chuyển 14d.
- M4: reopen audit lỗi 503 chỉ kiểm ở module, chưa qua HTTP; tracker :280 cần ghi rõ phần qua HTTP. Chuyển 14d.
- M5: chưa có ca Root session không fresh trên close/reopen (ADR-05: Root vẫn cần fresh khi policy có `fresh@1`). Chuyển 14d.
