"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { resolveEscalationAction, type EscalationResult } from "@/app/ops/dispute-actions";

/**
 * THE ONE DECISION THE MACHINE IS NOT ALLOWED TO MAKE.
 *
 * An escalated dispute is where the autonomy ladder stops: refunding a
 * customer and releasing a crew's frozen pay is a person's call. These two
 * buttons were a bare `<form action={serverAction}>` with no pending state and
 * no result, and the action returned `Promise<void>`.
 *
 * SO BOTH FAILURE MODES WERE INVISIBLE, on a phone, on the money.
 *
 *   Nothing happened on tap — no spinner, no disable — so on LTE the honest
 *   response is to tap again, and the second submit posts the same decision a
 *   second time.
 *
 *   A failure logged to a server console and returned. The page revalidated,
 *   the same card came back, and ops had no way to tell "done" from "didn't".
 *   Meanwhile the crew's pay stays frozen and the customer has no refund.
 *
 * useFormStatus is read from a CHILD of the form on purpose — that is the only
 * place it reports the enclosing form's state.
 */
function Decide({ outcome, label, ghost }: { outcome: "refund" | "close"; label: string; ghost?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      className={ghost ? "ll-btn ghost" : "ll-btn"}
      type="submit"
      name="outcome"
      value={outcome}
      disabled={pending}
      style={{ fontSize: 13 }}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function EscalationDecision({ disputeId }: { disputeId: string }) {
  const [state, action] = useActionState<EscalationResult | null, FormData>(
    resolveEscalationAction,
    null,
  );

  return (
    <div>
      <form action={action} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input type="hidden" name="disputeId" value={disputeId} />
        <Decide outcome="refund" label="Refund the customer" />
        <Decide outcome="close" label="Close in crew's favor" ghost />
      </form>
      {state && (
        <p
          style={{
            fontSize: 12.5,
            margin: "6px 0 0",
            lineHeight: 1.5,
            color: state.ok ? "var(--ink-good)" : "var(--ink-warn)",
          }}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
