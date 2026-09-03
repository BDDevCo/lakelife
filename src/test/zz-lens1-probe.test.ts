import { describe, it } from "vitest";
import { parseRentRoll, parseLot, parseMoney } from "@/lib/roll-parse";
import { planImport, normaliseLotLabel, emptyLotsFrom } from "@/app/park/import-helpers";

const HAVEN = ["1","2","6","7","9","10","11","14","15","16","17","18","19","20","21","22","23","24","26","27","28"];
const lots = HAVEN.map((n, i) => ({ id: `lot-${n}`, lotNumber: n }));

function show(label: string, blob: string) {
  const p = parseRentRoll(blob, { knownLots: HAVEN });
  const plan = planImport({
    rows: p.rows, lots, liveStays: [], cutoverISO: "2027-01-01", season: null,
    namelessRoll: !p.shape.hasNameColumn,
    emptyLots: emptyLotsFrom([...p.vacantDeclared, ...p.silentLots], lots, p.rows.map(r=>r.lot?.value ?? "").filter(Boolean)),
  });
  console.log("\n===== " + label + " =====");
  console.log("delimiter", p.shape.delimiter, "headerLine", p.shape.headerLine, "hasName", p.shape.hasNameColumn);
  console.log("roles", JSON.stringify(p.columns.roles));
  console.log("index", JSON.stringify(p.columns.index));
  console.log("blockQ", JSON.stringify(p.blockQuestions));
  console.log("stats", JSON.stringify(p.stats), "silentLots", JSON.stringify(p.silentLots.map(s=>s.text)), "vacant", JSON.stringify(p.vacantDeclared.map(s=>s.text)), "unparsed", JSON.stringify(p.unparsed.map(s=>s.text)), "totals", JSON.stringify(p.totals.map(t=>t.text)), "facilities", JSON.stringify(p.facilities.map(t=>t.text)));
  for (const r of p.rows) console.log("  row", r.lines[0], "lot=", JSON.stringify(r.lot), "name=", JSON.stringify(r.name.value), "rent=", JSON.stringify(r.rent.value), r.rent.why ?? "", "notes=", JSON.stringify(r.notes), "email=", r.email.value, "phone=", r.phone.value);
  console.log("PLAN ready", plan.ready.length, "needsYou", plan.needsYou.length, "lotsToCreate", JSON.stringify(plan.lotsToCreate), "monthly", plan.monthlyTotal, "nameless", plan.namelessRoll);
  for (const r of plan.needsYou) console.log("   NEEDS lot=", r.lotLabel, "name=", r.name, "blockers=", JSON.stringify(r.blockers));
  for (const r of plan.ready) console.log("   READY lot=", r.lotLabel, "name=", r.name, "amt=", r.amount, "email=", r.email, "phone=", r.phone);
}

describe("lens1", () => {
  it("A: Lot-prefixed labels, tab", () => {
    show("A lot-prefixed", [
      "Lot\tTenant\tRent",
      "Lot 1\tWexler, Donna\t400",
      "Lot 26\tKastner, Ray\t400",
      "Lot 15\tReyes, Ana\t400",
    ].join("\n"));
  });
  it("B: bare numbers, Mike-ish headers, CSV", () => {
    show("B mike headers", [
      "Space #,Tenant,Monthly,Deposit,Move In,Phone,Email",
      '1,"Wexler, Donna",$400.00,300,4/1/15,260-555-0101,d@example.com',
      '26,"Kastner, Ray","1,200.00",0,,(260) 555-0102,',
      '15,VACANT,,,,,',
      "TOTAL,,$1600.00,,,,",
    ].join("\n"));
  });
  it("C: headers Mike might actually use", () => {
    for (const h of ["Tenant","Space #","Monthly","Lot #","Resident Name","Rent Amt","Site","Unit","Occupant","Lot Rent","Amount Due","Balance","Deposit","Move-In Date","Cell","E-mail","Last Name","First Name","Address","Home Owner","Notes"]) {
      const p = parseRentRoll(`${h}\tX\n1\tY\n2\tZ`, { knownLots: HAVEN });
      console.log(`  header ${JSON.stringify(h)} -> ${JSON.stringify(p.columns.roles[0])}`);
    }
  });
  it("D: money and dates", () => {
    for (const s of ["$400.00","400","1,200.00","4/1/15","400.5","$400 ","-","(blank)","0","400/mo","$ 400","4l0.00","542.53","1200","$1,200"]) {
      console.log("  money", JSON.stringify(s), JSON.stringify(parseMoney(s === "(blank)" ? "" : s)));
    }
  });
  it("E: lot cell forms", () => {
    for (const s of ["26","Lot 26","LOT 26","#26","26 ","Lot26","3","25","12","26A","Space 26","0026"]) {
      const f = parseLot(s, HAVEN);
      console.log("  lot", JSON.stringify(s), "->", JSON.stringify(f.value), f.why ?? "", "| normalise(readable)", normaliseLotLabel(s.trim().replace(/\s+/g,"").toUpperCase(), HAVEN));
    }
  });
  it("F: first/last name split", () => {
    show("F first+last", [
      "Lot,First Name,Last Name,Rent",
      "1,Donna,Wexler,400",
      "2,Ray,Kastner,400",
      "6,Ana,Reyes,400",
    ].join("\n"));
  });
});
