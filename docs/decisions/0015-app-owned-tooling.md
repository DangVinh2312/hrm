# ADR 0015 — App sở hữu tests, tools, env và cấu hình riêng

Ngày: 2026-10-17. Trạng thái: chấp nhận theo yêu cầu trực tiếp tổ chức HRM thành workspace cho nhiều app.

## Bối cảnh

HRM có backend `apps/api`; frontend React/Mantine sẽ được thêm bằng task riêng. Layout kế thừa đặt API tests, CLI, env mẫu và Compose tại root, khiến các app khác phải dùng đường dẫn và dependencies của API.

## Quyết định

- API sở hữu tests/fixtures tại `apps/api/test`, CLI/env parser/test runner tại `apps/api/tools`, env mẫu/local và Compose trong `apps/api`.
- API package sở hữu build/typecheck/test/start/DB/identity scripts, runtime dependencies và test dependencies riêng. Root giữ tooling/tests dùng chung, orchestration và một pnpm workspace/lockfile.
- Root build/typecheck/test gọi scripts của app; root unit command chạy thêm formatting tests chung. DB/identity/start giữ tên lệnh root, forward tới API với cwd `apps/api`.
- API TypeScript config bao phủ source/test/tools cho editor và ESLint; build chỉ emit source, test config giữ erasable syntax cho tools/tests. NodeNext/decorator metadata thuộc backend.
- `apps/api/eslint.config.js` import baseline `eslint.shared.config.js` từ root, áp path tương đối của app khi ESLint tìm config gần từng file. Không làm yếu module boundaries hoặc mở thêm Root bypass.
- Env API và ops vẫn tách riêng; không fallback đọc env root. CLI file paths tương đối resolve từ cwd API; ưu tiên absolute path cho activation artifacts.
- Compose cố định project name `hrm` để giữ namespace volume trước khi chuyển file khỏi root. Task này không chạy Compose, provision/migrate hoặc chuyển dữ liệu.

## Hệ quả và giới hạn

Frontend có package/scripts/config/env/tests riêng khi được triển khai. Root `test/function-spacing.spec.ts` kiểm rule formatting chung; tests behavior/SQL/auth/HTTP thuộc API.

ADR thay ownership tooling trong hướng dẫn cũ; không thay semantics identity/IAM/Root, SQL/schema, migration identifiers, manifests/hashes, runtime credentials, audit hoặc HTTP routes. ADR/plan/verification ledger lịch sử giữ kết quả/đường dẫn tại thời điểm chạy; tài liệu vận hành và kế hoạch HRM hiện tại cập nhật đường dẫn mới.

Docker/PostgreSQL integration và HTTP E2E cần Docker hoạt động; unit/layout pass không chứng nhận suites chưa chạy.

## Kiểm chứng layout — 2026-10-17

Chạy tại `/home/dang_vinh/projects/hrm`, Node 24.15.0 và pnpm 12.3.4. Toolchain/cache tạm ở `/tmp`; không đổi phiên bản khai báo, không commit hoặc chạy thao tác database thật.

| Lệnh đã chạy                                                                                               | Kết quả                                                                                                         |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline --store-dir /tmp/hrm-pnpm-store --state-dir /tmp/hrm-pnpm-state` | Exit 0; lockfile khớp manifests và supply-chain check pass                                                      |
| `pnpm run build`                                                                                           | Exit 0                                                                                                          |
| `pnpm run typecheck`                                                                                       | Exit 0; gồm source, tests/tools API và tests workspace                                                          |
| `pnpm run lint`                                                                                            | Exit 0; tests âm tính module/Root boundaries cũng pass trong unit suite                                         |
| `pnpm run test:unit`                                                                                       | Exit 0; 18 workspace + 228 API tests, 0 fail/skip/cancel                                                        |
| `pnpm run test:unit -- ./apps/api/test/core/key-codec.spec.ts`                                             | Exit 0; path filter từ root có tiền tố `./` hoạt động                                                           |
| `pnpm run format:check`                                                                                    | Exit 1; chỉ `docs/HR_Web_Requirement_Tieng_Viet.md` chưa đúng Prettier, file được giữ nguyên ngoài phạm vi task |
| `pnpm run test:integration -- apps/api/test/product-cli.integration-spec.ts`                               | Exit 1; 2 tests lỗi môi trường: `Could not find a working container runtime strategy`                           |
| `pnpm run test:e2e -- apps/api/test/product.e2e-spec.ts`                                                   | Exit 1; 1 test lỗi cùng container runtime                                                                       |

Đã kiểm diff/links, các file mới/đổi được format có phạm vi, tất cả business source `.ts` và requirement khớp hash trước thay đổi. Runner có regression cases cho unit/smoke/integration/E2E directory filters, cwd khác và các dạng path tương đương. Full PostgreSQL integration chưa chạy; CLI/HTTP behavior với database phải kiểm lại khi Docker hoạt động. Local checks không chứng nhận CI/provider/production.
