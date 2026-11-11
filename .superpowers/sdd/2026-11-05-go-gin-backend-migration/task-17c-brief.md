# Brief Task 17c — C1: hạ tầng test Go dùng `hrmctl` thay CLI TypeScript

BASE: commit 17b `3ce6460` (xem `git log -1`; working tree sạch ngoài sổ). Đọc trước: `implementer-rules.md`, `task-17-map.md` (§2 hàng test Go, §5 — nhất là `TestGooseIsOnlyInTheOfflineCommand`, §6 mục 17c, Rủi ro), `task-17a-report.md`, `task-17b-report.md` (lệnh, câu stdout, test integration `cmd/hrmctl`), phần cuối `progress.md` (ruling 105–109: 107 bỏ phần sync TS của `TestGoSyncedFixtureSupportsLegacyTypeScriptVerificationAndRootBootstrap`, phần Root chuyển sang `hrmctl`; 109 template chạy binary `hrmctl` dựng một lần, không import `internal/offline`), `apps/api-go/AGENTS.md` (mục integration, `test.NewDatabase`), root `AGENTS.md`, `contract/package-dag.md`.

## Phạm vi

1. `apps/api-go/test/template.go`: dựng template DB bằng binary `hrmctl` (build một lần mỗi process test, vào thư mục tạm; `provision` đã gồm migrate theo bản đồ — tự xác minh) thay CLI TS; bỏ `apiRoot`/`checkBuilt` và kiểm `dist` cũ nếu không còn ai cần; giữ manifest sync và anchors như hiện tại. Không import `internal/offline` từ `test/` (giữ luật goose).
2. `apps/api-go/test/fixture/fixture.go` (`fixture.Root`) và `pendingRoot` (`internal/authentication/oidc_integration_test.go` và các nơi gọi), `internal/authorization/manifest/reconcile_integration_test.go` (ruling 107): dựng Root bằng `hrmctl bootstrap` (binary), giữ regex câu stdout. Test `reset-root-mfa` của 17a (`cmd/hrmctl/identity_integration_test.go`) tự chuyển theo nếu dùng `fixture.Root`.
3. `apps/api-go/package.json` `test:integration`: bỏ `pnpm --filter @hrm/api run build` nếu sau thay đổi không còn test Go nào gọi CLI/dist TS (tự `rg 'apps/api/dist|tools/product|TypeScriptCLI'` trong `apps/api-go`). Nếu vẫn còn chỗ cần TS thì giữ và nêu lý do.
4. Tài liệu: đoạn integration trong `apps/api-go/AGENTS.md` (bỏ câu "cần `apps/api/dist`" nếu hết đúng), `contract/test-port-tracker.md` nếu nhắc.

Không đổi stack web/dev/docker, root `package.json`, `seed/` (17d). Không sửa `apps/api`. Không đổi semantics của fixture (cùng dữ liệu, cùng câu stdout, cùng Root pending/active như trước).

## Test

- Toàn bộ integration Go phải xanh sau khi đổi hạ tầng: `pnpm --filter @hrm/api-go run test:integration` (hoặc lệnh `go test -race -tags integration -count=1 -p 1 ./cmd/... ./internal/... ./test/...` tương đương nếu script đã đổi). Lỗi môi trường (25P04, tải máy) báo riêng, chạy lại riêng package đó.
- Chứng minh không còn phụ thuộc TS: chạy integration của ít nhất `./test/...` và `./internal/authentication` khi `apps/api/dist` KHÔNG được build lại (không xóa `dist` của người dùng; chỉ cần chứng minh không có lệnh nào đọc nó — ví dụ `rg` + chạy với biến môi trường/đường dẫn khiến CLI TS không thể chạy nếu bị gọi, mô tả cách làm trong báo cáo).
- `go test -count=1 ./test` (luật import, goose) xanh.

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-17c-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./cmd/... ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration toàn bộ như trên. Prettier Markdown đã đổi; `git diff --check`.

## Báo cáo

`task-17c-report.md`: thay đổi, cách template build/gọi `hrmctl`, thời gian dựng template trước/sau nếu đo được (ghi môi trường), bằng chứng không còn phụ thuộc TS, lệnh + output thật, file đổi, nợ, điều chưa kiểm, ghi chú cho 17d. Không stage/commit/spawn/tick plan. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
