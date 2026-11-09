# Brief Task 13e — hủy đơn và test đồng thời (M5)

Đọc trước:
- `implementer-rules.md` (ràng buộc không nới; scratchpad theo prompt)
- `handoff-2026-11-09.md`
- Root `AGENTS.md`
- `apps/api-go/AGENTS.md`
- `apps/api-go/contract/package-dag.md`
- Plan Task 13 cùng mục "Mẫu cho mỗi nhóm có chuyển route"
- `task-13a-report.md`, `task-13b-report.md`, `task-13r-report.md`, `task-13c-report.md`
- Ruling 85–90 trong `progress.md`

Working tree: HEAD là commit của 13c. Không dùng lệnh git ghi.

## Phạm vi

1. Route `POST /api/hr/requests/:id/cancel` ở `internal/modules/workrequest`. Nguồn TS: `services/request-cancel.service.ts` và phần cancel của controller, validator, declarations. Test nguồn: `apps/api/test/hrm-cancel.integration-spec.ts`.
   - Hủy đơn đã duyệt phải đảo đủ effect: `leavecore.ReverseApproved`, `attendancecore.ReverseApprovedWfh` và effect attendance. Kiểm tên API thật trước khi dùng.
   - Kỳ đã chốt bị chặn.
   - Có idempotency nếu TS có. Replay dùng cơ chế 13r/13c để Root replay có audit có target.
   - Thứ tự khóa theo TS (ruling 89: chép TS, không tự đổi semantics). Test trình tự SQL.
2. Port các test đồng thời và deadlock bằng PostgreSQL thật:
   - `hrm-cancel-concurrency.integration-spec.ts`
   - `hrm-leave-concurrency.integration-spec.ts`
   - `hrm-attendance-concurrency.integration-spec.ts`
   - `hrm-period-concurrency.integration-spec.ts` (tracker :249)
   - Test thứ tự khóa của lệnh lịch làm việc hoãn từ M4 (tracker, `workschedule`). Ca nào chạm module chưa chuyển (attendance close/reopen của M6) thì để M6 và ghi tracker (ruling 82).
3. Ma trận HTTP ADR-20 §4 cho cancel: thêm vào `m5c` hoặc file mới, tái dùng checker. Thêm route vào `httpapi.MigratedRoutes`. Nếu test proxy dùng cancel làm route "chưa chuyển" thì đổi sang route khác.
4. Mã lỗi chỉ dùng từ `API_ERROR_CODES` có sẵn. DAG: cạnh mới phải sửa cả bảng lẫn khối máy đọc.
5. Đột biến có RED thật, làm qua overlay ngoài repo. Tối thiểu:
   - bỏ một reverse effect
   - bỏ kiểm kỳ đã chốt
   - cho người khác hủy đơn không phải của mình (theo luật TS)
   - bỏ CSRF
   - đảo thứ tự khóa (test concurrency phải đỏ hoặc deadlock được phát hiện)
   - bỏ `FOR UPDATE` của request
6. Tracker, `apps/api-go/AGENTS.md`, ghi chú 13e dưới Task 13 trong plan. Không tick plan.

## Check trước khi báo

Chạy trong `apps/api-go` với `GOCACHE=/private/tmp/hrm-go-cache`. Mỗi lệnh nặng chạy sau `bash /Users/vinhdq2312/Documents/personal/hrm/.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh` (đường dẫn tuyệt đối), chạy tuần tự:
- `go build ./...`
- `go vet ./...`
- `go vet -tags integration ./...`
- `go test -race -count=1 ./internal/...`
- integration `-p 1` từng package `workrequest`, `leavecore`, `attendancecore`, `workschedule`, `app`
- `go tool golangci-lint run`
- `go test -count=1 ./test`
- `gofmt -l .`
- `pnpm test:browser` (chạy từ root)
- `git diff --check`

## Báo cáo

Viết `task-13e-report.md` theo mẫu 13c.
