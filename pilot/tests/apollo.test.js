import test from "node:test";
import assert from "node:assert/strict";
import { previewApolloCompanies } from "../src/apollo.js";

test("Apollo: protects missing API key and does not search automatically", async () => {
  await assert.rejects(
    previewApolloCompanies({ apiKey: "", fetchImpl: () => { throw Error("should not call"); } }),
    /APOLLO_API_KEY/
  );
});

test("Apollo: zero-credit people search returns unique company-only preview", async () => {
  let request;
  const result = await previewApolloCompanies({
    apiKey: "test-token-not-a-real-secret",
    fetchImpl: async (url, opts) => {
      request = { url, opts };
      return { ok: true, json: async () => ({ people: [
        { name: "Private Person A", email: "private@example.com", organization: { name: "Betrieb GmbH", industry: "Technik", website_url: "https://betrieb.example" } },
        { name: "Private Person B", phone_number: "012345", organization: { name: "Betrieb GmbH", industry: "Technik" } },
        { organization: { name: "Wartung KG", industry: "Services" } },
      ] }) };
    }
  });
  assert.equal(request.url, "https://api.apollo.io/api/v1/mixed_people/api_search");
  assert.equal(request.opts.headers["x-api-key"], "test-token-not-a-real-secret");
  const body = JSON.parse(request.opts.body);
  assert.equal(body.per_page, 10);
  assert.equal(body.organization_locations[0], "Germany");
  assert.equal(result.companies.length, 2);
  assert.equal(result.checked, 3);
  assert.equal(JSON.stringify(result).includes("private@example.com"), false);
  assert.equal(JSON.stringify(result).includes("Private Person"), false);
});

test("Apollo: authorization failures do not log response content", async () => {
  await assert.rejects(
    previewApolloCompanies({
      apiKey: "test-token",
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => "SECRET ECHO" }),
    }),
    err => err.message === "Apollo-Abfrage fehlgeschlagen (HTTP 403)"
  );
});
