import { Anchor, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { useSession } from '../../auth/session.provider';
import { EmploymentStateBadge } from '../components/employment-state-badge.component';
import { QueryState } from '../../../components/query-state.component';
import { useEmployeeClient, useOwnEmployee } from '../employee-services.provider';
import { useI18n } from '../../../i18n/i18n.provider';
import { AttendanceAdjustSection } from '../../attendance/attendance-adjust.component';
import { EmployeeAccountSection } from '../components/employee-account.component';
import { EmployeeIdentitySection } from '../components/employee-identity.component';
import { EmployeeLeaveRateSection } from '../components/employee-leave-rate.component';
import { EmployeeProfile } from '../components/employee-profile.component';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * One employee: F1 for everyone in scope; F2/F3 sections only when the API returns them. HR
 * buttons follow the server's company-scope hint; the API still authorizes each change.
 */
export function EmployeeDetailPage() {
  const { t } = useI18n();
  const { namespace } = useSession();
  const employees = useEmployeeClient();
  const me = useOwnEmployee();
  const id = useParams().id ?? '';
  const valid = uuid.test(id);
  const detail = useQuery({
    queryKey: [namespace, 'employees', 'detail', id],
    queryFn: ({ signal }) => employees.detail(id, signal),
    enabled: valid,
  });
  const canManage = me.data?.companyScope === true;
  const employee = detail.data;

  return (
    <Stack gap="lg">
      <Anchor component={Link} to="/employees" size="sm">
        <Group gap={4}>
          <IconArrowLeft size={16} aria-hidden />
          {t('employee.detail.back')}
        </Group>
      </Anchor>
      {!valid ? (
        <Stack gap="xs">
          <Title order={1}>{t('notFound.title')}</Title>
          <Text c="dimmed">{t('notFound.body')}</Text>
        </Stack>
      ) : (
        <QueryState
          pending={detail.isPending}
          error={detail.error}
          onRetry={() => detail.refetch()}
        >
          {employee && (
            <Stack gap="lg">
              <Group gap="sm" align="center" wrap="wrap">
                <Title order={1}>{employee.fullName}</Title>
                <EmploymentStateBadge state={employee.state} />
              </Group>
              <Text c="dimmed" mt={-12}>
                {employee.code}
              </Text>
              <EmployeeProfile employee={employee} canManage={canManage} />
              <EmployeeIdentitySection employeeId={employee.id} canManage={canManage} />
              <EmployeeLeaveRateSection employeeId={employee.id} canManage={canManage} />
              {canManage && <AttendanceAdjustSection employeeId={employee.id} />}
              {canManage && <EmployeeAccountSection employee={employee} />}
            </Stack>
          )}
        </QueryState>
      )}
    </Stack>
  );
}
