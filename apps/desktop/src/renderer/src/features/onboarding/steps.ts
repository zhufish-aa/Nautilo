import type { MessageKey } from "../../lib/i18n";

export interface OnboardingStep {
  id: string;
  titleKey: MessageKey;
  descKey: MessageKey;
  /** Route to navigate to before resolving the target. */
  path?: string;
  /** Spotlight target selector; falls back to a centered card when unresolved. */
  target?: string;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: "welcome", titleKey: "onboarding.welcome.title", descKey: "onboarding.welcome.desc" },
  {
    id: "agents",
    titleKey: "onboarding.agents.title",
    descKey: "onboarding.agents.desc",
    path: "/agents",
    target: '[data-tour="agents-page"]'
  },
  {
    id: "teams",
    titleKey: "onboarding.teams.title",
    descKey: "onboarding.teams.desc",
    path: "/teams",
    target: '[data-tour="teams-page"]'
  },
  {
    id: "projects",
    titleKey: "onboarding.projects.title",
    descKey: "onboarding.projects.desc",
    path: "/projects",
    target: '[data-tour="projects-new"]'
  },
  {
    id: "sessions",
    titleKey: "onboarding.sessions.title",
    descKey: "onboarding.sessions.desc",
    path: "/sessions",
    target: '[data-tour="sessions-new"]'
  },
  { id: "done", titleKey: "onboarding.done.title", descKey: "onboarding.done.desc" }
];
