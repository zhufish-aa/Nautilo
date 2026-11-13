import { Terminal } from "lucide-react";
import codexLogo from "../../assets/harness/codex.png";
import claudeLogo from "../../assets/harness/claude-code.png";
import kimiLogo from "../../assets/harness/kimi-code.png";
import ompLogo from "../../assets/harness/omp.svg";
import piLogo from "../../assets/harness/pi.svg";
import opencodeLogo from "../../assets/harness/opencode.png";
import commandcodeLogo from "../../assets/harness/commandcode.svg";
import traeLogo from "../../assets/harness/trae.png";
import deepseekLogo from "../../assets/harness/deepseek.png";
import antigravityLogo from "../../assets/harness/antigravity.png";

const TINTS = ["violet", "rose", "blue", "mint", "amber", "peach"];

export function NautiloMark(): JSX.Element {
  return <div className="nautilo-brand-mark" aria-hidden><svg viewBox="0 0 24 24" fill="none"><path d="M20 12a8 8 0 1 1-8-8 6 6 0 0 1 6 6 4 4 0 0 1-4 4 2 2 0 0 1-2-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg></div>;
}

/** Stable local identities: no remote avatars, account data or image loading. */
export function IdentityAvatar({ label, seed = label, size = "md" }: { label: string; seed?: string; size?: "sm" | "md" | "lg" }): JSX.Element {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const initial = /^[a-z]/i.test(label) ? label.slice(0, 2).toUpperCase() : Array.from(label)[0] || "N";
  return <div aria-hidden className={`identity-avatar identity-avatar-${size}`} data-tint={TINTS[Math.abs(hash) % TINTS.length]}>{initial}</div>;
}

const PROVIDER_MARKS = {
  codex: codexLogo,
  "claude-code": claudeLogo,
  "kimi-code": kimiLogo,
  omp: ompLogo,
  pi: piLogo,
  opencode: opencodeLogo,
  commandcode: commandcodeLogo,
  trae: traeLogo,
  deepseek: deepseekLogo,
  antigravity: antigravityLogo
};

export function ProviderAvatar({ providerId, size = "md" }: { providerId: string; size?: "sm" | "md" | "lg" }): JSX.Element {
  const logo = PROVIDER_MARKS[providerId as keyof typeof PROVIDER_MARKS];
  return <div aria-hidden className={`identity-avatar identity-avatar-${size} provider-avatar${logo ? " provider-avatar-branded" : ""}`} data-provider={providerId} data-tint={logo ? undefined : "violet"}>{logo ? <img src={logo} alt="" draggable={false} /> : <Terminal />}</div>;
}
