export type RoomCardProps = {
  name: string;
  userCount: number;
  onPress?: () => void;
};

export function RoomCard({ name, userCount, onPress }: RoomCardProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      aria-label={`Join ${name}, ${userCount} online`}
      className="flex min-h-18 w-full items-center gap-3 rounded-xl border bg-card p-3.5 text-left text-card-foreground transition hover:bg-muted/70 active:scale-[0.99]"
    >
      <span aria-hidden className="grid size-12 place-items-center rounded-lg bg-secondary text-xl text-primary">◌</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{name}</span>
        <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-[#55C995]" />
          {userCount} online
        </span>
      </span>
      <span aria-hidden className="text-xl text-muted-foreground">›</span>
    </button>
  );
}