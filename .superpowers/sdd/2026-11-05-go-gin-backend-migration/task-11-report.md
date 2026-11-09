# Báo cáo Task 11 — M3, lõi HR dùng chung (không chuyển route)

Trạng thái: DONE_WITH_CONCERNS — implementation, test integration PostgreSQL, đột biến RED và tracker đã xong; review độc lập và commit còn chờ agent chính. Không chuyển route, không push, không commit.

## Thay đổi

Code lõi đã được viết trước phiên này (untracked): `internal/modules/hrbase/request_types.go`, `internal/modules/{schedulecore,attendancecore,leavecore}/`. Phiên này chỉ sửa lỗi thật tìm thấy, không viết lại:

- `golangci-lint` lượt đầu báo 4 lỗi trong code có sẵn: `exhaustive` ở `attendance_calculation_helper.go` (switch `DayKind` thiếu `DayOff`; thêm nhánh rỗng, semantics không đổi) và `work_schedule_helper.go` (`LeaveMinutes` đổi switch thành hai `if` như TypeScript: makeup → `makeup_day`, khác workday → `non_working_day`; kind lạ vẫn bị từ chối); `errcheck` ở `attendance_snapshot_helper_test.go`, `working_time_helper_test.go` (kiểm lỗi thay vì `_`).
- `gofmt -w` trên ba file có sẵn (`leave_balance_helper_test.go`, `employee_schedule_repository.go`, `work_schedule_sql_helper.go`), chỉ định dạng.

Test integration mới (build tag `integration`, chỉ ASCII, `LC_ALL=C grep` không thấy ký tự ngoài ASCII):

- `attendancecore/attendance_fixture_integration_test.go`: fixture team/request/segment/lịch/version công ty/frame/điều chỉnh/tháng đóng bằng superuser của cluster tạm; employee, account bằng `test/fixture`. Không dùng `session_replication_role` (không có trigger trên các bảng HR này).
- `attendancecore/attendance_facts_integration_test.go`: port nguyên văn `oracleLoadAttendanceFacts`, `oracleApprovedEffectsSql`, `oracleAdjustmentMinutesSql`. Dataset như spec TypeScript (approved/pending_lead/pending_final/rejected/cancelled, trùng segment, WFH qua ranh tháng, tuyển 03-16, nghỉ 03-20, người đã nghỉ trước tháng, 6 thay đổi lịch gồm holiday bị revert và makeup company/employee, version công ty 2026-04-13, frame nhân viên, điều chỉnh có dấu, tháng 2 đóng) cộng 300 nhân viên bulk (40 có request/điều chỉnh, một có frame). Với 4 tháng × 8 tập id (`nil`, rỗng, một, IDLE, bốn người, 11 người đảo thứ tự, id lạ, 311 id đảo thứ tự) `LoadFacts` bằng `reflect.DeepEqual` với oracle chạy trong cùng transaction; set-based (311 id) cắt về 11 người bằng per-row; cửa sổ 4 tháng của `ApprovedEffectsBySQL` bằng fragment correlated theo text từng cặp nhân viên-tháng và chỉ đọc nhân viên được giao. Chỉ request approved là effect; `TotalsOf` không lỗi trên mọi dòng; tháng sai là `ErrInvalidMonth`.
- `AssertPeriodsOpen`: upsert dòng `open`, tháng đóng → `apperror.Rejection` `error.periodClosed` (409); trong callback của runner, superuser `FOR UPDATE NOWAIT` nhận 55P03 còn `FOR SHARE NOWAIT` qua; superuser giữ dòng `FOR UPDATE` thì runner trả `database.ConflictError` (lock_timeout), COMMIT xong thì qua.
- `attendancecore/attendance_effect_integration_test.go`: WFH vừa đủ giới hạn mặc định 4; ngày thứ năm không ack → `error.wfhLimitAckRequired` (409), counter không đổi và không còn dòng tháng 4; ack → hai counter (3: 5, 4: 1); `hr.wfhMonthLimit` = 7 đọc từ `system_setting`; cảnh báo `WfhLimitExceeded` năm ca; release; release lần hai bị CHECK (23514) và không đổi tháng 3; request không phải WFH, request thiếu. `ApplyApprovedAttendance` khóa cả hai tháng của request, tháng thứ hai đóng → `error.periodClosed`.
- `leavecore/leave_effect_integration_test.go`: `AssertAvailable` vừa đủ 1440 qua, thêm 120 → 422 `error.insufficientLeave`, tháng 2 chỉ 960, pending được tính; `ApplyApproved` một debit mỗi segment và bucket 1→2, replay UNIQUE và không ghi; vượt entitlement → `ErrCommandRejected`, không ghi; pending khác không tính lúc duyệt; ngày sau kỳ official (đã tích 960) → `ErrCommandRejected`, không ghi bucket/debit; probation → `ErrCommandRejected`; `ReverseApproved` hai reversal, bucket 4, lần hai UNIQUE, request không debit → `ErrDebitsMismatch`. `LoadFacts` tách opening/adjustment, debit rồi reversal âm, pending (bỏ rejected, ledger năm khác), entitlement tháng 1/5, >100 id → `ErrTooManyEmployees`.
- `schedulecore/employee_schedule_integration_test.go`: `EmployeeSchedule` ở version lịch 3/5/1 (holiday sau đó bị revert, thay đổi sau version không thấy, ngày ngoài khoảng không đọc), hai version công ty (version 04-01 ngoài khoảng bị loại), frame của nhân viên (frame người khác, frame bắt đầu sau khoảng bị loại), `FrameOn` cho workday frame riêng, holiday, makeup lấy frame nhân viên, version mới, ngày nghỉ.

Mọi code được test chạy bằng login runtime qua `database.Run`: effect và period guard `ModeWrite` (login data), đọc `ModeRead`. Không thiếu grant nào; không đổi migration, ACL, declarations, mã lỗi, dependency.

Tài liệu: tracker tách 6 dòng (`hrm-attendance-effects-equivalence`, oracle helper, `hrm-attendance.spec`, `hrm-leave.spec`, `hrm-work-schedule.spec`, `hrm-working-time.spec`) thành phần đã port M3 và phần cần route M4–M7. Plan chỉ tick hai bước đầu của Task 11; bước "Không có route… Review độc lập. Lưu thay đổi." để trống. Không có bẫy Go mới đủ để thêm vào `apps/api-go/AGENTS.md`. DAG không đổi (cạnh M3 đã có sẵn ở `package-dag.md`, `go test ./test` qua).

## Lệnh và kết quả thật

Go 1.27.3 darwin/amd64, Docker 29.9.2. Cwd `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng có `bash ../../.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh &&` trước, chạy tuần tự. `apps/api/dist` mới hơn `apps/api/src` nên không build lại. Lượt kiểm cuối (sau mọi sửa):

- `go build ./...`: exit 0.
- `go vet ./...`, `go vet -tags integration ./...`: exit 0.
- `go test -race -count=1 ./internal/...`: exit 0 (12 s wall; attendancecore 1.037s, hrbase 1.029s, leavecore 1.032s, schedulecore 1.026s).
- `go test -race -tags integration -count=1 -p 1 ./internal/modules/schedulecore ./internal/modules/attendancecore ./internal/modules/leavecore`: exit 0; schedulecore 5.572s, attendancecore 11.245s, leavecore 5.741s.
- `go tool golangci-lint run`: lượt đầu exit 1, 4 issues (mục trên); sau sửa exit 0, `0 issues.`
- `go test -count=1 ./test`: exit 0, 4.371s; chạy lại sau sửa tracker 4.372s.
- `gofmt -l .`: rỗng. `git diff --check` (root): exit 0. `pnpm exec prettier --check` plan: `All matched files use Prettier code style!`. Tracker giữ cách viết bảng hiện có, không chạy Prettier.

Lỗi không phải kết quả test: hai lượt chạy đột biến đầu ra `FAIL . [setup failed]` vì zsh không tách cờ trong biến (`"$2"`), không tính RED; chạy lại bằng lệnh viết thẳng.

## Đột biến

Overlay ở `/private/tmp/hrm-11-mutants/`, không sửa source thật. Integration: `go test -race -tags integration -count=1 -overlay /private/tmp/hrm-11-mutants/<x>.json <pkg> -run '<test>'`; (d) không có `-tags integration`.

|     | File, đột biến                                                                           | Test                                                              | Kết quả                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| a   | `attendance_facts_helper.go`: bỏ `AND r.state = 'approved'` trong `ApprovedEffectsBySQL` | `TestLoadFactsEqualsTheCorrelatedOracleSetBasedAndPerRow`         | RED 5.200s, `facts 2026-03 ids=set-based differ from the oracle: row 5`                                                                    |
| b   | `attendance_facts_repository.go`: bỏ `FOR SHARE`                                         | `TestAssertPeriodsOpenUpsertsRefusesAClosedMonthAndLocksForShare` | RED 4.609s, `NOWAIT FOR UPDATE` lấy được khóa và runner không bị chặn                                                                      |
| b2  | cùng file: bỏ điều kiện `state != open`                                                  | test trên và `TestApprovedAttendanceLocksEveryMonthOfTheRequest`  | RED 4.892s, cả hai: tháng đóng trả `<nil>`                                                                                                 |
| c   | `attendance_effect_repository.go`: `if false && !acknowledged`                           | `TestApprovedWfhCountersLimitAcknowledgementAndRelease`           | RED 4.722s, ngày thứ năm không ack trả `<nil>`                                                                                             |
| d   | `leave_balance_helper.go`: `floorDiv12` làm tròn lên                                     | toàn bộ unit `./internal/modules/leavecore`                       | RED 0.026s, `TestAnAgreedRateAccruesTheCumulativeFloorWithoutDrift`                                                                        |
| e   | `leave_effect_repository.go`: `notOfficial < 0`                                          | `TestApplyAndReverseApprovedLeaveWriteTheLedgerOnce`              | Lượt đầu GREEN: ca probation bị từ chối vì accrual 0, không vì ngày. Thêm ca kỳ official kết thúc 03-01 (đã tích 960); chạy lại RED 5.036s |

GREEN tương ứng là lượt integration cuối ở trên.

## Khác biệt Go so với TypeScript

Đã đối chiếu từng hàm với nguồn TS. Không thấy khác biệt semantics trên input hợp lệ; các điểm khác:

1. Interface theo plan là `attendancecore.AttendanceFacts.AssertPeriodsOpen(ctx, tx, dates)`, `leavecore.LeaveEffects.ApplyApprovedLeave`; code là hàm tự do nhận `tx` (`AssertPeriodsOpen(tx, dates)`, `leavecore.ApplyApproved`, `ReverseApproved`, `AssertAvailable`, `attendancecore.ApplyApprovedWfh(tx, id, acknowledged)`), theo quy ước repository của `apps/api-go/AGENTS.md`. M5 cần ghép theo tên này.
2. Chặt hơn TS: `attendancecore.LoadFacts` kiểm tháng (`ParseMonth`) trước SQL; `leavecore.LoadFacts` từ chối >100 id (TS chỉ ghi trong comment); `DatesBetween` từ chối ngày không tồn tại và năm ngoài 1900–2100 (TS dựa vào `inputDate` của caller); JSON lưu đọc với `RejectUnknownMembers` (shape lạ là lỗi, không đọc thành ngày nghỉ); `ParseSnapshot` từ chối key lặp (v2), không xảy ra với jsonb.
3. Lỗi lập trình (request thiếu, không có segment, không phải WFH/annual leave, request trải hai năm, `ReverseApproved` khi không có segment) là sentinel error thay vì `throw new Error`; TS ở ca không segment của reversal sẽ lỗi NOT NULL ở bucket, Go trả `ErrNotAnnualLeave`. Cả hai đều là lỗi 503.
4. Từ chối duyệt nghỉ (`not_official`, `insufficient_leave`) là `apperror.ErrCommandRejected` (409) không kèm lý do; TS có `ProductCommandRejected(reason)`. Nếu M5 cần lý do cho audit/log thì phải bổ sung.
5. Sắp xếp kind bằng so byte thay `localeCompare`: tương đương cho năm kind (chữ đầu khác nhau, ghi ở `hrbase/request_types.go`).
6. `MonthTotals`, `MonthDates`, `FrameOn` trả `error` thay vì throw `RangeError`.

## Rủi ro còn lại

- Chưa chạy review độc lập và chưa commit (dành cho agent chính).
- Snapshot canonical chỉ có vector vàng (unit); byte-parity với `JSON.stringify` cho chuỗi có ký tự điều khiển chưa kiểm, để Task 14 (format 1/2 trên stack trộn).
- Dataset equivalence có 311 nhân viên, không phải hàng nghìn như ca :388 (thuộc M6/M7); không đo hiệu năng hay query plan ở task này.
- Thứ tự khóa đầy đủ (fence → idempotency → employee → request → bucket → kỳ công) và deadlock/concurrency thuộc Task 13; ở đây chỉ kiểm khóa của từng hàm.
- Test local trên PostgreSQL tạm không chứng nhận môi trường production.

## Review độc lập và sửa

Reviewer độc lập không tìm thấy lỗi chặn. Finding và cách xử lý (chưa commit, không push):

- R1 `attendancecore.LoadFacts`: `ids == nil` nghĩa là "mọi nhân viên trong tháng", còn `[]string{}` là "không ai"; caller tương lai dựng `ids` bằng `append` từ một trang có scope rỗng sẽ truyền nil và đọc cả công ty. Đã sửa: `LoadFacts(tx, month, ids)` luôn đọc đúng `ids` (nil bằng rỗng, không ai), `LoadAllFacts(tx, month)` riêng cho việc chốt tháng; cả hai qua `loadFacts` không export. Quy tắc set-based giữ nguyên (đọc tất cả, hoặc `len(ids) >= EffectsSetBasedMinRows`). Test equivalence thêm tập `all` (so `LoadAllFacts` với oracle nil) và khẳng định tập `nil`, `empty` trả slice rỗng không nil; `TestOnlyApprovedRequestsAreEffects` dùng `LoadAllFacts`, thêm ca tháng sai của `LoadAllFacts`.
- R2 `leavecore.FirstMonthOver`: TS dùng `accrued[i] ?? 0`, Go bỏ qua tháng vượt `len(accrued)`. Đã sửa: tháng ngoài `accrued` so với 0. Unit: `[480, 960]` với `[0, 960]` → 0, với `[0, 960, 0]` → 3.
- R3: không nằm trong danh sách sửa agent chính giao cho phiên này; phiên này không biết nội dung, không xử lý.
- R4 `attendancecore.FirstOfMonth`/`MonthsOf` panic với chuỗi ngắn. Đã sửa: `FirstOfMonth` trả `(string, error)` (nhận `YYYY-MM` qua `ParseMonth` hoặc ngày qua `schedulecore.ParseDate`), `MonthsOf` trả `([]string, error)` và kiểm mỗi ngày bằng `schedulecore.ParseDate`; lỗi truyền ra ở `AssertPeriodsOpen`, `ApplyApprovedWfh`, `ReverseApprovedWfh`, `WfhLimitExceeded`. `daysIn` chỉ đếm ngày hợp lệ (ngày đã qua `MonthsOf`). Unit: `""`, `"2026"`, `"2026-1"`, `"2026-02-30"`, `"2026-03-1x"` bị từ chối ở cả hai hàm, `2026-03`/`2026-03-31` → `2026-03-01`.
- Test gap đã bổ sung: (a) hai `late-arrival` cùng ngày → `LateCount` 1, `LateMinutes` 90; hai `early-departure` cùng ngày → `EarlyCount` 1, `EarlyMinutes` 120; (b) ngày làm bù `frameSource employee`, `asWeekday` 7 (công ty nghỉ) trong khi nhân viên có frame riêng cho thứ 7 → nghỉ (giữ `len(frame) > 0`, khớp `base.length > 0` của TS); (c) snapshot `wfhDays` âm và `lateCount` âm → `ErrInvalidSnapshot`; (d) `leave_effect_integration_test.go`: ca "February has only 960 accrued" và "a pending request does not count" giờ kiểm đúng `apperror.Rejection` `error.insufficientLeave`, không chỉ `err != nil`.
- Nit đã sửa: `DatesBetween` so khoảng bằng `end.Sub(start)/(24*time.Hour) >= time.Duration(maxDays)` (không float); `leavecore.monthIn` đọc tháng đúng hai chữ số ASCII 01..12 thay `fmt.Sscanf` (unit thêm `2026-1x-01`, `2026-+1-01`, `2026- 3-01`, `2026-00-01`, `2026-13-01`, `2026-1`); plan Task 11 "Produces" đổi sang tên hàm tự do thật, kèm ghi chú 2026-11-09.

Không có finding nào để lại chưa sửa.

### RED/GREEN

Overlay ở `/private/tmp/hrm-11r-mutants/` khôi phục hành vi cũ trên source đã sửa (giữ chữ ký mới để test biên dịch được). Cwd `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, có `waitload.sh` trước mỗi lệnh.

| Fix | Overlay | Lệnh | RED | GREEN (source đã sửa) |
| --- | --- | --- | --- | --- |
| 1 | `r1.json`: `LoadFacts` truyền nil như "tất cả" (`ids == nil \|\| len(ids) >= Min`) | `go test -race -tags integration -count=1 [-overlay …/r1.json] ./internal/modules/attendancecore -run TestLoadFactsEqualsTheCorrelatedOracleSetBasedAndPerRow` | FAIL 5.236s: `facts 2026-02 ids=nil differ from the oracle: 309 rows, want 0` | ok 7.323s |
| 2 | `r2.json`: `i < len(accrued) && used > max(0, accrued[i])` | `go test -count=1 [-overlay …/r2.json] ./internal/modules/leavecore -run TestFirstMonthOverChecksCumulativeCommittedMinutes` | FAIL 0.012s: `a month past the accrual counts against 0: 0` | ok 0.012s |
| 3 | `r3.json`: `FirstOfMonth`/`MonthsOf` cắt `value[:7]` không kiểm | `go test -count=1 [-overlay …/r3.json] ./internal/modules/attendancecore -run TestMonthDatesAndMonthGrammar` | FAIL 0.015s: `panic: runtime error: slice bounds out of range [:7] with length 0` | ok 0.013s |

### Checks chạy lại (sau mọi sửa)

- `go build ./...`, `go vet ./...`, `go vet -tags integration ./...`: exit 0.
- `go test -race -count=1 ./internal/...`: exit 0 (attendancecore 1.040s, hrbase 1.027s, leavecore 1.034s, schedulecore 1.033s).
- `go test -race -tags integration -count=1 -p 1 ./internal/modules/schedulecore ./internal/modules/attendancecore ./internal/modules/leavecore`: ok 5.587s / 11.204s / 5.660s.
- `go tool golangci-lint run`: `0 issues.`, exit 0.
- `go test -count=1 ./test`: ok 4.510s.
- `gofmt -l .`: rỗng. `git diff --check` (root): exit 0; vì ba package mới còn untracked, kiểm thêm khoảng trắng cuối dòng bằng `grep -rnE "[[:space:]]+$"` trên chúng: không có.
- `pnpm exec prettier --check` plan: `All matched files use Prettier code style!`.

Plan: tick bước "Không có route… Review độc lập. Lưu thay đổi." kèm "(review độc lập 2026-11-09, finding đã sửa; commit kèm)"; commit do agent chính làm.

- R3 (agent chính ghi bổ sung): `leavecore.ApplyApproved` trả `apperror.ErrCommandRejected` (409 `error.conflict`) cho cả `not_official` lẫn `insufficient_leave`, giống status của `ProductCommandRejected` bên TS nhưng mất lý do cho log/audit. Chấp nhận ở M3, chưa sửa; xử lý khi ghép duyệt đơn ở Task 13 (M5) nếu audit/log cần lý do.
