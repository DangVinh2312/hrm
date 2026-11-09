# Báo cáo Task 13a — M5 phần 1, route `leave`

Trạng thái: DONE_WITH_CONCERNS — 3 route của module `leave` (TS) phục vụ tại Go, mọi check yêu cầu đã chạy (kết quả bên dưới). Review độc lập chưa chạy, chưa commit, không push. Không đổi NestJS, web, schema, ACL, declarations quyền, mã lỗi, OpenAPI hay dependency.

## Thay đổi

| File | Nội dung |
| --- | --- |
| `internal/modules/leave/leave_types.go` | `BalanceQuery` (`AsOn` nil là hôm nay), `ReconciliationQuery`, `AdjustmentInput`, `AdjustmentResult`, `ExcessView`, `ReconciliationView`; view số dư dùng `leavecore.BalanceView` |
| `internal/modules/leave/leave_validator.go` | `parseBalanceQuery` (không query hoặc đúng `?date=` một lần, ngày có thật 1900–2100), `parseReconciliationQuery` (`InputPageQuery` + `year` 4 chữ số ASCII 1900–2100), `parseAdjustment` (UUID path, `hrbase.ParseIdempotencyKey` trên `Header.Values`, phút theo grammar số nguyên, khác 0, ±175680, `effectiveOn`, `reference` qua `InputText` ≤ 200 code point) |
| `internal/modules/leave/leave_adjust_command.go` | `adjustmentHash` (mảng JSON `[employeeId, minutes, effectiveOn, reference]` như TS, từng giá trị mã hóa bằng `encoding/json/v2`); `runAdjust` theo đúng thứ tự TS: đọc claim → replay/422 → `hired_on` (409) → `LockBucket` → `AssertPeriodsOpen` (409 `error.periodClosed`) → ledger (`gen_random_uuid()`) → `BumpBucket` → claim `ON CONFLICT DO NOTHING RETURNING 1` (0 dòng là 422) → audit `hr.leave.adjust` |
| `internal/modules/leave/leave_read_repository.go` | `readBalance` (scope SQL trên dòng employee rồi `leavecore.LoadFacts` + `Balance`), `readReconciliation` (SQL chép nguyên văn TS: scope trong CTE trước `LIMIT/OFFSET`, facts một lượt cho trang), `excessMonths` |
| `internal/modules/leave/leave_service.go`, `_http_port.go`, `_controller.go` | `Operations{}.Bind`, `HTTPPort`, `Routes.Register`; replay bắt bằng `errors.AsType[adjustmentReplayed]` sau `Execute` |
| `internal/modules/leavecore/leave_effect_repository.go` | Export `LockBucket`, `BumpBucket` (trước là `lockBucket`, `bumpBucket`), không đổi SQL |
| `internal/httpapi/inventory.go` | 3 route vào `MigratedRoutes` |
| `internal/app/authority.go` | `modules.leave`, đăng ký operations và `leave.Routes` |
| `internal/app/m1_matrix_integration_test.go` | `m1Row.keyed`/`reuse`; `w.state` gộp state M1/M2/M4/M5a cho mọi ô từ chối; `succeed` nhận edit header và trả body; guard đòi `keyed`+`reuse` khi ô idempotency không NA; guard gộp `m5aMatrix` |
| `internal/app/m2_matrix_integration_test.go` | Guard M2 bỏ qua route M5a dưới `/api/hr/employees` |
| `internal/app/m5a_matrix_integration_test.go` | Ma trận 3 route, `checkIdempotency`, `TestM5aRoutesAreMigrated`, `TestM5aScopedGrantsReachOnlyTheirOwnEmployee` |
| Test mới | `leave_validator_test.go`, `leave_hash_test.go` (unit); `leave_integration_test.go`, `leave_adjust_integration_test.go` (PostgreSQL) |
| Tài liệu | `contract/test-port-tracker.md`, `apps/api-go/AGENTS.md` (dòng module, thứ tự khóa, bẫy hash v1/v2), plan Task 13 (ghi chú, không tick) |

DAG: import thật của `leave` nằm trong tập đã khai ở `package-dag.md` §3/§4 (`config` khai sẵn nhưng chưa dùng), `app → leave` đã có; `go test ./test` GREEN nên không sửa `package-dag.md`.

## Route

| Method | Path | Classification | Thành công |
| --- | --- | --- | --- |
| GET | `/api/hr/employees/:id/leave-balance` | `employee.readLeaveBalance` | 200 `leavecore.BalanceView` |
| GET | `/api/hr/leave/reconciliation` | `employee.readLeaveBalance` | 200 `{year,total,items}` |
| POST | `/api/hr/employees/:id/leave-adjustments` | `employee.adjustLeaveBalance` (fresh@1) | 201 `{id}`; replay cùng payload trả 201 cùng `id` |

POST đi qua `httpapi.DecodeCommand` (CSRF/Origin trước body, khóa và session); `TestEveryMigratedWriteRefusesAMissingCSRF` bao route mới.

## Ma trận HTTP (`TestTheM5aRoutesAnswerEveryCellOfTheMatrix`)

Mọi route: signed out, expired, suspended → 401; `hr` fresh và Root fresh → status/shape của contract; ghi có đúng một audit `hr.leave.adjust` của actor, đọc của Root có `access.employee.readLeaveBalance`. Mọi ô từ chối kiểm state M1+M2+M4+M5a (ledger, bucket+revision, `hr_idempotency`, kỳ công, audit) không đổi.

| Route | Không grant / deny | Boundary / fresh | CSRF / Origin | Foreign / absent | Invalid / extra | Idempotency |
| --- | --- | --- | --- | --- | --- | --- |
| GET leave-balance | 404 / 404 | NA / NA | NA | 404 / 404 | 400 (6) / NA | NA (đọc) |
| GET reconciliation | 200 trang rỗng / 200 trang rỗng | NA / NA | NA | NA (scope lọc trong SQL) / NA | 400 (5) / NA | NA (đọc) |
| POST leave-adjustments | 404 / 404 | NA (`optional`) / 403 | 403 / 403 | 404 / 404 | 400 (9) / 400 | replay cùng body, state không đổi; payload khác 422 `error.idempotencyKeyReused`; thiếu, sai (chữ hoa), lặp header là 400 |

`prepare` của đối soát thêm một nhân viên có đơn chờ duyệt tháng 3/2031 (SQL), nên ô no grant/deny trả trang rỗng trong khi `hr` thấy dòng: chứng minh scope. `scoped` có allow `employee.adjustLeaveBalance`/`selfEmployee` (fixture runtime) để ô foreign của POST không chỉ lặp ô no grant; `TestM5aScopedGrantsReachOnlyTheirOwnEmployee` kiểm `scoped` đọc số dư của mình 200, điều chỉnh của mình 201 kèm audit, đối soát chỉ thấy mình, số dư người khác 404.

## Test PostgreSQL (`internal/modules/leave`)

- Số dư: accrual qua query (5760, 6720, năm mới, thâm niên), thử việc → chính thức và đổi mức (dựng bằng SQL), CHECK mức < 12 ngày 23514, ai đọc được (self, lead, HR, COO chỉ của mình, Root; absent = foreign, Root audit cả absent), D09 đơn chờ là pending, ngày mặc định theo đồng hồ DB.
- Đối soát: tháng 3/4 của R1 đúng số, `requestIds`, đơn vừa đủ không liệt kê, không đổi state đơn, scope (self/lead/O/C/N), phân trang theo nhân viên, năm 2031 rỗng, entitlement âm chỉ cấm nghỉ, scope trước phân trang (`TestTheReconciliationScopesBeforeItPages`: nhân viên ngoài team xếp đầu theo code không chiếm trang `limit=1` của lead).
- Điều chỉnh: dòng ledger đúng, số dư đổi, audit, bucket revision 2 rồi 3, Root audit; chỉ HR fresh (stale 403, người khác/absent 404, không ghi); replay cùng kết quả, khác phút/ngày/reference/nhân viên là 422, khóa của actor khác không thấy; tháng đã chốt 409 không ghi, mở lại thì nhận; trước ngày vào làm 409; audit lỗi (REVOKE INSERT) rollback ledger/claim/bucket rồi cùng khóa thành công một lần; hai request cùng khóa chạy đua → một dòng, cùng `id`; một khóa cho hai nhân viên chạy đua → đúng một thắng, một 422, một dòng ledger; thứ tự khóa employee → bucket → kỳ công (giữ khóa sau, thử khóa trước với `lock_timeout` 50 ms phải 55P03); E-17.
- Schema/ACL sổ phép: CHECK/FK/UNIQUE của opening/adjustment/debit/reversal (đơn nghỉ không lương dựng bằng SQL), login `data` không UPDATE/DELETE `leave_ledger`, `leave_bucket` (trừ `revision`), `hr_idempotency`; `authority`, `identity`, `sync` không đọc ba bảng.

## Lệnh và kết quả (từ `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, lệnh nặng sau `waitload.sh`)

| Lệnh | Exit | Thời gian | Kết quả |
| --- | --- | --- | --- |
| `go test -count=1 ./internal/modules/leave` (trước validator) | 1 | — | RED: `undefined: parseBalanceQuery`, `adjustmentBody`… |
| `go test -count=1 ./internal/modules/leave` (trước hash) | 1 | — | RED: `undefined: adjustmentHash` |
| `go build ./...`, `go vet ./...`, `go vet -tags integration ./...` | 0 | — | lượt cuối sau mọi sửa |
| `go test -race -count=1 ./internal/...` | 0 | 20:23:24–20:23:36 | 31 package ok |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/leave ./internal/modules/leavecore ./internal/app` | 0 | 20:23:41–20:24:46 | leave 21.643s, leavecore 5.758s, app 31.589s |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/leave` (sau khi thêm test thử việc/mức phép và schema debit/reversal) | 0 | 20:33:24–20:33:52 | ok 22.830s |
| `go tool golangci-lint run` | 0 | — | 0 issues |
| `go test -count=1 ./test` | 0 | — | ok 4.610s |
| `gofmt -l .` | — | — | rỗng |
| `git diff --check` (root) | 0 | — | sạch; file mới không có khoảng trắng cuối dòng; test mới chỉ ASCII |
| `pnpm test:browser` (root) | 0 | 20:27:57–20:31:06 | 30 passed (3.0m) |

Lượt integration đầu: một lỗi của test (stale HR mong `ErrStepUpRequired`, authority trả `ErrAccessDenied`, cùng 403); lượt schema đầu: fixture đổi `kind` đơn thành `unpaid-leave` vi phạm FK, sửa bằng insert trực tiếp. Code không đổi. Integration và ma trận viết sau implementation; bằng chứng độ nhạy là đột biến bên dưới.

Vector hash: `node leave-hash-vectors.mjs apps/api/dist` (script ở scratchpad) tạo `LeaveService` của bản build TS với `authorization.execute` giả chỉ ghi lại `input.hash`, gọi `adjust` với bốn input (tiếng Việt dựng sẵn, dấu tổ hợp U+0302 U+0300, emoji và chuỗi ZWJ, `<>&"\`, U+2028, U+2029, U+0085, U+00A0); `dist` mới hơn `src` (kiểm `find -newer`). Bốn hash dán vào `leave_hash_test.go`, Go khớp ngay lượt đầu.

## Đột biến (`go test -overlay`, bản ở `/private/tmp/hrm-13a-mutants/`)

| # | Đột biến | Lệnh | Kết quả | Thời gian |
| --- | --- | --- | --- | --- |
| M1 | Bỏ so hash: `Replay(*prior, prior.Hash)` | `-tags integration -overlay m1.json ./internal/modules/leave`; `-overlay m1.json -run TestTheM5aRoutesAnswerEveryCellOfTheMatrix ./internal/app` | RED cả hai: payload khác trả kết quả cũ; ô "another payload under the key" 201 | 20:25:35–20:25:55; 20:27:22–20:27:32 |
| M2 | Scope đối soát thành `(<scope> OR true)` | như trên với `m2.json` | RED: E/O/C/N thấy R1, lead thấy nhân viên ngoài team; ô no grant/deny 200 có dòng | 20:25:55–20:26:15; 20:27:32–20:27:40 |
| M3 | Bỏ `AssertPeriodsOpen` | `-overlay m3.json ./internal/modules/leave` | RED: tháng đã chốt nhận; hai test khóa không thấy chờ | 20:26:15–20:26:36 |
| M4 | Controller đọc body bằng `json.UnmarshalRead` thay `DecodeCommand` (bỏ CSRF) | `-overlay m4.json -run TestEveryMigratedWriteRefusesAMissingCSRF ./internal/app`; `-tags integration -run TestTheM5aRoutes…` | RED: 400 thay 403; ô csrf/origin 201 và đổi state | 20:25:28–20:25:30; 20:27:40–20:27:49 |
| M5 | Đảo `AssertPeriodsOpen` lên trước `LockBucket` | `-overlay m5.json ./internal/modules/leave` | RED: bucket còn trống khi lệnh chờ kỳ công | 20:26:36–20:26:56 |
| M6 | Claim chỉ từ chối khi > 1 dòng | `-overlay m6.json ./internal/modules/leave` | RED: hai nhân viên cùng khóa đều thắng, 2 dòng ledger | 20:26:56–20:27:16 |
| M7 | Hash mã hóa bằng `encoding/json` v1 | `-overlay m7.json -run AdjustmentHash ./internal/modules/leave` | RED: vector có `<>&`/U+2028 lệch | 20:25:27–20:25:28 |

GREEN: source repo không đổi khi chạy đột biến; các lượt không overlay trong bảng lệnh ở trên (sau đột biến: 20:33) exit 0.

## Khác với TypeScript

- Thứ tự khóa giữ đúng TS: fence → employee (target của `Execute`) → đọc `hr_idempotency` (SELECT thường, không khóa) → bucket FOR UPDATE → kỳ công FOR SHARE → ledger, revision, claim, audit. Brief ghi "fence, idempotency row, employee, …"; TS không khóa dòng idempotency trước employee, nên tôi không đổi. Khóa duy nhất trên idempotency là khóa PK của `INSERT … ON CONFLICT` cuối cùng.
- Id dòng ledger do `gen_random_uuid()` sinh trong SQL (TS: `randomUUID()` của Node), cùng UUID v4; tránh bản sao thứ tư của `newUUID`.
- Số phút theo grammar số nguyên: `480.0`, `4.8e2` là 400 (TS nhận vì `Number.isSafeInteger`). Cùng cách với employee/setting/lịch.
- Kết quả claim đọc bằng `RejectUnknownMembers`: một `result` lưu khác `{id}` là lỗi 503 thay vì trả nguyên văn. Cả hai runtime chỉ ghi `{"id":…}`.
- Hash: TS băm mảng, không phải object, nên Go dựng mảng bằng từng giá trị mã hóa v2 chứ không dùng struct (`AGENTS.md` cập nhật).
- Test: chốt/mở kỳ, đơn chờ duyệt, trạng thái chính thức và mức phép dựng bằng SQL (route M6/13b hoặc M2); phần cần submit/duyệt để tracker (ruling 82).

## Rủi ro và câu hỏi mở

- Review độc lập chưa chạy.
- Replay của Root không ghi audit (lệnh rollback), như TS; replay khi nhân viên đã ra ngoài scope của actor là 404, như TS.
- `leavecore` đổi API: `LockBucket`/`BumpBucket` export (13b/13c dùng được). Cần reviewer xem có chấp nhận đổi API M3 không.
- `m1World.check` giờ so thêm state M5a ở mọi ô từ chối M1/M2/M4 (app integration toàn package GREEN).
- Không có quyết định bảo mật/dữ liệu nào chưa được TS/ADR chốt trong phạm vi 13a.

## Review độc lập và sửa

Reviewer độc lập không thấy lỗi chặn. Chỉ sửa test và guard; code production không đổi.

### R1 — Root replay không có audit (chưa sửa, chờ người dùng quyết định)

`runAdjust` (`internal/modules/leave/leave_adjust_command.go:101-106`) khi gặp claim đã commit trả `adjustmentReplayed{result}` dưới dạng error. Trong `authority.Execute` (`internal/authorization/authority/authority_operations.go:103-105`), error của `command.run` được trả ngay, trước khi `commandContext.Audit` (nhánh duy nhất ghi `RootOutcome` cho `kind = root`) chạy, nên transaction rollback; `Service.Adjust` (`leave_service.go:65-66`) bắt lỗi đó và trả `{id}` lưu trước. Kết quả: Root replay một khóa nhận 201 `{id}` mà không có dòng audit nào. Giống TS. Mâu thuẫn với `AGENTS.md` ("mọi `access` của Root được audit"). **Chờ người dùng quyết định: chấp nhận như TS hay ghi access audit cho Root khi replay.**

### Đã sửa

| Mã | Sửa | File |
| --- | --- | --- |
| T1 | Đối soát không có `year` trả năm nghiệp vụ theo đồng hồ DB (năm tính bằng SQL `statement_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh'`, không theo máy chạy test) và bằng kết quả gọi tường minh năm đó | `leave_integration_test.go` (`TestTheReconciliationCountsApprovedLeaveAndListsRequestsUpToTheMonth`) |
| T2 | Fixture nhân viên X: một ngày đã duyệt 10/02 (debit trong ledger), đơn chờ tháng 3 (hai ngày) ghi trước đơn chờ 16/02, đơn chờ 04/05. Chỉ tháng 3 vượt: accrued 1440, approved 480, pending 1440, excess 480, `requestIds` = [đơn tháng 2, đơn tháng 3], không có đơn tháng 5. SQL `FactsSQL` đã sắp pending theo ngày, nên thêm unit `TestExcessMonthsListsRequestsOldestFirstUpToTheMonth` đưa pending lộn thứ tự (id của đơn muộn nhỏ hơn) để `SortStableFunc` của Go cũng bị kiểm | `leave_integration_test.go`, `leave_read_repository_test.go` (mới) |
| T3 | `waitBlocked(t, n)` chờ đủ `n` backend `product_data` bị chặn; `race` chờ mọi request. Với hai nhân viên, cả hai đã đọc `hr_idempotency` trước khi chờ kỳ công, nên bên thua chắc chắn đi qua nhánh `ON CONFLICT … len(claimed) != 1`, không qua `Replay` | `leave_integration_test.go`, `leave_adjust_integration_test.go` |
| N1 | Guard ma trận: ô idempotency không NA ⇔ `keyed` ⇔ có `reuse` (sai một chiều là lỗi); `c.idempotency` vào luật "no success cell besides the grants" | `internal/app/m1_matrix_integration_test.go` |
| N2 | `succeed` nhận hơn một edit thì `t.Fatalf` | `internal/app/m1_matrix_integration_test.go` |

Để nit, không sửa: N3 (`cumulative`/`errKeyReused` trùng lặp, theo reviewer), N4 (`480.0` → 400 theo grammar số nguyên, xem mục "Khác với TypeScript").

### Đột biến (`go test -overlay`, bản ở `/private/tmp/hrm-13ar-mutants/`)

| Đột biến | Test | Kết quả |
| --- | --- | --- |
| `t2_filter`: bỏ `p.Date[5:7] <= upTo` | unit `ExcessMonths`; integration `TestTheReconciliationCountsApprovedLeave…` | RED cả hai: `requestIds` có thêm đơn tháng 5 |
| `t2_sort`: bỏ so ngày trong sort | unit `ExcessMonths` | RED: [tháng 3, tháng 2] |
| `t2_approved`: `committed := pending[i]` | unit; integration | RED cả hai: không còn tháng vượt |
| `t1_year`: năm mặc định `- 1` | integration | RED: `Year:2025`, muốn 2026 |
| `t3_claim`: bỏ `if len(claimed) != 1` | `-race -count=5 -run TestOneKeyForTwoEmployeesRacingClaimsOnce` | RED 5/5: `won 2, reused 0, ledger 0 -> 2` |

GREEN: `-race -tags integration -count=10 -run 'TestOneKeyForTwoEmployeesRacingClaimsOnce|TestTwoRequestsWithOneKey|TestTheAdjustmentLocks'` ok 35.206s (20:46:40–20:47:28).

### Lệnh và kết quả (từ `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, lệnh nặng sau `waitload.sh`)

| Lệnh | Kết quả |
| --- | --- |
| `go build ./...`, `go vet ./...`, `go vet -tags integration ./...` | exit 0 |
| `go test -race -count=1 ./internal/...` | exit 0, 31 package ok (20:48:08–20:48:20) |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/leave ./internal/app` | ok leave 34.638s, app 40.048s (20:48:23–20:49:45) |
| `go tool golangci-lint run` | 0 issues |
| `go test -count=1 ./test` | ok 4.462s |
| `gofmt -l .` | rỗng |
| `git diff --check` (root) | exit 0; ba file test sửa/mới chỉ ASCII |

Không chạy lại `pnpm test:browser` và integration `leavecore` (không đổi file nào ở đó hay ở web).
