# Brief Task 13d — hoàn tất ghép M5 và ma trận tổng

Đọc `implementer-rules.md`, `handoff-2026-11-09.md`, AGENTS root/Go, `contract/package-dag.md`, các báo cáo 13a/13b/13r/13c/13e. Trả lời và viết báo cáo bằng tiếng Việt có dấu. Không commit/stage, không spawn subagent. Không ghi đè thay đổi khác. Không đọc seed, env, secret hoặc PII; chỉ PostgreSQL disposable. Không sửa NestJS nếu stack trộn vẫn chạy.

## Phạm vi

1. Xác minh app ghép đủ 11 route M5 theo `contract/route-ownership.md`, gồm cancel của 13e. Tận dụng các ma trận `m5a`, `m5b`, `m5c`, `m5e` hiện có; thêm guard tổng bằng danh sách route M5 tường minh để không bỏ sót route `authenticated`. Không tạo lại checker hoặc lặp mọi ô đã có.
2. Đọc các dòng tracker M5 còn trống, đối chiếu source test và test Go hiện có. Phần đã được kiểm thì cập nhật đúng đích/symbol và lý do; phần nghiệp vụ M5 thực sự thiếu thì port bằng test PostgreSQL/HTTP phù hợp. Đặc biệt kiểm workflow owner→lead→COO→cancel, Root audit/effect, SQL/evaluator parity work-request/leave, leave detail trong reconciliation, ngày lễ/ngày làm bù/membership kết thúc, permission runtime cho tự duyệt, ACL/CHECK work_request/request_decision/hr_idempotency và các ca approval đang ghi chưa port. Không đánh dấu toàn file nếu còn ca chưa có bằng chứng. Các ca cần attendance/report/admin chưa chuyển giữ dòng riêng cùng task đích, theo ruling 82.
3. Giữ semantics đã chốt ở ruling 85–91. Minor m3 của 13c: queue loại `owner_account_id`, decision chặn cả `e.account_id`, giống TS. Nếu muốn đổi phải báo NEEDS_CONTEXT trước phần phụ thuộc; không âm thầm sửa.
4. Kiểm payloadHash đúng phạm vi: M5 có bốn nơi (leave.adjust, submit, decision, cancel); nơi thứ năm là attendance adjustment (`apps/api/src/modules/attendance/attendance.service.ts:39`) thuộc Task 14. Ghi chú vào plan, chưa tick checkbox năm nơi trước khi Task 14 có bằng chứng. Tương tự ca period :249 phải chờ close thật M6, không dùng SQL fixture để tuyên bố đã port ca end-to-end.
5. Chạy Playwright toàn suite và các check liên quan. Mọi logic/test mới phải có RED thật qua overlay ngoài repo (`/private/tmp/hrm-13d-mutants/`); không đột biến source thật. Guard tổng phải thấy RED khi bỏ một route/ô matrix.
6. Cập nhật tracker, ghi chú plan và `task-13d-report.md` (mẫu 13c/13e). Không tick checkbox tổng hợp khi còn phần thiếu hoặc review chưa chạy. Parent sẽ xử lý trạng thái sau review.

## Check

Trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`; mọi lệnh nặng riêng lẻ, tuần tự sau `bash /Users/vinhdq2312/Documents/personal/hrm/.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh`. Dùng escalation khi cần Docker/localhost/quan sát tải; không chạy cùng test của agent khác.

- `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`.
- `go test -race -count=1 ./internal/...`.
- `go test -race -tags integration -count=1 -p 1 ./internal/app`, và từng package đã đổi khác.
- `go tool golangci-lint run`; `go test -count=1 ./test`; `gofmt -l .`.
- Root: `pnpm test:browser`, Prettier đúng file Markdown đã sửa, `git diff --check`.

Ghi từng exit lỗi, timeout, skip, lỗi môi trường và lần chạy lại. Không gọi suite đầy đủ pass nếu chỉ chạy subset. Báo cáo nêu đúng diff, test, mutants, phần hoãn và lý do; không cần lặp lịch sử phiên.
