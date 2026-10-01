import { Component, type ErrorInfo, type ReactNode } from 'react';

export type ErrorFallbackProps = {
  error: Error;
  resetError: () => void;
  showDetails?: boolean;
};

export function ErrorFallback({
  error,
  resetError,
  showDetails = false,
}: ErrorFallbackProps) {
  return (
    <section
      role="alert"
      className="mx-auto max-w-lg rounded-xl border bg-card p-6 text-center"
    >
      <div aria-hidden className="mx-auto grid size-12 place-items-center rounded-full bg-destructive/10 text-2xl text-destructive">
        !
      </div>
      <h2 className="mt-4 text-xl font-bold">Something went wrong</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The app hit an unexpected error. Your account and messages are unchanged.
      </p>
      <button
        type="button"
        onClick={resetError}
        className="mt-5 min-h-11 rounded-xl bg-primary px-5 font-semibold text-primary-foreground"
      >
        Try again
      </button>
      {showDetails ? (
        <pre className="mt-5 max-h-40 overflow-auto rounded-lg bg-muted p-3 text-left font-mono text-xs text-muted-foreground">
          {error.message}
        </pre>
      ) : null}
    </section>
  );
}

export class ErrorBoundary extends Component<
  { children: ReactNode; showDetails?: boolean },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {}

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          showDetails={this.props.showDetails}
          resetError={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}