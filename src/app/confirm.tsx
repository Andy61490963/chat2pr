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

// 不能復原的動作（拒絕、取消、刪除、移除）先問一次，避免誤觸就直接生效。
export function ConfirmButton({
  title,
  description,
  confirm,
  onConfirm,
  dialogActionClassName,
  dismiss = "先不要",
  children,
  ...button
}: Omit<ComponentProps<typeof Button>, "title" | "onClick"> & {
  title: string;
  description: ReactNode;
  /** 確認按鈕上的字，寫出實際會做的事。 */
  confirm: string;
  onConfirm: () => unknown;
  dialogActionClassName?: string;
  dismiss?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" {...button}>
          {children}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" className={dialogActionClassName}>
              {dismiss}
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            className={dialogActionClassName}
            onClick={() => {
              setOpen(false);
              void onConfirm();
            }}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
