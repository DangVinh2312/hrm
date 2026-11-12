# Giảm chi phí integration test

Phạm vi: tái sử dụng binary CLI trong một lượt chạy Go và giảm round-trip của snapshot ma trận HTTP. Giữ container riêng theo package, mọi assertion, race detector và full suite CI; không bỏ suite NestJS trước cutover.

- [x] Thêm runner build `hrmctl` vào thư mục tạm một lần, truyền đường dẫn cho fixture, dọn khi kết thúc và chuyển nguyên exit code. Kiểm tra build lỗi, test lỗi, package/flag filter và cleanup bằng subprocess test.
- [x] Gom bảy snapshot SQL thành một câu lệnh, giữ nguyên chuỗi kết quả. Kiểm parity với các câu query riêng trên PostgreSQL và chạy lại package app/manifest cùng workload đã đo.
- [x] Ghi quy ước chọn phạm vi test, tái sử dụng fixture và đo trước/sau trong root/app `AGENTS.md`; chạy build, vet, workspace tests, integration liên quan và kiểm diff.

Môi trường local: Go 1.27.3 darwin/amd64, Node 24.20.0, pnpm 12.3.4; Docker 4 CPU / 3,82 GiB, PostgreSQL 18.6-bookworm, disposable fixtures của suite. Không đổi dữ liệu fixture hay tập test cũ khi so sánh. Số dưới đây là thời gian package của Go, không gồm toàn bộ thời gian runner/build ngoài process test.

| Package  | Trước (1 lượt) | Sau (lượt 1) | Sau (runner cuối) |
| -------- | -------------- | ------------ | ----------------- |
| manifest | 30,583 s       | 13,390 s     | 19,454 s          |
| app      | 172,176 s      | 160,727 s    | 197,940 s         |

Lượt sau đầu dùng wrapper shell; runner cuối dùng Node để chuyển tín hiệu dừng cho cả process group và dọn binary tạm. Mỗi lượt đều pass 19 test cấp cao của manifest và 93 test cấp cao cũ của app. Regression snapshot mới chạy riêng để giữ workload so sánh như cũ, pass (package 8,474 s). Trong lượt cuối M1/M2/M4 lần lượt 5,25 / 3,55 / 3,35 s, so với 6,92 / 7,42 / 6,49 s trước thay đổi.

Sau lượt cuối, `uptime` cho load average 90,06 / 71,77 / 60,12, vượt ngưỡng 40 của ADR-20 Q4; chưa ghi tải máy ở mốc trước. Vì vậy chưa chứng minh được tổng suite nhanh hơn ổn định; không dùng bảng này để tuyên bố phần trăm cải thiện. Chưa đo toàn bộ repository. Chi phí cấu trúc đã giảm: build CLI một lần mỗi lượt runner thay vì mỗi package dùng fixture; snapshot thông thường còn 2 thay vì 14 round-trip cho mỗi ca từ chối.

Kiểm chứng đã chạy và pass:

- `pnpm run test:workspace`: 27 test, gồm 7 ca runner (default packages, package filter, flag-only filter, build/test lỗi, hủy lúc build/test).
- `pnpm exec tsc -p tsconfig.json`, ESLint và Prettier trên file thay đổi; `git diff --check`.
- Trong `apps/api-go`: `go test -race ./test`, `go build ./...`, `go vet -tags integration ./...`.
- Trong `apps/api-go`: `pnpm run test:integration ./internal/app -run '^TestTheMatrixSnapshotMatchesEveryIndividualQuery$' -json`.
- `pnpm --filter @hrm/api-go run test:integration ./internal/authorization/manifest ./internal/app -skip '^TestTheMatrixSnapshotMatchesEveryIndividualQuery$' -json`.

Chưa chạy root full suite NestJS + Go hoặc E2E vì phạm vi thay đổi là fixture/runner Go; không khởi động thêm suite nặng sau khi thấy tải máy vượt ngưỡng. Review độc lập không còn finding sau khi sửa signal forwarding và flag-only filter. Thay đổi có sẵn của người dùng trong M8/role/manifest được giữ nguyên.

## Lượt 2 (2026-11-12): cluster dùng chung, bỏ suite NestJS khỏi lệnh root

- [x] Runner khởi một container PostgreSQL cho cả lượt (`docker run`, password chỉ qua env), truyền `HRM_TEST_POSTGRES_URL`; `test.NewDatabase` gắn vào cluster đó, package đầu dựng template dưới advisory lock rồi rename, package sau chỉ clone. `internal/database` và test `test.StartPostgres` của `internal/offline` giữ cluster riêng. Gọi `go test` trực tiếp không đổi.
- [x] Lệnh root `test:unit`, `test:integration` chỉ còn Go (và web với unit); gỡ `test:e2e` root và bước CI tương ứng (quyết định của người dùng 2026-11-12). File test của `apps/api` giữ nguyên, gọi tay bằng `pnpm --filter @hrm/api run test:<suite>`.
- [x] Chạy lại đủ suite Go sau khi tách `test/template_shared.go`: 9 lượt đủ suite ở bảng "Đo lặp lại" đều exit 0, 42 package, 1060 test cấp cao pass (lượt đầu 11:17, trước khi sửa ca bảng của `TestByteOrderOfTheGrants…`, exit 1 với đúng fail đó).
- [x] Quyết định `-p 2`: runner mặc định `-p 2` (3 lượt đủ suite trên cluster dùng chung đều pass, load đỉnh 7,68–10,82).
- [ ] Kết luận cluster dùng chung nhanh hơn ổn định ở `-p 1`: chưa chứng minh, chỉ có một cặp sạch (xem dưới). Giữ cluster dùng chung theo quyết định của người dùng 2026-11-12.

Cùng máy và môi trường như trên; mỗi cấu hình một lượt đủ suite qua runner (`pnpm run test:integration -json`, 43 package, 1058 test cấp cao ở baseline), tải nền của tiến trình khác 5–20 suốt các lượt.

| Cấu hình                      | Wall (s) | Tổng package (s) | Load đỉnh | Fail                           |
| ----------------------------- | -------- | ---------------- | --------- | ------------------------------ |
| Container mỗi package, `-p 1` | 849,81   | 728,5            | 16        | test đang dở của người dùng    |
| Container mỗi package, `-p 2` | 490,01   | 884,1            | 35        | như trên                       |
| Cluster dùng chung, `-p 1`    | 872,55   | 753,8            | 20        | như trên + giới hạn 300 dòng\* |

\* `TestConventionsHoldOnTheModule` fail vì `test/template.go` 312 dòng; đã tách file và test này pass lại khi chạy riêng. Test đang dở là `TestByteOrderOfTheGrantsIsTheCollationOrderOfTheReleaseKeys` (`role_catalog_helper_test.go`, thay đổi có sẵn của người dùng).

Cluster dùng chung **chưa chứng minh được tổng nhanh hơn**. 19 package nhỏ đều giảm 2,2–9,9 s (tổng khoảng 90 s, đúng bằng chi phí container + template đo riêng: container 3,6–5,6 s, provision 0,8–2,2 s, sync 0,6–1,4 s), nhưng `report`, `app`, `authentication` tăng 48, 31, 19 s trong cùng lượt. Đo riêng `report` hai lượt xen kẽ: container riêng 144,7 và 97,3 s; cluster mới của runner 110,4 và 169,0 s (baseline 79,8 s), tức nhiễu của máy lớn hơn chênh lệch cần đo và không thấy hướng nhất quán. Không dùng bảng này để tuyên bố phần trăm cải thiện.

Chi phí còn lại theo lượt baseline: CPU user 245 s trên 850 s wall (chạy nối đuôi là nguyên nhân chính); compile/link giữa các package khoảng 109 s; fixture mỗi test khoảng 250 ms (clone 92, revoke 17, mở pool 74, drop 64; trung bình 30 lần × 3 lượt), tắt `fsync` chỉ bớt khoảng 35 ms nên không làm; 540 test unit chạy kèm tổng 1 s nên không tách. `-p 2` giảm 42% wall trong một lượt nhưng đẩy load tới 35 và chưa đo cùng cluster dùng chung; chưa áp dụng.

Kiểm chứng lượt 2 đã chạy và pass: `node --test test/go-integration-runner.spec.ts` (8 ca, thêm cluster lỗi và docker giả), `pnpm exec tsc -p tsconfig.json`, ESLint/Prettier trên file đổi, `git diff --check`; trong `apps/api-go`: `go build ./...`, `go vet ./...`, `go vet -tags integration ./...`, `go tool golangci-lint run ./test/...`, `go test -race -count=1 ./test`, `go test -race -tags integration -count=1 -run 'TestEveryPackageOfARunnerRunClonesOneTemplate|TestConventionsHoldOnTheModule|RunnerCluster' ./test`. Mutant overlay (bỏ kiểm template đã có) làm `TestEveryPackageOfARunnerRunClonesOneTemplate` đỏ với SQLSTATE 42P04. Chưa chạy: lệnh root `test:unit`/`test:integration` sau khi đổi script, `golangci-lint` toàn module, browser E2E.

Giới hạn: runner bị SIGKILL để lại container `hrm-integration-*` (không có reaper), gỡ bằng `docker rm -f`; image PostgreSQL nay ghim thêm ở `tools/test-integration.ts`.

### Đo lặp lại (2026-11-12, 11:41–14:05)

Cùng máy; mỗi lượt là đủ suite `-json` qua runner trong `apps/api-go`, chạy nối tiếp, mỗi lượt bắt đầu khi load 1 phút dưới 40. "Container mỗi package" là bản tạm của runner ngoài repo, chỉ khác ở chỗ không khởi cluster và không truyền `HRM_TEST_POSTGRES_URL`. Load lấy mẫu 15 giây một lần (`sysctl vm.loadavg`, trung bình 1 phút). Mọi lượt exit 0, 42 package, 1060 test cấp cao pass.

| Lượt | Cấu hình                      | Wall (s) | Tổng package (s) | Load đỉnh | Ghi chú         |
| ---- | ----------------------------- | -------- | ---------------- | --------- | --------------- |
| 1    | Container mỗi package, `-p 1` | 1142     | 1020,0           | 324,83    | nhiễu tải ngoài |
| 1    | Cluster dùng chung, `-p 1`    | 864      | 782,4            | 128,71    | nhiễu tải ngoài |
| 2    | Container mỗi package, `-p 1` | 1108     | 1023,1           | 63,20     | nhiễu tải ngoài |
| 2    | Cluster dùng chung, `-p 1`    | 1568     | 1367,8           | 221,06    | nhiễu tải ngoài |
| 3    | Container mỗi package, `-p 1` | 807      | 747,3            | 5,42      | máy rảnh        |
| 3    | Cluster dùng chung, `-p 1`    | 772      | 718,4            | 5,00      | máy rảnh        |
| 1    | Cluster dùng chung, `-p 2`    | 447      | 830,2            | 9,96      | máy rảnh        |
| 2    | Cluster dùng chung, `-p 2`    | 463      | 865,0            | 7,68      | máy rảnh        |
| 3    | Cluster dùng chung, `-p 2`    | 480      | 905,5            | 10,82     | máy rảnh        |

Tải ngoài ở lượt 1 và 2 không phải của suite: lúc 12:40 các tiến trình chiếm CPU là jest worker của một dự án khác trên máy và VM của Docker. Hai lượt đó cho hướng ngược nhau (cluster dùng chung nhanh hơn 278 s rồi chậm hơn 460 s) nên không dùng để so sánh.

Kết luận:

- Cluster dùng chung ở `-p 1`: một cặp sạch duy nhất, nhanh hơn 35 s wall (4%) và 29 s tổng package. **Chưa chứng minh nhanh hơn ổn định**; hai cặp sạch đo bổ sung lúc 14:06 bị ngắt khi phiên làm việc kết thúc và chưa chạy lại. Người dùng quyết định giữ cluster dùng chung với số hiện có.
- `-p 2` trên cluster dùng chung: 447–480 s, thấp hơn 38–42% so với lượt `-p 1` sạch cùng cấu hình (772 s, một lượt), load đỉnh dưới 11 trên máy rảnh. Không so được với lượt `-p 2` container mỗi package của bảng trên (490 s, load 35) vì lượt đó chạy lúc máy có tải nền 5–20. Runner đổi mặc định sang `-p 2`; chưa đo `-p 2` khi máy đang tải, khi đó truyền `-p 1`.
- Ba lượt `-p 2` ở bảng chạy bằng cờ `-p 2` truyền thêm cho runner còn mặc định `-p 1` (cờ sau thắng). Sau khi đổi mặc định: `node --test test/go-integration-runner.spec.ts` 8/8 pass; `pnpm --filter @hrm/api-go run test:integration` (14:42) exit 0, 572 s, 42 package `ok`, load cuối lượt 103 do tải ngoài; `go tool golangci-lint run` 0 issues; `go vet -tags integration ./...` exit 0. `pnpm run test:unit` ngay sau đó (load 104–116) exit 1: Go pass, web 304/305 với `test/work-calendar.spec.tsx` không tìm thấy heading; chạy lại riêng file đó lúc load 13 thì 14/14 pass. Thay đổi này không chạm `apps/web`; chưa chạy lại cả `test:unit` trên máy rảnh.

Sửa 2026-11-12 (sau lượt 2): theo quyết định của người dùng, bốn nhóm integration rủi ro thấp đã gỡ, trong đó có `TestTheMatrixSnapshotMatchesEveryIndividualQuery` và `TestEveryPackageOfARunnerRunClonesOneTemplate` nêu ở trên; danh sách ở đầu `apps/api-go/contract/test-port-tracker.md`. Số test và thời gian trong các bảng là của suite trước khi gỡ.
