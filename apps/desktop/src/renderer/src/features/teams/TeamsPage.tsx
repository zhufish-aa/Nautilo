import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronRight, Loader2, Plus, Users } from "lucide-react";
import { useI18n, type MessageKey } from "../../lib/i18n";
import { PageHeader } from "../../components/layout/AppShell";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Field, Input } from "../../components/ui/Input";
import { useTeamsStore } from "../../stores/teams";

export function TeamsPage(): JSX.Element {
  const { t, locale } = useI18n();
  const zh = locale === "zh-CN";
  const navigate = useNavigate();
  const teams = useTeamsStore((state) => state.teams);
  const createTeam = useTeamsStore((state) => state.createTeam);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const startCreate = (): void => {
    setName("");
    setError("");
    setOpen(true);
  };
  const handleCreate = async (): Promise<void> => {
    if (inFlight.current) return;
    if (!name.trim()) {
      setError(t("agents.editor.nameRequired"));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const team = await createTeam(name.trim());
      setOpen(false);
      navigate(`/teams/${encodeURIComponent(team.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return (
    <div data-tour="teams-page" className="mx-auto max-w-5xl py-3 sm:py-6">
      <p className="mb-5 text-sm text-ink-3">
        {zh ? "设置 / 模型与 Agent / 团队" : "Settings / Models & agents / Teams"}
      </p>
      <PageHeader
        title={t("teams.title")}
        actions={
          <Button variant="outline" onClick={startCreate}>
            <Plus className="h-4 w-4" aria-hidden />
            {t("teams.new")}
          </Button>
        }
      />
      {teams.length === 0 ? (
        <EmptyState
          icon={Users}
          title={t("teams.empty.title")}
          description={t("teams.empty.desc")}
          action={
            <Button variant="primary" onClick={startCreate}>
              <Plus className="h-4 w-4" aria-hidden />
              {t("teams.empty.action")}
            </Button>
          }
        />
      ) : (
        <ul className="mt-8 divide-y divide-line border-b border-line">
          {teams.map((team) => (
            <li key={team.id}>
              <Link
                to={`/teams/${encodeURIComponent(team.id)}`}
                className="grid min-h-[80px] grid-cols-[minmax(0,1fr)_20px] items-center gap-x-6 gap-y-2 rounded-lg px-2 py-5 transition-colors hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.7fr)_minmax(0,1fr)_20px]"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Users className="h-5 w-5 shrink-0 text-ink-2" aria-hidden />
                  <span className="truncate text-[15px] font-medium">{team.name}</span>
                </span>
                <span className="col-start-1 row-start-2 pl-8 text-sm text-ink-3 sm:col-auto sm:row-auto sm:pl-0">
                  {t("teams.card.members", { count: team.members.length })}
                </span>
                <span className="col-start-1 row-start-3 pl-8 text-sm text-ink-3 sm:col-auto sm:row-auto sm:pl-0">
                  {t(`teams.policy.${team.delegationPolicy}` as MessageKey)}
                </span>
                <ChevronRight
                  className="col-start-2 row-start-1 h-4 w-4 text-ink-3 sm:col-auto"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
        title={t("teams.new")}
        description={
          zh
            ? "先为团队命名，然后添加成员与协作设置。"
            : "Name your team, then add members and configure how they collaborate."
        }
        footer={
          <>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={pending || !name.trim()}
              onClick={() => void handleCreate()}
            >
              {pending && <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
              {zh ? "创建" : "Create"}
            </Button>
          </>
        }
      >
        <Field label={t("teams.editor.nameLabel")} htmlFor="new-team-name" error={error}>
          <Input
            id="new-team-name"
            value={name}
            autoFocus
            disabled={pending}
            aria-invalid={Boolean(error)}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleCreate();
              }
            }}
            placeholder={t("teams.editor.namePlaceholder")}
          />
        </Field>
      </Dialog>
    </div>
  );
}
