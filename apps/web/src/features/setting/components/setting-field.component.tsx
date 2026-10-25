import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconHistory } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { localeNames } from '../../../i18n/i18n.helper';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../../infrastructure/http.client';
import { useSession } from '../../auth/session.provider';
import type { SettingRow } from '../setting.client';
import {
  draftOf,
  draftValue,
  settingLabelStems,
  unitKeys,
  type KnownSettingKey,
} from '../setting.helper';
import { useSettingClient } from '../setting-services.provider';

/** 403: not allowed (no step-up exists for settings); 409: someone changed it first or nothing changes. */
function failureKey(error: unknown) {
  if (!(error instanceof ApiError)) return 'hr.write.unknown' as const;
  if (error.status === 409) return 'setting.conflict' as const;
  return apiErrorKey(error);
}

/**
 * One setting: label, allowed range, the value in force with its version, an input for a caller
 * who may update the group and the history. The input is built from the bounds the API sends, the
 * save sends the version that was shown (409 when someone changed it first) and every request is
 * authorized again by the API; `editable` only decides whether the form is offered.
 */
export function SettingField(props: {
  readonly row: SettingRow;
  readonly stem: (typeof settingLabelStems)[KnownSettingKey];
  readonly editable: boolean;
  readonly onHistory: () => void;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const client = useSettingClient();
  const queryClient = useQueryClient();
  const { row, stem } = props;
  const [draft, setDraft] = useState(draftOf(row));
  const next = draftValue(row, draft);
  const unchanged = draft === draftOf(row) || next === row.value;
  const labelId = `${row.key}-label`;
  const save = useMutation({
    mutationFn: (value: number | string) => client.update(row.group, row.key, value, row.version),
    onSuccess: async (_result, value) => {
      setDraft(String(value));
      await queryClient.invalidateQueries({ queryKey: [namespace, 'setting'] });
    },
    // A stale version or an unchanged value: show the current state, keep the message.
    onError: () => queryClient.invalidateQueries({ queryKey: [namespace, 'setting', 'list'] }),
  });
  const label = t(`${stem}.label`);
  const common = {
    'aria-labelledby': labelId,
    'aria-invalid': props.editable && next === undefined,
    disabled: save.isPending,
  };
  return (
    <Stack gap="xs" py="sm">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
        <Box flex="1 1 16rem" miw={0}>
          <Text fw={600} id={labelId}>
            {label}
          </Text>
          <Text size="sm" c="dimmed">
            {t(`${stem}.hint`)}
          </Text>
          <Group gap="xs" mt={4}>
            <Badge variant="light" color={row.isDefault ? 'gray' : 'brand'}>
              {row.isDefault ? t('setting.default') : `${t('setting.version')} ${row.version}`}
            </Badge>
            {row.kind === 'int' && (
              <Text size="xs" c="dimmed">
                {`${row.min}–${row.max} ${t(unitKeys[row.unit])}`}
              </Text>
            )}
          </Group>
        </Box>
        <Group gap="xs" align="flex-start" wrap="wrap">
          {props.editable ? (
            <>
              {row.kind === 'int' && (
                <NumberInput
                  {...common}
                  w={160}
                  value={draft}
                  min={row.min}
                  max={row.max}
                  allowDecimal={false}
                  allowNegative={false}
                  clampBehavior="none"
                  onChange={(value) => setDraft(String(value))}
                />
              )}
              {row.kind === 'text' && (
                <TextInput
                  {...common}
                  w={260}
                  value={draft}
                  maxLength={row.maxLength * 2}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                />
              )}
              {row.kind === 'enum' && (
                <Select
                  {...common}
                  w={180}
                  allowDeselect={false}
                  data={row.values.map((value) => ({
                    value,
                    label: value === 'vi' || value === 'en' ? localeNames[value] : value,
                  }))}
                  value={draft}
                  onChange={(value) => setDraft(value ?? draft)}
                />
              )}
              <Button
                loading={save.isPending}
                disabled={unchanged || next === undefined}
                aria-label={`${t('common.save')} ${label}`}
                onClick={() => {
                  if (next !== undefined) save.mutate(next);
                }}
              >
                {t('common.save')}
              </Button>
            </>
          ) : (
            <Text fw={500}>
              {row.kind === 'enum' && (row.value === 'vi' || row.value === 'en')
                ? localeNames[row.value]
                : row.value === ''
                  ? '—'
                  : String(row.value)}
            </Text>
          )}
          <Button
            variant="subtle"
            color="gray"
            leftSection={<IconHistory size={16} stroke={1.75} aria-hidden />}
            aria-label={`${t('setting.history.open')} ${label}`}
            onClick={props.onHistory}
          >
            {t('setting.history.open')}
          </Button>
        </Group>
      </Group>
      {props.editable && next === undefined && (
        <Text size="xs" c="red" role="alert">
          {t('setting.invalid')}
        </Text>
      )}
      {save.isSuccess && !save.isPending && (
        <Text size="xs" role="status">
          {t('setting.saved')}
        </Text>
      )}
      {save.isError && (
        <Alert color="red" icon={<IconAlertCircle size={18} aria-hidden />} role="alert">
          {t(failureKey(save.error))}
        </Alert>
      )}
    </Stack>
  );
}
