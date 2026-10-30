// Offline evaluation of the recommendation algorithms on real votes, using leave-one-out cross-validation.
// For each vote: train on every other vote, score the held-out movie, and check it against the real vote.
//
// 1. In the popup, open Developer stats and click "Export votes" to save votes.json
// 2. Move it into the project folder (it's gitignored since it's personal data)
// 3. Run: npm run eval:recs votes.json
import fs from 'node:fs';
import {
  ALGORITHM_NAMES,
  FOR_YOU_THRESHOLDS,
  scoreWithModel,
  trainModel,
  type Algorithm,
  type RecommendationStore,
  type VoteEntry,
} from '../utils/recommendations.ts';
import type { Ratings } from '../utils/ratings.ts';

const THRESHOLDS_TO_TRY = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
// Votes from before ratings were saved with each vote don't have them, so they get no quality bonus
const NO_RATINGS: Ratings = { imdbRating: 'N/A', rtRating: 'N/A', metacriticRating: 'N/A' };

type Result = { score: number; liked: boolean };

/**
 * Reads the votes exported from the popup.
 * @param path
 * @returns the votes, or exits with a message if the file is missing or wrong.
 */
function loadVotes(path: string): VoteEntry[] {
  if (!fs.existsSync(path)) {
    console.error(`Couldn't find ${path}. Export it from the popup's Developer stats first.`);
    process.exit(1);
  }
  const store = JSON.parse(fs.readFileSync(path, 'utf8')) as RecommendationStore;
  return Object.values(store.votes ?? {});
}

/**
 * Scores every vote with a model trained on all the other votes.
 * @param algorithm
 * @param votes
 * @returns each held-out movie's score and whether it was actually liked.
 */
function leaveOneOut(algorithm: Algorithm, votes: VoteEntry[]): Result[] {
  return votes.map((held, i) => {
    const model = trainModel(algorithm, votes.filter((_, j) => j !== i));
    return { score: scoreWithModel(model, held.info, held.ratings ?? NO_RATINGS), liked: held.vote === 1 };
  });
}

/**
 * Works out the AUC: the chance a random liked movie scores higher than a random disliked one.
 * 0.5 means no better than guessing, 1 means it always ranks liked movies above disliked ones.
 * @param results
 * @returns the AUC, or NaN if there aren't both likes and dislikes.
 */
function auc(results: Result[]): number {
  const liked = results.filter((r) => r.liked).map((r) => r.score);
  const disliked = results.filter((r) => !r.liked).map((r) => r.score);
  let wins = 0;
  for (const a of liked) {
    for (const b of disliked) {
      wins += a > b ? 1 : a === b ? 0.5 : 0;
    }
  }
  return wins / (liked.length * disliked.length);
}

/**
 * Gets the score at a given percentile, e.g. 0.5 for the median.
 * @param results
 * @param fraction
 * @returns the score, rounded to 2 decimals.
 */
function percentile(results: Result[], fraction: number): string {
  const sorted = results.map((r) => r.score).sort((a, b) => a - b);
  return sorted[Math.floor(fraction * (sorted.length - 1))].toFixed(2);
}

const votes = loadVotes(process.argv[2] ?? 'votes.json');
const likes = votes.filter((v) => v.vote === 1).length;
const withRatings = votes.filter((v) => v.ratings).length;
console.log(`${votes.length} votes (${likes} 👍, ${votes.length - likes} 👎), ${withRatings} with saved ratings`);
console.log(`Base 👍 rate: ${((likes / votes.length) * 100).toFixed(1)}% (what a random pick would get)`);

if (likes === 0 || likes === votes.length) {
  console.error('Need both 👍 and 👎 votes to evaluate.');
  process.exit(1);
}

for (const algorithm of Object.keys(ALGORITHM_NAMES) as Algorithm[]) {
  const results = leaveOneOut(algorithm, votes);
  const current = FOR_YOU_THRESHOLDS[algorithm];

  console.log(`\n${ALGORITHM_NAMES[algorithm]}`);
  console.log(`  AUC ${auc(results).toFixed(3)} (0.5 = guessing)`);
  console.log(`  Score percentiles 25 / 50 / 75 / 90: ${[0.25, 0.5, 0.75, 0.9].map((f) => percentile(results, f)).join(' / ')}`);
  console.log('  Threshold   Cards pilled   👍 rate on pilled cards');
  for (const threshold of [...new Set([...THRESHOLDS_TO_TRY, current])].sort((a, b) => a - b)) {
    const pilled = results.filter((r) => r.score >= threshold);
    const rate = pilled.length ? `${((pilled.filter((r) => r.liked).length / pilled.length) * 100).toFixed(1)}%` : '—';
    const marker = threshold === current ? '  <- current' : '';
    console.log(
      `  ${threshold.toFixed(2).padStart(9)}   ${`${Math.round((pilled.length / results.length) * 100)}%`.padStart(12)}   ${rate.padStart(6)} of ${pilled.length}${marker}`,
    );
  }
}
