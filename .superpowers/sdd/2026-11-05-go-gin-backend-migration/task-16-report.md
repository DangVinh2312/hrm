# Báo cáo Task 16 — M8 (`role`, `administration`, `health/metrics`)

## Lát và commit

| Lát | Commit | Nội dung | Review độc lập |
|---|---|---|---|
| 16a | `2d7eebf` | `authorization/grant`, `authority.Administer` | Approved |
| 16b | `da18326` | 5 route `internal/modules/role` | Approved, 5 Minor |
| 16c1 | `7683e5f` | 6 route `internal/administration` (list, provision, suspend, reactivate, gán/thu hồi role) | Approved with fixes (1 Important đã sửa: ca từ chối `WithinActor` ở assign/revoke) |
| 16c2 | `1385a51` | 5 route `internal/administration` (bind/unbind boundary, changeEmail, resetMfa, resetGoogleBinding) | Approved, 3 Minor |
| 16d | `702bf2c` | `GET /api/health/metrics`, `MigratedRoutes` 100/100, stack e2e/dev/compose chỉ khởi Go | Approved with fixes (Minor sửa trong lát) |

Chi tiết từng lát: `task-16{a,b,c1,c2,d}-report.md`; ruling và diễn biến: `progress.md`.

## Gate (chạy 2026-11-11 trên `702bf2c`)

- `pnpm --filter @hrm/api-go run test:integration` (gồm build `apps/api`, `go test -race -tags integration -count=1 -p 1 ./cmd/... ./internal/... ./test/...`): exit 0, 42 package `ok`, 1 package không có test (`test/fixture/attendanceoracle`). Log `/private/tmp/hrm-16-gate-integration.log`.
- Theo báo cáo 16d (implementer chạy, điều phối viên chưa chạy lại): unit race 37 package ok, `./test` ok, lint 0, `pnpm test:browser` 30 passed, Vitest web 305 passed.
- Sau sửa Minor 16d, điều phối viên chạy: `go build ./...`, `go vet ./internal/health ./internal/app`, `gofmt -l internal/health`, `go test -count=1 ./internal/health ./internal/app` — đều ok. Integration toàn bộ ở trên chạy sau các sửa này.

## Plan

Đã tick 5/6 checkbox Task 16 kèm ghi chú bằng chứng. Chưa tick "Làm theo mẫu" (ma trận ADR-20 §4 đầy đủ, cuộc đua, port spec TS): nợ ở `test-debt.md` các mục Task 16a–16d.

## Còn lại / rủi ro

- Người dùng tự kiểm `.env.api` local không còn `API_UPSTREAM_URL` (binary từ chối boot nếu có).
- `pnpm run start:dev` và tài liệu Google login local vẫn chạy NestJS làm API (Task 17/19).
- Rủi ro khóa (dự kiến, chưa tái hiện) ở ba lệnh identity: ghi `test-debt.md`.
