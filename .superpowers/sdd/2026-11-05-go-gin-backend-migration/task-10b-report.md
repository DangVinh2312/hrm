# Báo cáo Task 10b

Trạng thái: DONE_WITH_CONCERNS — đọc/menu đã có bằng chứng; ghép app/HTTP session thật ở 10d, review độc lập còn chờ.

## Thay đổi và API ghép

`internal/modules/employee`: `NewOperations().All()` cung cấp năm query; `Bind(*authority.Authorization)` trả `*Service` có `List`, `Detail`, `Identity`, `LeaveRates`, `Profile`, `Menus`. `Routes{Employees: HTTPPort, Origin}.Register(group)` đăng ký năm route đọc, `me` là authenticated; route khác authorize đúng resource/action. `Menus(ctx, secret)` trả `[]keys.MeMenu` cho app tiêm vào port authentication ở 10d.

Theo ruling 84 người dùng đã chốt, module trả F1 hiện tại tương thích web; gateway `authority.Detail(employee, read)` vẫn chỉ có `key/code/fullName`. Identity riêng có scope SQL; leave-rates trả `{items}`. Không lọc quyền sau pagination. Search escape `%`, `_`, `\` và nằm trong scope; count và page cùng statement. Absent/foreign cùng 404. Trạng thái employment không hợp lệ bị từ chối. Không thêm dependency, schema hay mã lỗi.

Menu đọc own employee qua query có scope, chỉ nuốt `ErrAccessDenied` của own query thành không thấy gì. Một `PermitsMany` trả 14 probe (17 khi linked), giữ thứ tự menu; Root không linked không hỏi ba action self. Như TS, own query và phép probe là hai transaction riêng; tập probe nằm trong một transaction. `Profile` dùng `Permits(hrCompany,read)` cho hint. Không ghép vào app/inventory trước 10d.

## Bằng chứng thực chạy

Cwd `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`; các lệnh nặng có waitload trước, chạy tuần tự và được cấp quyền Docker/localhost. Go 1.27.3 darwin/amd64, Docker Desktop 29.9.2. Không dùng staging/production/mysql/redis.

- Test đọc với stub trả rỗng RED: `TestEmployeeReadScopesProjectionAndLiteralSearch`, `page: {Items:[] Total:}`, 5.400s. Sau SQL thật GREEN 6.227s.
- Test menu với stub RED: `TestEmployeeMenusRootEmptyDirectoryAndPermissionRevocation`, `Root empty directory menus: []`; `TestLinkedEmployeeMenuFitsSeventeenProbes`, `linked admin: []`, 6.341s.
- Test HTTP với stub đăng ký RED: `TestEmployeeReadRoutesDispatchClassificationAndItemsShape`, `registered 0 read routes, want 5`, 0.018s.
- `go test -race -tags integration -count=1 ./internal/modules/employee`: GREEN 12.133s; sau bổ sung ma trận role/read/F2/F3/audit Root: GREEN 14.875s.
- `go build ./...`, `go vet ./...`, `go vet -tags integration ./...`: exit 0.
- `go test -race -count=1 ./internal/...`: exit 0; employee 1.067s, authentication 9.663s, database 3.079s, mọi package qua.
- `go tool golangci-lint run`: exit 0, `0 issues.`
- `go test -count=1 ./test`: output `ok hrm/api-go/test 5.565s`; phiên đọc trạng thái cuối bị mất sau ngắt turn. Chạy lại để lấy exit code đầy đủ: exit 0, `ok hrm/api-go/test 4.992s`.
- `git diff --check`: exit 0.

## Đột biến

Overlay trong `/private/tmp/hrm-10b-mutants`, không đổi source repo.

| Đột biến | Lệnh (sau waitload, GOCACHE như trên) | Kết quả |
| --- | --- | --- |
| Thêm `OR TRUE` vào scope list | `go test -race -tags integration -count=1 -overlay /private/tmp/hrm-10b-mutants/scope.json ./internal/modules/employee -run '^TestEmployeeReadScopesProjectionAndLiteralSearch$'` | RED 7.867s; self nhận hai người, total 2 thay vì 1 |
| Bỏ menu settings | `go test -race -tags integration -count=1 -overlay /private/tmp/hrm-10b-mutants/menus.json ./internal/modules/employee -run '^TestEmployeeMenusRootEmptyDirectoryAndPermissionRevocation$'` | RED 6.548s; menu Root thiếu settings |

## Bao phủ và giới hạn

Scope HR/COO/lead/self; count/detail cùng tập list; deny thắng allow và revoke hiện ngay; F2/F3 chỉ self/HR; F1 không lộ F2; literal search; emoji và tiếng Việt tổ hợp round-trip; Root audit cả target có thật/vắng. Menu Root trên danh bạ rỗng, mọi role HR, roleless, runtime grant/revoke settings, linked admin đủ 17 probe. HTTP unit kiểm shape `{items:[]}`, static `me` và classification authenticated.

Chưa chạy browser/app M2 (10d). Các ca CROSS để tracker ở 10d theo ruling 82. `hrm-authorization-root-audit:144` là ca deny thắng HR allow, được kiểm bằng scope/deny/revoke và audit Root ở test Go mới. Sửa mô tả tham chiếu sai của lượt 10b khi đọc lại source ở 10d; không đổi kết quả test đã ghi. Chưa review độc lập; không tick plan.
