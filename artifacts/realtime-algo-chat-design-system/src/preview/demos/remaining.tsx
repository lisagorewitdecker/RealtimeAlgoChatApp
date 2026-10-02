import { AppFooter } from '../../components/ui/app-footer';
import { AppleSignInButton } from '../../components/ui/apple-sign-in-button';
import { ErrorFallback } from '../../components/ui/error-fallback';
import { KeyboardAwareForm } from '../../components/ui/keyboard-aware-form';
import { ScaledTextInput } from '../../components/ui/scaled-text-input';
import { Guidelines, Row, Stack } from '../parts';

export function KeyboardAwareFormDemo() {
  return (
    <div className="max-w-lg">
      <KeyboardAwareForm onSubmit={(event) => event.preventDefault()}>
        <div>
          <label className="text-sm font-medium" htmlFor="display-name">Display name</label>
          <ScaledTextInput id="display-name" className="mt-2" placeholder="Ada Lovelace" />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="room-name">Room name</label>
          <ScaledTextInput id="room-name" className="mt-2" placeholder="Algorithm Lab" />
        </div>
        <button className="min-h-11 w-full rounded-xl bg-primary font-semibold text-primary-foreground">
          Continue
        </button>
      </KeyboardAwareForm>
      <div className="mt-5">
        <Guidelines items={[
          { kind: 'do', text: 'Keep focused inputs visible and preserve taps while the keyboard is open.' },
          { kind: 'dont', text: 'Let keyboard handling change the form’s data or navigation behavior.' },
        ]} />
      </div>
    </div>
  );
}

export function AppleSignInButtonDemo() {
  return (
    <Stack label="Apple authentication action">
      <div className="w-full max-w-sm"><AppleSignInButton /></div>
      <div className="w-full max-w-sm"><AppleSignInButton disabled /></div>
      <Guidelines items={[
        { kind: 'do', text: 'Keep the control black, 52px tall, and visually equal to other social sign-in actions.' },
        { kind: 'dont', text: 'Change Apple’s label, mark contrast, or required prominence.' },
      ]} />
    </Stack>
  );
}

export function ErrorFallbackDemo() {
  return (
    <Row>
      <ErrorFallback error={new Error('Room recovery failed safely.')} resetError={() => undefined} />
    </Row>
  );
}

export function AppFooterDemo() {
  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="h-36 rounded-lg bg-muted" />
      <AppFooter year={2026} />
    </div>
  );
}