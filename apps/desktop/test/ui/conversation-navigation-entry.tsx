import React from "react";
import { createRoot } from "react-dom/client";
import { TimelineViewport, type TimelineRow } from "../../src/renderer/src/features/timeline/Timeline";
import { useSettingsStore } from "../../src/renderer/src/stores/settings";
import { timelinePositions } from "../../src/renderer/src/lib/timeline-position";
import type { ConversationLocation } from "../../src/renderer/src/lib/conversation-navigation";
import { I18nProvider } from "../../src/renderer/src/lib/i18n";

const rows: TimelineRow[] = Array.from({ length: 600 }, (_, index) => ({ key: `row-${index}`, render: () => <div style={{ height: 120 }}>Row {index}</div> }));
const locations: ConversationLocation[] = Array.from({ length: 300 }, (_, index) => ({ id: `question-${index}`, rowKey: `row-${index * 2}`, rowIndex: index * 2, title: `Question ${index}`, preview: `Answer ${index}`, timestamp: "2026-11-16T12:00:00Z" }));
const root = createRoot(document.getElementById("root")!);
function render(sessionKey = "a", active = true) { root.render(<I18nProvider><TimelineViewport rows={rows} sessionKey={sessionKey} active={active} locations={locations} /></I18nProvider>); }
(window as unknown as { qa: unknown }).qa = { render, settings: useSettingsStore, positions: timelinePositions };
useSettingsStore.setState({ reduceMotion: true });
render();
