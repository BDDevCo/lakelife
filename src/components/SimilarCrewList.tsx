"use client";

/**
 * "WE NEED A CROSS REFRENCE IF A HOME OWNER SEND OUT AND INVITE AND WE FLAG
 *  THAT IT COULD POSSIBLY BE A DUPLICATE, SEND A RESPONSE BACK THAT YOUR VEDOR
 *  MIGHT BE ALREADY ON OUR PLATFORM..... DO YOU SEE THEM (SHOW A LIST) OR
 *  SOMTHING LIKE THIS." (23 September 2026)
 *
 * IT ASKS. IT DOES NOT REFUSE. A name match is a guess — `josh@joshsdocks.com`
 * and `jdocks@gmail.com` are the same man and nothing in the database will ever
 * know it — so both answers have to work. "That's them" stops the duplicate;
 * "no, different business" sends the invitation exactly as it would have gone.
 * A guess must never block a real invitation.
 *
 * WHAT IS ON THIS LIST AND WHAT IS DELIBERATELY NOT. The company name, the
 * lakes they work, and whether they are taking work — enough for a person to
 * recognise their own contractor. NOT the email address, and that is the one
 * that matters: an address is how somebody would go after an invitation that is
 * not theirs. Not their phone, their owner's name, their rates, or anything
 * about their other customers. Under crew pricing a buyer sees these crews on
 * the offers screen anyway, so the roster is not a secret from them; the
 * address is.
 *
 * Shared by the homeowner door and the park door because there is one question
 * here, not two, and two copies of it would answer differently by spring.
 */

import type { SimilarCrew } from "@/lib/invite-guard";

const AVAILABILITY: Record<SimilarCrew["availability"], string> = {
  taking_work: "taking work",
  setting_up: "still setting up",
  not_taking_work: "not taking work right now",
};

export function SimilarCrewList({
  typed,
  crews,
  busy,
  onMine,
  onNotMine,
}: {
  /** What they typed, so the question names it rather than gesturing at it. */
  typed: string;
  crews: SimilarCrew[];
  busy: boolean;
  /** "That's them" — no invitation is sent. */
  onMine: (crew: SimilarCrew) => void;
  /** "None of these" — the invitation goes, unchanged. */
  onNotMine: () => void;
}) {
  return (
    <div>
      <p style={{ fontSize: 14, margin: "0 0 4px", fontWeight: 700 }}>
        They might already be here
      </p>
      <p className="mut" style={{ fontSize: 13, margin: "0 0 12px" }}>
        We already work with {crews.length === 1 ? "a crew" : "crews"} with a
        name like <strong>{typed}</strong>. If one of these is yours there&rsquo;s
        nothing to send — they&rsquo;re already on LakeLife and you can book them.
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: "0 0 12px", display: "grid", gap: 8 }}>
        {crews.map((c) => (
          <li
            key={c.vendorId}
            style={{
              border: "1px solid var(--line)", borderRadius: 8, padding: "10px 12px",
              display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 180px", minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{c.company}</div>
              <div className="mut" style={{ fontSize: 12.5 }}>
                {/* NO LAKES IS A REAL STATE, not a blank. A crew part-way
                    through onboarding has not ticked any yet, and saying so is
                    more use than an empty line. */}
                {c.lakes.length ? c.lakes.join(" · ") : "no lakes set yet"}
                {" — "}
                {AVAILABILITY[c.availability]}
              </div>
            </div>
            <button className="ll-btn ghost" disabled={busy} onClick={() => onMine(c)}>
              That&rsquo;s them
            </button>
          </li>
        ))}
      </ul>

      <button className="ll-btn" disabled={busy} onClick={onNotMine}>
        {busy ? "Sending…" : "None of these — send the invite"}
      </button>
    </div>
  );
}
