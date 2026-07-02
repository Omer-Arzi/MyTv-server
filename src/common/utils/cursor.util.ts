// Opaque cursor for the recently-watched feed. Wraps the EpisodeWatch id
// (which is what Prisma's native `cursor` pagination needs) in base64 so
// clients treat it as an opaque token rather than relying on its shape.
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid cursor');
  }
}
