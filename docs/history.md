# Lịch sử, quyết định và bằng chứng

> Số ADR cũ (00NN) trong tài liệu này ứng với ADR-01..14 theo bảng ánh xạ ở [docs/decisions/README.md](decisions/README.md).

Gộp từ các plan, spec, ledger và báo cáo kiểm chứng đã hoàn tất (ngày gộp 2026-10-29). Chỉ giữ những gì không có chỗ khác: quyết định của người dùng, số đo, bằng chứng và giới hạn còn hiệu lực. Thiết kế hiện hành nằm ở [architecture](architecture.md), vận hành ở [operations](operations.md), quyết định chi tiết ở [ADR](decisions/). Số liệu dưới đây là kết quả chạy local tại thời điểm ghi, không chứng nhận working tree hiện tại, CI hay production.

Nội dung đầy đủ của các tài liệu đã xóa còn trong Git (`git log --follow -- docs/<đường dẫn cũ>`).

## 1. Dòng thời gian

| Giai đoạn (2026) | Nội dung                                                                                                                                                                 | Nguồn                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| 10-13            | Thiết kế nền multi-tenant, rồi chuyển một sản phẩm: một database, user/session chung, local + OIDC, fence ứng dụng, login DB theo mục đích                               | ADR 0001–0008            |
| 10-14            | Foundation hardening: codec scalar qua port (Day.js adapter), `createAuthorizationCore`, audit có kiểu, probe chặn drift, giảm I/O trong fence, limiter, outbox delivery | ADR 0009–0011            |
| 10-15            | IAM không rank, Root ngoài IAM (`app_user.kind`), `planUnrestricted`, genesis release                                                                                    | ADR 0012                 |
| 10-16            | Gom bốn package thành một app `apps/api`; xóa tenant/legacy; khởi tạo HRM (React/Mantine, `apps/web`)                                                                    | ADR 0013–0015, 0019      |
| 10-17 đến 10-19  | HR T0–T4: spec, quyền/PII, hồ sơ, team, lịch; Root OIDC, step-up, Google-only, TOTP 2FA, Root/IAM theo email                                                             | ADR 0016–0028            |
| 10-20 đến 10-22  | HR T5–T9: đơn, duyệt Team Lead → COO, phép, bảng công, báo cáo + XLSX; điều chỉnh công                                                                                   | ADR 0016–0018, 0039–0040 |
| 10-23 đến 10-28  | Administration: tài khoản, setting, ma trận role, vai trò runtime                                                                                                        | ADR 0041–0047            |
| 10-29            | Gộp 36 migration thành hai baseline, release về sequence 1; gộp docs                                                                                                     | ADR 0048                 |

Đã bỏ: tenant (ADR 0014), đăng nhập/mật khẩu local, link/unlink và reauth bằng Google (ADR 0027), route `GET /api/hr/me` (ADR 0037, nay là `GET /api/auth/me` và `GET /api/hr/employees/me`), module `modules/hr` (ADR 0036). Hai kế hoạch quản lý tài khoản/quyền gắn vào `employee` (ADR 0029/0030) chưa từng được duyệt và đã bị ADR 0041 thay; các symbol `issueAccount`, `protectedGroup`, `roleAdministration@N` không tồn tại trong `apps/`.

## 2. Quyết định của người dùng

Chỉ ghi quyết định chưa có nguyên văn ở ADR đang dùng; quyết định đã nằm trong ADR thì xem ADR.

- IAM/Root (2026-10-14, ADR 0012): bỏ rank hoàn toàn; Root là super admin bypass mọi grant/deny/boundary/policy kể cả action thêm sau; `app_user.kind` ∈ {`root`, `iam`}; `bootstrap` chuyển `iam → root` đúng một lần; marker đã khởi tạo mà không còn Root thì cần repair offline có duyệt; fresh-auth chỉ cho ghi; mọi `access` commit của Root được audit (denied không audit); API quản trị IAM chưa làm; MFA cho mọi account là spec riêng.
- Gom app (2026-10-16, ADR 0013/0014): giữ `apps/api`, gom bốn package vào app; xóa implementation tenant và fixture tương thích, giữ chuỗi migration lúc đó; không thêm vòng hỏi lại.
- Google-only + TOTP (2026-10-18, ADR 0026/0027): chấp nhận rủi ro đăng ký 2FA bằng phiên bị chiếm; sai mã 10 lần liên tiếp thì đăng xuất mọi phiên, bộ đếm chỉ về 0 khi đúng; phiên sau verify giữ `assurance` và hạn của phiên cũ; xoay khóa bằng mã hóa lại khi dùng, boot kiểm mọi `key_id`; Root tự gỡ/thay 2FA như IAM; duyệt ADR 0026/0027; cho phép thao tác tự do trên DB local khi gỡ code local; thư viện QR `qrcode.react` 4.2.0.
- Đồng hồ và profile (2026-10-18): đồng hồ DB bị step lùi giữ semantics fail closed, yêu cầu NTP chỉ slew; đồng bộ profile từ claims OIDC hoãn. Nếu làm sau: họ tên nhân viên là dữ liệu do HR quản lý (`employee.full_name`); claims IdP không bao giờ ghi vào hồ sơ nhân viên, quyền, team hay `employee.account_id`; cần ADR và migration mới.
- Quản lý tài khoản/quyền (2026-10-20, kế hoạch đã đóng): Root-only trước, đường ghi binding cho IAM là task riêng sau; giữ gán role thủ công; ủy quyền gán role do boundary quyết (`hr.admin` chỉ khi Root gắn boundary cho phép). Thiết kế này đã bị ADR 0041 thay.
- HR (2026-10-17 đến 10-22): phạm vi T2 "khung quyền HR"; `team.assign` và `employee.linkAccount` giữ `boundary: 'required'`, chưa binding nên chỉ Root dùng được; boundary HR khai báo trong manifest (ADR 0016); đi muộn/về sớm tính từ mép ca và chỉ cần Team Lead (requirement §3 không sửa); lead gửi cho team mình vẫn qua COO; Root được duyệt cuối; submit trả 422 với key theo lý do (409 cho trùng đơn); bảng "Đã xử lý" hiện họ tên chủ đơn; COO đọc chi tiết đơn lead từ chối; sinh nhật 29/02 hiển thị 28/02 năm không nhuận, COO không thấy năm sinh, Lead không có báo cáo theo team, XLSX là bảng phẳng (chưa có mẫu D14); điều chỉnh công theo ngày bằng delta phút có dấu, tổng tháng không âm, HR không tự điều chỉnh công của mình, nhân viên chỉ thấy tổng; nhãn role HR đổi sang tiếng Anh `Employee`/`COO`/`Admin`.
- Test viết sau implementation cho một số mục T1/T3/T4 là ngoại lệ do người dùng chấp nhận 2026-10-22 (đã đối chiếu hành vi và chạy xanh, không có lần đỏ trước).
- Dữ liệu (2026-10-29, ADR 0048): chỉ có database dev, được xóa và dựng lại; không cần đường nâng cấp từ chuỗi migration cũ.

## 3. Số đo

Máy dev macOS Intel i5-1038NG7 (4 nhân/8 luồng), RAM 16 GiB, Docker VM 8 CPU/7.75 GiB, Node 24.20.0, `postgres:18.4`, một replica, pool mặc định. Không phải SLO, không đo HTTP/Nest/cookie trừ khi ghi rõ.

### 3.1 Application fence (2026-10-13)

Dataset 100 dòng, 8 worker, 80 transaction (40 read gồm 8 giữ shared fence 40 ms, 24 write, 8 authority change, 8 revoke). Workload 406 ms; latency p95 128 ms, p99 141 ms; 0/80 lỗi. Fence lock wait p95 113 ms, hold p95 46 ms, pool wait p95 21 ms, revoke commit p95 142 ms. Chạy lại cùng suite có thêm container song song: 516 ms, p95 167 ms, p99 222 ms (độ nhiễu của phép đo local). Contention thật: shared fence bị giữ trong lúc revoke dùng lock timeout 30 ms, tối đa một retry; PostgreSQL trả `55P03` ở cả hai lần, runner báo 2 timeout + 1 retry và dừng bằng `TransactionConflictError`. Kết luận: giữ một fence; chưa có bằng chứng cần chia theo module.

### 3.2 Giảm I/O trong fence (T8, 2026-10-14)

Đường service `list/detail/update` và `logout`; 10 000 dòng, 3 285 khớp scope, 40 permission, 80 rule, 40 boundary; mỗi thao tác 20 warmup + 100 mẫu tuần tự; workload trộn 8 worker, 400 thao tác. Authority đọc chỉ permission đang hỏi trong một statement; clock DB gộp vào statement session; list trả trang và `total` cùng statement.

| Thao tác (BEGIN..COMMIT) | Statement trước | Sau |
| ------------------------ | --------------: | --: |
| list / detail            |              13 |   8 |
| update (2 audit insert)  |              15 |  10 |
| revoke                   |              10 |  10 |

Tuần tự p50: list 25.5-27.3 → 20.9-22.2 ms, detail 13-15 → 9-10 ms, update 17.5-20 → 11-12 ms. Workload trộn (3 lần trước → sau): elapsed 4232/4129/3952 → 2264/2765/2831 ms; p95 ~355 → ~190 ms; lock wait p95 ~337 → ~169 ms; 0 lỗi. `EXPLAIN ANALYZE` list (offset 80): `count(*) OVER()` + `LIMIT` 13.46 ms so với `row_number()` 14.18 ms; cả hai quét mọi dòng khớp vì `total` chính xác (1M dòng gần statement timeout 2 s). Muốn tránh phải đổi contract `total` (keyset hoặc ước lượng) bằng ADR riêng.

### 3.3 Limiter và revoke (T9, ADR 0010)

8 worker gọi `rateLimit` 200 lần cùng vòng revoke liên tục. Trước (advisory sau fence): revoke hoàn tất 2-3 lần, p95 1.5-2.0 s, `25P04` ở 3/4 kịch bản. Sau (advisory trước fence): ~200 revoke, p95 14-30 ms, 0 lỗi; latency limiter cùng dải nhiễu. Bảng gần đầy làm advisory wait tăng ~1.5x. Ngưỡng limiter không đổi; chọn ngưỡng mới cần tải đăng nhập và SLO thật.

### 3.4 Export báo cáo (T9, 2026-10-21)

5000 nhân viên, 25 000 đơn đã duyệt / 30 000 segment trong 03/2026. Truy vấn (`ReportService.query`, trung vị/tối đa ms, N=8, COO): attendance 448/509, late-early 403/440, wfh 403/410, leave 151/182, seniority 46/50, birthday 12 tháng 72/82. Render XLSX: 227-472 ms, tệp 128-261 KB. Root tối đa: truy vấn 637 ms, đợt khác 1708 ms; đợt stress CPU: truy vấn tối đa 1717 ms, render 1488 ms. Deadline thực của runner là 3000 ms (mục tiêu 2 s chỉ là mục tiêu): Root và máy tải cao chỉ cách 2 s khoảng 0.3 s. Một lần đo đỏ `Connection terminated unexpectedly` chưa xác minh nguyên nhân. Hạn chế: chỉ COO/Root, không phạm vi team phức tạp, không có ghi đồng thời, workload thực chỉ 50 x 24 = 1200 dòng. Cần biên rộng hơn thì thiết kế snapshot/batch riêng, không nới deadline. Hiệu ứng đã duyệt đọc theo tập (`approvedEffectsBySql`, từ 300 hàng) được ghim bằng `hrm-attendance-effects-equivalence`; hiệu quả tốc độ chưa chứng minh (ADR 0018 bổ sung 2026-10-22).

### 3.5 Menu `permitsMany` và baseline migration

`GET /api/auth/me` gom các lượt `permits` vào một giao dịch, trần `MAX_PERMIT_PROBES` hiện 17 (ADR 0017 bổ sung, ADR 0046). Hai baseline migration cho catalog PostgreSQL giống hệt chuỗi 36 migration cũ: 1347 dòng catalog mỗi bên, diff rỗng; `pg_dump --schema-only` diff rỗng (ADR 0048 §6).

## 4. Bằng chứng kiểm chứng đáng giữ

- Mutation check bảo mật (cô lập, mỗi lần khôi phục và chạy lại): bỏ boundary conjunct, Root bypass theo tên role, bỏ fence, timestamp cắt microsecond đều làm test hành vi fail (2026-10-14). Mười mutation của IAM/Root (2026-10-15) đều bị bắt: coi mọi principal là Root; lấy `kind` từ tên role; bỏ fresh-auth ghi của Root; bỏ `kind='iam'` trong view `iam_account`; bỏ audit Root; bỏ drift check trong migration; genesis không kiểm catalog rỗng; bỏ `FOR SHARE` ở guard gắn fact vào Root; bỏ kiểm isolation READ COMMITTED ở `guard_root_kind`; guard lifecycle sai `session_user`. Hai khoảng hở review tìm ra sau đó (IAM ép `freshAuthentication`, event suspend IAM ghi cho Root) đã được đóng.
- Binary cũ không khởi động trên schema mới: probe cũ ném `Product privilege drift` khi gặp cột đã bỏ (kiểm thủ công một lần, 2026-10-15).
- Review độc lập (subagent chỉ đọc) năm vòng trên thay đổi chưa commit ngày 2026-10-14 tìm ra: probe chưa so body function/binding trigger, chưa chặn `session_replication_role`, authority kích hoạt được account pending; đã sửa kèm regression.
- 55P03 sinh từ contention thật; 40P01/40001 được fault-inject vào runner (rollback hai lần, commit một effect), không gọi là deadlock/serialization do DB tự phát sinh.
- Chuyển một app (2026-10-16): AST so sánh 93 file gốc không đổi declaration ngoài import; migration body/identifier giữ nguyên; xóa tenant 34 file; hash release không đổi. Lỗi E2E "đợi startup" hai lần do vòng chờ 150 probe x 50 ms (~7.5 s) ngắn hơn startup hợp lệ; helper `http-startup.helper.ts` chờ theo deadline của test, có regression 5/5 (không tăng timeout runner).
- Quy mô test tại các mốc: foundation hardening unit 227, integration 184, e2e 1 (2026-10-14); IAM/Root unit 234, integration 236 (2026-10-15); tại 2026-10-18 unit 20+243+59, integration 196, browser 9. Đây là số lịch sử, không phải hiện trạng.
- Lệnh `format:check` luôn đỏ ở `docs/HR_Web_Requirement_Tieng_Viet.md` (file gốc của người dùng, không format).

## 5. Tiến độ HR theo task (T0–T9 xong; T10–T12 còn mở trong [kế hoạch HRM](superpowers/plans/2026-10-16-hrm-implementation.md))

Số release/migration bên dưới là của chuỗi cũ trước ADR 0048 (nay gộp vào baseline, release sequence `1`).

| Task | Kết quả chính                                                                                              | Release / migration cũ         |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| T0   | Spec, acceptance, ADR 0016–0018                                                                            | -                              |
| T1   | React/Vite/Mantine, đăng nhập Google OIDC cùng origin, CSRF, session; logout mất mạng giữ phiên và báo lỗi | -                              |
| T2   | Capability HR, ma trận quyền, boundary `hrAdministration@1`, idempotency                                   | 3, 7 / 100                     |
| T3   | Hồ sơ nhân viên, team, assignment; liên kết account; F1/F2/F3 theo D08                                     | 5 / 101, 102, 105              |
| T4   | Lịch làm việc versioned, ngày làm bù                                                                       | 6 / 103                        |
| T5   | Gửi đơn năm loại, idempotency, 422 theo lý do                                                              | 106 (không release mới)        |
| T6   | Duyệt hai bước Team Lead → COO, state machine, inbox                                                       | 9                              |
| T7   | Quỹ phép: ledger append-only, định mức theo kỳ chính thức                                                  | 10 / 109                       |
| T8   | Bảng công (hàm thuần), kỳ công, hủy/đảo đơn, `attendance.adjust`, nghỉ lễ theo khoảng                      | 11, 12, 15, 16 / 110, 111, 112 |
| T9   | Sáu báo cáo + XLSX, sinh nhật, trang `/reports`                                                            | 13, 14                         |

Sau T9: `account.reactivate` (17, ADR 0043), setting (18, ADR 0045), ma trận role chỉ đọc (19, ADR 0046); ADR 0047 đang triển khai theo đợt.

## 6. Gate chưa chứng nhận

Còn hiệu lực tại 2026-10-29:

- Mapping/consolidation dữ liệu thật, restore/failover/durability; backup/restore chưa diễn tập.
- Production: IdP discovery/TLS, quản trị assurance, revoke từ IdP (hiện session ứng dụng còn tới hạn tuyệt đối 12 giờ), xoay secret, hiệu chỉnh ngưỡng limiter, pool sizing và nhiều replica.
- Audit: chưa có sink thật nên worker outbox chưa chạy ở đâu (adapter có test crash/lease/hai worker/poison); recovery delivery bền vững chưa có.
- Approval authority độc lập và audit sink cho runbook Root; chưa có CLI elevation/thêm Root.
- GitHub workflow cập nhật nhưng chưa chạy thực; local pass không là CI pass.
- Chưa đo timing Root/absent ở suspend; adapter thời gian thứ hai (Moment) chưa có, conformance chưa là export dùng lại; cleanup `one_time_token` là thao tác offline có duyệt.
- T10–T12 (hợp đồng, ký, UAT, vận hành) chưa làm; phụ thuộc D11–D14 trong kế hoạch HRM.

## 7. Tài liệu đã xóa (2026-10-29)

Thay bằng tài liệu hiện hành hoặc mục trên: `authz-architecture.md` (thiết kế đa tenant, đã bỏ), `authz-single-product-architecture.md`, `project-structure.md`, `hrm-engineering-conventions.md` (gộp vào architecture), `hrm-local-operations.md`, `single-product-operations.md` (gộp vào operations), `single-product-verification.md`, `single-product-load-results.md`, `single-product-reuse-map.md` (mục 3-4), `prompt.md`, `oidc-claims-profile-design.md`, `account-linking-analysis.md` (mục 2), và các plan/spec `2026-10-13-single-product-transition`, `2026-10-13-base-authorization`, `2026-10-14-foundation-hardening-and-adapters`, `2026-10-15-iam-root-separation` (kể cả ledger gần 5000 dòng), `2026-10-14-iam-root-separation-design`, `2026-10-16-remove-legacy`, `2026-10-16-single-app-modules` (plan và design), `2026-10-18-google-only-and-totp`, `2026-10-20-account-management`, `2026-10-20-permission-management`.
