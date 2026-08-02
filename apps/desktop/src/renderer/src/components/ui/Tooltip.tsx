import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export function Tooltip({
  content,
  children,
  side = "top"
}: {
  content: string;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
}): JSX.Element {
  return (
    <TooltipPrimitive.Root delayDuration={240}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="ui-tooltip z-50 max-w-64 rounded-lg border border-line bg-card-hover px-2.5 py-1.5 text-xs text-ink shadow-pop data-[state=delayed-open]:animate-pop-in"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-line" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
