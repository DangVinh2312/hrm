import { Badge, Group, List, Text } from '@mantine/core';
import { useI18n } from '../../../i18n/i18n.provider';
import type { RoleCapability } from '../administration.client';

export function RoleCapabilities(props: {
  readonly capabilities: readonly RoleCapability[];
  readonly notes?: boolean;
}) {
  const { t } = useI18n();
  if (props.capabilities.length === 0) return null;
  if (props.notes === true)
    return (
      <List size="sm" spacing={4}>
        {props.capabilities.map((capability) => (
          <List.Item key={capability}>
            <Text span fw={600}>
              {t(`administration.roles.capability.${capability}`)}
            </Text>
            {': '}
            {t(`administration.roles.capability.${capability}.note`)}
          </List.Item>
        ))}
      </List>
    );
  return (
    <Group gap="xs">
      {props.capabilities.map((capability) => (
        <Badge key={capability} variant="light" color="yellow" tt="none">
          {t(`administration.roles.capability.${capability}`)}
        </Badge>
      ))}
    </Group>
  );
}
