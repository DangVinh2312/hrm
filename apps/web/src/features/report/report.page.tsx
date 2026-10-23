import {
  Alert,
  Card,
  Group,
  NativeSelect,
  Pagination,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../auth/session.provider';
import { QueryState } from '../../components/query-state.component';
import { useReportClient } from './report-services.provider';
import { useI18n } from '../../i18n/i18n.provider';
import { ReportExport } from './components/report-export.component';
import { ReportTable } from './components/report-table.component';
import { REPORT_PAGE_SIZE } from './report.client';
import {
  type ReportInputs,
  filterOf,
  initialInputs,
  isFilter,
  isReportKind,
  kindKeys,
  reportKinds,
} from './report.helper';
import { useMenus } from '../auth/me.provider';

/**
 * Six HR reports and their XLSX (T9). Menu `reports` is a display hint from the server: without it
 * the page is "not found" and asks for nothing; with it the API still authorizes every request.
 */
export function ReportPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const report = useReportClient();
  const menus = useMenus();
  const [inputs, setInputs] = useState<ReportInputs>(initialInputs);
  const [pageNumber, setPageNumber] = useState(1);
  const checked = filterOf(inputs);
  const filter = isFilter(checked) ? checked : undefined;
  const allowed = menus.data?.menus.includes('reports') === true;
  const rows = useQuery({
    queryKey: [namespace, 'report', filter ?? null, pageNumber],
    enabled: allowed && filter !== undefined,
    queryFn: async ({ signal }) => {
      if (!filter) throw new Error('Invalid filter');
      return report.page(filter, pageNumber, signal);
    },
    placeholderData: keepPreviousData,
  });
  const change = (patch: Partial<ReportInputs>) => {
    setInputs((current) => ({ ...current, ...patch }));
    setPageNumber(1);
  };
  const pages = Math.max(1, Math.ceil(Number(rows.data?.total ?? '0') / REPORT_PAGE_SIZE));
  const monthly = inputs.kind !== 'leave' && inputs.kind !== 'seniority';
  const problem = isFilter(checked) ? undefined : checked;

  return (
    <Stack gap="lg">
      <div>
        <Title order={1}>{t('report.title')}</Title>
        <Text c="dimmed" mt={4}>
          {t('report.description')}
        </Text>
      </div>
      <Card padding="lg">
        <QueryState pending={menus.isPending} error={menus.error} onRetry={() => menus.refetch()}>
          {!allowed ? (
            <Alert
              color="gray"
              title={t('notFound.title')}
              icon={<IconAlertCircle size={18} aria-hidden />}
            >
              {t('notFound.body')}
            </Alert>
          ) : (
            <Stack gap="lg">
              <Group align="flex-start" gap="md">
                <NativeSelect
                  label={t('report.kind')}
                  value={inputs.kind}
                  data={reportKinds.map((kind) => ({ value: kind, label: t(kindKeys[kind]) }))}
                  onChange={(event) => {
                    const kind = event.currentTarget.value;
                    if (isReportKind(kind)) change({ kind });
                  }}
                />
                {monthly ? (
                  <>
                    <TextInput
                      type="month"
                      label={t('report.from')}
                      value={inputs.from}
                      min="1900-01"
                      max="2100-12"
                      onChange={(event) => change({ from: event.currentTarget.value })}
                    />
                    <TextInput
                      type="month"
                      label={t('report.to')}
                      value={inputs.to}
                      min="1900-01"
                      max="2100-12"
                      onChange={(event) => change({ to: event.currentTarget.value })}
                    />
                  </>
                ) : (
                  <TextInput
                    type="date"
                    label={t('report.asOn')}
                    value={inputs.asOn}
                    onChange={(event) => change({ asOn: event.currentTarget.value })}
                  />
                )}
              </Group>
              {problem && (
                <Alert color="red" icon={<IconAlertCircle size={18} aria-hidden />}>
                  {t(problem)}
                </Alert>
              )}
              <ReportExport key={JSON.stringify(filter)} filter={filter} />
              {filter && (
                <QueryState
                  pending={rows.isPending}
                  error={rows.error}
                  onRetry={() => rows.refetch()}
                >
                  {rows.data?.rows.length === 0 ? (
                    <Text c="dimmed">{t('report.empty')}</Text>
                  ) : (
                    rows.data && (
                      <Stack gap="sm">
                        <Text
                          size="sm"
                          c="dimmed"
                        >{`${t('report.total')}: ${rows.data.total}`}</Text>
                        <ReportTable result={rows.data} />
                      </Stack>
                    )
                  )}
                  {pages > 1 && (
                    <Pagination total={pages} value={pageNumber} onChange={setPageNumber} />
                  )}
                </QueryState>
              )}
            </Stack>
          )}
        </QueryState>
      </Card>
    </Stack>
  );
}
