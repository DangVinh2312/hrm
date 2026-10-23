// Release 15 (T8 `attendance.adjust`) rebuilt from today's source: release 16 (user decision
// 2026-10-22) changed only the three HR role labels, from Vietnamese ('Nhân viên', 'COO (duyệt
// cuối)', 'HR/Admin') to English. Role labels are part of the release hash, so the pinned hash
// proves the rebuild equals the published release 15.
import type { ProductReleaseSource } from '../../dist/authorization/services/product-manifest.service.js';
import { productReleaseSource } from '../../dist/authorization/product.manifest.js';

/** Published hash of release 15 (structure.spec.ts before release 16). */
export const releaseFifteenHash =
  '56d9c740bc754405121f2959638c35447b2e9e2a8cda735ef288cc1b54c2f153';

const releaseFifteenRoleLabels: Readonly<Record<string, string>> = {
  'hr.employee': 'Nhân viên',
  'hr.coo': 'COO (duyệt cuối)',
  'hr.admin': 'HR/Admin',
};

export const releaseFifteenSource: ProductReleaseSource = {
  ...productReleaseSource,
  sequence: '15',
  predecessor: '14',
  roles: productReleaseSource.roles.map((role) => ({
    key: role.key,
    label: releaseFifteenRoleLabels[role.key] ?? role.label,
  })),
};
