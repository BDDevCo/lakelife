import random
random.seed(20260727)
# Cheapest AVAILABLE crew rate as a share of menu price. Thin markets -> crews
# quote closer to (or above) menu, so achievable margin is small or negative.
# Distribution widens at launch (few crews) and tightens as competition arrives.
def cheapest_rate_share(liquidity):
    # liquidity 0 = launch (few crews), 1 = frothy (many crews bidding)
    mean = 0.78 - 0.13*liquidity      # frothy market -> cheaper cheapest bid
    return random.gauss(mean, 0.11)

MENU = [("Mow", 85, 0.42), ("Housekeeping", 95, 0.14), ("Open/close", 457, 0.18),
        ("Pier", 508, 0.13), ("Boat lift", 495, 0.08), ("Storage pkg", 2550, 0.05)]
N = 4000
PROC = lambda p: p*0.029 + 0.30      # card processing, the floor under the floor

def run(floor_pct, dollar_floor, liquidity):
    filled=margin=gross=0; thin=0
    for _ in range(N):
        r=random.random(); acc=0
        for name,price,w in MENU:
            acc+=w
            if r<=acc: break
        share=cheapest_rate_share(liquidity)
        cost=price*share
        m=price-cost
        if m >= price*floor_pct and m >= dollar_floor:
            filled+=1; margin+=m; gross+=price
            if m - PROC(price) < 5: thin+=1
    return filled/N, margin, gross, thin

print("AT LAUNCH (few crews competing)  — 4,000 simulated bookings")
print("-"*78)
print(f"{'Floor':>16}{'Fill rate':>11}{'Total margin':>15}{'Margin/filled':>15}{'Thin jobs':>11}")
for fp,df in ((0.30,0),(0.25,0),(0.20,0),(0.15,0),(0.20,25),(0.20,35)):
    f,m,g,t=run(fp,df,liquidity=0.0)
    lbl=f"{fp:.0%}" + (f" or ${df}" if df else "")
    print(f"{lbl:>16}{f:>10.0%}{m:>15,.0f}{m/max(1,f*N):>15,.0f}{t:>11}")

print("\nONCE FROTHY (many crews bidding)")
print("-"*78)
print(f"{'Floor':>16}{'Fill rate':>11}{'Total margin':>15}{'Margin/filled':>15}")
for fp,df in ((0.30,0),(0.25,0),(0.20,25),(0.20,0)):
    f,m,g,t=run(fp,df,liquidity=1.0)
    lbl=f"{fp:.0%}" + (f" or ${df}" if df else "")
    print(f"{lbl:>16}{f:>10.0%}{m:>15,.0f}{m/max(1,f*N):>15,.0f}")

print("\nTHE FLOOR UNDER THE FLOOR — card processing eats the bottom of the menu")
print("-"*78)
print(f"{'Service':>14}{'Price':>8}{'20% margin':>12}{'Processing':>12}{'Net to LakeLife':>18}")
for name,price,_ in MENU:
    m=price*0.20; p=PROC(price)
    print(f"{name:>14}{price:>8}{m:>12,.2f}{p:>12,.2f}{m-p:>18,.2f}")
print("\n  A 20% margin on a $85 mow nets ~$11 after processing.")
print("  At 15% it is $9.98. At 10% it is $5.73 — before any support or refund.")
