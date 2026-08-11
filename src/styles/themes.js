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
}

// Keys that are metadata, not CSS custom properties.
const META_KEYS = new Set(['name', 'label', 'dark'])

export const applyTheme = (theme) => {
  const root = document.documentElement
  Object.entries(theme).forEach(([key, value]) => {
    if (!META_KEYS.has(key)) root.style.setProperty(`--${key}`, value)
  })
}
