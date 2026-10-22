import { useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { RobotIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import type { Mission, MissionSummary } from "../shared/types";
import { request } from "./api";
import { EmptyState, Status } from "./components";
import { OperationTrack } from "./OperationMotion";
import AgentAssignment from "./AgentAssignment";
import "./repository-work.css";

export default function RepositoryWork({
  tab,
  missions,
  canContribute,
  onCreate,
  onOpen,
}: {
  tab: "agents" | "checks";
  missions: MissionSummary[];
  canContribute: boolean;
  onCreate: () => void;
  onOpen: (id: string, tab?: string, runId?: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const runs = missions
    .filter((mission) => mission.epoch > 0)
    .flatMap((mission) => mission.runs.map((run) => ({ mission, run })));
  const checks = missions.flatMap((mission) =>
    mission.checks.map((check) => ({ mission, check })),
  );
  const match = (text: string, status: string) =>
    text.toLowerCase().includes(search.toLowerCase()) &&
    (filter === "all" ||
      (filter === "open"
        ? !["integrated", "cancelled"].includes(status)
        : filter === "active"
          ? ["queued", "running", "checking"].includes(status)
          : status === filter));
  const filteredRuns = runs.filter(({ mission, run }) =>
    match(
      `${mission.title} ${run.name} ${run.assignment} ${run.model ?? ""} ${run.branch ?? ""}`,
      run.status,
    ),
  );
  const filteredChecks = checks.filter(({ mission, check }) =>
    match(
      `${mission.title} ${check.name} ${check.candidateSha ?? ""}`,
      check.status,
    ),
  );
  const total = tab === "agents" ? runs.length : checks.length;
  const shown = tab === "agents" ? filteredRuns.length : filteredChecks.length;
  const filters =
    tab === "agents"
      ? ["all", "active", "completed", "failed", "cancelled"]
      : ["all", "pending", "running", "passed", "failed", "skipped"];
  return (
    <>
      <div className="repository-work-heading">
        <div>
          <h2>{tab === "agents" ? "Agent runs" : "Checks"}</h2>
          <p>
            {tab === "agents"
              ? "Each agent works in its own fork."
              : "Recorded agent and combined checks, pinned to the revision they verified."}
          </p>
        </div>
      </div>
      <div className="repository-work-toolbar">
        <input
          aria-label={`Search ${tab}`}
          placeholder={`Search ${tab}…`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label={`Filter ${tab} by status`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          {filters.map((value) => (
            <option key={value} value={value}>
              {value === "all" ? "All statuses" : value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <span>
          {shown} of {total}
        </span>
      </div>
      <section className="panel">
        {!shown ? (
          <EmptyState
            icon={tab === "agents" ? <RobotIcon size={25} /> : <ShieldCheckIcon size={25} />}
            title={
              total
                ? "No matching results"
                : tab === "agents"
                  ? "No agent runs yet"
                  : "No checks recorded"
            }
            description={
              total
                ? "Try another search or status filter."
                : "Describe an outcome; agents start when you say so."
            }
            action={
              total ? (
                <Button
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button disabled={!canContribute} onClick={onCreate}>
                  Create mission
                </Button>
              )
            }
          />
        ) : tab === "agents" ? (
          <div className="repository-work-list">
            {filteredRuns.map(({ mission, run }) => (
              <article
                className="repository-work-item"
                key={`${mission.id}-${run.id}`}
              >
                <div className="repository-work-title">
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id, "agents", run.id)}
                  >
                    {run.name}
                  </button>
                  {["queued", "running", "checking"].includes(run.status) && <OperationTrack compact kind="agents" />}<Status status={run.status} />
                </div>
                <p>
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id)}
                  >
                    {mission.title}
                  </button>{" "}
                  · {run.role} · {run.model || "Model not recorded"}
                </p>
                <AgentAssignment run={run} mission={mission} />
                <div className="repository-work-meta">
                  <span>
                    Stream <code>{run.branch || "Not allocated"}</code>
                  </span>
                  <span>
                    Fork <code>{run.forkName || "Not allocated"}</code>
                  </span>
                  <span>
                    Revision{" "}
                    <code>
                      {run.commitSha?.slice(0, 12) || "No saved revision"}
                    </code>
                  </span>
                  <span>{run.changedFiles.length} changed files</span>
                </div>
                {run.error && (
                  <p className="repository-work-error">{run.error}</p>
                )}
                <button
                  className="text-link"
                  onClick={() => onOpen(mission.id, "agents", run.id)}
                >
                  View run details and logs →
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="repository-work-list">
            {filteredChecks.map(({ mission, check }) => (
              <article
                className="repository-work-item"
                key={`${mission.id}-${check.id}`}
              >
                <div className="repository-work-title">
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id, "checks")}
                  >
                    {check.name}
                  </button>
                  {["pending", "running"].includes(check.status) && <OperationTrack compact kind="agents" />}<Status status={check.status} />
                </div>
                <p>
                  <button
                    className="text-link"
                    onClick={() => onOpen(mission.id, "checks")}
                  >
                    {mission.title}
                  </button>{" "}
                  ·{" "}
                  {check.candidateSha === mission.candidateSha &&
                  mission.candidateSha
                    ? "Combined candidate"
                    : check.candidateSha &&
                        mission.runs.some(
                          (run) => run.commitSha === check.candidateSha,
                        )
                      ? "Agent revision"
                      : "Combination check"}
                </p>
                <div className="repository-work-meta">
                  <span>
                    Revision{" "}
                    <code>
                      {check.candidateSha?.slice(0, 12) ||
                        "No revision recorded"}
                    </code>
                  </span>
                  {check.durationMs !== undefined && (
                    <span>{(check.durationMs / 1000).toFixed(1)}s</span>
                  )}
                </div>
                <CheckOutput missionId={mission.id} checkId={check.id} />
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function CheckOutput({ missionId, checkId }: { missionId: string; checkId: string }) {
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState("");
  const load = () => {
    if (output !== undefined) return;
    setError("");
    request<Mission>(`/api/missions/${encodeURIComponent(missionId)}`)
      .then((mission) => setOutput(mission.checks.find((check) => check.id === checkId)?.output ?? ""))
      .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Check output could not be loaded."));
  };
  return (
    <details onToggle={(event) => { if (event.currentTarget.open) load(); }}>
      <summary>View check output</summary>
      {error ? <p className="repository-work-error">{error}</p> : output === undefined ? <div className="operation-inline-status"><OperationTrack compact />Loading output…</div> : output ? <pre className="code-output">{output}</pre> : <p>No output recorded.</p>}
    </details>
  );
}
