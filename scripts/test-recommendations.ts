// Tests for the recommendation algorithms in utils/recommendations.ts. Every check runs against each algorithm.
// Run with: npm run test:recs
import {
  ALGORITHM_NAMES,
  FOR_YOU_THRESHOLDS,
  RANDOM_CONTROL_RATE,
  forYouSource,
  scoreWithModel,
  trainModel,
  type Algorithm,
  type Model,
  type Vote,
  type VoteEntry,
} from '../utils/recommendations.ts';
import type { MovieInfo, Ratings } from '../utils/ratings.ts';

// Sample movies, shaped like what getMovieInfo() builds from OMDb
const movie = (imdbId: string, genres: string[], directors: string[], actors: string[], year: number): MovieInfo => ({
  imdbId, genres, directors, actors, year,
});

const se7en = movie('tt0114369', ['Crime', 'Drama', 'Mystery'], ['David Fincher'], ['Morgan Freeman', 'Brad Pitt', 'Kevin Spacey'], 1995);
const zodiac = movie('tt0443706', ['Crime', 'Drama', 'Mystery'], ['David Fincher'], ['Jake Gyllenhaal', 'Robert Downey Jr.', 'Mark Ruffalo'], 2007);
const prisoners = movie('tt1392214', ['Crime', 'Drama', 'Mystery'], ['Denis Villeneuve'], ['Hugh Jackman', 'Jake Gyllenhaal', 'Viola Davis'], 2013);
const stepBrothers = movie('tt0838283', ['Comedy'], ['Adam McKay'], ['Will Ferrell', 'John C. Reilly', 'Mary Steenburgen'], 2008);
const anchorman = movie('tt0357413', ['Comedy'], ['Adam McKay'], ['Will Ferrell', 'Christina Applegate', 'Steve Carell'], 2004);

const goneGirl = movie('tt2267998', ['Drama', 'Mystery', 'Thriller'], ['David Fincher'], ['Ben Affleck', 'Rosamund Pike', 'Neil Patrick Harris'], 2014);
const talladegaNights = movie('tt0415306', ['Comedy', 'Sport'], ['Adam McKay'], ['Will Ferrell', 'John C. Reilly', 'Sacha Baron Cohen'], 2006);
const paddington = movie('tt1109624', ['Adventure', 'Comedy', 'Family'], ['Paul King'], ['Ben Whishaw', 'Hugh Bonneville', 'Sally Hawkins'], 2014);
const spiritedAway = movie('tt0245429', ['Animation', 'Adventure', 'Family'], ['Hayao Miyazaki'], ['Daveigh Chase', 'Suzanne Pleshette', 'Miyu Irino'], 2001);
const loveAndOtherDrugs = movie('tt0758752', ['Comedy', 'Drama', 'Romance'], ['Edward Zwick'], ['Jake Gyllenhaal', 'Anne Hathaway', 'Oliver Platt'], 2010);
const missingData: MovieInfo = { imdbId: 'tt0000001', genres: [], directors: [], actors: [] };

const imdb = (rating: string): Ratings => ({ imdbRating: rating, rtRating: 'N/A', metacriticRating: 'N/A' });
const vote = (info: MovieInfo, value: Vote): VoteEntry => ({ vote: value, title: info.imdbId, info, votedAt: 0 });

// Liked the crime mysteries, disliked the Will Ferrell comedies
const votes = [
  vote(se7en, 1),
  vote(zodiac, 1),
  vote(prisoners, 1),
  vote(stepBrothers, -1),
  vote(anchorman, -1),
];

let failures = 0;
function check(description: string, passed: boolean, details: string): void {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${description}${passed ? '' : `\n      ${details}`}`);
  if (!passed) failures++;
}

/**
 * Runs every check against one algorithm.
 * @param algorithm
 */
function testAlgorithm(algorithm: Algorithm): void {
  console.log(`\n${ALGORITHM_NAMES[algorithm]}`);
  const model = trainModel(algorithm, votes);
  const emptyModel = trainModel(algorithm, []);
  const threshold = FOR_YOU_THRESHOLDS[algorithm];
  const score = (info: MovieInfo, ratings = imdb('7.5'), withModel: Model = model) => scoreWithModel(withModel, info, ratings);

  const goneGirlScore = score(goneGirl);
  const talladegaScore = score(talladegaNights);
  const paddingtonScore = score(paddington);

  check(
    'With no votes, nothing gets recommended',
    score(goneGirl, imdb('8.1'), emptyModel) < threshold && score(spiritedAway, imdb('8.6'), emptyModel) < threshold,
    `Gone Girl: ${score(goneGirl, imdb('8.1'), emptyModel)}, Spirited Away: ${score(spiritedAway, imdb('8.6'), emptyModel)} (threshold ${threshold})`,
  );
  check(
    'A Fincher mystery gets recommended',
    goneGirlScore >= threshold,
    `Gone Girl scored ${goneGirlScore}, needs at least ${threshold}`,
  );
  check(
    'A Will Ferrell / Adam McKay comedy scores negative',
    talladegaScore < 0,
    `Talladega Nights scored ${talladegaScore}`,
  );
  check(
    'Ranks the mystery above the family comedy above the Will Ferrell comedy',
    goneGirlScore > paddingtonScore && paddingtonScore > talladegaScore,
    `Gone Girl ${goneGirlScore}, Paddington ${paddingtonScore}, Talladega Nights ${talladegaScore}`,
  );
  check(
    "An unrelated movie isn't recommended just for having a high rating",
    score(spiritedAway, imdb('8.6')) < threshold,
    `Spirited Away scored ${score(spiritedAway, imdb('8.6'))}`,
  );
  check(
    'Better rated movies get a small boost',
    score(goneGirl, imdb('8.1')) > score(goneGirl, imdb('5.0')),
    `Gone Girl at 8.1: ${score(goneGirl, imdb('8.1'))}, at 5.0: ${score(goneGirl, imdb('5.0'))}`,
  );
  check(
    'Sharing one actor counts for less than sharing the director and genres',
    score(loveAndOtherDrugs) < goneGirlScore,
    `Love & Other Drugs ${score(loveAndOtherDrugs)}, Gone Girl ${goneGirlScore}`,
  );
  check(
    "Doesn't break on missing data (no genres/actors, N/A ratings)",
    Number.isFinite(score(missingData, imdb('N/A'))) && Number.isFinite(score(missingData, imdb('N/A'), emptyModel)),
    `Got ${score(missingData, imdb('N/A'))} and ${score(missingData, imdb('N/A'), emptyModel)}`,
  );

  // Not pass/fail, just handy for seeing how the scores compare
  const sample: [string, MovieInfo][] = [
    ['Gone Girl', goneGirl],
    ['Love & Other Drugs', loveAndOtherDrugs],
    ['Spirited Away', spiritedAway],
    ['Paddington', paddington],
    ['Talladega Nights', talladegaNights],
  ];
  console.log('  Scores: ' + sample.map(([name, info]) => `${name} ${score(info).toFixed(2)}`).join(', '));
}

for (const algorithm of Object.keys(ALGORITHM_NAMES) as Algorithm[]) {
  testAlgorithm(algorithm);
}

console.log('\nRandom control cards');
const cosineModel = trainModel('cosine', votes);
const ids = Array.from({ length: 10000 }, (_, i) => `tt${String(i).padStart(7, '0')}`);
const isControl = (imdbId: string) => forYouSource(cosineModel, { ...missingData, imdbId }, imdb('N/A')) === 'random';
const controlShare = ids.filter(isControl).length / ids.length;
check(
  `About ${Math.round(RANDOM_CONTROL_RATE * 100)}% of movies are control cards`,
  Math.abs(controlShare - RANDOM_CONTROL_RATE) < 0.01,
  `Got ${(controlShare * 100).toFixed(1)}% of ${ids.length} movies`,
);
check(
  'A movie is always or never a control card, so its pill never flickers',
  ids.slice(0, 1000).every((id) => isControl(id) === isControl(id)),
  'The same IMDb id gave different answers',
);

console.log(`\n${failures === 0 ? 'All tests passed' : `${failures} test(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
