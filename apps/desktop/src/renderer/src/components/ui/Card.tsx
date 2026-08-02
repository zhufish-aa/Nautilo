import { forwardRef, type HTMLAttributes } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { cn } from "../../lib/utils";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        "ui-card rounded-2xl border border-line bg-card shadow-card transition-colors duration-200",
        className
      )}
      {...rest}
    />
  );
});

export interface MotionCardProps extends HTMLMotionProps<"div"> {
  interactive?: boolean;
}

/** Card with entrance + hover motion, used in grid/list layouts. */
export const MotionCard = forwardRef<HTMLDivElement, MotionCardProps>(function MotionCard(
  { className, interactive, ...rest },
  ref
) {
  return (
    <motion.div
      ref={ref}
      variants={{
        hidden: { opacity: 0, y: 14 },
        show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 26 } }
      }}
      whileHover={interactive ? { y: -3, transition: { type: "spring", stiffness: 400, damping: 25 } } : undefined}
      className={cn(
        "ui-card rounded-2xl border border-line bg-card shadow-card transition-[background-color,border-color,box-shadow] duration-200",
        interactive && "cursor-pointer hover:border-accent/40 hover:bg-card-hover hover:shadow-glow",
        className
      )}
      {...rest}
    />
  );
});

/** Stagger container for grids of MotionCard. */
export function StaggerGroup({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.055 } }
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
