import { Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import type { ReactNode } from 'react';

/** One titled group of fields; two columns from `sm`, one column on phones. */
export function Section(props: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <Stack gap="sm">
      <Stack gap={2}>
        <Group gap="xs">
          <Title order={3} size="h5">
            {props.title}
          </Title>
          {props.aside}
        </Group>
        {props.hint && (
          <Text size="sm" c="dimmed">
            {props.hint}
          </Text>
        )}
      </Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md" verticalSpacing="md">
        {props.children}
      </SimpleGrid>
    </Stack>
  );
}
