import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ParkEnquiry } from "@/app/ops/parks-data";

/**
 * A LEAD NOBODY OPENS IS WORSE THAN NO FORM AT ALL.
 *
 * 0164 refused to file park-owner enquiries in `marketing_contacts` for
 * exactly this reason: that table has one writer and NO reader on any ops
 * screen. A form whose answers land somewhere nobody looks still tells the
 * person who filled it in that they have been heard.
 *
 * So the reader ships with the writer, and this pins it.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/Toast", () => ({ toast: () => {} }));
vi.mock("@/app/ops/enquiry-actions", () => ({ markEnquiryHandled: async () => ({ ok: true }) }));

const { ParkEnquiries } = await import("./ParkEnquiries");

const one: ParkEnquiry = {
  id: "e1",
  createdAt: "2026-09-10T16:00:43Z",
  name: "Dale Whitcomb",
  email: "dale@whitcombmhp.com",
  phone: "260-555-0142",
  parkName: "Whitcomb Mobile Home Park",
  town: "Kendallville, IN",
  lots: 42,
  note: "We collect rent by cheque at the office.\nInterested in the shared-cost side.",
};

const draw = (enquiries: ParkEnquiry[]) =>
  renderToStaticMarkup(<ParkEnquiries enquiries={enquiries} />);

describe("an enquiry reaches somebody", () => {
  it("shows every field a decision needs", () => {
    const html = draw([one]);
    expect(html).toContain("Dale Whitcomb");
    expect(html).toContain("dale@whitcombmhp.com");
    expect(html).toContain("260-555-0142");
    expect(html).toContain("Whitcomb Mobile Home Park");
    expect(html).toContain("Kendallville, IN");
    // THE NUMBER WORTH READING FIRST — a 4-lot park and a 400-lot park are
    // different businesses, and it is the optional field most worth having.
    expect(html).toContain("42 lots");
  });

  it("keeps what they actually wrote", () => {
    expect(draw([one])).toContain("We collect rent by cheque at the office.");
  });

  it("counts who is waiting", () => {
    expect(draw([one, { ...one, id: "e2" }])).toContain("2 waiting");
  });

  it("survives an enquiry with only the two required fields", () => {
    // The form asks for two things and makes five optional on purpose. The
    // card must not fall over on the shape it will most often receive.
    const bare: ParkEnquiry = {
      id: "e3", createdAt: "2026-09-10T16:00:43Z",
      name: "A Name", email: "a@example.com",
      phone: null, parkName: null, town: null, lots: null, note: null,
    };
    const html = draw([bare]);
    expect(html).toContain("A Name");
    expect(html).toContain("a@example.com");
    // No stray separators or "null lots" from the optional fields.
    expect(html).not.toContain("null");
    expect(html).not.toMatch(/·\s*·/);
  });

  it("says nobody has asked, without reading as a failure", () => {
    // The loader THROWS on a dropped read rather than returning [], so this
    // sentence is only ever true when it appears.
    const html = draw([]);
    expect(html).toContain("Nobody has asked yet");
    expect(html).not.toContain("waiting");
  });

  it("shows the date on the lakes' clock, not the reader's laptop", () => {
    // 16:00 UTC is still the 10th in Indiana. Pinned so a reader in another
    // timezone sees the day the enquiry actually arrived.
    expect(draw([one])).toContain("Sep 10, 2026");
  });
});
