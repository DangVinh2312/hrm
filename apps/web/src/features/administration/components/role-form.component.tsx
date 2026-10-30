import { Alert, Button, Code, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n.provider';
import { ApiError } from '../../../infrastructure/http.client';
import { useSession } from '../../auth/session.provider';
import { useAdministrationClient } from '../administration-services.provider';
import type { CatalogPair, RoleRow } from '../administration.client';
import {
  byPairId,
  draftLacksFinalDecision,
  draftSelfApproval,
  grantsOfRole,
  isRoleLabel,
  isRoleName,
  pairId,
  roleKeyOf,
} from '../role-form.helper';
import { ConfirmPanel } from './confirm-panel.component';
import { RoleCapabilities } from './role-capabilities.component';
import { RoleCatalogPicker } from './role-catalog-picker.component';

export type RoleSaved = 'create' | 'update';

/**
 * Create (no `role`) or edit one runtime role. The form holds the whole grant set; `PUT` replaces
 * it and carries the digest read with the role, so a 409 means the role changed since: the form
 * closes and the page reloads instead of resending an old draft.
 */
export function RoleForm(props: {
  readonly role?: RoleRow;
  readonly catalog: readonly CatalogPair[];
  readonly onClose: () => void;
  readonly onSaved: (kind: RoleSaved) => void;
  readonly onStale: () => void;
}) {
  const { t } = useI18n();
  const { namespace } = useSession();
  const administration = useAdministrationClient();
  const queryClient = useQueryClient();
  const { role } = props;
  const [name, setName] = useState('');
  const [label, setLabel] = useState(role?.label ?? '');
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set((role ? grantsOfRole(role) : []).map(pairId)),
  );
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [checked, setChecked] = useState(false);
  const known = new Map(
    [...(role ? grantsOfRole(role) : []), ...props.catalog].map((pair) => [pairId(pair), pair]),
  );
  const pairs = [...known.values()].filter((pair) => selected.has(pairId(pair))).sort(byPairId);
  const nameValid = role !== undefined || isRoleName(name);
  const labelValid = isRoleLabel(label);
  const missingFinal = draftLacksFinalDecision(pairs);
  const invalid = !nameValid || !labelValid || missingFinal;

  const save = useMutation({
    mutationFn: () =>
      role
        ? administration.updateRole(role.key, {
            label: label.trim(),
            grants: pairs,
            expectedDigest: role.digest,
          })
        : administration.createRole({ key: roleKeyOf(name), label: label.trim(), grants: pairs }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'roles'] });
      await queryClient.invalidateQueries({
        queryKey: [namespace, 'administration', 'account-permissions'],
      });
      props.onSaved(role ? 'update' : 'create');
    },
    onError: async (error) => {
      if (role && error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: [namespace, 'administration', 'roles'] });
        props.onStale();
      }
    },
  });

  return (
    <Modal
      opened
      onClose={props.onClose}
      closeOnClickOutside={!save.isPending}
      closeOnEscape={!save.isPending}
      size="lg"
      title={t(role ? 'administration.roles.edit.title' : 'administration.roles.create.title')}
    >
      {step === 'form' ? (
        <Stack gap="md">
          {!role && (
            <TextInput
              label={t('administration.roles.form.name')}
              description={t('administration.roles.form.name.hint')}
              value={name}
              error={checked && !nameValid ? t('administration.roles.form.name.invalid') : null}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          )}
          {!role && (
            <Text size="sm">
              {t('administration.roles.form.key')}: <Code>{roleKeyOf(name)}</Code>
            </Text>
          )}
          <TextInput
            label={t('administration.roles.form.label')}
            description={t('administration.roles.form.label.hint')}
            value={label}
            error={checked && !labelValid ? t('administration.roles.form.label.invalid') : null}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
          {props.catalog.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('administration.roles.form.noCatalog')}
            </Text>
          ) : (
            <RoleCatalogPicker
              catalog={props.catalog}
              selected={selected}
              onToggle={(pair, on) => {
                const next = new Set(selected);
                if (on) next.add(pairId(pair));
                else next.delete(pairId(pair));
                setSelected(next);
              }}
            />
          )}
          {draftSelfApproval(pairs) && (
            <Alert color="yellow" role="status" icon={<IconAlertCircle size={18} aria-hidden />}>
              {t('administration.roles.capability.selfApproval.note')}
            </Alert>
          )}
          {checked && missingFinal && (
            <Alert color="red" role="alert" icon={<IconAlertCircle size={18} aria-hidden />}>
              {t('administration.roles.form.needFinalDecision')}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={props.onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => {
                setChecked(true);
                if (!invalid) {
                  save.reset();
                  setStep('confirm');
                }
              }}
            >
              {t('administration.roles.form.next')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          {role && <RoleCapabilities capabilities={role.capabilities} notes />}
          <Text size="sm">
            {`${t('administration.roles.form.selected')}: ${pairs.length}`}
            {' · '}
            <Code>{role ? role.key : roleKeyOf(name)}</Code>
          </Text>
          <Text size="sm" c="dimmed">
            {t('administration.roles.form.riskNote')}
          </Text>
          <ConfirmPanel
            title={
              role
                ? 'administration.roles.edit.confirm.title'
                : 'administration.roles.create.confirm.title'
            }
            body={
              role
                ? 'administration.roles.edit.confirm.body'
                : 'administration.roles.create.confirm.body'
            }
            confirm={
              role ? 'administration.roles.edit.confirm' : 'administration.roles.create.confirm'
            }
            subject={label.trim()}
            loading={save.isPending}
            error={save.error}
            onConfirm={() => save.mutate()}
            onCancel={() => setStep('form')}
          />
        </Stack>
      )}
    </Modal>
  );
}
