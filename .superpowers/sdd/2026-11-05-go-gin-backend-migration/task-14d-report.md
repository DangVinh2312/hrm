# Báo cáo Task 14d — concurrency chéo module M6, stack trộn Go close → report NestJS, phủ còn thiếu

Trạng thái: DONE_WITH_CONCERNS (chưa review độc lập). Base `8cf5e73`; không stage/commit/push. Không đổi runtime Go/NestJS, schema, ACL, identity, mã lỗi, OpenAPI, DAG. Không phát hiện lỗi runtime trong M5/M6 khi chạy các cuộc đua, nên không có bug fix.

## Thay đổi

- `apps/api-go/internal/app/m6_race_integration_test.go` (mới), chỉ dùng route Go thật qua handler của app:
  - Helper: `blocked` (đếm backend `product_data` có `pg_blocking_pids`, 3 s), `held` (transaction superuser giữ một khóa; lệnh i+1 chỉ bắt đầu khi i+1 backend đang chờ; không tới được thì rollback và fail), `gated` (`LOCK TABLE audit_outbox IN SHARE MODE`: lệnh đầu chạy tới bước append audit với mọi khóa hàng còn giữ), `call`, `closeMonth`, `reopenMonth`, `stored` (entry snapshot của nhân viên), `live` (GET bảng công), `m6Member`, `m6Request` (SQL như `fixtureRequest`), `m6Days`.
  - `TestM6TheCloseRacingEveryWriterKeepsTheSnapshotEqualToTheSheet`: 9 writer × 2 thứ tự tất định (writer trước / close trước): duyệt cuối WFH, duyệt cuối phép năm, hủy approved WFH, hủy approved phép năm, nộp WFH, điều chỉnh công, đổi ngày lịch, nghỉ việc, tuyển. Writer trước: writer 2xx; close trước: writer 409 `error.periodClosed`. Mọi vòng: close 200, entry snapshot của nhân viên (cả người vừa tuyển) bằng bảng công sống, `calendarVersion` của snapshot bằng version lịch hiện tại, tuyển bị từ chối không để lại employee; reopen giữa các vòng.
  - `TestM6ACommandACalendarChangeAndTheCloseOfOneMonthAllFinish` (period :249 và adjust F-31 :646): kỳ có dòng trước; holder `work_calendar FOR UPDATE`; submit (hoặc điều chỉnh) chờ ở lịch, close chờ kỳ, đổi lịch chờ holder; nhả ra: lệnh đầu 201, close 200, đổi lịch 200 hoặc 409 `error.periodClosed`; state closed và `calendarVersion` bằng version lịch cuối (Minor M4 của 14b); snapshot của nhân viên bằng bảng công, có 30 phút ở nhánh điều chỉnh.
  - `TestM6CompetingTransitionsOfOneMonthMoveItOnce`: close/close (200/409), reopen/reopen (200/409), close rồi reopen đang chờ (200/200); state/version/số event sau mỗi vòng, lịch sử `close2,reopen3,close4,reopen5`.
  - `TestM6EmploymentChangesInAClosedMonthWaitForItsReopen` (period :67): tuyển 2026-02-10/2026-01-26, chính thức 2026-02-20/02-02, nghỉ việc 2026-02-20/02-02/01-30 trong/trước tháng 2026-02 đã chốt đều 409 `error.periodClosed` không đổi state; tuyển/nghỉ việc tháng 3 qua; bảng công tháng 2 bằng snapshot; reopen thì cả ba qua.
  - `TestM6RequestEffectsMoveTheSheetAndAClosedMonthWaitsForItsReopen`: COO nộp đi muộn được duyệt lúc nộp, bảng công `lateCount` 1 (coo-submit :55); close thật, COO nộp WFH 409 không ghi, reopen, nộp lại approved, `wfhDays` 1 (:153); duyệt WFH/nghỉ không lương/đi muộn đổi bảng công, hủy cả ba trả về bảng công ban đầu, counter 0 (cancel :213/:232, chưa có về sớm); phép năm approved trong tháng đã chốt: hủy 409 không ghi, ledger 1, reopen rồi hủy 200, ledger 2 (:253).
- `apps/api-go/internal/app/m6_matrix_integration_test.go` (`TestM6PeriodTransitionsOverHTTP`): M5 của 14c, Root session không fresh bị 403 ở close và reopen (state không đổi); M4 của 14c, reopen bị audit lỗi trả 503 và rollback (thêm close tháng trước trigger), close 503 chuyển sang tháng 2019-07.
- `apps/api-go/internal/app/m5b_matrix_integration_test.go` (`TestM5ARootRetryIsAuditedOnItsEmployeeAndAnIAMRetryIsNot`): M3 của 14c, thêm dòng "attendance adjust": Root replay qua HTTP có đúng một `access.employee.adjustAttendance` có target là nhân viên, IAM replay không audit và không đổi state.
- `apps/api-go/internal/modules/attendance/attendance_adjust_integration_test.go`: `TestTheAttendanceTablesRefuseOtherLoginsAndImpossibleRows` (F-29 CHECK cột, :453): login data không xóa/sửa `wfh_month_counter`; authority/identity/sync không đọc bốn bảng attendance (42501); CHECK kỳ không phải ngày 1, closed thiếu snapshot, open có snapshot, counter âm, reopen thiếu reason (23514), counter của employee lạ (23503); entry hợp lệ ghi được, 11 entry sai biên (phút 0/±1441, reason rỗng/301/xuống dòng, reference rỗng/65/xuống dòng, ngày 1899-12-31/2101-01-01) đều 23514.
- `apps/web/e2e/attendance.e2e-spec.ts`: bước close/reopen, sau khi Go chốt `2026-03` (có điều chỉnh 90 phút), gọi `GET /api/hr/reports/attendance` (route còn proxy sang NestJS thật trong stack Go+NestJS+PostgreSQL của Playwright) và `GET` bảng công Go của ATT001; yêu cầu cả hai 200 và 12 trường (`periodState` cùng 11 tổng) bằng nhau, `periodState` closed, `adjustmentMinutes` 90.
- `apps/api-go/contract/test-port-tracker.md`: tách và điền từng ca (xem mục Tracker).
- `apps/api-go/AGENTS.md`: câu M6 về test chéo và stack trộn; hai bẫy (cổng `audit_outbox` SHARE và runner retry che deadlock; `fixture.Employee` không có kỳ trạng thái nên nghỉ việc/chính thức 409 `error.conflict`).
- `docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md`: ghi chú 14d dưới Task 14, không tick.

## Quyết định tự đưa ra

1. Thay random order của TS (`raced`) bằng hai thứ tự tất định qua cổng `audit_outbox` SHARE. Lý do: mỗi thứ tự là một ca xác định, mutant bỏ khóa đỏ chắc chắn; TS `racedInOrder` cũng dùng cùng tư tưởng. Ca :249/F-31 giữ đúng hình TS (holder lịch).
2. Kiểm "không trôi" bằng một bất biến chung: entry snapshot = bảng công sống của nhân viên bị ghi, cộng `calendarVersion` = version hiện tại. Không so `created_at` của đơn với thời điểm close như TS :206.
3. Duyệt cuối do `hr` (COO của world M5c); đơn chờ duyệt dựng bằng SQL như TS. Tháng race là tháng của ngày làm việc gần nhất ≤ hôm nay theo đồng hồ DB (cửa sổ submit), như TS.
4. Stack trộn dùng hạ tầng Playwright hiện có (Go binary trước NestJS dist thật, PostgreSQL testcontainers), không viết fixture chạy NestJS từ Go.

## RED/GREEN

Test mới là test port/hành vi trên code đã có; không có implementation mới để TDD. Bằng chứng nhạy là mutant hành vi qua `go test -overlay` / `go build -overlay` ngoài repo, `/private/tmp/hrm-14d-mutants/` (bản sao sinh bằng `perl -0pe`, file repo không sửa). Cả năm đỏ do assertion, không có compile failure.

| Mutant                | Thay đổi                                                                                    | Lệnh                                                                                  | Kết quả                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| close-no-for-update   | bỏ `FOR UPDATE` khi khóa kỳ ở close/reopen                                                  | `./internal/app -run TestM6TheCloseRacing`                                            | exit 1: sáu nhánh writer trước đỏ (duyệt WFH/phép, hủy WFH/phép, điều chỉnh, ngày lịch): snapshot thiếu effect so với bảng công, ngày lịch còn `snapshot calendar 1, final 2`; `hrm-14d-mutant-close-no-for-update.log` |
| effect-no-period      | `ApplyApprovedAttendance` bỏ `AssertPeriodsOpen` (duyệt và hủy approved không khóa/kiểm kỳ) | như trên                                                                              | exit 1: tám nhánh duyệt/hủy đỏ ở cả hai thứ tự; close trước thì writer trả 200 thay vì 409; `hrm-14d-mutant-effect-no-period.log`                                                                                       |
| submit-calendar-first | submit lấy `work_calendar FOR SHARE` trước kỳ                                               | `./internal/app -run TestM6ACommand`                                                  | exit 1: close không còn chờ kỳ, "never in flight together", submit 409 `error.periodClosed`; nhánh adjustment đỏ dây chuyền vì tháng còn chốt; `hrm-14d-mutant-submit-calendar-first.log`                               |
| root-no-fresh         | `freshAuthentication` = true với Root                                                       | `./internal/app -run TestM6PeriodTransitionsOverHTTP`                                 | exit 1: Root stale close/reopen 200; `hrm-14d-mutant-root-no-fresh.log`                                                                                                                                                 |
| snapshot-wrong-month  | close ghi snapshot với `month` `1999-01` (hash khớp bytes)                                  | `go build -overlay … -o dist/ ./...` rồi `playwright test e2e/attendance.e2e-spec.ts` | exit 1: report NestJS 503 (reader `verifiedSnapshot` từ chối), 1 failed 4 passed; `hrm-14d-mutant-snapshot-wrong-month.log`. `dist/api` sau đó được build lại bởi `pnpm test:browser`                                   |

Không có mutant cho test schema F-29/:453 (kiểm ràng buộc DB có sẵn, không có code Go tương ứng).

Lượt chạy bị loại/sửa test: lượt focused đầu (`hrm-14d-app-focused.log`) đỏ ở hai test mới do fixture: nghỉ việc trên `fixture.Employee` trả 409 `error.conflict` (không có kỳ trạng thái), và segment nghỉ không lương/đi muộn dựng sai độ dài (480/540 phút thay vì 240/60). Sửa fixture (tạo hồ sơ qua route; độ dài segment theo kind), lượt sau xanh (`hrm-14d-app-focused-r2.log`). Không phải lỗi runtime.

## Lệnh và kết quả

Trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng sau `waitload.sh`. Load 5–26 (dưới ngưỡng 40).

| Lệnh                                                                                                                           | Kết quả / log                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `go test -race -tags integration -count=1 -p 1 ./internal/app -run 'TestM6TheCloseRacing\|TestM6ACommand\|TestM6Competing' -v` | 0, 18.050s; `hrm-14d-race-r1.log`                                                                                                    |
| `go test … ./internal/app -run 'TestM6\|TestM5ARootRetry' -v`                                                                  | 1 (hai test fixture, xem trên); `hrm-14d-app-focused.log`                                                                            |
| `go test … ./internal/app -run 'TestM6EmploymentChanges\|TestM6RequestEffects' -v`                                             | 0, 13.704s; `hrm-14d-app-focused-r2.log`                                                                                             |
| `go build ./...`                                                                                                               | 0, 3s; `hrm-14d-build.log`                                                                                                           |
| `go vet ./...`                                                                                                                 | 0; `hrm-14d-vet.log`                                                                                                                 |
| `go vet -tags integration ./...`                                                                                               | 0; `hrm-14d-vet-integration.log`                                                                                                     |
| `go test -race -count=1 ./internal/...`                                                                                        | 0, 14s; `hrm-14d-unit.log`                                                                                                           |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/attendance`                                                  | 0, 50s; `hrm-14d-int-attendance.log`                                                                                                 |
| `go test -race -tags integration -count=1 -p 1 ./internal/app`                                                                 | 0, 119s; `hrm-14d-int-app.log`                                                                                                       |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/workrequest`                                                 | 0, 113s; `hrm-14d-int-workrequest.log`                                                                                               |
| `go tool golangci-lint run`                                                                                                    | lượt 1 exit 1 (gofmt căn cột map trong test F-29), sửa bằng Edit; lượt 2 exit 0, 0 issues; `hrm-14d-lint.log`, `hrm-14d-lint-r2.log` |
| `go test -count=1 ./test`                                                                                                      | 0, 7s; `hrm-14d-test.log`                                                                                                            |
| `gofmt -l .`                                                                                                                   | lượt 1 một file (như lint), sau sửa rỗng                                                                                             |
| root `pnpm test:browser`                                                                                                       | xem mục Browser                                                                                                                      |
| root `pnpm exec prettier --check` AGENTS Go, plan, e2e spec                                                                    | 0 (e2e lượt đầu cần ngắt dòng, sửa)                                                                                                  |
| root `pnpm exec eslint apps/web/e2e/attendance.e2e-spec.ts`                                                                    | lượt đầu 3 lỗi `format/function-spacing`, sửa, sau đó 0                                                                              |
| root `git diff --check`                                                                                                        | 0                                                                                                                                    |

Sửa gofmt chỉ đổi khoảng trắng trong file test integration attendance; integration attendance không chạy lại sau sửa (vet/lint/gofmt chạy lại). Sửa Prettier/ESLint của e2e chỉ đổi khoảng trắng/dòng trống.

## Browser

- Root `pnpm test:browser` (build lại binary Go thật, rồi Playwright): exit 0, 30 passed (3.8m), không failed/flaky; `hrm-14d-browser.log`. Lượt này bắt đầu trước khi tôi sửa khoảng trắng/dòng trống của e2e spec theo Prettier/ESLint.
- Chạy lại riêng `pnpm exec playwright test -c e2e/playwright.config.ts e2e/attendance.e2e-spec.ts` trên bản spec cuối: exit 0, 6 passed (44.4s); `hrm-14d-browser-attendance-r2.log`.
- `pnpm --filter @hrm/web run typecheck` (app + e2e): exit 0; `hrm-14d-web-typecheck.log`.

## Tracker

Đã điền: adjust :508 F-29 CHECK, :646 F-31 (tách khỏi :399 F-24 còn M7); attendance-concurrency :301/:344; `hrm-attendance.helper.ts` (thay bằng); `hrm-attendance` :280 (ghi thêm Root stale và reopen 503 qua HTTP), :280 nộp/duyệt/đổi lịch trong tháng đã chốt, :453; cancel-concurrency :144; cancel :213/:232/:253; coo-submit :55/:153; period-concurrency :67, :143/:174/:206, :249 (dòng "toàn file" trống được thay bằng ba dòng từng ca).

Còn trống, không tuyên bố: `hrm-attendance` :35/:148/:201/:249/:434/:31/:140 (bảng công qua đơn thật theo từng ca); effects-equivalence :235 (sheet theo oracle facts) và :310/:333/:388 (report/XLSX/close quy mô, M6/M7); F-24 report (M7); oracle report (M7); `hrm-setting-behavior` :98/:181/:194 (M6/M7).

## Điều chưa kiểm chứng và lo ngại

- (Đã sửa ở vòng sửa 1, I1.) Bản đầu không đo deadlock/lock timeout và ghi sai rằng app không có hook metric; `RunnerOptions.OnMetric` có sẵn, nay ca :249/F-31 đếm qua nó.
- Cổng `audit_outbox` SHARE và holder phụ thuộc `lock_timeout` 1 s của runner: máy rất tải có thể làm lệnh đầu hết hạn và retry, test có thể đỏ giả (chưa thấy).
- Stack trộn chỉ kiểm snapshot format 2 do Go vừa ghi, một tháng, một nhân viên có điều chỉnh qua report trang đầu; format 1 lịch sử, phạm vi (employee ngoài scope), snapshot hỏng hash do dữ liệu (không qua mutant) chưa kiểm trên stack trộn. Report/export thuộc M7.
- (Đã sửa ở vòng sửa 1.) Bản đầu thiếu về sớm (:232).
- Ca :206 không so `created_at` của đơn với thời điểm close.
- Mutant snapshot-wrong-month build vào `apps/api-go/dist/` (gitignored); `pnpm test:browser` sau đó build lại binary thật.
- Ghi chú plan Task 13 (thứ tự khóa/concurrency, `hrm-coo-submit`) chưa cập nhật; điều phối viên quyết định khi tick.

## Vòng sửa 1

Review độc lập: Needs fixes (I1, m1, ca về sớm, m3, m4, m5). Không làm I2 (14e).

- I1: `internal/app/app.go` thêm field `steps.runner database.RunnerOptions`, `authRoutes` dùng nó thay `RunnerOptions{}`; product để zero nên runner giữ nguyên giới hạn (thay đổi duy nhất ngoài test, không đổi semantics). `newM1World`, `newM5bWorld`, `newM5cWorld` nhận thêm `edits ...func(*steps)` (caller cũ không đổi). `m6Contention` gắn `OnMetric`, đếm `MetricDeadlock`/`MetricTimeout`/`MetricRetry`; `TestM6ACommandACalendarChangeAndTheCloseOfOneMonthAllFinish` yêu cầu 0 trong lúc đua. Sửa claim "không có hook metric" ở report, tracker (:249, F-31), AGENTS.
- m1: `m6Writes` (đơn + version, quyết định, tổng counter WFH, ledger, điều chỉnh, claim, employee + version, kỳ trạng thái, version lịch, audit trừ `hr.attendance-period.close`). Close trước: không đổi cho mọi writer; writer trước: phải đổi. Bảng công của nhân viên đo trước cuộc đua: writer trước phải khác (trừ submit pending và hire), close trước phải giống; snapshot không được toàn số 0. Comment test và tracker :47 viết lại cho khớp.
- Về sớm: `m6Request` thêm `early-departure` (segment 1020–1080 theo `schedulecore.EarlySegment` trên khung kết thúc 1080); `TestM6RequestEffects…` duyệt rồi hủy cả về sớm, `earlyCount` 1 rồi về như trước. Tracker :75 sửa theo.
- m3: closure `hire` dùng `t` của chính nó. m4: câu AGENTS "không dùng được làm lệnh đầu". m5: CHECK reason của event reopen: rỗng và 1001 ký tự 23514, 1000 ký tự ghi được (đối chứng); không so tên constraint.

RED/GREEN (overlay `/private/tmp/hrm-14d-mutants/`, cả hai exit 1 do assertion):

| Mutant               | Thay đổi                                             | Test đỏ                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| close-locks-calendar | close đọc version lịch `FOR SHARE` (sau khi khóa kỳ) | `TestM6ACommand…` cả hai nhánh: "2 deadlocks, lock timeouts or retries in the race", kết quả HTTP vẫn đúng (đúng hiện tượng reviewer nêu); `hrm-14d-mutant-close-locks-calendar.log`  |
| adjust-no-period     | điều chỉnh bỏ `AssertPeriodsOpen`                    | `TestM6TheCloseRacing…/adjustment`: close trước thì writer 201, `writes … -> …` đổi, bảng công đổi; writer trước thì snapshot thiếu điều chỉnh; `hrm-14d-mutant-adjust-no-period.log` |

Lượt GREEN đầu sau sửa (`hrm-14d-fix1-green.log`) đỏ ở guard mới của tôi: kiểm `ScheduledMinutes == 0` sai khi nghỉ việc rơi vào ngày đã thành ngày lễ ở vòng lịch (chỉ còn phút ngày lễ). Đổi thành "không toàn số 0"; lượt sau xanh (`hrm-14d-fix1-green-r2.log`). Không phải lỗi runtime.

Gate (apps/api-go, sau `waitload.sh`, load 4–8): `go build ./...` 0; `go vet ./...` 0; `go vet -tags integration ./...` 0; `go test -race -count=1 ./internal/...` 0 (15s); `go test -race -tags integration -count=1 -p 1 ./internal/app` 0 (90s, full); `./internal/modules/attendance` 0 (37s); `go tool golangci-lint run` 0 issues; `go test -count=1 ./test` 0; `gofmt -l .` rỗng. Log `/private/tmp/hrm-14d-fix1-*.log`. Root: Prettier Markdown đổi và `git diff --check` xem cuối mục. Không chạy lại browser: e2e không đổi; `app.go` chỉ đổi nguồn options của runner, product truyền zero như trước.

## Re-review delta vòng sửa 1 (điều phối viên ghi)

Reviewer độc lập (opus, chỉ đọc, diff `review-t14d-fix1.diff` dựng từ HEAD + `review-t14d.diff` so với working tree): **Approved**. I1, :232, m1, m3, m4, m5 đều ADDRESSED; `app.go` an toàn (product để `steps.runner` zero, `NewRunner` chỉ hạ giới hạn, field unexported, chỉ test `app` gắn `OnMetric`). Minor hoãn (đưa vào 14e):
- r1: `TestM6TheCloseRacingEveryWriterKeepsTheSnapshotEqualToTheSheet` (cổng `gated`) chưa gắn `m6Contention`, nên writer/close khóa ngược thứ tự vẫn xanh nhờ retry (rủi ro dự kiến, chưa thấy ca thật).
- r2: assertion 0 retry có thể đỏ giả khi tải cao (`lock_timeout` 1 s so với `blocked` 3 s); thông báo không tách deadlock/timeout/retry.
- r3: guard `live == (m6Totals{})` yếu; kiểm thật ở `moved`.
- r4: `AGENTS.md:99` và tracker dòng 97 thiếu mã retry `40001`.
Minor review lượt 1 còn lại: m2 (flaky dưới tải) gộp với r2.
