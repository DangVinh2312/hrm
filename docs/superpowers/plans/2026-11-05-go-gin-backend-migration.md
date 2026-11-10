# Kế hoạch chuyển backend sang Go/Gin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay `apps/api` (NestJS) bằng `apps/api-go` (Go/Gin) từng nhóm route, giữ contract HTTP với web, các login và mọi bất biến bảo mật; test hành vi Go ở mỗi bước.

**Architecture:** Go đứng trước và proxy route chưa chuyển sang NestJS; cả hai dùng chung một PostgreSQL. Go là nguồn contract (ADR-22); NestJS đóng băng. Mỗi nhóm route chỉ chuyển khi test Go và Playwright trên stack trộn đã pass.

**Tech Stack:** Go, Gin, pgx v5, goose v3, testcontainers-go, go-oidc, x/oauth2, excelize, golangci-lint.

**Spec:** [ADR-20](../../decisions/ADR-20-go-gin-backend-migration.md), thay một phần bởi [ADR-22](../../decisions/ADR-22-go-owns-the-contract.md) (2026-11-06): bỏ exporter, `jscompat`, vector, parity HTTP; các bước đã tick nhắc chúng là lịch sử, bước chưa tick đã được viết lại. Đặc tả hành vi là ADR-02 đến ADR-19 và `AGENTS.md`.

**Trạng thái:** ADR-20 đã duyệt (2026-11-05). Task 1 (F0) xong, chưa commit; Task 2–8 (F1–F6) đang làm liên tục, dừng ở cuối F6. Chạy theo subagent từng task.

## Global Constraints

- Không commit, push, deploy khi người dùng chưa yêu cầu. Bước "lưu thay đổi" nghĩa là để trong working tree và báo cáo.
- Không reset, restore, stash thay đổi có sẵn. Không đọc file PII trong `seed/`. Không in `.env`, secret, connection string.
- Chỉ pnpm cho Node; Node 24. Go theo `go.mod`. Không cài CLI global.
- Không đổi tính năng hay semantics bảo mật. Schema sửa được trước release đầu (ADR-22 §4), dựng lại database local; đổi ACL thì sửa `privilege_declarations.go` cùng lúc.
- Lỗi luôn `{ statusCode, code }`, `code` thuộc `API_ERROR_CODES` (18 key). Lỗi ngoài dự kiến và panic: `503 error.unavailable`.
- Không commit dữ liệu thật trong fixture hay contract. Test DB chỉ dùng database disposable, image `postgres:18.6-bookworm`.
- Không sửa `src` API khi một suite đang chạy nền, vì test chạy `tsc -b` lại `dist`.
- Mức test theo Q4: một file integration mỗi lần, khi load dưới 40; suite đầy đủ chỉ ở các gate ghi rõ.
- NestJS đóng băng (ADR-22): chỉ sửa khi stack trộn không chạy được. Không deploy thật trước khi xong (Q6).
- Không comment thừa, trong cả code Go và dặn subagent. Mỗi task kết thúc bằng review độc lập, chỉ đọc code.

## Review Focus

1. Body JSON có `null`, thiếu key, key sai hoa thường (`ROLEKEY`), key trùng, số lớn: bị từ chối hoặc ra đúng field của struct, không gán nhầm field. Test ở Task 4.
2. Client ngắt kết nối giữa lúc mutation đang chạy: transaction vẫn commit hoặc rollback trọn vẹn cùng audit. Test ở Task 2 và Task 8.
3. Dữ liệu đọc chéo runtime trên stack trộn (ADR-22): phiên, mã khôi phục, khóa MFA, limiter, snapshot kỳ công mà NestJS còn đọc. Kiểm bằng test trên stack trộn ở Task 6, Task 12, Task 13; lệch thì chuyển cùng route đọc hoặc dựng lại database.
4. Đường dẫn lạ và header lạ: `/` cuối, sai hoa thường, percent-encode, sai method, HEAD, `Origin` lặp, `X-Forwarded-For` giả: không vượt guard, đúng 404 shape, không đổi IP limiter. Test ở Task 4.
5. Email hoặc tên có `İ`, emoji, tiếng Việt tổ hợp, ký tự điều khiển: chuẩn hóa, giới hạn độ dài (rune), thứ tự đúng ADR-22 §6; không va chạm định danh. Test ở Task 1, Task 6 và Task 10.

---

## Theo dõi test

`apps/api-go/contract/test-port-tracker.md`: một dòng cho mỗi file trong `apps/api/test`, với các cột: file, nhóm, trạng thái (`port`, `thay bằng`, `bỏ`), đích Go, lý do. Task 1 tạo; mỗi task cập nhật; Task 19 chặn nếu còn dòng trống.

## Task 0: Duyệt

- [x] Viết ADR-20 và kế hoạch này; review độc lập; sửa finding.
- [x] Người dùng trả lời Q1–Q8; ghi câu trả lời vào ADR-20 và sửa kế hoạch theo đó. Q1 là ưu tiên công nghệ nên không đo mốc NestJS.
- [x] Người dùng duyệt rõ ràng ADR-20.
- [x] Đổi trạng thái ADR-20 thành Accepted.

## Task 1: F0, khung, exporter contract, DAG package

**Files:**

- Create: `apps/api-go/{go.mod,package.json,AGENTS.md,.golangci.yml}`, `apps/api-go/cmd/api/main.go`, `apps/api-go/internal/jscompat/*`
- Create: `apps/api/tools/export-go-contract.ts`, `apps/api/test/route-inventory.helper.ts`, `apps/api/test/go-contract.spec.ts`
- Modify: `apps/api/test/structure.spec.ts` (chỉ import inventory từ helper), root `package.json`, `pnpm-lock.yaml` (importer mới, bằng `pnpm install`), `AGENTS.md` và `apps/web/AGENTS.md` (mốc 1 của ADR-20 §9), `.github/workflows`
- Test: `apps/api-go/internal/jscompat/*_test.go`, `apps/api-go/test/conventions_test.go`, `apps/api-go/test/imports_test.go`

**Interfaces:**

- Produces: `contract/{routes,openapi,api-errors,release,bindings,privileges}.json`, `contract/vectors/*.json`, `contract/route-ownership.md`, `contract/package-dag.md`, `contract/test-port-tracker.md`
- Produces: `jscompat.UTF16Len(s string) int`, `jscompat.LessUTF16(a, b string) bool`, `jscompat.ToLower(s string) string`, `jscompat.ToUpper(s string) string`, `jscompat.Trim(s string) string`

- [x] Ghi lại phiên bản thật lúc bắt đầu (`go.mod`). Tham khảo từ `proxy.golang.org` ngày 2026-11-05, chưa đối chiếu với tài liệu từng bản: gin v1.12.0, pgx v5.12.0, goose v3.29.0, testcontainers-go v0.44.0, go-oidc v3.21.0, x/oauth2 v0.37.0, excelize v2.11.1, golangci-lint v2.15.0.
- [x] Viết exporter; fail khi gặp `function`, `undefined` lồng trong dữ liệu, hoặc migration có hành vi ngoài `query(sql)`, trừ ngoại lệ `$1 = PRODUCT_OFFLINE_ACTOR` ghi ở ADR-20 §6.
- [x] Viết `go-contract.spec.ts`: output phải khớp file đã xuất. Sửa thử một declaration để thấy đỏ, rồi hoàn tác. Chạy `structure.spec.ts`, hash không đổi.
- [x] Viết bản đồ route → controller cho 100 route.
- [x] Tính thành phần liên thông mạnh theo file trên toàn bộ `apps/api/src`, kể cả `import type`, rồi viết `contract/package-dag.md`: package Go đích, hướng phụ thuộc, từng symbol phải chuyển xuống package lá. Phải xử lý: tám cặp vòng HR, `authorization ↔ authentication`, `authorization ↔ audit`, `administration ↔ role`, `config → authentication`, `product.manifest.ts`. Nếu lõi HR không tách được mà vẫn giữ mỗi module một package thì dừng hỏi người dùng.
- [x] Viết test thất bại trước cho `jscompat`, từ vector TS:
  - Key non-ASCII sắp theo UTF-16, khác với thứ tự byte khi có ký tự ngoài BMP.
  - `<>&`, U+2028, ký tự điều khiển, emoji, `1.0`, `1e3`, `-0`.
  - `undefined`: field trong object bị bỏ; phần tử trong mảng thành `null`.
  - `ToLower` với `İ`, `ΣΣ`; `Trim` với U+FEFF, U+0085.
- [x] Implement `jscompat`, chạy `go test -race ./internal/jscompat`, kỳ vọng pass.
- [x] Viết test quy ước: tên file, 300 dòng, helper không nhận `context.Context`, hướng import theo DAG; có ca âm tính.
- [x] Chạy `go vet ./...`, lint, `pnpm --filter @hrm/api run test:unit -- test/go-contract.spec.ts test/structure.spec.ts`, `pnpm install --frozen-lockfile`.
- [x] Review độc lập. Lưu thay đổi.

## Task 2: F1, config, runner, provision, goose, probe

**Files:**

- Create: `internal/config/`, `internal/database/{runner,transaction_errors,privilege_verify}*.go`, `internal/database/migrations/*.sql`, `internal/offline/provision*.go`, `cmd/hrmctl/main.go`, `test/postgres.go`
- Test: `internal/database/*_integration_test.go`, `internal/config/*_test.go`
- Tham chiếu: `database/product-transaction.runner.ts`, `config/app.config.ts`, `infrastructure/product-runtime.service.ts`, `product-privilege-verify.service.ts`, `product-database-provision.service.ts`

**Interfaces:**

- Produces: `config.Load(env map[string]string) (Config, error)`
- Produces: `database.Run[T any](ctx context.Context, r *Runner, mode Mode, work func(ctx context.Context, tx *Tx) (T, error), opts RunOptions) (T, error)`, với `Mode` gồm `read|write|identity|revoke|admin|sync|bootstrap`, `Tx{Mode, Revision}` và các method `Query`, `Exec`
- Produces: `database.ConflictError` (409), `database.UnavailableError` (503)
- Produces: `database.VerifyPrivileges(ctx, pools, expected) error`, `offline.Provision(ctx, admin, passwords) error`

Giá trị ghim: READ COMMITTED; deadline tối đa 3000 ms; lock tối đa 1000 ms; retry tối đa 2 lần chỉ cho `40P01`, `40001`, `55P03`; tổng 5000 ms; `RUNTIME_CAPABILITY = 1`; trình tự `set_config` timeout, advisory, fence; `revoke|admin|bootstrap` tăng revision trước commit; chờ connection 2000 ms; pool `data` 5, `identity` 2, `authority` 2, `sync` 1.

- [x] Viết test config: từ chối `DATABASE_ADMIN_URL`, `PRODUCT_MIGRATION_DATABASE_URL`, `PRODUCT_BOOTSTRAP_DATABASE_URL`, `AUTH_METHODS`; username sai login; bốn URL khác database; key ring MFA sai dạng. Thấy đỏ, implement, pass. Parse key ring đặt ở package lá theo DAG, để `config` không phụ thuộc `authentication`.
- [x] Test TLS: production dựng `verify-full` từ `NODE_ENV`; URL có `sslmode=disable` hay `prefer` ở production không hạ được mức này; `NODE_ENV` khác thì tắt như hiện tại.
- [x] Sinh SQL goose; viết `offline.Provision`; dựng database bằng Go trong test.
- [x] Chạy so sánh catalog và `pg_dump` của ADR-14 giữa database TS và database Go; diff phải rỗng; kiểm độ nhạy bằng một GRANT và một DEFAULT thêm vào. Thêm ca có tài khoản IAM thiếu role, so `user_role`, `audit_outbox`, revision.
- [x] Port test runner, thấy đỏ trước: trình tự `set_config`/advisory/fence, shared/exclusive đúng login, tăng revision, retry hữu hạn, timeout thành 503, chờ pool quá 2000 ms thành 503, `AZ001`, `runtime_incompatible`, rollback khi panic, không rò timeout giữa các transaction của cùng connection. (Runner, probe, provision không viết đỏ trước; bù bằng mutation, xem báo cáo Task 2.)
- [x] Test Review Focus 2 ở mức runner: hủy context của caller giữa transaction, transaction vẫn hoàn tất theo deadline riêng.
- [x] Thử exec mode pgx với SQL mẫu có `$n` không cast, multi-statement, `25P04`; đếm round trip; ghi lựa chọn vào ADR-20.
- [x] Port test probe, gồm ca âm: thiếu grant, grant thừa, thân hàm đổi, trigger tắt, `search_path` đổi, owner đổi. Probe phải pass với `goose_db_version`.
- [x] Ca âm lint trên pgx thật, gồm cả `pgx.CollectRows`: bỏ `rows.Err()`, bỏ `rows.Close()`. Kiểm `rowserrcheck` (`packages: github.com/jackc/pgx/v5`) và `sqlclosecheck` có báo. Nếu analyzer không dùng được thì sửa ADR-20 §5 và §8, dựa vào test fault, không ghi là được enforce.
- [x] Chạy `go test -race ./internal/config ./internal/database`, `go test -tags integration ./internal/database`.
- [x] Cập nhật tracker. Review độc lập (3 vòng). Lưu thay đổi: chưa commit theo yêu cầu người dùng.

## Task 3: Fixture test Go

Task này tồn tại vì test Go ở Task 6, Task 9 và sau đó cần dữ liệu mà service Go chưa có. Đang thiếu: Root (Go ở Task 17), facts code-owned (Go ở Task 8), nhân viên (Go ở Task 10).

**Files:**

- Create: `test/template.go`, `test/fixture/*.go`
- Test: `test/fixture/*_integration_test.go`

**Interfaces:**

- Produces: `test.NewDatabase(t) *test.Stack`, tạo database từ template; một container, template `CREATE DATABASE … TEMPLATE` như ADR-01
- Produces: `fixture.Employee(t, s, spec) EmployeeRow`, `fixture.Account(t, s, spec) AccountRow`, `fixture.Session(t, s, userID, spec) string`, `fixture.Root(t, s) RootRow`

Quy định: template dựng bằng CLI TypeScript đã build (`provision`, `migrate`, `sync`), `fixture.Root` gọi `bootstrap` của CLI đó. Dữ liệu còn lại là SQL trực tiếp bằng login có quyền ghi bảng đó. Task 8 đổi `sync` sang Go; Task 17 đổi `provision`, `bootstrap` sang `hrmctl`. Chỉ dùng dữ liệu giả.

- [x] Viết test: template có đủ facts code-owned, probe privilege pass, `fixture.Session` được `resolve_session` nhận, `fixture.Root` có `kind = 'root'` và đúng marker.
- [x] Implement; chạy `go test -tags integration ./test/...`.
- [x] Review độc lập (2 vòng). Lưu thay đổi: chưa commit theo yêu cầu người dùng.

## Task 4: F2, nền HTTP, guard và proxy

**Files:**

- Create: `internal/apperror/*`, `internal/authorization/enforcement/*`, `internal/httpapi/{engine,errors,security,body,path,auth_controller,inventory,proxy,client_ip}*.go`, `internal/health/`, `internal/openapi/`, `internal/app/*`
- Test: `internal/apperror/*_test.go`, `internal/httpapi/*_test.go`, `internal/authorization/enforcement/*_test.go`
- Modify: `apps/web/e2e/stack.helper.ts`, `apps/web/package.json`, root `package.json`, `apps/web/vite.config.ts` (nếu cần), `scripts/dev.sh`, `docker/compose.yaml`
- Tham chiếu: `api-error.helper.ts`, `http-security.helper.ts`, `product-error.filter.ts`, `input-validation.helper.ts`, `main.ts`, `product-authorization.module.ts`

**Interfaces:**

- Produces: `enforcement.Classification` (`public`, `authenticated`, `authorize{resource, action}`), `enforcement.RequestAuth` (interface kiểm dạng cookie, cài ở composition root)
- Produces: `apperror.Rejection{Code}` và các lỗi được ánh xạ status (`InvalidRequest`, `AccessDenied`, `CommandRejected`, `AuthenticationFailed`, `MfaConflict`, `StepUpRequired`), `httpapi.WriteError(c *gin.Context, err error)`
- Produces: `httpapi.DecodeCommand[T any](c *gin.Context, origin string) (T, error)`: CSRF rồi decode vào struct của route (ADR-22 §5, §7)
- Produces: `httpapi.Register(group, method, path, enforcement.Classification, handler)`; route không có `Classification` không đăng ký được
- Produces: `httpapi.ClientIP(c *gin.Context, trustProxy int) string`, `httpapi.MigratedRoutes` (hằng), `httpapi.CheckInventory(routes, contract) error`
- Env mới của binary Go: `API_UPSTREAM_URL`, bắt buộc khi bảng route chưa đủ 100

- [x] Viết test thất bại trước cho error: mọi status đúng key; `Rejection` đúng bảng 12 key; key lạ là lỗi lập trình; panic trả 503 đúng shape; `http.ErrAbortHandler` không ghi body; log không chứa giá trị canary.
- [x] Viết test cookie/CSRF theo `http-security.helper.ts`: cookie lạ bỏ qua, cookie của API lặp lại 400, thiếu header, sai Origin, `Origin` hoặc `x-csrf-token` lặp bị từ chối, độ dài khác, `__Host-` trên HTTPS, thuộc tính `Set-Cookie` chính xác như `structure.spec.ts`.
- [x] Viết test guard: `public` không cần cookie; `authenticated` kiểm dạng cookie trước handler, không truy cập DB; `authorize` chưa có ở task này thì route loại đó không đăng ký được.
- [x] Trước handler đầu tiên: mở rộng `checkHandlerFile` bằng `go/types`, áp cho cả danh sách prefix `handlerForbiddenImports`: từ chối alias tới package bị cấm khai ở file khác cùng package (`type Runner = database.Runner`, `type Row = gateway.Row`) và truy cập field kiểu `h.repo.Runner`, có ca âm cho từng dạng; đổi hai ca "not caught before plan Task 4" trong `imports_test.go` thành từ chối. Defined type của file không phải handler vẫn được dùng.
- [x] Ca âm `forbidigo` với Gin thật: `gin.Default`, `gin.Logger`, `gin.Recovery`, `c.ClientIP`, `c.ShouldBind*`, `c.Bind*`, `c.MustBindWith`. Luật mới thử trên gin giả.
- [x] Đo surrogate đơn lẻ: gửi `"\ud83d"` trong body có idempotency tới NestJS, xem hash, xem chuỗi được ghi. `encoding/json` đổi thành U+FFFD (đã quan sát), có thể làm `payloadHash` lệch; chưa tái hiện qua HTTP. Có số đo thì hỏi người dùng theo ADR-20 §4 trước khi chốt `DecodeObject`.
- [x] Viết test `DecodeCommand` và phần decode của nó (Review Focus 1): null, thiếu key, sai hoa thường, trùng key, field lạ, số lớn, không phải object, sai content-type, quá giới hạn.
- [x] Viết test đường dẫn (Review Focus 4). Dùng `gin.New()`, đặt tường minh `RedirectTrailingSlash = false`, `RedirectFixedPath = false`, `ForwardedByClientIP = false`.
- [x] Viết test `ClientIP` theo hop 0, 1, 2 với IPv4 và IPv6; `X-Forwarded-For` giả với hop 0 bị bỏ qua.
- [x] Implement, chạy pass. Đặt `MaxHeaderBytes`, `ReadHeaderTimeout`, `IdleTimeout` tường minh.
- [x] Viết proxy; test: nhiều `Set-Cookie`, `303` giữ nguyên, body không đổi, `X-Forwarded-For` bị ghi đè bằng `ClientIP`, upstream chết trả 503 đúng shape.
- [x] Implement `health/live`, `health/ready` (Go đã qua bước boot hiện có và upstream ready), `openapi.json` phục vụ byte của file contract; test so body với `contract.OpenAPI()`, kiểm JSON hợp lệ và mọi path của `routes.json` có trong document (ADR-22). `health/metrics` để proxy tới Task 16.
- [x] Viết thứ tự boot với các bước đã có; test lỗi inventory thì không `listen`.
- [x] Đổi `stack.helper.ts`: build và khởi Go đứng trước NestJS. Script build binary là `pnpm --filter @hrm/api-go run build`, gọi ở `test:browser` cùng chỗ build API. NestJS `TRUST_PROXY=1`, Go `TRUST_PROXY=0`. Ghi lý do vào `apps/web/AGENTS.md`. (Mới kiểm bằng đọc code; chạy thật ở bước `test:browser`.)
- [x] Chuyển `health/live`, `health/ready`, `openapi.json`, `auth/csrf`, `auth/options`, có test Go cho từng route.
- [x] Chạy `pnpm --filter @hrm/web run test:browser` một lần trên trạng thái trộn (khi load cho phép), báo cáo kết quả. Người dùng 2026-11-06: để tới cuối F6. (2026-11-09, sau `b7d1eb3`: 30/30 pass, 3.0 phút, 0 skip/flaky.)
- [x] Review độc lập (Approved ở vòng sửa 3). Chưa commit vào repo.

## Task 5: Parity harness (bỏ theo ADR-22)

Không làm. Các bước dưới đây chỉ còn là lịch sử.

**Files:**

- Create: `apps/api/test/parity/{harness,normalize,sql-trace,round-trip,matrix}.helper.ts`, `apps/api/test/parity/harness.parity-spec.ts`
- Modify: `apps/api/tools/test.ts` (suite `parity`), `apps/api/package.json` (`test:parity`)

**Interfaces:**

- Produces: `startParity(group): Promise<ParityStack>`, gồm NestJS-A trên database A; Go-B và NestJS-B trên database B
- Produces: `startCrossRuntime(group): Promise<CrossStack>`, NestJS và Go cùng một database, không proxy giữa chúng
- Produces: `step(stack, principal, request, options?): Promise<void>`; options gồm `unordered` (đường dẫn so theo tập hợp), `tables` (bảng cần dump), `bodyShapeOnly` (chỉ cho `health/metrics`)
- Produces: `matrixFor(route): ParityCase[]`, từ phân loại của route (`boundary`, `fresh@1`, mutation hay không)
- Produces: `assertMatrixComplete(group)`: đỏ nếu route đã chuyển thiếu ca áp dụng được

- [ ] Viết kiểm độ nhạy trước: một server giả lệch một field, một header, một dòng audit, một câu SQL thì `step` phải đỏ; lệch danh sách không khai `unordered` cũng đỏ.
- [ ] Implement so status, header, body, DB state, audit, trình tự SQL. Chuẩn hóa `BEGIN` theo ADR-20 §4.
- [ ] Implement proxy TCP đếm message giao thức cho các ca round trip đã ghim ở ADR-17.
- [ ] Viết test chéo runtime cho Review Focus 3, chạy dần: phiên và mã khôi phục (Task 6), idempotency (Task 12), snapshot (Task 13).
- [ ] Chạy `pnpm --filter @hrm/api run test:parity -- test/parity/harness.parity-spec.ts`.

## Task 6: F3, identity, session, limiter, MFA, OIDC

**Files:**

- Create: `internal/authentication/*`, `internal/authentication/credential/*`, `internal/audit/append*.go` (các kind `identity.*`; Task 8 mở rộng)
- Test: `internal/authentication/*_test.go`, `internal/authentication/credential/*_test.go`, `*_integration_test.go`
- Tham chiếu: `authentication/**`, `config/security-policy.config.ts`; port hành vi từ `product-mfa-http`, `product-sign-in-http`, `product-request-auth-http` và các spec identity trong tracker

**Interfaces:**

- Consumes: `database.Run`, `httpapi.*`, `enforcement.RequestAuth`, `test/fixture`
- Produces: `credential.SessionDigest(secret string) ([]byte, error)`, `credential.SecretDigest`, `credential.FreshAuthSQL`, `credential.CanonicalLoginEmail` (kiểm ASCII rồi `strings.ToLower`)
- Produces: `authentication.Service` (session, logout, logout-all, limiter), `MfaService` (có `VerifyKeyCoverage`), `OidcService`
- Produces: `audit.Append(tx *database.Tx, event Event) error` (Tx đã mang deadline riêng, không nhận context)

Giá trị ghim: `RATE_LIMIT_LOCK = 1379171467`; 20 lượt/15 phút mỗi client và mỗi định danh; 200 mỗi IPv6 /48; 10 000 dòng; advisory trước fence; ID token RS256; attempt 5 phút; `sub` tối đa 512.

`credential.CanonicalLoginEmail` theo [ADR-21](../../decisions/ADR-21-ascii-login-email-and-well-formed-text.md) §1: từ chối ký tự ngoài `!`..`~` trước `ToLower`; test gồm U+212A (`Kim@`), `İ`, `i` + U+0307, `kim@exämple`, `ｍ` toàn độ rộng, U+0001, U+007F, U+00A0, surrogate đơn lẻ, và `Kim@Example.com` → `kim@example.com`.

- [x] Test trước: `sessionDigest` gồm secret sai dạng; `bucket_key`; `recoveryCodeHash`; `rootEnrollmentHash`; TOTP; AES-GCM hai chiều với AAD; `canonicalLoginEmail` gồm `İ` và ca âm va chạm. (Task 6a; reviewer đối chiếu với hàm TS thật.)
- [x] Test và implement limiter theo giá trị ghim. (Task 6a, integration `internal/authentication`.)
- [x] Test OIDC ca âm, thấy đỏ trước: sai `iss`, `aud`; nhiều `aud` thiếu `azp`; sai `azp`, `nonce`; thiếu hoặc sai kiểu `iat`; `nbf` ngoài cửa sổ; hết hạn; sai chữ ký; thuật toán khác RS256; `sub` rỗng hoặc quá 512; `email_verified` không phải `true` (chỉ từ chối ở lần đăng nhập đầu và kích hoạt; subject đã gắn vẫn vào, email bỏ qua, theo ADR-06 và ADR-15 D10); state dùng lại; attempt hết hạn; sai browser; sai PKCE. (Task 6b; RED chỉ có ở claims helper, còn lại kiểm bằng đột biến.)
- [x] Implement các service. Lần sai 2FA thứ 10 đăng xuất mọi phiên. Không gọi network, không hash trong fence. Thêm `VerifyKeyCoverage` vào boot trước khi chuyển route MFA.
- [x] Cấu hình CA cho Go trong `stack.helper.ts`, vì `NODE_EXTRA_CA_CERTS` không có tác dụng với Go. Thử `SSL_CERT_FILE` trước; nếu không được thì hỏi người dùng, không thêm nhánh chỉ dùng cho test vào code production. (`SSL_CERT_FILE`, có hiệu lực trên macOS từ Go 1.27; kiểm bằng `NewOidcProvider` với IdP giả và CA của stack, chưa chạy qua Playwright.)
- [x] Test trên stack trộn: phiên do Go tạo dùng được ở route còn proxy sang NestJS (Review Focus 3). (Đã kiểm đọc chéo các cột phiên bằng hàm TS thật; luồng HTTP thật qua Playwright cuối F6: đăng nhập OIDC ở Go rồi employee/report/work-request/work-calendar proxy sang NestJS đều pass.)
- [x] Chuyển `logout`, `logout-all`, `account`, `mfa/*`, `oidc/*` như một nhóm. `auth/session` và `auth/me` chưa chuyển vì cần menu từ authority.
- [x] Test Go đủ ma trận với IdP fixture.
- [x] Chạy `auth.e2e-spec.ts`, `mfa.e2e-spec.ts` trên web. Người dùng 2026-11-06: để tới cuối F6. (Trong lần `test:browser` cuối F6: auth 9/9, mfa 1/1 pass.)
- [x] Cập nhật tracker. Review độc lập (Approved sau một vòng sửa). Chưa commit vào repo.

## Task 7: F4, core, codec, compiler, gateway

**Files:**

- Create: `internal/authorization/core/*`, `internal/authorization/values/*`, `internal/authorization/compiler/*`, `internal/authorization/gateway/*`
- Test: `*_test.go` port từ `apps/api/test/{core,values}`, `*_integration_test.go` port `compiler.integration-spec.ts`, `collation.integration-spec.ts`
- Tham chiếu: `core/AGENTS.md`, `values/AGENTS.md`, `apps/api/test/{core,values}`

**Interfaces:**

- Produces: `core.New(codecs) (*Core, error)`, `Core.ParseKey`, `Core.NormalizeValue`, `Core.Plan`, `Core.PlanUnrestricted`, `Core.Evaluate`
- Produces: `compiler.CompilePlan(plan, bindings) (Bound, error)`, tham số có kiểu, không `[]any`
- Depguard: `core` chỉ import thư viện chuẩn, không biết tên domain

- [x] Port thành test Go bảng ca: `test/core/fixtures.ts` và các spec `decision`, `permission-boundary`, `permission-policy`, `relations`, `runtime`, `unrestricted`, `user-decision`, `key-codec`, `value-codecs`.
- [x] Viết test bảng ca và test zero value. Thấy đỏ.
- [x] Implement core, kiểm unknown action, resource, scope, operator, validator, obligation đều fail closed; ReBAC đủ source, target, version, hạn; path tối đa 8.
- [x] Implement codec: timestamp UTC đúng 6 chữ số lẻ, từ chối giờ 24, giây 60, offset, ngày không tồn tại; key số không qua float.
- [x] Implement compiler; test văn bản SQL, tham số và kết quả trên PostgreSQL thật; identifier chỉ từ binding đã đăng ký. `compileNamed` chỉ phục vụ QueryBuilder của gateway: viết lại thành SQL `$n` trực tiếp.
- [x] Implement gateway: mặc định 20, tối đa 100, offset tối đa 10 000, tối đa 32 node filter; filter bọc ngoặc rồi AND, không thoát khỏi predicate.
- [x] Test `go test -race ./internal/authorization/...` và integration; `core` không kéo Gin, pgx (kiểm bằng test import). Vòng sửa 1 chạy lại toàn bộ package F4 và `./test` theo tên cụ thể vì F5 đang thêm package song song; xem báo cáo Task 7b.
- [x] Cập nhật tracker. Review độc lập Approved sau vòng sửa 1 (`4e1a31b..4f3238e`, chỉ compiler/gateway). Lưu thay đổi.

## Task 8: F5 và F6, audit, declarations, manifest, engine, outbox

**Files:**

- Create: `internal/audit/*`, `internal/authorization/keys/*`, `internal/authorization/declarations/*` (mọi `*_declarations.go`), `internal/authorization/manifest/*`, `internal/authorization/authority/*`, `internal/modules/permission/*`
- Modify: `internal/authorization/enforcement/*` (thêm `authorize`), `test/template.go` (sync bằng Go)
- Test: `*_test.go`, `*_integration_test.go`
- Tham chiếu: `audit/**`, `product.manifest.ts`, `product-manifest*.{service,repository}.ts`, `protected-state.repository.ts`, `product-authority-*.service.ts`, `product-obligation.service.ts`, `product-authority-facts.repository.ts`, `product-runtime.service.ts`

**Interfaces:**

- Produces: `Event` có kiểu theo mọi kind của `audit.Append`
- Produces: `authorization/keys` (hằng có kiểu của mọi `*-authorization.types.ts`), `authorization/declarations` (declarations, bindings, release source; chỉ `app`, `cmd/hrmctl`, `test/` import)
- Produces: `manifest.Prepare(source, core) (Release, error)`, `manifest.Reconcile(ctx, r, release) (Result, error)`
- Produces: `authority.Authorization` với `Permits`, `PermitsMany`, `Read`, `Update`, `Run(command)`; `Command` và `Query` là giá trị đăng ký, so theo con trỏ, gọi giá trị chưa đăng ký bị từ chối
- Produces: `CommandContext{Tx, Actor, Permission, Target, Reaches, Audit}`

- [x] Test và implement audit đầy đủ: revision đúng theo mode, không PII, Root có marker, lỗi ghi làm rollback.
- [x] Viết declarations Go (struct, `encoding/json`). Test: nội dung bằng `release.json`, `bindings.json`; hash do Go tính và ghim. Người dùng chốt 2026-11-08: chỉ Go sync manifest; NestJS upstream kiểm readiness (ADR-22).
- [x] Test `materialized_hash` Go trên PostgreSQL thật, gồm số trong `to_jsonb`.
- [x] Port reconcile: genesis, idempotent, `conflicting_release`, `downgrade`, `predecessor_mismatch`, `collision`, `not_ready`, không ghi đè fact runtime. Sync lại cùng release là no-op.
- [x] Hoàn tất boot theo danh sách ở ADR-20 §5: dòng `oidc_provider`, bốn `ensure*`, `SELECT … LIMIT 0`, `verifyPermissionProtection`, `verifyWorkCalendarSchema`, `verifySettingSchema`. Test lỗi từng bước, không `listen`.
- [x] Port engine: session và facts trong một statement (ADR-17), cửa sổ 2 giây, Root chỉ qua một nhánh, `reaches`, allowlist field, lock `FOR NO KEY UPDATE`. Test fault đọc facts là deny. Test sửa bản sao declarations không ảnh hưởng gốc. Test ngắt client giữa mutation (Review Focus 2).
- [x] Thêm test AST: `planUnrestricted` chỉ được gọi trong engine và core, tương đương `module-boundaries.spec.ts`, có ca âm; `depguard` không thấy method.
- [x] Thêm guard `authorize`: route khai permission phải có trong declarations, thiếu thì không boot.
- [x] Port obligation `audit@1`, thiếu handler thì deny, handler lỗi thì rollback.
- [x] Port outbox: lease, `SKIP LOCKED`, crash, hai worker, poison, backoff, park. Không wire worker, không tạo sink giả.
- [x] Gate: chạy suite Go đầy đủ của nền tảng và `test:integration` NestJS (theo Q4). Báo cáo riêng lỗi môi trường. (2026-11-09: Go race unit/build/vet/lint và integration 25/25 package pass; NestJS 680/684, 1 fail là test cũ lệch ADR-21, sửa ở `b7d1eb3` và spec đó 5/5 pass; người dùng không yêu cầu chạy lại full NestJS. Browser 30/30.)
- [x] Cập nhật tracker. Review độc lập. Lưu thay đổi. **Dừng, báo cáo chi phí thực tế và xin xác nhận đi tiếp.** (Review Approved cho 8a, 8b, 8c; commit `ef803bc`, `11aca5d`, `770c43c`. Chi phí tiền/token không có nguồn billing trong session. Người dùng 2026-11-09 cho đi tiếp Task 9, chỉ quan tâm Go.)

## Mẫu cho mỗi nhóm có chuyển route (Task 9, 10, 12–16)

Mỗi task theo đúng thứ tự:

- [ ] Viết test bảng ca cho helper và validator; test Go đỏ.
- [ ] Port helper, validator; test pass. Giới hạn độ dài theo `UTF16Len`; rà từng `localeCompare`, `toLowerCase`, `trim`.
- [ ] Port repository và test integration theo tracker, một file mỗi lần. Test thấy đỏ trước.
- [ ] Port service, handler; route khai `Classification`; mutation gọi CSRF. Handler chỉ nhận facade.
- [ ] Test HTTP Go của nhóm đủ ma trận ADR-20 §4 (chưa đăng nhập, thiếu grant, deny, boundary, Root, `fresh`, CSRF, Origin, ngoài phạm vi, không tồn tại, input sai, field thừa, idempotency).
- [ ] Thêm route vào `MigratedRoutes`; kiểm inventory.
- [ ] Chạy Playwright của màn hình liên quan.
- [ ] Cập nhật tracker, `apps/api-go/AGENTS.md` nếu có bẫy mới. Review độc lập, sửa finding thật. Tick với tham chiếu test.

## Task 9: M1, `setting`, `team`

Tạo `internal/modules/{settingcore,hrbase,setting,team}`. Trong `internal/modules/`, `setting` import `permission`, `settingcore`; `team` import `permission`, `hrbase`. Bắt đầu từ đây để đo chi phí thực của một module đầy đủ. Dữ liệu nhân viên trong test lấy từ `fixture`, không qua `employees.create`.

- [ ] Làm theo mẫu. Test nguồn: `hrm-setting*`, `hrm-menu-setting`, `hrm-team`. (2026-11-09: mọi bước trừ review độc lập đã có bằng chứng: commit `9c16e51`, `fdf4eaf`, `22e4ec1` và commit ghép 9d; ma trận ADR-20 §4 ở `internal/app/m1_matrix_integration_test.go`, 14 route trong `MigratedRoutes`, Playwright 30/30. Review độc lập chưa chạy.)
- [x] Trigger append-only của `system_setting_history` có test từ login `data`. (`TestTheHistoryIsAppendOnlyForTheRuntimeAndTheOwner`, `internal/modules/setting/setting_integration_test.go`: login `data` và owner `migration`, ruling 75.)
- [ ] **Mốc đánh giá: báo cáo chi phí của M1 và ước lượng phần còn lại; người dùng quyết định đi tiếp.**

## Task 10: M2, `employee`, `auth/session`, `auth/me`

- [ ] Làm theo mẫu. Test nguồn: `hrm-employee`, `hrm-admin-precheck`, `hrm-authorization-*`. Field ACL và PII: projection chỉ trả field được phép, CCCD/MST không vào log. (2026-11-09: implementation 10a–10d và 10e đã có test; ma trận HTTP M2, audit rollback và CROSS được ghi ở tracker/báo cáo 10d. Review độc lập còn chờ, nên chưa tick bước tổng hợp này.)
- [x] Test tên có emoji, tiếng Việt tổ hợp (Review Focus 5). (`TestEmployeeReadScopesProjectionAndLiteralSearch`: PostgreSQL round-trip, F1 projection; validator kiểm độ dài theo code point.)
- [x] Chuyển `GET /api/auth/session`, `GET /api/auth/me` và `GET /api/hr/employees/me`; test menu với mọi loại principal, gồm Root trên danh bạ rỗng (ADR-16). Menu có probe nhiều module: chạy `permitsMany` trên declarations đã có, không cần module đích đã chuyển. (`TestM2AuthenticatedRoutesWithRealSessions`, `TestEmployeeMenusRootEmptyDirectoryAndPermissionRevocation`, `TestLinkedEmployeeMenuFitsSeventeenProbes`, ma trận route động; single Permits vẫn false trên danh bạ IAM rỗng.)

## Task 11: M3, lõi HR dùng chung (không chuyển route)

Làm trước vì `assertPeriodsOpen` và effect của duyệt đơn được tiêm vào `work-calendar`, `work-schedule`, `work-request`, `leave`.

**Files:** `internal/modules/{schedulecore,attendancecore,leavecore}/*`, theo `contract/package-dag.md`. Tham chiếu: `attendance-facts.repository.ts`, `attendance-effect.repository.ts`, `attendance-calculation.helper.ts`, `attendance-facts.helper.ts`, `attendance-snapshot.helper.ts`, `work-schedule-sql.helper.ts`, method `employeeSchedule` của `work-schedule-read.repository.ts`, `leave-effect`/`leave-facts`, `leave-balance.helper.ts`, `working-time.helper.ts`.

**Interfaces:**

- Produces: `attendancecore.AssertPeriodsOpen(tx, dates) error`
- Produces: `attendancecore.ApplyApprovedAttendance(tx, requestID)`, `attendancecore.ApplyApprovedWfh(tx, requestID, acknowledged)`, `attendancecore.ReverseApprovedWfh(tx, requestID)`, `attendancecore.WfhLimitExceeded`, `leavecore.AssertAvailable`, `leavecore.ApplyApproved`, `leavecore.ReverseApproved`
- Produces: `schedulecore.EmployeeSchedule`, các helper lịch và khung giờ

Ghi chú 2026-11-09: tên interface cũ (`AttendanceFacts`, `AttendanceEffects`, `LeaveEffects`) đổi thành hàm tự do nhận `tx` theo quy ước repository của `apps/api-go/AGENTS.md`.

- [x] Test bảng ca cho helper; port oracle `hrm-attendance-effects-oracle.helper.ts` sang Go với seed cố định.
- [x] Port repository và helper, kèm test integration của phần này (`hrm-attendance-effects-equivalence`, `hrm-working-time`, phần facts của `hrm-leave`, `hrm-attendance`).
- [x] Không có route chuyển ở task này. Cập nhật tracker. Review độc lập. Lưu thay đổi. (review độc lập 2026-11-09, finding đã sửa; commit kèm)

## Task 12: M4, `work-calendar` + `work-schedule`

- [x] Làm theo mẫu; một nhóm chuyển cùng lúc. Test nguồn: `hrm-work-calendar`, `hrm-work-schedule*`, `hrm-period-concurrency` (phần lịch). Ghim các ca ADR-19: tháng đã chốt 409, `makeup:null` / `holiday:null`, ngày làm bù tương lai, khoảng chồng nhau. (2026-11-09: mọi bước trừ review độc lập đã có bằng chứng: validator `work_calendar_validator_test.go`, `work_schedule_validator_test.go`; PostgreSQL `TestTheCalendarOnPostgreSQL`, `TestWorkingHoursOnPostgreSQL`, `TestTheDataLoginReplacesSchedulesAndKeepsShiftsBounded`; ma trận `TestTheM4RoutesAnswerEveryCellOfTheMatrix`; 10 route trong `MigratedRoutes`; Playwright toàn suite, xem `task-12-report.md`. Phần `hrm-period-concurrency` cần submit/chốt kỳ để M5/M6.) (review độc lập 2026-11-09, finding đã sửa; commit kèm)

## Task 13: M5, `work-request`, approvals, `leave`

**Files:** `internal/modules/{workrequest,leave}/*`.

**Interfaces:**

- Produces: `workrequest.ApprovedEffects{Leave, Wfh, Attendance}`, ở `workrequest` vì nhận `CommandContext`, lõi HR không import `authority`

Ghi chú 2026-11-09 (13a, chưa tick vì các bước dưới phủ cả submit/duyệt/hủy): ba route `leave` phục vụ tại Go (`internal/modules/leave`, ma trận `internal/app/m5a_matrix_integration_test.go`); payloadHash của `leave.adjust` (1/5 nơi) ghim bằng vector của bản build TS (`leave_hash_test.go`); replay/`error.idempotencyKeyReused`, thứ tự khóa employee → bucket → kỳ công FOR SHARE và tranh chấp cùng khóa có test PostgreSQL (`leave_adjust_integration_test.go`). Xem `task-13a-report.md`.

Ghi chú 2026-11-09 (13b): `POST/GET /api/hr/requests`, `GET /api/hr/requests/:id` phục vụ tại Go (`internal/modules/workrequest`, ma trận `internal/app/m5b_matrix_integration_test.go`); payloadHash của submit (2/5 nơi) ghim bằng vector của bản build TS (`work_request_hash_test.go`); thứ tự khóa và tranh chấp cùng key/chồng lấn có test PostgreSQL. Root replay có audit (ruling 85, cơ chế tạm; bước 13r thống nhất). Xem `task-13b-report.md`.

Ghi chú 2026-11-09 (13c): `POST /api/hr/requests/:id/decision` và `GET /api/hr/approvals/{lead,final,decided}` phục vụ tại Go (`internal/modules/workrequest`, ma trận `internal/app/m5c_matrix_integration_test.go`); payloadHash của quyết định (3/5 nơi, có phần tử điều kiện `ack`) ghim bằng vector của bản build TS (`work_request_decision_test.go`); `ApprovedEffects{Leave, Wfh, Attendance}` và `createApprovedEffects`, test registry thiếu handler; thứ tự khóa request → bucket → kỳ công FOR SHARE, quyết định song song, replay của Root có audit có target có test PostgreSQL (`work_request_decision_integration_test.go`). Cancel và test concurrency `hrm-*-concurrency` để 13e. Xem `task-13c-report.md`.

Ghi chú 2026-11-10 (13e): `POST /api/hr/requests/:id/cancel` phục vụ tại Go, ma trận HTTP pending/approved ở `internal/app/m5e_matrix_integration_test.go`; hash cancel (4/5 nơi) có vector tiếng Việt/emoji/dấu tổ hợp, nơi thứ năm là attendance adjustment (M6). Hủy approved đảo ledger/counter và kiểm kỳ công trong cùng transaction; thứ tự request → bucket/counter → kỳ công giữ như TS/ruling 89. Test PostgreSQL ghim lock order cancel và lệnh lịch M4, tranh chấp cancel/decision, WFH counter, bucket mới, submit tranh phút phép cuối, revoke/retry/audit rollback; Root replay có audit target. Cuộc đua có close/reopen/snapshot thật, gồm `hrm-period-concurrency` :249, còn ở M6 theo tracker; không tick bước chung của Task 13. Xem `task-13e-report.md`.

Ghi chú 2026-11-10 (13d): guard tổng `TestEveryM5RouteHasAFullMatrixIncludingAuthenticatedCommands` ghim đủ 11 route M5 và tái dùng checker cho cả decision/cancel authenticated. Test PostgreSQL/HTTP bổ sung workflow owner → lead → COO → cancel, Root audit/effect, đối soát → detail, SQL/evaluator work-request/leave, ACL/CHECK, ngày lễ/làm bù/membership đã kết thúc, permission runtime, đổi lead/team/account và setting có hiệu lực. Tracker tách riêng ca close/reopen/sheet/snapshot (Task 14), report/export/query-count chéo (Task 15); period :249 vẫn cần close thật, không thay bằng fixture SQL. M5 chỉ sở hữu bốn payloadHash: leave.adjust, submit, decision, cancel; hash thứ năm ở attendance adjustment (`apps/api/src/modules/attendance/attendance.service.ts:39`) thuộc Task 14. Không tick checkbox năm nơi hoặc concurrency tổng trước bằng chứng M6. Gate và review 13d ghi ở `task-13d-report.md`. Sau review độc lập (Approved sau vòng sửa 1) tick idempotency (13a/13b/13c/13e) và `createApprovedEffects` (13c); ba bước còn lại chờ M6 (`hrm-coo-submit` :55/:153, hash thứ năm, period :249).

- [x] Làm theo mẫu. Test nguồn: `hrm-request*`, `hrm-approval*`, `hrm-cancel*`, `hrm-coo-submit`, `hrm-leave*`. (`hrm-coo-submit` :55/:153: `TestM6RequestEffectsMoveTheSheetAndAClosedMonthWaitsForItsReopen`; `task-14e-report.md`)
- [x] Test `payloadHash` cho cả năm nơi (struct, `encoding/json`), gồm lý do tiếng Việt, emoji, và phần tử điều kiện `ack`. (`leave_hash_test.go`, `work_request_hash_test.go`, `work_request_decision_test.go`, `work_request_cancel_test.go`, `attendance_hash_test.go`)
- [x] Test idempotency: replay cùng payload cho cùng kết quả, khác payload ra `error.idempotencyKeyReused`.
- [x] Trình tự SQL chứng minh thứ tự khóa: fence, idempotency, employee theo ID tăng dần, request, bucket, kỳ công `FOR SHARE`. Port test deadlock và concurrency. (period :249: `TestM6ACommandACalendarChangeAndTheCloseOfOneMonthAllFinish/submit`, 0 deadlock/timeout/retry)
- [x] `createApprovedEffects` đăng ký đủ ba effect; test thiếu effect handler thì loại đơn đóng chỉ dùng registry test.

## Task 14: M6, `attendance`

- [x] Làm theo mẫu. Test nguồn: `hrm-attendance*` còn lại, `hrm-period-concurrency`. (14a–14e; `m6_matrix`, `m6_race`, `m6_sheet` integration; phần report/XLSX và `hrm-setting-behavior` CROSS report để M7 theo ruling 82)
- [x] Test `canonicalSnapshot` format 1 và 2; nếu `report` còn ở NestJS khi Go đóng kỳ thì test trên stack trộn (Review Focus 3). (vector `attendance_snapshot_helper_test.go`; stack trộn format 2 mà Go ghi: `apps/web/e2e/attendance.e2e-spec.ts`; format 1 chỉ là dữ liệu cũ, ruling 95)

Ghi chú 2026-11-10 (14d, chưa review): cuộc đua chéo module bằng route Go thật ở `internal/app/m6_race_integration_test.go`: close đua duyệt/hủy WFH và phép năm, nộp đơn, điều chỉnh, ngày lịch, tuyển, nghỉ việc ở hai thứ tự tất định (snapshot của nhân viên luôn bằng bảng công sống, `calendarVersion` là version cuối); period :249 và F-31 (submit hoặc điều chỉnh + đổi lịch + close cùng tháng đều hoàn tất); close/reopen cạnh tranh; `hrm-coo-submit` :55/:153, `hrm-cancel` :213/:232/:253, period :67. Stack trộn: bước close của `apps/web/e2e/attendance.e2e-spec.ts` đọc report NestJS cho tháng Go vừa đóng và so với bảng công Go; đột biến snapshot sai tháng làm report lỗi. Format 1 trên stack trộn chưa kiểm (chỉ vector Go). Bằng chứng và lệnh trong `task-14d-report.md`; chưa tick.

## Task 15: M7, `report`

- [ ] Làm theo mẫu. Test nguồn: `hrm-report*`, `hrm-excel`, `hrm-report-export-http`.
- [x] Parity XLSX theo ô: sheet, header tiếng Việt, kiểu, `numFmt`; chuỗi bắt đầu bằng `=` vẫn là chuỗi; chuỗi rất dài so với ExcelJS.
- [ ] Render ngoài transaction và fence; authorize lại trước khi giao; vượt ngân sách 422; 5000 dòng, 5 MiB; hủy theo context chỉ ở ngoài transaction như `report.service.ts`.
- [ ] Trang rỗng cho người không có grant, không 403/404. Đo export 5000 dòng so với deadline 3000 ms.

Ghi chú 2026-11-10 (15a/15f): 15a (`1919504`) có test parity XLSX. 15f chuyển đủ 12 route report sang Go (repository, service, `httpapi.WriteBinary`, wiring, `MigratedRoutes`, ma trận `m7` theo guard, smoke HTTP), review độc lập Approved. Theo quyết định người dùng 2026-11-10 (chuyển tính năng trước, test bổ sung sau), ba checkbox còn lại chưa tick: oracle `hrm-report` :310/:333/:388, 422/hủy qua HTTP, đo 5000 dòng và mutant là nợ ghi ở `.superpowers/sdd/2026-11-05-go-gin-backend-migration/test-debt.md`.

## Task 16: M8, `role`, `administration`, `health/metrics`

- [ ] Làm theo mẫu. Test nguồn: `hrm-role*`, `hrm-menu-role`, `hrm-menu-account`, `product-account-*`, `account-*`, `grant-set`, `role-*`.
- [ ] Handler `administration` không import `authorization/gateway`: `Row` và `Page`, mà `administration.http-port.ts:2,3,74`, `account.controller.ts:17` đang dùng dưới dạng `import type`, ở Go đặt thành defined type của file không phải handler cùng package. Không dùng alias `type Row = gateway.Row`, vì luật `go/types` của Task 4 từ chối alias tới package bị cấm (`imports_test.go`).
- [ ] Bất biến lệnh tài khoản: không tự tác động, đích phải IAM, grant trong tập của mình, đích không có tập lớn hơn. Root đích luôn bị từ chối. Ba lệnh `account.*`: `boundary: 'required'`, `fresh@1`, tăng `auth_epoch`, không trả secret.
- [ ] Mọi lệnh đổi facts: exclusive fence, kiểm affected set, tăng revision cùng transaction; không báo thành công trước commit. Test sửa dòng `managed_by = 'code'` qua login `authority` bị từ chối.
- [ ] Chuyển `health/metrics`, test shape.
- [ ] Gate: `MigratedRoutes` đủ 100/100; suite Go đầy đủ, `pnpm --filter @hrm/web run test:browser`, Vitest web. Báo cáo riêng lỗi môi trường. Từ đây binary từ chối `API_UPSTREAM_URL`.

## Task 17: C1, CLI offline

**Files:**

- Create: `internal/offline/*`, các subcommand của `cmd/hrmctl`
- Modify: `test/template.go`, `test/fixture/*` (đổi sang `hrmctl`), `apps/web/e2e/stack.helper.ts`, `docker/`, `scripts/dev.sh`
- Test: `cmd/hrmctl/*_integration_test.go`, port `cli-fixture.helper.ts`, `product-cli-mfa`, `product-root-*`, `product-genesis`

- [ ] Port `migrate`, `sync`, `bootstrap`, `reissue-root`, `revoke-root`, `set-root-email`, `reset-root-mfa`, `enroll`, `reset-mfa`, `purge-sessions`, cùng cờ và cùng env `.env.ops`.
- [ ] Kiểm `cmd/api` không link `internal/offline` (test `go list -deps`). File kích hoạt mode `0600`; không in secret. Audit `PRODUCT_OFFLINE_ACTOR` đúng hằng.
- [ ] Đổi script `seed/` sang `hrmctl`, không đọc nội dung file PII khi sửa.
- [ ] Test Root guard, marker, operation lặp, email khác, Root offline trên database dựng bởi Go.

## Task 18: Bỏ NestJS khỏi stack test của web

- [ ] Playwright và `dev:stack` chỉ khởi Go; chạy cả 9 file e2e, không có upstream NestJS.
- [ ] Parity mọi nhóm chạy lần cuối ngay trước C2; lưu kết quả vào `docs/history.md`.

## Task 19: C2, cutover

Chỉ làm khi người dùng xác nhận riêng. Đây là bước xóa code lớn.

- [ ] Tracker không còn dòng trống.
- [ ] Gỡ code proxy và `API_UPSTREAM_URL`; 404 do Go trả.
- [ ] Thêm test ghim SHA-256 từng file SQL ở release đầu (từ đó không sửa migration đã áp dụng, ADR-14).
- [ ] Database dev theo Q5: xóa dựng lại bằng goose, tạo lại Root và dữ liệu HR.
- [ ] Cập nhật mọi chỗ phụ thuộc `apps/api`: `test/locale-keys.spec.ts`, `scripts/dev.sh`, `docker/Dockerfile`, `docker/compose.yaml`, script root, `.github/workflows`. Rà lại bằng `rg 'apps/api\b'`.
- [ ] Xóa `apps/api`, dependency Node của API, cập nhật lockfile bằng `pnpm install`; đổi tên `apps/api-go` thành `apps/api` nếu người dùng muốn.
- [ ] Đổi CI sang `setup-go` và `go test`; ghi rõ workflow chưa chạy thực nếu chưa chạy.
- [ ] Mốc 3 của ADR-20 §9: viết lại `AGENTS.md`, `architecture.md`, `operations.md`, ADR-01, ADR-14; ghi vào `docs/history.md`.
- [ ] Chạy đầy đủ: `go test -race`, integration, lint, Vitest, Playwright, `test:workspace`, format.
- [ ] Review độc lập toàn bộ. Báo cáo: đã chạy gì, chưa chạy gì, và rằng đây là tương đương trên fixture, không phải chứng nhận production.

## Chưa làm trong kế hoạch này

Sink audit, hiệu chỉnh limiter, cờ `email_verified` (Q10 của ADR-15), các giới hạn đã biết của ADR-19: giữ nguyên hiện trạng, port đúng như đang có.
