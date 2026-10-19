import {
  Badge,
  Button,
  Card,
  Center,
  Grid,
  Group,
  Modal,
  NavLink,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPlus, IconUsersGroup } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useSession } from '../auth/session.provider';
import { MutationError } from '../hr/components/mutation-error.component';
import { QueryState } from '../hr/components/query-state.component';
import { useHrMe, useHrServices } from '../hr/hr-services.provider';
import { useI18n } from '../i18n/i18n.provider';
import { TeamDetail } from './components/team-detail.component';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function CreateTeam(props: {
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const { teams } = useHrServices();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const valid = name.trim().length > 0 && name.trim().length <= 200;
  const create = useMutation({
    mutationFn: () => teams.create(name.trim()),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: [namespace, 'teams'] });
      await queryClient.invalidateQueries({ queryKey: [namespace, 'hr', 'me'] });
      props.onCreated(id);
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) create.mutate();
      }}
      noValidate
    >
      <Stack gap="md">
        <MutationError error={create.error} />
        <TextInput
          label={t('team.field.name')}
          value={name}
          maxLength={200}
          withAsterisk
          data-autofocus
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!valid}>
            {t('team.create.submit')}
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

/**
 * Teams the caller may see (member, lead or company scope) and one selected team (`?team=` in the
 * URL). Management buttons follow the server's company-scope hint; the API decides each change.
 */
export function TeamPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const { teams } = useHrServices();
  const me = useHrMe();
  const [params, setParams] = useSearchParams();
  const [creating, create] = useDisclosure();
  const list = useQuery({
    queryKey: [namespace, 'teams', 'list'],
    queryFn: ({ signal }) => teams.list(signal),
  });
  const canManage = me.data?.companyScope === true;
  const requested = params.get('team') ?? '';
  const selected = uuid.test(requested) ? requested : list.data?.items[0]?.id;
  const select = (id: string) => setParams(new URLSearchParams({ team: id }));

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Title order={1}>{t('team.title')}</Title>
          <Text c="dimmed" mt={4}>
            {t('team.description')}
          </Text>
        </div>
        {canManage && (
          <Button
            leftSection={<IconPlus size={18} stroke={1.75} aria-hidden />}
            onClick={create.open}
          >
            {t('team.create.open')}
          </Button>
        )}
      </Group>
      <QueryState pending={list.isPending} error={list.error} onRetry={() => list.refetch()}>
        {list.data?.items.length === 0 ? (
          <Card padding="lg">
            <Center py="xl">
              <Stack align="center" gap="xs">
                <ThemeIcon size={44} radius="md" variant="light" color="gray" aria-hidden>
                  <IconUsersGroup size={24} stroke={1.75} />
                </ThemeIcon>
                <Text c="dimmed">{t('team.empty')}</Text>
              </Stack>
            </Center>
          </Card>
        ) : (
          <Grid gap="lg">
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Card padding="sm">
                <nav aria-label={t('team.listLabel')}>
                  {list.data?.items.map((team) => (
                    <NavLink
                      key={team.id}
                      active={team.id === selected}
                      label={team.name}
                      description={team.lead ? team.lead.fullName : t('team.lead.none')}
                      rightSection={
                        <Badge size="sm" variant="light" color="gray">
                          {team.memberCount}
                        </Badge>
                      }
                      onClick={() => select(team.id)}
                      styles={{ root: { borderRadius: 'var(--mantine-radius-md)' } }}
                    />
                  ))}
                </nav>
              </Card>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 8 }}>
              {selected && <TeamDetail key={selected} teamId={selected} canManage={canManage} />}
            </Grid.Col>
          </Grid>
        )}
      </QueryState>
      <Modal opened={creating} onClose={create.close} title={t('team.create.open')}>
        <CreateTeam
          onClose={create.close}
          onCreated={(id) => {
            create.close();
            select(id);
          }}
        />
      </Modal>
    </Stack>
  );
}
