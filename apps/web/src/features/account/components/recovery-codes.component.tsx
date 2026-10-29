import { Button, Code, CopyButton, Group, List, Stack, Text, Title } from '@mantine/core';
import { IconCopy, IconDownload } from '@tabler/icons-react';
import { useI18n } from '../../../i18n/i18n.provider';

/** A local text file built in the page; nothing leaves the browser. */
function download(codes: readonly string[]): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'hrm-recovery-codes.txt';
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Recovery codes, shown once after enrollment or regeneration. The parent holds them
 * in component state only and drops them when the user confirms they are saved.
 */
export function RecoveryCodes(props: {
  readonly codes: readonly string[];
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  return (
    <Stack gap="sm">
      <Title order={3} size="h4">
        {t('mfa.codes.title')}
      </Title>
      <Text size="sm">{t('mfa.codes.body')}</Text>
      <List listStyleType="none" spacing={4}>
        {props.codes.map((code) => (
          <List.Item key={code}>
            <Code fz="sm">{code}</Code>
          </List.Item>
        ))}
      </List>
      <Group gap="sm">
        <CopyButton value={props.codes.join('\n')}>
          {({ copied, copy }) => (
            <Button
              variant="default"
              leftSection={<IconCopy size={18} stroke={1.75} aria-hidden />}
              onClick={copy}
            >
              {t(copied ? 'mfa.setup.copied' : 'mfa.codes.copy')}
            </Button>
          )}
        </CopyButton>
        <Button
          variant="default"
          leftSection={<IconDownload size={18} stroke={1.75} aria-hidden />}
          onClick={() => download(props.codes)}
        >
          {t('mfa.codes.download')}
        </Button>
        <Button onClick={props.onDone}>{t('mfa.codes.done')}</Button>
      </Group>
    </Stack>
  );
}
