# Báo cáo Task 13r — audit Root khi replay idempotency (ruling 85, 87)

Trạng thái: DONE_WITH_CONCERNS. Cơ chế replay chung đã có trong `authority.Execute`, và `leave.adjust` lẫn `workRequest.submit` đã chuyển sang dùng nó. Mọi check trong brief đã chạy, kết quả ở bảng dưới. Chưa commit, chưa push. Không đổi schema, contract audit, mã lỗi, HTTP contract, OpenAPI, web, NestJS hay dependency. Lo ngại duy nhất nằm ở mục "Quyết định: submit của Root".

## Cơ chế (`internal/authorization/authority/authority_operations.go`)

- `authority.Replay[R](value) (R, error)`: `run` gọi hàm này khi gặp claim đã commit. Hàm trả về lỗi kiểu không export `replayed[R]`, nên module không tự định nghĩa lỗi replay.
- Với Root, `Execute` mở `SAVEPOINT command` ngay trước `run`. Khi `run` trả replay thì `ROLLBACK TO SAVEPOINT command` để bỏ mọi thứ `run` đã ghi, kể cả audit trong lệnh. Sau đó trả `rootAccess(plan, &RequestedKey{Resource, KeyKind, Key}, false)` cho `access`, rồi `access` append, chạy `fulfill` và commit như mọi thao tác của Root.
- Dòng audit dùng contract sẵn có: `access.<resource>.<action>`, `audit.Access{Permission, Root:{ok}, Target}`. `object_id` rỗng, vì validation hiện tại bắt buộc như vậy với mọi `Access` có target (giống dòng `absent` của Root). Không cần đổi schema hay semantics nên không phải NEEDS_CONTEXT.
- Với IAM, `run` trả replay thì cả transaction rollback và không có audit, như trước. Sau `database.Run`, `Execute` bóc `replayed[R]` rồi trả `CommandResult{Found:true, Value}`.
- Fail closed: append lỗi làm `access` trả lỗi và transaction rollback. Caller nhận lỗi, không nhận kết quả replay.
- Chỉ Root mới có savepoint, nên đường IAM không thêm round trip nào.

## Chuyển module

- `leave_adjust_command.go`: bỏ `adjustmentReplayed`, đổi thành `return authority.Replay(result)`. `leave_service.go`: bỏ nhánh `errors.AsType` và import `errors`.
- `work_request_submit_command.go`: bỏ `submitReplayed`, `replay()` giờ trả `authority.Replay(result)`, sửa comment. `work_request_service.go`: bỏ nhánh bắt replay.

## Quyết định: submit của Root (brief yêu cầu "chọn và ghi rõ")

Query submitter (`authority.Read` của `employee.submitRequest`) vẫn cần cho nghiệp vụ. Nó tìm hồ sơ của chính session để làm target cho `Execute`, nên tôi giữ nguyên. Hệ quả: `Read` luôn ghi một dòng access không target cho Root (`access` bắt buộc có audit với Root), ở mọi lần submit, kể cả lần đầu (lần đầu gồm dòng query và `hr.request.submit`).

Tôi chọn như sau: mỗi lần Root replay submit có hai dòng, một dòng query không target và một dòng replay có target là hồ sơ của Root. Dòng replay là dòng có target duy nhất. Dòng query không còn đóng vai trò audit replay, comment và `AGENTS.md` đã ghi lại điều này. Lệnh không có query trước, như `leave.adjust`, có đúng một dòng.

Lý do không làm cho submit chỉ còn đúng một dòng:
- Bỏ audit của `Read` vi phạm bất biến "mọi access của Root được audit".
- Bỏ audit replay riêng cho submit trái ruling 87.
- Gộp query vào lệnh cần một khả năng mới của authority (target tự giải từ session trong transaction). Đó là thay đổi về cách phân giải target, chạm bảo mật, nên tôi không tự làm.

**Nếu điều phối viên hiểu "không audit hai lần" là tổng số dòng phải bằng 1 thì cần chốt một trong các hướng trên.**

## Test

PostgreSQL, viết trước khi có code. RED khi đó là `undefined: authority.Replay`. Hành vi RED được chứng minh bằng đột biến ở mục sau.
- `authority/authority_replay_integration_test.go` (mới). `TestAReplayKeepsNothingButRootsAccessOfTheTarget`: lệnh ghi document và audit rồi mới replay. IAM và Root đều nhận `stored`, document không đổi. IAM thêm 0 dòng. Root thêm đúng 1 dòng `access.document.update` với `object_id` NULL, `principalKind` root, outcome `ok`, `resource` document, `keyKind` uuid, đúng `key`. `TestARootReplayFailsWithoutItsAudit`: trigger chỉ từ chối `access.document.update`, nên Root replay trả lỗi, không có giá trị, document và audit không đổi.
- `leave/leave_adjust_integration_test.go`, `TestARootReplayIsAuditedOnItsEmployeeAndAnIAMReplayIsNot`. Khi `REVOKE INSERT ON audit_outbox`: Root replay nhận 42501 và kết quả rỗng; HR replay vẫn trả kết quả cũ vì không audit. Sau đó replay thật: Root có đúng 1 dòng mới có target là nhân viên, HR có 0 dòng. Ledger, bucket và claim không đổi.
- `workrequest/work_request_submit_integration_test.go`: đổi tên thành `TestARootReplayIsAuditedOnItsProfileAndAnIAMReplayIsNot`. Không dùng `REVOKE`, vì như vậy query submitter sẽ lỗi trước. Thay vào đó, trigger chỉ từ chối dòng `access.employee.submitRequest` có `key`. Root replay nhận P0001 và kết quả rỗng; E replay thành công. Replay thật: Root có 1 dòng có target là hồ sơ, 1 dòng query, tổng 2. E có 0. `requestState` không đổi.
- `app/m5b_matrix_integration_test.go`: `TestM5bARootRetry…` được thay bằng `TestM5ARootRetryIsAuditedOnItsEmployeeAndAnIAMRetryIsNot`, chạy qua HTTP cho cả `leave-adjustments` và `requests`. Kiểm số dòng mới (Root: 1 với adjust, 2 với submit; hr: 0), số dòng có target đúng nhân viên, và state khi IAM replay.
- Ma trận `m5a`/`m5b`: ô idempotency chỉ chạy với actor `hr` (`checkIdempotency`), không kiểm Root, nên không đổi ô nào. Root replay qua HTTP nằm ở test riêng kể trên.
- Unit test thuần cho authority: không có lớp thuần mới. Logic nằm trong `Execute` và cần DB, nên chỉ test bằng integration.

## Đột biến (`go test -overlay`, bản ở `/private/tmp/claude-501/-Users-vinhdq2312-Documents-personal-hrm/f784f0a3-1454-4fff-b01f-38a224bcfd71/scratchpad/13r/mutants/`)

| # | Đột biến | Kết quả |
| --- | --- | --- |
| m1 | Bỏ append khi replay (`&audit.Event{}` thay `rootAccess`) | RED ở authority (0 dòng; replay vẫn trả khi audit lỗi), leave (trả khi audit lỗi, 0 dòng có target), workrequest (0 dòng hồ sơ) |
| m2 | Rollback thay commit (nhánh Root không bao giờ chạy) | RED ở authority, leave, workrequest; HTTP `TestM5ARootRetry…`: adjust 4 → 4, submit 0 dòng có target |
| m3 | Nuốt lỗi append (trả giá trị replay khi `access` lỗi) | RED ở authority `TestARootReplayFailsWithoutItsAudit`, leave, workrequest ("released without its audit") |
| m4 | Không `ROLLBACK TO SAVEPOINT` | RED ở authority (document bị đổi, 2 dòng). Leave và workrequest GREEN, vì replay được phát hiện trước khi lệnh ghi gì |

Lượt đầu, m3 GREEN ở authority. Nguyên nhân: trigger từ chối mọi insert nên `auditDocument` trong `run` lỗi trước replay. Tôi đã sửa trigger để chỉ chặn `access.document.update`, chạy lại thì RED như bảng. Repo không bị sửa khi chạy đột biến. SHA-256 của `authority_operations.go` không đổi trước và sau: `fbd581e4…88246f8`.

## Lệnh và kết quả (từ `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, lệnh nặng chạy sau `waitload.sh`; load khoảng 3, dưới ngưỡng)

| Lệnh | Thời gian | Kết quả |
| --- | --- | --- |
| `go vet -tags integration ./internal/authorization/authority` (trước code) | 21:57 | RED: `undefined: authority.Replay` |
| `go build ./...`, `go vet ./...`, `go vet -tags integration ./...` | 21:58; lại 22:04:17 | exit 0 |
| `go test -race -tags integration -count=1 -p 1 ./internal/authorization/authority` | 21:58:43; lại 22:05:11 sau khi sửa trigger | ok 16.751s; ok 18.629s |
| `… ./internal/modules/leave` | 21:59:14 | ok 25.225s |
| `… ./internal/modules/workrequest` | 21:59:51 | ok 23.087s |
| `… ./internal/app` | 22:00:23 | ok 40.037s |
| `go test -race -count=1 ./internal/...` | 22:04:21 | exit 0, 32 package ok |
| `go tool golangci-lint run` | 22:04:53 | 0 issues |
| `go test -count=1 ./test` | 22:05:00 | ok 4.643s |
| `gofmt -l .` | 22:05 | rỗng |
| `git diff --check` (root) | 22:05 | exit 0 |
| `pnpm exec prettier --check` AGENTS.md, tracker | 22:05 | pass |

Sau khi sửa trigger (chỉ đổi file test authority), chỉ chạy lại integration authority. Leave, workrequest và app integration không phụ thuộc file đó.

Không chạy `pnpm test:browser`, vì contract HTTP không đổi: status, body và shape replay giữ nguyên, chỉ thêm dòng audit cho Root. Không chạy integration `leavecore` hay package khác, vì không đổi file nào ở đó. Ba file test sửa hoặc thêm chỉ chứa ASCII.

## File đã đổi

- Code: `internal/authorization/authority/authority_operations.go`, `internal/modules/leave/{leave_adjust_command,leave_service}.go`, `internal/modules/workrequest/{work_request_submit_command,work_request_service}.go`.
- Test: `internal/authorization/authority/authority_replay_integration_test.go` (mới), `internal/modules/leave/leave_adjust_integration_test.go`, `internal/modules/workrequest/work_request_submit_integration_test.go`, `internal/app/m5b_matrix_integration_test.go`.
- Tài liệu: `apps/api-go/AGENTS.md` (dòng 13a và mục bẫy replay thay ghi chú cơ chế tạm), `contract/test-port-tracker.md` (dòng `hrm-leave-adjust` và `hrm-request`). Plan không tick, không sửa. DAG không đổi, vì không có import mới.

## Điều chưa kiểm chứng và lo ngại

- Submit của Root replay ghi 2 dòng (xem mục Quyết định). Cần điều phối viên chấp nhận cách hiểu này.
- Lệnh `ModeAdmin` nếu sau này dùng `Replay` với Root thì commit vẫn tăng `authz_state.revision` (runner luôn bump khi commit ở admin). Hiện chưa có lệnh admin nào dùng replay, nên tôi không chặn.
- IAM replay không chạy obligation `audit@1` của policy, vì rollback. Đây là hành vi cũ, brief yêu cầu giữ.
- Chưa có review độc lập.

## Review độc lập

Reviewer độc lập (opus, chỉ đọc) kết luận **Approved**, 0 Critical, 0 Important. Đã kiểm: ROLLBACK TO SAVEPOINT bỏ mọi ghi của `run`; append audit lỗi thì fail closed; IAM/Root tách theo session; `object_id` rỗng là đúng contract `Access` có target; `replayed` không bị `database.Run` retry; ruling 88 (2 dòng Root submit) không vi phạm bất biến. Minor để lại, không sửa ở bước này:
1. Lệnh `ModeAdmin` nếu sau này dùng `Replay` với Root sẽ bump `authz_state.revision` dù không đổi facts; hiện không có lệnh admin nào dùng. Khi có thì thêm guard từ chối hoặc tách commit.
2. `Read` không bóc `replayed`; gọi `Replay` ngoài `run` của Command hoặc sai kiểu `R` thành 500 (fail closed, không có đường gọi).
3. `m5b`: phép kiểm "0 dòng có target" của IAM luôn đúng vì lọc `principalKind='root'`; phép kiểm tổng số dòng đã bù.
4. IAM replay không chạy obligation `audit@1` (hành vi cũ, brief yêu cầu giữ).
