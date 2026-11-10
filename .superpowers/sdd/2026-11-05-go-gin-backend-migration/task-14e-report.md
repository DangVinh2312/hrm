# Báo cáo Task 14e — đóng phần còn lại của M6

Ngày 2026-11-10. Repo `/Users/vinhdq2312/Documents/personal/hrm`, branch `version/single-app`, HEAD `917dd71`. Lúc bắt đầu `git status --short` có hai file sổ của điều phối viên (`handoff-2026-11-09.md`, `progress.md`); tôi không đụng. Không stage/commit, không spawn, không sửa runtime. Chỉ PostgreSQL disposable (testcontainers); không đọc seed/env/secret.

## Đã làm

### 1. Bảng công qua route so với oracle facts (:35, :235, :148)

`apps/api-go/internal/app/m6_sheet_integration_test.go` (mới), `TestM6TheSheetOfRealRequestsIsTheOracleAndTheCloseStoresIt`, world `newM5cWorld`, hai nhân viên `m6Member` (a, b):

- Đơn chờ dựng bằng SQL qua `m6Request` (tái dùng, như `fixtureRequest` của TS) vì cửa sổ nộp `[hôm nay − 7, + 90]` theo đồng hồ DB loại tháng cố định 2026-03; sau đó mọi chuyển trạng thái đi qua route Go thật: quyết định (`POST /api/hr/requests/:id/decision`), hủy (`/cancel`), ngày lễ (`PUT /api/hr/work-calendar/days/2026-03-12`), điều chỉnh (`POST …/attendance-adjustments`, +120, −60, +30 tháng 4).
- Dataset: phép năm 02-27, 03-02, 03-18 (Root duyệt bước cuối), 04-14; nghỉ không lương 03-03; đi muộn 03-04 và về sớm 03-05 dựng `pending_lead`, lead duyệt là approved luôn; WFH 03-06; nghỉ không lương 03-09 duyệt rồi hủy; phép năm 03-10 để `pending_lead`; WFH 03-11 bị từ chối; phép năm + nghỉ không lương cùng phút 03-13; b có WFH 2026-03-31 + 2026-04-01 (thêm segment thứ hai bằng SQL).
- Kiểm: với a, b × 2026-02/03/04, body route bằng đúng bytes `json.Marshal(attendance.SheetView{…, Totals: attendancecore.TotalsOf(month, oracle)})`, đọc lại cho cùng bytes (F-08). Neo tường minh để không rỗng: tháng 3 của a có `[lateCount, earlyCount, wfhDays, paidHolidayMinutes, adjustmentMinutes] = [1,1,1,480,60]`, unpaid và annual khác 0; cặp chồng phút chỉ tính một lần (tổng annual+unpaid tăng 240, phút có lương giảm đúng phần unpaid); phép năm 03-02 đúng một dòng ledger; counter WFH `a: 2026-03=1`, `b: 2026-03=1,2026-04=1` (D-04 qua route).
- Oracle: `oracleLoadFacts` và câu correlated chuyển nguyên văn từ `internal/modules/attendancecore/attendance_facts_integration_test.go` sang `apps/api-go/test/fixture/attendance_oracle.go` (`fixture.OracleLoadFacts`, `fixture.OracleApprovedEffectsSQL`), vì test `package app` không import được helper trong `_test.go` của `attendancecore_test`. Test M3 cũ gọi lại qua `fixture.` (không đổi câu SQL). `test/fixture` không phải node DAG; `app` và `attendancecore_test` import nó không tạo vòng.

### 2. Close: snapshot lưu bằng oracle (:333 phần close)

Cùng test: đọc oracle với `nil` ids (mọi nhân viên của tháng như `LoadAllFacts`), `BuildSnapshot(month, version lịch, …)`, `CanonicalSnapshot`, `SnapshotHash`; close qua route (`{}`): response `{"month":"2026-03","state":"closed","version":"2"}`; SQL kiểm `version = 2`, `attendance_period.snapshot_hash` và `snapshot_hash` của event close bằng hash oracle, `snapshot = CAST(canonical AS jsonb)`; `VerifiedSnapshot(month, stored, hash)` rồi canonical bằng bytes oracle; bảng công tháng đã chốt vẫn bằng oracle với `periodState":"closed"`. Report/XLSX của :333, :310, :388 ghi M7 trong tracker.

### 3. D-04 và các ca :201/:249/:434/:140/:31/:148

- `internal/modules/workrequest/work_request_decision_integration_test.go`: thêm `TestAnApprovalCountsEachWfhDayInTheMonthOfThatDay` (façade thật, lead → COO): WFH qua ranh tháng (ngày làm việc cuối tháng này và đầu tháng sau theo đồng hồ DB) bị từ chối không để lại dòng counter nào (D-06); nộp lại không ghi counter (read-only, :434); duyệt cho hai counter mỗi tháng 1 (D-04); L ba ngày một tháng +3 (D-08); thêm hai ngày vượt hạn mức mặc định 4 bị `error.wfhLimitAckRequired`, counter giữ 3; có xác nhận thì 5.
- `internal/modules/employee/employee_menu_integration_test.go`: thêm `TestTheAttendanceMenuFollowsTheReadableOwnSheet` (:140): `hr.employee` có hồ sơ thấy menu; thêm deny `employee.readAttendance` thì mất menu nhưng vẫn còn `requests`; hồ sơ không role, role không hồ sơ đều không thấy. Bản đầu thiếu ca deny và đột biến "có hồ sơ là có menu" sống sót (xem RED/GREEN), nên thêm ca này.
- :31, :148, :201, :434 trỏ tới test đã có, đã đọc từng test (chi tiết ở mục Tracker).

### 4. Minor r1–r4 từ re-review 14d

- r1: `TestM6TheCloseRacingEveryWriterKeepsTheSnapshotEqualToTheSheet` dựng world bằng `newM5cWorld(t, contention.observe)` và bọc mỗi `gated` trong `contention.during`, đòi 0 deadlock/lock timeout/retry. Mutant đảo thứ tự khóa: xem RED/GREEN; kết luận quan trọng ở mục Lo ngại.
- r2: `m6Contention` đếm riêng `m6Counts{deadlocks, timeouts, retries}`; `during` báo "the race met %d deadlocks, %d lock timeouts and %d retries". `TestM6ACommandACalendarChangeAndTheCloseOfOneMonthAllFinish` dùng cùng `during`. Switch liệt kê đủ `database.Metric` vì `exhaustive` (`default-signifies-exhaustive: false`).
- r3: bỏ guard `live == (m6Totals{})`; `held` (snapshot có nhân viên) cộng `stored == live` và `moved` là phần kiểm thật.
- r4: `apps/api-go/AGENTS.md` câu runner retry thành `40P01`/`55P03`/`40001` kèm metric tương ứng (kiểm `internal/database/transaction_errors.go:49` `retryableCodes`, `runner.go:210-219`); tracker dòng period :249 cũng vậy.

## RED/GREEN

Mutant qua `go test -overlay` với bản sao ngoài repo ở `/private/tmp/hrm-14e-mutants/`; mọi lượt đỏ là exit 1 do assertion, không phải lỗi biên dịch. Log `/private/tmp/hrm-14e-*.log`.

| Mutant (file overlay)                                                                                                                     | Test                                                                  | Kết quả                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) `sheet-drops-early`: `readSheet` bỏ effect `early-departure` trước `TotalsOf`                                                       | `TestM6TheSheetOfRealRequests…`                                       | ĐỎ: dòng 121 (neo `earlyCount 0`), 134 (bytes khác oracle: `"earlyCount":0` so với `1`), 175 (tháng đã chốt)                                                                                                                             |
| (b) `close-drops-adjustment`: `snapshotOf` đặt `row.AdjustmentMinutes = 0`                                                              | `TestM6TheSheetOfRealRequests…`                                       | ĐỎ: dòng 165 (hash lưu `f4c1…` khác oracle `b0ab…`, `snapshot = canonical` false), 169 (`VerifiedSnapshot` với hash oracle: "does not match its hash")                                                                                 |
| (c) `wfh-counter-merges-months`: `moveCounters` chỉ tháng đầu với `len(dates)`                                                          | `TestAnApprovalCountsEachWfhDayInTheMonthOfThatDay`                   | ĐỎ: dòng 368, counters `"2026-11=2,2026-12=0"`, muốn `"2026-11=1,2026-12=1"`                                                                                                                                                             |
| `termination-locks-after-read`: nghỉ việc đọc tháng đã chốt trước khi khóa công ty FOR SHARE                                             | `TestM6TheCloseRacing…/termination`                                   | ĐỎ ở `close_first`: writer 200 trong tháng đã chốt, writes đổi, snapshot khác bảng công; `writer_first` xanh. Không có dòng "the race met": đỏ do kết quả, không do bộ đếm contention                                                     |
| `adjust-calendar-before-period`: điều chỉnh khóa lịch FOR SHARE trước kỳ                                                                 | `TestM6TheCloseRacing…/adjustment`, `TestM6ACommand…/adjustment`      | `TestM6TheCloseRacing…/adjustment` XANH cả hai thứ tự; `TestM6ACommand…/adjustment` ĐỎ ("the attempts were never in flight together": điều chỉnh không còn chờ ở lịch, nhận 409 sau close)                                              |
| `menu-attendance-without-grant`: menu attendance hiện khi có hồ sơ (`attendance = true`)                                                 | `TestTheAttendanceMenuFollowsTheReadableOwnSheet`                     | Bản đầu (ba ca) XANH: đột biến sống. Thêm ca deny `employee.readAttendance`; lượt sau ĐỎ dòng 86 `[requests calendar leave attendance]`                                                                                                    |

GREEN (trước mutant, mã thật): `go test -race -tags integration -count=1 -p 1 -run '…Sheet…|…CloseRacing…|…ACommand…' ./internal/app` exit 0 (25.9s, `hrm-14e-green-app.log`); `-run TestAnApprovalCountsEachWfhDayInTheMonthOfThatDay ./internal/modules/workrequest` PASS 6.57s (`hrm-14e-green-d04.log`); menu ba ca PASS (`hrm-14e-green-menu.log`), bốn ca PASS (`hrm-14e-green-menu-r2.log`). Các test này viết sau runtime (port test cho hành vi đã có), nên "đỏ trước" là đỏ dưới mutant, không phải trước implementation.

## Gate (apps/api-go, mỗi lệnh riêng sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`, load 3–6)

| Lệnh                                                                                | Kết quả                                                                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `go build ./...`                                                                    | exit 0 (`hrm-14e-build.log`)                                                                              |
| `go vet ./...`                                                                      | exit 0 (`hrm-14e-vet.log`)                                                                                |
| `go vet -tags integration ./...`                                                    | exit 0 (`hrm-14e-vet-int.log`)                                                                            |
| `go test -race -count=1 ./internal/...`                                             | exit 0, 33 package ok (`hrm-14e-unit.log`)                                                                |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/attendance`       | exit 0, 36.6s                                                                                             |
| `… ./internal/modules/attendancecore`                                               | exit 0, 15.6s (oracle đã chuyển sang `fixture`)                                                           |
| `… ./internal/modules/workrequest`                                                  | exit 0, 124.0s                                                                                            |
| `… ./internal/modules/leavecore`                                                    | exit 0, 7.2s                                                                                              |
| `… ./internal/modules/workschedule`                                                 | exit 0, 10.8s                                                                                             |
| `… -v ./internal/app`                                                               | exit 0, 88.4s, 62 test top-level PASS, 0 FAIL/SKIP (`hrm-14e-int-app.log`)                                |
| thêm: `… ./internal/modules/employee`, `… ./test/fixture`                           | exit 0 (15.9s), exit 0 (9.4s); hai package có file đổi nhưng ngoài danh sách brief                        |
| `go tool golangci-lint run`                                                         | lượt 1 exit 1: `exhaustive` ở switch metric của `m6Contention`; thêm case liệt kê metric còn lại; lượt 2 `0 issues` |
| sau sửa lint: `-run '…CloseRacing…|…ACommand…' ./internal/app` (race, integration)   | exit 0, 12.5s (`hrm-14e-int-app-race-r2.log`)                                                             |
| `go test -count=1 ./test`                                                           | exit 0                                                                                                    |
| `gofmt -l .`                                                                        | rỗng                                                                                                      |
| root `pnpm exec prettier --check apps/api-go/AGENTS.md apps/api-go/contract/test-port-tracker.md` | exit 0                                                                                    |
| root `git diff --check`                                                             | exit 0                                                                                                    |
| root `pnpm test:browser`                                                            | exit 0, 30 passed (4.0m), không failed/flaky (`hrm-14e-browser.log`)                                      |

## Tracker (`apps/api-go/contract/test-port-tracker.md`)

- effects-equivalence :235 → port (`m6_sheet_integration_test.go`). Dòng :310/:333/:388 tách thành ":333 phần close" (M6, port) và ":310 report, :333 report/XLSX, :388 quy mô" (M7, trống).
- `hrm-attendance` dòng gộp ":35/:148/:201/:249/:434, :31, :140" tách thành bảy dòng, mỗi dòng có tên test cụ thể và giới hạn:
  - :31 `TestAKindIsOpenOnlyWithEveryEffectItNeeds` (production `NewOperations` dùng `createApprovedEffects`) + test app duyệt cả năm kind qua composition thật.
  - :35 test sheet mới; ghi rõ chưa có F-02 (tuyển giữa tháng) qua route, chỉ ở oracle facts M3.
  - :140 `TestTheAttendanceMenuFollowsTheReadableOwnSheet`, `TestLinkedEmployeeMenuFitsSeventeenProbes`.
  - :148 test sheet mới (lead-only cho muộn/sớm qua route, Root duyệt bước cuối, ledger 1, counter 1) + `TestTheLeadThenTheCooApproveWithTheEffects`, `TestTheChainIsLeadOnlyForLateAndEarly`.
  - :201 `TestAnApprovalCountsEachWfhDayInTheMonthOfThatDay`, `TestAnApprovalIsRefusedByItsEffectsWithNothingWritten` (409 không ghi qua `refusedFinal`, xác nhận trong hash 422), `TestAWfhRequestWarnsPastTheMonthLimit`, `TestAReplayAnswersTheStoredWarning`, `TestARetryAfterALockTimeoutIsACleanFirstAttempt` (replay không đổi counter), `TestApprovedWfhCountersLimitAcknowledgementAndRelease` (mặc định 4); ghi không lặp đúng chuỗi bốn đơn một ngày của TS.
  - :249 `TestAnApprovalCountsEachWfhDayInTheMonthOfThatDay` + counter `b` qua route.
  - :434 `TestAMemberSubmitsAndReadsOwnRequests` (đi muộn không có cờ), `TestAWfhRequestWarnsPastTheMonthLimit`, `TestChangedSettingsApplyToNewSubmitsAndFinalDecisions`, `TestAnApprovalCountsEachWfhDayInTheMonthOfThatDay` (nộp không ghi counter).
- attendance-concurrency :301/:344: thêm 0 deadlock/lock timeout/retry qua `OnMetric` và giới hạn của cổng `gated` (đảo hai khóa hàng không lộ; đột biến điều chỉnh đỏ ở `TestM6ACommand…/adjustment`, đảo khóa công ty/bước đọc của nghỉ việc đỏ ở kết quả).
- period :249: `40001` và thông báo tách loại.

`apps/api-go/AGENTS.md`: câu retry (r4); vị trí oracle facts trong đoạn M6; bẫy mới: dưới `gated` không có vòng chờ nên đảo thứ tự hai khóa hàng không lộ, thứ tự khóa kiểm bằng holder ở giữa.

## File đã đổi

- Test mới: `apps/api-go/internal/app/m6_sheet_integration_test.go`.
- Test sửa: `apps/api-go/internal/app/m6_race_integration_test.go` (r1–r3), `apps/api-go/internal/modules/workrequest/work_request_decision_integration_test.go` (D-04), `apps/api-go/internal/modules/employee/employee_menu_integration_test.go` (:140), `apps/api-go/internal/modules/attendancecore/attendance_facts_integration_test.go` (bỏ oracle, gọi `fixture.`).
- Fixture mới: `apps/api-go/test/fixture/attendance_oracle.go` (oracle chuyển nguyên văn, export `OracleLoadFacts`, `OracleApprovedEffectsSQL`).
- Tài liệu: `apps/api-go/contract/test-port-tracker.md`, `apps/api-go/AGENTS.md`.
- Không sửa runtime, schema, ACL, plan.
- File repo sửa bằng Edit/Write; riêng file báo cáo này chạy thêm `pnpm exec prettier --write` để căn bảng. Prettier `--check` cuối (AGENTS, tracker, báo cáo) và `git diff --check` chạy sau mọi lần sửa: exit 0.

## Quyết định tự đưa ra

- Chuyển oracle sang `test/fixture` thay vì chép lần hai vào `package app`: một nguồn câu correlated cho cả M3 và M6; `test/fixture` ngoài DAG.
- Dataset đơn bằng SQL `pending_*` rồi chuyển trạng thái qua route, giữ tháng cố định 2026-03 như TS; submit qua route không dùng được cho tháng đã qua (cửa sổ nộp theo đồng hồ DB). Submit thật có ở `TestM6RequestEffects…`, test race và workrequest.
- Test menu thêm ca deny sau khi đột biến sống sót; D-04 đặt ở `workrequest` (façade) vì counter là effect M5, cộng kiểm counter qua route ở test app.

## Bằng chứng cho Task 14 và ba checkbox Task 13 còn treo (điều phối viên quyết định tick)

- Task 14 "Làm theo mẫu…": 14a–14d đã commit; 14e lấp :35/:235/:333-close và tách tracker M6. Dòng M6 còn trống/M7 trong tracker: F-24 report (M7), :310/:333 report/XLSX/:388 (M7), oracle report (M7), `hrm-setting-behavior` :98/:181/:194 (M6, M7, CROSS report). Grep dòng nhóm `M6` trạng thái trống sau sửa: chỉ còn dòng `hrm-setting-behavior` :98/:181/:194 (`M6, M7`, cần report).
- Task 14 "canonicalSnapshot format 1 và 2…": vector Go format 1/2 ở `attendance_snapshot_helper_test.go`; stack trộn (Go close → report NestJS) ở bước close của `apps/web/e2e/attendance.e2e-spec.ts` (14d), chỉ format 2. Format 1 trên stack trộn chưa kiểm. 14e thêm: snapshot Go lưu bằng oracle trên dataset nhiều loại đơn.
- Task 13 "Làm theo mẫu… `hrm-coo-submit`": :55/:153 ở `TestM6RequestEffectsMoveTheSheetAndAClosedMonthWaitsForItsReopen` (14d, tracker dòng coo-submit); chạy lại PASS trong gate app 14e.
- Task 13 "payloadHash cả năm nơi": leave.adjust `leave_hash_test.go`, submit `work_request_hash_test.go`, decision (có `ack`) `work_request_decision_test.go` `TestTheDecisionHashIsTheBytesOfTheTypeScriptBuild`, cancel `work_request_cancel_test.go` `TestTheCancelHashIsTheBytesOfTheTypeScriptBuild`, nơi thứ năm attendance adjustment `attendance_hash_test.go` `TestTheAdjustmentHashIsTheBytesOfJSONStringify` (tiếng Việt, emoji ZWJ, null); unit chạy PASS trong `go test -race ./internal/...` 14e.
- Task 13 "Trình tự SQL chứng minh thứ tự khóa… Port test deadlock và concurrency": period :249 bằng close thật `TestM6ACommandACalendarChangeAndTheCloseOfOneMonthAllFinish/submit` (0 deadlock/timeout/retry, đột biến 14d đỏ, đột biến 14e điều chỉnh đỏ); các test lock order workrequest/cancel/leave/workschedule PASS trong gate 14e.

## Điều chưa kiểm chứng và lo ngại

- r1 không đạt nguyên văn: brief đòi "mutant đảo thứ tự khóa của một writer phải RED" ở test `gated` nhờ bộ đếm contention. Dưới `gated`, lệnh đầu đã giữ mọi khóa hàng và chỉ chờ cổng `audit_outbox`; lệnh sau chờ lệnh đầu; không có vòng chờ, nên đảo hai khóa hàng không tạo deadlock và bộ đếm không thể đỏ. Đã đo: đột biến điều chỉnh khóa lịch trước kỳ xanh ở test này (đỏ ở `TestM6ACommand…/adjustment`); đột biến nghỉ việc đọc tháng đã chốt trước khi khóa công ty đỏ ở test này nhưng do kết quả, không do bộ đếm. Bộ đếm ở test `gated` hiện là guard (bắt timeout/retry ngoài ý muốn, ví dụ lệnh đầu hết `lock_timeout` khi chờ cổng), không phải bằng chứng thứ tự khóa. Nếu cần bộ đếm đỏ với đảo khóa ở chính test này phải đổi thiết kế cuộc đua (không cổng audit, holder ở khóa giữa) — chưa làm, cần điều phối viên quyết định.
- r2: thông báo đã tách loại, nhưng rủi ro đỏ giả dưới tải vẫn còn: lệnh đầu chờ cổng `audit_outbox` chịu `lock_timeout` 1 s trong khi `blocked` chờ tối đa 3 s. Chưa thấy trong các lượt chạy 14e (load 3–6).
- :35 chưa có ca F-02 tuyển giữa tháng qua route; dataset sheet nhỏ hơn TS (hai nhân viên). Bao phủ set-based/300 nhân viên vẫn ở test facts M3.
- Test sheet dựng body mong đợi bằng `attendance.SheetView` và quy tắc `PeriodState` nil → open giống `readSheet`; nếu cả hai cùng sai cách ánh xạ state thì test không bắt (totals thì độc lập nhờ oracle SQL).
- Root duyệt bước cuối chỉ kiểm state `approved`, không kiểm audit của Root ở test này (audit Root có ở test workrequest).
- Report/XLSX sau close (:333 phần còn lại), :310, :388, format 1 trên stack trộn: M7/chưa kiểm.

## Review độc lập (điều phối viên ghi)

Reviewer opus, chỉ đọc, diff `review-t14e.diff`: **Approved**, không Critical/Important; đồng ý ruling 98 (r1). Minor hoãn (đưa vào 15a làm dọn dẹp):
- m1 tracker dòng `hrm-attendance-effects-oracle.helper.ts` chưa trỏ `test/fixture/attendance_oracle.go`.
- m2 tracker :35 ghi F-01 nhưng `m6_sheet` không neo giá trị tuyệt đối; trỏ thêm `attendance_integration_test.go` (`marchBase`) hoặc neo `ScheduledMinutes == 21*480`.
- m3 `test/fixture` nay kéo `attendancecore`/`permission`/`schedulecore`…, test nội bộ các package đó không import được `fixture`; tách `test/fixture/attendanceoracle` hoặc ghi ràng buộc vào AGENTS.
- m4 `AGENTS.md:50` thiếu `57014` phát `MetricTimeout` và ngoại lệ lần thử cuối không phát Retry.
- m5 `open` periodState chưa neo chuỗi trong `m6_sheet`.
- m6 segment WFH SQL `minutes=480` lệch `m6Request` 540 (không đổi kết quả).
- m7 rủi ro đỏ giả dưới tải của cuộc đua `gated` (như m2 của 14d).
Plan: tick Task 14 (hai checkbox) và ba checkbox Task 13 còn treo theo bằng chứng mục trên.
