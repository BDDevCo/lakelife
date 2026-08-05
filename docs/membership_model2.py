rows = [
 ("Just the lawn, 2x/month",     260,   650),
 ("Lawn weekly, small lot",      140,  1300),
 ("Lawn + clean before visits",  120,  2460),
 ("Open/close + lawn",           160,  2615),
 ("Pier family",                 160,  4621),
 ("Whole house + boat storage",  110, 10413),
 ("Estate, everything",           50, 13307),
]
N=1000
tot_spend=sum(c*s for _,c,s in rows); base=tot_spend*0.30

print("WHERE THE MONEY ACTUALLY IS")
print("-"*66)
cum_c=cum_s=0
for n,c,s in rows:
    cum_c+=c; cum_s+=c*s
    print(f"  {n:<30}{c:>5} cust  ${c*s:>10,.0f}  {c*s/tot_spend:>5.1%} of book")
print(f"\n  Top 16% of customers (whole house + estate) = "
      f"${(110*10413+50*13307):,.0f} = {(110*10413+50*13307)/tot_spend:.0%} of the book")
print(f"  'Just the lawn' 26% of customers            = "
      f"${260*650:,.0f} = {260*650/tot_spend:.1%} of the book\n")

print("=== DESIGN A: membership that DISCOUNTS prices (adverse selection) ===")
for fee,disc in ((250,0.08),(400,0.08),(250,0.05)):
    join=[(n,c,s) for n,c,s in rows if s*disc>fee]
    jn=sum(c for _,c,_ in join); ms=sum(c*s for _,c,s in join)
    margin=(tot_spend-ms)*0.30 + ms*(1-disc)*0.30 + jn*fee
    print(f"  ${fee} fee / {disc:.0%} off -> {jn:>4} join, margin ${margin:>10,.0f} "
          f"({margin-base:+,.0f}, {(margin-base)/base:+.1%})")
print("  Only customers who save MORE than the fee ever join, so every joiner")
print("  costs you the discount and the fee just claws part of it back.\n")

print("=== DESIGN B: membership sold on ACCESS, no price discount ===")
print("  (priority dates, guaranteed crew, no rush surcharge, off-season storm checks)")
for fee in (150,250,400):
    for take in (0.20,0.35,0.50):   # share of the top-3 archetypes who join
        pool=sum(c for n,c,s in rows if s>=2460)
        jn=int(pool*take)
        margin=base+jn*fee
        print(f"  ${fee} fee, {take:.0%} of the {pool} higher-spend customers join "
              f"-> {jn:>3} members, margin ${margin:>10,.0f} ({margin-base:+,.0f}, "
              f"{(margin-base)/base:+.1%})")
    print()

print("=== DESIGN C: season-pass bundle (no subscription, reuses package machinery) ===")
print("  'Open + Close + 20 mows, one price, booked once'")
alacarte = 430+485+20*85
for d in (0.05,0.10):
    print(f"    a la carte ${alacarte:,.0f} -> pass at {d:.0%} off = ${alacarte*(1-d):,.0f}"
          f" | LakeLife margin ${alacarte*(1-d)*0.30:,.0f} vs ${alacarte*0.30:,.0f}")
print("  Value is locked-in volume + one decision, not a fee. No auto-renewal law.")
