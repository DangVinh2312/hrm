# Task 15f: báo cáo implementer

## Đã làm

- `internal/modules/report`: repository cho sáu report (chấm công, về sớm/đi muộn, WFH dùng chung `loadSheetRows`; birthday, leave, seniority), SQL chép từ TS, không ORM. `Service.Query` và `Service.Export` dùng cùng một reader và cùng action, nên JSON và export đi qua cùng AST quyền. Trang rỗng là `rows: []`.
  - Export: đọc `export.maxRows`, `export.maxBytes` và dữ liệu trong một transaction, với `Limit` bằng `maxRows`. Nếu `total > maxRows` thì 422 `error.exportTooLarge`, không cắt. Sau đó render ngoài transaction, gọi lại `Permits`, rồi giao tệp. Chỉ kiểm hủy theo ctx giữa các bước, ba lần (`gone`), và không nới deadline của runner.
  - Leave không dùng `leavecore.LoadFacts`. Facts nằm trong cùng câu SQL qua `leavecore.FactsSQL`, mỗi hàng qua `FactsOf` rồi `Balance`.
  - Tháng đã chốt: totals lấy từ snapshot đã verify, thiếu hàng thì lỗi. Tháng mở: totals tính bằng `TotalsOf`.
- `httpapi.WriteBinary` đặt Content-Type, `Content-Disposition: attachment` và Content-Length. Tên tệp rỗng hoặc có ký tự ngoài `[A-Za-z0-9._-]` bị từ chối (503) trước khi ghi byte nào. Có test đơn vị.
- Controller, http_port và wiring trong `app/authority.go`. Thêm 12 route vào `MigratedRoutes`. Trong `app_test.go`, ba chỗ dùng `/api/hr/reports/birthday` làm route còn proxy được đổi sang `/api/administration/roles` (M8, vẫn proxy).
- Test: `internal/app/m7_matrix_integration_test.go` gồm ma trận 12 route (guard `TestEveryMigratedAuthorizeRouteHasAFullMatrix` đòi, nên thêm `m7Matrix` vào guard), guard danh sách tường minh và smoke `TestM7ReportsOverHTTP`.
- Tài liệu:
  - `apps/api-go/AGENTS.md`: đoạn M7, bẫy tệp tải về và `Permits` của Root, câu Minor m-a của 15a ở bullet XLSX, đính chính câu "Report NestJS" về e2e.
  - `contract/test-port-tracker.md`: bốn dòng M7 ghi phần đã có và phần nợ, trạng thái để trống vì chưa port trọn file nào.
  - `test-debt.md`: file mới.
  - Chú thích ở `apps/web/e2e/attendance.e2e-spec.ts:323`.
- Không đổi `route-ownership.md`: file đã liệt kê 12 route M7 với `internal/modules/report`. Không đổi `package-dag.md`: cạnh `report` và `app → report` đã có, và lát này không thêm cạnh mới.

## Route

| Method | Path | Handler |
| --- | --- | --- |
| GET | `/api/hr/reports/attendance` | `report.Routes.page` (`employee.reportAttendance`) |
| GET | `/api/hr/reports/attendance/export` | `report.Routes.download` (`employee.reportAttendance`) |
| GET | `/api/hr/reports/late-early` | `page` (`employee.reportLateEarly`) |
| GET | `/api/hr/reports/late-early/export` | `download` (`employee.reportLateEarly`) |
| GET | `/api/hr/reports/wfh` | `page` (`employee.reportWfh`) |
| GET | `/api/hr/reports/wfh/export` | `download` (`employee.reportWfh`) |
| GET | `/api/hr/reports/birthday` | `page` (`employee.reportBirthday`) |
| GET | `/api/hr/reports/birthday/export` | `download` (`employee.reportBirthday`) |
| GET | `/api/hr/reports/leave` | `page` (`employee.reportLeave`) |
| GET | `/api/hr/reports/leave/export` | `download` (`employee.reportLeave`) |
| GET | `/api/hr/reports/seniority` | `page` (`employee.reportSeniority`) |
| GET | `/api/hr/reports/seniority/export` | `download` (`employee.reportSeniority`) |

## Quyết định tự đưa ra

1. **Không grant hoặc bị deny.** JSON trả 200 với trang rỗng, theo plan rỗng như danh sách team và employee. Export trả 403, vì sau khi render, `Permits` trả false. Ma trận đã kiểm cả hai ô với `none` và `denied`. Khớp brief.
2. **Ma trận M7 viết đủ ô vì guard đòi.**
   - `foreign`, `absent`, `absentEmployee` là NA vì path không có record. Ô `foreign` với actor có scope hẹp ghi vào nợ.
   - `invalid` gồm: thiếu key, key lặp, key lạ, tháng 13, from>to, span 13 tháng, tháng một chữ số, thiếu `to`, ngày 30/02, `asOn` dạng tháng. JSON thêm `limit=101` và `offset=-1`. Export thêm `limit` và `offset`, vì export không nhận hai key này.
3. **Root và bảng `employee` rỗng.** Theo code, `Permits` (menu=false) chạy `EXISTS` cả với Root, nên Root trên bảng rỗng nhận 403 ở export, giống `report.service.ts:102`. Chỉ đọc code, chưa chạy ca này.
4. **Bỏ kiểm `ctx.Err() != nil`.** Thay bằng `select` trên `ctx.Done()` (`gone`), vì `nilerr` của golangci-lint báo khi trả `nil` sau kiểm lỗi. Ngữ nghĩa không đổi.
5. **Kiểm tên tệp.** Dùng `strings.Trim(name, allowed) != ""` thay vòng `ContainsFunc`, vì staticcheck QF1001 báo.

## Lệnh và output

Mọi lệnh Go chạy trong `apps/api-go` với `GOCACHE=/private/tmp/hrm-go-cache`, sau `waitload.sh`.

| Lệnh | Kết quả | Log |
| --- | --- | --- |
| `go build ./...` | exit 0 | `/private/tmp/hrm-15f-build.log` |
| `go vet ./...` | exit 0 | `/private/tmp/hrm-15f-vet.log` |
| `go vet -tags integration ./...` | exit 0 | `/private/tmp/hrm-15f-vet-int.log` |
| `gofmt -l .` | lần đầu liệt kê `report_sheet_repository.go` (căn tag), đã sửa bằng Edit; lần sau rỗng | `/private/tmp/hrm-15f-gofmt.log` |
| `go tool golangci-lint run` | lần đầu exit 1 (3 `nilerr`, 1 QF1001), đã sửa; lần sau `0 issues.`, exit 0 | `/private/tmp/hrm-15f-lint.log` |
| `go test -race -count=1 ./internal/...` | exit 0, 34 package `ok` | `/private/tmp/hrm-15f-unit.log` |
| `go test -count=1 ./test` | exit 0, `ok hrm/api-go/test 5.118s` | `/private/tmp/hrm-15f-test.log` |
| `go test -tags integration -race -count=1 -p 1 ./internal/modules/report` | exit 0, `ok ... 11.536s` (package chưa có file integration, chỉ chạy test đơn vị) | `/private/tmp/hrm-15f-int-report.log` |
| `go test -tags integration -race -count=1 -p 1 -run 'M7\|EveryMigratedAuthorizeRoute' ./internal/app` (lượt đầu) | exit 1: smoke seniority, kỳ vọng tôi viết sai (6/1/27). `seniorityOf` tính cả ngày cắt nên ra 6/2/0, `totalDays` 2251. Đã sửa kỳ vọng, không sửa code. Ma trận 12 route và guard đều xanh ở lượt này. | `/private/tmp/hrm-15f-m7-first.log` |
| `go test -tags integration -race -count=1 -p 1 ./internal/app` | exit 0, `ok hrm/api-go/internal/app 90.082s`, không có `--- FAIL` | `/private/tmp/hrm-15f-int-app.log` |
| `pnpm test:browser` (root) | exit 0, `30 passed (2.8m)`, gồm `report.e2e-spec.ts` (report và XLSX qua Go) và bước close/report của `attendance.e2e-spec.ts` | `/private/tmp/hrm-15f-browser.log` |
| `pnpm exec prettier --check` các Markdown đã đổi và `attendance.e2e-spec.ts` | `All matched files use Prettier code style!` | |
| `git diff --check` | exit 0, không có output | |

## File đổi

- Mới:
  - `internal/modules/report/report_{sheet,birthday,leave,seniority,export}_repository.go`
  - `report_service.go`, `report_controller.go`, `report_http_port.go`
  - `internal/app/m7_matrix_integration_test.go`
  - `test-debt.md`, `task-15f-report.md`
- Sửa:
  - `internal/modules/report/report_types.go`
  - `internal/httpapi/{errors.go,errors_test.go,inventory.go}`
  - `internal/app/{authority.go,app_test.go,m1_matrix_integration_test.go}`
  - `apps/api-go/AGENTS.md`, `apps/api-go/contract/test-port-tracker.md`
  - `apps/web/e2e/attendance.e2e-spec.ts` (chỉ chú thích)
- `progress.md` đã có thay đổi từ trước lát này, tôi không sửa file đó.

## Nợ test

Xem `test-debt.md` (cùng thư mục). Gồm:

- Ô `foreign` với actor có scope hẹp.
- Oracle `:310`/`:333`/`:388`, so cả nhánh per-row và set-based.
- F-24.
- Mọi ca số liệu, snapshot, birthday, PII và cuộc đua của `hrm-report.integration-spec.ts`.
- Bảy ca của `hrm-report-export-http.integration-spec.ts`.
- Đo 5000 dòng.
- Bốn ca export của `hrm-excel.spec.ts`.
- Bốn ca snapshot của `hrm-report.spec.ts`.
- Bốn ca setting.
- Sáu mutant chưa chạy.

## Chưa kiểm chứng

- Chưa có test nào phân biệt hai nhánh per-row và set-based của `loadSheetRows`. Smoke dùng `limit` mặc định, nên chỉ đi qua nhánh per-row.
- Số liệu report chưa được so với oracle hoặc bảng công. Smoke chỉ kiểm shape, nhân viên có mặt, và thâm niên của một ca.
- Chưa có test cho tháng đã chốt (snapshot), ngân sách 422 qua HTTP, client đóng socket, hay thu hồi quyền giữa render và giao.
- Root với bảng `employee` rỗng ở export (quyết định 3): chỉ đọc code.
- Chưa chạy mutant nào trong lát này.

## Review độc lập (điều phối viên ghi)

Reviewer (opus), diff `review-t15f.diff`: **Approved**, không Critical/Important. Minor:

1. `test-port-tracker.md` dòng 45, 51, 53, 87, 125, 126 còn ghi "Cần report"/"Cần service export" dù report đã có → sửa khi trả nợ test (ghi vào `test-debt.md`).
2. `AGENTS.md` câu Root trên `employee` rỗng nhận 403 khẳng định quá nguồn → điều phối viên đã sửa thành "suy ra từ code, chưa có test"; ca này thêm vào nợ.
3. `report_service.go` nhánh `!ok` không chạm được (fail closed) → để nguyên.
