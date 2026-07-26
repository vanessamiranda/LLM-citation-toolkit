/**
 * GEO scoring. Pure ESM, no platform APIs, so the Node collector and the
 * browser dashboard import the same code and can never disagree.
 *
 *   GEO score = 100 * ( 0.40*frequency + 0.25*prominence
 *                     + 0.20*normalisedShareOfVoice + 0.15*topTwoRate )
 *
 * Change WEIGHTS once if your commercial reality differs, then leave it
 * alone. A moving formula makes the trend line meaningless.
 */
export const WEIGHTS = { frequency: 0.40, prominence: 0.25, shareOfVoice: 0.20, topTwo: 0.15 };

/** Prominence decay: rank 1 -> 1.0, rank 6+ -> 0. */
const prominenceOf = (index) => Math.max(0, 1 - index / 5);

/**
 * @param {Array} records  [{promptId, engineId, cited:[brandId,...]}]
 * @param {Array} brands   [{id, name, ...}]
 * @param {number} promptCount
 * @param {Array<string>} activeEngineIds  engines that actually returned data
 */
export function computeScores(records, brands, promptCount, activeEngineIds) {
  const active = new Set(activeEngineIds);
  const used = records.filter(r => active.has(r.engineId) && Array.isArray(r.cited));

  const totalSlots = promptCount * active.size || 1;
  const acc = Object.fromEntries(brands.map(b => [b.id, { hits: 0, promSum: 0, top2: 0 }]));
  let allCitations = 0;

  for (const r of used) {
    allCitations += r.cited.length;
    r.cited.forEach((id, i) => {
      const a = acc[id];
      if (!a) return;
      a.hits += 1;
      a.promSum += prominenceOf(i);
      if (i < 2) a.top2 += 1;
    });
  }
  if (!allCitations) allCitations = 1;

  const maxSov = Math.max(...brands.map(b => acc[b.id].hits)) / allCitations || 1;

  const rows = brands.map(b => {
    const a = acc[b.id];
    const frequency = a.hits / totalSlots;
    const prominence = a.hits ? a.promSum / a.hits : 0;
    const shareOfVoice = a.hits / allCitations;
    const topTwo = a.hits ? a.top2 / a.hits : 0;
    const score = 100 * (
      WEIGHTS.frequency * frequency +
      WEIGHTS.prominence * prominence +
      WEIGHTS.shareOfVoice * (shareOfVoice / maxSov) +
      WEIGHTS.topTwo * topTwo
    );
    // Mean rank across citations, back-derived from prominence. '-' when never cited.
    const avgPosition = a.hits ? 1 + (1 - prominence) * 5 : null;
    return { ...b, hits: a.hits, frequency, prominence, shareOfVoice, topTwo, avgPosition, score };
  }).sort((x, y) => y.score - x.score);

  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/** First-mention extraction. Position is character offset, not model ordering. */
export function extractCitations(text, patterns) {
  if (!text) return [];
  const found = [];
  for (const [id, src] of Object.entries(patterns)) {
    const re = new RegExp(src.source ?? src, src.flags ?? 'i');
    const m = re.exec(text);
    if (m) found.push({ id, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at).map(f => f.id);
}
