import type { Artifact, Download, Project, UploadInstructions, UploadTicket, Version } from "../src/types.js";

export const PROJECT_ID = "0198f3c2-0000-7000-8000-000000000001";
export const ARTIFACT_ID = "0198f3c2-0000-7000-8000-0000000000a1";
export const VERSION_ID = "0198f3c2-0000-7000-8000-0000000000b1";
/** sha256 of the ASCII bytes "hello" */
export const HELLO_SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

export const VERSION_VIEW: Version = {
  id: VERSION_ID,
  version_number: 1,
  original_filename: "hello.txt",
  content_type: "text/plain",
  size_bytes: 5,
  etag: '"abc"',
  sha256: HELLO_SHA256,
  summary: null,
  status: "ready",
  created_at: "2026-09-21T10:00:00Z",
};

export const ARTIFACT: Artifact = {
  id: ARTIFACT_ID,
  project_id: PROJECT_ID,
  external_key: null,
  title: "Hello",
  description: "",
  tags: ["greeting"],
  metadata: { k: "v" },
  status: "ready",
  expires_at: null,
  created_by: "key:test",
  created_at: "2026-09-21T10:00:00Z",
  updated_at: "2026-09-21T10:00:01Z",
  latest_version: VERSION_VIEW,
  semantic_ready: true,
  superseded: false,
  superseded_by: null,
  stale_upstream: false,
};

export function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return { ...ARTIFACT, ...overrides };
}

export const UPLOAD: UploadInstructions = {
  method: "PUT",
  url: "https://storage.test/bucket/object?X-Amz-Signature=SECRETSIG",
  headers: { "Content-Type": "text/plain" },
  expires_at: "2026-09-21T10:15:00Z",
};

export const TICKET: UploadTicket = {
  artifact: { id: ARTIFACT_ID, version_id: VERSION_ID, status: "pending_upload" },
  upload: UPLOAD,
};

export const DOWNLOAD: Download = {
  url: "https://storage.test/bucket/object?X-Amz-Signature=SECRETGET",
  method: "GET",
  expires_at: "2026-09-21T10:15:00Z",
  version_id: VERSION_ID,
};

export const PROJECTS: Project[] = [
  { id: PROJECT_ID, name: "Default", slug: "default", created_at: "2026-09-01T00:00:00Z" },
  { id: "0198f3c2-0000-7000-8000-000000000002", name: "Research", slug: "research", created_at: "2026-09-02T00:00:00Z" },
];
