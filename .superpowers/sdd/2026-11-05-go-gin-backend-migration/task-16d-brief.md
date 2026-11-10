# Brief Task 16d — M8: `health/metrics` + gate 100/100 + bỏ upstream NestJS khỏi stack

BASE: commit 16c2 `1385a51` (xem `git log -1`). Đọc trước: `implementer-rules.md`, `task-16-map.md` (đính chính ở đầu; §1 dòng #17, §2c Metrics, §3 dòng `internal/health`/`internal/app`, §4 mục "Metrics shape" và "Gate 100/100", §5 dòng 16d, §6 Q1/Q5/Q8), phần cuối `progress.md` (ruling 100–104, nhất là 104: 16d bỏ upstream + tiến trình NestJS khỏi stack e2e/dev/compose; CLI NestJS migrate/sync/bootstrap GIỮ tới Task 17), `task-16c2-report.md` mục ghi chú cho 16d, root `AGENTS.md`, `apps/api-go/AGENTS.md`, `contract/package-dag.md`, `contract/test-port-tracker.md`, plan Task 16 (`docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md`). Code TS: `apps/api/src/health/health.controller.ts`, `apps/api/src/health/services/product-metrics.service.ts`.

## Phạm vi

1. Route `GET /api/health/metrics` (public) trong `internal/health`: bộ thu metrics an toàn đồng thời (`Observe(metric, mode, value)` + `Snapshot()`), shape `[{metric,mode,count,sum,buckets:[{upper,count}]}]`, bucket cố định `[1,5,10,25,50,100,250,500,1000,2000,5000]` cộng dồn (`value <= upper`), `sum` ms, rỗng là `[]` không `null`, nhãn hữu hạn (không user/record/URL). Thứ tự: byte order trên `metric:mode` (ghi rõ khác biệt có thể với `localeCompare` của TS trong `apps/api-go/AGENTS.md` nếu có). Ghép `OnMetric` của runner product trong `app` (`app.go` `authRoutes`/`a.steps.runner`) — nếu không ghép thì route luôn `[]`, không chấp nhận. Sửa comment sai "metrics stays with NestJS until M8".
2. `MigratedRoutes` đủ 100/100. Xác nhận `app.newUpstream` từ chối `API_UPSTREAM_URL` khi đủ (đã có sẵn, không viết code mới nếu đúng) và boot không cần upstream.
3. Sửa test Go hàng loạt: các boot test đang đặt `UpstreamURL`/`testConfig("http://127.0.0.1:1")`/`configOver()` (bản đồ §4 liệt kê ~14 chỗ; tự `rg` lại) bỏ upstream; ca "routes left, absent" (`app_test.go`) dùng contract giả còn route chưa chuyển; fixture proxy `GET /api/health/metrics` trong `app_test.go` (từ 16c1) đổi sang route giả trong contract giả. Không nới guard.
4. Bỏ `API_UPSTREAM_URL` và việc khởi tiến trình NestJS (`dist/main.js`) khỏi: `apps/web/e2e/stack.helper.ts`, `scripts/dev.sh`, `docker/compose.yaml` (và nơi khác `rg API_UPSTREAM_URL` tìm ra ngoài `apps/api/src` và sổ). GIỮ việc gọi CLI NestJS (migrate/sync/bootstrap, `tools/product.ts`) mà stack cần tới Task 17. Proxy Go (`httpapi/proxy.go`, `RegisterProxied`, `health.Upstream`) giữ tới Task 19, chỉ là đường chết.
5. Tài liệu: `apps/api-go/AGENTS.md`, `contract/test-port-tracker.md` (cập nhật trạng thái M8), docs vận hành nếu nhắc upstream cho dev (`docs/operations.md` — chỉ sửa câu sai, không viết lại).

Không xóa `apps/api`, không đổi CI (Task 19). Không tick plan.

## Test (ruling 101)

- Unit: bộ thu metrics (bucket biên `value == upper`, nhiều mode, đồng thời với `-race`, rỗng → `[]`).
- Integration/HTTP: một request đọc qua stack Go → `GET /api/health/metrics` có dòng `transaction:read` (hoặc nhãn thật runner phát) với count ≥ 1; boot với `API_UPSTREAM_URL` đặt → bị từ chối (`errUpstreamRefused`); boot không upstream → chạy.
- Guard inventory 100/100 xanh.
- Phần còn lại (spec TS `product-http.spec.ts` › runtime metrics, CROSS M8 trong tracker) ghi `test-debt.md` mục "Task 16d".

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-16d-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` cho `./internal/health` và `./internal/app`. Từ root: `pnpm test:browser` (BẮT BUỘC — stack đã đổi), Vitest web (`pnpm --filter @hrm/web run test` hoặc script tương ứng, tự xác minh tên), `bash -n scripts/dev.sh`, kiểm cú pháp compose nếu có công cụ (`docker compose -f docker/compose.yaml config -q`, không khởi container), prettier file đã đổi; `git diff --check`.

## Báo cáo

`task-16d-report.md`: thay đổi, shape metrics, xác nhận 100/100 + từ chối upstream, danh sách nơi đã bỏ upstream/NestJS process và nơi còn giữ CLI NestJS (lý do), lệnh + output thật, file đổi, nợ, điều chưa kiểm, gợi ý checkbox Task 16 trong plan nào đã có bằng chứng (không tự tick). Không stage/commit/spawn. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
