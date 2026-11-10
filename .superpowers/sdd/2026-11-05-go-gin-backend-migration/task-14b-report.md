# Báo cáo Task 14b — sáu operation M6 attendance và PostgreSQL

Trạng thái: XONG, review độc lập Approved (0 Critical/Important, xem mục Review cuối báo cáo). Base `c8aab64`, commit chứa báo cáo này; không push. Chỉ làm lát 14b: không route, controller, http_port, wiring `internal/app`, `MigratedRoutes`, ma trận HTTP, concurrency chéo module.

## Thay đổi

- `apps/api-go/internal/modules/attendance/attendance_service.go` (mới): `Operations`/`NewOperations`/`All`/`Bind`, façade `Service` với `Sheet`, `PeriodState`, `Adjustments` (found=false là 404), `ClosePeriod`, `ReopenPeriod` (không tới neo công ty là 403 như TS), `Adjust` (không tới nhân viên là 404). Mẫu theo `leave`/`workcalendar`.
- `attendance_read_repository.go` (mới): `readSheet` (scope trên employee, tháng mặc định theo `hrbase.BusinessToday`, `attendancecore.LoadFacts` đúng một id, kiểm có đúng một dòng và đúng id; state nil là open), `readPeriodState` (scope trên `hr_company`, LEFT JOIN kỳ, ≤50 event mới nhất trước, `occurredAt` UTC 6 chữ số micro giây), `readAdjustments` (scope trước count/page, đọc `json_build_object(...)::text` vào `AdjustmentList` với `RejectUnknownMembers`). SQL chép từ TS; chỉ thêm `::text` và thay `date()` riêng của attendancecore bằng `to_char(..,'YYYY-MM-DD')`.
- `attendance_period_command.go` (mới): `lockPeriodForUpdate` (upsert rồi FOR UPDATE), `runClose` (state open dưới khóa, chặn tháng tương lai theo đồng hồ DB, `LoadAllFacts` + version lịch không khóa, `BuildSnapshot`, lưu `string(CanonicalSnapshot)` vào jsonb, hash bằng `SnapshotHash`, append event close, audit `hr.attendance-period.close` trên công ty), `runReopen` (state closed dưới khóa, xóa snapshot/hash, event reopen có reason, audit). Helper `one[T]` đọc đúng một giá trị.
- `attendance_adjust_command.go` (sửa, giữ `adjustmentHash` của 14a): `runAdjust` và `priorClaim`. Thứ tự: target employee (Execute) → kiểm tự điều chỉnh (`account_id = actor`, 403, trước khi đọc claim nên không đốt khóa) → đọc claim `(actor,'attendance.adjust',key)` → `hrbase.Replay` rồi `authority.Replay` → kiểm trong thời gian làm việc (409) → `AssertPeriodsOpen` (FOR SHARE, 409 `error.periodClosed`) → lịch FOR SHARE → `LoadFacts` đúng nhân viên, `PaidMinutes + minutes < 0` thì 409 → insert entry → claim `ON CONFLICT DO NOTHING RETURNING 1` (không claim được: 422 `error.idempotencyKeyReused`, rollback entry) → audit `hr.attendance.adjust` chỉ id/kind.
- `attendance_types.go`: Minor M4 của 14a: `PeriodEvent.Event` thành `PeriodEventKind` (`close`/`reopen`); `readPeriodState` từ chối kind khác và state khác open/closed (fail closed).
- Tests mới: `attendance_integration_test.go` (fixture, bảng công, trạng thái kỳ, close/reopen, thứ tự khóa close), `attendance_adjust_integration_test.go` (điều chỉnh, danh sách, replay/reuse, Root replay, race, thứ tự khóa điều chỉnh). Chỉ ASCII (kiểm `LC_ALL=C grep`).
- `apps/api-go/contract/test-port-tracker.md`: tách dòng `hrm-attendance-adjust.integration-spec.ts` và `hrm-attendance.integration-spec.ts` theo từng ca đã port; ca còn lại (F-24 report, F-31, CHECK cột, các ca :280 cần submit/decision/lịch thật, :453 các login khác, tính bảng công qua đơn thật) giữ trạng thái trống.
- `apps/api-go/AGENTS.md`: đoạn M6 14b (thứ tự khóa, close không khóa lịch, self guard trước claim) và bẫy jsonb snapshot (không `json.Marshal(Snapshot)`, `snapshot::text` khác bytes canonical, so bằng `VerifiedSnapshot` hoặc `= CAST(canonical AS jsonb)`).

Không đổi schema, ACL, identity, mã lỗi, OpenAPI, routes, NestJS, web, DAG (các import đều đã có trong cạnh `attendance` của `package-dag.md`), progress/handoff/plan.

## Quyết định tự đưa ra

1. id của entry và event dùng `gen_random_uuid()` trong SQL (theo `leave`) thay cho `randomUUID()` truyền từ TS; entry trả id bằng `RETURNING id::text`.
2. Service nhận `month string` cho close (không type riêng, như 14a); input đã qua validator ở 14c.
3. Thứ tự khóa theo TS (ruling 89): close/reopen là fence → công ty → kỳ FOR UPDATE; điều chỉnh là fence → employee → claim → kỳ FOR SHARE → lịch FOR SHARE. Không có quyết định mới về semantics.
4. Đọc trạng thái kỳ fail closed khi event/state lưu ngoài tập đóng (M4); TS chỉ dựa CHECK của bảng.

## RED/GREEN

- RED: viết hai file test trước; `go vet -tags integration ./internal/modules/attendance` exit 1, `undefined: Service` (`/private/tmp/hrm-14b-red.log`). Đây là RED biên dịch, bằng chứng thứ tự TDD, không tính RED hành vi.
- GREEN lần đầu: `go test -race -tags integration -count=1 -p 1 ./internal/modules/attendance` exit 0, 32.238s (`hrm-14b-integration-r1.log`). Lượt cuối có `-v`: xem bảng lệnh.
- RED hành vi: 13 mutant dưới đây.

## Mutant hành vi (overlay ngoài repo)

Bản sao ở `/private/tmp/hrm-14b-mutants/<tên>/` với `overlay.json`, sinh bằng `perl -0pe` vào bản sao (không sửa file repo). Lệnh: `go test -tags integration -count=1 -p 1 -overlay <dir>/overlay.json ./internal/modules/attendance` sau `waitload.sh`. Log `/private/tmp/hrm-14b-mutant-<tên>.log`. Cả 13 exit 1 do assertion; không `build failed`, không lỗi môi trường ở lượt được tính.

| Mutant                           | Thay đổi                                                                  | Test đỏ                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| m1-period-no-for-update          | bỏ `FOR UPDATE` khi khóa kỳ (không chờ writer, đọc state không dưới khóa) | `TestTheCloseReadsTheStateAndTheFactsUnderThePeriodLock`, `TestAnAdjustmentRacingTheCloseIsInTheSnapshotExactlyWhenItCommitted` |
| m2-close-no-state-check          | bỏ kiểm state open khi close                                              | `TestTheCloseStoresTheCanonicalSnapshotAndTheReopenKeepsTheHistory`, `…UnderThePeriodLock`                                      |
| m13-reopen-no-state-check        | bỏ kiểm state closed khi reopen                                           | `TestTheCloseStoresTheCanonicalSnapshot…`                                                                                       |
| m3-close-loadfacts-nil           | close dùng `LoadFacts(tx, month, nil)`                                    | `TestTheCloseStoresTheCanonicalSnapshot…`, `…UnderThePeriodLock`, `…RacingTheClose…`                                            |
| m4-close-marshal-snapshot        | lưu `json.Marshal(snapshot)` thay bytes canonical                         | `TestTheCloseStoresTheCanonicalSnapshot…`, `TestAFutureMonthIsNotClosed…`, `…RacingTheClose…`                                   |
| m6-close-no-audit                | bỏ audit của close                                                        | mọi test có close (`Execute` từ chối lệnh không audit), vd. `TestAClosedMonthRefusesTheAdjustmentUntilItIsReopened`             |
| m8-close-locks-calendar          | close lấy `work_calendar FOR SHARE`                                       | `TestTheCloseLocksTheCompanyThenThePeriodAndNotTheCalendar`                                                                     |
| m5-replay-no-hash                | replay bỏ so hash                                                         | `TestARetryReplaysAndAnotherPayloadReusesTheKey`                                                                                |
| m7-adjust-calendar-before-period | điều chỉnh khóa lịch trước kỳ                                             | `TestTheAdjustmentLocksEmployeeThenPeriodThenCalendar`                                                                          |
| m9-no-self-guard                 | bỏ chặn tự điều chỉnh                                                     | `TestHRNeverAdjustsTheirOwnAttendanceAndTheKeyStaysFree`                                                                        |
| m10-no-negative-total            | bỏ chặn tổng âm                                                           | `TestThePaidTotalOfAMonthNeverGoesBelowZero`, `TestTwoNegativeAdjustmentsRacingForTheLastMinutesOneFits`                        |
| m11-event-kind-unchecked         | bỏ kiểm kind event                                                        | `TestAStoredEventOfAnotherKindIsNotRead`                                                                                        |
| m12-sheet-loadfacts-all          | bảng công đọc `LoadAllFacts` thay đúng id                                 | `TestHRAdjustsInOneAuditedEntryThatMovesTheSheet`, `TestThePaidTotal…`, `TestTwoNegative…`                                      |

Lần chạy bị loại: m9 và m11 lượt đầu là `build failed` (biến không dùng), sửa bản đột biến rồi chạy lại; m8 lượt đầu fail cả 24 test vì testcontainers không khởi tạo được container (`No such container`, lỗi môi trường), chạy lại đỏ đúng một test. Bảng trên là lượt chạy lại.

Mutant "audit không atomic" không viết riêng: append audit lỗi làm transaction PostgreSQL hỏng nên không thể commit nửa chừng; tính atomic được kiểm bằng `TestAnAuditFailureRollsBackTheCloseAndTheReopen`, `TestAnAuditFailureRollsBackTheEntryAndTheClaim` (REVOKE INSERT trên `audit_outbox`, state trước/sau bằng nhau), còn bỏ audit là m6.

## Test PostgreSQL (24 test, package `attendance`, tag `integration`)

Bảng công: phạm vi E/H/Root đọc, L/C/O/N và absent không thấy, tháng mặc định theo DB, trước ngày tuyển bằng 0, tháng đã chốt vẫn là facts sống. Trạng thái kỳ: tháng chưa chạm open/v1/`[]`, lịch sử mới trước, reason chỉ ở reopen, định dạng `occurredAt`, C/L/E/N không thấy, event lạ bị từ chối. Close/reopen: chỉ HR fresh (stale và vai khác 403, không ghi), version 2..6, `VerifiedSnapshot` trên jsonb đọc lại, jsonb bằng `CAST(canonical AS jsonb)`, nhân viên đúng tập theo id (không có người nghỉ tháng trước), entry của E bằng bảng công sống, hash giống sau reopen với input không đổi và khác khi có entry mới, lịch sử event (version/kind/reason/actor/hash), audit trên công ty không có reason, tháng tương lai 409 không ghi, tháng hiện tại đóng được, tháng 2020-01 trống, audit lỗi rollback. Khóa: close chờ writer giữ kỳ FOR SHARE rồi thấy entry writer vừa commit; close sau một close vừa commit bị 409 và không ghi đè; close/reopen giữ công ty khi chờ kỳ (`lock_timeout` 55P03); close không chờ lịch. Điều chỉnh: F-18/19/20/21/22/25/26/27/28/30/33, F-29 phần quyền, F-32 danh sách, Root replay một dòng access có target và bị từ chối khi append lỗi, IAM replay không audit, một khóa hai nhân viên đúng một claim, thứ tự employee → kỳ → lịch.

## Lệnh và kết quả

Trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng sau `waitload.sh`. Load quan sát 4–16 (dưới ngưỡng 40).

| Lệnh                                                                                      | Kết quả / log                                                                                                                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `go vet -tags integration ./internal/modules/attendance` (RED)                            | 1, `undefined: Service`; `hrm-14b-red.log`                                                                                                   |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/attendance` (GREEN đầu) | 0, 32.238s; `hrm-14b-integration-r1.log`                                                                                                     |
| 13 mutant overlay                                                                         | đều 1 do assertion; `hrm-14b-mutant-*.log`                                                                                                   |
| `go build ./...`                                                                          | 0, 3s; `hrm-14b-build.log`                                                                                                                   |
| `go vet ./...`                                                                            | 0, 1s; `hrm-14b-vet.log`                                                                                                                     |
| `go vet -tags integration ./...`                                                          | 0; `hrm-14b-vet-integration.log` (chạy lại sau sửa lint)                                                                                     |
| `go test -race -count=1 ./internal/...`                                                   | 0, 15s, 33 package ok; `hrm-14b-internal.log`                                                                                                |
| `go test -race -tags integration -count=1 -p 1 -v ./internal/modules/attendance`          | xem mục "Lượt cuối"                                                                                                                          |
| `go tool golangci-lint run`                                                               | lượt 1 exit 1, 2 errcheck trong test (`_` cho lỗi của `Adjustments`), sửa; lượt 2 xem "Lượt cuối"; `hrm-14b-lint-r1.log`, `hrm-14b-lint.log` |
| `go test -count=1 ./test`                                                                 | 0, 8s (test 4.614s); `hrm-14b-test.log`                                                                                                      |
| `gofmt -l .`                                                                              | lượt đầu liệt kê một file test (khoảng trắng biểu thức), sửa; sau đó rỗng; `hrm-14b-gofmt.log`                                               |
| `git diff --check` (root)                                                                 | 0; file mới chưa track nên kiểm thêm khoảng trắng cuối dòng bằng `grep`, không có                                                            |

Lượt cuối sau sửa errcheck (chỉ đổi test): `go tool golangci-lint run` exit 0, 0 issues, 8s; `go vet -tags integration ./...` exit 0; `go test -race -tags integration -count=1 -p 1 -v ./internal/modules/attendance` exit 0, 75.141s, 35 `--- PASS` (24 integration + 11 unit của 14a), 0 FAIL (`hrm-14b-integration.log`); `gofmt -l .` rỗng; `git diff --check` exit 0. Ngay sau lượt integration, load máy tăng lên 96 do tiến trình khác; không có lệnh nặng nào của tôi chạy trong lúc đó (gofmt chạy trực tiếp vì nhẹ). Build, vet, unit race internal và `./test` không chạy lại sau sửa vì thay đổi chỉ ở file test có tag `integration`.

Prettier: báo cáo này kiểm bằng `prettier --ignore-path /dev/null --check` (thư mục sổ nằm trong `.prettierignore`); bản định dạng được tạo trên bản sao ở `/private/tmp/hrm-14b-fmt` rồi ghi lại bằng Write. `AGENTS.md` đạt. `test-port-tracker.md` không đạt Prettier ngay cả ở `HEAD` (đã kiểm bản `git show HEAD:` ra `/private/tmp`) và nằm trong `.prettierignore`, nên không định dạng lại toàn bảng.

Không chạy: `pnpm test:browser`, ma trận HTTP, integration `./internal/app` (14b không đổi route/wiring); concurrency chéo module (14d). Không tuyên bố M6 runtime qua HTTP đã được kiểm.

## Điều chưa kiểm chứng và lo ngại

- Snapshot Go đọc bởi report NestJS trên stack trộn chưa kiểm (14d); ở đây chỉ kiểm bằng `VerifiedSnapshot` của Go.
- Cuộc đua với submit/decision/cancel/lịch/hire/termination thật (period :249, F-31, approval/cancel-close) chưa có; test thứ tự khóa ở đây chỉ dùng holder SQL superuser.
- `TestAStoredEventOfAnotherKindIsNotRead` gỡ CHECK của bảng trên DB tạm bằng superuser để dựng dữ liệu không thể có; chỉ kiểm nhánh fail closed.
- Danh sách điều chỉnh: kiểm `createdAt` qua độ dài/hậu tố `Z`, không so giá trị thời gian.
- F-29 danh sách CHECK cột và :453 với ba login authority/identity/sync chưa port (tracker ghi dòng trống).

## Chưa làm (14c trở đi)

14c: controller/http_port, composition `internal/app`, sáu `MigratedRoutes`, ma trận HTTP và browser. 14d: concurrency chéo module, mixed stack Go close → NestJS report. 14e: gate đầy đủ, `task-14-report.md`.

## Review

Reviewer độc lập (opus, chỉ đọc `review-t14b.diff` cùng nguồn TS): Approved. Reviewer đối chiếu code reader NestJS (`report-sheet.repository.ts:155`, `parseSnapshot`/`verifiedSnapshot`) với `documentV2` của Go: `employeeId` dạng uuid text, `formatVersion: 2`, `calendarVersion` string, số nguyên an toàn, mảng rỗng là `[]`. Theo đọc code, report NestJS sẽ verify được snapshot Go ghi; kiểm thật trên stack trộn vẫn thuộc 14d.

Minor (điều phối viên ghi nhận):

- M1: helper `one[T]` dùng chung `errMissingRow` ("attendance period or calendar row is missing") cho cả self guard/`employed` của adjust; chỉ ảnh hưởng thông điệp nội bộ (client nhận 500 chung). Sửa khi chạm lại file.
- M2: `waitBlocked` hạn cứng 900 ms trong `attendance_integration_test.go`, có thể đỏ giả khi máy tải cao. Chuyển sang 14c: nới hạn hoặc gắn theo `lock_timeout`.
- M3: chưa có ca Root close/reopen đếm audit trong module; chuyển sang ma trận 14c.
- M4: `snapshotOf` đọc facts và version lịch bằng hai statement không khóa lịch (giữ như TS); tháng đang đóng không đổi số liệu vì writer lấy kỳ FOR SHARE. Ca :249 ở 14d kiểm `calendarVersion` cuối.
- M5: F-23 dựng entry bằng SQL; CHECK cột F-29 và :453 (ba login còn lại) chưa port, đã khai trong tracker; làm ở 14d/14e.
