"use client";

import { createContext, useCallback, useContext, useState } from "react";
import type { OpsTab } from "@/app/ops/ops-today-helpers";

/**
 * THE TAB STATE, LIFTED OUT OF THE STRIP.
 *
 * "Needs you today" first went in at the top of OpsShell, above the nine tabs
 * — which is where the taps were, and a true place to put it. It was still
 * wrong: OpsShell renders at the BOTTOM of /ops, after four health panels, the
 * claim card, the escalations card and the proposed fees. So the card that
 * answers "what needs me" sat about fifteen hundred pixels down a console
 * whose first screen was still four zeros.
 *
 * The test that was supposed to catch this asserted the card came before
 * `TABS.map`. Both true and useless: it pinned the card's position relative to
 * the strip, when what mattered was its position on the PAGE.
 *
 * So the state lives here instead, and the page puts the card where it belongs
 * — directly under the tiles — while the strip stays where it has always been.
 * The card's buttons set the tab AND scroll the strip into view, because a
 * control labelled "Open dispatch" that silently highlights something a
 * thousand pixels below is the same defect in miniature.
 */

interface Ctx {
  tab: OpsTab;
  setTab: (t: OpsTab) => void;
  /** Set the tab and take him to it. What a button labelled "Open …" means. */
  open: (t: OpsTab) => void;
}

const OpsTabCtx = createContext<Ctx | null>(null);

/** The strip's anchor, so "Open dispatch" can land on what it opened. */
export const OPS_TAB_STRIP_ID = "ops-tabs";

export function OpsTabProvider({
  openingTab, children,
}: {
  openingTab: OpsTab;
  children: React.ReactNode;
}) {
  const [tab, setTab] = useState<OpsTab>(openingTab);

  const open = useCallback((t: OpsTab) => {
    setTab(t);
    // After the commit that renders the tab, so the strip is where it will be
    // once the content under it has changed height.
    requestAnimationFrame(() => {
      document.getElementById(OPS_TAB_STRIP_ID)?.scrollIntoView({
        behavior: "smooth", block: "start",
      });
    });
  }, []);

  return (
    <OpsTabCtx.Provider value={{ tab, setTab, open }}>
      {children}
    </OpsTabCtx.Provider>
  );
}

/**
 * The tab, from the provider when there is one.
 *
 * FALLS BACK TO LOCAL STATE rather than throwing: OpsShell is a 200-line
 * component with twenty props, and a missing provider should cost the page its
 * deep link, not its jobs board. The hooks are called unconditionally either
 * way, which is the only thing React cares about.
 */
export function useOpsTab(fallback: OpsTab): Ctx {
  const ctx = useContext(OpsTabCtx);
  const [tab, setTab] = useState<OpsTab>(fallback);
  const open = useCallback((t: OpsTab) => setTab(t), []);
  return ctx ?? { tab, setTab, open };
}
