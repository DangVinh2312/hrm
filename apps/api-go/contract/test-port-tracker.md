# Theo dõi port test TypeScript

Một dòng cho mỗi file trong `apps/api/test` lúc NestJS bị đóng băng (ADR-22), hoặc mỗi test khi file chỉ port một phần (phần còn lại là dòng riêng, trạng thái trống); danh sách viết tay, không còn sinh lại. Trạng thái: `port`, `thay bằng`, `bỏ`. C2 chặn nếu còn dòng trống.

| File | Nhóm | Trạng thái | Đích Go | Lý do |
| --- | --- | --- | --- | --- |
| `account-boundary.spec.ts` | M8 | | | |
| `account-identity-operation.spec.ts` | M8 | | | |
| `account-role.spec.ts` | M8 | | | |
| `app-http.helper.ts` | | | | |
| `authorization-keys.spec.ts` | F5 | port | `internal/authorization/keys/keys_test.go`, `internal/authorization/declarations/product_test.go` | Declarations dùng hằng có kiểu; nội dung ghim bằng release reference. ReportActions ghim thứ tự và trả bản sao |
| `cli-fixture.helper.ts` | C1 | | | |
| `collation.integration-spec.ts` | F4 | port | `internal/authorization/gateway/collation_integration_test.go` | |
| `compiler.integration-spec.ts` | F4 | port | `internal/authorization/gateway/compiler_integration_test.go` | Bỏ `compileNamed` và `queryBuilder` của TypeORM (plan dòng 234); PostgreSQL kiểm `CompilePlanAt` với alias `s`, tham số từ `$3`, `List` sort hai chiều và tie-breaker theo key, `Detail` khóa UUID/string |
| `core/decision.spec.ts` | F4 | port | `internal/authorization/core/decision_test.go`, `internal/authorization/core/zero_value_test.go` | `Object.isFrozen` thay bằng test sửa bản sao; số JS trong fact thay bằng boolean và zero value, vì Go không có `unknown` |
| `core/fixtures.ts` | F4 | port | `internal/authorization/core/fixtures_test.go` | |
| `core/key-codec.spec.ts` | F4 | port | `internal/authorization/core/key_codec_test.go`, `internal/authorization/values/value_codecs_test.go` | `ParseKey` nhận `string`: số JS, `bigint`, `null` không biên dịch được. `compareText`, `keyEquals`, `utf8ByteLength` thay bằng `string` so byte, `Key` so bằng `==`, `len` |
| `core/permission-boundary.spec.ts` | F4 | port | `internal/authorization/core/permission_boundary_test.go` | |
| `core/permission-policy.spec.ts` | F4 | port | `internal/authorization/core/permission_policy_test.go` | Hàm JS làm biểu thức không biên dịch được; node `sql`, `not` thay bằng kiểu ngoài tập đóng ở `relations_test.go` |
| `core/relations.spec.ts` | F4 | port | `internal/authorization/core/relations_test.go` | |
| `core/runtime.spec.ts` | F4 | port | `internal/authorization/core/runtime_test.go` | Không có free function vì Go chỉ có method của `Core`; codec thiếu method không biên dịch được. `throw` của codec thay bằng `panic`, `error` và giá trị ngoài contract |
| `core/unrestricted.spec.ts` | F4 | port | `internal/authorization/core/unrestricted_test.go` | |
| `core/user-decision.spec.ts` | F4 | port | `internal/authorization/core/user_decision_test.go` | |
| `enforcement/product-authorization.spec.ts` | F2 | thay bằng | `internal/authorization/enforcement/classification_test.go`, `internal/httpapi/engine_test.go`, `internal/httpapi/inventory_test.go`, `internal/app/app_test.go` | Go không có decorator: route không lớp không đăng ký được, guard chạy trước handler, inventory lệch thì không listen. Lớp `authorize` chưa đăng ký được, thêm test khi có `authority` |
| `enforcement/product-authorization.spec.ts` › lớp `authorize` | F6 | | | Cần authority engine; không thuộc brief F5 Task 8a |
| `explicit-columns.spec.ts` | F0 | | | |
| `file-size-limit.spec.ts` | F0 | | | |
| `fixtures/resources.ts` | F4 | port | `internal/authorization/gateway/resources_fixture_test.go`, `internal/authorization/gateway/resources_seed_test.go` | Chỉ `compiler.integration-spec.ts` và `collation.integration-spec.ts` dùng; port cùng hai file đó |
| `go-contract.spec.ts` | F0 | bỏ | | Exporter bị bỏ ở ADR-22; contract do Go sở hữu |
| `grant-set.spec.ts` | M8 | | | |
| `helper-sync.spec.ts` | F0 | | | |
| `hrm-admin-precheck.integration-spec.ts` | F6 | | | |
| `hrm-approval.integration-spec.ts` | M5 | | | |
| `hrm-approval.spec.ts` | M5 | | | |
| `hrm-attendance-adjust.integration-spec.ts` | M6 | | | |
| `hrm-attendance-concurrency.integration-spec.ts` | M6 | | | |
| `hrm-attendance-effects-equivalence.integration-spec.ts` | M3 | | | |
| `hrm-attendance-effects-oracle.helper.ts` | M3 | | | |
| `hrm-attendance.helper.ts` | M6 | | | |
| `hrm-attendance.integration-spec.ts` | M6 | | | |
| `hrm-attendance.spec.ts` | M3 | | | |
| `hrm-authorization-facts.integration-spec.ts` | F6 | | | |
| `hrm-authorization-fixture-commands.helper.ts` | F6 | | | |
| `hrm-authorization-matrix.integration-spec.ts` | M2 | | | |
| `hrm-authorization-probes.integration-spec.ts` › privilege/protection/schema probes | F5 | port | `internal/modules/permission/protection_integration_test.go`, `internal/database/privilege_verify_integration_test.go` | Owner ACL, rewritten view, missing constraint/disabled trigger và anchors trên PostgreSQL thật |
| `hrm-authorization-probes.integration-spec.ts` › list/detail/count share scope | F6 | | | Cần authority engine |
| `hrm-authorization-root-audit.integration-spec.ts` | F6 | | | |
| `hrm-authorization-stack.helper.ts` | F6 | | | |
| `hrm-authorization-workflow.integration-spec.ts` | F6 | | | |
| `hrm-cancel-concurrency.integration-spec.ts` | M5 | | | |
| `hrm-cancel.integration-spec.ts` | M5 | | | |
| `hrm-coo-submit.integration-spec.ts` | M5 | | | |
| `hrm-employee.integration-spec.ts` | M2 | | | |
| `hrm-excel.spec.ts` | M7 | | | |
| `hrm-http-measure.integration-spec.ts` | | | | |
| `hrm-input.spec.ts` | | | | |
| `hrm-leave-adjust.integration-spec.ts` | M5 | | | |
| `hrm-leave-concurrency.integration-spec.ts` | M5 | | | |
| `hrm-leave.integration-spec.ts` | M5 | | | |
| `hrm-leave.spec.ts` | M3 | | | |
| `hrm-menu-account.integration-spec.ts` | M2 | | | |
| `hrm-menu-role.integration-spec.ts` | M2 | | | |
| `hrm-menu-setting.integration-spec.ts` | M2 | | | |
| `hrm-period-concurrency.integration-spec.ts` | M6 | | | |
| `hrm-permits-many-measure.integration-spec.ts` | F6 | | | |
| `hrm-permits-many.integration-spec.ts` | F6 | | | |
| `hrm-report-export-http.integration-spec.ts` | M7 | | | |
| `hrm-report-export-measure.integration-spec.ts` | M7 | | | |
| `hrm-report-http.helper.ts` | M7 | | | |
| `hrm-report.integration-spec.ts` | M7 | | | |
| `hrm-report.spec.ts` | M7 | | | |
| `hrm-request.integration-spec.ts` | M5 | | | |
| `hrm-request.spec.ts` | M5 | | | |
| `hrm-role-matrix.integration-spec.ts` | M8 | | | |
| `hrm-role-runtime-assumptions.integration-spec.ts` | M8 | | | |
| `hrm-role-truncation.integration-spec.ts` | M8 | | | |
| `hrm-role-write.integration-spec.ts` | M8 | | | |
| `hrm-setting-behavior.integration-spec.ts` | M1 | | | |
| `hrm-setting.integration-spec.ts` | M1 | | | |
| `hrm-setting.spec.ts` | M1 | | | |
| `hrm-stack.helper.ts` | | | | |
| `hrm-team.integration-spec.ts` | M1 | | | |
| `hrm-work-calendar.integration-spec.ts` | M4 | | | |
| `hrm-work-schedule-upgrade.integration-spec.ts` | M4 | | | |
| `hrm-work-schedule.integration-spec.ts` | M4 | | | |
| `hrm-work-schedule.spec.ts` | M4 | | | |
| `hrm-working-time.spec.ts` | M3 | | | |
| `http-startup.helper.ts` | F2 | bỏ | | Chờ process Node khởi động; test Go boot trong process (`internal/app`) |
| `http-startup.spec.ts` | F2 | bỏ | | Chỉ kiểm `http-startup.helper.ts` |
| `module-boundaries.spec.ts` | F0 | | | |
| `module-template.helper.ts` | F1 | thay bằng | `test/template.go` | Template dựng bằng CLI TypeScript (`provision`, `migrate`, `sync`) cộng provider fixture; mỗi binary test một container, `CREATE DATABASE … TEMPLATE`. Task 8 đổi `sync`, Task 17 đổi `provision` |
| `oidc-discovery.helper.ts` | F3 | thay bằng | `internal/authentication/idp_test.go`, `internal/app/auth_routes_test.go` | Issuer HTTPS cục bộ cho discovery; test boot có `discoveryServer` riêng |
| `oidc-fixture.helper.ts` | F3 | thay bằng | `test/fixture/fixture.go` | `fixtureProvider` nằm ở template; `bindAccount`, `oidcSession`, `bootstrapActiveRoot` thành `Account`, `Session`, `Root`. Chưa có `activateAccount` (tài khoản mời), thêm khi test F3 cần |
| `oidc-idp.helper.ts` | F3 | thay bằng | `internal/authentication/idp_test.go` | IdP cục bộ qua TLS: discovery, một khóa RS256, token endpoint kiểm code một lần, PKCE, client, redirect URI |
| `postgres-shared.helper.ts` | F1 | thay bằng | `test/template.go` | Go chạy mỗi package một process, không có runner chia container qua `HRM_TEST_PG`: mỗi binary test một container và một template |
| `postgres-shared.spec.ts` | F1 | bỏ | | Kiểm `parseSharedEnv`, `quoteIdentifier`, `treeDigest`, không có ở Go; tên database Go chỉ sinh từ hex |
| `product-account-boundary.integration-spec.ts` | M8 | | | |
| `product-account-grant-scope.integration-spec.ts` | M8 | | | |
| `product-account-provisioning.integration-spec.ts` | M8 | | | |
| `product-account-reactivate.integration-spec.ts` | M8 | | | |
| `product-account-role-required-upgrade.integration-spec.ts` | M8 | | | Một phần ở `internal/offline/provision_integration_test.go`: kiểm `user_role`, `audit_outbox`, revision sau migration, chưa qua manifest sync và Root thật. Phần còn lại ở M8 |
| `product-account-role.integration-spec.ts` | M8 | | | |
| `product-ascii-email-upgrade.integration-spec.ts` | M8 | | | |
| `product-audit-permission.integration-spec.ts` › typed writer/detail allowlist | F5 | port | `internal/audit/full_event_test.go`, `internal/audit/full_event_integration_test.go` | Detail đóng bằng struct; kiểm kind/detail, metadata số thành string, Root marker, không PII, rollback |
| `product-audit-permission.integration-spec.ts` › command context and Root mutation | F6 | | | Cần CommandContext/authority |
| `product-audit.integration-spec.ts` › writer revisions/targets/metadata | F5 | port | `internal/audit/audit_integration_test.go`, `internal/audit/full_event_integration_test.go`, `internal/authorization/manifest/reconcile_integration_test.go` | Identity/admin/bootstrap/sync revisions; access không resultingRevision; string key không vào metadata; audit failure rollback |
| `product-audit.integration-spec.ts` › access loop/obligation handlers/authorized update | F6 | | | Cần authority và obligations |
| `product-authorization.integration-spec.ts` | F6 | | | |
| `product-cli-mfa.integration-spec.ts` | C1 | | | |
| `product-cli-root.integration-spec.ts` | C1 | | | |
| `product-cli.integration-spec.ts` | C1 | | | |
| `product-database.integration-spec.ts` | F1 | port | `internal/database/{runner,privilege_verify,product_database}_integration_test.go` | Giữ cả ca âm; schema đủ 8 migration nên probe thêm `applicationPrivileges` từ contract |
| `product-fence-io.integration-spec.ts` | F6 | | | |
| `product-genesis.integration-spec.ts` | F5 | thay bằng | `internal/authorization/manifest/{reconcile,grant,fence}_integration_test.go` | Go-owned source 6 được sync từ catalog rỗng; nonempty genesis bị từ chối; generic upgrades 7/8/9 kiểm default chỉ cho permission mới, omission không revoke, removal tường minh, runtime facts giữ nguyên. Không dựng lại từng snapshot TypeScript 1..5 (ADR-22) |
| `product-http.spec.ts` | F2 | port | `internal/httpapi/security_test.go`, `internal/httpapi/client_ip_test.go`, `internal/httpapi/errors_test.go`, `internal/apperror/api_error_test.go` | CSRF, cookie, hop, lỗi và key đã có test Go. Còn lại phải port cùng code: `runtime metrics` (M8), `limiter groups an IPv6 /64` (F3) |
| `product-http.spec.ts` › `runtime metrics` | M8 | | | |
| `product-http.spec.ts` › `limiter groups an IPv6 /64` | F3 | port | `internal/authentication/credential/credential_test.go` (`TestRateLimitClient`) | Vector từ hàm TS thật |
| `product-identity-limiter.integration-spec.ts` | F3 | port | `internal/authentication/rate_limit_integration_test.go`, `identity_port_integration_test.go`, `auth_http_integration_test.go` | Ca NAT 20 lần `begin` chạy qua route thật |
| `product-identity-oidc.integration-spec.ts` | F3 | port | `internal/authentication/oidc_integration_test.go`, `oidc_provider_test.go`, `oidc_claims_helper_test.go`, `identity_port_integration_test.go` | Hook `setTokenGate` thay bằng `idp.route("/token", …)` |
| `product-identity-operation-concurrency.integration-spec.ts` | M8 | | | |
| `product-identity-operation-faults.integration-spec.ts` | M8 | | | |
| `product-identity-operation-mfa.integration-spec.ts` | M8 | | | |
| `product-identity-operation-oidc.integration-spec.ts` | M8 | | | |
| `product-identity-operation.integration-spec.ts` | M8 | | | |
| `product-identity-operations-upgrade.integration-spec.ts` | M8 | | | |
| `product-identity-operations.integration-spec.ts` | M8 | | | |
| `product-identity-sessions.integration-spec.ts` | F3, C1 | port | `internal/authentication/session_integration_test.go`, `identity_port_integration_test.go`, `internal/offline/session_purge_integration_test.go` | Test fixture `OIDC fixture validates a signed token` thay bằng `oidc_provider_test.go`; lệnh `hrmctl` của purge vẫn thuộc C1 |
| `product-identity-stack.helper.ts` | F3 | thay bằng | `test/fixture/fixture.go`, `internal/authentication/session_integration_test.go` | |
| `product-identity.spec.ts` | F3 | port | `internal/authentication/credential/credential_test.go`, `oidc_provider_test.go` (`TestProviderSettingsAreCheckedBeforeDiscovery`) | |
| `product-load.integration-spec.ts` | F6 | | | |
| `product-mfa-flow.integration-spec.ts` | F3 | port | `internal/authentication/mfa_integration_test.go`, `identity_port_integration_test.go`, `auth_http_integration_test.go` | |
| `product-mfa-guards.integration-spec.ts` | F3 | port | `internal/authentication/identity_schema_integration_test.go` | Probe drift gọi `database.VerifyPrivileges`; thân hàm khôi phục bằng `pg_get_functiondef` |
| `product-mfa-http.integration-spec.ts` | F3 | port | `internal/authentication/auth_http_integration_test.go`, `auth_routes_test.go` | Mức handler, `httptest.NewRecorder`, PostgreSQL thật |
| `product-mfa-keys-reset.integration-spec.ts` | F3 | port | `internal/authentication/identity_port_integration_test.go`, `mfa_integration_test.go`, `internal/app/auth_routes_integration_test.go` | Mọi test trừ `offline reset` |
| `product-mfa-keys-reset.integration-spec.ts` › `offline reset: identity resets IAM only, bootstrap resets Root only` | C1 | | | |
| `product-mfa-stack.helper.ts` | F3 | thay bằng | `internal/authentication/mfa_integration_test.go` (`enrolled`, `stepNow`, `fresh`) | |
| `product-mfa.spec.ts` | F3 | port | `internal/authentication/credential/credential_test.go`, `credential/internal_test.go`, `internal/config/config_test.go` | Vector từ hàm TS thật |
| `product-oidc-rebinding.integration-spec.ts` | F3 | port | `internal/authentication/identity_port_integration_test.go`, `oidc_refusal_integration_test.go` | |
| `product-outbox.integration-spec.ts` | F6 | port | `internal/audit/outbox*_integration_test.go`, `internal/database/outbox_mode_integration_test.go` | Lease/token ownership, SKIP LOCKED, hai worker, crash/retry/backoff/park/poison, cancellation, exact ACL và delivery ngoài transaction. Park theo batch hữu hạn, backlog tiến triển qua nhiều lượt; worker/sink thật chưa wire |
| `product-rebac-type.integration-spec.ts` | F4 | port | `internal/authorization/gateway/product_rebac_type_integration_test.go` | |
| `product-request-auth-http.integration-spec.ts` | F3 | port | `internal/authentication/auth_routes_test.go`, `auth_http_integration_test.go`, `internal/app/auth_routes_integration_test.go` | Route xác thực; đếm transaction bằng `RunnerOptions.OnMetric`. Route `hr/*`, `auth/me`, lệnh admin ở dòng dưới |
| `product-request-auth-http.integration-spec.ts` › route `hr/employees`, `auth/me` | M2 | | | |
| `product-request-auth-http.integration-spec.ts` › `an admin command of a dead well-formed session` | M8 | | | |
| `product-request-text-http.integration-spec.ts` | F2, M1, M8 | | | |
| `product-root-access.integration-spec.ts` | F6 | | | |
| `product-root-activation.integration-spec.ts` | F3 | port | `internal/authentication/oidc_integration_test.go`, `oidc_refusal_integration_test.go`, `identity_port_integration_test.go`, `auth_http_integration_test.go` | Bootstrap, reissue vẫn qua CLI TypeScript (`pendingRoot`); Go ở C1 |
| `product-root-activation.integration-spec.ts` › `nothing is left to reissue` | C1 | | | |
| `product-root-bootstrap.integration-spec.ts` | C1 | | | |
| `product-root-concurrency.integration-spec.ts` | C1 | | | |
| `product-root-guards.integration-spec.ts` | | | | |
| `product-root-lifecycle-guards.integration-spec.ts` | C1 | | | |
| `product-root-regression.integration-spec.ts` | C1 | | | |
| `product-root-stack.helper.ts` | C1 | | | |
| `product-root-suspend.integration-spec.ts` | M8 | | | |
| `product-root-token-guards.integration-spec.ts` | C1 | | | |
| `product-sign-in-fixtures.helper.ts` | F3 | thay bằng | `internal/authentication/idp_test.go`, `oidc_integration_test.go`, `oidc_refusal_integration_test.go` | |
| `product-sign-in-http.integration-spec.ts` | F3 | port | `internal/authentication/auth_http_integration_test.go`, `auth_routes_test.go` | `GET /api/auth/session` sau đăng nhập đổi thành `GET /api/auth/account`, vì `session` ở M2 |
| `product-sign-in-root.integration-spec.ts` | F3 | port | `internal/authentication/oidc_integration_test.go`, `oidc_refusal_integration_test.go`, `auth_http_integration_test.go` | Mọi test trừ `set-root-email` |
| `product-sign-in-root.integration-spec.ts` › `set-root-email` | C1 | | | |
| `product-sign-in-schema.integration-spec.ts` | F3 | port | `internal/authentication/identity_schema_integration_test.go` | Probe drift gọi `database.VerifyPrivileges` |
| `product-sign-in-stack.helper.ts` | F3 | thay bằng | `test/template.go`, `internal/authentication/oidc_integration_test.go` (`newOidcStack`) | |
| `product-sql-regression.spec.ts` | F4 | port | `internal/authorization/compiler/product_sql_regression_test.go`, `internal/authorization/gateway/gateway_test.go` | |
| `product-sql.spec.ts` | F4 | port | `internal/authorization/compiler/product_sql_test.go`, `internal/authorization/gateway/gateway_test.go` | |
| `product-system-regression.integration-spec.ts` | F5 | port | `internal/authorization/manifest/fence_integration_test.go` | Grant bị đổi ID hoặc bị bỏ khỏi release mới vẫn là drift, không được nhận làm baseline |
| `product-system.integration-spec.ts` › sync/no-op/concurrency/runtime ownership/grant removal | F5 | port | `internal/authorization/manifest/{reconcile,grant,fence}_integration_test.go` | PostgreSQL thật, hai runner publish đúng một lần, runtime boundary collision fail closed, audit rollback |
| `product-system.integration-spec.ts` › Root bootstrap/reissue/revoke lifecycle and input validation | C1 | | | Fixture đã chạy CLI TypeScript Root thật; Go offline Root thuộc Task 17 |
| `product-transaction-runner.spec.ts` | F1 | port | `internal/database/pool_test.go`, `internal/database/runner_integration_test.go` | Mất kết nối thật thay cho pool giả: cổng đóng, `pg_terminate_backend` |
| `product-values.integration-spec.ts` | F4 | port | `internal/authorization/gateway/values_integration_test.go` | Parity PostgreSQL và codec (`int64`, `numeric`, `uuid`, `boolean`, `timestamp`), `gateway.Detail` key `'01'`, parity microsecond với `gateway.List`, custom `Core` codecs, từ chối malformed timestamp trước khi chạm SQL. Phần `manifest` và `authority` ở dòng dưới |
| `product-values.integration-spec.ts` › `manifest sync` | F5 | port | `internal/authorization/manifest/prepare_test.go` | Timestamp literal bị PostgreSQL coerce vẫn bị Prepare từ chối trước DB; dùng codecs của core đã prepare release |
| `product-values.integration-spec.ts` › `authority.update`, `authority.list` | F6 | | | |
| `product.e2e-spec.ts` | | | | |
| `role-catalog.spec.ts` | M8 | | | |
| `role-controller.spec.ts` | M8 | | | |
| `role-grant.spec.ts` | M8 | | | |
| `role-risk.spec.ts` | M8 | | | |
| `role-runtime-constraint.integration-spec.ts` | M8 | | | |
| `role-validator.spec.ts` | M8 | | | |
| `root-guards-stack.helper.ts` | | | | |
| `route-inventory.helper.ts` | F0 | | | |
| `setting-controller.spec.ts` | M1 | | | |
| `setup-postgres.ts` | F1 | thay bằng | `test/postgres.go` | Container, superuser, password ngẫu nhiên. Cluster dùng chung và template ở plan Task 3 |
| `single-app.spec.ts` | F0 | | | |
| `structure.spec.ts` | F2 | port | `internal/httpapi/inventory_test.go`, `internal/httpapi/auth_controller_test.go`, `internal/openapi/openapi_test.go`, `internal/app/app_test.go`, `test/imports_test.go` | Inventory, OpenAPI, cookie/CSRF, boot lỗi không listen đã có test Go; pin hash OpenAPI bỏ theo ADR-22 §3; `raw runtime` thay bằng `checkHandlerTypes`. Còn lại phải port cùng code: `composed release and storage bindings` (F5) |
| `structure.spec.ts` › `the composed release and storage bindings are unchanged` | F5 | port | `internal/authorization/declarations/product_test.go` | Nội dung bằng reference, hash Go ghim, không runtime JSON loading; bridge readiness ghim theo Prepare |
| `system-regression.helper.ts` | F5 | thay bằng | `test/template.go`, `test/fixture/fixture.go` | Go sync và fixture typed; provision/migrate/bootstrap TypeScript còn dùng tới Task 17 |
| `system-release.spec.ts` › source validation/hash/core provenance | F5 | port | `internal/authorization/manifest/prepare_test.go`, `internal/authorization/declarations/product_test.go` | Prefix system/custom, UTF-8, grants/removals, bounds, core mismatch/missing capability trước I/O; constructor clone capabilities |
| `system-release.spec.ts` › every registered admin command has fresh policy | F6 | | | Cần registry command Go; source hiện tại đã ghim nội dung policy |
| `test-runner.spec.ts` | F0 | | | |
| `time-source.spec.ts` | F0 | | | |
| `values/value-codecs.spec.ts` | F4 | port | `internal/authorization/values/value_codecs_test.go` | Test locale Day.js và test đóng băng bỏ: codec Go không dùng Day.js, không có state. Đối chứng codec dễ dãi giữ, là `lenientTimestamp` |
| `workspace.smoke-spec.ts` | F0 | | | Phần `loadConfig` đã port ở `internal/config/config_test.go`; ranh giới import của core ở `test/imports_test.go` và `depguard`; phần boot API chưa |
