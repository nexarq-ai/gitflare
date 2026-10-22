export const ROUTE_MODULES_MARKER = 'gitflare-route-modules ';

export const ROUTE_MODULE_SOURCES = {
  app: 'src/ui/App.tsx',
  public: 'src/ui/HostedPublicApp.tsx',
  home: 'src/ui/HostedHomepage.tsx',
  repository: 'src/ui/PublicRepository.tsx',
  profile: 'src/ui/PublicProfile.tsx',
  explore: 'src/ui/Explore.tsx',
  search: 'src/ui/PublicSearch.tsx',
} as const;

export type RouteModuleName = keyof typeof ROUTE_MODULE_SOURCES;
export type RouteModules = Partial<Record<RouteModuleName, { js: string[]; css: string[] }>>;
