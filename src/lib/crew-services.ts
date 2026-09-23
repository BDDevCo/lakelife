/**
 * DOES THIS CREW LIST THIS SERVICE? ONE COPY, FOR THE OPS ANNOTATION.
 *
 * This rule had four copies — CrewBoard's pill, ops/data.ts, JobFile.tsx and
 * JobBoard.tsx — and three of them answered TRUE for a crew who lists nothing,
 * under a comment calling that crew a generalist. The router has never agreed:
 * dispatch pools only crews whose `service_types` INCLUDES the job's service
 * name, so a crew listing nothing is offered nothing, ever. Ops read that they
 * did everything; the machine gave them none.
 *
 * So the empty-list half lives here now, once, and both boards import it. The
 * dead ops/data.ts copy was deleted with it.
 *
 * WHAT THIS IS AND IS NOT. It is the HINT beside a crew's name on the manual
 * assign screen — a loose, forgiving match, on purpose, so a crew who typed
 * "mow" still sorts above one who typed nothing when ops is assigning "Weekly
 * mow & blow". It is NOT the router's gate: `lib/dispatch.ts` decides routing
 * with an exact `includes`, ops may still assign by hand, and the hard block on
 * the assign action is the certificate. The one thing this and the router must
 * never disagree about is the empty list, which is what this file exists for.
 */
export function crewListsService(serviceTypes: string[] | null | undefined, serviceName: string | null): boolean {
  const types = serviceTypes ?? [];
  // AN EMPTY LIST MATCHES NOTHING, not everything.
  if (!types.length) return false;
  const svc = (serviceName ?? "").toLowerCase();
  return types.some((t) => {
    const tt = String(t).toLowerCase();
    return svc.includes(tt) || tt.includes(svc.split(" ")[0]);
  });
}
