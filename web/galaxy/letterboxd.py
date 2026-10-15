"""Read star ratings from a Letterboxd export: the whole .zip, or just its ratings.csv.

Letterboxd's export (Settings > Data > Export your data) is a zip of CSVs. Only ratings.csv
is read, with the columns Date, Name, Year, Letterboxd URI and Rating (0.5 to 5 in half
stars). The URI and everything else in the export are ignored and never kept.
"""

import csv
import io
import zipfile
from dataclasses import dataclass
from datetime import date

# Vercel rejects request bodies over 4.5 MB; stay under it with room for the multipart wrapper.
MAX_UPLOAD_BYTES = 4_000_000
# ratings.csv runs about 80 bytes a row, so this allows ~60,000 rows before the row cap.
MAX_CSV_BYTES = 5_000_000
MAX_ROWS = 25_000
REQUIRED_COLUMNS = {"Name", "Year", "Rating"}
VALID_RATINGS = {k / 2 for k in range(1, 11)}


class LetterboxdError(ValueError):
    """The upload isn't a usable Letterboxd ratings export; the message is safe to show."""


@dataclass(frozen=True)
class Rating:
    name: str
    year: int | None
    rating: float
    date: date | None


@dataclass(frozen=True)
class Ratings:
    rows: list[Rating]
    skipped: int  # rows that were blank or malformed


def read_upload(filename: str, content: bytes) -> Ratings:
    """Ratings from an uploaded .zip export or ratings.csv."""
    if len(content) > MAX_UPLOAD_BYTES:
        raise LetterboxdError(f"That file is over {MAX_UPLOAD_BYTES // 1_000_000} MB. Upload ratings.csv on its own.")
    if content[:4] == b"PK\x03\x04" or filename.lower().endswith(".zip"):
        return parse_csv(_ratings_from_zip(content))
    if filename.lower().endswith(".csv"):
        return parse_csv(content)
    raise LetterboxdError("Upload your Letterboxd export (.zip) or the ratings.csv inside it.")


def _ratings_from_zip(content: bytes) -> bytes:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            info = next((i for i in archive.infolist() if i.filename == "ratings.csv"), None)
            if info is None:
                raise LetterboxdError("That zip has no ratings.csv. Is it a Letterboxd export?")
            # The declared size can lie, so the read is capped too.
            if info.file_size > MAX_CSV_BYTES:
                raise LetterboxdError("ratings.csv in that zip is too large.")
            with archive.open(info) as f:
                data = f.read(MAX_CSV_BYTES + 1)
    except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, RuntimeError):
        raise LetterboxdError("That zip couldn't be opened. Try exporting from Letterboxd again.") from None
    if len(data) > MAX_CSV_BYTES:
        raise LetterboxdError("ratings.csv in that zip is too large.")
    return data


def parse_csv(content: bytes) -> Ratings:
    if len(content) > MAX_CSV_BYTES:
        raise LetterboxdError("That ratings.csv is too large.")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise LetterboxdError("That file isn't text. Upload ratings.csv from your Letterboxd export.") from None
    reader = csv.DictReader(io.StringIO(text, newline=""))
    if not REQUIRED_COLUMNS <= set(reader.fieldnames or []):
        raise LetterboxdError("That isn't a Letterboxd ratings.csv: it needs Name, Year and Rating columns.")

    rows, skipped = [], 0
    try:
        for record in reader:
            if len(rows) + skipped >= MAX_ROWS:
                raise LetterboxdError(f"That file has more than {MAX_ROWS:,} ratings.")
            row = _parse_row(record)
            if row is None:
                skipped += 1
            else:
                rows.append(row)
    except csv.Error:
        raise LetterboxdError("That ratings.csv is malformed.") from None
    if not rows:
        raise LetterboxdError("No star ratings found in that file.")
    return Ratings(rows, skipped)


def _parse_row(record: dict) -> Rating | None:
    name = (record.get("Name") or "").strip()
    try:
        rating = float(record.get("Rating") or "")
    except ValueError:
        return None
    if not name or rating not in VALID_RATINGS:
        return None
    year_text = (record.get("Year") or "").strip()
    year = int(year_text) if year_text.isdigit() and len(year_text) == 4 else None
    try:
        when = date.fromisoformat((record.get("Date") or "").strip())
    except ValueError:
        when = None
    return Rating(name[:300], year, rating, when)
