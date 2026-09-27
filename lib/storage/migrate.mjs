import { createHash } from 'node:crypto';

async function digest(stream) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}

/** Copy only missing objects. Both copies are read back and compared; neither store is deleted from. */
export async function migrateObjects({ items, source, target, apply = false, concurrency = 4, progress = () => {} }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('INVALID_CONCURRENCY');
  const counts = { total: items.length, missing: 0, copied: 0, verified: 0, conflicts: 0, failed: 0, bytes: 0 };
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      let stage = "head", reader;
      try {
        // URL decoding belongs to inventory, never here: keys must remain byte-for-byte identical.
        if (!item.key || item.key.startsWith('/') || item.key.includes('\\') || item.key.split('/').some(p => p === '.' || p === '..')) throw new Error('INVALID_KEY');
        const existing = await target.head(item.key);
        if (!existing) counts.missing++;
        if (!apply) { results.push({ key: item.key, status: existing ? 'existing' : 'missing' }); continue; }
        if (existing && existing.size !== item.size) { counts.conflicts++; results.push({ key: item.key, status: 'conflict' }); continue; }
        stage = "source";
        const original = await source.get(item);
        if (!original) throw new Error('SOURCE_MISSING');
        // Lock the upstream immediately, before awaiting destination setup.
        // An idle, unlocked fetch body may be closed by its response finalizer.
        reader = original.stream.getReader();
        const hash = createHash('sha256');
        let length = 0;
        async function* bytes() {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            const chunk = part.value;
            length += chunk.length;
            if (length > item.size) throw Object.assign(new Error('SOURCE_CHANGED'), { expectedBytes: item.size, actualBytes: length });
            hash.update(chunk);
            yield chunk;
          }
          if (length !== item.size) throw Object.assign(new Error('SOURCE_CHANGED'), { expectedBytes: item.size, actualBytes: length });
        }
        if (!existing) {
          stage = "copy";
          await target.put(item.key, bytes(), { contentType: original.contentType, overwrite: false, multipart: true });
          counts.copied++;
        } else { for await (const chunk of bytes()) void chunk; }
        const expected = hash.digest('hex');
        stage = "verify-destination";
        const retained = await target.get(item.key);
        if (!retained) throw new Error('DESTINATION_MISSING');
        const actual = await digest(retained.stream);
        if (actual.bytes !== length || actual.sha256 !== expected) {
          counts.conflicts++;
          results.push({ key: item.key, status: 'conflict' });
          continue;
        }
        stage = "verify-source";
        await source.verify(item);
        counts.verified++; counts.bytes += length;
        results.push({ key: item.key, status: 'verified', bytes: length, sha256: expected });
      } catch (error) {
        counts.failed++;
        // Raw storage errors may contain signed URLs. Reports contain only keys and bounded statuses.
        results.push({ key: item.key, status: 'failed', stage, httpStatus: typeof error?.status === 'number' ? error.status : null, errorType: error?.cause?.name ?? error?.name, errorCode: error?.cause?.cause?.code ?? error?.cause?.code ?? null, sourceChanged: error?.cause?.message === 'SOURCE_CHANGED', expectedBytes: error?.cause?.expectedBytes, actualBytes: error?.cause?.actualBytes });
      } finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        progress({ ...counts });
      }
    }
  }));
  return { counts, results };
}
