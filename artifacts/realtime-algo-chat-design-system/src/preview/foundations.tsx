import { MessageBubble } from '../components/ui/message-bubble';
import { RoomCard } from '../components/ui/room-card';
import { ScaledText } from '../components/ui/scaled-text';
import { ScaledTextInput } from '../components/ui/scaled-text-input';
import { StatusCard } from '../components/ui/status-card';
import { Guidelines } from './parts';

const core = [{name:'Primary',cls:'bg-primary'},{name:'Secondary',cls:'bg-secondary'},{name:'Accent',cls:'bg-accent'}];
const support = [{name:'Background',cls:'bg-background border'},{name:'Card',cls:'bg-card border'},{name:'Muted',cls:'bg-muted'},{name:'Destructive',cls:'bg-destructive'},{name:'Online',cls:'bg-[#55C995]'}];
function Swatch({name,cls}:{name:string;cls:string}) { return <div><div className={`h-16 rounded-xl ${cls}`} /><p className="mt-2 text-sm font-medium">{name}</p></div>; }

export function OverviewPage() {
  return <div className="space-y-6">
    <section className="grid gap-4 rounded-xl border bg-card p-5 lg:grid-cols-[1fr_1.2fr]">
      <div><p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Dark-first mobile system</p><h2 className="mt-3 text-3xl font-bold">Private chat, clear states.</h2><p className="mt-3 text-muted-foreground">A calm navy interface with accessible type, bright blue actions, and explicit security feedback.</p></div>
      <RoomCard name="Algorithm Lab" userCount={24} />
    </section>
    <div className="grid gap-4 lg:grid-cols-2"><section className="space-y-4 rounded-xl border bg-card p-5"><ScaledText as="h3" size={22} className="font-bold">Scaled typography</ScaledText><ScaledTextInput placeholder="Message the room" /><MessageBubble username="You" content="The pilot is ready to review." time="9:43 PM" isSelf /></section><StatusCard title="Device encryption" description="Each device keeps its own end-to-end encryption key." status="Registered" fingerprint="8a7f 22c1 91d4 a602" tone="success" actionLabel="Reset key" /></div>
  </div>;
}
export function LogoPage() { return <div className="rounded-xl border bg-card p-8"><img src={`${import.meta.env.BASE_URL}brand-icon.png`} alt="RealtimeAlgoChatApp icon" className="size-32 rounded-[28px] shadow-2xl" /><h2 className="mt-6 text-xl font-semibold">RealtimeAlgoChatApp</h2><p className="mt-2 text-sm text-muted-foreground">Use the genuine app icon. Do not redraw or approximate the mark.</p></div>; }
export function ColorsPage() { return <div className="space-y-8 rounded-xl border bg-card p-6"><section><h2 className="font-semibold">Core palette</h2><div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">{core.map((s)=><Swatch key={s.name} {...s}/>)}</div></section><section><h2 className="font-semibold">Surfaces and states</h2><div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">{support.map((s)=><Swatch key={s.name} {...s}/>)}</div></section><Guidelines items={[{kind:'do',text:'Use blue for actions and green only for presence or success.'},{kind:'dont',text:'Treat the dark-first light token set as a white marketing theme.'}]} /></div>; }
export function FontsPage() { return <div className="space-y-5 rounded-xl border bg-card p-6"><p className="text-4xl font-bold">Inter Bold 700</p><p className="text-2xl font-semibold">Inter Semibold 600</p><p className="text-base">Inter Regular 400 supports dense, readable chat content.</p><p className="font-mono text-sm text-secondary-foreground">8a7f 22c1 91d4 a602</p><Guidelines items={[{kind:'do',text:'Use Inter 400–700 and preserve user-controlled text scaling.'},{kind:'dont',text:'Render user-facing text below the 12px minimum.'}]} /></div>; }
export function LayoutPage() { return <div className="grid gap-4 lg:grid-cols-2"><section className="rounded-xl border bg-card p-6"><h2 className="font-semibold">4px spacing rhythm</h2><div className="mt-6 space-y-4">{[4,8,12,16,24].map((n)=><div key={n} className="flex items-center gap-4"><span className="w-8 text-xs text-muted-foreground">{n}</span><div className="h-3 rounded-full bg-primary" style={{width:n*4}} /></div>)}</div></section><section className="rounded-xl border bg-card p-6"><h2 className="font-semibold">12px radius</h2><div className="mt-6 h-32 rounded-xl border bg-muted" /><p className="mt-4 text-sm text-muted-foreground">Cards and bubbles use a 12px base; message tails tighten one lower corner to 4px.</p></section></div>; }