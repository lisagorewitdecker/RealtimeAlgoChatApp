import { Router, type Request, type Response } from "express";
import { getAccountProfile } from "../lib/accountProfile";
import { getAssistantRateLimitCountdown } from "../lib/assistantErrors";
import { createRoomAccessCapability, type RoomAccessPurpose } from "../lib/roomAccess";
import { requireAuthorizedUser } from "../lib/requireAccountAccess";
import { getRooms } from "../socket";
import { getRoomEnvelope } from "../lib/e2eePersistence";

const router = Router();
const DEFAULT_AVATAR_EMOJI = "🧑‍💻";
const ROOM_DOCUMENT_WINDOW_MS = 60 * 1_000;
const ROOM_DOCUMENTS_PER_USER_WINDOW = 30;
const ROOM_DOCUMENTS_PER_IP_WINDOW = 120;
const ROOM_DOCUMENT_TRACKING_KEY_LIMIT = 10_000;

interface IssuanceWindow {
  startedAt: number;
  count: number;
}

const roomDocumentsByUser = new Map<string, IssuanceWindow>();
const roomDocumentsByIp = new Map<string, IssuanceWindow>();

router.get("/", async (req, res) => {
  if (!(await requireAuthorizedUser(req, res))) return;
  res.json({ rooms: getRooms() });
});

router.get("/call", (req, res) => {
  void renderRoomDocument(req, res, "call");
});

router.get("/sandbox", (req, res) => {
  void renderRoomDocument(req, res, "sandbox");
});

router.get("/:roomId/key-envelope", async (req, res, next) => {
  const userId = await requireAuthorizedUser(req, res);
  if (!userId) return;
  const roomId = getRoomId(req.params["roomId"]);
  if (!roomId) {
    res.status(400).json({ error: "A valid room is required." });
    return;
  }
  try {
    res.json({ envelope: await getRoomEnvelope(roomId, userId) });
  } catch (error) {
    next(error);
  }
});

async function renderRoomDocument(
  req: Request,
  res: Response,
  purpose: RoomAccessPurpose,
) {
  const userId = await requireAuthorizedUser(req, res);
  if (!userId) return;
  const roomId = getRoomId(req.query["roomId"]);
  if (!roomId) {
    res.status(400).json({ error: "A valid room is required." });
    return;
  }
  if (!allowRoomDocumentIssuance(userId, req.ip)) {
    res
      .status(429)
      .setHeader("Retry-After", String(ROOM_DOCUMENT_WINDOW_MS / 1_000))
      .json({ error: "Too many room access requests. Please try again later." });
    return;
  }

  let profile;
  try {
    profile = await getAccountProfile(userId);
  } catch {
    res.status(503).json({ error: "Account profile is temporarily unavailable." });
    return;
  }
  const capability = createRoomAccessCapability({
    roomId,
    userId,
    username: profile.username,
    avatarEmoji: profile.avatarEmoji,
    purpose,
  });

  res
    .setHeader("Content-Type", "text/html; charset=utf-8")
    .setHeader("Cache-Control", "no-store")
    .setHeader("Referrer-Policy", "no-referrer")
    .send(
      purpose === "call"
        ? buildCallHtml({ roomId, userId, username: profile.username, capability })
        : buildSandboxHtmlWithAssistant({
            roomId,
            username: profile.username,
            capability,
          }),
    );
}

function allowRoomDocumentIssuance(
  userId: string,
  ip: string | undefined,
): boolean {
  const now = Date.now();
  pruneIssuanceWindows(now);
  const userWindow = incrementIssuanceWindow(roomDocumentsByUser, userId, now);
  const ipKey = ip || "unknown";
  const ipWindow = incrementIssuanceWindow(roomDocumentsByIp, ipKey, now);
  const allowed =
    userWindow.count <= ROOM_DOCUMENTS_PER_USER_WINDOW &&
    ipWindow.count <= ROOM_DOCUMENTS_PER_IP_WINDOW;
  if (allowed) return true;

  // Roll back the local counters when the other dimension rejected this
  // request, so one noisy IP does not consume an account's full allowance.
  decrementIssuanceWindow(roomDocumentsByUser, userId);
  decrementIssuanceWindow(roomDocumentsByIp, ipKey);
  return false;
}

function incrementIssuanceWindow(
  windows: Map<string, IssuanceWindow>,
  key: string,
  now: number,
): IssuanceWindow {
  const current = windows.get(key);
  if (!current || now - current.startedAt >= ROOM_DOCUMENT_WINDOW_MS) {
    const created = { startedAt: now, count: 1 };
    windows.set(key, created);
    return created;
  }
  current.count += 1;
  return current;
}

function decrementIssuanceWindow(
  windows: Map<string, IssuanceWindow>,
  key: string,
): void {
  const current = windows.get(key);
  if (!current) return;
  current.count -= 1;
  if (current.count <= 0) windows.delete(key);
}

function pruneIssuanceWindows(now: number): void {
  for (const windows of [roomDocumentsByUser, roomDocumentsByIp]) {
    for (const [key, window] of windows) {
      if (now - window.startedAt >= ROOM_DOCUMENT_WINDOW_MS) {
        windows.delete(key);
      }
    }
    while (windows.size > ROOM_DOCUMENT_TRACKING_KEY_LIMIT) {
      const oldest = windows.keys().next().value;
      if (typeof oldest !== "string") break;
      windows.delete(oldest);
    }
  }
}

function getRoomId(value: unknown): string | null {
  const roomId = typeof value === "string" ? value : "";
  return /^[a-zA-Z0-9_-]{3,64}$/.test(roomId) ? roomId : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character] ?? character;
  });
}

export function buildCallHtml({
  roomId,
  userId,
  username,
  capability,
}: {
  roomId: string;
  userId: string;
  username: string;
  capability: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"><title>Call</title>
<style>*{margin:0;padding:0;box-sizing:border-box}html{-webkit-text-size-adjust:100%;text-size-adjust:100%}body{background:#0d0d1a;width:100vw;height:100vh;height:100dvh;display:flex;flex-direction:column;overflow:hidden;font-family:system-ui,sans-serif}#videos{flex:1;min-height:0;position:relative;background:#0d0d1a;display:flex;align-items:center;justify-content:center}#remoteVideo{width:100%;height:100%;object-fit:cover;background:#161628}#localVideo{position:absolute;bottom:16px;right:16px;width:min(110px,34vw);height:min(150px,25vh);min-height:96px;border-radius:14px;object-fit:cover;border:2px solid #6366f1;background:#1e1e3a;z-index:10}#status{position:absolute;top:20px;left:16px;right:16px;color:#a5b4fc;font-size:13px;line-height:1.35;background:rgba(13,13,26,.82);padding:5px 14px;border-radius:20px;z-index:10;text-align:center;overflow-wrap:anywhere}#nameTag{position:absolute;bottom:16px;left:16px;max-width:calc(100% - 158px);color:#f1f0ff;font-size:12px;line-height:1.35;background:rgba(13,13,26,.86);padding:5px 12px;border-radius:20px;z-index:10;overflow-wrap:anywhere}#controls{display:flex;flex:none;justify-content:center;gap:clamp(12px,5vw,18px);padding:12px max(16px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));background:rgba(13,13,26,.96);border-top:1px solid #2d2d4a}.btn{width:58px;height:58px;min-width:48px;min-height:48px;border-radius:50%;border:1px solid transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:24px}#muteBtn,#cameraBtn{background:#2d2d4a;color:#fff}#endBtn{background:#ef4444;color:#fff}.btn.toggled{background:#6366f1}@media(max-height:600px){#localVideo{bottom:10px;right:10px;min-height:88px}#status{top:10px}#nameTag{bottom:10px;left:10px;max-width:calc(100% - 126px)}#controls{padding-top:9px}.btn{width:52px;height:52px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}@media(forced-colors:active){#status,#nameTag,#controls,.btn{forced-color-adjust:none}.btn{border-color:#fff}}</style></head>
<body><div id="videos"><video id="remoteVideo" aria-label="Remote participant video" autoplay playsinline></video><video id="localVideo" aria-label="Your camera preview" autoplay muted playsinline></video><div id="status" role="status" aria-live="polite">Connecting…</div><div id="nameTag">${escapeHtml(username)}</div></div><div id="controls" role="toolbar" aria-label="Call controls"><button class="btn" id="muteBtn" type="button" aria-label="Mute microphone">🎤</button><button class="btn" id="cameraBtn" type="button" aria-label="Turn camera off">📷</button><button class="btn" id="endBtn" type="button" aria-label="End call" title="End call">📵</button></div>
 <script src="/api/socket-client.js"></script><script>
const ROOM_ID=${JSON.stringify(roomId)},USER_ID=${JSON.stringify(userId)},CAPABILITY=${JSON.stringify(capability)};
const socket=io({path:'/api/socket.io',auth:{token:CAPABILITY},reconnection:false});
let localStream=null,peers={},muted=false,camOff=false;
const statusEl=document.getElementById('status'),remoteVideo=document.getElementById('remoteVideo'),localVideo=document.getElementById('localVideo'),ICE={iceServers:[{urls:'stun:stun.l.google.com:19302'}]};
socket.on('connect_error',()=>statusEl.textContent='Secure connection failed');
async function init(){try{localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});localVideo.srcObject=localStream;statusEl.textContent='Ready — waiting for others'}catch{try{localStream=await navigator.mediaDevices.getUserMedia({video:false,audio:true});statusEl.textContent='Audio only'}catch{statusEl.textContent='No media access'}}socket.emit('join-room',{roomId:ROOM_ID,createIfMissing:true});}
function makePeer(remoteId){const pc=new RTCPeerConnection(ICE);peers[remoteId]=pc;if(localStream)localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));pc.ontrack=e=>{remoteVideo.srcObject=e.streams[0];statusEl.textContent='Connected'};pc.onicecandidate=e=>{if(e.candidate)socket.emit('webrtc-ice',{roomId:ROOM_ID,candidate:e.candidate,to:remoteId})};pc.onconnectionstatechange=()=>{if(['disconnected','failed'].includes(pc.connectionState)){remoteVideo.srcObject=null;statusEl.textContent='Peer disconnected'}};return pc}
socket.on('room-joined',async({users})=>{const others=users.filter(u=>u.userId!==USER_ID);statusEl.textContent=others.length?'Connecting…':'Waiting for others…';for(const o of others){const pc=makePeer(o.userId),offer=await pc.createOffer();await pc.setLocalDescription(offer);socket.emit('webrtc-offer',{roomId:ROOM_ID,offer,to:o.userId})}});
socket.on('user-left',({userId})=>{if(peers[userId]){peers[userId].close();delete peers[userId]}remoteVideo.srcObject=null;statusEl.textContent='Participant left'});
socket.on('webrtc-offer',async({offer,from})=>{const pc=makePeer(from);await pc.setRemoteDescription(offer);const answer=await pc.createAnswer();await pc.setLocalDescription(answer);socket.emit('webrtc-answer',{roomId:ROOM_ID,answer,to:from})});
socket.on('webrtc-answer',async({answer,from})=>{const pc=peers[from];if(pc)await pc.setRemoteDescription(answer)});
socket.on('webrtc-ice',async({candidate,from})=>{const pc=peers[from];if(pc&&candidate){try{await pc.addIceCandidate(candidate)}catch{}}});
document.getElementById('muteBtn').onclick=()=>{if(!localStream)return;muted=!muted;localStream.getAudioTracks().forEach(t=>t.enabled=!muted);document.getElementById('muteBtn').textContent=muted?'🔇':'🎤';document.getElementById('muteBtn').classList.toggle('toggled',muted)};
document.getElementById('cameraBtn').onclick=()=>{if(!localStream)return;camOff=!camOff;localStream.getVideoTracks().forEach(t=>t.enabled=!camOff);document.getElementById('cameraBtn').textContent=camOff?'🚫':'📷';document.getElementById('cameraBtn').classList.toggle('toggled',camOff)};
document.getElementById('endBtn').onclick=()=>{socket.emit('leave-room',{roomId:ROOM_ID});Object.values(peers).forEach(p=>p.close());if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify({type:'end-call'}));else history.back()};
init();</script></body></html>`;
}

export function buildSandboxHtml({
  roomId,
  username,
  capability,
}: {
  roomId: string;
  username: string;
  capability: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0d1a;color:#f1f0ff;font-family:'Courier New',monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}#topbar{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#161628;border-bottom:1px solid #2d2d4a;min-height:38px}#room-info,#sync-badge{font-size:11px;color:#7c8db0}#sync-badge{color:#22d3ee;background:rgba(34,211,238,.1);padding:2px 8px;border-radius:10px}#tabs{display:flex;background:#161628;border-bottom:1px solid #2d2d4a}.tab{padding:10px 18px;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.04em;color:#7c8db0;border-bottom:2px solid transparent}.tab.active{color:#6366f1;border-bottom-color:#6366f1}.tab[data-tab="preview"].active{color:#22d3ee;border-bottom-color:#22d3ee}#main{flex:1;display:flex;flex-direction:column;min-height:0}.editor-pane{flex:1;display:none;flex-direction:column}.editor-pane.active{display:flex}textarea{flex:1;width:100%;background:#0d0d1a;color:#f1f0ff;border:none;outline:none;padding:16px;font-family:'Courier New',monospace;font-size:13px;line-height:1.7;resize:none;caret-color:#6366f1}#preview-pane{flex:1;display:none;flex-direction:column}#preview-pane.active{display:flex}#preview-bar{display:flex;justify-content:flex-end;padding:6px 12px;background:#161628;border-bottom:1px solid #2d2d4a}#runBtn{background:#6366f1;color:#fff;border:none;padding:6px 16px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer}#previewFrame{flex:1;border:none;background:#fff}</style></head>
<body><div id="topbar"><span id="room-info">#${escapeHtml(roomId)} · ${escapeHtml(username)}</span><span id="sync-badge">Connecting…</span></div><div id="tabs"><div class="tab active" data-tab="html">HTML</div><div class="tab" data-tab="css">CSS</div><div class="tab" data-tab="js">JS</div><div class="tab" data-tab="preview">▶ Preview</div></div><div id="main"><div class="editor-pane active" id="html-pane"><textarea id="htmlEditor" spellcheck="false"></textarea></div><div class="editor-pane" id="css-pane"><textarea id="cssEditor" spellcheck="false"></textarea></div><div class="editor-pane" id="js-pane"><textarea id="jsEditor" spellcheck="false"></textarea></div><div id="preview-pane"><div id="preview-bar"><button id="runBtn" onclick="runPreview()">▶ Run</button></div><iframe id="previewFrame" sandbox="allow-scripts"></iframe></div></div>
 <script src="/api/crypto-client.js"></script><script src="/api/socket-client.js"></script><script>
 const ROOM_ID=${JSON.stringify(roomId)},CAPABILITY=${JSON.stringify(capability)},ROOM_KEY=globalThis.__DEVSTUDIO_ROOM_KEY__||'',socket=io({path:'/api/socket.io',auth:{token:CAPABILITY},reconnection:false}),badge=document.getElementById('sync-badge'),htmlEd=document.getElementById('htmlEditor'),cssEd=document.getElementById('cssEditor'),jsEd=document.getElementById('jsEditor');let timer=null,ignoreNext=false;
 const decryptState=payload=>{if(!payload||!ROOM_KEY||!globalThis.DevStudioCrypto)return null;const text=DevStudioCrypto.decryptText(payload.ciphertext,payload.nonce,ROOM_KEY);if(!text)return null;try{return JSON.parse(text)}catch{return null}};
 const encryptState=()=>globalThis.DevStudioCrypto?.encryptText(JSON.stringify({html:htmlEd.value,css:cssEd.value,js:jsEd.value}),ROOM_KEY)||null;
 socket.on('connect',()=>{badge.textContent='Connected';socket.emit('join-room',{roomId:ROOM_ID,createIfMissing:true})});socket.on('disconnect',()=>badge.textContent='Disconnected');socket.on('connect_error',()=>badge.textContent='Secure connection failed');
 socket.on('room-joined',({sandboxState})=>{const state=decryptState(sandboxState);if(state){htmlEd.value=state.html||'';cssEd.value=state.css||'';jsEd.value=state.js||''}badge.textContent=state||!sandboxState?'Synced':'Unable to decrypt'});
 socket.on('sandbox-update',payload=>{const state=decryptState(payload);if(!state)return;ignoreNext=true;htmlEd.value=state.html||'';cssEd.value=state.css||'';jsEd.value=state.js||'';badge.textContent='Updated';setTimeout(()=>badge.textContent='Synced',1200)});
 function broadcast(){if(ignoreNext){ignoreNext=false;return}clearTimeout(timer);timer=setTimeout(()=>{const encrypted=encryptState();if(!encrypted){badge.textContent='Encryption unavailable';return}socket.emit('sandbox-update',{roomId:ROOM_ID,ciphertext:encrypted.ciphertextB64,nonce:encrypted.nonceB64});badge.textContent='Syncing…';setTimeout(()=>badge.textContent='Synced',600)},350)}[htmlEd,cssEd,jsEd].forEach(el=>el.addEventListener('input',broadcast));document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>{document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));tab.classList.add('active');const name=tab.dataset.tab;document.querySelectorAll('.editor-pane').forEach(p=>p.classList.remove('active'));document.getElementById('preview-pane').classList.remove('active');if(name==='preview'){document.getElementById('preview-pane').classList.add('active');runPreview()}else document.getElementById(name+'-pane').classList.add('active')}));function runPreview(){const content='<!DOCTYPE html><html><head><style>'+cssEd.value+'<\\/style><\\/head><body>'+htmlEd.value+'<script>'+jsEd.value+'<\\/script><\\/body><\\/html>';document.getElementById('previewFrame').srcdoc=content}</script></body></html>`;
}

export function buildSandboxHtmlWithAssistant(args: {
  roomId: string;
  username: string;
  capability: string;
}): string {
  return buildSandboxHtml(args);
}

export default router;
