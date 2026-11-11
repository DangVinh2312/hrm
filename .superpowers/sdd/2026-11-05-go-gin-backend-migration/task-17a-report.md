# Báo cáo Task 17a — khung cờ `hrmctl`, `purge-sessions`, `enroll`, `reset-mfa`/`reset-root-mfa`

BASE `60d7941` (working tree sạch lúc bắt đầu). Không stage/commit, không sửa `apps/api`, không đọc `.env*`/`seed/`. Status: DONE_WITH_CONCERNS (xem Lo ngại).

## Lệnh đã port (so với TS `apps/api/tools/product.ts`, `identity-commands.ts`, `root-commands.ts`)

| Lệnh | Cờ | Env | Login / mode | SQL | Audit | Stdout |
| --- | --- | --- | --- | --- | --- | --- |
| `enroll` | `--user --email --issuer --role` | `PRODUCT_AUTHORITY_DATABASE_URL` | authority / `ModeAdmin` | `role_definition WHERE role_key=$1` (bytea), `provision_oidc_account($1,$2,$3,$4)`, `INSERT user_role` — nguyên văn | `identity.enroll` (`Enrollment{method oidc}`) + `permission.role-assign` (`account.assignRole`, target account/uuid, roleKey, targetUserId), actor `audit.OfflineActor` | `Pending account enrolled for its first verified Google login within 7 days.` |
| `purge-sessions` | `--retention-days` (`^[0-9]{1,4}$`, ≤ 3650) | `PRODUCT_IDENTITY_DATABASE_URL` | identity / `ModeIdentity` (qua `offline.PurgeExpiredSessions` có sẵn) | có sẵn | `identity.session-purge` khi xóa > 0 | `Purged N expired sessions.`; ≤ 200 lô × 500 |
| `reset-mfa` | `--user --operation --approval --reason` | `PRODUCT_IDENTITY_DATABASE_URL` | identity / `ModeRevoke` | `SELECT kind … FOR NO KEY UPDATE`, `DELETE mfa_recovery_code`, `WITH removed AS (DELETE FROM mfa_totp …) SELECT * FROM removed` — nguyên văn | `identity.mfa-reset` (`OfflineRevoke`, reason vào cột `reason`) chỉ khi xóa được TOTP | `Second factor and recovery codes removed; the account sessions ended.` / `No second factor; nothing changed.` |
| `reset-root-mfa` | như trên | `PRODUCT_BOOTSTRAP_DATABASE_URL` | bootstrap / `ModeBootstrap` | như trên, kind phải `root` | như trên | như trên |

Chung: bộ đọc cờ viết tay (`cmd/hrmctl/main.go:82` `parseFlags`), allowlist `commandFlags` (`:41`), bỏ một `--` đầu, cặp lỗi → `Expected unique --option value pairs`, cờ lạ → `Unexpected option --k`. `provision`/`migrate`/`sync` giữ hành vi, giờ cũng đi qua bộ đọc cờ (allowlist rỗng). Lệnh lạ → `Expected provision|migrate|sync|enroll|purge-sessions|reset-mfa|reset-root-mfa`. Mỗi lệnh mới mở đúng một pool (`cmd/hrmctl/identity.go:26` `openRunner`). `run` nhận thêm `out io.Writer` để test đọc stdout.

## Bất biến → code → test

| Bất biến | Code | Test |
| --- | --- | --- |
| Actor audit = `audit.OfflineActor` | `internal/offline/enroll.go:43,49,53`; `mfa_reset.go:101` | `TestEnrollCommitsAPendingAccountItsRoleAndTwoOfflineEvents` (metadata jsonb chính xác + `policy_revision`), `TestEachResetCommandResetsOnlyItsKindOfAccount`, `TestPurgeSessionsDeletesOnlyExpiredSessions`; đột biến m4 đỏ |
| Audit atomic với mutation | `database.Run` một transaction, `audit.Append` trong callback | lỗi append → rollback (runner); không có ca riêng |
| `reset-mfa` trên Root/vắng bị từ chối, không xóa | `mfa_reset.go:87` (`ErrNotIAMAccount`) | `TestEachResetCommandResetsOnlyItsKindOfAccount` (đếm TOTP + code giữ 2, 0 event); đột biến m1 đỏ (identity xóa được factor Root, chỉ code chặn) |
| `reset-root-mfa` trên IAM bị từ chối | `mfa_reset.go:87` (`ErrNotRootAccount`), thêm trigger `protect_mfa_*` | cùng test; m1 cho thấy trigger trả 42501 |
| Enroll role vắng → không ghi | `enroll.go:40-41` | `TestEnroll…` (`ErrUnknownRole`, 0 `app_user`, revision không đổi); đột biến m2 đỏ (FK 23503 thay vì lỗi tên) |
| Cờ lạ bị từ chối | `main.go:93` | unit `TestFlagsArePairsOfTheCommand`; integration enroll `--subject`; đột biến m3 đỏ |
| Không in secret/email/giá trị | `failureLine` (`main.go:55`) chỉ usage/reason/lỗi tên hằng/SQLSTATE; `flagName` (`:53`) | `TestTheFailureLineNamesReasonsAndInputsButNoValue`, `TestInputsAreRefusedBeforeConnectingWithoutTheirValue`, `TestAnInvalidConnectionURLIsNamedNotPrinted`; integration kiểm stdout/stderr không `@` và mọi dòng `audit_outbox` (`o::text`) không `@` |
| Input validate trước khi dùng | UUID `IsCanonicalUUID` + ≠ actor offline, `grant.IsRoleKeyReference`, `credential.CanonicalLoginEmail` (`identity.go:60-70`); approval/reason `offline.NewMFAReset` (`mfa_reset.go:42`, UTF-16 ≤ 200/1000, không Cc, không rỗng sau trim kiểu JS) | `TestInputsAreRefusedBeforeConnectingWithoutTheirValue` (mọi ca dừng trước khi đọc URL), `TestLimitsCountUTF16UnitsAsTheTypeScriptCLI`; đột biến m5 đỏ |
| `cmd/api` không link `offline`, goose chỉ offline | không đổi import của `cmd/api`; cạnh mới đều có trong DAG | `go test ./test` ok |
| Purge chỉ phiên hết hạn | `offline.PurgeExpiredSessions` có sẵn | `TestPurgeSessionsDeletesOnlyExpiredSessions` |

Không thêm cạnh DAG: `cmd/hrmctl` dùng `audit`, `credential`, `declarations`, `grant`, `manifest`, `database`, `offline` (đã khai); `offline` dùng `audit`, `core`, `database`.

## Quyết định tự đưa ra

1. Cờ lạ không khớp `^--[a-z][a-z-]{0,31}$` chỉ in `Unexpected option` (TS in nguyên key). Lý do: `--user=<email>` gõ nhầm sẽ in địa chỉ. Chặt hơn TS, không đổi kết quả (vẫn từ chối).
2. Lệnh lạ bị từ chối trước khi đọc cờ (TS đọc cờ trước nên lệnh lạ có cờ ra `Unexpected option`). Cả hai đều exit 1.
3. Toàn bộ validation (kể cả approval/reason, retention > 3650) chạy trước khi mở pool; TS mở kết nối rồi mới kiểm printable trong service. Chỉ đổi thứ tự lỗi.
4. Validation enroll ở `cmd/hrmctl` (như TS tool), của reset trong `offline.NewMFAReset` (như TS service); `MFAReset` có field private nên `ResetMFA` chỉ nhận giá trị đã kiểm.
5. Dòng lỗi giữ dạng Go hiện có (`Product operation failed <phần>; …`, không ngoặc, không tên class). Reason của `*manifest.Rejection` và tên hằng lỗi input được thêm.
6. Trim theo `String.prototype.trim`: `unicode.IsSpace` cộng U+FEFF (U+0085 là Cc nên đã bị từ chối). Không dùng `httpapi.InputText` vì `hrmctl` không được link `httpapi`.
7. Thông điệp `ErrNotRootAccount` viết `second factors of the Root only: …` (chữ thường đầu, theo lint ST1005); ý giữ như TS, tên lệnh là tên `hrmctl`.

## Lệnh đã chạy (trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, sau `waitload.sh`, load ~2)

- RED: `go test -count=1 ./cmd/hrmctl` → exit 1 (build failed: `parseFlags`, `offline.ErrUnknownRole`… chưa có). Lượt GREEN đầu exit 1 do hai kỳ vọng test sai (`-- -- x` thật ra là `Unexpected option`; chuỗi "secret" trùng câu `no secrets are printed`), sửa test.
- Integration lượt đầu exit 1: `SQLSTATE 42501` khi superuser thêm TOTP cho Root (trigger `guard_root_lifecycle` chỉ cho login identity đổi Root); sửa test ghi factor bằng `database.Run` mode identity.
- `gofmt -l .` → lần đầu báo `cmd/hrmctl/identity_integration_test.go`, đã sửa; lần cuối rỗng.
- `go build ./...` exit 0; `go vet ./...` exit 0; `go vet -tags integration ./...` exit 0 (ba lệnh này chạy nối tiếp sau một lần `waitload.sh`, load ~2).
- `go test -race -count=1 ./cmd/... ./internal/...` exit 0 (39 dòng `ok`).
- `go test -count=1 ./test` exit 0 (`ok hrm/api-go/test 4.893s`).
- `go tool golangci-lint run` exit 0, `0 issues.`
- `go test -tags integration -race -count=1 -p 1 -v ./cmd/hrmctl` exit 0, 13 test PASS (`ok … 7.975s`); dùng `fixture.Root` nên cần `apps/api/dist` (đã kiểm không có file `apps/api/src` mới hơn `tsconfig.tsbuildinfo`).
- `go test -tags integration -race -count=1 -p 1 ./internal/offline` exit 0 (`ok … 15.967s`).
- Đột biến bằng `-overlay` (bản sao trong scratchpad, không sửa repo): m1 bỏ kiểm kind → đỏ; m2 bỏ kiểm role → đỏ; m3 bỏ allowlist → đỏ; m4 actor audit = operation id → đỏ; m5 đếm rune thay UTF-16 → đỏ. (Lượt đầu m1/m2/m5 không biên dịch, viết lại cho biên dịch được rồi chạy lại.)
- `pnpm exec prettier --check apps/api-go/AGENTS.md …/test-debt.md` exit 0; `git diff --check` exit 0.

## File đổi

- Sửa: `apps/api-go/cmd/hrmctl/main.go`, `main_test.go`, `sync_integration_test.go` (thêm `io.Discard`), `apps/api-go/AGENTS.md` (danh sách lệnh `hrmctl`), `.superpowers/…/test-debt.md` (mục Task 17a).
- Mới: `apps/api-go/cmd/hrmctl/identity.go`, `flags_test.go`, `identity_integration_test.go`, `apps/api-go/internal/offline/enroll.go`, `mfa_reset.go`, báo cáo này.

## Nợ

`test-debt.md` mục "Task 17a": provision/migrate lặp qua CLI và release CLI = API (`product-cli.integration-spec.ts:9`), ma trận cờ của lệnh Root (`:27`, chờ 17b), field enroll còn lại (hạn 7 ngày, 0 binding/token, `--user` = actor offline qua tiến trình; `:77`), epoch đúng +1 và thứ tự audit reset (`product-cli-mfa.integration-spec.ts:10`), exit code tiến trình thật (17c), ca recovery code không TOTP.

## Chưa kiểm

- Chưa chạy binary `hrmctl` như tiến trình con (exit code 1, stderr thật); test gọi `run` + `failureLine`.
- Chưa kiểm `.env.ops` thật có `NODE_ENV` hợp lệ cho Go (bản đồ, Rủi ro 2); người dùng tự kiểm.
- `UnavailableError`/`ConflictError` (vd. login sai, DB không trả lời) chỉ ra dòng `Product operation failed; …` không có code; không đổi ở lát này.
- Approval dài ≤ 200 đơn vị UTF-16 nhưng > 256 byte (chữ nhiều byte) qua được kiểm input rồi bị `audit` từ chối (`ErrInvalidEvent`), transaction rollback: fail closed, giống giới hạn audit của TS (suy ra, chưa chạy ca này).

## Ghi chú cho 17b

- `openRunner(ctx, env, "PRODUCT_BOOTSTRAP_DATABASE_URL", database.PurposeBootstrap)` dùng lại được; thêm cờ vào `commandFlags`, thêm tên lỗi vào danh sách `failureLine`; reason `collision/missing_reference/not_ready/invalid_release` đã in qua `*manifest.Rejection`.
- Ghi factor/sửa Root trong test phải qua login identity (trigger `guard_root_lifecycle`).
- `fixture.Root` còn gọi CLI TS tới 17c.
