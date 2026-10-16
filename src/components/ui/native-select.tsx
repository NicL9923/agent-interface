import type { ComponentProps } from "react";

/** Keep the platform picker, particularly on touch devices. */
export function NativeSelect(props: ComponentProps<"select">) {
  return <select data-slot="native-select" {...props} />;
}

export { NativeSelect as Select };
