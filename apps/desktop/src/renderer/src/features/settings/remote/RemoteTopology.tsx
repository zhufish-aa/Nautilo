export function RemoteTopology({ state, label, zh }: {
  state: "off" | "waiting" | "ready" | "direct" | "relay";
  label: string;
  zh: boolean;
}) {
  return <div className="remote-topology" data-state={state}>
    <svg viewBox="0 0 320 110" aria-hidden="true">
      <line className="remote-topology-track" x1="73" x2="247" y1="49" y2="49" />
      <circle className="remote-topology-ring" cx="49" cy="49" r="28" />
      <circle className="remote-topology-ring remote-topology-ring-late" cx="49" cy="49" r="28" />
      <rect className="remote-topology-box" x="25" y="25" width="48" height="48" rx="12" />
      <rect className="remote-topology-box remote-topology-phone" x="247" y="25" width="48" height="48" rx="12" />
      <g className="remote-topology-icons" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="38" y="41" width="22" height="14" rx="2" /><path d="M49 55v4m-5 0h10" />
        <rect x="265" y="38" width="12" height="22" rx="2" /><path d="M270 56h2" />
      </g>
      <line className="remote-topology-scan" x1="76" x2="110" y1="49" y2="49" />
      <circle className="remote-topology-dot" cx="77" cy="49" r="2.5" />
      <circle className="remote-topology-dot remote-topology-return" cx="77" cy="49" r="2.5" />
      <g className="remote-topology-labels" textAnchor="middle">
        <text x="49" y="94">{zh ? "本机" : "Computer"}</text>
        <text x="271" y="94">{zh ? "移动设备" : "Mobile device"}</text>
      </g>
    </svg>
    <span className="remote-topology-label">{label}</span>
  </div>;
}
