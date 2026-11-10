# Task 16a: nền M8 trong Go

Status: DONE_WITH_CONCERNS

## Đã làm

- Package mới `internal/authorization/grant`: so sánh tập grant, kiểm grant của role runtime, digest trùng byte với TS, đọc facts từ DB.
- Primitive admin trong `internal/authorization/authority`: `AdminCommand` và `Administer`, tương đương `access(..., 'admin', work, rootEvent)` của TS.
- Không thêm route, không đổi `MigratedRoutes`, không sửa `apps/api/src`, không thêm cạnh DAG (`grant -> core, keys, database` đã khai sẵn trong `contract/package-dag.md`).

## API mới

`grant`:

- `type Source string` (`SourceRole`, `SourceUser`); `GrantRuleFact{Source, Effect core.Effect, Permission string, Template core.RelationRef, Parameters string}`; `Parameters` ở dạng RFC 8785.
- `type Verdict string` (`Within`, `Larger`, `Incomparable`, `Unprovable`); `CompareGrantSets(target, actor []GrantRuleFact) Verdict`; `ProvenWithin(target, actor []GrantRuleFact, truncated bool) bool`.
- `MaxRuntimeRoles = 100`, `MaxRoleKeyBytes = 96`, `IsRuntimeRoleKey(string) bool`, `IsRoleKeyReference(string) bool`.
- `RoleGrantSpec{Permission string, Template core.RelationRef}`; `type GrantCheck` (`GrantsOK`, `GrantsTooMany`, `GrantsUnknownPermission`, `GrantsUnknownTemplate`, `GrantsWrongResource`, `GrantsDuplicate`); `CheckRoleGrants(*core.ValidatedDeclarations, []RoleGrantSpec) GrantCheck`.
- `GrantsAsFacts([]RoleGrantSpec) []GrantRuleFact`; `GrantsDigest(label string, grants []RoleGrantSpec) (string, error)`.
- `MaxFactRows = 20000`; `Actor{ID, Kind string}`; `Read(tx *database.Tx, userIDs []string, maxRows int) (map[string][]GrantRuleFact, bool, error)`; `WithinActor(tx *database.Tx, actor Actor, target string) (bool, []GrantRuleFact, error)`.

`authority`:

- `AdminContext{Tx *database.Tx, Actor Actor, Permission string, Detail func(key string) (gateway.Row, error), Reaches func(resource, action, key string, fulfil bool) (bool, error)}`.
- `NewAdminCommand[I, R](resource, action string, run func(AdminContext, I) (R, error), rootEvent func(AdminContext, I, R) *audit.Event) *AdminCommand[I, R]`.
- `Administer[I, R](ctx, a *Authority, secret, command *AdminCommand[I, R], input I) (R, error)`.
- `reachesIn` (nội bộ) nhận thêm `fulfil bool`; `CommandContext.Reaches` gọi với `false`, hành vi cũ giữ nguyên.

## Đối chiếu TS

- `grant-set.helper.ts`: `CompareGrantSets`; deny hoặc rule gắn user thì `Unprovable`; thiếu permission thì `Larger` (thắng `Incomparable`); cùng permission nhưng khác template, version hoặc parameters thì `Incomparable`.
- `role-grant.helper.ts:105-112`: `GrantsDigest`. Vector lấy từ node chạy dist TS: `"Admin"`/[] = `369a5dc1…`, một grant = `229bc963…`, nhãn có ký tự escape = `6db48187…` (không phụ thuộc thứ tự grant), nhãn astral = `d6aafe2e…`. Nhãn UTF-8 sai bị từ chối.
- `grant-facts.repository.ts:20-91`: SQL của `Read` chép từ TS, `LIMIT maxRows+1` để phát hiện bị cắt.
- `product-authority-engine.service.ts:150-237` và `admin-account-command.service.ts`: `Administer` chạy `access` ở `ModeAdmin`, gọi `Detail`/`Reaches` trong cùng transaction, Root đi qua `planUnrestricted` và ghi audit bằng `rootEvent`.

## Quyết định tự đưa ra

- Primitive ở dạng command phải đăng ký bằng pointer, theo mẫu operation hiện có. `New` bắt mọi admin command phải có policy `fresh@1`; command chưa đăng ký thì `ErrAccessDenied`.
- Precheck, kiểm tự tác động, thứ tự khóa `app_user` là việc của caller (16c), không nằm trong `Administer`.
- Không thêm hàm `RoleLabel` riêng; nhãn role dùng `httpapi.InputText(label, 120)` (đã ghi vào `apps/api-go/AGENTS.md`).
- SQL thêm `::text` cho `holder` và `parameters`; parameters được canonical hóa bằng `jsontext.Value.Canonicalize`, vì vậy hai jsonb bằng nhau luôn so bằng nhau.
- Row của digest sắp theo byte. Kết quả trùng thứ tự UTF-16 của JS vì key permission/template là ASCII.
- `Reaches` của Root với `fulfil` không ghi gì, vì plan của Root không có obligation; audit của Root đi qua `rootEvent`.
- Obligation của `Detail` vẫn chạy khi đích vắng, giống TS.
- `rootEvent` trả `&audit.Event{}` nghĩa là `run` đã tự ghi audit.

## Lệnh và kết quả

Mọi lệnh chạy trong `apps/api-go`, sau `waitload.sh`, với `GOCACHE=/private/tmp/hrm-go-cache`.

| Check | Lệnh | Kết quả | Log |
| --- | --- | --- | --- |
| RED grant | `go test ./internal/authorization/grant` trước khi viết code | build fail (package chưa có) | `/private/tmp/hrm-16a-grant-red.log` |
| RED authority | `go vet -tags integration ./internal/authorization/authority` | undefined `AdminCommand` | `/private/tmp/hrm-16a-authority-red.log` |
| build | `go build ./...` | exit 0 | `/private/tmp/hrm-16a-build.log` |
| vet | `go vet ./...` | exit 0 | `/private/tmp/hrm-16a-vet.log` |
| vet integration | `go vet -tags integration ./...` | exit 0 | `/private/tmp/hrm-16a-vetint.log` |
| unit | `go test -race -count=1 ./internal/...` | exit 0 | `/private/tmp/hrm-16a-unit.log` |
| test package | `go test -count=1 ./test` | ok 5.252s, exit 0 | `/private/tmp/hrm-16a-testpkg.log` |
| lint | `go tool golangci-lint run` | 0 issues, exit 0 | `/private/tmp/hrm-16a-lint.log` |
| gofmt | `gofmt -l .` | rỗng, exit 0 | `/private/tmp/hrm-16a-gofmt.log` |
| integration grant | `go test -tags integration -race -count=1 -p 1 ./internal/authorization/grant` | ok 6.630s, exit 0 | `/private/tmp/hrm-16a-grantint.log` |
| integration authority | `go test -tags integration -race -count=1 -p 1 ./internal/authorization/authority` | ok 20.131s, exit 0 | `/private/tmp/hrm-16a-authority-int.log` |
| diff | `git diff --check` | exit 0 | — |
| ASCII | `LC_ALL=C grep -n '[^ -~\t]'` trên các file Go mới | không có dòng nào | — |
| prettier | `pnpm exec prettier --check` cho `apps/api-go/AGENTS.md`, `test-debt.md`, báo cáo này | pass | — |

Đột biến (bản sao trong scratchpad, không chạm repo): unit m1, m2, m4, m5, m9, m3b đều RED (`/private/tmp/hrm-16a-mutants-unit.log`); integration m6, m7, m8 RED (`/private/tmp/hrm-16a-mutants-int.log`). m3 dạng integration (`truncated ||` trong `WithinActor`) sống vì không test integration nào cắt `WithinActor`; đã tách `ProvenWithin` và m3b trên hàm đó RED.

Integration authority chạy trước khi tách `ProvenWithin`; phần đổi đó chỉ nằm trong `grant`, và integration grant đã chạy lại sau khi tách.

Chưa chạy: suite integration toàn `apps/api-go` (`go test -tags integration ./...`), E2E web, suite NestJS. Task không đổi route hay wiring nên không chạy smoke HTTP.

## File đổi

- Mới: `apps/api-go/internal/authorization/grant/{grant_set_helper.go, role_grant_helper.go, grant_facts_repository.go, grant_set_helper_test.go, role_grant_helper_test.go, grant_facts_repository_integration_test.go}`.
- Mới: `apps/api-go/internal/authorization/authority/{authority_admin.go, authority_admin_command_integration_test.go}`.
- Sửa: `apps/api-go/internal/authorization/authority/{sql_gateway.go, authority_operations.go}`.
- Tài liệu: `apps/api-go/AGENTS.md` (package `grant`, đoạn về `AdminCommand`/`Administer` và bẫy), `test-debt.md` (mục "M8 nền (Task 16a)"), báo cáo này.
- `progress.md` đã bị sửa từ trước, không phải trong task này.

## Nợ và điều chưa kiểm chứng

- Ghi trong `test-debt.md`: grant-set.spec :68 (thứ tự key và số trong parameters), :122 (property test); role-grant.spec :50, :57; hrm-admin-precheck :121/:132/:161/:216; tự tác động; thứ tự khóa `app_user`; mutant `Detail`.
- `CheckRoleGrants` chưa nhận template có tham số (comment `shortcut:` trong `role_grant_helper.go`).
- Chưa có caller thật: precheck, kiểm tự tác động và khóa sẽ được kiểm khi 16c nối route.
- Digest chỉ đối chiếu bốn vector; tính trùng với TS cho nhãn khác dựa trên việc `encoding/json/v2` không escape `<`, `>`, `&`, U+2028, giống `JSON.stringify`.

## Vòng sửa 1

Sửa:

- IMPORTANT 1, fail open với id không ở dạng chuẩn. `grant.Read` (`grant_facts_repository.go:34-39`) và `grant.WithinActor` (`:81`) nhận thêm `*core.Core`. `Read` trả `errNonCanonicalID` trước khi query nếu có id không qua `core.(*Core).IsCanonicalUUID` (helper có sẵn), hoặc core là nil. Row có holder không nằm trong tập id đã hỏi giờ trả lỗi (`:70-72`), không bị bỏ qua. Chưa có caller ngoài test, nên chữ ký mới không làm vỡ chỗ nào. Bẫy này đã ghi vào `apps/api-go/AGENTS.md`.
- Minor 2: `sql_gateway.go:109-113`, `Reaches(..., true)` trả `false, err` khi obligation lỗi.
- Minor 5: doc comment của `GrantsDigest` (`role_grant_helper.go:93-96`) giờ nói thứ tự sắp theo byte chỉ khớp TS khi key là ASCII, nên phải gọi `CheckRoleGrants` trước.
- Không sửa Minor 1, 3, 4 (đã chuyển sang 16c hoặc ghi vào nợ).

Test:

- `TestANonCanonicalTargetIDIsAnError` (integration, `grant_facts_repository_integration_test.go:74`): actor giữ `hr.employee`, đích giữ `hr.employee` và `hr.coo`. Gọi với id đích viết chữ hoa và dạng `{…}` thì phải trả lỗi và không được `Within`.
- `TestReadRefusesANonCanonicalIDBeforeQuerying` (unit, `grant_set_helper_test.go:86`): truyền tx nil, với chữ hoa, `{…}`, không có gạch nối, chuỗi rỗng, `x` và core nil. Test chỉ pass khi id bị từ chối trước khi chạy SQL.

RED (`/private/tmp/hrm-16a-r1-red.log`, chạy với code cũ):

```
--- FAIL: TestANonCanonicalTargetIDIsAnError (5.63s)
    grant_facts_repository_integration_test.go:84: a non-canonical target id gave within=true error=false
    grant_facts_repository_integration_test.go:84: a non-canonical target id gave within=true error=false
FAIL	hrm/api-go/internal/authorization/grant	5.713s
exit 1
```

GREEN (`/private/tmp/hrm-16a-r1-green.log`):

```
--- PASS: TestANonCanonicalTargetIDIsAnError (5.94s)
--- PASS: TestReadRefusesANonCanonicalIDBeforeQuerying (0.00s)
ok  	hrm/api-go/internal/authorization/grant	7.019s
exit 0
```

Check chạy lại (log ở `/private/tmp/hrm-16a-r1-<tên>.log`), tất cả exit 0:

- build, vet, vet integration.
- unit `-race ./internal/...`.
- `./test`: ok 5.064s.
- lint: 0 issues.
- gofmt: không liệt kê file nào.
- integration `grant`: ok 6.693s.
- integration `authority`: ok 20.673s.
- `git diff --check`.
- prettier cho `apps/api-go/AGENTS.md` và báo cáo này.

Chưa có test riêng cho hai đường lỗi mới: row có holder lạ (SQL hiện tại không thể sinh ra row như vậy) và `Reaches(..., true)` khi obligation lỗi.

## Review độc lập (điều phối viên ghi)

- Lượt 1 (opus, `review-t16a.diff`): Needs fixes. Important 1: `grant.Read`/`WithinActor` fail open với target UUID không chuẩn (tái hiện: chữ hoa → `within=true`). Minor 1–5.
- Re-review delta (`review-t16a-r1.diff`): **Approved**. Important 1, Minor 2, Minor 5 ADDRESSED; reviewer chạy lại ca tái hiện và một đột biến (bỏ kiểm UUID chuẩn → unit đỏ; integration vẫn xanh nhờ lớp chặn holder lạ).
- Hoãn: Minor 1, 3 (cờ audit trong `Administer`), 4 (deny thắng allow qua `Administer`) → `task-16-checklist.md` và nợ; nhánh holder lạ không có test riêng; `userIDs` rỗng không kiểm `c == nil` (vô hại).
- Checklist bắt buộc cho 16b/16c: `task-16-checklist.md`.
