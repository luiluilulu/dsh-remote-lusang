export type ColorScheme = 'light' | 'dark'

export type ThemePreference = 'system' | ColorScheme

export type TypographyDensity = 'standard' | 'compact'

export function isTypographyDensity(value: unknown): value is TypographyDensity {
  return value === 'standard' || value === 'compact'
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function resolveColorScheme(
  preference: ThemePreference,
  systemScheme: ColorScheme | null | undefined,
): ColorScheme {
  if (preference === 'light' || preference === 'dark') return preference
  return systemScheme === 'dark' ? 'dark' : 'light'
}

export interface ThemeColors {
  /** Page canvas behind cards and grouped lists. */
  background: string
  /** Opaque sheets, inputs and the composer. */
  surface: string
  /** White card fill; alpha applies only to the background, never its children. */
  card: string
  /** Card composited over the canvas, for swipe rows that must hide actions underneath. */
  cardOpaque: string
  /** Pills, pressed rows and other fills drawn on a surface. */
  surfaceStrong: string
  /** Inset grouped lists (settings-style sections) drawn on the canvas. */
  grouped: string
  /** Floating header chips and other controls that hover over content. */
  elevated: string
  ink: string
  muted: string
  subtle: string
  primary: string
  primaryPressed: string
  primarySoft: string
  accent: string
  accentSoft: string
  /** High-contrast fill for the main floating call to action (black in light, white in dark). */
  inverse: string
  onInverse: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  border: string
  separator: string
  disabled: string
  white: string
  scrim: string
  modalBackdrop: string
  menuDismiss: string
  shadow: string
  /** Full-bleed conversation canvas; official chat screens paint a pure canvas fill. */
  chatCanvas: string
  /** Right-aligned user message bubble fill (official blue-50 in light). */
  chatBubble: string
  /** Composer card fill (official input-major token). */
  composerFill: string
  /** 1px outline used by the composer and other official cards. */
  hairline: string
  /** Supporting caption text such as the composer disclaimer (official label-tertiary). */
  faint: string
  /** Session drawer canvas (official sidebar fill). */
  sidebarFill: string
  /** Session drawer divider hairline. */
  sidebarBorder: string
  /** Drawer row hover/pressed fill. */
  sidebarHover: string
  /** Selected drawer row fill. */
  sidebarActive: string
  /** Label color inside a selected drawer row. */
  sidebarActiveText: string
  /** Drawer section captions such as 今天 / 昨天 / 30 天内. */
  sidebarSection: string
  /** White pill that opens a new conversation inside the drawer. */
  sidebarActionFill: string
  /** Brand-colored text and links; lighter than `primary` on dark surfaces. */
  linkText: string
}

// DeepSeek palette: ink #0F1115, DeepSeek blue (#3964FE) accents, white cards on the
// official #F9FAFB canvas with rgba(0,0,0,.10) hairlines and #61666B readable muted text.
export const lightColors: ThemeColors = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  card: '#FFFFFF',
  cardOpaque: '#FFFFFF',
  surfaceStrong: '#F1F3F5',
  grouped: '#F9FAFB',
  elevated: '#FFFFFF',
  ink: '#0F1115',
  muted: '#61666B',
  subtle: '#ADB2B8',
  primary: '#3964FE',
  primaryPressed: '#2F55E8',
  primarySoft: '#EDF3FE',
  accent: '#3964FE',
  accentSoft: '#EDF3FE',
  inverse: '#0F1115',
  onInverse: '#FFFFFF',
  success: '#1E8449',
  successSoft: '#E2F3E9',
  warning: '#95600A',
  warningSoft: '#FBEFD5',
  danger: '#C2362F',
  dangerSoft: '#FBE7E5',
  border: '#EDEDED',
  separator: '#EDEDED',
  disabled: '#B3B9C4',
  white: '#FFFFFF',
  scrim: 'rgba(15, 17, 21, 0.40)',
  modalBackdrop: 'rgba(15, 17, 21, 0.42)',
  menuDismiss: 'rgba(15, 17, 21, 0.14)',
  shadow: '#1A2638',
  chatCanvas: '#FFFFFF',
  chatBubble: '#EDF3FE',
  composerFill: '#FFFFFF',
  hairline: 'rgba(0, 0, 0, 0.10)',
  faint: '#81858C',
  sidebarFill: '#F9FAFB',
  sidebarBorder: 'rgba(0, 0, 0, 0.04)',
  sidebarHover: '#F1F3F5',
  sidebarActive: '#E4EDFD',
  sidebarActiveText: '#3964FE',
  sidebarSection: '#81858C',
  sidebarActionFill: '#FFFFFF',
  linkText: '#3964FE',
}

export const darkColors: ThemeColors = {
  background: '#151517',
  surface: '#2C2C2E',
  card: '#232325',
  cardOpaque: '#232325',
  surfaceStrong: '#43454A',
  grouped: '#232325',
  elevated: '#2C2C2E',
  ink: '#F9FAFB',
  muted: '#CFD3D6',
  subtle: '#81858C',
  primary: '#3964FE',
  primaryPressed: '#5686FE',
  primarySoft: '#283142',
  accent: '#679EFE',
  accentSoft: '#283142',
  inverse: '#F9FAFB',
  onInverse: '#151517',
  success: '#4ED17E',
  successSoft: '#233C2C',
  warning: '#F7AD31',
  warningSoft: '#27241F',
  danger: '#F25A5A',
  dangerSoft: '#2E1618',
  border: 'rgba(255, 255, 255, 0.10)',
  separator: 'rgba(255, 255, 255, 0.08)',
  disabled: '#4E5562',
  white: '#FFFFFF',
  scrim: 'rgba(0, 0, 0, 0.58)',
  modalBackdrop: 'rgba(0, 0, 0, 0.62)',
  menuDismiss: 'rgba(0, 0, 0, 0.45)',
  shadow: '#000000',
  chatCanvas: '#151517',
  chatBubble: '#2C2C2E',
  composerFill: '#2C2C2E',
  hairline: 'rgba(0, 0, 0, 0.10)',
  faint: '#ADB2B8',
  sidebarFill: '#1B1B1C',
  sidebarBorder: 'rgba(255, 255, 255, 0.04)',
  sidebarHover: '#2C2C2E',
  sidebarActive: '#353638',
  sidebarActiveText: '#F9FAFB',
  sidebarSection: '#ADB2B8',
  sidebarActionFill: '#2C2C2E',
  linkText: '#679EFE',
}

export function colorsForScheme(scheme: ColorScheme): ThemeColors {
  return scheme === 'dark' ? darkColors : lightColors
}

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  /** Grouped lists, cards and sheets. */
  xl: 22,
  /** The composer and other large floating surfaces. */
  xxl: 28,
  pill: 999,
} as const

/** Soft lift for floating controls (header chips, cards, composer). */
export function floatingShadow(colors: { shadow: string }, strength: 'low' | 'high' = 'low') {
  return strength === 'high'
    ? { shadowColor: colors.shadow, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 6 }
    : { shadowColor: colors.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 8, elevation: 2 }
}

/** Official composer lift: barely visible, wide and soft rather than a hard drop shadow. */
export function composerShadow(colors: { shadow: string }) {
  return {
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 1,
  }
}

/** Soft brand glow for prominent floating call-to-action pills (e.g. create session). */
export function brandGlowShadow(colors: { primary: string; shadow: string }) {
  return {
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 4,
  }
}

export const standardType = {
  hero: { fontSize: 32, lineHeight: 38, fontWeight: '700' as const, letterSpacing: -0.6, includeFontPadding: false },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' as const, letterSpacing: -0.3, includeFontPadding: false },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const, includeFontPadding: false },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const, includeFontPadding: false },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const, includeFontPadding: false },
  small: { fontSize: 14, lineHeight: 19, fontWeight: '400' as const, includeFontPadding: false },
  smallStrong: { fontSize: 14, lineHeight: 19, fontWeight: '600' as const, includeFontPadding: false },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const, includeFontPadding: false },
} as const

export const compactType = {
  hero: { fontSize: 30, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.6, includeFontPadding: false },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' as const, letterSpacing: -0.3, includeFontPadding: false },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const, includeFontPadding: false },
  body: { fontSize: 15, lineHeight: 20, fontWeight: '400' as const, includeFontPadding: false },
  bodyStrong: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const, includeFontPadding: false },
  small: { fontSize: 13, lineHeight: 17, fontWeight: '400' as const, includeFontPadding: false },
  smallStrong: { fontSize: 13, lineHeight: 17, fontWeight: '600' as const, includeFontPadding: false },
  caption: { fontSize: 11, lineHeight: 15, fontWeight: '500' as const, includeFontPadding: false },
} as const

export function typeForDensity(density: TypographyDensity) {
  return density === 'compact' ? compactType : standardType
}

export const type = standardType
