# Brief Task 17b — C1: lệnh Root của `hrmctl` (`bootstrap`, `reissue-root`, `revoke-root`, `set-root-email`) + file kích hoạt

BASE: commit 17a `8425e67` (xem `git log -1`; working tree sạch ngoài sổ). Đọc trước: `implementer-rules.md`, `task-17-map.md` (§1 hàng của bốn lệnh Root, §5, §6 mục 17b, Rủi ro), `task-17a-report.md` (khung cờ, `failureLine`, mẫu lệnh một pool, test integration `cmd/hrmctl`), phần cuối `progress.md` (ruling 100–109; 109: giữ đúng câu stdout `Root enrollment committed (id …)`), root `AGENTS.md` (Bất biến bảo mật: Root ngoài IAM, tối đa một Root, chỉ bootstrap offline chuyển `iam → root`, Root-only chỉ CLI offline có approval; Secrets/PII; audit atomic), `apps/api-go/AGENTS.md`, `apps/api/src/database/AGENTS.md`, `contract/package-dag.md`, plan Task 17, ADR-05. Code TS (`apps/api/tools/product.ts` và file nó gọi) chỉ để hiểu nghiệp vụ; SQL chép nguyên văn.

## Phạm vi

Trong `apps/api-go/cmd/hrmctl` và `apps/api-go/internal/offline`:

1. `bootstrap`, `reissue-root`, `revoke-root`, `set-root-email`: cờ, env (đúng một URL theo login như TS), login/mode, SQL, marker/approval, audit (actor `audit.OfflineActor`), stdout, exit code như TS (bản đồ §1). Bootstrap so `Release.Hash()` và `ProtectedStateHash` dưới fence (release dựng ở `cmd/hrmctl` từ `declarations`, như `sync`), manifest lệch → `not_ready`.
2. File kích hoạt: `os.OpenFile(path, O_WRONLY|O_CREATE|O_EXCL, 0o600)` TRƯỚC transaction (file đã tồn tại → từ chối trước khi ghi DB); ghi nội dung sau commit; xóa file khi không commit. Secret/proof chỉ đi vào file, không stdout/stderr/log/audit. Câu stdout giữ đúng TS.
3. Minor từ review 17a: `failureLine` in thêm `.Code` của `*database.UnavailableError` và `*database.ConflictError` (mã hữu hạn, không in message); lỗi ghi stdout sau khi đã commit không đổi exit code thành lỗi (như `console.log` của TS) — chọn cách tối giản, có test.

Bất biến không hoãn: tối đa một Root (marker/ràng buộc DB); chỉ bootstrap chuyển `iam → root`; operation lặp với cùng id + khác email/khác tham số → `collision`, không ghi file; revoke thiếu approval → từ chối; set-root-email trên IAM → `collision`; issuer lạ → `missing_reference`; Root đích không bao giờ qua login runtime; mọi mutation và audit atomic; input argv/env validate trước khi dùng; không in giá trị input/secret/email; `cmd/api` không link `internal/offline`; DAG không thêm cạnh nếu không cần.

Không đổi template test, fixture, stack web/dev/docker, `seed/` (17c/17d). Không xóa gì ở `apps/api`.

## Test (ruling 101/103)

- Unit: file kích hoạt (mode `0600`, `O_EXCL`, xóa khi không commit), `failureLine` với hai lỗi mới.
- Integration (testcontainers) `./cmd/hrmctl` hoặc `./internal/offline`: mỗi lệnh một ca thành công (state, audit actor offline, file mode `0600`, stdout đúng câu TS); ca từ chối tối thiểu: operation/email khác → `collision` và không có file; file đã tồn tại → từ chối trước khi ghi DB (state không đổi); manifest lệch → `not_ready`; issuer lạ → `missing_reference`; Root thứ hai → `collision`; revoke thiếu approval; set-root-email trên IAM → `collision`; stdout/stderr/audit không chứa proof hay email.
- Root dựng bằng chính `hrmctl bootstrap` trong test mới (không qua CLI TS) nếu khả thi.
- Phần còn lại (port `product-root-{bootstrap,regression,guards,concurrency,lifecycle-guards,token-guards}`, `cli-root`, `activation:249`, `sign-in-root:134`, đua, mutant) ghi `test-debt.md` mục "Task 17b", liệt kê spec:dòng.

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-17b-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./cmd/... ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` cho `./cmd/hrmctl` và `./internal/offline`. Prettier Markdown đã đổi; `git diff --check`.

## Báo cáo

`task-17b-report.md`: bảng lệnh so với TS, bất biến → file:line + ca test, quyết định tự đưa ra, lệnh + output thật, kết quả đột biến (nếu chạy), file đổi, nợ, điều chưa kiểm, ghi chú cho 17c/17d. Cập nhật `apps/api-go/AGENTS.md`. Không stage/commit/spawn/tick plan. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
