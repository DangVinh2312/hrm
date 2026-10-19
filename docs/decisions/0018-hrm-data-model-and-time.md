# ADR 0018 — Mô hình dữ liệu HR, ngày nghiệp vụ và đơn vị phút

Ngày: 2026-10-17. **Trạng thái: Accepted** — người dùng duyệt 2026-10-17 (TD7, TD9); G0 D01–D10 đã chốt. Chưa triển khai. Thiết kế: [HRM design](../superpowers/specs/2026-10-16-hrm-design.md) §3, §8–§9.

## Quyết định

**Thời gian.** Ngày nghiệp vụ là PostgreSQL `date`; giờ trong ngày là phút `smallint` 0..1440; timezone nghiệp vụ `Asia/Ho_Chi_Minh` truyền tường minh; thời điểm sự kiện `timestamptz` theo đồng hồ DB. Phép/công là phút nguyên (`integer`), 120/240/480 = 0,25/0,5/1 ngày; không float.

**Bảng (tên đề xuất, mỗi resource có `object_id` UNIQUE FK `object_ref`):**

| Bảng                                              | Cột/ràng buộc chính                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employee`                                        | `id` uuid, `code` text UNIQUE (`COLLATE "C"`, độ dài giới hạn), `full_name`, `account_id` uuid NULL UNIQUE FK `app_user`, `hired_on` date, `terminated_on` date NULL CHECK ≥ `hired_on`, `version` int8 |
| `employee_identity`                               | PK/FK `employee_id`, `date_of_birth` date, `document_kind`, `document_number`, `tax_code`; UNIQUE `(document_kind, document_number)`                                                                    |
| `employment_status_period`                        | `employee_id`, `status IN ('probation','official')`, `[starts_on, ends_on)`; không chồng khoảng                                                                                                         |
| `leave_rate`                                      | `employee_id`, `effective_from`, `annual_minutes` CHECK ≥ 5760                                                                                                                                          |
| `team`, `team_membership`, `team_lead_assignment` | khoảng hiệu lực `starts_at/ends_at`; nhiều team/nhân viên, cờ `is_primary` (đúng một hiện hành), tối đa một lead hiện hành mỗi team, một người lead nhiều team — partial UNIQUE trên dòng hiện hành     |
| `work_calendar_version`, `calendar_day`           | ngày + loại (`workday`/`weekend`/`paid_holiday`/…) theo version                                                                                                                                         |
| `work_request`                                    | `employee_id`, `owner_account_id`, `team_id` (team chọn khi gửi), `kind`, `state`, `version`, `created_at`; không sửa nội dung sau submit                                                               |
| `work_request_segment`                            | `request_id`, `work_date`, `start_minute`, `end_minute`, `minutes`; CHECK slot theo kind                                                                                                                |
| `request_decision`                                | `request_id`, `stage`, `decision`, `actor_kind` (`user`/`system`), `actor_account_id` NULL khi system, `system_reason`, `decided_at`, lý do; UNIQUE `(request_id, stage)`; append-only                  |
| `hr_idempotency`                                  | ADR 0017                                                                                                                                                                                                |
| `wfh_month_counter`                               | PK `(employee_id, month)`, `approved_count` CHECK ≥ 0 (vượt 4 chỉ cảnh báo, D04)                                                                                                                        |
| `leave_ledger`                                    | `employee_id`, `year`, `effective_on`, `entry_kind` (`accrual`/`debit`/`reversal`/`adjustment`), `minutes`, `source_segment_id` UNIQUE, `reverses_entry_id` UNIQUE                                      |
| `attendance_adjustment`, `attendance_period`      | kỳ tháng `open`/`closed`, snapshot khi chốt, lịch sử mở lại có lý do (D07)                                                                                                                              |

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
