import { neon } from "@neondatabase/serverless";
import Papa from "papaparse";
import fs from "fs";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const filePath = "./indian-pin-codes.csv";

  if (!fs.existsSync(filePath)) {
    console.error("❌ Error: pincodes.csv not found in the directory!");
    process.exit(1);
  }

  console.log("📂 Reading and parsing CSV file...");
  const csvFile = fs.readFileSync(filePath, "utf8");

  Papa.parse(csvFile, {
    header: true,
    skipEmptyLines: true,
    complete: async (results) => {
      const rows = results.data as any[];
      const totalRows = rows.length;
      console.log(`🚀 Parsed ${totalRows} records. Starting upload to NeonDB...\n`);

      const batchSize = 50;
      let totalInserted = 0;
      let failedBatches = 0;
      const startTime = performance.now();

      for (let i = 0; i < totalRows; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const valuePlaceholders: string[] = [];
        const flatValues: any[] = [];
        let paramIndex = 1;

        // Build placeholders and flatten parameters for sql.query()
        batch.forEach((row) => {
          const lat = row.latitude && row.latitude !== "NA" ? parseFloat(row.latitude) : null;
          const lng = row.longitude && row.longitude !== "NA" ? parseFloat(row.longitude) : null;

          valuePlaceholders.push(
            `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
          );

          flatValues.push(
            row.circlename || null,
            row.regionname || null,
            row.divisionname || null,
            row.officename || null,
            parseInt(row.pincode, 10),
            row.officetype || null,
            row.delivery || null,
            row.district || null,
            row.statename || null,
            lat,
            lng
          );
        });

        try {
          const queryText = `
            INSERT INTO postal_offices (
              circlename, regionname, divisionname, officename,
              pincode, officetype, delivery, district, statename, latitude, longitude
            ) VALUES ${valuePlaceholders.join(", ")}
          `;

          // Use sql.query to support parameter arrays safely
          await sql.query(queryText, flatValues);
          totalInserted += batch.length;
        } catch (err: any) {
          failedBatches++;
          console.log(`\n❌ Failed at batch starting index ${i}: ${err.message}`);
        }

        // Render progress bar
        const progress = Math.min((totalInserted / totalRows) * 100, 100);
        const barLength = 30;
        const filled = Math.round((barLength * progress) / 100);
        const bar = "█".repeat(filled) + "-".repeat(barLength - filled);
        process.stdout.write(`\r[${bar}] ${progress.toFixed(1)}% (${totalInserted}/${totalRows})`);
      }

      const endTime = performance.now();
      console.log(`\n\n✨ Upload complete in ${((endTime - startTime) / 1000).toFixed(2)} seconds!`);
      if (failedBatches > 0) {
        console.log(`⚠️ Completed with ${failedBatches} failed batch(es).`);
      } else {
        console.log(`🎉 All records successfully uploaded without errors!`);
      }
    },
    error: (error: any) => {
      console.error("❌ CSV Parsing Error:", error.message);
    },
  });
}

main().catch(console.error);
