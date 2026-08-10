/**
 * photo-day-format.mjs
 * The photo-day shape rules, shared by pick-photo-topic.mjs (which must know a
 * candidate idea's likely shape BEFORE picking it) and photo-day.mjs (which
 * applies it to the chosen topic). One copy, so the picker's diversity floor and
 * the builder's routing can never disagree about what an idea will become.
 *
 * Why the picker needs this at all: the category floor in pick-photo-topic.mjs
 * only excludes the previous CATEGORY, and both 'humor' and 'gear' route to the
 * same enumeration carousel. humor -> gear -> humor passes the category floor
 * cleanly and still ships three visually identical posts (2026-08-08/09/10 did
 * exactly that). Shape has to be a first-class axis of the floor, not a
 * side effect of category.
 */

// Categories whose ideas in cycling-topics-bank.json are enumerations by
// construction ("Sinais de que...", "as 4 estacoes...", "o que priorizar quando
// o orcamento e curto"). Flattening a list onto one card throws away the joke's
// timing - the swipe is the punchline pacing. These get the enumeration cut.
export const LIST_SHAPED_CATEGORIES = ['humor', 'gear'];

// Shape classes used by the diversity floor. Deliberately coarser than the
// format names: the feed reads "another swipe post", not "another list cut", so
// reframe and list collapse into one class.
export const SHAPE_CAROUSEL = 'carousel';
export const SHAPE_SINGLE = 'single';

const SHAPE_BY_FORMAT = {
  list: SHAPE_CAROUSEL,
  carousel: SHAPE_CAROUSEL,
  reframe: SHAPE_CAROUSEL,
  single: SHAPE_SINGLE,
};

/**
 * Picks the post shape from the idea's theme instead of pinning every photo day
 * to one format. Returns { format, why }; a null format means "pass no --format
 * flag and let generate-carousel.mjs's editorial filter decide" (reframe when
 * the idea passes the three tests, single when it doesn't).
 *
 * Why this beats a hardcoded --format single: that override doesn't just choose
 * a shape, it SKIPS the editorial filter entirely, so ideas that are textbook
 * flips ("a estampa nao e decoracao, e declaracao") could never become the
 * reframe carousel that filter exists to build.
 */
export function routeFormat(topic, lastShape = null) {
  if (LIST_SHAPED_CATEGORIES.includes(topic.category)) {
    // Deliberately NOT overridden by the streak guard. Flattening an enumeration
    // onto one card throws away the joke's timing, which is the whole reason the
    // list cut exists. The picker's shape floor is what should have kept us off a
    // list idea today; if it couldn't, the bank had nothing else to offer and a
    // repeated shape beats a ruined post.
    return { format: 'list', why: `${topic.category} ideas are enumerations` };
  }
  if (topic.photo) {
    return { format: 'single', why: 'photo-pinned idea, the jersey is the post' };
  }
  // The streak guard, and the reason the shape floor alone wasn't enough: an
  // unpinned idea left to the editorial filter usually comes back as a reframe
  // carousel, so "undecided" days leaked straight back into carousel runs and
  // the feed still read as one long swipe post. After a carousel, take the
  // single. These ideas carry a single argument, which is exactly what one card
  // is for, and the filter gets the day back as soon as the shapes alternate.
  if (lastShape === SHAPE_CAROUSEL) {
    return { format: 'single', why: 'last post was a carousel, break the streak' };
  }
  return { format: null, why: 'unpinned argument, let the three-test filter choose' };
}

/**
 * The shape an idea will PROBABLY produce, known at pick time. Returns null when
 * routing defers to generate-carousel.mjs's editorial filter - the honest answer
 * is "unknown", and the floor treats unknown as always-eligible rather than
 * guessing. Deferred picks get their real shape written back after the build
 * (see photo-day.mjs), so the ledger converges on the truth.
 */
export function predictedShape(idea, lastShape = null) {
  return shapeOfFormat(routeFormat(idea, lastShape).format);
}

/** Maps a concrete built format (from carousel-meta.json) to its shape class. */
export function shapeOfFormat(format) {
  return SHAPE_BY_FORMAT[format] ?? null;
}
