import { previewApolloCompanies } from "../src/apollo.js";

try {
  const result = await previewApolloCompanies();
  // Output only company-level data. Do not output API tokens, people, email or phone.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  console.error("Apollo-Vorschau:", error.message);
  process.exitCode = 1;
}
