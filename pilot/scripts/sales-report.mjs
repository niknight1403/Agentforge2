import { openDatabase } from "../src/db.js";
import { reportFirstSale } from "../src/sales-report.js";

// Runs only on an authorized machine with access to the server's private DB.
// Uses the existing DB_FILE configuration; no public API endpoint is added.
const db = openDatabase();
try {
  process.stdout.write(JSON.stringify(reportFirstSale(db), null, 2) + "\n");
} finally {
  db.close();
}
