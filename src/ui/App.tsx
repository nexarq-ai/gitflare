import { repositoryLabel } from "../shared/repository-names";
import cloudflareIcon from "./assets/cloudflare-icon.svg";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import { Input } from "@cloudflare/kumo/components/input";
import { Tabs } from "@cloudflare/kumo/components/tabs";
import {
  ActivityIcon,
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CloudIcon,
  CopyIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  GitCommitIcon,
  HouseIcon,
  InfoIcon,
  ListIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  ShieldCheckIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { AccessSnapshot, Repository, Workspace } from "../shared/types";
import { request, RequestError, rememberedWorkspace, rememberWorkspace, selectedWorkspace, selectWorkspace } from "./api";
import { confirmSession, INITIAL_LOAD_ATTEMPTS, retryDelay, SESSION_CHECK_EVENT, transientFailure } from "./session-health";
import {
  BranchIllustration,
  EmptyState,
  ErrorNotice,
  MissionTable,
  SetupSteps,
  Status,
} from "./components";
import QuickSearch from "./QuickSearch";
import InvitationScreen from "./InvitationScreen";
import AuthScreen, { AccountScreen, isAccountRoute, type AuthConfig } from "./AuthScreen";
import OwnerTokenNotice from "./OwnerTokenNotice";
import NotFoundScreen, { NotFound } from "./NotFound";
import DemoBanner from "./DemoBanner";
import { DemoReplayCard } from "./DemoReplay";
import DemoFeaturePanel from "./DemoFeaturePanel";
import { showOwnerTokenNotice } from "./owner-token-notice";
import WorkspaceLoader, { RouteProgress } from "./WorkspaceLoader";
import RepositoryImport, { RepositoryImportOnboarding, quoteGitArgument } from "./RepositoryImport";
import { canonicalizeLegacyHash, currentRoute, navigate as goTo, onRouteChange, isKnownAppRoute, isPublicDocumentationRoute, publicSourceLocation, POLICY_ROUTES, isPublicProductRoute, SIGNED_IN_PRODUCT_ROUTES, keepsRouteAcrossWorkspaces } from "./router";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { RepositorySettingsLayout, WorkspaceSettingsLayout } from "./SettingsLayout";
import { workspaceChord } from "./workspace-chord";
import { accountSection } from "./account-data";
import { eligibleApprovers, knownCheckNames } from "./approvals";
import { crossHostTarget, pageHostOrigins } from "./hosts";
import AccountMenu from "./AccountMenu";

import ConnectionError from "./ConnectionError";
import "./policy-pages.css";
import { CloudflareConnectPrompt } from "./CloudflareConnectPrompt";
import { BrandMark } from "./BrandMark";

const AccountSettings = lazy(() => import("./AccountSettings"));
const GeneralSettings = lazy(() => import("./GeneralSettings"));
const loadMissionDetail = () => import("./MissionDetail");
const MissionDetail = lazy(loadMissionDetail);
const loadRepositoryBrowser = () => import("./RepositoryBrowser");
const RepositoryBrowser = lazy(loadRepositoryBrowser);
const loadDocumentation = () => import("./Documentation");
const Documentation = lazy(loadDocumentation);
const loadRepositorySkills = () => import("./RepositorySkills");
const RepositorySkills = lazy(loadRepositorySkills);
const loadCloudflareConnection = () => import("./CloudflareConnection");
const CloudflareConnection = lazy(loadCloudflareConnection);
const Deployments = lazy(() => import("./Deployments"));
const loadMcpConnections = () => import("./McpConnections");
const McpConnections = lazy(loadMcpConnections);
const loadHomepage = () => import("./SelfHostedHome");
const Homepage = lazy(loadHomepage);
const loadPeopleSettings = () => import("./PeopleSettings");
const PeopleSettings = lazy(loadPeopleSettings);
const AuditLog = lazy(() => import("./AuditLog"));
const RepositoryAccess = lazy(() => import("./RepositoryAccess"));
const InstallationAdmin = lazy(() => import("./InstallationAdmin"));
const CloudflareAccounts = lazy(() => import("./CloudflareAccounts"));
const loadRepositoryWork = () => import("./RepositoryWork");
const RepositoryWork = lazy(loadRepositoryWork);
const loadProposalCreate = () => import("./ProposalCreate");
const ProposalCreate = lazy(loadProposalCreate);
const loadModelConnections = () => import("./ModelConnections");
const ModelConnections = lazy(loadModelConnections);
const loadIssues = () => import("./Issues");
const Issues = lazy(loadIssues);
const loadReleases = () => import("./Releases");
const Releases = lazy(loadReleases);
const loadPullRequests = () => import("./PullRequests");
const PullRequests = lazy(loadPullRequests);
const loadPullRequestCreate = () => import("./PullRequestCreate");
const PullRequestCreate = lazy(loadPullRequestCreate);
const loadBranchProtection = () => import("./BranchProtection");
const BranchProtection = lazy(loadBranchProtection);
const PreviewSettings = lazy(() => import("./PreviewSettings"));
const GitHubMirror = lazy(() => import("./GitHubMirror"));
const loadSecretSettings = () => import("./SecretSettings");
const SecretSettings = lazy(loadSecretSettings);
const loadGitAccess = () => import("./GitAccess");
const GitAccess = lazy(loadGitAccess);
const workspacePages = [loadMissionDetail, loadRepositoryBrowser, loadDocumentation, loadRepositorySkills, loadCloudflareConnection, loadMcpConnections, loadPeopleSettings, loadRepositoryWork, loadProposalCreate, loadModelConnections, loadIssues, loadReleases, loadPullRequests, loadPullRequestCreate, loadBranchProtection, loadSecretSettings, loadGitAccess];
// Start the homepage chunk alongside the main bundle instead of after it
if (currentRoute() === "home") void loadHomepage();

type Modal = "repository" | "connect" | "learn" | "session" | null;
const blankWorkspace: Workspace = {
  name: "Your workspace",
  mode: "local",
  repositories: [],
  missions: [],
  integrations: [],
};
const runningStates = ["queued", "running", "checking", "integrating"];

const RETURN_ROUTE_KEY = "gitflare:return-route";

export function isPublicRoute(route: string): boolean {
  return !!publicSourceLocation(route) || ["home", "signin", "signup", "source/gitflare", "deploy", ...POLICY_ROUTES].includes(route) || isPublicProductRoute(route) || isPublicDocumentationRoute(route) || !isKnownAppRoute(route) || route.startsWith("invite?") || isAccountRoute(route);
}

function takeReturnRoute(): string {
  try {
    const stored = sessionStorage.getItem(RETURN_ROUTE_KEY);
    sessionStorage.removeItem(RETURN_ROUTE_KEY);
    if (stored && !isPublicRoute(stored)) return stored;
  } catch {}
  return "overview";
}

export default function App() {
  return (
    <Suspense fallback={<WorkspaceLoader publicPage={currentRoute() === "home"} />}>
      <Workspace />
    </Suspense>
  );
}

function ReconnectingNotice() {
  return <div className="reconnecting-notice" role="status" aria-live="polite"><span aria-hidden="true" />Reconnecting to Gitflare…</div>;
}

function Workspace() {
  const [workspace, setWorkspace] = useState<Workspace>(blankWorkspace);
  const [authConfigError, setAuthConfigError] = useState("");
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);
  const authFlowActive = useRef(false);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [account, setAccount] = useState<AccessSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [authState, setAuthState] = useState<
    "checking" | "required" | "configuration" | "unavailable" | "authenticated"
  >("checking");
  const [signingOut, setSigningOut] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const failedLoads = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [route, setRoute] = useState(
    () => { canonicalizeLegacyHash(); return currentRoute(); },
  );
  const [routePending, startRouteTransition] = useTransition();
  const [modal, setModal] = useState<Modal>(null);
  const [sidebar, setSidebar] = useState(false);
  const [quickSearchOpen, setQuickSearchOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [installationAdmin, setInstallationAdmin] = useState(false);
  const located = useRef(new Set<string>());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [toast, setToast] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadGeneration = useRef(0);
  const hasWorkspace = useRef(false);
  const workspaceActive = useRef(false);
  const reschedulePoll = useRef(() => {});

  const clearSession = useCallback(() => {
    loadGeneration.current += 1;
    failedLoads.current = 0;
    clearTimeout(retryTimer.current);
    setReconnecting(false);
    hasWorkspace.current = false;
    selectWorkspace("");
    setPermissions([]);
    setCurrentUserId("");
    setAccount(null);
    setWorkspace(blankWorkspace);
    setLoaded(false);
    setAuthState("required");
    setError("");
    setModal(null);
    setQuickSearchOpen(false);
    setSidebar(false);
    setToast("");
  }, []);

  const inFlight = useRef(0);
  const load = useCallback(async (background: unknown = false): Promise<void> => {
    if (background === true && inFlight.current > 0) return;
    let restore = false;
    const generation = background === true ? loadGeneration.current : ++loadGeneration.current;
    inFlight.current += 1;
    try {
      const [data, access] = await Promise.all([request<Workspace>("/api/workspace"), request<AccessSnapshot>("/api/access")]);
      if (generation !== loadGeneration.current) return;
      const remembered = selectedWorkspace() ? null : rememberedWorkspace(access.user.id);
      if (remembered && remembered !== access.workspace?.id && access.workspaces.some(item => item.id === remembered)) {
        selectWorkspace(remembered);
        restore = true;
        return;
      }
      hasWorkspace.current = true;
      setWorkspace(data);
      setPermissions(access.permissions);
      setCurrentUserId(access.user.id);
      setAccount(access);
      setLoaded(true);
      setError("");
      failedLoads.current = 0;
      clearTimeout(retryTimer.current);
      setReconnecting(false);
      setAuthState("authenticated");
      if (["signin", "signup"].includes(currentRoute())) { const next = takeReturnRoute(); goTo(next, true); setRoute(next); }
    } catch (failure) {
      if (generation !== loadGeneration.current) return;
      const message =
        failure instanceof Error
          ? failure.message
          : "The workspace could not be loaded.";
      const signedOut = failure instanceof RequestError && failure.status === 401 && await confirmSession() === "signed-out";
      if (generation !== loadGeneration.current) return;
      if (signedOut) {
        clearSession();
      } else if (transientFailure(failure) && (hasWorkspace.current || failedLoads.current + 1 < INITIAL_LOAD_ATTEMPTS)) {
        const attempt = failedLoads.current++;
        setReconnecting(true);
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => void load(true), retryDelay(attempt));
      } else if (
        failure instanceof RequestError &&
        failure.code === "AUTH_NOT_CONFIGURED"
      ) {
        clearSession();
        setError(message);
        setAuthState("configuration");
      } else {
        setError(message);
        setReconnecting(false);
        if (!hasWorkspace.current) setAuthState("unavailable");
      }
    } finally {
      inFlight.current -= 1;
      if (restore) void load();
    }
  }, [clearSession]);

  useEffect(() => {
    if (authState !== "required" || isPublicRoute(route)) return;
    try { sessionStorage.setItem(RETURN_ROUTE_KEY, route); } catch {}
    goTo("signin", true);
  }, [authState, route]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const prefetch = () => { for (const load of workspacePages) void load().catch(() => {}); };
    const idle = (window as { requestIdleCallback?: (callback: () => void) => number }).requestIdleCallback;
    if (idle) idle(prefetch); else setTimeout(prefetch, 1500);
  }, [authState]);

  useEffect(() => {
    let active = true;
    const check = () => {
      void confirmSession().then((status) => {
        if (!active) return;
        if (status === "signed-out") clearSession();
        else if (status === "unreachable") { setReconnecting(true); void load(true); }
      });
    };
    window.addEventListener(SESSION_CHECK_EVENT, check);
    return () => {
      active = false;
      window.removeEventListener(SESSION_CHECK_EVENT, check);
    };
  }, [clearSession, load]);

  useEffect(() => () => clearTimeout(retryTimer.current), []);

  useEffect(() => {
    void request<AuthConfig>("/api/auth/config").then(setAuthConfig).catch((failure: unknown) => { setAuthConfigError(failure instanceof Error ? failure.message : "Installation configuration is unavailable."); setAuthState("unavailable"); });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === "visible") timer = setTimeout(poll, workspaceActive.current ? 8000 : 60000);
    };
    const poll = () => { if (!authFlowActive.current) void load(true).finally(schedule); else schedule(); };
    const resume = () => { if (document.visibilityState === "visible") poll(); else clearTimeout(timer); };
    reschedulePoll.current = schedule;
    void load(true).finally(schedule);
    document.addEventListener("visibilitychange", resume);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, [load]);

  const hasActiveMissions = workspace.missions.some((mission) => ["queued", "running", "checking", "integrating"].includes(mission.status));
  workspaceActive.current = hasActiveMissions;
  useEffect(() => { if (hasActiveMissions) reschedulePoll.current(); }, [hasActiveMissions]);

  useEffect(() => {
    return onRouteChange(() => {
      const next = currentRoute();
      setSidebar(false);
      startRouteTransition(() => {
        setRoute(next);
        setSearch("");
        setFilter("all");
      });
    });
  }, []);

  useEffect(() => {
    const { origin, pathname, search, hash } = window.location;
    const target = crossHostTarget(pageHostOrigins(), origin, route, `${pathname}${search}${hash}`, authState === "checking" ? null : authState === "authenticated");
    if (target) window.location.replace(target);
  }, [authState, route]);

  useEffect(() => {
    if (authState === "authenticated" && ["signin", "signup"].includes(route)) {
      const next = takeReturnRoute();
      goTo(next, true);
      setRoute(next);
    }
  }, [authState, route]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!sidebar) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebar(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [sidebar]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k" &&
        loaded &&
        !modal
      ) {
        event.preventDefault();
        setQuickSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [loaded, modal]);

  useEffect(() => {
    if (!loaded) return;
    return workspaceChord(() => {
      if (modal || quickSearchOpen) return;
      if (window.matchMedia("(max-width: 760px)").matches) setSidebar(true);
      setSwitcherOpen(true);
    });
  }, [loaded, modal, quickSearchOpen]);

  const adminCheck = account?.role === "Owner" ? account.workspace?.id ?? "" : "";
  useEffect(() => {
    if (!adminCheck) { setInstallationAdmin(false); return; }
    let active = true;
    void import("./InstallationAdmin").then(module => module.loadAdminStatus()).then(status => { if (active) setInstallationAdmin(!!status); }, () => {});
    return () => { active = false; };
  }, [adminCheck]);

  useEffect(() => {
    if (authState === "authenticated" && route === "connect") { goTo("account/clients", true); setRoute("account/clients"); }
  }, [authState, route]);

  const missingRepository = loaded && route.startsWith("repository/") && !workspace.repositories.some(repo => repo.id === route.split("/")[1]) ? route.split("/")[1] : "";
  useEffect(() => {
    if (!missingRepository || located.current.has(missingRepository)) return;
    located.current.add(missingRepository);
    void request<{ workspaces: { id: string }[] }>(`/api/workspaces/locate?repository=${encodeURIComponent(missingRepository)}`)
      .then(result => { const target = result.workspaces.find(item => item.id !== account?.workspace?.id)?.id; if (target) void switchWorkspace(target, false); })
      .catch(() => {});
  }, [missingRepository]);

  async function switchWorkspace(id: string, resetRoute = true) {
    const target = account?.workspaces.find(item => item.id === id);
    try { await request("/api/workspaces/switch", { workspaceId: id }); }
    catch (failure) {
      notify(failure instanceof RequestError && [403, 404].includes(failure.status) ? "You no longer belong to that workspace." : failure instanceof Error ? failure.message : "The workspace could not be opened.");
      await load();
      return;
    }
    selectWorkspace(id);
    if (currentUserId) rememberWorkspace(currentUserId, id);
    setSwitcherOpen(false);
    if (resetRoute && !keepsRouteAcrossWorkspaces(route)) navigate("overview");
    await load();
    notify(`Switched to ${target?.name ?? "the workspace"}.`);
  }

  function notify(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 5000);
  }

  function navigate(target: string) {
    goTo(target);
    startRouteTransition(() => setRoute(target));
    setSidebar(false);
  }

  const aiEnabled = workspace.ai?.enabled !== false;
  useEffect(() => { document.documentElement.classList.toggle("ai-off", !aiEnabled); }, [aiEnabled]);

  function createMission(repositoryId?: string) {
    if (!aiEnabled) { notify("AI features are turned off for this workspace. An Owner can turn them on in Settings."); return; }
    if (!permissions.includes("contribute")) { notify("Your role cannot create missions."); return; }
    navigate(repositoryId ? `repository/${repositoryId}/proposals/new` : "proposals/new");
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await request("/api/session/logout", {});
      clearSession();
      goTo("signin");
      setRoute("signin");
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Sign-out could not be completed. Try again.",
      );
    } finally {
      setSigningOut(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (!isKnownAppRoute(route) && authState === "checking") return <WorkspaceLoader />;
  if (!isKnownAppRoute(route) && authState !== "authenticated") return <NotFoundScreen />;
  if (isPublicDocumentationRoute(route)) return <main className="public-documentation"><Documentation publicMode id={route === "docs" ? "overview" : route.slice(5)} /></main>;
  if (route === "home" && (!authConfig || (authConfig.edition === "hosted" && !authConfig.setupRequired))) return <Homepage authenticated={authState === "authenticated"} />;
  if (!authConfig && !authConfigError) return <WorkspaceLoader />;
  if (!authConfig) return <ConnectionError error={authConfigError} onRetry={() => window.location.reload()} />;
  if (isAccountRoute(route) && !authConfig.setupRequired) return <AccountScreen key={route} route={route} config={authConfig} authenticated={authState === "authenticated"} onChanged={load}/>;
  if (route.startsWith("invite?")) return <InvitationScreen route={route} config={authConfig} state={authState} error={error} onRetry={load} onSignedIn={load} onFlowChange={(active) => {authFlowActive.current=active;}}/>;

  if (authState !== "authenticated" || authConfig.setupRequired) {
    return (
      <>
      {reconnecting && authState === "checking" && <ReconnectingNotice />}
      <AuthScreen
        key={route === "signup" ? "signup" : "signin"}
        mode={route === "signup" ? "signup" : "signin"}
        config={authConfig}
        onFlowChange={(active) => { authFlowActive.current = active; }}
        state={authState === "authenticated" ? "required" : authState}
        error={error}
        onRetry={load}
        onSignedIn={async () => { setAuthConfig(await request<AuthConfig>("/api/auth/config")); await load(); }}
      />
      </>
    );
  }

  if (route.startsWith("docs/")) return <main className="public-documentation"><Documentation id={route.slice(5)} /></main>;

  const creatingProposal = route === "proposals/new" || /^repository\/[^/]+\/proposals\/new$/.test(route);
  const importingRepository = /^repository\/[^/]+\/import$/.test(route);
  const importRepository = importingRepository ? workspace.repositories.find(repo => repo.id === route.split("/")[1]) : undefined;
  const proposalRepositoryId = route.startsWith("repository/") && creatingProposal ? route.split("/")[1] : undefined;
  const requestedPage = ["signin", "signup"].includes(route) ? "overview" : route.split("/")[0];
  const page = requestedPage === "access" ? "settings" : requestedPage;
  const pageName = !isKnownAppRoute(route) ? "Page not found" : importingRepository ? "Import code" : creatingProposal ? "Ask AI agents" :
    {
      overview: "Overview",
      repositories: "Repositories",
      missions: "Proposals",
      mission: "Proposal",
      repository: "Repository",
      activity: "Activity",
      settings: "Settings",
      account: { security: "Security", sessions: "Sessions", clients: "AI clients", profile: "Profile" }[accountSection(route)],
      admin: "Installation",
    }[page] ?? "Overview";
  const missionList = workspace.missions.filter(
    (mission) =>
      (filter === "all" ||
        (filter === "active"
          ? runningStates.includes(mission.status)
          : mission.status === filter)) &&
      `${mission.title} ${mission.prompt}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const activeCount = workspace.missions.filter((mission) =>
    runningStates.includes(mission.status),
  ).length;
  const reviewCount = workspace.missions.filter(
    (mission) => mission.status === "needs_review",
  ).length;
  const hasAccountSession = authConfig.edition !== "self-hosted" && !!account && "email" in account.user;
  const navigation = [
    { id: "overview", label: "Overview", icon: HouseIcon },
    { id: "repositories", label: "Repositories", icon: FolderSimpleIcon },
    {
      id: "missions",
      label: "Proposals",
      icon: GitBranchIcon,
      count: activeCount,
    },
    { id: "activity", label: "Activity", icon: ActivityIcon },
  ];

  return (
    <>{authConfig.demo && <DemoBanner resetsDaily={authConfig.demo.resetsDaily} />}<div className={authConfig.demo ? "app-shell app-shell-demo" : "app-shell"}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebar ? "open" : ""}`}
        aria-label="Workspace navigation"
        id="workspace-navigation"
      >
        <a
          className="wordmark"
          href="/overview"
          style={{ textDecoration: "none" }}
        >
          <BrandMark size={32} />
          <span className="beta-tag">alpha</span>
        </a>
        <WorkspaceSwitcher
          workspaces={account?.workspaces.map(item => ({ id: item.id, name: item.name, role: item.role, repositoryScoped: item.repositoryScoped })) ?? []}
          currentId={account?.workspace?.id ?? ""}
          currentName={workspace.name}
          role={account?.role ?? ""}
          menu={authConfig.edition !== "self-hosted" && !!account}
          canCreate={hasAccountSession}
          canJoin={hasAccountSession}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
          onSwitch={id => switchWorkspace(id)}
          onCreated={async created => { await switchWorkspace(created.id); }}
          onJoined={async id => { await switchWorkspace(id); }}
        />
        <button
          className="quick-search-trigger"
          onClick={() => setQuickSearchOpen(true)}
          disabled={!loaded}
          aria-label="Search workspace"
        >
          <MagnifyingGlassIcon size={16} />
          <span>Quick search…</span>
          <kbd>⌘K</kbd>
        </button>
        <nav className="side-nav">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id || ((page === "mission" || (page === "proposals" && creatingProposal)) && item.id === "missions") || (page === "repository" && item.id === "repositories") ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={page === item.id ? "page" : undefined}
            >
              <item.icon size={17} />
              {item.label}
              {!!item.count && <span className="count">{item.count}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <div className="nav-label">Manage</div>
        <nav className="side-nav">
          <button
            className={`nav-item ${page === "settings" ? "active" : ""}`}
            aria-current={page === "settings" ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <GearSixIcon size={17} />
            Settings
          </button>
          <button className={`nav-item ${page === "docs" ? "active" : ""}`} onClick={() => navigate("docs/overview")} aria-current={page === "docs" ? "page" : undefined}>
            <BookOpenIcon size={17} />
            Documentation
          </button>
          <button className="nav-item" onClick={() => setModal("learn")}>
            <BookOpenIcon size={17} />
            How Gitflare works
            <ArrowUpRightIcon size={12} style={{ marginLeft: "auto" }} />
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-footer">
            <img src={cloudflareIcon} alt="" width="18" height="18" />
            Built on Cloudflare
          </div>
          <div className="sidebar-footer secondary">
            Independent product · Early access
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="utility-header">
          <button
            className="mobile-menu"
            aria-label="Open navigation"
            aria-expanded={sidebar}
            aria-controls="workspace-navigation"
            onClick={() => setSidebar(true)}
          >
            <ListIcon size={20} />
          </button>
          <div className="breadcrumbs">
            <span>{workspace.name}</span>
            <CaretRightIcon size={11} />
            <span>{pageName}</span>
          </div>
          <div className="utility-actions">
            <AccountMenu account={account} workspace={workspace} loaded={loaded} installationAdmin={installationAdmin} signingOut={signingOut} onSignOut={() => void signOut()} />
          </div>
        </header>
        {routePending && <RouteProgress />}
        {reconnecting && <ReconnectingNotice />}
        <main className="page-content" id="main-content" tabIndex={-1}>
          {error && (
            <ErrorNotice message={error} onRetry={() => void refresh()} />
          )}
          <Suspense fallback={<RouteProgress />}>
            {!isKnownAppRoute(route) ? <NotFound authenticated /> : importingRepository && authConfig.demo ? <DemoFeaturePanel feature="repository-creation" /> : importingRepository ? importRepository ? <RepositoryImport key={importRepository.id} repository={importRepository} canManage={permissions.includes("manage")} canContribute={permissions.includes("contribute")} onBack={() => navigate(`repository/${importRepository.id}/code`)} onImported={item => setWorkspace(current => ({ ...current, repositories: current.repositories.map(repo => repo.id === item.id ? item : repo) }))} onCreateProposal={() => createMission(importRepository.id)} /> : <ErrorNotice message="This repository could not be found." /> : creatingProposal ? <ProposalCreate key={route} repositories={workspace.repositories} repositoryId={proposalRepositoryId} canContribute={permissions.includes("contribute")} canManage={permissions.includes("manage")} onImportRepository={id => navigate(`repository/${id}/import`)} onBack={() => navigate(proposalRepositoryId ? `repository/${proposalRepositoryId}/pulls/new` : "missions")} onCreateRepository={() => setModal("repository")} onCreated={async proposal => { await load(); navigate(`mission/${proposal.id}`); notify(proposal.status === "draft" ? "Mission draft created." : "Mission started."); }} /> : page === "settings" ? (
              <WorkspaceSettingsLayout route={route}>
                {route === "settings/models" ? <ModelConnections canManage={permissions.includes("manage")} />
                  : route === "settings/cloudflare" ? <CloudflareAccounts canManage={permissions.includes("manage")} repositories={workspace.repositories} workspaceName={workspace.name} />
                  : !account ? <RouteProgress />
                  : route === "settings/people" ? <PeopleSettings data={account} repositories={workspace.repositories} workspaceName={workspace.name} selfHosted={authConfig.edition === "self-hosted"} onChanged={load} />
                  : route === "settings/audit" ? <AuditLog data={account} repositories={workspace.repositories} workspaceName={workspace.name} />
                  : <GeneralSettings workspace={workspace} data={account} selfHosted={authConfig.edition === "self-hosted"} onChanged={load} onLeft={async remaining => { if (remaining[0]) await switchWorkspace(remaining[0].id); else await load(); }} onOpenInstallation={() => navigate("admin")} />}
              </WorkspaceSettingsLayout>
            ) : route === "admin" ? <InstallationAdmin workspace={workspace} notFound={<NotFoundPanel />} /> : page === "account" ? <AccountSettings key={route} section={accountSection(route)} config={authConfig} onChanged={load} onSwitchWorkspace={switchWorkspace} onSignOut={() => void signOut()}>{route === "account/clients" && <McpConnections />}</AccountSettings> : page === "mission" ? (
              <MissionDetail
                key={route.split("/")[1]}
                id={route.split("/")[1]}
                initialTab={route.split("/")[2] || "overview"}
                selectedRunId={route.split("/")[3]}
                currentUserId={currentUserId}
                onTabChange={(tab) => navigate(`mission/${route.split("/")[1]}/${tab}`)}
                permissions={permissions}
                workspace={workspace}
                onBack={() => { const mission = workspace.missions.find(item => item.id === route.split("/")[1]); navigate(mission ? `repository/${mission.repositoryId}/pulls` : "missions"); }}
                onUpdate={() => void load()}
                demo={!!authConfig.demo}
              />
            ) : page === "repository" ? (
              <RepositoryDetail
                repository={workspace.repositories.find(
                  (repo) => repo.id === route.split("/")[1],
                )}
                workspace={workspace}
                onBack={() => navigate("repositories")}
                onMission={createMission}
                onOpenMission={(id, tab, runId) => navigate(`mission/${id}/${tab || "overview"}${runId ? `/${runId}` : ""}`)}
                tab={route.split("/")[2] || "code"}
                issueNumber={route.split("/")[3]}
                releaseId={route.split("/")[3]}
                canLand={permissions.includes("land")}
                subroute={route.split("/").slice(3).join("/")}
                onRefresh={() => void load()}
                onTabChange={(tab) => navigate(`repository/${route.split("/")[1]}/${tab}`)}
                onImport={() => navigate(`repository/${route.split("/")[1]}/import`)}
                canManage={permissions.includes("manage")}
                demo={!!authConfig.demo}
                onNotify={notify}
                canContribute={permissions.includes("contribute")}
                canExecute={permissions.includes("execute")}
                access={account}
                onAccessChanged={load}
              />
            ) : (
              <>
                <div className="page-heading">
                  <div>
                    <h1>{pageName}</h1>
                    <p>
                      {{
                        overview:
                          "Your code, your agents, and everything they build together.",
                        repositories:
                          "A shared home for code. Independent space for every agent.",
                        missions:
                          "Every proposed change (pull request), whether AI agents or people wrote it.",
                        activity: "Follow the work across your repositories.",
                        settings:
                          "Manage access, security, and workspace connections.",
                      }[page] ?? ""}
                    </p>
                  </div>
                  <div className="heading-actions">
                    <Button
                      variant="secondary"
                      size="base"
                      icon={
                        page === "repositories"
                          ? GitBranchIcon
                          : ArrowClockwiseIcon
                      }
                      loading={refreshing}
                      disabled={page === "repositories" && !permissions.includes("contribute")}
                      onClick={() =>
                        page === "repositories"
                          ? setModal("connect")
                          : void refresh()
                      }
                    >
                      {page === "repositories" ? "Connect existing" : "Refresh"}
                    </Button>
                    {page === "repositories" ? (
                      <Button
                        variant="primary"
                        size="base"
                        icon={PlusIcon}
                        disabled={!permissions.includes("contribute")}
                        onClick={() => setModal("repository")}
                      >
                        Create repository
                      </Button>
                    ) : (
                      page !== "settings" && (
                        <Button
                          variant="primary"
                          size="base"
                          icon={PlusIcon}
                          disabled={!permissions.includes("contribute")}
                          className="ai-only"
          onClick={() => createMission()}
                        >
                          Create mission
                        </Button>
                      )
                    )}
                  </div>
                </div>
                {page === "overview" && (
                  <>
                    {authConfig.demo && <DemoReplayCard onWatch={(id) => navigate(`mission/${id}/agents`)} />}
                    <div className="workspace-help">
                      <GitBranchIcon size={20} />
                      <p>
                        Agents work independently. Review their combined changes
                        before merging.
                      </p>
                      <button
                        className="text-link"
                        onClick={() => setModal("learn")}
                      >
                        How it works
                        <ArrowUpRightIcon size={14} />
                      </button>
                    </div>
                    <div className="workspace-columns">
                      <div>
                        <div className="section-heading">
                          <h2>
                            Recent missions
                            <span className="number-tag">
                              {workspace.missions.length}
                            </span>
                          </h2>
                          <button
                            className="text-link"
                            onClick={() => navigate("missions")}
                          >
                            View all
                            <ArrowUpRightIcon size={12} />
                          </button>
                        </div>
                        <section className="panel">
                          {workspace.missions.length ? (
                            <MissionTable
                              missions={workspace.missions.slice(0, 5)}
                              workspace={workspace}
                              onOpen={(id) => navigate(`mission/${id}`)}
                            />
                          ) : (
                            <EmptyState
                              icon={<GitBranchIcon size={25} />}
                              title="The next change starts with a mission"
                              description="Describe what you want to build. Track each agent's work and review the result in one place."
                              action={
                                <Button
                                  variant="secondary"
                                  size="base"
                                  icon={PlusIcon}
                                  disabled={!permissions.includes("contribute")}
                          className="ai-only"
          onClick={() => createMission()}
                                >
                                  Create your first mission
                                </Button>
                              }
                            />
                          )}
                        </section>
                        <div
                          className="section-heading"
                          style={{ marginTop: 28 }}
                        >
                          <h2>
                            Repositories
                            <span className="number-tag">
                              {workspace.repositories.length}
                            </span>
                          </h2>
                          <button
                            className="text-link"
                            onClick={() => navigate("repositories")}
                          >
                            View all
                            <ArrowUpRightIcon size={12} />
                          </button>
                        </div>
                        <section className="panel">
                          {workspace.repositories.length ? (
                            <div className="table-scroll">
                              <table className="resource-table">
                                <thead>
                                  <tr>
                                    <th>Repository</th>
                                    <th>Storage</th>
                                    <th>Stream</th>
                                    <th />
                                  </tr>
                                </thead>
                                <tbody>
                                  {workspace.repositories
                                    .slice(0, 3)
                                    .map((repo) => (
                                      <tr key={repo.id}>
                                        <td>
                                          <div className="resource-name">
                                            <FolderSimpleIcon size={18} />
                                            <div>
                                              <button
                                                onClick={() =>
                                                  navigate(
                                                    `repository/${repo.id}`,
                                                  )
                                                }
                                              >
                                                {repositoryLabel(repo)}
                                              </button>
                                              <small>
                                                {repo.description.length > 70
                                                  ? `${repo.description.slice(0, 70)}…`
                                                  : repo.description}
                                              </small>
                                            </div>
                                          </div>
                                        </td>
                                        <td>
                                          <Status
                                            status={
                                              repo.provider === "artifacts"
                                                ? "connected"
                                                : "local"
                                            }
                                          />
                                        </td>
                                        <td>
                                          <code style={{ fontSize: 13 }}>
                                            {repo.defaultBranch}
                                          </code>
                                        </td>
                                        <td>
                                          <Button
                                            variant="ghost"
                                            size="base"
                                            shape="square"
                                            aria-label={`Open ${repositoryLabel(repo)}`}
                                            icon={ArrowUpRightIcon}
                                            onClick={() =>
                                              navigate(`repository/${repo.id}`)
                                            }
                                          />
                                        </td>
                                      </tr>
                                    ))}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <EmptyState
                              icon={<FolderSimpleIcon size={25} />}
                              title="A home for your next idea"
                              description="Create a repository to keep source code and agent contributions together."
                              action={
                                <button
                                  className="text-link"
                                  disabled={!permissions.includes("contribute")}
                        onClick={() => setModal("repository")}
                                >
                                  Create repository
                                  <ArrowUpRightIcon size={12} />
                                </button>
                              }
                            />
                          )}
                        </section>
                      </div>
                      <aside className="overview-aside">
                        <SetupSteps
                          workspace={workspace}
                          onRepository={() => setModal("repository")}
                          onMission={() => createMission()}
                          onSettings={() => navigate("settings")}
                        />
                        {permissions.includes("manage") && <CloudflareConnectPrompt onOpen={() => navigate("settings/cloudflare")} />}
                        <div className="info-card">
                          <h3>
                            <ShieldCheckIcon size={17} />
                            Review the combination
                          </h3>
                          <p>
                            Two passing changes can fail together. Gitflare
                            keeps the combined result and its checks in the same
                            review.
                          </p>
                          <button
                            className="text-link"
                            style={{ marginTop: 13, fontSize: 13 }}
                            onClick={() => setModal("learn")}
                          >
                            See how it works
                            <ArrowUpRightIcon size={12} />
                          </button>
                        </div>
                      </aside>
                    </div>
                  </>
                )}
                {page === "missions" && (
                  <>
                    <div className="page-tabs">
                      <Tabs
                        variant="underline"
                        value={filter}
                        onValueChange={setFilter}
                        tabs={[
                          { value: "all", label: "All" },
                          {
                            value: "active",
                            label: `Active (${activeCount})`,
                          },
                          {
                            value: "needs_review",
                            label: `Needs review (${reviewCount})`,
                          },
                          { value: "draft", label: "Drafts" },
                          { value: "integrated", label: "Landed" },
                        ]}
                      />
                    </div>
                    <div className="searchbar">
                      <div className="search-input">
                        <MagnifyingGlassIcon size={15} />
                        <Input
                          aria-label="Search proposals"
                          placeholder="Search proposals…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </div>
                      <span className="status-strip">
                        {missionList.length}{" "}
                        {missionList.length === 1 ? "proposal" : "proposals"}
                      </span>
                    </div>
                    <section className="panel">
                      {missionList.length ? (
                        <MissionTable
                          missions={missionList}
                          workspace={workspace}
                          onOpen={(id) => navigate(`mission/${id}`)}
                        />
                      ) : (
                        <EmptyState
                          icon={<GitBranchIcon size={25} />}
                          title={
                            search || filter !== "all"
                              ? "No missions match this view"
                              : "Create your first mission"
                          }
                          description={
                            search || filter !== "all"
                              ? "Try another search or choose a different status."
                              : "Start with a clear outcome. Give each agent its own assignment, then review their work together."
                          }
                          action={
                            <Button
                              variant="secondary"
                              size="base"
                              onClick={
                                search || filter !== "all"
                                  ? () => {
                                      setSearch("");
                                      setFilter("all");
                                    }
                                  : () => createMission()
                              }
                            >
                              {search || filter !== "all"
                                ? "Clear filters"
                                : "Create mission"}
                            </Button>
                          }
                        />
                      )}
                    </section>
                  </>
                )}
                {page === "repositories" && (
                  <>
                    <div className="searchbar">
                      <div className="search-input">
                        <MagnifyingGlassIcon size={15} />
                        <Input
                          aria-label="Search repositories"
                          placeholder="Search repositories…"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                        />
                      </div>
                    </div>
                    <div className="repo-grid">
                      {workspace.repositories
                        .filter((repo) =>
                          `${repositoryLabel(repo)} ${repo.description}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .map((repo) => (
                          <article className="repo-card" key={repo.id}>
                            <div className="repo-card-head">
                              <FolderSimpleIcon size={20} />
                              <h2>{repositoryLabel(repo)}</h2>
                              <Status
                                status={
                                  repo.provider === "artifacts"
                                    ? "connected"
                                    : "local"
                                }
                              />
                            </div>
                            <p>
                              {repo.description || "No description added yet."}
                            </p>
                            <div className="repo-card-meta">
                              <span>
                                <GitBranchIcon size={13} />
                                {repo.defaultBranch}
                              </span>
                              <span>
                                <GitCommitIcon size={13} />
                                {repo.headSha?.slice(0, 8) ?? "No revision yet"}
                              </span>
                              <span>
                                {
                                  workspace.missions.filter(
                                    (mission) =>
                                      mission.repositoryId === repo.id,
                                  ).length
                                }{" "}
                                missions
                              </span>
                            </div>
                            <button
                              className="text-link"
                              onClick={() => navigate(`repository/${repo.id}`)}
                            >
                              Open repository
                              <ArrowUpRightIcon size={12} />
                            </button>
                          </article>
                        ))}
                    </div>
                    {!workspace.repositories.some((repo) =>
                      `${repositoryLabel(repo)} ${repo.description}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    ) && (
                      <section className="panel">
                        <EmptyState
                          icon={<FolderSimpleIcon size={25} />}
                          title={
                            search
                              ? "No repositories found"
                              : "Create your first repository"
                          }
                          description={
                            search
                              ? "Try searching for another name."
                              : "Keep your code and its mission history together."
                          }
                          action={
                            <Button
                              variant="primary"
                              size="base"
                              disabled={!permissions.includes("contribute")}
                        onClick={() => setModal("repository")}
                            >
                              Create repository
                            </Button>
                          }
                        />
                      </section>
                    )}
                  </>
                )}
                {page === "activity" && (
                  <ActivityView
                    workspace={workspace}
                    onOpen={(id) => navigate(`mission/${id}`)}
                  />
                )}
              </>
            )}
            <footer className="bottom-note">
              <span>
                <CloudIcon size={13} />
                Gitflare · A workspace for human and agent collaboration
              </span>
              <span>
                {workspace.mode === "local"
                  ? "Local development · No simulated execution"
                  : "Private workspace"}
              </span>
            </footer>
          </Suspense>
        </main>
      </div>
      <QuickSearch
        open={quickSearchOpen}
        workspace={workspace}
        workspaces={authConfig.edition === "self-hosted" ? [] : account?.workspaces.map(item => ({ id: item.id, name: item.name, role: item.role })) ?? []}
        currentWorkspaceId={account?.workspace?.id ?? ""}
        onClose={() => setQuickSearchOpen(false)}
        onNavigate={navigate}
        onSwitchWorkspace={hasAccountSession ? id => void switchWorkspace(id) : undefined}
      />
      <CreationDialog
        modal={modal}
        demo={!!authConfig.demo}
        cloudflareAvailable={authConfig.cloudflareSignin === true}
        onClose={() => setModal(null)}
        workspace={workspace}
        onCreated={async (item, importCode) => {
          await load();
          setModal(null);
          navigate(importCode ? `repository/${item.id}/import` : creatingProposal ? `repository/${item.id}/proposals/new` : `repository/${item.id}`);
          notify("Repository created.");
        }}
        onSignedIn={async () => {
          setModal(null);
          await load();
        }}
      />
      {toast && (
        <div className="app-toast" role="status">
          <CheckCircleIcon size={18} />
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}
    </div></>
  );
}

function NotFoundPanel() {
  return <section className="panel"><EmptyState icon={<InfoIcon size={25} />} title="This page could not be found." description="The link may have changed, or your account cannot open it." action={<a className="text-link" href="/overview">Go to overview</a>} /></section>;
}

function RepositoryDetailsPanel({ repository, onNotify }: { repository: Repository; onNotify: (message: string) => void }) {
  return (
          <section className="panel">
            <div className="panel-header">
              <h2>Repository details</h2>
              <Status
                status={
                  repository.provider === "artifacts" ? "connected" : "local"
                }
              />
            </div>
            <div className="panel-body">
              <div className="summary-grid" style={{ marginTop: 0 }}>
                <div>
                  <span>Default stream</span>
                  <strong>
                    <code>{repository.defaultBranch}</code>
                  </strong>
                </div>
                <div>
                  <span>Current revision</span>
                  <strong>
                    <code>
                      {repository.headSha?.slice(0, 12) ?? "No revision yet"}
                    </code>
                  </strong>
                </div>
                <div>
                  <span>Git storage</span>
                  <strong>
                    {repository.provider === "artifacts"
                      ? "Cloudflare Artifacts"
                      : "Local workspace record"}
                  </strong>
                </div>
                <div>
                  <span>Created</span>
                  <strong>
                    {new Date(repository.createdAt).toLocaleDateString()}
                  </strong>
                </div>
              </div>
              {repository.remote && (
                <div className="clipboard-row">
                  <code>git clone {quoteGitArgument(repository.remote)}</code>
                  <Button
                    variant="ghost"
                    size="base"
                    shape="square"
                    aria-label="Copy clone command"
                    icon={CopyIcon}
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(`git clone ${quoteGitArgument(repository.remote ?? "")}`)
                        .then(() => onNotify("Clone command copied."))
                        .catch(() =>
                          onNotify("Copy is unavailable in this browser."),
                        );
                    }}
                  />
                </div>
              )}
            </div>
          </section>
  );
}

function RepositoryGeneral({ repository, onNotify }: { repository: Repository; onNotify: (message: string) => void }) {
  return <>
    <div className="page-heading"><div><h1>General</h1><p>Details, clone address and GitHub mirror for {repositoryLabel(repository)}.</p></div></div>
    <RepositoryDetailsPanel repository={repository} onNotify={onNotify} />
    <GitHubMirror key={repository.id} repositoryId={repository.id} onNotify={onNotify} />
  </>;
}

function ActivityView({
  workspace,
  onOpen,
}: {
  workspace: Workspace;
  onOpen: (id: string) => void;
}) {
  const events = workspace.missions
    .flatMap((mission) =>
      mission.events.map((event) => ({ ...event, mission })),
    )
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Recorded activity</h2>
        <span className="number-tag">{events.length} events</span>
      </div>
      {events.length ? (
        <div className="panel-body">
          <ol className="timeline">
            {events.map((event) => (
              <li key={`${event.mission.id}-${event.id}`}>
                <span className="timeline-marker" />
                <p>{event.message}</p>
                <small>
                  <button
                    className="text-link"
                    style={{ fontSize: 13 }}
                    onClick={() => onOpen(event.mission.id)}
                  >
                    {event.mission.title}
                  </button>{" "}
                  · {new Date(event.timestamp).toLocaleString()}
                </small>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <EmptyState
          icon={<ActivityIcon size={25} />}
          title="Your workspace history starts here"
          description="Mission creation, agent execution, checks, and review decisions will appear as they happen."
        />
      )}
    </section>
  );
}

function RepositoryDetail({
  repository,
  workspace,
  onBack,
  onMission,
  onOpenMission,
  onNotify,
  canContribute,
  canExecute,
  canManage,
  tab,
  issueNumber,
  subroute,
  onRefresh,
  onTabChange,
  onImport,
  releaseId,
  canLand,
  demo = false,
  access,
  onAccessChanged,
}: {
  repository?: Repository;
  workspace: Workspace;
  onBack: () => void;
  onMission: (id: string) => void;
  onOpenMission: (id: string, tab?: string, runId?: string) => void;
  onNotify: (message: string) => void;
  canContribute: boolean;
  canExecute: boolean;
  canManage: boolean;
  tab: string;
  issueNumber?: string;
  subroute: string;
  onRefresh: () => void;
  onTabChange: (tab: string) => void;
  onImport: () => void;
  releaseId?: string;
  canLand: boolean;
  demo?: boolean;
  access: AccessSnapshot | null;
  onAccessChanged: () => Promise<void>;
}) {
  if (!repository)
    return (
      <>
        <button className="header-back" onClick={onBack}>
          <ArrowLeftIcon size={13} />
          All repositories
        </button>
        <ErrorNotice message="This repository could not be found." />
      </>
    );
  const missions = workspace.missions.filter(
    (mission) => mission.repositoryId === repository.id,
  );
  const openPullCount = missions.filter((mission) => mission.branchChange ? !mission.branchChange.closedAt && mission.status !== "integrated" : !["integrated", "cancelled"].includes(mission.status)).length;
  return (
    <>
      <button className="header-back" onClick={onBack}>
        <ArrowLeftIcon size={13} />
        All repositories
      </button>
      <div className="page-heading">
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <FolderSimpleIcon size={25} color="#7d8b9e" />
            {repositoryLabel(repository)}
          </h1>
          <p>
            {repository.description ||
              "Your source code and its mission history."}
          </p>
        </div>
        <Button
          variant="primary"
          size="base"
          icon={PlusIcon}
          disabled={!canContribute}
          className={tab === "pulls" || tab === "proposals" ? "is-hidden" : undefined}
          onClick={() => onTabChange("pulls/new")}
        >
          New proposal
        </Button>
      </div>
      <nav className="repository-navigation" aria-label="Repository navigation">
        {[
            { value: "code", label: "Code" },
            { value: "issues", label: "Issues" },
            { value: "pulls", label: `Proposals (${openPullCount})` },
            { value: "agents", label: `Agents (${missions.reduce((count, mission) => count + (mission.epoch > 0 ? mission.runs.length : 0), 0)})` },
            { value: "checks", label: `Checks (${missions.reduce((count, mission) => count + mission.checks.length, 0)})` },
            { value: "skills", label: "Skills", ai: true },
            { value: "releases", label: "Checkpoints" },
            { value: "settings", label: "Settings" },
          ].map((item) => <button key={item.value} className={"ai" in item && item.ai ? "ai-only" : undefined} aria-current={tab === item.value || (tab === "proposals" && item.value === "pulls") ? "page" : undefined} onClick={() => onTabChange(item.value)}>{item.label}</button>)}
      </nav>
      {tab === "issues" ? <Issues key={repository.id} repository={repository} issueNumber={issueNumber} missions={missions} /> : tab === "releases" ? <Releases key={repository.id} repository={repository} releaseId={releaseId} canLand={canLand} demo={demo} onNotify={onNotify} /> : tab === "pulls" || tab === "proposals" ? subroute === "new" ? <PullRequestCreate key={repository.id} repository={repository} canContribute={canContribute} canExecute={canExecute} onCreated={onRefresh} onAskAgents={() => onMission(repository.id)} /> : <PullRequests key={repository.id} repositoryId={repository.id} missions={missions} canContribute={canContribute} /> : tab === "settings" ? <RepositorySettingsLayout repositoryId={repository.id} page={subroute}>
        {subroute === "branches" ? <BranchProtection key={repository.id} repository={repository} canManage={canManage} demo={demo} approvers={access ? eligibleApprovers(access.members, repository.id) : undefined} knownChecks={knownCheckNames(missions)} onNotify={onNotify} />
          : subroute === "secrets" ? <SecretSettings key={repository.id} repositoryId={repository.id} onNotify={onNotify} />
          : subroute === "deploys" ? <Deployments key={repository.id} repository={repository} onNotify={onNotify} />
          : subroute === "previews" ? <PreviewSettings key={repository.id} repositoryId={repository.id} onNotify={onNotify} />
          : subroute === "cloudflare" ? <CloudflareConnection key={repository.id} canManage={canManage} repository={repository} repositoryId={repository.id} />
          : subroute === "access" ? access ? <RepositoryAccess data={access} repository={repository} repositories={workspace.repositories} workspaceName={workspace.name} onChanged={onAccessChanged} /> : <RouteProgress />
          : <RepositoryGeneral repository={repository} onNotify={onNotify} />}
      </RepositorySettingsLayout> : ["agents", "checks"].includes(tab) ? <RepositoryWork key={`${repository.id}-${tab}`} tab={tab} missions={missions} canContribute={canContribute} onCreate={() => onMission(repository.id)} onOpen={onOpenMission} /> : tab === "skills" ? <RepositorySkills key={repository.id} repository={repository} canContribute={canContribute} canExecute={canExecute} demo={demo} onOpenMission={onOpenMission} /> : tab === "code" ? (
        <><RepositoryImportOnboarding key={repository.id} repository={repository} canManage={canManage} onImport={onImport} onRefresh={onRefresh} /><RepositoryBrowser key={repository.id} repository={repository} />{repository.provider === "artifacts" && <GitAccess key={`git-${repository.id}`} repository={repository} onNotify={onNotify} />}</>
      ) : tab === "overview" ? (
        <>
          <RepositoryDetailsPanel repository={repository} onNotify={onNotify} />
          {repository.provider === "local" && (
            <div className="alert info" style={{ marginTop: 20 }}>
              <InfoIcon size={17} />
              <div className="alert-text">
                This is a local workspace record. Connect Artifacts to host Git
                source code and run agent work.
              </div>
            </div>
          )}
          <section className="panel" style={{ marginTop: 24 }}>
            <div className="panel-header">
              <h2>Recent missions</h2>
              <button className="text-link" onClick={() => onTabChange("proposals")}>
                View all
                <ArrowUpRightIcon size={12} />
              </button>
            </div>
            {missions.length ? (
              <MissionTable
                missions={missions.slice(0, 5)}
                workspace={workspace}
                onOpen={onOpenMission}
              />
            ) : (
              <EmptyState
                icon={<GitBranchIcon size={25} />}
                title="What should we build next?"
                description="Start a mission to give your agents a clear outcome and track their contributions."
                action={
                  <Button
                    variant="secondary"
                    size="base"
                    disabled={!canContribute}
          className="ai-only"
          onClick={() => onMission(repository.id)}
                  >
                    Create mission
                  </Button>
                }
              />
            )}
          </section>
        </>
      ) : (
        <section className="panel">
          {missions.length ? (
            <MissionTable
              missions={missions}
              workspace={workspace}
              onOpen={onOpenMission}
            />
          ) : (
            <EmptyState
              icon={<GitBranchIcon size={25} />}
              title="No missions yet"
              description="Create your first mission for this repository."
              action={
                <Button
                  variant="secondary"
                  size="base"
                  disabled={!canContribute}
          className="ai-only"
          onClick={() => onMission(repository.id)}
                >
                  Create mission
                </Button>
              }
            />
          )}
        </section>
      )}
    </>
  );
}

function CreationDialog({
  modal,
  onClose,
  workspace,
  onCreated,
  onSignedIn,
  cloudflareAvailable,
  demo = false,
}: {
  modal: Modal;
  demo?: boolean;
  cloudflareAvailable: boolean;
  onClose: () => void;
  workspace: Workspace;
  onCreated: (item: Repository, importCode?: boolean) => Promise<void>;
  onSignedIn: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [initializeReadme, setInitializeReadme] = useState(true);
  const [start, setStart] = useState<"new" | "zip" | "url">("new");
  const importCode = start === "zip";
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceToken, setSourceToken] = useState("");
  const [sourceUsername, setSourceUsername] = useState("");
  const [gitignore, setGitignore] = useState("none");
  const [license, setLicense] = useState("none");
  const [copyrightHolder, setCopyrightHolder] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ownerNotice, setOwnerNotice] = useState(false);
  const mutation = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    setName("");
    setDescription("");
    setStart("new"); setSourceUrl(""); setSourceToken(""); setSourceUsername(""); setInitializeReadme(true); setGitignore("none"); setLicense("none"); setCopyrightHolder("");
    setToken("");
    setError("");
    setBusy(false);
    mutation.current = null;
  }, [modal]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const fromUrl = modal === "repository" && start === "url";
    const body = modal === "session" ? { token } : fromUrl ? { name: name.trim(), description: description.trim(), url: sourceUrl.trim(), ...(sourceToken ? { token: sourceToken } : {}), ...(sourceToken && sourceUsername.trim() ? { username: sourceUsername.trim() } : {}) } : { name: name.trim(), description: description.trim(), ...(modal === "repository" ? { initializeReadme: importCode ? false : initializeReadme, gitignore: importCode ? "none" : gitignore, license: importCode ? "none" : license, copyrightHolder: importCode ? undefined : copyrightHolder.trim() || undefined } : {}) };
    const signature = JSON.stringify({ modal, body });
    if (mutation.current?.signature !== signature)
      mutation.current = { signature, key: crypto.randomUUID() };
    try {
      if (modal === "session") {
        await request("/api/session", body, mutation.current.key);
        setToken("");
        if (showOwnerTokenNotice(true)) setOwnerNotice(true);
        else await onSignedIn();
      } else if (modal === "repository" || modal === "connect") {
        const result = await request<Repository>(
          modal === "connect"
            ? "/api/repositories/connect"
            : fromUrl ? "/api/repositories/import-url" : "/api/repositories",
          body,
          mutation.current.key,
        );
        setSourceToken("");
        await onCreated(result, modal === "repository" && importCode);
      }
      mutation.current = null;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The request could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const titleText = {
    repository: "Create a repository",
    connect: "Connect an existing repository",
    learn: "From intent to a reviewed change",
    session: "Sign in to Gitflare",
  }[modal ?? "repository"];
  const descriptionText = {
    repository: "A home for your code and every agent contribution.",
    connect:
      "Add a repository that already exists in the Artifacts namespace connected to this workspace.",
    learn:
      "Keep the speed of parallel agents, with a clear record of what changed and why.",
    session:
      "Enter the owner access token for this workspace. It is used to establish a private session.",
  }[modal ?? "repository"];

  return (
    <>
    <OwnerTokenNotice
      open={ownerNotice}
      cloudflareAvailable={cloudflareAvailable}
      onContinue={() => { setOwnerNotice(false); void onSignedIn(); }}
    />
    <Dialog.Root
      open={modal !== null && !ownerNotice}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog size={modal === "learn" ? "xl" : "lg"} className="dialog-content">
        <div className="dialog-title-row">
          <Dialog.Title className="dialog-title">{titleText}</Dialog.Title>
          <Button
            variant="ghost"
            size="base"
            shape="square"
            icon={XIcon}
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          />
        </div>
        <Dialog.Description className="dialog-description">
          {descriptionText}
        </Dialog.Description>
        {modal === "learn" ? (
          <>
            <BranchIllustration />
            <div className="learn-grid">
              <div>
                <strong>1. Define the work</strong>
                <p>
                  Choose a repository, describe the outcome, and assign
                  independent tasks.
                </p>
              </div>
              <div>
                <strong>2. Follow the evidence</strong>
                <p>
                  Inspect each agent's fork, revisions, actual changes, and
                  recorded checks.
                </p>
              </div>
              <div>
                <strong>3. Review together</strong>
                <p>
                  Test the combined candidate. Approve the exact revision you
                  reviewed.
                </p>
              </div>
            </div>
            <p className="terminology-note">
              A stream is a Git branch. A revision is a Git commit. Landing
              changes merges an approved result into your repository. Your
              existing Git commands still work.
            </p>
            <div className="dialog-actions">
              <Button variant="primary" size="base" onClick={onClose}>
                Got it
              </Button>
            </div>
          </>
        ) : demo && (modal === "repository" || modal === "connect") ? (
          <div className="demo-feature-dialog">
            <DemoFeaturePanel feature="repository-creation" headingLevel={3} />
            <div className="dialog-actions">
              <Button variant="secondary" size="base" onClick={onClose}>Close</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)}>
            {modal === "session" ? (
              <div className="form-field">
                <label htmlFor="owner-token">Owner access token</label>
                <Input
                  id="owner-token"
                  aria-label="Owner access token"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                <small>Your token is not saved in browser storage.</small>
              </div>
            ) : modal === "repository" || modal === "connect" ? (
              <>
                <div className="form-field">
                  <label htmlFor="repository-name">Repository name</label>
                  <Input
                    id="repository-name"
                    aria-label="Repository name"
                    placeholder="my-edge-app"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={64}
                    pattern="[a-z0-9][a-z0-9-]*"
                  />
                  <small>Lowercase letters, numbers, and hyphens.</small>
                </div>
                <div className="form-field">
                  <label htmlFor="repository-description">
                    Description{" "}
                    <span style={{ color: "#929dab", fontWeight: 400 }}>
                      (optional)
                    </span>
                  </label>
                  <Input
                    id="repository-description"
                    aria-label="Repository description"
                    placeholder="What are you building?"
                    value={description}
                    maxLength={500}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
                {modal === "repository" && <div className="form-field"><label htmlFor="repository-start">Start this repository</label><select id="repository-start" value={start} onChange={event => setStart(event.target.value as "new" | "zip" | "url")}><option value="new">Start a new project</option><option value="zip">Import existing code from a ZIP</option><option value="url">Import from a Git URL with history</option></select><small>{start === "zip" ? "Create an empty repository, then choose your project ZIP on the import page." : start === "url" ? "Copy every branch and tag with full history from GitHub, GitLab, Bitbucket or another HTTPS Git host." : "Choose initial setup files for your repository."}</small></div>}
                {modal === "repository" && start === "url" && <div className="form-field"><label htmlFor="repository-source-url">Repository URL</label><Input id="repository-source-url" type="url" required placeholder="https://github.com/owner/repository" value={sourceUrl} maxLength={2048} onChange={event => { const value = event.target.value; const derived = (url: string) => (url.trim().replace(/\/+$/, "").split("/").pop() ?? "").replace(/\.git$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64); if (!name || name === derived(sourceUrl)) setName(derived(value)); setSourceUrl(value); }} /><label htmlFor="repository-source-token">Access token <span style={{ color: "#929dab", fontWeight: 400 }}>(private repositories only)</span></label><Input id="repository-source-token" type="password" autoComplete="off" value={sourceToken} maxLength={1024} onChange={event => setSourceToken(event.target.value)} />{sourceToken && <><label htmlFor="repository-source-username">Token username <span style={{ color: "#929dab", fontWeight: 400 }}>(optional)</span></label><Input id="repository-source-username" autoComplete="off" value={sourceUsername} maxLength={100} onChange={event => setSourceUsername(event.target.value)} /></>}<small>The token is used once to read the source for this import and is never stored. Use a read-only token. Limit: 256 MiB of Git objects, 500 branches and 2,000 tags.</small></div>}
                {modal === "repository" && start === "new" && <div className="form-field"><label className="access-checkbox"><input type="checkbox" checked={initializeReadme} onChange={event => setInitializeReadme(event.target.checked)}/>Initialize with a README</label><label htmlFor="repository-gitignore">.gitignore template</label><select id="repository-gitignore" value={gitignore} onChange={event => setGitignore(event.target.value)}>{["none", "Node", "Python"].map(value => <option key={value} value={value}>{value === "none" ? "None" : value}</option>)}</select><label htmlFor="repository-license">License</label><select id="repository-license" value={license} onChange={event => setLicense(event.target.value)}>{["none", "MIT", "Apache-2.0"].map(value => <option key={value} value={value}>{value === "none" ? "No license" : value}</option>)}</select>{license === "MIT" && <><label htmlFor="repository-copyright">Copyright holder</label><Input id="repository-copyright" value={copyrightHolder} onChange={event => setCopyrightHolder(event.target.value)} required maxLength={200}/></>}</div>}
                {modal === "repository" && start !== "url" &&
                  workspace.mode === "local" &&
                  !workspace.integrations.find(
                    (item) => item.id === "artifacts",
                  )?.ready && (
                    <div className="alert info">
                      <InfoIcon size={16} />
                      <div className="alert-text">
                        This creates a local workspace record. Connect Artifacts
                        for Git hosting.
                      </div>
                    </div>
                  )}
              </>
            ) : null}
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="dialog-actions">
              <Button
                variant="secondary"
                size="base"
                type="button"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="base"
                type="submit"
                loading={busy}
              >
                {modal === "session"
                  ? "Sign in"
                  : modal === "repository"
                    ? start === "url" ? "Import repository" : "Create repository"
                    : modal === "connect"
                      ? "Connect repository"
                      : "Create repository"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Dialog.Root>
    </>
  );
}
