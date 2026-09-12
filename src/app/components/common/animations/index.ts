export { TapScale } from './TapScale';
export { FadeIn } from './FadeIn';
export { SlideIn } from './SlideIn';
export { ConditionalFade } from './ConditionalFade';

/**
 * 动画预设配置
 * 统一管理项目中所有动画参数，避免硬编码
 */
export const AnimationPresets = {
  tap: { scale: 0.92 },
  tapLight: { scale: 0.96 },
  tapHeavy: { scale: 0.88 },
} as const;

/**
 * 缓动曲线预设
 * 对应 constants.ts 中的 APPLE_CURVE 和 SPRING_CURVE
 */
export const EasingPresets = {
  apple: [0.32, 0.72, 0, 1] as const,
  spring: [0.16, 1, 0.3, 1] as const,
  smooth: [0.4, 0, 0.2, 1] as const,
} as const;
