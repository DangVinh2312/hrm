# ADR-10 — Báo cáo và xuất XLSX

Thay thế các ADR cũ: 0016, 0018 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Code: `modules/report` (`report.controller.ts`, `report.validator.ts`, `report.declarations.ts`, `services/report.service.ts`, `services/excel-export.service.ts`, `repositories/report-*.repository.ts`); snapshot kỳ công: [ADR-09](ADR-09-requests-leave-attendance-idempotency.md); setting `report.maxMonths`, `export.maxRows`, `export.maxBytes`: [ADR-12](ADR-12-administration-accounts-settings-roles.md).

## Quyết định

### Quyền và phạm vi

- Sáu báo cáo: `attendance`, `late-early`, `wfh`, `leave`, `seniority`, `birthday`; mỗi báo cáo một action trên hàng `employee` (`reportAttendance`, `reportLateEarly`, `reportWfh`, `reportLeave`, `reportSeniority`, `reportBirthday`, policy `hrRead`, `boundary: 'optional'`), để deny hay gỡ grant từng báo cáo được (deny thắng allow); không có `report.read` chung. Mười hai grant mặc định: `hr.coo` và `hr.admin` → `allEmployees`. Nhân viên, Team Lead, CEO không có báo cáo (Lead đọc số dư thành viên qua endpoint từng nhân viên). Root qua `planUnrestricted`, mỗi lần đọc một `access.employee.report*`.
- Báo cáo là kết quả tính nên authorize trên các hàng `employee` được tổng hợp; `ProductQuery.run` AND `scope.sql` vào lượt quét `employee r` trước aggregate, `count(*)` và `LIMIT/OFFSET`, nên `total` chỉ đếm hàng người gọi được đọc.
- Người không có grant nhận trang rỗng `{ total: '0', rows: [] }` ở JSON: không có 403/404 phân biệt "không có dữ liệu" với "ngoài phạm vi", nên không có key lỗi mới; sai query là `400 error.invalidRequest`.
- Projection chỉ mã nhân viên, họ tên và số liệu tính; không CCCD, MST, ngày sinh, giới tính, điện thoại, email, và (sinh nhật) không năm sinh ([ADR-08](ADR-08-hr-data-time-pii.md)).

### Truy vấn

- Route `GET /api/hr/reports/{attendance,late-early,wfh,birthday}?from=YYYY-MM&to=YYYY-MM` và `…/{leave,seniority}?asOn=YYYY-MM-DD`, kèm `limit`/`offset` (page 20/100, offset ≤ 10000); thiếu hoặc thừa key là 400; loại báo cáo lấy từ route. Khoảng tháng tối đa 12 (≈ 366 ngày; trần cấu trúc `REPORT_MAX_MONTHS = 12`, `report.maxMonths` chỉ hạ được).
- Mỗi báo cáo là một statement (CTE, một snapshot dưới READ COMMITTED) trả một JSON; không đổi isolation. Tháng có kỳ `closed` đọc snapshot đã lưu và kiểm hash lại; tháng mở tính sống bằng chính `attendanceTotals` và cùng đoạn SQL facts (`approvedEffectsSql`/`calendarDaysSql`), không có công thức thứ hai. Sửa hồ sơ sau khi chốt không đổi báo cáo kỳ đó. Báo cáo phép và thâm niên không dùng snapshot. Nhãn `overLimit` của báo cáo WFH theo ngưỡng hiện hành kể cả tháng đã chốt (`wfhDays` và hash snapshot không đổi).
- Quy ước: tháng WFH/late/early là tháng của ngày trong đơn; `wfhDays` đếm ngày khác nhau; hàng gồm mọi nhân viên có làm việc trong tháng (kể cả số 0), không lọc sau tính toán để phân trang đúng; thứ tự mã nhân viên, id, tháng. Báo cáo phép dùng `leaveBalanceView` tại cutoff (nhân viên có làm việc trong năm của cutoff). Thâm niên (nhân viên đang làm tại cutoff): từ `hired_on` đến cutoff, tính cả ngày vào làm và ngày cutoff, cộng tháng với ngày cắt về cuối tháng (2024-01-31 + 1 tháng = 2024-02-29); vào 2025-01-01, cutoff 2026-12-31 là 2 năm 0 tháng 0 ngày.
- Sinh nhật: hàng theo (nhân viên, tháng); ngày hiển thị cắt về ngày cuối tháng (29/02 → 28/02 năm không nhuận); chỉ ngày/tháng, tính trong SQL nên năm sinh không rời DB kể cả với HR; chỉ nhân viên đang làm tại ngày hiển thị và có ngày sinh. Một projection cho cả COO và HR.
- Hiệu ứng đã duyệt đọc theo tập khi `limit` ≥ 300 ([ADR-09](ADR-09-requests-leave-attendance-idempotency.md)); phạm vi vẫn áp trước aggregate.

### Xuất XLSX

- `GET /api/hr/reports/<loại>/export`: cùng khóa query với báo cáo, không `limit`/`offset` (có là 400). Không có action riêng: dùng đúng action và đúng `ProductQuery` đăng ký của báo cáo JSON (`ReportExportRepository.queries[kind]`, cùng một statement/snapshot/scope), đọc ngân sách `export.maxRows`/`export.maxBytes` trong cùng transaction rồi chạy query với trang = ngân sách dòng. Deny hay gỡ grant một báo cáo chặn luôn tệp của nó.
- Ngân sách: tối đa 5000 dòng trong phạm vi người gọi và tệp tối đa 5 MiB (`EXPORT_MAX_ROWS`, `EXPORT_MAX_BYTES` là trần cấu trúc; setting chỉ hạ được, `export.maxBytes` tối thiểu 1 MiB). Vượt dòng hoặc kích thước: 422 `error.exportTooLarge` (`ApiRejection`), không bao giờ xuất thiếu dòng. Key này chỉ ném sau khi người gọi authorize trên chính báo cáo và phản ánh số dòng/kích thước phạm vi của chính họ (đã thấy qua `total` của JSON).
- Vòng đời: query (một statement, đóng transaction) → render ngoài transaction và fence (`writeBuffer` trong bộ nhớ, không tệp tạm) → authorize lại bằng `ProductAuthorization.permits(employee, report*)` (session, facts, plan) → giao `StreamableFile` (`Content-Type` xlsx, `Content-Disposition: attachment; filename="hrm-report-<loại>-<khoảng>.xlsx"` dựng từ phần đã validate, `Cache-Control: no-store`). Không có action → 403 `error.accessDenied` (không giao tệp rỗng; phạm vi rỗng cũng 403 và không phân biệt hai trường hợp). `AbortSignal` từ `res.once('close')` (khi `writableFinished` sai): ngắt thì bỏ các bước còn lại, không trả gì.
- Cửa sổ re-check (chấp nhận có chủ ý, `shortcut:` ở `ReportService.export`): cửa sổ chạy từ lúc transaction của lần kiểm lại commit đến khi byte cuối được gửi, như mọi HTTP read đã giao. Lần kiểm lại chỉ chứng minh plan còn chạm được ít nhất một hàng, không so với tập hàng đã đọc: quyền thu hồi hẳn trong lúc render bị chặn, nhưng scope chỉ thu hẹp (mất team A, còn team B) vẫn giao đủ các dòng đã đọc, tối đa 5000 dòng / 5 MiB. Đóng bằng so dấu vân tay facts trước/sau render cần API mới ở `ProductAuthorization` và quyết định riêng.
- Nội dung: một sheet mỗi báo cáo, header tiếng Việt, một dòng mỗi nhân viên-kỳ; số là ô số (phút/đếm, đơn vị như JSON), tháng/ngày là ô ngày UTC 00:00 kèm `numFmt` (`mm/yyyy`, `dd/mm/yyyy`, sinh nhật `dd/mm`); "Kỳ công" `Đã chốt`/`Đang mở`; "Vượt 4 ngày/tháng" `Có`/`Không`; "Phút điều chỉnh công" và "Định mức năm (phút)" (ô trống cho thử việc). Chuỗi luôn là ô chuỗi (ExcelJS chỉ phát công thức cho giá trị `{ formula }`, không cột nào tạo ra), nên giá trị bắt đầu `=`/`+`/`-`/`@` hay tab/CR vẫn là văn bản. Renderer nhận DTO báo cáo, không entity; ExcelJS `4.4.0`, thay thế chỉ đụng `excel-export.service.ts`. Chưa có mẫu D14.
- Web: nút tải không tắt khi bảng rỗng; 403 hiển thị key riêng của trang `report.export.denied` ("không có quyền tải báo cáo này hoặc không có dòng nào trong phạm vi của bạn"), không dùng `error.accessDenied` chung; 422 dùng `error.exportTooLarge`, lỗi mạng `error.unavailable`. `HttpClient.download` chỉ nhận content-type XLSX, tên tệp client dựng từ loại + khoảng, tệp chỉ nằm trong bộ nhớ trình duyệt (object URL thu hồi ngay), hủy request khi rời trang hoặc đổi bộ lọc. Menu `reports` hiện khi ít nhất một trong sáu action chạm được một hàng (chỉ là gợi ý hiển thị).

### Thời gian và số đo đã chốt

- Deadline thực của runner là 3000 ms (mục tiêu 2 s, không phải trần); không tự tăng deadline cho export. Nếu workload thật lớn hơn cần thiết kế riêng (snapshot, batch).
- Số đo (máy macOS Intel i5-1038NG7 8 lõi, 16 GiB, Node 24, `postgres:18.4`; 5000 nhân viên, 25 000 đơn đã duyệt; máy tải cao nên số tuyệt đối nhiễu; không phải SLO): export 5000 dòng, truy vấn tối đa ~0,5 s (COO) và 1,7 s (Root, một đợt đo), render ≤ ~0,55 s (COO) tới ~1,0 s (Root). Đọc hiệu ứng theo tập (từ 300 hàng): báo cáo nhiều tháng 5000 dòng và đóng kỳ 5000 nhân viên nhanh hơn khoảng 50–55% (trung vị), nhưng chưa tách khỏi nhiễu tải (24–67) và JIT; báo cáo 5000 dòng một tháng, tức export hiện tại, không nhanh hơn có ý nghĩa (EXPLAIN trung vị 1138 → 1220 ms, wall 1479 → 1467 ms). Mục tiêu "export 5000 dòng xa trần 3000 ms khi máy tải" chưa đạt. Ở dưới ngưỡng 300, câu lệnh không đổi (chênh lệch trong nhiễu).
- Câu lệnh cũ 5000 dòng nhiều lần vượt `transaction_timeout` (`25P04`); PostgreSQL kết thúc cả session nên kết nối chết trong pool và lần mượn kế tiếp lỗi `Connection terminated unexpectedly`. Đây có thể là nguyên nhân lần đỏ đã gặp, chưa xác minh.
- Workload thực tế dự kiến 50 nhân viên × 24 tháng = 1200 dòng, xa ngân sách 5000.

## Quyết định của người dùng

- 2026-10-21: sinh nhật 29/02 hiển thị 28/02 năm không nhuận; COO không thấy năm sinh; Lead không có báo cáo theo team (giữ COO + HR); XLSX là bảng phẳng một sheet (chưa có mẫu D14); báo cáo tháng đã chốt đọc snapshot.

## Chưa làm / điều mở

- Chưa đo trên máy rảnh hay với `jit=off`; phạm vi báo cáo chỉ COO/HR/Root nên chưa có phạm vi ReBAC hẹp ở tầng báo cáo; chưa đo `late-early`/`wfh` riêng (cùng `loadSheetRows`).
- Snapshot gửi cả document để kiểm hash; chọn nhân viên của tháng đóng quét mảng `snapshot->'employees' @> …` cho từng nhân viên (O(n²) mỗi tháng đóng, chưa đo). Tách snapshot theo nhân viên khi một tháng vượt vài nghìn nhân viên.
- Giới hạn byte XLSX chưa có test tích hợp vượt 1 MiB (tối thiểu hợp lệ); renderer được test đơn vị với ngân sách nhỏ hơn.
- Test huỷ ở mức HTTP (`hrm-report-export-http.integration-spec.ts`, đóng socket giữa chừng) không kiểm trả connection pool DB hay huỷ SQL giữa chừng (huỷ chỉ xảy ra ngoài transaction).
- Mẫu XLSX theo yêu cầu khách (D14) và so dấu vân tay facts trước/sau render.
