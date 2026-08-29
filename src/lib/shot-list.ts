/**
 * WHAT A CREW IS ACTUALLY BEING ASKED TO PHOTOGRAPH.
 *
 * 0146 put a named shot list on `services.required_photo_slots` and raised
 * `min_photos` to match it. That made the gate honest and, on its own, made
 * the SCREEN worse: a crew opening a boat storage job now reads "0 / 7 photos
 * required" with not one word about which seven. Seven is not an instruction.
 * Before 0146 the same screen asked for three, and three of the same fender
 * satisfied it — which is the whole reason the named list exists.
 *
 * So the list has to reach the thumb that takes the picture, or the migration
 * only made the number bigger.
 *
 * THE LIST IS DATA (CLAUDE.md rule 8). Nothing here may assume the five lists
 * that exist today. `slotLabel` falls back to de-slugging, so a slot added to
 * a service in the database shows up on the crew screen reading as English,
 * with no deploy and no edit to this file.
 *
 * AND THE GATE IS STILL A COUNT. 0146 deliberately did not enforce slots —
 * there is no offline support in the vendor app, so a device that must know
 * which named slots are still empty while it has no signal cannot answer.
 * `canComplete` therefore reports what the DATABASE will actually do, never
 * what this list wishes it would. When the two disagree — enough photos, but
 * a named shot still missing — the crew is told both, and allowed to finish.
 * Copy that claims a rule the server does not enforce is the bug class this
 * codebase keeps paying for.
 */

/**
 * Labels for the slots seeded by 0146. NOT a whitelist: an unknown slot is
 * de-slugged rather than dropped, because dropping it would show a crew a
 * shorter walk-around than the service asks for.
 */
const KNOWN: Record<string, string> = {
  port_side: "Port side",
  starboard_side: "Starboard side",
  bow: "Bow",
  stern: "Stern",
  hull: "Hull",
  engine: "Engine",
  interior: "Interior",
  deck: "Deck",
  overall: "Overall",
  tag: "Registration tag",
  racked_position: "In the rack",
  cover_or_wrap: "Cover / wrap",
};

/** "cover_or_wrap" → "Cover / wrap"; "fuel_line" → "Fuel line". */
export function slotLabel(slot: string): string {
  const key = slot.trim().toLowerCase();
  if (KNOWN[key]) return KNOWN[key];
  const words = key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slot;
}

export type ShotProgress = {
  /** The walk-around, in the order the service lists it. */
  required: string[];
  /** Slots that already have at least one photo. */
  done: string[];
  /** Named shots still with nothing against them, in list order. */
  missing: string[];
  /** What the crew reads. Never a bare number when a list exists. */
  message: string;
  /** What the DATABASE will accept — a count, not the list. See the header. */
  canComplete: boolean;
};

const list = (slots: string[]) => slots.map(slotLabel).join(", ");

/**
 * @param required the service's `required_photo_slots`
 * @param shot     the `slot` values already on this job's photos (nulls out)
 * @param count    how many photos the job has, labelled or not
 * @param min      the service's `min_photos` — the gate 0050 enforces
 */
export function shotProgress(
  required: string[] | null | undefined,
  shot: Array<string | null | undefined> | null | undefined,
  count: number,
  min: number,
): ShotProgress {
  // Duplicates in either list would double-count a slot; a blank slug in
  // `required` would render an empty chip nobody can tap.
  const req = [...new Set((required ?? []).map((s) => (s ?? "").trim()).filter(Boolean))];
  const taken = new Set((shot ?? []).map((s) => (s ?? "").trim()).filter(Boolean));
  const done = req.filter((s) => taken.has(s));
  const missing = req.filter((s) => !taken.has(s));
  const canComplete = min <= 0 || count >= min;

  let message: string;
  if (req.length === 0) {
    // No list on this service — the old sentence, which is all there is to say.
    const need = Math.max(0, min - count);
    message = canComplete
      ? `${count} of ${min} photos — ready to complete.`
      : `${need} more photo${need === 1 ? "" : "s"} needed to close this job.`;
  } else if (missing.length === 0) {
    message = canComplete
      ? `Walk-around complete — all ${req.length} shots.`
      // Every named shot is in and the count still is not met: the gate is a
      // sum of legs on a package visit, so another leg is owed photos too.
      : `All ${req.length} shots done — this visit needs ${min} photos in total.`;
  } else if (!canComplete) {
    message = `Still to shoot: ${list(missing)}.`;
  } else {
    // THE HONEST DISAGREEMENT. Enough photos to satisfy the server, but the
    // report has a hole in it. Say both; do not invent a block.
    message = `Enough photos to complete — but no shot yet of ${list(missing)}.`;
  }

  return { required: req, done, missing, message, canComplete };
}
