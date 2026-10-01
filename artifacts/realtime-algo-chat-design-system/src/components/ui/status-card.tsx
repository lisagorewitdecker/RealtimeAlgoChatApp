export type StatusCardProps = {
  title: string;
  description: string;
  status: string;
  fingerprint?: string;
  tone?: 'default' | 'success' | 'danger';
  actionLabel?: string;
  disabled?: boolean;
};

export function StatusCard({ title, description, status, fingerprint, tone = 'default', actionLabel, disabled }: StatusCardProps) {
  const toneClass = tone === 'danger' ? 'text-destructive' : tone === 'success' ? 'text-[#55C995]' : 'text-primary';
  return (
    <section className="rounded-xl border bg-card p-4 text-card-foreground">
      <p className={`text-xs font-semibold uppercase tracking-[0.12em] ${toneClass}`}>{title}</p>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-4 rounded-lg bg-muted p-3">
        <p className="text-xs text-muted-foreground">Status</p>
        <p className="mt-1 text-sm font-semibold">{status}</p>
        {fingerprint ? <code className="mt-2 block font-mono text-xs text-secondary-foreground">{fingerprint}</code> : null}
      </div>
      {actionLabel ? <button disabled={disabled} className="mt-4 min-h-11 rounded-lg bg-destructive/10 px-4 text-sm font-semibold text-destructive disabled:opacity-50">{actionLabel}</button> : null}
    </section>
  );
}