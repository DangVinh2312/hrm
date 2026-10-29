# ADR-01 — Workspace, cấu trúc module, quy ước mã và kiểm thử

Thay thế các ADR cũ: 0001, 0009, 0013, 0014, 0015, 0016, 0031, 0032, 0033, 0034, 0035, 0036, 0038 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Một sản phẩm, một tổ chức, không tenant. Gốc của mọi ADR sau.

## Quyết định

### Runtime và workspace

- Node 24 (`.nvmrc`, `engines` `>=24.15.0 <25`), pnpm theo `packageManager`, một `pnpm-lock.yaml`, workspace `apps/*` (`apps/api`, `apps/web`). `engineStrict`, `strictPeerDependencies`, `saveExact`. Phiên bản từng package lấy từ `package.json`/lockfile, không chép vào tài liệu.
- Toàn workspace ESM (`"type": "module"`, `module`/`moduleResolution: nodenext`, `verbatimModuleSyntax`). `experimentalDecorators` + `emitDecoratorMetadata` chỉ ở `apps/api`; lõi phân quyền không dùng decorator. Test và tool viết bằng TypeScript chỉ dùng cú pháp xóa được (`erasableSyntaxOnly`) vì Node chạy bằng type stripping.
- Test runner `node:test` + `node:assert` (Nest ESM-only; Vitest không phát decorator metadata giống `tsc`). Test chạy trên output `tsc`. Web dùng Vitest + Testing Library và Playwright.
- Build script của dependency tắt (`allowBuilds`: `cpu-features`, `protobufjs`, `ssh2`); bật lại chỉ khi biết lý do và giới hạn đúng package.
- Một NestJS app `apps/api`, một React SPA `apps/web`. Không có package nội bộ, SDK hay project reference giữa library; module import tương đối trực tiếp tới file sở hữu (đuôi `.js` ở API), không barrel. Không tenant: không tenant giả, `tenantId` tùy chọn hay flag bỏ isolation; không tạo lại contract tenant.
- Mỗi app sở hữu test, tool, env, Compose, script và dependency riêng: API ở `apps/api/{test,tools}`, env `.env.api`/`.env.ops` chỉ đọc trong app, không fallback về root. Root chỉ giữ orchestration, tooling và test dùng chung (`test/function-spacing.spec.ts`, `test/locale-keys.spec.ts`). Compose cố định project name `hrm`. `apps/api/eslint.config.js` import baseline `eslint.shared.config.js` của root.

### Cấu trúc `apps/api/src`

- `modules/` chứa nghiệp vụ: `permission`, `employee`, `team`, `work-request`, `leave`, `attendance`, `work-calendar`, `report`, `setting`, `role`. Nền tảng ở `src/`: `authorization`, `authentication`, `administration`, `audit`, `database`, `infrastructure`, `health`, `openapi`, `config`, `document`. Module nghiệp vụ chỉ import nền tảng và `modules/permission`, không import lẫn nhau trừ qua port/token; nền tảng không import `modules/` ngoại trừ nơi ghép (`app.module.ts`, `infrastructure/`, `authorization/product.manifest.ts`, `tools/product.ts`). Quy tắc này chưa được ESLint enforce và đã bị vi phạm (`leave` import `employee`/`attendance`/`work-request`, `employee` import `report`/`setting`; ví dụ `leave.service.ts`, `employee.service.ts`); thêm rule kèm negative test khi dọn.
- Khai báo quyền nằm ở module sở hữu: `<module>.declarations.ts` + `<module>-authorization.types.ts`; phần dùng chung (role, policy `hrRead`/`hrSubmit`/`hrWrite`/`hrFresh`, resource `hrCompany`, boundary, builder `permission-declaration.helper.ts`) ở `modules/permission/`. Hằng có kiểu là `as const` object cùng union dẫn xuất, không TypeScript `enum`; core vẫn chỉ nhận `string`. Giá trị chuỗi là dữ liệu đã lưu (manifest, DB, audit): chỉ thêm member, không đổi giá trị. `test/authorization-keys.spec.ts` ghim giá trị.
- Tên `hr` chỉ còn ở giá trị đã lưu hoặc hợp đồng công bố: role `hr.*`, policy `hrRead`…, resource `hrCompany`, boundary `hrAdministration`, bảng/view/hàm `hr_*`, route `/api/hr/*`, kind audit `hr.*`, tên sản phẩm `hrm`. Không có module hay folder `hr`.
- `document` chỉ là fixture của lõi phân quyền, không controller/route/DTO; test gọi thẳng `ProductAuthorization`. Resource `document` không gán được cho role runtime.
- Web: `apps/web/src/{app,components,infrastructure,i18n,features}`; `features/` số ít (`auth`, `account`, `administration`, `setting`, `home`, `employee`, `team`, `work-request`, `leave`, `attendance`, `work-calendar`, `report`), mỗi feature sở hữu client và context của nó; không `shared/`, không thư mục hay định danh `hr`. `src/components/` là ngoại lệ có tên của "không `shared/`": chỉ UI thuần dùng chung từ hai feature trở lên, không import `features/` hay `app/`. Quy tắc riêng: `apps/web/AGENTS.md`.

### Quy ước mã (đã có ESLint hoặc test)

- Tên file `<kebab-case>.<vai-trò>.ts`; module số ít; hai file cùng vai trò trở lên thì vào folder số nhiều.
- Giới hạn 300 dòng không tính dòng trống/comment cho file trong `apps/api/src` và `apps/web/src` (ESLint `max-lines`, mức `error`, `fileSizeLimit` trong `eslint.shared.config.js`). Miễn `*.declarations.ts`, `*.schema.ts`, `*.migration.ts`, `*.manifest.ts` và test. Ngoại lệ tạm là danh sách `fileSizeLimit([...])` trong `apps/api/eslint.config.js` (hiện `product-mfa.service.ts`, `policy.validator.ts`, `product-authority.service.ts`): tách khi chạm tới, không thêm file vào danh sách. Kiểm: `test/file-size-limit.spec.ts` (ESLint thật).
- Mọi `*.repository.ts` trong `apps/api/src` export một class `XxxRepository` (người dùng chốt). `ProductCommand`/`ProductQuery` là field `readonly`; dependency qua constructor vào `#private`; `EntityManager` của transaction luôn truyền vào method, không giữ trong field; instance tạo ở composition root (`ProductRuntime.create`, `createProductModules` trong `infrastructure/product-modules.factory.ts`, `tools/product.ts`, test stack), không Nest DI, service locator hay singleton. Ngoại lệ có chủ đích: repository SQL không trạng thái chỉ dùng nội bộ một service hoặc migration (5 repository manifest trong `ProductManifestReconciler`, `ProtectedStateRepository` ở migration) tạo tại chỗ.
- `*.helper.ts` dưới `src/` đồng bộ: không `async`/`await`/`Promise` (ESLint `no-restricted-syntax`, kiểm `test/helper-sync.spec.ts`); effect async thuộc repository/service. Bốn selector `planUnrestricted` được lặp lại trong block helper để không bị ghi đè.
- SQL chọn cột tường minh: không `SELECT *`, `alias.*`, `RETURNING *`, `row_to_json`, `to_jsonb(hàng)` trong `src/` (trừ `migrations/`). Cho phép có lý do: `SELECT * FROM <cte>` khi CTE tự liệt kê cột; bọc ngoài subquery đã chọn cột; `to_jsonb` trong `protected-state.repository.ts` (định nghĩa của `materialized_hash`); `SELECT … LIMIT 0` kiểm cột lúc boot. Kiểm: `test/explicit-columns.spec.ts` (quét văn bản, không phân tích SQL).
- Ranh giới module: ESLint + `test/module-boundaries.spec.ts` (kèm negative case và Root bypass) là ranh giới developer, không phải process isolation. `test/structure.spec.ts` ghim route inventory, DI và OpenAPI.
- HTTP handler (controller, http-port, module của nền tảng và nghiệp vụ) bị ESLint chặn import runtime `authorization/repositories/**` và `authorization/services/**` (chỉ `import type`). Lệnh Root lifecycle, provisioning và registry migration (`productDataSourceOptions`, `productMigrations`, `provisionProductDatabase`) bị `offlineImports` chặn trong `src/`, chỉ gọi từ tool offline (`apps/api/tools`); đây là ranh giới developer.
- `productBindings` (`authorization/product.manifest.ts`) được ghim bằng SHA-256 của `JSON.stringify` trong `structure.spec.ts`, nên thứ tự binding trong manifest là một phần của hash; đổi thứ tự là re-pin có chủ ý.
- `document` còn là fixture nên không gỡ hẳn được bằng sync: sync không xóa resource type, policy hay template (chỉ default grant, seed và binding seed; permission biến mất thành `deprecated`), và `predecessor` phải khớp release hiện tại; gỡ hẳn cần đổi lõi sync và ADR. `ProductRuntime` không đăng ký allowlist ghi cho `document.update`.

### Kiểm thử hạ tầng

- Integration dùng PostgreSQL thật (Testcontainers, image khai ở `apps/api/test/setup-postgres.ts`), credentials sinh ngẫu nhiên; không SQLite.
- `tools/test.ts integration` khởi MỘT container (`max_connections=300`) khi có file dùng `startModuleStack(`, dựng template database `tpl_module_<digest>` (digest = sha256 của `dist/**/*.js` cùng các helper template) và truyền cấu hình qua env `HRM_TEST_PG`; mỗi file nhận database riêng bằng `CREATE DATABASE … TEMPLATE …` và `DROP DATABASE … WITH (FORCE)` khi xong.
- Opt-in, không opt-out ngầm: `startPostgres()` mặc định vẫn là container riêng; chỉ `{ shared: true }` dùng container chung và chỉ khi có `HRM_TEST_PG`. Env sai dạng là lỗi, không fallback. File cần cluster riêng (role/ACL cấp cluster, kill session, migration từng bước, CLI offline, đo thời gian) dùng `isolated`.
- Role `product_*` là cấp cluster với tên cố định trong migration, nên mọi database của cluster chung dùng chung một bộ mật khẩu synthetic; query đếm session theo role phải lọc `datname = current_database()`.
- Lỗi port-bind của Testcontainers thử lại tối đa 3 lần chỉ khi thông báo chứa `ports to be bound`; `withStartupTimeout(120_000)`; lỗi khác không retry.

## Quyết định của người dùng

- Một NestJS app, bỏ tenant và mọi compatibility legacy; dữ liệu ngoài fixture disposable không được chuyển (chưa có server thật).
- Không có tên `hr` trong cấu trúc: mọi thứ quy về role và permission; dọn tên `hr` cả ở web (không còn `features/hr`).
- Mọi repository là class (ghi đè quy ước "class chỉ khi có dependency thật", chỉ cho repository).
- Helper không `async`; tách `max-lines` ngay các service lớn.
- Test dùng chung container + template database; cả hai phương án được chọn.

## Chưa làm / điều mở

- Rule ESLint cho "module không import lẫn nhau" và "nền tảng không import `modules/`" (cần negative test).
- Đưa các file test integration còn lại (`product-*` dựng stack riêng) sang container chung: chưa chứng minh không an toàn, chỉ chưa làm; mỗi file cần đổi sang mật khẩu chung và/hoặc template riêng.
- Ba file còn trong danh sách ngoại lệ `max-lines`.

Tài liệu liên quan: [architecture](../architecture.md), [operations](../operations.md).
