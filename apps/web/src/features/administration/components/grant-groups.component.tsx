import { Badge, Group, Stack, Text } from '@mantine/core';
import { useI18n } from '../../../i18n/i18n.provider';
import type { RoleGrant } from '../administration.client';
import { grantScopeText, groupByResource } from '../role.helper';

/**
 * Rules grouped by resource, as plain badges: `action · scope`, with "denied" or "attached
 * directly" spelled out in words (never by colour alone). Display only.
 */
export function GrantGroups(props: {
  readonly grants: readonly (RoleGrant & { readonly source?: 'role' | 'user' })[];
}) {
  const { t } = useI18n();
  return (
    <Stack gap="sm">
      {groupByResource(props.grants).map((group) => (
        <div key={group.resource} role="group" aria-label={group.resource}>
          <Text fw={600} size="sm" mb={4}>
            {group.resource}
          </Text>
          <Group gap="xs">
            {group.items.map((grant) => {
              const notes = [
                grant.effect === 'deny' ? t('administration.roles.deny') : null,
                grant.source === 'user' ? t('administration.roles.direct') : null,
              ].filter((note) => note !== null);
              return (
                <Badge
                  key={`${grant.action}/${grant.version}/${grantScopeText(grant)}/${grant.effect}/${grant.source ?? ''}`}
                  variant="light"
                  color={grant.effect === 'deny' ? 'red' : 'gray'}
                  tt="none"
                >
                  {`${grant.action} · ${grantScopeText(grant)}${notes.length ? ` (${notes.join(', ')})` : ''}`}
                </Badge>
              );
            })}
          </Group>
        </div>
      ))}
    </Stack>
  );
}
