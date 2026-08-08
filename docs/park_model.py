# A park's value is NOT the rent (pass-through, no margin). It is (a) service
# capture and (b) density — the thing the launch model said the platform lacks.
LOTS = 80
RATE = 0.68          # crew keeps ~68% of menu
FLOOR = 0.20         # new launch floor

# Service attach in a northern lake park. Golf carts and MH winterization are
# near-universal; boats depend on the lake.
SERVICES = [
 # name,                        menu,  attach, on-site min
 ("Golf cart winterize+store",   285,  0.55,  40),
 ("Boat storage & winterize",   2550,  0.15, 120),
 ("Mobile home winterization",   395,  0.70,  75),
 ("Spring de-winterize",         295,  0.65,  60),
 ("Lot mow (biweekly, season)",  480,  0.30,  30),   # 8 visits x $60
]
print(f"SERVICE CAPTURE — {LOTS}-lot park, one season")
print("-"*76)
rev=marg=0
for n,menu,att,_ in SERVICES:
    units=LOTS*att; r=units*menu; m=r*FLOOR
    rev+=r; marg+=m
    print(f"  {n:<30}{units:>5.0f} lots  ${r:>9,.0f}  margin ${m:>8,.0f}")
print("-"*76)
print(f"  {'TOTAL':<30}{'':>5}       ${rev:>9,.0f}  margin ${marg:>8,.0f}")
print(f"  Per lot: ${rev/LOTS:,.0f} of service revenue, ${marg/LOTS:,.0f} of margin\n")

print("DENSITY — why a crew loves a park (drive time is what kills them)")
print("-"*76)
COST_MIN = 0.95
def day(stops, between, to_site, onsite, menu):
    gross = stops*menu*RATE
    drive = 2*to_site + max(0,stops-1)*between
    net = gross - drive*COST_MIN
    hrs = (stops*onsite + drive)/60
    return net, hrs, net/hrs
print(f"{'Scenario':<44}{'Stops':>7}{'Net':>10}{'Net/hr':>9}")
n,h,r = day(6, 12, 25, 40, 285)   # scattered lake homes, golf carts
print(f"{'Golf carts, scattered around a lake':<44}{6:>7}{n:>10,.0f}{r:>9,.0f}")
n,h,r = day(14, 3, 25, 40, 285)   # same work inside one park
print(f"{'Golf carts, all inside ONE park':<44}{14:>7}{n:>10,.0f}{r:>9,.0f}")
n,h,r = day(5, 12, 25, 75, 395)
print(f"{'MH winterization, scattered':<44}{5:>7}{n:>10,.0f}{r:>9,.0f}")
n,h,r = day(7, 3, 25, 75, 395)
print(f"{'MH winterization, one park':<44}{7:>7}{n:>10,.0f}{r:>9,.0f}")

print("\n  Inside a park the drive between stops is ~2-3 minutes, not 12.")
print("  Hourly rises modestly (+16-34%); THROUGHPUT is the real win —")
print("  6 stops becomes 14, and the crew's DAY goes $1,058 -> $2,629.")
print("  That is the retention problem from the launch model, solved by geography.\n")

print("WHAT THE PARK IS WORTH TO THE PLATFORM (season one, park #1)")
print("-"*76)
print(f"  Rent collected:        pass-through, $0 margin by design")
print(f"  Service margin:        ${marg:,.0f}")
print(f"  New customers reached: {LOTS} households, from ONE relationship")
print(f"  Crew density:          a full truck-day without leaving the property")
print(f"\n  Compare: the launch model said ~16 scattered customers = ONE crew day/week.")
print(f"  This park is {LOTS} customers at one address.")
