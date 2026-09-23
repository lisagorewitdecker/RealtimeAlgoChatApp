export type AppFooterProps = {
  productName?: string;
  year?: number;
};

export function AppFooter({
  productName = 'RealtimeAlgoChatApp',
  year = new Date().getFullYear(),
}: AppFooterProps) {
  return (
    <footer className="py-4 text-center text-xs text-muted-foreground">
      © {year} {productName}. Private conversations, protected.
    </footer>
  );
}