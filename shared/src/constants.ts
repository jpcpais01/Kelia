export const PROTOCOL_VERSION = 2;
export const TICK_RATE = 20; // server simulation + snapshot rate (Hz)
export const TICK_MS = 1000 / TICK_RATE;
export const MAX_PLAYERS = 10;
export const INTERP_DELAY_MS = 110; // remote entities are rendered this far in the past

// Movement (metres / second). Shared so the server can validate client motion.
export const WALK_SPEED = 2.1;
export const RUN_SPEED = 5.4;
export const SPRINT_SPEED = 8.0;
export const JUMP_VELOCITY = 6.6;
export const GRAVITY = 20;
export const MAX_WADE_DEPTH = 1.25; // deeper water pushes you back to shore
/** Generous upper bound the server accepts, including dodges and lag spikes. */
export const MAX_ACCEPTED_SPEED = SPRINT_SPEED * 1.35;

export const DAY_LENGTH_SECONDS = 40 * 60; // one full day/night cycle
export const SAVE_INTERVAL_MS = 30_000;
export const CHAT_MAX_LENGTH = 160;
export const CHAT_RATE_PER_10S = 6;
/** Teleporting to a place from the world map: a short channel, then a cooldown. */
export const TRAVEL_CHANNEL_MS = 3000;
export const TRAVEL_COOLDOWN_MS = 20_000;
