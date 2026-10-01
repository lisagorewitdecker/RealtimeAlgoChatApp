export type MessageBubbleProps = {
  content: string;
  username: string;
  time: string;
  isSelf?: boolean;
  deleted?: boolean;
  system?: boolean;
};

export function MessageBubble({ content, username, time, isSelf = false, deleted = false, system = false }: MessageBubbleProps) {
  if (system) return <p role="status" className="py-2 text-center text-xs italic text-muted-foreground">{content}</p>;
  return (
    <div className={`flex gap-2 ${isSelf ? 'justify-end' : 'justify-start'}`} aria-label={`${isSelf ? 'You' : username}: ${deleted ? 'message deleted' : content}, ${time}`}>
      {!isSelf ? <span aria-hidden className="mt-auto grid size-8 place-items-center rounded-full bg-primary font-bold text-primary-foreground">{username[0]?.toUpperCase()}</span> : null}
      <div className="max-w-[75%]">
        {!isSelf ? <p className="mb-1 ml-0.5 text-[11px] text-muted-foreground">{username}</p> : null}
        <div className={`px-3.5 py-2.5 text-[15px] leading-[1.4] ${isSelf ? 'rounded-xl rounded-br-sm bg-[#357FD5] text-white' : 'rounded-xl rounded-bl-sm bg-[#202631] text-[#F4F6FA]'} ${deleted ? 'italic opacity-50' : ''}`}>
          {deleted ? 'Message deleted' : content}
        </div>
        <p className="mt-1 text-right text-[10px] text-muted-foreground">{time}</p>
      </div>
    </div>
  );
}