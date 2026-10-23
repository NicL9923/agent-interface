import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";

export type FormMessageProps = ComponentProps<"p"> & { tone: "error" | "notice" };

/** An error is announced at once as an alert; a notice waits its turn as a status. */
export function FormMessage({ tone, className, ...props }: FormMessageProps) {
  return <p data-slot="form-message" role={tone === "error" ? "alert" : "status"}
    className={cn(tone === "error" ? "form-error" : "form-notice", className)} {...props} />;
}
