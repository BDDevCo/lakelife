"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { usePathname } from "next/navigation";
import {
  leaveWarning, leavingLosesWork, unsavedButtonLabel, unsavedSentence,
} from "@/components/unsaved-helpers";

/**
 * ONE PLACE THAT SAVES, ON A PAGE WITH FOUR SAVE BUTTONS.
 *
 * /park/setup is four cards deep and each one saves itself through its own
 * server action — on purpose: they validate different things, one of them is
 * the only switch in the module that can charge somebody's card, and merging
 * them into a single write would put four unrelated permission checks behind
 * one button. The cards stay as they are.
 *
 * What was missing is the thing that makes four buttons survivable: a card
 * that knows whether it has anything to save, and ONE place — always in the
 * same spot, whatever he has scrolled to — that names what is unsaved and
 * saves it in a tap. A card with no edits now has no live Save at all, so the
 * button he can see is never a button that lies about his work.
 *
 * And leaving with an edit still in the box asks first. ParkNav's tabs are
 * client-side navigations, which the browser's own unload prompt does not see;
 * that is exactly the tap that used to drop the edit without a word.
 *
 * The decisions live in unsaved-helpers.ts, which has no DOM in it.
 */

interface Registered {
  key: string;
  label: string;
  save: () => void;
}

interface Ctx {
  register: (card: Registered) => void;
  forget: (key: string) => void;
}

const UnsavedCtx = createContext<Ctx | null>(null);

/**
 * Wraps the screen. Renders the bar itself, so a page cannot opt into the
 * tracking and forget the thing that shows it.
 */
export function UnsavedWatch({ children }: { children: React.ReactNode }) {
  const [cards, setCards] = useState<Registered[]>([]);
  const pathname = usePathname();

  const register = useCallback((card: Registered) => {
    setCards((prev) => {
      const without = prev.filter((c) => c.key !== card.key);
      return [...without, card];
    });
  }, []);

  const forget = useCallback((key: string) => {
    setCards((prev) => prev.filter((c) => c.key !== key));
  }, []);

  const ctx = useMemo(() => ({ register, forget }), [register, forget]);

  // The live list in a ref as well, because both listeners below are attached
  // once and must not be torn down and rebuilt on every keystroke. Synced in
  // an effect rather than during render: a ref written while rendering is a
  // value React is free to throw away, and these two are read by listeners
  // that only ever fire after a commit.
  const live = useRef<Registered[]>([]);
  const path = useRef(pathname);
  useEffect(() => { live.current = cards; }, [cards]);
  useEffect(() => { path.current = pathname; }, [pathname]);

  // CLOSING THE TAB, RELOADING, OR LEAVING THE SITE. The browser's own
  // prompt — we cannot word it, only ask for it.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (live.current.length === 0) return;
      e.preventDefault();
      // Set for the handful of browsers that still want it; the wording is
      // the browser's regardless.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  // A TAB IN THE PARK NAV. Captured before the router sees it, because once
  // the route changes the component is gone and so is the edit. This is the
  // one the browser never asked about.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (live.current.length === 0) return;
      if (e.defaultPrevented) return;
      const anchor = (e.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const lose = leavingLosesWork({
        dirty: true,
        href: anchor.getAttribute("href"),
        currentPath: path.current ?? "",
        target: anchor.getAttribute("target"),
        modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0,
        download: anchor.hasAttribute("download"),
      });
      if (!lose) return;
      const ok = window.confirm(leaveWarning(live.current.map((c) => c.label)));
      if (!ok) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  return (
    <UnsavedCtx.Provider value={ctx}>
      {children}
      <UnsavedBar cards={cards} />
    </UnsavedCtx.Provider>
  );
}

/**
 * A card says what it is called, whether it has anything to save, and how to
 * save it. Registration is by key, so a card that goes clean disappears from
 * the bar without the bar knowing anything about that card's fields.
 *
 * Safe outside an UnsavedWatch: the hook does nothing, and the card's own
 * button still works. A screen that has not opted in is not a screen with a
 * broken Save.
 */
export function useUnsavedCard(opts: {
  key: string; label: string; dirty: boolean; save: () => void;
}) {
  const ctx = useContext(UnsavedCtx);
  const { key, label, dirty } = opts;

  // The latest save in a ref, so registering does not depend on a function
  // identity that changes every render. Declared BEFORE the registering
  // effect so it is synced first on every commit, and written in an effect
  // for the same reason as the two above.
  const saveRef = useRef(opts.save);
  const latest = opts.save;
  useEffect(() => { saveRef.current = latest; }, [latest]);

  useEffect(() => {
    if (!ctx) return;
    if (!dirty) { ctx.forget(key); return; }
    ctx.register({ key, label, save: () => saveRef.current() });
    return () => ctx.forget(key);
  }, [ctx, key, label, dirty]);
}

/**
 * THE BAR. Sticky at the bottom, because the whole complaint was having to
 * find the right button on a long page: wherever he is, the thing that saves
 * his work is in the same place and says what it is about to save.
 *
 * It renders nothing at all when nothing is unsaved — this screen has enough
 * on it already.
 */
function UnsavedBar({ cards }: { cards: Registered[] }) {
  if (cards.length === 0) return null;
  const sentence = unsavedSentence(cards.map((c) => c.label));

  return (
    <div
      role="status"
      style={{
        position: "sticky", bottom: 0, zIndex: 40,
        borderTop: "1px solid var(--line)",
        background: "var(--card)",
        boxShadow: "0 -6px 18px rgba(16,42,67,.08)",
      }}
    >
      <div
        className="wrap"
        style={{
          display: "flex", flexWrap: "wrap", gap: 12,
          alignItems: "center", justifyContent: "space-between",
          paddingTop: 12, paddingBottom: 12,
        }}
      >
        <div style={{ fontSize: 13, lineHeight: 1.45, flex: "1 1 240px", minWidth: 0 }}>
          {sentence}
        </div>
        <button
          className="ll-btn"
          style={{ flex: "0 0 auto" }}
          onClick={() => { for (const c of cards) c.save(); }}
        >
          {unsavedButtonLabel(cards.length)}
        </button>
      </div>
    </div>
  );
}
