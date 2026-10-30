// Recommendation types and the scoring algorithms.
// Only relative type imports in here, so `node --experimental-strip-types` can run this file
// directly for scripts/test-recommendations.ts.
import type { MovieInfo, Ratings } from './ratings';

export const RECOMMENDATIONS_KEY = 'recommendations';
// Which algorithm is picked in the dev stats. Saved separately from the votes since the popup writes it.
export const ALGORITHM_KEY = 'recommendationAlgorithm';
// Cards scoring at or above these get a "For you" pill. Each algorithm spreads its scores differently,
// so each gets its own threshold. Picked with a leave-one-out test on 206 real votes so both put
// pills on roughly the top 25-30% of movies.
export const FOR_YOU_THRESHOLDS: Record<Algorithm, number> = { cosine: 0.4, naiveBayes: 0.5 };
// Share of cards picked at random as control cards. They get a "For you" pill no matter their score,
// so the 👍 rate on real recommendations can be compared against random picks shown the same way.
export const RANDOM_CONTROL_RATE = 0.07;

// How much each kind of feature counts. Directors say the most about whether you'll like
// a movie, actors and decade the least.
const FEATURE_WEIGHTS = { genre: 1, director: 1.5, actor: 0.5, decade: 0.5 };
// Small boost per IMDb point above an average movie. Kept small so a well rated movie
// can't get recommended without matching your taste.
const AVERAGE_IMDB_RATING = 6.5;
const QUALITY_BONUS_PER_POINT = 0.02;
// Laplace smoothing for Naive Bayes, so a feature never seen in one class doesn't give a probability of 0
const SMOOTHING = 1;

export type Vote = 1 | -1;

export interface VoteEntry {
  vote: Vote;
  title: string;
  info: MovieInfo;
  // Saved so quality can be tried as a feature later. Votes from before this was added don't have it.
  ratings?: Ratings;
  votedAt: number;
}

/** Everything saved for recommendations. votes is keyed by IMDb id */
export interface RecommendationStore {
  votes: Record<string, VoteEntry>;
}

export type Algorithm = 'cosine' | 'naiveBayes';
export const DEFAULT_ALGORITHM: Algorithm = 'cosine';
export const ALGORITHM_NAMES: Record<Algorithm, string> = {
  cosine: 'Cosine similarity',
  naiveBayes: 'Naive Bayes',
};

/** What put a "For you" pill on a card: one of the algorithms, or the random control */
export type PillSource = Algorithm | 'random';
export const PILL_SOURCE_NAMES: Record<PillSource, string> = {
  ...ALGORITHM_NAMES,
  random: 'Random (control)',
};

/** Feature weights built from the votes, e.g. { "genre:Thriller": 2, "director:David Fincher": 1.5 } */
export type Profile = Record<string, number>;

/** How many liked and disliked movies had each feature */
export interface NaiveBayesCounts {
  likes: number;
  dislikes: number;
  liked: Record<string, number>;
  disliked: Record<string, number>;
}

/** A trained model for whichever algorithm is picked */
export type Model =
  | { algorithm: 'cosine'; profile: Profile }
  | { algorithm: 'naiveBayes'; counts: NaiveBayesCounts };

export interface RateMovieMessage {
  type: 'RATE_MOVIE';
  // vote 0 means the vote was undone. forYouSource is set if the card had a "For you" pill,
  // and says what put it there (for the dev stats).
  payload: { title: string; info: MovieInfo; ratings: Ratings; vote: Vote | 0; forYouSource: PillSource | null };
}

/**
 * Creates an empty store with no votes.
 * @returns the empty store.
 */
export function emptyRecommendationStore(): RecommendationStore {
  return { votes: {} };
}

/**
 * Trains a model from the votes using the given algorithm.
 * @param algorithm
 * @param votes
 * @returns the model to pass to scoreWithModel.
 */
export function trainModel(algorithm: Algorithm, votes: VoteEntry[]): Model {
  if (algorithm === 'naiveBayes') {
    return { algorithm, counts: buildNaiveBayesCounts(votes) };
  }
  return { algorithm: 'cosine', profile: buildCosineProfile(votes) };
}

/**
 * Scores a movie with a trained model. Higher means a better match. 0 is no opinion,
 * positive means you'll probably like it, negative means you probably won't.
 * @param model
 * @param info
 * @param ratings
 * @returns the score, roughly between -1 and 1.
 */
export function scoreWithModel(model: Model, info: MovieInfo, ratings: Ratings): number {
  if (model.algorithm === 'naiveBayes') {
    return scoreNaiveBayes(info, ratings, model.counts);
  }
  return scoreCosine(info, ratings, model.profile);
}

/**
 * Decides whether a card gets a "For you" pill and what put it there. Control cards always get one,
 * picked at random so they can be compared against real recommendations.
 * @param model
 * @param info
 * @param ratings
 * @returns the pill's source, or null if the card shouldn't get a pill.
 */
export function forYouSource(model: Model, info: MovieInfo, ratings: Ratings): PillSource | null {
  if (isControlCard(info.imdbId)) return 'random';
  return scoreWithModel(model, info, ratings) >= FOR_YOU_THRESHOLDS[model.algorithm] ? model.algorithm : null;
}

/**
 * Picks about RANDOM_CONTROL_RATE of movies as control cards. Uses a hash of the IMDb id instead of
 * Math.random() so a movie doesn't flip in and out of the control group every time its badge redraws.
 * @param imdbId
 * @returns true if the movie is a control card.
 */
function isControlCard(imdbId: string): boolean {
  // FNV-1a hash, turned into a number between 0 and 1
  let hash = 2166136261;
  for (let i = 0; i < imdbId.length; i++) {
    hash ^= imdbId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 2 ** 32 < RANDOM_CONTROL_RATE;
}

// Features shared by both algorithms

/**
 * Turns a movie into weighted features like ["genre:Crime", 1] or ["director:David Fincher", 1.5].
 * @param info
 * @returns the movie's features and how much each one counts.
 */
export function movieFeatures(info: MovieInfo): [string, number][] {
  const features: [string, number][] = [];
  for (const genre of info.genres) features.push([`genre:${genre}`, FEATURE_WEIGHTS.genre]);
  for (const director of info.directors) features.push([`director:${director}`, FEATURE_WEIGHTS.director]);
  for (const actor of info.actors) features.push([`actor:${actor}`, FEATURE_WEIGHTS.actor]);
  if (info.year) {
    features.push([`decade:${Math.floor(info.year / 10) * 10}s`, FEATURE_WEIGHTS.decade]);
  }
  return features;
}

/**
 * Gives well rated movies a small boost and badly rated ones a small penalty.
 * @param ratings
 * @returns the bonus, or 0 if the movie has no IMDb rating.
 */
function qualityBonus(ratings: Ratings): number {
  const imdb = parseFloat(ratings.imdbRating);
  return Number.isNaN(imdb) ? 0 : (imdb - AVERAGE_IMDB_RATING) * QUALITY_BONUS_PER_POINT;
}

// Cosine similarity

/**
 * Builds the user's taste profile. Each liked movie adds its feature weights
 * and each disliked movie takes them away.
 * @param votes
 * @returns the feature weights.
 */
export function buildCosineProfile(votes: VoteEntry[]): Profile {
  const profile: Profile = {};
  for (const { vote, info } of votes) {
    for (const [feature, weight] of movieFeatures(info)) {
      profile[feature] = (profile[feature] ?? 0) + vote * weight;
    }
  }
  return profile;
}

/**
 * Scores a movie by the cosine similarity between its features and the profile, plus the quality bonus.
 * Cosine similarity is the dot product divided by both vector lengths, so the score stays between
 * -1 and 1 no matter how many votes there are or how many actors the movie lists.
 * @param info
 * @param ratings
 * @param profile
 * @returns the score.
 */
export function scoreCosine(info: MovieInfo, ratings: Ratings, profile: Profile): number {
  const features = movieFeatures(info);

  let dotProduct = 0;
  let movieLengthSquared = 0;
  for (const [feature, weight] of features) {
    dotProduct += (profile[feature] ?? 0) * weight;
    movieLengthSquared += weight * weight;
  }
  let profileLengthSquared = 0;
  for (const weight of Object.values(profile)) {
    profileLengthSquared += weight * weight;
  }

  // No votes yet, or a movie with no features, means there's nothing to compare
  const lengths = Math.sqrt(movieLengthSquared) * Math.sqrt(profileLengthSquared);
  const similarity = lengths === 0 ? 0 : dotProduct / lengths;
  return similarity + qualityBonus(ratings);
}

// Naive Bayes

/**
 * Counts how many liked and disliked movies had each feature.
 * @param votes
 * @returns the counts used by scoreNaiveBayes.
 */
export function buildNaiveBayesCounts(votes: VoteEntry[]): NaiveBayesCounts {
  const counts: NaiveBayesCounts = { likes: 0, dislikes: 0, liked: {}, disliked: {} };
  for (const { vote, info } of votes) {
    const bucket = vote === 1 ? counts.liked : counts.disliked;
    if (vote === 1) counts.likes++;
    else counts.dislikes++;
    // A Set so a feature listed twice only counts once per movie
    for (const feature of new Set(movieFeatures(info).map(([name]) => name))) {
      bucket[feature] = (bucket[feature] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Scores a movie with Naive Bayes: how likely you are to like it based on how often its features
 * showed up in movies you liked vs disliked. Works in log odds (adding logs instead of multiplying
 * small probabilities), then turns the probability of liking it into a score from -1 to 1.
 * Features that never showed up in any voted movie are skipped since they say nothing about your taste.
 * Each feature's evidence is scaled by its weight so the 3 actors don't outweigh the director.
 * @param info
 * @param ratings
 * @param counts
 * @returns the score.
 */
export function scoreNaiveBayes(info: MovieInfo, ratings: Ratings, counts: NaiveBayesCounts): number {
  const { likes, dislikes, liked, disliked } = counts;

  // Start from the prior: how often you like movies in general
  let logOdds = Math.log((likes + SMOOTHING) / (dislikes + SMOOTHING));

  for (const [feature, weight] of movieFeatures(info)) {
    const likedCount = liked[feature] ?? 0;
    const dislikedCount = disliked[feature] ?? 0;
    if (likedCount === 0 && dislikedCount === 0) continue;

    // Chance a liked (or disliked) movie has this feature, smoothed so it's never 0 or 1
    const pIfLiked = (likedCount + SMOOTHING) / (likes + 2 * SMOOTHING);
    const pIfDisliked = (dislikedCount + SMOOTHING) / (dislikes + 2 * SMOOTHING);
    logOdds += weight * Math.log(pIfLiked / pIfDisliked);
  }

  const probabilityLiked = 1 / (1 + Math.exp(-logOdds));
  return 2 * probabilityLiked - 1 + qualityBonus(ratings);
}
