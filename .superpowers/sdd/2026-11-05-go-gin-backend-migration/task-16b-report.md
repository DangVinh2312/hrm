# Task 16b: các route `role` trên Go

Status: DONE_WITH_CONCERNS

BASE `2d7eebf`. Không stage, commit, tick plan hay sửa `apps/api/src`.

## Kế thừa và cách kiểm lại

Implementer trước bị ngắt lúc khoảng 16:51, chưa chạy check nào và chưa có báo cáo. Phần để lại: sửa `internal/app/authority.go` (đăng ký operations và route role), `internal/httpapi/inventory.go` (5 route vào `MigratedRoutes`), package mới `internal/modules/role` (types, validator, catalog/risk helper, ba repository, service, controller, http_port, `role_validator_test.go`).

Tôi đọc toàn bộ diff và mọi file, rồi đối chiếu từng hàm với TS (`apps/api/src/modules/role/*`, chỉ đọc): validator, catalog, risk, SQL của read/write (chép nguyên văn), thứ tự bước của ba lệnh, `#within`/`#current`, mapping lỗi, shape JSON (thứ tự key, `AccountGrant` nhúng `GrantView` rồi `source` như object TS). Phần runtime khớp TS ở mọi bất biến của checklist nên tôi giữ nguyên, chỉ sửa gofmt ở `role_read_repository.go:93-94` (khoảng trắng quanh `+`). Hai số liệu của test kế thừa đã được kiểm bằng `apps/api/dist`: catalog TS có 142 cặp, và vector capabilities khớp `roleCapabilities`. Tôi thêm sha256 của JSON catalog TS vào test.

Phần tôi viết: ma trận M8 và smoke HTTP, test integration của package role, guard dùng chung (`m1Row.state`, `m8State`), sửa hai fixture trong `app_test.go`, đoạn M8 trong `apps/api-go/AGENTS.md`, nợ trong `test-debt.md`, báo cáo này.

## Route đã chuyển

| Method, path | Action | Lệnh Go | Status Go (ngoài 401/503) |
| --- | --- | --- | --- |
| `GET /api/administration/roles` | `role.read` | `authority.Read` + `reaches` trên `role_anchor` | 200 `{roles,catalog,truncated}`; 404 không grant hoặc deny |
| `GET /api/administration/accounts/:id/permissions` | `account.readPermissions` | `authority.Read`, target là id | 200 `{roles,grants,boundaries,truncated}`; 400 id sai (trước transaction); 404 không grant, deny, vắng, Root |
| `POST /api/administration/roles` | `role.create` | `authority.Execute` mode admin, target `permission.RoleID` | 201 `{key,digest}`; 400; 403 không grant, deny, không fresh, grant ngoài tập IAM; 409 key đã có, 100 role |
| `PUT /api/administration/roles/:key` | `role.update` | như trên | 200 `{key,digest}`; 400 (gồm key của role code); 403 thêm boundary; 404 vắng, role lớn hơn tập IAM, IAM gặp role >300 rule; 409 digest cũ, rule deny/tham số, Root gặp role >300 rule |
| `DELETE /api/administration/roles/:key` | `role.delete` | như trên | 200 `{status:"deleted"}`; 400; 403; 404; 409 đang giữ, `record_exception` |

Bản đồ ghi "6 route `internal/modules/role`, 10 route `administration`" ở mục 0, nhưng bảng của chính nó và `route-ownership.md` có 5 route role và 11 route administration (tổng vẫn 17). Lát này chuyển đủ 5 route role, không route nào bị xếp sang 16c.

## Checklist 16b

- [x] `CheckRoleGrants` trước khi lưu và trước `GrantsDigest`: `checkCatalog` (`role_validator.go:100-113`) gọi `grant.CheckRoleGrants` ở `:104`. Service gọi trước fence (`role_service.go:74`, `:81`), lệnh gọi lại trước mọi ghi (`role_command_repository.go:86`, `:124`). Digest của input tính sau đó (`:113`, `:183`). Digest của rule đã lưu (`:74`, `role_read_repository.go:54`) tính trên rule trong DB, giống TS. Key là permission/template của release (ASCII), nên vector của 16a vẫn áp dụng.
- [x] Nhãn qua `httpapi.InputText(label, 120)`: `role_validator.go:63`; lệnh kiểm lại nhãn đã trim ở `:101`.
- [x] Tạo role dùng `IsRuntimeRoleKey`: `role_validator.go:35`, lệnh kiểm lại ở `role_command_repository.go:83`. Về `IsRoleKeyReference`: không route nào của 16b nhận tham chiếu role ngoài key runtime. TS dùng `parseRoleKey` (= `isRuntimeRoleKey`) cho cả PUT/DELETE, nên Go giữ như vậy. `IsRoleKeyReference` dành cho assign/provision ở 16c (xem Quyết định).
- [x] Giới hạn `MaxRuntimeRoles` (`role_command_repository.go:100`), `keys.MaxRoleGrants` (body `role_validator.go:43`; đọc rule `role_write_repository.go:58`, `:73`).
- [x] Từ chối sửa/xóa role `managed_by='code'`: key của route phải có tiền tố `custom.` (400). CHECK `ck_role_runtime_prefix` buộc role code không có tiền tố này. `lockRole` chỉ thấy `managed_by = 'runtime'` (`role_write_repository.go:43`). Trigger chặn login `authority`.
- [x] `expectedDigest` so với `GrantsDigest` của trạng thái DB đọc dưới fence và khóa: `lockRole` FOR UPDATE, rồi `current` đọc rule và tính digest (`role_command_repository.go:57-75`), rồi so (`:151`).
- [x] IAM: `grant.ProvenWithin(target, facts, truncated)` (`role_command_repository.go:22-31`), tức `CompareGrantSets == Within` và đọc bị cắt thì từ chối; Root bỏ qua (`:23`). Áp cho grant mới (create `:89`, update `:138`) và rule hiện tại của role (update/delete qua `current`, `:67`).
- [x] Mỗi bất biến có ca từ chối chạy thật:
  - role code: `TestM8RolesOverHTTP` (`m8_matrix_integration_test.go:268-274`, PUT/DELETE `hr.admin` là 400, state không đổi); `TestTheAuthorityLoginCannotChangeACodeOwnedRole` (`role_command_repository_integration_test.go:47`: `lockRole` không thấy, nhãn/xóa/thêm rule bị 42501); ô `invalid` của ma trận PUT/DELETE.
  - tập con: `m8_matrix_integration_test.go:276` (create ngoài tập 403), `:279`/`:281` (update/delete role lớn hơn 404), `:282` (update thêm grant ngoài tập 403). Đọc bị cắt: `TestAnIncompleteReadOfTheActorsGrantsProvesNothing` (`role_command_repository_integration_test.go:79`, actor có 20001 rule, role rỗng vẫn bị từ chối).
  - cặp chưa đăng ký: `m8_matrix_integration_test.go:285-292` (template của resource khác, permission lạ, `document`, `approvals` thiếu `decideFinal` đều 400); ô `invalid` của ma trận POST/PUT.
  - digest lệch: `m8_matrix_integration_test.go:266` (409, state không đổi).

Bất biến chung của brief:

- Default deny: ô `noGrant`, `deny`, `boundary` (update/delete), `fresh` của ma trận. `granted` (`role_service.go:92-101`) đổi `Found=false` của lệnh thành 403.
- Fence độc quyền, kiểm affected set, tăng revision cùng transaction: lệnh mode `database.ModeAdmin` qua `authority.Execute` (`role_service.go:39-41`). Runner lấy fence độc quyền và tăng revision. `Execute` khóa `role_anchor`. Mỗi ô từ chối so `w.state`, gồm revision, `role_definition`, `policy_rule`, số audit.
- Audit atomic: audit ghi trong cùng transaction (`role_command_repository.go:78-80`); `Execute` từ chối lệnh thành công không audit. Ca thật: REVOKE INSERT audit của `product_authority` thì create trả 503 và state không đổi (`m8_matrix_integration_test.go:331-340`).
- Lỗi một shape, không thêm mã: mọi ô kiểm body `{"statusCode":N,"code":"error.*"}` bằng `m1Cell.answers`. Không thêm key vào `API_ERROR_CODES`.
- DTO allowlist: `createBody`/`updateBody` (`role_validator.go:22-32`) qua `DecodeCommand` (`RejectUnknownMembers`). Ô `extra` của ma trận ra 400.
- Mutation dùng `httpapi.DecodeCommand`: `role_controller.go:84`, `:101`. DELETE không có body nên chỉ `EnforceCSRF` (`:118`).

## Quyết định tự đưa ra

1. `insertRules` dùng `gen_random_uuid()` trong SQL thay cho mảng UUID sinh ở client như TS (kế thừa). Đã có tiền lệ ở `attendance`/`workrequest`. Semantics không đổi.
2. Không dùng `IsRoleKeyReference` cho PUT/DELETE: giữ 400 như TS. Nếu nới thành reference thì `hr.admin` sẽ đi tới `lockRole` và ra 404, tức đổi semantics.
3. Thứ tự sắp của `readPermissions`: so byte thay cho `localeCompare`. Tôi kiểm trên dist (Node 24, locale `en-US`): 62 permission có thứ tự byte trùng `localeCompare`. Trong 22 template chỉ cặp `ownRequests`/`ownedDocuments` lệch, nhưng hai template này thuộc hai resource khác nhau nên không bao giờ cùng permission. Vì sắp theo permission trước, kết quả trùng TS trên dữ liệu release (comment ở `role_read_repository.go:136-138`). Catalog dùng `<` như TS. Go thêm tiêu chí version cuối cùng, không làm đổi thứ tự 142 cặp (sha256 khớp).
4. Thứ tự trong controller: CSRF, decode/parse, rồi session, theo mẫu các module Go khác (`attendance`). TS đọc session trước parse, nên khi chưa đăng nhập mà body sai thì Go trả 400, TS trả 401. Không lộ thông tin: CSRF vẫn chạy đầu tiên.
5. Guard dùng chung: thêm `m1Row.state` (`m1_matrix_integration_test.go:139-140`, dùng ở `check`). Lý do: obligation `audit@1` của `auditedRead@1` ghi `access.readPermissions` cho mọi lần đọc tới engine, kể cả khi không grant, deny hay đích vắng (TS giống hệt: `product-obligation.service.ts:20`, chạy sau `access`). `w.state` đếm mọi dòng audit nên coi đó là một lần ghi. `m8ReadAudited` chỉ loại đúng kind đó, vẫn giữ revision, role, rule, `user_role`, `user_boundary`, `app_user` và mọi audit khác. Smoke kiểm tường minh rằng một lần đọc bị từ chối ghi đúng +1 dòng kind này (`m8_matrix_integration_test.go:303-316`). Route khác không đổi.
6. `w.state` thêm `m8State` (`role_definition`, `policy_rule`). Mọi ma trận M1–M7 so thêm hai bảng này; các ma trận đó không ghi role nên không đổi kết quả (app integration xanh).
7. `app_test.go`: hai fixture dùng `GET /api/administration/roles` làm "route chưa chuyển" và "route proxy". Tôi đổi sang `GET /api/administration/accounts` (còn proxy tới 16c). 16c sẽ phải đổi lại.

## Lệnh và kết quả

Mọi lệnh chạy trong `apps/api-go` (trừ browser), sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`. Load lúc chạy app integration là 27 (dưới ngưỡng 40). Các log trung gian (`vet0`, `roleunit0`, `vetint0`, `m8focus`, `m8focus2`) giữ trong `/private/tmp`.

| Check | Lệnh | Kết quả | Log |
| --- | --- | --- | --- |
| build | `go build ./...` | exit 0 (chạy lại sau sửa gofmt, cùng lệnh với role unit) | `/private/tmp/hrm-16b-build.log` |
| vet | `go vet ./...` | exit 0 | `/private/tmp/hrm-16b-vet.log` |
| vet integration | `go vet -tags integration ./...` | exit 0 | `/private/tmp/hrm-16b-vetint.log` |
| unit | `go test -race -count=1 ./internal/...` | lượt 1 FAIL: `TestAFailedStepNeverListens` panic "handlers are already registered for path '/api/administration/roles'" (fixture cũ). Sửa `app_test.go`. Lượt 2 exit 0, 36 package ok | `/private/tmp/hrm-16b-unit.log` |
| role unit sau gofmt | `go test -race -count=1 ./internal/modules/role/` | ok 1.069s | `/private/tmp/hrm-16b-roleunit.log` |
| test package | `go test -count=1 ./test` | ok 6.987s | `/private/tmp/hrm-16b-testpkg.log` |
| lint | `go tool golangci-lint run` | lượt 1: 2 issue gofmt (`role_read_repository.go:93` kế thừa, `role_validator_test.go:21` do tôi sửa). Lượt 2: 0 issues | `/private/tmp/hrm-16b-lint.log` |
| gofmt | `gofmt -l .` | rỗng, exit 0 | `/private/tmp/hrm-16b-gofmt.log` |
| integration role | `go test -tags integration -race -count=1 -p 1 ./internal/modules/role/` | ok 8.356s (sau gofmt; lượt trước ok 13.450s) | `/private/tmp/hrm-16b-roleint.log` |
| integration app | `go test -tags integration -race -count=1 -p 1 ./internal/app/` | ok 133.092s | `/private/tmp/hrm-16b-appint.log` |
| M8 tập trung | `-run 'M8\|EveryMigratedAuthorizeRouteHasAFullMatrix' -v ./internal/app/` | lượt 1 FAIL (obligation audit, quyết định 5); lượt 2 ok 13.661s | `/private/tmp/hrm-16b-m8focus{,2}.log` |
| browser | `pnpm test:browser` (root) | 30 passed (3.6m), exit 0 | `/private/tmp/hrm-16b-browser.log` |
| prettier | `pnpm exec prettier --check` cho `apps/api-go/AGENTS.md`, `test-debt.md`, báo cáo này | All matched files use Prettier code style, exit 0 | — |
| diff | `git diff --check` | exit 0 (chỉ phủ file đã track; file mới kiểm bằng `grep -nE '[[:space:]]+$'`, không có dòng nào) | — |

Lượt 1 của M8 tập trung (trước quyết định 5):

```
m1_matrix_integration_test.go:700: no grant changed the state: ...|15|... -> ...|16|...
m1_matrix_integration_test.go:728: granted: access.account.readPermissions audits by the actor went from 0 to 0
--- FAIL: TestTheM8RoleRoutesAnswerEveryCellOfTheMatrix
m8_matrix_integration_test.go:291: permissions of Root changed the state: ...
--- FAIL: TestM8RolesOverHTTP
```

Lượt 2:

```
--- PASS: TestEveryMigratedAuthorizeRouteHasAFullMatrix (0.01s)
--- PASS: TestEveryM8RoleRouteIsMigratedWithAFullMatrix (0.00s)
--- PASS: TestTheM8RoleRoutesAnswerEveryCellOfTheMatrix (9.69s)
--- PASS: TestM8RolesOverHTTP (2.82s)
ok  	hrm/api-go/internal/app	13.661s
```

### Đột biến (overlay ở scratchpad, không chạm repo)

Runtime có sẵn trước khi test được viết, nên không có RED theo kiểu TDD. Độ nhạy được kiểm bằng sáu đột biến; cả sáu đều RED:

| # | Đột biến | Test đỏ | Log |
| --- | --- | --- | --- |
| m1 | `lockRole` bỏ `AND managed_by = 'runtime'` | `role_command_repository_integration_test.go:58` "the command lock found a code-owned role" | `/private/tmp/hrm-16b-mut-m1.log` |
| m2 | `within` bỏ `truncated` (lượt đầu không biên dịch vì biến thừa, đã sửa bản đột biến) | `:111` "a truncated read ... proved an empty role within" | `/private/tmp/hrm-16b-mut-m2.log` |
| m3 | create bỏ `within` của grant mới | `m8_matrix_integration_test.go:276` 201 thay vì 403 | `/private/tmp/hrm-16b-mut-m3.log` |
| m4 | update bỏ so digest | `:266` 200 thay vì 409 | `/private/tmp/hrm-16b-mut-m4.log` |
| m6 | `current` bỏ `within` của rule hiện tại | `:279`, `:281` 200 thay vì 404 | `/private/tmp/hrm-16b-mut-m6.log` |
| m7 | `checkCatalog` bỏ `CheckRoleGrants` và `lacksFinalDecision` | `:291` 201/503 thay vì 400 | `/private/tmp/hrm-16b-mut-m7.log` |

## File đổi

- Kế thừa, đã kiểm: `apps/api-go/internal/app/authority.go`, `apps/api-go/internal/httpapi/inventory.go`, `apps/api-go/internal/modules/role/{role_types,role_validator,role_catalog_helper,role_write_repository,role_read_repository,role_command_repository,role_service,role_controller,role_http_port}.go`. Tôi chỉ sửa gofmt ở `role_read_repository.go`.
- Test: `apps/api-go/internal/modules/role/role_validator_test.go` (kế thừa; thêm vector sha256 catalog, sửa gofmt), mới `role_command_repository_integration_test.go`, mới `apps/api-go/internal/app/m8_matrix_integration_test.go`, sửa `m1_matrix_integration_test.go` (guard `maps.Copy(m8Matrix)` `:426`, `m1Row.state`, `m8State` trong `w.state` `:661`), sửa `app_test.go` (hai fixture).
- Tài liệu: `apps/api-go/AGENTS.md` (package `role`, đoạn M8), `test-debt.md` (mục "Task 16b"), báo cáo này.
- `progress.md` đã bị sửa từ trước khi tôi bắt đầu, tôi không đụng.

## Nợ

Ghi ở `test-debt.md` mục "Task 16b", liệt kê spec:dòng: `hrm-role-write` (:180, :226 phần còn lại, :258, :289, :316, :331, :343, :356, :381, :419 phần nhãn, :447, :479, :510, :524, :539, :557, :607, :655 Root, :677, :687 update/delete), `hrm-role-matrix` (:152, :227 target, :256, :298), `hrm-role-truncation` (cả 5 ca), `hrm-role-runtime-assumptions`, `role-runtime-constraint` (trừ :125), `hrm-menu-role`, `role-catalog.spec` :48 :78, `role-risk.spec` :158 :165 :211, ca đọc bị cắt qua HTTP, và các đột biến chưa chạy.

## Điều chưa kiểm chứng và lo ngại

- Đọc bị cắt chỉ được kiểm ở mức repository (`commands.within` với 20001 rule). Chưa thử qua HTTP vì chưa rõ engine lập plan có đọc nổi chừng đó rule không.
- Lệnh tự kiểm lại catalog/key/nhãn khi service bị bỏ qua: chưa có test riêng. Đột biến m7 bỏ cả hai lớp mới đỏ; bỏ riêng lớp trong `commands` sẽ không đỏ.
- Smoke không có cuộc đua. Tính tuần tự của lệnh role dựa vào khóa `role_anchor` của `Execute`, chưa có test Go nào ghim.
- Obligation audit cho lần đọc bị từ chối là hành vi của engine (giống TS), không do lát này thêm. Lát này chỉ ghim nó trong smoke.
- Fixture `app_test.go` dùng `GET /api/administration/accounts`, nên 16c phải chọn route khác (`GET /api/health/metrics` tới 16d).
- Test kế thừa có ký tự ngoài ASCII (chữ Việt, emoji) trong `role_validator_test.go`. Đây là dữ liệu thật của ca nhãn, không có ký tự gần giống.

## Review độc lập và quyết định của điều phối viên (2026-11-10, ~18:00)

Reviewer độc lập (opus, chỉ đọc, không xem báo cáo này): **Approved**, không Critical/Important, 5 Minor.

1. Thứ tự grant so byte thay `localeCompare`: đúng với release hiện tại (62 permission trùng thứ tự; cặp template lệch duy nhất `ownRequests`/`ownedDocuments` thuộc hai resource khác nhau), nhưng comment "Keys are ASCII" không phải lý do đúng và chưa có test ghim. Chỉ ảnh hưởng hiển thị. → ghi nợ.
2. `m1Row.state` không bị giới hạn. → ĐÃ SỬA bởi điều phối viên: `check` dừng (`t.Fatalf`) nếu dòng đặt `state` mà route không phải GET (`m1_matrix_integration_test.go`). Chạy lại: `go vet -tags integration ./internal/app/` exit 0, `gofmt -l internal/app` rỗng, `go test -tags integration -race -count=1 -p 1 -run M8 ./internal/app/` ok 13.7s (3 test PASS). Phần "ô từ chối ghi đúng một dòng obligation" → ghi nợ.
3. Ca code-owned qua HTTP dừng ở `parseKey` (400); nhánh `managed_by='runtime'` của `lockRole` chỉ kiểm ở repository. Đủ cho ruling 103. → ghi nợ.
4. Audit lỗi chỉ phủ create; `record_exception` chưa có ca (đã có trong nợ). Khôi phục `REVOKE audit_outbox` nên dời vào `t.Cleanup`. → ghi nợ.
5. `task-16-map.md` đếm sai: đúng là administration 11, role 5, health 1; role code trên PUT trả 400 (không phải 404). → đã ghi chú đính chính đầu bản đồ.

Chưa chạy lại sau chỉnh guard: full `./internal/app` integration và `pnpm test:browser` (chỉ đổi file test; lượt đầy đủ của implementer chạy trước chỉnh này).
