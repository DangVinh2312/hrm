# Brief Task 13b — submit và đọc work-request (M5)

Đọc trước theo thứ tự: `implementer-rules.md` (cùng thư mục, ràng buộc không nới; scratchpad dùng thư mục được giao trong prompt), `handoff-2026-11-09.md`, root `AGENTS.md`, `apps/api-go/AGENTS.md`, `apps/api-go/contract/package-dag.md`, plan `docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md` (mục "Mẫu cho mỗi nhóm có chuyển route" và Task 13), `task-13a-report.md` (mẫu báo cáo, cách idempotency/hash/thứ tự khóa của 13a), `task-12-report.md`.

Ghi chú: working tree hiện sạch (HEAD `32e5a6e`), mọi thay đổi chưa commit là của bạn hoặc của người dùng; vẫn không dùng lệnh git ghi.

## Phạm vi

Ba route ở `internal/modules/workrequest` (route-ownership M5):

- `POST /api/hr/requests` (submit, có `Idempotency-Key`)
- `GET /api/hr/requests`
- `GET /api/hr/requests/:id`

Không làm ở 13b: `POST requests/:id/decision`, `POST requests/:id/cancel`, `GET approvals/{lead,final,decided}` (13c). Nếu cần type/projection dùng chung cho 13c thì đặt sẵn nhưng không đăng ký route 13c.

Nguồn nghiệp vụ: `apps/api/src/modules/work-request/**` (controller, validator, `helpers/work-request-submit.helper.ts`, `work-request.helper.ts`, `work-request-sql.helper.ts`, `repositories/work-request-read.repository.ts`, `services/work-request.service.ts`, declarations, http-port, types) và test nguồn `hrm-request*`, `hrm-coo-submit`, phần submit/đọc của `hrm-approval*` trong `apps/api/test`.

## Yêu cầu

1. Theo mẫu plan: test bảng validator/helper đỏ trước → repository/service/handler (handler chỉ nhận facade đã bind; mutation dùng `httpapi.DecodeCommand`; route khai `Classification`; CSRF) → integration PostgreSQL một file mỗi lần → ma trận HTTP ADR-20 §4 ở `internal/app/m5b_matrix_integration_test.go` tái dùng checker M1/M2/M5a (`m1Row{keyed,reuse}`, `waitBlocked`) → thêm 3 route vào `httpapi.MigratedRoutes` (danh sách tường minh như M4/M5a) → `pnpm test:browser` từ root.
2. payloadHash của submit: struct + JSON như cách 13a làm, ghim bằng vector tính từ bản build TS (`apps/api/dist`), gồm lý do tiếng Việt, emoji và phần tử điều kiện `ack`. Replay cùng payload trả cùng kết quả; khác payload → `error.idempotencyKeyReused`.
3. Nghiệp vụ submit dùng API lõi M3 có sẵn: `schedulecore.EmployeeSchedule` và helper khung giờ (`LeaveMinutes`/`LateSegment`/`EarlySegment`/`WfhSegment` hoặc tên thật trong code — kiểm trước khi dùng), `leavecore.AssertAvailable`, `attendancecore.AssertPeriodsOpen`, `attendancecore.WfhLimitExceeded` (cảnh báo/ack), cửa sổ ngày `hr.requestWindow*` qua `settingcore`, đơn chồng lấn → 409, kiểm thành viên team/chain duyệt như TS. Thứ tự khóa của submit chép theo TS và có test trình tự (WireProxy hoặc cách 13a đã dùng).
4. DAG: `workrequest` được import attendancecore, hrbase, leavecore, permission, schedulecore, settingcore. Cạnh mới phải sửa cả bảng lẫn khối máy đọc; `go test ./test` kiểm.
5. Mã lỗi chỉ từ `API_ERROR_CODES` hiện có; không thêm key mới (nếu buộc phải thêm → NEEDS_CONTEXT).
6. Root replay idempotency: giữ hành vi TS (không audit khi replay) — đang chờ người dùng; ghi rõ trong báo cáo.
7. Đột biến có RED thật (ít nhất: bỏ so hash, bỏ kiểm kỳ đã chốt, bỏ chồng lấn 409, bỏ CSRF, scope OR true, đảo thứ tự khóa), làm trên bản sao/overlay ngoài repo như 13a.
8. Cập nhật `contract/test-port-tracker.md` cho các ca nguồn đã port; bẫy mới vào `apps/api-go/AGENTS.md`. Không tick plan.

## Check trước khi báo

Trong `apps/api-go` với `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng sau `waitload.sh`, chạy nền, tuần tự: `go build ./...`, `go vet ./...`, `go vet -tags integration ./...`, `go test -race -count=1 ./internal/...`, integration `-p 1` từng package `workrequest` rồi `app`, `go tool golangci-lint run`, `go test -count=1 ./test`, `gofmt -l .`; từ root `pnpm test:browser`; `git diff --check`.

## Báo cáo

Viết `task-13b-report.md` cùng thư mục theo mẫu 13a.
