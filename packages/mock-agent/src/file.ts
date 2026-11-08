// A file the mock agent reads, as Claude Code's `Read` returns an image (Agora's docs/specs/files.md): `size`
// bytes, the same for the same seed, so that a test knows what the log must keep.
export function mockFile(size: number, seed = 0): Buffer {
  const bytes = Buffer.alloc(size)
  let x = (seed * 2654435761 + 1) >>> 0
  for (let i = 0; i < size; i++) {
    x = (x ^ (x << 13)) >>> 0
    x = (x ^ (x >>> 17)) >>> 0
    x = (x ^ (x << 5)) >>> 0
    bytes[i] = x & 0xff
  }
  return bytes
}
