# Brief Task 14a — types, validators và hash attendance

Đây là lát đầu của Task 14 M6. Đọc `implementer-rules.md`, `task-14-brief.md`, `task-14-map.md`, AGENTS root/Go và DAG. Bạn chỉ làm 14a, không tự chuyển route hoặc viết commands/repositories. Không stage/commit/spawn; parent điều phối review độc lập và commit. Không revert thay đổi khác; parent giữ progress/handoff. Trả lời và báo cáo bằng tiếng Việt có dấu.

## Phạm vi

- Thêm package `internal/modules/attendance` với types input/output thật cần cho sáu route M6, validator/parser và adjustment hash. Giữ views tương thích web/OpenAPI; không thêm abstraction hoặc wrapper chưa có caller cụ thể trong module M6 tiếp theo.
- Đọc TS `attendance.types.ts`, `attendance.validator.ts`, `attendance.service.ts`, cùng `apps/web/src/features/attendance/attendance.client.ts` để giữ shape. Close body `{}`; reopen `{reason}`; không có expectedVersion. Không tự thêm Idempotency-Key cho close/reopen; chỉ adjustment có key.
- Month/query/date/pagination và UUID dùng helper hiện có theo DAG. Month mặc định của sheet là preference chưa resolve ở parser (clock DB sẽ do query xử lý), không dùng time.Now để quyết định tháng. Reject unknown/duplicate/null/type sai, grammar date và năm có giới hạn; giữ integer/precision, reason/reference bounds. Reference omitted thành null ở hash, explicit null bị từ chối; không trim reference nếu source không trim. Reason có trim/Unicode/NUL và code point length theo helper HTTP hiện hành.
- Adjustment hash là SHA-256 của JSON array `[employeeId,workDate,minutes,reason,reference]`. Dùng typed struct/encoding/json v2, không any/map cho nghiệp vụ; omitted reference mã hóa null. Không hash key. Vector tiếng Việt, dấu tổ hợp, emoji ZWJ, `<>&`, U+2028/U+2029 và signed minutes/null reference. Không chỉ dùng chính hàm Go làm expected; tính độc lập JSON.stringify/SHA-256 hoặc gọi service TS đã build với fake authorization, không sửa NestJS.
- Tests bảng RED trước implementation. Kiểm cả boundaries ±1440, zero và signed grammar đúng source, reference Unicode/64, reason length/source, ngày không hợp lệ và leap-year, key/query lạ/lặp, extra field. Không thay semantics để khớp assertion chưa xác minh.
- Có RED hành vi qua overlay ngoài repo `/private/tmp/hrm-14a-mutants/` cho ít nhất reference omitted/null và hash Unicode/field order hoặc signed grammar; compile failure chỉ chứng minh TDD chưa có API, không thay thế mutant hành vi.
- Không sửa runtime core/auth/authority/schema/contract routes, không thêm inventory/app wiring ở 14a. Nếu cần DAG cạnh thật mới thì báo trước, đừng thêm cạnh chỉ để tái dùng helper private. Cập nhật tracker đúng các parser/hash đã port, không đánh dấu cả attendance suite/Task 14 hoàn tất.
- Báo cáo `task-14a-report.md`, ghi rõ 14b+ chưa triển khai. Không tự tick plan; parent xử lý bằng chứng sau review.

## Check

`GOCACHE=/private/tmp/hrm-go-cache`. Lệnh nặng riêng lẻ, tuần tự sau `bash /Users/vinhdq2312/Documents/personal/hrm/.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh`; escalation khi cần quan sát tải/cache. Không chạy cùng test agent khác.

- `go build ./...`, `go vet ./...`, `go vet -tags integration ./...`.
- `go test -race -count=1 ./internal/modules/attendance` và `go test -race -count=1 ./internal/...`.
- `go tool golangci-lint run`, `go test -count=1 ./test`, `gofmt -l .`.
- Format đúng Markdown đổi và `git diff --check`.

Không yêu cầu browser hay PostgreSQL integration ở 14a vì chưa route/SQL; ghi rõ chưa chạy với lý do này, không tuyên bố M6 runtime đã được kiểm. Không đọc env/seed/secret/PII; không chạm mysql/redis hoặc database không disposable.
