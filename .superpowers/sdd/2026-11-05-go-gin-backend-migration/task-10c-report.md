# Báo cáo Task 10c

Trạng thái: DONE_WITH_CONCERNS — command/handler đã triển khai; app/ma trận session thật ở 10d, review độc lập còn chờ.

## Thay đổi

Bổ sung bảy command vào cùng `NewOperations().All()`/`Bind` của employee: `Create`, `Update`, `Official`, `Terminate`, `UpdateIdentity`, `AdjustLeaveRate`, `LinkAccount`. Routes đăng ký đủ 12 endpoint employee; mọi lệnh ghi dùng `DecodeCommand` (CSRF trước body), không Idempotency-Key. HTTP facade có kiểu input/output tường minh. Không thêm dependency, mã lỗi, schema/ACL hay sửa NestJS/web.

Create target company, fresh theo policy; ghi F1/F2/status và rate cho official cùng giao dịch. Update F1/identity có expectedVersion và unique → 409. Official/termination không fresh, khóa company và chặn tháng đóng; status chain không khoảng trống, ngày nghỉ inclusive. Official chỉ ghi rate mặc định nếu chưa có rate trước đó, audit riêng. Rate trước hired_on bị 409. Link account dùng ModeAdmin/boundary/fresh; kiểm expectedVersion, self cả chiều đến/đi, unchanged, IAM active không suspended, unique link. Không tăng auth_epoch. Mọi effect và audit cùng transaction; audit không chứa F2.

File mới: `employee_command.go`, `employee_status_command.go`, `employee_account_command.go`, `employee_command_service.go`, `employee_write_controller.go`, cùng `employee_command_integration_test.go` và `employee_write_controller_test.go`. Cập nhật service/HTTPPort/route registration, helper `uniqueVersion` xử lý UNIQUE ở cả Query và CollectRows, test inventory 12 route.

## Bằng chứng

Cwd `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`. Các lệnh nặng chạy tuần tự với waitload, được cấp quyền Docker/localhost. PostgreSQL disposable, không chạm mysql/redis.

- RED trước implementation: `go test -race -tags integration -count=1 ./internal/modules/employee -run 'TestEmployeeCreateUpdate|TestEmployeeStatusChain|TestEmployeeLinkAccount'`: ba test FAIL 8.111s, stub trả rejection ở nhánh phải thành công.
- GREEN sau implementation: cùng lệnh, `ok 11.759s`.
- HTTP RED trước đăng ký: `go test -count=1 ./internal/modules/employee -run '^TestEmployeeWriteRoutes'`: 0.025s, bảy route trả 404 thay success/403 CSRF/400 field thừa.
- `go test -race -tags integration -count=1 ./internal/modules/employee`: GREEN 20.692s; sau bổ sung stale identity, fresh/duplicate rate, account unavailable/duplicate và callback từ chối effect cho test self guard: GREEN 15.778s.
- `go build ./...`, `go vet ./...`, `go vet -tags integration ./...`: exit 0.
- `go test -race -count=1 ./internal/...`: exit 0, mọi package qua; employee 1.071s, authentication 9.880s, database 3.092s.
- `go tool golangci-lint run`: exit 0, `0 issues.`
- `go test -count=1 ./test`: exit 0, `ok hrm/api-go/test 4.665s`.
- `pnpm exec prettier --write .superpowers/sdd/2026-11-05-go-gin-backend-migration/task-10c-report.md` và `git diff --check` từ root: exit 0.

## Đột biến

Overlay `/private/tmp/hrm-10c-mutants`, source repo không thay đổi. Lệnh sau waitload và GOCACHE như trên.

| Đột biến | Lệnh | Kết quả |
| --- | --- | --- |
| Bỏ self guard | `go test -race -tags integration -count=1 -overlay /private/tmp/hrm-10c-mutants/self.json ./internal/modules/employee -run '^TestEmployeeLinkAccountBoundarySelfAndEpoch$'` | RED 6.760s, `unlink self accepted: guard reached effect` |
| Bỏ chặn rate trước hired_on | `go test -race -tags integration -count=1 -overlay /private/tmp/hrm-10c-mutants/before.json ./internal/modules/employee -run '^TestEmployeeStatusChainRateAndClosedMonth$'` | RED 5.096s, `before hire accepted` |

## Bao phủ và giới hạn

PostgreSQL thật kiểm duplicate create/F2 rollback, stale version, fresh, F1/identity audit không PII, trigger làm audit lỗi thì mutation rollback, probation không rate, official default rate/audit và chain gapless, invalid status transition, inclusive termination, tháng đóng, link boundary, tự unlink, unchanged/stale/duplicate/unavailable account, auth_epoch không đổi. Unit HTTP kiểm success, CSRF trước JSON hỏng, Origin, body thừa cho cả bảy route. Chưa ghép app/inventory/browser; các ô HTTP boundary/fresh/foreign/absent sẽ kiểm ở 10d. Chưa review độc lập, chưa tick plan.
