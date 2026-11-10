# Báo cáo Task 15a — M7 report: kiểu, validator, helper, XLSX (unit) + dọn Minor 14e

Repo `/Users/vinhdq2312/Documents/personal/hrm`, branch `version/single-app`, HEAD `a09888e`. Không stage, không commit, không spawn. Trước khi sửa, `git status --short` chỉ có `progress.md` của người dùng; file đó không bị đụng.

## 1. Đã làm

### Package `internal/modules/report` (mới, chưa có route, chưa repository/service)

- `report_types.go`: `Kind` (6 hằng, thứ tự route), `ExportQuery{Kind, From, To, AsOn}`, `Query{ExportQuery; Limit, Offset}`, `Employee`, sáu kiểu hàng (`AttendanceRow` nhúng `attendancecore.Totals`, `LateEarlyRow`, `WfhRow`, `BirthdayRow`, `LeaveRow` có field riêng không lặp `employeeId`, `SeniorityRow` nhúng `Seniority`), ràng buộc `Row` (union đóng), `Page[R Row]{kind,total,rows}`, interface niêm phong `Result`. Thứ tự key JSON theo `report.types.ts`; trang rỗng cho `"rows":[]` (JSON v2) — ghim bằng `TestEveryReportPageHasTheShapeTheWebReads`.
- `report_validator.go`: `parseQuery(kind, rawQuery)` qua `httpapi.InputPageQuery` (key lặp sau giải mã `%`, key lạ, `limit` 1..100 grammar `^[0-9]{1,5}$` nên `1.0`/`1e2`/`+5`/`-1` là 400, offset ≤ 10000), `parseExportQuery` qua `httpapi.InputQuery` (đúng tập key, nên `limit`/`offset` ở export là 400), kind lạ là 400. Tháng qua `attendancecore.ParseMonth`, ngày qua `schedulecore.ParseDate` (1900..2100, ngày có thật). `MaxMonths = 12`.
- `report_span_helper.go`: `checkSpan(from, to, maxMonths)` — validator dùng với 12, repository 15c sẽ dùng với `report.maxMonths`.
- `report_seniority_helper.go`: `seniorityOf(hiredOn, asOn) (Seniority, error)`, `errNotEmployed` khi cutoff trước ngày vào làm (TS trả `null` rồi service ném 5xx).
- `report_xlsx_columns_helper.go`: định nghĩa cột thuần (header, width, numFmt, hàm giá trị kiểu `cellValue`) cho 6 sheet, `exportFileName`.
- `report_excel_export_service.go`: `renderXLSX(Result, ExportLimits) ([]byte, error)`, `ExportMaxRows = 5000`, `ExportMaxBytes = 5 MiB`, `XLSXMime`, `errExportTooLarge = apperror.Rejection{Code: "error.exportTooLarge"}` (mã có sẵn, 422; không thêm mã).

Quyết định tự đưa ra (lệch brief, có lý do kiểm chứng được):

1. Tên file renderer là `report_excel_export_service.go`, không phải `report_xlsx_helper.go` như brief: `test/conventions_test.go` (`helperForbiddenImports`, dòng 131–135) cấm `*_helper.go` import `github.com/xuri/excelize`, có cả ca test `"imports excelize"` (dòng 589). Tên mới khớp TS `excel-export.service.ts`. Phần thuần (cột) vẫn là helper.
2. Text dài hơn 32767 đơn vị UTF-16 bị từ chối 422 `error.exportTooLarge` trước khi ghi. Lý do: excelize v2.11.0 cắt thầm (`trimCellValue`, `cell.go:512-515`, `truncateUTF16Units`), trong khi nguyên tắc của export là "refused, never cut" (comment TS `EXPORT_MAX_ROWS`). Đây là khác biệt với ExcelJS (xem mục 4). Dữ liệu thật không chạm được: `employee.full_name` bị CHECK 1..200 ký tự.
3. `exportFileName` đặt ở helper cột (TS đặt ở service export); không đổi hành vi.

Chọn StreamWriter thay `NewFile` + `SetCellValue`: StreamWriter ghi mỗi hàng thành XML vào buffer ngay (`stream.go:388-447`), không giữ cây `xlsxC` cho từng ô; với 5000 × 15 ô đó là phần RAM lớn nhất của `NewFile`. Giới hạn: quá 16 MiB XML (`StreamChunkSize = 1<<24`) excelize ghi ra temp file (`os.CreateTemp`, `stream.go:829-836`); `File.Close` xóa file đó (`stream.go:858-866`, `file.go:90-108`), renderer luôn `defer Close`. Ca 5000 dòng tên 3 KiB ngẫu nhiên đi qua nhánh temp file. Chưa đo RAM thực tế (không benchmark theo quy ước máy).

### Minor 14e

- m1: dòng tracker `hrm-attendance-effects-oracle.helper.ts` (M3) trỏ `test/fixture/attendanceoracle/attendance_oracle.go` và hai nơi dùng.
- m2: dòng tracker `hrm-attendance.integration-spec.ts › :35` thêm đích `internal/modules/attendance/attendance_integration_test.go` (`TestTheSheetIsTheLiveMonthOfOneEmployee`, `marchBase = 22×480`). Brief ghi `21*480`; F-01 của TS là `22 * 480` (`hrm-attendance.integration-spec.ts:41`, tháng 3/2026 có 22 ngày làm việc), nên chọn phương án trỏ test, không neo giá trị mới trong `m6_sheet`.
- m3: chuyển oracle sang package `test/fixture/attendanceoracle` (`LoadFacts`, `ApprovedEffectsSQL`; file cũ xóa). `test/fixture` nay chỉ import `internal/database` và `test`. Không có vòng (oracle không import `fixture`). Sửa import ở `internal/app/m6_sheet_integration_test.go`, `internal/modules/attendancecore/attendance_facts_integration_test.go`. Ghi ràng buộc vào `apps/api-go/AGENTS.md` (đoạn M6) và `contract/package-dag.md` (mục "Ngoài khối").
- m4: `AGENTS.md` câu metric: `55P03` và `57014` phát `MetricTimeout`, `57014` không retry (503); lần thử cuối (hết `retries` hoặc quá `maxRequest`) trả `ConflictError` không phát `MetricRetry` — đối chiếu `internal/database/runner.go:200-226`, `transaction_errors.go:49-60`.
- m5: vòng so bảng công trước close trong `m6_sheet` kiểm thêm `"periodState":"open"`.
- m6: segment WFH SQL `minutes` 480 → 540, khớp `m6Request` (540..1080).

### Tài liệu

- `apps/api-go/AGENTS.md`: thêm `internal/modules/report` vào danh sách package; bẫy XLSX mới (helper không import excelize, `<f>` chỉ từ `Cell.Formula`, cắt 32767, ngày trước 1900-03-01, temp file 16 MiB, đọc lại bằng `archive/zip`).
- `contract/test-port-tracker.md`: tách `hrm-excel.spec.ts` và `hrm-report.spec.ts` thành phần đã port (port) và phần còn lại (trống: service export `:351/:360/:372/:472`; snapshot `:195/:209/:240/:250` chưa đối chiếu đủ).

## 2. Phiên bản excelize

`github.com/xuri/excelize/v2 v2.11.0`, thêm bằng `go get github.com/xuri/excelize/v2@v2.11.0` rồi `go mod tidy`. Kiểm trên `proxy.golang.org`:

- `@v/list` (bản cuối): v2.9.1, v2.10.0, v2.10.1, v2.11.0, v2.11.1.
- `v2.11.0.info`: `Time 2026-07-06T16:07:47Z`, commit `90ff348959dd842cbf3a4fbd93a78afbe18db476`.
- `v2.11.1.info`: `Time 2026-11-02T00:16:17Z` (8 ngày trước hôm nay).

Lý do chọn v2.11.0: bản minor mới nhất đã phát hành hơn 4 tháng; v2.11.1 mới 8 ngày, chưa đủ thời gian cộng đồng phát hiện lỗi/supply-chain. Không đọc được release notes v2.11.1 (GitHub API không trả nội dung), nên chưa biết nó có sửa lỗi bảo mật liên quan không — điểm cần người dùng/reviewer cân nhắc. Excelize yêu cầu Go ≥ 1.25 (`go.mod` của nó), repo dùng Go 1.27.3.

Dependency gián tiếp mới (`go.mod`): `richardlehane/mscfb v1.0.7`, `richardlehane/msoleps v1.0.6`, `tiendc/go-deepcopy v1.7.2`, `xuri/efp v0.0.1`, `xuri/nfp v0.0.2-0.20250530014748-2ddeb826f9a9`; `go.sum` thêm `golang.org/x/image v0.38.0`. Không bản nào của dependency có sẵn bị nâng. `test/imports_test.go`, depguard: không cần sửa — `helperForbiddenImports` đã cấm excelize ở helper; `moduleForbiddenDeps`, `apiForbiddenDeps` không liên quan; `go test ./test` và golangci-lint xanh. Package `report` chưa được `cmd/api` import nên binary API chưa kéo excelize (sẽ kéo ở 15e).

## 3. RED/GREEN

RED (`/private/tmp/hrm-15a-red.log`): test viết trước, implementation là stub trả giá trị zero; `go test -count=1 ./internal/modules/report/` exit 1, 15 test FAIL:
`TestEachReportIsOneSheetOfTypedCellsUnderVietnameseHeaders`, `TestAProbationRowLeavesTheRateCellEmpty`, `TestDatesBeforeMarch1900AreTheDaysExcelShows`, `TestTextThatLooksLikeAFormulaStaysText`, `TestALongTextIsKeptWholeOrRefused`, `TestTheRendererAppliesTheLoweredBudgetsNeverAboveTheCeilings`, `TestTheDefaultByteBudgetIsFiveMebibytes`, `TestNoResultIsRefusedWithoutAFile`, `TestSeniorityCountsTheHireDayAndTheCutoffDay`, `TestSeniorityIsRefusedBeforeTheHireDateOrOnABadDate`, `TestMonthlyReportsNeedAnExplicitRangeOfAtMostTwelveMonths`, `TestLeaveAndSeniorityNeedAnExplicitValidCutoff`, `TestExportQueryTakesTheReportKeysOnly`, `TestTheFileNameIsFixedByTheReportAndItsValidatedRange`, `TestTheSpanIsCheckedAgainstTheLimitInForce`.
Ngoại lệ: `TestEveryReportPageHasTheShapeTheWebReads` xanh ngay vì kiểu được viết trước để test biên dịch; nó là test ghim shape, không có RED riêng.

Giá trị kỳ vọng thâm niên ngoài bảng TS (kẹp cuối tháng, 1900/2100) lấy bằng cách chạy `seniorityOf` của `apps/api/dist/modules/report/seniority.helper.js`; lần đầu tôi đoán sai hai ca (2024-01-31→02-28 TS cho 1 tháng 0 ngày) và đã sửa test theo output TS trước khi implement.

GREEN (`/private/tmp/hrm-15a-green1.log`): `ok hrm/api-go/internal/modules/report 0.759s`, 16 test PASS.

Test đọc XLSX bằng `archive/zip` + `encoding/xml` (`report_xlsx_reader_test.go`), không bằng excelize: tên sheet trong `workbook.xml`, đúng một worksheet, header bold, độ rộng `<col>`, pane `ySplit=1 state=frozen topLeftCell=A2`, kiểu ô (`inlineStr`/shared string là chuỗi, không `t` là số), `numFmt` qua `cellXfs`/`numFmts`, không có `<f` trong XML thô. Header tiếng Việt và chuỗi kỳ vọng viết bằng code point `{hex}` (hàm `vi`), sinh từ chính source TS bằng script node; `LC_ALL=C grep -n '[^ -~\t]'` trên các file test mới không có kết quả.

Đột biến (`/private/tmp/hrm-15a-mutants/`, chạy bằng `go test -overlay`, log `/private/tmp/hrm-15a-mutants.log`); không đột biến nào lỗi biên dịch:

| Đột biến | Kết quả |
| --- | --- |
| a: text bắt đầu `=` ghi thành `excelize.Cell{Formula}` | đỏ: `TestTextThatLooksLikeAFormulaStaysText` |
| b1: bỏ kiểm ngân sách dòng | đỏ: `TestTheRendererAppliesTheLoweredBudgetsNeverAboveTheCeilings` |
| b2: bỏ kiểm ngân sách byte | đỏ: hai test ngân sách |
| b3: ngân sách byte bỏ trần 5 MiB (`limits.MaxBytes` thay `min`) | lần đầu SỐNG (test dùng limit 10 MiB, file ~11 MiB vẫn vượt); sửa test dùng limit `1<<30` → đỏ: `TestTheDefaultByteBudgetIsFiveMebibytes` |
| b4: ngân sách dòng bỏ trần 5000 | đỏ: `TestTheRendererAppliesTheLoweredBudgetsNeverAboveTheCeilings` |
| e: bỏ từ chối text > 32767 | đỏ: `TestALongTextIsKeptWholeOrRefused` |
| e2: đếm rune thay đơn vị UTF-16 | đỏ: cùng test (ca emoji) |
| c1: export đọc bằng `InputPageQuery` (nhận `limit`/`offset`) | đỏ: `TestExportQueryTakesTheReportKeysOnly` |
| c2: key lặp lấy giá trị đầu | đỏ: hai test parser |
| d1: `dd/mm/yyyy` → `dd/mm/yy` | đỏ: ba test XLSX |
| d2: cột đếm ghi thành chuỗi | đỏ: hai test XLSX |
| d3: sinh nhật `dd/mm` → `dd/mm/yyyy` | đỏ: `TestEachReportIsOneSheet…` |
| f: thâm niên không tính ngày cắt | đỏ: `TestSeniorityCountsTheHireDayAndTheCutoffDay` |

## 4. Đối chiếu ExcelJS 4.4.0 (đo thật)

Script `probe.cjs` trong scratchpad, chạy bằng `node` với `apps/api/node_modules/exceljs` (4.4.0), giải nén bằng `unzip`:

- Chuỗi 32767/32768/100000 ký tự: ExcelJS ghi nguyên vào `sharedStrings.xml` (độ dài 32767, 32768, 100000) và đọc lại nguyên. excelize cắt ở 32767 đơn vị UTF-16. Go từ chối 422 thay vì cắt (quyết định 2 ở mục 1). Khác biệt hành vi, chỉ chạm dữ liệu tổng hợp.
- Ngày 1900-01-15: ExcelJS ghi serial `16` (đọc lại bằng chính ExcelJS ra 1900-01-15, nhưng Excel hiển thị 16/01/1900 vì lỗi năm nhuận 1900); excelize ghi `15` (đúng ngày Excel hiển thị). 1900-03-01: cả hai `61`. 2026-03-01: cả hai `46082`. Validator cho phép năm 1900 nên đây là khác biệt có thể chạm (ngày vào làm/cutoff năm 1900); Go theo Excel.
- Chuỗi `=1+1`: ExcelJS là shared string (`t="s"`), không `<f>`; Go là `inlineStr`, không `<f>`. Cả hai là ô chuỗi.
- Header: ExcelJS đặt style bold cho cả hàng (`row s="1" customFormat`) và từng ô; Go đặt bold từng ô. Font bold của cả hai chỉ có `<b/>`, không tên/cỡ.
- Ô số: cả hai không `t`, style 0 (General). Ô ngày: style có `numFmtId ≥ 164` với `formatCode` tương ứng.
- Khác chưa chuẩn hóa: excelize stream ghi `<dimension ref="A1">` cố định (ExcelJS ghi vùng thật `A1:C8`); `docProps` của excelize có `Application=Go Excelize`, `creator=xuri`, ngày 2006 cố định (không có PII). Chưa kiểm Excel/LibreOffice thật mở file Go; chỉ kiểm cấu trúc XML.

Chưa thêm mục vào `contract/parity-exceptions.md` (file chưa tồn tại); hai khác biệt trên ghi ở đây và ở `AGENTS.md` để Task 15f quyết định.

## 5. Lệnh và output thật

Mọi lệnh nặng chạy riêng sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`, trong `apps/api-go`. Load 1 phút lúc chạy 3.4–5.6 (dưới ngưỡng).

| Lệnh | Kết quả |
| --- | --- |
| `go build ./...` | exit 0 (`/private/tmp/hrm-15a-build.log`) |
| `go vet ./...` | exit 0 |
| `go vet -tags integration ./...` | exit 0 |
| `go test -race -count=1 ./internal/...` | exit 0, mọi package `ok` (report 11.5 s dưới race) (`/private/tmp/hrm-15a-unit.log`) |
| `go test -count=1 ./test` | `ok hrm/api-go/test 5.229s` |
| `go tool golangci-lint run` | `0 issues.` |
| `gofmt -l .` | lượt 1 báo `report_xlsx_reader_test.go` (căn struct tag), sửa; lượt sau trống |
| `go test -tags integration -count=1 ./internal/modules/attendancecore` | `ok 11.291s` |
| `go test -tags integration -count=1 -run '^TestM6TheSheetOfRealRequestsIsTheOracleAndTheCloseStoresIt$' ./internal/app` | `--- PASS (7.67s)`, `ok hrm/api-go/internal/app 7.802s` (`/private/tmp/hrm-15a-int-m6sheet.log`) |
| `pnpm exec prettier --check` AGENTS.md, test-port-tracker.md, package-dag.md | AGENTS.md, tracker xanh; `package-dag.md` báo lỗi format, nhưng bản HEAD (`git show HEAD:…`) cũng báo cùng lỗi ở bảng mục 3 (dòng 39–77, căn cột) — có sẵn, không do dòng tôi sửa; không format lại cả file |
| `git diff --check` | exit 0; file mới không có khoảng trắng cuối dòng (`grep '[[:space:]]$'`) |

Không chạy: `go test -race ./...` toàn bộ (gồm `./test` — đã chạy riêng không `-race` theo brief), integration ngoài hai package bị m3/m5/m6 chạm, `pnpm test:browser` (brief không yêu cầu), `pnpm install --frozen-lockfile` (không đổi package npm).

## 6. File đã đổi

Mới:
- `apps/api-go/internal/modules/report/report_types.go`, `report_validator.go`, `report_span_helper.go`, `report_seniority_helper.go`, `report_xlsx_columns_helper.go`, `report_excel_export_service.go`
- `apps/api-go/internal/modules/report/report_types_test.go`, `report_validator_test.go`, `report_seniority_helper_test.go`, `report_excel_export_service_test.go`, `report_xlsx_reader_test.go`
- `apps/api-go/test/fixture/attendanceoracle/attendance_oracle.go`

Sửa: `apps/api-go/go.mod`, `apps/api-go/go.sum`, `apps/api-go/internal/app/m6_sheet_integration_test.go`, `apps/api-go/internal/modules/attendancecore/attendance_facts_integration_test.go`, `apps/api-go/AGENTS.md`, `apps/api-go/contract/test-port-tracker.md`, `apps/api-go/contract/package-dag.md`.

Xóa: `apps/api-go/test/fixture/attendance_oracle.go` (nội dung chuyển nguyên văn sang `attendanceoracle`, chỉ đổi tên hàm `OracleLoadFacts` → `LoadFacts`, `OracleApprovedEffectsSQL` → `ApprovedEffectsSQL`, `oracleAdjustmentMinutesSQL` → `adjustmentMinutesSQL`).

## 7. Chưa kiểm chứng, lo ngại

1. Từ chối text > 32767 là khác biệt với ExcelJS (ExcelJS ghi nguyên một file Excel sẽ phải sửa khi mở). Tôi chọn từ chối theo nguyên tắc "refused, never cut"; nếu người dùng muốn khác (vd. ghi nguyên như ExcelJS bằng cách tránh `trimCellValue`), cần đổi. Không chạm dữ liệu thật.
2. Ngày trước 1900-03-01 Go ghi serial khác ExcelJS 1 ngày (Go đúng theo Excel). Chưa ghi `parity-exceptions.md`.
3. Chọn v2.11.0 thay v2.11.1 chưa đối chiếu release notes v2.11.1.
4. Chưa mở file Go bằng Excel/LibreOffice thật; `<dimension ref="A1">` cố định của stream writer chưa kiểm ảnh hưởng.
5. RAM/thời gian render 5000 dòng chưa đo (chỉ thấy test 5000 dòng chạy trong ~0.5 s không race trên máy này, không phải số đo).
6. Rủi ro đỏ giả của cuộc đua `gated` dưới tải (m7 của 14e) không thuộc lát này, không xử lý.

## Vòng sửa 1

Phiên implementer trước bị ngắt giữa vòng; I1, m3 và file m4 đã có trong working tree. Phiên này kiểm lại I1, m3 (không làm lại), chạy RED/GREEN cho m4, ghi (b)(c), cập nhật tài liệu, chạy check. Không stage, không commit.

### I1 — `<col>` giảm dần

- Sửa: `report_excel_export_service.go:93-99` gọi `stream.SetColWidth` từ cột cuối về cột đầu. Lý do: excelize v2.11.0 `xlsxWorksheet.setColWidth` (`col.go:521`) gộp `<col>` mới qua `flatCols` và đặt nó trước các cột đã có, nên gọi tăng dần sinh `<cols>` giảm dần (thấy ở log RED).
- Test: `report_xlsx_reader_test.go:217-222` — mọi lần đọc lại file (`render`) kiểm `<col>` có `Min ≥ 1`, `Max ≥ Min`, và `Min` của phần tử sau lớn hơn `Max` phần tử trước (tăng dần, không chồng). Vì nằm trong hàm đọc chung nên mọi test XLSX đều giữ.
- RED (`/private/tmp/hrm-15a-r1-red.log`, renderer cũ gọi tăng dần): 6 test FAIL, vd. `report_excel_export_service_test.go:159: <col> 1 is 5..5 after [{Min:6 Max:6 Width:18}]`; dòng 159 là lời gọi `render` (helper `t.Helper()`), khớp file hiện tại. GREEN (`/private/tmp/hrm-15a-r1-green.log`): `ok hrm/api-go/internal/modules/report 0.862s`.

### m3 — `<dimension ref="A1">`

- Sửa: `report_excel_export_service.go:74-81` `SetSheetDimension(name, "A1:"+last)` trước `NewStreamWriter`, vì StreamWriter chép `<dimension>` lúc tạo và không cập nhật.
- Test: `report_excel_export_service_test.go:188-190` so `Dimension.Ref` với `A1:<cột cuối><số hàng + 1>` cho cả 6 sheet.
- RED (`/private/tmp/hrm-15a-r1-dim-red.log`): `report_excel_export_service_test.go:189: birthday: dimension "A1", want "A1:D2"` (và 5 sheet còn lại). GREEN (`/private/tmp/hrm-15a-r1-dim-green.log`): `ok hrm/api-go/internal/modules/report 0.680s`.

### m4 — `test/fixture` là lá

- File mới `apps/api-go/test/fixture_leaf_test.go`: `checkFixtureLeaf` trên `go list ./...` (`listPackages` có sẵn) cho phép `test/fixture` import trong module chỉ `internal/database` và `test`; `TestTheFixtureImportsNoModule` chạy trên repo thật, `TestCheckFixtureLeaf` 6 ca bảng (gồm subpackage `attendanceoracle` bị cấm import ngược và được tự do import module).
- RED bằng đột biến ngoài repo: `/private/tmp/hrm-15a-mutants/leaf.go` (`package fixture; import _ "hrm/api-go/internal/modules/hrbase"`) thêm vào `test/fixture` qua overlay `/private/tmp/hrm-15a-mutants/leaf.json`, chạy `GOFLAGS=-overlay=… go test -count=1 -run TestTheFixtureImportsNoModule ./test` (GOFLAGS để `go list` con cũng thấy overlay). Log `/private/tmp/hrm-15a-r1-leaf-red.log`:
  ```
  --- FAIL: TestTheFixtureImportsNoModule (0.33s)
      fixture_leaf_test.go:35: violations:
          test/fixture imports internal/modules/hrbase
  FAIL	hrm/api-go/test	0.381s
  ```
- GREEN (`/private/tmp/hrm-15a-r1-leaf-green.log`, `go test -count=1 -v -run Fixture ./test`): `TestTheFixtureImportsNoModule` PASS, `TestCheckFixtureLeaf` 6/6 PASS, `ok hrm/api-go/test 0.255s`.
- Tài liệu trỏ tới test: `AGENTS.md` (đoạn M6), `contract/package-dag.md:143`.

### Ruling 99 (b)(c) — nơi ghi khác biệt

`parity-exceptions.md` KHÔNG được tạo. ADR-22 mục 3 (Accepted, quyết định người dùng) ghi rõ "Bỏ … `contract/vectors/`, `contract/parity-exceptions.md`"; ADR-20 mục 4/7 nhắc file này thuộc phần ADR-22 thay thế (dòng đầu ADR-22: thay "đoạn 'Khi hai runtime khác nhau'" và dòng `contract/` "output exporter, parity-exceptions.md"). Theo chỉ dẫn "ADR quy định khác thì theo ADR", hai khác biệt ghi ở `apps/api-go/AGENTS.md` (bẫy XLSX) và `contract/test-port-tracker.md` (dòng `hrm-excel.spec.ts`), là hai tài liệu ADR-22 giữ:

- (b) Text ô > 32767 đơn vị UTF-16 → 422 `error.exportTooLarge` (mã có sẵn trong `contract/api-errors.json` và `apperror`, không thêm mã). Symbol: `rowValues`/`utf16Units`/`maxCellUnits` trong `report_excel_export_service.go`. Test: `TestALongTextIsKeptWholeOrRefused`. Lý do: excelize cắt thầm chuỗi dài hơn giới hạn ô (`trimCellValue`), tức mất dữ liệu âm thầm; ExcelJS 4.4.0 ghi nguyên. Tác động: export có ô như vậy từng thành công ở NestJS nay là 422; dữ liệu thật bị CHECK chặn dưới ngưỡng (`full_name` 1..200).
- (c) Ngày trước 1900-03-01: Go ghi serial đúng theo Excel (1900-01-15 → 15), ExcelJS ghi 16. Symbol: nhánh `cellDate` của `rowValues` (excelize `Cell{Value: time.Time}`). Test: `TestDatesBeforeMarch1900AreTheDaysExcelShows`. Tác động: ô ngày năm 1900 trước tháng 3 hiển thị khác file NestJS một ngày (Go đúng ngày lưu).

Nếu điều phối viên vẫn muốn một file riêng thì đó là đảo ADR-22 mục 3, cần người dùng chốt.

### Tài liệu

- `apps/api-go/AGENTS.md`: bẫy XLSX thêm tên test của (b)(c), câu ADR-22 bỏ `parity-exceptions.md`; bẫy mới: `StreamWriter.SetColWidth` gọi từ cột cuối về đầu, `SetSheetDimension` trước `NewStreamWriter`. Đoạn M6 trỏ `test/fixture_leaf_test.go`.
- `contract/test-port-tracker.md`: dòng `hrm-excel.spec.ts` thêm `<col>` tăng dần không chồng, `<dimension>` đúng vùng.
- `contract/package-dag.md:143`: trỏ `TestTheFixtureImportsNoModule`.

### Check (trong `apps/api-go`, mỗi lệnh riêng sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`, load 1 phút 4.2–5.7)

| Lệnh | Kết quả |
| --- | --- |
| `go build ./...` | exit 0 (`/private/tmp/hrm-15a-r1-build.log`) |
| `go vet ./...` | exit 0 (`/private/tmp/hrm-15a-r1-vet.log`) |
| `go vet -tags integration ./...` | exit 0 (`/private/tmp/hrm-15a-r1-vet-int.log`) |
| `go test -race -count=1 ./internal/...` | exit 0, mọi package `ok`, `report 10.320s` (`/private/tmp/hrm-15a-r1-unit.log`) |
| `go test -count=1 ./test` | `ok hrm/api-go/test 4.946s` (`/private/tmp/hrm-15a-r1-test.log`) |
| `go tool golangci-lint run` | `0 issues.` (`/private/tmp/hrm-15a-r1-lint.log`) |
| `gofmt -l .` | trống, exit 0 |
| `pnpm exec prettier --check` AGENTS.md, test-port-tracker.md, package-dag.md, task-15a-report.md | chỉ `package-dag.md` báo; prettier trên bản HEAD báo đúng cùng hai vùng (dòng 39–77, 79–81, bảng có sẵn), không do dòng tôi sửa; không format cả file |
| `git diff --check` | exit 0 |

Không chạy lại integration (vòng sửa không đổi file integration).

### Minor ghi nhận, không sửa

- m1: helper `vi("{hex}")` thay `string(rune(0x…))` — chấp nhận (file test vẫn chỉ ASCII, cùng cơ chế tránh công cụ giải mã escape).
- m5: đọc changelog/advisory excelize bản mới hơn v2.11.0 (v2.11.1 trở lên) trước cutover.
- m6: ký tự điều khiển trong text thành U+FFFD — chỉ ghi nhận.
- Mở file mẫu bằng LibreOffice/Excel thật ở gate 15c (vòng này vẫn chỉ kiểm cấu trúc XML).

### File đã đổi (cập nhật mục 6)

Thêm so với mục 6: mới `apps/api-go/test/fixture_leaf_test.go`; `report_excel_export_service.go`, `report_excel_export_service_test.go`, `report_xlsx_reader_test.go` (I1, m3); `apps/api-go/AGENTS.md`, `contract/test-port-tracker.md`, `contract/package-dag.md` (tài liệu vòng sửa). Không tạo `parity-exceptions.md` (xem trên). Đột biến chỉ ở `/private/tmp/hrm-15a-mutants/leaf.{go,json}`.

## Re-review delta vòng sửa 1 (điều phối viên ghi)

Reviewer độc lập (opus), diff `review-t15a-r1.diff`: **Approved**. I1, m3, m4, ruling 99 (b)(c) đều ADDRESSED; reviewer tự chạy mutant overlay cho `<col>` và `<dimension>`, cả hai đỏ.

Minor hoãn (không chặn):

- m-a: AGENTS/tracker chưa nêu tác động của (b)(c): dữ liệu qua CHECK của `employee` (`full_name` ≤ 200, `hired_on >= 1950-01-01`) không chạm được hai nhánh; nới CHECK thì export từng thành công thành 422 / ô ngày lệch một ngày so với file NestJS. Bổ sung khi chạm tài liệu ở 15c.
- m-b: ruling 99 trong `progress.md` có lý do cũ "Excel không mở được" và nơi ghi `parity-exceptions.md`; đã đính chính bằng ruling 100.
- m-c: `TestTheFixtureImportsNoModule` không thấy file `//go:build integration` trong `package fixture` (hiện không có file nào như vậy).
- Từ lượt 1: m1 helper `vi("{hex}")` chấp nhận; m5 đọc changelog/advisory excelize bản mới trước cutover; m6 ký tự điều khiển → U+FFFD chỉ ghi nhận; mở file mẫu bằng LibreOffice/Excel ở gate 15c.
