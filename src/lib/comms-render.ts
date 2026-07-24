/**
 * Pure render layer for AI comms context — testable without a server.
 * These strings are EXACTLY what the model sees about a person; the
 * rule-1 tests in comms-render.test.ts hold the line that a customer
 * context never carries crew economics and a crew context never carries
 * customer prices or margins.
 */

export interface CustomerContext {
  name: string | null;
  properties: Array<{ label: string; lake: string | null }>;
  jobs: Array<{ service: string; date: string; status: string; price: number | null; where: string | null }>;
  autopilotServices: string[];
  creditBalance: number;
}

export interface CrewContext {
  company: string;
  services: string[];
  lakes: string[];
  trucks: Array<{ name: string; capacity: number; hours: string; active: boolean }>;
  pendingTakeHome: number;
  upcomingJobs: Array<{ service: string; date: string }>;
  coiExpiry: string | null;
  garagekeepersExpiry: string | null;
}

export function renderCustomerContext(c: CustomerContext): string {
  const lines: string[] = [];
  lines.push(`Customer: ${c.name ?? "the homeowner"}`);
  for (const p of c.properties) lines.push(`Property: ${p.label}${p.lake ? ` on ${p.lake}` : ""}`);
  const upcoming = c.jobs.filter((j) => j.status === "requested" || j.status === "scheduled" || j.status === "in_progress");
  const past = c.jobs.filter((j) => j.status === "complete" || j.status === "paid");
  for (const j of upcoming.slice(0, 5)) {
    lines.push(`Upcoming: ${j.service} on ${j.date}${j.where ? ` at ${j.where}` : ""} (${j.status}${j.price != null ? `, $${j.price}` : ""})`);
  }
  for (const j of past.slice(0, 5)) {
    lines.push(`Done: ${j.service} on ${j.date}${j.price != null ? ` ($${j.price})` : ""}`);
  }
  if (c.autopilotServices.length) lines.push(`Autopilot on: ${c.autopilotServices.join(", ")}`);
  if (c.creditBalance > 0) lines.push(`Credit balance: $${c.creditBalance.toFixed(2)}`);
  return lines.join("\n");
}

export function renderCrewContext(c: CrewContext): string {
  const lines: string[] = [];
  lines.push(`Crew: ${c.company}`);
  if (c.services.length) lines.push(`Services: ${c.services.join(", ")}`);
  if (c.lakes.length) lines.push(`Lakes served: ${c.lakes.join(", ")}`);
  for (const t of c.trucks) lines.push(`Truck: ${t.name} (${t.capacity}/day, ${t.hours}${t.active ? "" : ", off"})`);
  if (c.pendingTakeHome > 0) lines.push(`Take-home ready to pay out: $${c.pendingTakeHome.toFixed(2)}`);
  for (const j of c.upcomingJobs.slice(0, 5)) lines.push(`Upcoming job: ${j.service} on ${j.date}`);
  if (c.coiExpiry) lines.push(`Insurance on file through ${c.coiExpiry}`);
  if (c.garagekeepersExpiry) lines.push(`Garagekeepers on file through ${c.garagekeepersExpiry}`);
  return lines.join("\n");
}
