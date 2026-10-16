import type { ComponentProps } from "react";
import { ContextMenu as Menu } from "@base-ui/react/context-menu";
import { useOverlayContainer } from "../../lib/overlay-container";

export const ContextMenu = Menu.Root;
export const ContextMenuTrigger = Menu.Trigger;

type ContentProps = ComponentProps<typeof Menu.Popup> & {
  container?: ComponentProps<typeof Menu.Portal>["container"];
  positionerProps?: Menu.Positioner.Props;
};

export function ContextMenuContent({ container, positionerProps, ...props }: ContentProps) {
  const inherited = useOverlayContainer();
  return <Menu.Portal container={container ?? inherited ?? undefined}>
    <Menu.Positioner className="tw:z-30" positionMethod="fixed" {...positionerProps}>
      <Menu.Popup data-slot="menu-content" {...props} />
    </Menu.Positioner>
  </Menu.Portal>;
}

export function ContextMenuItem(props: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item data-slot="menu-item" render={<button type="button" />} nativeButton {...props} />;
}

export const ContextMenuSeparator = Menu.Separator;
