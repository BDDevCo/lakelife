# What "ramp up to cover costs" actually requires — and what it really costs.
FIXED_MONTHLY = {  # realistic at low volume
 "Supabase Pro":25, "Vercel Pro":20, "Twilio (verify+SMS)":25,
 "Resend":20, "Anthropic API":25, "Google Maps":10, "Domain/misc":10,
}
fixed_yr = sum(FIXED_MONTHLY.values())*12
print("FIXED PLATFORM COSTS")
for k,v in FIXED_MONTHLY.items(): print(f"   {k:<24}${v:>4}/mo")
print(f"   {'TOTAL':<24}${sum(FIXED_MONTHLY.values()):>4}/mo   = ${fixed_yr:,}/yr\n")

MARGIN=0.30
ARCH=[("Just the lawn",650),("Open/close + lawn",2615),("Pier family",4621),("Whole house",10413)]
print("CUSTOMERS NEEDED TO COVER PLATFORM COSTS")
for n,s in ARCH:
    print(f"   {n:<20} ${s*MARGIN:>7,.0f} margin/season -> {fixed_yr/(s*MARGIN):>5.1f} customers")
print("\n   Infrastructure is NOT the constraint. A dozen customers covers it.")
print("   The constraint is giving a CREW a reason to show up.\n")

print("THE REAL LAUNCH NUMBER — density on ONE lake")
print("-"*70)
print("A crew wants a full day, not a job. Biweekly mowing, ~8 mows in a day:\n")
for cust in (8,16,32,64):
    mows_wk = cust/2
    days_wk = mows_wk/8
    print(f"   {cust:>3} lawn customers on one lake -> {mows_wk:>4.0f} mows/week"
          f" -> {days_wk:>4.2f} full crew-days/week")
print("\n   ~16 customers on ONE lake = one full crew day a week.")
print("   ~64 customers on ONE lake = a crew's whole week.\n")

print("SPREAD vs CONCENTRATED — same 24 customers")
print("-"*70)
for label, per_lake, lakes in (("Spread over 3 lakes", 8, 3), ("Concentrated on 1 lake", 24, 1)):
    mows_wk = per_lake/2
    stops_day = min(8, mows_wk)          # what a crew can batch in a day
    # crew net/hr using earlier model: 25min each way, 12min between, 45min/stop
    gross = stops_day*85*0.68
    drive = 50 + max(0,stops_day-1)*12
    net = gross - drive*0.95
    hrs = (stops_day*45+drive)/60
    print(f"   {label:<24} {per_lake} cust/lake -> {stops_day:.0f} stops/day, "
          f"crew nets ${net/hrs:,.0f}/hr")
print("\n   Same customer count. One is a business for a crew, one is a favour.")
