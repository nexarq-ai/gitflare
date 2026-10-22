import type { ExploreFilters, ExploreSort } from './types';

export const EXPLORE_SORTS: readonly ExploreSort[] = ['stars', 'trending', 'landed', 'updated', 'new', 'name'];
export const DEFAULT_EXPLORE_SORT: ExploreSort = 'stars';
export const EMPTY_EXPLORE_FILTERS: ExploreFilters = { language: null, license: null, topic: null, releases: false, agentReady: false, query: null };

export interface ExploreState extends ExploreFilters { sort: ExploreSort }

export function exploreParams(state: ExploreState, options: { cursor?: number; omitDefaultSort?: boolean } = {}): URLSearchParams {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (!options.omitDefaultSort || state.sort !== DEFAULT_EXPLORE_SORT) params.set('sort', state.sort);
  if (state.language) params.set('language', state.language);
  if (state.license) params.set('license', state.license);
  if (state.topic) params.set('topic', state.topic);
  if (state.releases) params.set('releases', '1');
  if (state.agentReady) params.set('agent', 'ready');
  if (options.cursor) params.set('cursor', String(options.cursor));
  return params;
}

export function exploreStateFrom(params: URLSearchParams): ExploreState {
  const sort = params.get('sort') as ExploreSort | null;
  const text = (name: string) => params.get(name)?.trim() || null;
  return {
    sort: sort && EXPLORE_SORTS.includes(sort) ? sort : DEFAULT_EXPLORE_SORT,
    query: text('q'), language: text('language'), license: text('license'), topic: text('topic'),
    releases: params.get('releases') === '1', agentReady: params.get('agent') === 'ready',
  };
}
