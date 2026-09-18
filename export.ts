import { neon } from "@neondatabase/serverless";
import fs from "fs";
import path from "path";

// ==========================================
// ⚙️ FINE-GRAINED CONTROL CONSTANTS
// ==========================================
//

const DEFAULT_BATCH_SIZE: number = 500;

const CONFIG = {
  BATCH_SIZE: parseInt(process.env.READ_BATCH_SIZE || "", 10) || DEFAULT_BATCH_SIZE,
  OUTPUT_DIR: "./dist/pincode", // Target output folder
  DATABASE_URL: process.env.DATABASE_URL as string,
};

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

  // ---- Run statistics (for stats.json) ----
  let processedPins = 0; // PINs whose batch succeeded (for the progress bar)
  let writtenPins = 0; // PINs whose file was actually written this run
  let failedPins = 0; // PINs in batches that failed before writing
  let totalRecords = 0; // postal office records exported
  let totalBytes = 0; // sum of generated file sizes
  let failedBatches = 0;
  const failedBatchIndexes: number[] = [];
  const startTime = performance.now();
  const startedAt = new Date();

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
        writtenPins++;
        totalRecords += entries.length;
        totalBytes += Buffer.byteLength(minifiedJson, "utf8");
      }

      processedPins += pinChunk.length;
    } catch (err: any) {
      failedBatches++;
      failedBatchIndexes.push(i);
      failedPins += pinChunk.length;
      console.error(
        `\n❌ Failed at PIN batch starting index ${i}: ${err.message}`,
      );
    }

    // Render smooth inline progress bar
    const progress = Math.min((processedPins / totalPins) * 100, 100);
    const barLength = 30;
    const filled = Math.round((barLength * progress) / 100);
    const visualBar = "█".repeat(filled) + "-".repeat(barLength - filled);
    process.stdout.write(
      `\r[${visualBar}] ${progress.toFixed(1)}% (${processedPins}/${totalPins} PINs)`,
    );
  }

  const endTime = performance.now();
  const finishedAt = new Date();
  const durationSeconds = (endTime - startTime) / 1000;

  // Collect all PIN files actually present on disk (excludes stats.json itself)
  const filesOnDisk = new Set(
    fs
      .readdirSync(CONFIG.OUTPUT_DIR)
      .filter((f) => f !== "stats.json"),
  );

  // Consistency check: distinct PINs from DB vs files actually generated
  const missingPins = pinCodes.filter((pin) => !filesOnDisk.has(pin.toString()));

  const previousStats = readPreviousStats();

  // All timestamps are UTC ISO 8601 (timestamptz equivalent)
  const stats = {
    // Timing (UTC timestamptz)
    generated_at: finishedAt.toISOString(),
    generation_started_at: startedAt.toISOString(),
    generation_duration_seconds: Number(durationSeconds.toFixed(2)),

    // PIN code counts
    total_pin_codes: totalPins, // expected from DB
    generated_pin_codes: filesOnDisk.size, // files on disk after this run
    written_this_run: writtenPins,
    failed_pin_codes: failedPins,
    missing_pin_codes: missingPins.length,
    missing_pincode_list: missingPins.map(String),

    // Data volume
    total_postal_office_records: totalRecords,
    total_size_bytes: totalBytes,
    total_size_mb: Number((totalBytes / 1024 / 1024).toFixed(2)),

    // Batch configuration
    batch_size: CONFIG.BATCH_SIZE,
    total_batches: Math.ceil(totalPins / CONFIG.BATCH_SIZE),
    failed_batches: failedBatches,
    failed_batch_start_indexes: failedBatchIndexes,

    // Environment
    source: "NeonDB (postal_offices table)",
    database: sqlHost(CONFIG.DATABASE_URL),
    node_version: process.version,
    bun_version: typeof Bun !== "undefined" ? Bun.version : null,

    // History (across runs)
    previous_run: previousStats
      ? {
          generated_at: previousStats.generated_at,
          total_pin_codes: previousStats.total_pin_codes,
          generated_pin_codes: previousStats.generated_pin_codes,
        }
      : null,
  };

  const statsPath = path.join(CONFIG.OUTPUT_DIR, "stats.json");
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");

  console.log(
    `\n\n✨ Export complete in ${durationSeconds.toFixed(2)} seconds!`,
  );
  if (missingPins.length === 0 && failedBatches === 0) {
    console.log(
      `🎉 All ${totalPins} PIN code files successfully generated in '${CONFIG.OUTPUT_DIR}/'.`,
    );
  } else {
    console.log(
      `⚠️  Generated ${writtenPins}/${totalPins} PIN files (${missingPins.length} missing, ${failedBatches} failed batch(es)).`,
    );
  }
  console.log(`📊 Stats saved to '${statsPath}'`);
}

/** Reads the previous run's stats.json, if any, for run-over-run comparison. */
function readPreviousStats(): any | null {
  const statsPath = path.join(CONFIG.OUTPUT_DIR, "stats.json");
  if (!fs.existsSync(statsPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statsPath, "utf8"));
  } catch {
    return null; // corrupt/unreadable previous stats — ignore
  }
}

/** Extracts just the host from a postgres connection string (never logs credentials). */
function sqlHost(connStr: string): string | null {
  try {
    return new URL(connStr).host;
  } catch {
    return null;
  }
}

main().catch(console.error);
