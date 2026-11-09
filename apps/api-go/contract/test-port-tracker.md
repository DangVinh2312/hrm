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
| `hrm-admin-precheck.integration-spec.ts` › :121/:132/:161/:216, nền authority và employee.linkAccount/team.assign | F6, M1, M2 | port | `internal/authorization/authority/authority_admin_integration_test.go`, `internal/app/m1_matrix_integration_test.go`, `m2_matrix_integration_test.go`, `m2_behavior_integration_test.go` | Shared precheck/exclusive recheck ở authority; ô permission/boundary/deny/fresh/foreign/absent kiểm state/revision không đổi, bound link tiến một revision |
| `hrm-admin-precheck.integration-spec.ts` › :121/:132/:161/:216, role/account administration commands | M8 | | | CROSS: port lại từng command thật khi role/administration chuyển; không đánh dấu module chưa chuyển đã được kiểm |
| `hrm-approval.integration-spec.ts` | M5 | | | |
| `hrm-approval.spec.ts` | M5 | | | |
| `hrm-attendance-adjust.integration-spec.ts` | M6 | | | |
| `hrm-attendance-concurrency.integration-spec.ts` | M6 | | | |
| `hrm-attendance-effects-equivalence.integration-spec.ts` › :161/:189/:215, reader set-based và `loadAttendanceFacts` | M3 | port | `internal/modules/attendancecore/attendance_facts_integration_test.go` | Cùng dataset trộn trạng thái, tháng, điều chỉnh, frame, lịch, tuyển/nghỉ, tháng đóng, cộng 300 nhân viên để vượt ngưỡng set-based; so `nil`, rỗng, danh sách nhỏ (per-row), ≥300 id (set-based) với oracle, và cửa sổ nhiều tháng so text từng nhóm |
| `hrm-attendance-effects-equivalence.integration-spec.ts` › :235, sheet bằng totals của facts oracle | M6 | | | Cần query sheet của module `attendance` |
| `hrm-attendance-effects-equivalence.integration-spec.ts` › :310/:333/:388, report, XLSX, close/snapshot, quy mô hàng nghìn | M6, M7 | | | Cần report, close và export |
| `hrm-attendance-effects-oracle.helper.ts` › `oracleLoadAttendanceFacts`, `oracleApprovedEffectsSql`, `oracleAdjustmentMinutesSql` | M3 | port | `internal/modules/attendancecore/attendance_facts_integration_test.go` | Giữ nguyên văn câu lệnh correlated; fragment lịch/khung giờ dùng helper thật như bản TypeScript |
| `hrm-attendance-effects-oracle.helper.ts` › `oracleLoadSheetRows`, `oracleAttendanceReport`, `oracleAuthorization` | M7 | | | Cần report |
| `hrm-attendance.helper.ts` | M6 | | | |
| `hrm-attendance.integration-spec.ts` | M6 | | | |
| `hrm-attendance.spec.ts` › :59–:227, :267, :292, phép tính bảng công | M3 | port | `internal/modules/attendancecore/attendance_calculation_helper_test.go` | |
| `hrm-attendance.spec.ts` › :235/:308/:354, parser tháng/query/reopen/điều chỉnh | M6 | | | Parser thuộc route `attendance` |
| `hrm-authorization-facts.integration-spec.ts` | F6 | | | |
| `hrm-authorization-fixture-commands.helper.ts` | F6 | | | |
| `hrm-authorization-matrix.integration-spec.ts` › :118/:180/:233/:321/:366, employee/team | M1, M2 | port | `internal/app/m1_matrix_integration_test.go`, `m2_matrix_integration_test.go`, `m2_behavior_integration_test.go`, `internal/modules/employee/employee_command_integration_test.go` | Permission/boundary/deny/fresh, scope, audit rollback cả data/authority, link và revision; generic shared/exclusive race ở authority_admin_integration_test.go |
| `hrm-authorization-matrix.integration-spec.ts` › :292, bootstrap sau revoke role cùng session | M2 | thay bằng | `internal/app/m2_behavior_integration_test.go`, `internal/modules/employee/employee_menu_integration_test.go` | Grant/revoke trực tiếp cùng session kiểm menu không cache; thao tác role admin qua HTTP thuộc M8 |
| `hrm-authorization-probes.integration-spec.ts` › privilege/protection/schema probes | F5 | port | `internal/modules/permission/protection_integration_test.go`, `internal/database/privilege_verify_integration_test.go` | Owner ACL, rewritten view, missing constraint/disabled trigger và anchors trên PostgreSQL thật |
| `hrm-authorization-probes.integration-spec.ts` › :132-175 list/detail/count share scope | M1, M2 | port | `internal/modules/team/team_integration_test.go`, `internal/modules/employee/employee_read_integration_test.go`, `employee_scope_integration_test.go` | SQL scope lead/COO/HR/self, count/detail/list cùng tập; gateway projection chỉ key/code/fullName |
| `hrm-authorization-root-audit.integration-spec.ts` › :144 deny thắng HR allow | M2 | port | `internal/modules/employee/employee_scope_integration_test.go` | Deny/revoke cùng session và Root audit target hiện/vắng |
| `hrm-authorization-root-audit.integration-spec.ts` › :38/:84 work-request commands, Root audit/effect | M5 | | | CROSS: quyết định/cancel work-request và effect thật; nền audit rollback đã kiểm F6/M2 |
| `hrm-authorization-stack.helper.ts` | F6 | | | |
| `hrm-authorization-workflow.integration-spec.ts` › :45 owner/lead/COO/cancel | M5 | | | CROSS: work-request workflow |
| `hrm-authorization-workflow.integration-spec.ts` › :141 SQL/evaluator parity trên work-request/leave | M5 | | | CROSS: employee/team scopes đã kiểm M1/M2, phần workflow đợi M5 |
| `hrm-cancel-concurrency.integration-spec.ts` | M5 | | | |
| `hrm-cancel.integration-spec.ts` | M5 | | | |
| `hrm-coo-submit.integration-spec.ts` | M5 | | | |
| `hrm-employee.integration-spec.ts` | M2 | port | `internal/modules/employee/employee_*_integration_test.go`, `employee_validator_test.go`, `internal/app/m2_matrix_integration_test.go`, `m2_behavior_integration_test.go` | :143 privilege data/anchor; :166/:257/:312/:332 create/status/rate; :393 F1/F2/F3; :467 fresh/version/unique; :567/:628 link/self/epoch/scope commit; :656 menu/own; :735 F1/version/DB CHECK/audit. SQL fixtures thay calls tới module chưa chuyển |
| `hrm-excel.spec.ts` | M7 | | | |
| `hrm-http-measure.integration-spec.ts` | | | | |
| `hrm-input.spec.ts` | | | | |
| `hrm-leave-adjust.integration-spec.ts` | M5 | | | |
| `hrm-leave-concurrency.integration-spec.ts` | M5 | | | |
| `hrm-leave.integration-spec.ts` | M5 | | | |
| `hrm-leave.spec.ts` › :36–:289, accrual, `firstMonthOver`, balance view | M3 | port | `internal/modules/leavecore/leave_balance_helper_test.go`, `leave_effect_integration_test.go` | Facts, debit/reversal, D09 thêm trên PostgreSQL thật bằng login `data` |
| `hrm-leave.spec.ts` › :307/:339, parser query và body điều chỉnh | M5 | | | Parser thuộc route `leave` |
| `hrm-menu-account.integration-spec.ts` | M2 | port | `internal/modules/employee/employee_menu_integration_test.go`, `internal/app/m2_behavior_integration_test.go` | Root trên danh bạ rỗng, single Permits vẫn false; account.read runtime grant/revoke, không HR role mặc định |
| `hrm-menu-role.integration-spec.ts` | M2 | port | `internal/modules/employee/employee_menu_integration_test.go`, `internal/app/m2_behavior_integration_test.go` | Role permission/menu, runtime grant/revoke, linked admin trong 17 probe; fixture attendance thay bằng employee SQL, không gọi module attendance |
| `hrm-menu-setting.integration-spec.ts` | M2 | port | `internal/modules/employee/employee_menu_integration_test.go`, `internal/app/m2_behavior_integration_test.go` | Admin/COO/Root/runtime, grant/revoke cùng session, linked admin 17 probe; fixture attendance thay bằng employee SQL |
| `hrm-period-concurrency.integration-spec.ts` | M6 | | | |
| `hrm-period-concurrency.integration-spec.ts` › :249 submit, đổi lịch, chốt kỳ cùng tháng | M6 | | | CROSS: cần submit (M5) và chốt kỳ (M6). Phần lịch đã ghim riêng ở M4: `TestTheCalendarOnPostgreSQL` › "a change waiting behind a close…" (`internal/modules/workcalendar/work_calendar_integration_test.go`): giữ dòng kỳ FOR UPDATE như lệnh chốt, lệnh lịch chờ rồi thấy kỳ đã chốt, 409 `error.periodClosed`, không ghi version |
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
| `hrm-setting-behavior.integration-spec.ts` | M1 | | | Chưa port: mọi ca cần work-request, attendance close/reopen, report/export hoặc `employees.create`, chưa có ở Go; port cùng các nhóm đó |
| `hrm-setting.integration-spec.ts` | M1 | port | `internal/modules/setting/setting_integration_test.go`, `internal/modules/settingcore/setting_read_repository_integration_test.go` (ca :414) | Trừ ca :358 (dòng dưới). Append-only kiểm bằng login `data` (privilege chặn trước trigger) và login owner `migration` (trigger) |
| `hrm-setting.integration-spec.ts` :358 (đổi rate mặc định không áp ngược) | M2 | | | Cần `employees.create` |
| `hrm-setting.spec.ts` | M1 | port | `internal/modules/settingcore/setting_registry_test.go`, `internal/modules/setting/setting_validator_test.go`, `test/setting_security_policy_test.go` (ca :155) | Giá trị số đọc chính xác, không qua `float64`; body chỉ nhận số nguyên dạng thường (ruling 76). Ca :155 ghim view an toàn với giá trị thực thi của Go và SQL `resolve_session` |
| `hrm-stack.helper.ts` | | | | |
| `hrm-team.integration-spec.ts` | M1 | port | `internal/modules/team/team_integration_test.go`, `internal/modules/team/team_boundary_integration_test.go` | Nhân viên nghỉ việc dựng bằng superuser của cluster tạm, không qua `employees.create` |
| `hrm-work-calendar.integration-spec.ts` | M4 | port | `internal/modules/workcalendar/work_calendar_integration_test.go`, `internal/app/m4_matrix_integration_test.go` | Chốt kỳ (`attendance.closePeriod`, M6) thay bằng fixture SQL của `attendancecore`; thêm ngày làm bù năm 2030 (ADR-19, ngày tương lai) và ngày lẻ/ngày làm bù trong tháng đã chốt. CSRF/Origin/field thừa ở ma trận HTTP M4 |
| `hrm-work-schedule-upgrade.integration-spec.ts` › :58/:111 quyền login `data`, CHECK ca làm và ngày làm bù | M4 | port | `internal/modules/workschedule/work_schedule_integration_test.go` (`TestTheDataLoginReplacesSchedulesAndKeepsShiftsBounded`) | |
| `hrm-work-schedule-upgrade.integration-spec.ts` › :12 provision lại database dựng trước migration 7 | C1 | | | Kiểm đường nâng cấp của provision TypeScript; Go dựng bằng `hrmctl migrate` (goose), chưa có test nâng cấp từ database trước `1792108800007` |
| `hrm-work-schedule.integration-spec.ts` | M4 | port | `internal/modules/workschedule/work_schedule_integration_test.go`, `internal/app/m4_matrix_integration_test.go` | Chốt kỳ và ngày làm bù dựng bằng SQL (calendar ở package khác, module không import nhau). Ca tháng đã chốt chạy mọi ngày: chốt tháng của ngày mai bằng fixture thay vì bỏ qua ngày cuối tháng, thêm xóa version và kết thúc khung |
| `hrm-work-schedule.spec.ts` › :54–:318, helper khung giờ | M3 | port | `internal/modules/schedulecore/work_schedule_helper_test.go`, `employee_schedule_integration_test.go` | `EmployeeSchedule` thêm test PostgreSQL theo version lịch |
| `hrm-work-schedule.spec.ts` › :327/:355/:380, parser tuần, body, khoảng 92 ngày | M4 | port | `internal/modules/workschedule/work_schedule_validator_test.go`, `internal/modules/workcalendar/work_calendar_validator_test.go` | Số phút và `asWeekday` đọc theo grammar số nguyên: `540.0`, `5.4e2` bị từ chối (TS nhận vì `Number.isInteger`); `null` ở tuần, khung, ca bị từ chối |
| `hrm-working-time.spec.ts` | M3 | port | `internal/modules/schedulecore/working_time_helper_test.go` | Không spawn process với `TZ`: test đổi `time.Local` qua bốn múi giờ rồi khôi phục |
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
| `product-request-auth-http.integration-spec.ts` › route `hr/employees`, `auth/me` | M2 | port | `internal/app/auth_routes_integration_test.go`, `m2_matrix_integration_test.go` | Inventory động buộc route authenticated resolve session thật; unknown/revoked/expired/suspended không trả dữ liệu |
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
| `setting-controller.spec.ts` | M1 | port | `internal/modules/setting/setting_controller_test.go` | Engine thật với facade giả; ma trận session thật ở `internal/app` |
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
