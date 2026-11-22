import { useEffect, useRef } from "react";
import { FormMessage } from "../components/ui/form-message";

/** What the person reads about the last refused preferences save. `id` tells two alike refusals apart. */
export type Refusal = { message: string; id: number };

/**
 * A refused preferences save, inside a modal sheet, where the app's toast is out of reach. It scrolls
 * itself into view, since the control that made the change may sit far down the sheet.
 */
export function SaveRefusal({ refusal }: { refusal: Refusal | null | undefined }) {
  const shown = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (refusal) shown.current?.scrollIntoView?.({ block: "nearest" });
  }, [refusal]);
  if (!refusal) return null;
  return (
    <FormMessage tone="error" className="settings-footnote" ref={shown}>
      {refusal.message}
    </FormMessage>
  );
}
