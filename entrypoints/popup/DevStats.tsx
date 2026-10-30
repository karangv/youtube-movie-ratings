import { useEffect, useState } from 'react';
import { DEV_STATS_KEY, emptyDevStats, normalizeDevStats, type DevStats as Stats } from '@/utils/devStats';
import {
  ALGORITHM_KEY,
  ALGORITHM_NAMES,
  DEFAULT_ALGORITHM,
  PILL_SOURCE_NAMES,
  RECOMMENDATIONS_KEY,
  type Algorithm,
  type PillSource,
  type RecommendationStore,
} from '@/utils/recommendations';

/**
 * Dev stats section in the popup. It's collapsed unless you open it.
 */
function DevStats() {
  const [stats, setStats] = useState<Stats>(emptyDevStats());
  const [algorithm, setAlgorithm] = useState<Algorithm>(DEFAULT_ALGORITHM);

  useEffect(() => {
    browser.storage.local.get(ALGORITHM_KEY).then((result) => {
      setAlgorithm((result[ALGORITHM_KEY] as Algorithm | undefined) ?? DEFAULT_ALGORITHM);
    });

    const load = () =>
      browser.storage.local.get(DEV_STATS_KEY).then((result) => {
        // Fill in fields added after these stats were first saved
        setStats(normalizeDevStats(result[DEV_STATS_KEY] as Partial<Stats> | undefined));
      });
    load();

    // Update the numbers live while the popup is open
    const onChanged = (changes: Record<string, unknown>, areaName: string) => {
      if (areaName === 'local' && DEV_STATS_KEY in changes) load();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  const handleReset = async () => {
    const fresh = emptyDevStats();
    await browser.storage.local.set({ [DEV_STATS_KEY]: fresh });
    setStats(fresh);
  };

  const handleExportVotes = async () => {
    // Saves the votes as a JSON file for scripts/evaluate-recommendations.ts
    const result = await browser.storage.local.get(RECOMMENDATIONS_KEY);
    const store = (result[RECOMMENDATIONS_KEY] as RecommendationStore | undefined) ?? { votes: {} };
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'votes.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleAlgorithmChange = async (value: Algorithm) => {
    // Open YouTube tabs see this change, retrain with the new algorithm and redraw their pills
    setAlgorithm(value);
    await browser.storage.local.set({ [ALGORITHM_KEY]: value });
  };

  const avgCachedMs = average(stats.cachedLookupMsTotal, stats.cacheHits);
  const avgFetchMs = average(stats.fetchLookupMsTotal, stats.fetchLookups);
  const matched = stats.found + stats.notFound;
  const algorithms = Object.keys(ALGORITHM_NAMES) as Algorithm[];
  const sources = Object.keys(PILL_SOURCE_NAMES) as PillSource[];
  const totalUp = stats.otherVotesUp + sources.reduce((sum, name) => sum + stats.forYou[name].votesUp, 0);
  const totalDown = stats.otherVotesDown + sources.reduce((sum, name) => sum + stats.forYou[name].votesDown, 0);

  const rows: [string, string][] = [
    ['Tracking since', new Date(stats.since).toLocaleDateString()],
    ['Rating lookups', String(stats.lookups)],
    ['API call reduction', percent(stats.cacheHits + stats.sharedRequests, stats.lookups)],
    ['  from cache', percent(stats.cacheHits, stats.lookups)],
    ['  from shared requests', percent(stats.sharedRequests, stats.lookups)],
    ['OMDb requests made', String(stats.omdbRequests)],
    ['Avg cached lookup', ms(avgCachedMs)],
    ['Avg uncached lookup', ms(avgFetchMs)],
    ['Cache speedup', avgCachedMs && avgFetchMs ? `${(avgFetchMs / avgCachedMs).toFixed(1)}×` : '—'],
    ['Avg OMDb request', ms(average(stats.omdbRequestMsTotal, stats.omdbRequests))],
    ['Title match rate', percent(stats.found, matched)],
    ['  matched via fallback', percent(stats.foundViaFallback, stats.found)],
    ['All 3 ratings available', percent(stats.foundWithAllRatings, stats.found)],
    ['Errors', String(stats.errors)],
    ['Page batches', String(stats.batches)],
    ['  avg cards / batch', stats.batches ? (stats.batchCardsTotal / stats.batches).toFixed(1) : '—'],
    ['  avg time / batch', ms(average(stats.batchMsTotal, stats.batches))],
    ['  slowest batch', stats.batches ? `${ms(stats.slowestBatchMs)} (${stats.slowestBatchCards} cards)` : '—'],
    ['Votes cast', `${totalUp} 👍 · ${totalDown} 👎`],
    ...sources.flatMap((name): [string, string][] => {
      const { shown, votesUp, votesDown } = stats.forYou[name];
      return [
        [`"For you": ${PILL_SOURCE_NAMES[name]}`, `${shown} shown`],
        [`  👍 rate (${PILL_SOURCE_NAMES[name]})`, voteRate(votesUp, votesDown)],
      ];
    }),
    ['👍 rate on other cards', voteRate(stats.otherVotesUp, stats.otherVotesDown)],
  ];

  return (
    <details className="dev-stats">
      <summary>Developer stats</summary>
      <label className="algorithm">
        Recommendation algorithm
        <select value={algorithm} onChange={(e) => handleAlgorithmChange(e.target.value as Algorithm)}>
          {algorithms.map((name) => (
            <option key={name} value={name}>
              {ALGORITHM_NAMES[name]}
            </option>
          ))}
        </select>
      </label>
      <table>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th className={label.startsWith('  ') ? 'sub' : undefined}>{label.trim()}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button onClick={handleReset}>Reset stats</button>
        <button onClick={handleExportVotes}>Export votes</button>
      </div>
    </details>
  );
}

/**
 * Works out an average without dividing by zero.
 * @param total
 * @param count
 * @returns the average, or null if count is 0.
 */
function average(total: number, count: number): number | null {
  return count > 0 ? total / count : null;
}

/**
 * Formats part / whole as a percentage.
 * @param part
 * @param whole
 * @returns something like "70.6%", or "—" if there's no data yet.
 */
function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';
}

/**
 * Formats a 👍 rate along with how many votes it's based on and its likely range.
 * @param up
 * @param down
 * @returns something like "76.7% of 103 (68–84%)", or "—" if there are no votes yet.
 */
function voteRate(up: number, down: number): string {
  const total = up + down;
  if (total === 0) return '—';
  const [low, high] = wilsonInterval(up, total);
  return `${percent(up, total)} of ${total} (${Math.round(low * 100)}–${Math.round(high * 100)}%)`;
}

/**
 * Works out the range the true rate is probably in (95% confidence), using the Wilson score interval.
 * It behaves better than the simple ± formula when there are few votes or the rate is near 0% or 100%.
 * @param successes
 * @param total
 * @returns the low and high ends of the range, between 0 and 1.
 */
function wilsonInterval(successes: number, total: number): [number, number] {
  const z = 1.96; // 95% confidence
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * Formats a time in milliseconds, switching to seconds once it goes over 1000 ms.
 * @param value
 * @returns something like "58.6 ms" or "1.20 s", or "—" if there's no data yet.
 */
function ms(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

export default DevStats;
