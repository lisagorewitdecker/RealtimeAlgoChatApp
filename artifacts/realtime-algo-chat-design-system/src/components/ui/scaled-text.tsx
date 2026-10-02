import type { HTMLAttributes } from 'react';

export const MIN_LEGIBLE_FONT_SIZE = 12;

export type ScaledTextProps = HTMLAttributes<HTMLSpanElement> & {
  as?: 'span' | 'p' | 'div' | 'label' | 'h1' | 'h2' | 'h3';
  scale?: number;
  size?: number;
  lineHeight?: number;
};

export function ScaledText({
  as: Component = 'span',
  scale = 1,
  size = 16,
  lineHeight,
  style,
  ...props
}: ScaledTextProps) {
  const scaledSize = Math.max(size * scale, MIN_LEGIBLE_FONT_SIZE);
  return (
    <Component
      {...props}
      style={{
        fontSize: scaledSize,
        lineHeight: lineHeight ? `${lineHeight * scale}px` : 1.4,
        ...style,
      }}
    />
  );
}