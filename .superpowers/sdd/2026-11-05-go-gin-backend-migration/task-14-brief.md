# Brief Task 14 — M6 attendance

Đọc `implementer-rules.md`, handoff/progress, AGENTS root/Go, `contract/package-dag.md`, `contract/route-ownership.md`, tracker, plan Task 14 và mẫu chuyển route. Trả lời và viết báo cáo bằng tiếng Việt có dấu. Không stage/commit/spawn. Bạn không làm một mình: không revert thay đổi người khác, đọc lại file trước patch. Không đọc seed/env/secret/PII, chỉ PostgreSQL disposable; không chạm mysql/redis. NestJS đóng băng.

## Phạm vi

Port sáu route M6 vào `internal/modules/attendance`, ghép composition app và inventory, giữ contract web/Go và mọi bất biến bảo mật. Nguồn nghiệp vụ: `apps/api/src/modules/attendance` và các test `hrm-attendance*`, `hrm-period-concurrency` trong tracker; Go sở hữu contract theo ADR-22, không yêu cầu so byte toàn bộ với TS.

- Bảng công một nhân viên và trạng thái/lịch sử kỳ công.
- Close/reopen kỳ: fresh, CSRF/Origin; close nhận body rỗng, reopen chỉ nhận `{reason}`, không thêm expectedVersion (validator TS, input types và web client hiện tại đều không có field này). Kiểm trạng thái dưới khóa như semantics hiện hành; snapshot immutable/version/hash; audit atomic. Đọc toàn bộ facts khi close bằng `attendancecore.LoadAllFacts`, dùng `BuildSnapshot`/`VerifiedSnapshot` với tên API thật kiểm từ source. Đọc bảng công theo phạm vi dùng `LoadFacts` đúng employee IDs, không nil thành toàn bộ.
- Điều chỉnh công: signed minutes theo grammar có giới hạn, reason/reference, Idempotency-Key và hash `[employeeId,workDate,minutes,reason,reference]` (nơi thứ năm của plan Task 13), replay/reuse; Root replay có audit có target qua `authority.Replay` (85/87), IAM giữ semantics cũ. Không thêm mã lỗi.
- Handler chỉ facade đã bind, decoder chặt, route classification; lỗi `{statusCode,code}`. Không đổi schema/ACL/identity semantics khi chưa có quyết định, không tắt guard/validation để test xanh.
- Snapshot format 1/2 và canonical hash; vì report còn proxy NestJS (M7), phải kiểm đọc snapshot Go trên stack trộn bằng fixture phù hợp Review Focus 3. Không tuyên bố đã kiểm provider/production.
- Port đầy đủ concurrency còn hoãn từ M4/M5: cancel-close, approval-close (WFH/leave), điều chỉnh-close, close/reopen cạnh tranh, calendar/schedule/submit/close. Bắt buộc ca `hrm-period-concurrency.integration-spec.ts:249`: submit, đổi lịch, chốt cùng tháng không deadlock. Chạy lệnh Go thật, không coi SQL giả chốt là test end-to-end ca này. Giữ thứ tự khóa TS đã chốt (89); phát hiện mâu thuẫn dữ liệu/bảo mật thì báo NEEDS_CONTEXT trước sửa semantics.
- Ma trận HTTP đủ sáu route ADR-20 §4 dùng checker hiện có; input/version/field thừa/no grant/deny/boundary/fresh/CSRF/Origin/foreign/absent/idempotency/audit rollback. Đổi test proxy/validBodies/keys khi route chuyển; DAG đổi cả bảng và khối máy đọc.
- Cập nhật tracker theo từng ca thực tế; những dòng CROSS M5 cần sheet/reopen nay có thể hoàn tất thì port. Cập nhật AGENTS nếu có bẫy mới, plan với bằng chứng nhưng không tự tick trước review. Báo cáo `task-14-report.md` theo mẫu 13e/13d.

## RED/GREEN và check

Test bảng validator/helper phải đỏ trước implementation. PostgreSQL thật cho khóa/transaction. Mutant qua overlay ngoài repo (`/private/tmp/hrm-14-mutants/`), ít nhất nhạy với: bỏ period guard, bỏ reverse/effect khi close race, snapshot/hash sai hoặc lọt phạm vi, bỏ CSRF/fresh, bỏ so hash idempotency và đổi thứ tự khóa. Compile failure không tính RED hành vi. Không đột biến source thật.

`GOCACHE=/private/tmp/hrm-go-cache`; mọi lệnh nặng riêng lẻ, tuần tự sau `bash /Users/vinhdq2312/Documents/personal/hrm/.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh`. Escalation khi cần quan sát load/Docker/localhost, không chạy chồng test agent khác.

- `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`.
- `go test -race -count=1 ./internal/...`.
- `go test -race -tags integration -count=1 -p 1` từng package liên quan và `./internal/app`; ghi rõ subset, không gọi full integration pass khi chưa chạy.
- `go tool golangci-lint run`; `go test -count=1 ./test`; `gofmt -l .`.
- Root: `pnpm test:browser`, Prettier file Markdown đổi và `git diff --check`.

Mọi exit lỗi/timeout/skip/môi trường và lần chạy lại phải ghi riêng; đừng in connection string hoặc SQL binds. Nếu quá lớn, báo điểm chia nhỏ có thể commit/review riêng, không tự cắt bỏ yêu cầu.
