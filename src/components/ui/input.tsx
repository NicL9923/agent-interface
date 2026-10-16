import type { ComponentProps } from "react";

export function Input(props: ComponentProps<"input">) {
  return <input data-slot="input" {...props} />;
}
