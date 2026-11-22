import { useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ConfirmDialogProps = {
  title: string;
  description: ReactNode;
  /** 確認按鈕上的字，寫出實際會做的事。 */
  confirm: string;
  onConfirm: () => unknown;
  dialogActionClassName?: string;
  dismiss?: string;
};

export function ConfirmDialogContent({
  title,
  description,
  confirm,
  onConfirm,
  dialogActionClassName,
  dismiss = "先不要",
  confirmVariant = "destructive",
  pending = false,
  footerClassName,
  onCloseAutoFocus,
}: ConfirmDialogProps & {
  confirmVariant?: ComponentProps<typeof Button>["variant"];
  pending?: boolean;
  footerClassName?: string;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  return (
    <DialogContent
      showCloseButton={false}
      className="sm:max-w-md"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogFooter className={footerClassName}>
        <DialogClose asChild>
          <Button
            variant="outline"
            className={dialogActionClassName}
            disabled={pending}
          >
            {dismiss}
          </Button>
        </DialogClose>
        <Button
          variant={confirmVariant}
          className={dialogActionClassName}
          disabled={pending}
          onClick={() => void onConfirm()}
        >
          {confirm}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

// 不能復原的動作（拒絕、取消、刪除、移除）先問一次，避免誤觸就直接生效。
export function ConfirmButton({
  title,
  description,
  confirm,
  onConfirm,
  dialogActionClassName,
  dismiss,
  children,
  ...button
}: Omit<ComponentProps<typeof Button>, "title" | "onClick"> &
  ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" {...button}>
          {children}
        </Button>
      </DialogTrigger>
      <ConfirmDialogContent
        title={title}
        description={description}
        confirm={confirm}
        dismiss={dismiss}
        dialogActionClassName={dialogActionClassName}
        onConfirm={() => {
          setOpen(false);
          void onConfirm();
        }}
      />
    </Dialog>
  );
}
