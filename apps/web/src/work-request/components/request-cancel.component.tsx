import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconBan } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../hr/components/mutation-error.component';
import { useHrMe, useHrServices } from '../../hr/hr-services.provider';
import { useI18n } from '../../i18n/i18n.provider';
import { ApiError } from '../../infrastructure/http.client';
import type { CancelInput, RequestDetail } from '../work-request.client';

/**
 * Cancel (design §6.2 D06): the owner cancels a pending request, HR an approved one with a
 * mandatory reason. The button follows the owner/company-scope hints only; the API decides, so a
 * refusal is shown, never assumed. One idempotency key per distinct cancel: a retry after a lost
 * answer or a refusal reuses it; another reason or version gets a new one.
 */
export function RequestCancel(props: { readonly request: RequestDetail }) {
  const { request } = props;
  const { t } = useI18n();
  const { namespace } = useSession();
  const { workRequest } = useHrServices();
  const me = useHrMe().data;
  const queryClient = useQueryClient();
  const [opened, dialog] = useDisclosure();
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const attempt = useRef<{ readonly body: string; readonly key: string } | undefined>(undefined);
  const approved = request.state === 'approved';
  const pending = request.state === 'pending_lead' || request.state === 'pending_final';
  const visible =
    me !== undefined &&
    ((pending && me.employee?.id === request.employeeId) || (approved && me.companyScope));
  const cancel = useMutation({
    mutationFn: (input: CancelInput) => {
      const body = JSON.stringify([request.id, input]);
      if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
      return workRequest.cancel(request.id, input, attempt.current.key);
    },
    onSuccess: async () => {
      attempt.current = undefined;
      dialog.close();
      setReason('');
      // The state moved: detail, lists, queues, and what the request fed (leave, timesheet).
      for (const area of ['requests', 'approvals', 'leave', 'attendance'])
        await queryClient.invalidateQueries({ queryKey: [namespace, area] });
    },
    onError: async (error) => {
      // A moved-on request: reload it so the next attempt carries the current version.
      if (error instanceof ApiError && error.status === 409 && error.code !== 'error.periodClosed')
        await queryClient.invalidateQueries({ queryKey: [namespace, 'requests'] });
    },
  });
  if (!visible) return null;
  const confirm = () => {
    const text = reason.trim();
    setReasonMissing(approved && text === '');
    if (approved && text === '') return;
    cancel.mutate({ expectedVersion: request.version, ...(text === '' ? {} : { reason: text }) });
  };
  return (
    <>
      <Group>
        <Button
          variant="light"
          color="red"
          leftSection={<IconBan size={18} stroke={1.75} aria-hidden />}
          onClick={dialog.open}
        >
          {t('request.cancel.button')}
        </Button>
      </Group>
      <Modal opened={opened} onClose={dialog.close} title={t('request.cancel.title')}>
        <Stack gap="md">
          <Text size="sm">
            {t(approved ? 'request.cancel.bodyApproved' : 'request.cancel.bodyPending')}
          </Text>
          <MutationError error={cancel.error} />
          <Textarea
            label={t('request.cancel.reason')}
            withAsterisk={approved}
            maxLength={1000}
            rows={3}
            value={reason}
            error={reasonMissing ? t('request.cancel.reasonRequired') : undefined}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.close}>
              {t('common.cancel')}
            </Button>
            <Button color="red" loading={cancel.isPending} onClick={confirm}>
              {t('request.cancel.confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
