import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/noto-sans-tc";
import "../src/styles.css";
import { ConfirmButton } from "@/app/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DescriptionList,
  DescriptionItem,
} from "@/components/ui/description-list";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Checkbox,
  Progress,
  Switch,
  Label,
  Textarea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/form-controls";
import { Sidebar } from "@/components/ui/sidebar";
import { Input } from "@/components/ui/input";
import {
  PageHeader,
  SectionHeader,
  EmptyState,
  DataList,
  ListRow,
  Toolbar,
  InlineNotice,
} from "@/components/ui/layout";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

document.documentElement.classList.toggle(
  "dark",
  matchMedia("(prefers-color-scheme: dark)").matches,
);

function Gallery() {
  const [stopped, setStopped] = useState(false);
  return (
    <div className="min-h-screen md:grid md:grid-cols-shell">
      <Sidebar label="展示導覽" brand="範例看板">
        <a href="#work-order" className="work-touch flex items-center px-3 text-sm">工單名稱</a>
      </Sidebar>
      <main className="mx-auto grid min-h-screen w-full min-w-0 max-w-3xl content-start gap-4 p-4 pb-16 md:pb-4">
        <PageHeader title="範例工單" />
        <SectionHeader>工單資料</SectionHeader>
        <DescriptionList pairs={2}>
          <DescriptionItem label="批號" numeric>
            1008
          </DescriptionItem>
          <DescriptionItem label="設備">範例壓床</DescriptionItem>
        </DescriptionList>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="work-order">工單名稱</Label>
            <Input id="work-order" defaultValue="範例設備檢查" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="station">站別</Label>
            <Select defaultValue="check">
              <SelectTrigger id="station">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="check">檢查站</SelectItem>
                <SelectItem value="review">複核站</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="note">備註</Label>
          <Textarea id="note" />
        </div>
        <Label htmlFor="review">
          <Checkbox id="review" />
          需要複核
        </Label>
        <Label htmlFor="enabled">
          <Switch id="enabled" />
          啟用工序
        </Label>
        <InlineNotice tone="info" variant="soft">設備異動後請重新複核工單。</InlineNotice>
        <Progress aria-label="檢查進度" value={75} />
        <Tabs defaultValue="work">
          <TabsList aria-label="工單內容" className="w-full">
            <TabsTrigger value="work">工序</TabsTrigger>
            <TabsTrigger value="events">紀錄</TabsTrigger>
          </TabsList>
          <TabsContent value="work">
            <DataList variant="bordered">
              <ListRow className="flex flex-wrap items-center gap-2 p-2">
                範例批次
                <Badge variant="good">運轉</Badge>
                <Badge variant="warn">待複核</Badge>
                <Badge variant="danger">停機</Badge>
                <Badge variant="info">排定</Badge>
              </ListRow>
            </DataList>
          </TabsContent>
          <TabsContent value="events">
            <EmptyState title="尚無工序紀錄">
              工單執行後會顯示時間與結果。
            </EmptyState>
          </TabsContent>
        </Tabs>
        <Toolbar>
          <Dialog>
            <DialogTrigger asChild>
              <Button size="md">查看工單</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle>查看工單</DialogTitle>
              <DialogDescription>
                範例設備檢查安排於複核站。
              </DialogDescription>
            </DialogContent>
          </Dialog>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline">
                操作說明
              </Button>
            </TooltipTrigger>
            <TooltipContent>查看工序的填寫方式</TooltipContent>
          </Tooltip>
          <ConfirmButton
            variant="destructive"
            title="停止工單"
            description="將停止這張範例工單的執行。"
            dismiss="取消"
            confirm="確定停止"
            disabled={stopped}
            onConfirm={() => setStopped(true)}
          >
            {stopped ? "已停止" : "停止工單"}
          </ConfirmButton>
        </Toolbar>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider><Gallery /></TooltipProvider>,
);
