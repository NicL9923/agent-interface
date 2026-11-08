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
  return <Menu.Portal className="tw:relative tw:z-30" container={container ?? inherited ?? undefined}>
    <Menu.Positioner className="tw:z-30" positionMethod="fixed" {...positionerProps}>
      <Menu.Popup data-slot="menu-content" {...props} />
    </Menu.Positioner>
  </Menu.Portal>;
}

export function ContextMenuItem(props: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item data-slot="menu-item" render={<button type="button" />} nativeButton {...props} />;
}

export const ContextMenuSubmenu = Menu.SubmenuRoot;
export const ContextMenuRadioGroup = Menu.RadioGroup;

export function ContextMenuSubmenuTrigger(props: ComponentProps<typeof Menu.SubmenuTrigger>) {
  return <Menu.SubmenuTrigger data-slot="menu-item" render={<button type="button" />} nativeButton {...props} />;
}

/** A submenu's popup, placed beside its trigger and kept on screen. */
export function ContextMenuSubmenuContent({ container, positionerProps, ...props }: ContentProps) {
  const inherited = useOverlayContainer();
  return <Menu.Portal className="tw:relative tw:z-30" container={container ?? inherited ?? undefined}>
    <Menu.Positioner className="tw:z-30" positionMethod="fixed" side="inline-end" align="start" alignOffset={-6} collisionPadding={12} {...positionerProps}>
      <Menu.Popup data-slot="menu-content" {...props} />
    </Menu.Positioner>
  </Menu.Portal>;
}

/** A choice that closes the menu once picked, marked with a check. */
export function ContextMenuRadioItem({ children, ...props }: ComponentProps<typeof Menu.RadioItem>) {
  return <Menu.RadioItem data-slot="menu-item" closeOnClick render={<button type="button" />} nativeButton {...props}>
    <span className="menu-check" aria-hidden="true"><Menu.RadioItemIndicator>✓</Menu.RadioItemIndicator></span>
    {children}
  </Menu.RadioItem>;
}

export function ContextMenuSeparator(props: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator data-slot="menu-separator" {...props} />;
}
