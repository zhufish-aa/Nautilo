import { memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Bookmark } from "lucide-react";
import type { ConversationLocation } from "../../lib/conversation-navigation";
import { useI18n } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { UI_EASE_OUT, useUiReducedMotion } from "../../lib/ui-motion";
import "./ConversationNavigator.css";

export const ConversationNavigator = memo(function ConversationNavigator({ sessionKey, locations, current, onNavigate }: {
  sessionKey: string; locations: ConversationLocation[]; current: number; onNavigate: (location: ConversationLocation) => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const reduced = useUiReducedMotion();
  const [preview, setPreview] = useState<{ id: string; top: number }>();
  const container = useRef<HTMLElement>(null);
  const bookmarks = useSettingsStore(state => state.conversationBookmarks[sessionKey]);
  const toggleBookmark = useSettingsStore(state => state.toggleConversationBookmark);
  const selected = locations.find(location => location.id === preview?.id);
  const showPreview = (id: string, button: HTMLButtonElement): void => {
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds) return;
    setPreview({ id, top: button.getBoundingClientRect().top - bounds.top + button.offsetHeight / 2 });
  };
  useEffect(() => {
    if (preview) return;
    const track = container.current?.querySelector<HTMLElement>(".conversation-navigator-track");
    const tick = track?.querySelector<HTMLElement>("[data-current]");
    if (!track || !tick) return;
    const top = tick.offsetTop;
    if (top < track.scrollTop) track.scrollTop = top;
    else if (top + tick.offsetHeight > track.scrollTop + track.clientHeight) track.scrollTop = top + tick.offsetHeight - track.clientHeight;
  }, [current, preview, locations.length]);
  if (locations.length < 2) return null;
  return <nav ref={container} className="conversation-navigator" aria-label={zh ? "会话定位" : "Conversation navigation"}
    onMouseLeave={() => setPreview(undefined)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPreview(undefined); }}
    onKeyDown={event => {
      if (event.key === "Escape") { setPreview(undefined); return; }
      if (!(event.target as HTMLElement).closest("[data-location]") || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = selected ? locations.indexOf(selected) : current;
      const next = event.key === "Home" ? 0 : event.key === "End" ? locations.length - 1 : Math.max(0, Math.min(locations.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
      container.current?.querySelectorAll<HTMLButtonElement>("[data-location]")[next]?.focus();
    }}>
    <div className="conversation-navigator-track">
      {locations.map((location, index) => <button type="button" key={location.id} data-location={location.id}
        data-current={index === current || undefined} data-bookmarked={bookmarks?.includes(location.id) || undefined}
        tabIndex={index === current ? 0 : -1} aria-label={location.title} aria-current={index === current ? "location" : undefined}
        onFocus={event => showPreview(location.id, event.currentTarget)} onMouseEnter={event => showPreview(location.id, event.currentTarget)}
        onClick={() => onNavigate(location)}><span /></button>)}
    </div>
    <AnimatePresence initial={false}>
      {selected && <motion.div key="preview" className="conversation-navigator-preview"
        style={{ top: preview?.top }}
        initial={{ opacity: 0, x: reduced ? 0 : -7, scale: reduced ? 1 : .98 }} animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={{ opacity: 0, x: reduced ? 0 : -4 }} transition={{ duration: reduced ? 0 : .16, ease: UI_EASE_OUT }}>
        <div className="conversation-navigator-preview-heading">
          <button type="button" className="conversation-navigator-jump" onClick={() => onNavigate(selected)}>{selected.title}</button>
          <button type="button" className="conversation-navigator-bookmark" aria-pressed={!!bookmarks?.includes(selected.id)}
            aria-label={bookmarks?.includes(selected.id) ? (zh ? "移除书签" : "Remove bookmark") : (zh ? "添加书签" : "Bookmark")}
            onClick={() => toggleBookmark(sessionKey, selected.id)}><Bookmark size={14} fill={bookmarks?.includes(selected.id) ? "currentColor" : "none"} /></button>
        </div>
        {selected.preview && <p>{selected.preview}</p>}
        <footer><span>{new Date(selected.timestamp).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          <button type="button" onClick={() => onNavigate(selected)}>{zh ? "跳转" : "Jump"}<ArrowUpRight size={12} /></button></footer>
      </motion.div>}
    </AnimatePresence>
  </nav>;
});
