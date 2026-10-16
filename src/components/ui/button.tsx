import type { ComponentProps } from "react";

export type ButtonProps = ComponentProps<"button">;

/** Native button behavior and the application's existing visual variants. */
export function Button({ type = "button", ...props }: ButtonProps) {
  return <button data-slot="button" type={type} {...props} />;
}
