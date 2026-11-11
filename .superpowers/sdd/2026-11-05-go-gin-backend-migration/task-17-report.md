# Báo cáo Task 17 (C1, CLI offline `hrmctl`) — tổng hợp

| Lát | Commit | Nội dung | Review độc lập |
|---|---|---|---|
| 17a | `8425e67` | khung cờ, `enroll`, `reset-mfa`, `reset-root-mfa`, `purge-sessions` | Approved (xem `task-17a-report.md`) |
| 17b | `3ce6460` | `bootstrap`, `reissue-root`, `revoke-root`, `set-root-email`, file kích hoạt | Approved, 6 Minor |
| 17c | `29a4dfb` | template/fixture test Go chạy binary `hrmctl`; `test:integration` bỏ build TS | Approved, 4 Minor |
| 17d | `f41dd83` | e2e stack, script root, compose `hrmctl`, `root-activation.sh`, `seed/`, docs | Approved, 7 Minor (2 đã sửa) |

Checkbox plan Task 17: tick 3/4 (port lệnh; ràng buộc link + `0600` + audit actor; `seed/`). Chưa tick "Test Root guard, marker…": mới có các ca từ chối tối thiểu của 17a/17b (ruling 103); port đầy đủ là nợ 17e. Task 18: tick dòng Playwright/`dev:stack`; dòng parity ghi chú ADR-22 (không chạy), không tick.

Bằng chứng chạy thật gần nhất: integration Go toàn bộ sau 17c: 41 package ok + `internal/modules/setting` FAIL môi trường (chạy lại riêng ok) — chưa có lượt xanh liền một mạch; `pnpm test:browser` sau 17d: 30 passed. Sau 17d chưa chạy lại integration Go (17d không đổi code Go ngoài `package.json`).

Còn lại theo ruling 105/106: `db:provision`/`db:migrate`, `setup` (dev.sh, compose), `docker/Dockerfile`, script `tools/product.ts` trong `apps/api/package.json` → Task 19. Nợ: `test-debt.md` mục Task 17a–17d, 17e.
