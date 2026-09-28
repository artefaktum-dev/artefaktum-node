# Changelog

## 0.2.0

Breaking:

- `summary` is removed from the options of `push`, `createUpload` and `createVersion`, and
  from the `Version` type. The API refuses a request that still sends `summary`, so
  version 0.1.0 fails an upload when a summary is set.

Added:

- `RequestTooLargeError`, thrown for HTTP 413 with code `request_too_large`: the JSON
  request is over 256 KB. It is separate from `QuotaExceededError`.

Changed on the server:

- One tag is 1 to 64 characters. `metadata` is at most 16,384 bytes as compact JSON and
  nested at most 5 levels. A value over a limit throws `ValidationError`, and its message
  names the limit. See <https://artefaktum.dev/docs/rest/#limits>.

## 0.1.0

- First release.
