rows = [
 ("Just the lawn",        260,   650),
 ("Lawn weekly",          140,  1300),
 ("Lawn + clean",         120,  2460),
 ("Open/close + lawn",    160,  2615),
 ("Pier family",          160,  4621),
 ("Whole house",          110, 10413),
 ("Estate",                50, 13307),
]
N=1000; MARGIN=0.30
tot=sum(c*s for _,c,s in rows); base=tot*MARGIN
print(f"Today: ${tot:,.0f} spend, ${base:,.0f} margin\n")

print("=== WHAT ONE UPGRADE IS WORTH vs WHAT ONE MEMBERSHIP IS WORTH ===")
for a,b in ((3,4),(4,5),(5,6)):
    lift=(rows[b][2]-rows[a][2])*MARGIN
    print(f"  Move ONE customer {rows[a][0]:<20} -> {rows[b][0]:<14} = ${lift:>7,.0f} of margin")
print(f"  A $250 membership                                     = ${250:>7,.0f}")
print(f"\n  Moving one 'Pier family' up to 'Whole house' is worth "
      f"{(rows[5][2]-rows[4][2])*MARGIN/250:.0f}x a membership.\n")

print("=== A: PAID MEMBERSHIP (access perks, no discount) ===")
pool=sum(c for _,c,s in rows if s>=2460)
for fee in (150,250):
    for take in (0.20,0.35):
        print(f"  ${fee} @ {take:.0%} take-up -> +${int(pool*take)*fee:>8,.0f}  "
              f"({int(pool*take)*fee/base:+.1%})")

print("\n=== B: FREE LOYALTY TIERS that drive upsell (no fee, no law) ===")
print("  Perks unlock on season spend. Costs ~nothing; goal is share of wallet.")
for conv in (0.05,0.10,0.15):
    gain=0
    for i in range(len(rows)-1):
        n,c,s = rows[i]
        moved = c*conv
        gain += moved*(rows[i+1][2]-s)*MARGIN
    print(f"  {conv:.0%} of customers move up ONE archetype -> +${gain:>9,.0f} ({gain/base:+.1%})")

print("\n=== C: SMALL UPFRONT + per-service cut (owner's phrasing) ===")
for up in (25,50,100):
    rev=up*N
    hurt=[n for n,c,s in rows if up/s>0.05]
    print(f"  ${up} upfront from everyone -> +${rev:>8,.0f} ({rev/base:+.1%})"
          f"   friction for: {', '.join(hurt) if hurt else 'nobody'}")
print("\n  But an upfront fee lands at signup — the single highest drop-off moment.")
print("  Losing even 5% of signups costs more than the fee collects:")
for up in (25,50,100):
    print(f"    ${up} upfront collects ${up*N:,.0f}; losing 5% of customers costs "
          f"${base*0.05:,.0f} of margin.")
