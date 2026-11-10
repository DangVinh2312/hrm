# Brief Task 16c2 — M8: `administration` phần boundary và lệnh identity ADR-15 (5 route)

BASE: commit 16c1 `7683e5f` (xem `git log -1`). Đọc trước: `implementer-rules.md` (ràng buộc không nới), `task-16-map.md` (đính chính ở đầu; §1 dòng #7–#11, §2 đoạn bind/unbind và "ba lệnh ADR-15", §3 package `internal/administration`, §4 handler không import `gateway`), `task-16-checklist.md` (mục 16c BẮT BUỘC; mọi ô áp dụng cho 5 route này phải đáp ứng và nêu file:line trong báo cáo), `task-16c1-report.md` (khung `newAccountCommand`/`onAccount` trong `admin_account_command_service.go` — TÁI DÙNG, không viết khung thứ hai; mục "Vòng sửa review"), `task-16b-report.md` (mẫu ma trận/smoke M8), phần cuối `progress.md` (ruling 100–104), root `AGENTS.md` (Bất biến bảo mật, nhất là đoạn ADR-05/ADR-15 về `account.*`; Locale và mã lỗi), `apps/api-go/AGENTS.md`, `contract/package-dag.md`, `contract/routes.json`/`openapi.json` phần administration, plan Task 16. Module đã có: `internal/administration` (16c1). Code TS chỉ để hiểu nghiệp vụ; SQL chép nguyên văn.

## Phạm vi

Năm route còn lại của package `internal/administration`:

- `POST /api/administration/accounts/:id/boundaries` (`account.bindBoundary`)
- `DELETE /api/administration/accounts/:id/boundaries/:key/:version` (`account.unbindBoundary`)
- `PUT /api/administration/accounts/:id/email` (`account.changeEmail`)
- `POST /api/administration/accounts/:id/mfa/reset` (`account.resetMfa`)
- `POST /api/administration/accounts/:id/google/reset` (`account.resetGoogleBinding`)

Gồm: repository boundary (`packageOf`, `bindingsOf`, insert gói, `deleteRuntime` chỉ dòng `seed_owner IS NULL`), service boundary, service identity (savepoint + hàm SECURITY DEFINER `change_iam_account_email`, `reset_iam_mfa`, `reset_iam_google_binding`), input helper (`inputBoundaryRef`, `inputBoundaryVersionParam`), controller/http_port, `MigratedRoutes` (+5 → 99/100), contract docs nếu lệch. Lệnh dùng `authority.Administer` qua khung 16c1 (ruling 102). Id sai → 403 như TS.

Bất biến trong CODE không hoãn (checklist 16c + root `AGENTS.md`): UUID chuẩn chữ thường đầu mỗi lệnh → 403; precheck `ReachesTarget` → 404; trong `run`: `Detail` nil → 404 (vắng và Root không phân biệt) rồi mới so tự tác động → 403; khóa `app_user` của đích rồi `WithinActor` TRƯỚC mọi đọc/ghi lộ state (bind: trước `packageOf`/`bindingsOf`; identity: trước savepoint); bind: gói active, mọi entry `required`, ≤64; IAM không giữ đủ gói → 403 trước 409; 23505 → 409 `boundary_bound` đúng như TS; unbind 0 dòng → 409; identity: canonical email trước (`credential.CanonicalLoginEmail`), `SAVEPOINT identity_operation`, P0002 hoặc 42501 có message `^only IAM accounts ` → `ROLLBACK TO SAVEPOINT` và 404 (Root vẫn audit `absent`), 55000/23505 → 409, lỗi khác là lỗi hệ thống (không nuốt); cả ba lệnh tăng `auth_epoch` của đích (do hàm DB); response chỉ `{status}` — không trả secret/mã khôi phục; issuer từ config đúng một provider (dùng `provisioningIssuer` 16c1), không lấy từ request, 0 hoặc ≥2 provider → 503 cho changeEmail/resetGoogleBinding (resetMfa không cần provider); `boundary: 'required'` + `fresh@1` từ declarations; IAM ghi event trong `run`, `rootEvent` không nil; audit atomic với mutation, kind đúng (`permission.boundary-assign`/`-revoke`, `identity.email-change`, `identity.mfa-reset-by-permission`, `identity.binding-reset`), không ghi email/PII ngoài những gì contract audit TS đã ghi; không thêm mã lỗi; DTO allowlist (`RejectUnknownMembers`); mutation dùng `httpapi.DecodeCommand`/`DecodeEmptyCommand`.

## Test (ruling 101/103)

- Guard/conventions có sẵn phải xanh; thêm dòng ma trận guard đòi vào `internal/app/m8_matrix_integration_test.go` (mở rộng `m8AccountMatrix`/`m8State` cho bảng lát này ghi, ví dụ `user_boundary`, cột identity của `app_user`/`external_identity`), không nới guard. `m1Row.state` chỉ dùng cho GET.
- Smoke HTTP thật (PostgreSQL testcontainers): mỗi route một ca thành công đúng shape + audit kind; 401 chưa đăng nhập; không grant bị từ chối.
- Mỗi bất biến một ca từ chối chạy thật: tự tác động → 403 (ít nhất một lệnh boundary và một lệnh identity); đích Root → 404; đích có tập grant lớn hơn → 404 cho ít nhất bind và một lệnh identity (chọn đích sao cho nếu bỏ `WithinActor` thì ra 200, không phải 409); id chữ hoa → 403; IAM bind gói mình không giữ → 403; bind trùng → 409; unbind không bound → 409; `auth_epoch` của đích tăng sau mỗi lệnh identity (phiên của đích → 401); changeEmail email trùng → 409; resetMfa không có yếu tố thứ hai → 409; changeEmail/resetGoogleBinding với 0 provider → 503. Mỗi ca từ chối quan trọng: chạy đột biến (bản sao trong scratchpad, như vòng sửa 16c1) chứng minh đỏ — ít nhất bỏ `WithinActor` ở bind và ở một lệnh identity.
- Ghi nhớ ADR-15: không cấp đồng thời ba permission `account.*` cho một người/role trong fixture mới trừ khi test cố ý kiểm điều đó.
- Phần còn lại (ma trận đầy đủ, đua, các spec TS `product-account-boundary*`, `product-identity-operation*` gồm concurrency/faults/mfa/oidc/upgrade, `account-boundary.spec.ts`, `account-identity-operation.spec.ts`) thêm vào `test-debt.md` mục "Task 16c2", liệt kê spec:dòng.

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-16c2-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` cho `./internal/administration` và `./internal/app`. Từ root: `pnpm test:browser` (một lần, cuối); prettier Markdown đã đổi; `git diff --check`.

## Báo cáo

`task-16c2-report.md`: route đã chuyển (bảng), checklist 16c từng ô → file:line, quyết định tự đưa ra, lệnh + output thật, kết quả đột biến, file đổi, nợ, điều chưa kiểm chứng, ghi chú cho 16d. Không stage/commit/spawn/tick plan. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
