import type { ButtonHTMLAttributes } from 'react';

export type AppleSignInButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function AppleSignInButton({
  className = '',
  children = 'Continue with Apple',
  ...props
}: AppleSignInButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`flex min-h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-black px-5 text-base font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <span aria-hidden className="text-xl leading-none">●</span>
      {children}
    </button>
  );
}