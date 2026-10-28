// ─────────────────────────────────────────────────────────────────────────────
// Tokens every theme must define. Components read these as CSS custom
// properties (`var(--surface)`), never as hard-coded hex — a panel that inlines
// `isDark ? '#1e2130' : '#fff'` silently opts out of theming and won't follow a
// theme switch.
//
// Four groups, and the separation matters:
//   surfaces   background / surface / panel / border / rule
//   text       text / textSecondary
//   accent     accent — selection and branding ONLY
//   semantic   positive / negative / warning / severity — meaning, never brand
//
// Accent and semantic are deliberately different hues in every theme. Where they
// share a family the eye stops trusting colour to mean anything.
// ─────────────────────────────────────────────────────────────────────────────

export const themes = {
  light: {
    name: 'light', label: 'Light', dark: false,
    chartPositive: '#12805c', chartNegative: '#d9534a',
    chartSeriesStock: '#0b6bcb', chartSeriesOptions: '#9a6700',
    accent: '#5a6fd6', accentHover: '#4c5fc4', accentText: '#ffffff',
    panel: '#f8fafc', rule: '#e2e8f0', severity: '#dc2626',
    background: '#f8f9fa',
    surface: '#ffffff',
    surfaceHover: '#f8f9fa',
    text: '#212529',
    textSecondary: '#6c757d',
    border: '#dee2e6',
    shadow: 'rgba(0, 0, 0, 0.1)',

    // Status colors
    positive: '#28a745',
    negative: '#dc3545',
    neutral: '#6c757d',
    warning: '#ffc107',

    // Card backgrounds
    cardPositive: '#d4edda',
    cardNegative: '#f8d7da',
    cardNeutral: '#e9ecef',

    // Chart colors
    chartLine: '#2196F3',
    chartGrid: '#e0e0e0',
    chartText: '#666',

    // Table
    tableHeader: '#f8f9fa',
    tableRowHover: '#f8f9fa',
    tableRowExpanded: '#e9ecef',

    // Buttons
    buttonPrimary: '#007bff',
    buttonPrimaryHover: '#0056b3',
    buttonSecondary: '#6c757d',
    buttonSecondaryHover: '#545b62',
    buttonDanger: '#dc3545',
    buttonDangerHover: '#c82333'
  },

  dark: {
    name: 'dark', label: 'Dark', dark: true,
    chartPositive: '#26a072', chartNegative: '#d9534a',
    chartSeriesStock: '#3f86c9', chartSeriesOptions: '#b08536',
    accent: '#8b9bf0', accentHover: '#7a8ce8', accentText: '#12141c',
    panel: '#232323', rule: '#404040', severity: '#ef4444',
    background: '#1a1a1a',
    surface: '#2d2d2d',
    surfaceHover: '#3a3a3a',
    text: '#e0e0e0',
    textSecondary: '#a0a0a0',
    border: '#404040',
    shadow: 'rgba(0, 0, 0, 0.3)',

    // Status colors
    positive: '#4ade80',
    negative: '#f87171',
    neutral: '#9ca3af',
    warning: '#fbbf24',

    // Card backgrounds
    cardPositive: '#1e3a2a',
    cardNegative: '#3a1e1e',
    cardNeutral: '#2d2d2d',

    // Chart colors
    chartLine: '#60a5fa',
    chartGrid: '#404040',
    chartText: '#a0a0a0',

    // Table
    tableHeader: '#232323',
    tableRowHover: '#3a3a3a',
    tableRowExpanded: '#404040',

    // Buttons
    buttonPrimary: '#3b82f6',
    buttonPrimaryHover: '#2563eb',
    buttonSecondary: '#6b7280',
    buttonSecondaryHover: '#4b5563',
    buttonDanger: '#ef4444',
    buttonDangerHover: '#dc2626'
  },

  midnight: {
    name: 'midnight', label: 'Midnight', dark: true,
    chartPositive: '#26a072', chartNegative: '#d9534a',
    chartSeriesStock: '#3f86c9', chartSeriesOptions: '#b08536',
    accent: '#818cf8', accentHover: '#6f7bf0', accentText: '#0f1629',
    panel: '#151b33', rule: '#2d3a63', severity: '#f87171',
    background: '#0f1629',
    surface: '#1a2140',
    surfaceHover: '#232c52',
    text: '#e2e8f0',
    textSecondary: '#94a3b8',
    border: '#2d3a63',
    shadow: 'rgba(0, 0, 0, 0.4)',

    positive: '#34d399',
    negative: '#f87171',
    neutral: '#94a3b8',
    warning: '#fbbf24',

    cardPositive: '#12351f',
    cardNegative: '#3a1e1e',
    cardNeutral: '#1a2140',

    chartLine: '#818cf8',
    chartGrid: '#2d3a63',
    chartText: '#94a3b8',

    tableHeader: '#151b33',
    tableRowHover: '#232c52',
    tableRowExpanded: '#2d3a63',

    buttonPrimary: '#6366f1',
    buttonPrimaryHover: '#4f46e5',
    buttonSecondary: '#64748b',
    buttonSecondaryHover: '#475569',
    buttonDanger: '#ef4444',
    buttonDangerHover: '#dc2626'
  },

  sepia: {
    name: 'sepia', label: 'Sepia', dark: false,
    chartPositive: '#12805c', chartNegative: '#d9534a',
    chartSeriesStock: '#0b6bcb', chartSeriesOptions: '#9a6700',
    accent: '#b06b2c', accentHover: '#95591f', accentText: '#fbf6ea',
    panel: '#efe4cc', rule: '#e0d3b8', severity: '#c0392b',
    background: '#f4ecd8',
    surface: '#fbf6ea',
    surfaceHover: '#f1e7cf',
    text: '#433422',
    textSecondary: '#8a7355',
    border: '#e0d3b8',
    shadow: 'rgba(120, 90, 40, 0.12)',

    positive: '#2f8f4e',
    negative: '#c0392b',
    neutral: '#8a7355',
    warning: '#c9860a',

    cardPositive: '#dcecd6',
    cardNegative: '#f2ddd6',
    cardNeutral: '#efe6d2',

    chartLine: '#b06b2c',
    chartGrid: '#e0d3b8',
    chartText: '#8a7355',

    tableHeader: '#efe4cc',
    tableRowHover: '#f1e7cf',
    tableRowExpanded: '#e9dcc0',

    buttonPrimary: '#b06b2c',
    buttonPrimaryHover: '#95591f',
    buttonSecondary: '#8a7355',
    buttonSecondaryHover: '#6f5c43',
    buttonDanger: '#c0392b',
    buttonDangerHover: '#a52f22'
  },

  // ── Instrument ────────────────────────────────────────────────────────────
  // Precision-equipment discipline: flat surfaces, no coloured shadows, one
  // measured blue used only for selection. Neutrals carry a slight blue bias so
  // they read as chosen rather than as default grey.
  instrument: {
    name: 'instrument', label: 'Instrument', dark: false,
    chartPositive: '#12805c', chartNegative: '#d9534a',
    chartSeriesStock: '#0b6bcb', chartSeriesOptions: '#9a6700',
    accent: '#0b6bcb', accentHover: '#0a5aad', accentText: '#ffffff',
    panel: '#f5f6f8', rule: '#dee2e7', severity: '#c0392f',
    background: '#f5f6f8',
    surface: '#ffffff',
    surfaceHover: '#f5f6f8',
    text: '#10141a',
    textSecondary: '#5c6672',
    border: '#dee2e7',
    // Flat by design — depth comes from rules, not shadow.
    shadow: 'rgba(16, 20, 26, 0.06)',

    positive: '#12805c',
    negative: '#c0392f',
    neutral: '#5c6672',
    warning: '#9a6700',

    cardPositive: '#e6f4ef',
    cardNegative: '#fbecea',
    cardNeutral: '#f5f6f8',

    chartLine: '#0b6bcb',
    chartGrid: '#dee2e7',
    chartText: '#5c6672',

    tableHeader: '#f5f6f8',
    tableRowHover: '#f5f6f8',
    tableRowExpanded: '#eceff3',

    buttonPrimary: '#0b6bcb',
    buttonPrimaryHover: '#0a5aad',
    buttonSecondary: '#5c6672',
    buttonSecondaryHover: '#48515b',
    buttonDanger: '#c0392f',
    buttonDangerHover: '#a32f26'
  },

  instrumentDark: {
    name: 'instrumentDark', label: 'Instrument Dark', dark: true,
    chartPositive: '#26a072', chartNegative: '#d9534a',
    chartSeriesStock: '#3f86c9', chartSeriesOptions: '#b08536',
    // Accent sits lower in saturation than the sampled #4c9aff: on this ground
    // a brighter blue reads at nearly the same weight as the positive green,
    // and the two blur together down a dense column of figures.
    accent: '#3d8bdb', accentHover: '#4c9aff', accentText: '#0e1116',
    panel: '#151a21', rule: '#242b35', severity: '#ff6b5e',
    background: '#0e1116',
    surface: '#131820',
    surfaceHover: '#1a212a',
    text: '#e6eaef',
    textSecondary: '#8b95a1',
    border: '#242b35',
    shadow: 'rgba(0, 0, 0, 0.45)',

    positive: '#3ecf8e',
    negative: '#ff6b5e',
    neutral: '#8b95a1',
    warning: '#d9a441',

    cardPositive: '#10261f',
    cardNegative: '#2a1614',
    cardNeutral: '#151a21',

    chartLine: '#3d8bdb',
    chartGrid: '#242b35',
    chartText: '#8b95a1',

    tableHeader: '#151a21',
    tableRowHover: '#1a212a',
    tableRowExpanded: '#242b35',

    buttonPrimary: '#3d8bdb',
    buttonPrimaryHover: '#4c9aff',
    buttonSecondary: '#8b95a1',
    buttonSecondaryHover: '#6f7986',
    buttonDanger: '#ff6b5e',
    buttonDangerHover: '#e0574b'
  }
,

  // ── Prift ─────────────────────────────────────────────────────────────────
  // After the Prift wealth dashboard (Eleken): cool off-white page, white cards
  // lifted by a soft wide shadow instead of borders, one confident blue, teal
  // for gains, and big bold figures with a quiet grey delta beside them. The
  // card, font and tab treatment lives in index.css under [data-theme^="prift"].
  prift: {
    name: 'prift', label: 'Prift', dark: false,
    chartPositive: '#0f8f84', chartNegative: '#e5484d',
    chartSeriesStock: '#2f6fe4', chartSeriesOptions: '#0f8f84',
    accent: '#1f6feb', accentHover: '#1a5fd0', accentText: '#ffffff',
    panel: '#f4f7fb', rule: '#e9eef5', severity: '#d93f44',
    background: '#f4f7fb',
    surface: '#ffffff',
    surfaceHover: '#f7f9fc',
    text: '#0f1b2d',
    textSecondary: '#66758a',
    border: '#e9eef5',
    shadow: 'rgba(15, 35, 70, 0.07)',

    positive: '#0f8f84',
    negative: '#e5484d',
    neutral: '#66758a',
    warning: '#c27c0e',

    cardPositive: '#e3f5f2',
    cardNegative: '#fdecec',
    cardNeutral: '#f4f7fb',

    chartLine: '#2f6fe4',
    chartGrid: '#edf1f6',
    chartText: '#66758a',

    tableHeader: '#f7f9fc',
    tableRowHover: '#f4f8fe',
    tableRowExpanded: '#eef3fb',

    buttonPrimary: '#1f6feb',
    buttonPrimaryHover: '#1a5fd0',
    buttonSecondary: '#66758a',
    buttonSecondaryHover: '#516073',
    buttonDanger: '#e5484d',
    buttonDangerHover: '#cc3a3f'
  },

  priftDark: {
    name: 'priftDark', label: 'Prift Dark', dark: true,
    chartPositive: '#2bb3a3', chartNegative: '#f06a6e',
    chartSeriesStock: '#5b8ff0', chartSeriesOptions: '#2bb3a3',
    accent: '#4f8ef7', accentHover: '#6a9ff8', accentText: '#0a1120',
    panel: '#0f1829', rule: '#1f2b40', severity: '#f06a6e',
    background: '#0a1120',
    surface: '#111b2e',
    surfaceHover: '#16223a',
    text: '#e8eef7',
    textSecondary: '#8c9ab0',
    border: '#1f2b40',
    shadow: 'rgba(0, 0, 0, 0.35)',

    positive: '#2bb3a3',
    negative: '#f06a6e',
    neutral: '#8c9ab0',
    warning: '#e0a43a',

    cardPositive: '#0f2a2a',
    cardNegative: '#2c1619',
    cardNeutral: '#111b2e',

    chartLine: '#5b8ff0',
    chartGrid: '#1f2b40',
    chartText: '#8c9ab0',

    tableHeader: '#0f1829',
    tableRowHover: '#16223a',
    tableRowExpanded: '#1f2b40',

    buttonPrimary: '#4f8ef7',
    buttonPrimaryHover: '#6a9ff8',
    buttonSecondary: '#8c9ab0',
    buttonSecondaryHover: '#73839b',
    buttonDanger: '#f06a6e',
    buttonDangerHover: '#d9575b'
  }
,

  // ── RightCapital ──────────────────────────────────────────────────────────
  // After the RightCapital planning app: plain white page, a warm grey band
  // behind the navigation, uppercase tracked nav labels, light large headings,
  // square-edged cards on hairline rules, periwinkle blue and sea green. Card,
  // font and nav treatment in index.css under [data-theme^="rightCapital"].
  rightCapital: {
    name: 'rightCapital', label: 'RightCapital', dark: false,
    chartPositive: '#3f9e7b', chartNegative: '#d2554f',
    chartSeriesStock: '#4f6fd0', chartSeriesOptions: '#3f9e7b',
    accent: '#4f6fd0', accentHover: '#405fc0', accentText: '#ffffff',
    panel: '#efeeec', rule: '#e4e2df', severity: '#c8433d',
    background: '#ffffff',
    surface: '#ffffff',
    surfaceHover: '#f7f6f4',
    text: '#2c2838',
    textSecondary: '#6d6878',
    border: '#e4e2df',
    shadow: 'rgba(44, 40, 56, 0.05)',

    positive: '#2f8f6b',
    negative: '#c8433d',
    neutral: '#6d6878',
    warning: '#b7791f',

    cardPositive: '#e5f3ed',
    cardNegative: '#f8e7e6',
    cardNeutral: '#f4f3f1',

    chartLine: '#4f6fd0',
    chartGrid: '#ecebe8',
    chartText: '#6d6878',

    tableHeader: '#f4f3f1',
    tableRowHover: '#f7f6f4',
    tableRowExpanded: '#efeeec',

    buttonPrimary: '#4f6fd0',
    buttonPrimaryHover: '#405fc0',
    buttonSecondary: '#6d6878',
    buttonSecondaryHover: '#585362',
    buttonDanger: '#c8433d',
    buttonDangerHover: '#b03731'
  },

  rightCapitalDark: {
    name: 'rightCapitalDark', label: 'RightCapital Dark', dark: true,
    chartPositive: '#5bbf98', chartNegative: '#e7726c',
    chartSeriesStock: '#8199e6', chartSeriesOptions: '#5bbf98',
    accent: '#8199e6', accentHover: '#93a8ec', accentText: '#17151d',
    panel: '#22202a', rule: '#34313d', severity: '#e7726c',
    background: '#17151d',
    surface: '#1d1b24',
    surfaceHover: '#26232f',
    text: '#ebe8f0',
    textSecondary: '#a39eae',
    border: '#34313d',
    shadow: 'rgba(0, 0, 0, 0.3)',

    positive: '#5bbf98',
    negative: '#e7726c',
    neutral: '#a39eae',
    warning: '#d9a441',

    cardPositive: '#15291f',
    cardNegative: '#2e1a1a',
    cardNeutral: '#22202a',

    chartLine: '#8199e6',
    chartGrid: '#34313d',
    chartText: '#a39eae',

    tableHeader: '#22202a',
    tableRowHover: '#26232f',
    tableRowExpanded: '#34313d',

    buttonPrimary: '#8199e6',
    buttonPrimaryHover: '#93a8ec',
    buttonSecondary: '#a39eae',
    buttonSecondaryHover: '#8b8696',
    buttonDanger: '#e7726c',
    buttonDangerHover: '#d45f59'
  },

  // ── Revolut ───────────────────────────────────────────────────────────────
  // After the Revolut app: a light grey page, big white cards with deep
  // rounding and no outline, near-black type, one electric blue, and pill
  // shapes for the nav and buttons. Card, font and nav treatment in index.css
  // under [data-theme^="revolut"].
  revolut: {
    name: 'revolut', label: 'Revolut', dark: false,
    chartPositive: '#00a37a', chartNegative: '#e2364b',
    chartSeriesStock: '#0666eb', chartSeriesOptions: '#00a37a',
    accent: '#0666eb', accentHover: '#0556c7', accentText: '#ffffff',
    panel: '#f2f3f5', rule: '#e8eaed', severity: '#e2364b',
    background: '#f2f3f5',
    surface: '#ffffff',
    surfaceHover: '#f6f7f8',
    text: '#191c1f',
    textSecondary: '#717780',
    border: '#e8eaed',
    shadow: 'rgba(25, 28, 31, 0.06)',

    positive: '#00a37a',
    negative: '#e2364b',
    neutral: '#717780',
    warning: '#c97a00',

    cardPositive: '#e2f6ef',
    cardNegative: '#fdeaec',
    cardNeutral: '#f2f3f5',

    chartLine: '#0666eb',
    chartGrid: '#eceef1',
    chartText: '#717780',

    tableHeader: '#f6f7f8',
    tableRowHover: '#f3f6fc',
    tableRowExpanded: '#edf2fb',

    buttonPrimary: '#0666eb',
    buttonPrimaryHover: '#0556c7',
    buttonSecondary: '#717780',
    buttonSecondaryHover: '#5c626a',
    buttonDanger: '#e2364b',
    buttonDangerHover: '#c92c40'
  },

  revolutDark: {
    name: 'revolutDark', label: 'Revolut Dark', dark: true,
    chartPositive: '#2fd3a1', chartNegative: '#ff5c6c',
    chartSeriesStock: '#4d8dff', chartSeriesOptions: '#2fd3a1',
    accent: '#4d8dff', accentHover: '#6a9fff', accentText: '#000000',
    panel: '#111114', rule: '#26262c', severity: '#ff5c6c',
    background: '#000000',
    surface: '#18181c',
    surfaceHover: '#212126',
    text: '#f4f5f7',
    textSecondary: '#8e929b',
    border: '#26262c',
    shadow: 'rgba(0, 0, 0, 0.5)',

    positive: '#2fd3a1',
    negative: '#ff5c6c',
    neutral: '#8e929b',
    warning: '#f0a83a',

    cardPositive: '#0e2a22',
    cardNegative: '#2e1418',
    cardNeutral: '#18181c',

    chartLine: '#4d8dff',
    chartGrid: '#26262c',
    chartText: '#8e929b',

    tableHeader: '#111114',
    tableRowHover: '#212126',
    tableRowExpanded: '#26262c',

    buttonPrimary: '#4d8dff',
    buttonPrimaryHover: '#6a9fff',
    buttonSecondary: '#8e929b',
    buttonSecondaryHover: '#767a83',
    buttonDanger: '#ff5c6c',
    buttonDangerHover: '#e84a5a'
  },

  // ── Vivid ─────────────────────────────────────────────────────────────────
  // After Vivid Money: rich purples and soft violet gradients, rounded
  // "pocket" cards, a segmented pill nav whose current tab carries the
  // gradient. Dark is its home look. Treatment in index.css under
  // [data-theme^="vivid"].
  vivid: {
    name: 'vivid', label: 'Vivid', dark: false,
    chartPositive: '#12a77b', chartNegative: '#e5466a',
    chartSeriesStock: '#6d4aff', chartSeriesOptions: '#12a77b',
    accent: '#6d4aff', accentHover: '#5b38ef', accentText: '#ffffff',
    panel: '#f3f0fd', rule: '#e9e4fa', severity: '#e5466a',
    background: '#f3f0fd',
    surface: '#ffffff',
    surfaceHover: '#f8f6ff',
    text: '#1c1533',
    textSecondary: '#6f6888',
    border: '#e9e4fa',
    shadow: 'rgba(76, 48, 170, 0.08)',

    positive: '#12a77b',
    negative: '#e5466a',
    neutral: '#6f6888',
    warning: '#c47d0e',

    cardPositive: '#e3f6ef',
    cardNegative: '#fdebf0',
    cardNeutral: '#f3f0fd',

    chartLine: '#6d4aff',
    chartGrid: '#eeeaf9',
    chartText: '#6f6888',

    tableHeader: '#f8f6ff',
    tableRowHover: '#f5f2ff',
    tableRowExpanded: '#eee9ff',

    buttonPrimary: '#6d4aff',
    buttonPrimaryHover: '#5b38ef',
    buttonSecondary: '#6f6888',
    buttonSecondaryHover: '#5a5371',
    buttonDanger: '#e5466a',
    buttonDangerHover: '#cc3a5b'
  },

  vividDark: {
    name: 'vividDark', label: 'Vivid Dark', dark: true,
    chartPositive: '#3ddc9e', chartNegative: '#ff6b8b',
    chartSeriesStock: '#9b7bff', chartSeriesOptions: '#3ddc9e',
    accent: '#9b7bff', accentHover: '#ae93ff', accentText: '#120d24',
    panel: '#16112b', rule: '#2c2450', severity: '#ff6b8b',
    background: '#0e0a1f',
    surface: '#1a1433',
    surfaceHover: '#231b42',
    text: '#f1edff',
    textSecondary: '#a49cc4',
    border: '#2c2450',
    shadow: 'rgba(0, 0, 0, 0.45)',

    positive: '#3ddc9e',
    negative: '#ff6b8b',
    neutral: '#a49cc4',
    warning: '#f3b04a',

    cardPositive: '#122b28',
    cardNegative: '#33152a',
    cardNeutral: '#1a1433',

    chartLine: '#9b7bff',
    chartGrid: '#2c2450',
    chartText: '#a49cc4',

    tableHeader: '#16112b',
    tableRowHover: '#231b42',
    tableRowExpanded: '#2c2450',

    buttonPrimary: '#9b7bff',
    buttonPrimaryHover: '#ae93ff',
    buttonSecondary: '#a49cc4',
    buttonSecondaryHover: '#8c84ad',
    buttonDanger: '#ff6b8b',
    buttonDangerHover: '#e85878'
  }
}

// Keys that are metadata, not CSS custom properties.
const META_KEYS = new Set(['name', 'label', 'dark'])

export const applyTheme = (theme) => {
  const root = document.documentElement
  // Lets a theme carry more than colour: index.css styles cards, type and tabs
  // per theme through this attribute.
  root.dataset.theme = theme.name
  Object.entries(theme).forEach(([key, value]) => {
    if (!META_KEYS.has(key)) root.style.setProperty(`--${key}`, value)
  })
}
