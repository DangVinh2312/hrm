# ADR-22 — Go là nguồn duy nhất của backend; bỏ parity từng byte với NestJS

Trạng thái: **Accepted** (2026-11-06), quyết định của người dùng. Thay một phần [ADR-20](ADR-20-go-gin-backend-migration.md): mục 3 (nguồn sự thật), mục 4 lớp 1 và lớp 3, đoạn "Khi hai runtime khác nhau", mục 1 phần inventory "xuất từ `expectedRoutes`" (inventory giờ là `contract/routes.json` sửa tay), mục 6 bước 1, 2, 4, 5 (exporter migration, so với TypeScript), các dòng `jscompat` và số đo Express của mục 7, hai dòng `contract/` ("output exporter, parity-exceptions.md") và `jscompat/` trong sơ đồ thư mục của mục 8, Q7, Q12. Giữ nguyên: mục 1 (Go đứng trước, proxy route chưa chuyển), mục 2 (thứ tự), lớp 2 (test trên PostgreSQL thật), mục 5 (bất biến bảo mật), pgx và goose.

Sửa 2026-11-06: §7 đổi `httpapi.DecodeJSON` thành `httpapi.DecodeCommand`, gộp CSRF rồi decode, phần decode không export (Task 4 vòng sửa 3); siết chặt hơn, không đổi semantics khác.

## Quyết định của người dùng (2026-11-06)

> "cho phép sửa, chưa release, tôi chỉ quan tâm build phiên bản này thành Go hoàn toàn, có thể rebuild lại database local thoải mái, không quan tâm nestjs, mục tiêu là thay thế backend hoàn toàn bằng Go, cho phép tìm kiếm và sử dụng các thư viện Go hữu ích và cần thiết, không dùng []any, map[string]any, viết các struct tương úng"

## Quan sát

- Chưa có release và production (ADR-20 quan sát 7, Q6); database dev dựng lại được.
- Trước ADR này, Go mô phỏng hành vi Node: `internal/jscompat` (giá trị JS, `JSON.stringify`, `canonicalJson`, độ dài và thứ tự UTF-16, bảng chữ hoa thường sinh từ Node), `httpapi.parseBody` theo body-parser, `FramingListener` theo framing của Node, chuẩn hóa path như Express, đọc header theo latin1. Tất cả được kiểm bằng vector do TypeScript sinh (`contract/vectors`, `internal/httpapi/testdata`).
- Phần lớn mô phỏng đó chỉ phục vụ so byte với NestJS, không phải bất biến bảo mật hay contract mà web dùng.

## Quyết định

1. **Go là nguồn duy nhất.** NestJS đóng băng: không thêm tính năng; chỉ sửa khi stack trộn không chạy được. Nó chỉ còn là upstream của proxy tới cutover (C2).
2. **Giữ contract với web và bất biến**, không giữ hành vi biên của Node/Express. Giữ: route dưới `/api`, shape lỗi `{ statusCode, code }` và tập `API_ERROR_CODES` (ADR-11), cookie/session/CSRF/Origin, schema PostgreSQL và login theo mục đích (ADR-04), toàn bộ ADR-02 đến ADR-19 và ADR-21.
3. **Contract do Go sở hữu, sửa tay.** `apps/api-go/contract/{routes,openapi,api-errors,privileges}.json`, `route-ownership.md`, `test-port-tracker.md`, `internal/database/privilege_declarations.go` không còn sinh từ TypeScript. Bỏ exporter (`apps/api/tools/export-go-contract.ts`, `apps/api/tools/go-contract/`), test `apps/api/test/go-contract.spec.ts`, script `contract:export`, `contract/vectors/`, `contract/parity-exceptions.md`. `release.json`, `bindings.json` giữ làm dữ liệu tham chiếu cho declarations Go ở F5, xóa khi declarations Go có test riêng.
4. **Migration.** File goose trong `internal/database/migrations` là nguồn. Trước release đầu tiên được sửa file đã có và dựng lại database local, thay cho luật "không sửa migration đã áp dụng" của ADR-14 tới release đầu. Sửa ACL, hàm hay trigger thì sửa `privilege_declarations.go` cùng thay đổi.
5. **Hash và giá trị lưu** tính bằng struct có kiểu và `encoding/json`, không mô phỏng `JSON.stringify`/`canonicalJson`. Không dùng `any`, `[]any`, `map[string]any` cho dữ liệu nghiệp vụ.
6. **Text.** Email đăng nhập chỉ ASCII (ADR-21 §1), nên chữ hoa thường dùng `strings.ToLower`/`ToUpper`, không cần bảng Unicode của Node. Giới hạn độ dài đếm rune (`utf8.RuneCountInString`), khớp `char_length` của PostgreSQL; con số giới hạn giữ như OpenAPI. Thứ tự: byte (bằng thứ tự code point), hoặc `x/text/collate` ở nơi người dùng thấy thứ tự chữ có dấu.
7. **HTTP theo `net/http` và Gin**:
   - Body: `httpapi.DecodeCommand[T]` đọc trong handler, sau guard, gộp CSRF rồi decode; phần decode không export, để không route ghi nào decode mà quên CSRF. Chỉ `application/json` (charset nếu có phải `utf-8`), tối đa 100 KiB, phải là object. `encoding/json/v2` với `RejectUnknownMembers` từ chối member lạ, member lặp, UTF-8 sai, surrogate đơn lẻ (ADR-21 §2, §3). Mọi lỗi là 400 `error.invalidRequest`; trước đây quá giới hạn và charset lạ là 503 như NestJS.
   - Path: chữ hoa và `/` cuối không còn được chuẩn hóa, trả 404. `+` trong path vẫn được escape trước Gin.
   - Header: `Origin`, `X-Csrf-Token` lặp thì từ chối; cookie của app lặp thì 400; không còn đọc latin1 hay so độ dài UTF-16.
   - Framing: bỏ `FramingListener`. Escape sai ở request line nhận 400 dạng text của `net/http` trước app; `Content-Length` lặp cùng giá trị được gộp; có cả `Transfer-Encoding` và `Content-Length` thì xử lý chunked mà không đóng connection.
   - Giữ giới hạn server: `MaxHeaderBytes` 16384, `ReadHeaderTimeout` 60 s, `ReadTimeout` 300 s, `IdleTimeout` 5 s.
8. **Test.** Test Go kiểm hành vi theo ADR, không so với NestJS. Lớp 2 là bộ test chính. Bỏ lớp 1 (vector) và lớp 3 (HTTP so hai runtime). Test integration `internal/offline` không còn so database với CLI TypeScript: kiểm goose áp đủ migration, probe privilege pass, chạy lại không đổi catalog. `shortcut: test.NewDatabase vẫn dựng template bằng CLI TypeScript (sync manifest, fixture), thay khi Go có manifest sync ở F5.`
9. **Tiêu chí chuyển một nhóm route** (thay mục 10 của ADR-20): test Go của nhóm pass với `-race`; `go vet`, lint, test import sạch; Playwright của màn hình liên quan pass trên stack trộn; review độc lập; checkbox kế hoạch có tham chiếu test.

## Hệ quả và rủi ro

### Chủ sở hữu manifest trên stack trộn (2026-11-08)

Người dùng chọn **chỉ Go sync manifest**. NestJS upstream không reconcile release lúc boot; nó vẫn kiểm readiness và các bất biến schema, privilege, capabilities trước khi phục vụ. Không để hai runtime cùng sync hoặc tăng sequence chỉ để né khác biệt hash. Go phải hoàn tất reconcile trước khi nhận traffic; NestJS phải từ chối boot nếu trạng thái manifest chưa sẵn sàng. CLI TypeScript dùng cho fixture lịch sử không phải runtime sync thứ hai.

Thay đổi này cần sửa tối thiểu boot NestJS để stack trộn chạy được theo mục 1. Release, declaration hash và materialized hash do Go sở hữu; kiểm tra readiness của NestJS phải dùng trạng thái đã được Go xác minh, không đòi hash TypeScript bằng hash Go. Chi tiết triển khai và test từ chối trạng thái chưa sẵn sàng thuộc F5.

Contract tạm `apps/api-go/contract/manifest-readiness.json` chứa sequence và manifest hash Go kỳ vọng, được test Go đối chiếu với release đã chuẩn bị. NestJS đọc contract này, kiểm đúng sequence/hash và kiểm lại materialized hash trong cùng transaction giữ fence, không chạy reconcile. Materialized hash giữ dạng canonical JSON của catalog để NestJS kiểm drift; F5 phải có test đọc chéo hai runtime, gồm giá trị số. Contract tạm được đóng gói cùng workspace và bỏ khi xóa upstream ở cutover; thiếu hoặc sai contract phải làm boot thất bại.

- Mất bằng chứng tự động rằng Go tương đương NestJS. Độ đúng dựa trên test hành vi Go, Playwright và review.
- **Dữ liệu đọc chéo runtime trên stack trộn.** Hai runtime dùng chung database tới C2. Giá trị một bên ghi mà bên kia đọc (digest phiên, khóa và AAD của MFA, khóa advisory và `bucket_key` của limiter, `payloadHash`, `canonicalSnapshot`, hash release) không còn có vector bảo đảm. Khi Go bắt đầu ghi một giá trị như vậy, nhóm đó phải có test trên stack trộn. Nếu lệch: chuyển cùng lúc route đọc giá trị đó, hoặc dựng lại database; không thêm lại lớp mô phỏng.
- **Quay lui** (ADR-20 mục 11) chỉ còn chắc chắn bằng cách dựng lại database, vì dữ liệu Go ghi không còn được kiểm là NestJS đọc được.
- **Đổi schema trước C2:** NestJS vẫn boot trên cùng database và probe của nó so ACL và thân hàm với hằng TypeScript, nên đổi schema làm NestJS không ready. Hoặc sửa tối thiểu hằng TypeScript, hoặc đổi sau khi route liên quan đã chuyển.
- **Framing.** `net/http` nhận request có cả `Transfer-Encoding` và `Content-Length` mà không đóng connection. Sau một reverse proxy hiểu framing khác, đây là đường request smuggling. Reverse proxy chọn khi deploy phải từ chối hoặc chuẩn hóa request như vậy; ghi vào `docs/operations.md` khi chốt hosting.
- Route còn proxy giữ hành vi biên của NestJS (503 cho body quá lớn, path không phân biệt hoa thường). Web không được dựa vào các hành vi đó.

## Triển khai

- [x] Bỏ `internal/jscompat`, `contract/vectors`, `httpapi` `parseBody`/`strict_json`/`FramingListener`/`testdata`, chuẩn hóa path; thêm `httpapi.DecodeJSON` (đổi thành `DecodeCommand` ở Task 4 vòng sửa 3); `config` dùng `strconv`/`strings`; `internal/offline` chỉ kiểm Go; bỏ exporter và `contract:export` (2026-11-06). `go vet ./...`, `go vet -tags integration ./...`, `go build ./...`, `go test -race ./...`, `golangci-lint run` pass; test integration chưa chạy.
- [x] F5: triển khai quyết định 2026-11-08: chỉ Go sync manifest, NestJS upstream kiểm readiness; test stack trộn không reconcile hoặc ghi đè release Go.
- [ ] Viết lại các task của kế hoạch còn nhắc vector, parity lớp 3, `contract:export`.
- [ ] `docs/operations.md`: yêu cầu framing với reverse proxy khi chốt hosting.
