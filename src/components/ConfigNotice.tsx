/**
 * A friendly banner shown when the keys aren't in .env.local yet, so the
 * app never looks "broken" — it tells the product owner exactly what to do.
 */
export function ConfigNotice({
  missing,
}: {
  missing: { supabase: boolean; twilio: boolean };
}) {
  if (!missing.supabase && !missing.twilio) return null;

  return (
    <div
      style={{
        background: "var(--sun-soft)",
        borderBottom: "1px solid #ecd9ad",
        color: "#7a5a1e",
        padding: "10px 24px",
        fontSize: 13.5,
        textAlign: "center",
      }}
    >
      <b>Setup:</b>{" "}
      {missing.supabase && (
        <>Add your Supabase keys to <code>.env.local</code> to turn on sign-up. </>
      )}
      {missing.twilio && (
        <>Add your Twilio keys to enable text verification. </>
      )}
      Then restart with <code>npm run dev</code>.
    </div>
  );
}
