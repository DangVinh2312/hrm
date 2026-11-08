# ADR-17 — Bớt round trip mỗi request: một câu phiên + facts, menu một lượt, guard không mở giao dịch

Trạng thái: **Accepted** (2026-11-03): người dùng chọn làm cả ba phần 1a, 1b, 1c. Thay điều hoãn "gộp facts của `permitsMany`" ở [ADR-03](ADR-03-fence-transactions-manifest-sync.md) và "gộp `checkSession`" ở [ADR-11](ADR-11-http-api-errors-openapi-web.md). Không đổi mô hình quyền ([ADR-02](ADR-02-authorization-core-and-value-codecs.md), [ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)), fence ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)) hay phiên ([ADR-06](ADR-06-google-auth-sessions-2fa.md)).

## Quan sát (số đo `docs/history.md` §3.6)

- Mọi route `@ProductAuthorize`/`@ProductAuthenticated` chạy hai giao dịch: guard gọi `ProductAuthorization.checkSession` (giao dịch `read` riêng: BEGIN, `set_config`, fence, `resolve_session`, COMMIT = 5 query) rồi service mở giao dịch nghiệp vụ và đọc lại phiên trong fence. Kết quả của guard không được dùng lại: comment của `ProductRequestAuth` đã ghi "data services must recheck".
- Trong giao dịch nghiệp vụ, `ProductAuthorityEngine.session` và `decide` là hai câu riêng (phiên, rồi facts theo `user_id`).
- `permitsMany` (menu `GET /api/auth/me`) chạy 2 câu mỗi cặp: facts của cặp rồi `EXISTS`. 17 cặp + phiên = 35 câu trong giao dịch; `auth/me` tổng 51 query.

## Quyết định

**1c. Phiên và facts trong một câu.** `ProductAuthorityFactsRepository` có một câu duy nhất lấy phiên (`resolve_session`) và facts của một hoặc nhiều permission theo `user_id` của chính phiên đó (`FROM resolve_session($1) s`, facts là subquery tương quan theo `s.user_id`). Không có dòng phiên thì không có dòng kết quả, xử lý như phiên không hợp lệ (401). `now`/`deadline` lấy từ cùng câu (cửa sổ 2 giây, không quá hạn phiên) như trước. `access`, `reachesTarget`, `permits` và `permitsMany` dùng câu này. `decide` theo `user_id` (dùng cho `reaches` trong command, đã có phiên) giữ câu facts riêng.

**1a. Menu một lượt.** `permitsMany` đọc phiên + facts của mọi cặp trong một câu (1c), lập plan từng cặp từ snapshot lọc theo permission của cặp, rồi gộp mọi `EXISTS` vào một câu `SELECT EXISTS(…) AS r0, EXISTS(…) AS r1, …` (tham số đánh số tiếp nối bằng `compilePlan(…, firstIndex)`). Nhóm any-of là OR của các cột. Root ở đường menu vẫn trả theo quyết định, không `EXISTS` (ADR-16).

Vì sao không đổi ngữ nghĩa quyết định (lý do ADR-03 từng hoãn):

- Facts bảo mật chỉ đổi dưới exclusive fence, mà giao dịch đọc giữ shared fence suốt từ trước câu facts, nên mọi câu facts trong cùng giao dịch, dù tách hay gộp, thấy cùng facts. Snapshot của một cặp lọc từ câu gộp bằng đúng các dòng câu riêng trả (cùng điều kiện, cùng thứ tự `rule_id`).
- `EXISTS` của mọi cặp chạy trong một statement nên cùng một snapshot dữ liệu; trước đây mỗi cặp một snapshot READ COMMITTED khác nhau. Gộp chỉ chặt hơn.
- Cửa sổ thời gian: trước đây mỗi cặp làm mới `now`/`deadline` từ câu facts của nó; nay một cửa sổ chung từ câu phiên + facts, `EXISTS` vẫn kèm `statement_timestamp() < validUntil`. Cả lượt chỉ còn hai câu nên cửa sổ 2 giây đủ; nếu câu `EXISTS` chạy quá cửa sổ thì mọi cặp `false` (fail closed), không bao giờ trả `true` từ plan hết hạn.
- Cặp không khai báo vẫn `false`: planner từ chối khi snapshot không có permission đó.

Câu phiên + facts đọc `resolve_session` qua `(SELECT … FROM public.resolve_session($1) LIMIT 1) s`. `token_hash` là khóa chính nên kết quả không đổi. Không có `LIMIT`, planner ước lượng hàm trả 1000 dòng, nhân với các subplan theo `s.user_id` cho ra cost khoảng 665 000, vượt `jit_above_cost` (100 000) khi `policy_rule` lớn đã `ANALYZE` (20 001 rule). Khi đó mỗi request tốn khoảng 1 giây biên dịch JIT, phát hiện qua `product-account-role` chậm 10–30 lần so với HEAD. Có `LIMIT 1` thì cost còn khoảng 668 và câu chạy 3 ms. Test `hrm-permits-many` giữ cost của đúng câu này dưới `jit_above_cost`.

`MAX_PERMIT_PROBES` giữ 17 trong ADR này; nâng trần cần số đo mới (chi phí nay không còn tuyến tính theo round trip).

**1b. Guard không mở giao dịch.** `requestAuth.authenticate` ở composition root (`app.module.ts`) chỉ kiểm cookie phiên có và đúng dạng secret (43 ký tự base64url, như `newSessionSecret`); thiếu hoặc sai dạng là 401 như trước. Phiên thật (tồn tại, hạn, trạng thái, `auth_epoch`) chỉ kiểm trong giao dịch có fence của service, như đã bắt buộc. `ProductAuthorization.checkSession` bị xóa.

Hệ quả người dùng đã chấp nhận: với cookie đúng dạng nhưng phiên không hợp lệ (hết hạn, đã thu hồi), request có body sai trả `400 error.invalidRequest`, mutation thiếu CSRF/Origin trả `403 error.accessDenied`, thay vì `401`. Cùng loại: lệnh tài khoản có id đích sai dạng trả `403` (kiểm dạng trước giao dịch), và lệnh cần đúng một OIDC provider trả `503` khi cấu hình không đủ. Không lộ fact nào: các mã này chỉ phụ thuộc dạng input hoặc cấu hình triển khai, không phụ thuộc phiên hay dữ liệu, và mọi đọc/ghi vẫn 401 trước khi chạm dữ liệu. Web đã xử lý 400/403/401/503 theo `code`.

Điều kiện an toàn của 1b: mọi handler không `@ProductPublic` phải đi qua service xác thực phiên trong fence trước khi đọc/ghi dữ liệu hay làm việc tốn tài nguyên, và chỉ phiên còn sống mới được chờ exclusive fence. Review độc lập (93 handler, 84 không public) thấy một chỗ hở: `logout`/`logout-all` mở giao dịch `revoke` (exclusive fence) rồi mới xác thực, nên cookie giả đúng dạng chặn mọi đọc/ghi trong lúc chờ. Đã sửa: `ProductIdentityService.logout` xác thực trước trong giao dịch `read` (như `#limit` của MFA, `reachesTarget` của lệnh admin), giao dịch `revoke` vẫn xác thực lại. Test HTTP có ca cookie đúng dạng nhưng phiên giả trả 401 ở route đọc, `logout` và lệnh admin, chỉ mở giao dịch `read`.

## Kiểm chứng

- Test hành vi trên PostgreSQL thật: `permitsMany` gộp cho cùng đáp án với `permits` từng cặp trên các ca deny, boundary, record allow, Root, cặp không khai báo, any-of; một câu facts + một câu `EXISTS` mỗi lượt (đếm query); hết cửa sổ thì `false`.
- Phiên không hợp lệ/đã thu hồi/tài khoản bị khóa ở mọi đường (`access`, `permits`, `permitsMany`, `reachesTarget`) vẫn 401; thu hồi role có hiệu lực ở request kế tiếp.
- Guard: thiếu cookie, cookie sai dạng → 401 không mở giao dịch; cookie đúng dạng nhưng giả → 401 từ service.
- Số đo lại bằng `hrm-http-measure.integration-spec.ts`, cùng máy và cấu hình với §3.6.
- Review độc lập (đường quyết định phân quyền và xác thực).

Kết quả (2026-11-03):

- API unit 445/445.
- Integration 656 pass, 3 skip, 0 fail. Đây là lượt chạy đầy đủ trước khi đổi `SELECT *` thành cột tường minh. Sau đổi đó, đã chạy lại unit cùng `hrm-permits-many`, `product-request-auth-http` và `product-account-role`, tất cả đều pass.
- e2e 1/1.
- Số đo sau thay đổi ở `docs/history.md` §3.6.
- Review độc lập (93 handler) tìm ra chỗ hở `logout`, đã sửa như trên.

## Còn mở

- Gộp `currentSession` và `ownEmployee` vào giao dịch của `permitsMany` (ADR-11) không thuộc ADR này.
- `count(*) OVER()` của list là chi phí lớn nhất ở 10 000 dòng (§3.2, §3.6); đổi contract `total` cần ADR riêng.
