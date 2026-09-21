import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const bans = await db.execute(sql`select room_id, user_id, expires_at from room_bans limit 20`);
console.log("bans:", JSON.stringify(bans.rows ?? bans));
const kicks = await db.execute(sql`select room_id, user_id, expires_at from room_kick_cooldowns limit 20`);
console.log("kicks:", JSON.stringify(kicks.rows ?? kicks));
const rooms = await db.execute(sql`select id, name, is_active from rooms order by created_at desc limit 10`);
console.log("rooms:", JSON.stringify(rooms.rows ?? rooms));
process.exit(0);
