# Bản đồ Task 17 (C1, CLI offline `hrmctl`)

Chỉ đọc source ở HEAD `702bf2c` (working tree sạch lúc bắt đầu); không chạy test/build/pnpm/docker. `file:dòng` tương đối từ gốc repo. Viết tắt: `A/` = `apps/api`, `G/` = `apps/api-go`. "Quan sát" = đọc từ code; "Suy đoán" = chưa kiểm, ghi cách xác minh. Không mở `.env*` và nội dung `seed/`.

Ranh giới plan: Task 17 port CLI và đổi hạ tầng test/dev sang `hrmctl`; Task 18 chỉ còn Playwright/`dev:stack` không có NestJS và parity cuối; Task 19 xóa `apps/api`, dựng lại DB dev bằng goose (Q5), viết lại docs/AGENTS (`docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md:367-397`). ADR-20 §rollback: "Sau C1, CLI TypeScript vẫn còn đến C2; không chạy song song hai CLI trên cùng thao tác" (`docs/decisions/ADR-20-go-gin-backend-migration.md:317`).

## 0. Hiện trạng Go

Quan sát:

| Thành phần | Có gì | Vị trí |
|---|---|---|
| `cmd/hrmctl` dispatch | `provision`, `migrate`, `sync`; mọi option bị từ chối (`len(options) > 0` → `Unexpected option`), chỉ bỏ một `--` đầu | `G/cmd/hrmctl/main.go:53-84` |
| Dòng lỗi | `Product operation failed` + usage message + 4 lỗi đã biết của `offline` + SQLSTATE; không in message driver | `G/cmd/hrmctl/main.go:33-51` |
| TLS | `NODE_ENV` phải `''/development/test/production`; `PGSSLMODE` `disable/prefer/require/verify-ca/verify-full` | `G/cmd/hrmctl/main.go:98-114` |
| `provision` | `DATABASE_ADMIN_URL`, `PRODUCT_DATABASE_NAME`, 7 `PRODUCT_*_PASSWORD`; `offline.CreateDatabase` + `offline.Provision` (tạo login, owner, cấp tạm, chạy goose, thu hồi) | `G/cmd/hrmctl/main.go:140-184`; `G/internal/offline/provision.go:105-176` |
| `migrate` | `PRODUCT_MIGRATION_DATABASE_URL`; goose `Up`; in `Applied forward migrations.` (không có số lượng, TS in `Applied N`) | `G/cmd/hrmctl/main.go:186-203`, `:74`; `G/internal/offline/migrate.go:16-41` |
| `sync` | Cần đủ 4 URL runtime (`config.RuntimeDatabases`), **từ chối** khi có `DATABASE_ADMIN_URL`, `PRODUCT_MIGRATION_/BOOTSTRAP_/OUTBOX_DATABASE_URL`; reconcile + 4 anchor | `G/cmd/hrmctl/sync.go:13-56`; `G/internal/config/runtime_database.go:3-14` |
| `PurgeExpiredSessions` | Đã port (SQL, giới hạn 0–3650/1–1000, audit `identity.session-purge`, actor offline) nhưng **chưa nối vào `hrmctl`** | `G/internal/offline/session_purge.go:30-48`; test `session_purge_test.go`, `session_purge_integration_test.go:62,113` |
| Audit | Kind và detail cho Root/offline đã có: `KindRootBootstrap/Reissue/SetEmail/Revoke`, `KindIdentityMfaReset`, `KindIdentityEnroll`; `RootBootstrap`, `RootReissue`, `RootSetEmail`, `OfflineRevoke`, `Enrollment`; `audit.OfflineActor = "00000000-0000-4000-8000-000000000001"` (trùng TS `A/src/audit/product-audit.repository.ts:14`) | `G/internal/audit/event_kinds.go:34-40`, `event_types.go:52-56`, `audit_repository.go:37`; test `full_event_test.go:101-105` |
| Runner | `ModeBootstrap` → login bootstrap, `ModeRevoke` → identity; cả hai (và admin) tăng `revision` cùng transaction như TS | `G/internal/database/runner.go:19-26,65-72,293` |
| Mảnh dùng lại | `credential.CanonicalLoginEmail`, `(*core.Core).IsCanonicalUUID`, `grant.IsRoleKeyReference`, `manifest.ProtectedStateHash`, `Release.Hash()`, `manifest.Rejection{Reason}` | `G/internal/authentication/credential/session_helper.go:59`, `authorization/core/authorization_factory.go:225`, `authorization/grant/role_grant_helper.go:26`, `authorization/manifest/protected_state_repository.go:20`, `release_types.go:71-77` |
| Quyền login bootstrap | Đủ cột/bảng cho bootstrap/reissue/revoke/set-email/reset-root-mfa (INSERT `app_user`, UPDATE `kind/state/auth_epoch/email_*`, `oidc_email_enrollment`, `one_time_token`, `security_bootstrap_state`, DELETE `mfa_*`, `audit_outbox`) | `G/internal/database/privilege_declarations.go:382-435` |

Còn thiếu so với plan (`plan:375`): `bootstrap`, `reissue-root`, `revoke-root`, `set-root-email`, `reset-root-mfa`, `enroll`, `reset-mfa`, `purge-sessions` (logic có, thiếu subcommand), bộ đọc cờ `--option value`, dòng lỗi có lý do `collision/missing_reference/not_ready/invalid_release`. `provision`, `migrate`, `sync` đã có (khác TS: xem §1).

## 1. Bảng lệnh CLI TypeScript

Nguồn: `A/tools/product.ts` (dispatch), `A/tools/root-commands.ts`, `A/tools/identity-commands.ts`, `A/tools/env.ts`. Chung (Quan sát):
- Cờ: cặp `--key value`, không trùng, chỉ cờ trong `allowedFlags` của lệnh (`product.ts:66-91`); bỏ một `--` đầu (`:64`). Lệnh lạ → lỗi (`:186-189`).
- Kết nối mỗi login: `PRODUCT_<PURPOSE>_DATABASE_URL` (`product.ts:37-57,95-101`); TLS qua `pg`/`PGSSLMODE` (TS không kiểm `NODE_ENV`).
- Env đọc từ `A/.env.ops` qua script `node --env-file-if-exists=.env.ops tools/product.ts <cmd>` (`A/package.json:24-36`). Tên biến dưới đây lấy từ code, không từ file env.
- Lỗi: in `Product operation failed (<Class> <reason> <SQLSTATE>)…`, `exitCode = 1` (`product.ts:190-201`); `<reason>` chỉ khi `ReleaseRejectedError` (`collision`, `missing_reference`, `not_ready`, `invalid_release`). Thành công exit 0.
- Audit actor luôn `PRODUCT_OFFLINE_ACTOR`.

| Lệnh (script pnpm) | Cờ | Env | Login / mode | SQL / hàm DB | Audit | Stdout; secret | Guard / lỗi |
|---|---|---|---|---|---|---|---|
| `provision` (`db:provision`) | không | `DATABASE_ADMIN_URL` (`env.ts:11-26`), `PRODUCT_DATABASE_NAME` (`^[a-z_][a-z0-9_]{0,62}$`), 7 `PRODUCT_*_PASSWORD` | admin → `CREATE DATABASE`, rồi `provisionProductDatabase` (gồm migrations) | `product.ts:107-132` | không | `Product database provisioned; credentials are never printed.` | Go đã có |
| `migrate` (`db:migrate`) | không | `PRODUCT_MIGRATION_DATABASE_URL` | migration; TypeORM `runMigrations({transaction:'each'})` (bảng `migrations` của TypeORM) | `product.ts:133-141` | không | `Applied N forward migrations.` | Go đã có (goose, bảng `goose_db_version`) |
| `sync` (`manifest:sync`, nay root script trỏ Go) | không | `PRODUCT_SYNC_DATABASE_URL` (chỉ một) | sync | reconcile + 4 `ensure*` (`product.ts:142-159`) | `manifest.sync` (trong reconciler) | `Manifest synchronized.` | Go đã có nhưng cần 4 URL runtime và từ chối URL ops (§0) |
| `enroll` (`identity:enroll`) | `--user --email --issuer --role` | `PRODUCT_AUTHORITY_DATABASE_URL` | authority / `admin` (fence độc quyền, tăng revision) | `role_definition WHERE role_key=$1` (bytea), `public.provision_oidc_account(uuid,email,issuer,actor)` (definer kiểm issuer bật, 22023), `INSERT user_role` (`identity-commands.ts:24-40`) | `identity.enroll` `{target userId, method:'oidc'}` + `permission.role-assign` `{permission account.assignRole, target account/uuid, detail roleKey,targetUserId}` (`:41-53`) | `Pending account enrolled…` ; không in email | `--user` UUID chuẩn và ≠ actor offline (`:15-16`), `--issuer` khác rỗng, `isRoleKeyReference` (`:19-21`), email canonical (`:22`), role phải tồn tại (`:29`); 23505 email trùng → lỗi |
| `purge-sessions` (`identity:purge-sessions`) | `--retention-days` (`^\d{1,4}$`, bắt buộc) | `PRODUCT_IDENTITY_DATABASE_URL` | identity | tối đa 200 lô × 500 (`product.ts:162-175`), SQL `A/src/authentication/services/product-identity.service.ts:151-180` | `identity.session-purge` khi xóa > 0 | `Purged N expired sessions.` | 0–3650 ở service |
| `bootstrap` (`root:bootstrap`) | `--operation --issuer --email --activation-file` | `PRODUCT_BOOTSTRAP_DATABASE_URL` | bootstrap / `bootstrap` (fence độc quyền) | `A/src/authorization/services/product-root.service.ts:73-135`: marker `security_bootstrap_state … FOR UPDATE OF s` (`:85-91`); cùng operation + cùng email + có target → no-op (`:93-95`), khác → `collision` (`:96`); `authz_state.manifest_hash` = release hash và `materialized_hash` = `protectedState.hash` nếu không `not_ready` (`:98-102`); provider bật nếu không `missing_reference` (`:28-34,103`); `INSERT app_user(... 'pending')`, 23505 → `collision` (`:106-117`); ghim enrollment 15 phút (`:37-47,118`); `UPDATE app_user SET kind='root'` (`:120`, trigger `guard_root_kind`); token `oidc-activation` 15 phút, lưu SHA-256 (`:50-57,121`); cập nhật marker (`:122-125`) | `root.bootstrap` `{target, operationId, method:'oidc'}` (`:126-132`) | `Root enrollment committed (id <uuid>); activation still required.` hoặc `Operation already committed (id <uuid>); marker and Root unchanged.` (`root-commands.ts:49-53`). **Secret**: chỉ ghi file kích hoạt; id không bí mật | `--operation` UUID chuẩn, `--issuer`/`--email` bắt buộc (`root-commands.ts:36-39`); file mở `wx` mode `0o600` **trước** transaction, ghi sau commit, xóa nếu không commit (`:17-32`) |
| `reissue-root` (`root:reissue`) | `--issuer --activation-file` | `PRODUCT_BOOTSTRAP_DATABASE_URL` | bootstrap | `product-root.service.ts:146-182`: target = Root của marker, khóa `FOR UPDATE OF b FOR NO KEY UPDATE OF u`; không pending/không root → `collision`; không email hoặc có binding → `missing_reference`; provider bật; tiêu thụ token cũ, xóa + ghim lại enrollment, token mới | `root.reissue` `{target, method:'oidc'}` | `Root activation proof reissued; earlier proofs are void.`; secret chỉ vào file | như trên; `committed: true` cố định (`root-commands.ts:66`) |
| `revoke-root` (`root:revoke`) | `--user --operation --approval --reason` | `PRODUCT_BOOTSTRAP_DATABASE_URL` | bootstrap | `A/src/authorization/services/product-root-lifecycle.service.ts:89-124`: `UPDATE app_user SET state='suspended',auth_epoch+1 WHERE id AND kind='root' AND state<>'suspended'` | `root.revoke` `{target, operationId, approval, reason}` (cột `reason`) | `Root suspended and its sessions revoked; marker unchanged.` / `No unsuspended Root…; nothing changed.` | UUID chuẩn cả hai; approval ≤200, reason ≤1000, không rỗng sau trim, không ký tự điều khiển (`:95-107`); thiếu → lỗi (`root-commands.ts:75-76`) |
| `set-root-email` (`root:set-email`) | `--user --operation --email` | `PRODUCT_BOOTSTRAP_DATABASE_URL` | bootstrap | `product-root-lifecycle.service.ts:29-75`: chỉ `kind='root' AND state='active'` (`FOR NO KEY UPDATE`), không thì `collision`; cùng email → no-op; `UPDATE … email_verified=false, auth_epoch+1`, 23505 → `collision`; `userId` ≠ actor offline | `root.set-email` `{target, operationId}` (không email) | `Root email set…` / `Root already has this email; nothing changed.`; không in email | email sai → `invalid_release` |
| `reset-mfa` (`identity:reset-mfa`) / `reset-root-mfa` (`root:reset-mfa`) | `--user --operation --approval --reason` | `PRODUCT_IDENTITY_DATABASE_URL` / `PRODUCT_BOOTSTRAP_DATABASE_URL` | identity mode `revoke` / bootstrap mode `bootstrap` (`root-commands.ts:126-128`) | `A/src/authentication/services/product-mfa.service.ts:397-445`: `SELECT kind … FOR NO KEY UPDATE`, kind phải `iam` (identity) / `root` (bootstrap), không thì `TypeError`; `DELETE mfa_recovery_code`, `DELETE mfa_totp` (trigger `mfa_epoch` tăng `auth_epoch`, `G/internal/database/migrations/1792108800001_product_baseline.sql:666`) | `identity.mfa-reset` `{target, operationId, approval, reason}` khi xóa được totp | `Second factor and recovery codes removed; …` / `No second factor; nothing changed.` | UUID chuẩn, ≠ actor offline, approval/reason như revoke |

Ghi chú quan sát:
- Guard Root ở DB: tối đa một Root, chỉ promote `pending iam → root` khi marker trỏ đúng, không root→iam (trigger `guard_root_kind`, `guard_root_activation`; test TS `product-root-guards`, `product-root-regression:105`). CLI chỉ dựa vào marker + trigger, không có kiểm tra riêng ở tầng tool.
- `reset-mfa`: `DELETE mfa_recovery_code` chạy trước, nếu không có `mfa_totp` thì trả `reset:false` nhưng transaction vẫn commit (kể cả `revision+1`), không audit. Nếu có dòng recovery code mà không có totp thì chúng bị xóa không audit. Suy đoán: không xảy ra vì recovery code chỉ tạo cùng totp; xác minh bằng `rg -n 'mfa_recovery_code' G/internal/database/migrations` (trigger `protect_mfa_recovery_code`). Port nguyên hành vi.
- Chỗ in secret: chỉ file kích hoạt (bootstrap/reissue). Email, approval, reason không in ra stdout; dòng lỗi chỉ class/reason/SQLSTATE. Id Root in ra có chủ ý.
- Nếu ghi file thất bại sau commit, TS xóa file và báo lỗi trong khi Root đã commit (`root-commands.ts:25-31`); đường cứu là `reissue-root`. Port giữ nguyên.

## 2. Nơi gọi CLI NestJS cần đổi

Quan sát (`rg 'tools/product|db:migrate|…'`):

| File:dòng | Đang gọi | Đổi sang |
|---|---|---|
| `G/test/template.go:189-193` | `typeScript(..., "provision")`, `"migrate"` khi dựng template | `hrmctl provision` (Go Provision đã gồm migrate) |
| `G/test/template.go:78-81` (`Stack.TypeScriptCLI`), `:264-279` (`cluster.typeScript`), `:281-296` (`env`), `:298-326` (`apiRoot`, `checkBuilt`, thông báo `rebuild`) | node `tools/product.ts` | helper chạy binary `hrmctl` dựng một lần (mẫu: `G/internal/offline/provision_integration_test.go:104-118`) |
| `G/test/fixture/fixture.go:189-221` (`Root`), regex `:50` | TS `bootstrap`, parse `Root enrollment committed (id …)` | `hrmctl bootstrap`; giữ đúng câu in để regex khỏi đổi |
| `G/internal/authentication/oidc_integration_test.go:40,261-277` (`pendingRoot`, `rootCreated`) và 6 lời gọi: `oidc_integration_test.go:281,302`, `identity_port_integration_test.go:405,410,419`, `oidc_refusal_integration_test.go:108,153`, `auth_http_integration_test.go:668` | TS `bootstrap`, `reissue-root` | `hrmctl` |
| `G/internal/authorization/manifest/reconcile_integration_test.go:128-139` (`TestGoSyncedFixtureSupportsLegacyTypeScriptVerificationAndRootBootstrap`) | TS `sync` để kiểm tương thích ngược | xem Q3 |
| `G/package.json` `test:integration` | `pnpm --filter @hrm/api run build && go test …` (build TS chỉ để có CLI) | bỏ bước build TS khi không còn test Go nào gọi TS |
| `G/package.json` `manifest:sync` | `node --env-file-if-exists=../api/.env.api -e spawnSync('go',['run','./cmd/hrmctl','sync'])` | giữ (đã Go) |
| `apps/web/e2e/stack.helper.ts:77` (kiểm `apps/api/dist/main.js`), `:135-139` (`cli('provision')`, `cli('migrate')`), `:211-224` (`bootstrapRoot`), `:226-238` (`enrollByEmail`) | node `tools/product.ts` với `opsEnv` (`:120-133`) | `dist/hrmctl` (đã kiểm tồn tại ở `:79`); bỏ kiểm `dist/main.js` |
| `scripts/dev.sh:46-47` (`setup`) | `pnpm run db:provision`, `pnpm run db:migrate` (→ `@hrm/api`) | xem Q1 |
| `docker/compose.yaml:20-30` (service `setup`) | `node tools/product.ts provision` trong image `hrm-local` | `go run ./cmd/hrmctl provision` (image golang như `manifest`), xem Q1 |
| `docker/root-activation.sh:16-17` | `docker compose run … setup node tools/product.ts "$@" --activation-file /out/$file` | chạy `hrmctl` trong container Go, mount `volumes/secrets:/out` |
| `docker/Dockerfile:12` | `pnpm --filter @hrm/api run build` | Task 19 (image còn dùng cho web) |
| Root `package.json:18-19,28-35` | `db:migrate`, `db:provision`, `root:*`, `identity:*` → `--filter @hrm/api` | trỏ `@hrm/api-go`; `manifest:sync` (`:27`) đã trỏ Go |
| `A/package.json:24-25,28-36` | script `tools/product.ts` | giữ tới C2 (rollback ADR-20:317) hoặc bỏ — Q2 |
| Docs | `docs/operations.md:22,35-47,92-123` (lệnh `pnpm run root:*`, `identity:*`, `db:*`, "CLI offline (`apps/api/tools/product.ts`…)"), `docs/architecture.md:75,80`, `G/AGENTS.md:3,47` ("Root còn dùng CLI TypeScript tới Task 17", "cần `apps/api/dist`"), `apps/web/AGENTS.md:68`, root `AGENTS.md:128` (Task 19 viết lại) | cập nhật cùng lát đổi |
| Tracker | `G/contract/test-port-tracker.md:12,160-162,198-206,210,229` (các dòng C1 trống; `product-root-guards`, `root-guards-stack.helper` chưa gán nhóm) | điền |

TS còn tham chiếu `tools/product.ts` trong test của chính NestJS (`A/test/cli-fixture.helper.ts:14`, `A/test/workspace.smoke-spec.ts:145`, `A/test/module-boundaries.spec.ts:132,192`): không đổi ở Task 17 (bị xóa ở C2).

## 3. `seed/`

`ls seed/`: `accounts.map.json`, `enroll-accounts.mjs`, `enroll.sh`, `import-employees.mjs`, `nhan-vien.json`, `nhan-vien.report.10.03.16.10.26.xlsx`, `xlsx-to-json.py`. Cả thư mục bị `.gitignore:25` bỏ qua (không có trong Git).

`rg -l 'tools/product|db:migrate|hrmctl' seed/` → `seed/enroll-accounts.mjs`, `seed/enroll.sh`. Đếm bằng `rg -c` (không in nội dung): `enroll.sh` 49 dòng, 48 dòng chứa `tools/product`, `enroll`, `--user`, `--email`, `--issuer`, `--role`, `node `; `enroll-accounts.mjs` 34 dòng, 1 dòng `tools/product`, 1 `identity:enroll`, 1 `.env.ops`, 1 `pnpm`. Không file nào chứa `db:migrate`/`hrmctl`/`cd `.

Suy đoán: `enroll.sh` là 48 lời gọi `node tools/product.ts enroll …` sinh từ `enroll-accounts.mjs`; email nằm trong dòng lệnh (PII). Cách sửa không đọc nội dung: thay chuỗi cố định bằng `sed -i ''` (vd `node tools/product.ts enroll` → đường dẫn `hrmctl enroll`) rồi kiểm lại bằng `rg -c`; cần biết cwd và cách nạp env (`.env.ops`) mà script giả định, nên người dùng xác nhận hoặc tự sửa (Q4).

## 4. Test TypeScript nguồn cần port

Quan sát (`A/test/`):

| File | Ca (`test(...)`) | Bất biến | Tracker |
|---|---|---|---|
| `cli-fixture.helper.ts` (98 dòng) | helper | Chạy CLI như tiến trình con với env của operator; `provision`, `migrate`, `sync`, rồi superuser thêm `oidc_provider` (`:72-77`); `run` khẳng định exit 0 | `:12` C1 trống |
| `product-cli.integration-spec.ts` | 3: `:9` provision/migrate/sync/purge; `:27` không nhận cờ subject/method/user đã bỏ (9 tổ hợp, không ghi file, không tạo `app_user`); `:77` enroll tạo pending + role, `--` đầu, revision +1, audit actor offline không email, email/role sai bị từ chối không in email | lệnh lặp idempotent; retention bắt buộc; release CLI = release API; cờ lạ fail; không in PII | `:162` C1 trống |
| `product-cli-mfa.integration-spec.ts` | 1: `:10` | `reset-mfa` chỉ IAM, `reset-root-mfa` chỉ Root, sai đích thì exit ≠ 0 và không xóa; có approval/audit, metadata không có `@` | `:160` C1 trống |
| `product-cli-root.integration-spec.ts` | 1: `:23` | file `0600`, stdout không chứa proof/email; retry cùng operation không ghi file; operation/email khác → `collision`; reissue tạo proof mới, issuer lạ → `missing_reference` không ghi file; sau kích hoạt reissue → `collision`; `set-root-email` sai không in địa chỉ; `revoke-root` cần approval+reason, lặp là no-op, session cũ chết; marker vĩnh viễn; audit `root.*` actor offline, không `@` | `:161` C1 trống |
| `product-root-bootstrap.integration-spec.ts` | 2: `:96` từ chối không để lại account/pin/token/marker; `:140` tạo một Root pending + pin + proof, guard vẫn chặn Root trực tiếp | gọi service, không qua CLI | `:199` C1 trống |
| `product-root-regression.integration-spec.ts` | 3: `:28` ghim (issuer,email) + một proof, reissue thay cả hai; `:105` promote chỉ commit khi marker trỏ đúng; `:157` chỉ login bootstrap phát activation Root | service + SQL | `:203` C1 trống |
| `product-root-guards.integration-spec.ts` | 3: `:154` promote chỉ bootstrap, đích pending không facts, không lời mời sống; `:218` một Root, không root→iam, không Root thứ hai; `:242` Root không giữ IAM fact | trigger DB | `:201` chưa gán nhóm |
| `product-root-concurrency.integration-spec.ts` | 4: `:183`, `:215` (ngoài READ COMMITTED bị từ chối), `:234`, `:243` | cuộc đua promote với fact/token | `:200` C1 trống |
| `product-root-lifecycle-guards.integration-spec.ts` | 3: `:34`, `:62`, `:88` (không login runtime gỡ suspend Root; repair offline được) | quyền từng login | `:202` C1 trống |
| `product-root-token-guards.integration-spec.ts` | 2: `:22`, `:49` | chỉ bootstrap phát activation Root | `:206` C1 trống |
| `product-root-activation.integration-spec.ts` › `:249` | 1 | proof đã dùng không chạy lại, không còn gì để reissue | `:198` C1 trống (phần còn lại đã port F3) |
| `product-sign-in-root.integration-spec.ts` › `:134` set-root-email | 1 | Root nhận email chưa xác minh, mất mọi phiên; bootstrap không làm gì khác | `:210` C1 trống |
| `product-genesis.integration-spec.ts` | 9 (`:68`…`:663`) | đã "thay bằng" ở F5 (`internal/authorization/manifest/*_integration_test.go`) | `:165` xong, không cần port thêm |
| Helper `product-root-stack.helper.ts`, `root-guards-stack.helper.ts` | helper | | `:204`, `:229` |

Go đã có một phần: `G/test/fixture/fixture_integration_test.go:305` (Root bởi lệnh, enrollment/token dọn), test DB guard có nhắc `guard_root_kind`/`security_bootstrap_state` ở `G/internal/database/product_database_integration_test.go`, `privilege_verify_integration_test.go` (Suy đoán: phủ một phần guards; xác minh bằng `rg -n 'guard_root_kind' -A3` hai file đó).

## 5. Ràng buộc import

Quan sát:
- `cmd/api` không link `internal/offline`, goose, testcontainers: `apiForbiddenDeps` (`G/test/imports_test.go:276`) chạy trong `checkClosures` (`:289-312`) trên `go list -e -json=…,Deps ./...` thật (`TestRealImportsFollowTheDAG`, `:726-747`); ca tổng hợp `TestCheckClosures` `:943`. Checkbox plan `:376` về `go list -deps` đã được enforce sẵn.
- Goose chỉ ở `cmd/hrmctl` và `internal/offline`: `TestGooseIsOnlyInTheOfflineCommand` (`:1495-1516`) quét mọi package của `go list ./...` (gồm package `hrm/api-go/test`, file không có build tag).
- Chỉ `cmd/hrmctl` import `internal/offline`: `checkEdgeRules` (`:221-223`), nhưng `edgesOf` bỏ qua package `test`/`test/...` (`:158-160,232-237`).
- `cmd/hrmctl` không được link `internal/authentication`, `httpapi`, gin, go-oidc (`authorityForbiddenDeps`, `:266-269,298`).
- DAG đã khai sẵn cạnh cho C1: `cmd/hrmctl -> audit, authentication/credential, authorization/{authority,core,declarations,grant,manifest}, config, database, modules/permission, offline` (`G/contract/package-dag.md:98`); `internal/offline -> audit, authentication/credential, authorization/core, authorization/manifest, database` (`:136`).

Suy ra:
- Không cần cạnh DAG mới nếu `offline` nhận `*core.Core`, `manifest.Release` và đã kiểm role key ở `cmd/hrmctl` (`grant.IsRoleKeyReference`). Nếu đặt kiểm role key trong `offline` thì cần thêm `internal/offline -> internal/authorization/grant`.
- Nếu `test/template.go` import `internal/offline` để gọi `Provision` trong tiến trình, `TestGooseIsOnlyInTheOfflineCommand` sẽ báo `test links goose` (Suy đoán từ `:1509`; xác minh bằng mutant tạm). Nên chạy binary `hrmctl` (dựng một lần như `provision_integration_test.go:104-110`), không cần sửa luật.
- `cmd/hrmctl` đang không link `internal/authentication` (Quan sát qua luật closure); các lệnh mới chỉ cần `credential` và `audit`.

## 6. Đề xuất chia lát

Theo ruling 101/103: chuyển tính năng trước; mỗi bất biến bảo mật có ít nhất một ca từ chối chạy thật trong lát; ma trận đầy đủ, cuộc đua, mutant là nợ ghi `test-debt.md`.

**17a: khung cờ + `purge-sessions` + `enroll` + `reset-mfa`/`reset-root-mfa`** (`cmd/hrmctl`, `internal/offline`)
- Parser cờ giống TS: cặp `--k v`, không trùng, allowlist theo lệnh, bỏ một `--` đầu, cờ lạ → `Unexpected option --k`. Viết tay khoảng 15 dòng (gói `flag` của Go nhận `-k`, `--k=v` và cho trùng, nên không dùng).
- `failureLine` thêm `*manifest.Rejection` reason và lỗi input tên hằng (không in giá trị).
- `purge-sessions`: nối `offline.PurgeExpiredSessions`, vòng ≤200 lô × 500, in `Purged N expired sessions.`; chỉ mở pool identity.
- `enroll` (authority/`ModeAdmin`), `reset-mfa` (identity/`ModeRevoke`), `reset-root-mfa` (bootstrap/`ModeBootstrap`): mỗi lệnh chỉ mở pool của login đó (`database.OpenPools` với một purpose).
- Check: build, vet, vet integration, lint, unit race `cmd/hrmctl`/`offline`, `./test` (luật import), integration `./cmd/hrmctl ./internal/offline`. Ca từ chối tối thiểu: cờ lạ; `reset-mfa` trên Root và `reset-root-mfa` trên IAM bị từ chối, không xóa; enroll role vắng; audit actor = `audit.OfflineActor`, metadata không có `@`.

**17b: Root (`bootstrap`, `reissue-root`, `revoke-root`, `set-root-email`)** (`internal/offline/root*.go`, `cmd/hrmctl`)
- File kích hoạt: `os.OpenFile(path, O_WRONLY|O_CREATE|O_EXCL, 0o600)` trước transaction; ghi sau commit; xóa khi không commit. Stdout giữ đúng câu TS (`Root enrollment committed (id …)` để regex fixture/oidc khỏi đổi).
- Bootstrap so `Release.Hash()` và `ProtectedStateHash` dưới fence (release dựng ở `cmd/hrmctl` từ `declarations`, như `sync.go:31-38`).
- Check như 17a + integration. Ca từ chối: operation/email khác → `collision` không ghi file; file đã tồn tại → từ chối trước khi ghi DB; manifest lệch → `not_ready`; issuer lạ → `missing_reference`; Root thứ hai (marker) → `collision`; revoke thiếu approval; set-email trên IAM → `collision`; mode file `0600`; stdout/stderr không chứa proof/email.

**17c: đổi hạ tầng test Go sang `hrmctl`** (`G/test/template.go`, `G/test/fixture/fixture.go`, `pendingRoot` trong `internal/authentication`, `reconcile_integration_test.go:128`, `G/package.json`)
- Template: `hrmctl provision` (đã gồm migrate) thay TS; bỏ `apiRoot`/`checkBuilt`; `Stack.TypeScriptCLI` → `Stack.Hrmctl`; bỏ `pnpm --filter @hrm/api run build` khỏi `test:integration` nếu không còn ai gọi TS (tùy Q3).
- Check: integration `./test/...`, `./internal/authentication`, `./internal/authorization/manifest`, `./cmd/...`, `./internal/offline`; full integration Go nếu đủ thời gian (lỗi môi trường báo riêng).
- Phụ thuộc 17b.

**17d: stack web/dev/docker/scripts/seed/docs** (`apps/web/e2e/stack.helper.ts`, root `package.json`, `G/package.json` script ops, `scripts/dev.sh`, `docker/compose.yaml`, `docker/root-activation.sh`, `seed/*` theo Q4, docs §2, tracker)
- Script ops ở `G/package.json` theo mẫu `manifest:sync` nhưng đọc `../api/.env.ops` và chuyển tiếp argv (`process.argv.slice(1)`) cho `root:*`/`identity:*`/`db:*`.
- Check: `pnpm --filter @hrm/web run test:browser` (e2e dựng DB và Root bằng `hrmctl`), `bash -n scripts/dev.sh docker/root-activation.sh`, `docker compose -f docker/compose.yaml config -q`, Prettier phạm vi, `git diff --check`.
- Phụ thuộc 17a, 17b. Có thể chạy song song 17c.

**17e (nợ, sau cùng theo ruling 101):** port đầy đủ `product-cli*`, `product-root-{bootstrap,regression,guards,concurrency,lifecycle-guards,token-guards}`, `activation:249`, `sign-in-root:134` vào `cmd/hrmctl/*_integration_test.go`/`internal/offline/*_integration_test.go`; mutant; điền tracker.

Thứ tự: 17a → 17b → (17c ∥ 17d) → 17e (nợ).

### Rủi ro

- Quan sát: Go `sync` từ chối env có URL ops (`runtime_database.go:5-9`), còn TS `sync` đọc `.env.ops`. Plan ghi "cùng env `.env.ops`" cho mọi lệnh; với `sync` không giữ được, hiện đã dùng `.env.api` (`G/package.json` `manifest:sync`, `docs/operations.md:88`). Các lệnh mới nên đọc đúng một URL như TS để `.env.ops` hiện có dùng được.
- Quan sát: `hrmctl` từ chối `NODE_ENV` lạ (`main.go:98-105`); TS không kiểm. `.env.ops` có `NODE_ENV` khác ba giá trị kia sẽ làm lệnh fail. Suy đoán: không xảy ra; người dùng kiểm `.env.ops` local (điều phối viên không đọc).
- Quan sát: DB dev và volume docker do TypeORM dựng (bảng `migrations`, không có `goose_db_version`); goose sẽ áp lại baseline và fail vì `CREATE TABLE` trùng (`docs/operations.md:44` mô tả fail closed). Đổi `setup` của `dev.sh`/compose sang `hrmctl` trước Q5 sẽ làm hỏng `setup` trên DB dev hiện có. Hai bộ migration đang khớp 8 phiên bản (`G/internal/database/migrations/` và các `*.migration.ts`).
- Thông điệp lỗi đổi dạng (`(ReleaseRejectedError collision)` → token reason); script/runbook nào grep chuỗi cũ sẽ lệch. Suy đoán: chỉ test TS dùng; xác minh `rg 'ReleaseRejectedError' --glob '!apps/api/**'`.
- Chạy song song hai CLI trên cùng thao tác bị ADR-20:317 cấm; khi `A/package.json` còn script TS và root script trỏ Go, operator có thể gọi nhầm. Giảm bằng cách root script chỉ trỏ Go.
- `pendingRoot`/`fixture.Root` phụ thuộc đúng câu stdout; đổi câu sẽ làm đỏ hàng loạt test.

### Câu hỏi cần chốt

- **Q1 (DB dev):** Task 17 có đổi `setup` của `scripts/dev.sh` và service `setup` của `docker/compose.yaml` sang `hrmctl provision/migrate` không? (a) Đổi ngay, xóa dựng lại DB dev/volume docker (kéo Q5 lên sớm, mất Root/dữ liệu HR dev); (b) giữ `provision/migrate` TS cho DB dev tới Task 19, chỉ đổi lệnh Root/identity, e2e và template test (DB mới) sang `hrmctl`. Đề xuất (b): migration hai bên đang trùng, Q5 đã định ở C2.
- **Q2:** Giữ script `tools/product.ts` trong `A/package.json` tới C2 (đường quay lui ADR-20) hay bỏ ngay ở 17d? Đề xuất giữ, nhưng root `package.json` chỉ trỏ Go.
- **Q3:** `TestGoSyncedFixtureSupportsLegacyTypeScriptVerificationAndRootBootstrap` (`reconcile_integration_test.go:128`) kiểm TS `sync` đọc được DB do Go sync, phục vụ quay lui. Giữ nó thì `test:integration` của Go vẫn cần build `apps/api` tới C2; bỏ thì hết phụ thuộc. Đề xuất: đổi phần Root sang `hrmctl`, bỏ phần TS `sync` (rollback sau C1 chỉ còn ở mức route, đã có test chéo runtime ở các nhóm).
- **Q4 (`seed/`):** Cho phép sửa `seed/enroll.sh`, `seed/enroll-accounts.mjs` bằng thay chuỗi mù (`sed`) không đọc nội dung, hay người dùng tự sửa? Cần biết script chạy từ cwd nào và nạp `.env.ops` thế nào (không đọc được mà không mở file).
