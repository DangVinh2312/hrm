<!-- Bản nháp: chèn vào apps/api-go/AGENTS.md sau khi 17d commit (người dùng: "áp dụng tất cả các rules", 2026-11-11).
     Vị trí: ba mục dưới đây đặt ngay trước "## Lệnh"; các dòng "Bổ sung Ánh xạ quy ước" thành bullet ngay sau bảng của mục đó;
     dòng migration thêm vào mục "## `database`". Nguồn tham khảo: offspring/hro/swager-api (đã lọc phần trái bất biến HRM). -->

## Checklist mỗi thay đổi

Trước khi coi một thay đổi là xong, soát từng dòng, không chỉ build/lint:

- **Bảo mật**: route chạm tới có đúng lớp (`authorize`/`authenticated`/public) và đi qua `authority`; input ngoài biên được validate (`DecodeCommand`, `InputPageQuery`, `InputText`); projection chỉ trả field được phép; không secret/PII trong log, lỗi, audit. Bất biến ở root `AGENTS.md` áp dụng nguyên văn.
- **Đua**: mọi ghi qua `database.Run` + fence + `authority.Execute`; facts được recheck trong transaction; audit cùng transaction. Không tự thêm khóa hàng ngoài thứ tự đã ghi của module, không bỏ fence để "nhẹ hơn".
- **Deadlock**: khóa theo cùng thứ tự ở mọi nơi gọi (fence → target → hàng phụ); để runner xử lý retry/`ConflictError` (409), không tự bắt SQLSTATE khóa trong module.
- **Hiệu năng**: mục "Hiệu năng" dưới đây.
- **Contract**: route mới/đổi cập nhật `contract/*.json` (route, OpenAPI có example thật, mã lỗi) cùng thay đổi.

## Hiệu năng

Áp cho mọi query và vòng lặp trên đường request. Dựa vào ngoại lệ nào thì ghi lý do bằng comment.

Query:

- **Không N+1.** Lấy quan hệ trong cùng câu (join, subquery JSON) hoặc một câu `= ANY($1)` cho cả trang; không một query mỗi dòng.
- **Aggregate trong SQL** (`count`, `sum`, `GROUP BY`); kiểm tồn tại bằng `EXISTS`. Không tải dòng về để đếm hay cộng.
- **`WHERE`/`JOIN` dùng được index.** Không bọc hàm quanh cột có index (`date(created_at) = $1` → khoảng `>= $1 AND < $2`). Filter hoặc sort mặc định mới có index trong cùng migration; khi hiệu năng là mục tiêu, xem `EXPLAIN` trên dữ liệu disposable đủ đại diện.
- **Đọc có trần.** Danh sách qua `httpapi.InputPageQuery` (limit có max); `OFFSET` sâu trên bảng lớn chuyển sang keyset; export đọc theo trang hoặc stream. Ngoại lệ: bảng tham chiếu nhỏ.
- `pgx.CollectRows` giữ cả kết quả trong memory: chỉ dùng khi query đã có `LIMIT` hoặc tập kết quả bị chặn bởi thiết kế.

Ghi:

- **Gộp lô, không `Exec` trong vòng lặp**: `INSERT … SELECT FROM unnest($1::…[])`, `UPDATE … WHERE id = ANY($1)`, hoặc `pgx.Batch`.
- **Chia lô danh sách không giới hạn** (mẫu: `purge-sessions` 500 dòng mỗi lô, số lô có trần).
- **Không I/O ngoài trong transaction**: network, delivery, hash mật khẩu chạy trước hoặc sau `database.Run`, rồi recheck facts/version trong transaction.

Đồng thời:

- **Một `Tx` là một connection: không dùng `tx` từ hai goroutine.** Trong callback của `database.Run` mọi câu lệnh chạy tuần tự.
- Việc độc lập ngoài transaction có thể chạy song song, nhưng số goroutine phải có trần cố định (không `go` theo độ dài input) và mỗi goroutine có owner chờ nó kết thúc, nhận lỗi và hủy được qua context.
- Không thêm pool, cache quyền, worker nền để tối ưu khi chưa có số đo và thiết kế invalidation (root `AGENTS.md`).

Trong process (chỉ với slice lớn theo bảng, không phải slice đã bị DTO chặn):

- Tra cứu trong vòng lặp dùng `map` dựng một lần; `slices.Contains`/`slices.Index` trong vòng lặp là O(n²).
- Đưa việc bất biến (regex compile, parse ngày, tập giá trị cho phép) ra ngoài vòng lặp; cấp phát slice với capacity đã biết.

## Code dễ đọc

Viết để đọc từ trên xuống mà không phải bóc biểu thức. Ngắn hơn không tốt hơn nếu phải đọc hai lần.

- **Mỗi câu lệnh một bước.** Kết quả trung gian có tên riêng rồi mới dùng; không lồng lời gọi có I/O hoặc trả lỗi vào đối số của lời gọi khác.
- **Đặt tên kết quả trước khi kiểm**: `sent, err := mailer.Send(…)`, rồi `if err != nil`, rồi `if !sent`.
- **Return sớm** cho ca kết thúc hàm; không `else` sau `return`, đường chính không lồng trong nhánh.
- **Dòng trống giữa các bước** khi hàm làm nhiều việc theo thứ tự (đọc, đổi, ghi, audit).
- Lỗi bọc bằng `%w` kèm ngữ cảnh ngắn không chứa giá trị input; phân loại bằng `errors.As`/`errors.Is`, không so chuỗi.
- Comment theo root `AGENTS.md`: mặc định không viết; chỉ ghi lý do, invariant hoặc bẫy mà code không tự nói được.

```go
// sai
if _, err := tx.Exec(sql, mustID(parse(c.Param("id"))), now(tx)); err != nil { … }

// đúng
id, err := parseID(c.Param("id"))
if err != nil {
	return err
}

at, err := clockOf(tx)
if err != nil {
	return err
}

if _, err := tx.Exec(sql, id, at); err != nil {
	return fmt.Errorf("close period: %w", err)
}
```

<!-- Bổ sung "Ánh xạ quy ước" (bullet sau bảng) -->

- `tx *database.Tx` là tham số đầu của mọi hàm chạy trong transaction của caller; hàm đọc ngoài transaction không nhận `tx`.
- Field dependency của struct giữ hậu tố vai trò (`leaveRepo`, `mailService`, `runner`), không dùng tên trần của chủ thể.
- Kiểu đặt theo phạm vi dùng: chỉ một file dùng thì khai không export ngay trong file đó; nhiều file trong package thì `<tên>_types.go`; chỉ đưa lên package chung khi từ hai module cần và `contract/package-dag.md` có cạnh.
- Cột `jsonb` đọc vào struct có tag (hoặc `jsontext.Value` khi phải giữ nguyên byte), không `map[string]any`.
- Mỗi đối tượng xem một struct projection riêng (vd. bản tự xem có PII và bản cho người khác): không dùng chung một struct rồi bỏ field bằng `omitempty` hay gán rỗng.
- Lệnh dùng một lần (backfill, đối soát dữ liệu) không thêm vào `hrmctl`; `hrmctl` chỉ giữ lệnh vận hành lặp lại được.

<!-- Thêm vào mục "## `database`" -->

- Migration chỉ đổi schema, ACL, hàm, trigger; không backfill hay sửa dữ liệu hàng loạt trong migration (backfill là bước vận hành riêng, chạy sau migration). Từ release đầu trở đi không sửa migration đã áp ở bất kỳ môi trường nào: mọi thay đổi là migration mới.
