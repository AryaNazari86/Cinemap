// Read a Letterboxd export in the browser and keep only ratings.csv, so the upload is small
// (Vercel caps request bodies at 4.5 MB) and the rest of the export never leaves the device.

const MAX_FILE_BYTES = 200_000_000; // a whole export is rarely over a few MB
const MAX_CSV_BYTES = 4_000_000; // matches letterboxd.MAX_UPLOAD_BYTES on the server

export class ExportError extends Error {}

/** ratings.csv from a dropped .zip export or a .csv file. */
export async function ratingsCsv(file: File): Promise<Blob> {
  if (file.size > MAX_FILE_BYTES) throw new ExportError("That file is too large to be a Letterboxd export.");
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (isZip) return fromZip(file);
  if (!/\.csv$/i.test(file.name)) {
    throw new ExportError("Drop the .zip from Letterboxd, or the ratings.csv inside it.");
  }
  if (file.size > MAX_CSV_BYTES) throw new ExportError("That ratings.csv is too large.");
  return file;
}

async function fromZip(file: File): Promise<Blob> {
  // Loaded on first use: most visitors never upload anything.
  const { unzip } = await import("fflate");
  const data = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(
      data,
      // Only ratings.csv at the top level; deleted/ and orphaned/ hold other things.
      { filter: (f) => f.name === "ratings.csv" },
      (err, out) => (err ? reject(err) : resolve(out)),
    ),
  ).catch(() => {
    throw new ExportError("That zip couldn't be opened. Try exporting from Letterboxd again.");
  });
  const csv = files["ratings.csv"];
  if (!csv) throw new ExportError("That zip has no ratings.csv. Is it a Letterboxd export?");
  if (csv.length > MAX_CSV_BYTES) throw new ExportError("The ratings.csv in that zip is too large.");
  // fflate's output is backed by a plain ArrayBuffer, never a SharedArrayBuffer.
  return new Blob([csv as Uint8Array<ArrayBuffer>], { type: "text/csv" });
}
