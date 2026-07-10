export const themes = {
  light: {
    name: 'light', label: 'Light', dark: false,
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
