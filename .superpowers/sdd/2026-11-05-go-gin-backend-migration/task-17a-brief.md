# Brief Task 17a — C1: khung cờ `hrmctl` + `purge-sessions` + `enroll` + `reset-mfa`/`reset-root-mfa`

BASE: commit `702bf2c` hoặc mới hơn (xem `git log -1`; working tree phải sạch ngoài sổ). Đọc trước: `implementer-rules.md`, `task-17-map.md` (toàn bộ; §0 hiện trạng, §1 bảng lệnh TS, §5 ràng buộc import, §6 mục 17a, Rủi ro), phần cuối `progress.md` (ruling 100–109; nhất là 105 DB dev giữ CLI TS tới Task 19, 109 giữ câu stdout của TS), root `AGENTS.md` (Bất biến bảo mật: Root ngoài IAM, Root-only chỉ CLI offline; Secrets/PII không ghi log), `apps/api-go/AGENTS.md`, `apps/api/src/database/AGENTS.md` (login theo mục đích), `contract/package-dag.md`, plan Task 17. Code TS (`apps/api/tools/product.ts` và các file nó gọi) chỉ để hiểu nghiệp vụ; SQL chép nguyên văn.

## Phạm vi

Trong `apps/api-go/cmd/hrmctl` và `apps/api-go/internal/offline`:

1. Bộ đọc cờ giống TS: cặp `--k v`, không trùng, allowlist theo lệnh, bỏ một `--` đầu, cờ lạ → `Unexpected option --k` (không in giá trị). Viết tay, không dùng gói `flag`. Lệnh có sẵn (`provision`, `migrate`, `sync`) giữ hành vi.
2. `failureLine` thêm reason của `*manifest.Rejection` và tên lỗi input (hằng, không in giá trị, email, token).
3. `purge-sessions`: nối `offline.PurgeExpiredSessions` (đã có), giới hạn lô như TS (bản đồ: ≤200 lô × 500), in câu như TS (`Purged N expired sessions.`); chỉ mở pool identity.
4. `enroll` (login authority, `ModeAdmin`), `reset-mfa` (identity, `ModeRevoke`, chỉ tài khoản IAM), `reset-root-mfa` (bootstrap, `ModeBootstrap`, chỉ Root): cờ, env, SQL, audit, stdout như TS (bản đồ §1). Mỗi lệnh chỉ mở pool của login nó cần. Lệnh mới đọc env như TS (`.env.ops`, đúng một URL theo lệnh) — xem Rủi ro của bản đồ về `sync`.

Bất biến không hoãn: audit actor đúng hằng `audit.OfflineActor` (tương đương `PRODUCT_OFFLINE_ACTOR`), audit atomic với mutation; `reset-mfa` trên Root và `reset-root-mfa` trên IAM bị từ chối và không xóa gì; không in/ghi log secret, mã khôi phục, email trong metadata audit (như TS); input ngoài (argv, env) validate trước khi dùng (UUID chuẩn, email canonical, role key `IsRoleKeyReference`); không fallback, không đổi semantics TS khi chưa ghi lý do; `cmd/api` không link `internal/offline` (test có sẵn `test/imports_test.go` phải xanh), goose chỉ trong offline/hrmctl; hướng import theo `package-dag.md` (không thêm cạnh nếu không cần; nếu cần, sửa khối mục 4).

Không đổi template test, fixture, stack web/dev/docker, `seed/` (để 17c/17d). Không xóa gì ở `apps/api`.

## Test (ruling 101/103)

- Unit: bộ đọc cờ (trùng, lạ, thiếu giá trị, `--` đầu, allowlist mỗi lệnh), `failureLine` không chứa giá trị input.
- Integration (PostgreSQL testcontainers) `./cmd/hrmctl` hoặc `./internal/offline`: mỗi lệnh một ca thành công (state + audit đúng actor); ca từ chối tối thiểu: cờ lạ; `reset-mfa` trên Root bị từ chối, không xóa; `reset-root-mfa` trên IAM bị từ chối, không xóa; enroll role vắng; metadata audit không chứa `@`; purge chỉ xóa phiên hết hạn.
- Phần còn lại (port `product-cli*`, `cli-mfa`, mutant) ghi `test-debt.md` mục "Task 17a", liệt kê spec:dòng.

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-17a-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./cmd/... ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` cho `./cmd/hrmctl` và `./internal/offline`. Prettier Markdown đã đổi; `git diff --check`. Không cần `pnpm test:browser` (không đổi route/stack).

## Báo cáo

`task-17a-report.md`: lệnh đã port (bảng cờ/env/login/mode/audit/stdout so với TS), bất biến → file:line + ca test, quyết định tự đưa ra, lệnh + output thật, file đổi, nợ, điều chưa kiểm, ghi chú cho 17b. Cập nhật `apps/api-go/AGENTS.md` (danh sách lệnh `hrmctl`). Không stage/commit/spawn/tick plan. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
