# Báo cáo Task 17c — hạ tầng test Go dùng `hrmctl` thay CLI TypeScript

BASE `3ce6460`. Implementer trước (bị ngắt 09:26, không viết report) đã làm gần hết phần sửa code/docs; implementer này (từ ~09:40) đối chiếu diff với brief, sửa phần thiếu, chạy lại toàn bộ check và viết báo cáo. Không stage/commit, không tick plan, không sửa `progress.md`.

## Thay đổi

Do implementer trước làm (đã đọc lại từng dòng và xác minh bằng check bên dưới):

- `apps/api-go/test/template.go`: bỏ `apiRoot`, `checkBuilt`, `rebuild`, `cluster.typeScript`, `Stack.TypeScriptCLI`. Thêm `buildHrmctl` (một lần mỗi binary test, trong `startCluster` qua `sharedOnce`), `cluster.hrmctl`, `Stack.Hrmctl`. Template chỉ gọi `hrmctl provision` (đã gồm migrate), rồi manifest sync và anchors bằng Go trong process như trước. Env của tiến trình con bỏ `PATH`, `HOME` (binary Go tĩnh không cần), giữ `DATABASE_ADMIN_URL`, `PRODUCT_DATABASE_NAME`, `PRODUCT_<LOGIN>_PASSWORD`, `PRODUCT_<LOGIN>_DATABASE_URL`.
- `apps/api-go/test/fixture/fixture.go`: `fixture.Root` gọi `s.Hrmctl(…, "bootstrap", …)` với đúng các cờ cũ (`--operation`, `--issuer`, `--email`, `--activation-file`); regex `rootCommitted` không đổi.
- `apps/api-go/internal/authentication/oidc_integration_test.go`: `pendingRoot` gọi `s.Hrmctl`; regex `rootCreated` không đổi; 6 nơi gọi (`bootstrap`, `reissue-root`) không phải sửa.
- `apps/api-go/internal/authorization/manifest/reconcile_integration_test.go`: theo ruling 107 bỏ bước TS `sync`, đổi tên thành `TestGoSyncedFixtureSupportsRootBootstrap`, phần Root qua `fixture.Root` (= `hrmctl bootstrap`).
- `apps/api-go/test/export_test.go`: bỏ `CheckBuilt`. `apps/api-go/test/template_test.go`: xóa `TestTheTemplateRefusesAStaleBuild` (38 dòng).
- `apps/api-go/package.json` `test:integration`: bỏ `pnpm --filter @hrm/api run build &&`.
- `apps/api-go/AGENTS.md` (dòng đầu và đoạn integration), `contract/test-port-tracker.md` (dòng `product-root-activation`, `product-system › Root bootstrap…`).

Do implementer này sửa thêm:

1. `test/template.go:275`: `golangci-lint` đỏ (gosec G204 trên `exec.CommandContext(ctx, "go", "build", "-o", binary, …)`), log lint cũ rỗng nên implementer trước chưa thấy. Thêm `//nolint:gosec // the output path is the directory of the test binary itself`, cùng kiểu với `nolint` có sẵn ở dòng 286.
2. `contract/test-port-tracker.md`: hai dòng còn nói CLI TS — `module-template.helper.ts` ("Template dựng bằng CLI TypeScript (`provision`, `migrate`, `sync`)… Task 17 đổi `provision`") và `system-regression.helper.ts` ("provision/migrate/bootstrap TypeScript còn dùng tới Task 17") — đổi sang `hrmctl`.

Test bị xóa `TestTheTemplateRefusesAStaleBuild`: nó chỉ kiểm `checkBuilt` (từ chối `apps/api/dist` thiếu hoặc cũ hơn một file `src/*.ts`). Rủi ro đó biến mất cùng `checkBuilt`: `hrmctl` được `go build` từ source hiện tại ở mỗi process test, không có artefact cũ để từ chối; build lỗi thì `startCluster` trả lỗi và mọi test của binary fail (fail closed). Không mất ca từ chối bảo mật hay bất biến dữ liệu nào, nên không thêm ca thay thế.

## Cách template build/gọi `hrmctl`

- `buildHrmctl`: `go build -o <dir của os.Executable()>/hrmctl ./cmd/hrmctl`, `Dir` = gốc module (tính từ `runtime.Caller`). Binary nằm trong work dir `$WORK/b…` của `go test`, bị xóa khi chạy xong. Context là `buildTimeout` 5 phút chung với khởi PostgreSQL và provision. Env build kế thừa process test (gồm `GOCACHE`).
- `cluster.hrmctl`: chạy binary với `commandTimeout` 1 phút, env tối thiểu ở trên, gộp stdout+stderr. `NODE_ENV` và `PGSSLMODE` để trống → `tlsMode` nhận `""` và tắt TLS (`cmd/hrmctl/main.go:170-180`), đúng với container local.
- `provision` gồm migrate: `cmd/hrmctl/main.go:212-255` → `offline.Provision`, trong đó `runMigrations` chạy bằng login migration (`internal/offline/provision.go`, đoạn quanh `grantForMigration`/`runMigrations`). Xác minh thực tế: toàn bộ integration xanh trên template này.
- `test/` không import `internal/offline` (`rg 'internal/offline' test/` chỉ thấy `imports_test.go`); `TestGooseIsOnlyInTheOfflineCommand` xanh trong `go test -count=1 ./test`.
- Cache kết quả `go test` không theo dõi source `cmd/hrmctl` mà tiến trình con build, nên AGENTS ghi chạy integration với `-count=1` (script đã có).

## Bằng chứng không còn phụ thuộc TS

1. `rg -n 'apps/api/dist|tools/product|TypeScriptCLI|TypeScript CLI|checkBuilt|CheckBuilt|apiRoot|typeScript\(|"node"|pnpm' apps/api-go` (trừ tracker): không còn lời gọi. Còn lại chỉ là comment/AGENTS ghi nguồn gốc vector hash đã ghim (`leave_hash_test.go`, `work_request_*_test.go`, `credential_test.go`, `role_grant_helper_test.go`, `role_validator_test.go`), comment về hành vi TS trong `cmd/hrmctl/main.go`, `offline/mfa_reset.go`, `package-dag.md`, và câu AGENTS về stack e2e/dev (17d). `rg 'exec\.Command' --glob '*.go' apps/api-go` chỉ còn `go list`/`go build` và binary `hrmctl`.
2. Chạy integration `./test/...` và `./internal/authentication` với `PATH=/usr/local/bin:/usr/bin:/bin` (có `go`, `git`, `docker`; không có `node`, `pnpm`, `npx`, `tsx` — `command -v node pnpm` exit 1, ghi đầu log). Tiến trình `hrmctl` con còn chạy không có `PATH`. Nếu bất kỳ code nào gọi `node` thì `exec` trả `*exec.Error`, như log RED của implementer trước (`/private/tmp/hrm-17c-red.log`: template cũ, cùng cách chạy, `fixture cluster: TypeScript provision: *exec.Error`). Kết quả: xanh (mục lệnh).
3. `apps/api/dist` không được build lại: `tsconfig.tsbuildinfo` mtime `Nov 8 15:26:30 2026`, `main.js` `Nov 6 10:13:27 2026`, trước và sau mọi lệnh. Không xóa `dist`.

## Lệnh đã chạy (trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng sau `waitload.sh`, load 2–14, dưới ngưỡng 40)

| Lệnh | Kết quả | Log |
|---|---|---|
| `go build ./...` | exit 0 | `/private/tmp/hrm-17c-build.log` |
| `go vet ./...` | exit 0 | `hrm-17c-vet.log` |
| `go vet -tags integration ./...` | exit 0 | `hrm-17c-vetint.log` |
| `go test -count=1 ./test` | exit 0, `ok hrm/api-go/test 5.799s` | `hrm-17c-test.log` |
| `gofmt -l .` | rỗng, exit 0 | — |
| `go tool golangci-lint run` | lần 1 exit 1 (gosec G204 `test/template.go:275`); sau sửa exit 0, `0 issues.` | `hrm-17c-lint.log` (lần 2) |
| `go test -race -count=1 ./cmd/... ./internal/...` | exit 0, 39 `ok`, 1 không có test | `hrm-17c-unit.log` |
| PATH không node/pnpm: `go test -race -tags integration -count=1 -p 1 ./test/... ./internal/authentication` | exit 0: `test` 20.994s, `test/fixture` 9.708s, `internal/authentication` 66.332s; real 107.49s | `hrm-17c-nonode.log` |
| Toàn bộ: `go test -race -tags integration -count=1 -p 1 -timeout 90m ./cmd/... ./internal/... ./test/...` | exit 1: 41 `ok`, 1 FAIL (`internal/modules/setting`), 1 không có test (`test/fixture/attendanceoracle`); real 840.77s | `hrm-17c-integration.log` |
| Chạy lại riêng `./internal/modules/setting` (integration, race) | exit 0, `ok 11.777s` | `hrm-17c-setting.log` |
| `pnpm exec prettier --check apps/api-go/AGENTS.md apps/api-go/contract/test-port-tracker.md` | exit 0 | — |
| `git diff --check -- apps` | exit 0 | — |

FAIL của `internal/modules/setting` là lỗi môi trường: `fixture cluster: start PostgreSQL: start the container: … wait until ready: mapped port: … get state: Get "http://…/docker.sock/v1.56/containers/…/json": context deadline exceeded` (Docker API không trả lời trong lúc khởi container, 124s; các test còn lại của package fail dây chuyền vì cùng cluster). Lỗi xảy ra ở `StartPostgres`, sau `buildHrmctl` đã xong; không phải 25P04. Chạy lại riêng thì xanh. Không có ca nào khác đỏ.

Lệnh dùng thay script: `pnpm --filter @hrm/api-go run test:integration` không chạy trực tiếp; lệnh `go test` trên tương đương script mới cộng `-timeout 90m`.

Log của implementer trước (`hrm-17c-baseline.log`, `-red.log`, `-green.log` cho `./internal/authorization/manifest`) giữ nguyên; `-unit/-nonode/-build/-vet/-vetint/-lint/-test` đã bị ghi đè bằng lượt chạy này.

## Thời gian dựng template

Không đo trước/sau trên cùng workload. Chỉ có số tổng package (máy dev macOS, Docker Desktop 29.9.2, load 2–8): `test/fixture` 9.7–10.4s, `internal/authorization/manifest` 12.2s (log green của implementer trước: package đó chạy đơn lẻ). Lượt đầu mỗi process tốn thêm một `go build ./cmd/hrmctl` (nhanh khi cache ấm), bù lại bỏ hai lần khởi Node.

## File đổi (so với `3ce6460`)

`apps/api-go/test/template.go`, `test/template_test.go`, `test/export_test.go`, `test/fixture/fixture.go`, `internal/authentication/oidc_integration_test.go`, `internal/authorization/manifest/reconcile_integration_test.go`, `package.json`, `AGENTS.md`, `contract/test-port-tracker.md`; mới: báo cáo này. Không đổi root `package.json`, stack web/dev/docker, `seed/`, `apps/api`.

## Nợ

- Không thêm test cho đường lỗi `buildHrmctl` (build hỏng → mọi test của binary fail) — hiển nhiên khi xảy ra, không có ca bảo mật.
- `apps/api-go/AGENTS.md:121` còn câu "TypeScript CLI sync chỉ dùng trong tests lịch sử": giờ không test Go nào dùng; để nguyên (nói về test NestJS), 17d/C2 viết lại khi gỡ.

## Chưa kiểm

- Không chạy `pnpm --filter @hrm/api-go run test:integration` qua pnpm (chạy lệnh `go test` tương đương).
- Không đo thời gian dựng template trước/sau.
- Chạy test binary dựng sẵn (`go test -c`) ngoài work dir: `hrmctl` sẽ được ghi cạnh binary đó và không tự xóa. Không ai dùng cách này hiện nay; chưa thử.
- Không có đột biến kiểm độ nhạy (thay đổi là hạ tầng, không phải logic có nhánh mới).

## Lo ngại

- Integration toàn bộ có một FAIL môi trường (Docker API timeout) ở `internal/modules/setting`; chạy lại riêng xanh. Không có lượt toàn bộ xanh liền một mạch.
- `go build` của `buildHrmctl` cần `git` khi stamp VCS (mặc định `-buildvcs=auto` trong repo git). Máy dev và PATH thu hẹp đều có `git`; môi trường CI không có `git` có thể cần `-buildvcs=false`. Suy đoán, chưa kiểm.

## Ghi chú cho 17d

- Test Go đã độc lập với `apps/api/dist`; e2e (`apps/web/e2e/stack.helper.ts`), `scripts/dev.sh`, `docker/*`, root `package.json`, `seed/enroll*` vẫn gọi CLI TS — phạm vi 17d.
- `hrmctl` chạy được với env tối thiểu: không cần `NODE_ENV`/`PGSSLMODE` (trống = TLS tắt), chỉ cần URL của login lệnh đó (Root: `PRODUCT_BOOTSTRAP_DATABASE_URL`; provision: `DATABASE_ADMIN_URL`, `PRODUCT_DATABASE_NAME`, bảy `PRODUCT_<LOGIN>_PASSWORD`).
- Câu stdout `Root enrollment committed (id …); activation still required.` là contract mà `fixture.Root`, `pendingRoot` và `cmd/hrmctl/root_integration_test.go` ghim; e2e nên parse cùng regex.

## Review độc lập và ghi chú của điều phối viên (2026-11-11)

Reviewer opus (chỉ đọc diff + brief, không đọc báo cáo này): **Approved**, 0 Critical, 0 Important, 4 Minor. Không sửa code sau review; cả bốn Minor ghi `test-debt.md` mục Task 17c:

1. `test/template.go` `buildHrmctl` ghi binary cạnh binary test: với `go test -c`/`-o`/debugger IDE, file `hrmctl` nằm lại trong thư mục package và không bị gitignore (rủi ro dự kiến, chưa tái hiện).
2. `buildTimeout` 5 phút nay gồm cả `go build`; reviewer gặp một lần `-run 'Root|Reissue' ./internal/authentication` FAIL (test đầu 125 s, phần còn lại fail theo `errShared`), không có log, hai lần chạy lại PASS. Chưa rõ nguyên nhân, coi là môi trường; để ý nếu lặp lại.
3. `reconcile_integration_test.go:130-133` `root.ID == ""` không bao giờ đỏ; nên thay bằng assertion `!result.Changed` (có từ trước).
4. `pendingRoot` không `t.Fatal` khi `bootstrap` không in câu commit (có từ trước).

Integration toàn bộ: một lượt, exit 1 (41 ok, `internal/modules/setting` FAIL do Docker API hết hạn khi khởi container; chạy lại riêng package: ok). Chưa có lượt toàn bộ xanh liền một mạch trên diff này.
