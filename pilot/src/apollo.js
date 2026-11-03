// Apollo lead research is read-only and manual. It does not send messages,
// fetch personal contact data, or initiate credit-using enrichment.
// Docs: https://docs.apollo.io/reference/people-api-search
const ENDPOINT = "https://api.apollo.io/api/v1/mixed_people/api_search";

export async function previewApolloCompanies({
  apiKey = process.env.APOLLO_API_KEY,
  fetchImpl = fetch,
  location = "Germany",
} = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("APOLLO_API_KEY fehlt. Als GitHub Actions Secret hinterlegen.");
  }
  if (!["Germany", "Deutschland"].includes(location)) {
    throw new Error("Only preapproved German market search is supported");
  }
  const controller = new AbortController();
  const request = {
    person_titles: ["Geschäftsführer", "Inhaber", "Managing Director"],
    organization_locations: [location],
    organization_num_employees_ranges: ["1,10", "11,50"],
    page: 1,
    per_page: 10,
  };
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(request),
    signal: controller.signal,
  });
  if (!response.ok) {
    // Never log error response bodies: providers may echo request headers.
    throw new Error("Apollo-Abfrage fehlgeschlagen (HTTP " + response.status + ")");
  }
  const data = await response.json();
  const companies = new Map();
  for (const person of Array.isArray(data.people) ? data.people : []) {
    const org = person.organization || {};
    const name = typeof org.name === "string" ? org.name.trim().slice(0, 120) : "";
    const website = typeof org.website_url === "string" ? org.website_url : null;
    const industry = typeof org.industry === "string" ? org.industry.slice(0, 120) : null;
    if (!name) continue;
    // Company-level information only; no personal contact details or emails.
    const key = name.toLowerCase();
    if (!companies.has(key)) companies.set(key, { company: name, industry, website });
  }
  return { companies: [...companies.values()], checked: Array.isArray(data.people) ? data.people.length : 0 };
}
