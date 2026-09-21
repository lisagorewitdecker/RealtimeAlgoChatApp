import { forwardRef, type InputHTMLAttributes } from 'react';

export type ScaledTextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  scale?: number;
};

export const ScaledTextInput = forwardRef<HTMLInputElement, ScaledTextInputProps>(
  ({ scale = 1, className = '', style, ...props }, ref) => (
    <input
      ref={ref}
      {...props}
      className={`min-h-11 w-full rounded-lg border bg-background px-3 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      style={{ fontSize: Math.max(16 * scale, 12), ...style }}
    />
  ),
);
ScaledTextInput.displayName = 'ScaledTextInput';