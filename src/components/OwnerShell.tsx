import { TopBar } from "@/components/Brand";
import { OwnerNav } from "@/components/OwnerNav";
import { PropertySwitcher } from "@/components/PropertySwitcher";
import { listProperties, getActivePropertyId } from "@/app/profile/data";

/**
 * THE HOMEOWNER WORKSPACE — top bar, column, page.
 *
 * The same shape as ParkShell, and for the same reason: the column has to be
 * a sibling of the page content for the grid to place them side by side, so
 * the screens hand their body to this instead of placing the nav themselves.
 *
 * WHICH PROPERTY IS IN THE CONTEXT BAR, NOT THE COLUMN. An account with
 * several homes — an owner with two, a property manager with ten — needs to
 * know which one the screen is about, and the column is a bar along the
 * bottom at 900px and below. So the answer sits above the page at every
 * width, with the switcher beside it when there is more than one.
 */
export async function OwnerShell({ children }: { children: React.ReactNode }) {
  const [properties, activeId] = await Promise.all([listProperties(), getActivePropertyId()]);
  const active = properties.find((p) => p.id === activeId) ?? properties[0];
  const name = active?.nickname ?? active?.address ?? null;

  return (
    <>
      <TopBar />
      <div className="ll-workspace">
        <div className="ll-ws-ctx">
          <span className="ll-ws-ctx-name">{name ?? "My LakeLife"}</span>
          {active?.lake && <span className="ll-pill teal">{active.lake}</span>}
          {/* The switcher earns its room only when there is something to
              switch between; with one property it is a dropdown of one. The
              "+ Add a property" link inside it is the other half of the
              control, so a single-property account still needs it — it lives
              on the profile screen, which is where that account goes to add
              the second one. */}
          {properties.length > 1 && (
            <div className="ll-ws-ctx-act">
              <PropertySwitcher properties={properties} activeId={activeId} />
            </div>
          )}
        </div>
        <aside className="ll-sidebar">
          <div className="ll-ws-id">
            <small>My property</small>
            <b>{name ?? "No property yet"}</b>
            {active?.lake && <span>{active.lake}</span>}
          </div>
          <OwnerNav />
        </aside>
        <main className="ll-ws-main">{children}</main>
      </div>
    </>
  );
}
