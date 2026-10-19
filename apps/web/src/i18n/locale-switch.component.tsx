import { ActionIcon, Menu } from '@mantine/core';
import { IconCheck, IconLanguage } from '@tabler/icons-react';
import { localeNames, locales } from './i18n.helper';
import { useI18n } from './i18n.provider';

/** Language menu (44px target); each entry is named in its own language. */
export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <Menu position="bottom-end">
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" size="xl" aria-label={t('locale.label')}>
          <IconLanguage size={20} stroke={1.75} aria-hidden />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {locales.map((value) => (
          <Menu.Item
            key={value}
            lang={value}
            aria-current={value === locale ? 'true' : undefined}
            rightSection={value === locale ? <IconCheck size={16} aria-hidden /> : undefined}
            onClick={() => setLocale(value)}
          >
            {localeNames[value]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
