# ADR-19 — Giờ làm việc tùy chỉnh: lịch chung theo thứ và khung giờ riêng của nhân viên

Trạng thái: **Accepted** (2026-11-04). Người dùng chọn:

- **Phạm vi:** theo nhân viên.
- **Mức tùy biến:** theo từng thứ trong tuần.
- **Mô hình:** lịch chung của công ty quyết định ngày làm. Nhân viên có thể có khung giờ riêng trong một khoảng ngày, có tùy chọn "cả tháng". Khung riêng chỉ đổi giờ trong các ngày làm của công ty.
- **Hiệu lực:** theo ngày, **chỉ từ ngày mai**.
- **Người sửa:** HR, qua permission riêng.
- **Khung xin nghỉ:** theo giờ tròn trong ca.
- **Sổ phép:** theo phút thực, hiển thị 1 ngày = 480 phút.
- **Đổi lịch khi đã có đơn:** cho đổi, đơn cũ giữ số cũ.
- **Ngày lễ:** được rơi vào mọi thứ trong tuần.
- **Độ dài tối đa một ngày:** chỉnh được, mặc định 8 giờ.
- **Ngày làm bù:** khai báo chung. HR chọn giờ theo khung chung của công ty, hoặc theo khung của từng nhân viên.
- **Giờ ca:** tối đa 3 ca mỗi ngày, mốc giờ theo bước 5 phút.

Bổ sung [ADR-09](ADR-09-requests-leave-attendance-idempotency.md) (đơn, phép, công) và lịch T4. Không đổi mô hình quyền ([ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)) hay fence ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)).

## Quan sát

Giờ làm đang là hằng số trong code và trong ràng buộc DB:

- `work-calendar/working-time.helper.ts`: hai ca 540–780, 840–1080 và 7 khung nghỉ cố định.
- `attendance/helpers/attendance-calculation.helper.ts`: hai ca chép lại và `DAY_MINUTES = 480`.
- `work-request/helpers/work-request.helper.ts`: mốc đi muộn/về sớm 541..780, 841..1079; WFH cố định 540–1080/480.
- CHECK `ck_work_request_segment_slot` liệt kê đúng các khung trên.
- CHECK `ck_work_calendar_change_kind` chỉ cho ngày lễ vào thứ 2–6, ngày làm bù vào thứ 7/CN.
- `leave_ledger` (debit/reversal) giới hạn mỗi lần trừ tối đa 480 phút.
- Web: `features/work-request/work-request.helper.ts` chép 7 khung nghỉ.

## Quyết định

### Khung giờ

**Khung giờ** là danh sách 0–3 ca `[start, end)`, tính bằng phút trong ngày:

- Các mốc là bội của 5, nằm trong khoảng `0 ≤ start < end ≤ 1440`.
- Các ca sắp tăng và không chồng nhau.
- Không ca nào qua nửa đêm.
- Tổng độ dài các ca không vượt setting `hr.workdayMaxMinutes` (nhóm `rule`, đơn vị phút, mặc định 480, từ 60 đến 720).
- Setting chỉ áp khi ghi khung mới; hạ setting không làm khung đã lưu thành sai.
- Kiểm tra bằng một hàm thuần duy nhất. DB giữ CHECK theo từng dòng (bước 5, `start < end`, thứ tự ca 1..3); thứ tự và không chồng nhau do code kiểm.

### Lịch chung

**Lịch chung** gồm các phiên bản, mỗi phiên bản có ngày `effective_from` và một khung cho mỗi thứ 1..7 (ISO); thứ không có ca là ngày nghỉ.

- Migration tạo phiên bản đầu bằng đúng hằng số hiện tại, hiệu lực từ `1900-01-01`: thứ 2–6 làm 09:00–13:00 và 14:00–18:00, thứ 7 và CN nghỉ. Nhờ vậy mọi ngày đã qua vẫn tính như cũ.
- Phiên bản áp cho một ngày là phiên bản có `effective_from` lớn nhất không vượt quá ngày đó.

### Khung riêng của nhân viên

**Khung riêng** gồm khoảng ngày `[valid_from, valid_to]` (`valid_to` để trống là không hạn) và một khung cho một số thứ.

- Thứ không khai báo thì dùng lịch chung.
- Khung riêng chỉ đổi giờ trong ngày làm của công ty, không thêm hay bớt ngày làm. Thứ mà lịch chung (phiên bản tại `valid_from`) nghỉ thì không nhận khung riêng (400). Nếu phiên bản sau đổi thứ đó thành nghỉ, khung riêng của thứ ấy bị bỏ qua.
- Các khoảng của cùng một nhân viên không được chồng nhau (`409 error.conflict`). Code kiểm việc này dưới khóa hàng `employee`; DB không có exclusion constraint vì như vậy phải cài `btree_gist`.
- "Cả tháng" trên web chỉ điền sẵn ngày đầu (không sớm hơn ngày mai) và ngày cuối tháng, không phải khái niệm lưu riêng.
- Tháng hiện tại có thể chốt công trước khi hết tháng, nên mọi lệnh đổi giờ (lịch chung, khung riêng) bị từ chối `409 error.periodClosed` khi tháng của ngày đầu tiên bị đổi đã chốt; tháng sau chưa chốt được.

### Ngày làm bù và ngày lễ

**Ngày làm bù** khai báo chung cho cả công ty, có thêm hai trường:

- `as_weekday` (1..7): làm theo giờ của thứ nào.
- `frame_source`:
  - `company`: mọi người làm theo khung của lịch chung cho thứ đó;
  - `employee`: mỗi người làm theo khung của mình cho thứ đó (khung riêng nếu có, không thì lịch chung).
- Ngày làm bù chỉ được đặt vào ngày mà lịch chung nghỉ.
- Các dòng làm bù đã có nhận `as_weekday = 1`, `frame_source = 'company'`, đúng với giờ chuẩn hiện tại.
- Đổi hoặc bỏ một phiên bản lịch chung mà làm một ngày làm bù từ ngày đó trở đi trái hai quy tắc trên thì bị từ chối (`409 error.conflict`); HR bỏ ngày làm bù trước.
- Bỏ ngày làm bù (`makeup: null`) chỉ áp cho ngày đang là làm bù, bỏ ngày lễ (`holiday: null`) chỉ cho ngày đang là lễ; ngược lại là `409 error.conflict`, không xóa nhầm loại kia.

**Ngày lễ** được đặt vào mọi thứ. Đó là ngày nghỉ có lương với ai có khung hôm đó; số phút lễ là khung người đó lẽ ra làm.

### Giờ của nhân viên P vào ngày D

Quy tắc thuần `frameOn(D)`:

1. Gọi `w` là thứ của D, `C(x)` là khung của lịch chung cho thứ x tại phiên bản hiệu lực ngày D, `O(x)` là khung riêng của P phủ ngày D cho thứ x (nếu có).
2. D là ngày làm bù:
   - `frame_source = 'company'`: lấy `C(as_weekday)`;
   - `frame_source = 'employee'`: lấy `O(as_weekday) ?? C(as_weekday)`;
   - loại ngày là `makeup_workday`.
3. D là ngày lễ: loại ngày là `paid_holiday`, khung là `C(w)` khi `C(w)` có ca, lúc đó khung riêng cũng áp như một ngày thường (`O(w) ?? C(w)`). Nếu `C(w)` rỗng thì ngày lễ không có tác dụng với P (coi như ngày nghỉ).
4. Ngày khác: `C(w)` rỗng thì nghỉ; không thì làm việc với khung `O(w) ?? C(w)`.

### Hiệu lực

- Ghi một phiên bản lịch chung, hay thêm, sửa, xóa khung riêng, chỉ được chạm tới ngày ≥ ngày mai, theo ngày nghiệp vụ (Asia/Ho_Chi_Minh) lấy từ đồng hồ DB.
- Khung riêng đang chạy (`valid_from ≤ hôm nay`) không bị xóa. Sửa nó nghĩa là đặt `valid_to = hôm nay`, rồi thêm một khung mới từ ngày mai.
- Phiên bản lịch chung có `effective_from ≥ ngày mai` được thay hoặc xóa; phiên bản đã có hiệu lực thì không đổi được.
- Vì không bao giờ đổi hôm nay hay quá khứ, tháng đã chốt công không bị ảnh hưởng.

### Đơn

- **Nghỉ phép, nghỉ không lương:**
  - Khoảng `[start, end)`, mỗi mép là mép ca hoặc một giờ tròn (bội 60) nằm trong ca của ngày đó.
  - `start < end`; số phút là phần giao với các ca và phải > 0.
  - Thay cho 7 khung cố định; mọi khung cũ vẫn hợp lệ với lịch mặc định.
  - Nghỉ phép vào ngày làm bù vẫn bị từ chối như trước.
- **WFH:** cả ngày theo khung hôm đó, từ đầu ca đầu tới cuối ca cuối, số phút là tổng khung.
- **Đi muộn, về sớm:** tính theo ca chứa giờ dự kiến m.
  - Muộn khi `start < m ≤ end` và m trước cuối ca cuối, đoạn tính là `[start, m)`. Đến đúng cuối ca cuối là không làm gì cả, nên không phải đi muộn.
  - Sớm khi `start < m < end`, đoạn tính là `[m, end)`.
  - Với lịch mặc định, quy tắc này trùng đúng các mốc 541..780, 841..1079 hiện nay.
- **Lưu trữ:**
  - Đơn đã gửi giữ nguyên segment và số phút lúc gửi; sổ phép giữ số đã trừ.
  - Bảng công tính theo khung hiện hành của từng ngày, nên với một đơn gửi trước lần đổi lịch, số phút trên bảng công có thể khác số đã trừ phép. Người dùng chấp nhận điều này.
- **Ràng buộc DB:**
  - CHECK `ck_work_request_segment_slot` được thay bằng ràng buộc chung: `0 ≤ start < end ≤ 1440`, `minutes` từ 1 đến 720, đi muộn/về sớm có `minutes = end − start`, nghỉ và WFH có `minutes ≤ end − start` (WFH mặc định là 540–1080 với 480 phút).
  - Khung có hợp lệ hay không là việc của code, vì khung thay đổi theo người và theo ngày.

### Phép và công

- Sổ phép vẫn tính bằng phút. CHECK của `debit`/`reversal` được nới từ `≤ 480` lên `≤ 720`.
- Web hiển thị ngày bằng `phút / 480`.
- Bảng công:
  - `scheduledMinutes` là tổng khung của các ngày làm;
  - `paidHolidayMinutes` là tổng khung của các ngày lễ (thay `DAY_MINUTES`);
  - phút nghỉ là phần giao với khung của ngày đó.
  - Tháng đã chốt giữ snapshot như cũ.

### Quyền

Release tăng sequence; mọi hành động ghi đều audit và là `fresh@1`.

- **Lịch chung** (bản ghi neo `work_calendar`):
  - đọc: `workCalendar.read`, đã có grant cho Employee, COO, Admin;
  - ghi: action mới `workCalendar.manageSchedule`, grant cho Admin.
- **Khung riêng** (trên bản ghi `employee`, giống `adjustLeaveRate`):
  - `employee.readSchedule`: self, lead đọc thành viên, HR;
  - `employee.manageSchedule`: HR, scope theo bản ghi nhân viên.
- **Tra giờ cho form đơn:** `GET /api/hr/employees/:id/schedule?from&to` trả khung đã tính cho từng ngày (tối đa 92 ngày), qua `employee.readSchedule` (self, lead, HR). Route theo id giống `leave-balance`; web lấy id từ `GET /api/hr/employees/me`.
- **API ghi:**
  - `PUT`/`DELETE /api/hr/work-calendar/schedule/:effectiveFrom`: thay hoặc xóa phiên bản lịch chung;
  - `POST /api/hr/employees/:id/schedule-frames`: thêm khung riêng (201);
  - `DELETE /api/hr/employees/:id/schedule-frames/:frameId`: xóa khung chưa chạy, hoặc kết thúc khung đang chạy vào hôm nay.
- **Mã lỗi:** không thêm key mới.
  - Ghi trùng nội dung hiện có, khung chồng nhau, hoặc phiên bản/khung không tồn tại trên bản ghi đã được phép ghi: `409 error.conflict`.
  - Người không có quyền ghi trên nhân viên đích: `404`, như mọi lệnh ghi khác.

### Thứ tự triển khai

Mỗi bước có test riêng:

- [x] 1. Hàm thuần `frameOn`, kiểm tra khung, khoảng nghỉ, đi muộn/về sớm. Unit test đối chiếu lịch mặc định với đúng các mốc cũ (parity). Có ở `modules/work-schedule/helpers/work-schedule.helper.ts`, test `test/hrm-work-schedule.spec.ts`.
- [x] 2. Migration forward:
  - bảng `work_schedule`, `work_schedule_shift`, `employee_schedule`, `employee_schedule_shift`;
  - hai cột làm bù;
  - nới các CHECK; seed phiên bản đầu;
  - privileges và probe. Integration chạy trên PostgreSQL thật, gồm nâng cấp database đã có dữ liệu.
  - Có ở `modules/work-schedule/work-schedule.migration.ts`, test `test/hrm-work-schedule-upgrade.integration-spec.ts`.
- [x] 3. Đơn, phép, bảng công, báo cáo đọc khung theo từng nhân viên và từng ngày, thay hằng số. Đọc qua `modules/work-schedule/helpers/work-schedule-sql.helper.ts` và `repositories/work-schedule-read.repository.ts`; test ở các spec request, leave, attendance, report và effects-equivalence.
- [x] 4. Quyền, lệnh và API: lịch chung, khung riêng, `:id/schedule`, khai báo làm bù kèm giờ, setting `hr.workdayMaxMinutes`, OpenAPI. Release 6 (`workCalendar.manageSchedule`, `employee.readSchedule|manageSchedule`), module `modules/work-schedule/`; test `test/hrm-work-schedule.integration-spec.ts`, `test/hrm-work-schedule.spec.ts` (validator), `test/product-genesis.integration-spec.ts` (nâng 5 → 6), `test/structure.spec.ts` (route, OpenAPI), `test/product.e2e-spec.ts` (HTTP).
- [x] 5. Web:
  - màn "Giờ làm việc" (lịch chung theo thứ, ngày hiệu lực);
  - mục "Giờ làm riêng" trong hồ sơ nhân viên, có nút "Cả tháng";
  - form đơn lấy giờ từ `employees/:id/schedule`;
  - lịch hiển thị ngày làm bù "làm như thứ X";
  - locale `vi`/`en`, e2e.

  Code: `apps/web/src/components/week-frames*.ts(x)`, `features/work-calendar/components/company-schedule.component.tsx`, `features/employee/components/employee-schedule.component.tsx`. Form ngày lễ và ngày làm bù kiểm theo lịch chung đã tải (`workdaysInRange`), không còn giả định thứ Bảy/Chủ nhật. Test: `test/week-frames.helper.spec.ts`, `test/employee-schedule.spec.tsx`, `test/work-calendar.spec.tsx`, `test/work-request.spec.tsx`, `e2e/work-calendar.e2e-spec.ts`, `e2e/work-request.e2e-spec.ts`.

## Ngoài phạm vi

- Lịch theo team.
- Ca qua nửa đêm.
- Khung riêng thêm hay bớt ngày làm.
- Đổi lịch có hiệu lực từ hôm nay hoặc quá khứ (sai sót thì dùng điều chỉnh công).

## Hệ quả

- Chạm 6 module API (work-calendar, work-request, leave, attendance, report, employee), migration, release và web.
- Rủi ro chính: bảng công lệch với số phút của đơn đã gửi trước một lần đổi lịch (đã chấp nhận). Mọi ngày trước lần đổi đầu tiên vẫn tính như cũ nhờ phiên bản gốc.
- Không có cache khung: mỗi lần đọc, khung được tính trong cùng giao dịch và cùng phạm vi quyền với dữ liệu nó áp vào.
