# Báo cáo Task 14a — types, validator và hash attendance

Trạng thái: XONG, review độc lập Approved (0 Critical/Important, xem mục Review cuối báo cáo). Base `eff69ac`, commit chứa báo cáo này; không push. Chỉ làm lát 14a: không route, repository, SQL, wiring app, inventory hay DAG.

## Thay đổi

- `apps/api-go/internal/modules/attendance/attendance_types.go` (mới): input `SheetQuery`, `ReopenInput`, `AdjustmentInput`, `AdjustmentQuery`; view `SheetView` (nhúng `attendancecore.Totals`, JSON v2 inline phẳng), `PeriodEvent`, `PeriodHistory`, `PeriodResult`, `AdjustmentItem`, `AdjustmentList`, `AdjustmentResult`. State dùng `attendancecore.PeriodState`. Close không có type riêng: chỉ nhận month từ path, body do `httpapi.DecodeEmptyCommand` ở 14c.
- `apps/api-go/internal/modules/attendance/attendance_validator.go` (mới): `parseMonth` (bọc `attendancecore.ParseMonth`, đổi lỗi thành `apperror.ErrInvalidRequest`), `parseSheetQuery` (month tùy chọn theo mẫu `leave.parseBalanceQuery`), `parseReopen` (`{reason}`, `httpapi.InputText` 1000), `parseAdjustment` (path id, `hrbase.ParseIdempotencyKey`, body), `parseAdjustmentQuery` (`httpapi.InputPageQuery` + month bắt buộc). Body struct `reopenBody`, `adjustmentBody`; `wholeNumber` (grammar số nguyên JSON), `optionalText` (phân biệt thiếu với `null`, từ chối `null`).
- `apps/api-go/internal/modules/attendance/attendance_adjust_command.go` (mới): chỉ `adjustmentHash`; 14b thêm lệnh vào file này.
- Tests mới: `attendance_validator_test.go`, `attendance_hash_test.go`.
- `apps/api-go/contract/test-port-tracker.md`: dòng `hrm-attendance.spec.ts › :235/:308/:354` thành `port`, ghi đích và độ lệch grammar phút. Không đổi dòng nào khác của attendance/M6.

Không đổi runtime khác, schema, quyền, contract route/OpenAPI, NestJS, web, DAG, AGENTS, progress/handoff/plan.

## Quyết định

1. Close `{}`, reopen `{reason}`, không `expectedVersion` (ruling 93); `reopenBody` chỉ có `reason`, test từ chối `{"reason":"x","expectedVersion":"1"}`. Không Idempotency-Key cho close/reopen.
2. Phút điều chỉnh: grammar `^-?(0|[1-9][0-9]{0,18})$` như `leave.wholeNumber`, `workrequest.minute` (map 14 gợi ý mẫu này), nên `1.0`, `1e2`, `-6e1`, `"60"`, `null`, `01`, `+60` bị 400; `-0` khớp grammar nhưng là 0 nên bị từ chối. TS `inputMinutes` nhận `1.0`/`1e2` (JS number). Đây là độ lệch theo quy ước Go đã có, cùng OpenAPI `type: integer`; ghi ở tracker. Nếu reviewer muốn khớp TS thì cần ruling.
3. Reference: không trim; grammar `^[\p{L}\p{N}][\p{L}\p{N} ._/#:-]{0,63}$` chép từ TS (RE2 rune-based, `{0,63}` đếm code point như cờ `u`). Dấu tổ hợp (`\p{M}`), emoji, tab, newline, U+2028, `<`, `&` bị từ chối; dấu cách cuối được giữ nguyên. Omitted → `nil` → `null` trong hash; `null` tường minh → 400 qua `optionalText`.
4. `workDate`: grammar `YYYY-MM-DD` + `time.Parse(time.DateOnly)` + năm 1900..2100, viết trong module như `leave`/`workrequest`; không thêm cạnh `attendance → schedulecore`.
5. Month mặc định của sheet là `nil` ở parser; không dùng `time.Now` (query 14b dùng clock DB).
6. Hash: năm phần tử marshal riêng bằng `encoding/json/v2` theo kiểu (`string`, `int`, `*string`), nối bằng `,` trong `[...]`; không `any`/map. Không hash key.

## RED/GREEN

- RED biên dịch: viết hai file test trước, `go test -count=1 ./internal/modules/attendance` exit 1 với `undefined: parseMonth`, `AdjustmentInput`, `adjustmentHash`… (`/private/tmp/hrm-14a-red.log`). Đây chỉ là bằng chứng TDD, không tính RED hành vi.
- GREEN: `go test -race -count=1 -v ./internal/modules/attendance` exit 0, 11 test PASS (`/private/tmp/hrm-14a-attendance.log`).

Vector hash tính độc lập bằng Node v24.20.0, không lấy từ hàm Go:

```sh
node -e '
const {createHash}=require("node:crypto");
const id="0b8d1a4e-5c3f-4a7b-9e21-3f6d8c2a1b09";
const cases=[
 [id,"2026-11-03",-60,"Qu\u00ean ch\u1ea5m c\u00f4ng bu\u1ed5i chi\u1ec1u","Q\u0110-2026/11"],
 [id,"2024-02-29",1440,"Nghi\u0302\u0300 ph\u00e9p",null],
 [id,"2026-12-31",-1440,"WFH \u{1f44d}\u{1f468}\u200d\u{1f469}\u200d\u{1f467}","S\u1ed1 12#A:b_c.d"],
 [id,"2026-01-01",1,"<a>&\"b\"\\c\u2028d\u2029e\u0085f\u00a0g",null],
 [id,"2026-01-01",1,"<a>&\"b\"\\c\u2028d\u2029e\u0085f\u00a0g","null"],
];
for (const c of cases){const s=JSON.stringify(c);console.log(createHash("sha256").update(s).digest("hex"), s.length);}
'
```

Đây là `JSON.stringify` + SHA-256 trên đúng mảng `[employeeId,workDate,minutes,reason,reference]` mà `AttendanceService.adjust` hash (`attendance.service.ts:38`), không gọi service TS đã build. Năm vector phủ tiếng Việt dựng sẵn, dấu tổ hợp, emoji ZWJ, `<>&`, U+2028/U+2029, phút âm/dương ±1440, reference `null` so với chuỗi `"null"`. Mỗi vector còn kiểm đổi key không đổi hash.

## Mutant hành vi (overlay ngoài repo)

Bản sao ở `/private/tmp/hrm-14a-mutants/<tên>/`, mỗi thư mục có `overlay.json` (`{"Replace":{"<file thật>":"<bản đột biến>"}}`), sinh bằng `perl -0pe … > bản sao` (không sửa file repo). Lệnh: `go test -count=1 -overlay <dir>/overlay.json ./internal/modules/attendance`, sau `waitload.sh`. Chạy lại trên test cuối cùng; cả 12 exit 1 do assertion, không có `build failed`. Log `/private/tmp/hrm-14a-mutant-<tên>.log`.

| Mutant                   | Thay đổi                                    | Assertion đỏ đầu tiên                                         |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------- |
| m1-null-reference        | `optionalText` coi `null` là thiếu          | `attendance_validator_test.go:261` accepted null              |
| m2-hash-empty-reference  | reference thiếu hash thành `""` thay `null` | `attendance_hash_test.go:41` hai vector null                  |
| m3-hash-order            | đổi chỗ workDate và minutes                 | `attendance_hash_test.go:41`                                  |
| m4-hash-json-v1          | `encoding/json` v1                          | `attendance_hash_test.go:41` hai vector `<>&`/U+2028          |
| m5-zero-minutes          | bỏ điều kiện `minutes == 0`                 | `attendance_validator_test.go:195` accepted 0, -0             |
| m6-bound                 | biên trên 1441                              | `attendance_validator_test.go:195` accepted 1441              |
| m7-float-minutes         | grammar số thực + `ParseFloat`              | `attendance_validator_test.go:195` accepted 1.0, 1e2          |
| m8-trim-reference        | `strings.TrimSpace` reference               | `attendance_validator_test.go:252` "QD " bị đổi, " QD" lọt    |
| m9-reason-limit          | reason điều chỉnh 1000 thay 300             | `attendance_validator_test.go:235` 301 code point lọt         |
| m10-calendar-date        | chỉ parse năm, bỏ kiểm ngày lịch            | `attendance_validator_test.go:212` 2026-02-29, 2100-02-29 lọt |
| m11-ascii-reference      | grammar reference chỉ ASCII                 | `attendance_validator_test.go:147` `QĐ-2026/11` bị từ chối    |
| m12-sheet-month-required | sheet không còn nhánh query rỗng            | `attendance_validator_test.go:55`                             |

## Lệnh và kết quả

Trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng riêng sau `bash …/waitload.sh`. Load quan sát 4.8–14.8 (dưới ngưỡng 40). Thời gian là wall clock cả lệnh.

| Lệnh                                                      | Exit / thời gian / log                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `go test -count=1 ./internal/modules/attendance` (RED)    | 1, build failed vì chưa có API; `hrm-14a-red.log`                                                                                             |
| `go test -race -count=1 -v ./internal/modules/attendance` | 0, 3s, 11 PASS; `hrm-14a-attendance.log`                                                                                                      |
| `go test -race -count=1 ./internal/...`                   | 0, 15s, 33 package ok, `modules/permission` không có test; `hrm-14a-internal.log`                                                             |
| `go tool golangci-lint run`                               | lượt 1 exit 1, 3 errcheck (`_` cho lỗi decode/Marshal trong test), đã sửa; lượt 2 exit 0, 0 issues; `hrm-14a-lint-r1.log`, `hrm-14a-lint.log` |
| `go build ./...`                                          | 0, 2s; `hrm-14a-build.log`                                                                                                                    |
| `go vet ./...`                                            | 0, 1s; `hrm-14a-vet.log`                                                                                                                      |
| `go vet -tags integration ./...`                          | 0, 1s; `hrm-14a-vet-integration.log`                                                                                                          |
| `go test -count=1 ./test`                                 | 0, 9s (test 4.893s); `hrm-14a-test.log`                                                                                                       |
| `gofmt -l .`                                              | 0, rỗng; `hrm-14a-gofmt.log`                                                                                                                  |
| 12 mutant overlay                                         | đều 1 do assertion, mỗi lượt ≤1s; `hrm-14a-mutant-*.log`                                                                                      |
| `git diff --check` (root)                                 | 0; file mới chưa track nên kiểm thêm khoảng trắng cuối dòng bằng `grep`, không có                                                             |
| `prettier --ignore-path /dev/null --check` báo cáo này    | lượt 1 exit 1 (căn bảng), sửa bằng Edit; lượt 2 exit 0. Thư mục sổ nằm trong `.prettierignore` nên phải bỏ ignore mới kiểm được               |

Build/vet/vet-integration/internal/`./test`/gofmt chạy lại sau lần sửa errcheck cuối; số trong bảng là lượt sau cùng. Tracker thuộc `.prettierignore`.

Không chạy: PostgreSQL integration, `pnpm test:browser`, matrix HTTP, vì 14a không có route/SQL. Không tuyên bố M6 runtime đã được kiểm.

## Ghi chú working tree

Lúc bắt đầu `git status` có `apps/api-go/internal/modules/attendancecore/attendance_calculation_helper_test.go` (M, thay đổi của người dùng). Tôi không mở hay sửa file đó; ở lần kiểm cuối nó không còn trong `git status` và `gofmt -l .` không liệt kê. Thay đổi đó không do agent này.

## Lo ngại và điều chưa kiểm chứng

- Độ lệch grammar phút so với TS (quyết định 2). Client web gửi `number` nguyên từ form nên không bị ảnh hưởng theo đọc source; chưa kiểm bằng browser.
- `\p{L}`/`\p{N}` của Go 1.27.3 và V8 trong Node 24 có thể khác phiên bản Unicode với ký tự mới; chưa đối chiếu toàn bảng.
- Comment trong file Go mới có ký tự ngoài ASCII (`…`, `±`, `Đ`) như file `leave`; test chỉ ASCII (đã kiểm bằng `LC_ALL=C grep`).

## Chưa làm (14b trở đi)

14b: sáu operations (query sheet/state/list, lệnh close/reopen/adjust) dùng `LoadFacts`/`LoadAllFacts`/`BuildSnapshot`/`CanonicalSnapshot`, claim/replay/`authority.Replay`, PostgreSQL tests. 14c: controller/http_port, composition app, `MigratedRoutes`, ma trận HTTP sáu route, browser. 14d: concurrency chéo module (period :249, adjust :646, cancel/approval-close, hire/termination-close), mixed stack Go close → NestJS report. 14e: gate đầy đủ, `task-14-report.md`. Các dòng tracker M6 khác vẫn trống.

## Review

Reviewer độc lập (opus, chỉ đọc `review-t14a.diff` và nguồn TS/web/OpenAPI): Approved. Reviewer tự tính lại năm vector hash bằng `node -e`, khớp; tự chạy ba mutant (null reference, đổi thứ tự hash, json v1), đều đỏ do assertion. Ruling 94 (grammar số nguyên cho phút, `1.0`/`1e2` bị 400) được xác nhận chấp nhận được vì OpenAPI khai `integer` và web gửi số nguyên.

Minor giữ lại (điều phối viên ghi nhận, không sửa ở 14a):

- M1: `parseSheetQuery` parse query hai lần (`url.ParseQuery` rồi `InputQuery`), theo mẫu `leave.parseBalanceQuery`; trau chuốt.
- M2: `adjustmentHash` gom năm lỗi Marshal bằng `errors.Join`, có thể trả lỗi sớm như `leave_adjust_command.go`; không đổi hành vi.
- M3: thiếu ca từ chối 65 ký tự nhiều byte cho reference; phía nhận 64 `Đ` đã chứng minh đếm code point.
- M4: `PeriodEvent.Event` là `string` trần; 14b phải dùng type có tên (`close`/`reopen`) khi map từ SQL để không lọt giá trị lạ (web parse bằng `z.enum`).
