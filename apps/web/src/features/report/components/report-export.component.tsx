import { Alert, Button, Stack } from '@mantine/core';
import { IconAlertCircle, IconDownload } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError, apiErrorKey } from '../../../infrastructure/http.client';
import { useReportClient } from '../report-services.provider';
import type { ReportFilter } from '../report.client';
import { saveFile } from '../report.helper';

/**
 * XLSX of the whole scoped set. The API answers 403 both for a caller without the report role and
 * for one whose scope holds no row, so the page says both; 422 is its own closed key. Leaving the
 * page aborts a running request (the API then stops and stores nothing).
 */
export function ReportExport(props: { readonly filter: ReportFilter | undefined }) {
  const { t } = useI18n();
  const report = useReportClient();
  const running = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => running.current?.abort(), []);
  const download = useMutation({
    mutationFn: async (filter: ReportFilter) => {
      const controller = new AbortController();
      running.current = controller;
      const file = await report.download(filter, controller.signal);
      if (!controller.signal.aborted) saveFile(file.blob, file.fileName);
    },
  });
  const { error } = download;
  const denied = error instanceof ApiError && error.status === 403;
  return (
    <Stack gap="sm">
      <Button
        leftSection={<IconDownload size={18} aria-hidden />}
        variant="light"
        loading={download.isPending}
        disabled={props.filter === undefined}
        onClick={() => props.filter && download.mutate(props.filter)}
        w="fit-content"
      >
        {t('report.export')}
      </Button>
      {error && (
        <Alert
          color="red"
          title={t('report.export.failedTitle')}
          icon={<IconAlertCircle size={18} aria-hidden />}
          role="alert"
        >
          {t(denied ? 'report.export.denied' : apiErrorKey(error))}
        </Alert>
      )}
    </Stack>
  );
}
