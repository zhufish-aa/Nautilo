import { forwardRef, type ButtonHTMLAttributes } from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { cn } from "../../lib/utils";

export type ButtonVariant = "primary" | "outline" | "ghost" | "subtle" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: React.ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-to-b from-accent to-accent-2 text-on-accent shadow-[0_1px_2px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.18)] hover:shadow-glow hover:brightness-110 border border-accent-2/60",
  outline:
    "border border-line-strong bg-card text-ink hover:bg-card-hover hover:border-accent/50",
  ghost: "text-ink-2 hover:text-ink hover:bg-accent-soft",
  subtle: "bg-accent-soft text-accent hover:bg-accent-soft/70 border border-accent/20",
  danger:
    "border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 hover:border-danger/50"
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg",
  md: "h-9.5 px-4 text-sm gap-2 rounded-xl",
  icon: "h-8 w-8 rounded-lg"
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "outline", size = "md", className, disabled, children, ...rest },
  ref
) {
  return (
    <motion.button
      ref={ref}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      className={cn(
        "inline-flex select-none items-center justify-center font-medium whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow,filter] duration-150",
        "focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas",
        "disabled:pointer-events-none disabled:opacity-45",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      disabled={disabled}
      {...rest}
    >
      {children}
    </motion.button>
  );
});

export type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;
