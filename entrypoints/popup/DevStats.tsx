import { useEffect, useState } from 'react';
import { DEV_STATS_KEY, emptyDevStats, type DevStats as Stats } from '@/utils/devStats';

/**
 * Dev stats section in the popup. It's collapsed unless you open it.
 */
function DevStats() {
  const [stats, setStats] = useState<Stats>(emptyDevStats());

  useEffect(() => {
    const load = () =>
      browser.storage.local.get(DEV_STATS_KEY).then((result) => {
        setStats((result[DEV_STATS_KEY] as Stats | undefined) ?? emptyDevStats());
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

  const avgCachedMs = average(stats.cachedLookupMsTotal, stats.cacheHits);
  const avgFetchMs = average(stats.fetchLookupMsTotal, stats.fetchLookups);
  const matched = stats.found + stats.notFound;

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
  ];

  return (
    <details className="dev-stats">
      <summary>Developer stats</summary>
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
      <button onClick={handleReset}>Reset stats</button>
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
 * Formats a time in milliseconds, switching to seconds once it goes over 1000 ms.
 * @param value
 * @returns something like "58.6 ms" or "1.20 s", or "—" if there's no data yet.
 */
function ms(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

export default DevStats;
