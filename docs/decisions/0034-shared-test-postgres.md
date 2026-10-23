# ADR 0034 — Integration test dùng chung một container PostgreSQL và template database

Ngày: 2026-10-23. **Trạng thái: Accepted** (người dùng chọn cả hai phương án: một container dùng chung và template database). Chỉ đổi hạ tầng test (`apps/api/test`, `apps/api/tools/test.ts`); không đổi `src`, migration, privilege hay hành vi production.

## Bối cảnh

Mỗi file integration tự dựng container PostgreSQL 18.4 (~4,5–7 s), provision, chạy 13 HR migration trên 20 migration sản phẩm và sync manifest (~1–2,5 s): 61 file, ~10–13 s cố định/file. Thêm vào đó testcontainers 12.2.0 chờ port-bind với timeout cứng 10 s (`inspectContainerUntilPortsExposed`, không chịu `withStartupTimeout`); đã gặp 1 lần `Timed out after 10000ms while waiting for container ports to be bound`.

## Điều tra role (ràng buộc quyết định thiết kế)

- `provisionProductDatabase` tạo role cấp cluster có tên CỐ ĐỊNH `product_{data,identity,authority,sync,migration,bootstrap,outbox}` và NOLOGIN owners `product_{fence,session,object,account}_owner`. Nếu role đã có, nó chỉ kiểm thuộc tính và KHÔNG đổi mật khẩu; `connections[purpose]` lại trả mật khẩu của lời gọi hiện tại. Hai database cùng cluster với mật khẩu ngẫu nhiên riêng ⇒ file sau nhận mật khẩu sai.
- Tên role nằm cứng trong ~20 migration (GRANT/REVOKE, owner hàm) và trong body hàm đã băm; role "theo từng database" cần đổi migration/production và hash. Không làm.
- Grant/ACL trên bảng, hàm, schema, `REVOKE TEMP ON DATABASE` đều theo database, nên invariant privilege (42501, NOLOGIN owner, fence function owner, login riêng) vẫn được kiểm trên role thật trong database của từng file. Cái dùng chung là: thuộc tính role (giống nhau mọi lần), mật khẩu, và `GRANT owners TO product_migration WITH ADMIN OPTION … REVOKE` (cấp cluster, race nếu hai provision chạy song song).

## Quyết định

1. `tools/test.ts integration` khởi MỘT container (`max_connections=300`) khi có file chọn `startModuleStack(` (glob/thư mục: giả định có), tạo role `authz_provisioner` và sinh một bộ mật khẩu synthetic cho `product_*`; truyền bằng env `HRM_TEST_PG` (JSON); dừng container khi thoát (SIGINT/SIGTERM chuyển cho tiến trình con; `Ryuk` của testcontainers gỡ container nếu runner bị kill).
2. Role dùng chung với MỘT bộ mật khẩu cho cả lần chạy (`TestPostgres.passwords`). Provision chạy một lần ở template, nên không có provision song song và không có race membership.
3. Template `tpl_module_<digest>`: provision + migrations + `fixtureProvider` + `ProductManifestReconciler.reconcile` + `ensureCompany` + `ensureWorkCalendar` (`test/module-template.helper.ts`). `<digest>` = sha256 của toàn bộ `dist/**/*.js` cùng `hr-template.helper.ts` và `oidc-fixture.helper.ts`; đổi migration/manifest/sync ⇒ tên template khác, bản cũ không bao giờ dùng. Runner dựng trước khi chạy file; file cũng gọi cùng hàm (idempotent, dưới `pg_advisory_lock` cấp cluster, đánh dấu `ready` bằng `COMMENT ON DATABASE`, template dở dang bị drop và dựng lại) nên chạy lần đầu song song an toàn.
4. Mỗi file: `CREATE DATABASE t_<hex> TEMPLATE tpl_…` (dưới cùng lock, vì clone cần template không có kết nối), dùng superuser/`product_*` trong DB đó, `DROP DATABASE … WITH (FORCE)` ở `stop()` (cả đường lỗi của `startModuleStack`).
5. Opt-in, không opt-out ngầm: `startPostgres()` mặc định vẫn là container riêng (hành vi cũ); chỉ `startPostgres({ shared: true })` dùng container chung, và chỉ khi có `HRM_TEST_PG`. Không có env (chạy `node --test` trực tiếp) ⇒ tự dựng container riêng và dựng template tại chỗ; env có nhưng sai dạng ⇒ lỗi (không fallback lặng lẽ). Opt-out một file đã dùng `startModuleStack`: `startModuleStack({ isolated: true })`.
6. Port-bind flake: bỏ timeout 10 s không cấu hình được bằng cách thử lại tối đa 3 lần CHỈ khi lỗi chứa `ports to be bound`, thêm `withStartupTimeout(120_000)` cho health/log wait. Lỗi khác không retry.
7. Sửa test phụ thuộc phạm vi cluster: 6 truy vấn `pg_stat_activity` đếm session `product_data` đang chờ Lock (barrier trong `hrm-attendance.helper.ts`, `hrm-approval`, `hrm-attendance-concurrency`, `hrm-leave-concurrency`, `hrm-request`, `hrm-permits-many`) thêm `datname = current_database()`; nếu không, hai file song song đếm lẫn nhau.

## Danh sách

Dùng container chung (20 file, qua `startModuleStack`): `hrm-approval`, `hrm-attendance`, `hrm-attendance-adjust`, `hrm-attendance-concurrency`, `hrm-attendance-effects-equivalence`, `hrm-authorization-matrix`, `hrm-cancel`, `hrm-cancel-concurrency`, `hrm-coo-submit`, `hrm-employee`, `hrm-leave`, `hrm-leave-adjust`, `hrm-leave-concurrency`, `hrm-period-concurrency`, `hrm-permits-many`, `hrm-report`, `hrm-report-export-http`, `hrm-request`, `hrm-team`, `hrm-work-calendar`.

Container riêng (41 file, gồm `hrm-report-export-measure` dù dùng `startModuleStack`):

- Cần cluster riêng theo bản chất: `product-database` (role/ACL/membership cấp cluster, DB legacy, mô phỏng upgrade), `hrm-authorization-upgrade` (migration từng bước, nhiều DB), `product-genesis`, `product-account-provisioning`, `product-system-regression` (qua `system-regression.helper.ts`: CREATE/DROP DATABASE hoặc role; các file trên đã grep thấy `CREATE ROLE|CREATE DATABASE|…`), `product-fence-io`, `product-load` (đo tải/IO, không chia cluster), `hrm-report-export-measure` (đo deadline thời gian), `product-cli`, `product-cli-root`, `product-cli-mfa` (CLI offline theo yêu cầu).
- Còn lại (`product-root-*`, `product-audit`, `product-authorization`, `product-outbox`, `product-rebac-type`, `product-system*`, `product-values`, `product-identity-*`, `product-mfa-*` (gồm `product-mfa-http`), `product-sign-in-*`, `collation`, `compiler`, `hrm-authorization-probes|root-audit|workflow`): CHƯA chuyển, không phải đã chứng minh không an toàn. Mỗi helper tự `provisionProductDatabase` với mật khẩu ngẫu nhiên riêng nên cần đổi sang `postgres.passwords` và/hoặc template riêng, và kiểm từng file. Việc tiếp theo, không trong phạm vi này.

## Rủi ro

- Độc lập giữa file giảm: chung `max_connections`, CPU, bộ nhớ và role/mật khẩu; một bug làm hỏng thuộc tính role cấp cluster ảnh hưởng mọi file chung (file đụng role phải ở danh sách riêng). Test mới đếm/kill session phải lọc `datname`.
- Template chứa dữ liệu đã seed (provider fixture, release sync, company, lịch); test giả định DB trống sau migration phải dựng lại ở bản riêng. Digest bao toàn `dist` nên rebuild không đổi nội dung sẽ giữ template; đổi nội dung bất kỳ làm dựng lại (~2,3 s).
- Chạy 1–2 file không có lợi: chi phí cố định của runner (container + template) ≈ chi phí cũ của một file.
- Nếu runner bị `kill -9` và `TESTCONTAINERS_RYUK_DISABLED` bật, container mồ côi.
- Test về quyền vẫn dùng đăng nhập `product_*` thật; superuser chỉ dùng cho fixture/assert như trước. Không nới privilege.

## Số đo

Môi trường: macOS, Docker Desktop, Node 24.20.0, PostgreSQL 18.4, `--test-concurrency=2`; máy tải biến động (load 1 phút 10–35 trong lúc đo, cao đột biến do tiến trình ngoài), n = 1 mỗi dòng nên chỉ là chỉ báo.

| Workload (một lệnh `node tools/test.ts integration …`)             | Trước (số đo sẵn có)   | Sau  |
| ------------------------------------------------------------------ | ---------------------- | ---- |
| work-calendar + team                                               | 18 s                   | 21 s |
| work-calendar + team + leave-adjust + employee                     | 28+13+13+18 s riêng lẻ | 22 s |
| team riêng lẻ (runner)                                             | 13 s                   | 14 s |
| team trực tiếp `node --test` (fallback)                            | —                      | 12 s |
| product-audit (container riêng, runner không khởi container chung) | —                      | 10 s |

Pha (một lần đo): container chung 7,0 s; dựng template 2,3 s; clone mỗi file 0,2 s; drop 0,6 s. Chi phí cố định mỗi lần chạy ≈ 9 s (container + template), mỗi file dùng chung chỉ trả phần clone ≈ 0,2 s thay cho container + migration + sync (ước lượng từ các pha trên, chưa đo toàn bộ 20 file).
