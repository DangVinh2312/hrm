# Task 16c2: năm route `administration` còn lại (boundary và ba lệnh identity ADR-15) trên Go

Status: DONE_WITH_CONCERNS

BASE `7683e5f`. Không stage, commit, tick plan, spawn hay sửa `apps/api/src`.

## Route đã chuyển

| Method, path | Action | Lệnh Go | Status Go (ngoài 401/503 chung) |
| --- | --- | --- | --- |
| `POST /api/administration/accounts/:id/boundaries` | `account.bindBoundary` | `onAccount` + `changeBoundary(true)` | 200 `{status:"bound"}`; 400 body/key/version, gói không active/không toàn `required`/> 64; 403 id không chuẩn, tự tác động, không grant/boundary/fresh, IAM không bind đủ gói; 404 vắng, Root, deny, đích lớn hơn; 409 gói chồng binding |
| `DELETE /api/administration/accounts/:id/boundaries/:key/:version` | `account.unbindBoundary` | `onAccount` + `changeBoundary(false)` | 200 `{status:"unbound"}`; 400 key/version trong path; 403; 404 như trên; 409 không có dòng runtime để xóa |
| `PUT /api/administration/accounts/:id/email` | `account.changeEmail` | `onAccount` + `identityCommand` | 200 `{status:"changed"}`; 400 body/email; 403; 404; 409 email không đổi/đã dùng (55000/23505); 503 không đúng một provider |
| `POST /api/administration/accounts/:id/mfa/reset` | `account.resetMfa` | `onAccount` + `identityCommand` | 200 `{status:"reset"}`; 400 body khác rỗng/`{}`; 403; 404; 409 không có yếu tố thứ hai (55000). Không cần provider |
| `POST /api/administration/accounts/:id/google/reset` | `account.resetGoogleBinding` | `onAccount` + `identityCommand` | 200 `{status:"reset"}`; 400 body; 403; 404; 409 không có email (55000); 503 không đúng một provider |

Sau lát này: 99/100 route trên Go; còn `GET /api/health/metrics` (16d).

## Checklist 16c → file:line

Đường dẫn tương đối từ `apps/api-go/internal/administration/` trừ khi ghi khác. Khung `newAccountCommand`/`onAccount` của 16c1 được tái dùng, không có khung thứ hai.

- [x] UUID chuẩn chữ thường đầu mỗi lệnh, sai là 403: `admin_account_command_service.go:60` (`onAccount`, cả năm lệnh); `changeEmail` kiểm thêm trước email `identity_operation_service.go:56`. Cùng chuỗi đi vào `Detail`, so tự tác động, `lockAccount`, `WithinActor`, SQL. Ca chạy thật: smoke `internal/app/m8_matrix_integration_test.go:826` (bind), `:846` (mfa), `:863` (email); ô `invalid` của mfa/google (chữ hoa, `not-a-uuid`); unit `TestAnEmailChangeChecksTheIdThenTheEmail`.
- [x] Precheck `ReachesTarget` trước `Administer`, `false` là 404 không lấy fence độc quyền: `admin_account_command_service.go:63-67`. Ca: ô `absent`/`deny` của năm dòng ma trận (so cả revision); smoke `:820` (IAM bind trên Root), IAM mfa/email trên Root.
- [x] Trong `run`: `Detail` nil là 404 rồi mới so tự tác động (403): `admin_account_command_service.go:32-38`. Ca: tự tác động 403 ở bind `:818`, unbind, mfa `:841`, email `:860`, google; Root với chính mình là 404 có audit absent (`m8RootAbsent`) ở bind `:821`, mfa, email, google.
- [x] Khóa `app_user` của đích rồi `WithinActor` trước mọi đọc/ghi lộ state: bind/unbind `account_boundary_service.go:25-31` (trước `boundaryPackage`/`boundaryBindings`/delete); identity `identity_operation_service.go:28-34` (trước `SAVEPOINT`). Ca: đích lớn hơn 404, state không đổi, bind `:824`, mfa `:845` (đích có recovery code nên bỏ `WithinActor` ra 200, đã chứng minh bằng đột biến).
- [x] Bind: gói active, mọi entry `required`, ≤ `MaxBoundaryPackage` (64) → 400 `account_boundary_service.go:56-68`; actor không phải Root phải giữ đủ gói → 403 trước 409 `:73-78`; insert cả gói, 23505 hoặc số dòng khác → 409 `account_boundary_service.go:79-82`, `account_boundary_repository.go:46-63`. Unbind chỉ xóa `seed_owner IS NULL` `account_boundary_repository.go:66-76`, 0 dòng → 409 `account_boundary_service.go:37-40`. Ca: `:832` (actor không bind đủ gói 403), `:835` (cả khi đích đã bind, vẫn 403 không phải 409), `:834` (bind trùng 409), `:827` (unbind chưa bind 409); ô `invalid` (key vắng, version 2); repository test dòng seed không bị xóa.
- [x] Identity: canonical email trước (`credential.CanonicalLoginEmail`) `identity_operation_service.go:59`; `SAVEPOINT identity_operation`, P0002 hoặc 42501 có message bắt đầu `only IAM accounts` → `ROLLBACK TO SAVEPOINT` và không tìm thấy (Root vẫn audit `absent`), 55000/23505 → 409, lỗi khác là lỗi hệ thống: `identity_operation_repository.go:17-38`. Ca: integration `TestTheIdentityFunctionsUnderTheSavepoint` (vắng, Root ở ba hàm: transaction đi tiếp; 55000/23505 → 409; 22023 và EXECUTE bị thu hồi là lỗi).
- [x] Tăng `auth_epoch` (do hàm DB), không trả secret (response chỉ `{status}`), hàm `SECURITY DEFINER` hẹp `kind='iam'`: `identity_operation_repository.go:42-57`. Ca: `m8EndsTheSession` (`:756`) cho mfa `:849`, email `:866`, google `:878`: epoch +1 đúng một lần, phiên của đích trước 200 sau 401; email mới hạ chữ và `email_verified=false`; google về `pending`, binding bị tắt; recovery code bị xóa.
- [x] Issuer từ config, đúng một provider (`provisioningIssuer` 16c1), không từ request; 503 ở đầu service: `identity_operation_service.go:53`, `:74`; `resetMfa` không cần. Ca: unit `TestTheIdentityCommandsNeedingAnIssuerAreUnavailableWithoutIt` (issuer rỗng); HTTP với cấu hình hai provider `:886-887` (503), mfa vẫn 200 `:891`. 0 provider qua HTTP không dựng được (xem lo ngại).
- [x] `boundary: 'required'` + `fresh@1` từ declarations (`authority.New` bắt admin command có `fresh@1`). Ca: ô `boundary` (403) và `fresh` (403) của năm dòng ma trận.
- [x] IAM ghi event trong `run` (khung append event `work` trả, `admin_account_command_service.go:39-43`); `rootEvent` không nil: bind/unbind `access.account.<action>` absent (`account_service.go`, `accessAbsent`), identity chính kind với outcome `absent` (`identityAbsent`, `identity_operation_service.go:44-48`). Kind: `permission.boundary-assign`/`-revoke` (`audit.PermissionChange` có `BoundaryKey`, `BoundaryVersion`, `TargetUserID`, target account), `identity.email-change`, `identity.mfa-reset-by-permission`, `identity.binding-reset` (`audit.AccountChange`, chỉ id đích, không email). Ca: ô `granted`/`root` của ma trận đếm đúng một audit kind; `m8RootAbsent`.
- [x] Không dùng `Execute` cho `account`; `Reaches` không dùng ở lát này.
- [x] Không thêm mã lỗi; DTO allowlist qua `RejectUnknownMembers`: `boundaryBody`, `emailBody` (`administration_input_helper.go`); mutation dùng `DecodeCommand` (bind `account_controller.go:153`, email `:185`), `DecodeEmptyCommand` (mfa `:201`, google `:212`), unbind chỉ `EnforceCSRF` (`:169`). Ca: ô `extra` (400), `csrf`, `origin` (403), `TestEveryMigratedWriteRefusesAMissingCSRF`.

## Quyết định tự đưa ra

1. Ba lệnh identity cũng `lockAccount` trước `WithinActor` (TS không khóa, hàm DB tự khóa `FOR UPDATE`). Brief yêu cầu "khóa `app_user` của đích rồi `WithinActor`"; khóa `FOR NO KEY UPDATE` rồi hàm nâng lên `FOR UPDATE` trong cùng transaction, chỉ thêm tuần tự hóa với writer khác của dòng.
2. Bind kiểm giữ gói với mọi actor không phải Root (`Kind != "root"`), thay vì chỉ `iam` như TS: kind lạ fail closed (thực tế `WithinActor` đã trả lỗi trước với kind lạ).
3. Version của body là `*int64` (số nguyên JSON; `1.5`, `"1"` là 400, v2 từ chối số lẻ), range 1..2^31-1 kiểm sau; version trong path theo grammar `^[1-9][0-9]{0,9}$` rồi cùng range.
4. `changeEmail`: 503 (issuer) → 403 (id) → 400 (email) → `onAccount`. Như TS: port trả 503 trước service, service kiểm id rồi email.
5. Mfa/google đọc body bằng `DecodeEmptyCommand` (TS bỏ qua body), như suspend ở 16c1; OpenAPI đã có 400.
6. Ma trận: ba role `custom.m8_email|mfa|google`, mỗi role một permission identity; `holdIdentity` để hr/unbound/denied chỉ giữ role của route đang kiểm (ADR-15: không ai giữ hai permission identity cùng lúc). `m8Larger` đổi grant từ `account.bindBoundary` sang `account.changeEmail`, vì hr nay giữ bind/unbind; đích lớn hơn chỉ dùng khi hr không giữ role email. `m8State` thêm `user_boundary`, `email_verified`, enrollment theo email, `external_identity`, `mfa_totp`, `mfa_recovery_code`; `m8Committed` so cả `m8State` (chặt hơn bản 16c1).
7. `m1Codes` thêm `503: error.unavailable` để `m1Refused(503)` dùng được.
8. `app_test.go` ca "a migrated route the contract lost": khi bỏ một route khỏi contract thì contract còn 99 = `MigratedRoutes`, boot dừng ở bước `upstream` (`errUpstreamRefused`) trước `route inventory`. Thêm một route giả chưa chuyển (`/api/health/proxied`) để contract vẫn lớn hơn; ý của ca (route đã chuyển mà contract mất là lỗi inventory) giữ nguyên. Đây là một trong các guard bản đồ §4 dự đoán phải sửa ở 16d, đến sớm một lát.
9. Repository tách thành `account_boundary_repository.go` và `identity_operation_repository.go`; không có `boundary_binding_helper.go` riêng (grammar ở `administration_input_helper.go`, `MaxBoundaryPackage` ở repository).

## Lệnh và kết quả

Mọi lệnh trong `apps/api-go`, sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`. Load 1 phút lúc chạy: 3–8 (dưới 40).

| Check | Lệnh | Kết quả | Log |
| --- | --- | --- | --- |
| RED repository | `go vet -tags integration ./internal/administration/` trước khi viết repository/service | exit 1, `undefined: boundaryPackage` | `/private/tmp/hrm-16c2-red-repo.log` |
| RED HTTP | overlay `inventory.go` của HEAD, `-run 'M8BoundariesAndIdentity\|TheM8AccountRoutes\|EveryM8Account\|EveryMigratedAuthorizeRouteHasAFullMatrix'` | exit 1: 5 route "a matrix for a route not served as authorize" | `/private/tmp/hrm-16c2-mut-red.log` |
| integration administration (lượt đầu) | `go test -tags integration -race -count=1 -p 1 ./internal/administration/` | FAIL: fixture không có email nên reset Google ra 55000; sửa test (đích có email, thêm ca "no email" 409) | `/private/tmp/hrm-16c2-int-administration.log` (bị ghi đè) |
| M8 tập trung | `-run 'M8\|EveryMigratedAuthorizeRouteHasAFullMatrix\|CSRF' -v ./internal/app/` | 9 PASS, ok 18.567s | `/private/tmp/hrm-16c2-m8focus.log` |
| build | `go build ./...` | exit 0 | `/private/tmp/hrm-16c2-build.log` |
| vet | `go vet ./...` | exit 0 | `/private/tmp/hrm-16c2-vet.log` |
| vet integration | `go vet -tags integration ./...` | exit 0 | `/private/tmp/hrm-16c2-vetint.log` |
| unit lượt 1 | `go test -race -count=1 ./internal/...` | exit 1: `TestAFailedStepNeverListens/a_migrated_route_the_contract_lost` (boot dừng ở `upstream`, quyết định 8) | `/private/tmp/hrm-16c2-unit.log` |
| test package | `go test -count=1 ./test` | exit 0 | `/private/tmp/hrm-16c2-testpkg.log` |
| lint | `go tool golangci-lint run` | exit 0 | `/private/tmp/hrm-16c2-lint.log` |
| gofmt | `gofmt -l .` | rỗng, exit 0 | `/private/tmp/hrm-16c2-gofmt.log` |
| integration administration | `go test -tags integration -race -count=1 -p 1 ./internal/administration/` | exit 0 | `/private/tmp/hrm-16c2-int-administration.log` |
| integration app | `go test -tags integration -race -count=1 -p 1 ./internal/app/` (đã gồm sửa `app_test.go`) | ok 111.666s, exit 0 | `/private/tmp/hrm-16c2-int-app.log` |
| unit lượt 2 | `go test -race -count=1 ./internal/...` sau sửa `app_test.go` | exit 0 | `/private/tmp/hrm-16c2-unit2.log` |
| vet app, gofmt sau sửa | `go vet ./internal/app/`, `gofmt -l .` | exit 0, rỗng | — |
| lint lượt 2 | `go tool golangci-lint run` sau sửa `app_test.go` | exit 0, "0 issues." | `/private/tmp/hrm-16c2-lint2.log` |
| browser | `pnpm test:browser` (root) | 30 passed (3.0m), exit 0 | `/private/tmp/hrm-16c2-browser.log` |
| prettier | `pnpm exec prettier --check` `apps/api-go/AGENTS.md`, `test-debt.md`, báo cáo này | pass, exit 0 | — |
| diff | `git diff --check`; file mới: không khoảng trắng cuối dòng, chỉ ASCII (`LC_ALL=C grep -n '[^ -~\t]'`) | exit 0, không dòng nào | — |

### Đột biến (overlay ở scratchpad `mut16c2/`, không chạm repo)

App: `-run 'M8BoundariesAndIdentity|TheM8AccountRoutes|EveryM8Account|EveryMigratedAuthorizeRouteHasAFullMatrix' ./internal/app/`; repository: `./internal/administration/` integration.

| # | Đột biến | Kết quả | Test đỏ |
| --- | --- | --- | --- |
| mA | bind/unbind bỏ kết quả `WithinActor` | RED | `:824` "an IAM bind on a larger account: 200, want 404" và state đổi |
| mB | identity bỏ kết quả `WithinActor` | RED | `:845` "an IAM mfa reset of a larger account: 200, want 404" và state đổi |
| mC | bỏ kiểm actor giữ đủ gói | RED | `:832` 200 thay 403 |
| mD | P0002/42501 không `ROLLBACK TO SAVEPOINT` | RED | repository: "the transaction did not go on: SQLSTATE 25P02" (4 ca) |
| mE | 23505 không còn là 409 | RED | smoke `:865` 503 thay 409; repository "a taken email: SQLSTATE 23505" |
| mF | bỏ kiểm `bound > 0` trước insert | sống | Tương đương: insert gặp khóa chính → 23505 → 409, rollback; chỉ khác là thêm một câu INSERT thất bại |
| mG | unbind bỏ `seed_owner IS NULL` | RED | repository: trigger `protect_product_rows` chặn, "delete of seeded rows" lỗi 25P02 |
| mH | mọi 42501 coi là "only IAM accounts" | RED | repository: "a revoked EXECUTE is not a fault: nil" |
| mI | `changeEmail` bỏ kiểm issuer ở service | RED (unit) | `-run Issuer ./internal/administration/`: "changeEmail: access denied" thay vì unavailable |

Log: `/private/tmp/hrm-16c2-mut-{red,mA,mB,mC,mF,mE,mI}.log`, `/private/tmp/hrm-16c2-mut-{mD,mE,mG,mH}-repo.log`. Đột biến chạy trước khi sửa `app_test.go` và trước hai lần chỉnh gofmt chỉ đổi định dạng test.

## File đổi

- Mới `apps/api-go/internal/administration/`: `account_boundary_repository.go`, `account_boundary_service.go`, `identity_operation_repository.go`, `identity_operation_service.go`, test `account_boundary_repository_integration_test.go`.
- Sửa `internal/administration/`: `account_service.go` (năm command, `All`), `account_controller.go` (năm handler), `administration_http_port.go`, `administration_input_helper.go` (`boundaryBody`, `emailBody`, `inputBoundaryRef`, `inputBoundaryVersionParam`, `validBoundaryRef`, `parseEmailBody`), `account_types.go` (`BoundaryRef`), `administration_input_helper_test.go`.
- `internal/httpapi/inventory.go` (+5 route → 99).
- Test app: `m8_matrix_integration_test.go` (năm dòng ma trận, `m8State`, world, `holdIdentity`, smoke `TestM8BoundariesAndIdentityOverHTTP`), `m1_matrix_integration_test.go` (`m1Codes` 503), `app_test.go` (quyết định 8).
- Tài liệu: `apps/api-go/AGENTS.md` (danh sách package, đoạn M8 năm route), `test-debt.md` (mục "Task 16c2"), báo cáo này. Contract (`routes.json`, `openapi.json`, `route-ownership.md`) đã khớp (status 200, 400/401/403/404/409/503, body bind/email), không sửa. DAG không thêm cạnh (`administration` đã import `database`, `credential`, `grant`).

## Nợ

`test-debt.md` mục "Task 16c2": spec:dòng của `product-account-boundary.integration-spec.ts`, `product-identity-operation*.integration-spec.ts` (gồm concurrency, faults, mfa, oidc, upgrade), `product-identity-operations*.integration-spec.ts`, `account-boundary.spec.ts`, `account-identity-operation.spec.ts`; audit lỗi rollback, đua, `lockAccount`, gói có entry optional/> 64 (cần fixture boundary riêng), 503 với 0 provider qua HTTP.

## Điều chưa kiểm chứng và lo ngại

- 503 với 0 provider qua HTTP không dựng được: cấu hình bỏ provider đang bật thì boot dừng ở `oidc provider sync` ("provider disable requires offline revoke"). Kiểm bằng unit (issuer rỗng) và HTTP với hai provider. Bỏ kiểm issuer ở service (mI) chỉ đỏ ở unit: với hai provider, issuer rỗng sẽ tới hàm DB và ra 22023 → 503, nên ca HTTP không phân biệt được (suy ra từ code hàm, chưa chạy đột biến qua HTTP).
- Nhánh savepoint (đích đổi kind giữa lookup và hàm) chỉ kiểm ở repository bằng cách gọi thẳng hàm với Root/vắng; qua HTTP Root đích luôn dừng ở `Detail`.
- `lockAccount` ở năm lệnh không có test (cần cuộc đua).
- Kiểm gói `required`/≤ 64 không có ca 400 riêng (catalog hiện chỉ có gói toàn `required` ≤ 9); key vắng và version sai thì có.
- Đột biến mF sống, được coi là tương đương (nêu ở bảng).

## Ghi chú cho 16d

- `MigratedRoutes` 99/100; thêm metrics thì `newUpstream` từ chối `API_UPSTREAM_URL` ở mọi boot test đặt upstream (bản đồ §4). Ca `a_migrated_route_the_contract_lost` đã sửa trước (quyết định 8); `configOver()` và `testConfig("http://127.0.0.1:1")` vẫn đặt upstream.
- `m1Codes` đã có 503.
