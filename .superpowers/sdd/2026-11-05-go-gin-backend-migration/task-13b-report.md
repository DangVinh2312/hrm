# Báo cáo Task 13b — M5 phần 2, submit và đọc `work-request`

Trạng thái: DONE_WITH_CONCERNS. Ba route của `work-request` (TS) đã chạy ở Go. Mọi check yêu cầu đã chạy, kết quả ở bảng dưới. Chưa có review độc lập, chưa commit, chưa push. Không đổi NestJS, web, schema, ACL, declarations quyền, mã lỗi, OpenAPI hay dependency. Không đổi package `authority` (hook thử nghiệm đã gỡ, diff rỗng).

## Thay đổi

| File | Nội dung |
| --- | --- |
| `internal/modules/workrequest/work_request_types.go` | `SubmitInput`, `Slot`, `SubmitResult` (`wfhLimitExceeded` `omitzero`), `ListQuery`, `RequestSummary`, `ListView`, `Segment`, `DecisionView`, `DetailView`; hằng state và system reason |
| `work_request_validator.go` | `present[T]` để phân biệt `null` với thiếu; `minute` theo grammar số nguyên. `parseSubmit` gồm: `hrbase.ParseIdempotencyKey` trên `Header.Values`; tập member đúng theo kind (member của kind khác là 400, kể cả `null`); `teamId` qua `InputUUID`; `reason` qua `InputText` ≤ 1000; ngày có thật; phút 0..1440; 1..31 ngày, sắp theo ngày, ngày trùng là 400. `parseRequestList` dùng `InputPageQuery` |
| `work_request_helper.go` (thuần) | Luật submit: một năm, cửa sổ ngày, đang làm, thử việc theo ngày, khung giờ, ngày nghỉ, ngày làm bù. `conflicts`, `initialState`. Hash dùng một struct cho mỗi kind, mã hóa `encoding/json/v2` rồi SHA-256 hex |
| `work_request_effects.go` | Bảng effect khi duyệt theo kind. `productionEffects()` = `leavecore.ApplyApproved`, `attendancecore.ApplyApprovedWfh`, `ApplyApprovedAttendance`. Kind thiếu handler thì không tự duyệt (409) |
| `work_request_submit_repository.go` | SQL chép theo TS: facts của người nộp (cửa sổ, team, lead, lịch), trạng thái theo ngày, đơn đã đặt, insert request và segment (`unnest`), tự duyệt, quyết định hệ thống, claim. Id sinh bằng `gen_random_uuid()` |
| `work_request_submit_command.go` | `runSubmit` theo thứ tự TS: claim, replay/422, settings, maxDays (400), `AssertPeriodsOpen`, facts (404/`teamNotMember`), segments, chồng lấn (409 `overlappingRequest`), `AssertAvailable` (phép năm), ghi. COO được xác định qua `Reaches(hrCompany.approvals)`. Đơn của COO ghi `pending_final` rồi kiểm `Reaches(workRequest.decideFinal)` trên chính dòng đó, chạy effect với ack, rồi audit `hr.request.submit` (+ `hr.request.self-approve`) |
| `work_request_read_repository.go` | `readSubmitter` (`employee.submitRequest`, hồ sơ của chính session). `readOwnRequests`: scope trong CTE trước count/`LIMIT`. `readDetail`: segment và lịch sử quyết định |
| `work_request_service.go`, `_http_port.go`, `_controller.go` | `Operations.Bind`, `HTTPPort`, `Routes.Register`. POST đi qua `DecodeCommand` (CSRF/Origin trước body, key và session). Detail thử `workRequest.read` trước, rồi `readLeadRejected` |
| `internal/httpapi/inventory.go` | Thêm 3 route vào `MigratedRoutes` |
| `internal/app/authority.go` | Đăng ký `workrequest` operations và routes |
| `internal/app/app_test.go` | Route "chưa chuyển" trong test proxy đổi từ `/api/hr/requests` sang `/api/hr/approvals/lead` (route 13c) |
| `internal/app/m1_matrix_integration_test.go` | `w.state` gộp thêm `m5bState`; guard gộp `m5bMatrix` |
| `internal/app/m5b_matrix_integration_test.go` | Ma trận 3 route, `TestM5bRoutesAreMigrated`, `TestM5bARootRetryIsAuditedAndAnIAMRetryIsNot` |
| Test mới | Unit: `work_request_validator_test.go`, `work_request_helper_test.go`, `work_request_hash_test.go`. PostgreSQL: `work_request_integration_test.go` (fixture), `work_request_submit_integration_test.go` |
| Tài liệu | `contract/test-port-tracker.md`, `apps/api-go/AGENTS.md` (hash theo kind, `present` cho member của kind khác, audit replay của Root). Plan không tick |

DAG: chỉ import các cạnh đã khai cho `workrequest` (attendancecore, hrbase, leavecore, permission, schedulecore, settingcore và nền). `go test ./test` GREEN, không sửa `package-dag.md`.

## Route

| Method | Path | Classification | Thành công |
| --- | --- | --- | --- |
| POST | `/api/hr/requests` | `employee.submitRequest` | 201 `{id,state,version[,wfhLimitExceeded]}`; replay cùng payload trả 201 với cùng body |
| GET | `/api/hr/requests` | `workRequest.read` | 200 `{items,total}` (đơn của chính mình, mới nhất trước) |
| GET | `/api/hr/requests/:id` | `workRequest.read` | 200 `DetailView`; không có và ngoài scope đều 404 |

## Ma trận HTTP (`TestTheM5bRoutesAnswerEveryCellOfTheMatrix`)

Thế giới M5b: `hr`, `denied`, `none` và Root có hồ sơ official trong một team mới, nên 404 của `none`/`denied` đến từ thiếu grant hoặc deny, không phải thiếu hồ sơ. `denied` có deny `employee.submitRequest`/`allEmployees` và `workRequest.read`/`allRequests`. Mọi ô từ chối kiểm state M1+M2+M4+M5a+M5b (work_request + version, segment, decision, bộ đếm WFH) không đổi.

| Route | Không grant / deny | Boundary / fresh | CSRF / Origin | Foreign / absent | Invalid / extra | Idempotency |
| --- | --- | --- | --- | --- | --- | --- |
| POST requests | 404 / 404 | NA (`optional`) / NA (không có fresh@1) | 403 / 403 | NA (đích là hồ sơ của chính session) | 400 (8) / 400 | replay cùng body, state không đổi; payload khác 422; thiếu, sai hoặc lặp key là 400 |
| GET requests | 200 trang rỗng / 200 trang rỗng | NA / NA | NA | NA (scope lọc trong SQL) | 400 (6) / NA | NA |
| GET requests/:id | 404 / 404 | NA / NA | NA | 404 / 404 | 400 (2) / NA | NA |

`prepare` của danh sách tạo đơn cho cả `denied` và `none`, nên ô trang rỗng chứng minh scope chứ không phải "không có đơn". Root thành công ở cả ba route, có audit `hr.request.submit` hoặc `access.workRequest.read`.

## Root replay (quyết định người dùng 2026-11-09)

Không cần thêm contract mới. `Service.Submit` luôn chạy query `employee.submitRequest` (`authority.Read`, transaction riêng, commit trước) rồi mới `Execute`. Với Root, query này ghi một dòng `access.employee.submitRequest` (`audit.Access{Root:{ok}}`, đường `rootAccess` sẵn có). Replay rollback lệnh nhưng dòng access đã commit. Kết quả: mỗi lần Root replay thành công có đúng một dòng audit mới. Dòng này commit trước khi lệnh chạy, nên rollback không làm mất. Nó không nằm cùng transaction với phản hồi replay: nếu lệnh lỗi sau đó thì dòng access vẫn còn, đúng với bất biến "mọi access của Root được audit". IAM replay không ghi gì.

Test PostgreSQL:
- `TestARootReplayIsAuditedAndAnIAMReplayIsNot` (module): Root được liên kết hồ sơ bằng SQL. Replay của Root thêm đúng 1 dòng, đúng kind đó, ngoài ra state không đổi. Replay của E thêm 0 dòng.
- `TestM5bARootRetryIsAuditedAndAnIAMRetryIsNot` (HTTP): kết quả tương tự qua route thật.

Helper dùng chung: không thêm. Cách này phụ thuộc vào việc có query trước lệnh, nên `leave.adjust` (13a) không dùng lại được. Bước riêng cho leave sẽ cần cơ chế khác, ví dụ ghi access trong lệnh trước khi trả lỗi replay. Đã ghi vào `apps/api-go/AGENTS.md`.

## Test PostgreSQL (`internal/modules/workrequest`)

- Nộp/đọc: thành viên → `pending_lead` v1, dòng đúng owner/team/kind/reason, claim, một audit. Danh sách và chi tiết của chính mình. O/N không đọc được đơn của E, danh sách rỗng. Đơn không có → not found.
- Lead của team → `pending_final` với quyết định hệ thống `lead_skipped`. COO: đơn trễ, phép năm, WFH đều `approved`, quyết định `coo_self_approved`, hai loại audit, ledger debit 240, bộ đếm WFH. Cảnh báo vượt hạn mức WFH.
- Idempotency: replay cùng kết quả, không ghi gì; payload khác 422. Khóa của actor khác không bị ảnh hưởng. Replay trả cảnh báo đã lưu (không tính lại). Hai request cùng khóa chạy song song → một đơn, cùng id. Người nộp mất hồ sơ thì replay trả 404.
- Từ chối không ghi gì: chồng lấn, đơn trễ thứ hai cùng ngày, tháng đã chốt (`periodClosed`), không có team, team không phải của mình (`teamNotMember`), thử việc, trước/sau cửa sổ (`dateOutOfRange`), thứ Bảy (`nonWorkingDay`), phút ngoài ca (400), không role (404), `requestMaxDays` (400), thiếu quỹ phép (`insufficientLeave`).
- Thử việc chặn WFH nhưng vẫn cho trễ và nghỉ không lương. Đơn trễ trên ngày WFH không bị tính là chồng lấn.
- Root chưa có hồ sơ → 404 kèm audit access. Root replay như mục trên.
- Thiếu effect handler → COO nhận 409, không ghi gì; thành viên vẫn nộp được. Deny `workRequest.decideFinal` → COO nhận 409, không ghi gì; gỡ deny thì được duyệt. Thu hồi `hr.coo` → đơn thường.
- Audit lỗi (`REVOKE INSERT ON audit_outbox`) → rollback đơn và claim, rồi cùng khóa thành công.
- Thứ tự khóa employee → kỳ công → `work_calendar`: giữ khóa sau rồi thử khóa trước với `lock_timeout` 50 ms phải ra 55P03. Hai đơn chồng lấn chạy song song → đúng một đơn commit.

## Lệnh và kết quả (từ `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, lệnh nặng sau `waitload.sh`)

| Lệnh | Thời gian | Kết quả |
| --- | --- | --- |
| `go test ./internal/modules/workrequest` (trước code validator/helper/hash) | — | RED: `undefined` |
| `go build ./...`, `go vet ./...`, `go vet -tags integration ./...` | 21:38:29–21:38:35; lại 21:40:37–21:40:41 | exit 0 |
| `go test -race -count=1 ./internal/...` | 21:38:35–21:38:49 | 32 package ok |
| `go test -race -tags integration -count=1 -p 1 ./internal/modules/workrequest` | 21:38:49–21:39:16; lại 21:40:49–21:41:16 | ok 22.872s; ok 23.653s |
| `go test -race -tags integration -count=1 -p 1 ./internal/app` | 21:39:16–21:39:55 | ok 36.436s |
| `go tool golangci-lint run` | 21:39:55 | Lần đầu 2 issue `exhaustive` (`work_request_helper.go:109`, `work_request_validator.go:167`). Sửa bằng cách liệt kê case, lại lúc 21:40:41: 0 issues |
| `go test -race -count=1 ./internal/modules/workrequest ./internal/app` (sau sửa lint) | 21:40:44 | ok |
| `go test -count=1 ./test` | 21:40:01 | ok 4.476s |
| `gofmt -l .` | 21:40:08; lại 21:41:16 | rỗng |
| `pnpm test:browser` (root) | 21:41:16–21:44:06 | 30 passed (2.8m) |
| `git diff --check` (root) | 21:44:06 | exit 0; file mới không có khoảng trắng cuối dòng |

Sửa lint không đổi hành vi (liệt kê case đã đóng). Sau sửa, `app` integration và `./test` không chạy lại, còn `workrequest` unit, integration và `app` unit đã chạy lại. Các lỗi trong lúc viết test là lỗi của chính test, code không đổi: `CAST($2 AS int)` mơ hồ (42725), cột ledger là `source_request_id` và số phút dương, add member qua route bị 409 nên dựng membership bằng SQL, và ca `?x=1` trên detail bị bỏ vì route bỏ qua query giống TS.

Hash: `node submit-hash-vectors.mjs apps/api/dist` (script trong scratchpad) gọi `payloadHash` của `modules/work-request/helpers/work-request-submit.helper.js` với 5 input. Input gồm tiếng Việt, dấu tổ hợp U+0302 U+0300, emoji, `<>&"\`, U+2028, U+2029, U+0085, U+00A0, đủ ba nhóm kind. Dist được build lại trước khi lấy vector (`pnpm --filter @hrm/api run build`, exit 0). Go khớp ngay lượt đầu. Test unit validator/helper/hash viết trước và RED (`undefined`) trước khi có code.

## Đột biến (`go test -overlay`, bản ở `/private/tmp/claude-501/-Users-vinhdq2312-Documents-personal-hrm/f784f0a3-1454-4fff-b01f-38a224bcfd71/scratchpad/13b/mutants/`)

| # | Đột biến | Test | Kết quả |
| --- | --- | --- | --- |
| m1 | Bỏ so hash: `Replay(prior, prior.Hash)` | module; ma trận | RED cả hai: payload khác nhận kết quả cũ / 201 |
| m2 | Bỏ `AssertPeriodsOpen` | module | RED: tháng đã chốt được nhận và ghi; test thứ tự khóa không thấy chờ |
| m3 | Bỏ 409 chồng lấn (`false && conflicts`) | module | RED: chồng lấn và trễ trùng ngày được nhận; hai đơn song song đều commit |
| m4 | Controller đọc body bằng `json.UnmarshalRead`, bỏ `DecodeCommand` (bỏ CSRF) | `TestEveryMigratedWriteRefusesAMissingCSRF`; ma trận | RED: 503/400 thay vì 403; ô csrf trả 201 và đổi state |
| m5 | Scope danh sách `(<scope> OR true)` | module; ma trận | Module GREEN (danh sách vẫn lọc theo hồ sơ của mình); ma trận RED: ô no grant/deny thấy đơn của chính `none`/`denied` |
| m6 | Scope chi tiết `(<scope> OR true)` | module; ma trận | RED cả hai: O/N đọc được đơn của E; ô no grant/deny/foreign trả 200 |
| m7 | Đảo `AssertPeriodsOpen` ra sau `segmentsOf` (đảo thứ tự khóa kỳ công/lịch) | module | RED: kỳ công còn trống khi submit chờ lịch |
| m8 | Hash bằng `encoding/json` v1 | unit hash | RED: vector `<>&`/U+2028 lệch |

Đột biến chạy 21:35–21:38. Repo không đổi khi chạy đột biến; lượt không overlay ở bảng lệnh đều GREEN. Các lượt module từ m2 trở đi đã gồm 5 test thêm sau (chồng lấn song song, deny `decideFinal`, thử việc/WFH, thu hồi `hr.coo`, submitter bị thu hồi).

## Khác với TypeScript

- Hash submit không có phần tử `ack`. Brief nhắc `ack`, nhưng `payloadHash` trong dist chỉ băm `kind, teamId, reason` và date/expectedMinute, dates hoặc segments, theo thứ tự key riêng của kind. `ack` chỉ có ở hash decision (13c). Vector lấy từ dist xác nhận điều này.
- Phút theo grammar số nguyên: `600.0`, `6e2` trả 400 (TS nhận). Cách xử lý giống 13a.
- `employeeId` trong body: Go không có field này, nên `RejectUnknownMembers` trả 400. TS bỏ qua field lạ ở DTO hay 404 tùy validator (ca B-09 "foreign employee target"). Đích luôn là hồ sơ của session ở cả hai runtime.
- Detail bỏ qua query string, như TS và các route detail Go khác.
- Id request sinh bằng `gen_random_uuid()` trong SQL (TS dùng `randomUUID()`).

## Rủi ro và câu hỏi mở

- Chưa có review độc lập.
- Audit replay của Root đến từ query submitter (commit trước lệnh), không ghi trong transaction của lệnh. Nếu reviewer muốn audit nằm trong cùng transaction với phản hồi replay thì cần đổi `authority` (hook trong `CommandContext`), tức là đổi contract. Tôi chưa làm vì quyết định yêu cầu không bịa contract mới.
- Chưa port (đã ghi trong tracker): ngày lễ có lương và ngày làm bù ở mức integration (đã có unit), membership đã kết thúc, ACL/CHECK của bảng work_request, tự duyệt theo permission của role runtime, "counts on the sheet" và mở lại kỳ (M6), cancel giải phóng thời gian (13c). Phần submit/đọc trong `hrm-approval*` chưa đối chiếu (13c). Dòng `hrm-leave-adjust` :215 (HR mở đơn qua detail) có thể port được, vì detail đã có ở 13b, nhưng chưa làm.
- Root có thể có hồ sơ nhân viên nếu liên kết bằng SQL. Không có route nào làm việc này; test dùng cách đó để kiểm replay và ô root của ma trận.
- Hai case `exhaustive` mà lint báo đã được liệt kê tường minh. `RejectInvalidDate` từ lịch sau khi đã validate được trả như lỗi nội bộ (503), không phải 422.

## Review độc lập (2026-11-09)

Reviewer độc lập (opus, chỉ đọc) kết luận **Approved**, không Critical/Important; tự kiểm lại ba vector hash bằng `apps/api/dist`.

- Minor 1: audit Root khi replay đến từ query submitter commit trước lệnh, không có target, không tái dùng được cho 13c/leave. Điều phối viên chốt (ruling 87): chấp nhận tạm cho commit 13b; bước 13r làm cơ chế chung trong `authority.Execute` (replay có kiểu riêng, append `rootAccess` có target rồi commit) và chuyển cả 13b lẫn `leave.adjust` (13a-fix) sang dùng.
- Minor 2: lint sửa sau lượt integration `app`/`./test` → điều phối viên chạy lại `./test`, integration `app`, lint, gofmt, `git diff --check` trước commit (kết quả ở progress).
- Minor 3: Root query không target ghi outcome `ok` kể cả khi 404 — có từ trước, khớp TS, không sửa.
