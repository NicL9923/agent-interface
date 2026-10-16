import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export type ButtonProps = ComponentProps<"button"> & { variant?: "default" | "primary" | "danger" | "icon" };

/** Native button behavior and the application's existing visual variants. */
export function Button({ type = "button", variant = "default", className, ...props }: ButtonProps) {
  return <button data-slot="button" type={type} className={cn(variant === "icon" ? "icon-button" : variant !== "default" && variant, className)} {...props} />;
}
