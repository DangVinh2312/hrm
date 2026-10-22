import type { DataSource } from 'typeorm';
import type { ProductAuditRepository } from '../dist/audit/product-audit.repository.js';
import type { AuthorizationCore } from '../dist/authorization/core/authorization.factory.js';

/** What a CLI command may use: its validated flags, the shared core and per-purpose logins. */
export interface Cli {
  readonly flags: Readonly<Record<string, string>>;
  readonly core: AuthorizationCore;
  readonly audit: ProductAuditRepository;

  readonly source: (purpose: string) => Promise<DataSource>;
}
