import { describe, it } from "vitest";
import { parseRentRoll } from "@/lib/roll-parse";

const HAVEN_LOTS = ["1","2","6","7","9","10","11","14","15","16","17","18","19","20","21","22","23","24","26","27","28"];

function show(title: string, blob: string) {
  const r = parseRentRoll(blob, { knownLots: HAVEN_LOTS });
  console.log("\n=====", title, "=====");
  console.log("delimiter:", r.shape.delimiter, "header:", r.shape.headerLine, "hasName:", r.shape.hasNameColumn);
  console.log("index:", JSON.stringify(r.columns.index), "unrecognised:", JSON.stringify(r.columns.unrecognised));
  console.log("blockQuestions:", r.blockQuestions.map(q=>q.code).join(","));
  for (const row of r.rows) {
    console.log(` line ${row.lines[0]} lot=${JSON.stringify(row.lot.value)} name=${JSON.stringify(row.name.value)} rent=${JSON.stringify(row.rent.value)} verdict=${row.verdict} ask=${JSON.stringify(row.askReasons)} notes=${JSON.stringify(row.notes)}`);
  }
  console.log(" silentLots:", JSON.stringify(r.silentLots.map(s=>s.text)));
  console.log(" vacant:", JSON.stringify(r.vacantDeclared.map(s=>s.text)));
  console.log(" unparsed:", JSON.stringify(r.unparsed.map(s=>s.text)));
  console.log(" totals:", JSON.stringify(r.totals.map(s=>s.text)));
  console.log(" stats:", JSON.stringify(r.stats));
}

describe("probe", () => {
  it("quoted csv, surname-first", () => {
    show("A. Excel CSV, quoted 'Surname, Given'", [
      "Lot,Tenant,Rent,Deposit",
      '1,"Wexler, Donna",400,300',
      '2,"Kastner, Ray",385,0',
      '6,"Reyes, Donna",410,300',
      '7,"O\'Neil, Pat",400,300',
    ].join("\n"));
  });

  it("plain csv given-first", () => {
    show("B. Plain CSV, 'Donna Wexler'", [
      "Lot,Tenant,Rent,Deposit",
      "1,Donna Wexler,400,300",
      "2,Ray Kastner,385,0",
      "6,Reyes Donna,410,300",
    ].join("\n"));
  });

  it("haven-ish sheet with title, vacants and total", () => {
    show("C. Title row + vacant + total", [
      "THE HAVEN MHP - RENT ROLL 9/1/2026",
      "",
      "Lot,Tenant,Rent",
      "1,Donna Wexler,400",
      "2,Ray Kastner,385",
      "6,VACANT,",
      "11,PARK OWNED,0",
      "14,Pat O'Neil,400",
      "TOTAL,,1185",
    ].join("\n"));
  });
});
