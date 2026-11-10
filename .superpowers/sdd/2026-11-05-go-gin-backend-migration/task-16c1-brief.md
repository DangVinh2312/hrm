# Brief Task 16c1 — M8: `administration` phần tài khoản và role (6 route)

BASE: commit 16b `da18326` (xem `git log -1`). Đọc trước: `implementer-rules.md` (ràng buộc không nới), `task-16-map.md` (toàn bộ, chú ý đính chính ở đầu; §1 dòng #1–#11, §2a khung `AdminAccountCommand`, §3 package `internal/administration`, §4 handler không import `gateway`), `task-16-checklist.md` (mục 16c là BẮT BUỘC, từng ô áp dụng cho lát này phải được đáp ứng và nêu file:line trong báo cáo), `task-16a-report.md` (API `grant`, `authority.Administer`), `task-16b-report.md` (mẫu module M8, cách viết ma trận `m8Matrix`, `m8State`, smoke), phần cuối `progress.md` (ruling 100–104), root `AGENTS.md` (Bất biến bảo mật, Locale và mã lỗi), `apps/api-go/AGENTS.md`, `contract/package-dag.md`, `contract/routes.json`/`openapi.json` phần administration, plan Task 16. Module mẫu: `internal/modules/role` (16b). Code TS chỉ để hiểu nghiệp vụ; SQL chép nguyên văn.

## Phạm vi

Sáu route của package `internal/administration`:

- `GET /api/administration/accounts` (list, trang theo email)
- `POST /api/administration/accounts` (provision)
- `POST /api/administration/users/:id/suspend`
- `POST /api/administration/users/:id/reactivate`
- `POST /api/administration/accounts/:id/roles` (assignRole)
- `DELETE /api/administration/accounts/:id/roles/:roleKey` (revokeRole)

Gồm: types (`AccountRow`/`AccountPage` là defined type thuần, handler không chạm `gateway`), validator/input helper, repository, service, khung lệnh admin dùng chung (thiết kế sao cho 16c2 — bind/unbind boundary và ba lệnh `account.*` ADR-15 — tái dùng được, nhưng KHÔNG chuyển năm route đó ở lát này), controller + http_port, wiring composition root, `MigratedRoutes`, contract docs nếu lệch. Lệnh trên tài khoản dùng `authority.Administer` (ruling 102). Giữ như TS: id sai ở lệnh tài khoản → 403.

`app_test.go` đang dùng `GET /api/administration/accounts` làm route còn proxy trong hai fixture: đổi sang `GET /api/health/metrics` (còn proxy tới 16d), giữ nguyên ý nghĩa test.

Bất biến trong CODE không hoãn (checklist 16c + root `AGENTS.md`): default deny; UUID chuẩn chữ thường đầu mỗi lệnh → 403; precheck `ReachesTarget` → 404, provision dùng `AllowsAll`; trong `run`: `Detail` nil → 404 (vắng và đích Root không phân biệt) rồi mới so tự tác động → 403; khóa dòng `app_user` của đích trước khi đọc facts rồi `WithinActor`; assign của IAM: rule của role không bị cắt và `CompareGrantSets(role, actorGrants) == Within`, Root bỏ hai phép so; `WithinActor` trước mọi đọc/ghi lộ state (reactivate: trước khi kiểm `suspended`); suspend tăng `auth_epoch`; IAM ghi event trong `run`, `rootEvent` không nil; audit atomic với mutation; `boundary: 'required'` + `fresh@1` lấy từ declarations; không trả secret; lỗi một shape `{statusCode, code}`, không thêm mã lỗi; DTO allowlist; mutation dùng `httpapi.DecodeCommand`/`DecodeEmptyCommand`; không giữ fence trong lúc hash/network (provision: theo đúng thứ tự TS).

## Test (ruling 101/103)

- Guard/conventions có sẵn phải xanh; thêm dòng ma trận guard đòi vào `internal/app/m8_matrix_integration_test.go` (mở rộng `m8Matrix`/`m8State` cho bảng lát này ghi), không nới guard. `m1Row.state` chỉ dùng được cho GET.
- Smoke HTTP thật (PostgreSQL testcontainers): mỗi route một ca thành công đúng shape; 401 chưa đăng nhập; không grant bị từ chối.
- Mỗi bất biến một ca từ chối chạy thật: tự tác động → 403; đích Root → 404; đích có tập grant lớn hơn actor → 404; assign role ngoài tập grant của actor bị từ chối; id không chuẩn (chữ hoa) → 403; suspend tăng `auth_epoch` (phiên của đích hết hiệu lực); provision email trùng → 409; reactivate đích chưa suspend → 409 (theo TS).
- Phần còn lại (ma trận đầy đủ, đua, mutant, các spec TS `product-account-role*`, `product-account-provisioning*`, `product-account-reactivate*`, `product-account-grant-scope*`, `product-root-suspend*`, `account-role.spec.ts`, `hrm-admin-precheck*`) thêm vào `test-debt.md` mục "Task 16c1", liệt kê spec:dòng.

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-16c1-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` cho package `./internal/administration` và `./internal/app`. Từ root: `pnpm test:browser` (một lần, cuối); prettier Markdown đã đổi; `git diff --check`.

## Báo cáo

`task-16c1-report.md`: route đã chuyển (bảng), checklist 16c từng ô → file:line (ô chỉ thuộc 16c2 ghi "16c2"), quyết định tự đưa ra, lệnh + output thật, file đổi, nợ, điều chưa kiểm chứng, và ghi chú cho 16c2 (khung nào tái dùng, còn thiếu gì). Không stage/commit/spawn/tick plan. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
