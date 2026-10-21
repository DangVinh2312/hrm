# ADR 0032 — `document` chỉ còn là fixture của lõi phân quyền, không có HTTP

Ngày: 2026-10-21. **Trạng thái: Accepted** (người dùng chọn phương án C 2026-10-21). Bổ sung [ADR 0031](0031-modules-folder.md); không đổi release, hash manifest/declarations/bindings, migration hay dữ liệu.

## Bối cảnh

Resource `document` (bảng, migration 002, declarations, grant mặc định `document.read` cho role `reviewer`) là mẫu của lõi phân quyền, không phải nghiệp vụ HRM. Muốn xoá hẳn thì release mới phải bỏ resource, nhưng sync hiện tại không làm được trọn vẹn: `applyDefinitions` chỉ chuyển permission biến mất sang `deprecated`, không xoá `resource_type`/policy/template; `removeDefaultGrants` được validate bằng declarations của chính release đó nên không gỡ được grant của permission không còn khai báo; `predecessor` phải khớp release đang chạy nên không tách làm hai release. Xoá hẳn cần đổi lõi sync (ADR riêng) hoặc để lại grant mồ côi.

## Quyết định

1. Gỡ bề mặt HTTP: `DocumentController`, `DocumentModule`, `document.http-port.ts`, `DOCUMENT_HTTP_PORT` và binding ở `runtime.module.ts`, `AppModule` import, `GET /api/documents`, `GET /api/documents/{id}`, `PATCH /api/documents/{id}` (route inventory và OpenAPI). `ProductRuntime` không còn đăng ký allowlist ghi `document.update` (`[]`), nên `update` generic bị tắt trong tiến trình API.
2. Giữ `document/document.declarations.ts`, `document/migrations/product-document.migration.ts` (migration 002, `ProductDocument1792108800002`), bảng và ACL, manifest/release `12`, hash release và bindings. Không migration mới.
3. Test dùng `document` như fixture lõi gọi thẳng `ProductAuthorization` (`list`/`detail`/`update`, truyền allowlist ghi riêng) thay vì HTTP.

## Hệ quả và bằng chứng

- OpenAPI sha256 `b4a0c67e…` → `a7820b4e65c31b61df822ef0c85414d36d32e34bb691d09b2268476ca5f48359` (chỉ bỏ hai path trên).
- `product.e2e-spec.ts`: các lời gọi `/api/documents` đổi sang `ProductAuthorization` tạo trong test với session thật của luồng OIDC (cùng assertion: projection không có `ownerId`, hidden và absent cùng `null`, title injection được lưu nguyên văn, Root stale được ghi, Root fresh ghi, key sai bị từ chối). 401 sau `logout-all` và cookie lạ kiểm bằng `/api/hr/me`; kiểm boot fail dùng `/api/health/live`. Mất coverage HTTP riêng của document: 401 chưa đăng nhập và 400 key sai ở tầng route (route HR giữ 401/404 tương đương). Test integration khác đã gọi `ProductAuthorization` trực tiếp, không đổi.
- `module-boundaries.spec.ts`: đường dẫn giả định của document đổi sang `administration`/`auth`.
- Nếu sau này muốn xoá hẳn: mở rộng sync cho phép gỡ grant theo declarations tiền nhiệm (hoặc tự dọn grant của permission đã deprecated), kèm ADR, release mới, migration drop bảng và xoá `object_ref` kiểu `document`.
