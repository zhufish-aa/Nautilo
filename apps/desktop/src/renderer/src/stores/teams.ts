import { create } from "zustand";
import type { TeamDefinition } from "@agenthub/domain";
import { requestCore } from "../lib/bridge";
import { toDomainTeam, toUiTeam } from "../lib/core-mappers";
import { newId } from "../lib/utils";
import type { AgentInstanceConfig, TeamIssue, UiTeam, UiTeamMember } from "../lib/types";

interface TeamsState {
  teams: UiTeam[];
  hydrate: () => Promise<void>;
  createTeam: (name: string) => Promise<UiTeam>;
  updateTeam: (id: string, patch: Partial<Pick<UiTeam, "name" | "delegationPolicy">>) => Promise<void>;
  deleteTeam: (id: string) => Promise<void>;
  addMember: (teamId: string, member: UiTeamMember) => Promise<void>;
  updateMember: (teamId: string, memberId: string, patch: Partial<UiTeamMember>) => Promise<void>;
  removeMember: (teamId: string, memberId: string) => Promise<void>;
}

function touch(team: UiTeam): UiTeam { return { ...team, updatedAt: new Date().toISOString() }; }

export const useTeamsStore = create<TeamsState>((set, get) => ({
  teams: [],

  hydrate: async () => {
    const teams = await requestCore<TeamDefinition[]>("team.list");
    set({ teams: teams.map(toUiTeam) });
  },

  createTeam: async (name) => {
    const now = new Date().toISOString();
    const team: UiTeam = { id: newId("team"), name: name.trim() || "未命名团队", delegationPolicy: "autonomous", members: [], createdAt: now, updatedAt: now };
    const saved = toUiTeam(await requestCore<TeamDefinition>("team.upsert", toDomainTeam(team)));
    set((state) => ({ teams: [saved, ...state.teams] }));
    return saved;
  },

  updateTeam: async (id, patch) => {
    const current = requireTeam(get().teams, id);
    const next = touch({ ...current, ...patch });
    set((state) => ({ teams: state.teams.map((team) => team.id === id ? next : team) }));
    await requestCore<TeamDefinition>("team.upsert", toDomainTeam(next));
  },

  deleteTeam: async (id) => {
    await requestCore<{ removed: true }>("team.remove", { teamId: id });
    set((state) => ({ teams: state.teams.filter((team) => team.id !== id) }));
  },

  addMember: async (teamId, member) => {
    const current = requireTeam(get().teams, teamId);
    const next = touch({ ...current, members: [...current.members, member] });
    set((state) => ({ teams: state.teams.map((team) => team.id === teamId ? next : team) }));
    await requestCore<TeamDefinition>("team.upsert", toDomainTeam(next));
  },

  updateMember: async (teamId, memberId, patch) => {
    const current = requireTeam(get().teams, teamId);
    const next = touch({ ...current, members: current.members.map((member) => member.id === memberId ? { ...member, ...patch } : member) });
    set((state) => ({ teams: state.teams.map((team) => team.id === teamId ? next : team) }));
    await requestCore<TeamDefinition>("team.upsert", toDomainTeam(next));
  },

  removeMember: async (teamId, memberId) => {
    const current = requireTeam(get().teams, teamId);
    const members = current.members.filter((member) => member.id !== memberId);
    const next = touch({ ...current, members });
    set((state) => ({ teams: state.teams.map((team) => team.id === teamId ? next : team) }));
    await requestCore<TeamDefinition>("team.upsert", toDomainTeam(next));
  }
}));

function requireTeam(teams: UiTeam[], id: string): UiTeam {
  const team = teams.find((item) => item.id === id);
  if (!team) throw new Error(`Team ${id} is missing`);
  return team;
}

/** Pure validation shared by the editor and run-start checks. */
export function validateTeam(team: UiTeam, instances: AgentInstanceConfig[]): TeamIssue[] {
  const issues: TeamIssue[] = [];
  if (team.members.length === 0) issues.push({ id: "no-members", level: "critical", textKey: "teams.validation.noMembers" });
  const enabledMembers = team.members.filter((member) => member.enabled);
  if (team.members.length > 0 && enabledMembers.length === 0) issues.push({ id: "no-enabled", level: "critical", textKey: "teams.validation.noEnabled" });
  const seen = new Map<string, string[]>();
  for (const member of team.members) seen.set(member.agentInstanceId, [...(seen.get(member.agentInstanceId) ?? []), member.displayName]);
  for (const names of seen.values()) if (names.length > 1) issues.push({ id: `dup-${names.join("-")}`, level: "warning", textKey: "teams.validation.duplicateInstance", values: { names: names.join("、") } });
  for (const member of team.members) {
    const instance = instances.find((item) => item.id === member.agentInstanceId);
    if (!instance) issues.push({ id: `missing-${member.id}`, level: "warning", textKey: "teams.validation.instanceMissing", values: { name: member.displayName } });
    else if (!instance.enabled && member.enabled) issues.push({ id: `inst-disabled-${member.id}`, level: "info", textKey: "teams.validation.instanceDisabled", values: { name: member.displayName, instance: instance.displayName } });
    if (!member.enabled) issues.push({ id: `member-disabled-${member.id}`, level: "info", textKey: "teams.validation.memberDisabled", values: { name: member.displayName } });
  }
  const order = { critical: 0, warning: 1, info: 2 } as const;
  return issues.sort((left, right) => order[left.level] - order[right.level]);
}
