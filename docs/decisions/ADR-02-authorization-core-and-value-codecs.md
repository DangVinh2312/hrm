# ADR-02 — Lõi phân quyền thuần, SQL compiler, boundary và value codec

Thay thế các ADR cũ: 0002, 0003, 0009 (phần liên quan; xem bảng ánh xạ ở [README](README.md)).

Trạng thái: hiện hành. Lõi ở `apps/api/src/authorization/core`, codec ở `authorization/values`, compiler và gateway ở `authorization/product-sql.compiler.ts`, `product-data.gateway.ts`. Hợp đồng boundary chi tiết: [permission-boundaries](../permission-boundaries.md).

## Quyết định

### Lõi quyết định

- Hai tầng AST: `Expr` (khai báo do mã hệ thống viết, có `ValueRef`) và `PlanExpr` (đã hạ kiểu, mọi giá trị đã bind). Compiler và evaluator chỉ nhận `PlanExpr`. `not` và `exception` chỉ do lõi tạo; validator từ chối mọi operator, node hay nguồn giá trị lạ (fail closed). Không có node tham chiếu template/policy khác nên không có vòng tham chiếu.
- `P = requiredScope AND (allow scopes OR record allow) AND NOT (deny scopes OR record deny)`; user, policy, boundary, context validator và obligation được kiểm trước. Một rule hỏng (template, tham số, kiểu) làm cả quyết định deny, không bỏ qua rule. Default deny; deny thắng allow.
- NULL: so sánh với NULL không khớp. Để `NOT D` không thành NULL trong SQL, template dùng cho deny không được so sánh field nullable ngoài `exists` (dùng `isNull` tường minh); vi phạm là deny lúc plan.
- Contract một sản phẩm: `UserTrustedInput`, `UserAuthoritySnapshot.user`, `UserAuthorizedPlan.userId`, facts không tenant. Lõi không biết Root: `planUnrestricted` giữ mọi kiểm tra target/principal/user/validity của `planUser`, tra policy của action và chạy `contextRequirements` của policy (vd `fresh@1`), nhưng bỏ grant, deny, `requiredScope` và boundary (xem [ADR-05](ADR-05-root-iam-boundaries-account-invariants.md)). ESLint chặn dùng tên `planUnrestricted` ngoài `product-authority.service.ts`, `core/authorization.factory.ts` và `test/core/**`; đây là ranh giới developer, không phải sandbox.
- `validate` trả bản đóng băng cùng `canonical` JSON không phụ thuộc thứ tự khai báo; `plan` chỉ nhận declarations do `validate` của cùng instance tạo. Lõi không có crypto: adapter băm `canonical` (SHA-256).
- Path ReBAC tối đa 8 bước (`MAX_PATH_DEPTH`); ReBAC kiểm source/target type, exact version và hạn trên từng cạnh; không đệ quy vô hạn, không SQL callback tùy ý.
- Validator ngữ cảnh và obligation handler là registry của adapter; lõi chỉ nhận kết quả `true`. `false`, `'unknown'`, throw hoặc thiếu handler đều deny.
- Exception `purpose = 'emergency'` không bao giờ cấp quyền; deny exception luôn có hiệu lực.
- Kiểu dữ liệu: integer là chuỗi thập phân int64 chuẩn hoặc `bigint`, JS `number` bị từ chối; decimal so sánh chính xác bằng chuỗi; chuỗi so theo code point (= thứ tự byte UTF-8 = `COLLATE "C"`); timestamp UTC, 6 chữ số thập phân.
- Property test dùng PRNG có seed viết trong test (không `fast-check`); đổi algebra cần mutation check (bỏ conjunct phải làm test đỏ). Bất biến ghim bằng property test: thêm deny không mở rộng tập được phép (`test/core/decision.spec.ts`); boundary đã bind không mở rộng tập được phép (`test/core/permission-boundary.spec.ts`).

### Permission boundary

- Boundary là giới hạn tổng quát theo user và permission, không phải grant: `Allow = HardInvariants AND PermissionPolicy AND EffectiveBoundary AND (RoleAllow OR DirectAllow OR RecordAllow) AND NOT AnyDeny`. Biểu diễn bằng cùng typed AST, AND ngoài mọi allow kể cả record exception; không engine biểu thức thứ hai. `ApplicationRoleBoundary` chỉ là ví dụ cấu hình.
- Một binding cho mỗi `(user, permission)`; nhiều permission có thể cùng trỏ một definition. Action khai báo `boundary: 'required'` hoặc `'optional'` tường minh (không có mặc định). `required` thiếu binding, definition, version, entry hay facts: deny. `optional` không có binding: boundary là true; có binding thì vẫn bắt buộc thi hành. Không kế thừa boundary từ role, không nhiều binding (chưa có use case; mở rộng cần ngữ nghĩa phép giao được kiểm chứng).
- Definition code-owned, version bất biến; boot chỉ đồng bộ seed code-owned và không ghi đè binding runtime. Assignment boundary chỉ hạn chế các lần gán sau, không tự thu hồi quyền đã cấp. Boundary áp cho mọi đường (endpoint, job, internal service), không chỉ decorator.
- Thiếu facts hoặc không chứng minh được tập con thì từ chối; không giải containment của biểu thức tùy ý.

### SQL compiler và gateway

- `BindingRegistry` kiểm lúc khởi tạo: mọi resource/field có binding, identifier an toàn, projection thuộc field đã khai báo. Giá trị luôn là bind parameter (raw dùng `$n`, QueryBuilder dùng tên duy nhất theo process); không thay chuỗi SQL bằng regex; identifier chỉ từ binding đã đăng ký. Domain binding tới đích không phải identity chưa được hỗ trợ và làm khởi tạo registry (readiness) lỗi.
- So khóa chính bằng bind có kiểu (`CAST($n AS int8|uuid|text)`), không cast cột. Mọi cạnh kiểm cửa sổ hiệu lực bằng `statement_timestamp()`; hạn của plan cũng kiểm bằng đồng hồ DB trong cùng statement.
- List, detail, count, export và write dùng cùng AST; không lọc quyền sau phân trang. `DataGateway`: `count(*) OVER ()` để tổng và trang cùng statement; filter người dùng chỉ trên field projection, bọc AND sau predicate (tối đa 32 node); `limit` mặc định 20, tối đa 100; `offset` tối đa 10 000; sắp xếp luôn có khóa tie-break; integer/decimal/timestamp trả dạng text chuẩn. QueryBuilder bridge chỉ trả bảng dẫn xuất đã lọc quyền có `key` + projection; `.where()` và `.orWhere()` của handler không gỡ được predicate; join sang resource khác chỉ qua `subQuery(plan)` của chính resource đó.
- Gateway nhận transaction mà plan phải cùng revision với fence đang giữ ([ADR-03](ADR-03-fence-transactions-manifest-sync.md)).

### Value codec và engine identity

- Core khai báo `ValueCodecs` ở `core/ports/value-codecs.port.ts` với sáu kind cố định: `timestamp`, `integer`, `decimal`, `uuid`, `string`, `boolean`. Mỗi kind là `ScalarCodec` (`normalize(input) -> T | undefined`, `compare(l, r) -> -1|0|1`). `normalize` không dùng clock, timezone máy, trim hay parse lỏng; `compare` chỉ nhận giá trị đã normalize. Không có `registerKind`, SQL callback hay codec mặc định. Boolean/UUID chỉ equality. Codec thiếu/sai hình dạng throw khi tạo; codec throw hoặc trả sai thì mọi đường quyết định thành deny, `validate` trả `{ ok: false }` không echo input.
- Timestamp strict: chỉ UTC `YYYY-MM-DDTHH:mm:ss[.f{1..6}]Z`, năm `0001..9999` (năm `0001`/`0099`/`0100` phải round-trip, không thu hẹp domain), đầu ra luôn sáu chữ số lẻ, microsecond giữ dạng chuỗi không qua `Date`. Từ chối ngày không tồn tại, tháng/ngày 0, giờ 24, giây 60, quá sáu chữ số lẻ, offset, thiếu `Z`, whitespace, trailing junk; không truncate, round hay đổi timezone. Regex chỉ kiểm grammar, không chứng minh ngày lịch hợp lệ.
- Adapter đầu tiên: Day.js (`CustomParseFormat` strict + `utc`), ở `authorization/values/codecs/`. Adapter mới (vd Moment) chỉ thêm khi có consumer và phải vượt cùng conformance suite (`test/values/value-codecs.spec.ts`) cùng parity với PostgreSQL (`product-values.integration-spec.ts`).
- `createAuthorizationCore({ values })` trả instance; provenance của declarations, release (`prepareProductRelease`), binding registry và service gắn với đúng instance (WeakSet, không vào canonical JSON hay hash manifest). Declarations validate bởi instance A bị từ chối ở instance B. Không có engine toàn cục, không plugin manager, service locator hay DI container trong core, không cache allow, không phân vùng fence; composition root (`product.manifest.ts#createProductAuthorizationCore`, dùng bởi `ProductRuntime` và `tools/product.ts`) chọn adapter.
- Integer/decimal không round-trip qua JS `number`; time adapter không thay clock có thẩm quyền của DB.

## Quyết định của người dùng

- Thay đổi hành vi timestamp (từ chối giá trị trước đây được nhận) là có chủ ý; không rewrite dữ liệu hay audit lịch sử.

## Chưa làm / điều mở

- Raw SQL template đã đăng ký (slot predicate), `mutate` pre/post state ở lõi, JSON Schema/Ajv cho tham số template (hiện dùng map tên → `FieldKind`).
- Adapter thời gian thứ hai và export dùng lại của bộ conformance.
