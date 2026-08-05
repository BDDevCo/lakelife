# Membership economics against a realistic lake-community customer mix.
# Menu prices are the REAL seeded values from production's services table.
MOW   = {"small":65, "medium":85, "large":110}
CLEAN = {"small":80, "medium":95, "large":120}
OPEN, CLOSE = 430, 485
PIER_BASE, PIER_SECT = 220, 48
BOATLIFT, PWCLIFT = 495, 495
STORAGE = 2550          # full valet package, both legs
TOYS = 120

# Archetypes of a real lake community, with rough population shares.
# (mows/season assumes a ~5-month season.)
ARCH = [
 # name                         share  build(spend)
 ("Just the lawn, 2x/month",     0.26, lambda: 10*MOW["small"]),
 ("Lawn weekly, small lot",      0.14, lambda: 20*MOW["small"]),
 ("Lawn + clean before visits",  0.12, lambda: 20*MOW["medium"] + 8*CLEAN["medium"]),
 ("Open/close + lawn",           0.16, lambda: OPEN+CLOSE + 20*MOW["medium"]),
 ("Pier family",                 0.16, lambda: OPEN+CLOSE + 20*MOW["medium"]
                                                + 2*(PIER_BASE+6*PIER_SECT) + 2*BOATLIFT),
 ("Whole house + boat storage",  0.11, lambda: OPEN+CLOSE + 20*MOW["large"] + 12*CLEAN["large"]
                                                + 2*(PIER_BASE+8*PIER_SECT) + 2*BOATLIFT
                                                + 2*PWCLIFT + STORAGE + TOYS),
 ("Estate, everything",          0.05, lambda: OPEN+CLOSE + 24*MOW["large"] + 20*CLEAN["large"]
                                                + 2*(PIER_BASE+12*PIER_SECT) + 4*BOATLIFT
                                                + 2*PWCLIFT + STORAGE + 2*TOYS),
]
N = 1000
rows = [(n, round(sh*N), b()) for n, sh, b in ARCH]

print(f"{'Archetype':<30}{'#':>6}{'Season spend':>14}{'Margin @30%':>13}")
print("-"*63)
tot_spend = tot_margin = 0
for n, cnt, sp in rows:
    m = sp*0.30
    tot_spend += cnt*sp; tot_margin += cnt*m
    print(f"{n:<30}{cnt:>6}{sp:>14,.0f}{m:>13,.0f}")
print("-"*63)
print(f"{'TOTAL / per customer':<30}{N:>6}{tot_spend/N:>14,.0f}{tot_margin/N:>13,.0f}")
print(f"\nBook: ${tot_spend:,.0f} spend, ${tot_margin:,.0f} margin at a flat 30%\n")

def flat_fee(fee):
    """Everyone pays. Who does it price out? (fee as % of their spend)"""
    hurt = [(n,cnt,sp) for n,cnt,sp in rows if fee/sp > 0.15]
    return sum(c for _,c,_ in hurt), hurt

print("=== A flat membership everyone pays ===")
for fee in (150, 250, 400):
    n_hurt, hurt = flat_fee(fee)
    print(f"  ${fee}/season: {n_hurt:>4} of {N} customers ({n_hurt/N:.0%}) would be paying "
          f">15% of their total spend just to be a member")
    for nm,c,sp in hurt:
        print(f"        {nm:<30} fee = {fee/sp:.0%} of their ${sp:,.0f}")
print()

print("=== An OPTIONAL membership: who would actually buy it? ===")
print("   (member perk modelled as 8% off menu prices + jobs actually getting filled)")
for fee in (150, 250, 400):
    joiners = [(n,c,sp) for n,c,sp in rows if sp*0.08 > fee]
    jn = sum(c for _,c,_ in joiners)
    fee_rev = jn*fee
    # LakeLife: members pay 8% less, so margin per member job drops by that discount
    mem_spend = sum(c*sp for _,c,sp in joiners)
    non_spend = tot_spend - mem_spend
    margin = non_spend*0.30 + mem_spend*0.92*0.30 + fee_rev
    print(f"  ${fee}/season -> {jn:>4} join ({jn/N:>4.0%}). "
          f"Fee revenue ${fee_rev:>9,.0f} | total margin ${margin:>10,.0f} "
          f"({'+' if margin>tot_margin else ''}{margin-tot_margin:,.0f} vs today)")
    for nm,c,sp in joiners:
        print(f"        joins: {nm:<28} saves ${sp*0.08:,.0f}, pays ${fee}")
print()

print("=== The break-even rule the owner needs ===")
print("  A membership that DISCOUNTS prices only adds margin when:")
print("      fee  >  (discount %) x (that customer's season spend)")
for d in (0.05, 0.08, 0.10):
    print(f"    at a {d:.0%} member discount, a $250 fee stops paying for itself "
          f"above ${250/d:,.0f} of season spend")
