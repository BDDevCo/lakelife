# Crew-side economics. Customer prices are production's real menu; crew rates
# are ~68% of menu (the spread that leaves LakeLife its ~32%).
RATE = 0.68
JOBS = {   # (customer price, on-site minutes)
 "Mow (medium)":        (85,   45),
 "Housekeeping":        (95,   90),
 "Pier install":        (508, 180),
 "Boat lift set/pull":  (495,  90),
 "Spring opening":      (430, 120),
}
DRIVE_MIN_BETWEEN = 12      # stops on the same lake
DRIVE_MIN_TO_LAKE = 25      # base -> first stop, and last -> home
COST_PER_MIN_DRIVE = 0.95   # fuel + wear + the driver's time
DAY_MIN = 8*60

print("WHY DENSITY IS THE PRODUCT — a day of mows for one crew")
print("-"*74)
print(f"{'Stops':>6}{'Gross':>10}{'On-site':>10}{'Drive':>8}{'Drive cost':>12}{'Net':>10}{'Net/hr':>9}")
for stops in (1,2,3,4,6,8):
    gross = stops*85*RATE
    onsite = stops*45
    drive = 2*DRIVE_MIN_TO_LAKE + max(0,stops-1)*DRIVE_MIN_BETWEEN
    dcost = drive*COST_PER_MIN_DRIVE
    net = gross-dcost
    hrs = (onsite+drive)/60
    flag = "" if net/hrs > 45 else "   <- not worth the trip"
    print(f"{stops:>6}{gross:>10,.0f}{onsite:>10}{drive:>8}{dcost:>12,.0f}{net:>10,.0f}{net/hrs:>9,.0f}{flag}")

print("\n  A crew driving 25 min each way for ONE $85 mow nets $10/hr.")
print("  The same crew with 6 mows on that lake nets ~$59/hr.")
print("  LakeLife's core product to a crew is a FULL DAY, not a job.\n")

print("MIXED DAY — what a good LakeLife day looks like")
print("-"*74)
day = ["Spring opening","Mow (medium)","Mow (medium)","Boat lift set/pull","Mow (medium)"]
gross=onsite=0
for j in day:
    p,m = JOBS[j]; gross += p*RATE; onsite += m
drive = 2*DRIVE_MIN_TO_LAKE + (len(day)-1)*DRIVE_MIN_BETWEEN
net = gross - drive*COST_PER_MIN_DRIVE
print(f"  {len(day)} stops, {onsite+drive} min ({(onsite+drive)/60:.1f} h of an 8h day)")
print(f"  Crew gross ${gross:,.0f} | drive cost ${drive*COST_PER_MIN_DRIVE:,.0f} | "
      f"net ${net:,.0f} = ${net/((onsite+drive)/60):,.0f}/hr")
print(f"  Over a 22-week season, 4 days/wk: ${net*4*22:,.0f}\n")

print("THE CONCENTRATION PROBLEM the audit found")
print("-"*74)
print("  34 crews, 10,184 jobs over two seasons.")
print("  Top 4 crews carried 3,756 jobs (37%).  14 crews had ZERO.\n")
# What a new crew faces under score > density > margin > fairness ranking
print("  Dispatch ranks: score, then density, then margin, then fairness (last).")
print("  A new crew has no score, so it loses every tie to an established crew,")
print("  so it never completes a job, so it never earns a score. Cold-start trap.\n")
seasons=2
for label, jobs in (("a top-4 crew", 3756/4), ("the median crew", (10184-3756)/30), ("an idle crew", 0)):
    per_season = jobs/seasons
    earn = per_season*85*RATE   # rough, as if all mows
    print(f"  {label:<18}{per_season:>7,.0f} jobs/season  ~${earn:>9,.0f}/season gross")
print("\n  14 idle crews are 14 businesses about to quit. Every one that quits")
print("  shrinks supply, which is what CREATES the below-floor problem.")
