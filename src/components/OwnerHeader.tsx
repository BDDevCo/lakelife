import { OwnerNav } from "@/components/OwnerNav";
import { PropertySwitcher } from "@/components/PropertySwitcher";
import { listProperties, getActivePropertyId } from "@/app/profile/data";

/**
 * The owner-portal header: the tab nav plus a property switcher, so an account
 * with several homes (owner or property manager) can pick which one to view.
 */
export async function OwnerHeader() {
  const [properties, activeId] = await Promise.all([listProperties(), getActivePropertyId()]);

  return (
    <>
      <OwnerNav />
      {properties.length > 0 && (
        <div className="wrap" style={{ paddingTop: 12, paddingBottom: 0 }}>
          <PropertySwitcher properties={properties} activeId={activeId} />
        </div>
      )}
    </>
  );
}
