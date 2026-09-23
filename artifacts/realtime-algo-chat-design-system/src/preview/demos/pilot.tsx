import { MessageBubble } from '../../components/ui/message-bubble';
import { RoomCard } from '../../components/ui/room-card';
import { ScaledText } from '../../components/ui/scaled-text';
import { ScaledTextInput } from '../../components/ui/scaled-text-input';
import { StatusCard } from '../../components/ui/status-card';
import { Guidelines, Stack } from '../parts';

export function TypographyDemo() {
  return <Stack label="User-controlled text scaling"><ScaledText as="p" size={28} className="font-bold">Accessible display text</ScaledText><ScaledText as="p" size={16} scale={1.25}>Body text at 125% scale remains readable and balanced.</ScaledText><Guidelines items={[{kind:'do',text:'Scale font size and line height together, with a 12px minimum.'},{kind:'dont',text:'Bypass the shared text primitive for user-facing copy.'}]} /></Stack>;
}
export function InputDemo() {
  return <Stack label="Text input states"><ScaledTextInput placeholder="Room name" aria-label="Room name" /><ScaledTextInput value="Realtime chat" readOnly aria-label="Filled room name" /><ScaledTextInput placeholder="Unavailable" disabled aria-label="Disabled input" /></Stack>;
}
export function RoomCardDemo() {
  return <div className="max-w-xl space-y-3"><RoomCard name="Algorithm Lab" userCount={24} /><RoomCard name="Systems Lounge" userCount={7} /></div>;
}
export function MessageBubbleDemo() {
  return <div className="max-w-xl space-y-4"><MessageBubble username="Maya" content="The reconnect path is clean now." time="9:42 PM" /><MessageBubble username="You" content="Great — I’ll verify the recovery state." time="9:43 PM" isSelf /><MessageBubble username="System" content="Jordan joined the room" time="" system /><MessageBubble username="Maya" content="" time="9:44 PM" deleted /></div>;
}
export function StatusCardDemo() {
  return <div className="grid gap-4 lg:grid-cols-2"><StatusCard title="Device encryption" description="Each device has its own end-to-end encryption key." status="Registered" fingerprint="8a7f 22c1 91d4 a602" tone="success" actionLabel="Reset key" /><StatusCard title="Device encryption" description="Encrypted rooms stay closed until registration completes." status="Still registering your device key" actionLabel="Reset key" disabled /></div>;
}