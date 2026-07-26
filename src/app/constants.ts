export const AMBIENT_BG = "https://images.unsplash.com/photo-1541140134513-85a161dc4a00?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtaW5pbWFsaXN0JTIwZ3JheSUyMGFic3RyYWN0JTIwdGV4dHVyZXxlbnwxfHx8fDE3ODA5Mjg1NjZ8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral";

export const RIGHT_RAIL_WIDTH = 56;
export const SMALL_SCREEN_SIDEBAR_BREAKPOINT = 1200;
export const MIN_CHAT_WIDTH = 520;
export const COLLAPSED_CHAT_WIDTH = 0;
export const MIN_SIDEBAR_WIDTH = 220;
export const MIN_EDITOR_WIDTH = 260;
export const MAX_EDITOR_WIDTH = 880;
export const BROWSER_PANEL_WIDTH = 500;
export const MIN_BROWSER_WIDTH = 360;
export const MIN_SETTINGS_WIDTH = 320;
export const CHAT_EDITOR_GUTTER = 520;

export const APPLE_CURVE = [0.32, 0.72, 0, 1] as const;
export const SPRING_CURVE = [0.16, 1, 0.3, 1] as const;

export const DURATION = {
  micro: 0.15,
  fast: 0.28,
  normal: 0.45,
  panel: 0.55,
  card: 0.6,
  cardExpand: 0.8,
} as const;

export const PANEL_TRANSITION = {
  duration: DURATION.panel,
  ease: SPRING_CURVE,
} as const;

export const CARD_HEADER_TRANSITION = {
  duration: DURATION.card,
  ease: APPLE_CURVE,
} as const;

export const CARD_EXPAND_TRANSITION = {
  duration: DURATION.cardExpand,
  ease: APPLE_CURVE,
  opacity: { duration: DURATION.fast + 0.12 },
} as const;
