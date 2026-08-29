import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE COLUMN WITH NO WRITER, AND ITS TWIN.
 *
 * 0146 added `job_photos.slot` and shipped with NOTHING on screen sending
 * one. `uploadJobPhoto` read a `slot` off the FormData that no caller ever
 * appended — so the column was written by nobody, the walk-around existed
 * only in the database, and the migration's one visible effect was raising
 * "3 photos required" to "7 photos required" with no word about which seven.
 *
 * These scans hold the wiring down at both ends: the crew screens must SEND a
 * slot, and every surface that shows a photo must READ one. A column written
 * but never read is the same defect wearing the other hat.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** Both doors a crew can upload a photo through. */
const CREW_SCREENS = ["src/components/VendorStopCard.tsx", "src/components/VendorJobPanel.tsx"];

describe("the crew screens send the slot", () => {
  for (const file of CREW_SCREENS) {
    it(`${file.split("/").pop()} appends a slot to the upload`, () => {
      const src = code(file);
      expect(src, "this screen still uploads unlabelled photos — slot has no writer")
        .toMatch(/fd\.append\("slot", slot\)/);
      expect(src, "the walk-around is what supplies the slot")
        .toContain("<WalkAround");
    });

    it(`${file.split("/").pop()} does not tick a chip on a failed upload`, () => {
      // A ticked chip with nothing behind it is a walk-around that lies: the
      // crew moves on, the shot is never taken, and the gap only surfaces in
      // the argument the photo existed to settle.
      const src = code(file);
      expect(src).toMatch(/if \(slot && landed\) setShot/);
      expect(src, "`landed` must be set from a SUCCESSFUL upload only")
        .toMatch(/landed = true;[\s\S]{0,80}latest = res\.photoCount/);
    });

    it(`${file.split("/").pop()} names what is missing instead of counting it`, () => {
      const src = code(file);
      expect(src, "shotProgress owns the sentence").toContain("shotProgress(");
      expect(src, `a bare "N more photos needed" toast is back`)
        .not.toMatch(/more photo\$\{/);
    });
  }
});

describe("the walk-around prompts but never gates", () => {
  it("the shared component does not disable completion", () => {
    // 0146 left the gate a COUNT on purpose — there is no offline support in
    // the vendor app, so a device with no signal cannot know which named
    // slots are still empty. A chip that blocked completion would enforce a
    // rule no trigger has.
    const src = code("src/components/WalkAround.tsx");
    expect(src).not.toMatch(/completeJob|markComplete|canComplete\s*&&/);
  });

  it("both screens still gate on the count the server actually enforces", () => {
    for (const file of CREW_SCREENS) {
      const src = code(file);
      expect(src, `${file}: the complete button must key off the photo count`)
        .toMatch(/const enough = [^;]*count >= min/);
    }
  });

  it("is ONE component, so the two screens cannot drift", () => {
    for (const file of CREW_SCREENS) {
      expect(code(file)).toContain('from "@/components/WalkAround"');
    }
  });
});

describe("every surface that shows a photo shows its label", () => {
  it("the shared gallery captions the shot", () => {
    const src = code("src/components/JobPhotoGallery.tsx");
    expect(src, "the label is the whole point of a named shot").toContain("slotLabel(");
    expect(src).toMatch(/slot\?: string \| null/);
  });

  it("the gallery no longer claims to know when a photo was taken", () => {
    // `taken_at` is the moment our SERVER wrote the row. The gallery said
    // "Taken 3:42 PM" to all three roles — a claim about the world we cannot
    // support, on the one page that exists to settle "was it like that in
    // October". A crew shoots at the dock and uploads from the truck.
    const src = read("src/components/JobPhotoGallery.tsx");
    expect(src, 'the caption must not say "Taken"').not.toMatch(/`Taken \$\{/);
    expect(src, "it says what it actually knows").toMatch(/Uploaded \$\{/);
  });

  it("carries the device's own file time, so the two can disagree in public", () => {
    const src = code("src/components/JobPhotoGallery.tsx");
    expect(src).toContain("deviceTime");
    expect(src, "never described as capture time").not.toMatch(/[Cc]aptured? (at|on)/);
  });

  it("the reader that feeds all three roles selects every evidence column", () => {
    // One reader serves customer, crew and ops. If it stops selecting these,
    // every gallery quietly loses its labels at once.
    //
    // Membership, not the exact string: pinning the literal would break the
    // day somebody legitimately adds a column, and a test that breaks on
    // correct changes gets deleted rather than fixed. Dropping one still
    // fails, which is the thing worth catching.
    const src = code("src/lib/photos.ts");
    const selects = [...src.matchAll(/\.select\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(selects.length, "no .select() found — this scan is measuring nothing")
      .toBeGreaterThanOrEqual(2);
    for (const sel of selects) {
      for (const col of ["id", "url", "taken_at", "slot", "device_time"]) {
        expect(sel.split(",").map((c) => c.trim()), `${col} dropped from "${sel}"`)
          .toContain(col);
      }
    }
    // AND EACH IS ONE STRING LITERAL. A .select() built by concatenation
    // makes PostgREST return GenericStringError for every column — the
    // failure looks like a type error, not a missing photo.
    expect(src, "a select must never be assembled from pieces")
      .not.toMatch(/\.select\([^)]*(\$\{|\+ )/);
  });
});

describe("the customer sees the report before they approve it", () => {
  const DOORS = ["src/app/c/[token]/good/route.ts", "src/app/c/[token]/issue/route.ts"];

  for (const file of DOORS) {
    it(`${file.includes("good") ? "the 👍" : "the 👎"} door renders the photos`, () => {
      // §E.2 asked for customer e-acknowledgment of a condition report. Before
      // this, 👍 was a tap on a page showing a service name and a button — an
      // acknowledgment of something unseen, which is worth nothing in the
      // argument it exists to settle.
      const src = code(file);
      expect(src).toContain("signedJobPhotosOrNone");
    });
  }

  it("uses the reader that cannot throw, because a route has no error boundary", () => {
    // signedJobPhotos throws ReadFailed by design. On these pages that would
    // be a bare 500 on a phone, and the verdict the customer came to record
    // would be lost with it.
    const src = code("src/lib/photos.ts");
    const fn = src.match(/export async function signedJobPhotosOrNone[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn, "signedJobPhotosOrNone not found").not.toBe("");
    expect(fn, "the throw must be caught here").toMatch(/catch/);
    expect(fn, "and must resolve to no photos, never rethrow").toMatch(/return \[\];[\s\S]*\}/);
    expect(fn).not.toMatch(/throw /);
  });

  it("hands htmlPage values, never markup", () => {
    // The strip is built by photoStripHtml, which escapes. If a caller could
    // pass HTML through, a slot off a database column would be a live XSS on
    // a page with no session and no CSP of its own.
    const src = code("src/app/a/[token]/respond.ts");
    expect(src).toMatch(/photos\?: StripPhoto\[\]/);
    expect(src, "the page must not accept raw html from a caller")
      .not.toMatch(/extraHtml|rawHtml|dangerouslySet/);
  });
});
