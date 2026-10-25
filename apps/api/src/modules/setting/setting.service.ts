import {
  ProductAccessDenied,
  type ProductAuthorization,
} from '../../authorization/services/product-authority.service.js';
import { ProductInvalidRequest } from '../../authorization/product-data.gateway.js';
import type { SecurityPolicyView } from '../../config/security-policy.config.js';
import type { InputPage } from '../../infrastructure/helpers/input-validation.helper.js';
import type { SettingCommandRepository } from './repositories/setting-command.repository.js';
import type { SettingReadRepository } from './repositories/setting-read.repository.js';
import { SettingAction, SettingResource } from './setting-authorization.types.js';
import { type SettingKey, settingDefinition } from './setting.registry.js';
import type {
  SettingHistoryView,
  SettingListView,
  SettingProfileView,
  SettingUpdateInput,
} from './setting.types.js';

export const settingCommands = (commands: SettingCommandRepository) =>
  [commands.updateRule, commands.updateProfile] as const;

export const settingQueries = (reads: SettingReadRepository) =>
  [reads.list, reads.profile, reads.history, reads.security] as const;

/**
 * Setting operations bound to the registered commands and queries. A read returns `undefined`
 * when the caller's plan does not reach the settings anchor (no grant): HTTP 404, the same answer
 * for a roleless account and for a page that does not exist. An update without the grant of the
 * key's group is `ProductAccessDenied` (403).
 */
export class SettingService {
  constructor(
    private readonly authorization: ProductAuthorization,
    private readonly commands: SettingCommandRepository,
    private readonly reads: SettingReadRepository,
  ) {}

  /** setting.read, with a display hint of which groups the caller may update. */
  async list(secret: string): Promise<SettingListView | undefined> {
    const settings = await this.authorization.query(secret, this.reads.list, undefined);
    if (!settings) return undefined;
    const [rule = false, profile = false] = await this.authorization.permitsMany(secret, [
      { resource: SettingResource.Setting, action: SettingAction.UpdateRule },
      { resource: SettingResource.Setting, action: SettingAction.UpdateProfile },
    ]);
    return { settings, canUpdate: { rule, profile } };
  }

  profile(secret: string): Promise<SettingProfileView | undefined> {
    return this.authorization.query(secret, this.reads.profile, undefined);
  }

  history(
    secret: string,
    key: SettingKey,
    page: InputPage,
  ): Promise<SettingHistoryView | undefined> {
    return this.authorization.query(secret, this.reads.history, { key, ...page });
  }

  security(secret: string): Promise<SecurityPolicyView | undefined> {
    return this.authorization.query(secret, this.reads.security, undefined);
  }

  /** The new version. The command of the key's group decides; an unknown key never reaches it. */
  async update(secret: string, input: SettingUpdateInput): Promise<{ readonly version: string }> {
    const definition = settingDefinition(input.key);
    if (!definition) throw new ProductInvalidRequest('Unknown setting');
    const command =
      definition.group === 'rule' ? this.commands.updateRule : this.commands.updateProfile;
    const changed = await this.authorization.execute(secret, command, input);
    // The anchor always exists, so "not visible" means no grant (403), as for the work calendar.
    if (!changed) throw new ProductAccessDenied();
    return changed;
  }
}
