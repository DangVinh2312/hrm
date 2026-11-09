# Brief Task 13r — audit Root khi replay idempotency (ruling 85, 87)

Đọc trước: `implementer-rules.md`, `handoff-2026-11-09.md`, root `AGENTS.md` (bất biến Root/audit), `apps/api-go/AGENTS.md` (mục idempotency/Root replay do 13b thêm), `apps/api-go/contract/package-dag.md`, `task-13a-report.md`, `task-13b-report.md` (cả mục "Review độc lập"). HEAD `179cc6b`, working tree sạch.

## Quyết định người dùng

Ruling 85: khi Root gửi lại cùng `Idempotency-Key` + cùng payload (replay thành công), phải ghi access audit cho Root; không được mất do rollback.
Ruling 87 (điều phối viên): 13b đang đạt bằng query submitter commit trước lệnh (không target, không tái dùng được). Thay bằng một cơ chế chung trong `authority` cho lệnh (`Execute`).

## Yêu cầu

1. Trong `internal/authority` (và nơi liên quan theo DAG), thêm cách để lệnh báo "đây là replay" với kết quả của lệnh gốc, ví dụ `run` trả một kết quả replay có kiểu riêng: transaction của lệnh rollback phần ghi (không có mutation), nhưng với Root thì append `rootAccess` có target (resource đích của lệnh, ví dụ employee) và outcome phù hợp với contract audit hiện có, rồi COMMIT dòng audit đó; trả kết quả replay cho caller. Không đổi schema; dùng outcome/kind audit đã có trong contract. Nếu contract audit hiện có không biểu diễn được mà không đổi schema/semantics → NEEDS_CONTEXT.
2. Fail closed: append audit lỗi → caller nhận lỗi, không trả replay thiếu audit. IAM replay giữ hành vi hiện tại (không audit) trừ khi contract hiện có đã yêu cầu khác.
3. Chuyển `workrequest` submit (13b) sang cơ chế mới và bỏ đường audit tạm qua query submitter nếu nó chỉ tồn tại vì replay (nếu query vẫn cần cho nghiệp vụ thì giữ, nhưng không để Root bị audit hai lần cho một replay — chọn và ghi rõ). Chuyển `leave.adjust` (13a, `internal/modules/leave/leave_adjust_command.go`) sang cơ chế mới.
4. Test PostgreSQL: cho cả submit và leave.adjust — Root replay có đúng một dòng audit mới có target đúng; IAM replay không thêm dòng; state không đổi; audit lỗi khi replay → lỗi, không phản hồi replay. Cập nhật ma trận `m5a`/`m5b` nếu ô idempotency của Root kiểm audit. Unit test cho authority nếu có lớp thuần.
5. Đột biến có RED thật (ít nhất: bỏ append audit khi replay; rollback thay vì commit audit; nuốt lỗi append).
6. Cập nhật `apps/api-go/AGENTS.md` (thay ghi chú cơ chế tạm), tracker nếu liên quan. Không tick plan.

## Check trước khi báo

Như brief 13b: build, vet, vet integration, unit race `./internal/...`, integration `-p 1` từng package `authority`, `leave`, `workrequest`, `app`, lint, `./test`, gofmt, `git diff --check`. Không cần `pnpm test:browser` nếu không đổi contract HTTP (ghi rõ).

## Báo cáo

`task-13r-report.md` cùng thư mục.
