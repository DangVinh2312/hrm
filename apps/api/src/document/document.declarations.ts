import type { SystemDeclarations } from '../authorization/core/authorization.declarations.js';
import type { ProductReleaseSource } from '../authorization/services/product-manifest.service.js';
import type { ProductStorageBindings } from '../authorization/product-sql.compiler.js';
import { ProductObligation } from '../authorization/product-capability.types.js';
import {
  DocumentAction,
  DocumentPolicy,
  DocumentResource,
  DocumentRole,
  DocumentTemplate,
} from './document-authorization.types.js';

/**
 * Document capability fragment: data only, composed into the release in authorization/. ADR 0032:
 * a fixture of the authorization core (deny/boundary/fence/stale/Root/audit tests); not HR business
 * and no HTTP route. The release sync cannot remove a resource or its default grant, so it stays.
 */
export const documentDeclarations: Pick<
  SystemDeclarations,
  'resources' | 'policies' | 'templates' | 'boundaries'
> = {
  resources: [
    {
      key: DocumentResource.Document,
      keyKind: 'uuid',
      fields: { title: { kind: 'string' }, ownerId: { kind: 'uuid' }, state: { kind: 'string' } },
      actions: {
        [DocumentAction.Read]: {
          policy: { key: DocumentPolicy.Readable, version: 1 },
          boundary: 'optional',
        },
        [DocumentAction.Update]: {
          policy: { key: DocumentPolicy.Editable, version: 1 },
          boundary: 'optional',
        },
      },
    },
  ],
  policies: [
    {
      key: DocumentPolicy.Readable,
      version: 1,
      contextRequirements: [],
      requiredScope: { op: 'constant', value: true },
      obligations: [],
    },
    {
      key: DocumentPolicy.Editable,
      version: 1,
      contextRequirements: [],
      requiredScope: { op: 'eq', field: 'state', value: { from: 'literal', value: 'draft' } },
      obligations: [{ handler: ProductObligation.Audit }],
    },
  ],
  templates: [
    {
      key: DocumentTemplate.OwnedDocuments,
      version: 1,
      resource: DocumentResource.Document,
      parameters: {},
      expression: { op: 'eq', field: 'ownerId', value: { from: 'principal', name: 'id' } },
    },
  ],
  boundaries: [],
};

export const documentDefaultGrants: ProductReleaseSource['defaultGrants'] = [
  {
    permission: `${DocumentResource.Document}.${DocumentAction.Read}`,
    role: DocumentRole.Reviewer,
    template: { key: DocumentTemplate.OwnedDocuments, version: 1 },
    parameters: {},
  },
];

export const documentBinding: ProductStorageBindings['resources'][number] = {
  resource: DocumentResource.Document,
  table: 'document',
  objectIdColumn: 'object_id',
  keyColumn: 'id',
  columns: { title: 'title', ownerId: 'owner_id', state: 'state' },
  projection: ['title', 'state'],
};
