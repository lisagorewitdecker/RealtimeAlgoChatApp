import type { FormHTMLAttributes, ReactNode } from 'react';

export type KeyboardAwareFormProps = FormHTMLAttributes<HTMLFormElement> & {
  children: ReactNode;
};

export function KeyboardAwareForm({
  children,
  className = '',
  ...props
}: KeyboardAwareFormProps) {
  return (
    <form
      {...props}
      className={`max-h-[32rem] space-y-4 overflow-y-auto rounded-xl border bg-card p-5 [scrollbar-gutter:stable] ${className}`}
    >
      {children}
    </form>
  );
}