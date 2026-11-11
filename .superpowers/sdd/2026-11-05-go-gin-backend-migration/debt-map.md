# Bản đồ trả nợ test trước Task 19

Lập ngày 2026-11-11 trên HEAD `9f59f87` (branch `version/single-app`, working tree sạch lúc bắt đầu). Chỉ đọc code, không chạy test. Nguồn: `test-debt.md` (toàn bộ), `apps/api-go/contract/test-port-tracker.md` (88 dòng còn trống cột trạng thái), `task-17-map.md` §4 và §6, plan Task 13–19, `progress.md` (ruling 101–110), `implementer-rules.md`, `apps/api-go/AGENTS.md`, root `AGENTS.md`.

Quy ước: **QS** = quan sát trực tiếp từ code/file; **SĐ** = suy đoán, kèm cách xác minh. "Có vẻ đã trả" nghĩa là đã thấy test Go tương ứng theo tên/nội dung; vẫn cần đối chiếu từng ca với spec TS trước khi xóa dòng nợ.

## 0. Kết luận chính

- **QS**: không test Go nào đọc `apps/api` lúc chạy. `rg 'apps/api/|api/dist'` trong `apps/api-go` chỉ ra các comment ghi nguồn vector đã chép cứng: `internal/modules/leave/leave_hash_test.go:7`, `internal/modules/workrequest/work_request_hash_test.go:9`, `work_request_decision_test.go:119`, `work_request_cancel_test.go:61`, `internal/authorization/grant/role_grant_helper_test.go:19`, `internal/modules/role/role_validator_test.go:18`, `internal/authentication/credential/credential_test.go:16`, `internal/modules/attendancecore/attendance_snapshot_helper_test.go:11`. Xóa `apps/api` không làm đỏ test Go nào.
- **QS**: không mục nợ nào *bắt buộc* chạy code TS. ADR-22 bỏ so byte với NestJS; các oracle còn nợ (report M7) là SQL chép nguyên văn từ `apps/api/test/hrm-attendance-effects-oracle.helper.ts:127-221`, ghép bằng fragment helper mà Go đã có (tiền lệ M3: `test/fixture/attendanceoracle`). Vậy **nhóm A rỗng**; chỉ có hai mục "A tùy chọn" (đối chiếu thêm với hàm TS thật, xem §2).
- Rủi ro thật khi xóa là mất **nguồn đọc** (nhóm B, 116 mục): spec TS là danh sách ca cần port. Sau khi xóa vẫn lấy lại được bằng `git show <sha>:apps/api/test/<file>`; đánh đổi ở §2.
- **QS**: ngoài nợ test, các chỗ sau gãy khi xóa `apps/api` và thuộc chính Task 19: `apps/api-go/package.json:10-19` (đọc `../api/.env.api`, `../api/.env.ops`), `scripts/dev.sh:14,31,53,61` (`apps/api/compose.yaml`, `apps/api/.env.*`), `docker/Dockerfile`, `docker/compose.yaml` (service `setup`), `README.md`, root `AGENTS.md`. `test/locale-keys.spec.ts:16` đã đọc `apps/api-go/contract/api-errors.json` (đã xong phần đó của plan :395).

## 1. Bảng kiểm kê

Cột: **TS?** = cần oracle TS không (`không`; `đọc spec` = spec TS là nguồn ca; `đọc src` = chép SQL/logic từ file TS; `Node` = cần Node nhưng không cần `apps/api`). **Cỡ** S/M/L. **Rủi ro nếu bỏ**: hậu quả bảo mật/dữ liệu khi không có test. **Nhóm** A/B/C/D theo §2.

### 1.1 M7 report (test-debt.md dòng 11–48)

| ID | Nguồn | Loại | Package Go đích | TS? | Cỡ | Rủi ro nếu bỏ | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| M7-01 | td:11, `hrm-report.integration-spec.ts:394` | ma trận | `internal/app` (m7 matrix) | đọc spec | M | Cao: scope lọc sau phân trang/đếm trước lọc lộ dữ liệu ngoài phạm vi | B | QS: `m7_matrix_integration_test.go:55` ô `foreign` là NA |
| M7-02 | td:12, equivalence `:310`, oracle helper | oracle | `internal/modules/report`, `test/fixture/attendanceoracle` | đọc src | L | TB: nhánh per-row/set-based lệch nhau | B (A tùy chọn) | QS: chưa có `report_integration_test.go` |
| M7-03 | td:13, equivalence `:333` | oracle | `internal/modules/report` | đọc src | M | TB: export tháng đã chốt khác JSON/snapshot | B | |
| M7-04 | td:14, equivalence `:388` | oracle (tag tay) | `internal/modules/report` | đọc spec | S | Thấp | B | Sau M7-02 |
| M7-05 | td:15, `hrm-attendance-adjust:399` F-24 | port spec | report | đọc spec | S | TB | B | Tracker dòng 45 |
| M7-06 | td:16, `hrm-report:188` | port spec | report | đọc spec | S | TB | B | |
| M7-07 | td:17, `:252` | port spec | report | đọc spec | S | TB | B | |
| M7-08 | td:18, `:291` D09 | port spec | report | đọc spec | S | TB | B | |
| M7-09 | td:19, `:356` | port spec | report | đọc spec | S | Thấp | B | QS: unit `report_seniority_helper_test.go:8` có bảng ca, thiếu qua SQL |
| M7-10 | td:20, `:430`, `:873` | port spec | report | đọc spec | S | **Cao: lộ PII (CCCD, MST, năm sinh)** | B | |
| M7-11 | td:21, `:440` | port spec | report | đọc spec | S | Cao: thu hồi quyền không có hiệu lực | B | |
| M7-12 | td:22, `:484` | port spec | report | đọc spec | M | TB: `errMissingSnapshotRow` chưa test | B | |
| M7-13 | td:23, `:546`, `:909` | đua | `internal/app` (m7 race) | đọc spec | M | TB: snapshot không nhất quán | B | Dùng `m1World.gated` (`m6_race_integration_test.go:103`) |
| M7-14 | td:24, `:624` | port spec | report | đọc spec | S | Thấp | B | |
| M7-15 | td:25, `:646` | port spec | report | đọc spec | S | Thấp | B | |
| M7-16 | td:26, `:683` | port spec | report | đọc spec | S | Cao: PII theo actor | B | |
| M7-17 | td:27, `:745` | port spec | report | đọc spec | S | TB | B | |
| M7-18 | td:28, `:767` | port spec | report | đọc spec | S | TB | B | |
| M7-19 | td:29, `:808` | port spec | report | đọc spec | S | Cao: ai nhận file | B | |
| M7-20 | td:30, `:852`, `hrm-excel.spec.ts:360` | port spec | report (test service) | đọc spec | M | **Cao: bỏ kiểm lại `Permits` không đỏ** | B | Cần điểm chèn, xem Q4 |
| M7-21 | td:31, `hrm-excel.spec.ts:351` | port spec | report | đọc spec | S | TB: render trong transaction giữ fence | B | Cùng điểm chèn M7-20 |
| M7-22 | td:32, excel `:372`, export-http `:134` | port spec | report | đọc spec | S | TB: `>` thành `>=` | B | QS: unit renderer có `report_excel_export_service_test.go:318`, chưa qua HTTP |
| M7-23 | td:33, export-http `:90` | port spec | report | đọc spec | S | TB | B | |
| M7-24 | td:34, export-http `:104` | port spec | report | đọc spec | S | TB | B | QS: unit `:343` có ngưỡng 5 MiB |
| M7-25 | td:35, export-http `:150` | port spec | report hoặc app | đọc spec | S | Cao: lộ kích thước khi không grant | B | |
| M7-26 | td:36, export-http `:170`, excel `:472` | port spec | report (service) | đọc spec | M | TB: nhánh `delivered=false` | B | Gộp M7-26..28 |
| M7-27 | td:37, export-http `:213` | port spec | report | đọc spec | S | TB | B | |
| M7-28 | td:38, export-http `:257` | port spec | report | đọc spec | S | TB | B | |
| M7-29 | td:39, export-measure `:72` | đo | report (tag riêng) | không | S | Thấp; plan :354 còn checkbox | C | Đo Go, không so NestJS |
| M7-30 | td:40, setting-behavior `:98` | port spec | report | đọc spec | S | Thấp | B | |
| M7-31 | td:41, setting-behavior `:181` | port spec | report | đọc spec | S | Thấp | B | QS: validator có `report_validator_test.go:154`; thiếu nhánh `checkSpan` qua HTTP |
| M7-32 | td:42, setting-behavior `:194` | port spec | — | — | — | — | D | Trùng M7-22 (setting hạ `export.maxRows`) |
| M7-33 | td:43, setting-behavior `:209` | đo query count | `internal/app` | đọc spec | S | Thấp | B | Tracker dòng 126 nêu đủ bộ đếm |
| M7-34 | td:44, `hrm-report.spec.ts:195,:209,:240,:250` | port spec | — | — | — | — | D | **Có vẻ đã trả**: `attendance_snapshot_helper_test.go:25` (format 2 + hash + jsonb), `:41` (format 1), `:52` (sửa/sai tháng/sai format). Cần xác minh rồi đổi tracker dòng 113 |
| M7-35 | td:45 | mutant | report, httpapi | không | S | Cao với đột biến (1) bỏ `Permits` | C | (2)(3)(6) chỉ đỏ được sau M7-02/M7-22/M7-12 |
| M7-36 | td:46 | port | report hoặc app | không | S | Thấp | C | Hành vi suy từ code |
| M7-37 | td:47 | docs | tracker | không | S | Không | C | QS: tracker dòng 45, 51, 53, 87 còn "Cần report"/"Cần service export" |
| M7-38 | td:48 | dọn dẹp | `internal/app` | không | M | Không | C | Phương án A, §3 L25 |

### 1.2 Task 16a (td:56–63)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| A8-01 | td:56, `grant-set.spec.ts:68` | port | `internal/authorization/grant` | không | S | Thấp (release chưa có template tham số) | C | |
| A8-02 | td:57, `grant-set.spec.ts:122` | property | grant | đọc spec | S | TB | B | QS: không có `testing/quick`/`Fuzz` trong repo |
| A8-03 | td:58 | port | — | — | — | — | D | Trùng R-06 (100 role) và `role_validator_test.go:104` (300 grant) |
| A8-04 | td:59 | port | — | — | — | — | D | **Có vẻ đã trả**: `role_validator_test.go:61`, `:104` (nhãn trim, 120 code point) |
| A8-05 | td:60 | port | — | — | — | — | D | Trùng AC-14 (F1) |
| A8-06 | td:61 | port | — | — | — | — | D | **Có vẻ đã trả**: `m8_matrix_integration_test.go:685` (`TestM8AccountsOverHTTP`), `:809` |
| A8-07 | td:62 | đua | — | — | — | — | D | Trùng AC-16 |
| A8-08 | td:63 | mutant | authority | không | S | TB | C | |

### 1.3 Task 16b role (td:71–99)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| R-01 | td:71, role-write `:180` | port spec | `internal/app` (M8) | đọc spec | S | TB | B | |
| R-02 | td:72, `:226` | port spec | app | đọc spec | S | **Cao: tự nâng quyền** | B | |
| R-03 | td:73, `:258` | property | role (integration) | đọc spec | M | Cao | B | |
| R-04 | td:74, `:289`, `:316` | port spec | role | đọc spec | S | Cao: bỏ kiểm trong lệnh không đỏ | B | |
| R-05 | td:75, `:331` | port spec | app | đọc spec | S | Thấp | B | |
| R-06 | td:76, `:343`, `:356` | port + đua | role/app | đọc spec | M | TB | B | QS: không test nào nhắc `MaxRuntimeRoles` |
| R-07 | td:77, `:381`, `:419` | port spec | role | đọc spec | S | TB | B | |
| R-08 | td:78, `:447`, `:557` | đua | app | đọc spec | M | TB: rule mồ côi | B | |
| R-09 | td:79, `:479` | port spec | app | đọc spec | S | Cao: cache grant | B | |
| R-10 | td:80, `:524`, `:539` | port spec | app | đọc spec | S | TB | B | |
| R-11 | td:81, `:510` | port spec | role | đọc spec | S | TB: audit sai | B | |
| R-12 | td:82, `:607` | port spec | app | đọc spec | S | Cao | B | |
| R-13 | td:83, `:655` | ma trận | app | đọc spec | S | Cao: Root không fresh | B | |
| R-14 | td:84, `:677` | port spec | app | đọc spec | S | Cao | B | |
| R-15 | td:85, `:687` | port spec | app | đọc spec | S | Cao: audit không atomic | B | Gộp với R-29 phần rollback |
| R-16 | td:86, role-matrix `:152` | port spec | app | đọc spec | S | TB | B | |
| R-17 | td:87, `:227` | port spec | app | đọc spec | S | TB | B | |
| R-18 | td:88, `:256` | port spec | app | đọc spec | S | Thấp | B | |
| R-19 | td:89, `:298` | port spec | app | đọc spec | S | TB | B | |
| R-20 | td:90, role-truncation `:76..:193` | port spec | role | đọc spec | M | TB | B | |
| R-21 | td:91, runtime-assumptions, `role-runtime-constraint` | port spec | `internal/database`, `manifest` | đọc spec | M | Cao: `managed_by` | B | |
| R-22 | td:92, `hrm-menu-role` | port | — | — | — | — | D | **Có vẻ đã trả**: tracker dòng 101 (`employee_menu_integration_test.go`, `m2_behavior_integration_test.go`) |
| R-23 | td:93, `role-catalog.spec.ts:48`, `:78` | port spec | role (unit) | đọc spec | S | TB | B | |
| R-24 | td:94, `role-risk.spec.ts:158..211` | port spec | role (unit) | đọc spec | S | TB: permission mới không bị phân loại | B | Chép danh sách cặp rủi ro |
| R-25 | td:95 | port | app | không | M | TB | C | 20001 rule, cần xem engine đọc nổi |
| R-26 | td:96 | mutant | role | không | S | TB | C | |
| R-27 | td:97 | port | role (unit) | Node | S | Thấp | C (A tùy chọn) | So byte order với `localeCompare`; Node vẫn còn sau xóa (web). Chỉ cần `apps/api` nếu muốn gọi đúng hàm sắp xếp TS |
| R-28 | td:98 | ma trận | app | không | S | Thấp | C | |
| R-29 | td:99 | port | app | không | S | TB | C | |

### 1.4 Task 16c1 tài khoản (td:107–130)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| AC-01 | td:107, account-role `:144,:173,:189` | port spec | app | đọc spec | S | Cao | B | |
| AC-02 | td:108, `:216` | port spec | app | đọc spec | S | TB | B | |
| AC-03 | td:109, `:228` | port spec | app | đọc spec | S | Cao: tự tác động | B | |
| AC-04 | td:110, `:238` | port spec | app | đọc spec | S | Cao: lộ tồn tại | B | |
| AC-05 | td:111, `:255`, `account-role.spec.ts:61` | port spec | app | đọc spec | S | TB | B | QS: unit `administration_input_helper_test.go:146` |
| AC-06 | td:112, `:265`, spec `:70,:90` | port spec | app | đọc spec | S | Thấp | B | |
| AC-07 | td:113, `:274` | port spec | app | đọc spec | S | TB | B | |
| AC-08 | td:114, `:289..:359` | port spec | administration + app | đọc spec | M | **Cao: grant ngoài tập** | B | |
| AC-09 | td:115, `:381,:396`, grant-scope 10 ca | port spec | app | đọc spec | M | **Cao: đích lớn hơn** | B | |
| AC-10 | td:116, `:407` | port spec | administration | đọc spec | S | TB | B | QS: không test nhắc `MaxAccountRoles` |
| AC-11 | td:117, `:443` | port spec | app | đọc spec | S | TB | B | |
| AC-12 | td:118, `:465` | port spec | app | đọc spec | S | TB | B | |
| AC-13 | td:119, `:485,:500,:514` | ma trận | app | đọc spec | S | Cao | B | |
| AC-14 | td:120 (+ td:60, td:146, tracker dòng 33) | port spec | app | đọc spec | M | TB: chờ fence độc quyền, tăng revision | B | Gộp F1 cả 16a/16c1/16c2 |
| AC-15 | td:121 (+ td:147) | port spec | app | đọc spec | M | Cao: audit không atomic | B | |
| AC-16 | td:122 (+ td:62) | đua | app | đọc spec | M | Cao: bỏ `lockAccount` không đỏ | B | |
| AC-17 | td:123, provisioning `:379..:725` | port spec | `internal/database` + app | đọc spec | M | Cao | B | |
| AC-18 | td:124, provisioning `:836..:991` | port spec | `internal/authentication` | đọc spec | M | Cao: kích hoạt tài khoản Go cấp | B | |
| AC-19 | td:125, reactivate `:82..:299` | port spec | app + administration | đọc spec | M | TB | B | |
| AC-20 | td:126, root-suspend `:25,:86` | port spec | app | đọc spec | S | Cao | B | |
| AC-21 | td:127, `account-role.spec.ts:43..:61` | port spec | administration (controller unit) | đọc spec | S | Thấp (ma trận HTTP đã phủ) | B | |
| AC-22 | td:128 | migration | — | — | — | — | D | Baseline Go (ADR-14/22); phần còn lại ở `internal/offline/provision_integration_test.go:313` |
| AC-23 | td:129 | port | app | không | S | Cao: deny thắng allow ở bước độc quyền | C | |
| AC-24 | td:130 | mutant | administration | không | S | TB | C | Bỏ `lockAccount` cần AC-16 |

### 1.5 Task 16c2 boundary và identity (td:138–164)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| BI-01 | td:138, account-boundary.spec `:40..:54`, identity-operation.spec `:30..:92` | port spec | `internal/authorization/declarations` (unit) | đọc spec | S | **Cao: gói boundary đổi không đỏ** | B | |
| BI-02 | td:139 | port spec | administration (controller unit) | đọc spec | S | Thấp | B | |
| BI-03 | td:140, account-boundary `:218..:370` | port spec | app | đọc spec | M | Cao | B | |
| BI-04 | td:141, `:391,:418` | port spec | app | đọc spec | S | Cao: lộ tồn tại | B | |
| BI-05 | td:142, `:441..:514` | port spec | app | đọc spec | M | Cao | B | |
| BI-06 | td:143, `:488..:591` | port spec | administration + app | đọc spec | M | TB | B | |
| BI-07 | td:144, `:624,:656,:700` | port spec | app + database | đọc spec | S | Cao: xóa dòng seed | B | |
| BI-08 | td:145, `:722..:748` | ma trận | app | đọc spec | S | Cao | B | |
| BI-09 | td:146 | port spec | app | đọc spec | S | TB | B | Gộp AC-14 |
| BI-10 | td:147 | port spec | app | đọc spec | S | Cao | B | Gộp AC-15 |
| BI-11 | td:148 | đua | app | đọc spec | M | Cao | B | |
| BI-12 | td:149, `:1008` | port spec | manifest | đọc spec | S | Cao: sync ghi đè binding runtime | B | SĐ: có thể đã phủ một phần ở `internal/authorization/manifest/*_integration_test.go` (tracker dòng 216 "runtime boundary collision"); xác minh bằng đọc `grant_integration_test.go` |
| BI-13 | td:150, identity-operation `:174..:349` | port spec | app | đọc spec | M | **Cao: chiếm tài khoản** | B | |
| BI-14 | td:151, `:384,:414,:463` | port spec | app | đọc spec | S | TB | B | |
| BI-15 | td:152, `:478..:594` | port spec | app | đọc spec | S | TB | B | |
| BI-16 | td:153, concurrency `:87..:297` | đua | app | đọc spec | M | Cao | B | |
| BI-17 | td:154, faults `:71..:183` | port spec | app + administration | đọc spec | M | TB | B | |
| BI-18 | td:155, mfa `:66`, oidc `:118..:228` | port spec | `internal/authentication` | đọc spec | M | **Cao: binding cũ còn đăng nhập được** | B | |
| BI-19 | td:156, identity-operations `:119..:407` | port spec | `internal/database` | đọc spec | M | Cao: hàm `SECURITY DEFINER` chưa có test riêng | B | |
| BI-20 | td:157 | migration | — | — | — | — | D | Đường nâng cấp TS, baseline Go đã gồm (tiền lệ ruling 86) |
| BI-21 | td:158 | port | — | — | — | — | D | Không dựng được; đã có unit + HTTP hai provider |
| BI-22 | td:159 | mutant | administration | không | S | TB | C | Cần BI-11/BI-06 |
| BI-23 | td:163 (review) | đua + code | administration | không | S | TB: 40P01 dự kiến, chưa tái hiện | C | Xem Q6 |
| BI-24 | td:164 (review) | — | — | — | — | — | D | Đã ghi nhận, không lộ facts |

### 1.6 Task 16d (td:172–179)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| HM-01 | td:172, tracker dòng 33, 71, 194, 195 | docs + port | tracker, app | đọc spec | S | TB | B | Dòng 194 **có vẻ đã trả**: ô 401 ba kiểu của `TestTheM8AccountRoutesAnswerEveryCellOfTheMatrix` (`m8_matrix_integration_test.go:656`); dòng 33 = AC-14; dòng 195 xem TR-10 |
| HM-02 | td:173 | port | app | không | S | Thấp | C | |
| HM-03 | td:174 | — | — | — | — | — | D | Debt tự ghi "không cần ca riêng" |
| HM-04 | td:178 | docs | docs, package.json | không | S | Không | C | SĐ: 17d đã đổi `start:dev` sang Go (progress :443); còn đường chạy thủ công trong `docs/operations.md`. Thuộc Task 19 |
| HM-05 | td:179 | dọn dẹp | app | — | — | — | D | QS: `run_integration_test.go:193,206,233` còn `DialTimeout`; hết nghĩa khi Task 19 gỡ proxy/`API_UPSTREAM_URL` |

### 1.7 Task 17a CLI (td:187–199)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| CL-01 | td:187, product-cli `:9` | port spec | `cmd/hrmctl` | đọc spec | S | Thấp | B | |
| CL-02 | td:188, product-cli `:27` | port spec | cmd/hrmctl | đọc spec | S | TB | B | Go không có lệnh `invite`: chỉ `bootstrap`/`reissue-root` |
| CL-03 | td:189, product-cli `:77` | port spec | cmd/hrmctl | đọc spec | S | TB | B | |
| CL-04 | td:190, product-cli-mfa `:10` | port spec | cmd/hrmctl | đọc spec | S | TB | B | |
| CL-05 | td:191 | hạ tầng | cmd/hrmctl | không | S | Thấp | C | QS: template đã chạy `hrmctl` như tiến trình con (`test/template.go:283-290`); thiếu ca exit code |
| CL-06 | td:192 | — | — | — | — | — | D | Suy đoán không xảy ra; HTTP đã có ca recovery code (16c2) |
| CL-07 | td:196 | port | cmd/hrmctl | không | S | Thấp | C | QS: một phần ở `internal/offline/session_purge_integration_test.go:62`, `:113`; thiếu trần 200 lô ở CLI (`cmd/hrmctl/identity.go:19`) |
| CL-08 | td:197 | dọn dẹp | cmd/hrmctl | không | S | Thấp | C | |
| CL-09 | td:198 | — | — | — | — | — | D | Đã chấp nhận |
| CL-10 | td:199 | — | — | — | — | — | D | **Có vẻ đã trả** ở 17b: `cmd/hrmctl/root_test.go:78` |

### 1.8 Task 17b Root (td:207–223)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| RT-01 | td:207, root-bootstrap `:96` | port spec | `internal/offline` | đọc spec | S | Cao | B | |
| RT-02 | td:208, `:140` | port spec | offline | đọc spec | S | Cao | B | |
| RT-03 | td:209, root-regression `:28,:105,:157` | port spec | offline/database | đọc spec | M | Cao | B | |
| RT-04 | td:210, root-guards `:154,:218,:242` | port spec | `internal/database` | đọc spec | M | **Cao: Root thứ hai, root→iam** | B | QS: `privilege_verify_integration_test.go:180-229` chỉ kiểm trigger tồn tại/không bị thay, chưa kiểm hành vi |
| RT-05 | td:211, root-concurrency | đua | database/offline | đọc spec | M | Cao | B | |
| RT-06 | td:212, lifecycle-guards | port spec | database | đọc spec | S | Cao | B | QS: một phần ở `product_database_integration_test.go:274` |
| RT-07 | td:213, token-guards | port spec | database | đọc spec | S | Cao | B | |
| RT-08 | td:214, cli-root `:23`, product-cli `:27` | port spec | cmd/hrmctl + authentication | đọc spec | M | Cao: phiên cũ sống sau revoke | B | |
| RT-09 | td:215, activation `:249` | port spec | authentication | đọc spec | S | TB | B | QS: một phần ở `root_integration_test.go:119` |
| RT-10 | td:216, sign-in-root `:134` | port spec | authentication | đọc spec | S | Cao | B | |
| RT-11 | td:217 | port | cmd/hrmctl | không | S | TB | C | |
| RT-12 | td:221 | dọn dẹp (UX) | cmd/hrmctl | không | S | Thấp | C | |
| RT-13 | td:222 | dọn dẹp | cmd/hrmctl | không | S | Thấp | C | |
| RT-14 | td:223 | port | cmd/hrmctl, database | không | S | TB | C | Phần trigger trực tiếp trùng RT-04 |

### 1.9 Task 17c, 17d, Task 19 docker (td:227–245)

| ID | Nguồn | Loại | Package | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| IN-01 | td:227 | hạ tầng | `test` | không | S | Không | C | QS: `test/template.go:274` vẫn đặt binary cạnh binary test |
| IN-02 | td:228 | hạ tầng | test | không | S | Không | C | |
| IN-03 | td:229 | dọn dẹp | manifest | không | S | Không | C | QS: `reconcile_integration_test.go:131` còn `root.ID == ""` |
| IN-04 | td:230 | dọn dẹp | authentication | không | S | Thấp | C | QS: `oidc_integration_test.go:272-275` trả id rỗng khi không khớp |
| IN-05 | td:231 | hạ tầng (CI) | test, CI | không | S | Không | C | SĐ; kiểm cùng Task 19 (đổi CI) |
| IN-06 | td:232 | hạ tầng (gate) | toàn bộ | không | S | Không | C | Chạy integration một mạch xanh |
| T19-01 | td:236 | hạ tầng | docker | không | M | Không (vận hành) | C | **Chặn xóa**: Dockerfile build `@hrm/api`; làm trong Task 19 |
| SC-01 | td:240 | hạ tầng | scripts | không | S | Không | C | Người dùng chạy thật với `.env` thật |
| SC-02 | td:241 | hạ tầng | seed (2 script) | không | S | Không | C | Ruling 110 giới hạn file được đọc |
| SC-03 | td:242 | dọn dẹp | `apps/web/e2e/stack.helper.ts` | không | S | Không | C | |
| SC-04 | td:243 | dọn dẹp | `apps/api-go/package.json` | không | S | Không | C | |
| SC-05 | td:244 | docs | `docs/operations.md` | không | S | Thấp (PII trên terminal) | C | |
| SC-06 | td:245 | docs | docs, AGENTS | không | S | Không | C | Thuộc Task 19 |

### 1.10 Dòng tracker trống không có trong test-debt.md

| ID | Dòng tracker | Loại | Đích Go | TS? | Cỡ | Rủi ro | Nhóm | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| TR-01 | 26, 27, 31, 141 (`explicit-columns`, `file-size-limit`, `helper-sync`, `module-boundaries`) | docs | `test/conventions_test.go`, `test/imports_test.go` | đọc spec | S | Thấp | B | **Có vẻ đã trả**: `conventions_test.go:438` (`TestCheckExplicitColumns`), `:543` (`TestCheckFileSize`), `:569` (`TestCheckHelper`); `imports_test.go:749`, `:966`, `test/unrestricted_boundary_test.go`. Ghi "thay bằng" sau khi đối chiếu ca |
| TR-02 | 230, 233, 239, 240, 242 (`route-inventory.helper`, `single-app`, `test-runner`, `time-source`, `workspace.smoke-spec`) | docs | — | — | S | — | D | Tooling TS/Day.js; Go có `forbidigo` cho `time.Now` (AGENTS), `internal/config/config_test.go`, `run_integration_test.go`. Ghi "bỏ"/"thay bằng" |
| TR-03 | 25, 221, 238 (lớp `authorize`, `product-values` authority, admin fresh) | docs | authority, httpapi | không | S | Thấp | C | **Có vẻ đã trả** (theo `task-8b-report.md:56-66`): `httpapi/authorize_test.go:16`, `authority/authority_values_integration_test.go:19`, `authority/authority_test.go:85` |
| TR-04 | 156, 158, 159, 196, 107 (`product-audit-permission`, `product-audit`, `product-authorization`, `product-root-access`, `hrm-permits-many`) | port spec | authority | đọc spec | M | TB | B | `task-8b-report.md` ghi "partial": cần đối chiếu phần còn lại với spec rồi port hoặc ghi lý do bỏ |
| TR-05 | 68, 69, 76 (`hrm-authorization-facts`, fixture-commands, stack helper) | docs | workrequest | không | S | Thấp | C | Facts ở lần transaction sau: **có vẻ đã trả** bằng `TestTheCurrentTeamAndLeadControlPendingRequests` (tracker dòng 36) |
| TR-06 | 88, 106, 164, 181 (`hrm-http-measure`, `permits-many-measure`, `product-fence-io`, `product-load`) | đo | — | — | — | — | D | Benchmark lịch sử của TS; xem Q3. SĐ: phần hành vi "retry hữu hạn, metric timeout/retry" của `product-load:168` đã phủ ở `internal/database/runner_integration_test.go` (xác minh bằng `rg -n 'MetricRetry' runner_integration_test.go`) |
| TR-07 | 10, 110, 130, 204, 229 (helper HTTP/stack/Root) | docs | `test/template.go`, `test/fixture`, `m1World` | không | S | Không | C | "thay bằng" |
| TR-08 | 89 (`hrm-input.spec.ts`, 11 ca) | port spec | employee, workcalendar, httpapi | đọc spec | S | TB | B | **Có vẻ đã trả** phần lớn: `employee_validator_test.go`, `work_calendar_validator_test.go`, `httpapi/input_test.go`, `httpapi/body_test.go:66` |
| TR-09 | 222 (`product.e2e-spec.ts`) | docs | — | — | S | — | D | Thay bằng Playwright (30 ca) + `run_integration_test.go` + test `internal/authentication` |
| TR-10 | 195 (`product-request-text-http`, 7 ca) | port spec | httpapi, app | đọc spec | S | TB | B | Một phần: `body_test.go:66`, `administration_input_helper_test.go:96` |
| TR-11 | 128 (`hrm-setting:358`) | port spec | employee | đọc spec | S | Thấp | B | Một phần: `employee_rate_repository_integration_test.go:48` (mức repository) |
| TR-12 | 186 (offline reset) | docs | cmd/hrmctl | không | S | Không | C | **Có vẻ đã trả**: `cmd/hrmctl/identity_integration_test.go:188` |
| TR-13 | 198, 217 (`nothing is left to reissue`, product-system Root lifecycle) | port spec | cmd/hrmctl | đọc spec | S | TB | B | Gộp RT-08/RT-09; một phần ở `root_integration_test.go:119`, `root_test.go:92` |
| TR-14 | 152, 154, 176 (ba spec upgrade) | migration | — | — | — | — | D | Như AC-22, BI-20 |
| TR-15 | 7, 8, 9, 30, 223–228 (unit spec `account-*`, `grant-set`, `role-*`) | docs | role, grant, administration | không | S | Không | C | Đã port một phần (16a/16b/16c); điền tracker khi xong R-23, R-24, A8-02, BI-01, BI-02, AC-21 |
| TR-16 | Plan Task 5 `:183` (test chéo runtime) | — | — | — | — | — | D | Không còn route NestJS; DB dev dựng lại ở Task 19 (Q5), không còn dữ liệu NestJS ghi |

Ngoài nợ test, plan còn hai checkbox không phải test: review độc lập M1 (`:286`), M2 (`:292`). Không tính vào bản đồ này.

## 2. Phân loại

**(A) Phải làm trước khi xóa vì cần chạy code TS: 0 mục bắt buộc.**
Hai mục "A tùy chọn" (đã đếm trong B/C):
- M7-02: chạy thêm oracle TS (`oracleLoadSheetRows` qua `apps/api/dist`) trên cùng dataset để chứng minh bản chép Go đúng. Tiền lệ M3 không làm việc này; ADR-22 không đòi.
- R-27: so thứ tự với chính hàm sắp xếp của TS thay vì `localeCompare` của Node. Node thuần là đủ cho mục đích của nợ.
Nếu người dùng muốn một trong hai, phải làm trước Task 19 (Q1).

**(B) Chỉ cần đọc spec/src TS làm nguồn: 116 mục.** Gồm M7 (31), 16a (1), 16b (23), 16c1 (21), 16c2 (19), 16d (1), 17a (4), 17b (10), tracker (6).
Đánh đổi nếu xóa trước khi trả:
- Lấy lại bằng `git show <sha>:apps/api/test/<file>` vẫn đủ nội dung; cần ghi SHA cuối có `apps/api` vào đầu tracker (hoặc tag, ví dụ `pre-cutover-ts`), vì sau squash/rewrite history có thể mất.
- Mất tiện lợi: không `rg` chéo spec/src cùng working tree, implementer phải nhận nội dung spec trong brief; oracle M7 import nhiều fragment từ `apps/api/src`, dò theo history chậm hơn.
- Tracker dòng trống (Task 19 checkbox `:391`) phải điền bằng cách đọc spec; làm sau khi xóa thì mọi lý do "bỏ/thay bằng" dựa trên bản trong history.
Đề xuất: giữ ruling 101 (trả nợ B trước Task 19); dù sao vẫn ghi SHA vào tracker ở lát cuối trước khi xóa.

**(C) Không phụ thuộc TS, làm lúc nào cũng được: 43 mục.** Mutant, đo 5000 dòng, dọn dẹp minor 17a–17d, hạ tầng test, docs, phương án A, T19-01 (chặn xóa nhưng thuộc chính Task 19).

**(D) Đề xuất bỏ: 22 mục.**
- Trùng hoặc đã phủ (9): M7-32, M7-34, A8-03, A8-04, A8-05, A8-06, A8-07, R-22, CL-10.
- Hết nghĩa sau ADR-22/ADR-14 hoặc Task 19 (7): AC-22, BI-20, TR-14 (đường nâng cấp TS), TR-16 (chéo runtime), HM-05 (gỡ cùng proxy), TR-02 (tooling TS), TR-09 (e2e TS thay bằng Playwright).
- Không dựng được hoặc đã chấp nhận (6): BI-21, BI-24, CL-06, CL-09, HM-03, TR-06 (benchmark, chờ Q3).
Các mục "có vẻ đã trả" trong D vẫn cần một lượt đối chiếu (lát L0) trước khi xóa dòng khỏi `test-debt.md`.

## 3. Lát thực thi đề xuất

Nhóm A rỗng nên lát đầu là triage (đọc TS, chưa viết test). Thứ tự còn lại: B theo domain (M7 → M8 → C1), rồi C thuần, mutant, phương án A, Task 19. Mỗi lát: một implementer + một reviewer; check chung theo `implementer-rules.md` (vet, vet integration, lint, unit race package đổi, integration từng file, `./test`), cộng check riêng ghi dưới. Mỗi lát cập nhật tracker và xóa dòng `test-debt.md` đã trả.

| Lát | Phạm vi (ID) | File chính | Check riêng | Phụ thuộc | Cỡ |
|---|---|---|---|---|---|
| L0 Triage | TR-01..16, M7-34, M7-37, A8-04/06, R-22, CL-10, HM-01 (dòng 194) | `contract/test-port-tracker.md`, `test-debt.md` | Đối chiếu từng ca spec ↔ test Go; prettier, `git diff --check` | Q2, Q3 | S–M |
| L1 M7 oracle | M7-02, M7-03, M7-05, M7-06, M7-07 | `test/fixture/attendanceoracle` (thêm oracle sheet rows), `internal/modules/report/report_integration_test.go` (mới) | Integration report; mutant đổi `EffectsSetBasedMinRows` phải đỏ | — | L (có thể tách 1a: oracle + :310; 1b: XLSX/close :333) |
| L2 M7 quy mô | M7-04 | report (tag riêng) | Chạy tay một lần | L1 | S |
| L3 M7 số liệu, PII | M7-08..12, M7-14..16, M7-30 | `report_integration_test.go` | Integration report; quét PII cả JSON và mọi entry workbook | L1 (fixture) | M |
| L4 M7 export HTTP | M7-17..19, M7-22..25, M7-31, M7-33 | report hoặc `internal/app` | Setting hạ bằng SQL; đếm query qua `RunnerOptions.OnMetric` | L1 | M |
| L5 M7 luồng export | M7-20, M7-21, M7-26..28 | `report_excel_export_service`/service test | Mutant bỏ `Permits` đỏ | Q4 | M |
| L6 M7 ma trận foreign | M7-01, M7-36 | `internal/app/m7_matrix_integration_test.go` | Integration app | — | M |
| L7 M7 đua | M7-13 | `internal/app/m7_race_integration_test.go` (mới) | 0 deadlock/timeout/retry qua `OnMetric` | Q5 | M |
| L8 M7 đo + mutant | M7-29, M7-35 | report | Tag đo chạy tay; overlay 6 đột biến | L1, L4, L5 | S |
| L9 role A | R-01..05, R-12..14, R-23, R-24, A8-02 | `m8_matrix_integration_test.go`, `role_validator_test.go`, `grant_set_helper_test.go` | Integration app/role | — | M |
| L10 role B | R-07, R-09..11, R-15..20, R-28, R-29 | app, role | `REVOKE INSERT ON audit_outbox` có `t.Cleanup` | L9 | M |
| L11 role DB/catalog | R-21, R-25, R-27 | `internal/database`, `manifest`, role | Integration database/manifest | — | M |
| L12a tài khoản cơ bản | AC-01..07, AC-10..13 | app, administration | Integration app | — | M |
| L12b tập grant | AC-08, AC-09, AC-23 | app, administration | Mutant bỏ `WithinActor` vẫn đỏ | L12a | M |
| L13 cấp/khôi phục/suspend Root | AC-17, AC-19, AC-20, AC-21 | app, administration, database | Integration | — | M |
| L14 boundary | BI-01..08, BI-12 | app, declarations, manifest | Integration | — | M |
| L15 identity HTTP | BI-13..15, BI-17 | app, administration | `holdIdentity` (không giữ hai permission) | L14 | M |
| L16 hàm DB identity | BI-19 | `internal/database` | Integration database | — | M |
| L17 đăng nhập sau lệnh | AC-18, BI-18 | `internal/authentication` | Integration authentication | L13, L15 | M |
| L18 F1 + audit rollback | AC-14, AC-15, BI-09, BI-10 | app | Holder fence độc quyền; đo không chờ | — | M |
| L19a đua role | R-06, R-08 | app | Như L7 | Q5 | M |
| L19b đua tài khoản/boundary | AC-16, BI-11 | app | Mutant bỏ `lockAccount` đỏ | Q5 | M |
| L19c đua identity | BI-16, BI-23 | app, administration | Đổi khóa chỉ khi tái hiện 40P01 | Q5, Q6 | M |
| L20 mutant M8 + metric | A8-08, R-26, AC-24, BI-22, HM-02 | overlay | Overlay `go test -overlay` | L9–L19 | S–M |
| L21 CLI | CL-01..05, CL-07, CL-08 | `cmd/hrmctl` | Integration `./cmd/hrmctl -count=1` | — | M |
| L22 Root guard DB | RT-01..04, RT-06, RT-07, RT-14 | `internal/database`, `internal/offline` | Integration; dùng login owner `migration` để chạm trigger | — | M |
| L23 Root kích hoạt/phiên/đua | RT-05, RT-08..10, TR-13 | cmd/hrmctl, authentication, offline | Integration | L22 | M |
| L24 minor + hạ tầng | IN-01..04, IN-06, RT-11..13, A8-01, SC-02..05 | test, cmd/hrmctl, manifest, scripts | Integration toàn bộ một mạch (IN-06) | — | S–M |
| L26 authority/audit/PermitsMany + tồn dư triage | TR-01 (web `max-lines`), TR-02 (`time-source`), TR-03 (221), TR-04, TR-05 (68), TR-06 (số câu lệnh, `MetricTimeout`), tracker dòng 126, nhóm unit controller (`role-controller`, AC-21, BI-02), R-22 (menu `roles`), M7-34 (hai ca hash), mục "Sau triage L0" của `test-debt.md` | `authority/*_integration_test.go`, `employee_menu_integration_test.go`, `attendance_snapshot_helper_test.go`, `test/` | Integration `./internal/authorization/authority`; mutant cho từng ca từ chối | — | M |
| L25 Phương án A | M7-38 | `internal/app/{matrix,world,race}_integration_test.go` | Chỉ di chuyển: `git diff --stat` cân, integration `./internal/app` | Mọi lát trên (theo ruling 101) | M |
| Task 19 | T19-01, SC-01, SC-06, HM-04, IN-05 | docker, scripts, CI, docs | Theo plan :391–400 | L0–L25 | — |

## 4. Tổng số

| Nhóm | Số mục | Ghi chú |
|---|---|---|
| A (bắt buộc chạy TS) | 0 | 2 mục A tùy chọn (M7-02, R-27) nằm trong B/C |
| B (đọc spec TS) | 116 | |
| C (không phụ thuộc TS) | 43 | |
| D (đề xuất bỏ) | 22 | 9 trùng/đã phủ, 7 hết nghĩa, 6 không dựng được/đã chấp nhận |
| **Tổng** | **181** | 165 dòng nợ của `test-debt.md` + 16 dòng gộp từ tracker/plan |

Ước lượng: 28 lát (L0–L25, tính L12, L19 tách thành 2 và 3) trước Task 19; khoảng 2 lát S, 22 lát M, 1–2 lát L (L1 nên tách đôi).

## 5. Câu hỏi cần người dùng chốt

- **Q1 (xóa `apps/api`)**: nhóm A rỗng. Cho phép Task 19 khi nợ B đã trả, hay chấp nhận xóa sớm và đọc spec từ git history? Đề xuất: trả nợ B trước (giữ ruling 101), không làm hai mục A tùy chọn, ghi SHA cuối có `apps/api` vào tracker.
- **Q2 (danh sách D)**: đồng ý bỏ 22 mục ở §2? Đề xuất: đồng ý; mục "có vẻ đã trả" chỉ xóa sau khi L0 đối chiếu.
- **Q3 (đo)**: chỉ giữ đo export 5000 dòng của Go (plan :354, chạy tay, tag riêng); bỏ bốn spec đo của TS (TR-06)? Đề xuất: có.
- **Q4 (điểm chèn export)**: M7-20/21/26..28 cần dừng `Service.Export` giữa render và kiểm lại `Permits`. Cho phép thêm một seam chỉ test dùng (field hàm trong service, mặc định nil), hay chỉ dùng cổng khóa DB và context hủy? Đề xuất: thử cổng khóa/context trước; seam chỉ khi không đỏ được mutant bỏ `Permits`.
- **Q5 (thứ tự phương án A)**: L7, L19a–c sẽ thêm cuộc đua dựa trên `m1World.gated` đang nằm trong `m6_race_integration_test.go`. Làm A trước các lát đua (chỉ di chuyển code, giảm churn), hay giữ A cuối như ruling 101? Đề xuất: đưa A lên trước L7, vì phần "tính năng trước" của ruling đã xong.
- **Q6 (khóa identity)**: BI-23 đổi `FOR NO KEY UPDATE` thành `FOR UPDATE` ở ba lệnh identity (`identity_operation_service.go:28`) chỉ khi L19c tái hiện được 40P01? Đề xuất: có; không tái hiện thì ghi lại và giữ code.
- **Q7 (mutant)**: chạy hết danh sách đột biến của test-debt hay chỉ các nhánh bảo mật? Đề xuất: chạy hết; mỗi lát mutant cỡ S.

## 6. Kết quả L0

Lát L0 (triage, chỉ sửa tài liệu) làm ngày 2026-11-11 trên HEAD `b31db0d`, đọc từng ca của spec TS và assertion của test Go; không chạy test. Bảng đối chiếu từng ca ở `task-L0-report.md`. Quy ước: **QS** là điều đọc được trong code, **SĐ** là suy đoán. Tracker (`apps/api-go/contract/test-port-tracker.md`): 25 dòng đã điền trạng thái (16 `thay bằng`, 3 `port`, 6 `bỏ`), 32 dòng giữ trống kèm ghi chú phần còn thiếu (57 dòng được sửa, không thêm hay xóa dòng). `test-debt.md`: xóa 16 dòng (R-22 đã khôi phục ở vòng sửa 1), thu hẹp 3 dòng (BI-12, BI-20, HM-01), thêm mục "Sau triage L0".

### 6.1 Mục đã đóng (xóa khỏi `test-debt.md` hoặc ghi tracker)

| ID | Kết luận | Bằng chứng chính | Còn lại |
|---|---|---|---|
| M7-34 | đã phủ cả bốn ca | `attendancecore/attendance_snapshot_helper_test.go` (`TestTheCanonicalSnapshotMatchesTheTypeScriptBytesAndHash`, `TestAFormatOneSnapshotKeepsItsOwnCanonicalForm`, `TestAnAlteredSnapshotIsRefused`); tracker dòng 113 `port` | không |
| M7-37 | đã sửa | Tracker dòng 45, 51, 53, 87, 125, 126 không còn "Cần report"/"Cần service export", trỏ về dòng nợ M7 | không |
| A8-03 | trùng, đã xác minh | 300 grant: `role_validator_test.go` (`TestParseCreateTakesExactlyTheLimits`); 100 role còn ở R-06 (`test-debt.md` dòng "Tối đa 100 role runtime") | R-06 giữ |
| A8-04 | đã phủ | `role_validator_test.go` (`TestParseCreate`: trim, 120 code point emoji, `\u0000`) và `httpapi/input_test.go` | không |
| A8-05 | trùng, đã xác minh | AC-14 (`test-debt.md` dòng "F1") nêu đúng bốn dòng `hrm-admin-precheck` | AC-14 giữ |
| A8-06 | đã phủ | `m8_matrix_integration_test.go` `TestM8AccountsOverHTTP` (tự tác động 403 ở suspend và assign; Root và IAM với Root 404; ô `absent`) | revoke tự tác động ở AC-03 (giữ) |
| A8-07 | trùng, đã xác minh | AC-16 và BI-11 (`test-debt.md`) nêu đua assign/revoke/bind và thứ tự khóa `app_user` | AC-16, BI-11 giữ |
| R-22 | phủ một phần, dòng nợ được khôi phục ở dạng thu hẹp (vòng sửa 1) | `m2_behavior_integration_test.go` (cấp rồi thu hồi `role.read` đổi menu `roles` cùng phiên; không grant thì không có), `employee_menu_integration_test.go` (Root, admin liên kết có `roles`) | Ca từ chối `hrm-menu-role.integration-spec.ts:44-45` (COO và `hr.employee` không có menu `roles`) chưa có assertion Go: `employee_menu_integration_test.go:30` chỉ kiểm `settings`. Dòng nợ trong `test-debt.md`; nhóm B, L26 |
| M7-32 | trùng, đã xác minh | M7-22 (`test-debt.md` dòng "Vượt ngân sách dòng") hạ `export.maxRows` bằng setting | M7-22 giữ |
| AC-22 | bỏ | `internal/offline/provision_integration_test.go` (`TestRoleRequiredAssignsTheEmployeeRoleFromALiteralActor`); tracker dòng 152 `thay bằng` | không |
| BI-21 | bỏ | Unit `TestProvisioningWithoutAnIssuerIsUnavailable`, `TestTheIdentityCommandsNeedingAnIssuerAreUnavailableWithoutIt`, `app_test.go` (`provisioningIssuer` 0/1/2 provider) và HTTP hai provider `m8_matrix_integration_test.go:886` | không |
| BI-24 | bỏ | Khác biệt thứ tự validation đã ghi nhận, không lộ facts | không |
| CL-06, CL-09 | bỏ (ruling 112) | Không xác minh thêm | không |
| CL-10 | đã phủ | `cmd/hrmctl/root_test.go` (`TestTheFailureLineNamesTheCodeOfADatabaseFailure`) cho Minor 1; `root_integration_test.go` (`run` với `failingWriter`: revoke đã commit không đổi kết quả) cho Minor 2 | không |
| HM-03, HM-05 | bỏ (ruling 112) | HM-05 hết nghĩa khi Task 19 gỡ proxy và `API_UPSTREAM_URL` cùng `TestRunRefusesAnUpstream` | Task 19 gỡ proxy cùng `TestRunRefusesAnUpstream`; HM-05 đã bỏ khỏi hàng Task 19 ở §3 |

### 6.2 Mục thu hẹp nhưng còn nợ

| ID | Kết luận | Còn lại | Nhóm, lát |
|---|---|---|---|
| BI-12 | phủ một phần (SĐ của §1.5 đúng một phần) | `reconcile_integration_test.go:186` đã kiểm seed trùng dòng runtime là `collision` và `definition_in_use`; thiếu: release sau thêm binding seed cho tài khoản khác không đổi dòng runtime, `RemoveBoundaryBindings` nêu dòng runtime không xóa (không test nào dùng trường này) | B, L14 (đã có BI-12) |
| BI-20 | thu hẹp, không xóa hẳn (lệch ruling 112 có lý do) | Đường nâng cấp (`:73`, `:93`, ascii `:67`) bỏ. Giữ: probe đặc quyền của ba hàm identity (`product-identity-operations-upgrade` `:138`, `:212`) chưa có test làm lệch; CHECK ASCII của `app_user` và `oidc_email_enrollment` (migration 8) chưa có ca ghi email ngoài ASCII | B (probe ba hàm) gộp L16 (BI-19); C (CHECK ASCII) L24 |
| HM-01 (dòng 194) | phủ một phần | Ô 401 của ma trận M8 có; thiếu phiên đúng dạng không tồn tại chỉ chạy một transaction `read`, không lấy fence độc quyền (QS: `TestRunServesEveryRouteWithoutAnUpstream` chỉ có route GET) | B, L12a |
| TR-06 | SĐ về `MetricRetry` đúng một phần | QS: `MetricRetry` có ở `runner_integration_test.go:265`, `:314`; `MetricTimeout` của 55P03 chưa assert (chỉ `m6_race_integration_test.go:351` dùng nhãn này, để khẳng định bằng 0). Bốn spec đo bỏ; riêng `product-fence-io` còn assertion số câu lệnh mỗi thao tác (list 7, detail 7, update 9, revoke 16) chưa có bản Go | C, L26 (đề xuất) |

### 6.3 Dòng tracker trống ngoài `test-debt.md` (TR-01..TR-16)

| ID | Kết luận | Còn lại | Nhóm, lát |
|---|---|---|---|
| TR-01 | `explicit-columns`, `helper-sync`, `module-boundaries`: `thay bằng` (`conventions_test.go`, `imports_test.go`, `unrestricted_boundary_test.go`). `file-size-limit`: một phần | Ca web (`max-lines` cho `apps/web/src`) chỉ có ở spec TS; mất khi xóa `apps/api/test` | C, L24 |
| TR-02 | `route-inventory.helper`, `single-app`, `test-runner`: `bỏ`; `workspace.smoke-spec`: `thay bằng` (`config_test.go`, `app_test.go`); `time-source`: một phần | `internal/authentication` không bị `forbidigo` cấm `time.Now` và có một lời gọi ở `oidc_service.go:206`; chưa có test khẳng định authentication không tự đọc đồng hồ cho quyết định khác | C, L24 |
| TR-03 | Dòng 25 và 238: `thay bằng` (`httpapi/authorize_test.go`, `authority_test.go:85`). Dòng 221: một phần | `authority.List` của IAM đọc facts từ database (rule timestamp có tham số, cạnh hết hạn, boundary) chưa có; test authority chỉ dùng Root | B, L26 (đề xuất) |
| TR-04 | Năm dòng đều một phần (`task-8b-report.md` ghi "partial" là đúng) | `product-audit-permission` (Root `Execute`, detail sai shape rollback), `product-audit` (shape sự kiện IAM, handler thay thế), `product-authorization` (đọc facts theo permission, total trang rỗng khi chèn đồng thời), `product-root-access` (danh sách sự kiện chính xác, registry rỗng, key sai không ghi sự kiện, IAM đọc không audit, role tên `custom.root`), `hrm-permits-many` (phiên lạ, chờ fence, phiên hết hạn trong cửa sổ, giới hạn any-of, JIT) | B, L26 (đề xuất) |
| TR-05 | Dòng 69, 76: `thay bằng`. Dòng 68: một phần | Phạm vi `employee` của lead thu hẹp sau khi lead assignment và membership kết thúc (`employee_scope_integration_test.go` chỉ dựng assignment) | B, L26 (đề xuất) |
| TR-06 | `hrm-http-measure`, `hrm-permits-many-measure`: `bỏ`; `product-fence-io`, `product-load`: một phần | Xem §6.2 | C, L26 (đề xuất) |
| TR-07 | `thay bằng` cả năm dòng (`test/template.go`, `test/fixture`, `m1World`) | Dữ liệu hàng nghìn nhân viên của `hrm-report-http.helper` viết lại cùng M7-02, M7-04 | không thêm |
| TR-08 | `thay bằng` (đủ 11 ca) | không | không |
| TR-09 | `thay bằng` (`run_integration_test.go`, ma trận M1..M8, 30 ca Playwright: 9+6+5+3+2+2+1+1+1) | không | không |
| TR-10 | Một phần | Email ngoài ASCII (U+212A, U+0130, `ä`, điều khiển) qua `POST accounts` và `PUT accounts/:id/email` cho 400; hai hành vi charset của Express bỏ vì Go chặt hơn (400) | B, L12a |
| TR-11 | `port` (`employee_rate_repository_integration_test.go`; `internal/modules/setting` không ghi `leave_rate`) | không | không |
| TR-12 | Một phần | CLI đã phủ; quyền SQL của login bootstrap (không xóa `mfa_totp` IAM, không tăng epoch Root đang giữ factor, không đổi thêm cột) | B, L22 (RT-06, RT-07 đã có) |
| TR-13 | Dòng 198, 217: một phần | Dòng 198 trùng RT-09 (proof đã dùng); dòng 217: đua bootstrap (RT-05), revision của revoke, sync sau revoke không khởi tạo lại, bootstrap sau revoke, `UPDATE kind` trực tiếp (RT-04) | B, L22 và L23 (đã có) |
| TR-14 | Dòng 152: `thay bằng`; dòng 154: `bỏ`; dòng 176: một phần | Xem BI-20 ở §6.2 | B, L16; C, L24 |
| TR-15 | `role-validator.spec`: `port`. Các dòng còn lại giữ trống | `account-boundary`, `account-identity-operation` (BI-01, BI-02), `account-role` (AC-21), `grant-set` (A8-01, A8-02), `role-catalog` (R-23), `role-risk` (R-24), `role-runtime-constraint` (R-21), `role-grant` (R-06). `role-controller` cùng loại AC-21 và BI-02 | B, theo lát của từng ID; ba nợ unit controller (`role-controller`, AC-21, BI-02) cần một quyết định chung |
| TR-16 | bỏ (không có dòng tracker) | Vector TS đã chép cứng thay cho test chéo runtime: phiên và recovery code (`credential_test.go:29`, `:286`, `:345`), idempotency (`leave_hash_test.go`, `work_request_hash_test.go`), snapshot (`attendance_snapshot_helper_test.go:25`) | không |

### 6.4 Điều chưa xác minh hoặc cần người dùng chốt

- Chưa chạy test nào; mọi kết luận "đã phủ" dựa trên đọc assertion. Lát L26 được thêm vào §3 ở vòng sửa 1 theo yêu cầu của điều phối viên.
- BI-20: L0 giữ lại hai phần thay vì xóa theo ruling 112, vì probe ba hàm identity và CHECK ASCII không phải đường nâng cấp. Điều phối viên có thể chốt bỏ hẳn nếu chấp nhận rủi ro.
- R-22: đã khôi phục dòng nợ thu hẹp (COO và `hr.employee` không có menu `roles`).
- `role-controller`, AC-21, BI-02: cùng một loại (unit controller với port giả, ma trận HTTP đã phủ CSRF, Origin, 400); đề nghị quyết định một lần.
