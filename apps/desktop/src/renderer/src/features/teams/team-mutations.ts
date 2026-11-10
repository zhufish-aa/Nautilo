import { useTeamsStore } from "../../stores/teams";

/** The store is optimistic. Restore only this untouched update if persistence fails. */
export async function persistTeamChange(
  teamId: string,
  action: () => Promise<void>
): Promise<void> {
  const before = useTeamsStore.getState().teams.find((team) => team.id === teamId);
  const request = action();
  const optimistic = useTeamsStore.getState().teams.find((team) => team.id === teamId);
  try {
    await request;
  } catch (error) {
    if (before && optimistic && optimistic !== before) {
      useTeamsStore.setState((state) => ({
        teams: state.teams.map((team) =>
          team.id === teamId && team === optimistic ? before : team
        )
      }));
    }
    throw error;
  }
}
