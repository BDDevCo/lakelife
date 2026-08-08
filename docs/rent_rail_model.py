LOTS=80; RENT=450; MONTHS=12
gross = LOTS*RENT*MONTHS
print(f"Park: {LOTS} lots x ${RENT}/mo = ${gross:,.0f} of rent collected per year")
print("Rent carries ZERO margin by design — LakeLife keeps none of it.\n")

def card(amt): return amt*0.029 + 0.30
ACH_FLAT = 0.50            # typical per-ACH-debit cost
print("WHO PAYS THE PROCESSING FEE WHEN LAKELIFE IS MERCHANT OF RECORD")
print("-"*72)
card_yr = LOTS*MONTHS*card(RENT)
ach_yr  = LOTS*MONTHS*ACH_FLAT
print(f"  Card (2.9% + $0.30) : ${card(RENT):>6,.2f} per payment  ->  ${card_yr:>9,.0f}/yr")
print(f"  ACH  (flat ~$0.50)  : ${ACH_FLAT:>6,.2f} per payment  ->  ${ach_yr:>9,.0f}/yr")
print(f"  Difference                                    ${card_yr-ach_yr:>9,.0f}/yr\n")

SERVICE_MARGIN = 18424     # from park_model.py, one season
print("AGAINST THE PARK'S ACTUAL MARGIN")
print("-"*72)
print(f"  Service margin from the park (season)     ${SERVICE_MARGIN:>9,.0f}")
print(f"  Rent processing on CARD                  -${card_yr:>9,.0f}   ({card_yr/SERVICE_MARGIN:.0%} of it)")
print(f"  Rent processing on ACH                   -${ach_yr:>9,.0f}   ({ach_yr/SERVICE_MARGIN:.0%} of it)")
print(f"\n  Net on card: ${SERVICE_MARGIN-card_yr:>8,.0f}")
print(f"  Net on ACH : ${SERVICE_MARGIN-ach_yr:>8,.0f}")
print("\n  Card rent would eat ~2/3 of everything the park earns the platform.")
print("  This is not an optimisation — it decides which rail rent runs on.\n")

print("WHAT IT WOULD TAKE FOR CARD RENT TO BREAK EVEN")
print("-"*72)
print(f"  Pass the fee to the renter (convenience fee) : renter pays ${RENT+card(RENT):,.2f}")
print(f"  Or charge the park owner                     : ${card_yr/LOTS:,.0f}/lot/yr")
print(f"  Or absorb it and require a park fee of       : ${card_yr:,.0f}/yr just to break even")
print("\n  Note: card-surcharge rules vary by state and card-network agreement,")
print("  and several states restrict surcharging — an attorney question, not a")
print("  product decision.")
