# YÊU CẦU PHÁT TRIỂN ỨNG DỤNG QUẢN LÝ NHÂN SỰ

## 1. Tổng quan dự án

Mục tiêu là xây dựng một ứng dụng quản lý nhân sự trên nền tảng web cho công ty hoạt động tại Việt Nam, quy mô khoảng 50 nhân sự. Hệ thống cần hỗ trợ nhân viên gửi yêu cầu, quy trình phê duyệt, quản lý phép, dữ liệu chấm công, báo cáo nhân sự, hồ sơ nhân viên và tạo hợp đồng lao động.

## 2. Lịch làm việc và lịch nghỉ, cách tính công

- Ngày làm việc tiêu chuẩn: từ thứ Hai đến thứ Sáu.
- Giờ làm việc: 09:00–13:00 và 14:00–18:00.
- Nghỉ trưa: 13:00–14:00, không tính là thời gian làm việc.
- Ngày nghỉ hằng tuần: thứ Bảy và Chủ nhật.
- Hệ thống cần thiết lập các ngày nghỉ lễ, Tết theo quy định của pháp luật lao động Việt Nam là ngày nghỉ hưởng nguyên lương. Quản trị viên có thể cập nhật lịch nghỉ khi cần.
- Hệ thống mặc định người lao động có đủ công trong tháng làm việc, khi nhân viên apply các request thì tính toán lại và cập nhật vào bảng công

## 3. Vai trò người dùng và quy trình phê duyệt:

- Nhân viên (Team Member): gửi và theo dõi yêu cầu của bản thân; xem số dư phép và lịch sử yêu cầu liên quan.
- Trưởng nhóm (Team Lead): xem xét, phê duyệt hoặc từ chối yêu cầu của các thành viên thuộc nhóm mình phụ trách.
- COO: xem xét và đưa ra quyết định phê duyệt cuối cùng sau Trưởng nhóm.;
- HR/Admin (Quản trị nhân sự): quản lý hồ sơ nhân viên, thiết lập phép, lịch nghỉ, báo cáo và mẫu hợp đồng.
- CEO: không tham gia quy trình phê duyệt và không được mặc định là người phê duyệt.

Quy trình phê duyệt: Nhân viên gửi yêu cầu → Team Lead xem xét → COO phê duyệt cuối cùng. Trạng thái yêu cầu và lịch sử từng quyết định cần được lưu lại, đồng thời hiển thị cho những người dùng có liên quan.

## 4. Chức năng dành cho nhân viên

### 4.1. Đăng ký đi muộn hoặc về sớm

Nhân viên có thể gửi yêu cầu đi muộn hoặc về sớm. Yêu cầu cần ghi nhận ngày, giờ dự kiến, lý do và các thông tin khác do HR yêu cầu. Hệ thống cần lưu lịch sử yêu cầu và phê duyệt để phục vụ tra cứu, báo cáo.

### 4.2. Đăng ký làm việc tại nhà (WFH)

Nhân viên có thể gửi yêu cầu làm việc tại nhà, với giới hạn tối đa 4 lần WFH được phê duyệt trong mỗi tháng dương lịch. Hệ thống cần đếm số lần WFH đã được duyệt theo từng nhân viên và từng tháng; đồng thời chặn hoặc cảnh báo khi yêu cầu vượt giới hạn.

### 4.3. Nghỉ phép năm

- Định mức tiêu chuẩn: 12 ngày/năm.
- HR/Admin có thể thiết lập định mức phép riêng lớn hơn 12 ngày/năm cho nhân viên đã thỏa thuận mức phép cao hơn khi tuyển dụng.
- Nghỉ 0,25 ngày: 09:00–11:00; 11:00–13:00; 14:00–16:00 hoặc 16:00–18:00.
- Nghỉ 0,5 ngày: 09:00–13:00 hoặc 14:00–18:00.
- Nghỉ 1 ngày: 09:00–18:00, không tính thời gian nghỉ trưa 13:00–14:00.

Hệ thống cần tính và hiển thị tổng phép năm được cấp, số phép đã sử dụng tính đến thời điểm báo cáo và số phép còn lại. Phép chỉ được trừ sau khi yêu cầu được phê duyệt.

### 4.4. Nghỉ không hưởng lương

- Nghỉ 0,25 ngày: 09:00–11:00; 11:00–13:00; 14:00–16:00 hoặc 16:00–18:00.
- Nghỉ 0,5 ngày: 09:00–13:00 hoặc 14:00–18:00.
- Nghỉ 1 ngày: 09:00–18:00, không tính thời gian nghỉ trưa 13:00–14:00.

Nhân viên có thể gửi yêu cầu nghỉ không hưởng lương theo các khung thời gian trên. Các yêu cầu đã được phê duyệt cần được ghi nhận trong dữ liệu chấm công của nhân viên.

### 4.5. Nhân viên đang thử việc

Trong thời gian thử việc, nhân viên không được đăng ký nghỉ phép năm và không được cộng bù phép khi đã qua thử việc. Nhân viên thử việc chỉ được gửi yêu cầu đi muộn/về sớm và nghỉ không hưởng lương.

## 6. Chức năng dành cho HR/Admin

### 6.1. Quản lý hồ sơ nhân sự

HR/Admin có thể tạo mới, xem và cập nhật hồ sơ của từng nhân viên. Các trường thông tin tối thiểu gồm:

- Mã nhân viên.
- Họ và tên.
- Ngày, tháng, năm sinh.
- Số căn cước công dân (CCCD) hoặc giấy tờ định danh cá nhân.
- Mã số thuế cá nhân.
- Tình trạng làm việc (ví dụ: thử việc hoặc nhân viên chính thức).
- Định mức phép năm, bao gồm định mức riêng cao hơn tiêu chuẩn nếu có thỏa thuận.

Có thể bổ sung các trường dữ liệu khác theo nhu cầu. Quyền truy cập thông tin cá nhân cần được giới hạn theo vai trò người dùng.

### 6.2. Tạo và ký hợp đồng thử việc/hợp đồng lao động

- Tạo hàng loạt hợp đồng lao động theo mẫu đã được HR phê duyệt.
- Tự động điền dữ liệu của nhân viên vào các trường tương ứng trong mẫu hợp đồng.
- Hỗ trợ chữ ký số của công ty thông qua USB Token/chứng thư số hoặc chữ ký hình ảnh
- Hỗ trợ người lao động ký bằng cách chèn hoặc tải lên hình ảnh chữ ký theo yêu cầu hiện tại. Cần xác nhận tính hợp lệ pháp lý và mức độ phù hợp của phương thức ký này trước khi triển khai.
- Lưu hợp đồng đã tạo cùng thông tin về tình trạng ký và trạng thái hợp đồng trong hồ sơ nhân viên.

### 6.3. Báo cáo

- Báo cáo chấm công: xuất dữ liệu chấm công theo khoảng thời gian được chọn.
- Báo cáo quỹ phép năm: tổng số phép được cấp, số phép đã sử dụng tính đến ngày báo cáo và số phép còn lại của từng nhân viên.
- Báo cáo đi muộn/về sớm: số lượng yêu cầu đã được phê duyệt theo từng nhân viên và từng kỳ báo cáo.
- Báo cáo WFH: số lần WFH đã được phê duyệt theo từng nhân viên và từng kỳ báo cáo.
- Báo cáo về thâm niên làm việc
- Báo cáo về sinh nhật

Định dạng xuất dữ liệu excel

