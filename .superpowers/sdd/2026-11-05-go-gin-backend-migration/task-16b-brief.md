# Brief Task 16b — M8: các route `role` trên Go

BASE: commit 16a (xem `git log -1`). Đọc trước: `implementer-rules.md` (ràng buộc không nới), `task-16-map.md` (toàn bộ; lát 16b), `task-16-checklist.md` (mục 16b là BẮT BUỘC, từng ô phải được đáp ứng và nêu file:line trong báo cáo), `task-16a-report.md` (API `grant`, `authority.Administer`), phần cuối `progress.md` (ruling 85–104; 101 tính năng trước, test nặng ghi nợ; 103 mỗi bất biến bảo mật có ít nhất một ca từ chối chạy thật), root `AGENTS.md` (Bất biến bảo mật), `apps/api-go/AGENTS.md`, `contract/package-dag.md`, `contract/routes.json`/`openapi.json` phần role, plan Task 16 và "Mẫu cho mỗi nhóm có chuyển route". Module mẫu: `internal/modules/report` hoặc `attendance` (repository/service/controller/http_port, wiring `internal/app`, `httpapi.MigratedRoutes`). Code TS chỉ để hiểu nghiệp vụ; SQL chép nguyên văn.

## Phạm vi

Chuyển toàn bộ route nhóm `role` theo bản đồ (GET roles, GET accounts/:id/permissions, POST/PUT/DELETE roles; nếu bản đồ xếp route nào sang 16c thì theo bản đồ và ghi rõ): types/validator, repository, service, controller + http_port, wiring composition root, `MigratedRoutes`, contract docs nếu lệch. Lệnh role dùng `Execute` qua `role_anchor` như bản đồ. Chuyển cả nhóm trong một lát để digest không lệch giữa hai runtime. Giữ như TS: `readPermissions` id sai → 400. Sắp xếp `localeCompare` của TS → kiểm dữ liệu (key ASCII thì so byte tương đương), ghi nếu lệch.

Bất biến trong CODE không hoãn: default deny; fence độc quyền + kiểm affected set + tăng revision cùng transaction; không sửa/xóa `managed_by = 'code'`; role runtime chỉ chọn `(permission, template)` đã đăng ký; IAM chỉ tạo/sửa role trong tập grant của mình (đọc bị cắt → từ chối); audit atomic với mutation; lỗi một shape `{statusCode, code}`, không thêm mã lỗi; DTO allowlist; mutation dùng `httpapi.DecodeCommand`.

## Test (ruling 101/103)

- Guard/conventions có sẵn phải xanh; guard buộc dòng ma trận cho route trong `MigratedRoutes` thì viết đúng phần guard đòi (`internal/app/m8_matrix_integration_test.go`), không nới guard.
- Smoke HTTP thật (PostgreSQL testcontainers): mỗi route một ca thành công đúng shape; 401 chưa đăng nhập; không grant bị từ chối.
- Mỗi bất biến trong checklist 16b một ca từ chối chạy thật: sửa/xóa role code-owned; grant ngoài tập của actor; cặp chưa đăng ký; `expectedDigest` lệch → 409 (theo TS).
- Phần còn lại (ma trận đầy đủ, đua, mutant, spec TS `hrm-role*`, `hrm-menu-role`, `role-*`, `grant-set` chưa port) thêm vào `test-debt.md` mục "Task 16b", liệt kê spec:dòng.

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-16b-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` cho package role mới và `./internal/app`. Từ root: `pnpm test:browser` (một lần, cuối); prettier Markdown đã đổi; `git diff --check`.

## Báo cáo

`task-16b-report.md`: route đã chuyển (bảng), checklist 16b từng ô → file:line, quyết định tự đưa ra, lệnh + output thật, file đổi, nợ, điều chưa kiểm chứng. Không stage/commit/spawn/tick plan. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
