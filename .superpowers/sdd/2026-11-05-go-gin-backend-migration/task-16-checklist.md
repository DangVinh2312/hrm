# Checklist bắt buộc cho 16b/16c (từ review độc lập 16a, 2026-11-10)

Primitive `authority.Administer` chỉ tương đương `access(..., 'admin', work, rootEvent)` của TS. Go không port `AdminAccountCommand`, nên caller phải dựng lại toàn bộ frame dưới đây.

## 16c (`administration`)

- [ ] Đầu mỗi lệnh `account.*` trên đích: kiểm target là UUID chuẩn chữ thường (tương đương `isCanonicalUuid`), không đạt thì 403. Dùng đúng chuỗi đó cho `Detail`, self-check, `WithinActor`, SQL.
- [ ] Precheck `ReachesTarget` (fence chia sẻ) trước `Administer`. `false` thì 404, không lấy fence độc quyền. Lệnh tạo (provision) dùng `AllowsAll`.
- [ ] Trong `run`, theo thứ tự: `Detail(target)` nil thì `false`/404 (gồm cả vắng và đích Root). Chỉ sau đó mới so `c.Actor.ID == target` thì 403.
- [ ] `assignRole`/`revokeRole`: khóa dòng `app_user` của đích trước khi đọc facts, rồi `WithinActor`. Với assign của IAM, rule của role không bị cắt và `CompareGrantSets(role, actorGrants) == Within`. Root bỏ hai phép so.
- [ ] Suspend, reactivate, bind/unbind boundary, các lệnh identity: `WithinActor` phải đứng trước mọi đọc hay ghi để lộ state (reactivate: trước khi kiểm `suspended`, SQLSTATE 55000 thì 409).
- [ ] IAM ghi event nghiệp vụ trong `run`. `rootEvent` không bao giờ nil, outcome `ok`/`absent` đúng `done`; chỉ trả `&audit.Event{}` khi `run` đã ghi event có cờ Root.
- [ ] Tăng `auth_epoch` (suspend, `account.changeEmail`, `account.resetMfa`, `account.resetGoogleBinding`). Không trả secret hay mã khôi phục. Dùng hàm `SECURITY DEFINER` hẹp `kind='iam'`. `boundary: 'required'` + `fresh@1` lấy từ declarations.
- [ ] `Reaches(..., fulfil)`: kiểm cả bool lẫn `err`.
- [ ] Không dùng `Execute` cho resource `account`.
- [ ] Ruling 103: mỗi ý trên có ít nhất một ca từ chối chạy thật (tự tác động 403, đích lớn hơn 404, target chữ hoa bị từ chối, không fresh, `auth_epoch` tăng).

## 16b (`role`)

- [ ] `CheckRoleGrants` trước khi lưu và trước `GrantsDigest`. Nhãn đi qua `httpapi.InputText(label, 120)`. Tạo role dùng `IsRuntimeRoleKey`, tham chiếu role dùng `IsRoleKeyReference`. Giới hạn `MaxRuntimeRoles`, `keys.MaxRoleGrants`.
- [ ] Từ chối sửa/xóa role `managed_by='code'`. `expectedDigest` so với `GrantsDigest` của trạng thái DB đọc dưới fence.
- [ ] IAM: `CompareGrantSets(GrantsAsFacts(new), actorGrants) == Within`, đọc bị cắt thì từ chối. Root bỏ qua phép so.
- [ ] Mỗi bất biến (code-owned, tập con, cặp chưa đăng ký, digest lệch) có một ca từ chối chạy thật.

## Minor 16a chuyển sang 16c / nợ

- `Administer` không bắt IAM `run` ghi audit nghiệp vụ (Execute có cờ `audited`); `rootEvent` trả `&audit.Event{}` mà `run` không ghi thì mất audit Root không ai phát hiện. 16c cân nhắc thêm cờ đã ghi giống `Execute`.
- Chưa có ca deny thắng allow qua `Administer` (nợ).
