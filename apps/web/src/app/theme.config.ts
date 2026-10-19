import { type CSSVariablesResolver, createTheme, type MantineColorsTuple } from '@mantine/core';

/**
 * Brand scale (indigo). Shade 6 on white text is 6.3:1, shade 7 is 7.9:1 (WCAG AA for body text);
 * lighter shades are for tinted backgrounds only, never for text on white.
 */
const brand: MantineColorsTuple = [
  '#eef2ff',
  '#e0e7ff',
  '#c7d2fe',
  '#a5b4fc',
  '#818cf8',
  '#6366f1',
  '#4f46e5',
  '#4338ca',
  '#3730a3',
  '#312e81',
];

/** Self-hosted Be Vietnam Pro (OFL, full Vietnamese subset); system fonts while it loads. */
const fontFamily =
  "'Be Vietnam Pro', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * The only theme of the app (docs/hrm-ui-design-system.md). Components read tokens through
 * props (`c`, `bg`, `p`, `radius`) or CSS variables; no raw hex outside this file.
 */
export const theme = createTheme({
  colors: { brand },
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 4 },
  fontFamily,
  fontFamilyMonospace: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
  headings: {
    fontFamily,
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '1.75rem', lineHeight: '1.3' },
      h2: { fontSize: '1.375rem', lineHeight: '1.35' },
      h3: { fontSize: '1.125rem', lineHeight: '1.4' },
    },
  },
  defaultRadius: 'md',
  cursorType: 'pointer',
  focusRing: 'auto',
  respectReducedMotion: true,
  autoContrast: true,
  components: {
    Paper: { defaultProps: { radius: 'lg' } },
    Card: { defaultProps: { radius: 'lg', withBorder: true } },
    Alert: { defaultProps: { radius: 'md', variant: 'light' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300 } },
    // Hints and errors under the field: inputs side by side line up whether or not they have a
    // hint (design system §3).
    InputWrapper: {
      defaultProps: { inputWrapperOrder: ['label', 'input', 'description', 'error'] },
    },
  },
});

/**
 * Mantine's default `dimmed` (gray.6) is 3.3:1 on white, below WCAG AA for body text; gray.7 is
 * 8:1. Secondary text keeps `c="dimmed"` and gets the accessible shade from here.
 */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: { '--mantine-color-dimmed': 'var(--mantine-color-gray-7)' },
  dark: {},
});
