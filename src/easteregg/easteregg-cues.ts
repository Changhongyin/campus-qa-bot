/**
 * Synchronisation cues for the easter-egg film, in seconds on the video clock
 * (`video.currentTime`, which follows the anthem audio as master clock).
 *
 * Measured in public/media/anthem.mp3 (D = 172.70 s). The anthem's last line is
 * "…我的名字叫计量": 计 is sung from 158.10 s, 量 from 162.05 s, and 量 is held and
 * released by 169.25 s; the file ends with 3.4 s of silence. `D - 4` (168.70 s)
 * would land in the reverb tail, so the reveal window is the measured span
 * instead, as the brief allows. See README "Easter Egg Integration".
 */
export const REVEAL_AT_SECONDS = 158.1; // measured onset of 计 (brief's default: D - 4 = 168.70)

/** Per-character onsets inside the reveal window, for staggering the two spans. */
export const CHARACTER_CUES_SECONDS = { ji: 158.1, liang: 162.05 } as const;

/** End of the sung 量 (release finished); silence follows until D. */
export const SUNG_END_SECONDS = 169.25;

/** Shared duration of easteregg.webm/.mp4 and anthem.mp3. Read the live value from the clock. */
export const FILM_DURATION_SECONDS = 172.7;
