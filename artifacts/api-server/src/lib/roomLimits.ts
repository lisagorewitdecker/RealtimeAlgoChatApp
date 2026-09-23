/**
 * Number of messages kept in a resident room for cursor-based reconnects.
 *
 * Keep this in a dependency-light module so server code and live regression
 * tests use the same boundary without importing the full socket server.
 */
export const ROOM_MESSAGE_HISTORY_LIMIT = 200;