import type { CrewScore, CrewTier } from "@/lib/scoring";

/**
 * Crew "My standing" card — private, shown only to the signed-in crew on their
 * Today page. Presentational only: takes the crew's own CrewScore plus the tier
 * label/blurb (computed server-side). Never shows the raw 0–100 score, peers,
 * rank, or prices — tier + friendly hint only.
 */

const PILL_BY_TIER: Record<CrewTier, "gold" | "teal" | "slate"> = {
  priority: "gold",
  building: "teal",
  new: "slate",
};

export function VendorStanding({
  standing,
  label,
  blurb,
}: {
  standing: CrewScore;
  label: string;
  blurb: string;
}) {
  const pill = PILL_BY_TIER[standing.tier];
  // On-time % only earns a mention once there's real history behind it (the
  // scoring layer gives new crews a benefit-of-the-doubt 1.0 with 0 jobs).
  const showOnTime = standing.completedCount >= 3;
  const onTimePct = Math.round(standing.onTimeRate * 100);

  const facts: string[] = [];
  if (showOnTime) facts.push(`On-time ${onTimePct}%`);
  facts.push(
    standing.completedCount === 1 ? "1 job completed" : `${standing.completedCount} jobs completed`
  );

  return (
    <div className="ll-card ll-card-pad" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span className={`ll-pill ${pill}`}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Your standing</span>
      </div>
      <p style={{ fontSize: 14, marginTop: 10 }}>{facts.join(" · ")}</p>
      <p className="mut" style={{ fontSize: 13, marginTop: 6 }}>{blurb}</p>
      <p className="mut" style={{ fontSize: 13, marginTop: 6 }}>{standing.nextTierHint}</p>
    </div>
  );
}
