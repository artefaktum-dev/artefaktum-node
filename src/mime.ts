/**
 * Content type from a file name. JavaScript has no `mimetypes` and this package takes no
 * dependencies, so this is a deliberately small table of what agents actually exchange;
 * anything else is `application/octet-stream`, and callers can always pass `content_type`.
 */
const TYPES: Record<string, string> = {
  // text and data
  txt: "text/plain", log: "text/plain", md: "text/markdown", markdown: "text/markdown",
  csv: "text/csv", tsv: "text/tab-separated-values", html: "text/html", htm: "text/html",
  css: "text/css", xml: "application/xml", json: "application/json", jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson", yaml: "application/yaml", yml: "application/yaml", toml: "application/toml",
  js: "text/javascript", mjs: "text/javascript", ts: "text/typescript", py: "text/x-python", sql: "application/sql",
  // documents
  pdf: "application/pdf", rtf: "application/rtf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // data science
  parquet: "application/vnd.apache.parquet", avro: "application/avro", npy: "application/octet-stream",
  ipynb: "application/x-ipynb+json", sqlite: "application/vnd.sqlite3", db: "application/vnd.sqlite3",
  // images
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", ico: "image/x-icon",
  // audio and video
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  // archives
  zip: "application/zip", gz: "application/gzip", tgz: "application/gzip", tar: "application/x-tar",
  bz2: "application/x-bzip2", "7z": "application/x-7z-compressed",
};

export function contentTypeFor(filename: string): string {
  const base = filename.slice(Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  // No dot, or a dotfile like `.gitignore`: there is no extension to read.
  if (dot <= 0) return "application/octet-stream";
  return TYPES[base.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}
