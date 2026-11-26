import type { ComponentProps } from "react";
import { AlertDialog as Primitive } from "radix-ui";
import { cn, resolvePortalContainer } from "@/lib/utils";
import { buttonVariants } from "./button";
import {
  dialogContentClass,
  dialogOverlayClass,
  dialogPanelClass,
} from "./dialog";
import { useDialogFocus } from "./use-dialog-focus";

export const AlertDialog = Primitive.Root;
export const AlertDialogTrigger = Primitive.Trigger;

export function AlertDialogContent({
  portalContainer,
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof Primitive.Content> & {
  portalContainer?: HTMLElement | null;
}) {
  const focus = useDialogFocus(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <Primitive.Portal container={resolvePortalContainer(portalContainer)}>
      <Primitive.Overlay className={dialogOverlayClass} />
      <Primitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          dialogContentClass,
          dialogPanelClass,
          "sm:max-w-md",
          className,
        )}
        {...focus}
        {...props}
      />
    </Primitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof Primitive.Title>) {
  return (
    <Primitive.Title className={cn("heading-section", className)} {...props} />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof Primitive.Description>) {
  return (
    <Primitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof Primitive.Cancel>) {
  return (
    <Primitive.Cancel
      data-slot="button"
      className={cn(buttonVariants({ variant: "outline" }), className)}
      {...props}
    />
  );
}

export function AlertDialogAction({
  className,
  ...props
}: ComponentProps<typeof Primitive.Action>) {
  return (
    <Primitive.Action
      data-slot="button"
      className={cn(buttonVariants({ variant: "destructive" }), className)}
      {...props}
    />
  );
}
