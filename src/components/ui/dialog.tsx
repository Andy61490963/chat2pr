import * as React from "react";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";
import { resolvePortalContainer } from "@/lib/utils";
import { useDialogFocus } from "./use-dialog-focus";

const ControlledDialog = React.createContext<
  ((open: boolean) => void) | undefined
>(undefined);

function Dialog({
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <DialogPrimitive.Root data-slot="dialog" {...props}>
      <ControlledDialog.Provider
        value={props.open ? props.onOpenChange : undefined}
      >
        {children}
      </ControlledDialog.Provider>
    </DialogPrimitive.Root>
  );
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  container,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return (
    <DialogPrimitive.Portal
      data-slot="dialog-portal"
      container={resolvePortalContainer(container)}
      {...props}
    />
  );
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  layout = "default",
  portalContainer,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  layout?: "default" | "operation";
  portalContainer?: HTMLElement | null;
}) {
  const focus = useDialogFocus(onOpenAutoFocus, onCloseAutoFocus);
  const onOpenChange = React.useContext(ControlledDialog);
  const scopeId = React.useId();
  React.useEffect(() => {
    if (!onOpenChange) return;
    // 內層確認已取得焦點時，Radix 在 document 捕捉的 Esc 有時仍會關掉外層側欄。
    // 只在多層視窗由最內層先處理，從選單或下拉清單發出的 Esc 留給各自的控制項。
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !(event.target instanceof Element)
      )
        return;
      const dialog = event.target.closest("[role=dialog]");
      if (
        dialog?.getAttribute("data-focus-scope") !== scopeId ||
        document.querySelectorAll('[role=dialog][data-state="open"]').length < 2
      )
        return;
      onEscapeKeyDown?.(event);
      if (!event.defaultPrevented) onOpenChange(false);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [scopeId, onOpenChange, onEscapeKeyDown]);
  return (
    <DialogPortal data-slot="dialog-portal" container={portalContainer}>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-focus-scope={scopeId}
        onEscapeKeyDown={onEscapeKeyDown}
        {...focus}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 translate-x-[-50%] translate-y-[-50%] text-popover-foreground shadow-raised [--surface:var(--popover)] duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          layout === "default" &&
            "grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-xl border border-border-raised bg-popover p-6 sm:max-w-lg",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">關閉</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">關閉</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
