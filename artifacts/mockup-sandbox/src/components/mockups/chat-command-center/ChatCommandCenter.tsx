import React, { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  Hash,
  Menu,
  Pin,
  Plus,
  Search,
  Send,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";

type Room = {
  id: string;
  name: string;
  topic: string;
  count: number;
  time: string;
  initials: string;
  color: string;
  activity: string;
  unread?: number;
  pinned?: boolean;
};

const initialRooms: Room[] = [
  {
    id: "algorithms",
    name: "algorithms",
    topic: "Designing better systems together",
    count: 18,
    time: "now",
    initials: "AL",
    color: "#e6a15c",
    activity: "Mina shared a new thread",
    unread: 4,
    pinned: true,
  },
  {
    id: "launch-week",
    name: "launch-week",
    topic: "A quiet place for launch notes",
    count: 7,
    time: "2m",
    initials: "LW",
    color: "#76b8ae",
    activity: "Jonah is typing…",
    unread: 2,
    pinned: true,
  },
  {
    id: "random",
    name: "random",
    topic: "Low stakes, high signal",
    count: 23,
    time: "11m",
    initials: "RN",
    color: "#b590ce",
    activity: "Last message from Priya",
  },
  {
    id: "design-crit",
    name: "design-crit",
    topic: "Bring the work, not the pitch",
    count: 11,
    time: "38m",
    initials: "DC",
    color: "#d77f85",
    activity: "Last message from Lio",
  },
];

const messages = [
  { name: "Mina K.", initials: "MK", color: "#e6a15c", copy: "The smaller state machine feels easier to explain. I added a sketch above.", time: "9:41" },
  { name: "You", initials: "YO", color: "#5d92d5", copy: "This is much clearer. I’m going to try it against the retry case.", time: "9:43", own: true },
  { name: "Mina K.", initials: "MK", color: "#e6a15c", copy: "Perfect. Drop the result here when you have it.", time: "9:45" },
];

export default function ChatCommandCenter() {
  const [rooms, setRooms] = useState(initialRooms);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "pinned">("all");
  const [composeOpen, setComposeOpen] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);

  const selected = rooms.find((room) => room.id === selectedId);
  const visibleRooms = useMemo(
    () =>
      rooms.filter((room) => {
        const matchesFilter = filter === "all" || room.pinned;
        const matchesQuery = `${room.name} ${room.topic}`.toLowerCase().includes(query.toLowerCase());
        return matchesFilter && matchesQuery;
      }),
    [filter, query, rooms],
  );

  function togglePin(id: string) {
    setRooms((current) => current.map((room) => (room.id === id ? { ...room, pinned: !room.pinned } : room)));
  }

  function createRoom(event: React.FormEvent) {
    event.preventDefault();
    const cleanName = roomName.trim().replace(/^#/, "");
    if (!cleanName) return;
    const newRoom: Room = {
      id: cleanName.toLowerCase().replace(/\s+/g, "-"),
      name: cleanName,
      topic: "A new room for good questions",
      count: 1,
      time: "now",
      initials: cleanName.slice(0, 2).toUpperCase(),
      color: "#79a9d3",
      activity: "You just opened this room",
      pinned: true,
    };
    setRooms((current) => [newRoom, ...current]);
    setRoomName("");
    setComposeOpen(false);
  }

  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    setDraft("");
    setSent(true);
    window.setTimeout(() => setSent(false), 1800);
  }

  if (selected) {
    return (
      <main className="chat-shell detail-shell">
        <header className="detail-header">
          <button className="icon-button" onClick={() => setSelectedId(null)} aria-label="Back to rooms"><ArrowLeft size={19} /></button>
          <div className="detail-title"><div className="room-title-row"><span className="room-hash">#</span><h1>{selected.name}</h1></div><span><i className="online-dot" /> {selected.count} people here</span></div>
          <button className="icon-button" aria-label="Room settings"><Settings2 size={18} /></button>
        </header>
        <section className="room-intro">
          <div className="large-mark" style={{ backgroundColor: selected.color }}>{selected.initials}</div>
          <p className="eyebrow">ROOM NOTES</p>
          <h2>{selected.topic}</h2>
          <p className="intro-copy">Messages are end-to-end encrypted. Keep it useful, keep it kind.</p>
          <div className="date-rule"><span>Today</span></div>
        </section>
        <section className="messages">
          {messages.map((message) => <article className={`message ${message.own ? "own" : ""}`} key={`${message.name}-${message.time}`}><div className="avatar" style={{ backgroundColor: message.color }}>{message.initials}</div><div className="message-body"><div className="message-meta"><strong>{message.name}</strong><time>{message.time}</time></div><p>{message.copy}</p></div></article>)}
          {sent && <div className="sent-note"><Check size={13} /> Message sent securely</div>}
        </section>
        <form className="composer" onSubmit={sendMessage}>
          <button type="button" className="composer-plus" aria-label="Add attachment"><Plus size={18} /></button>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Message #${selected.name}`} aria-label="Message" />
          <button className="send-button" aria-label="Send message" type="submit"><Send size={17} /></button>
        </form>
      </main>
    );
  }

  return (
    <main className="chat-shell">
      <header className="topbar">
        <button className="brand" aria-label="Open navigation"><span className="brand-mark"><Sparkles size={15} /></span><span>Realtime<span className="brand-muted">Algo</span></span></button>
        <div className="top-actions"><button className="icon-button" aria-label="Notifications"><Bell size={18} /><i className="notification-dot" /></button><button className="profile" aria-label="Open profile">LM</button></div>
      </header>
      <section className="welcome">
        <div><p className="eyebrow">TUESDAY, OCTOBER 14</p><h1>Good morning, Lisa.</h1><p className="welcome-copy">Pick up where the room left off.</p></div>
        <button className="menu-button" aria-label="Open menu"><Menu size={19} /></button>
      </section>
      <div className="search-wrap"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a room or conversation" aria-label="Find a room" />{query && <button onClick={() => setQuery("")} aria-label="Clear search"><X size={15} /></button>}<kbd>⌘ K</kbd></div>
      <section className="section-heading"><div><p className="eyebrow">YOUR ROOMS</p><h2>Conversation, sorted.</h2></div><button className="new-room" onClick={() => setComposeOpen(true)}><Plus size={16} /> New room</button></section>
      <div className="filter-tabs" role="tablist"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All rooms <span>{rooms.length}</span></button><button className={filter === "pinned" ? "active" : ""} onClick={() => setFilter("pinned")}><Pin size={13} /> Pinned <span>{rooms.filter((room) => room.pinned).length}</span></button></div>
      <section className="room-list" aria-label="Rooms">
        {visibleRooms.map((room, index) => <button className={`room-row ${index === 0 && filter === "all" ? "featured" : ""}`} onClick={() => setSelectedId(room.id)} key={room.id}>
          <div className="room-icon" style={{ backgroundColor: room.color }}>{room.initials}</div><div className="room-content"><div className="room-name-line"><strong><span>#</span>{room.name}</strong>{room.pinned && <Pin size={13} className="pinned-icon" />}<time>{room.time}</time></div><p>{room.activity}</p></div>{room.unread ? <span className="unread">{room.unread}</span> : <ChevronRight size={16} className="row-arrow" />}
        </button>)}
        {visibleRooms.length === 0 && <div className="empty-state"><Search size={21} /><strong>No rooms found</strong><span>Try another search or create a new room.</span></div>}
      </section>
      <section className="pulse-card"><div className="pulse-icon"><Users size={17} /></div><div><p className="eyebrow">LIVE PULSE</p><strong>59 people are talking now</strong><span>Across {rooms.length} rooms · 3 new threads</span></div><ArrowUpRight size={17} /></section>
      <footer><span><i className="online-dot" /> All systems quiet</span><span>Encrypted by default</span></footer>
      {composeOpen && <div className="modal-backdrop" onClick={() => setComposeOpen(false)}><form className="new-room-modal" onClick={(event) => event.stopPropagation()} onSubmit={createRoom}><div className="modal-top"><div><p className="eyebrow">MAKE SPACE</p><h2>Start a new room</h2></div><button type="button" className="icon-button" onClick={() => setComposeOpen(false)} aria-label="Close"><X size={18} /></button></div><label htmlFor="room-name">Room name</label><div className="room-input"><span>#</span><input id="room-name" autoFocus value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="e.g. product-thinking" /></div><p className="modal-hint">A focused place for the conversation to grow.</p><button className="create-button" type="submit">Create room <ArrowUpRight size={16} /></button></form></div>}
    </main>
  );
}

const style = document.createElement("style");
style.textContent = `
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
:root{font-family:'Plus Jakarta Sans',sans-serif;color:#f5f1e9;background:#10151b}
*{box-sizing:border-box}button,input{font:inherit}.chat-shell{min-height:100dvh;background:#10151b;color:#f5f1e9;padding:0 20px 18px;position:relative;overflow:hidden}.chat-shell:after{content:"";position:fixed;inset:0;pointer-events:none;opacity:.035;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}.topbar{height:68px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #29313a}.brand{border:0;background:none;color:#f5f1e9;font-size:15px;font-weight:800;display:flex;align-items:center;gap:9px;padding:0}.brand-mark{width:25px;height:25px;border-radius:8px;background:#df875c;color:#10151b;display:grid;place-items:center}.brand-muted{color:#8a96a3;font-weight:500}.top-actions{display:flex;align-items:center;gap:16px}.icon-button,.menu-button{border:0;background:transparent;color:#aab4be;display:grid;place-items:center;position:relative;width:32px;height:32px;border-radius:8px}.icon-button:hover,.menu-button:hover{background:#242d35;color:#f5f1e9}.profile{border:0;background:#bf8d75;color:#1a1716;width:29px;height:29px;border-radius:50%;font-size:10px;font-weight:800}.notification-dot{width:5px;height:5px;background:#df875c;border-radius:50%;position:absolute;top:6px;right:6px;border:1px solid #10151b}.welcome{display:flex;justify-content:space-between;align-items:flex-start;padding:31px 0 24px}.eyebrow{font:500 10px 'DM Mono',monospace;letter-spacing:.14em;color:#8b9aa6;margin:0 0 8px}.welcome h1{font-size:24px;letter-spacing:-.05em;margin:0 0 6px;line-height:1.15}.welcome-copy{margin:0;color:#85929e;font-size:13px}.menu-button{margin-top:2px}.search-wrap{height:44px;border:1px solid #303a43;background:#1a222a;border-radius:10px;display:flex;align-items:center;gap:10px;padding:0 12px;color:#80909e}.search-wrap input{border:0;outline:0;color:#f5f1e9;background:transparent;font-size:12px;flex:1;min-width:0}.search-wrap input::placeholder{color:#74818d}.search-wrap button{border:0;background:none;color:#8e9aa5;padding:0}.search-wrap kbd{font:10px 'DM Mono',monospace;color:#77838e;border:1px solid #3b4650;border-radius:4px;padding:3px 5px}.section-heading{display:flex;justify-content:space-between;align-items:end;padding:32px 0 16px}.section-heading h2{font-size:17px;letter-spacing:-.03em;margin:0}.new-room{border:1px solid #3d4c56;background:#e2a36c;color:#171719;border-radius:7px;padding:8px 10px;font-size:11px;font-weight:800;display:flex;align-items:center;gap:4px}.filter-tabs{display:flex;gap:7px;border-bottom:1px solid #29313a;padding-bottom:10px}.filter-tabs button{background:transparent;color:#788691;border:0;padding:7px 9px;font-size:11px;display:flex;align-items:center;gap:5px;border-radius:6px}.filter-tabs button.active{background:#28343d;color:#f2eee7}.filter-tabs span{font:10px 'DM Mono',monospace;color:#8494a0}.room-list{padding-top:4px}.room-row{width:100%;border:0;border-bottom:1px solid #273039;background:transparent;color:#f5f1e9;text-align:left;display:flex;align-items:center;gap:11px;padding:14px 2px;cursor:pointer;transition:background .2s,transform .2s}.room-row:hover{background:#172029;transform:translateX(3px)}.room-row.featured{padding-top:17px;padding-bottom:17px}.room-icon{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;color:#192027;font-size:10px;font-weight:800;flex:none}.room-content{min-width:0;flex:1}.room-name-line{display:flex;align-items:center;gap:6px}.room-name-line strong{font-size:13px;letter-spacing:-.02em}.room-name-line strong span{color:#84909a;margin-right:2px}.room-name-line time{margin-left:auto;color:#75828c;font:10px 'DM Mono',monospace}.room-content p{margin:4px 0 0;color:#84919c;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.pinned-icon{color:#de9b64;transform:rotate(35deg)}.row-arrow{color:#65737e}.unread{background:#db895e;color:#1a1716;border-radius:9px;min-width:20px;text-align:center;padding:3px 5px;font:10px 'DM Mono',monospace}.pulse-card{background:#1b282c;border:1px solid #34463e;border-radius:10px;margin-top:19px;padding:13px;display:flex;align-items:center;gap:11px}.pulse-icon{width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:#29463f;color:#8bc0a8;flex:none}.pulse-card div:nth-child(2){min-width:0;flex:1}.pulse-card strong{font-size:11px;display:block}.pulse-card div span{font-size:10px;color:#88a099;display:block;margin-top:4px}.pulse-card>svg{color:#87b39d}footer{display:flex;justify-content:space-between;color:#71808a;font:10px 'DM Mono',monospace;padding:20px 1px 0}footer span{display:flex;align-items:center;gap:5px}.online-dot{width:6px;height:6px;border-radius:50%;background:#76c19a;display:inline-block}.empty-state{text-align:center;padding:38px 20px;color:#83909a;display:flex;align-items:center;flex-direction:column;gap:8px}.empty-state strong{color:#e9e5dd;font-size:13px}.empty-state span{font-size:11px}.modal-backdrop{position:fixed;z-index:5;inset:0;background:rgba(6,9,12,.76);display:flex;align-items:flex-end;padding:14px}.new-room-modal{width:100%;background:#1d272e;border:1px solid #3a4b54;border-radius:14px;padding:19px;box-shadow:0 18px 55px rgba(0,0,0,.4)}.modal-top{display:flex;justify-content:space-between;align-items:start;margin-bottom:24px}.modal-top h2{font-size:20px;letter-spacing:-.04em;margin:0}.new-room-modal label{font:10px 'DM Mono',monospace;color:#9ba8b2;display:block;text-transform:uppercase;letter-spacing:.1em;margin-bottom:7px}.room-input{height:45px;border:1px solid #50606a;background:#12191e;border-radius:8px;display:flex;align-items:center;padding:0 12px;gap:6px}.room-input span{color:#df9565}.room-input input{border:0;background:transparent;outline:0;color:#f5f1e9;flex:1;font-size:13px}.room-input input::placeholder{color:#667682}.modal-hint{color:#86949e;font-size:11px;margin:10px 0 21px}.create-button{border:0;border-radius:7px;background:#df9565;color:#1b1817;font-weight:800;font-size:12px;padding:11px 14px;display:flex;align-items:center;gap:7px;margin-left:auto}.detail-shell{padding:0 18px}.detail-header{height:68px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #29313a}.detail-title{text-align:center}.room-title-row{display:flex;align-items:center;justify-content:center;gap:4px}.room-title-row h1{font-size:15px;margin:0;letter-spacing:-.03em}.room-hash{color:#dc9463}.detail-title>span{font:10px 'DM Mono',monospace;color:#7b8a95}.room-intro{text-align:center;padding:30px 20px 6px}.large-mark{margin:0 auto 14px;width:53px;height:53px;border-radius:15px;display:grid;place-items:center;color:#182028;font-size:13px;font-weight:800}.room-intro h2{font-size:17px;margin:0 auto 8px;letter-spacing:-.04em;max-width:280px}.intro-copy{font-size:11px;color:#82909b;line-height:1.5;max-width:260px;margin:0 auto}.date-rule{border-bottom:1px solid #2e3942;height:22px;margin:8px 0 18px}.date-rule span{background:#10151b;padding:0 9px;color:#788690;font:10px 'DM Mono',monospace}.messages{min-height:490px}.message{display:flex;gap:9px;margin:17px 0}.message.own{flex-direction:row-reverse}.avatar{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;color:#171b1e;font-size:8px;font-weight:800;flex:none}.message-body{max-width:77%}.message.own .message-body{text-align:right}.message-meta{display:flex;gap:8px;align-items:baseline}.message.own .message-meta{justify-content:flex-end}.message-meta strong{font-size:10px}.message-meta time{font:9px 'DM Mono',monospace;color:#71808a}.message-body p{font-size:12px;line-height:1.45;color:#c7cbd0;margin:5px 0 0}.sent-note{font:10px 'DM Mono',monospace;color:#80b49a;text-align:center;display:flex;justify-content:center;align-items:center;gap:5px;margin-top:14px}.composer{height:47px;border:1px solid #3e4c56;background:#1a232a;border-radius:9px;display:flex;align-items:center;gap:7px;padding:0 7px}.composer input{border:0;background:transparent;outline:0;color:#eef0ed;font-size:12px;flex:1;min-width:0}.composer input::placeholder{color:#76838d}.composer-plus,.send-button{border:0;background:transparent;color:#84929c;display:grid;place-items:center;width:29px;height:29px;border-radius:7px}.send-button{background:#df9565;color:#1c1817}.composer-plus:hover{background:#2b363e}
`;
document.head.appendChild(style);