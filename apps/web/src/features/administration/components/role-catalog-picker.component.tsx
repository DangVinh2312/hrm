import { Checkbox, Fieldset, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n.provider';
import type { CatalogPair } from '../administration.client';
import { MAX_ROLE_GRANTS, filterCatalog, pairId } from '../role-form.helper';
import { splitPermission } from '../role.helper';

export function RoleCatalogPicker(props: {
  readonly catalog: readonly CatalogPair[];
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (pair: CatalogPair, checked: boolean) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const shown = filterCatalog(props.catalog, query);
  const groups = new Map<string, CatalogPair[]>();
  for (const pair of shown) {
    const { resource } = splitPermission(pair.permission);
    groups.set(resource, [...(groups.get(resource) ?? []), pair]);
  }
  const full = props.selected.size >= MAX_ROLE_GRANTS;
  return (
    <Stack gap="sm">
      <TextInput
        label={t('administration.roles.form.search')}
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <Text size="sm" aria-live="polite">
        {`${t('administration.roles.form.selected')}: ${props.selected.size} / ${MAX_ROLE_GRANTS}`}
      </Text>
      {shown.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('administration.roles.form.noMatch')}
        </Text>
      )}
      {[...groups.entries()].map(([resource, pairs]) => (
        <Fieldset key={resource} legend={resource}>
          <Stack gap={6}>
            {pairs.map((pair) => {
              const checked = props.selected.has(pairId(pair));
              return (
                <Checkbox
                  key={pairId(pair)}
                  label={`${splitPermission(pair.permission).action} · ${pair.template.key}`}
                  checked={checked}
                  disabled={full && !checked}
                  onChange={(event) => props.onToggle(pair, event.currentTarget.checked)}
                />
              );
            })}
          </Stack>
        </Fieldset>
      ))}
    </Stack>
  );
}
