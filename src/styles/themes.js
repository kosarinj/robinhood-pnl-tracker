export const themes = {
  light: {
    name: 'light',
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
    name: 'dark',
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
  }
}

export const applyTheme = (theme) => {
  const root = document.documentElement
  Object.entries(theme).forEach(([key, value]) => {
    root.style.setProperty(`--${key}`, value)
  })
}
