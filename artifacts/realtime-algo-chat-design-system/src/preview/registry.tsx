import { lazy, type ComponentType } from 'react';
import { ColorsPage, FontsPage, LayoutPage, LogoPage, OverviewPage } from './foundations';

function lazyPage(load: () => Promise<ComponentType>) {
  return lazy(async () => ({ default: await load() }));
}
const TypographyDemo = lazyPage(() => import('./demos/pilot').then((m) => m.TypographyDemo));
const InputDemo = lazyPage(() => import('./demos/pilot').then((m) => m.InputDemo));
const RoomCardDemo = lazyPage(() => import('./demos/pilot').then((m) => m.RoomCardDemo));
const MessageBubbleDemo = lazyPage(() => import('./demos/pilot').then((m) => m.MessageBubbleDemo));
const StatusCardDemo = lazyPage(() => import('./demos/pilot').then((m) => m.StatusCardDemo));
const KeyboardAwareFormDemo = lazyPage(() => import('./demos/remaining').then((m) => m.KeyboardAwareFormDemo));
const AppleSignInButtonDemo = lazyPage(() => import('./demos/remaining').then((m) => m.AppleSignInButtonDemo));
const ErrorFallbackDemo = lazyPage(() => import('./demos/remaining').then((m) => m.ErrorFallbackDemo));
const AppFooterDemo = lazyPage(() => import('./demos/remaining').then((m) => m.AppFooterDemo));

export type PreviewEntry = { id: string; name: string; description: string; Page: ComponentType };
export type NavGroup = { name: string; entries: PreviewEntry[] };
export const DESIGN_SYSTEM = {
  title: 'RealtimeAlgoChatApp Design System',
  description: 'Dark-first, accessible foundations and mobile interaction patterns for private realtime chat.',
} as const;
export const OVERVIEW_ENTRY: PreviewEntry = { id: 'overview', name: 'Overview', description: 'The foundations and pilot components that define RealtimeAlgoChatApp.', Page: OverviewPage };
export const NAV_GROUPS: NavGroup[] = [
  { name: 'Brand', entries: [{ id: 'brand-logo', name: 'App mark', description: 'The product icon and its intended presentation.', Page: LogoPage }] },
  { name: 'Colors', entries: [{ id: 'color-roles', name: 'Color roles', description: 'Dark navy surfaces, blue actions, and semantic status colors.', Page: ColorsPage }] },
  { name: 'Fonts', entries: [{ id: 'type-scale', name: 'Type scale', description: 'Inter typography and accessible scaling behavior.', Page: FontsPage }] },
  { name: 'Layout', entries: [{ id: 'spacing-radius', name: 'Spacing and radius', description: 'A compact 4px rhythm and 12px base radius.', Page: LayoutPage }] },
  { name: 'Foundations', entries: [
    { id: 'scaled-text', name: 'Scaled text', description: 'Text that follows the in-app accessibility scale.', Page: TypographyDemo },
    { id: 'scaled-input', name: 'Scaled text input', description: 'Accessible text entry with shared scaling and focus treatment.', Page: InputDemo },
    { id: 'keyboard-aware-form', name: 'Keyboard-aware form', description: 'Scrollable form composition that keeps focused inputs reachable.', Page: KeyboardAwareFormDemo },
  ]},
  { name: 'Actions', entries: [
    { id: 'apple-sign-in', name: 'Apple sign-in', description: 'Policy-compliant Apple authentication action and disabled state.', Page: AppleSignInButtonDemo },
  ]},
  { name: 'Chat', entries: [
    { id: 'room-card', name: 'Room card', description: 'Interactive room summary with presence and navigation affordance.', Page: RoomCardDemo },
    { id: 'message-bubble', name: 'Message bubble', description: 'Self, other, system, and deleted message states.', Page: MessageBubbleDemo },
  ]},
  { name: 'Security & status', entries: [{ id: 'status-card', name: 'Status card', description: 'Encryption state, fingerprint, feedback, and guarded action.', Page: StatusCardDemo }] },
  { name: 'Feedback', entries: [{ id: 'error-fallback', name: 'Error recovery', description: 'Global failure surface with retry and optional development details.', Page: ErrorFallbackDemo }] },
  { name: 'Structure', entries: [{ id: 'app-footer', name: 'App footer', description: 'Compact branded legal footer for authentication and setup surfaces.', Page: AppFooterDemo }] },
];
export const ALL_ENTRIES = [OVERVIEW_ENTRY, ...NAV_GROUPS.flatMap((group) => group.entries)];
const duplicateIds = ALL_ENTRIES.map((entry) => entry.id).filter((id, index, ids) => ids.indexOf(id) !== index);
if (duplicateIds.length) throw new Error(`Duplicate preview page id(s): ${[...new Set(duplicateIds)].join(', ')}`);