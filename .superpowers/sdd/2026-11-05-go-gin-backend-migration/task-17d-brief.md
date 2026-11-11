# Brief Task 17d — C1: stack web/dev/docker/scripts/seed/docs dùng `hrmctl`

BASE: commit 17c (xem `git log -1`; working tree sạch ngoài sổ). Đọc trước: `implementer-rules.md`, `task-17-map.md` (§2 bảng nơi gọi, §3 `seed/`, §6 mục 17d, Rủi ro), `task-17a-report.md`, `task-17b-report.md`, `task-17c-report.md` (lệnh, cờ, câu stdout, ghi chú cho 17d), phần cuối `progress.md` (ruling 105–110), root `AGENTS.md`, `apps/api-go/AGENTS.md`, `apps/web/AGENTS.md`, `docs/operations.md`.

## Ruling ràng buộc

- 105: DB dev (`scripts/dev.sh` `setup`, service `setup` của `docker/compose.yaml`) GIỮ `provision`/`migrate` bằng CLI TS tới Task 19 (DB dev do TypeORM dựng, goose sẽ fail). Chỉ đổi lệnh Root/identity, e2e sang `hrmctl`. Vì vậy root `db:provision`/`db:migrate` vẫn phải dựng được DB dev hiện có: giữ trỏ `@hrm/api` cho hai script này (ghi chú lý do trong docs), còn `root:*`, `identity:*` và các script ops khác trỏ `@hrm/api-go`. Nếu thấy cách khác an toàn hơn thì nêu trong báo cáo, không tự đổi DB dev.
- 106: giữ script `tools/product.ts` trong `apps/api/package.json`; root `package.json` trỏ Go.
- 108/110: được đọc và sửa riêng `seed/enroll.sh`, `seed/enroll-accounts.mjs`. KHÔNG mở file khác trong `seed/`. KHÔNG in email/PII ra terminal, log hay báo cáo (kiểm bằng `rg -c`, không `cat` toàn file `enroll.sh` ra output; nếu cần xem cấu trúc thì xem một dòng đã che email bằng `sed 's/--email [^ ]*/--email <redacted>/'`). `seed/` bị gitignore: sửa tại chỗ, không `git add`.
- 109: giữ câu stdout `Root enrollment committed (id …)`.

## Phạm vi

1. `apps/web/e2e/stack.helper.ts`: dựng DB (`provision`, đã gồm migrate — xác minh), `bootstrapRoot`, `enrollByEmail` bằng binary `hrmctl` (`dist/hrmctl` đã được kiểm tồn tại); bỏ kiểm `apps/api/dist/main.js` và mọi lời gọi `tools/product.ts`. Kiểm 9 file e2e còn tham chiếu NestJS nào không (`rg 'tools/product|apps/api/dist|nest' apps/web/e2e apps/web/playwright*`).
2. `apps/api-go/package.json`: script ops theo mẫu `manifest:sync` nhưng đọc `../api/.env.ops` và chuyển tiếp argv cho từng lệnh `hrmctl` (`bootstrap`, `reissue-root`, `revoke-root`, `set-root-email`, `enroll`, `reset-mfa`, `reset-root-mfa`, `purge-sessions`; `provision`/`migrate` nếu hợp ruling 105). Không in env.
3. Root `package.json`: `root:*`, `identity:*` (và tên script hiện có tương ứng) trỏ `@hrm/api-go`; `db:*` theo ruling 105.
4. `scripts/dev.sh`, `docker/compose.yaml`, `docker/root-activation.sh`: lệnh Root/identity chạy `hrmctl` (container Go như service `manifest`, mount `volumes/secrets:/out`); `setup` giữ TS theo ruling 105.
5. `seed/enroll.sh`, `seed/enroll-accounts.mjs`: đổi lời gọi sang `hrmctl enroll` (cờ theo `task-17a-report.md`), giữ cwd/env giả định hoặc ghi rõ thay đổi.
6. Docs: `docs/operations.md` (lệnh `root:*`/`identity:*`/`db:*`, đoạn "CLI offline", và đoạn `start:dev`/Google login local còn mô tả chạy NestJS — nợ từ review 16d), `docs/architecture.md` dòng nhắc CLI, `apps/api-go/AGENTS.md`, `apps/web/AGENTS.md` dòng nhắc CLI TS, `contract/test-port-tracker.md` (dòng C1 liên quan helper stack). Root `AGENTS.md` để Task 19.

Không sửa `apps/api/src`, không sửa code Go ngoài `package.json` trừ khi `hrmctl` thiếu thứ stack cần (khi đó nêu rõ, giữ nhỏ). Không đọc `.env*`/secret. Không khởi container dev, không chạm DB dev.

## Test / Check (lệnh nặng tuần tự sau `waitload.sh`, `GOCACHE=/private/tmp/hrm-go-cache`, log `/private/tmp/hrm-17d-*.log`)

- `pnpm test:browser` (hoặc `pnpm --filter @hrm/web run test:browser`): e2e dựng DB và Root bằng `hrmctl`, toàn bộ xanh. Chứng minh không gọi TS: `rg` + giải thích.
- `bash -n scripts/dev.sh docker/root-activation.sh seed/enroll.sh`; `node --check seed/enroll-accounts.mjs`; `docker compose -f docker/compose.yaml config -q` (KHÔNG khởi container).
- Một ca từ chối chạy thật cho script ops mới (ruling 103), ví dụ gọi script với cờ lạ hoặc thiếu env → exit ≠ 0, không in secret (dùng env giả, không đọc `.env.ops` thật).
- `pnpm exec prettier --check` các file đã đổi; `pnpm --filter @hrm/web run typecheck` + lint nếu đổi TS; `pnpm run test:workspace` nếu đổi root `package.json`; `git diff --check`.

## Báo cáo

`task-17d-report.md`: thay đổi theo file, bảng script cũ → mới, lệnh + output thật, cách xử lý `seed/` (không PII), điều chưa kiểm (docker thật, DB dev), nợ, ghi chú cho Task 18/19. Không stage/commit/spawn/tick plan. Quyết định chỉ người dùng chốt được → NEEDS_CONTEXT.
