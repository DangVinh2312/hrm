# Báo cáo Task 10d — ghép M2

Trạng thái: DONE_WITH_CONCERNS — implementation M2 và kiểm tra yêu cầu đã hoàn tất; review độc lập còn chờ. Không push, không làm Task 11.

## Kết quả và commit

| Phần                             | Commit                  | Nội dung                                               |
| -------------------------------- | ----------------------- | ------------------------------------------------------ |
| 10e (đã có trước phiên tiếp tục) | `277711e`               | Session/me trong authentication, menu qua port         |
| 10a                              | `691d0a8`               | Nền employee và permission.Register dùng chung         |
| 10b                              | `19aeef4`               | Scoped reads, năm route đọc, menu                      |
| 10c                              | `8a7ed26`               | Bảy command và route ghi                               |
| 10d                              | Commit chứa báo cáo này | Ghép app, inventory, ma trận HTTP M2, tracker/tài liệu |

App tạo và đăng ký đúng pointer operations employee cùng setting/team; bind service đó vào 12 route employee. `authentication.SessionRoutes` nhận identity và menu port từ app, giữ DAG authentication không phụ thuộc authority/module. `SessionMenus` dùng single `Permits(account,read)` như composition TypeScript; `MeMenus` dùng employee.Menus. Trên danh bạ IAM rỗng, single permit của Root vẫn false còn menu me có accounts/reports (ADR-16).

Thêm 14 route vào `httpapi.MigratedRoutes`: 12 employee, auth/session và auth/me; các endpoint employee thuộc schedule/leave/attendance vẫn proxy. Test proxy dùng endpoint chưa chuyển `/api/hr/requests` thay cho session. Không đổi schema, ACL, declarations quyền, mã lỗi, dependency hoặc NestJS/web.

`m2_matrix_integration_test.go` tái sử dụng bộ kiểm ô của M1, thêm coverage guard cho 14 route M2 (cả authorize và authenticated). Bộ kiểm authorize ghép M1+M2; state snapshot thêm employee/identity/status/rate/object/audit. `m2_behavior_integration_test.go` kiểm menu grant/revoke cùng session, bound link tiến đúng một revision, revoke boundary, audit failure rollback hai login, F1/version/DB CHECK và scope self chuyển tại commit.

## Ma trận HTTP thực chạy

Mọi route: signed out, expired và suspended trả 401 đúng shape đóng; granted và Root trả đúng status/shape của contract. Các ô từ chối kiểm state/audit không đổi. Không có route nhận Idempotency-Key; ô không áp dụng có lý do trong bảng code.

| Route                                     | Không grant / deny                            | Boundary / fresh          | CSRF / Origin | Foreign / absent     | Invalid / extra        | Success   |
| ----------------------------------------- | --------------------------------------------- | ------------------------- | ------------- | -------------------- | ---------------------- | --------- |
| GET auth/session, auth/me, employees/me   | 200, menu/hint theo permission; roleless rỗng | n/a                       | n/a           | n/a                  | n/a (không nhận input) | 200       |
| GET employees                             | 200 rỗng / 200 rỗng                           | n/a                       | n/a           | lọc trong SQL / n/a  | 400 / n/a              | 200       |
| GET employee detail/identity              | 404 / 404                                     | n/a                       | n/a           | 404 / 404            | 400 / n/a              | 200       |
| GET employee leave-rates                  | 200 `{items:[]}` / tương tự                   | n/a                       | n/a           | rỗng / rỗng          | 400 / n/a              | 200       |
| POST employees                            | 403 / 403                                     | n/a / 403                 | 403 / 403     | n/a (company anchor) | 400 / 400              | 201       |
| PATCH employee, POST official/termination | 404 / 404                                     | n/a / không yêu cầu fresh | 403 / 403     | 404 / 404            | 400 / 400              | 200       |
| POST leave-rates, PUT identity            | 404 / 404                                     | n/a / 403                 | 403 / 403     | 404 / 404            | 400 / 400              | 201 / 200 |
| PUT employee account                      | 403 / 404                                     | 403 / 403                 | 403 / 403     | 404 / 404            | 400 / 400              | 200       |

409 nghiệp vụ/version/unique/tháng đóng và 503 khi audit lỗi được kiểm thêm ở module/app behavior. Audit Root cho read, audit mutation cùng giao dịch; F2 không đi vào F1/audit. Unit/integration/browser dùng dữ liệu giả, không chứng nhận provider production.

## Lệnh và kết quả thật của 10d

Go 1.27.3 darwin/amd64, Docker Desktop 29.9.2, Node 24.20.0, pnpm 12.3.4. Cwd Go là `apps/api-go`, `GOCACHE=/private/tmp/hrm-go-cache`; lệnh nặng có `bash ../../.superpowers/sdd/2026-11-05-go-gin-backend-migration/waitload.sh &&` trước và chạy tuần tự, được cấp quyền Docker/localhost. Browser từ root dùng waitload ở root. Không chạm mysql/redis, staging/production hoặc đọc secrets.

- Test inventory trước ghép: lần đầu lỗi build vì test import `net/http` chưa dùng (không tính RED hành vi); bỏ import rồi `go test -tags integration -count=1 ./internal/app -run '^TestM2RoutesAreMigrated$'` RED 0.080s, liệt kê đủ 14 route chưa migrated.
- Sau ghép, `go test -race -tags integration -count=1 ./internal/app`: GREEN 23.556s; sau thêm runtime menu grants/audit rollback/DB CHECK: GREEN 32.661s.
- Lượt cuối `go test -race -tags integration -count=1 -p 1 ./internal/app ./internal/modules/employee`: exit 0; app 38.279s, employee 16.424s. Gồm kiểm quyền login data không đăng ký anchor/account, không ghi account_id, Root single permit rỗng, và scope sau link/unlink.
- `pnpm test:browser`: exit 0, **30 passed (3.1m)**. Script build api-go trước; chạy toàn suite, không dùng filter sau `--`. Chỉ có cảnh báo Node về NO_COLOR/FORCE_COLOR, không có test skip/fail.
- `go build ./...`: exit 0.
- `go vet ./...`, `go vet -tags integration ./...`: exit 0.
- `go test -race -count=1 ./internal/...`: exit 0; app 2.242s, employee 1.058s, authentication 9.504s, database 3.091s, các package khác qua.
- `go tool golangci-lint run`: exit 0, `0 issues.` (tool được ghim trong go.mod, không dùng CLI global).
- `go test -count=1 ./test`: lượt đầu FAIL 4.528s, thiếu cạnh `app → authorization/keys`; bổ sung cạnh ở bảng/khối DAG, lượt sau FAIL 4.558s vì số đo cũ 241 khác 242. Cập nhật đúng số cạnh hiện tại, giữ rõ phần số đo F0 là lịch sử; lượt cuối exit 0, **4.514s**. Không nới test/rule.
- `gofmt -l internal/app internal/modules/employee internal/httpapi/inventory.go` (từ root dùng prefix apps/api-go): output rỗng. `git diff --check`: exit 0.
- Prettier check báo cáo 10d (với `--ignore-path /dev/null`), `apps/api-go/AGENTS.md` và plan: exit 0, `All matched files use Prettier code style!`. Tracker/DAG giữ cách căn bảng hiện có để tránh diff toàn bảng; đã kiểm diff và link liên quan, không tuyên bố chúng qua Prettier khi đang được ignore.

Các lệnh 10a/10b/10c, lỗi môi trường và RED/GREEN trước đó được giữ trong [báo cáo 10a](task-10a-report.md), [10b](task-10b-report.md), [10c](task-10c-report.md). Không biến các lượt FAIL/đột biến RED thành một tuyên bố full-suite luôn xanh.

## Bảng đột biến tổng hợp của phiên tiếp tục

Đột biến ở overlay ngoài repo; không ghi đột biến vào source thật. Mỗi lệnh có `-count=1`; integration có `-race -tags integration`.

| Phần | Đột biến                            | Test bắt lỗi                                                           | Kết quả                                         |
| ---- | ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| 10a  | Nới CCCD                            | TestIdentityDocumentAndTaxCodeGrammar                                  | RED 0.017s                                      |
| 10a  | Bỏ chặn tháng đóng                  | TestAssertSheetsOpenFromRefusesEveryClosedMonthFromTheDate             | RED 4.963s                                      |
| 10b  | Scope list thêm OR TRUE             | TestEmployeeReadScopesProjectionAndLiteralSearch                       | RED 7.867s, self thấy thêm người                |
| 10b  | Bỏ menu settings                    | TestEmployeeMenusRootEmptyDirectoryAndPermissionRevocation             | RED 6.548s                                      |
| 10c  | Bỏ self guard link account          | TestEmployeeLinkAccountBoundarySelfAndEpoch                            | RED 6.760s, đi tới effect                       |
| 10c  | Bỏ chặn rate trước hired_on         | TestEmployeeStatusChainRateAndClosedMonth                              | RED 5.096s                                      |
| 10d  | Xóa dòng GET employees khỏi ma trận | TestEveryMigratedAuthorizeRouteHasAFullMatrix, TestM2RoutesAreMigrated | RED 0.075s, served with no matrix               |
| 10d  | Bỏ CSRF trong DecodeCommand         | TestTheM2RoutesAnswerEveryCellOfTheMatrix                              | RED 12.330s, bảy write trả 200/201 và đổi state |

Lệnh 10d cụ thể:

```sh
go test -tags integration -count=1 -overlay /private/tmp/hrm-10d-mutants/matrix.json ./internal/app -run 'TestEveryMigratedAuthorizeRouteHasAFullMatrix|TestM2RoutesAreMigrated'
go test -race -tags integration -count=1 -overlay /private/tmp/hrm-10d-mutants/csrf.json ./internal/app -run '^TestTheM2RoutesAnswerEveryCellOfTheMatrix$'
```

10e đã có hai đột biến nil menu/nil dependency trong báo cáo lịch sử 10e; không chạy lại và không tính là đột biến mới của phiên này.

## Ruling, tài liệu và phần chưa làm

- Ruling 83 do người dùng chốt: mở rộng permission.Register cho leaveRate/employeeIdentity; bỏ SQL đăng ký riêng trong employee.
- Ruling 84 do người dùng chốt: giữ F1 hiện tại tương thích web, F2 chỉ qua identity; gateway projection vẫn key/code/fullName.
- Không có mâu thuẫn bảo mật/dữ liệu mới cần người dùng chốt. Cạnh DAG app → keys chỉ phục vụ kiểu trả MenuPort, keys là lá, test kiểm không vòng đã qua.
- Tracker ghi đợt đích CROSS: role/account administration ở M8; work-request workflow/effect ở M5; các file leave/attendance/report vẫn giữ M5/M6/M7. Matrix employee/team không có ca CROSS work-request; không thêm dòng giả cho nó. Fixture attendance ở các test menu được thay bằng SQL employee, không gọi attendance module.
- Plan chỉ tick Unicode và ba route bootstrap/menu đã có bằng chứng. Checkbox tổng hợp “Làm theo mẫu” còn trống vì bao gồm review độc lập; không tick mốc đánh giá/review độc lập, không mở Task 11.
- Đã sửa mô tả tham chiếu sai trong báo cáo 10b: hrm-authorization-root-audit:144 thực sự là ca deny thắng HR allow, đã được test scope/deny/revoke bao phủ.
- Báo cáo/progress nằm trong thư mục Git ignore; thêm đúng file được yêu cầu bằng git add -f. Lần đầu sandbox chặn index.lock; automatic approval review từng từ chối commit vì không thấy ủy quyền trong tệp đính kèm. Đã dẫn lại câu yêu cầu “commit chỉ các file của bước đó. Không push”, hệ thống xét lại và các commit được phép. Không còn action bị chặn.

Chưa chạy review độc lập M1/M2, không chạy full integration các package không sửa. Đã tự đọc lại diff/composition/callers và các invariant; không gọi đó là review độc lập. Test local/fake IdP không chứng nhận production. Không thêm tính năng ngoài M2.

## Chi phí

Không có metadata token hoặc chi phí tiền của phiên, nên không ước lượng thành số. Mốc log RED đầu 17:03:53 và mốc đồng hồ kiểm cuối 17:49:16 ngày 2026-11-09 (Asia/Ho_Chi_Minh), khoảng 45 phút 23 giây; đây là thời gian trôi qua gồm chờ phản hồi, tải máy, ngắt/restart và chạy tool, không phải thời gian CPU hay toàn bộ phiên lịch sử. Thời điểm commit cuối có thể muộn hơn mốc này.
