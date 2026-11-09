# Báo cáo Task 13e — hủy đơn và test đồng thời (M5)

Trạng thái: DONE_WITH_CONCERNS. Repo `/Users/vinhdq2312/Documents/personal/hrm`, branch `version/single-app`, HEAD `639f991`. Nhận lại working tree có code cancel cùng năm file untracked; giữ nguyên phần triển khai đó và hoàn tất các phần còn thiếu. Hai finding coverage đã sửa trong vòng 1; parent quản lý kết quả scoped re-review và bước commit. Chưa stage/commit/push; không tick kế hoạch.

## Hành vi và file

- `POST /api/hr/requests/:id/cancel`: `authenticated`, body qua `DecodeCommand` (Origin/CSRF trước body), `Idempotency-Key` bắt buộc; thành công 200 `{id,state,version}`. `cancelBody` chỉ nhận `expectedVersion` và reason tùy chọn/null; reason bắt buộc khi hủy approved, kiểm trên request đã khóa. Không thêm mã lỗi, schema, migration, declarations, OpenAPI hay dependency; contract đã có route và status.
- `work_request_cancel_command.go`: hai command `cancel`/`cancelApproved`; kiểm claim, version, transition, reason; approved annual-leave gọi `leavecore.ReverseApproved`, WFH gọi `attendancecore.ReverseApprovedWfh`, mọi approved kind gọi `ApplyApprovedAttendance` để giữ kỳ công mở FOR SHARE. Rời state approved là bỏ effect khỏi reader công, không có bảng effect attendance riêng cần xóa.
- `work_request_service.go`, `_controller.go`, `_http_port.go`, `_types.go`, `_validator.go`: nối route tới service; đọc facts bằng `workRequest.read`, chọn command theo state đã lưu, plan và version kiểm lại trong transaction. Owner hủy pending; HR fresh hủy approved với reason. Owner approved nhận 409, caller ngoài scope/absent cùng 404. Terminal/stale 409, thiếu reason 400, khác payload dưới cùng key 422 `error.idempotencyKeyReused`.
- `work_request_approval_repository.go`, `_decision_command.go`, `_decision_helper.go`: dùng chung `readFacts(operation)`, `factsKey`, `requestFacts`, `writeMove`, `claimMove(operation)`, `arrayHash` cho decision/cancel. Decision vẫn truyền operation, stage, audit kind, version, reason cũ; thứ tự update → decision → claim → audit không đổi. Hash decision giữ thứ tự phần tử và đuôi true có điều kiện. `Owner` mới chỉ dùng trong cancel.
- `internal/httpapi/inventory.go`: thêm cancel vào `MigratedRoutes`. `internal/app/auth_routes_integration_test.go`: thêm cancel vào cả `validBodies` và `validKeys` để fixture đến bước resolve session.
- Test: `work_request_cancel_test.go`, `work_request_cancel_integration_test.go`, `work_request_concurrency_integration_test.go`, `internal/modules/workschedule/work_schedule_lock_integration_test.go`, `internal/app/m5e_matrix_integration_test.go`.
- Tài liệu: `apps/api-go/AGENTS.md`, `contract/test-port-tracker.md`, ghi chú 13e dưới Task 13 trong plan. Không sửa progress/handoff do parent sở hữu. DAG đã cho phép các cạnh attendancecore/leavecore; không thêm cạnh mới.

## Quyết định và phạm vi

1. Giữ thứ tự khóa TS/ruling 89: fence → request (Execute, FOR NO KEY UPDATE) → đọc idempotency → bucket hoặc WFH counter theo tháng tăng → kỳ công FOR SHARE. Không tự thêm khóa employee/calendar. Test PostgreSQL giữ khóa phía sau rồi dùng lock_timeout 50 ms xác nhận khóa phía trước đã bị command giữ; không dùng WireProxy.
2. Replay qua query facts giữ quyền read hiện tại, Root ghi `access.workRequest.read` có target như ruling 91. Khi Root replay ngay trong command đang cạnh tranh khóa, dùng `authority.Replay`, có đúng một `access.workRequest.cancelApproved` có target. IAM replay không ghi audit hay effect thêm.
3. Minor m3 của 13c không đổi: `lockedRequest` kiểm self theo `owner_account_id OR e.account_id`; `readQueue`/`readDecided` loại đơn mình theo `owner_account_id`. Giữ semantics TS, không xử lý việc chuyển account trong task này.
4. Proxy callers đã dùng `GET /api/hr/reports/birthday` làm route chưa chuyển trong `internal/app/app_test.go`; không còn dùng cancel, không cần sửa tiếp.
5. Ma trận cancel dùng checker M1 cho cả pending và approved. Freshness approved kiểm riêng request hiện diện (403) và absent (404): service đọc facts trước bước fresh, trong khi checker chung giả định cùng status cho hai ca. Pending không có fresh@1. Không sửa checker dùng chung để ép semantics mới.
6. Theo ruling 82, close/reopen/snapshot thật để M6: cancel-close, approval-close, calendar-close và `hrm-period-concurrency` :249 ba lệnh đồng thời. Guard kỳ đóng và lock order hiện đã kiểm bằng PostgreSQL; không gọi đó là port cuộc đua với close thật. Tracker tách riêng sheet/reopen chưa chuyển.
7. Ruling 86: tracker upgrade TypeScript trước migration 7 được đánh `bỏ`, do Task 19 dựng lại database dev theo Q5 và ADR-14/ADR-22. Không hỏi lại quyết định đã chốt.
8. Hash cancel đạt 4/5 nơi của kế hoạch tổng; nơi thứ năm là attendance adjustment thuộc M6, không tick cả năm ở Task 13.

## Bằng chứng test

Unit cancel kiểm allowlist body, UUID/key/version, reason null/trim/độ dài, field sai/field thừa. Bốn vector hash bao gồm reason null, tiếng Việt, dấu tổ hợp, emoji ZWJ, `<>&`, U+2028/U+2029/U+0085/U+00A0. `node /private/tmp/hrm-13e-hashes.mjs` gọi `RequestCancelService.cancel` của build TS để bắt hash, đồng thời tính độc lập JSON.stringify + SHA-256: 4 MATCH, exit 0 (`/private/tmp/hrm-13e-hashes.log`). Không build hay sửa NestJS.

PostgreSQL cancel kiểm owner pending/các caller bị từ chối, approved cần HR fresh và reason, version/terminal, reversal đầy đủ một lần và UNIQUE, WFH counter chỉ giảm đúng số ngày, kind còn lại rời approved, replay/khác payload, kỳ đóng rollback mọi ghi, audit lỗi rollback state/claim/ledger/counter, approval replay sau cancel, absent/foreign, audit Root có target và IAM không ghi. Lock order kiểm request → bucket/counter và bucket/counter → period.

Concurrency PostgreSQL kiểm hai cancel khác key/cùng key, owner cancel đua final ở cả thứ tự, Root concurrent replay, WFH chỗ cuối/counter chưa có row, hai approval tranh bucket mới, hai submit tranh phút phép cuối, submit gặp decision không vượt quỹ, kỳ đóng sau debit rollback bucket/debit, audit lỗi sau final effect rollback toàn bộ rồi cùng key retry/replay, bucket/debit theo năm và ngày thử việc, revoke role đua approval, timeout rồi cùng key retry. Các ca approve/approve và approve/reject trên một request đã có ở 13c và được chạy lại trong full package.

HTTP `m5e` kiểm pending/approved với signed out, expired, suspended, thiếu grant, deny, scoped/absent, Root, CSRF, Origin, input sai/field thừa, replay cùng body/khác payload/thiếu-sai-lặp key; freshness có test riêng. Ô từ chối so state/audit không đổi. HTTP replay Root thêm đúng một audit có target, IAM không ghi gì.

## RED và đột biến

Code và phần lớn test đã có khi nhận working tree; không có bằng chứng RED trước lúc triển khai phần đó. Tôi không xóa code được bàn giao để tạo lịch sử TDD giả. Baseline app có RED thật ở `TestEveryAuthenticatedRouteResolvesTheSession`: cancel no-such-session/revoked trả 400 thay vì 401 do fixture thiếu body/key, rồi GREEN sau sửa fixture.

Sáu đột biến dùng `go test -overlay`, chỉ tạo bản sao ngoài repo tại `/private/tmp/hrm-13e-mutants/`; source thật không bị chỉnh để gây lỗi. Recipe: `/private/tmp/hrm-13e-mutations.py`. Mỗi lệnh dùng `GOCACHE=/private/tmp/hrm-go-cache`, chạy tuần tự sau `bash /Users/vinhdq2312/Documents/personal/hrm/.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh`, thêm `-race -tags integration -count=1 -p 1 -timeout 3m`.

- m1-reverse: bỏ reverseLeave. `TestCancellingApprovedLeaveReversesEveryDebitOnce` RED: thiếu hai reversal và UNIQUE không còn chặn lần reversal thử đầu tiên; exit 1, 7.064s. Log `/private/tmp/hrm-13e-m1-reverse.log`.
- m2-period: bỏ `ApplyApprovedAttendance` trong reverseApproved. `TestAClosedMonthRefusesTheCancellation` RED: hủy thành công dù kỳ đóng và state/ledger/counter đổi; exit 1, 6.943s. Log `/private/tmp/hrm-13e-m2-period.log`.
- m3-owner: cancelPending dùng quyền read thay cancel. `TestTheOwnerCancelsAPendingRequestAndNobodyElseDoes` RED: lead L hủy được đơn của E; exit 1, 6.853s. Log `/private/tmp/hrm-13e-m3-owner.log`.
- m4-csrf: bỏ CSRF trong DecodeCommand riêng path cancel. `TestTheM5eCancelAnswersEveryCellOfTheMatrix` RED: csrf nhận 200 và đổi state, các assertion sau cũng phát hiện dữ liệu đổi; exit 1, 8.786s. Log `/private/tmp/hrm-13e-m4-csrf.log`.
- m5-order: kiểm/khóa period trước reverse effect. `TestTheCancellationLocksRequestThenBucketOrCounterThenPeriod` RED: bucket/counter còn tự do khi cancellation chờ period; exit 1, 7.298s. Đây là RED của invariant thứ tự khóa, không phải bằng chứng tái hiện deadlock thật. Log `/private/tmp/hrm-13e-m5-order.log`.
- m6-request-lock: overlay `authority/sql_gateway.go` bỏ FOR NO KEY UPDATE riêng resource workRequest. Test lock order trên RED: request còn tự do khi cancellation chờ bucket/counter; exit 1, 7.343s. Không sửa source authority thật. Log `/private/tmp/hrm-13e-m6-request-lock.log`.

Không mutant nào dùng compile failure làm RED. Gate sau đột biến chạy source thật, không overlay.

## Lệnh và kết quả

Các lệnh nặng đều chạy riêng, tuần tự sau waitload đường dẫn tuyệt đối, bằng escalation để đọc được tải máy/Docker/localhost. Load kiểm riêng trước baseline là 3.48, không có tiến trình playwright/tools-test/vitest khác. Log gate tổng `/private/tmp/hrm-13e-gates.log`; log riêng `/private/tmp/hrm-13e-gate-<tên>.log`. Không đọc env/secret/seed, không chạm staging/production hoặc container mysql/redis.

- Baseline `go test -race -tags integration -count=1 -p 1 ./internal/modules/workrequest`: exit 0, 73.744s; `/private/tmp/hrm-13e-baseline-workrequest.log`.
- Baseline cùng lệnh cho `./internal/app`: exit 1, 50.581s; một test lỗi fixture session như trên; `/private/tmp/hrm-13e-baseline-app.log`. Kết quả này được giữ riêng, không gọi baseline suite pass.
- Focused app `-run 'TestTheM5e|TestM5e|TestEveryAuthenticatedRouteResolvesTheSession' -timeout 5m`: exit 0, 13.614s; `/private/tmp/hrm-13e-matrix.log`.
- Focused workrequest `-run 'TestTwoSubmitsRacing|TestARootCancellationRacing' -timeout 5m`: exit 0, 8.943s; `/private/tmp/hrm-13e-new-concurrency.log`.
- `go build ./...`: exit 0.
- `go vet ./...`: exit 0.
- `go vet -tags integration ./...`: exit 0.
- `go test -race -count=1 ./internal/...`: exit 0, 32 package ok.
- Integration full `go test -race -tags integration -count=1 -p 1 -timeout 5m` từng package: workrequest exit 0 (80.997s), leavecore exit 0 (8.601s), attendancecore exit 0 (14.443s), workschedule exit 0 (10.253s), app exit 0 (58.094s).
- `go tool golangci-lint run`: lượt đầu exit 1, exhaustive báo reverseApproved thiếu case unpaid/late/early. Thêm ba case tường minh không có reverse ledger/counter riêng, vẫn chạy attendance guard cuối hàm. Chạy lại exit 0, `0 issues.`; `/private/tmp/hrm-13e-gate-lint-r2.log`. Không dùng default hay tắt rule.
- `go test -count=1 ./test`: exit 0, 4.703s, gồm conventions/DAG/contract; `/private/tmp/hrm-13e-gate-conventions.log`.
- Sau sửa exhaustive, chạy lại integration cancel `-run 'Test.*Cancel|TestCancelling|TestOnlyAFreshHR|TestTheOwner|TestAClosedMonthRefuses|TestAnAuditFailureRollsBackTheCancellation|TestAStranger'`: exit 0, 24.862s; `/private/tmp/hrm-13e-cancel-final.log`.
- `gofmt -l .`: exit 0, output rỗng; `/private/tmp/hrm-13e-gate-gofmt.log`. Sửa format source qua patch, không chạy gofmt ghi file.
- `pnpm exec prettier --check apps/api-go/AGENTS.md apps/api-go/contract/test-port-tracker.md docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md`: exit 0, matched files pass. Tracker thuộc `.prettierignore`, không coi là đã được formatter kiểm.
- `pnpm exec prettier --check --ignore-path /dev/null .superpowers/sdd/2026-11-05-go-gin-backend-migration/task-13e-report.md`: exit 0; `/private/tmp/hrm-13e-report-format.log`.
- `pnpm test:browser` từ root sau waitload tuyệt đối: exit 0, 30 passed (3.2m); `/private/tmp/hrm-13e-browser.log`. Lệnh tự build Go trước Playwright. Có warning NO_COLOR/FORCE_COLOR của Node, không test lỗi. Không chạy lại browser cho delta chỉ sửa test của vòng review 1.
- `git diff --check` cuối: exit 0, không output. Đã xem danh sách tracked/untracked: thay đổi của task ở Go/tests/AGENTS/tracker/plan/báo cáo; progress là thay đổi của parent. Không thêm dependency, lockfile, artifact generated được Git theo dõi hay sửa NestJS/web.

## Review độc lập — vòng sửa 1

Reviewer báo Needs fixes với hai Important về coverage, chưa chỉ ra bypass runtime:

1. I1: ô deny trong matrix ban đầu dùng actor có deny workRequest.read nên dừng ở facts, chưa tới deny cancel/cancelApproved; pending còn không thuộc actor đó. Thêm `TestM5eCancellationDeniesWinWhileTheRequestRemainsReadable`: HR có allow và deny chỉ trên đúng action cancel, read vẫn 200; pending thuộc chính HR, approved thuộc chủ đơn khác; cancel trả 404, toàn bộ state/audit không đổi. Giữ ô deny-read cũ làm coverage bổ sung, không coi nó thay thế hai ca mới.
2. I2: tracker ban đầu nói đã port cuộc đua final nhưng `TestDecisionsInFlightLeaveOneDecision` của 13c chỉ chạy lead. Thêm `TestFinalWfhDecisionsRacingLeaveOneDecisionAndItsCounter`: COO trên WFH pending_final, hai cuộc đua approve/approve và reject/approve, đúng một stale và một final decision; state khớp decision và counter chỉ tăng khi final approve thắng, gồm nhánh reject thắng. Tracker nêu đúng tên test và bước final.

Ngoài hai finding, bổ sung assertion đơn phép bị từ chối duyệt do thiếu quỹ vẫn reject được trong `TestLeaveApprovalsRacingForTheLastMinutes`, khớp ca nguồn :381. Các thay đổi vòng 1 chỉ ở test, tracker và báo cáo; không đổi runtime.

Bản trước sửa do parent giữ tại `/private/tmp/hrm-13e-fix1-before/`. Overlay dùng source thật và bản sao ngoài repo như sáu đột biến trên, không sửa runtime để gây RED. Ba RED mới compile được và lỗi ở assertion hành vi:

- `r1-deny-pending`: cancelPending dùng quyền read thay cancel. HTTP deny riêng workRequest.cancel RED: vẫn read được, cancel nhận 200 và đổi state/audit; exit 1, 7.423s. Log `/private/tmp/hrm-13e-r1-deny-pending.log`.
- `r1-deny-approved`: cancelApproved dùng quyền read thay cancelApproved. HTTP deny riêng workRequest.cancelApproved RED: cancel nhận 200 và đổi state/audit; exit 1, 7.234s. Log `/private/tmp/hrm-13e-r1-deny-approved.log`.
- `r1-final-wfh`: Wfh handler trả nil không tăng counter. Cuộc đua final approve/approve RED: approved nhưng counter 0 thay vì 1; exit 1, 7.085s. Log `/private/tmp/hrm-13e-r1-final-wfh.log`.

GREEN targeted: app exit 0 (10.049s), workrequest exit 0 (9.518s, gồm test reject sau thiếu quỹ); log `/private/tmp/hrm-13e-fix1-target-app.log`, `/private/tmp/hrm-13e-fix1-target-workrequest.log`. Full integration app/workrequest và lint/conventions/format/diff sau sửa đã pass, chi tiết bên dưới; log tổng `/private/tmp/hrm-13e-fix1-gates.log`. Không chạy lại build/vet/browser vì vòng sửa chỉ đổi test và tài liệu; các lệnh ban đầu và browser đã chạy ở mục trên.

- Full workrequest: exit 0, 84.369s; `/private/tmp/hrm-13e-fix1-workrequest.log`.
- Full app: exit 0, 67.246s; `/private/tmp/hrm-13e-fix1-app.log`.
- Lint: exit 0, `0 issues.`; `/private/tmp/hrm-13e-fix1-lint.log`.
- Conventions/DAG: exit 0, 4.923s; `/private/tmp/hrm-13e-fix1-conventions.log`.
- `gofmt -l .`: exit 0, rỗng; `/private/tmp/hrm-13e-fix1-gofmt.log`.
- Report format qua Prettier với `--ignore-path /dev/null` và `git diff --check`: exit 0.

## Điều chưa kiểm chứng và lo ngại

- Review vòng đầu có hai Important về coverage; đã thêm test có RED/GREEN và parent quản lý kết quả scoped re-review. Chưa commit/push; không tuyên bố production-ready từ fixture local.
- Các ca cần attendance close/reopen/sheet/snapshot thật chuyển M6 theo tracker, ma trận M5 tổng và đánh dấu Task 13 do 13d xử lý.
- Browser dùng stack trộn hiện hành; sheet/close/reopen còn ở upstream NestJS, nên browser GREEN không chứng minh các route M6 đã chuyển sang Go.
- Không thay semantics Minor m3, không thêm schema/quyền hay nới assertion để che lỗi. Độ nhạy phần code được bàn giao được chứng minh bằng mutation RED, không phải bằng lịch sử RED trước implement.

## Kết quả review độc lập do điều phối viên ghi

Reviewer `review_13e` (`gpt-6-astra`, high) đọc diff và log thô, không đọc báo cáo hay kết luận implementer. Vòng đầu: Spec chưa đạt / Quality Needs fixes, hai Important về coverage I1/I2 ở mục vòng sửa. Không thấy lỗi runtime cụ thể ở cancel hoặc refactor decision.

Scoped re-review vòng 1 xác nhận cả hai **ADDRESSED**, không thấy breakage mới. Test deny kiểm GET vẫn 200, có allow hợp lệ và deny riêng cancel/cancelApproved, POST 404 và state/audit không đổi. Test final WFH kiểm đúng bước pending_final, một stale, một final decision và counter khớp state; assertion reject sau thiếu quỹ chọn đúng bên thua và giữ đúng một debit. Reviewer xác nhận ba log RED mới, focused GREEN và browser 30 passed; không chạy lại suite.

Điều phối viên đã kiểm diff, log gate ban đầu và gate sau sửa, chín mutant RED hành vi và `git diff --check` exit 0. Task 13e đủ điều kiện commit riêng; các ca M6 và Minor m3 vẫn được ghi rõ, không tuyên bố đã hoàn tất Task 13–19.
