/** Chart geometry helpers. Gaps (null) are never bridged. */

/** Runs of consecutive indexes whose value is non-null. */
export function runs(values: ReadonlyArray<number | null>): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(i);
  });
  if (cur.length) out.push(cur);
  return out;
}

/** Y domain padded around the real min/max so the line does not touch the frame. */
export function paddedDomain(min: number, max: number): [number, number] {
  const range = max - min;
  const pad = range === 0 ? 1 : range * 0.12;
  return [min - pad, max + pad];
}
