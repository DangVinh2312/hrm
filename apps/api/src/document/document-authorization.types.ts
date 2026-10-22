/** Keys of the `document` fixture fragment (ADR 0032); values are stored strings (never rename). */
export const DocumentResource = { Document: 'document' } as const;

export type DocumentResource = (typeof DocumentResource)[keyof typeof DocumentResource];

export const DocumentAction = { Read: 'read', Update: 'update' } as const;

export type DocumentAction = (typeof DocumentAction)[keyof typeof DocumentAction];

export const DocumentPolicy = { Readable: 'readable', Editable: 'editable' } as const;

export type DocumentPolicy = (typeof DocumentPolicy)[keyof typeof DocumentPolicy];

export const DocumentTemplate = { OwnedDocuments: 'ownedDocuments' } as const;

export type DocumentTemplate = (typeof DocumentTemplate)[keyof typeof DocumentTemplate];

export const DocumentRole = { Reviewer: 'reviewer' } as const;

export type DocumentRole = (typeof DocumentRole)[keyof typeof DocumentRole];
