import { Group, Modal, Pagination, Stack, Table, Text } from '@mantine/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { QueryState } from '../../../components/query-state.component';
import { useI18n } from '../../../i18n/i18n.provider';
import { useSession } from '../../auth/session.provider';
import { SETTING_HISTORY_PAGE_SIZE } from '../setting.client';
import { useSettingClient } from '../setting-services.provider';

const shown = (value: number | string) => (value === '' ? '—' : String(value));

/** Changes of one key, newest first, each with the old and the new value (append-only on the API). */
export function SettingHistory(props: {
  readonly settingKey: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const client = useSettingClient();
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: [namespace, 'setting', 'history', props.settingKey, page],
    queryFn: ({ signal }) => client.history(props.settingKey, page, signal),
    placeholderData: keepPreviousData,
  });
  const total = Number(history.data?.total ?? '0');
  return (
    <Modal
      opened
      onClose={props.onClose}
      size="lg"
      title={`${t('setting.history.title')}: ${props.label}`}
    >
      <QueryState
        pending={history.isPending}
        error={history.error}
        onRetry={() => history.refetch()}
      >
        {history.data?.items.length === 0 ? (
          <Text c="dimmed">{t('setting.history.empty')}</Text>
        ) : (
          <Stack gap="md">
            <Table.ScrollContainer minWidth={420}>
              <Table verticalSpacing="xs" aria-label={t('setting.history.title')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('setting.history.version')}</Table.Th>
                    <Table.Th>{t('setting.history.old')}</Table.Th>
                    <Table.Th>{t('setting.history.new')}</Table.Th>
                    <Table.Th>{t('setting.history.when')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {history.data?.items.map((item) => (
                    <Table.Tr key={item.version}>
                      <Table.Td>{item.version}</Table.Td>
                      <Table.Td>{shown(item.oldValue)}</Table.Td>
                      <Table.Td>{shown(item.newValue)}</Table.Td>
                      <Table.Td>
                        {new Date(item.changedAt).toLocaleString(
                          locale === 'vi' ? 'vi-VN' : 'en-GB',
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {total > SETTING_HISTORY_PAGE_SIZE && (
              <Group justify="center">
                <Pagination
                  total={Math.ceil(total / SETTING_HISTORY_PAGE_SIZE)}
                  value={page}
                  onChange={setPage}
                  withEdges={false}
                  getControlProps={(control) => ({
                    'aria-label': t(control === 'next' ? 'common.nextPage' : 'common.previousPage'),
                  })}
                />
              </Group>
            )}
          </Stack>
        )}
      </QueryState>
    </Modal>
  );
}
