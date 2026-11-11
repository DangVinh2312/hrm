# Báo cáo Task 17d — stack web/dev/docker/scripts/seed/docs dùng `hrmctl`

BASE `29a4dfb` (working tree sạch lúc bắt đầu, `git status --short` rỗng). Không stage/commit, không sửa `apps/api/src`, không sửa code Go, không đọc `.env*`, không khởi container dev, không chạm DB dev, không chạy `docker compose up/run`. Status: DONE_WITH_CONCERNS (phần docker và seed chỉ kiểm cú pháp/config, chưa chạy thật; xem Chưa kiểm).

## Thay đổi theo file

- `apps/web/e2e/stack.helper.ts`: bỏ `apiRoot` và kiểm `apps/api/dist/main.js`; `cli(...)` chạy `apps/api-go/dist/hrmctl` (cwd `apps/api-go`, cùng `opsEnv` giả). Dựng DB chỉ còn `cli('provision')`: `hrmctl provision` → `offline.Provision` gọi `runMigrations` (`internal/offline/provision.go:155`), nên bỏ `cli('migrate')`. `bootstrapRoot`, `enrollByEmail` giữ nguyên cờ, nay qua `hrmctl`. Thông báo thiếu build: `pnpm --filter @hrm/api-go run build`. Docstring sửa theo.
- `apps/api-go/package.json`: thêm `start:dev` (`go run ./cmd/api`, đọc `../api/.env.api`) và 8 script ops theo mẫu `manifest:sync`, đọc `../api/.env.ops`, chuyển argv: `root:bootstrap|reissue|revoke|set-email|reset-mfa`, `identity:enroll|reset-mfa|purge-sessions`. Mỗi script kết thúc bằng ` --` để `node -e` không coi cờ của operator là cờ của node (đã thử: không có `--` thì `node: bad option: --operation`, exit 9). Không in env. Không thêm `db:provision`/`db:migrate` (ruling 105: goose fail trên DB dev).
- Root `package.json`: `root:*`, `identity:*` và `start:dev` trỏ `@hrm/api-go`; `db:migrate`, `db:provision` giữ `@hrm/api` (ruling 105).
- `docker/compose.yaml`: service mới `hrmctl` (image `golang:1.27.3-bookworm` như `manifest`, `profiles: ['ops']` để `up` không chạy, `env_file: .env.ops`, `entrypoint: go run ./cmd/hrmctl`, mount `../apps/api-go:/src:ro`, `./volumes/go:/go`, chờ `postgres` healthy). Service `setup` giữ CLI TS (ruling 105).
- `docker/root-activation.sh`: `docker compose run --rm -v "$PWD/volumes/secrets:/out" hrmctl "$@" --activation-file "/out/$file"` thay cho `setup node tools/product.ts`.
- `scripts/dev.sh`: không đổi. Không có lệnh Root/identity; `setup` gọi `db:provision`/`db:migrate` (vẫn TS theo ruling 105); `api_stack` đã dùng `dist/hrmctl sync` và `dist/api` từ 16d.
- Docs: `docs/operations.md` (câu mở đầu về cwd forward; Docker `hrmctl` + cách gọi lệnh khác; đoạn "CLI offline" viết lại cho `hrmctl` kèm ràng buộc `NODE_ENV`/`PGSSLMODE`; đoạn mới giải thích vì sao `db:*` còn TS; `test:browser`; `dev:stack` chỉ cần build Go; Google local dùng `manifest:sync` + `start:dev` Go; câu "chỉ còn dùng CLI NestJS…" và "CLI TypeScript sync…"). `docs/architecture.md` (dòng "CLI trong `apps/api/tools/`", hai ô bảng `cmd/hrmctl` và `internal/offline`; giữ độ rộng cột để Prettier không đệm lại cả bảng). `apps/api-go/AGENTS.md` (câu cuối đoạn đầu, script vận hành ở đoạn lệnh, dòng "TypeScript CLI sync"). `apps/web/AGENTS.md` (dòng CLI NestJS của stack, `dev:stack` cần build Go). Root `AGENTS.md` để Task 19.
- `apps/api-go/contract/test-port-tracker.md`: `cli-fixture.helper.ts` → `thay bằng` `test/template.go` (`Stack.Hrmctl`, `cluster.hrmctl`, `insertProvider`); các spec `product-cli*` vẫn là dòng riêng (17e).
- `seed/enroll.sh`, `seed/enroll-accounts.mjs` (gitignore, sửa tại chỗ, không `git add`): xem mục `seed/`.

## Bảng script cũ → mới

| Root script | Trước | Sau |
| --- | --- | --- |
| `root:bootstrap` | `@hrm/api` → `node tools/product.ts bootstrap` | `@hrm/api-go` → `go run ./cmd/hrmctl bootstrap` |
| `root:reissue` | TS `reissue-root` | `hrmctl reissue-root` |
| `root:revoke` | TS `revoke-root` | `hrmctl revoke-root` |
| `root:set-email` | TS `set-root-email` | `hrmctl set-root-email` |
| `root:reset-mfa` | TS `reset-root-mfa` | `hrmctl reset-root-mfa` |
| `identity:enroll` | TS `enroll` | `hrmctl enroll` |
| `identity:reset-mfa` | TS `reset-mfa` | `hrmctl reset-mfa` |
| `identity:purge-sessions` | TS `purge-sessions` | `hrmctl purge-sessions` |
| `start:dev` | `@hrm/api` NestJS `dist/main.js` | `@hrm/api-go` `go run ./cmd/api` (`.env.api`) |
| `manifest:sync` | Go (từ trước) | không đổi |
| `db:provision`, `db:migrate` | TS | không đổi (ruling 105) |

Env vẫn là `apps/api/.env.ops` (ops) và `apps/api/.env.api` (runtime). Script TS trong `apps/api/package.json` giữ (ruling 106).

## `seed/` (ruling 110, không PII)

Chỉ mở hai script. Không mở `nhan-vien.json`, `accounts.map.json` hay file khác; không chạy `enroll-accounts.mjs` (nó đọc dữ liệu nhân viên và ghi lại `accounts.map.json`).

- Cấu trúc xem bằng `rg -c`/`grep -c` và một dòng đã che email/UUID: `enroll.sh` 49 dòng = `set -eu` + 48 dòng `node tools/product.ts enroll --user <uuid> --issuer https://accounts.google.com --email <redacted> --role hr.employee`, không `cd`, không nạp env. Generator ghi rõ cách chạy cũ: `docker compose … run --rm -T --no-deps -v seed/enroll.sh:/tmp/enroll.sh:ro setup sh /tmp/enroll.sh` (cwd `/app/apps/api`, env `docker/.env.ops`).
- `enroll.sh`: chỉ đọc dòng 1 bằng Read; sửa bằng Edit `replace_all`: `node tools/product.ts enroll --user` → `/tmp/hrmctl enroll --user`, thêm dòng 2 `go build -o /tmp/hrmctl ./cmd/hrmctl` (build một lần thay 48 lần `go run`). Lần Edit đầu, công cụ cắt dấu cách cuối của chuỗi thay thế nên mất dấu cách sau `--user`; phát hiện bằng `grep -cE` (0 dòng khớp) và `od -c` trên dòng đã che, sửa bằng 15 Edit `enroll --user<hex>` → `enroll --user <hex>` theo ký tự đầu UUID. Kiểm cuối: 50 dòng; `grep -cE '^/tmp/hrmctl enroll --user <UUID chuẩn> --issuer https://accounts\.google\.com --email [^ ]+ --role hr\.employee$'` = 48; `grep -c 'tools/product\|node '` = 0; `bash -n` ok.
- `enroll-accounts.mjs`: chỉ đọc dòng 1–10 và 28–34 (không chứa PII; phần còn lại xem qua `sed` che email). Sửa chú thích (lệnh `hrmctl enroll`, cách chạy mới), dòng sinh lệnh (`/tmp/hrmctl enroll --user …`), và phần đầu file sinh ra (`set -eu` + `go build -o /tmp/hrmctl ./cmd/hrmctl`). `node --check` ok.
- Cách chạy mới (ghi trong chú thích generator): `docker compose -f docker/compose.yaml run --rm -T --no-deps --entrypoint sh -v "$PWD/seed/enroll.sh:/tmp/enroll.sh:ro" hrmctl /tmp/enroll.sh` — cwd `/src` = `apps/api-go`, env `docker/.env.ops` (cần `PRODUCT_AUTHORITY_DATABASE_URL`, đã cần cho TS). `hrmctl enroll` không in email (17a).

## Lệnh đã chạy và output thật

Chạy từ gốc repo; lệnh nặng sau `waitload.sh` (load 3.4 lúc chạy ca từ chối), `GOCACHE=/private/tmp/hrm-go-cache`.

| Lệnh | Kết quả | Log |
| --- | --- | --- |
| `env -i PATH HOME GOCACHE pnpm run root:bootstrap -- --bogus x` (env giả, `apps/api/.env.ops` không tồn tại — `ls` chỉ thấy hai file `.example`) | exit 1; `Product operation failed Unexpected option --bogus; no secrets are printed…` | `/private/tmp/hrm-17d-ops-refusal.log` |
| `… pnpm run identity:enroll -- --user <uuid giả> --email <email giả> --issuer … --role hr.employee` (không URL) | exit 1; `Product operation failed PRODUCT_AUTHORITY_DATABASE_URL is required; …`; dòng lỗi của `hrmctl` không có email | cùng log |
| `… pnpm run root:revoke -- --user <uuid> --operation <uuid>` (thiếu approval/reason) | exit 1; `Product operation failed Root revocation requires --approval and --reason; …` | cùng log |
| `pnpm exec prettier --check` 9 file đã đổi trong Git | lần 1 exit 1 (`docs/architecture.md`, bảng); rút gọn ô bảng, `prettier --write` file đó (HEAD đã đúng format), lần cuối exit 0 | `/private/tmp/hrm-17d-static.log` |
| `bash -n` từng file `scripts/dev.sh`, `docker/root-activation.sh`, `seed/enroll.sh`; `sh -n docker/root-activation.sh` | exit 0 | cùng log |
| `node --check seed/enroll-accounts.mjs` | exit 0 | cùng log |
| `docker compose -f docker/compose.yaml config -q` (không khởi container) | exit 0; `config --services` không có `hrmctl`, `--profile ops config --services` có | cùng log |
| `git diff --check` | exit 0 | cùng log |
| `pnpm --filter @hrm/web run typecheck` | exit 0 | `/private/tmp/hrm-17d-tc.log` |
| `pnpm exec eslint apps/web/e2e/stack.helper.ts` | exit 0 | cùng log |
| `pnpm run test:workspace` | exit 0, 20 pass | cùng log |
| `pnpm test:browser` (sau `waitload.sh`, load 3.96; tự build `@hrm/api-go`) | exit 0; `Running 30 tests using 1 worker`, `30 passed (2.4m)`; tổng 2:32.20 | `/private/tmp/hrm-17d-browser.log` |

`apps/api/dist/main.js` mtime `Nov 6 10:13` trước và sau: không có build TS nào trong lượt chạy.

Chứng minh e2e không gọi TS: `rg -n -i 'tools/product|apps/api/dist|nest|apiRoot|\.\./\.\./api/' apps/web/e2e` chỉ khớp một chỗ `administration.e2e-spec.ts:61` (`-o` cho thấy là `neSt` trong `outlineStyle`, không liên quan) — không còn tham chiếu nào tới `apps/api`. `stack.helper.ts` không còn biến trỏ `apps/api/`; mọi tiến trình con là `dist/hrmctl`, `dist/api` hoặc container PostgreSQL. `rg 'tools/product' --glob '!apps/api/**'` ngoài docs lịch sử/ADR/`package-dag.md` chỉ còn `docker/compose.yaml:27` (service `setup`, ruling 105) và đoạn docs mới giải thích điều đó.

## Chưa kiểm

- Docker thật: không chạy `root-activation.sh`, `docker compose run hrmctl …`, hay `enroll.sh` trong container (cấm khởi container dev). Chỉ `config -q`. Chưa kiểm `docker/.env.ops` có `NODE_ENV`/`PGSSLMODE` hợp lệ với `hrmctl` (không đọc env): `NODE_ENV=production` sẽ ép verify-full TLS, giá trị lạ bị từ chối; TS không kiểm hai biến này.
- DB dev: không chạm. Script ops chưa chạy ca thành công qua `pnpm` trên DB (đường thành công của binary đã được e2e và integration 17a–17c phủ).
- `pnpm run start:dev` mới chưa chạy (cần `.env.api` thật).
- File kích hoạt do `hrmctl` trong container ghi với user root của container; trên Docker Desktop macOS bind mount ánh xạ về user host (như service `setup` cũ chạy root). Trên Linux file sẽ thuộc root — giống trước, chưa kiểm.

## Nợ / ghi chú cho Task 18/19

- Task 19 — docker: service `setup` (`node tools/product.ts provision` trong image `hrm-local`) và `docker/Dockerfile` (`pnpm --filter @hrm/api run build`) chuyển sang Go khi dựng lại volume bằng goose; `scripts/dev.sh setup` và root `db:provision`/`db:migrate` cùng lúc. Ghi chú comment `api-go` trong compose ("New migrations still need `setup`") cũng đổi khi đó.
- Task 19: root `AGENTS.md:128` (danh sách script), `docs/architecture.md:14` (`tools/ (CLI offline)`), `apps/api/AGENTS.md`, `apps/api/README.md` còn nói `start:dev` NestJS; root `package.json#description` còn "NestJS API".
- `pnpm` tự in dòng lệnh kèm đối số (`$ pnpm --filter … --email …`) trước khi chạy script: email operator truyền qua `pnpm run identity:enroll`/`root:bootstrap` hiện trên terminal do pnpm, không do `hrmctl` — như script TS trước đây. `seed/enroll.sh` gọi binary trực tiếp nên không bị.
- `opsEnv` của e2e còn đặt URL `sync`/`migration`/`identity` không dùng; vô hại, giữ diff nhỏ.
- `apps/web/AGENTS.md` dòng "cần build API + Chromium" của `test:browser` vẫn đúng nghĩa (tự build Go); không sửa.

## Review độc lập và ghi chú của điều phối viên (2026-11-11)

Reviewer opus (chỉ đọc diff + brief + hai script `seed/` đã che PII, không đọc báo cáo này): **Approved**, 0 Critical, 0 Important, 7 Minor. Reviewer tự tái hiện: script ops chuyển nguyên argv (khoảng trắng, nháy, `$HOME`, `--`) và truyền exit code qua hai tầng pnpm; `identity:purge-sessions -- --bogus x` exit 1 trước khi nối DB; service `hrmctl` chỉ hiện khi có `--profile ops`.

Điều phối viên sửa sau review:

- Minor 1 (`seed/enroll-accounts.mjs:25`): regex email siết thành `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$` để giá trị ghép vào dòng shell không mang ký tự đặc biệt (`node --check` ok; `enroll.sh` hiện có không sinh lại).
- Minor 4: `apps/api-go/AGENTS.md:121`, `docs/operations.md:90` → "chỉ còn trong test và script quay lui của `apps/api`" (ruling 106). Prettier + `git diff --check` ok.

Ghi `test-debt.md` mục Task 17d: Minor 2 (`enroll.sh` không chạy lại tiếp được sau lỗi giữa chừng), 3 (`/tmp/hrmctl` cố định khi chạy trên host), 5 (`opsEnv` e2e thừa ba URL), 6 (script ops không in lý do khi spawn `go` lỗi), 7 (`docs/operations.md:59` và root `AGENTS.md:128` còn mô tả cũ — Task 19).

`start:dev` đổi sang Go ngoài brief (nợ từ review 16d): giữ, đã báo người dùng; chưa chạy thật (cần `.env.api`). Chưa chạy thật: `root-activation.sh`, `docker compose run hrmctl`, `seed/enroll.sh`.
