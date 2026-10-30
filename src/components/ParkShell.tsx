import { TopBar } from "@/components/Brand";
import { ParkNav } from "@/components/ParkNav";

/**
 * THE PARK WORKSPACE — top bar, column, page.
 *
 * Every park screen used to write `<TopBar /><ParkNav park={park} />` and
 * then its own content, three lines repeated across thirteen files. The
 * column has to be a sibling of the page content for the grid to place them,
 * so the wrapper lives here and the screens hand it their body.
 *
 * `.wrap` inside is neutralised in globals.css rather than removed from every
 * screen — the gutter and the centring belong to pages outside a workspace,
 * and eighty content blocks did not need touching to say so.
 */
export function ParkShell({ park, children }: {
  park: Parameters<typeof ParkNav>[0]["park"];
  children: React.ReactNode;
}) {
  return (
    <>
      <TopBar />
      <div className="ll-workspace">
        <ParkNav park={park} />
        <main className="ll-ws-main">{children}</main>
      </div>
    </>
  );
}
