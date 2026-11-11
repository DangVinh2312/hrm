# Nợ test

Test được hoãn có chủ đích (ruling 101: chuyển tính năng trước, test nặng sau). Mỗi dòng là một hạng mục cụ thể; dòng chỉ được xóa khi test Go dự kiến đã có và đã chạy xanh, kèm mutant RED nếu cột rủi ro nêu một nhánh cụ thể.

## M7 report (Task 15f)

Đã có ở lát 15f: ma trận 12 route trong `apps/api-go/internal/app/m7_matrix_integration_test.go` (401, phiên hết hạn, bị khóa, không grant, deny, Root có audit `access.employee.report*`, query sai 400) và smoke `TestM7ReportsOverHTTP` (một nhân viên đi qua cả sáu report JSON và export, workbook đọc lại được, không grant ra trang rỗng hoặc 403, chưa đăng nhập ra 401). Lát L1a thêm `apps/api-go/internal/modules/report/report_integration_test.go` (oracle `attendanceoracle.LoadSheetRows`: report chấm công tháng mở bằng oracle trên mọi scope/range/page ở cả hai nhánh, nhánh được ghim bằng tracer; số liệu bằng endpoint bảng công; late-early và WFH theo ngày ghi nhận); lát L1b thêm ô XLSX bằng oracle, close ghi snapshot và hash của facts tương quan, tháng đã chốt phục vụ từ snapshot trong JSON và export, điều chỉnh công live/snapshot/format 1 (F-24). Các dòng dưới đây chưa có.

| Hạng mục | Nguồn TS spec:dòng | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| Ô `foreign` của ma trận: actor có scope hẹp (lead, nhân viên) đọc report và export | `hrm-report.integration-spec.ts:394` | `m7_matrix_integration_test.go`: thêm actor có grant `report*` theo `memberTeams`/`selfEmployee`, kiểm `total` và hàng chỉ thuộc scope | Ma trận hiện chỉ có NA cho `foreign`; scope lọc sai (đếm trước khi lọc, phân trang trước khi lọc) không bị bắt |
| Quy mô hàng nghìn nhân viên: report, facts, snapshot vẫn bằng oracle | `hrm-attendance-effects-equivalence.integration-spec.ts:388` | `report_integration_test.go` (tag riêng, chạy tay) | Lỗi chỉ xuất hiện ở nhánh set-based với nhiều hàng |
| Report phép: số dư D09 tại ngày cắt bằng endpoint số dư | `hrm-report.integration-spec.ts:291` | `report_integration_test.go`, so với `GET /api/hr/employees/:id/leave-balance` | `readLeave` dùng `leavecore.FactsSQL` theo năm của `asOn`; lệch số dư không bị bắt |
| Thâm niên từ kỳ trạng thái, tính cả ngày tuyển và ngày cắt | `hrm-report.integration-spec.ts:356` | `report_integration_test.go` | Smoke chỉ có một ca (2020-01-02 → 2026-03-01 = 6 năm 2 tháng 0 ngày) |
| Không report nào chứa CCCD, mã số thuế, năm sinh, liên lạc (JSON và file) | `hrm-report.integration-spec.ts:430`, `:873` | `report_integration_test.go`: dữ liệu identity đủ trường, quét body JSON và mọi entry của workbook | Một cột mới lỡ chọn trường identity sẽ lộ PII |
| Thu hồi role hoặc thêm deny có hiệu lực ở lần report sau; Root đọc tất cả và có audit | `hrm-report.integration-spec.ts:440` | `report_integration_test.go` | Ma trận chỉ kiểm deny có sẵn, không kiểm thu hồi giữa hai lần đọc |
| Tháng đã chốt lấy từ snapshot kể cả khi dữ liệu đổi sau close; tháng mở là live; snapshot không verify được thì 503 | `hrm-report.integration-spec.ts:484` | `report_integration_test.go` | `sheetTotals` đọc nhầm nguồn; `errMissingSnapshotRow` chưa có test |
| Cuộc đua: pending→approved không đếm hai lần; close chen giữa lần đọc không trộn trạng thái (JSON và export) | `hrm-report.integration-spec.ts:546`, `:909` | `internal/app/m7_race_integration_test.go`, cổng `m1World.gated` như M6 | Snapshot đọc không nhất quán trong một transaction |
| Birthday: 29/02 ra 28/02 năm thường, 29/02 năm nhuận | `hrm-report.integration-spec.ts:624` | `report_integration_test.go` | Nhánh năm nhuận trong SQL chép từ TS không được kiểm |
| Birthday: biên tháng, range qua năm, ngày tuyển và nghỉ việc | `hrm-report.integration-spec.ts:646` | `report_integration_test.go` | Range `2025-12..2026-01` và nhân viên đã nghỉ chưa có ca |
| Birthday: COO và HR thấy cùng hàng ngày/tháng, không có năm sinh, CCCD, MST | `hrm-report.integration-spec.ts:683` | `report_integration_test.go` | Chỉ có actor `hr.admin` trong smoke |
| Mỗi file export đọc lại có cùng hàng và số với JSON | `hrm-report.integration-spec.ts:745` | `report_integration_test.go` | Smoke chỉ kiểm workbook chứa mã nhân viên |
| Export chấm công khớp sổ phép và snapshot tháng đã chốt | `hrm-report.integration-spec.ts:767` | `report_integration_test.go` | Như trên, cho tháng đã chốt |
| Chỉ COO, HR, Root nhận file | `hrm-report.integration-spec.ts:808` | `report_integration_test.go` với actor COO, lead, nhân viên, CEO | Ma trận chỉ có `hr.admin`, không grant, deny, Root |
| Quyền bị thu hồi sau khi đọc và trước khi giao thì không có file | `hrm-report.integration-spec.ts:852`; `hrm-excel.spec.ts:360` | Test service với hook giữa `renderXLSX` và `Permits` (cần điểm chèn cho test) hoặc cổng khóa | Lần kiểm lại `Permits` trong `Service.Export` có thể bị xóa mà không test nào đỏ |
| Thứ tự export: query, render ngoài transaction, kiểm lại quyền, giao | `hrm-excel.spec.ts:351` | Test service đếm transaction và số lần `Permits` | Render trong transaction giữ fence lâu |
| Vượt ngân sách dòng: 422, không cắt, không render | `hrm-excel.spec.ts:372`; `hrm-report-export-http.integration-spec.ts:134` | `report_integration_test.go`: hạ `export.maxRows` bằng setting, 3 nhân viên, maxRows 2 | So sánh `total > MaxRows` có thể thành `>=` mà không đỏ |
| Đúng 5000 dòng là file đủ; JSON cùng total | `hrm-report-export-http.integration-spec.ts:90` | Như trên với setting hạ thấp; bản 5000 dòng thật ở test đo | Biên đúng bằng ngân sách |
| Vượt ngân sách byte: 422, cùng dữ liệu dưới ngưỡng là file | `hrm-report-export-http.integration-spec.ts:104` | `report_integration_test.go`: hạ `export.maxBytes` | Nhánh byte của `renderXLSX` qua HTTP chưa có |
| 403 đến trước 422: không grant thì nhận lỗi quyền, không nhận lỗi kích thước | `hrm-report-export-http.integration-spec.ts:150` | `m7_matrix_integration_test.go` hoặc `report_integration_test.go` với maxRows thấp và actor không grant | Hiện không grant đọc trang rỗng (total 0) nên không chạm 422; nếu scope đổi thành đếm toàn bảng thì lộ kích thước |
| Client đóng socket khi render: không kiểm lại quyền, không rò | `hrm-report-export-http.integration-spec.ts:170`; `hrm-excel.spec.ts:472` | Test service với ctx hủy giữa các bước, đếm `Permits` | Nhánh `delivered=false` chưa có test |
| Client đóng socket khi đọc dữ liệu: không render | `hrm-report-export-http.integration-spec.ts:213` | Như trên | Như trên |
| Đối chứng: client ở lại nhận file và quyền được kiểm lại đúng một lần | `hrm-report-export-http.integration-spec.ts:257` | Như trên | Như trên |
| Đo latency query và render ở 5000 dòng | `hrm-report-export-measure.integration-spec.ts:72` | Test đo có tag riêng, chạy tay; brief 15f cấm chạy | Không biết export 5000 dòng có vượt deadline 3000 ms của runner không |
| WFH `overLimit` theo giới hạn hiện hành, kể cả tháng đã chốt | `hrm-setting-behavior.integration-spec.ts:98` | `report_integration_test.go` | `readWfh` dùng `wfhDays > limit`; biên `=` chưa có ca |
| Span theo `report.maxMonths` | `hrm-setting-behavior.integration-spec.ts:181` | `report_integration_test.go`: hạ setting, span hợp lệ theo validator nhưng quá setting là 400 | Nhánh `checkSpan` ở repository chưa có ca HTTP |
| Số lần đọc setting: report WFH 1, leave 0, export 2 | `hrm-setting-behavior.integration-spec.ts:209` | Test đếm query trên runner Go | Đọc setting thừa trong transaction |
| Mutant RED cho lát 15f | Không có nguồn TS | Overlay `go test -overlay`: (1) bỏ `Permits` trong `Service.Export`; (2) `>` thành `>=` ở so sánh `MaxRows`; (3) đổi ngưỡng `EffectsSetBasedMinRows`; (4) bỏ scope trong SQL birthday/seniority; (5) bỏ kiểm ký tự của `WriteBinary`; (6) đọc snapshot cho tháng mở | Chưa chạy mutant nào. Dự kiến (1) đỏ ở ô `no grant`/`deny` của export (sẽ ra 200 thay vì 403), (4) đỏ ở ô `no grant` của JSON và smoke (trang phải rỗng khi có dữ liệu), (5) đỏ ở `TestAnAttachmentCarriesItsTypeNameAndLengthOrIsRefusedBeforeAByte`; (2), (3), (6) chưa có test nào sẽ đỏ |
| Root export khi bảng `employee` rỗng nhận 403, JSON trang rỗng | Suy ra từ `report.service.ts:102` | `m7_matrix_integration_test.go` hoặc `report_integration_test.go` | Hành vi chỉ suy ra từ code ở cả hai runtime |
| Tách file test theo phương án A (ruling 101) | Khảo sát 2026-11-10 | `internal/app/{matrix,world,race}_integration_test.go` | Tên `m1_*` sai nghĩa; làm sau cùng |

## M8 nền (Task 16a)

Đã có ở lát 16a: unit bảng `grant` (`grant_set_helper_test.go`, `role_grant_helper_test.go`: so sánh tập, cắt cụt, Root/kind lạ, cặp chưa đăng ký, khóa role, vector digest TS), integration `grant_facts_repository_integration_test.go` (đích nhỏ hơn được, đích lớn hơn và đích có rule gắn user bị từ chối, đọc bị cắt báo `truncated`), integration `authority_admin_command_integration_test.go` (không grant, ngoài boundary, không fresh bị từ chối; đích Root không tới được; IAM trong boundary chạy và ghi audit, obligation của `Reaches(..., fulfil)`; Root chạy và có audit; command chưa đăng ký bị từ chối; admin command không có `fresh@1` không đăng ký được). Chín đột biến overlay RED, một đột biến sống đã được thay bằng ca unit (`task-16a-report.md`). Các dòng dưới đây chưa có.

| Hạng mục | Nguồn TS spec:dòng | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| Thứ tự key của parameters và grant trùng không đổi kết quả (RFC 8785 của jsonb thật, gồm số `1.0`/`1`) | `grant-set.spec.ts:68` | `grant_facts_repository_integration_test.go`: role có rule parameters khác thứ tự key, so `Read` của hai account | `Read` canonical hóa bằng `jsontext.Value.Canonicalize`; release hiện không có template có tham số nên nhánh này chưa chạm dữ liệu thật |
| Property: `within` đúng bằng bao hàm tập theo tuple | `grant-set.spec.ts:122` | `grant_set_helper_test.go` với `testing/quick` hoặc fuzz | Bảng ca có thể sót tổ hợp |
| Mutant: `Detail` dùng plan khác (ví dụ plan của `Reaches`) | Không có nguồn TS | Overlay trên `authority_admin.go` | Chưa chạy |

## Task 16b

Đã có ở lát 16b: unit `internal/modules/role/role_validator_test.go` (key runtime, body create/update đúng member, nhãn trim và 120 code point, 300 grant, trùng, digest, catalog 142 cặp và sha256 trùng `roleCatalog` của TS, capabilities trùng TS); integration `role_command_repository_integration_test.go` (login `authority` không sửa nhãn, không xóa, không thêm rule cho role code; `lockRole` không thấy role code; IAM có hơn `grant.MaxFactRows` rule bị từ chối cả với role rỗng, Root bỏ qua); ma trận 5 route ở `internal/app/m8_matrix_integration_test.go` (401 ba kiểu, không grant, thiếu boundary của update/delete, deny, không fresh, CSRF, Origin, vắng, input sai, member lạ, IAM và Root thành công có audit) và smoke `TestM8RolesOverHTTP` (Root tạo, đọc digest, sửa, digest cũ 409; role code 400; IAM tạo grant ngoài tập 403, sửa/xóa role lớn hơn 404, thêm grant ngoài tập 403; cặp chưa đăng ký, permission lạ, `document`, `approvals` thiếu `decideFinal` 400; role có deny 409 với Root; role đang giữ 409; quyền của Root 404 có audit obligation; audit không ghi được thì 503 và không còn dấu vết). Sáu đột biến overlay RED (`task-16b-report.md`). Các dòng dưới đây chưa có.

| Hạng mục | Nguồn TS spec:dòng | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| Root đặt mọi cặp của catalog trừ `document` vào một role | `hrm-role-write.integration-spec.ts:180` | `m8_matrix_integration_test.go` hoặc integration role | Một cặp catalog hợp lệ bị lệnh từ chối mà không ai thấy |
| Tập actor có template khác của permission đã giữ, có deny hoặc rule gắn user: tạo role bị 403 | `hrm-role-write.integration-spec.ts:226` | Smoke M8 với actor riêng | Smoke chỉ có ca permission hoàn toàn không giữ |
| Property: actor chỉ giữ cặp P không tạo được role với cặp khác | `hrm-role-write.integration-spec.ts:258` | Integration lặp qua catalog | Bảng ca có thể sót cặp |
| Lệnh tự kiểm lại key, `document`, >300 grant, `approvals` khi service bị bỏ qua | `hrm-role-write.integration-spec.ts:289`, `:316` | Integration gọi `authority.Execute` thẳng với input không qua `parseCreate`/`Service` | Xóa `checkCatalog`/`IsRuntimeRoleKey` trong `commands` không đỏ (service vẫn chặn) |
| Key đã có: 409, không đổi gì | `hrm-role-write.integration-spec.ts:331` | Smoke M8 | Nhánh `insertRole` false chưa có ca |
| Tối đa 100 role runtime, xóa giải phóng chỗ; hai create đua chỗ cuối | `hrm-role-write.integration-spec.ts:343`, `:356` | Integration role + cuộc đua có cổng | `>=` thành `>` ở `MaxRuntimeRoles` không đỏ |
| Update là diff: rule giữ nguyên `rule_id`, rule bỏ bị xóa, rule mới thêm; nhãn tính trong digest | `hrm-role-write.integration-spec.ts:381`, `:419` | Integration role đọc `rule_id` trước/sau | Update xóa hết rồi chèn lại vẫn xanh |
| Hai update cùng digest đua: một thắng, một 409; update đua delete không để rule mồ côi | `hrm-role-write.integration-spec.ts:447`, `:557` | Cuộc đua qua route, cổng `m1World.gated` | Khóa neo `role_anchor` bị gỡ không đỏ |
| Update có hiệu lực ở request kế tiếp của người giữ role | `hrm-role-write.integration-spec.ts:479` | Smoke M8 | Cache grant (nếu có) không bị bắt |
| Xóa bị 409 với tài khoản giữ role ở mọi state; 409 khi `record_exception` còn trỏ tới role | `hrm-role-write.integration-spec.ts:524`, `:539` | Smoke M8 | Chỉ có ca tài khoản active giữ role |
| Xóa bỏ hết rule và audit `grantCount` | `hrm-role-write.integration-spec.ts:510` | Integration role đọc `safe_metadata` | Audit sai số grant không bị bắt |
| IAM gặp role có deny hoặc rule có tham số: 404 | `hrm-role-write.integration-spec.ts:607` | Smoke M8 | Chỉ có ca Root (409) |
| Root không fresh bị từ chối mọi lệnh role | `hrm-role-write.integration-spec.ts:655` | Ô ma trận riêng cho Root stale | Ma trận chỉ có IAM stale |
| `hr.admin` không có grant ghi role mặc định | `hrm-role-write.integration-spec.ts:677` | Smoke M8 với actor chỉ có code role | Ô `noGrant` dùng actor không role, không phải `hr.admin` |
| Audit lỗi rollback update và delete | `hrm-role-write.integration-spec.ts:687` | Smoke M8, `REVOKE INSERT ON audit_outbox FROM product_authority` | Chỉ có ca create |
| `role.read` theo grant: người giữ runtime thấy, thu hồi có hiệu lực lần sau | `hrm-role-matrix.integration-spec.ts:152` | Smoke M8 | Chỉ có `hr.admin` và Root |
| Audit `readPermissions`: target chỉ có ở dòng Root | `hrm-role-matrix.integration-spec.ts:227` | Smoke M8 đọc `safe_metadata` | Ma trận chỉ đếm kind |
| `readPermissions` liệt kê boundary: permission, key, version, `seeded` | `hrm-role-matrix.integration-spec.ts:256` | Smoke M8 | Shape boundary chỉ kiểm bằng regex rộng |
| Capabilities chỉ từ rule allow, digest theo toàn bộ rule | `hrm-role-matrix.integration-spec.ts:298` | Smoke M8 với role có deny | Chỉ có ca role toàn allow |
| `truncated` của `role.read` (200 role, 500 rule) và `readPermissions` (200 role, 5000 rule); một câu lệnh | `hrm-role-truncation.integration-spec.ts:76`, `:107`, `:129`, `:161`, `:193` | Integration role | Nhánh cắt và cờ `truncated` chưa có ca |
| Dữ liệu thỏa `custom.` ⇔ runtime; role runtime không đổi hash/sync | `hrm-role-runtime-assumptions.integration-spec.ts:34`, `:55`, `:78`; `role-runtime-constraint.integration-spec.ts:65`, `:92`, `:99`, `:144`, `:160` | Integration `database`/`manifest` | CHECK và trigger chỉ được kiểm gián tiếp qua lệnh |
| COO và `hr.employee` không có menu `roles` | `hrm-menu-role.integration-spec.ts:38` | Thêm assertion vào vòng lặp `employee_menu_integration_test.go:30` (đã duyệt `nil`, `hr.employee`, `hr.admin`, `hr.coo` nhưng chỉ kiểm `settings`) | Cấp nhầm `role.read` cho `hr.coo` hay `hr.employee` không đỏ ở test menu (chỉ release ghim bằng hash) |
| Catalog: mọi cặp ứng viên khác bị validator từ chối; catalog vượt 500 bị từ chối | `role-catalog.spec.ts:48`, `:78` | `role_validator_test.go` với declarations giả | Nhánh `maxCatalogPairs` chưa có ca |
| Danh sách cặp rủi ro đóng; mọi permission của release được phân loại | `role-risk.spec.ts:158`, `:165`, `:211` | `role_validator_test.go` | Permission mới không bị buộc phân loại |
| IAM có hơn `grant.MaxFactRows` rule bị từ chối qua HTTP | Checklist 16b | Smoke M8 (cần xem engine có đọc nổi 20001 rule không) | Chỉ có ca mức repository |
| Đột biến còn lại: bỏ audit ở update/delete, bỏ kiểm `references`, bỏ kiểm rule deny/tham số, bỏ kiểm nhãn trong lệnh | Không có nguồn TS | Overlay trên `role_command_repository.go` | Chưa chạy; kiểm deny/tham số dự kiến đỏ ở smoke (role có deny), `references` dự kiến đổi 409 thành 503 (FK) |
| Thứ tự grant theo byte trùng `localeCompare` cho mọi permission/template của release | Review 16b Minor 1 | `role_validator_test.go` duyệt `release.json`; sửa comment ở `role_read_repository.go` (`distinctGrants`) | Action mới lệch hoa/thường đổi thứ tự hiển thị mà không test nào đỏ |
| Ô từ chối của `readPermissions` ghi đúng một dòng obligation (không nhiều hơn); ô 401 không ghi | Review 16b Minor 2 | `m8ReadAudited` trong `m8_matrix_integration_test.go` | Hiện loại mọi dòng `access.readPermissions` khỏi so trạng thái |
| Ca HTTP chạm nhánh `managed_by='runtime'` của `lockRole` (role code có key `custom.*` giả lập); rollback khi audit lỗi ở update/delete; khôi phục quyền `audit_outbox` bằng `t.Cleanup` | Review 16b Minor 3, 4 | Smoke M8 | Chỉ có ca repository và ca create |

## Task 16c1

Đã có ở lát 16c1: unit `internal/administration/administration_input_helper_test.go` (role key 1..96 byte, body provision, provision không issuer là 503 ở đầu service, trước `CanonicalLoginEmail`/`AllowsAll`, id không chuẩn bị 403 trước khi hỏi authority), `internal/app/app_test.go` (`provisioningIssuer`: 0, 1, 2 provider); integration `account_role_repository_integration_test.go` (suspend tăng `auth_epoch`, reactivate tài khoản chưa suspend là 409 và không đổi gì, reactivate tăng epoch lần nữa; `roleRules`, `roleExists`, `holding`, insert/delete `user_role`; email trùng là 409); ma trận 6 route `m8AccountMatrix` ở `internal/app/m8_matrix_integration_test.go` (401 ba kiểu, không grant, thiếu boundary, deny, không fresh, CSRF, Origin, vắng, id/input sai, member lạ, IAM và Root thành công có audit; list không grant/deny là trang rỗng) và smoke `TestM8AccountsOverHTTP` (tự tác động 403 ở suspend/assign; IAM với đích Root 404; Root với chính mình 404 có audit absent; đích lớn hơn 404 ở suspend/reactivate/assign/revoke; role ngoài tập 404; Root gán role lớn hơn tập của hr thành công; id chữ hoa 403 với IAM và Root; reactivate tài khoản active 409; thu hồi role cuối 409; gán role đang giữ 409; suspend tăng epoch và phiên của đích thành 401; provision email trùng 409 sau khi hạ chữ; provision role vắng, role lớn hơn, actor bị deny đều 404 và không tạo tài khoản). Các dòng dưới đây chưa có.

| Hạng mục | Nguồn TS spec:dòng | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| Gán/thu hồi có hiệu lực ở request kế tiếp của đích; Root gán role code, event có cờ Root, không ghi email/nhãn | `product-account-role.integration-spec.ts:144`, `:173`, `:189` | Smoke M8 đọc quyền của đích và `safe_metadata` | Audit Root/IAM chỉ được đếm theo kind |
| IAM giữ đủ rule của role code thì gán được | `product-account-role.integration-spec.ts:216` | Smoke M8 | Chỉ có ca `hr.admin` mà actor giữ |
| Tự tác động ở revoke; revision không đổi khi 403 | `product-account-role.integration-spec.ts:228` | Smoke M8 | Chỉ có suspend và assign |
| Root, id vắng, id ngoài phạm vi cùng "not found" cho revoke | `product-account-role.integration-spec.ts:238` | Smoke M8 | Chỉ có ô `absent` của ma trận |
| Id không chuẩn là 403 trước khi tra phiên trong DB (secret không tồn tại vẫn 403); id rỗng, có dấu cách, `../etc` | `product-account-role.integration-spec.ts:255`, `account-role.spec.ts:61` | Smoke M8 với secret giả | Unit `TestANonCanonicalTargetIsRefusedFirst` có ca này ở mức hàm; qua HTTP chỉ có phiên thật |
| Role key không phải chuỗi, rỗng, > 96 byte; 48 ký tự hai byte qua | `product-account-role.integration-spec.ts:265`, `account-role.spec.ts:70`, `:90` | Có một phần ở unit helper và ô `invalid`; thiếu ca qua HTTP với 48 ký tự hai byte | Đếm rune thay byte không đỏ qua HTTP |
| Role vắng là 404 cho assign và revoke; thu hồi role chưa giữ là 409 | `product-account-role.integration-spec.ts:274` | Smoke M8 | Chỉ có ca role ngoài tập (404) và role đang giữ (409) |
| (c) role có rule khác template, có tham số, có deny; actor có deny hoặc rule gắn user; đọc bị cắt; role > 300 rule | `product-account-role.integration-spec.ts:289`, `:304`, `:330`, `:346`, `:359` | Integration administration + smoke | Chỉ có ca permission hoàn toàn ngoài tập |
| (d) đích có deny hoặc rule gắn user; tập bằng/nhỏ hơn | `product-account-role.integration-spec.ts:381`, `:396`; `product-account-grant-scope.integration-spec.ts:86`, `:102`, `:113`, `:128`, `:140`, `:161`, `:177`, `:187`, `:221`, `:253` | Smoke M8 theo bảng lệnh | Chỉ có ca đích giữ permission ngoài tập |
| Trần 20 role mỗi tài khoản | `product-account-role.integration-spec.ts:407` | Integration administration | `>=` thành `>` ở `MaxAccountRoles` không đỏ |
| Tài khoản pending/suspended vẫn nhận và mất role | `product-account-role.integration-spec.ts:443` | Smoke M8 | Chỉ có đích active |
| Root cũng không thu hồi được role cuối | `product-account-role.integration-spec.ts:465` | Smoke M8 | Chỉ có ca IAM |
| Boundary/fresh với Root; release không cấp mặc định | `product-account-role.integration-spec.ts:485`, `:500`, `:514` | Ô ma trận cho Root stale | Ma trận chỉ có IAM stale |
| F1: caller không tới đích trả lời dưới fence chia sẻ, không chờ fence độc quyền; đích vắng/Root không tăng revision; bước độc quyền quyết định lại khi grant bị thu hồi giữa chừng | `product-account-role.integration-spec.ts:540`, `:586`, `:615`; `hrm-admin-precheck.integration-spec.ts:121`, `:132`, `:161`, `:216` | Integration app với holder fence độc quyền | Bỏ `ReachesTarget` đỏ qua state (đã chạy ở vòng sửa 16c1: ô `deny`/`absent` của 4 lệnh trên tài khoản khác và smoke "an IAM suspend of Root" thấy revision/obligation đổi), nhưng chưa test nào đo việc caller không tới đích không chờ fence độc quyền |
| Audit lỗi rollback toàn lệnh (assign, revoke, suspend, reactivate, provision; IAM và Root) | `product-account-role.integration-spec.ts:648`; `product-account-reactivate.integration-spec.ts:249`; `product-account-provisioning.integration-spec.ts:816` | Smoke M8, `REVOKE INSERT ON audit_outbox FROM product_authority` | Chưa có ca |
| Đua: hai assign cùng cặp, assign với revoke, assign với suspend; khóa dòng đích trước facts | `product-account-role.integration-spec.ts:678`, `:697`, `:715`, `:734` | Cuộc đua có cổng `m1World.gated`; holder khóa `app_user` | Bỏ `lockAccount` không đỏ |
| Provision: definer, probe privilege, cột email chỉ ASCII; Root chỉ cần fresh; audit có id không có email; IAM cần cả hai grant, boundary, fresh, role trong tập | `product-account-provisioning.integration-spec.ts:379`, `:416`, `:507`, `:564`, `:606`, `:725` | Integration `database` + smoke M8 | Chỉ có ma trận và ba ca 404 |
| Đăng nhập Google đầu tiên của email đã cấp; enrollment hỏng/hết hạn; hai đăng nhập đua; callback phát lại | `product-account-provisioning.integration-spec.ts:836`, `:893`, `:958`, `:991` | Thuộc OIDC (`internal/authentication`), kiểm lại với tài khoản do Go cấp | Tài khoản do Go cấp chưa đi qua luồng kích hoạt |
| Reactivate: tài khoản có binding thành active, chưa đăng nhập về pending giữ enrollment, binding/provider tắt để pending; pending là 409; tự tác động 403 trước kiểm state; ma trận actor; đua hai reactivate; definer chỉ `authority`, Root không bao giờ reactivate được | `product-account-reactivate.integration-spec.ts:82`, `:119`, `:137`, `:144`, `:160`, `:177`, `:207`, `:236`, `:275`, `:299` | Smoke M8 + integration administration | Chỉ có ca active 409 và ma trận |
| Root suspend: chính mình, vắng, id sai không lộ gì; IAM cần grant và boundary, Root vô hình với IAM | `product-root-suspend.integration-spec.ts:25`, `:86` | Smoke M8 | Có một phần (Root với chính mình, IAM với Root); thiếu id sai của Root với vắng |
| Controller: port nhận secret, id, key; "not found" là 404; CSRF/Origin trước khi parse body | `account-role.spec.ts:43`, `:55`, `:61` | Unit controller với port giả | Chỉ kiểm qua ma trận HTTP |
| Deny thắng allow đi qua `Administer` (không chỉ ở precheck) | Checklist 16a Minor | Smoke với actor có grant và deny chỉ ở bước độc quyền | Ô `deny` của ma trận dừng ở `ReachesTarget` |
| Đột biến còn lại: bỏ `lockAccount`, bỏ append trong khung, bỏ `WithinActor` ở reactivate (đã RED ở 16c1: bỏ kiểm UUID chuẩn, đảo `Detail`/tự tác động, bỏ `WithinActor` ở suspend và ở assign/revoke, bỏ so role, bỏ `ReachesTarget`) | Không có nguồn TS | Overlay trên `admin_account_command_service.go`, `account_command_service.go` | Bỏ `lockAccount` dự kiến không đỏ (cần cuộc đua) |

## Task 16c2

Đã có ở lát 16c2: unit `internal/administration/administration_input_helper_test.go` (grammar key/version của boundary, version trong path, body email, 503 khi không đúng một provider ở `changeEmail`/`resetGoogleBinding` còn `resetMfa` thì không, id không chuẩn 403 trước email sai 400, boundary sai 400 trước authority); integration `account_boundary_repository_integration_test.go` (`boundaryPackage` của `identityAdministration@1` và gói vắng/sai version; `boundaryBindings`; insert cả gói, insert lặp là 409; `deleteRuntimeBoundary` không xóa dòng có `seed_owner`; `identityOperation`: vắng, Root ở cả ba hàm là không tìm thấy và transaction đi tiếp; không có yếu tố thứ hai, email trùng, email không đổi, không có email để mời là 409; issuer hàm từ chối (22023) và EXECUTE bị thu hồi (42501 khác) là lỗi hệ thống; reset MFA tăng epoch); ma trận 5 route trong `m8AccountMatrix` (`internal/app/m8_matrix_integration_test.go`) và smoke `TestM8BoundariesAndIdentityOverHTTP` (tự tác động 403 ở bind, unbind, mfa, email, google; IAM với Root 404; Root với chính mình 404 có audit absent ở bind, mfa, email, google; đích lớn hơn 404 ở bind và mfa, chọn đích để bỏ `WithinActor` thì ra 200; id chữ hoa 403 ở bind, mfa, email; actor không bind đủ gói 403, cả khi đích đã bind; bind trùng 409; unbind chưa bind 409; mfa không có yếu tố 409; email trùng 409 sau khi hạ chữ; google không có email 409; ba lệnh identity tăng epoch đúng 1 và phiên của đích thành 401, email mới hạ chữ và `email_verified=false`, google về `pending` và tắt binding; hai provider là 503 ở email/google, mfa vẫn 200). Các dòng dưới đây chưa có.

| Hạng mục | Nguồn TS spec:dòng | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| Gói đúng 9 / 3 permission, mọi entry `required`, fresh, không release grant, cặp identity trong registry high-risk | `account-boundary.spec.ts:40`, `:49`, `:54`; `account-identity-operation.spec.ts:30`, `:39`, `:53`, `:69`, `:76`, `:84`, `:92` | Unit trên `declarations` | Đổi declarations không đỏ ở test nào của lát này |
| Controller: port nhận secret, id, ref/email; "not found" là 404; CSRF/Origin trước parse; ref/email sai không tới port; key/version lớn nhất qua | `account-boundary.spec.ts:69`, `:111`, `:124`, `:134`, `:146`, `:182`; `account-identity-operation.spec.ts:128`, `:142`, `:149`, `:160` | Unit controller với port giả | Chỉ kiểm qua ma trận HTTP và unit helper |
| Bind/unbind IAM: 9 dòng runtime một INSERT, một audit; Root có cờ Root, không email; admin đầu tiên chỉ Root bind; tài khoản suspended/pending; gói quyết định bảy permission; bind không cấp quyền | `product-account-boundary.integration-spec.ts:218`, `:264`, `:283`, `:300`, `:317`, `:334`, `:370` | Smoke M8 đọc `user_boundary`, `safe_metadata` | Audit chỉ được đếm theo kind; chỉ bind `identityAdministration@1` |
| Root, id vắng, id ngoài phạm vi cùng "not found" ở unbind; id không chuẩn trước mọi query | `product-account-boundary.integration-spec.ts:391`, `:418` | Smoke M8 | Có ô `absent` và id chữ hoa ở bind; thiếu ở unbind |
| (d) đích bằng/nhỏ hơn, có deny hoặc rule user, đọc bị cắt ở bind/unbind; 400 đến sau (a)(b)(d) | `product-account-boundary.integration-spec.ts:441`, `:452`, `:468`, `:514` | Smoke M8 | Chỉ có đích giữ permission ngoài tập ở bind |
| (e) boundary deprecated/retired, rỗng, có entry optional là 400; `hrAdministration@1` bind được; gói chồng binding seed là 409; actor bind dưới key khác không giữ gói | `product-account-boundary.integration-spec.ts:488`, `:525`, `:541`, `:571`, `:591` | Integration administration (fixture boundary riêng) + smoke | Chỉ có key vắng và version sai (400), gói `identityAdministration@1` |
| Unbind: dòng seed không bao giờ bị xóa qua HTTP; login `authority` không xóa/sửa/tạo dòng seed; unbind không cần giữ gói | `product-account-boundary.integration-spec.ts:624`, `:656`, `:700` | Smoke M8 + integration `database` | Có ở mức repository (`deleteRuntimeBoundary`); chưa qua HTTP |
| Boundary/fresh với Root; release không cấp mặc định | `product-account-boundary.integration-spec.ts:722`, `:735`, `:748` | Ô ma trận cho Root stale | Ma trận chỉ có IAM stale/unbound |
| F1 ở bind/unbind | `product-account-boundary.integration-spec.ts:777`, `:817`, `:834` | Như F1 của 16c1 | Như 16c1 |
| Audit lỗi rollback cả lệnh (bind, unbind, ba lệnh identity; IAM và Root) | `product-account-boundary.integration-spec.ts:866`; `product-identity-operation.integration-spec.ts:530` | Smoke M8, `REVOKE INSERT ON audit_outbox` | Chưa có ca |
| Đua: hai bind, bind với unbind, bind với suspend; thứ tự khóa fence → đích → facts → binding → ghi → audit | `product-account-boundary.integration-spec.ts:894`, `:912`, `:929`, `:947` | Cuộc đua `m1World.gated`, holder khóa | Bỏ `lockAccount` không đỏ |
| Sync không đụng binding runtime: release sau thêm binding seed cho tài khoản khác thì dòng runtime không đổi; `RemoveBoundaryBindings` nêu đúng dòng runtime không xóa dòng đó | `product-account-boundary.integration-spec.ts:1008` | Integration `manifest` (mẫu `TestUpgradeDoesNotOverwriteRuntimeBoundaryBinding`) | Seed trùng dòng runtime bị `collision` và `definition_in_use` đã có ở `reconcile_integration_test.go:186`; hai nhánh còn lại chưa có ca (không test nào dùng `RemoveBoundaryBindings`) |
| Ba lệnh identity theo bảng lệnh: Root có cờ Root, id-only; IAM với grant/boundary/fresh; ma trận actor (binding của permission identity khác, stale); đọc bị cắt; id không chuẩn cả khi email sai; Root/vắng; (a); (d) gồm thu hồi grant thấy ngay, deny/rule user/template khác | `product-identity-operation.integration-spec.ts:174`, `:204`, `:233`, `:257`, `:279`, `:296`, `:320`, `:331`, `:349` | Smoke M8 theo bảng ba lệnh | Đích lớn hơn chỉ ở `resetMfa`; id chữ hoa ở mfa và email (không google); `safe_metadata` chưa đọc |
| changeEmail: account pending chuyển lời mời, active không có lời mời; email sai 400 trước transaction; đích lớn hơn là 404 không phải 409 | `product-identity-operation.integration-spec.ts:384`, `:414`, `:463` | Smoke M8 | Chưa kiểm enrollment sau đổi email |
| resetMfa xóa factor TOTP, recovery code đứng một mình cũng tính; resetGoogleBinding giữ suspended; một revision mỗi thành công, không tốn khi từ chối; gói identity bind/unbind bằng lệnh sẵn có | `product-identity-operation.integration-spec.ts:478`, `:508`, `:570`, `:594` | Smoke M8 | Chỉ có recovery code, đích active |
| Đua identity: hai changeEmail cùng/khác địa chỉ, hai resetMfa, hai resetGoogleBinding, đan với suspend/reactivate/assign; P0002/42501 sau lookup; 409 rollback cả savepoint | `product-identity-operation-concurrency.integration-spec.ts:87`, `:102`, `:115`, `:146`, `:252`, `:297` | Cuộc đua có cổng | Nhánh savepoint chỉ kiểm ở repository (gọi thẳng hàm với Root/vắng), không qua đổi kind giữa lookup và hàm |
| Lỗi hệ thống: EXECUTE bị thu hồi (không absent, không ghi gì), lời mời ghi actor, provider bị hàm từ chối không audit/revision, email không ASCII, ba bản kiểm grant-within khớp | `product-identity-operation-faults.integration-spec.ts:71`, `:102`, `:144`, `:170`, `:183` | Smoke M8 + integration | EXECUTE thu hồi và 22023 chỉ kiểm ở repository |
| MFA/OIDC end-to-end sau lệnh: tài khoản tự đăng ký lại MFA; binding cũ bị từ chối, Google mới khớp email kích hoạt một lần; `email_verified` thiếu/false; changeEmail của pending/active với đăng nhập; đua đăng nhập với reset | `product-identity-operation-mfa.integration-spec.ts:66`; `product-identity-operation-oidc.integration-spec.ts:118`, `:152`, `:175`, `:202`, `:228` | Integration `internal/authentication` trên tài khoản do Go đổi | Chỉ kiểm phiên cũ thành 401 |
| Hàm DB: chỉ `authority` được EXECUTE; P0002/42501 với active/suspended; email trùng 23505/không đổi 55000/sai 22023; enrollment pending; reset binding giữ suspended, issuer tắt; reset MFA chỉ một lần tăng epoch; `authority` không ghi trực tiếp | `product-identity-operations.integration-spec.ts:119`, `:140`, `:184`, `:205`, `:243`, `:266`, `:290`, `:318`, `:333`, `:366`, `:383`, `:392`, `:407` | Integration `internal/database` | Hàm do migration Go dựng, chưa có test riêng |
| Probe đặc quyền của ba hàm identity ở trạng thái cuối: thân hàm, owner, `SECURITY DEFINER`, `search_path`, ACL và EXECUTE cho login khác `authority` bị làm lệch thì runtime không khởi động; ràng buộc ASCII của `app_user` và `oidc_email_enrollment` (migration `1792108800008`) từ chối email ngoài ASCII (23514) | `product-identity-operations-upgrade.integration-spec.ts:138`, `:212`; `product-ascii-email-upgrade.integration-spec.ts` (phần trạng thái cuối) | `internal/database/privilege_verify_integration_test.go` (thêm ba hàm vào bảng làm lệch của `TestProbeRejectsMissingOrMiswiredProtection`); CHECK ASCII ở test migration hoặc `internal/authentication` | Đường nâng cấp (`:73`, `:93`, `:67` của ascii) đã bỏ theo ruling 86 và ADR-22; `privilege_declarations.go` ghim thân hàm nhưng không test nào làm lệch ba hàm này, và không test nào ghi email ngoài ASCII thẳng vào bảng |
| Đột biến còn lại: bỏ `lockAccount` ở bind/unbind/identity, bỏ kiểm `MaxBoundaryPackage`, bỏ kiểm entry `required` | Không có nguồn TS | Overlay | Cần cuộc đua hoặc fixture boundary riêng |

### Review 16c2 (Minor, điều phối viên ghi)

- Ba lệnh identity khóa `app_user` đích bằng `FOR NO KEY UPDATE` (`identity_operation_service.go:28`) rồi hàm DB nâng lên `FOR UPDATE`. Rủi ro dự kiến (chưa tái hiện, chưa thấy writer cụ thể): transaction ngoài fence giữ KEY SHARE trên dòng đích rồi UPDATE chính dòng đó → 40P01, lệnh 500 và rollback sạch. Khi trả nợ đua: cân nhắc khóa thẳng `FOR UPDATE` ở ba lệnh identity và thêm ca đua.

## Task 16d

Đã có ở lát 16d: `product-http.spec.ts` › `runtime metrics` port đủ (tracker); unit `internal/health` (bucket biên, nhiều mode, byte order, `-race`, rỗng `[]`, route); integration `TestRunServesEveryRouteWithoutAnUpstream` (Run thật, không upstream, `transaction:read` có count ≥ 1) và `TestRunRefusesAnUpstream`; guard `TestMigratedRoutesAreInTheContract` buộc 100/100.

| Hạng mục | Nguồn | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| Các dòng CROSS M8 trong tracker: `hrm-admin-precheck.integration-spec.ts` :121/:132/:161/:216, `product-request-auth-http…` › "an admin command of a dead well-formed session" (ô 401 đã có ở ma trận M8; còn thiếu phiên đúng dạng nhưng không tồn tại chỉ chạy một transaction `read`, không lấy fence độc quyền), phần M8 của `product-request-text-http…` (còn thiếu email ngoài ASCII qua `POST accounts` và `PUT accounts/:id/email`), phần HTTP role admin của `hrm-authorization-matrix…` :292 | `test-port-tracker.md` dòng trống nhóm M8 | Integration `internal/app` theo từng lệnh | Tracker còn dòng trống M8, chặn C2 |
| Nhãn metrics khác ngoài `transaction:read` (lock_wait/lock_hold/revoke_commit/pool_wait) qua route thật | Không có ca TS qua HTTP | Integration `internal/app` | Chỉ biết runner product gắn đúng bộ thu; giá trị từng nhãn kiểm ở `internal/database` |

### Review 16d (Minor, điều phối viên ghi)

- `docs/operations.md` (đường chạy thủ công, đăng nhập Google qua Vite) và root `package.json` `start:dev` vẫn chạy NestJS `dist/main.js` làm API. Việc của Task 17/19: trỏ sang binary Go (`manifest:sync` + `apps/api-go/dist/api`) khi gỡ NestJS.

## Task 17a

Đã có ở lát 17a: unit `cmd/hrmctl/flags_test.go` (cặp cờ, trùng, thiếu giá trị, `--` đầu, allowlist từng lệnh, cờ lạ không in khi không phải tên, lệnh lạ, `failureLine` có reason/lỗi input và không in giá trị, từ chối input trước khi kết nối, độ dài UTF-16, URL sai không in password); integration `cmd/hrmctl/identity_integration_test.go` (enroll thành công + role vắng + cờ lạ + email trùng 23505, purge chỉ xóa phiên hết hạn, reset-mfa/reset-root-mfa đúng loại và sai loại, audit actor offline, không `@` trong audit/stdout/stderr). Đột biến đỏ: bỏ allowlist, bỏ kiểm kind, bỏ kiểm role tồn tại, đổi actor audit, đếm rune thay UTF-16 (`task-17a-report.md`).

| Hạng mục | Nguồn | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| `provision`/`migrate` lặp lại idempotent qua CLI (`Applied 0`), release CLI = release API | `product-cli.integration-spec.ts:9` (dòng 11, 22-24) | Integration `cmd/hrmctl` chạy binary | Go `migrate` in `Applied forward migrations.` không có số; idempotency đã có ở `internal/offline` |
| Ma trận cờ đã bỏ trên `bootstrap`/`reissue-root`/`invite` (không ghi file, không tạo `app_user`) | `product-cli.integration-spec.ts:27` (dòng 33-65) | 17b (lệnh Root chưa có ở Go) | Phần `enroll` đã có (`--subject`, `--method`) |
| Enroll: metadata audit đúng từng field (`resultingRevision`, `policy_revision` = revision trước), enrollment hết hạn sau ~7 ngày, 0 binding/0 token; issuer lạ (22023); `--user` là actor offline không tạo dòng | `product-cli.integration-spec.ts:77` (dòng 108-138, 140-160, 196-214) | Integration `cmd/hrmctl` | Go chỉ kiểm số event theo actor/kind và revision +1; actor offline bị chặn ở unit trước khi kết nối |
| reset: epoch tăng đúng một bước cho cả hai, thứ tự hàng audit, thiếu `--reason` qua tiến trình thật | `product-cli-mfa.integration-spec.ts:10` (dòng 62-73, 83-90, 98-120) | Integration `cmd/hrmctl` | Go kiểm epoch đổi (không kiểm +1), thiếu reason ở unit |
| Chạy `hrmctl` như tiến trình con (exit code 1, stderr) thay vì gọi `run` | `cli-fixture.helper.ts` | 17c (binary dựng một lần) | `main` chỉ gọi `run` + `failureLine` + `os.Exit(1)`; chưa có test exit code |

### Review 17a (Minor, điều phối viên ghi)

- Vòng `purge-sessions` (`cmd/hrmctl/identity.go:91-100`): chưa có test cho giới hạn 200 lô, điều kiện dừng `n < 500`, ca "hết hạn nhưng còn trong retention thì giữ" (17e).
- `TestInputsAreRefusedBeforeConnectingWithoutTheirValue` chưa khẳng định lý do từ chối (thêm cột `want`) (17e).

## Task 17b

Đã có (`cmd/hrmctl/root_integration_test.go`, `root_test.go`): mỗi lệnh Root một ca thành công; ca từ chối: file đã tồn tại, issuer lạ, login runtime làm bootstrap, operation/email khác và Root thứ hai (`collision`, không file), manifest/materialized lệch (`not_ready`), reissue issuer lạ và sau kích hoạt, set-root-email trên Root pending/IAM/vắng và email trùng, revoke thiếu approval; không `@`/proof trong stdout, dòng lỗi, audit.

| Hạng mục | Nguồn | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| Bootstrap bị từ chối không để lại pin/token (ngoài account/marker) | `product-root-bootstrap.integration-spec.ts:96` | Integration `internal/offline` | Go kiểm account, marker, revision; pin/token suy từ rollback |
| Một Root pending + pin + proof; guard vẫn chặn Root trực tiếp | `product-root-bootstrap.integration-spec.ts:140` | Integration | Phần CLI đã kiểm; guard trực tiếp chưa |
| Pin (issuer,email) + một proof, reissue thay cả hai; promote chỉ khi marker trỏ đúng; chỉ bootstrap phát activation Root | `product-root-regression.integration-spec.ts:28,105,157` | Integration | Reissue thay proof đã kiểm; marker/trigger chưa |
| Guard promote, một Root, không root→iam, Root không giữ IAM fact | `product-root-guards.integration-spec.ts:154,218,242` | Integration `internal/database` | Root thứ hai chỉ kiểm qua marker (CLI), chưa qua trigger trực tiếp |
| Cuộc đua promote với fact/token, ngoài READ COMMITTED | `product-root-concurrency.integration-spec.ts:183,215,234,243` | Integration race | Chưa có |
| Quyền từng login trên Root; không login runtime gỡ suspend Root | `product-root-lifecycle-guards.integration-spec.ts:34,62,88` | Integration | Chưa có |
| Login identity không phát token; chỉ bootstrap phát activation Root | `product-root-token-guards.integration-spec.ts:22,49` | Integration | Chưa có |
| Kịch bản CLI đầy đủ: kích hoạt thật bằng proof, session cũ chết sau revoke, ma trận cờ đã bỏ trên `bootstrap`/`reissue-root` | `product-cli-root.integration-spec.ts:23`, `product-cli.integration-spec.ts:27` | Integration `cmd/hrmctl` + `internal/authentication` | Kích hoạt trong test là SQL của login identity, không qua OIDC |
| Proof đã dùng không chạy lại, không còn gì để reissue | `product-root-activation.integration-spec.ts:249` | Integration `internal/authentication` | Reissue sau kích hoạt (`collision`) đã kiểm |
| set-root-email: Root mất mọi phiên, bootstrap không làm gì khác | `product-sign-in-root.integration-spec.ts:134` | Integration | Epoch tăng đã kiểm, phiên thật chưa |
| Exit code tiến trình thật, lỗi ghi file sau commit (file bị xóa, Root đã commit) | `root-commands.ts:25-31` | 17c/17e | Hành vi giữ như TS, chưa có ca |

### Review 17b (Minor, điều phối viên ghi)

- Lỗi ghi file kích hoạt sau commit (hoặc COMMIT mập mờ) chỉ in "Product operation failed; …", không chỉ đường cứu (`bootstrap` lại cùng op/email → id, rồi `reissue-root`). Giống TS; tùy chọn bọc `usageError` hằng số.
- Ca "login runtime bootstrap" (`root_integration_test.go:139-145`) và ca "file đã tồn tại" (`:128`) chỉ assert `err != nil`; nên assert SQLSTATE `42501`/thông điệp `must name a new file`.
- Audit revoke chưa assert `operationId`. Reissue `missing_reference` (binding/email) và nhánh 23505 khi INSERT `app_user` của bootstrap chưa có ca. Trigger `guard_root_kind` chưa có ca trực tiếp.

## Task 17c (hạ tầng test Go dùng `hrmctl`)

- `buildHrmctl` (`test/template.go`): build vào thư mục tạm ngoài repo (hoặc gitignore `hrmctl`) để `go test -c`/debugger không để lại binary trong thư mục package; sửa câu tương ứng ở `apps/api-go/AGENTS.md`.
- Tách timeout riêng cho bước `go build` khỏi `buildTimeout`; theo dõi lần FAIL không log của reviewer (`./internal/authentication`, test đầu 125 s).
- `TestGoSyncedFixtureSupportsRootBootstrap`: thay `root.ID == ""` bằng `!result.Changed`.
- `pendingRoot`: `t.Fatal` khi `bootstrap` không khớp regex câu commit.
- `go build` trong test cần `git` để stamp VCS; CI không có `git` có thể cần `-buildvcs=false` (suy đoán, chưa kiểm).
- Chạy lại integration toàn bộ một mạch xanh (lượt 17c: 41 ok + `setting` FAIL môi trường, chạy lại riêng ok); chưa đo thời gian dựng template trước/sau.

## Task 19 — docker (người dùng nhắc 2026-11-11: "nhớ sửa cả docker")

- Service `setup` của `docker/compose.yaml` và `docker/Dockerfile` (đang build `@hrm/api`) chuyển hẳn sang Go; kiểm image không còn Node cho API và compose khởi được từ volume trống (`hrmctl provision`). 17d chỉ đổi lệnh Root/identity trong compose và `root-activation.sh`.

## Task 17d (stack web/dev/docker/scripts/seed dùng `hrmctl`)

- Chưa chạy thật: `docker/root-activation.sh`, `docker compose --profile ops run hrmctl …`, `seed/enroll.sh`, root `start:dev` với `.env.api` thật, script ops với `.env.ops` thật (người dùng kiểm `NODE_ENV` hợp lệ; `production` bắt TLS verify-full).
- `seed/enroll.sh`: `set -eu` nên chạy lại sau lỗi giữa chừng dừng ở dòng đã enroll; ghi chú cách xử lý. `/tmp/hrmctl` cố định: dùng `mktemp -d` nếu chạy trên host.
- `apps/web/e2e/stack.helper.ts` `opsEnv`: bỏ `PRODUCT_MIGRATION/SYNC/IDENTITY_DATABASE_URL` không lệnh nào dùng.
- Script ops `apps/api-go/package.json` (và `manifest:sync`): in `r.error?.code` khi `spawnSync` lỗi (thiếu `go`).
- pnpm in lại dòng lệnh nên email truyền qua `pnpm run identity:enroll`/`root:bootstrap` hiện trên terminal (như trước); cân nhắc ghi cảnh báo trong `docs/operations.md`.
- Task 19: `docs/operations.md:59` ("API tsc + web vite build"), root `AGENTS.md:128`, `apps/api/AGENTS.md`/`README.md`, `description` root `package.json` còn nhắc NestJS.

## Sau triage L0

Phần còn thiếu mà L0 tìm ra và chưa có dòng nợ riêng (ID theo `debt-map.md` §6). Chi tiết từng ca ở `task-L0-report.md`.

| Hạng mục | Nguồn TS spec:dòng | Test Go dự kiến | Rủi ro khi chưa có |
| --- | --- | --- | --- |
| TR-01: `max-lines` của web (`apps/web/src`, 301 dòng bị từ chối) | `file-size-limit.spec.ts:51` | Test cấu hình ESLint ở root `test/` (cạnh `function-spacing.spec.ts`) hoặc bỏ có quyết định | Xóa `apps/api/test` thì không còn test nào kiểm luật web |
| TR-02: `internal/authentication` không bị `forbidigo` cấm `time.Now`; lời gọi ở `oidc_service.go:206` | `time-source.spec.ts:62` | Quy tắc `forbidigo` cho authentication kèm ngoại lệ có lý do cho `oidc_service.go:206`, hoặc test AST | Authentication tự đọc đồng hồ cho quyết định về phiên mà không test nào đỏ |
| TR-03: `authority.List` của IAM đọc facts từ DB (rule `before` có tham số timestamp, cạnh quan hệ hết hạn, boundary bắt buộc) ra đúng tập hàng | `product-values.integration-spec.ts:277` (tracker dòng 221) | `authority/authority_values_integration_test.go` với actor IAM | Chỉ có Root và facts dựng tay ở gateway; đường đọc facts của IAM với template có tham số không được so với evaluator |
| TR-04: Root, mỗi truy cập đúng một dòng audit (list, count, detail, update; `data.update` có `resultingRevision`; update vắng ghi `absent`); registry obligation rỗng không đổi gì với Root; key sai và action hay resource lạ không ghi sự kiện | `product-root-access.integration-spec.ts:54,98,194` | `authority/authority_root_integration_test.go` | Audit Root thiếu hoặc thừa dòng không đỏ |
| TR-04: IAM đọc không audit; role tên `custom.root` và `custom.system_root` không cấp gì | `product-root-access.integration-spec.ts:235` | `authority_integration_test.go` | Root nhận diện theo tên role thay vì `kind` đã xác minh |
| TR-04: `PermitsMany`: phiên lạ, thu hồi, hết hạn; thu hồi role khi chờ fence không cho allow cũ; phiên hết hạn trong cửa sổ; any-of tính vào giới hạn; bằng `Permits` cho mọi loại người gọi; kế hoạch facts dưới `jit_above_cost` | `hrm-permits-many.integration-spec.ts:117,182,201,242,268,339,355` | `authority_probes_integration_test.go` | Menu `auth/me` cấp quyền cũ sau thu hồi hoặc nhận phiên chết |
| TR-04: shape sự kiện audit của IAM (`access.read`, `access.update`, `data.update`: revision, metadata `{}`, `resultingRevision`, không chứa title); handler `audit@1` thay thế nhận đúng (user, permission); lệnh `Execute` của Root có cờ Root; detail audit sai shape rollback mutation | `product-audit.integration-spec.ts:217,228,283`; `product-audit-permission.integration-spec.ts:158,186` | `authority_integration_test.go`, `authority_commands_integration_test.go` | Audit sai revision hoặc lộ nội dung không đỏ |
| TR-04: đọc facts theo từng permission cho quyết định bằng đọc đủ (rule hỏng, boundary thiếu, deny qua role chỉ áp cho permission của nó); trang rỗng quá cuối báo total của cùng câu lệnh khi chèn đồng thời | `product-authorization.integration-spec.ts:467,570` | `authority_integration_test.go`, `gateway/compiler_integration_test.go` | Rule của permission này làm hỏng quyết định của permission khác |
| TR-05: phạm vi `employee` của lead thu hẹp sau khi lead assignment và membership kết thúc | `hrm-authorization-facts.integration-spec.ts:22` | `employee/employee_scope_integration_test.go` | Lead cũ còn đọc nhân viên của team |
| TR-06: số câu lệnh mỗi thao tác trong fence (list, detail, update, revoke); `MetricTimeout` của mỗi lần hết `lock_timeout` | `product-fence-io.integration-spec.ts:297`; `product-load.integration-spec.ts:168` | `authority` (trace pgx như `queryCounts`), `runner_integration_test.go:260` | Hồi quy I/O trong fence và metric timeout không đỏ |
| Tracker dòng 126: số lần đọc setting của submit late/WFH 1, final WFH 1, final có ack 0, create default 1/explicit 0 | `hrm-setting-behavior.integration-spec.ts:209` | Đếm query trên runner Go (`RunnerOptions.OnMetric` hoặc trace pgx) | Đọc setting thừa trong transaction |
| Nhóm unit controller với port giả: `role-controller`, AC-21, BI-02 (cần quyết định gộp hoặc bỏ vì ma trận HTTP M8 đã phủ CSRF, Origin, 400) | `role-controller.spec.ts:47,59,69` | Unit controller với port giả hoặc quyết định bỏ | Chỉ kiểm qua ma trận HTTP |
| M7-34: hash `'f'*64` và bỏ bớt một nhân viên bị từ chối với snapshot nhiều nhân viên | `hrm-report.spec.ts:250` | `attendance_snapshot_helper_test.go`, thêm hai ca vào `TestAnAlteredSnapshotIsRefused` (mẫu hiện chỉ có một nhân viên) | Nhánh `ErrSnapshotMismatch` cho hash lạ và thiếu nhân viên chưa có ca riêng |
