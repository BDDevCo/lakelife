"use client";

/**
 * THE STANDING SWITCH, and the look before the flip.
 *
 * Brendon, 23 September 2026: "then all crews should start out somewhere
 * nuetral because we wont have data in to rate them" and "we also dont want to
 * hinder any crews from onboarding and staying on the platform right away, so
 * maybe its a feature we toggle on at a later saturation date."
 *
 * It ships OFF. Until it is on, the Choose-your-crew screen shows price and
 * days and nothing else.
 *
 * THE FLIP IS NOT BLIND: this card prints what turning it on WOULD say about
 * every active crew, before the switch is touched, so he can see whether it
 * would punish anyone rather than finding out afterwards. And the trigger it
 * argues for is DATA, not a date — said on screen, because a date can arrive
 * with the bench still thin.
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "@/components/Toast";
import { getCrewStandingDial, setCrewStandingPublic, type StandingDialState } from "@/app/ops/standing-actions";

export function CrewStandingDial() {
  const [state, setState] = useState<StandingDialState | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    void (async () => setState(await getCrewStandingDial()))();
  }, []);

  function flip(on: boolean) {
    startTransition(async () => {
      const res = await setCrewStandingPublic(on);
      if (!res.ok) {
        toast.err(res.error ?? "Couldn't change that.");
        return;
      }
      toast(on ? "Crew standing is now shown to buyers." : "Crew standing is hidden again.");
      setState(await getCrewStandingDial());
    });
  }

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
      <h4 style={{ fontSize: 15, margin: "0 0 4px" }}>Show crew standing to buyers</h4>
      <p className="mut" style={{ fontSize: 12.5, margin: "0 0 10px", lineHeight: 1.55 }}>
        Off today. When a customer chooses a crew they see the price and the days each crew
        works. Turn this on and each crew also shows either how many jobs they&rsquo;ve completed
        and on which lakes, or &ldquo;New to LakeLife&rdquo;. It is never a star rating and never a
        score — a neutral number stops being neutral the day somebody earns a real one.
      </p>

      {/* A FAILED READ IS NOT AN EMPTY BENCH. It must not render as a green
          light to flip. */}
      {state && !state.ok && (
        <p className="mut" style={{ fontSize: 12.5, margin: "0 0 10px", color: "var(--ink-warn)" }}>
          {state.error} Until that reads, there&rsquo;s no way to tell what turning this on would
          print, so leave it where it is.
        </p>
      )}

      {state?.ok && (
        <>
          <p style={{ fontSize: 13, margin: "0 0 10px", lineHeight: 1.6 }}>
            <b>If you turned it on right now:</b> {state.sentence}
          </p>
          <p className="mut" style={{ fontSize: 12.5, margin: "0 0 12px", lineHeight: 1.55 }}>
            Switch on when the bench has enough finished work that the label stops being a
            penalty — not on a date. A date can arrive with the bench still thin, and flipping
            it then does exactly what you said you didn&rsquo;t want: put off the crews who are
            still settling in.
          </p>
          <button
            className="ll-btn"
            disabled={pending}
            onClick={() => flip(!state.enabled)}
            style={{ minHeight: 44 }}
          >
            {pending
              ? "Saving…"
              : state.enabled
                ? "Hide crew standing again"
                : "Show crew standing to buyers"}
          </button>
          <span className="mut" style={{ fontSize: 12.5, marginLeft: 10 }}>
            Currently {state.enabled ? "shown" : "hidden"}.
          </span>
        </>
      )}

      {!state && <p className="mut" style={{ fontSize: 12.5, margin: 0 }}>Checking the crew bench…</p>}
    </div>
  );
}
