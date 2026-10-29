# ADR 0040 — Trưởng nhóm phải là thành viên đang mở của team

Ngày: 2026-10-23. **Trạng thái: Accepted** (người dùng chốt phương án (b)+(c)). Bổ sung [ADR 0018](0018-hrm-data-model-and-time.md) (membership/lead là lịch sử) và [ADR 0016](0016-hrm-authorization-and-pii.md) (`team.assign`, mode admin). Không đổi action, permission, binding hay release; không migration; không đổi OpenAPI.

## Bối cảnh

Người dùng thấy "vừa là thành viên vừa là trưởng nhóm" như một lỗi. Nhưng spec §6.4(2) và acceptance C-07/C-23/C-29 dùng chính việc lead là thành viên của team mình: đơn của lead chọn team mình lead bỏ bước lead (`lead_skipped_submitter_is_lead`), và submit chỉ chọn được team mà người gửi là thành viên. Vì vậy **không cấm trùng**; ngược lại, trước đây lead không bắt buộc là thành viên nên một lead "treo" (không phải thành viên) không gửi được đơn cho team mình và không được nhìn nhận là thành viên trong danh sách.

## Quyết định

1. **Bất biến lead ⊆ member.** Lead hiện hành của một team phải là thành viên đang mở (`team_membership.ends_at IS NULL`) của đúng team đó. Là ứng dụng kiểm, không constraint/trigger DB.
2. **`assignLead`** (`team.assign`, mode admin): với `employeeId` khác `null`, sau guard `assignable` (tồn tại, còn làm việc, không phải chính mình) kiểm người đó có membership đang mở ở team này; không có thì `ProductCommandRejected('lead_not_member')` (409 `error.conflict`), không ghi gì, lead hiện tại giữ nguyên. `employeeId = null` (gỡ lead) không kiểm.
3. **`endMembership`**: nếu người bị kết thúc membership là lead hiện hành của team đó thì `ProductCommandRejected('member_is_lead')` (409). Người dùng chọn **chặn** chứ không tự gỡ lead: phải gán lead khác (người mới phải là thành viên) hoặc gỡ lead bằng `assignLead(null)` trước (lệnh này đã có, không thêm action). Thứ tự kiểm thực tế trong code: `not_member`, rồi `primary_required`, rồi `member_is_lead` (cả ba cùng 409 `error.conflict`, client không phân biệt).
4. **Đường khác.** `addMember` cho người đang là lead: bình thường (trùng là hợp lệ). `setPrimaryTeam`/`demotePrimary` kết thúc rồi thêm lại hàng membership trong cùng transaction nên membership vẫn mở: bất biến giữ. `terminateEmployee` **không** kết thúc membership hay lead (đã kiểm source: chỉ cập nhật period và `terminated_on`), nên lead nghỉ việc vẫn là thành viên và vẫn là lead; muốn rời phải gỡ/đổi lead rồi `endMembership` như thường. Không còn lệnh nào khác ghi `team_membership.ends_at` hay `team_lead_assignment`.
5. **Lỗi.** Dùng `ProductCommandRejected` có sẵn → 409 `{ statusCode, code: 'error.conflict' }`; lý do (`lead_not_member`, `member_is_lead`) chỉ nội bộ. Không thêm `API_ERROR_CODES`, key `error.*` hay status OpenAPI. Chỉ trả sau khi caller đã được authorize `team.assign` trên team đích, nên không lộ tồn tại/quyền ngoài phạm vi.
6. **Thứ tự khóa.** Không đổi: mọi lệnh team là mode admin ⇒ exclusive application fence (spec §8) rồi mới đọc membership/lead; kiểm lead-member và đổi membership cùng transaction dưới fence nên hai lệnh đồng thời (gán lead / kết thúc membership) tuần tự hóa, không thể vượt bất biến.
7. **Web.** Danh sách thành viên đánh nhãn "Trưởng nhóm" cho lead hiện hành (`team.member.lead`); nút xóa khỏi team của lead bị tắt kèm gợi ý (`team.member.removeLeadHint`); ô chọn lead chỉ liệt kê thành viên đang mở của team trừ lead hiện hành (`team.lead.memberHint`). Key riêng của trang `team.*`, không key lỗi mới. API vẫn là bên quyết định.

## Dữ liệu cũ

Không migration dọn dữ liệu. Lead hiện tại không phải thành viên có thể tồn tại (trước đây không ép). Truy vấn đọc cho người vận hành (không chạy trên dữ liệu thật trong thay đổi này; test dùng DB tạm):

```sql
SELECT l.team_id::text AS team, t.name, l.lead_employee_id::text AS employee, e.code
       FROM team_lead_assignment l
       JOIN team t ON t.id = l.team_id
       JOIN employee e ON e.id = l.lead_employee_id
      WHERE l.ends_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM team_membership m
                         WHERE m.team_id = l.team_id AND m.employee_id = l.lead_employee_id
                           AND m.ends_at IS NULL)
      ORDER BY t.name, l.team_id;
```

Xử lý tay (chọn một): thêm người đó làm thành viên của team (`POST /api/hr/teams/:id/members`, giữ nguyên lead), hoặc gán lead khác là thành viên (`PUT /api/hr/teams/:id/lead`) / gỡ lead (`employeeId: null`). Chừng nào chưa xử lý, lead treo vẫn thi hành quyền lead như trước nhưng không thể bị `endMembership` (không có membership) và `assignLead` sang người khác vẫn hoạt động.

## Hệ quả

- Không đổi: release 16 `c78446ef…`, bindings `51329119…`, canonical `99ec7bde…`, hash OpenAPI `475396922ef35a1bab68a27cc23691770fb9c7183179b56798a489c521d8d6c9`.
- Fixture test phải thêm thành viên trước khi gán lead (`hrm-team`, `hrm-approval`): kỳ vọng không đổi, trừ số thành viên cuối ca đồng thời của `hrm-team` (lead L, L2 giờ là thành viên).
- Test: `hrm-team.integration-spec.ts` (ca lead không phải thành viên, lead không rời được, nghỉ việc, truy vấn dữ liệu cũ), web `employee-team-pages.spec.tsx`. Acceptance: G-16..G-18, H-11.
