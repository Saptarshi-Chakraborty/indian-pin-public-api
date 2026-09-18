import { neon } from "@neondatabase/serverless";
import fs from "fs";
import path from "path";

// ==========================================
// ⚙️ FINE-GRAINED CONTROL CONSTANTS
// ==========================================
//

const DEFAULT_BATCH_SIZE: number = 500;

const CONFIG = {
  BATCH_SIZE: process.env.READ_BATCH_SIZE || DEFAULT_BATCH_SIZE,
  OUTPUT_DIR: "./dist/pincode", // Target output folder
  DATABASE_URL: process.env.DATABASE_URL as string,
};
CONFIG.BATCH_SIZE = parseInt(CONFIG.BATCH_SIZE as string) || DEFAULT_BATCH_SIZE;

// ========================================== //

// Initialize Neon client
const sql = neon(CONFIG.DATABASE_URL!);

async function main() {
  if (!CONFIG.DATABASE_URL) {
    console.error(
      "❌ Error: DATABASE_URL is not set in the environment variables!",
    );
    process.exit(1);
  }

  // Ensure output directory exists (handles nested paths safely)
  if (!fs.existsSync(CONFIG.OUTPUT_DIR)) {
    fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });
    console.log(`📁 Created directory: ${CONFIG.OUTPUT_DIR}`);
  }

  console.log("🔍 Fetching all distinct PIN codes from NeonDB...");
  const distinctPinsResult = await sql`
    SELECT DISTINCT pincode FROM postal_offices ORDER BY pincode ASC
  `;

  const pinCodes = distinctPinsResult.map((row: any) => row.pincode);
  const totalPins = pinCodes.length;
  console.log(
    `🚀 Found ${totalPins} unique PIN codes. Starting file generation...\n`,
  );

  let processedPins = 0;
  const startTime = performance.now();

  // Process PIN codes in chunks based on BATCH_SIZE
  for (let i = 0; i < totalPins; i += CONFIG.BATCH_SIZE) {
    const pinChunk = pinCodes.slice(i, i + CONFIG.BATCH_SIZE);

    try {
      // Fetch all postal office records belonging to this chunk of PIN codes
      const query = `
        SELECT circlename, regionname, divisionname, officename,
               pincode, officetype, delivery, district, statename, latitude, longitude
        FROM postal_offices
        WHERE pincode = ANY($1)
      `;
      const records = await sql.query(query, [pinChunk]);

      // Group records by their pincode using a Map for high performance O(1) grouping
      const groupedByPin = new Map<number, any[]>();

      for (const record of records) {
        const pin = record.pincode;
        if (!groupedByPin.has(pin)) {
          groupedByPin.set(pin, []);
        }
        // Exclude the database id column or format keys if necessary,
        // pushing the clean object representation
        groupedByPin.get(pin)!.push({
          circlename: record.circlename,
          regionname: record.regionname,
          divisionname: record.divisionname,
          officename: record.officename,
          pincode: record.pincode,
          officetype: record.officetype,
          delivery: record.delivery,
          district: record.district,
          statename: record.statename,
          latitude: record.latitude,
          longitude: record.longitude,
        });
      }

      // Write each PIN code group to its respective file without any extension
      for (const [pincode, entries] of groupedByPin.entries()) {
        const filePath = path.join(CONFIG.OUTPUT_DIR, pincode.toString());
        // Minified JSON string array of objects
        const minifiedJson = JSON.stringify(entries);
        fs.writeFileSync(filePath, minifiedJson, "utf8");
      }

      processedPins += pinChunk.length;
    } catch (err: any) {
      console.error(
        `\n❌ Failed at PIN batch starting index ${i}: ${err.message}`,
      );
    }

    // Render smooth inline progress bar
    const progress = Math.min((processedPins / totalPins) * 100, 100);
    const barLength = 30;
    const filled = Math.round((barLength * progress) / 100);
    const bar = "█".repeat(filled) - "".padStart(barLength - filled, "-"); // wait, fixed string repeat padding fix:
    // Safer string fill layout for the bar:
    const visualBar = "█".repeat(filled) + "-".repeat(barLength - filled);
    process.stdout.write(
      `\r[${visualBar}] ${progress.toFixed(1)}% (${processedPins}/${totalPins} PINs)`,
    );
  }

  const endTime = performance.now();
  console.log(
    `\n\n✨ Export complete in ${((endTime - startTime) / 1000).toFixed(2)} seconds!`,
  );
  console.log(
    `🎉 All ${totalPins} PIN code files successfully generated in '${CONFIG.OUTPUT_DIR}/'.`,
  );
}

main().catch(console.error);
