# Brief Task 13c — duyệt đơn và danh sách approvals (M5)

Đọc trước theo thứ tự:
1. `implementer-rules.md` (cùng thư mục). Ràng buộc trong đó không được nới. Scratchpad dùng thư mục được giao trong prompt.
2. `handoff-2026-11-09.md`.
3. Root `AGENTS.md`.
4. `apps/api-go/AGENTS.md` (gồm mục replay idempotency của 13r).
5. `apps/api-go/contract/package-dag.md`.
6. Plan `docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md`, mục "Mẫu cho mỗi nhóm có chuyển route" và Task 13.
7. `task-13a-report.md`, `task-13b-report.md`, `task-13r-report.md`.

Working tree: HEAD là commit của 13r. Mọi thay đổi chưa commit là của bạn hoặc của người dùng. Không dùng lệnh git ghi.

## Phạm vi

Bốn route ở `internal/modules/workrequest`:

- `POST /api/hr/requests/:id/decision` (có `Idempotency-Key`, có `ack` trong hash)
- `GET /api/hr/approvals/lead`
- `GET /api/hr/approvals/final`
- `GET /api/hr/approvals/decided`

Không làm ở 13c:
- `POST /api/hr/requests/:id/cancel`, các test deadlock/concurrency `hrm-*-concurrency`, `hrm-period-concurrency` (để 13e).
- Ma trận M5 tổng và `pnpm test:browser` cuối (để 13d).

Có thể đặt sẵn type dùng chung cho cancel nhưng không đăng ký route cancel.

Nguồn nghiệp vụ:
- `apps/api/src/modules/work-request/services/request-approval.service.ts`
- `repositories/request-approval-read.repository.ts`
- Phần decision/approvals của `work-request.controller.ts`, `work-request.validator.ts`, `work-request.declarations.ts`, các helper
- Test nguồn `apps/api/test/hrm-approval.spec.ts`, `hrm-approval.integration-spec.ts`

## Yêu cầu

1. Theo mẫu plan:
   - Test bảng validator/helper đỏ trước.
   - Repository/service/handler. Handler chỉ nhận facade đã bind, mutation dùng `httpapi.DecodeCommand`, route khai `Classification`, CSRF.
   - Integration PostgreSQL, một file mỗi lần.
   - Ma trận HTTP ADR-20 §4 cho 4 route, thêm vào `internal/app/m5b_matrix_integration_test.go` hoặc file `m5c` mới, tái dùng checker sẵn có.
   - Thêm 4 route vào `httpapi.MigratedRoutes`, dùng danh sách tường minh. Sửa test proxy trong `app_test.go` nếu đang dùng `/api/hr/approvals/lead` làm route "chưa chuyển": chọn một route chưa chuyển khác, ví dụ cancel.
2. Chain `lead`/`lead-final` và tự duyệt như TS.
3. `workrequest.ApprovedEffects{Leave, Wfh, Attendance}` cùng `createApprovedEffects` đăng ký đủ ba effect (plan). Thêm test "thiếu effect handler thì loại đơn đóng", chỉ dùng registry test.
4. Dùng API lõi M3 có sẵn, kiểm tên thật trước khi dùng:
   - `leavecore.ApplyApproved`
   - `attendancecore.ApplyApprovedAttendance`, `ApplyApprovedWfh(tx, id, ack)`, `AssertPeriodsOpen`
5. R3 hoãn từ M3: `leavecore.ApplyApproved` hiện trả `ErrCommandRejected` 409 không kèm lý do. Đối chiếu TS: nếu TS phân biệt `not_official`/`insufficient_leave` qua mã lỗi đã có trong `API_ERROR_CODES` (ví dụ `error.insufficientLeave` 422), Go phải trả đúng mã đó. Không thêm mã mới; nếu buộc phải thêm thì báo NEEDS_CONTEXT.
6. payloadHash của decision (3/5 nơi) phải có phần tử điều kiện `ack`. Ghim bằng vector tính từ bản build TS `apps/api/dist`, gồm lý do tiếng Việt và emoji.
7. Idempotency:
   - Replay dùng `authority.Replay(result)` theo cơ chế 13r, để Root replay có audit có target.
   - Thêm test Root replay có 1 dòng có target, IAM replay không có dòng nào.
   - Khác payload trả `error.idempotencyKeyReused`.
8. Thứ tự khóa theo TS: fence → idempotency → employee theo ID tăng → request → bucket → kỳ công FOR SHARE. Viết test trình tự SQL (WireProxy hoặc cách 13a/13b đã dùng).
9. DAG: cạnh import mới phải sửa cả bảng lẫn khối máy đọc.
10. Mã lỗi chỉ lấy từ `API_ERROR_CODES` hiện có.
11. Đột biến có RED thật, làm qua overlay ngoài repo. Tối thiểu:
    - Bỏ một effect trong `createApprovedEffects`
    - Bỏ `ack` khỏi hash
    - Bỏ kiểm kỳ đã chốt
    - Đảo thứ tự khóa
    - Bỏ CSRF
    - Scope OR true ở approvals list
    - Cho phép người không thuộc chain duyệt
    - Nuốt lý do R3
12. Cập nhật `contract/test-port-tracker.md` cho các ca nguồn đã port. Ghi bẫy mới vào `apps/api-go/AGENTS.md`. Không tick plan, chỉ thêm ghi chú 13c dưới Task 13 như 13a/13b.

## Check trước khi báo

Chạy trong `apps/api-go` với `GOCACHE=/private/tmp/hrm-go-cache`. Mỗi lệnh nặng chạy sau `bash ../../.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh`, tuần tự:

- `go build ./...`
- `go vet ./...`
- `go vet -tags integration ./...`
- `go test -race -count=1 ./internal/...`
- Integration `-p 1` từng package: `workrequest`, `leavecore`, `attendancecore`, `app`
- `go tool golangci-lint run`
- `go test -count=1 ./test`
- `gofmt -l .`
- Từ root: `pnpm test:browser`, `git diff --check`

## Báo cáo

Viết `task-13c-report.md` cùng thư mục, theo mẫu 13a/13b: trạng thái, file đổi, test, bảng đột biến, bảng lệnh có thời gian và kết quả, điều chưa kiểm chứng.
