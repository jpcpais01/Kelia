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
// Gliding: the glider opens by itself once a fall would be longer than
// GLIDE_FALL_HEIGHT, or by hand (Space) anywhere at least GLIDE_MIN_CLEARANCE up.
export const GLIDE_FALL_HEIGHT = 5;
export const GLIDE_MIN_CLEARANCE = 1.6;
/** Forward speed with no input, holding W, holding S (air brake) and diving (Shift). */
export const GLIDE_SPEED = 6.2;
export const GLIDE_FAST_SPEED = 7.8;
export const GLIDE_SLOW_SPEED = 3.6;
export const GLIDE_DIVE_SPEED = 10.2;
/** Sideways slip from A/D while gliding. */
export const GLIDE_STRAFE_SPEED = 3.2;
/** Sink rates (m/s) for the same four cases. */
export const GLIDE_SINK = 2.0;
export const GLIDE_FAST_SINK = 2.4;
export const GLIDE_SLOW_SINK = 1.5;
export const GLIDE_DIVE_SINK = 7.5;
/** Updrafts lift a glider this fast (m/s), easing off near the top of the column. */
export const UPDRAFT_LIFT = 8;
/** Over deep water the glider skims this high above the surface instead of landing in it. */
export const GLIDE_SKIM_HEIGHT = 0.9;
/** Generous upper bound the server accepts, including dodges and lag spikes. */
export const MAX_ACCEPTED_SPEED = SPRINT_SPEED * 1.35;

export const DAY_LENGTH_SECONDS = 40 * 60; // one full day/night cycle
export const SAVE_INTERVAL_MS = 30_000;
export const CHAT_MAX_LENGTH = 160;
export const CHAT_RATE_PER_10S = 6;
/** Teleporting to a place from the world map: a short channel, then a cooldown. */
export const TRAVEL_CHANNEL_MS = 3000;
export const TRAVEL_COOLDOWN_MS = 20_000;
