# Task 16c1: sáu route `administration` (tài khoản và role) trên Go

Status: DONE_WITH_CONCERNS

BASE `da18326`. Không stage, commit, tick plan, spawn hay sửa `apps/api/src`.

## Route đã chuyển

| Method, path | Action | Lệnh Go | Status Go (ngoài 401/503 chung) |
| --- | --- | --- | --- |
| `GET /api/administration/accounts` | `account.read` (`auditedRead@1`) | `authority.List`, `OrderBy: "email"` | 200 `{items:[{userId,email,state,enrollment}],total}`; 400 query (`InputPageQuery`); không grant hoặc deny: 200 trang rỗng (obligation `access.read` vẫn ghi) |
| `POST /api/administration/accounts` | `account.provision` + `account.assignRole` | `AllowsAll` rồi `Administer` | 201 `{userId,email,state}`; 400 body/email/roleKey; 403 không grant, thiếu boundary, không fresh, tài khoản mới không thấy qua hai plan; 404 role vắng, role ngoài tập IAM, actor bị deny; 409 email đã có; 503 không đúng một provider |
| `POST /api/administration/users/:id/suspend` | `account.suspend` | `onAccount` (khung) | 200 `{status:"suspended"}`; 400 body khác rỗng/`{}`; 403 id không chuẩn, tự tác động, không grant/boundary/fresh; 404 vắng, Root, deny, đích lớn hơn |
| `POST /api/administration/users/:id/reactivate` | `account.reactivate` | `onAccount` | 200 `{status:"reactivated"}`; như suspend; 409 chưa suspend (55000) |
| `POST /api/administration/accounts/:id/roles` | `account.assignRole` | `onAccount` | 200 `{status:"assigned"}`; 400 body/roleKey; 403 như trên; 404 như trên + role vắng/ngoài tập IAM; 409 đang giữ, 20 role |
| `DELETE /api/administration/accounts/:id/roles/:roleKey` | `account.revokeRole` | `onAccount` | 200 `{status:"revoked"}`; 400 roleKey; 403; 404 như trên + role vắng; 409 chưa giữ, role cuối |

Sau lát này: 94/100 route trên Go; còn 5 route `administration` (16c2) và `GET /api/health/metrics` (16d).

## Checklist 16c → file:line

Đường dẫn tương đối từ `apps/api-go/internal/administration/` trừ khi ghi khác.

- [x] UUID chuẩn chữ thường đầu mỗi lệnh trên đích, sai thì 403, dùng đúng chuỗi đó về sau: `admin_account_command_service.go:60` (`onAccount`). `Detail` (`:32`), so tự tác động (`:36`), `WithinActor` (`account_command_service.go:30`, `:44`, `:77`), SQL (`account_role_repository.go`) cùng nhận `input.targetID()`/`input.UserID`, không chuẩn hóa lại. Ca chạy thật: `TestM8AccountsOverHTTP` (`internal/app/m8_matrix_integration_test.go:574`, `:575`, IAM và Root), ô `invalid` của suspend/reactivate (chữ hoa, `not-a-uuid`), unit `TestANonCanonicalTargetIsRefusedFirst`.
- [x] Precheck `ReachesTarget` (fence chia sẻ) trước `Administer`, `false` là 404 không lấy fence độc quyền: `admin_account_command_service.go:63-67`. Provision dùng `AllowsAll`: `account_service.go:93`. Ca: ô `absent`, `deny` của ma trận (state gồm revision không đổi); `m8_matrix_integration_test.go:562` (IAM với đích Root).
- [x] Trong `run`: `Detail` nil là `false`/404 rồi mới so tự tác động (403): `admin_account_command_service.go:32-38`. Ca: `:560`, `:561` (tự tác động 403, state không đổi), `:564` (Root với chính mình là 404 kèm audit absent, không phải 403). Đột biến m2 (đảo thứ tự) RED.
- [x] Assign/revoke khóa dòng `app_user` trước khi đọc facts rồi `WithinActor`: `account_command_service.go:74-80`. Assign của IAM: rule của role đọc không bị cắt và `CompareGrantSets == Within` (`:60-65`); Root chỉ `roleExists` (`:58-59`), `WithinActor` của Root trả `true`. Revoke chỉ `roleExists` (`:85`). Ca: `:573` (role ngoài tập 404, `user_role` không đổi); đột biến m4 RED.
- [x] Suspend/reactivate: `WithinActor` đứng trước mọi đọc/ghi lộ state (`account_command_service.go:30`, `:44`); reactivate so trước khi gọi hàm definer kiểm `suspended`; 55000 → 409 (`account_role_repository.go:128`). Ca: `:570`, `:571` (đích lớn hơn 404, kể cả reactivate của tài khoản active lớn hơn), `:576` (active 409). Đột biến m3 RED. Bind/unbind và lệnh identity: 16c2.
- [x] IAM ghi event nghiệp vụ trong `run`; `rootEvent` không bao giờ nil, `ok`/`absent` đúng `done`, `&audit.Event{}` chỉ khi `run` đã ghi event có cờ Root: khung `admin_account_command_service.go:39-51` (work trả event, khung append trong cùng transaction; Root nhận cờ qua `rootOutcome` `:72-77`). Provision: `account_command_service.go:172-185` và `provisionRootEvent` `:189-195` (Root: `account.provision ok` hoặc `access.account.provision absent`). Minor 16a (Administer không bắt `run` ghi audit) được khung xử lý: lệnh xong mà không có event thì không thể trả `done`.
- [x] Tăng `auth_epoch` (suspend): `account_role_repository.go:120`; reactivate qua hàm `SECURITY DEFINER` `reactivate_iam_account` (`:127`). Không trả secret (response chỉ `{status}` hoặc projection). `boundary: 'required'` + `fresh@1` lấy từ declarations (`authority.New` bắt admin command có `fresh@1`). Ba lệnh `account.*` ADR-15: 16c2. Ca: `:583-595` (epoch +1, phiên của đích thành 401), ô `fresh` và `boundary` của ma trận.
- [x] `Reaches(..., fulfil)`: kiểm cả `err` lẫn bool, `account_command_service.go:157-164`.
- [x] Không dùng `Execute` cho resource `account`: chỉ `Administer`, `List`, `ReachesTarget`, `AllowsAll`.
- [x] Ruling 103: mỗi ý trên có ít nhất một ca từ chối chạy thật (liệt kê ở từng ô).

Bất biến chung của brief: default deny (ô `noGrant`, `deny`, `boundary`, `fresh`); lỗi một shape, không thêm mã (mọi ô so body `{"statusCode":N,"code":"error.*"}`); DTO allowlist (`provisionBody`, `roleBody`, `administration_input_helper.go:9-17`, `RejectUnknownMembers` qua `DecodeCommand`; ô `extra` 400); mutation dùng `DecodeCommand` (`account_controller.go:76`, `:115`), `DecodeEmptyCommand` (`:93`, `:104`), DELETE chỉ `EnforceCSRF` (`:131`); không giữ fence khi hash/network (provision không hash, không network; thứ tự như TS).

## Quyết định tự đưa ra

1. Khung dùng chung `newAccountCommand`/`onAccount` thay cho gọi `Administer` trực tiếp từ mỗi lệnh: `work` trả `*audit.Event` và khung append. Lý do: Minor 16a, và để 16c2 không phải dựng lại thứ tự UUID → precheck → Detail → self.
2. Suspend/reactivate đọc body bằng `DecodeEmptyCommand` (TS bỏ qua body). Web gửi POST không body; OpenAPI đã có 400. Thu hồi role (DELETE) chỉ `EnforceCSRF`, như DELETE role ở 16b.
3. Thứ tự controller: CSRF, decode/parse, rồi lấy cookie phiên, như 16b. `sessionSecret` của TS và `httpapi.SessionSecret` đều không tra DB (phiên được kiểm trong transaction), nên thứ tự quan sát được giống TS.
4. Issuer: `provisioningIssuer` ở `internal/app/authority.go`, truyền qua `newModules(runner, issuer)`; service trả 503 khi rỗng, trước khi đọc input (như port TS).
5. `provision` từ chối kind lạ (`roleWithin` lỗi) thay vì coi như Root như nhánh `else` của TS.
6. `roleRules` đọc `parameters::text` rồi canonical hóa RFC 8785, như `grant.Read`; một rule có permission mà thiếu cột khác là lỗi (TS điền mặc định).
7. Ma trận đặt trong map riêng `m8AccountMatrix` với world riêng `newM8AccountWorld` (role `custom.m8_accounts`), vì gắn grant `account.*` vào world role sẽ làm hỏng ca "create ngoài tập" (dùng `account.suspend`) của 16b. Guard chung (`TestEveryMigratedAuthorizeRouteHasAFullMatrix`) gộp map này. `m8State` mở rộng thêm `app_user` (id, state, epoch, email), `user_role`, `oidc_email_enrollment`; `m8ReadState` nhận kind làm tham số (`m8Audited`).
8. Ô ma trận NA có lý do: provision `deny` và `absent` (404 sau fence độc quyền vẫn commit revision và obligation `access.provision`, như TS; guard `m1Row.state` chỉ cho GET nên không thay state được). Hai ca này kiểm ở smoke với `m8Committed` (tài khoản và `user_role` không đổi).

## Lệnh và kết quả

Mọi lệnh trong `apps/api-go`, sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`. Load 1 phút lúc chạy: 4–9 (dưới 40). Vòng đột biến và vòng check chạy tuần tự trong một lệnh nền nhưng mỗi lệnh đứng sau một `waitload.sh` riêng.

| Check | Lệnh | Kết quả | Log |
| --- | --- | --- | --- |
| RED repository | `go vet -tags integration ./internal/administration/` trước khi viết repository | undefined `reactivateAccount`, exit 1 | `/private/tmp/hrm-16c1-red-repo.log` |
| RED HTTP | test M8 account với overlay đặt lại `inventory.go`, `app/authority.go`, `app/app.go` của HEAD | FAIL: 6 route "not migrated", mọi ca smoke 503 (proxy tới upstream chết) | `/private/tmp/hrm-16c1-red-http.log` |
| integration administration | `go test -tags integration -race -count=1 -p 1 ./internal/administration/` | ok 7.370s | `/private/tmp/hrm-16c1-int-administration.log` |
| M8 tập trung | `-run 'M8\|EveryMigratedAuthorizeRouteHasAFullMatrix' -v ./internal/app/` | 7 PASS (gồm `TestTheM8AccountRoutesAnswerEveryCellOfTheMatrix`, `TestM8AccountsOverHTTP`), ok 15.711s | `/private/tmp/hrm-16c1-m8focus-v.log` |
| build | `go build ./...` | exit 0 | `/private/tmp/hrm-16c1-build.log` |
| vet | `go vet ./...` | exit 0 | `/private/tmp/hrm-16c1-vet.log` |
| vet integration | `go vet -tags integration ./...` | exit 0 | `/private/tmp/hrm-16c1-vetint.log` |
| unit | `go test -race -count=1 ./internal/...` | exit 0 | `/private/tmp/hrm-16c1-unit.log` |
| test package | `go test -count=1 ./test` | ok 4.936s | `/private/tmp/hrm-16c1-testpkg.log` |
| lint | `go tool golangci-lint run` | 0 issues | `/private/tmp/hrm-16c1-lint.log` |
| gofmt | `gofmt -l .` | rỗng | `/private/tmp/hrm-16c1-gofmt.log` |
| integration app lượt 1 | `go test -tags integration -race -count=1 -p 1 ./internal/app/` | FAIL 214s: `TestM5WorkflowReconciliationDetailApprovalAndCancellation` (boot step manifest `UnavailableError 25P04`), `TestM5ApprovalsMenuFollowsPermissionsWithoutWaitingRequests` (CLI TS bootstrap `AuthorityUnavailableError 25P04`); cả hai lỗi ở dựng fixture trước khi chạm route | `/private/tmp/hrm-16c1-int-app.log` |
| hai ca M5 chạy riêng | `-run '<hai test>' -v` | 2 PASS, ok 9.551s | `/private/tmp/hrm-16c1-int-m5b.log` |
| integration app lượt 2 | như lượt 1 | ok 94.125s, exit 0 (load 1 phút lúc bắt đầu 17.66) | `/private/tmp/hrm-16c1-int-app2.log` |
| browser | `pnpm test:browser` (root) | 30 passed (2.8m), exit 0 | `/private/tmp/hrm-16c1-browser.log` |
| prettier | `pnpm exec prettier --check` cho `apps/api-go/AGENTS.md`, `test-debt.md`, báo cáo này | pass | — |
| diff | `git diff --check`; file mới: `grep -nE '[[:space:]]+$'`, `LC_ALL=C grep -n '[^ -~\t]'` | exit 0, không dòng nào | — |

### Đột biến (overlay ở scratchpad, không chạm repo)

| # | Đột biến | Test đỏ | Log |
| --- | --- | --- | --- |
| m1 | bỏ `IsCanonicalUUID` trong `onAccount` | ô `invalid` suspend/reactivate (chữ hoa ra 503 vì `grant.Read` từ chối, `not-a-uuid` ra 400), `TestM8AccountsOverHTTP` | `/private/tmp/hrm-16c1-mut-m1.log` |
| m2 | so tự tác động trước `Detail` | `:564` Root với chính mình 403 thay vì 404, không audit absent | `/private/tmp/hrm-16c1-mut-m2.log` |
| m3 | suspend bỏ kết quả `WithinActor` | `:570` đích lớn hơn 200, tài khoản đổi | `/private/tmp/hrm-16c1-mut-m3.log` |
| m4 | assign của IAM bỏ so role | `:573` role ngoài tập 200 | `/private/tmp/hrm-16c1-mut-m4.log` |

## File đổi

- Mới `apps/api-go/internal/administration/`: `account_types.go`, `administration_input_helper.go`, `account_id_helper.go`, `account_role_repository.go`, `admin_account_command_service.go` (khung), `account_command_service.go`, `account_service.go`, `administration_http_port.go`, `account_controller.go`; test `administration_input_helper_test.go`, `account_role_repository_integration_test.go`.
- Sửa: `internal/app/authority.go` (operations, issuer, routes), `internal/app/app.go` (gọi `newModules` với issuer), `internal/httpapi/inventory.go` (6 route).
- Test: `internal/app/m8_matrix_integration_test.go` (`m8State` mở rộng, `m8Audited`, `m8AccountMatrix`, world, smoke), `m1_matrix_integration_test.go` (guard gộp `m8AccountMatrix`), `app_test.go` (hai fixture sang `GET /api/health/metrics`, test `provisioningIssuer`).
- Tài liệu: `apps/api-go/AGENTS.md` (package, đoạn M8 administration), `test-debt.md` (mục "Task 16c1"), báo cáo này. Contract (`routes.json`, `openapi.json`, `route-ownership.md`) đã khớp, không sửa. DAG không thêm cạnh.

## Nợ

Ở `test-debt.md` mục "Task 16c1", liệt kê spec:dòng của `product-account-role`, `product-account-provisioning`, `product-account-reactivate`, `product-account-grant-scope`, `product-root-suspend`, `account-role.spec.ts`, `hrm-admin-precheck`, `product-account-role-required-upgrade`, cùng deny qua `Administer` và đột biến còn lại.

## Điều chưa kiểm chứng và lo ngại

- Integration app lượt 1 có hai lỗi 25P04 (idle-in-transaction timeout) ở bước dựng fixture của M5; chạy riêng thì pass. Không thấy liên quan tới code lát này, nhưng không có bằng chứng nguyên nhân.
- F1 (caller không tới đích không chờ fence độc quyền) chỉ được đo gián tiếp qua state; bỏ `ReachesTarget` chưa chắc đỏ (IAM sẽ ra 404 trong `run`, nhưng revision tăng — ô `absent`/`deny` của ma trận so revision nên dự kiến đỏ; chưa chạy đột biến này).
- Thiếu `lockAccount` không có test (cần cuộc đua).
- Không có test HTTP cho 503 khi 0 hoặc 2 provider; chỉ unit `provisioningIssuer` và `Service.Provision` với issuer rỗng.

## Ghi chú cho 16c2

- Tái dùng: `newAccountCommand[I accountTarget]` (input chỉ cần `targetID()`), `onAccount`, `rootOutcome`, `accountEvent`, `accessAbsent`, `lockAccount`, `sqlState`, `Operations.All`/`Bind`. Mỗi lệnh 16c2 chỉ viết `work` (trả event hoặc nil) và `absent`.
- Còn thiếu: `account_boundary_repository.go` (`packageOf`, `bindingsOf`, `deleteRuntime`), `boundary_binding_helper.go`, `inputBoundaryRef`/`inputBoundaryVersionParam`; ba lệnh ADR-15 cần `SAVEPOINT identity_operation` + `ROLLBACK TO SAVEPOINT` khi P0002 hoặc 42501 "only IAM accounts" (vẫn trả `nil` để khung ghi absent cho Root), 55000/23505 → 409, canonical email trước; changeEmail/resetGoogleBinding dùng `issuer` (đã có trong `Service`). Bind: IAM không giữ đủ gói là 403 trước 409. Kind audit `identity.*`, `permission.boundary-*` đã có trong `audit`.
- Khi thêm route vào `m8AccountMatrix` phải sửa số 6 ở `TestEveryM8AccountRouteIsMigratedWithAFullMatrix` và thêm grant/boundary binding vào `newM8AccountWorld` (gói `identityAdministration@1` cho ba lệnh ADR-15).

## Vòng sửa review

File đổi:

- `apps/api-go/internal/app/m8_matrix_integration_test.go` (`TestM8AccountsOverHTTP`): thêm `m8Committed` "an IAM revoke from a larger account" (`DELETE .../accounts/<larger>/roles/hr.employee`, đích giữ `hr.employee` + `custom.m8_larger` nên bỏ `WithinActor` ra 200 chứ không 409) và "an IAM assign to a larger account" (`hr.admin`, role trong tập của hr, như ô thành công của ma trận) → 404; thêm ca tích cực Root gán `custom.m8_larger` cho một `m8Target` mới → 200 `{"status":"assigned"}` có audit `permission.role-assign` (đích riêng, không đụng các ca sau).
- `apps/api-go/internal/administration/administration_input_helper_test.go`: comment `TestProvisioningWithoutAnIssuerIsUnavailable` nói đúng thứ tự (503 ở đầu service, trước `CanonicalLoginEmail`/`AllowsAll`; controller đã chạy `DecodeCommand`, `parseProvision`, `SessionSecret`).
- `apps/api-go/AGENTS.md`: cùng câu về 503 của provision.
- `test-debt.md` mục "Task 16c1": câu 503; smoke có thêm assign/revoke đích lớn hơn và Root gán role lớn hơn; dòng F1 sửa theo kết quả đột biến; dòng "Đột biến còn lại" bỏ `ReachesTarget` và `WithinActor` ở assign/revoke (đã RED).

Đột biến (làm trên bản sao `apps/api-go` trong scratchpad, `apps/api` symlink chỉ để fixture tìm `dist`; SHA-256 hai file service trong repo kiểm lại OK sau cả hai lượt, file repo không bị sửa):

- Bỏ `!within` ở `changeRole` (`account_command_service.go:77-78`, giữ `actorGrants`): `go test -tags integration -race -count=1 -p 1 -run 'TestM8AccountsOverHTTP$' ./internal/app` exit 1, đúng hai ca mới đỏ: `an IAM revoke from a larger account: 200 {"status":"revoked"}, want 404` và `an IAM assign to a larger account: 200 {"status":"assigned"}, want 404` (cùng "changed an account or its roles"). Log `/private/tmp/hrm-16c1-fix-mut-withinactor.log`. (Lượt đầu exit 1 do bản sao không thấy `apps/api/dist`, không phải kết quả đột biến; chạy lại sau khi symlink.)
- Bỏ precheck `ReachesTarget` ở `onAccount` (`admin_account_command_service.go:63-66`): `-run 'TestM8AccountsOverHTTP$|TestTheM8AccountRoutesAnswerEveryCellOfTheMatrix'` exit 1: ô `deny` và `absent` của suspend, reactivate, assign, revoke báo "changed the state", smoke "an IAM suspend of Root changed the state". Claim cũ "bỏ `ReachesTarget` vẫn xanh" sai; việc không chờ fence độc quyền vẫn chưa được đo (giữ là nợ). Log `/private/tmp/hrm-16c1-fix-mut-reaches.log`.

Lệnh (trong `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`, mỗi lệnh nặng sau `waitload.sh`; load lúc chạy khoảng 3):

- Trước đột biến, test mới xanh: `-run 'TestM8AccountsOverHTTP$'` exit 0.
- `gofmt -l .` exit 0, không file nào.
- `go vet ./...` exit 0; `go vet -tags integration ./...` exit 0.
- `go tool golangci-lint run` exit 0, "0 issues." (config có build tag `integration`).
- `go test -tags integration -race -count=1 -p 1 -run 'TestM8|TestEveryM8' ./internal/app` exit 0 (`ok 9.653s`).
- `go test -tags integration -race -count=1 -p 1 ./internal/app` exit 0 (`ok 96.444s`), một lượt, không gặp 25P04.
- `go test -race -count=1 ./internal/app ./internal/administration` exit 0.
- `git diff --check` trên các file đã đổi exit 0; `pnpm exec prettier --check` ba file Markdown đã đổi exit 0.
- Không chạy lại `go build ./...`, `go test ./test`, `pnpm test:browser` (vòng này chỉ đổi test, comment và tài liệu).
