# ADR 0042 — Nghỉ lễ theo khoảng ngày

Ngày: 2026-10-23. **Trạng thái: Accepted** (người dùng duyệt phương án A). Bổ sung [ADR 0018](0018-hrm-data-model-and-time.md) (lịch làm việc versioned, append-only). Không migration, không action/permission mới, release và canonical hash không đổi; chỉ OpenAPI có route mới (sha ghim trong `apps/api/test/structure.spec.ts` đổi vì lý do này).

## Bối cảnh

Nghỉ Tết kéo dài nhiều ngày, nhập từng ngày một (`PUT /api/hr/work-calendar/days/:date`) tốn công và tạo nhiều audit. Người dùng cần nhập một khoảng ngày.

## Quyết định

1. **Route mới** `PUT /api/hr/work-calendar/holidays`, body `{ expectedVersion, from, to, name }`, permission `workCalendar.manage` (fresh) như route từng ngày. Route từng ngày giữ nguyên (còn dùng để bỏ một ngày nghỉ, ngày làm bù); không caller nào bị thay.
2. **Validator** (`parseCalendarHolidays`): body đúng bốn key; `from`/`to` là ngày thật 1900..2100; `from ≤ to`; tối đa **31 ngày lịch** (cả hai đầu), có thể bắc qua hai năm; `name` 1..200 ký tự. Cuối tuần trong khoảng bị bỏ qua vì CHECK DB chỉ cho `paid_holiday` ở thứ Hai–thứ Sáu; khoảng **không có ngày thường nào** là `400` (cùng quy ước route từng ngày với thứ Bảy/Chủ nhật). Không thêm key lỗi.
3. **Ghi (phương án A).** Một transaction, **một audit** `hr.work-calendar.update` (chỉ id, như route từng ngày), **mỗi ngày thay đổi một version** liên tiếp theo thứ tự ngày (`work_calendar.version += n`, n dòng `work_calendar_change`), nên mọi version cũ vẫn chính xác. Phản hồi `{ version }` là version cuối.
4. **Idempotency / không đổi.** Ngày đã là `paid_holiday` đúng tên đó thì bỏ qua (không tạo version); không còn ngày nào thay đổi thì `ProductCommandRejected('unchanged')` (409 `error.conflict`) như route từng ngày. Đổi tên một khoảng đã có thì ghi lại các ngày khác tên.
5. **Khóa.** Giống `setCalendarDay`: `execute` khóa hàng lịch `FOR NO KEY UPDATE`, rồi `assertPeriodsOpen` trên các ngày thường của khoảng (≤ 2 tháng với 31 ngày, sắp xếp sẵn, `FOR SHARE`); tháng đã chốt ⇒ `409 error.periodClosed` cho **cả khoảng**, không ghi gì. Kiểm `expectedVersion` sau khi có khóa; sai ⇒ `stale_version` (409). Không giữ khóa qua network/hash.
6. **Web.** Form "Thêm ngày nghỉ lễ" nhập Từ ngày/Đến ngày/Tên, hiển thị số ngày sẽ áp dụng (không tính thứ Bảy, Chủ nhật), kiểm trước ở client (đảo ngược, > 31 ngày, chỉ cuối tuần) bằng key `calendar.form.*`; API vẫn là bên quyết định. Bỏ một ngày vẫn gọi route từng ngày.

## Hệ quả

- Khoảng 31 ngày tạo tối đa 23 version một lần; lịch sử vẫn tuyến tính, không đổi cách đọc `calendarYear`.
- Test: `hrm-input.spec` (validator), `hrm-work-calendar.integration-spec` (một audit, version liên tiếp, bắc năm, bỏ cuối tuần, unchanged/stale, quyền, tháng đã chốt), `structure.spec` (route + sha OpenAPI), web `work-calendar.spec`.
