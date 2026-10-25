import type { Scalar } from '../../authorization/core/authorization.types.js';

/** `code`: owned by the release, immutable; `runtime`: created through the UI (ADR 0041 §3). */
export type RoleSource = 'code' | 'runtime';

/** One `(permission, template, parameters)` rule of a role, exactly as stored. */
export interface RoleGrantView {
  readonly permission: string;
  readonly effect: 'allow' | 'deny';
  readonly template: string;
  readonly version: number;
  readonly parameters: Readonly<Record<string, Scalar>>;
}

export interface RoleView {
  readonly key: string;
  readonly label: string;
  readonly source: RoleSource;
  /** Number of accounts holding the role (a count only; no account is named). */
  readonly holders: number;
  readonly grants: readonly RoleGrantView[];
}

/** role.read: every role with its grants, code roles first. */
export interface RoleMatrixView {
  readonly roles: readonly RoleView[];
}

/** account.readPermissions: the roles an IAM account holds and the rules that apply to it. */
export interface AccountPermissionView {
  readonly roles: readonly {
    readonly key: string;
    readonly label: string;
    readonly source: RoleSource;
  }[];
  /** `user` marks a rule attached straight to the account (no UI path creates one). */
  readonly grants: readonly (RoleGrantView & { readonly source: 'role' | 'user' })[];
}
