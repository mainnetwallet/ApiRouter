import { PageHeader } from "../components/layout/PageHeader.jsx";
import { CustomEndpoints } from "../components/domain/CustomEndpoints.jsx";

/**
 * Custom endpoints.
 *
 * The one place to keep your own base URL permanently. Each saved endpoint is a
 * provider in the Fallback Chain with its own models and keys. The Playground
 * only tests an endpoint once and never saves it; saving happens here.
 */
export default function CustomEndpointsPage() {
  return (
    <div className="page">
      <PageHeader
        title="Custom endpoints"
        description="Your own base URL, models and keys, saved permanently. Each one works in the fallback chain like any other provider."
      />
      <CustomEndpoints showHeading={false} />
    </div>
  );
}
