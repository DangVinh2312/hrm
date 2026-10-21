import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconPencil,
  IconStar,
  IconUserCheck,
  IconUserMinus,
  IconUserPlus,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSession } from '../../auth/session.provider';
import { MutationError } from '../../hr/components/mutation-error.component';
import { QueryState } from '../../hr/components/query-state.component';
import { useHrServices } from '../../hr/hr-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';
import type { Team } from '../team.client';
import { EmployeePicker } from './employee-picker.component';

/** UTC instant → `dd/MM/yyyy` in the business timezone (ADR 0018), for history display only. */
function formatInstant(value: string | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'Asia/Ho_Chi_Minh',
      }).format(date);
}

function useTeamRefresh() {
  const { namespace } = useSession();
  const queryClient = useQueryClient();
  // Team facts change employee scopes and primary teams too.
  return async () => {
    await queryClient.invalidateQueries({ queryKey: [namespace, 'teams'] });
    await queryClient.invalidateQueries({ queryKey: [namespace, 'employees'] });
    await queryClient.invalidateQueries({ queryKey: [namespace, 'hr', 'me'] });
  };
}

function RenameForm(props: { readonly team: Team; readonly onClose: () => void }) {
  const { t } = useI18n();
  const { teams } = useHrServices();
  const refresh = useTeamRefresh();
  const [name, setName] = useState(props.team.name);
  const valid = name.trim().length > 0 && name.trim().length <= 200;
  const rename = useMutation({
    mutationFn: () =>
      teams.rename(props.team.id, { expectedVersion: props.team.version, name: name.trim() }),
    onSuccess: async () => {
      await refresh();
      props.onClose();
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) rename.mutate();
      }}
      noValidate
    >
      <Stack gap="md">
        <MutationError error={rename.error} />
        <TextInput
          label={t('team.field.name')}
          value={name}
          maxLength={200}
          withAsterisk
          onChange={(event) => setName(event.currentTarget.value)}
          error={valid ? undefined : t('employee.form.required')}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={rename.isPending} disabled={!valid}>
            {t('common.save')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/**
 * One team: lead, members, lead history. Assignments are permission facts (team.assign: fresh
 * reauthentication and a bound boundary — Root today), so failures offer reauthentication.
 */
export function TeamDetail(props: { readonly teamId: string; readonly canManage: boolean }) {
  const { t, locale } = useI18n();
  const { namespace } = useSession();
  const { teams } = useHrServices();
  const refresh = useTeamRefresh();
  const [renaming, rename] = useDisclosure();
  const [lead, setLead] = useState<string | null>(null);
  const [member, setMember] = useState<string | null>(null);
  const [primary, setPrimary] = useState(false);
  const detail = useQuery({
    queryKey: [namespace, 'teams', 'detail', props.teamId],
    queryFn: ({ signal }) => teams.detail(props.teamId, signal),
  });
  const change = useMutation({
    mutationFn: (run: () => Promise<void>) => run(),
    onSuccess: async () => {
      setLead(null);
      setMember(null);
      setPrimary(false);
      await refresh();
    },
  });
  const team = detail.data;

  return (
    <Card padding="lg">
      <QueryState pending={detail.isPending} error={detail.error} onRetry={() => detail.refetch()}>
        {team && (
          <Stack gap="lg">
            <Group justify="space-between" wrap="wrap">
              <Title order={2}>{team.name}</Title>
              {props.canManage && (
                <Button
                  variant="light"
                  leftSection={<IconPencil size={18} stroke={1.75} aria-hidden />}
                  onClick={rename.open}
                >
                  {t('team.rename')}
                </Button>
              )}
            </Group>
            <MutationError error={change.error} />

            <Stack gap="xs">
              <Text fw={600}>{t('team.lead.title')}</Text>
              {team.lead ? (
                <Group gap="xs">
                  <IconUserCheck size={20} stroke={1.75} aria-hidden />
                  <Text>
                    {team.lead.code} · {team.lead.fullName}
                  </Text>
                </Group>
              ) : (
                <Text c="dimmed" size="sm">
                  {t('team.lead.none')}
                </Text>
              )}
              {props.canManage && (
                <Group align="flex-end" wrap="wrap">
                  <EmployeePicker
                    label={t('team.lead.choose')}
                    value={lead}
                    onChange={setLead}
                    exclude={team.lead ? [team.lead.employeeId] : []}
                  />
                  <Button
                    disabled={lead === null}
                    loading={change.isPending}
                    onClick={() => {
                      if (lead) change.mutate(() => teams.assignLead(team.id, lead));
                    }}
                  >
                    {t('team.lead.assign')}
                  </Button>
                  {team.lead && (
                    <Button
                      variant="subtle"
                      color="red"
                      loading={change.isPending}
                      onClick={() => change.mutate(() => teams.assignLead(team.id, null))}
                    >
                      {t('team.lead.clear')}
                    </Button>
                  )}
                </Group>
              )}
            </Stack>

            <Stack gap="xs">
              <Text fw={600}>
                {t('team.member.title')} ({team.members.length})
              </Text>
              {team.members.length === 0 ? (
                <Text c="dimmed" size="sm">
                  {t('team.member.empty')}
                </Text>
              ) : (
                <Table.ScrollContainer minWidth={480}>
                  <Table verticalSpacing="xs" striped>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('employee.field.code')}</Table.Th>
                        <Table.Th>{t('employee.field.fullName')}</Table.Th>
                        <Table.Th>{t('team.member.since')}</Table.Th>
                        {props.canManage && <Table.Th>{t('common.actions')}</Table.Th>}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {team.members.map((row) => (
                        <Table.Tr key={row.employeeId}>
                          <Table.Td>{row.code}</Table.Td>
                          <Table.Td>
                            <Group gap="xs">
                              {row.fullName}
                              {row.primary && (
                                <Badge size="sm" variant="light">
                                  {t('team.member.primary')}
                                </Badge>
                              )}
                            </Group>
                          </Table.Td>
                          <Table.Td>{formatInstant(row.since, locale)}</Table.Td>
                          {props.canManage && (
                            <Table.Td>
                              <Group gap={4} wrap="nowrap">
                                {!row.primary && (
                                  <Tooltip label={t('team.member.makePrimary')}>
                                    <ActionIcon
                                      variant="subtle"
                                      size="lg"
                                      aria-label={`${t('team.member.makePrimary')}: ${row.fullName}`}
                                      onClick={() =>
                                        change.mutate(() =>
                                          teams.setPrimary(team.id, row.employeeId),
                                        )
                                      }
                                    >
                                      <IconStar size={18} stroke={1.75} aria-hidden />
                                    </ActionIcon>
                                  </Tooltip>
                                )}
                                <Tooltip label={t('team.member.remove')}>
                                  <ActionIcon
                                    variant="subtle"
                                    color="red"
                                    size="lg"
                                    aria-label={`${t('team.member.remove')}: ${row.fullName}`}
                                    onClick={() =>
                                      change.mutate(() =>
                                        teams.endMembership(team.id, row.employeeId),
                                      )
                                    }
                                  >
                                    <IconUserMinus size={18} stroke={1.75} aria-hidden />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
              {props.canManage && (
                <Group align="flex-end" wrap="wrap">
                  <EmployeePicker
                    label={t('team.member.add')}
                    value={member}
                    onChange={setMember}
                    exclude={team.members.map((row) => row.employeeId)}
                  />
                  <Checkbox
                    label={t('team.member.asPrimary')}
                    checked={primary}
                    onChange={(event) => setPrimary(event.currentTarget.checked)}
                    mb={8}
                  />
                  <Button
                    leftSection={<IconUserPlus size={18} stroke={1.75} aria-hidden />}
                    disabled={member === null}
                    loading={change.isPending}
                    onClick={() => {
                      if (member)
                        change.mutate(() =>
                          teams.addMember(team.id, { employeeId: member, primary }),
                        );
                    }}
                  >
                    {t('team.member.addSubmit')}
                  </Button>
                </Group>
              )}
              {props.canManage && (
                <Text size="xs" c="dimmed">
                  {t('team.member.primaryHint')}
                </Text>
              )}
            </Stack>

            {team.leadHistory.length > 0 && (
              <Stack gap="xs">
                <Text fw={600}>{t('team.lead.history')}</Text>
                <Table.ScrollContainer minWidth={420}>
                  <Table verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('employee.field.fullName')}</Table.Th>
                        <Table.Th>{t('employee.profile.from')}</Table.Th>
                        <Table.Th>{t('team.lead.until')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {team.leadHistory.map((row) => (
                        <Table.Tr key={`${row.employeeId}-${row.startsAt}`}>
                          <Table.Td>
                            {row.code} · {row.fullName}
                          </Table.Td>
                          <Table.Td>{formatInstant(row.startsAt, locale)}</Table.Td>
                          <Table.Td>
                            {row.endsAt === null
                              ? t('employee.profile.ongoing')
                              : formatInstant(row.endsAt, locale)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Stack>
            )}
          </Stack>
        )}
      </QueryState>
      {team && (
        <Modal opened={renaming} onClose={rename.close} title={t('team.rename')}>
          <RenameForm team={team} onClose={rename.close} />
        </Modal>
      )}
    </Card>
  );
}
