# HRM — Thiết kế mốc M0–M3 (T0)

Ngày: 2026-10-17. **Trạng thái:** Đã review với người dùng 2026-10-17 — G0 D01–D10 chốt (§12.0, §12.3), quyết định kỹ thuật TD1–TD9 duyệt (§12.4). Chưa có code HR; mục còn nhãn [P] là diễn giải kỹ thuật có thể chỉnh khi review task. D11–D14 vẫn mở (chặn T10–T12). ADR: [0016](../../decisions/0016-hrm-authorization-and-pii.md), [0017](../../decisions/0017-hrm-transaction-lock-idempotency.md), [0018](../../decisions/0018-hrm-data-model-and-time.md). Ví dụ có expected result ở [acceptance](../../hrm-acceptance.md).

Nguồn: [requirement](../../HR_Web_Requirement_Tieng_Viet.md), [kế hoạch](../plans/2026-10-16-hrm-implementation.md), [engineering conventions](../../hrm-engineering-conventions.md), ADR 0012–0015 và source `apps/api/src` tại working tree ngày 2026-10-17.

## 0. Cách đọc

Mỗi quy tắc gắn một nhãn nguồn. Nhãn quyết định ai có quyền đổi quy tắc:

| Nhãn      | Nghĩa                                                                   | Ai đổi                        |
| --------- | ----------------------------------------------------------------------- | ----------------------------- |
| **[R]**   | Có trong requirement                                                    | Chỉ người dùng/owner sản phẩm |
| **[C]**   | Đã chốt (người dùng chọn hoặc ADR đã Accepted)                          | ADR mới                       |
| **[P]**   | Đề xuất kỹ thuật trong spec/ADR Proposed, chờ review                    | Review T0                     |
| **[Dxx]** | Quy tắc nghiệp vụ còn mở trong G0; phương án ở §12, chưa được implement | Người dùng                    |

Task phụ thuộc một mục **[Dxx]** dừng trước implementation tới khi mục đó được chốt; phần còn lại vẫn tiến hành.

## 1. Phạm vi

Spec này đủ chi tiết cho M0–M3 (T1–T8): đăng nhập, hồ sơ/team, lịch, gửi đơn, hai bước duyệt, phép và công. Báo cáo (T9) chỉ chốt nguyên tắc cutoff/scope; hợp đồng và ký (T10–T11) chỉ liệt kê phụ thuộc D11–D13, không thiết kế schema.

Ngoài phạm vi: payroll, máy chấm công, tenant, microservice, workflow engine, MFA mới, recovery delivery provider.

## 2. Hiện trạng đã kiểm trong source

Kiểm bằng đọc file ngày 2026-10-17, chưa chạy runtime suite trong lượt này.

| Capability                                                                                                                                                                                                                                                         | Bằng chứng                                                                   | Hệ quả cho HRM                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ProductAuthorization` public: `checkSession`, `list`, `detail`, `count`, `update` (allowlist field), `suspendUser`. `access()` là `private`.                                                                                                                      | `authorization/services/product-authority.service.ts`                        | Không có create/command nghiệp vụ; T2 phải thêm capability HR trong cùng service owner, không public `access`          |
| Root branch duy nhất trong `access`: `kind` từ `resolve_session`, Root cần fresh 300 s chỉ khi policy của action có `fresh@1` (ADR 0022), audit mỗi access commit                                                                                                  | cùng file                                                                    | HR command đi qua cùng `access` nên Root giữ semantics ADR 0012                                                        |
| Runner: `read`/`write`/`identity` dùng shared fence; `revoke`/`admin`/`bootstrap` khóa `authz_state FOR UPDATE` và tăng revision; `admin` dùng pool `authority`; deadline ≤ 2000 ms, lock ≤ 1000 ms, retry ≤ 2 chạy lại toàn bộ `work` khi `40P01`/`40001`/`55P03` | `database/product-transaction.runner.ts`                                     | Work callback chỉ được chứa DB effects rollback được; facts HR đi `admin` cần grant mới cho login `authority`          |
| Login `data` chỉ SELECT bảng authority, không INSERT `object_ref`; login `authority` có INSERT `object_ref`                                                                                                                                                        | `database/helpers/product-database.helper.ts#expectedPrivileges`             | Tạo bản ghi HR (đơn, hồ sơ) trong mode `write` cần quyết định cách cấp `object_ref` — ADR 0016 §4                      |
| Domain relation chỉ resource → identity, có cửa sổ `starts/expires` so với `statement_timestamp()`; resource → resource bị từ chối lúc dựng registry                                                                                                               | `authorization/product-sql.compiler.ts` (`ProductBindingRegistry`, `exists`) | Scope "lead của nhân viên sở hữu đơn" phải đi qua domain table/view có cột request key + lead account                  |
| AST người dùng: `constant`, `and`, `or`, `eq`, `lt`, `lte`, `isNull`, `exists`; `not` chỉ core tạo                                                                                                                                                                 | `authorization/core/authorization.types.ts`                                  | "Không tự duyệt" không biểu diễn được bằng policy scope; phải là guard nghiệp vụ code-owned (deny rule chỉ là lớp phụ) |
| Projection cố định theo resource binding                                                                                                                                                                                                                           | `ProductResourceBinding.projection`                                          | Field ACL thực hiện bằng **resource riêng cho nhóm field nhạy cảm**, không bằng ẩn cột ở controller                    |
| `GET /api/auth/session` trả `userId`, `method`, `assurance`                                                                                                                                                                                                        | `auth/controllers/auth.controller.ts`                                        | Cần route bootstrap HR riêng (§10.2)                                                                                   |
| Audit là union đóng, không metadata tự do                                                                                                                                                                                                                          | `audit/product-audit.repository.ts#ProductAuditEvent`                        | Thêm variant `hr.*` typed, chỉ id/kind/outcome                                                                         |
| Manifest release `2`, resources `document`, `account`, role `reviewer`                                                                                                                                                                                             | `authorization/product.manifest.ts`                                          | HRM = release mới `3` với fragments HR; giữ document fixture tới khi có bằng chứng thay thế                            |

## 3. Thuật ngữ, thời gian và đơn vị

- **Ngày nghiệp vụ** [P]: PostgreSQL `date`, chuỗi `YYYY-MM-DD` ở API; timezone nghiệp vụ cố định `Asia/Ho_Chi_Minh` (UTC+7, không DST) chỉ dùng khi chuyển thời điểm sự kiện sang ngày nghiệp vụ, truyền tường minh, không đọc timezone máy.
- **Giờ trong ngày** [P]: số phút từ 00:00 (`smallint`, 0..1440). 09:00 = 540, 13:00 = 780, 14:00 = 840, 18:00 = 1080.
- **Thời điểm sự kiện** [C]: `timestamptz` UTC, đồng hồ DB (`statement_timestamp()`), precision µs như base.
- **Phép/công** [P]: số phút nguyên. 0,25/0,5/1 ngày = 120/240/480 phút [R]. 12 ngày = 5760 phút. Không dùng float; hiển thị ngày = phút/480 định dạng ở UI.
- **Ca chuẩn** [R]: thứ Hai–thứ Sáu, 09:00–13:00 và 14:00–18:00; 13:00–14:00 không tính.
- **Slot nghỉ hợp lệ** [R]: 09–11, 11–13, 14–16, 16–18 (120); 09–13, 14–18 (240); 09–18 (480 sau khi trừ trưa). Slot khác bị từ chối kể cả cùng số phút.
- **Tháng WFH** [R]: tháng dương lịch của **ngày WFH**, không phải tháng bấm duyệt [P, theo review focus 3].

## 4. Vai trò và ánh xạ IAM

| Vai trò nghiệp vụ [R] | Ánh xạ đề xuất [P]                                                                                                                              | Ghi chú                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Nhân viên             | role `hr.employee` + scope `self` (employee.account_id = principal.id)                                                                          | Mọi người có hồ sơ, kể cả Lead/COO/HR/CEO, đều là nhân viên với chính họ                        |
| Team Lead             | Không cần role riêng cho scope: quyền lead suy ra từ **assignment** trong domain table, grant cho role `hr.employee` với template `ledRequests` | Ai không có assignment thì template trả false. Một người có thể lead nhiều team [C D01]         |
| COO                   | role `hr.coo` (grant `work-request.decide-final`)                                                                                               | Đơn của chính COO tự duyệt khi gửi [C D01]; giả định mọi người giữ role này đều duyệt cuối được |
| HR/Admin              | role `hr.admin`                                                                                                                                 | Phạm vi company; không có capability reset/link identity đăng nhập [C]                          |
| CEO                   | Chỉ `hr.employee`; **không** grant duyệt [R]                                                                                                    | Không là người duyệt thay thế [C D01]                                                           |
| Root                  | `kind = root`, ngoài IAM [C, ADR 0012]                                                                                                          | Bypass phân quyền, **không** bypass invariant nghiệp vụ (§6.3)                                  |

Role keys/permission keys là đề xuất; chúng là dữ liệu đã lưu sau sync nên phải chốt trước T2.

## 5. Ma trận quyền và field

### 5.1. Nhóm field

| Nhóm             | Field                                                                            | Resource riêng [P]                                 |
| ---------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| F1 cơ bản        | mã NV, họ tên, các team + team chính, trạng thái làm việc hiện tại, ngày vào làm | `employee`                                         |
| F2 định danh     | ngày sinh, loại + số giấy tờ (CCCD…), MST                                        | `employee-identity`                                |
| F3 định mức phép | định mức phép năm theo hiệu lực                                                  | `leave-rate`                                       |
| F4 đơn           | loại, ngày/slot, trạng thái, lịch sử quyết định                                  | `work-request`                                     |
| F5 lý do đơn     | lý do/ghi chú tự do của người gửi và người duyệt                                 | trong `work-request` (người duyệt cần đọc) [C D08] |
| F6 số dư/công    | số dư phép, bảng công                                                            | `leave-balance`, `attendance`                      |

### 5.2. Ma trận actor × action × scope

`S` = self, `T` = nhân viên thuộc bất kỳ team nào đang lead / đơn mà actor là người duyệt bước 1 hiện hành (§6.4), `Q` = hàng đợi đúng stage, `A` = toàn công ty, `—` = deny. D08 đã chốt 2026-10-17 (§12.0); ô còn **(Dxx)** là chờ quyết định khác.

| Resource.action                 | Nhân viên       | Team Lead                               | COO                                   | HR/Admin                    | CEO | Ghi chú                                                      |
| ------------------------------- | --------------- | --------------------------------------- | ------------------------------------- | --------------------------- | --- | ------------------------------------------------------------ |
| `employee.read` (F1)            | S               | S + T                                   | S + A                                 | A                           | S   |                                                              |
| `employee.create`/`update` (F1) | —               | —                                       | —                                     | A                           | —   | `update` allowlist field; không sửa account link             |
| `employee-identity.read` (F2)   | S               | —                                       | —                                     | A                           | S   | Lead/COO không cần F2 để duyệt                               |
| `employee-identity.update` (F2) | —               | —                                       | —                                     | A, fresh                    | —   |                                                              |
| `employee.link-account`         | —               | —                                       | —                                     | A, fresh, boundary required | —   | Gán quyền self cho account khác → facts change               |
| `team.read`                     | S               | S + T                                   | A                                     | A                           | S   |                                                              |
| `team.assign` (membership/lead) | —               | —                                       | —                                     | A, fresh, boundary required | —   | Facts change, exclusive fence                                |
| `leave-rate.read` (F3)          | S               | —                                       | —                                     | A                           | S   |                                                              |
| `leave-rate.adjust` (F3)        | —               | —                                       | —                                     | A, fresh                    | —   | Ledger entry, không sửa số dư trực tiếp                      |
| `employee.submit-request`       | S               | S                                       | S                                     | S                           | S   | Authorize trên hồ sơ của chính mình (§7.2)                   |
| `work-request.read` (F4)        | S               | S + T                                   | S + Q + đã quyết                      | A                           | S   | Người đã quyết định giữ quyền đọc đơn đó                     |
| `work-request.decide-lead`      | —               | T, stage `pending_lead`, không tự duyệt | —                                     | —                           | —   | Scope + guard §6                                             |
| `work-request.decide-final`     | —               | —                                       | stage `pending_final`, không tự duyệt | —                           | —   | Final approval đóng tới gate M3                              |
| `work-request.cancel`           | S, đơn đang chờ | —                                       | —                                     | A, đơn đã duyệt, fresh      | S   |                                                              |
| `leave-balance.read` (F6)       | S               | S + T                                   | S                                     | A                           | S   |                                                              |
| `attendance.read` (F6)          | S               | S                                       | S                                     | A                           | S   |                                                              |
| `attendance.adjust`             | —               | —                                       | —                                     | A, fresh, kỳ đang mở        | —   |                                                              |
| `work-calendar.read`            | A               | A                                       | A                                     | A                           | A   | Lịch không phải PII                                          |
| `work-calendar.manage`          | —               | —                                       | —                                     | A, fresh, kỳ đang mở        | —   |                                                              |
| `report.*` (T9)                 | —               | —                                       | A, không CCCD/MST                     | A                           | —   | Export dùng cùng scope; ngày sinh chỉ trong report sinh nhật |

Quy tắc chung [C]: default deny, deny thắng allow, boundary nằm ngoài mọi allow, list/detail/count/export cùng AST, không lọc sau pagination, không suy update từ read. Absent và ngoài scope trả cùng shape `404`.

### 5.3. Biểu diễn trong manifest [P]

- **Template `self`**: trên `employee` là `eq accountId principal.id`. Các resource 1:1 có key là `employee_id` (`employee-identity`, `leave-rate`, `leave-balance`, `attendance`) dùng domain relation `employee_owner` (view `hr_employee_owner(employee_id, account_id)`), không sao chép `account_id` sang từng bảng để tránh lệch khi đổi account link.
- **Template `ownRequests`** trên `work-request`: domain relation `request_owner` (view `hr_request_owner(request_id, account_id)`).
- **Template `ledRequests`**: domain relation `request_lead` trên view `hr_request_lead(request_id, lead_account_id)` trả **người duyệt bước 1 hiện hành** theo §6.4 (team của đơn nếu nhân viên còn là thành viên, nếu không thì team chính), chỉ dùng membership/assignment đang hiệu lực tại `statement_timestamp()` [C D02]. Template `ledMembers` cho `employee`/`leave-balance` dùng view `hr_employee_lead(employee_id, lead_account_id)` trên mọi team hiện hành của nhân viên.
- **Template `decidedRequests`**: domain relation `request_decider` trên `request_decision(request_id, actor_account_id)`.
- **Policy `leadStage`** cho `decide-lead`: `requiredScope = eq state 'pending_lead'`; **`finalStage`** cho `decide-final`: `eq state 'pending_final'`. Policy là code-owned, nên grant sai stage không mở được.
- View dùng `security_invoker=true` như `iam_account`; login đọc phải có SELECT trên bảng nền. Parity test SQL ↔ evaluator bắt buộc (T2).
- **Không tự duyệt**: guard code-owned trong command `decide` (`request.owner_account_id ≠ actor`), áp cho cả Root [P]. Có thể thêm deny rule mặc định nhưng không coi deny row là bảo vệ chính vì đó là dữ liệu grant.
- **Key đã lưu (T2, release 3)** [C, chốt khi implement]: core chỉ nhận resource/action dạng `^[a-z][A-Za-z0-9_]*$`, nên các tên có gạch nối ở bảng §5.2 được lưu dạng camelCase: `workRequest.read|decideLead|decideFinal|cancel|cancelApproved`, `employee.read|submitRequest`, `team.read`; resource sau này `employeeIdentity`, `leaveRate`, `leaveBalance`, `hrCompany`. `work-request.cancel` tách thành `cancel` (người gửi, đơn đang chờ, policy `pendingStage`) và `cancelApproved` (HR, đơn đã duyệt, policy `approvedFresh` có `fresh@1`) vì policy gắn theo action. Relation: `employee.lead`, `team.member`, `team.lead`, `workRequest.owner|lead|decider`; template `ledMembers` lưu tên `ledEmployees`. Role: `hr.employee`, `hr.coo`, `hr.admin`. Không có grant → plan `false` → 404 như bản ghi vắng mặt.
- **Key đã lưu (T3, release 5)** [C, chốt khi implement]: `hrCompany.read|createEmployee|createTeam` (singleton cha của create), `employee.update|adjustLeaveRate|linkAccount`, `team.update|assign`, `employeeIdentity.read|update` (F2), `leaveRate.read` (F3); policy `hrWrite` (không fresh) và `hrFresh` (`fresh@1`); relation `employeeIdentity.owner`, `leaveRate.owner`; template `company`, `selfIdentity`, `allIdentities`, `selfLeaveRates`, `allLeaveRates`. `employee.linkAccount`, `team.assign` là `boundary: 'required'`. Thiếu fresh-auth/boundary → 403; không có grant → 404/danh sách rỗng.
- **Key đã lưu (T4, release 6)** [C, chốt khi implement]: resource singleton `workCalendar` (`read` policy `hrRead`, `manage` policy `hrFresh`), template `calendar`; grant `workCalendar.read` cho `hr.employee`/`hr.coo`/`hr.admin`, `workCalendar.manage` cho `hr.admin`. Không có role HR → `GET` 404, `PUT` 403. Menu `calendar` theo `workCalendar.read`.

## 6. State machine yêu cầu

### 6.1. Trạng thái [P]

`pending_lead` → `pending_final` → `approved`; `rejected` và `cancelled` là terminal. Tên `pending_final` thay `pending_coo` để không gắn tên chức danh vào dữ liệu đã lưu. Submit có thể vào thẳng `pending_final` hoặc `approved` theo §6.4 [C D01].

### 6.2. Bảng chuyển trạng thái

| From            | Event             | Permission                          | Guards (theo thứ tự, mọi guard đều chạy cả với Root)                                                                                                                                                                                                                                                                                                 | To                                                   | Effects trong cùng transaction                                                                                   |
| --------------- | ----------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| —               | `submit`          | `employee.submit-request` S         | schema; `teamId` là team hiện hành của người gửi (mặc định team chính); loại đơn hợp lệ với trạng thái làm việc tại **từng ngày** của đơn [R §4.5]; slot [R]; ngày làm việc theo lịch; ngày trong [hôm nay − 7, hôm nay + 90] và không qua năm [C D06]; không trùng giờ [C D06]; kỳ công chưa chốt [C D07]; số dư phép khả dụng [C D09]; idempotency | `pending_lead` / `pending_final` / `approved` (§6.4) | request + segments + decision hệ thống nếu bỏ bước/tự duyệt + effects nếu `approved` + audit `hr.request.submit` |
| `pending_lead`  | `lead_approve`    | `work-request.decide-lead`          | expectedVersion; actor ≠ owner; actor là người duyệt bước 1 hiện hành (§6.4); idempotency                                                                                                                                                                                                                                                            | `pending_final`                                      | decision(stage lead) + audit                                                                                     |
| `pending_lead`  | `lead_reject`     | như trên                            | như trên; lý do bắt buộc [C D08]                                                                                                                                                                                                                                                                                                                     | `rejected`                                           | decision + audit                                                                                                 |
| `pending_final` | `final_approve`   | `work-request.decide-final`         | expectedVersion; actor ≠ owner; được phép cùng người đã duyệt bước 1 [C D01]; WFH vượt 4 → cảnh báo, cần `acknowledgeWfhLimit` [C D04]; số dư phép [C D03/D09]; kỳ công chưa chốt [C D07]; có effect handler cho kind                                                                                                                                | `approved`                                           | decision + leave debit + attendance effect + WFH count + audit                                                   |
| `pending_final` | `final_reject`    | như trên                            | expectedVersion; actor ≠ owner; lý do bắt buộc                                                                                                                                                                                                                                                                                                       | `rejected`                                           | decision + audit                                                                                                 |
| `pending_*`     | `cancel`          | `work-request.cancel` S             | chỉ người gửi; expectedVersion; idempotency [C D06]                                                                                                                                                                                                                                                                                                  | `cancelled`                                          | decision(cancel) + audit                                                                                         |
| `approved`      | `cancel_approved` | `work-request.cancel` A (HR), fresh | lý do bắt buộc; mọi ngày của đơn thuộc kỳ công đang mở; expectedVersion; idempotency [C D06/D07]                                                                                                                                                                                                                                                     | `cancelled`                                          | reversal ledger phép đúng một lần + gỡ effect công + giảm WFH counter + decision + audit; không cần duyệt lại    |

Mọi cặp (state, event) khác → `409 invalid_transition`, không đổi dữ liệu, không audit thành công. Helper thuần `nextState(state, event)` trả next state hoặc typed rejection; test table-driven cho **toàn bộ** state × event.

### 6.3. Bất biến

1. Mỗi `(request_id, stage)` có tối đa một decision (UNIQUE) [P]. Decision append-only: login runtime chỉ có INSERT/SELECT.
2. Không bỏ bước: `final_approve` chỉ từ `pending_final`. Root cũng vậy [C, plan].
3. Không tự bấm duyệt đơn của mình. Ngoại lệ duy nhất là quy tắc hệ thống §6.4 (lead bỏ bước, COO tự duyệt), ghi thành decision `actor_kind = system` có lý do, không qua `decide`. Người gửi hộ không tồn tại ở M2 [P].
4. Không fallback sang CEO hoặc Root khi thiếu người duyệt [R/C]. Thiếu người duyệt → đơn chờ, HR thấy cảnh báo [C D01]. Không ủy quyền tạm [C D01].
5. Gate M3 [C, plan]: `final_approve` tra map `kind → effect handler` cố định lúc boot; thiếu handler → `409 final_approval_unavailable`, rollback, không đổi state. Ở M2 map rỗng nên mọi final approve bị từ chối và có test chứng minh.
6. Đơn đã gửi bất biến nội dung (ngày, slot, loại). Sửa = hủy + gửi mới [C D06].
7. Version: `work_request.version` tăng 1 mỗi transition; UPDATE có điều kiện `WHERE id=$ AND version=$expected AND state=$from`, 0 dòng → `409 stale_version`.

### 6.4. Chuỗi duyệt [C D01/D02, 2026-10-17]

Tổ chức: một nhân viên có thể thuộc nhiều team, HR đặt một **team chính** (mặc định khi gửi đơn); mỗi team có tối đa một lead tại một thời điểm; một người có thể lead nhiều team.

Khi `submit`, server xác định theo thứ tự, dùng facts trong cùng transaction:

1. Người gửi giữ role `hr.coo` → đơn **tự duyệt**: kiểm đủ WFH cap, số dư phép, effect handler như `final_approve`, ghi decision hệ thống `coo_self_approved`, state `approved`. Trước gate M3, thiếu effect handler → `409 final_approval_unavailable`, không tạo đơn.
2. Người gửi là lead hiện hành của team đã chọn → **bỏ bước lead**: decision hệ thống `lead_skipped_submitter_is_lead`, state `pending_final`.
3. Còn lại → `pending_lead`.

Người duyệt bước 1 hiện hành (tính lúc quyết định, không chụp lúc gửi): lead hiện hành của team ghi trên đơn nếu nhân viên còn là thành viên team đó; nếu không còn thì lead hiện hành của team chính. Không có lead → không ai quyết được, HR thấy cảnh báo.

Một người vừa là lead vừa là COO quyết hai bước bằng hai thao tác riêng, ghi hai decision [C D01]. Người gửi được bỏ bước lead ở (2) không vì vậy mà được duyệt cuối đơn của mình; nếu người đó còn giữ `hr.coo` thì (1) đã áp dụng trước.

Các trường hợp được chốt từ câu trả lời của người dùng, chưa có trong requirement gốc; không sửa requirement.

## 7. Transaction, khóa và idempotency

Chi tiết và lý do trong [ADR 0017](../../decisions/0017-hrm-transaction-lock-idempotency.md). Tóm tắt [P]:

### 7.1. Chế độ transaction

| Loại thao tác                                                                    | Mode runner    | Pool        | Fence     | Revision |
| -------------------------------------------------------------------------------- | -------------- | ----------- | --------- | -------- |
| Đọc HR, submit, decide, HR sửa F1/F2, adjust ledger/công, lịch                   | `read`/`write` | `data`      | shared    | không    |
| Facts quyết định quyền: membership, lead assignment, account link, grant role HR | `admin`        | `authority` | exclusive | +1       |

### 7.2. Tạo bản ghi

Create không có row để predicate. Pattern [P]: authorize action trên **bản ghi cha đã tồn tại** (`employee.submit-request` với `self`; `team.create` dùng resource singleton `hr-company`), rồi INSERT trong cùng `work`. Cấp `object_id` qua hàm `SECURITY DEFINER hr_register_object(type_key, key)` chỉ nhận type HR đã đăng ký (ADR 0016 §4).

### 7.3. Thứ tự khóa (mọi writer HR)

1. Runner: (advisory nếu có) → fence.
2. Session + authority facts + plan (`access`).
3. Idempotency claim: `INSERT … ON CONFLICT DO NOTHING` theo `(actor, operation, key)`, rồi đọc dòng.
4. `employee` `FOR NO KEY UPDATE`, nhiều nhân viên thì theo `id` tăng dần.
5. `work_request` theo `id` tăng dần, `FOR NO KEY UPDATE`.
6. Bucket: `INSERT … ON CONFLICT DO NOTHING` rồi `SELECT … FOR UPDATE` theo `(employee_id, kind, period)` tăng dần — WFH tháng, phép năm.
7. Kỳ công `attendance_period` của các tháng liên quan, `FOR SHARE` khi ghi đơn/effect; HR chốt/mở lại khóa `FOR UPDATE` [C D07].
8. Ghi decision/effects/audit → commit.

Không network/render/hash trong `work` vì runner có thể chạy lại `work`. Facts change (`admin`) không khóa dữ liệu HR ngoài bảng facts và employee cần kiểm affected set.

### 7.4. Idempotency [P]

- Header `Idempotency-Key` (UUID v4, bắt buộc với submit/decide/cancel/adjust). Bảng `hr_idempotency(actor_id, operation, key, payload_hash, target_id, result jsonb, created_at)`, PK `(actor_id, operation, key)`; `payload_hash` = SHA-256 của payload đã normalize (tính ngoài SQL, không lưu body).
- Cùng key + cùng hash → **recheck quyền hiện tại** rồi trả kết quả cũ (`result` chỉ chứa id/state/version, không PII). Mất quyền → 404.
- Cùng key khác hash → `422 idempotency_key_reused`.
- Dòng claim chỉ commit cùng effect; rollback thì không còn marker. Retention đề xuất 7 ngày, purge offline/CLI; quá hạn → key mới.

## 8. Dữ liệu và bất biến

Schema đề xuất trong [ADR 0018](../../decisions/0018-hrm-data-model-and-time.md). Bất biến chính:

| Bất biến                                                                                                                                                   | Cơ chế                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Mã NV duy nhất, account link duy nhất (nullable)                                                                                                           | UNIQUE                                                                                                        |
| Một trạng thái làm việc cho mỗi ngày của nhân viên                                                                                                         | Khoảng `[starts_on, ends_on)` không chồng: EXCLUDE (cần `btree_gist`) hoặc kiểm dưới employee lock — ADR 0018 |
| Membership không trùng `(employee, team)` hiện hành; đúng một team chính hiện hành cho nhân viên có membership; tối đa một lead hiện hành mỗi team [C D01] | Partial UNIQUE trên dòng `ends_at IS NULL` + kiểm khoảng dưới exclusive fence                                 |
| `work_request.team_id` là team người gửi thuộc lúc gửi                                                                                                     | Kiểm trong transaction submit dưới employee lock                                                              |
| Slot hợp lệ                                                                                                                                                | CHECK `(start_minute,end_minute) IN (…)` theo kind                                                            |
| Một decision/stage                                                                                                                                         | UNIQUE `(request_id, stage)`                                                                                  |
| Một debit phép cho mỗi segment, một reversal cho mỗi debit                                                                                                 | UNIQUE `source_segment_id`, UNIQUE `reverses_entry_id`                                                        |
| WFH counter = số ngày WFH đã duyệt trong tháng (cho phép vượt 4, chỉ cảnh báo) [C D04]                                                                     | Counter bucket `CHECK (approved_count >= 0)` dưới bucket lock; khớp với tổng segment WFH approved             |
| Với mọi tháng M của năm: phép đã duyệt + đang chờ có ngày ≤ cuối M ≤ phép tích lũy tới hết M [C D03/D09]                                                   | Kiểm dưới bucket lock phép năm; không dùng CHECK truy vấn bảng khác                                           |
| Định mức phép ≥ 12 ngày                                                                                                                                    | CHECK `annual_minutes >= 5760` [R]                                                                            |

## 9. Tính công và phép [C D03/D05/D07/D09, 2026-10-17]

- Công chuẩn ngày = 480 phút nếu ngày làm việc theo lịch version hiệu lực và trong employment period [R §2]; ngày lễ/Tết hưởng nguyên lương tính là có lương, không phải phút làm việc [R]. Mặc định đủ công; chỉ đơn **đã duyệt cuối** tạo effect [R].
- Effect theo loại: unpaid → phút không lương; annual → phút nghỉ phép có lương; WFH → đánh dấu WFH, đủ công; đi muộn/về sớm → **chỉ ghi nhận** số lần và số phút cho báo cáo, không trừ công, không quota [C D05].
- Đi muộn/về sớm: giờ dự kiến nằm trong ca; đi muộn `expectedMinute` ∈ [541, 780] ∪ [841, 1079], về sớm ∈ [541, 779] ∪ [841, 1079]; tối đa một đơn mỗi loại mỗi ngày [C D05; mốc biên chính xác là P].
- Nguồn chuẩn [P]: bảng công = hàm thuần(calendar version, employment periods, approved effects, adjustments). Không lưu bảng công tổng như nguồn thứ hai.
- Chốt kỳ [C D07]: HR chốt từng tháng; khi chốt lưu snapshot bảng công gắn version đầu vào. Kỳ đã chốt: không nhận đơn mới, duyệt cuối, hủy đơn đã duyệt, điều chỉnh công hay sửa lịch có ngày trong kỳ (`409 period_closed`). HR mở lại kỳ có lý do + audit, rồi chốt lại; sửa lịch quá khứ chỉ áp vào kỳ đang mở.
- Phép năm tích lũy theo tháng [C D03]: tháng M được tính nếu nhân viên **ở trạng thái chính thức vào ngày 15** của tháng M (chính thức/vào làm từ ngày 1–15 thì tính; nghỉ việc với ngày làm cuối ≥ 15 thì tính). Tích lũy cộng dồn tới hết một tháng = `floor(R × k / 12)` phút, với k = số tháng đã được tính trong năm tới hết tháng đó và R = định mức hiệu lực ngày 15; năm đủ 12 tháng cộng đúng R, không trôi số. Đổi định mức giữa năm: mỗi tháng tính phần chênh `floor(R×k/12) − floor(R×(k−1)/12)` theo R của tháng đó [P công thức]. Thử việc không tích lũy, không cộng bù [R].
- Không chuyển phép sang năm sau, hết 31/12; thâm niên không tự cộng phép (HR tăng định mức riêng nếu cần) [C D03].
- Không nghỉ trước phép chưa tích lũy: đơn ngày D chỉ dùng phép tích lũy tới hết tháng của D [C D03], kiểm theo bất biến §8 cho mọi tháng.
- Số dư hiển thị [C D09]: được cấp (tích lũy tới tháng báo cáo), đã dùng tới ngày báo cáo, đã duyệt cho ngày sau ngày báo cáo, đang chờ, khả dụng. Khả dụng = tích lũy − đã duyệt (mọi ngày trong năm) − đang chờ; không âm.
- Ledger append-only `accrual`/`debit`/`reversal`/`adjustment`; debit ghi tại duyệt cuối, đơn chờ không ghi ledger mà được tính "đang chờ" từ bảng đơn. Nghỉ việc giữa năm khi đã dùng nhiều hơn tích lũy: HR điều chỉnh bằng `adjustment`, không tự âm.
- Lịch nghỉ lễ: HR nhập ngày cụ thể từng năm từ nguồn đã xác minh. Spec không hardcode ngày lễ. Nguồn cần đối chiếu khi nhập: Bộ luật Lao động 2019 về nghỉ lễ, tết và thông báo hằng năm của cơ quan quản lý lao động; chưa xác minh trong phiên này.

## 10. Frontend

### 10.1. Lựa chọn [C: React + Mantine; P: phần còn lại]

Vite, React Router Data Mode (`createBrowserRouter`), TanStack Query, Mantine Form + Zod, `@mantine/dates` + Day.js, Vitest + Testing Library, Playwright. Versions pin exact và kiểm peer ở T1. Cùng origin với API; mọi route API dưới `/api`, callback OIDC redirect 303 cố định, link kích hoạt dùng `#token`, trang đăng nhập chỉ có Google ([ADR 0019](../../decisions/0019-web-same-origin-and-oidc-browser-flow.md)). Dev proxy `/api` qua Vite; production phục vụ static cùng origin (D13 hosting).

### 10.2. Bootstrap phiên [P]

`GET /api/hr/me` (authenticated): `{ userId, employee: { id, code, fullName } | null, menus: ('requests' | 'approvals' | 'employees' | 'teams' | 'calendar' | 'leave' | 'attendance' | 'reports')[], companyScope: boolean }`. `menus` tính trên server từ permission catalog/grants + assignment hiện hành; chỉ phục vụ hiển thị, mỗi thao tác vẫn kiểm quyền riêng. Không trả role keys, revision, PII F2.

Triển khai T3 (2026-10-18) [C]: chỉ trả menu của trang đã có — `employees` khi người gọi thấy hồ sơ khác ngoài của mình hoặc có `companyScope`; `teams` khi thấy ít nhất một team hoặc có `companyScope`. `companyScope` = plan `hrCompany.read` chạm tới anchor công ty (thực tế: HR/Admin và Root), là gợi ý hiển thị nút quản trị HR; không suy được role. Tính bằng query có scope vì plan không grant vẫn là `allow` với predicate false (ADR 0016, triển khai T3).

### 10.3. Sở hữu state

| State                                  | Owner                                                   | Quy tắc                                                                           |
| -------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Route, filter/sort/page không nhạy cảm | URL (React Router)                                      | Không đưa CCCD/MST/lý do vào URL                                                  |
| Dữ liệu server (DTO)                   | TanStack Query, key `[sessionNs, feature, …params]`     | In-memory; không persist; `sessionNs` đổi khi login/logout                        |
| Bản nháp form                          | Mantine Form (uncontrolled)                             | Không bị refetch ghi đè; clear khi logout                                         |
| Modal/tab                              | Local state component                                   |                                                                                   |
| Phiên                                  | `SessionProvider` từ `/api/auth/session` + `/api/hr/me` | 401 → hủy queries, clear cache + drafts, về login                                 |
| CSRF token                             | HTTP client in-memory từ `/api/auth/csrf`               | Không localStorage                                                                |
| Idempotency key                        | Mutation instance                                       | Sinh một lần mỗi lần người dùng bấm gửi; retry sau timeout dùng lại key + payload |

Mutation submit/decide/adjust không retry tự động, không optimistic update. Outcome không rõ (timeout/mạng) → gửi lại cùng key, hiển thị kết quả server. Thành công → invalidate request/inbox/leave/attendance của `sessionNs`.

### 10.4. Routes dự kiến

`/login`, `/requests`, `/requests/new`, `/requests/:id`, `/approvals`, `/leave`, `/attendance`, `/employees`, `/employees/:id`, `/teams`, `/calendar`, `/reports` (T9). Lazy load theo feature.

## 11. Budgets [P]

| Mục                     | Giới hạn                                                        |
| ----------------------- | --------------------------------------------------------------- |
| Page size / offset      | Giữ gateway: mặc định 20, max 100, offset ≤ 10000               |
| Một đơn: số ngày        | ≤ 31 ngày làm việc, qua tháng được, không qua năm [C D06]       |
| Lý do/ghi chú           | 1..1000 ký tự Unicode, không control chars                      |
| Body JSON               | ≤ 16 KiB cho HR routes                                          |
| Idempotency key         | UUID v4                                                         |
| Report range (T9)       | ≤ 366 ngày; rows/file bytes chốt ở T9                           |
| Transaction             | Giữ runner 2000 ms / lock 1000 ms / retry 2                     |
| Workload đo (chưa chạy) | 50 nhân viên, 24 tháng, 24000 đơn synthetic, 10 phiên đồng thời |

## 12. Quyết định G0

### 12.0. Đã chốt với người dùng — 2026-10-17

| ID  | Quyết định                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D10 | Đăng nhập OIDC với Google Workspace của công ty. Tài khoản cấp bằng cách mời từng người: CLI phát activation token, lần đăng nhập Google đầu tiên kích hoạt/liên kết (flow có sẵn của base). Không tự tạo tài khoản theo domain email. Session theo base, không thêm idle timeout.                                                                                                                                  |
| D01 | Nhân viên có thể thuộc nhiều team, có team chính mặc định; khi gửi đơn chọn team. Mỗi team một lead; một người có thể lead nhiều team. Người gửi là lead của team đã chọn → bỏ bước lead. COO gửi đơn → tự duyệt khi gửi (vẫn kiểm WFH/phép/công). Lead kiêm COO duyệt hai bước bằng hai thao tác. Team thiếu lead: vẫn gửi được, đơn chờ, HR thấy cảnh báo. Không ủy quyền tạm. CEO không là người duyệt thay thế. |
| D02 | Người duyệt bước 1 là lead hiện hành tại lúc quyết định (§6.4); lead cũ mất quyền ngay; người đã quyết định giữ quyền đọc đơn đã quyết.                                                                                                                                                                                                                                                                             |
| D08 | Nhân viên xem F1/F2/F3/F6 của mình, không tự sửa. Lead xem F1, đơn + lý do, số dư phép của thành viên; không F2/F3, không bảng công của người khác. COO xem F1 toàn công ty, đơn trong hàng đợi/đã quyết, xem và xuất báo cáo không có CCCD/MST. HR toàn công ty. Lý do từ chối bắt buộc.                                                                                                                           |

Hệ quả cần nắm:

- D10: T1 cần Google OAuth client (client ID/secret, redirect URI) do công ty cấp qua `OIDC_PROVIDERS_JSON` trong `apps/api/.env.api`; không đưa vào repo. Chưa có client thì T1 kiểm browser flow bằng IdP giả lập cục bộ và ghi rõ chưa kiểm Google thật. Login mật khẩu local của base vẫn tồn tại cho Root/vận hành; tắt nó cho IAM là quyết định riêng nếu cần.
- D01: đơn của COO là đường final approval nên chỉ mở ở M3 cùng effect handlers; tới lúc đó COO gửi đơn nhận `final_approval_unavailable`.
- Giả định còn mở nhỏ: mọi người giữ role `hr.coo` đều duyệt cuối được (nếu chỉ một COO, HR chỉ gán một người). Cần xác nhận nếu công ty có hơn một COO.
- Báo cáo sinh nhật cho COO có hiện năm sinh không: chốt ở T9.

### 12.3. Đã chốt với người dùng — 2026-10-17 (lượt 2)

| ID  | Quyết định                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D03 | Tích lũy theo tháng, tháng tính nếu chính thức vào ngày 15; không chuyển năm; không cộng thâm niên; không nghỉ trước phép chưa tích lũy (§9).                                                                                                                                                                                                                           |
| D04 | 1 ngày làm việc WFH = 1 lần, không có WFH nửa ngày. Vượt 4 lần/tháng: cảnh báo lúc gửi và lúc duyệt, vẫn cho duyệt; người duyệt cuối phải xác nhận đã thấy cảnh báo.                                                                                                                                                                                                    |
| D05 | Đi muộn/về sớm đã duyệt chỉ ghi nhận cho báo cáo, không trừ công, không quota; giờ dự kiến trong ca, tối đa một đơn mỗi loại mỗi ngày.                                                                                                                                                                                                                                  |
| D06 | Hồi tố tối đa 7 ngày lịch, tương lai tối đa 90 ngày lịch (theo ngày nghiệp vụ `Asia/Ho_Chi_Minh`); đơn nhiều ngày qua tháng được, không qua năm. Cấm trùng giờ với đơn đang chờ/đã duyệt, trừ đi muộn/về sớm cùng ngày WFH. Không sửa đơn; người gửi hủy đơn đang chờ; HR hủy đơn đã duyệt có lý do, hoàn phép/công tự động, không duyệt lại, không hủy khi kỳ đã chốt. |
| D07 | HR chốt công theo tháng; kỳ đã chốt không bị đơn/lịch/điều chỉnh thay đổi; HR mở lại có lý do + audit.                                                                                                                                                                                                                                                                  |
| D09 | Hiển thị tách được cấp/đã dùng tới ngày báo cáo/đã duyệt tương lai/đang chờ/khả dụng; khả dụng trừ cả đơn đang chờ, không âm.                                                                                                                                                                                                                                           |

Diễn giải còn là [P] (sửa được khi review): "7 ngày" là ngày lịch tính từ ngày nghiệp vụ hôm nay; mốc biên giờ đi muộn/về sớm §9; công thức `floor` tích lũy; `acknowledgeWfhLimit` là field boolean trong `ApprovalInput`/`SubmitRequestInput` khi vượt.

- **D11–D14**: theo kế hoạch, chặn T10–T12, không cần cho M0–M3.

### 12.4. Quyết định kỹ thuật — người dùng duyệt theo khuyến nghị 2026-10-17

| ID  | Nội dung                                                                                       | Đã duyệt                                         |
| --- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| TD1 | Cấp `object_ref` cho create trong mode `write`                                                 | Hàm SECURITY DEFINER giới hạn type HR (ADR 0016) |
| TD2 | Facts HR (team, lead, account link) ghi qua `admin`/login `authority` với grant mới            | Đồng ý (ADR 0016)                                |
| TD3 | Field ACL bằng resource riêng cho F2/F3                                                        | Đồng ý (ADR 0016)                                |
| TD4 | Lock order + idempotency §7                                                                    | Đồng ý (ADR 0017)                                |
| TD5 | `fresh@1` cho IAM ở facts change, sửa F2, adjust phép/công, sửa lịch; không cho decide         | Đồng ý                                           |
| TD6 | `boundary: 'required'` cho `team.assign`, `employee.link-account`; `optional` cho phần còn lại | Đồng ý                                           |
| TD7 | Thời gian: `date` + phút nguyên + `Asia/Ho_Chi_Minh` tường minh                                | Đồng ý (ADR 0018)                                |
| TD8 | Frontend stack §10.1 và state ownership §10.3                                                  | Đồng ý                                           |
| TD9 | Mã hóa F2 ở mức ứng dụng                                                                       | Hoãn tới D13; M1 dùng ACL + không log/audit F2   |

## 13. Tiêu chí kiểm chứng theo mốc

| Mốc | Phải có bằng chứng chạy                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Baseline frozen install/build/typecheck/lint/unit; Docker integration + E2E hoặc blocker ghi riêng; browser login/logout/expiry/CSRF với API thật; account A → B không thấy cache A                   |
| M1  | Ma trận §5.2 dạng table-driven trên PostgreSQL (list/detail/count cùng scope); F2 không lọt qua `employee`; revoke lead/team có hiệu lực ở transaction kế tiếp; ACL/probes khớp; audit rollback       |
| M2  | Toàn bộ state × event; slot/probation/lịch; replay/khác payload; hai lead approve đồng thời → một decision; final approve bị từ chối `final_approval_unavailable` không để lại state/audit thành công |
| M3  | Final approve + ledger + công + WFH count + audit atomic; lỗi audit/effect rollback cả decision; tranh số dư cuối/WFH lần 4–5; overlap không tính trùng; recompute xác định                           |

Ví dụ cụ thể: [hrm-acceptance.md](../../hrm-acceptance.md).
