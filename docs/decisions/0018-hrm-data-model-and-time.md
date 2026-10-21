# ADR 0018 — Mô hình dữ liệu HR, ngày nghiệp vụ và đơn vị phút

Ngày: 2026-10-17. **Trạng thái: Accepted** — người dùng duyệt 2026-10-17 (TD7, TD9); G0 D01–D10 đã chốt. Chưa triển khai. Thiết kế: [HRM design](../superpowers/specs/2026-10-16-hrm-design.md) §3, §8–§9.

## Quyết định

**Thời gian.** Ngày nghiệp vụ là PostgreSQL `date`; giờ trong ngày là phút `smallint` 0..1440; timezone nghiệp vụ `Asia/Ho_Chi_Minh` truyền tường minh; thời điểm sự kiện `timestamptz` theo đồng hồ DB. Phép/công là phút nguyên (`integer`), 120/240/480 = 0,25/0,5/1 ngày; không float.

**Bảng (tên đề xuất, mỗi resource có `object_id` UNIQUE FK `object_ref`):**

| Bảng                                              | Cột/ràng buộc chính                                                                                                                                                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `employee`                                        | `id` uuid, `code` text UNIQUE (`COLLATE "C"`, độ dài giới hạn), `full_name`, `account_id` uuid NULL UNIQUE FK `app_user`, `hired_on` date, `terminated_on` date NULL CHECK ≥ `hired_on`, `version` int8                                                            |
| `employee_identity`                               | PK/FK `employee_id`, `date_of_birth` date, `document_kind`, `document_number`, `tax_code`; UNIQUE `(document_kind, document_number)`                                                                                                                               |
| `employment_status_period`                        | `employee_id`, `status IN ('probation','official')`, `[starts_on, ends_on)`; không chồng khoảng                                                                                                                                                                    |
| `leave_rate`                                      | `employee_id`, `effective_from`, `annual_minutes` CHECK ≥ 5760                                                                                                                                                                                                     |
| `team`, `team_membership`, `team_lead_assignment` | khoảng hiệu lực `starts_at/ends_at`; nhiều team/nhân viên, cờ `is_primary` (đúng một hiện hành), tối đa một lead hiện hành mỗi team, một người lead nhiều team — partial UNIQUE trên dòng hiện hành                                                                |
| `work_calendar_version`, `calendar_day`           | ngày + loại (`workday`/`weekend`/`paid_holiday`/…) theo version                                                                                                                                                                                                    |
| `work_request`                                    | `employee_id`, `owner_account_id`, `team_id` (team chọn khi gửi), `kind`, `state`, `version`, `created_at`; không sửa nội dung sau submit                                                                                                                          |
| `work_request_segment`                            | `request_id`, `work_date`, `start_minute`, `end_minute`, `minutes`; CHECK slot theo kind                                                                                                                                                                           |
| `request_decision`                                | `request_id`, `stage`, `decision`, `actor_kind` (`user`/`system`), `actor_account_id` NULL khi system, `system_reason`, `decided_at`, lý do (`reason`, migration 107: 1..1000, bắt buộc khi `decision = 'reject'`, D08); UNIQUE `(request_id, stage)`; append-only |
| `hr_idempotency`                                  | ADR 0017                                                                                                                                                                                                                                                           |
| `wfh_month_counter`                               | T8 (migration `110`): PK `(employee_id, month)` (`month` = ngày đầu tháng của ngày WFH), `approved_count` CHECK 0..31, `revision` (vượt 4 chỉ cảnh báo + xác nhận, D04)                                                                                            |
| `leave_bucket`, `leave_ledger`                    | T7 (migration `109`): bucket `(employee_id, year)` là điểm khóa; ledger append-only `debit`/`reversal`/`opening`/`adjustment` — xem bổ sung 2026-10-21 (không lưu `accrual`)                                                                                       |
| `attendance_period`, `attendance_period_event`    | T8 (migration `110`): kỳ tháng `open`/`closed` toàn công ty, snapshot + SHA-256 khi chốt, lịch sử đóng/mở lại có lý do (D07) — xem bổ sung 2026-10-21 (T8). `attendance_adjustment` chưa có (HR điều chỉnh công, chưa làm)                                         |

**Không chồng khoảng** (`employment_status_period`, membership, lead): ưu tiên `EXCLUDE USING gist` nếu migration được tạo extension `btree_gist`; nếu không, kiểm dưới employee lock/exclusive fence kèm integration test. Cần kiểm quyền tạo extension của login migration trước khi chọn.

**Bảng công** là kết quả tính từ calendar version + employment period + approved effects + adjustments, không lưu tổng thành nguồn thứ hai; snapshot khi chốt kỳ (nếu D07 yêu cầu) gắn version.

**PII.** F2 không vào audit/log/URL/idempotency result. Mã hóa ứng dụng hoãn tới D13; trước đó dựa ACL + backup policy.

## Hệ quả

Migrations forward theo feature (T3/T4/T5/T6/T7/T8), mỗi lần cập nhật manifest, bindings, `expectedPrivileges` và probes. Ngày lễ do HR nhập theo nguồn đã xác minh; không seed suy đoán.

## Bổ sung 2026-10-19 — ngày làm bù (T4)

Người dùng chọn "Thêm ngày làm bù": thứ Bảy/Chủ nhật HR đánh dấu làm việc cả ngày, cùng ca 09:00–13:00/14:00–18:00 (480 phút); không có làm bù nửa ngày.

- **Dữ liệu:** không thêm bảng. `work_calendar_change.kind` thêm `makeup_workday` (không tên), migration forward `HrmWorkCalendarMakeup1792108800104` chuyển điều kiện ngày trong tuần từ cột `day` sang CHECK theo `kind`: `paid_holiday` chỉ thứ Hai–Sáu, `makeup_workday` chỉ thứ Bảy/CN, `standard` (về tuần chuẩn) mọi ngày. Mỗi dòng một `kind` và lịch của version N là dòng mới nhất mỗi ngày, nên một ngày không thể vừa là lễ vừa là làm bù. Dòng cũ đều là ngày thường `paid_holiday`/`standard` nên thỏa CHECK mới; ACL giữ nguyên (runtime chỉ INSERT lịch sử, UPDATE `work_calendar.version`).
- **Quyền:** dùng chung `workCalendar.manage` (`hrFresh`), không permission mới, không đổi manifest (release vẫn `7`). Audit cùng kind `hr.work-calendar.update`, chỉ id.
- **Tính giờ:** `dayKind` trả `makeup_workday`; `workingMinutes` tính như ngày thường. `leaveSlotMinutes` trên ngày làm bù từ chối với lý do riêng `makeup_day` — có cho đơn nghỉ trong ngày làm bù hay không là quyết định của T7, chưa chọn.

## Bổ sung 2026-10-21 — quỹ phép năm (T7, migration `109`)

- **Tích lũy không lưu**: `accrual` là hàm thuần của ngày vào làm, các khoảng trạng thái và `leave_rate` (spec §9, `leave/leave-balance.helper.ts#accruedByMonth`), nên không có nguồn thứ hai để lệch và định mức chuẩn/thỏa thuận chỉ có một nguồn (`leave_rate`, ≥ 5760). Vì vậy `entry_kind` chỉ còn `debit`, `reversal`, `opening`, `adjustment` (bỏ `accrual` so với bảng trên).
- **`leave_ledger`** (SELECT/INSERT cho `product_data`, không UPDATE/DELETE): `debit` 1..480 phút ứng với đúng một segment annual-leave (UNIQUE `(source_request_id, source_work_date)`, FK tới segment kèm `source_kind` sinh ra = `annual-leave`, nên không debit từ đơn loại khác hay segment không có); `reversal` UNIQUE theo debit và lặp lại employee/ngày/phút của debit bằng FK ghép; `opening`/`adjustment` có dấu, bắt buộc `reference` (nguồn đối soát, D14) — import số dư đầu kỳ là T12, không route runtime nào ghi hai loại này. Hoàn phép khi hủy đơn đã duyệt (D06): schema sẵn sàng, chưa có writer vì lệnh hủy chưa được triển khai.
- **`leave_bucket`** `(employee_id, year)` + `revision`: chỉ là điểm khóa của spec §7.3 bước 6 (grant `UPDATE(revision)` cũng là điều kiện để `FOR UPDATE`); revision đếm số lần ghi ledger dưới khóa.
- **Số dư** (D09): `entitled` = tích lũy đến hết tháng của ngày báo cáo + opening/adjustment dated đến tháng đó; `used`/`ahead` = debit − reversal theo ngày ≤/> ngày báo cáo; `pending` tính từ bảng đơn, không phải ledger; `available = max(0, …)`. Bất biến §8 theo từng tháng: `committed(≤ M) ≤ max(0, entitled(M))`. Submit kiểm approved + pending + đơn mới (422 `error.insufficientLeave`); effect duyệt kiểm approved + đơn đó (409 `insufficient_leave`), đơn chờ khác không bị tính ở đó (người duyệt quyết ai nhận phút cuối; phần vượt do điều chỉnh sau submit hiện ở danh sách đối soát cho HR).
- Ngày làm bù: đơn nghỉ trên ngày làm bù vẫn bị từ chối `makeup_day` (T4/T5); T7 không đổi quyết định đó.

## Bổ sung 2026-10-21 — bảng công (T8, migration `110`)

- **Bảng công không lưu**: `attendance-calculation.helper.ts#attendanceTotals` là hàm thuần của ngày vào làm/nghỉ việc, lịch một version (ngày lễ/làm bù) và các segment của đơn `approved` trong tháng; một statement SQL đọc mọi thứ (cùng snapshot) nên tính lại cùng đầu vào cho cùng kết quả. Công theo lịch = 480 × ngày làm việc (thứ Hai–Sáu không lễ, cộng ngày làm bù) trong khoảng `[hired_on, terminated_on]` (ngày làm cuối, gồm cả ngày đó); ngày lễ trong khoảng là `paidHolidayMinutes` (hưởng lương, không phải giờ làm việc); `paid = scheduled − unpaid + paidHoliday`; nghỉ phép năm chỉ ghi nhận; WFH đếm ngày; đi muộn/về sớm đếm số lần và phút (D05). Mỗi phút làm việc chỉ thuộc một loại nghỉ (phép năm xếp trước không lương) nên hai đơn chồng giờ không tính trùng. Segment ngoài khoảng làm việc hoặc ngoài ngày làm việc theo lịch bị bỏ qua.
- **`wfh_month_counter`**: đếm ngày WFH đã duyệt theo tháng của **ngày WFH** (D04, D-04); là điểm khóa spec §7.3 bước 6 và bộ đếm; khớp tổng segment WFH `approved` (test so sánh). Đơn nhiều tháng cộng từng tháng.
- **`attendance_period`** `(month)`: toàn công ty, không dòng = `open`; `state`, `version`, `snapshot` jsonb + `snapshot_hash` (CHECK: có đúng khi `closed`). Snapshot = `{month, calendarVersion, employees[{employeeId, …totals}]}` theo thứ tự id, JSON khóa cố định nên cùng đầu vào cho cùng hash (F-12). Mọi nhân viên có khoảng làm việc giao với tháng.
- **`attendance_period_event`**: append-only; `close` có hash, `reopen` có `reason` 1..1000 (D07); UNIQUE `(month, version)`; actor là `app_user`.
- ACL: `product_data` SELECT/INSERT cả ba bảng, UPDATE cột `approved_count, revision` của counter và `state, version, snapshot, snapshot_hash` của kỳ; không DELETE, không UPDATE lịch sử; login khác không đọc được. Probe đặc quyền (`hrPrivileges`) liệt kê đúng danh sách này.
- Chốt kỳ không cho đóng tháng sau tháng hiện tại [P]: snapshot của tháng chưa bắt đầu vô nghĩa (409 `future_period` → `error.conflict`). Chưa có: `attendance_adjustment`, chỉnh công/đơn quá khứ của HR, đối soát HR, UI đóng/mở kỳ (API có).
- `shortcut:` snapshot là một document jsonb cho cả công ty; tách theo nhân viên nếu một tháng vượt vài nghìn nhân viên. Đóng kỳ đọc nhân viên và hồ sơ trạng thái trong một statement nhưng không khóa chúng: sửa hồ sơ đúng lúc đóng có thể lệch một lần ghi (được snapshot ghi lại), mở lại và đóng lại là cách sửa.

shortcut (review độc lập T8A, 2026-10-21): `attendancePeriod` luôn tính lại từ dữ liệu sống cả với kỳ `closed`; `terminateEmployee`/`createEmployee` không khóa kỳ, nên đổi `terminated_on`/`hired_on` trong tháng đã chốt làm số liệu lệch `snapshot`/`snapshot_hash` mà không qua mở kỳ. `snapshot_hash` tính trên `JSON.stringify` còn cột là `jsonb`, nên chưa tái kiểm trực tiếp từ cột. Phải xử lý (đọc snapshot khi đóng hoặc khóa kỳ `FOR SHARE` ở hai lệnh hồ sơ) trước khi payroll/báo cáo T9 dùng bảng công.
