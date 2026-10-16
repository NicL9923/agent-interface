import type { ComponentProps } from "react";
import { Popover as Primitive } from "@base-ui/react/popover";
import { useOverlayContainer } from "../../lib/overlay-container";

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;
export const PopoverClose = Primitive.Close;

type ContentProps = ComponentProps<typeof Primitive.Popup> & Pick<Primitive.Positioner.Props, "align" | "side" | "sideOffset"> & {
  container?: ComponentProps<typeof Primitive.Portal>["container"];
  positionerProps?: Primitive.Positioner.Props;
};

export function PopoverContent({ container, positionerProps, align = "start", side, sideOffset = 8, ...props }: ContentProps) {
  const inherited = useOverlayContainer();
  return <Primitive.Portal container={container ?? inherited ?? undefined}>
    <Primitive.Positioner className="tw:z-30" positionMethod="fixed" align={align} side={side} sideOffset={sideOffset} {...positionerProps}>
      <Primitive.Popup data-slot="popover-content" {...props} />
    </Primitive.Positioner>
  </Primitive.Portal>;
}
