# Chỉ mục ADR

Mười lăm ADR hiện hành (ADR-15 đã chấp nhận; D8–D11 xong, D12 một phần, D13 docs xong, kiểm tổng chưa chạy) thay cho 48 ADR đánh số `0001`–`0048` (đã gộp; nội dung cũ xem lịch sử Git và `docs/history.md`). Mỗi ADR mới ghi code sở hữu, quyết định, quyết định của người dùng và điều còn mở.

## ADR hiện hành

| ADR                                                           | Chủ đề                                                                 | Trạng thái                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| [ADR-01](ADR-01-workspace-modules-conventions.md)             | Workspace, cấu trúc module, quy ước mã và kiểm thử                     | Hiện hành                                     |
| [ADR-02](ADR-02-authorization-core-and-value-codecs.md)       | Lõi quyết định, permission boundary, SQL compiler, value codec         | Hiện hành                                     |
| [ADR-03](ADR-03-fence-transactions-manifest-sync.md)          | Application fence, transaction runner, manifest sync                   | Hiện hành                                     |
| [ADR-04](ADR-04-database-logins-acl-probes.md)                | Database: login theo mục đích, ACL, hàm definer, probe, trigger bảo vệ | Hiện hành                                     |
| [ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)    | Root ngoài IAM, boundary, bất biến lệnh tác động tài khoản             | Hiện hành                                     |
| [ADR-06](ADR-06-google-auth-sessions-2fa.md)                  | Đăng nhập Google OIDC, phiên, TOTP 2FA                                 | Hiện hành                                     |
| [ADR-07](ADR-07-audit-and-outbox.md)                          | Audit và outbox                                                        | Hiện hành (chưa có sink, worker chưa wire)    |
| [ADR-08](ADR-08-hr-data-time-pii.md)                          | Dữ liệu HR, thời gian, field ACL và PII, team, lịch làm việc           | Hiện hành                                     |
| [ADR-09](ADR-09-requests-leave-attendance-idempotency.md)     | Đơn, phép, bảng công, idempotency, thứ tự khóa HR                      | Hiện hành                                     |
| [ADR-10](ADR-10-reports-and-xlsx.md)                          | Báo cáo và xuất XLSX                                                   | Hiện hành                                     |
| [ADR-11](ADR-11-http-api-errors-openapi-web.md)               | HTTP `/api`, mã lỗi, OpenAPI, web                                      | Hiện hành                                     |
| [ADR-12](ADR-12-administration-accounts-settings-roles.md)    | Quản trị: tài khoản, cài đặt hệ thống, ma trận role                    | Hiện hành, đang triển khai theo đợt           |
| [ADR-13](ADR-13-runtime-roles-assignment-boundary-binding.md) | Role runtime, gán/thu hồi role, binding boundary                       | Hiện hành, đang triển khai (đợt D1–D7)        |
| [ADR-14](ADR-14-baseline-migration-and-release.md)            | Baseline migration và release                                          | Hiện hành (ba phase gộp đã xong, 2026-10-29)  |
| [ADR-15](ADR-15-identity-operations-by-permission.md)         | Thao tác danh tính IAM bằng permission: email, 2FA, binding Google     | Accepted; D8–D11 xong, D12 một phần, D13 docs |

## Ánh xạ ADR cũ sang ADR mới

Một dòng cho mỗi số cũ. Cột `new` là `xóa` khi ADR cũ đã bị thay thế hoặc hoãn và không còn nội dung hiện hành. Với ADR đa đích, bảng phụ phía dưới ghi theo mục `§`.

| old  | new                            | note                                                                                                           |
| ---- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 0001 | ADR-01, ADR-04                 | runtime/module format/tên package sang ADR-01; ma trận role/ACL DB sang ADR-04; database-per-tenant bỏ         |
| 0002 | ADR-02                         | lõi, ReBAC, SQL compiler                                                                                       |
| 0003 | ADR-02                         | permission boundary (mục Permission boundary)                                                                  |
| 0004 | ADR-03                         | fence, revocation, manifest sync; phần tenant bỏ                                                               |
| 0005 | xóa                            | đề xuất một sản phẩm với local auth; local auth bị 0027 thay, kiến trúc một sản phẩm nằm ở ADR-01              |
| 0006 | xóa                            | local + IdP; thay bởi 0027 (chỉ Google)                                                                        |
| 0007 | ADR-03, ADR-04, ADR-05         | sync/drift system grants sang ADR-03; trigger bảo vệ code-owned sang ADR-04; marker bootstrap Root sang ADR-05 |
| 0008 | ADR-03, ADR-04, ADR-06         | fence/hash sang ADR-03; bốn login sang ADR-04; phiên 12h/30p sang ADR-06; compatibility tenant bỏ              |
| 0009 | ADR-01, ADR-02, ADR-07         | xem bảng phụ                                                                                                   |
| 0010 | ADR-03, ADR-06                 | thứ tự lock advisory sang ADR-03; limiter và purge session sang ADR-06; index session vào baseline ADR-14      |
| 0011 | ADR-04, ADR-07                 | login `outbox` sang ADR-04; delivery at-least-once sang ADR-07                                                 |
| 0012 | ADR-05                         | IAM thuần, Root tách khỏi IAM                                                                                  |
| 0013 | ADR-01                         | một NestJS app chia module                                                                                     |
| 0014 | ADR-01                         | bỏ tenant và compatibility legacy                                                                              |
| 0015 | ADR-01                         | app sở hữu tests, tools, env, config                                                                           |
| 0016 | ADR-01, ADR-08, ADR-09, ADR-10 | xem bảng phụ                                                                                                   |
| 0017 | ADR-03, ADR-09, ADR-11, ADR-12 | xem bảng phụ                                                                                                   |
| 0018 | ADR-08, ADR-09, ADR-10         | xem bảng phụ                                                                                                   |
| 0019 | ADR-11                         | tiền tố `/api`, callback 303, link kích hoạt, loopback; hai đích `link` đã gỡ bởi 0027                         |
| 0020 | ADR-06                         | cấp tài khoản Google theo email                                                                                |
| 0021 | xóa                            | Superseded bởi 0027; Root kích hoạt theo email nằm ở ADR-06 (nội dung do 0027 mang)                            |
| 0022 | ADR-05, ADR-06                 | fresh Root theo action và nguồn thời gian sang ADR-05; `fresh` từ 2FA sang ADR-06                              |
| 0023 | ADR-06                         | quy tắc email trùng, `binding_ref`; liên kết/gỡ đã bị 0027 gỡ                                                  |
| 0024 | xóa                            | Deferred (recovery email/SMTP cho mật khẩu local, không triển khai; local auth đã gỡ)                          |
| 0025 | ADR-06                         | step-up bằng yếu tố do HRM kiểm, một Google mỗi tài khoản                                                      |
| 0026 | ADR-06                         | TOTP và mã khôi phục                                                                                           |
| 0027 | ADR-05, ADR-06                 | Google-only, Root theo email, một Google mỗi tài khoản sang ADR-06; vòng đời Root offline sang ADR-05          |
| 0028 | ADR-08                         | giới tính, điện thoại, email công việc, chức danh, phân loại                                                   |
| 0029 | xóa                            | Superseded bởi 0041 (chưa từng Accepted); phần hiện hành nằm ở ADR-12                                          |
| 0030 | xóa                            | Superseded bởi 0041 (chưa từng Accepted); phần hiện hành nằm ở ADR-12, ADR-13                                  |
| 0031 | ADR-01                         | `modules/` và `features/`                                                                                      |
| 0032 | ADR-01                         | `document` chỉ là fixture, không HTTP                                                                          |
| 0033 | ADR-01                         | giới hạn 300 dòng                                                                                              |
| 0034 | ADR-01                         | test dùng chung một container và template database                                                             |
| 0035 | ADR-01                         | khai báo quyền về module sở hữu                                                                                |
| 0036 | ADR-01                         | xóa `modules/hr`; `/me` vào authentication                                                                     |
| 0037 | ADR-11                         | `GET /api/auth/me` tách `GET /api/hr/employees/me`                                                             |
| 0038 | ADR-01                         | SQL chọn cột tường minh                                                                                        |
| 0039 | ADR-08                         | định mức phép năm phát sinh khi chính thức                                                                     |
| 0040 | ADR-08                         | trưởng nhóm phải là thành viên đang mở                                                                         |
| 0041 | ADR-05, ADR-12, ADR-13         | xem bảng phụ                                                                                                   |
| 0042 | ADR-08                         | nghỉ lễ theo khoảng ngày                                                                                       |
| 0043 | ADR-04, ADR-12                 | hàm `SECURITY DEFINER` và trigger sang ADR-04; `account.reactivate` sang ADR-12                                |
| 0044 | ADR-09                         | COO tự duyệt lúc submit theo permission                                                                        |
| 0045 | ADR-12                         | cài đặt hệ thống (`system_setting`)                                                                            |
| 0046 | ADR-05, ADR-12                 | xem bảng phụ                                                                                                   |
| 0047 | ADR-13                         | role runtime, gán/thu hồi, binding boundary                                                                    |
| 0048 | ADR-14                         | gộp migration và release thành baseline                                                                        |

Lý do xóa: 0005 và 0006 mô tả phương án local auth đã bị 0027 thay; 0021 bị 0027 thay (Superseded); 0024 bị hoãn (Deferred) và local auth đã gỡ; 0029 và 0030 bị 0041 thay trước khi từng được Accepted.

## Bảng phụ cho ADR đa đích

Cột `old §` theo tiêu đề mục trong ADR cũ (số `§` là số mục của chính ADR cũ khi có). Mục nào không liệt kê đi theo đích đầu tiên trong bảng chính.

| old §                                                                                                                  | new            |
| ---------------------------------------------------------------------------------------------------------------------- | -------------- |
| 0001 Runtime và tooling; Module format và decorator metadata; Tên package                                              | ADR-01         |
| 0001 Cô lập tenant trên PostgreSQL (thuộc tính role, REVOKE PUBLIC, ma trận quyền)                                     | ADR-04         |
| 0001 Cô lập tenant trên PostgreSQL (database-per-tenant, registry, provisioning theo tenant)                           | xóa            |
| 0007 Quyết định: sync role definition, system grants, drift                                                            | ADR-03         |
| 0007 Quyết định: code-owned rows được bảo vệ ở DB writer                                                               | ADR-04         |
| 0007 Quyết định: bootstrap marker một lần, Root recovery ngoài API                                                     | ADR-05         |
| 0008 Quyết định: một fence, READ COMMITTED, hash materialized state, drift                                             | ADR-03         |
| 0008 Quyết định: bốn login, config từ chối credential bootstrap/migration                                              | ADR-04         |
| 0008 Quyết định: Argon2id/openid-client, phiên opaque 12h/30p                                                          | ADR-06         |
| 0009 Ports giá trị; Domain timestamp strict; Engine identity và provenance                                             | ADR-02         |
| 0009 API theo capability; Entrypoints `typeorm-postgres` (đã bỏ)                                                       | ADR-01         |
| 0009 Audit revision; Implementation note — audit (T5)                                                                  | ADR-07         |
| 0009 Breaking change nội bộ có chủ ý                                                                                   | xóa            |
| 0016 Quyết định 1, 3, 4, 5 (capability, scope relation, tạo bản ghi, facts)                                            | ADR-08         |
| 0016 Quyết định 2 (field ACL), Release 16 (nhãn role)                                                                  | ADR-08         |
| 0016 Quyết định 6, 7; Triển khai T2/T3; Release 7–12, 15 (guard, fresh, boundary HR, đơn, phép, công)                  | ADR-09         |
| 0016 Release 13, 14 (sáu báo cáo, sinh nhật, XLSX)                                                                     | ADR-10         |
| 0016 Quy ước hằng có kiểu cho khai báo quyền                                                                           | ADR-01         |
| 0016 Quyết định 8 (provisioning tài khoản)                                                                             | ADR-06         |
| 0017 Quyết định đề xuất (giao dịch, idempotency, thứ tự khóa); Bổ sung T8, T8B, `attendance.adjust`                    | ADR-09         |
| 0017 thứ tự lock toàn hệ thống                                                                                         | ADR-03         |
| 0017 Bổ sung `permitsMany`: menu `GET /api/auth/me` trong một giao dịch                                                | ADR-11, ADR-12 |
| 0018 Quyết định (mô hình dữ liệu, ngày nghiệp vụ, phút); Bổ sung ngày làm bù                                           | ADR-08         |
| 0018 Bổ sung quỹ phép năm, bảng công, hồ sơ trong kỳ chốt, ledger, `attendance.adjust`, hiệu ứng đã duyệt đọc theo tập | ADR-09         |
| 0018 Bổ sung T9 (hash snapshot chuẩn hoá, báo cáo, sinh nhật, XLSX, web báo cáo)                                       | ADR-10         |
| 0041 §1 Hai loại hành động; §2 Bất biến mọi lệnh; Bất biến mới (thay cho câu cấm cũ)                                   | ADR-05, ADR-12 |
| 0041 §3 Role runtime; §4 Boundary `required` và đường ghi binding                                                      | ADR-13         |
| 0041 §5 Setting; §7 Menu và web                                                                                        | ADR-12         |
| 0041 §6 Thao tác danh tính trên tài khoản IAM                                                                          | ADR-05, ADR-12 |
| 0041 §8 `hr.coo` hardcode (Q9)                                                                                         | ADR-09         |
| 0046 §1 Kiểm giả định; §2 helper `grant-set`; §3 bất biến (d) cho `account.suspend`/`reactivate`                       | ADR-05, ADR-12 |
| 0046 §4 Ma trận role chỉ đọc; §5 Menu `roles` và trần probe; §6 Web                                                    | ADR-12         |
| 0046 §7 Chưa làm (phần 2)                                                                                              | ADR-13         |
