import Link from "next/link";
import { TopBar } from "@/components/Brand";

/**
 * A LAKE WE DO NOT ADVERTISE, ANSWERED HONESTLY.
 *
 * These are the words /lakes/[slug] already rendered for a slug it could not
 * find. What they lacked was a status code: the page returned 200, so a
 * crawler kept the URL, ranked it against the lake's name and went on serving
 * it. This route is cached for an hour and declared in the sitemap, which
 * makes a soft 404 the most durable kind.
 *
 * The page now calls `notFound()` for both cases it cannot honestly render —
 * a slug no lake holds, and a real lake nobody at LakeLife has agreed to work
 * on yet (lib/lake-visibility.ts) — so the same sentence now arrives with the
 * code that matches it.
 *
 * THE WORD CHANGED FROM "know" TO "serve", AND IT HAD TO. "We don't know that
 * lake yet" was true of a slug no row holds and a plain lie about the other
 * case this page now answers: a lake a customer named last night is one we
 * know perfectly well — we hold their property on it. What is true of both is
 * that we do not work there.
 *
 * IT SAYS NOTHING ABOUT WHY, deliberately. A person who named their lake in
 * the set-up wizard last night would otherwise read a refusal aimed at them,
 * on a public URL, about water they live on — while their property, their
 * season dates and their booking all work perfectly well behind the sign-in.
 * "We're always adding water" is true of both cases and promises neither a
 * date nor a decision.
 */
export default function LakeNotFound() {
  return (
    <>
      <TopBar />
      <div className="wrap" style={{ paddingTop: 48, maxWidth: 520 }}>
        <div className="ll-card ll-card-pad" style={{ textAlign: "center" }}>
          <h2 style={{ fontSize: 22, margin: "0 0 6px" }}>We don&apos;t serve that lake yet 🌊</h2>
          <p className="mut" style={{ fontSize: 14, marginBottom: 14 }}>But we&apos;re always adding water.</p>
          <Link className="ll-btn" href="/lakes">See our lakes</Link>
        </div>
      </div>
    </>
  );
}
