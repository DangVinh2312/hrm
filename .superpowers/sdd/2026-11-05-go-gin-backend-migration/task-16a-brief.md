# Brief Task 16a — nền cho M8: package `authorization/grant` + primitive admin trong `authority`

BASE `e51a23d`. Đọc trước: `implementer-rules.md` (ràng buộc không nới), `task-16-map.md` (toàn bộ, đặc biệt mục 2, 3, 5 lát 16a, 6), phần cuối `progress.md` (ruling 85–104; 101: tính năng trước, test nặng ghi nợ `test-debt.md`; 102: thêm primitive admin tương đương `access(..., 'admin', work, rootEvent)` của TS; 103: mỗi bất biến bảo mật có ít nhất một ca từ chối chạy thật), root `AGENTS.md` (Bất biến bảo mật), `apps/api-go/AGENTS.md`, `contract/package-dag.md`, plan Task 16.

## Phạm vi

1. Package `internal/authorization/grant` theo package-dag: kiểu grant set, canonical JSON + digest (phải cho cùng digest với TS trên cùng dữ liệu vì stack trộn tới 16b còn đọc chéo; nếu không thể bằng byte thì trả NEEDS_CONTEXT kèm ca tái hiện), so sánh tập grant (tập con / "đích không có tập lớn hơn"), chọn `(permission, template)` chỉ từ tập đã đăng ký. Thuần, không DB nếu TS thuần.
2. Primitive admin trong `internal/authority` (file mới `authority_admin.go` hoặc tên theo quy ước): detail đích + reachesIn + boundary + Root event trong cùng transaction, đúng thứ tự khóa/fence của TS; Root bypass qua `planUnrestricted` có audit; fail closed khi thiếu policy/adapter. Không export credential/raw connection cho handler.
3. Chưa thêm route, chưa đổi `MigratedRoutes`. Cập nhật `package-dag.md` nếu thêm cạnh, `apps/api-go/AGENTS.md` bẫy mới.

## Test (ruling 101/103)

- Unit bảng cho `grant` (digest ổn định theo thứ tự key/phần tử, tập con, tập lớn hơn, cặp chưa đăng ký bị từ chối) — đỏ trước.
- Integration tối thiểu (PostgreSQL testcontainers) cho primitive admin: IAM có grant + trong boundary → chạy `work`; không grant → từ chối; ngoài boundary → từ chối; đích Root → từ chối; Root actor → chạy và có audit. Mỗi ca một assertion cốt lõi.
- Phần còn lại (ma trận, đua, mutant, spec TS chưa port) thêm vào `test-debt.md` (bảng có sẵn, thêm mục "Task 16a").

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-16a-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` chỉ package đã chạm. Prettier Markdown đã đổi; `git diff --check`.

## Báo cáo

`task-16a-report.md`: đã làm, API mới (chữ ký), đối chiếu TS file:line, quyết định tự đưa ra, lệnh + output thật, file đổi, nợ, điều chưa kiểm chứng. Không stage/commit/spawn/tick plan.
