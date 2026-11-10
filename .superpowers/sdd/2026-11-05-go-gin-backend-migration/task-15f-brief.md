# Brief Task 15f — M7 report: chuyển toàn bộ tính năng (repository, service, route, wiring), test nặng hoãn

BASE `1919504` (15a: types/validator/helper/XLSX đã có ở `apps/api-go/internal/modules/report`). Lát này gộp 15b + 15c của ruling 97 theo ruling 101 (quyết định người dùng 2026-11-10: "tôi muốn shift tính năng trước, các test và integration có thể bổ sung sau").

Đọc trước: `implementer-rules.md` (ràng buộc không nới; riêng yêu cầu "TDD đỏ trước / mutant" được ruling 101 hoãn cho phần test nặng), `task-15-map.md` (bản đồ M7 đầy đủ: route, SQL, rủi ro), `task-15a-report.md`, phần cuối `progress.md` (ruling 94–101), root `AGENTS.md`, `apps/api-go/AGENTS.md`, `contract/package-dag.md`, `contract/test-port-tracker.md`, `contract/routes.json`/`openapi.json` phần report, plan `docs/superpowers/plans/2026-11-05-go-gin-backend-migration.md` (Task 15, "Mẫu cho mỗi nhóm có chuyển route"). Xem một module đã chuyển làm mẫu (ví dụ `internal/modules/attendance`: repository/service/controller/http_port, wiring ở `internal/app`, `httpapi.MigratedRoutes`). Code TS ở `apps/api/src` chỉ để hiểu nghiệp vụ; SQL chép nguyên văn.

## Phạm vi (làm hết)

1. Repository + `Service.Query`/`Service.Export` cho mọi report của M7 theo bản đồ: cùng AST quyền cho JSON và export; `rows: []` không `null`; thứ tự key JSON theo contract web; không dùng `leavecore.LoadFacts` (trần 100); query nằm dưới trần runner 3000 ms, không nới; hủy theo context chỉ giữa các bước ngoài transaction; JSON trang rỗng nhưng export 403 khi không có grant (theo bản đồ); ngân sách 5000 dòng / 5 MiB → 422 `error.exportTooLarge`; F-24 theo bản đồ.
2. `httpapi.WriteBinary` (chưa có) cho phản hồi XLSX: Content-Type, Content-Disposition, độ dài; không rò lỗi thô.
3. Controller + http_port (handler chỉ nhận facade đã bind), wiring composition root, thêm route vào `httpapi.MigratedRoutes`, cập nhật `contract/route-ownership.md`, `package-dag.md` nếu thêm cạnh.
4. Sửa chú thích `apps/web`/e2e nếu có câu "report is still NestJS" (bản đồ nêu `attendance.e2e-spec.ts:323`) — chỉ chú thích/kỳ vọng runtime, không đổi hành vi web.
5. Tài liệu: `apps/api-go/AGENTS.md` (bẫy mới; kèm Minor m-a của 15a: thêm câu tác động của ruling 99 (b)(c) — dữ liệu qua CHECK `employee` (`full_name` ≤ 200, `hired_on >= 1950-01-01`) không chạm hai nhánh), `test-port-tracker.md` (dòng M7: ghi rõ phần nào ĐÃ port, phần nào NỢ).

## Test ở lát này (tối thiểu, có chủ đích)

- Bắt buộc: mọi guard/conventions có sẵn phải xanh. Nếu guard (ví dụ `TestEveryMigratedAuthorizeRouteHasAFullMatrix`, guard M-route trong `internal/app`, `./test`) buộc mỗi route trong `MigratedRoutes` phải có dòng ma trận thì viết đúng phần guard đòi, không nới guard, không thêm ngoại lệ.
- Một smoke integration cho mỗi nhóm hành vi chính qua HTTP thật (PostgreSQL testcontainers): JSON 200 có dữ liệu đúng shape; export 200 trả XLSX đọc lại được; không grant → từ chối đúng mã (JSON rỗng / export 403 theo bản đồ); chưa đăng nhập → 401. Mục đích: chứng minh route chạy và quyền không mở.
- HOÃN, ghi vào `test-debt.md` (file mới cùng thư mục sổ, bảng: hạng mục | nguồn TS spec:dòng | test Go dự kiến | rủi ro khi chưa có): ma trận HTTP đầy đủ ADR-20 §4 ngoài phần guard đòi, oracle integration `hrm-report` :310/:333/:388 (so cả nhánh per-row và set-based), đo 5000 dòng, mutant RED, cuộc đua, các ca biên còn lại của `hrm-report.spec.ts`/`hrm-excel.spec.ts` chưa port. Liệt kê cụ thể, không viết chung chung.
- Bất biến bảo mật trong CODE không hoãn: default deny, cùng AST cho list/export, không lọc quyền sau pagination, DTO allowlist, lỗi một shape `{statusCode, code}`, không thêm mã lỗi.

## Check (mỗi lệnh nặng riêng, sau `waitload.sh`, chạy nền, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-15f-*.log`)

Trong `apps/api-go`: `go build ./...`; `go vet ./...`; `go vet -tags integration ./...`; `go test -race -count=1 ./internal/...`; `go test -count=1 ./test`; `go tool golangci-lint run`; `gofmt -l .`; integration `-tags integration -race -count=1 -p 1` cho `./internal/modules/report` và `./internal/app` (app chứa guard ma trận). Từ root: `pnpm test:browser` (một lần, cuối cùng); prettier các Markdown đã đổi; `git diff --check`. Không chạy đo 5000 dòng.

## Báo cáo

`task-15f-report.md`: đã làm, route đã chuyển (bảng method/path/handler), quyết định tự đưa ra, lệnh + output thật, file đổi, nợ test (trỏ `test-debt.md`), điều chưa kiểm chứng. Không stage/commit/spawn, không tick plan. Gặp quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
