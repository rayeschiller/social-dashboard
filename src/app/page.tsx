import { getPool } from "@/lib/db";
import { loadDashboard } from "@/lib/queries/ui/dashboard";
import { Growth, Header, Hero, History, NewFollowers, NotConnectedBanner, Posts } from "@/ui/Sections";
import { parseSort } from "@/ui/posts";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ sort?: string | string[] }> }) {
  const spec = parseSort((await searchParams).sort);
  const data = await loadDashboard(getPool());
  const tz = data.goal.timezone;
  return (
    <main className="page">
      <Header data={data} tz={tz} />
      <NotConnectedBanner data={data} />
      <Hero data={data} tz={tz} />
      <Growth data={data} tz={tz} />
      <History data={data} tz={tz} />
      <NewFollowers data={data} tz={tz} />
      <Posts data={data} tz={tz} spec={spec} />
      <footer className="foot small">
        Every figure is read from stored Instagram API observations. Nothing is estimated, interpolated or filled in;
        missing data reads Unavailable. Times are shown in {tz}.
      </footer>
    </main>
  );
}
