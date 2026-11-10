# Brief Task 15a — M7 report: types, validator, helper, XLSX (unit) + dọn Minor 14e

Đọc `implementer-rules.md` (ràng buộc của người dùng), `task-15-map.md` (bản đồ M7, đặc biệt mục 1, 2, 4, 5, 6, 7 và rủi ro), AGENTS root, `apps/api-go/AGENTS.md`, `contract/package-dag.md`, `contract/test-port-tracker.md`, plan Task 15 (`docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md`, mục "Task 15" và "Mẫu cho mỗi nhóm có chuyển route"). Trả lời và viết báo cáo tiếng Việt có dấu. Không stage/commit/spawn.

## Phạm vi 15a (unit, không DB, chưa route)

Lát 15a+15b của bản đồ (ruling 97 gộp):
1. Package đích theo `package-dag.md` (bản đồ mục 6): `report_types.go`, `report_validator.go` (parser query: tháng, năm, khoảng, `limit`/cursor, key thừa/lặp, `limit` không được ở export), helper thuần (span, seniority, …) — test bảng ĐỎ TRƯỚC từ `hrm-report.spec.ts` phần parser/seniority và các ca `hrm-excel.spec.ts` thuần.
2. Renderer XLSX `report_xlsx_helper.go` bằng `github.com/xuri/excelize/v2`: thêm bằng `go get` với phiên bản cụ thể đã kiểm trên proxy.golang.org (ghi phiên bản, ngày phát hành, lý do chọn; không dùng `@latest` trong ghi chép), `go mod tidy`, cập nhật `test/imports_test.go`/depguard nếu cần (ghi lý do). Parity theo ô với ExcelJS của TS: tên sheet, header tiếng Việt (viết bằng `string(rune(0x...))` trong test), kiểu ô, `numFmt`; chuỗi bắt đầu bằng `=` vẫn là chuỗi (kiểm XML thô trong zip, không chỉ đọc lại bằng excelize); chuỗi rất dài (đối chiếu hành vi ExcelJS, giới hạn 32767); ngân sách 5000 dòng và 5 MiB (vượt trả lỗi ngân sách để service map 422 — dùng mã lỗi hiện có, không thêm mã). Chọn StreamWriter hay NewFile có lý do (RAM ở 5000 dòng).
3. Dọn Minor của 14e (cuối `task-14e-report.md`): m1 tracker trỏ thêm `test/fixture/attendance_oracle.go`; m2 trỏ thêm test F-01 tuyệt đối (`attendance_integration_test.go`, `marchBase`) ở dòng :35 hoặc neo `ScheduledMinutes == 21*480`; m3 tách oracle sang `test/fixture/attendanceoracle` để `fixture` lại là lá (sửa import ở `m6_sheet_integration_test.go`, `attendance_facts_integration_test.go`), nếu tách gây vòng thì ghi ràng buộc vào AGENTS; m4 `AGENTS.md` câu metric thêm `57014` → `MetricTimeout` và lần thử cuối không phát Retry (đối chiếu `internal/database/runner.go`); m5 neo `"periodState":"open"` trước close trong `m6_sheet`; m6 segment WFH SQL `minutes` khớp `m6Request`.

Không port repository/service/route ở lát này (để 15b/15c). Không đổi runtime ngoài package report mới.

## RED/GREEN

Test bảng đỏ trước implementation. Mutant overlay ngoài repo (`/private/tmp/hrm-15a-mutants/`): ít nhất (a) bỏ chặn chuỗi `=` (ghi thành formula) → đỏ; (b) bỏ kiểm ngân sách dòng/byte → đỏ; (c) validator chấp nhận `limit` ở export hoặc key lặp → đỏ; (d) sai `numFmt`/kiểu ô một cột → đỏ. Compile failure không tính.

## Check (mỗi lệnh nặng riêng, sau waitload.sh, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-15a-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration chỉ các package bị m3/m5/m6 chạm (`./internal/app` chạy riêng test `TestM6Sheet…` bằng `-run`, `./internal/modules/attendancecore`). Prettier Markdown đã đổi; `git diff --check`. Không cần `pnpm test:browser` ở lát này (chưa có route).

## Báo cáo

`task-15a-report.md` cùng thư mục: đã làm, phiên bản excelize và lý do, RED/GREEN, lệnh và output thật, file đổi, điều chưa kiểm chứng (đặc biệt hành vi ExcelJS chưa đối chiếu được).
