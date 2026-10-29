# ADR-08 — Dữ liệu HR, thời gian, lịch làm việc và PII

Thay thế các ADR cũ: 0016, 0018, 0028, 0039, 0040, 0042 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Code: schema ở `database/migrations/002-application-baseline.migration.ts`; `modules/employee`, `modules/team`, `modules/work-calendar`, `modules/permission` (anchor, `permission-database.helper.ts`), validator dùng chung `infrastructure/helpers/input-validation.helper.ts`. Quy trình đơn, phép và công: [ADR-09](ADR-09-requests-leave-attendance-idempotency.md); báo cáo: [ADR-10](ADR-10-reports-and-xlsx.md).

## Quyết định

### Thời gian và đơn vị

- Ngày nghiệp vụ là PostgreSQL `date`; giờ trong ngày là phút `smallint` 0..1440; timezone nghiệp vụ `Asia/Ho_Chi_Minh` truyền tường minh, không dùng timezone máy; thời điểm sự kiện là `timestamptz` theo đồng hồ DB (`statement_timestamp()`).
- Phép và công là phút nguyên (`integer`): 120/240/480 phút = 0,25/0,5/1 ngày. Không float.
- Ngày lịch do `inputDate` kiểm: `YYYY-MM-DD` ngày thật, năm 1900..2100; regex một mình không đủ.

### Resource và bản ghi

- Mỗi resource có `object_id` UNIQUE FK `object_ref`. Resource HR: `employee`, `team`, `workRequest`, `employeeIdentity` (F2), `leaveRate` (F3). Singleton `hrCompany`, `workCalendar`, `setting`, `role` có anchor do login `sync` tạo sau reconcile ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)).
- `object_id` cấp qua `public.hr_register_object(p_type text, p_key uuid)`: `SECURITY DEFINER`, `search_path` cố định, owner NOLOGIN `product_object_owner` (chỉ `INSERT` trên `object_ref`), `EXECUTE` chỉ cho `product_data`, danh sách type cố định trong thân hàm (`employee`, `team`, `workRequest`, `employeeIdentity`, `leaveRate`; không nhận anchor). Probe kiểm owner, thân hàm, volatility, `search_path` và ACL ([ADR-04](ADR-04-database-logins-acl-probes.md)). `GRANT INSERT object_ref` cho `product_data` bị loại (mở cho mọi type, kể cả type authority).
- Tạo bản ghi authorize trên bản ghi cha: `employee.submitRequest` (scope self) cho đơn; `hrCompany.createEmployee` (fresh) và `hrCompany.createTeam` cho nhân viên và team.
- Bảng chính (ràng buộc chốt):

| Bảng                                                | Ràng buộc chính                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employee`                                          | `code` `COLLATE "C"` UNIQUE 1..32; `full_name` 1..200; `account_id` UNIQUE FK `app_user` (null được); `hired_on >= 1950-01-01`; `terminated_on >= hired_on`; `version int8`; `job_position`, `classification`                                                                                                         |
| `employee_identity` (1:1, PK `employee_id`)         | `date_of_birth >= 1900-01-01`; `document_kind` ∈ `cccd`/`cmnd`/`passport` và `document_number` `^[A-Z0-9]{6,20}$` (cùng có hoặc cùng null), UNIQUE `(document_kind, document_number)`; `tax_code` `^[0-9]{10,13}(-[0-9]{3})?$`; `gender`, `phone`, `work_email`                                                       |
| `employment_status_period`                          | `status` ∈ `probation`/`official`, `[starts_on, ends_on)`, tối đa một kỳ đang mở mỗi nhân viên (partial UNIQUE), UNIQUE `(employee_id, starts_on)`                                                                                                                                                                    |
| `leave_rate` (F3, chỉ thêm)                         | `effective_from`, `annual_minutes` 5760..175680 (12 đến 366 ngày × 480), UNIQUE `(employee_id, effective_from)`                                                                                                                                                                                                       |
| `team`, `team_membership`, `team_lead_assignment`   | Khoảng hiệu lực `starts_at/ends_at`; partial UNIQUE trên dòng đang mở: một membership `(employee, team)`, một team chính mỗi nhân viên, một lead mỗi team; một người lead nhiều team; tên team UNIQUE `lower(name)`. Không dùng `EXCLUDE`/`btree_gist`: kiểm khoảng trong command dưới exclusive fence (mode `admin`) |
| `work_calendar` (singleton), `work_calendar_change` | Xem mục lịch                                                                                                                                                                                                                                                                                                          |

- Membership, lead, account link và role HR là facts: đổi dưới exclusive fence, kiểm affected set, tăng revision ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)). `product_authority` ghi các bảng đó; `product_data` chỉ `SELECT`, và `UPDATE(version)` trên `employee`/`team` để khóa dòng.
- Scope bằng domain relation trên view `security_invoker` (không mở rộng compiler sang resource → resource, có parity test SQL ↔ evaluator): `hr_team_member`, `hr_team_lead`, `hr_employee_lead`, `hr_employee_owner`, `hr_leave_rate_owner` (view của đơn: [ADR-09](ADR-09-requests-leave-attendance-idempotency.md)). Tài khoản luôn lấy từ liên kết `employee.account_id` hiện hành, không sao chép, nên đổi liên kết dời scope ở transaction kế tiếp. Lead dùng assignment hiện hành: thu hồi có hiệu lực ở transaction kế tiếp sau commit.

### Field ACL và PII

- F1 (thông tin tổ chức): hiển thị cho ai đọc được `employee` (chi tiết, không ở danh sách); gồm `position` (`job_position`) và `classification`. F2 (định danh cá nhân) là resource `employeeIdentity`: ngày sinh, loại và số giấy tờ (CCCD), mã số thuế, `gender`, `phone`, `workEmail`. F3 là resource `leaveRate`. Không ẩn cột ở controller; quyền đọc/ghi từng nhóm là permission riêng.
- Mặc định: nhân viên đọc F2/F3 của chính mình; Team Lead và COO không đọc; `hr.admin` đọc và sửa F2 (`employeeIdentity.update`, fresh) và đọc F3; nhân viên không tự sửa CCCD. Root không được hứa field ACL ([ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)).
- F2 chỉ nằm trong `EmployeeIdentityView`; không vào `EmployeeView`, danh sách, `GET /api/hr/employees/me`, URL, log, audit (chỉ id/kind), idempotency result hay báo cáo ([ADR-10](ADR-10-reports-and-xlsx.md)). Mã hóa ứng dụng F2 hoãn (D13); hiện dựa ACL và backup policy.
- Trường hồ sơ mở rộng, validator và CHECK DB giống nhau; mọi trường nullable (`null` = chưa ghi nhận/xóa):
  - `gender` ∈ `male|female|other`; `classification` ∈ `fullTime|contractor`; giá trị lạ là 400. Nhãn là key locale (`employee.gender.*`, `employee.classification.*`).
  - `phone`: bỏ khoảng trắng, `.`, `-`, `(`, `)`; đầu `+84` đổi thành `0`; phải khớp `^0[1-9][0-9]{8,9}$`; lưu dạng chuẩn; mã nước khác, chữ cái, `84` trần, độ dài khác bị từ chối.
  - `workEmail`: trim, chữ thường, tối đa 254; local gồm `a-z 0-9 _ + -` ngăn bởi dấu chấm đơn; domain kiểu DNS (label ≤ 63, TLD chữ ≥ 2); không tên hiển thị, nháy, comment, IP literal, ký tự không ASCII.
  - `position`: trim, 1..100 code point, không ký tự điều khiển; DB `COLLATE "C"` kèm CHECK `btrim` và `!~ '[[:cntrl:]]'`.
  - `phone` và `workEmail` không UNIQUE: UNIQUE sẽ trả 409 và lộ bản ghi khác ngoài scope; chống trùng, nếu cần, làm ở tầng nghiệp vụ trên dữ liệu người gọi được xem.
  - `workEmail` là dữ liệu liên hệ, không bao giờ dùng để đăng nhập, enrollment, so khớp `app_user.email`, liên kết `employee.account_id` hay quyết định quyền. Vận hành enroll tài khoản bằng chính địa chỉ này nhưng hai giá trị độc lập.
- API: `POST /api/hr/employees` (kèm `identity`), `PATCH /api/hr/employees/{id}` (thay cả F1, cần `expectedVersion`), `PUT /api/hr/employees/{id}/identity` (thay cả F2). Mọi key bắt buộc có mặt, `null` để xóa, key thừa bị từ chối; không thêm mã lỗi.

### Định mức phép năm (F3) và chính thức

- Thử việc không tích lũy phép: `createEmployee` với `status = probation` không ghi `leave_rate`, và gửi `annualLeaveMinutes` (kể cả `null`) kèm `probation` là 400. `status = official`: `annualLeaveMinutes` tùy chọn; bỏ trường thì dùng setting `hr.annualLeaveDefaultMinutes` hiện hành (mặc định 5760, đọc trong transaction lúc sắp ghi, [ADR-12](ADR-12-administration-accounts-settings-roles.md)); giá trị gửi lên vẫn trong [5760, 175680]. Dòng ghi tại `hiredOn`.
- `confirmOfficial` (`employee.update`, mode write, không fresh; `POST /api/hr/employees/{id}/official`): đóng kỳ thử việc, mở kỳ `official` từ `effectiveOn` (có thể ở tương lai), rồi ghi dòng định mức mặc định từ `effectiveOn` chỉ khi chưa có dòng nào của nhân viên có `effective_from <= effectiveOn` (khóa employee của lệnh giữ cho không race). Định mức HR đặt trước, dòng cũ và dòng trùng ngày được giữ; dòng chỉ hiệu lực sau `effectiveOn` không che nên mặc định vẫn thêm. Lệnh không hạ hay nâng định mức đã có; định mức riêng từng người luôn qua `adjustLeaveRate` (fresh). Mặc định phép là setting không fresh (`setting.updateRule`), nên người giữ quyền đó nâng được định mức cho các lần chính thức sau, không hồi tố. Muốn định mức khác mặc định: gọi `adjustLeaveRate` với `effective_from <= effectiveOn` trước khi xác nhận; UNIQUE `(employee_id, effective_from)` từ chối dòng thứ hai cùng ngày nên điều chỉnh tiếp phải dùng ngày kế.
- Tích lũy đổi hồi tố từ ngày hiệu lực, nên `confirmOfficial` gọi `assertSheetsOpenFrom` như `terminateEmployee`/`createEmployee`: có kỳ công `closed` từ tháng của ngày hiệu lực trở đi thì 409 `error.periodClosed`, kiểm trước kiểm trạng thái. Thứ tự khóa employee → company ([ADR-09](ADR-09-requests-leave-attendance-idempotency.md)).
- Audit dùng kind sẵn có: `hr.employee.status` và, khi thực sự ghi dòng, một `hr.leave-rate.adjust` (id/kind). Không đổi định mức đã ghi khi setting đổi (không hồi tố).
- `leaveBalanceView`: `annualMinutes` là `null` khi ngày tra không thuộc kỳ `official` (kể cả có dòng cũ ghi lúc vào làm) hoặc thiếu dòng (không đoán); báo cáo phép trả `null`/ô trống cho hàng thử việc, các số tích lũy giữ nguyên. `adjustLeaveRate` và `adjustLeaveBalance` không chặn nhân viên thử việc ở API; UI ẩn nút. Web: ô định mức chỉ hiện khi chọn "Chính thức"; hồ sơ thử việc không có khối định mức; form xác nhận mặc định hôm nay (`businessToday`) và cảnh báo không chặn khi ngày tương lai; chi tiết hiện "Sẽ chính thức từ dd/mm/yyyy".

### Team và trưởng nhóm

- Bất biến: lead hiện hành của team là thành viên đang mở (`ends_at IS NULL`) của đúng team đó; do ứng dụng kiểm, không constraint DB. Lead kiêm thành viên là hợp lệ và cần thiết (đơn của lead chọn team mình bỏ bước lead, [ADR-09](ADR-09-requests-leave-attendance-idempotency.md)).
- `assignLead` (`team.assign`, mode admin) với `employeeId` khác `null`, sau guard `assignable` (tồn tại, còn làm việc, không phải chính mình), yêu cầu membership đang mở ở team: không thì `lead_not_member`. `employeeId = null` gỡ lead, không kiểm. `endMembership` của lead hiện hành bị `member_is_lead`: phải gán lead khác (là thành viên) hoặc gỡ lead trước. Thứ tự kiểm trong `endMembership`: `not_member`, `primary_required`, `member_is_lead`; cả ba là 409 `error.conflict`, client không phân biệt, chỉ trả sau khi authorize `team.assign` trên team đích.
- `addMember` cho lead là bình thường; `setPrimaryTeam`/`demotePrimary` kết thúc rồi thêm lại membership trong một transaction nên bất biến giữ; `terminateEmployee` không kết thúc membership hay lead. Mọi lệnh team là mode admin nên gán lead và kết thúc membership đồng thời tuần tự hóa dưới exclusive fence.
- Web: nhãn "Trưởng nhóm" (`team.member.lead`); nút xóa của lead bị tắt kèm gợi ý; ô chọn lead chỉ liệt kê thành viên đang mở trừ lead hiện hành. API vẫn là bên quyết định.

### Lịch làm việc

- Lịch là `work_calendar` singleton có `version`; mỗi thay đổi là một dòng append-only `work_calendar_change` (`version` PK ≥ 2, `day` 1900..2100, `kind`, `name`); lịch của version N là dòng mới nhất mỗi ngày. `kind` ∈ `standard` (về tuần chuẩn, mọi ngày), `paid_holiday` (chỉ thứ Hai–Sáu, bắt buộc `name` 1..200), `makeup_workday` (chỉ thứ Bảy/Chủ nhật, không `name`); CHECK DB theo `kind`. Một ngày không thể vừa lễ vừa làm bù. Ngày làm bù là cả ngày 480 phút với ca 09:00–13:00 và 14:00–18:00, không có làm bù nửa ngày. Ngày lễ do HR nhập theo nguồn đã xác minh, không seed suy đoán.
- Quyền `workCalendar.manage` (fresh) cho cả hai route; audit `hr.work-calendar.update` chỉ id. `PUT /api/hr/work-calendar/days/:date` (từng ngày; còn dùng để bỏ lễ, đặt làm bù).
- `PUT /api/hr/work-calendar/holidays`, body đúng bốn key `{ expectedVersion, from, to, name }`: `from ≤ to`, tối đa 31 ngày lịch (cả hai đầu, có thể bắc năm), thứ Bảy/Chủ nhật trong khoảng bị bỏ qua nên một lần tạo tối đa 23 version; khoảng không có ngày thường nào là 400. Một transaction, một audit, mỗi ngày thay đổi một version liên tiếp theo thứ tự ngày (mọi version cũ vẫn chính xác); phản hồi `{ version }` là version cuối. Ngày đã là `paid_holiday` đúng tên đó thì bỏ qua; không còn ngày nào đổi thì 409 `error.conflict` (`unchanged`); đổi tên khoảng đã có ghi lại các ngày khác tên.
- Khóa: `execute` khóa hàng lịch `FOR NO KEY UPDATE`, rồi `assertPeriodsOpen` trên các ngày thường (≤ 2 tháng, sắp sẵn, `FOR SHARE`); tháng đã chốt thì 409 `error.periodClosed` cho cả khoảng và không ghi gì; `expectedVersion` kiểm sau khi có khóa (`stale_version`, 409). Web: form Từ ngày/Đến ngày/Tên hiện số ngày áp dụng và kiểm trước ở client (key `calendar.form.*`).

## Quyết định của người dùng

- 2026-10-19: thêm ngày làm bù (thứ Bảy/Chủ nhật làm cả ngày, không nửa ngày); `workEmail` chỉ là dữ liệu liên hệ, operator enroll tài khoản bằng chính địa chỉ đó.
- 2026-10-23: thử việc không có định mức, định mức phát sinh khi chính thức; ngày chính thức ở tương lai được phép; lead phải là thành viên đang mở của team, chặn `endMembership` của lead thay vì tự gỡ lead; nhập nghỉ lễ theo khoảng ngày (một audit, mỗi ngày một version).

## Chưa làm / điều mở

- Mã hóa ứng dụng cho F2 (D13).
- `adjustLeaveRate`/`adjustLeaveBalance` chưa chặn nhân viên thử việc ở API; `seed/import-employees.mjs` (gitignored) vẫn gửi `annualLeaveMinutes` cho nhân viên thử việc nên nhận 400.
- Dữ liệu cũ có thể có lead không phải thành viên (trước khi có bất biến); không có migration dọn. Truy vấn đọc cho operator: lấy `team_lead_assignment` đang mở không có `team_membership` đang mở tương ứng; xử lý tay bằng `POST /api/hr/teams/:id/members` hoặc `PUT /api/hr/teams/:id/lead`.
- Nhân viên thử việc cũ vẫn có dòng `leave_rate` ghi lúc vào làm (append-only, vô hại vì thử việc không tích lũy).
- Không có `EXCLUDE`/`btree_gist` cho khoảng chồng; nếu cần ràng buộc DB phải kiểm quyền tạo extension của login migration.
