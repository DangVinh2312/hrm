# Brief Task 14e — đóng phần còn lại của M6 (port I2 review 14d + gate tổng)

Đọc `implementer-rules.md` (ràng buộc, không nới), `task-14-brief.md` (phạm vi M6 gốc, mục RED/GREEN và check), `task-14-map.md`, AGENTS root và `apps/api-go/AGENTS.md`, `contract/package-dag.md`, `contract/test-port-tracker.md`. 14a–14d đã commit (sáu route M6, close/reopen/điều chỉnh, ma trận, cuộc đua chéo `internal/app/m6_race_integration_test.go`). Trả lời và viết báo cáo bằng tiếng Việt có dấu. Không stage/commit/spawn.

## Phạm vi bắt buộc (tracker dòng M6 còn trống)

1. `hrm-attendance.integration-spec.ts` :35 và `hrm-attendance-effects-equivalence.integration-spec.ts` :235: bảng công qua ROUTE Go (`GET` bảng công M6) so với oracle facts (`attendancecore` oracle đã port ở `attendance_facts_integration_test.go`, `oracleLoadAttendanceFacts`/`oracleApprovedEffectsSql`/`oracleAdjustmentMinutesSql`). Dataset tối thiểu: đơn early-departure, annual và unpaid chồng phút, ngày lễ, đơn đã hủy, điều chỉnh; recompute (gọi lại) phải byte-identical. Đơn tạo/duyệt bằng route Go thật khi có thể; nếu cần SQL dữ liệu nền thì ghi rõ lý do.
2. `hrm-attendance-effects-equivalence` :333 phần close: snapshot đã lưu sau close (bytes canonical, version, hash) khớp oracle trên cùng dataset. Phần report/XLSX của :333, cùng :310 và :388 ghi M7 trong tracker.
3. `hrm-attendance.integration-spec.ts` :201/:249/:434/:140/:31/:148: trỏ tracker đúng test Go đã có (WFH counter ở M5, menu, registry, thêm early/late chỉ cần lead duyệt) với tên test cụ thể, kiểm test đó thực sự phủ claim. D-04 (hai tháng, hai counter WFH) phải có test; nếu chưa có thì viết.
4. Tách dòng tracker :35/:148/:201/:249/:434/:31/:140 thành các dòng có trạng thái thật; không ghi "port" khi chưa có test phủ.

5. Minor hoãn từ re-review 14d (xem cuối `task-14d-report.md`): r1 gắn `m6Contention` vào `TestM6TheCloseRacingEveryWriterKeepsTheSnapshotEqualToTheSheet` (world qua `newM5cWorld(t, contention.observe)`), đòi hiệu số deadlock/timeout/retry bằng 0 quanh `gated`, và có mutant đảo thứ tự khóa của một writer phải RED; r2 tách đếm/thông báo theo từng loại metric (deadlock, timeout, retry) để lỗi chỉ rõ loại; r3 thay guard `live == (m6Totals{})` bằng kiểm có nghĩa hoặc bỏ nếu `moved` đã đủ; r4 bổ sung mã retry `40001` ở `apps/api-go/AGENTS.md` (câu runner retry) và tracker dòng :249.

## RED/GREEN

Test mới phải thấy đỏ thật (ví dụ mutant qua `go test -overlay` ngoài repo, `/private/tmp/hrm-14e-mutants/`): ít nhất (a) sheet bỏ một loại effect (vd. early-departure hoặc unpaid) → test :35/:235 đỏ; (b) close lưu snapshot lệch facts (vd. bỏ điều chỉnh) → test :333 đỏ; (c) D-04 counter gộp tháng → đỏ. Compile failure không tính.

## Gate tổng (sau khi xong, mỗi lệnh nặng riêng, sau waitload.sh, `GOCACHE=/private/tmp/hrm-go-cache`, ghi log `/private/tmp/hrm-14e-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -race -tags integration -count=1 -p 1` cho từng package `./internal/modules/attendance`, `./internal/modules/attendancecore`, `./internal/modules/workrequest`, `./internal/modules/leavecore`, `./internal/modules/workschedule`, `./internal/app`; `go tool golangci-lint run`; `go test -count=1 ./test`; `gofmt -l .`. Root: `pnpm test:browser` (đầy đủ), Prettier các Markdown đã đổi, `git diff --check`. Ghi riêng mọi exit lỗi/timeout/lần chạy lại.

## Báo cáo

`task-14e-report.md` cùng thư mục (mẫu 13d/14d): test thêm, RED/GREEN, lệnh và output thật, tracker đổi, điều chưa kiểm chứng. Không tick plan; ghi bằng chứng cho Task 14 và ba checkbox Task 13 còn treo (`hrm-coo-submit` :55/:153, hash thứ năm, period :249) vào báo cáo để điều phối viên quyết định tick.
