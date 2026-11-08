# src

`index.ts`: `mockBridge`, `keys`, `Collector`, `MOCK_AGENT`.

`s3.ts`: `FakeS3`, an S3 endpoint standing in for R2 (Agora's `docs/specs/files.md`), with the answers measured on
the real bucket; stopped, it refuses connections for real.
