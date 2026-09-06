"use server";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sealSecret } from "@/lib/gate";
import { abaValid, accountPlausible, earlyFee } from "@/lib/payouts";
import { getPlatformSettings } from "@/lib/settings";
import { notify } from "@/lib/notify";
import { readFailedMessage } from "@/lib/must-read";

export interface BankResult {
  ok: boolean;
  error?: string;
  last4?: string;
}

/**
 * Save where the money goes. Routing/account are validated (real ABA
 * checksum — a typo never reaches the vault), encrypted at rest with the
 * gate-code AES envelope, and NEVER echoed back — the caller gets last4
 * and nothing else. Works for crew users and HOA users alike.
 */
export async function setPayoutAccount(input: {
  bankName: string;
  routing: string;
  account: string;
}): Promise<BankResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const routing = (input.routing ?? "").replace(/\D/g, "");
  const account = (input.account ?? "").replace(/\D/g, "");
  if (!abaValid(routing)) return { ok: false, error: "That routing number doesn't check out — double-check the 9 digits on your checks." };
  if (!accountPlausible(account)) return { ok: false, error: "Account numbers are 4–17 digits." };

  const admin = createServiceClient();
  const last4 = account.slice(-4);
  // THIS READ IS THE ALARM, NOT A DETAIL. It is the only thing that knows the
  // destination changed, and the warning text below is conditioned on it — so a
  // failed read is a SILENT reroute, which is precisely the attack the text
  // exists to catch. Nothing is written yet, so refusing here costs the crew a
  // retry and costs a hijacked session everything.
  const prevRes = await admin
    .from("payout_accounts").select("account_last4").eq("user_id", user.id).maybeSingle();
  if (prevRes.error) {
    return { ok: false, error: readFailedMessage("your current bank details", prevRes.error) };
  }
  const prev = prevRes.data;
  const { error } = await admin.from("payout_accounts").upsert({
    user_id: user.id,
    bank_name: (input.bankName ?? "").slice(0, 80) || null,
    routing_encrypted: sealSecret(routing),
    account_encrypted: sealSecret(account),
    account_last4: last4,
    updated_at: new Date().toISOString(),
  });
  if (error) return { ok: false, error: error.message };
  // A changed payout destination is never silent — a hijacked session must
  // not be able to reroute money without the owner hearing about it.
  if (prev && prev.account_last4 !== last4) {
    try {
      const uRes = await admin.from("users").select("phone, email").eq("id", user.id).maybeSingle();
      // The account is already changed, so this can't refuse any more — but an
      // unsent security warning must never be silent in the log as well as on
      // the phone. "No phone on file" and "couldn't look" are not the same.
      if (uRes.error) console.error("[read failed] the number to warn about a payout change:", uRes.error);
      const u = uRes.data;
      // EVERY DOOR. This is the only thing standing between a hijacked session
      // and a silent reroute of somebody's money, and it went by text alone on
      // a channel that has delivered nothing since July.
      await notify(
        "the account owner that their payout destination was changed",
        { phone: u?.phone as string | null, email: u?.email as string | null },
        {
          // "CALL US IMMEDIATELY" NAMED NO NUMBER. LakeLife publishes none —
          // not in the top bar, not in a footer, not in this message — so the
          // one instruction on the one alert standing between a hijacked
          // session and a silent reroute of somebody's money was an action the
          // reader could not take. This is the pattern the codebase already
          // has a name for: copy that instructs an action the screen lacks.
          //
          // So it says what they CAN do, and each half is true of the channel
          // it arrives on. The email is a reply away from a person; both can
          // change a password; and the account itself is one screen away.
          sms: `LakeLife security: your payout account was just changed to ····${last4}. If this wasn't you, change your password now and reply to the email we've just sent.`,
          subject: `Your payout account was changed to ····${last4}`,
          body:
            `Your LakeLife payout account was just changed to ····${last4}.\n\n` +
            `If that was you, nothing to do.\n\n` +
            `IF IT WASN'T:\n` +
            `  1. Change your password now — ${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/reset-password\n` +
            `  2. Reply to this email and we'll freeze the account.\n\n` +
            // A first draft ended "Nothing has been paid out to the new account
            // yet." True at the instant of sending, and not something this code
            // checked — and it could stop being true before the email is read,
            // because an early payout or a month-end batch would both go to the
            // new destination. A reassurance with a shelf life is worse than
            // none on a security alert. Sooner is what is actually true.
            `The sooner you tell us, the more we can stop.`,
        },
      );
    } catch { /* best effort */ }
  }
  return { ok: true, last4 };
}

export interface EarlyPayoutResult {
  ok: boolean;
  error?: string;
  gross?: number;
  fee?: number;
  net?: number;
}

/**
 * "Get it now": batch every released, un-batched payout for THIS crew at
 * the early_payout_fee_pct dial. Race-safe: the batch row is created
 * first, then payout rows are CLAIMED by a guarded update (batch_id null
 * → this batch) — a double-tap's second claim gets zero rows and the
 * empty batch is deleted.
 *
 * ============ WHAT THE 2% ACTUALLY BUYS ============
 *
 * The line above used to end "nothing here waits on a human". It does. There
 * is no automated banking layer: an 'early' batch queues and then waits for
 * exactly the same thing a free month-end batch waits for — somebody opening
 * /ops and clicking Download ACH batch — and nobody was ever told one was
 * there. A crew paid 2% for speed that depended on somebody happening to look
 * at a screen.
 *
 * That is this repo's own "a switch is a wish, a processor is a rail". The
 * capability being sold here is a PERSON, so the honest version is: check the
 * person exists BEFORE taking the fee, and tell them the moment it queues.
 *
 * If there is nobody to tell, this refuses and takes nothing. Nothing is lost
 * — the payouts stay released and un-batched and go out free at month-end,
 * which is what the refusal says.
 *
 * WHAT THIS DOES NOT DECIDE: the fee itself. Whether an early pull should cost
 * 2%, or anything, is the owner's dial (`early_payout_fee_pct`) and is not
 * touched here.
 */
export async function requestEarlyPayout(): Promise<EarlyPayoutResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Please sign in first." };

  const admin = createServiceClient();
  // Both refusals below assert a fact about the crew's account — "you're not
  // set up", "you have no bank details" — and a failed read had no fact to
  // assert. Told to somebody who banked with us last week, either one reads as
  // their account having been wiped.
  const vendorRes = await admin
    .from("vendors").select("id, company").eq("user_id", user.id).maybeSingle();
  if (vendorRes.error) {
    return { ok: false, error: readFailedMessage("your crew account", vendorRes.error, { money: true }) };
  }
  const vendor = vendorRes.data;
  if (!vendor) return { ok: false, error: "Your crew account isn't set up yet." };

  const acctRes = await admin
    .from("payout_accounts").select("account_last4").eq("user_id", user.id).maybeSingle();
  if (acctRes.error) {
    return { ok: false, error: readFailedMessage("your bank details", acctRes.error, { money: true }) };
  }
  const acct = acctRes.data;
  if (!acct) return { ok: false, error: "Add your bank details first — that's where the money lands." };

  // THE CAPABILITY CHECK, BEFORE A SINGLE CENT OF FEE IS COMMITTED.
  //
  // An early batch is only faster than month-end if a human pulls the bank
  // file today. Read who that could be first: a failed read is not "there is
  // no ops team", and refusing on either is the direction that never charges
  // for something we cannot deliver.
  const opsRes = await admin.from("users").select("id, phone, email").eq("role", "ops");
  if (opsRes.error) {
    return { ok: false, error: readFailedMessage("who could send your payout today", opsRes.error, { money: true }) };
  }
  const opsContacts = (opsRes.data ?? []).filter((o) => o.phone || o.email);
  if (opsContacts.length === 0) {
    return {
      ok: false,
      error:
        "We can't get money out any faster than usual right now, so we're not going to charge you for it. " +
        "Your pay goes out with the month-end batch, free, and nothing has been taken.",
    };
  }

  // Create the envelope INVISIBLE to the exporter ('building'), claim rows
  // into it, then write totals + flip to 'queued' in ONE checked update —
  // the export can never see a batch whose numbers aren't final (review:
  // the $0-export window is how a crew gets paid nothing for real money).
  const { data: batch, error: bErr } = await admin
    .from("payout_batches")
    .insert({ user_id: user.id, vendor_id: vendor.id, kind: "early", status: "building" })
    .select("id")
    .single();
  if (bErr || !batch) return { ok: false, error: bErr?.message ?? "Couldn't start the payout." };

  const unclaimAndDrop = async () => {
    await admin.from("payouts").update({ batch_id: null }).eq("batch_id", batch.id);
    await admin.from("payout_batches").delete().eq("id", batch.id);
  };

  const claimRes = await admin
    .from("payouts")
    .update({ batch_id: batch.id })
    .eq("vendor_id", vendor.id)
    .eq("status", "released")
    .is("batch_id", null)
    .select("amount, kind");
  // A FAILED CLAIM IS NOT AN EMPTY ONE. Falling through told a crew with money
  // waiting "nothing released to pull right now" — and if the update landed but
  // the response didn't, those rows are sitting in a batch we just said was
  // empty. Unclaim first (nothing stranded), then say what actually happened.
  if (claimRes.error) {
    await unclaimAndDrop();
    return { ok: false, error: readFailedMessage("what's ready to pull", claimRes.error, { money: true }) };
  }
  const claimed = claimRes.data;
  const gross = Math.round((claimed ?? []).reduce((s, p) => s + Number(p.amount ?? 0), 0) * 100) / 100;

  // A TIP IS NEVER DISCOUNTED. The homeowner is told in writing "every cent
  // goes to the crew — LakeLife doesn't take a share of a thank-you", and
  // 0091 enforces that at the payout. Pulling it early through a 2% fee would
  // have broken the promise on the way out of the door, quietly, in the one
  // place nobody would look. So the early-pay fee is computed on EARNED money
  // only; tips ride along at full value.
  const tipCents = (claimed ?? [])
    .filter((p) => p.kind === "tip")
    .reduce((s, p) => s + Math.round(Number(p.amount ?? 0) * 100), 0);
  const tipTotal = tipCents / 100;
  const feeBase = Math.round((gross - tipTotal) * 100) / 100;
  if (!claimed || claimed.length === 0 || gross <= 0) {
    await unclaimAndDrop();
    return { ok: false, error: "Nothing released to pull right now — payouts land here the moment a job's photos clear." };
  }

  const settings = await getPlatformSettings();
  // Fee on the earned portion; the tip is added back whole.
  const { fee } = earlyFee(feeBase, settings.earlyPayoutFeePct);
  const net = Math.round((gross - fee) * 100) / 100;
  const { data: finalized, error: finErr } = await admin
    .from("payout_batches")
    .update({ gross, fee, net, status: "queued" })
    .eq("id", batch.id)
    .eq("status", "building")
    .select("id");
  if (finErr || !finalized || finalized.length === 0) {
    await unclaimAndDrop(); // money goes back to the pool, nothing stranded
    return { ok: false, error: "Couldn't queue the payout — nothing was taken, try again." };
  }

  // THE HALF THE FEE IS FOR. Told the moment it queues, to every ops door
  // that is open, and never with a bank number in it — the crew's account is
  // not ops' business and this message travels by email and text.
  try {
    for (const o of opsContacts) {
      const told = await notify(
        "ops that a crew has paid to be paid early and the bank file needs pulling",
        { phone: o.phone as string | null, email: o.email as string | null },
        {
          sms:
            `LakeLife: ${vendor.company ?? "a crew"} pulled an early payout — $${net.toFixed(2)} ` +
            `(they paid a $${fee.toFixed(2)} early fee). Download the ACH batch in /ops today. 🌊`,
          subject: `Early payout queued — $${net.toFixed(2)} needs the ACH file pulled`,
          body:
            `${vendor.company ?? "A crew"} asked for an early payout and paid a $${fee.toFixed(2)} fee for it.\n\n` +
            `  $${net.toFixed(2)} is queued and waiting on the ACH download.\n\n` +
            `That fee only buys them anything if the file goes up today — ` +
            `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}/ops`,
        },
      );
      // The batch IS queued and the crew has been charged, so this cannot
      // refuse anything any more. It must not be silent either.
      if (!told.reached && told.note) console.error(`[early payout] ${told.note}`);
    }
  } catch { /* best effort */ }

  // The receipt text — the number they'll see land.
  try {
    const uRes = await admin.from("users").select("phone, email").eq("id", user.id).maybeSingle();
    // Deliberately swallowed — the payout is queued and a missing receipt text
    // must not un-queue it — but never swallowed silently.
    if (uRes.error) console.error("[read failed] the number to text the payout receipt to:", uRes.error);
    const u = uRes.data;
    // A receipt for money that has left, and a fee they just paid to have it
    // early. Both doors, so it isn't only the bank statement that ever says so.
    await notify(
      "the crew that their early payout is queued and what the fee was",
      { phone: u?.phone as string | null, email: u?.email as string | null },
      {
        sms: `LakeLife: early payout queued — $${net.toFixed(2)} to your account ····${acct.account_last4} ($${gross.toFixed(2)} − $${fee.toFixed(2)} early fee${tipTotal > 0 ? `; $${tipTotal.toFixed(2)} of tips came through in full` : ""}). Month-end payouts are always free. 🌊`,
        subject: `Your early payout of $${net.toFixed(2)} is queued`,
      },
    );
  } catch { /* best effort */ }

  return { ok: true, gross, fee, net };
}
