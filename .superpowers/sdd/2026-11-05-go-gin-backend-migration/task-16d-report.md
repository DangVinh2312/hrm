# Báo cáo Task 16d — `health/metrics`, gate 100/100, bỏ upstream NestJS khỏi stack

BASE `1385a51`. Status: DONE_WITH_CONCERNS (lo ngại ở cuối). Không stage, commit hay spawn.

## Thay đổi

1. **Route `GET /api/health/metrics`** (public) trong `internal/health`:
   - `metrics_service.go`: `health.Metrics` (mutex, giá trị zero dùng được), `Observe(database.Metric, database.Mode, float64)` đúng chữ ký `RunnerOptions.OnMetric`, `Snapshot() []MetricRow`.
   - `health_controller.go`: `Register(group, gate, upstream, metrics)` thêm route metrics; sửa comment package sai ("stays with NestJS until M8").
   - `MetricRow` dùng `string` cho `metric`/`mode` (không lộ kiểu `database` qua file handler, theo `checkHandlerTypes`).
2. **Ghép `OnMetric`** ở `app.authRoutes` (`internal/app/app.go`): runner product luôn gọi `metrics.Observe`, rồi gọi `steps.runner.OnMetric` của test nếu có (các test đua M6 vẫn đếm retry/deadlock). `modules.metrics` (`authority.go`) mang bộ thu tới `registerMigrated`.
3. **`MigratedRoutes` 100/100**: thêm `{"GET", "/api/health/metrics"}` (`internal/httpapi/inventory.go`). Guard `TestMigratedRoutesAreInTheContract` giờ buộc `len(MigratedRoutes) == len(contract) == 100`.
4. **`newUpstream`**: không viết code mới, đã đúng: đủ 100 + `API_UPSTREAM_URL` có giá trị → `errUpstreamRefused` ở bước `upstream`; vắng → `nil`, boot không cần upstream.
5. **Test Go bỏ upstream**: `testConfig("http://127.0.0.1:1")` → `testConfig("")` ở `app_test.go` (4 chỗ), `auth_routes_test.go` (3), `manifest_boot_test.go` (1); `configOver()` bỏ `UpstreamURL`; `run_integration_test.go` dùng upstream rỗng.
   - `TestTheUpstreamVariableFollowsTheTable`: bỏ phần dựng "contract chỉ gồm route đã chuyển"; ca "routes left" dùng contract giả `withProxied()` (contract thật + `GET /api/health/proxied`); ca "all migrated" dùng chính `contract.Routes()`.
   - `TestTheBootedServerHasEveryLayer`: fixture proxy chuyển sang `/api/health/proxied` trong contract giả; `/api/health/metrics` trả `[]` từ Go và không tới upstream.
   - `TestAFailedStepNeverListens`: ca "a migrated route the contract lost" về lại `withOut("/api/health/live")` (không cần route giả nữa); ca "a route the migrated table does not list" đăng ký `/api/health/unlisted` thay cho metrics (metrics giờ đã chuyển, đăng ký lần hai sẽ trùng).
   - Hai test shutdown: contract giả thêm dòng metrics, `health.Register(..., &health.Metrics{})`.
   - Không nới guard nào.
6. **Stack**:
   - `apps/web/e2e/stack.helper.ts`: bỏ cổng NestJS, tiến trình `dist/main.js`, `API_UPSTREAM_URL`; chỉ spawn `apps/api-go/dist/api`. `NODE_EXTRA_CA_CERTS` (chỉ cho Node) thay bằng `SSL_CERT_FILE` trong `apiEnv` (Go và `hrmctl sync` dùng). GIỮ kiểm `apps/api/dist/main.js` tồn tại và CLI `tools/product.ts` (`provision`, `migrate`, `bootstrap`, `enroll`), vì CLI import `apps/api/dist` — tới Task 17.
   - `scripts/dev.sh`: bỏ `start:dev` NestJS, `HRM_UPSTREAM_PORT`, `API_UPSTREAM_URL`; `api_stack` = build Go, `hrmctl sync`, chạy Go. GIỮ `db:provision`/`db:migrate` (CLI NestJS).
   - `docker/compose.yaml`: xóa service `api` (NestJS); `api-go` không còn `API_UPSTREAM_URL`, phụ thuộc `manifest` hoàn tất. GIỮ service `setup` (`node tools/product.ts provision`).
   - `rg API_UPSTREAM_URL` ngoài `apps/api/src` và sổ: còn ở `internal/config` (đọc biến), `app.go` (lỗi refused/required), `httpapi/proxy.go`, test config/app (ca từ chối), plan và ADR-20 (lịch sử/quyết định, không sửa).
7. **Tài liệu**: `apps/api-go/AGENTS.md` (trạng thái 100/100, proxy là đường chết, mô tả metrics và thứ tự), `apps/web/AGENTS.md` (đoạn stack e2e), `docs/architecture.md`, `docs/operations.md` (ba câu sai về NestJS đứng sau Go/`HRM_UPSTREAM_PORT`), `contract/test-port-tracker.md` (`product-http.spec.ts` › `runtime metrics` → `port`), `test-debt.md` mục "Task 16d".

## Shape metrics

`[{"metric","mode","count","sum","buckets":[{"upper","count"}]}]`; bucket cố định `[1,5,10,25,50,100,250,500,1000,2000,5000]` cộng dồn (`value <= upper`); `sum` là ms (hoặc số lần với retry/timeout/deadlock); rỗng là `[]`. Nhãn chỉ là `database.Metric` × `database.Mode` (64 cặp tối đa), không user/record/URL. Thứ tự: byte order trên `metric:mode`. Đã so bằng Node v24.20.0 với cả 64 cặp nhãn hiện có: `localeCompare` và sort byte cho cùng thứ tự (ghi ở `apps/api-go/AGENTS.md`). Bộ đếm theo process, mất khi restart (như TS).

## RED/GREEN

| Bước | Lệnh | Kết quả | Log |
| --- | --- | --- | --- |
| RED health | `go test -count=1 ./internal/health/` trước khi có `Metrics` | exit 1, `undefined: health.Metrics`, `too many arguments in call to health.Register` | `/private/tmp/hrm-16d-red-health.log` |
| RED guard 100/100 | overlay `inventory.go` của HEAD, `-run TestMigratedRoutesAreInTheContract ./internal/httpapi/` | exit 1, `100 routes, 99 migrated` | `/private/tmp/hrm-16d-red-guard.log` |
| RED ghép OnMetric | overlay `app.go` bỏ dòng `metrics.Observe(...)`, `-tags integration -run 'TestRunServesEveryRouteWithoutAnUpstream\|TestRunRefusesAnUpstream'` | exit 1: `TestRunServesEveryRouteWithoutAnUpstream` FAIL, body `[]`; `TestRunRefusesAnUpstream` PASS | `/private/tmp/hrm-16d-mut-wiring.log` |
| GREEN unit app lượt đầu | `go test -race -count=1 ./internal/app/` | FAIL: `withProxied` không cắt được `]` vì `contract.Routes()` có xuống dòng cuối → thêm `strings.TrimSpace`; lượt hai exit 0 | `/private/tmp/hrm-16d-unit-focus.log`, `/private/tmp/hrm-16d-unit-app.log` |

Test mới: `internal/health/metrics_service_test.go` (rỗng `[]`; biên `value == upper` với 0.5/1/5/5.5/5000/5000.1; năm dòng theo byte order + JSON đầu dòng; 16 goroutine × 200 observe + snapshot dưới `-race`; snapshot là bản sao), `health_test.go` › `TestMetricsAnswersTheSnapshotBeforeTheBootEnds` (route `[]` rồi JSON đúng byte), `run_integration_test.go` › `TestRunServesEveryRouteWithoutAnUpstream` (Run thật, không upstream, ready 200, `GET /api/administration/roles` với session well-formed vắng → 401, rồi metrics có `transaction:read` count ≥ 1, 11 bucket) và `TestRunRefusesAnUpstream` (Run thật với `API_UPSTREAM_URL` → `BootError` bước `upstream`, không listen). `TestRunServesAfterTheRealPrivilegeProbe` (phụ thuộc upstream) được thay bằng test thứ nhất; ca "ready 503 khi upstream chưa ready" vẫn ở unit `health_test.go`.

## Lệnh và kết quả (sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`; load 1 phút 3–9, dưới 40)

| Check | Lệnh | Kết quả | Log |
| --- | --- | --- | --- |
| build | `go build ./...` | exit 0 | `/private/tmp/hrm-16d-build.log` |
| vet | `go vet ./...` | exit 0 | `/private/tmp/hrm-16d-vet.log` |
| vet integration | `go vet -tags integration ./...` | exit 0 | `/private/tmp/hrm-16d-vetint.log` |
| gofmt | `gofmt -l .` | lượt đầu liệt kê `internal/app/app_test.go` (hai dấu cách bị mất khi sửa), sửa, lượt hai rỗng, exit 0 | `/private/tmp/hrm-16d-gofmt.log` (lượt đầu) |
| unit race | `go test -race -count=1 ./internal/...` | exit 0, 37 package ok | `/private/tmp/hrm-16d-unit.log` |
| `./test` | `go test -count=1 ./test` | exit 0, `ok hrm/api-go/test 4.930s` | `/private/tmp/hrm-16d-test.log` |
| lint | `go tool golangci-lint run` | exit 0, `0 issues.` | `/private/tmp/hrm-16d-lint.log` |
| integration health | `go test -tags integration -race -count=1 -p 1 ./internal/health/` | exit 0, ok 1.057s | `/private/tmp/hrm-16d-int-health.log` |
| integration app | `go test -tags integration -race -count=1 -p 1 -timeout 30m ./internal/app/` | exit 0, ok 96.764s | `/private/tmp/hrm-16d-int-app.log` |
| browser | `pnpm test:browser` (root; build Go rồi Playwright) | exit 0, `30 passed (2.4m)` | `/private/tmp/hrm-16d-browser.log` |
| Vitest web | `pnpm --filter @hrm/web run test:unit` | exit 0, 34 file, 305 test passed. (Lần đầu gọi `run test` — package không có script `test`, pnpm thoát 0 không chạy gì; không tính) | `/private/tmp/hrm-16d-vitest.log` |
| tsc e2e | `pnpm exec tsc -p e2e/tsconfig.json` (apps/web) | exit 0 | — |
| ESLint | `pnpm exec eslint e2e/stack.helper.ts` (apps/web) | exit 0 | — |
| dev.sh | `bash -n scripts/dev.sh` | exit 0 | — |
| compose | `docker compose -f docker/compose.yaml config -q` (không khởi container) | exit 0, không output | `/private/tmp/hrm-16d-compose.log` |
| Prettier | `pnpm exec prettier --check` trên 8 file TS/MD/YAML đã đổi | All matched files use Prettier code style | — |
| diff check | `git diff --check` | exit 0 | — |

Không còn tiến trình nền (`pgrep` dist/api, playwright, vitest, go test rỗng).

## File đổi

- Go: `apps/api-go/internal/health/{health_controller.go, health_test.go}`, mới `metrics_service.go`, `metrics_service_test.go`; `apps/api-go/internal/app/{app.go, authority.go, migrated_routes.go, app_test.go, auth_routes_test.go, auth_routes_integration_test.go, manifest_boot_test.go, run_integration_test.go}`; `apps/api-go/internal/httpapi/{inventory.go, inventory_test.go}`.
- Stack: `apps/web/e2e/stack.helper.ts`, `scripts/dev.sh`, `docker/compose.yaml`.
- Tài liệu: `apps/api-go/AGENTS.md`, `apps/api-go/contract/test-port-tracker.md`, `apps/web/AGENTS.md`, `docs/architecture.md`, `docs/operations.md`, sổ `test-debt.md`, báo cáo này.

## Quyết định tự đưa ra

- Bộ thu đặt trong `modules` (không đổi chữ ký `steps.register`), ít đổi test nhất.
- `MetricRow` dùng `string` thay `database.Metric`/`Mode` để file controller không chạm kiểu `database`.
- Product luôn ghép metrics, cộng thêm `OnMetric` của test thay vì thay thế, để test đua M6 không mất bộ đếm.
- `TestRunServesAfterTheRealPrivilegeProbe` đổi thành test không upstream (ý "chạy qua probe quyền thật" giữ nguyên qua `Run`).

## Nợ, điều chưa kiểm

- Chỉ chạy integration `./internal/health` và `./internal/app` theo brief; integration các package khác không chạy lại (không đổi code của chúng). Plan gate ghi "suite Go đầy đủ": nếu hiểu là cả integration mọi package thì gate chưa có bằng chứng đầy đủ.
- `.env.api` thật của người dùng không được đọc: nếu nó có `API_UPSTREAM_URL` thì `scripts/dev.sh` và compose sẽ dừng boot ở bước `upstream` (đúng thiết kế, nhưng người dùng cần xóa biến).
- Compose chỉ kiểm cú pháp, không khởi container; `scripts/dev.sh` chỉ `bash -n`, chưa chạy thật.
- `docs/operations.md` dòng hướng dẫn Google local vẫn dùng `pnpm run start:dev` (NestJS chạy độc lập, không sai về mặt câu chữ) — để Task 17/18.
- `package-dag.md` dòng `internal/health` vẫn ghi "(route metrics chuyển ở M8)" — vẫn đúng, không sửa.
- Nợ M8 CROSS ghi ở `test-debt.md` mục "Task 16d".

## Gợi ý checkbox Task 16 trong plan (không tự tick)

- "Chuyển `health/metrics`, test shape": có bằng chứng (unit + integration + RED ghép).
- "Gate: `MigratedRoutes` đủ 100/100; suite Go đầy đủ, `test:browser`, Vitest web … binary từ chối `API_UPSTREAM_URL`": có bằng chứng cho 100/100, từ chối upstream (unit + Run thật), browser 30 passed, Vitest 305 passed, unit/`./test`/lint/vet; integration chỉ health + app (xem trên).
- Các checkbox còn lại của Task 16 thuộc 16a–16c2, không thuộc lát này.
